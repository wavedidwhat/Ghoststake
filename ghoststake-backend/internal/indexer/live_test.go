package indexer_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/chain"
	"github.com/wavedidwhat/ghoststake/internal/indexer"
	"github.com/wavedidwhat/ghoststake/internal/ledger"
	"github.com/wavedidwhat/ghoststake/internal/store"
)

// The seed script's borrower, in the checksummed form both auth and the
// indexer produce.
const seededBorrower = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

// Everything else in this package runs against fakes. This one runs against a
// real chain and a real database, which is the only way to find out whether
// the event signatures, the field names and the address format actually match
// what a node emits — none of which a fixture can tell you.
//
// Needs the local stack up (scripts/local-stack.sh) and TEST_DATABASE_URL.
// Run it with `make test-live`.
func TestLiveIndexerAgainstAnvil(t *testing.T) {
	rpcURL := os.Getenv("LIVE_RPC_URL")
	dsn := os.Getenv("TEST_DATABASE_URL")
	vault, pool := os.Getenv("VAULT_ADDRESS"), os.Getenv("POOL_ADDRESS")
	market := os.Getenv("MARKET_ADDRESS")
	if rpcURL == "" || dsn == "" || vault == "" || pool == "" || market == "" {
		t.Skip("needs LIVE_RPC_URL, TEST_DATABASE_URL, VAULT_ADDRESS, POOL_ADDRESS, MARKET_ADDRESS")
	}

	ctx := context.Background()

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer st.Close()
	if err := st.Migrate(false); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	client, err := chain.Dial(ctx, rpcURL, 31337)
	if err != nil {
		t.Fatalf("dial anvil: %v", err)
	}
	defer client.Close()

	ix, err := indexer.New(client, st, indexer.Config{
		ChainID:         31337,
		VaultAddress:    vault,
		PoolAddress:     pool,
		MarketAddresses: []string{market},
		StartBlock:      1,
		// anvil mines on demand and does not reorg, so nothing is gained by
		// staying behind the head.
		Confirmations: 0,
		BatchSize:     1000,
	})
	if err != nil {
		t.Fatalf("new indexer: %v", err)
	}

	// Step until caught up rather than sleeping: the loop is a no-op once the
	// cursor reaches the head, so this converges immediately.
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if err := ix.Step(ctx); err != nil {
			t.Fatalf("step: %v", err)
		}
		n, err := st.CountEntries(ctx, 31337)
		if err != nil {
			t.Fatalf("count: %v", err)
		}
		if n > 0 {
			t.Logf("indexed %d ledger entries from the live chain", n)
			break
		}
	}

	balances, err := st.BalancesOf(ctx, 31337, seededBorrower)
	if err != nil {
		t.Fatalf("balances: %v", err)
	}
	if len(balances) == 0 {
		t.Fatalf("no balances derived for the seeded borrower %s — "+
			"either nothing was indexed or the account format does not match", seededBorrower)
	}

	// Shares come from the vault's Transfer mint. The exact figure depends on
	// ERC-4626's decimals offset, so this asserts it exists and is positive
	// rather than pinning a number the contract is free to change.
	shares := balances[ledger.Shares]
	if shares == nil || shares.Sign() <= 0 {
		t.Fatalf("shares book is %v, want positive", shares)
	}
	t.Logf("derived shares      %s", shares)

	// Debt is the scaled amount from the pool, which must be positive after
	// the seed's 3,000 borrow.
	debt := balances[ledger.DebtScaled]
	if debt == nil || debt.Sign() <= 0 {
		t.Fatalf("debt_scaled is %v, want positive", debt)
	}
	t.Logf("derived debt_scaled %s", debt)

	// The one exactly predictable figure: the seed deposits 10,000 mUSDC at
	// six decimals, and Deposited carries the asset amount verbatim.
	deposits, err := st.BalanceOf(ctx, 31337, seededBorrower, ledger.Deposits)
	if err != nil {
		t.Fatalf("deposits: %v", err)
	}
	// Flow ledgers are excluded from balance queries by design, so this must
	// come back zero — proving the kind filter works on real data too.
	if deposits.Sign() != 0 {
		t.Fatalf("a flow ledger leaked into a balance query: %s", deposits)
	}

	if _, present := balances[ledger.Deposits]; present {
		t.Fatal("deposits appeared in the derived balances")
	}

	// The market's events land in their own table, and the round they belong
	// to is folded from them rather than read from the contract. A zero here
	// would mean the ParimutuelRound ABI matched nothing a node emitted —
	// which is the exact failure that produces a healthy-looking indexer with
	// an empty rounds page.
	roundEvents, err := st.CountRoundEvents(ctx, 31337)
	if err != nil {
		t.Fatalf("count round events: %v", err)
	}
	if roundEvents == 0 {
		t.Fatal("no round events indexed — the market's event signatures matched nothing")
	}
	t.Logf("indexed %d round events", roundEvents)

	refs, err := st.RecentRounds(ctx, 31337, "", 10)
	if err != nil {
		t.Fatalf("recent rounds: %v", err)
	}
	events, err := st.RoundEventsByRefs(ctx, 31337, refs)
	if err != nil {
		t.Fatalf("round events: %v", err)
	}
	rounds := ledger.Project(events)
	if len(rounds) == 0 {
		t.Fatal("round events indexed but nothing projected")
	}
	for _, round := range rounds {
		t.Logf("round %d %-8s up %s down %s (block %d)",
			round.RoundID, round.Status, round.UpPool, round.DownPool, round.LastBlock)
	}

	// The seed opens a round with stakes on both sides, so the derived pools
	// must be positive — a pool of zero would mean PositionTaken decoded but
	// its amount did not.
	if rounds[0].TotalPool().Sign() <= 0 {
		t.Fatalf("round %d has an empty pool: up %s down %s",
			rounds[0].RoundID, rounds[0].UpPool, rounds[0].DownPool)
	}
}
