package store_test

import (
	"context"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
	"github.com/wavedidwhat/ghoststake/internal/store"
)

const testChainID int64 = 421614

// newTestStore connects to TEST_DATABASE_URL and migrates.
//
// Skipped rather than failed when the variable is unset, so `go test ./...`
// stays runnable without a database. CI sets it, so the skip does not become
// a way for these to quietly stop running.
func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}

	st, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := st.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(st.Close)
	return st
}

func entry(account, book string, delta int64, block uint64, tx string, logIndex uint, entryIndex int) ledger.Entry {
	kind := ledger.KindBalance
	switch book {
	case "deposits", "withdrawals", "yield_settled", "borrow_flow", "repay_flow", "liquidations", "lien_settled":
		kind = ledger.KindFlow
	}
	return ledger.Entry{
		ChainID: testChainID, BlockNumber: block, BlockHash: "0xblock", BlockTime: time.Unix(1700000000, 0).UTC(),
		TxHash: tx, LogIndex: logIndex, EntryIndex: entryIndex,
		Contract: "CollateralVault", EventName: "Transfer", Kind: kind,
		Account: account, Ledger: book, Delta: big.NewInt(delta),
	}
}

func cursorAt(block uint64, hash string) ledger.Cursor {
	return ledger.Cursor{Stream: "test", ChainID: testChainID, LastBlock: block, LastHash: hash}
}

// Each test works in its own account namespace so they do not collide when
// run against a shared database.
func account(t *testing.T, suffix string) string {
	t.Helper()
	return "0xacc" + t.Name() + suffix
}

