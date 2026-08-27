package indexer

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/wavedidwhat/ghoststake/internal/abis"
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

	// MarketAddresses is every ParimutuelRound to index, in any order.
	//
	// A list rather than one address because there have been two markets on
	// Sepolia since GHO-29, and the registry from GHO-34 makes a third a
	// transaction away. Watching one of them meant the API was confidently
	// blind to the rest: a user with a demo-market position asking for their
	// positions was told they had none.
	MarketAddresses []string

	// StartBlock is where a fresh cursor begins. Set it to the deployment
	// block: scanning from genesis on a public RPC is slow and pointless.
	StartBlock uint64

	// Confirmations is how far behind the head to stay. Nothing is written
	// for a block shallower than this.
	Confirmations uint64

	// BatchSize bounds one eth_getLogs range. Public RPCs reject wide ones.
	BatchSize uint64

	PollInterval time.Duration

	// Publisher, if set, is notified after each committed range.
	Publisher Publisher
}

// Publisher is notified after a range is committed, so a websocket can push
// without polling the database.
//
// Declared here rather than taken as a concrete type: the indexer's job ends
// at the commit, and it should not know that anything downstream exists. A nil
// publisher is the normal case in tests and when nobody is listening.
type Publisher interface {
	Publish(batch ledger.Batch, cursor ledger.Cursor)
}

type Indexer struct {
	client    EthClient
	repo      ledger.Repository
	cfg       Config
	contracts []contractSpec
	addresses []common.Address
	stream    string
	// fingerprint identifies the watched address set; see ledger.Fingerprint.
	fingerprint string
	publisher   Publisher
}

