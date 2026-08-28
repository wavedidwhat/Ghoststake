package store_test

import (
	"context"
	"github.com/ethereum/go-ethereum/common"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
	"github.com/wavedidwhat/ghoststake/internal/store"
)

const testChainID int64 = 421614

// Two deployments' worth of addresses. Checksummed, because that is the form
// the indexer writes and the queries compare against — a lowercased spelling
// matches nothing while looking entirely correct.
var (
	vaultA = common.HexToAddress("0x000000000000000000000000000000000000000a").Hex()
	vaultB = common.HexToAddress("0x000000000000000000000000000000000000000b").Hex()

	deploymentA = []string{vaultA}
	deploymentB = []string{vaultB}
)

// newTestStore connects to TEST_DATABASE_URL and migrates.
//
// Skipped rather than failed when the variable is unset, so `go test ./...`
// stays runnable without a database. CI sets it, so the skip does not become
// a way for these to quietly stop running.
func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		// Skipping locally keeps `go test ./...` runnable without a
		// database. Skipping in CI would mean these quietly stop running the
		// moment the service container breaks — and a suite that reports
		// "ok" while testing nothing is worse than no suite.
		if os.Getenv("CI") != "" {
			t.Fatal("TEST_DATABASE_URL is unset in CI: the Postgres service is not wired up")
		}
		t.Skip("TEST_DATABASE_URL not set (run `make test-remote`)")
	}

	st, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := st.Migrate(false); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(st.Close)
	return st
}

// chainOf gives a test its own chain id, and with it its own everything.
//
// Namespacing the account is not enough for any test that operates on a range
// of blocks. `RollbackFrom` deletes by (chain_id, block_number) across every
// account — that is correct, a reorg does not care whose rows it takes — so a
// test rolling back to block 51 deletes rows another test wrote at block 51
// under an unrelated address, and both then fail in ways that depend on the
// order they happened to run in.
//
// The chain id is the one axis that isolates completely: it leads the
// uniqueness constraint, every index, and every WHERE clause in the store. A
// test that writes on its own chain cannot be seen or deleted by any other.
func chainOf(t *testing.T) int64 {
	t.Helper()
	var hash uint64 = 1469598103934665603
	for _, b := range []byte(t.Name()) {
		hash ^= uint64(b)
		hash *= 1099511628211
	}
	// Kept clear of testChainID and of anything a real network uses, so a row
	// written by a test is recognisable as one.
	return 900_000_000 + int64(hash%1_000_000)
}

func entry(account, book string, delta int64, block uint64, tx string, logIndex uint, entryIndex int) ledger.Entry {
	return entryOn(testChainID, account, book, delta, block, tx, logIndex, entryIndex)
}

func entryOn(chainID int64, account, book string, delta int64, block uint64, tx string, logIndex uint, entryIndex int) ledger.Entry {
	kind := ledger.KindBalance
	// Named from the ledger's own constants rather than as string literals.
	// The list used to be literals, and a book added to the domain then
	// silently became a *balance* entry here — which the activity feed
	// excludes, so the tests for it would have passed by testing nothing.
	switch book {
	case ledger.Deposits, ledger.Withdrawals, ledger.YieldSettled,
		ledger.BorrowFlow, ledger.RepayFlow, ledger.Liquidations, ledger.LienSettled,
		ledger.SupplyFlow, ledger.PoolWithdrawFlow, ledger.ShareTransferFlow:
		kind = ledger.KindFlow
	}
	return ledger.Entry{
		Provenance: ledger.Provenance{
			ChainID: chainID, BlockNumber: block, BlockHash: "0xblock",
			BlockTime: time.Unix(1700000000, 0).UTC(),
			TxHash:    tx, LogIndex: logIndex, RecordIndex: entryIndex,
			Contract: "CollateralVault", ContractAddress: vaultA, EventName: "Transfer",
		},
		Kind: kind, Account: account, Ledger: book, Delta: big.NewInt(delta),
	}
}

