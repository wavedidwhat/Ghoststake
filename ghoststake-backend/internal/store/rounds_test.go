package store_test

import (
	"context"
	"math/big"
	"testing"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// Round ids are namespaced per test so these can run against a shared
// database without colliding — the same trick the ledger tests use for
// accounts, applied to the other key.
func roundID(t *testing.T, n uint64) uint64 {
	t.Helper()
	var hash uint64 = 1469598103934665603
	for _, b := range []byte(t.Name()) {
		hash ^= uint64(b)
		hash *= 1099511628211
	}
	// Keep it inside bigint and well clear of the low ids other tests use.
	return (hash%1_000_000)*1_000 + n
}

func roundEvent(id uint64, name string, block uint64, tx string, logIndex uint, recordIndex int) ledger.RoundEvent {
	return ledger.RoundEvent{
		Provenance: ledger.Provenance{
			ChainID: testChainID, BlockNumber: block, BlockHash: "0xblock",
			BlockTime: time.Unix(1700000000, 0).UTC(),
			TxHash:    tx, LogIndex: logIndex, RecordIndex: recordIndex,
			Contract: "ParimutuelRound", EventName: name,
		},
		RoundID: id,
		Data:    map[string]string{},
	}
}

func TestRoundEventsRoundTripThroughPostgres(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	id := roundID(t, 1)

	opened := roundEvent(id, ledger.RoundOpened, 10, "0xro1", 0, 0)
	opened.Data = map[string]string{"openTime": "1000", "lockTime": "2000", "closeTime": "3000"}

	position := roundEvent(id, ledger.PositionTaken, 11, "0xro2", 0, 0)
	position.Account = "0xAlice"
	position.Side = ledger.SideUp
	position.Amount = big.NewInt(600)
	position.Data = map[string]string{"funder": "0xAlice"}

	if err := st.Append(ctx, ledger.Batch{Rounds: []ledger.RoundEvent{opened, position}},
		cursorAt(11, "0xh11")); err != nil {
		t.Fatalf("append: %v", err)
	}

	events, err := st.RoundEventsByIDs(ctx, testChainID, []uint64{id})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("want 2 events, got %d", len(events))
	}

	// Every part of the event must survive the round trip: the JSONB data,
	// the numeric amount, the nullable columns. A silent loss here would show
	// up as a pool total that is quietly short.
	round := ledger.Project(events)
	if len(round) != 1 {
		t.Fatalf("want 1 projected round, got %d", len(round))
	}
	if round[0].UpPool.Cmp(big.NewInt(600)) != 0 {
		t.Fatalf("up pool %s, want 600", round[0].UpPool)
	}
	if round[0].OpenTime.Unix() != 1000 {
		t.Fatalf("open time %v — the JSONB data did not survive", round[0].OpenTime)
	}
	if round[0].Status != ledger.StatusOpen {
		t.Fatalf("status %q", round[0].Status)
	}
}

// A replayed range must be a no-op, or a restart mid-batch doubles a pool.
func TestReplayingRoundEventsIsANoOp(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	id := roundID(t, 1)

	position := roundEvent(id, ledger.PositionTaken, 20, "0xdupround", 0, 0)
	position.Account = "0xAlice"
	position.Side = ledger.SideUp
	position.Amount = big.NewInt(500)

	for i := range 3 {
		if err := st.Append(ctx, ledger.Batch{Rounds: []ledger.RoundEvent{position}},
			cursorAt(20, "0xh20")); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	events, err := st.RoundEventsByIDs(ctx, testChainID, []uint64{id})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("replay wrote %d rows, want 1", len(events))
	}
	if pool := ledger.Project(events)[0].UpPool; pool.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("pool %s, want 500 — the replay double counted", pool)
	}
}

// A reorg must unwind round events by block exactly as it unwinds the ledger.
// Missing this table would leave a resolved round the chain no longer
// resolved, which is a payout quote for a settlement that did not happen.
func TestRollbackRemovesRoundEventsToo(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	id := roundID(t, 1)

	kept := roundEvent(id, ledger.PositionTaken, 100, "0xrb1", 0, 0)
	kept.Account, kept.Side, kept.Amount = "0xAlice", ledger.SideUp, big.NewInt(100)

	resolved := roundEvent(id, ledger.RoundResolved, 200, "0xrb2", 0, 0)
	resolved.Data = map[string]string{"closePrice": "2600", "winner": "up", "rakeTaken": "0"}

	if err := st.Append(ctx, ledger.Batch{Rounds: []ledger.RoundEvent{kept, resolved}},
		cursorAt(200, "0xh200")); err != nil {
		t.Fatalf("append: %v", err)
	}

	deleted, err := st.RollbackFrom(ctx, testChainID, "test", 150)
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if deleted < 1 {
		t.Fatalf("rollback deleted %d rows, want at least the resolution", deleted)
	}

	events, err := st.RoundEventsByIDs(ctx, testChainID, []uint64{id})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	round := ledger.Project(events)
	if len(round) != 1 {
		t.Fatalf("want 1 round, got %d", len(round))
	}
	if round[0].Status == ledger.StatusResolved {
		t.Fatal("the round is still resolved after the block that resolved it was rewound")
	}
	if round[0].UpPool.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("the rollback took the block below it too: pool %s", round[0].UpPool)
	}
}

