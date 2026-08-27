package store_test

import (
	"context"
	"math/big"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
	"github.com/wavedidwhat/ghoststake/internal/store"
)

func bigOf(n int64) *big.Int { return big.NewInt(n) }

// These tests each run on their own chain id (see chainOf). Not politeness:
// they share a database with a rollback test that deletes by block across
// every account, and the first version of this file wrote at heights that
// test rewound. Two rows vanished between the append and the read, and the
// failure looked like a bug in the query. The chain id is the axis that
// isolates completely — it leads every constraint, index and WHERE clause in
// the store.

// ids reduces a page to something a failure message can show.
func ids(events []ledger.Activity) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		out = append(out, e.CursorOf().String())
	}
	return out
}

// Takes the store rather than opening one.
//
// It used to call newTestStore itself, which connects *and runs the
// migrations* — so the paging test below did that once per page, and the
// store package's suite went from about a minute to eight, with the tunnel to
// the VPS dropping under the churn. The failure looked like a flaky database.
func activityOf(t *testing.T, st *store.Store, chainID int64, acct string, after *ledger.ActivityCursor, limit int) ([]ledger.Activity, *ledger.ActivityCursor) {
	t.Helper()
	events, next, err := st.ActivityFor(context.Background(), chainID, acct, after, limit)
	if err != nil {
		t.Fatalf("activity: %v", err)
	}
	return events, next
}

// The whole point of the endpoint: a borrow and the stake it funded are one
// story and have to come back in one list, in the order they happened.
func TestActivityMergesLendingAndBettingInLogOrder(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")
	id := roundID(t, 1)
	chainID := chainOf(t)

	position := roundEventOn(chainID, id, ledger.PositionTaken, 11, "0xtx2", 0, 0)
	position.Account = acct
	position.Side = ledger.SideUp
	position.Amount = bigOf(500)

	claim := roundEventOn(chainID, id, ledger.Claimed, 20, "0xtx3", 0, 0)
	claim.Account = acct
	claim.Amount = bigOf(900)

	err := st.Append(ctx, ledger.Batch{
		Entries: []ledger.Entry{
			entryOn(chainID, acct, ledger.Deposits, 1000, 1, "0xtx0", 0, 0),
			entryOn(chainID, acct, ledger.BorrowFlow, 500, 10, "0xtx1", 0, 0),
		},
		Rounds: []ledger.RoundEvent{position, claim},
	}, cursorOn(t, chainID, 20))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	events, next := activityOf(t, st, chainID, acct, nil, 50)
	if len(events) != 4 {
		t.Fatalf("want 4 rows, got %d: %v", len(events), ids(events))
	}
	if next != nil {
		t.Fatalf("one page should have no next cursor, got %v", next)
	}

	// Newest first, and interleaved: the round rows sit above the lending
	// ones because they happened later, not because they are round rows.
	want := []string{ledger.Claimed, ledger.PositionTaken, "Transfer", "Transfer"}
	wantBlocks := []uint64{20, 11, 10, 1}
	for i, e := range events {
		if e.EventName != want[i] || e.BlockNumber != wantBlocks[i] {
			t.Fatalf("row %d: got %s@%d, want %s@%d", i, e.EventName, e.BlockNumber, want[i], wantBlocks[i])
		}
	}

	if events[0].Source != ledger.SourceRound || events[3].Source != ledger.SourceLedger {
		t.Fatalf("sources are wrong: %s / %s", events[0].Source, events[3].Source)
	}
	if events[0].RoundID != id || events[0].Market != testMarket {
		t.Fatalf("round row lost its identity: %+v", events[0])
	}
	if events[1].Side != ledger.SideUp {
		t.Fatalf("position lost its side: %q", events[1].Side)
	}
}

// The trap this endpoint was written around. A balance entry holds an
// index-scaled amount, so a history row drawn from one shows a figure the
// user never saw — and a figure that moves every time the index does.
//
// Excluded at the query rather than by the caller, so this asserts the query
// does it.
func TestActivityNeverReturnsAScaledBalanceEntry(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")
	chainID := chainOf(t)

	err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		// What a pool supply writes: the scaled balance, then the nominal
		// flow. Only the second may be listed.
		entryOn(chainID, acct, ledger.SupplyScaled, 970, 10, "0xtx1", 0, 0),
		entryOn(chainID, acct, ledger.SupplyFlow, 1000, 10, "0xtx1", 0, 1),
		// And the debt book, which is scaled for the same reason.
		entryOn(chainID, acct, ledger.DebtScaled, 480, 11, "0xtx2", 0, 0),
		entryOn(chainID, acct, ledger.Shares, 1000, 12, "0xtx3", 0, 0),
	}}, cursorOn(t, chainID, 12))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	events, _ := activityOf(t, st, chainID, acct, nil, 50)
	if len(events) != 1 {
		t.Fatalf("want only the nominal flow, got %d rows: %+v", len(events), events)
	}
	if events[0].Ledger != ledger.SupplyFlow {
		t.Fatalf("want %s, got %s", ledger.SupplyFlow, events[0].Ledger)
	}
	if events[0].Amount.Cmp(bigOf(1000)) != 0 {
		t.Fatalf("want the nominal 1000, got %s — that is the scaled figure", events[0].Amount)
	}
}