func cursorAt(block uint64, hash string) ledger.Cursor {
	return ledger.Cursor{Stream: "test", ChainID: testChainID, LastBlock: block, LastHash: hash}
}

// cursorOn is cursorAt for a test on its own chain, with its own stream name
// — the cursor table is keyed on the stream, so a shared "test" stream is one
// more thing two tests would fight over.
func cursorOn(t *testing.T, chainID int64, block uint64) ledger.Cursor {
	t.Helper()
	return ledger.Cursor{Stream: t.Name(), ChainID: chainID, LastBlock: block, LastHash: "0xh"}
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

	err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entry(acct, "shares", 1000, 10, "0xa", 0, 0),
		entry(acct, "shares", -250, 11, "0xb", 0, 0),
		entry(acct, "shares", 40, 12, "0xc", 0, 0),
	}}, cursorAt(12, "0xh12"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	got, err := st.BalanceOf(ctx, testChainID, acct, "shares", deploymentA)
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

	entries := []ledger.Entry{
		entry(acct, "shares", 500, 20, "0xdup", 0, 0),
		entry(acct, "shares", 500, 20, "0xdup", 0, 1),
	}
	for i := 0; i < 3; i++ {
		if err := st.Append(ctx, ledger.Batch{Entries: entries}, cursorAt(20, "0xh20")); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	got, err := st.BalanceOf(ctx, testChainID, acct, "shares", deploymentA)
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

	err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		{Provenance: ledger.Provenance{ChainID: testChainID, BlockNumber: 30, BlockHash: "0xb",
			BlockTime: time.Now().UTC(), TxHash: "0xleg", LogIndex: 7, RecordIndex: 0,
			Contract: "CollateralVault", ContractAddress: vaultA, EventName: "Transfer"},
			Kind: "balance", Account: from, Ledger: "shares", Delta: big.NewInt(-100)},
		{Provenance: ledger.Provenance{ChainID: testChainID, BlockNumber: 30, BlockHash: "0xb",
			BlockTime: time.Now().UTC(), TxHash: "0xleg", LogIndex: 7, RecordIndex: 1,
			Contract: "CollateralVault", ContractAddress: vaultA, EventName: "Transfer"},
			Kind: "balance", Account: to, Ledger: "shares", Delta: big.NewInt(100)},
	}}, cursorAt(30, "0xh30"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	debit, _ := st.BalanceOf(ctx, testChainID, from, "shares", deploymentA)
	credit, _ := st.BalanceOf(ctx, testChainID, to, "shares", deploymentA)
	if debit.Cmp(big.NewInt(-100)) != 0 || credit.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("a leg was lost: debit=%s credit=%s", debit, credit)
	}
}