func TestBalanceIsDerivedFromEntries(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")

	err := st.AppendEntries(ctx, []ledger.Entry{
		entry(acct, "shares", 1000, 10, "0xa", 0, 0),
		entry(acct, "shares", -250, 11, "0xb", 0, 0),
		entry(acct, "shares", 40, 12, "0xc", 0, 0),
	}, cursorAt(12, "0xh12"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	got, err := st.BalanceOf(ctx, testChainID, acct, "shares")
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if got.Cmp(big.NewInt(790)) != 0 {
		t.Fatalf("want 790, got %s", got)
	}
}

// The whole point of the append-only design: replaying a range must not
// change any balance. Restarts, overlapping backfills and a retried cycle
// all do exactly this.
func TestReplayingARangeIsANoOp(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")

	batch := []ledger.Entry{
		entry(acct, "shares", 500, 20, "0xdup", 0, 0),
		entry(acct, "shares", 500, 20, "0xdup", 0, 1),
	}
	for i := 0; i < 3; i++ {
		if err := st.AppendEntries(ctx, batch, cursorAt(20, "0xh20")); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	got, err := st.BalanceOf(ctx, testChainID, acct, "shares")
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if got.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("replay double counted: want 1000, got %s", got)
	}
}

// Two entries from one log differ only by entry_index. If that column were
// missing from the unique constraint, the second would be swallowed and half
// a transfer would vanish.
func TestBothLegsOfOneLogSurvive(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	from, to := account(t, "from"), account(t, "to")

	err := st.AppendEntries(ctx, []ledger.Entry{
		{ChainID: testChainID, BlockNumber: 30, BlockHash: "0xb", BlockTime: time.Now().UTC(),
			TxHash: "0xleg", LogIndex: 7, EntryIndex: 0, Contract: "CollateralVault",
			EventName: "Transfer", Kind: "balance", Account: from, Ledger: "shares", Delta: big.NewInt(-100)},
		{ChainID: testChainID, BlockNumber: 30, BlockHash: "0xb", BlockTime: time.Now().UTC(),
			TxHash: "0xleg", LogIndex: 7, EntryIndex: 1, Contract: "CollateralVault",
			EventName: "Transfer", Kind: "balance", Account: to, Ledger: "shares", Delta: big.NewInt(100)},
	}, cursorAt(30, "0xh30"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	debit, _ := st.BalanceOf(ctx, testChainID, from, "shares")
	credit, _ := st.BalanceOf(ctx, testChainID, to, "shares")
	if debit.Cmp(big.NewInt(-100)) != 0 || credit.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("a leg was lost: debit=%s credit=%s", debit, credit)
	}
}

func TestFlowEntriesNeverEnterABalance(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")

	err := st.AppendEntries(ctx, []ledger.Entry{
		entry(acct, "shares", 100, 40, "0xf", 0, 0),
		entry(acct, "deposits", 9999, 40, "0xf", 1, 0),
	}, cursorAt(40, "0xh40"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	balances, err := st.BalancesOf(ctx, testChainID, acct)
	if err != nil {
		t.Fatalf("balances: %v", err)
	}
	if _, present := balances["deposits"]; present {
		t.Fatal("a flow ledger appeared in the derived balances")
	}
	if balances["shares"].Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("want 100 shares, got %s", balances["shares"])
	}
}

func TestRollbackRemovesEntriesAndRewindsTheCursor(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")

	err := st.AppendEntries(ctx, []ledger.Entry{
		entry(acct, "shares", 100, 50, "0xr1", 0, 0),
		entry(acct, "shares", 100, 51, "0xr2", 0, 0),
		entry(acct, "shares", 100, 52, "0xr3", 0, 0),
	}, cursorAt(52, "0xh52"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	deleted, err := st.RollbackFrom(ctx, testChainID, "test", 51)
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if deleted != 2 {
		t.Fatalf("want 2 deleted, got %d", deleted)
	}

	got, _ := st.BalanceOf(ctx, testChainID, acct, "shares")
	if got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("want 100 after rollback, got %s", got)
	}

	cursor, found, err := st.LoadCursor(ctx, "test")
	if err != nil || !found {
		t.Fatalf("cursor: %v found=%v", err, found)
	}
	if cursor.LastBlock != 50 {
		t.Fatalf("want cursor at 50, got %d", cursor.LastBlock)
	}
	// The hash must be cleared, or the next reorg check compares against a
	// hash for a block the cursor no longer sits on and sees a false match.
	if cursor.LastHash != "" {
		t.Fatalf("want cleared hash, got %q", cursor.LastHash)
	}
}

// uint256 does not fit in any Go integer type, and NUMERIC(78,0) is exactly
// wide enough. A silent truncation here would be invisible until a whale.
func TestFullWidthUint256SurvivesTheRoundTrip(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")

	max := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	e := entry(acct, "shares", 0, 60, "0xbig", 0, 0)
	e.Delta = max
	if err := st.AppendEntries(ctx, []ledger.Entry{e}, cursorAt(60, "0xh60")); err != nil {
		t.Fatalf("append: %v", err)
	}

	got, err := st.BalanceOf(ctx, testChainID, acct, "shares")
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if got.Cmp(max) != 0 {
		t.Fatalf("uint256 max did not survive: got %s", got)
	}
}

// Audit finding 3: fromBlock is unsigned, so zero would set the cursor to
// `0 - 1` — the top of uint64 — instead of rewinding it to the start.
func TestRollbackRejectsBlockZero(t *testing.T) {
	st := newTestStore(t)
	if _, err := st.RollbackFrom(context.Background(), testChainID, "test", 0); err == nil {
		t.Fatal("rollback from block 0 was accepted")
	}
}

func TestCursorRoundTrips(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	if _, found, err := st.LoadCursor(ctx, "never-run"); err != nil || found {
		t.Fatalf("want not found, got found=%v err=%v", found, err)
	}

	if err := st.AppendEntries(ctx, nil, cursorAt(77, "0xh77")); err != nil {
		t.Fatalf("append: %v", err)
	}
	cursor, found, err := st.LoadCursor(ctx, "test")
	if err != nil || !found {
		t.Fatalf("cursor: %v found=%v", err, found)
	}
	if cursor.LastBlock != 77 || cursor.LastHash != "0xh77" {
		t.Fatalf("cursor round trip failed: %+v", cursor)
	}
}