// Paging walks the whole list exactly once: no row seen twice, none skipped.
//
// The rows are deliberately packed into two blocks, so most of the page
// boundaries fall *inside* a block. That is where an ordering that is not a
// total order — sorting on block_time, say, which every log in a block shares
// — repeats or drops a row, and it does so silently.
func TestActivityPagesThroughEveryRowExactlyOnce(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")
	chainID := chainOf(t)

	var entries []ledger.Entry
	for i := range 6 {
		// Three rows in one block, three in the next, so most page
		// boundaries fall inside a block.
		block := 10 + uint64(i/3)
		entries = append(entries, entryOn(chainID, acct, ledger.Deposits, int64(100+i), block,
			"0xtx"+string(rune('a'+i)), uint(i), 0))
	}
	if err := st.Append(ctx, ledger.Batch{Entries: entries}, cursorOn(t, chainID, 11)); err != nil {
		t.Fatalf("append: %v", err)
	}

	var (
		seen   []string
		cursor *ledger.ActivityCursor
		pages  int
	)
	for {
		page, next := activityOf(t, st, chainID, acct, cursor, 2)
		pages++
		if pages > 10 {
			t.Fatal("paging did not terminate")
		}
		if len(page) > 2 {
			t.Fatalf("page longer than the limit: %v", ids(page))
		}
		seen = append(seen, ids(page)...)
		if next == nil {
			break
		}
		cursor = next
	}

	if len(seen) != 6 {
		t.Fatalf("want 6 rows across all pages, got %d: %v", len(seen), seen)
	}
	unique := map[string]bool{}
	for _, id := range seen {
		if unique[id] {
			t.Fatalf("row %s came back twice: %v", id, seen)
		}
		unique[id] = true
	}
	// Three full pages and no fourth empty one: the extra row read to decide
	// "is there more" must not produce a page of nothing at the end.
	if pages != 3 {
		t.Fatalf("want 3 pages, got %d: %v", pages, seen)
	}
}

// The reason the cursor is the row and not an offset. Something arriving at
// the head between two requests must not shift the page under the reader.
func TestANewRowDoesNotShiftAPageAlreadyBegun(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")
	chainID := chainOf(t)

	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryOn(chainID, acct, ledger.Deposits, 1, 10, "0xtx1", 0, 0),
		entryOn(chainID, acct, ledger.Deposits, 2, 11, "0xtx2", 0, 0),
		entryOn(chainID, acct, ledger.Deposits, 3, 12, "0xtx3", 0, 0),
	}}, cursorOn(t, chainID, 12)); err != nil {
		t.Fatalf("append: %v", err)
	}

	first, next := activityOf(t, st, chainID, acct, nil, 2)
	if len(first) != 2 || next == nil {
		t.Fatalf("want a full first page and a cursor, got %v", ids(first))
	}

	// The indexer writes a newer row while the reader is on page one.
	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryOn(chainID, acct, ledger.Deposits, 4, 13, "0xtx4", 0, 0),
	}}, cursorOn(t, chainID, 13)); err != nil {
		t.Fatalf("append: %v", err)
	}

	second, _ := activityOf(t, st, chainID, acct, next, 2)
	if len(second) != 1 {
		t.Fatalf("want the one remaining older row, got %v", ids(second))
	}
	// With an OFFSET 2 this would have returned block 11 again — the row the
	// reader had just read — because the new row pushed everything down.
	if second[0].BlockNumber != 10 {
		t.Fatalf("page two moved: got block %d, want 10", second[0].BlockNumber)
	}
}

