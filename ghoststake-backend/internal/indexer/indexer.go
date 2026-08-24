package indexer

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// EthClient is the slice of ethclient the indexer uses, named as an interface
// so the tests can drive the loop without an RPC endpoint.
type EthClient interface {
	BlockNumber(ctx context.Context) (uint64, error)
	FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error)
	HeaderByNumber(ctx context.Context, number *big.Int) (*types.Header, error)
}

type Config struct {
	ChainID int64

	VaultAddress string
	PoolAddress  string

	// StartBlock is where a fresh cursor begins. Set it to the deployment
	// block: scanning from genesis on a public RPC is slow and pointless.
	StartBlock uint64

	// Confirmations is how far behind the head to stay. Nothing is written
	// for a block shallower than this.
	Confirmations uint64

	// BatchSize bounds one eth_getLogs range. Public RPCs reject wide ones.
	BatchSize uint64

	PollInterval time.Duration
}

type Indexer struct {
	client    EthClient
	repo      ledger.Repository
	cfg       Config
	contracts []contractSpec
	addresses []common.Address
	stream    string
}

func New(client EthClient, repo ledger.Repository, cfg Config) (*Indexer, error) {
	if cfg.VaultAddress == "" || cfg.PoolAddress == "" {
		return nil, fmt.Errorf("indexer: vault and pool addresses are required")
	}
	if cfg.BatchSize == 0 {
		cfg.BatchSize = 2000
	}
	if cfg.PollInterval == 0 {
		cfg.PollInterval = 12 * time.Second
	}
	// Guarded here as well as in config.Load, because this is the library
	// boundary: `StartBlock - 1` below is unsigned, so zero wraps to the top
	// of uint64 and the first range is decided by an overflow.
	if cfg.StartBlock == 0 {
		return nil, fmt.Errorf("indexer: StartBlock must be greater than zero")
	}

	vaultABI, err := loadABI("CollateralVault.json")
	if err != nil {
		return nil, err
	}
	poolABI, err := loadABI("BorrowLiquidityPool.json")
	if err != nil {
		return nil, err
	}

	contracts := []contractSpec{
		{name: "CollateralVault", address: common.HexToAddress(cfg.VaultAddress), abi: vaultABI, decode: decodeVault},
		{name: "BorrowLiquidityPool", address: common.HexToAddress(cfg.PoolAddress), abi: poolABI, decode: decodePool},
	}
	addresses := make([]common.Address, 0, len(contracts))
	for _, c := range contracts {
		addresses = append(addresses, c.address)
	}

	return &Indexer{
		client:    client,
		repo:      repo,
		cfg:       cfg,
		contracts: contracts,
		addresses: addresses,
		stream:    fmt.Sprintf("lending:%d", cfg.ChainID),
	}, nil
}

// Run polls until the context is cancelled.
//
// Polling rather than an `eth_subscribe` stream, which the issue suggested.
// A subscription needs a websocket, delivers nothing about the gap while it
// was disconnected, and would still need this cursor and backfill path to
// recover — so the subscription would be a second code path that only works
// when nothing has gone wrong. Polling `eth_getLogs` from a persisted cursor
// is the same code for backfill, catch-up and steady state.
func (ix *Indexer) Run(ctx context.Context) error {
	ticker := time.NewTicker(ix.cfg.PollInterval)
	defer ticker.Stop()

	slog.Info("indexer started",
		"chain_id", ix.cfg.ChainID, "start_block", ix.cfg.StartBlock,
		"confirmations", ix.cfg.Confirmations, "poll", ix.cfg.PollInterval)

	for {
		if err := ix.Step(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			// A failed cycle is retried on the next tick. The cursor only
			// advances on a committed write, so nothing is skipped.
			slog.Warn("indexer cycle failed", "err", err)
		}

		select {
		case <-ctx.Done():
			slog.Info("indexer stopped")
			return nil
		case <-ticker.C:
		}
	}
}