// The listing reads whole rounds. A limit that cut a round in half would
// return some of its positions and not others, and the pool total would then
// simply be wrong with nothing to indicate it.
func TestRoundListingsSelectWholeRounds(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	first, second := roundID(t, 1), roundID(t, 2)

	var events []ledger.RoundEvent
	for i, id := range []uint64{first, second} {
		for stake := range 3 {
			e := roundEvent(id, ledger.PositionTaken, uint64(300+i), "0xlist", uint(stake), i*3+stake)
			e.Account, e.Side, e.Amount = "0xAlice", ledger.SideUp, big.NewInt(100)
			events = append(events, e)
		}
	}
	if err := st.Append(ctx, ledger.Batch{Rounds: events}, cursorAt(301, "0xh301")); err != nil {
		t.Fatalf("append: %v", err)
	}

	// Named ids rather than whatever RecentRoundIDs returns: the table is
	// shared with every other test in this package, so the newest round in it
	// belongs to whichever test ran last.
	got, err := st.RoundEventsByIDs(ctx, testChainID, []uint64{second})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// All three positions of the round asked for, and none of the other's.
	if len(got) != 3 {
		t.Fatalf("want the whole round's 3 events, got %d", len(got))
	}
	if pool := ledger.Project(got)[0].UpPool; pool.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("pool %s, want 300", pool)
	}
}

// The listing orders newest first and honours its limit — which is what makes
// "the most recent N rounds" a page rather than an arbitrary slice.
func TestRecentRoundIDsAreNewestFirstAndLimited(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	ids, err := st.RecentRoundIDs(ctx, testChainID, 3)
	if err != nil {
		t.Fatalf("recent: %v", err)
	}
	if len(ids) > 3 {
		t.Fatalf("limit ignored: got %d ids", len(ids))
	}
	for i := 1; i < len(ids); i++ {
		if ids[i-1] <= ids[i] {
			t.Fatalf("not descending: %v", ids)
		}
	}
}

// The account index has to find the rounds a user is in, and only those.
func TestRoundIDsForAccountFindsOnlyTheirRounds(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	mine, theirs := roundID(t, 1), roundID(t, 2)
	me := "0x" + t.Name()

	events := []ledger.RoundEvent{
		roundEvent(mine, ledger.PositionTaken, 400, "0xacc1", 0, 0),
		roundEvent(theirs, ledger.PositionTaken, 400, "0xacc1", 1, 1),
		// A round-level event with no account at all, which must not match.
		roundEvent(mine, ledger.RoundOpened, 399, "0xacc0", 0, 0),
	}
	events[0].Account, events[0].Side, events[0].Amount = me, ledger.SideUp, big.NewInt(100)
	events[1].Account, events[1].Side, events[1].Amount = "0xSomeoneElse", ledger.SideUp, big.NewInt(100)

	if err := st.Append(ctx, ledger.Batch{Rounds: events}, cursorAt(400, "0xh400")); err != nil {
		t.Fatalf("append: %v", err)
	}

	ids, err := st.RoundIDsForAccount(ctx, testChainID, me, 10)
	if err != nil {
		t.Fatalf("account rounds: %v", err)
	}
	if len(ids) != 1 || ids[0] != mine {
		t.Fatalf("got %v, want [%d]", ids, mine)
	}
}

// Ledger entries and round events from the same range commit together. On the
// leveraged path they arrive in the same transaction, and half of it would be
// a stake with no debt behind it.
func TestBothKindsCommitTogether(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	id := roundID(t, 1)
	acct := account(t, "")

	position := roundEvent(id, ledger.PositionTaken, 500, "0xboth", 1, 0)
	position.Account, position.Side, position.Amount = acct, ledger.SideUp, big.NewInt(5_000)

	err := st.Append(ctx, ledger.Batch{
		Entries: []ledger.Entry{entry(acct, "debt_scaled", 5_000, 500, "0xboth", 0, 0)},
		Rounds:  []ledger.RoundEvent{position},
	}, cursorAt(500, "0xh500"))
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	debt, err := st.BalanceOf(ctx, testChainID, acct, "debt_scaled")
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if debt.Cmp(big.NewInt(5_000)) != 0 {
		t.Fatalf("debt %s, want 5000", debt)
	}

	events, err := st.RoundEventsByIDs(ctx, testChainID, []uint64{id})
	if err != nil || len(events) != 1 {
		t.Fatalf("round events: %d, %v", len(events), err)
	}
}