func TestFlowEntriesNeverEnterABalance(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")

	err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entry(acct, "shares", 100, 40, "0xf", 0, 0),
		entry(acct, "deposits", 9999, 40, "0xf", 1, 0),
	}}, cursorAt(40, "0xh40"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	balances, err := st.BalancesOf(ctx, testChainID, acct, deploymentA)
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
	// Its own chain: a rollback deletes by block across every account, so on
	// the shared chain this counted — and deleted — rows other tests wrote at
	// the same heights. See chainOf.
	chainID := chainOf(t)

	err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryOn(chainID, acct, "shares", 100, 50, "0xr1", 0, 0),
		entryOn(chainID, acct, "shares", 100, 51, "0xr2", 0, 0),
		entryOn(chainID, acct, "shares", 100, 52, "0xr3", 0, 0),
	}}, cursorOn(t, chainID, 52))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	deleted, err := st.RollbackFrom(ctx, chainID, t.Name(), 51)
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if deleted != 2 {
		t.Fatalf("want 2 deleted, got %d", deleted)
	}

	got, _ := st.BalanceOf(ctx, chainID, acct, "shares", deploymentA)
	if got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("want 100 after rollback, got %s", got)
	}

	cursor, found, err := st.LoadCursor(ctx, t.Name())
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
	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{e}}, cursorAt(60, "0xh60")); err != nil {
		t.Fatalf("append: %v", err)
	}

	got, err := st.BalanceOf(ctx, testChainID, acct, "shares", deploymentA)
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

	if err := st.Append(ctx, ledger.Batch{}, cursorAt(77, "0xh77")); err != nil {
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

// RecordsInRange is the number the pruned-RPC guard weighs an empty
// eth_getLogs result against, so it has to count both derived tables and it
// has to be inclusive at both ends — the range it is compared against is the
// one handed to eth_getLogs, and an off-by-one here would read as pruning.
func TestRecordsInRangeCountsBothTablesInclusively(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")
	chainID := chainOf(t)

	if err := st.Append(ctx, ledger.Batch{
		Entries: []ledger.Entry{
			entryOn(chainID, acct, ledger.Deposits, 1, 10, "0xrr1", 0, 0),
			entryOn(chainID, acct, ledger.Deposits, 2, 15, "0xrr2", 0, 0),
			entryOn(chainID, acct, ledger.Deposits, 3, 20, "0xrr3", 0, 0),
			entryOn(chainID, acct, ledger.Deposits, 4, 25, "0xrr4", 0, 0),
		},
		Rounds: []ledger.RoundEvent{
			roundEventOn(chainID, 1, "RoundOpened", 15, "0xrr5", 0, 0),
		},
	}, cursorOn(t, chainID, 25)); err != nil {
		t.Fatalf("append: %v", err)
	}

	// Three entries at 10, 15, 20 plus the round event at 15.
	n, err := st.RecordsInRange(ctx, chainID, 10, 20)
	if err != nil {
		t.Fatalf("records in range: %v", err)
	}
	if n != 4 {
		t.Fatalf("want 4 records in blocks 10-20 across both tables, got %d", n)
	}

	// A genuinely empty stretch must count zero, or the guard would refuse
	// every rewind that landed in one.
	n, err = st.RecordsInRange(ctx, chainID, 11, 14)
	if err != nil {
		t.Fatalf("records in empty range: %v", err)
	}
	if n != 0 {
		t.Fatalf("want 0 records in the gap between blocks, got %d", n)
	}

	// Another chain's rows are not ours to reason about.
	n, err = st.RecordsInRange(ctx, chainID+1, 10, 20)
	if err != nil {
		t.Fatalf("records in range on another chain: %v", err)
	}
	if n != 0 {
		t.Fatalf("counted another chain's records: got %d", n)
	}
}

// The query GHO-42 needed: who has debt at all. Every other view in the system
// is per-address, which is why a liquidator could never find anyone.
func TestBorrowersByExposureListsDebtorsLargestFirst(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	chainID := chainOf(t)
	small := account(t, "small")
	large := account(t, "large")
	repaid := account(t, "repaid")
	supplier := account(t, "supplier")

	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryOn(chainID, small, ledger.DebtScaled, 100, 10, "0xbe1", 0, 0),
		entryOn(chainID, large, ledger.DebtScaled, 900, 11, "0xbe2", 0, 0),

		// Borrowed and then paid off in full: the sum is zero, so this address
		// is not a borrower any more and must not be offered to a liquidator.
		entryOn(chainID, repaid, ledger.DebtScaled, 500, 12, "0xbe3", 0, 0),
		entryOn(chainID, repaid, ledger.DebtScaled, -500, 13, "0xbe4", 0, 0),

		// A supplier is not a borrower. The book is what separates them, and
		// the index this query relies on leads with it.
		entryOn(chainID, supplier, ledger.SupplyScaled, 5_000, 14, "0xbe5", 0, 0),
	}}, cursorOn(t, chainID, 14)); err != nil {
		t.Fatalf("append: %v", err)
	}

	got, err := st.BorrowersByExposure(ctx, chainID, deploymentA, 10)
	if err != nil {
		t.Fatalf("borrowers: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want the two live borrowers, got %v", got)
	}
	// Largest first, which is what makes the limit fall on the smallest
	// positions rather than on an arbitrary set.
	if got[0] != large || got[1] != small {
		t.Fatalf("want [%s %s], got %v", large, small, got)
	}

	// Another chain's borrowers are not ours.
	other, err := st.BorrowersByExposure(ctx, chainID+1, deploymentA, 10)
	if err != nil {
		t.Fatalf("borrowers on another chain: %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("counted another chain's borrowers: %v", other)
	}
}

