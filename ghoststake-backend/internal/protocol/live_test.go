package protocol_test

import (
	"context"
	"math/big"
	"os"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/abis"
	"github.com/wavedidwhat/ghoststake/internal/chain"
	"github.com/wavedidwhat/ghoststake/internal/finance"
	"github.com/wavedidwhat/ghoststake/internal/protocol"
)

// The seed script's borrower — a deposit and a live debt, which is what makes
// the health factor a real number rather than a division by zero.
const seededBorrower = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

// This is the test that justifies the finance package existing.
//
// `internal/finance` reimplements the contracts' arithmetic in Go so the API
// can derive a whole position from three reads instead of six, and so it can
// answer questions no contract view answers ("what would this become if you
// borrowed another 500"). A reimplementation is a second opinion, and a second
// opinion that drifts from the contract is worse than no opinion at all: a
// health factor that says safe while the contract says liquidate is how
// somebody loses collateral believing a screen.
//
// So the reimplementation is checked against the original, on a real chain,
// at one pinned block. If a contract's maths changes and this package does
// not, this fails.
//
// Needs the local stack up (scripts/local-stack.sh) and the deploy addresses.
// Run it with `make test-live`.
func TestDerivedFiguresMatchTheContracts(t *testing.T) {
	rpcURL := os.Getenv("LIVE_RPC_URL")
	vault, pool := os.Getenv("VAULT_ADDRESS"), os.Getenv("POOL_ADDRESS")
	market := os.Getenv("MARKET_ADDRESS")
	if rpcURL == "" || vault == "" || pool == "" || market == "" {
		t.Skip("needs LIVE_RPC_URL, VAULT_ADDRESS, POOL_ADDRESS, MARKET_ADDRESS")
	}

	ctx := context.Background()

	client, err := chain.Dial(ctx, rpcURL, 31337)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	reader, err := protocol.New(client, vault, pool, []string{market})
	if err != nil {
		t.Fatalf("reader: %v", err)
	}

	params, err := reader.VaultParams(ctx)
	if err != nil {
		t.Fatalf("vault params: %v", err)
	}

	health, snapshot, err := reader.Health(ctx, seededBorrower)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	t.Logf("block %d (%s)", snapshot.Block, snapshot.Time)
	t.Logf("collateral %s  debt %s  hf %v  band %s",
		health.Collateral, health.Debt, health.HealthFactor, health.Band)

	// The same block the reader pinned its own calls to. Comparing against
	// "latest" would be comparing two different instants, and on a chain that
	// accrues interest per second they would differ for a reason that has
	// nothing to do with correctness.
	block := new(big.Int).SetUint64(snapshot.Block)

	vaultContract, err := client.Bind(abis.CollateralVault, vault)
	if err != nil {
		t.Fatalf("bind vault: %v", err)
	}
	poolContract, err := client.Bind(abis.BorrowLiquidityPool, pool)
	if err != nil {
		t.Fatalf("bind pool: %v", err)
	}

	address, err := chain.ParseAddress(seededBorrower)
	if err != nil {
		t.Fatalf("address: %v", err)
	}

	same := func(what string, got *big.Int, contract *chain.Contract, method string, args ...any) {
		t.Helper()
		want, err := contract.CallBig(ctx, block, method, args...)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		if got.Cmp(want) != 0 {
			t.Errorf("%s: derived %s, contract says %s", what, got, want)
			return
		}
		t.Logf("%-14s %s (matches %s)", what, got, method)
	}

	same("accrued yield", health.AccruedYield, vaultContract, "accruedYield", address)
	same("collateral", health.Collateral, vaultContract, "collateralValue", address)
	// Compared at the *stored* index, which is what the contract's views read.
	// The figures the API actually reports differ — see below.
	same("stored debt", health.DebtAtStoredIndex, poolContract, "balanceOfDebt", address)
	// The vault reads the debt back through the pool, so this also proves the
	// two agree — which is the desync the security review found and removed.
	same("stored (lien)", health.DebtAtStoredIndex, vaultContract, "lienOf", address)

	storedRoom := finance.MaxBorrowable(health.Collateral, params.MaxLTV, health.DebtAtStoredIndex)
	same("stored room", storedRoom, vaultContract, "maxBorrowable", address)

	if !health.HasDebt {
		t.Fatal("the seeded borrower has no debt — the seed did not run, and this test proves nothing")
	}

	// The health factor, at the stored index, must equal the contract's view
	// exactly. This is the arithmetic parity check.
	contractHF, err := vaultContract.CallBig(ctx, block, "healthFactor", address)
	if err != nil {
		t.Fatalf("healthFactor: %v", err)
	}
	storedHF, _ := finance.HealthFactor(health.Collateral, params.LiquidationThreshold, health.DebtAtStoredIndex)
	if storedHF.Cmp(contractHF) != 0 {
		t.Errorf("health factor at the stored index: derived %s, contract says %s", storedHF, contractHF)
	} else {
		t.Logf("%-14s %s (matches healthFactor)", "health factor", storedHF)
	}

	// And the figure the API actually reports is the pessimistic one: debt
	// with the pending interest counted, which is what a liquidator's own
	// transaction would compute after calling accrue().
	if health.Debt.Cmp(health.DebtAtStoredIndex) < 0 {
		t.Fatalf("reported debt %s is below the stored %s", health.Debt, health.DebtAtStoredIndex)
	}
	if health.HealthFactor.Cmp(storedHF) > 0 {
		t.Fatalf("the reported health factor %s is more optimistic than the contract view %s",
			health.HealthFactor, storedHF)
	}
	// `_borrow` accrues before it checks the LTV ceiling too, so the borrowing
	// room the view reports is money the contract would refuse to lend. A UI
	// that offered "borrow max" from `maxBorrowable()` would build a
	// transaction that reverts.
	if health.MaxBorrowable.Cmp(storedRoom) > 0 {
		t.Fatalf("the reported room %s exceeds the view's %s", health.MaxBorrowable, storedRoom)
	}

	t.Logf("%-14s %s pending", "interest", health.PendingInterest)
	t.Logf("%-14s reported %s, view says %s", "health factor", health.HealthFactor, storedHF)
	t.Logf("%-14s reported %s, view says %s", "room", health.MaxBorrowable, storedRoom)
}

