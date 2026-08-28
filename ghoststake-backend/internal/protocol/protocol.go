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

	"github.com/ethereum/go-ethereum/common"

	"github.com/wavedidwhat/ghoststake/internal/abis"
	"github.com/wavedidwhat/ghoststake/internal/chain"
	"github.com/wavedidwhat/ghoststake/internal/finance"
)

// Reader reads the deployed protocol.
type Reader struct {
	client *chain.Client
	vault  *chain.Contract
	pool   *chain.Contract
	// market is the primary market — the first configured — and is what
	// MarketParams answers for. Kept so callers with no market in hand still
	// have a default; anything rendering a specific round asks for that
	// round's market instead.
	market  *chain.Contract
	markets map[string]*chain.Contract

	mu     sync.Mutex
	vaultP *finance.VaultParams
	mktP   map[string]MarketParams
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

func New(client *chain.Client, vaultAddress, poolAddress string, marketAddresses []string) (*Reader, error) {
	vault, err := client.Bind(abis.CollateralVault, vaultAddress)
	if err != nil {
		return nil, err
	}
	pool, err := client.Bind(abis.BorrowLiquidityPool, poolAddress)
	if err != nil {
		return nil, err
	}
	if len(marketAddresses) == 0 {
		return nil, fmt.Errorf("protocol: at least one market address is required")
	}

	// Keyed by checksummed address, which is the spelling the indexer stamps
	// onto every round event — so a market read out of the database finds its
	// parameters without anyone normalising at the call site.
	markets := make(map[string]*chain.Contract, len(marketAddresses))
	for _, address := range marketAddresses {
		bound, err := client.Bind(abis.ParimutuelRound, address)
		if err != nil {
			return nil, err
		}
		markets[common.HexToAddress(address).Hex()] = bound
	}
	primary, err := client.Bind(abis.ParimutuelRound, marketAddresses[0])
	if err != nil {
		return nil, err
	}

	return &Reader{
		client: client, vault: vault, pool: pool,
		market: primary, markets: markets,
		mktP: map[string]MarketParams{},
	}, nil
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
	// The two below are only used to quote a liquidation (GHO-42), and are
	// read here rather than on demand because they are `immutable` in
	// Solidity like the other two — a separate lazy read would be a second
	// cache of constants, with a second chance to be stale about them.
	bonus, err := r.vault.CallBig(ctx, nil, "liquidationBonus")
	if err != nil {
		return finance.VaultParams{}, err
	}
	closeFactor, err := r.vault.CallBig(ctx, nil, "closeFactor")
	if err != nil {
		return finance.VaultParams{}, err
	}

	params := finance.VaultParams{
		MaxLTV:               maxLTV,
		LiquidationThreshold: threshold,
		LiquidationBonus:     bonus,
		CloseFactor:          closeFactor,
	}

	r.mu.Lock()
	r.vaultP = &params
	r.mu.Unlock()
	return params, nil
}

// MarketParams reads the primary market's immutables.
func (r *Reader) MarketParams(ctx context.Context) (MarketParams, error) {
	return r.marketParams(ctx, "", r.market)
}

// MarketParamsFor reads one named market's immutables.
//
// Per market rather than one cached set, because they are per market in the
// contracts: rake, entry cutoff and minimum side pool are constructor
// arguments, and the demo market is deliberately configured differently from
// the Chainlink-settled one. Rendering every round's odds with the primary
// market's rake would be a plausible wrong number on every row of the other
// market's history.
//
// An unknown address is an error rather than a fallback to the primary. A
// fallback is how the wrong rake gets applied silently, which is the bug this
// method exists to prevent.
func (r *Reader) MarketParamsFor(ctx context.Context, market string) (MarketParams, error) {
	if market == "" {
		return r.MarketParams(ctx)
	}
	key := common.HexToAddress(market).Hex()
	bound, ok := r.markets[key]
	if !ok {
		return MarketParams{}, fmt.Errorf("protocol: %s is not a configured market", key)
	}
	return r.marketParams(ctx, key, bound)
}

func (r *Reader) marketParams(ctx context.Context, key string, market *chain.Contract) (MarketParams, error) {
	r.mu.Lock()
	cached, ok := r.mktP[key]
	r.mu.Unlock()
	if ok {
		return cached, nil
	}

	values, err := market.CallAt(ctx, nil, "entryCutoff")
	if err != nil {
		return MarketParams{}, err
	}
	cutoff, ok := values[0].(uint64)
	if !ok {
		return MarketParams{}, fmt.Errorf("protocol: entryCutoff returned %T", values[0])
	}
	rake, err := market.CallBig(ctx, nil, "rake")
	if err != nil {
		return MarketParams{}, err
	}
	minSide, err := market.CallBig(ctx, nil, "minSidePool")
	if err != nil {
		return MarketParams{}, err
	}
	params := MarketParams{EntryCutoff: int64(cutoff), Rake: rake, MinSidePool: minSide}

	r.mu.Lock()
	r.mktP[key] = params
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

// HealthBatch reads several accounts' positions, all pinned to one block.
//
// Not a loop over Health, and the difference is most of the cost. Of the reads
// Health makes, five are about the pool rather than the account — the block,
// its header, the borrow index, the borrow rate and the last accrual time —
// and repeating them per account multiplies the expensive part of the call by
// the number of borrowers for no additional information. Hoisted, an account
// costs four reads instead of nine.
//
// One block for all of them, which matters more here than it does for a single
// account. This produces a *ranking*, and a list ordered by health factors
// sampled at different blocks is ordered by nothing in particular — the rate
// advances every second, so the account read last would look marginally
// sicker than the one read first purely for being read later.
//
// The returned slice is aligned with `accounts`. An account that cannot be
// parsed is an input error and fails the whole call rather than being silently
// dropped, because a caller ranking positions by risk must not be handed a
// list that is quietly missing one.
func (r *Reader) HealthBatch(ctx context.Context, accounts []string) ([]finance.Health, Snapshot, error) {
	params, err := r.VaultParams(ctx)
	if err != nil {
		return nil, Snapshot{}, err
	}
	snap, block, err := r.snapshot(ctx)
	if err != nil {
		return nil, Snapshot{}, err
	}
	if len(accounts) == 0 {
		return nil, snap, nil
	}

	borrowIndex, err := r.pool.CallBig(ctx, block, "borrowIndex")
	if err != nil {
		return nil, Snapshot{}, err
	}
	borrowRate, err := r.pool.CallBig(ctx, block, "borrowRatePerSecond")
	if err != nil {
		return nil, Snapshot{}, err
	}
	lastAccrual, err := r.pool.CallBig(ctx, block, "lastAccrualTime")
	if err != nil {
		return nil, Snapshot{}, err
	}

	out := make([]finance.Health, 0, len(accounts))
	for _, account := range accounts {
		address, err := chain.ParseAddress(account)
		if err != nil {
			return nil, Snapshot{}, err
		}

		position, err := r.vault.CallAt(ctx, block, "positions", address)
		if err != nil {
			return nil, Snapshot{}, err
		}
		if len(position) != 4 {
			return nil, Snapshot{}, fmt.Errorf("protocol: positions returned %d values, want 4", len(position))
		}
		shares, err := r.vault.CallBig(ctx, block, "balanceOf", address)
		if err != nil {
			return nil, Snapshot{}, err
		}
		sharesValue, err := r.vault.CallBig(ctx, block, "convertToAssets", shares)
		if err != nil {
			return nil, Snapshot{}, err
		}
		scaledDebt, err := r.pool.CallBig(ctx, block, "scaledDebt", address)
		if err != nil {
			return nil, Snapshot{}, err
		}

		startTime, ok := position[1].(*big.Int)
		if !ok {
			return nil, Snapshot{}, fmt.Errorf("protocol: positions.startTime returned %T", position[1])
		}

		out = append(out, finance.Describe(finance.VaultState{
			Principal:     asBig(position[0]),
			StartTime:     startTime.Int64(),
			RatePerSecond: asBig(position[2]),
			SettledYield:  asBig(position[3]),
			SharesValue:   sharesValue,
			ScaledDebt:    scaledDebt,
			BorrowIndex:   borrowIndex,

			BorrowRatePerSecond: borrowRate,
			LastAccrualTime:     lastAccrual.Int64(),
		}, params, snap.Time.Unix()))
	}

	return out, snap, nil
}

func asBig(v any) *big.Int {
	b, ok := v.(*big.Int)
	if !ok {
		return new(big.Int)
	}
	return b
}