// The limit is a bound on chain reads, not on rows, so it has to bite on the
// smallest exposures — a truncated list should be missing the trivia rather
// than the risk.
func TestBorrowersByExposureDropsTheSmallestFirst(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	chainID := chainOf(t)
	tiny, mid, big := account(t, "tiny"), account(t, "mid"), account(t, "big")

	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryOn(chainID, tiny, ledger.DebtScaled, 1, 10, "0xbd1", 0, 0),
		entryOn(chainID, mid, ledger.DebtScaled, 50, 11, "0xbd2", 0, 0),
		entryOn(chainID, big, ledger.DebtScaled, 900, 12, "0xbd3", 0, 0),
	}}, cursorOn(t, chainID, 12)); err != nil {
		t.Fatalf("append: %v", err)
	}

	got, err := st.BorrowersByExposure(ctx, chainID, deploymentA, 2)
	if err != nil {
		t.Fatalf("borrowers: %v", err)
	}
	if len(got) != 2 || got[0] != big || got[1] != mid {
		t.Fatalf("want the two largest, got %v", got)
	}
}

// entryFrom is entryOn with a chosen contract, so a test can put two
// deployments' rows in the same table.
func entryFrom(address string, chainID int64, account, book string, delta int64, block uint64, tx string) ledger.Entry {
	e := entryOn(chainID, account, book, delta, block, tx, 0, 0)
	e.ContractAddress = address
	return e
}

// The failure GHO-51 exists to prevent, asserted directly.
//
// Before deployments could be told apart, every balance was summed by
// (chain_id, account, ledger) — so a redeployment would have added an old
// vault's shares to a new vault's and an old pool's debt to a new pool's. One
// number, no error, and wrong in the direction that makes an insolvent
// position look healthy.
//
// This is the same shape GHO-43 found one layer down, where round ids restart
// at 1 in every market and a table keyed on the id alone folded two markets'
// round 7 into one. The answer is the same: identity is the real thing, not a
// label.
func TestBalancesNeverSumAcrossDeployments(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	chainID := chainOf(t)
	acct := account(t, "")

	// The same account, holding shares in two different vaults.
	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryFrom(vaultA, chainID, acct, ledger.Shares, 100, 10, "0xdepA"),
		entryFrom(vaultB, chainID, acct, ledger.Shares, 900, 11, "0xdepB"),
	}}, cursorOn(t, chainID, 11)); err != nil {
		t.Fatalf("append: %v", err)
	}

	a, err := st.BalanceOf(ctx, chainID, acct, ledger.Shares, deploymentA)
	if err != nil {
		t.Fatalf("balance A: %v", err)
	}
	b, err := st.BalanceOf(ctx, chainID, acct, ledger.Shares, deploymentB)
	if err != nil {
		t.Fatalf("balance B: %v", err)
	}

	if a.Int64() != 100 {
		t.Fatalf("deployment A sees %s shares, want 100 — it has picked up B's rows", a)
	}
	if b.Int64() != 900 {
		t.Fatalf("deployment B sees %s shares, want 900 — it has picked up A's rows", b)
	}
	// The whole point: 1000 is the number the old query returned, and it
	// describes neither deployment.
	if a.Int64()+b.Int64() != 1000 {
		t.Fatalf("setup is wrong: the two deployments should hold 1000 between them")
	}

	// BalancesOf takes the same scope, and would otherwise be the way the
	// merge leaked back in through a different door.
	books, err := st.BalancesOf(ctx, chainID, acct, deploymentA)
	if err != nil {
		t.Fatalf("balances A: %v", err)
	}
	if got := books[ledger.Shares]; got == nil || got.Int64() != 100 {
		t.Fatalf("BalancesOf disagrees with BalanceOf: %v", got)
	}
}