func New(client EthClient, repo ledger.Repository, cfg Config) (*Indexer, error) {
	if cfg.VaultAddress == "" || cfg.PoolAddress == "" || len(cfg.MarketAddresses) == 0 {
		return nil, fmt.Errorf("indexer: vault, pool and at least one market address are required")
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

	// One stream over all three contracts, not one per contract. A borrow and
	// the position it funded land in the same transaction, and separate
	// cursors would let the two halves of that be visible at different times
	// — a stake with no debt behind it, or a debt with no stake.
	specs := []struct {
		name    string
		address string
		decode  func(string, *fields, types.Log) ledger.Batch
	}{
		{abis.CollateralVault, cfg.VaultAddress, entriesOnly(decodeVault)},
		{abis.BorrowLiquidityPool, cfg.PoolAddress, entriesOnly(decodePool)},
	}
	// One spec per market, all on the same stream. Separate streams per market
	// would need a cursor each and would let a borrow and the position it
	// funded become visible at different times, which is the thing this loop
	// was built as one stream to prevent.
	for _, market := range cfg.MarketAddresses {
		specs = append(specs, struct {
			name    string
			address string
			decode  func(string, *fields, types.Log) ledger.Batch
		}{abis.ParimutuelRound, market, decodeRound})
	}

	seen := map[common.Address]bool{}
	contracts := make([]contractSpec, 0, len(specs))
	for _, spec := range specs {
		parsed, err := abis.Load(spec.name)
		if err != nil {
			return nil, err
		}
		address := common.HexToAddress(spec.address)
		// A duplicate would decode every one of its logs twice. The insert is
		// idempotent so nothing would be written twice, but the fingerprint
		// and the log lines would both describe a set that does not exist —
		// and a market listed twice is a copy-paste in an env var, which is
		// exactly the mistake worth naming rather than absorbing.
		if seen[address] {
			return nil, fmt.Errorf("indexer: %s is listed more than once", address.Hex())
		}
		seen[address] = true

		contracts = append(contracts, contractSpec{
			name:    spec.name,
			address: address,
			abi:     parsed,
			decode:  spec.decode,
			market:  marketOf(spec.name, address),
		})
	}
	addresses := make([]common.Address, 0, len(contracts))
	addressHexes := make([]string, 0, len(contracts))
	for _, c := range contracts {
		addresses = append(addresses, c.address)
		// The parsed address, not the configured string: this must describe
		// what is actually being filtered on, so a differently-cased or
		// zero-padded spelling of the same contract does not read as a
		// different deployment.
		addressHexes = append(addressHexes, c.address.Hex())
	}

	return &Indexer{
		client:      client,
		repo:        repo,
		cfg:         cfg,
		contracts:   contracts,
		addresses:   addresses,
		stream:      ledger.StreamName(cfg.ChainID),
		fingerprint: ledger.Fingerprint(addressHexes),
		publisher:   cfg.Publisher,
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
// Preflight refuses to start against a cursor built by reading different
// contracts.
//
// The stream is chain-scoped, so a redeployment inherits the previous
// deployment's cursor. That cursor is at the old contracts' head, which is
// past the new ones' start block — so the loop would resume *ahead* of the
// new deployment's history and never backfill it. Every symptom of that is a
// non-symptom: no error, no gap, the cursor advancing normally, and empty
// tables. It cost an afternoon once already.
//
// Called before the loop rather than inside it, so the answer is a refusal to
// boot instead of a warning repeating every poll interval.
func (ix *Indexer) Preflight(ctx context.Context) error {
	if err := ix.checkCursorContracts(ctx); err != nil {
		return err
	}
	// Not inside the check above, which returns early for a stream that has
	// never run and for a cursor predating the fingerprint. Attribution is
	// about rows, not about the cursor: a database whose `indexer_cursor` was
	// cleared but whose `round_events` was not has no cursor to check and
	// every reason to still need its markets filled in.
	return ix.attributeExistingRounds(ctx)
}

func (ix *Indexer) checkCursorContracts(ctx context.Context) error {
	cursor, found, err := ix.repo.LoadCursor(ctx, ix.stream)
	if err != nil {
		return err
	}
	if !found {
		return nil // nothing to disagree with
	}

	// A cursor written before this check existed. Adopting it is the only
	// option that does not break every running deployment on upgrade, and it
	// is logged because it is the one path here that assumes rather than
	// verifies.
	if cursor.Contracts == "" {
		slog.Warn("indexer cursor predates the contract fingerprint, adopting the current set",
			"stream", ix.stream, "last_block", cursor.LastBlock, "contracts", ix.fingerprint)
		return nil
	}

	if cursor.Contracts != ix.fingerprint {
		return fmt.Errorf(
			"indexer: cursor for stream %s was built from contracts %s but this process watches %s. "+
				"The contracts were redeployed: resuming would skip the new deployment's history "+
				"(cursor is at block %d, start block is %d) and index nothing while reporting healthy. "+
				"Reset the derived index to re-read from the start:\n"+
				"  DELETE FROM ledger_entries; DELETE FROM round_events; DELETE FROM indexer_cursor;",
			ix.stream, cursor.Contracts, ix.fingerprint, cursor.LastBlock, ix.cfg.StartBlock)
	}
	return nil
}

// attributeExistingRounds fills in the market on rows indexed before there was
// a column for it.
//
// Migration 0005 added the column and could not populate it — SQL has no
// access to which market this process was configured to watch. So the repair
// lands here, where the configured list is in scope and the answer can be
// checked instead of assumed.
//
// One market configured: those rows were written by a process watching exactly
// that one, so the attribution is a fact. More than one: refuse. The rows
// could belong to any of them, the ids collide across markets by construction,
// and a wrong attribution is invisible forever after — it does not fail, it
// just files someone's position under the wrong market and sums it into the
// wrong pool.
func (ix *Indexer) attributeExistingRounds(ctx context.Context) error {
	pending, err := ix.repo.UnattributedRoundEvents(ctx, ix.cfg.ChainID)
	if err != nil {
		return err
	}
	if pending == 0 {
		return nil
	}

	markets := ix.marketAddresses()
	if len(markets) != 1 {
		return fmt.Errorf(
			"indexer: %d round events were indexed before markets were distinguished and carry no market, "+
				"but this process watches %d of them (%s) — so which market those rows belong to cannot be "+
				"established here. Attribute them by hand if you know, or reset the derived index to re-read "+
				"them from the chain:\n"+
				"  DELETE FROM ledger_entries; DELETE FROM round_events; DELETE FROM indexer_cursor;",
			pending, len(markets), strings.Join(markets, ", "))
	}

	updated, err := ix.repo.AttributeRoundEvents(ctx, ix.cfg.ChainID, markets[0])
	if err != nil {
		return err
	}
	// Logged rather than silent: this is the one write the indexer makes that
	// is an inference about history rather than a decoding of a log, and the
	// record of having made it is what a later "why is this position in that
	// market" question is answered from.
	slog.Info("attributed round events indexed before markets were distinguished",
		"chain_id", ix.cfg.ChainID, "market", markets[0], "rows", updated)
	return nil
}

// marketAddresses lists the watched markets, checksummed and in a stable
// order, from the specs rather than from the config — so it describes what is
// actually being filtered on.
func (ix *Indexer) marketAddresses() []string {
	var out []string
	for _, c := range ix.contracts {
		if c.market != "" {
			out = append(out, c.market)
		}
	}
	sort.Strings(out)
	return out
}

// marketOf returns the address a round event should be attributed to, and ""
// for the contracts that do not emit round events.
//
// Checksummed, because that is the spelling every other address in the ledger
// carries — the account column included — and a market written one way and
// queried another matches nothing while looking entirely plausible.
func marketOf(name string, address common.Address) string {
	if name != abis.ParimutuelRound {
		return ""
	}
	return address.Hex()
}

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
		cursor = ledger.Cursor{
			Stream: ix.stream, ChainID: ix.cfg.ChainID,
			LastBlock: ix.cfg.StartBlock - 1, Contracts: ix.fingerprint,
		}
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

	batch, err := ix.decodeLogs(ctx, logs)
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
		Contracts: ix.fingerprint,
	}
	if err := ix.repo.Append(ctx, batch, next); err != nil {
		return err
	}

	if batch.Len() > 0 {
		slog.Info("indexed", "from", from, "to", to, "logs", len(logs),
			"entries", len(batch.Entries), "round_events", len(batch.Rounds))
		ix.publish(batch, next)
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

func (ix *Indexer) decodeLogs(ctx context.Context, logs []types.Log) (ledger.Batch, error) {
	// Block timestamps are not on the log, and fetching a header per log
	// would be one RPC call per event. Cached per block instead.
	blockTimes := map[uint64]time.Time{}

	var out ledger.Batch
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
				return ledger.Batch{}, fmt.Errorf("header %d: %w", log.BlockNumber, err)
			}
			blockTime = time.Unix(int64(header.Time), 0).UTC()
			blockTimes[log.BlockNumber] = blockTime
		}

		decoded, err := spec.decodeLog(ix.cfg.ChainID, log, blockTime)
		if err != nil {
			return ledger.Batch{}, err
		}
		out.Entries = append(out.Entries, decoded.Entries...)
		out.Rounds = append(out.Rounds, decoded.Rounds...)
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

// publish notifies the live broker, after the commit and never before.
//
// Order matters: a subscriber woken by this immediately re-reads the database,
// and waking it before the transaction commits would have it read the state
// the update is announcing has changed, then never hear about it again.
func (ix *Indexer) publish(batch ledger.Batch, cursor ledger.Cursor) {
	if ix.publisher == nil {
		return
	}
	ix.publisher.Publish(batch, cursor)
}
