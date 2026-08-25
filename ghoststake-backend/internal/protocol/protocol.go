// Package protocol reads live contract state and hands it to the finance
// domain to be turned into numbers.
//
// The split is deliberate and is the whole shape of this part of the backend:
//
//	chain     — how to talk to an RPC endpoint
//	protocol  — which views to read, and at which block
//	finance   — what the numbers mean          (no imports outside stdlib)
//	httpx     — how to say it over HTTP
//
// Nothing here does arithmetic on a balance. It gathers raw state and calls
// finance. If a rule ever needs changing, there is exactly one file to change
// and it has no dependencies to stand up before you can test it.
package protocol

import (
	"context"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/abis"
	"github.com/wavedidwhat/ghoststake/internal/chain"
	"github.com/wavedidwhat/ghoststake/internal/finance"
)

// Reader reads the deployed protocol.
type Reader struct {
	client *chain.Client
	vault  *chain.Contract
	pool   *chain.Contract
	market *chain.Contract

	mu     sync.Mutex
	vaultP *finance.VaultParams
	mktP   *MarketParams
}

// MarketParams are the market's immutables.
type MarketParams struct {
	// EntryCutoff is how many seconds before lock entry stops.
	EntryCutoff int64
	// Rake is the protocol's cut of a resolved round, WAD.
	Rake *big.Int
	// MinSidePool is the least a side may hold at lock for the round to be
	// valid. A round below it voids rather than paying one side a fee on a
	// market that never had two.
	MinSidePool *big.Int
}

func New(client *chain.Client, vaultAddress, poolAddress, marketAddress string) (*Reader, error) {
	vault, err := client.Bind(abis.CollateralVault, vaultAddress)
	if err != nil {
		return nil, err
	}
	pool, err := client.Bind(abis.BorrowLiquidityPool, poolAddress)
	if err != nil {
		return nil, err
	}
	market, err := client.Bind(abis.ParimutuelRound, marketAddress)
	if err != nil {
		return nil, err
	}
	return &Reader{client: client, vault: vault, pool: pool, market: market}, nil
}

// Snapshot is the block a set of reads was pinned to.
type Snapshot struct {
	Block uint64
	// Time is that block's timestamp, which is the clock the contracts
	// themselves used. Yield accrued "as of now" means as of this second, not
	// as of the server's wall clock — those differ by however long the last
	// block took, and on a quiet testnet that is minutes.
	Time time.Time
}

func (r *Reader) snapshot(ctx context.Context) (Snapshot, *big.Int, error) {
	block, err := r.client.BlockNumberBig(ctx)
	if err != nil {
		return Snapshot{}, nil, err
	}
	header, err := r.client.HeaderByNumber(ctx, block)
	if err != nil {
		return Snapshot{}, nil, err
	}
	return Snapshot{
		Block: block.Uint64(),
		Time:  time.Unix(int64(header.Time), 0).UTC(),
	}, block, nil
}

// VaultParams reads and caches the vault's risk immutables.
//
// Cached without expiry because they are `immutable` in Solidity: set at
// construction, unwritable afterwards, and a redeploy is a new address and a
// new process. A TTL here would be a cache that expires to fetch the same
// answer.
func (r *Reader) VaultParams(ctx context.Context) (finance.VaultParams, error) {
	r.mu.Lock()
	cached := r.vaultP
	r.mu.Unlock()
	if cached != nil {
		return *cached, nil
	}

	maxLTV, err := r.vault.CallBig(ctx, nil, "maxLTV")
	if err != nil {
		return finance.VaultParams{}, err
	}
	threshold, err := r.vault.CallBig(ctx, nil, "liquidationThreshold")
	if err != nil {
		return finance.VaultParams{}, err
	}
	params := finance.VaultParams{MaxLTV: maxLTV, LiquidationThreshold: threshold}

	r.mu.Lock()
	r.vaultP = &params
	r.mu.Unlock()
	return params, nil
}

// MarketParams reads and caches the market's immutables.
func (r *Reader) MarketParams(ctx context.Context) (MarketParams, error) {
	r.mu.Lock()
	cached := r.mktP
	r.mu.Unlock()
	if cached != nil {
		return *cached, nil
	}

	values, err := r.market.CallAt(ctx, nil, "entryCutoff")
	if err != nil {
		return MarketParams{}, err
	}
	cutoff, ok := values[0].(uint64)
	if !ok {
		return MarketParams{}, fmt.Errorf("protocol: entryCutoff returned %T", values[0])
	}
	rake, err := r.market.CallBig(ctx, nil, "rake")
	if err != nil {
		return MarketParams{}, err
	}
	minSide, err := r.market.CallBig(ctx, nil, "minSidePool")
	if err != nil {
		return MarketParams{}, err
	}
	params := MarketParams{EntryCutoff: int64(cutoff), Rake: rake, MinSidePool: minSide}

	r.mu.Lock()
	r.mktP = &params
	r.mu.Unlock()
	return params, nil
}

// Health reads one account's whole lending position.
//
// Eight calls, all pinned to one block. Sequential rather than concurrent: a
// public RPC endpoint rate-limits per connection, and eight round trips well
// inside the request's own timeout is not the thing to optimise before there
// is a measurement saying it is.
func (r *Reader) Health(ctx context.Context, account string) (finance.Health, Snapshot, error) {
	params, err := r.VaultParams(ctx)
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}
	snap, block, err := r.snapshot(ctx)
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}

	address, err := chain.ParseAddress(account)
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}

	position, err := r.vault.CallAt(ctx, block, "positions", address)
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}
	if len(position) != 4 {
		return finance.Health{}, Snapshot{}, fmt.Errorf("protocol: positions returned %d values, want 4", len(position))
	}

	shares, err := r.vault.CallBig(ctx, block, "balanceOf", address)
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}
	sharesValue, err := r.vault.CallBig(ctx, block, "convertToAssets", shares)
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}
	scaledDebt, err := r.pool.CallBig(ctx, block, "scaledDebt", address)
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}
	borrowIndex, err := r.pool.CallBig(ctx, block, "borrowIndex")
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}
	// The two reads that let finance advance the index to this block. The
	// stored index is behind by however long it has been since anyone poked
	// the pool, and a health factor computed from it is optimistic — see
	// finance.AccruedBorrowIndex.
	borrowRate, err := r.pool.CallBig(ctx, block, "borrowRatePerSecond")
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}
	lastAccrual, err := r.pool.CallBig(ctx, block, "lastAccrualTime")
	if err != nil {
		return finance.Health{}, Snapshot{}, err
	}

	startTime, ok := position[1].(*big.Int)
	if !ok {
		return finance.Health{}, Snapshot{}, fmt.Errorf("protocol: positions.startTime returned %T", position[1])
	}

	state := finance.VaultState{
		Principal:     asBig(position[0]),
		StartTime:     startTime.Int64(),
		RatePerSecond: asBig(position[2]),
		SettledYield:  asBig(position[3]),
		SharesValue:   sharesValue,
		ScaledDebt:    scaledDebt,
		BorrowIndex:   borrowIndex,

		BorrowRatePerSecond: borrowRate,
		LastAccrualTime:     lastAccrual.Int64(),
	}

	// The block's own timestamp, not time.Now(): this is the clock the
	// contract would use if it computed the same figure in this block.
	return finance.Describe(state, params, snap.Time.Unix()), snap, nil
}

func asBig(v any) *big.Int {
	b, ok := v.(*big.Int)
	if !ok {
		return new(big.Int)
	}
	return b
}