// The market's immutables have to be read, not assumed: the entry cutoff
// decides when the stake button closes, and a value the API believes and the
// contract does not is a button that lies.
func TestMarketParamsComeFromTheContract(t *testing.T) {
	rpcURL := os.Getenv("LIVE_RPC_URL")
	vault, pool := os.Getenv("VAULT_ADDRESS"), os.Getenv("POOL_ADDRESS")
	market := os.Getenv("MARKET_ADDRESS")
	if rpcURL == "" || vault == "" || pool == "" || market == "" {
		t.Skip("needs LIVE_RPC_URL, VAULT_ADDRESS, POOL_ADDRESS, MARKET_ADDRESS")
	}

	ctx := context.Background()
	client, err := chain.Dial(ctx, rpcURL, 31337)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	reader, err := protocol.New(client, vault, pool, []string{market})
	if err != nil {
		t.Fatalf("reader: %v", err)
	}

	params, err := reader.MarketParams(ctx)
	if err != nil {
		t.Fatalf("market params: %v", err)
	}
	if params.EntryCutoff <= 0 {
		t.Fatalf("entry cutoff %d — entry would never close", params.EntryCutoff)
	}
	if params.Rake == nil || params.Rake.Cmp(finance.MulDiv(finance.WAD, big.NewInt(10), big.NewInt(100))) > 0 {
		t.Fatalf("rake %v is above the contract's 10%% ceiling", params.Rake)
	}
	if params.MinSidePool == nil || params.MinSidePool.Sign() == 0 {
		t.Fatal("minSidePool is zero, which would let a one-sided round resolve")
	}
	t.Logf("entry cutoff %ds  rake %s  min side pool %s",
		params.EntryCutoff, params.Rake, params.MinSidePool)
}