// The live path. A borrower on the previous deployment must not appear in this
// one's at-risk list: their debt is owed to a pool this deployment does not
// lend from, and liquidating them here is not a transaction that exists.
func TestBorrowersAreScopedToTheirDeployment(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	chainID := chainOf(t)
	oldBorrower := account(t, "old")
	newBorrower := account(t, "new")

	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryFrom(vaultA, chainID, oldBorrower, ledger.DebtScaled, 500, 10, "0xoldDebt"),
		entryFrom(vaultB, chainID, newBorrower, ledger.DebtScaled, 700, 11, "0xnewDebt"),
	}}, cursorOn(t, chainID, 11)); err != nil {
		t.Fatalf("append: %v", err)
	}

	got, err := st.BorrowersByExposure(ctx, chainID, deploymentB, 10)
	if err != nil {
		t.Fatalf("borrowers: %v", err)
	}
	if len(got) != 1 || got[0] != newBorrower {
		t.Fatalf("want only this deployment's borrower, got %v", got)
	}
}

// Rows written before migration 0009 carry no address, and are stamped at
// preflight. Until then they belong to no deployment — which has to mean
// "invisible", not "everyone's", because adopting them on a guess is how the
// merge this whole change prevents would come back.
func TestUnattributedRowsBelongToNobody(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	chainID := chainOf(t)
	acct := account(t, "")

	orphan := entryOn(chainID, acct, ledger.Shares, 100, 10, "0xorphan", 0, 0)
	orphan.ContractAddress = "" // as migration 0009 leaves them
	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{orphan}},
		cursorOn(t, chainID, 10)); err != nil {
		t.Fatalf("append: %v", err)
	}

	got, err := st.BalanceOf(ctx, chainID, acct, ledger.Shares, deploymentA)
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if got.Sign() != 0 {
		t.Fatalf("an unattributed row was counted into a deployment: %s", got)
	}

	// And the preflight repair is what makes it visible again.
	n, err := st.UnattributedEntries(ctx, chainID)
	if err != nil || n != 1 {
		t.Fatalf("unattributed count %d (err %v), want 1", n, err)
	}
	if _, err := st.AttributeEntries(ctx, chainID, "CollateralVault", vaultA); err != nil {
		t.Fatalf("attribute: %v", err)
	}
	got, _ = st.BalanceOf(ctx, chainID, acct, ledger.Shares, deploymentA)
	if got.Int64() != 100 {
		t.Fatalf("attribution did not bring the row back: %s", got)
	}
}

// A rename that would land on an occupied name is refused, because the row
// already there is this deployment's real position and an older deployment's
// would move it to a block it never read.
func TestAdoptCursorRefusesToClobber(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	chainID := chainOf(t)
	from, to := t.Name()+":legacy", t.Name()+":current"

	seed := func(stream string, block uint64) {
		c := cursorOn(t, chainID, block)
		c.Stream = stream
		if err := st.Append(ctx, ledger.Batch{}, c); err != nil {
			t.Fatalf("seed %s: %v", stream, err)
		}
	}
	seed(from, 50)
	seed(to, 900)

	adopted, err := st.AdoptCursor(ctx, from, to)
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if adopted {
		t.Fatal("adopted over an occupied stream")
	}
	cursor, found, err := st.LoadCursor(ctx, to)
	if err != nil || !found {
		t.Fatalf("cursor: %v found=%v", err, found)
	}
	if cursor.LastBlock != 900 {
		t.Fatalf("the occupying cursor moved to %d, want 900", cursor.LastBlock)
	}
}