func TestActivityIsScopedToOneAccount(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	mine, theirs := account(t, "mine"), account(t, "theirs")
	chainID := chainOf(t)

	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryOn(chainID, mine, ledger.Deposits, 1, 10, "0xtx1", 0, 0),
		entryOn(chainID, theirs, ledger.Deposits, 2, 11, "0xtx1", 0, 1),
	}}, cursorOn(t, chainID, 11)); err != nil {
		t.Fatalf("append: %v", err)
	}

	events, _ := activityOf(t, st, chainID, mine, nil, 50)
	if len(events) != 1 || events[0].BlockNumber != 10 {
		t.Fatalf("want only my row, got %v", ids(events))
	}
}

// The distinction between the two rewinds, asserted against real SQL: a
// rollback deletes because the rows were never history; a replay keeps them
// because they are correct and merely incomplete.
func TestReplayRewindsTheCursorWithoutDeletingAnything(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")
	chainID := chainOf(t)

	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryOn(chainID, acct, ledger.Deposits, 1, 10, "0xrp1", 0, 0),
		entryOn(chainID, acct, ledger.Deposits, 2, 20, "0xrp2", 0, 0),
	}}, cursorOn(t, chainID, 20)); err != nil {
		t.Fatalf("append: %v", err)
	}

	if err := st.ReplayFrom(ctx, t.Name(), 10); err != nil {
		t.Fatalf("replay: %v", err)
	}

	events, _ := activityOf(t, st, chainID, acct, nil, 50)
	if len(events) != 2 {
		t.Fatalf("the replay took rows with it: %v", ids(events))
	}

	cursor, found, err := st.LoadCursor(ctx, t.Name())
	if err != nil || !found {
		t.Fatalf("cursor: %v found=%v", err, found)
	}
	if cursor.LastBlock != 9 {
		t.Fatalf("cursor is at %d, want 9", cursor.LastBlock)
	}
	// Cleared, or the next reorg check compares against a hash taken at a
	// block the cursor no longer sits on and sees a false match.
	if cursor.LastHash != "" {
		t.Fatalf("stale hash left behind: %q", cursor.LastHash)
	}
}

// A replay re-reads blocks whose rows are already there. That has to be a
// no-op for what exists and an insert for what the new decoder derives —
// which is the uniqueness constraint doing the work, not the caller.
func TestReReadingAfterAReplayAddsOnlyTheNewRecords(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	acct := account(t, "")
	chainID := chainOf(t)

	// What the old decoder wrote for a pool supply: the scaled balance alone.
	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryOn(chainID, acct, ledger.SupplyScaled, 970, 10, "0xrr1", 0, 0),
	}}, cursorOn(t, chainID, 10)); err != nil {
		t.Fatalf("first pass: %v", err)
	}

	// What the new one writes for the same log: the balance again, unchanged,
	// plus the nominal flow appended after it.
	if err := st.Append(ctx, ledger.Batch{Entries: []ledger.Entry{
		entryOn(chainID, acct, ledger.SupplyScaled, 970, 10, "0xrr1", 0, 0),
		entryOn(chainID, acct, ledger.SupplyFlow, 1000, 10, "0xrr1", 0, 1),
	}}, cursorOn(t, chainID, 10)); err != nil {
		t.Fatalf("replay pass: %v", err)
	}

	// The balance must not have doubled — that is the whole risk of a replay,
	// and it is why new records are appended after the existing record
	// indices rather than inserted before them.
	balance, err := st.BalanceOf(ctx, chainID, acct, ledger.SupplyScaled)
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if balance.Cmp(bigOf(970)) != 0 {
		t.Fatalf("the replay double counted: balance is %s, want 970", balance)
	}

	// And the history row the replay existed to create is now there.
	events, _ := activityOf(t, st, chainID, acct, nil, 50)
	if len(events) != 1 || events[0].Ledger != ledger.SupplyFlow {
		t.Fatalf("want the nominal flow the replay derived, got %+v", events)
	}
}

// The stamp has to survive the round trip, or the version check reads an
// empty string every boot and replays forever.
func TestTheDecoderVersionIsStoredWithTheCursor(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	chainID := chainOf(t)

	cursor := cursorOn(t, chainID, 10)
	cursor.Decoders = ledger.DecoderVersion
	if err := st.Append(ctx, ledger.Batch{}, cursor); err != nil {
		t.Fatalf("append: %v", err)
	}

	got, found, err := st.LoadCursor(ctx, t.Name())
	if err != nil || !found {
		t.Fatalf("cursor: %v found=%v", err, found)
	}
	if got.Decoders != ledger.DecoderVersion {
		t.Fatalf("decoder version came back as %q, want %q", got.Decoders, ledger.DecoderVersion)
	}
}