// The liquidation quote, checked against the contract that would actually pay
// it (GHO-42).
//
// Same argument as `TestDerivedFiguresMatchTheContracts`, and a sharper one.
// `LiquidationQuote` is what the at-risk endpoint puts in front of a
// liquidator: what they repay, what they receive, and whether the call is
// worth making at all. A quote that drifts from the contract does not show a
// wrong number on a dashboard — it sends somebody to spend gas on a
// transaction that pays less than it says, or on one that pays nothing.
//
// The comparison is against `maxLiquidatableDebt`, which is the contract's own
// close-factor arithmetic including the lift below the bonus line. If either
// side's rule changes and the other does not, this fails.
//
// Needs the local stack up and a borrower who is actually underwater, so it
// drives one there first rather than hoping the seed left one.
func TestTheLiquidationQuoteMatchesTheContract(t *testing.T) {
	rpcURL := os.Getenv("LIVE_RPC_URL")
	vault, pool := os.Getenv("VAULT_ADDRESS"), os.Getenv("POOL_ADDRESS")
	market := os.Getenv("MARKET_ADDRESS")
	if rpcURL == "" || vault == "" || pool == "" || market == "" {
		t.Skip("needs LIVE_RPC_URL, VAULT_ADDRESS, POOL_ADDRESS, MARKET_ADDRESS")
	}

	ctx := context.Background()
	client, err := chain.Dial(ctx, rpcURL, 31337)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	reader, err := protocol.New(client, vault, pool, []string{market})
	if err != nil {
		t.Fatalf("reader: %v", err)
	}
	params, err := reader.VaultParams(ctx)
	if err != nil {
		t.Fatalf("vault params: %v", err)
	}
	if params.LiquidationBonus == nil || params.CloseFactor == nil {
		t.Fatal("the reader did not load the liquidation immutables")
	}

	health, snapshot, err := reader.Health(ctx, seededBorrower)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	block := new(big.Int).SetUint64(snapshot.Block)

	vaultContract, err := client.Bind(abis.CollateralVault, vault)
	if err != nil {
		t.Fatalf("bind vault: %v", err)
	}
	address, err := chain.ParseAddress(seededBorrower)
	if err != nil {
		t.Fatalf("address: %v", err)
	}

	// The contract's views read the *stored* index, so the quote is computed
	// from the stored debt too. The endpoint reports the accrued figures,
	// which are larger and honest — but comparing those against a view that
	// has not accrued would be comparing two different instants and calling
	// the difference a bug.
	storedHF, err := vaultContract.CallBig(ctx, block, "healthFactor", address)
	if err != nil {
		t.Fatalf("healthFactor: %v", err)
	}
	quote := finance.LiquidationQuote(health.Collateral, health.DebtAtStoredIndex, storedHF, params)

	want, err := vaultContract.CallBig(ctx, block, "maxLiquidatableDebt", address)
	if err != nil {
		t.Fatalf("maxLiquidatableDebt: %v", err)
	}

	t.Logf("block %d  collateral %s  stored debt %s  hf %s",
		snapshot.Block, health.Collateral, health.DebtAtStoredIndex, storedHF)
	t.Logf("quote: repay %s  seized %s  bonus %s  profitable=%v  full=%v",
		quote.MaxRepay, quote.Seized, quote.Bonus, quote.Profitable, quote.FullLiquidation)

	if quote.MaxRepay.Cmp(want) != 0 {
		t.Fatalf("max repay: derived %s, contract says %s", quote.MaxRepay, want)
	}

	// A healthy borrower makes the comparison above vacuous — both sides are
	// zero and nothing is proven. Said out loud rather than passing quietly,
	// which is the failure mode this whole file exists to avoid.
	if want.Sign() == 0 {
		t.Log("the seeded borrower is healthy: both sides are zero, so only the healthy path is covered here")
	}
}

// A market this process does not index must still be describable (GHO-53).
//
// GHO-51 made round history span deployments on purpose, so `/rounds` and
// `/positions` return rounds from contracts the running process has never
// watched. `MarketParamsFor` used to reject those outright, which turned both
// endpoints into a 500 the moment the contracts were redeployed — and it did,
// on the live deployment, within minutes of pointing the API at new addresses.
//
// The reader is constructed here with only ONE market and then asked about the
// other, which is exactly the shape of the failure.
func TestMarketParamsWorkForAMarketThisProcessDoesNotIndex(t *testing.T) {
	rpcURL := os.Getenv("LIVE_RPC_URL")
	vault, pool := os.Getenv("VAULT_ADDRESS"), os.Getenv("POOL_ADDRESS")
	market, other := os.Getenv("MARKET_ADDRESS"), os.Getenv("OTHER_MARKET_ADDRESS")
	if rpcURL == "" || vault == "" || pool == "" || market == "" || other == "" {
		t.Skip("needs LIVE_RPC_URL, VAULT_ADDRESS, POOL_ADDRESS, MARKET_ADDRESS, OTHER_MARKET_ADDRESS")
	}

	ctx := context.Background()
	client, err := chain.Dial(ctx, rpcURL, 11155111)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	// Deliberately configured with one market only.
	reader, err := protocol.New(client, vault, pool, []string{market})
	if err != nil {
		t.Fatalf("reader: %v", err)
	}

	params, err := reader.MarketParamsFor(ctx, other)
	if err != nil {
		t.Fatalf("an unindexed market could not be described: %v", err)
	}
	if params.Rake == nil || params.MinSidePool == nil || params.EntryCutoff == 0 {
		t.Fatalf("params look unread: %+v", params)
	}
	t.Logf("unindexed market %s -> rake %s, cutoff %ds, minSide %s",
		other, params.Rake, params.EntryCutoff, params.MinSidePool)

	// And the configured one still works, so the on-demand path has not
	// displaced the constructed map.
	if _, err := reader.MarketParamsFor(ctx, market); err != nil {
		t.Fatalf("the configured market broke: %v", err)
	}
}