// Step runs one poll cycle: detect a reorg, read a bounded range of logs,
// write the entries and advance the cursor.
func (ix *Indexer) Step(ctx context.Context) error {
	head, err := ix.client.BlockNumber(ctx)
	if err != nil {
		return fmt.Errorf("head: %w", err)
	}

	// Stay `Confirmations` behind. A shallower block can still be reorged out
	// from under us, and not writing it is cheaper than unwinding it.
	if head < ix.cfg.Confirmations {
		return nil
	}
	safeHead := head - ix.cfg.Confirmations

	cursor, found, err := ix.repo.LoadCursor(ctx, ix.stream)
	if err != nil {
		return err
	}
	if !found {
		// A fresh stream starts one block below StartBlock so the first
		// range includes StartBlock itself.
		cursor = ledger.Cursor{Stream: ix.stream, ChainID: ix.cfg.ChainID, LastBlock: ix.cfg.StartBlock - 1}
	}

	if err := ix.checkReorg(ctx, &cursor); err != nil {
		return err
	}

	from := cursor.LastBlock + 1
	if from > safeHead {
		return nil // caught up
	}
	to := from + ix.cfg.BatchSize - 1
	if to > safeHead {
		to = safeHead
	}

	logs, err := ix.client.FilterLogs(ctx, ethereum.FilterQuery{
		FromBlock: new(big.Int).SetUint64(from),
		ToBlock:   new(big.Int).SetUint64(to),
		Addresses: ix.addresses,
	})
	if err != nil {
		return fmt.Errorf("filter logs %d-%d: %w", from, to, err)
	}

	entries, err := ix.decodeLogs(ctx, logs)
	if err != nil {
		return err
	}

	// The cursor records the hash of the block it stops on, which is what the
	// next cycle's reorg check compares against.
	tip, err := ix.client.HeaderByNumber(ctx, new(big.Int).SetUint64(to))
	if err != nil {
		return fmt.Errorf("header %d: %w", to, err)
	}

	next := ledger.Cursor{
		Stream:    ix.stream,
		ChainID:   ix.cfg.ChainID,
		LastBlock: to,
		LastHash:  tip.Hash().Hex(),
	}
	if err := ix.repo.AppendEntries(ctx, entries, next); err != nil {
		return err
	}

	if len(entries) > 0 {
		slog.Info("indexed", "from", from, "to", to, "logs", len(logs), "entries", len(entries))
	} else {
		slog.Debug("indexed", "from", from, "to", to, "logs", len(logs))
	}
	return nil
}

// checkReorg re-reads the block the cursor stopped on. A hash that no longer
// matches means the chain reorganised deeper than Confirmations, so
// everything from that height is discarded and re-read.
func (ix *Indexer) checkReorg(ctx context.Context, cursor *ledger.Cursor) error {
	if cursor.LastHash == "" {
		return nil // nothing indexed yet, or already rewound
	}

	header, err := ix.client.HeaderByNumber(ctx, new(big.Int).SetUint64(cursor.LastBlock))
	if err != nil {
		return fmt.Errorf("reorg check header %d: %w", cursor.LastBlock, err)
	}
	if header.Hash().Hex() == cursor.LastHash {
		return nil
	}

	// Rewind a whole confirmation window, not one block: the divergence
	// started at or before the block we noticed it on, and re-reading a
	// little too much is idempotent while re-reading too little is not.
	rewindTo := cursor.LastBlock
	if rewindTo > ix.cfg.Confirmations {
		rewindTo -= ix.cfg.Confirmations
	} else {
		rewindTo = ix.cfg.StartBlock
	}

	deleted, err := ix.repo.RollbackFrom(ctx, ix.cfg.ChainID, ix.stream, rewindTo)
	if err != nil {
		return err
	}
	slog.Warn("reorg detected, rewound",
		"at_block", cursor.LastBlock, "rewound_to", rewindTo, "entries_deleted", deleted)

	cursor.LastBlock = rewindTo - 1
	cursor.LastHash = ""
	return nil
}

func (ix *Indexer) decodeLogs(ctx context.Context, logs []types.Log) ([]ledger.Entry, error) {
	// Block timestamps are not on the log, and fetching a header per log
	// would be one RPC call per event. Cached per block instead.
	blockTimes := map[uint64]time.Time{}

	var out []ledger.Entry
	for _, log := range logs {
		// A log flagged Removed is one the node has already reorged away.
		if log.Removed {
			continue
		}

		spec, ok := ix.specFor(log.Address)
		if !ok {
			continue
		}

		blockTime, cached := blockTimes[log.BlockNumber]
		if !cached {
			header, err := ix.client.HeaderByNumber(ctx, new(big.Int).SetUint64(log.BlockNumber))
			if err != nil {
				return nil, fmt.Errorf("header %d: %w", log.BlockNumber, err)
			}
			blockTime = time.Unix(int64(header.Time), 0).UTC()
			blockTimes[log.BlockNumber] = blockTime
		}

		entries, err := spec.decodeLog(ix.cfg.ChainID, log, blockTime)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			out = append(out, e)
		}
	}
	return out, nil
}

func (ix *Indexer) specFor(address common.Address) (contractSpec, bool) {
	for _, c := range ix.contracts {
		if c.address == address {
			return c, true
		}
	}
	return contractSpec{}, false
}
