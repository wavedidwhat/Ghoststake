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

// The market every helper here writes under, unless a test names another.
// Checksummed, matching what the indexer stamps.
const (
	testMarket  = "0x00000000000000000000000000000000000B7C00"
	otherMarket = "0x00000000000000000000000000000000000De300"
)

func ref(id uint64) ledger.RoundRef {
	return ledger.RoundRef{Market: testMarket, RoundID: id}
}

func roundEvent(id uint64, name string, block uint64, tx string, logIndex uint, recordIndex int) ledger.RoundEvent {
	return roundEventOn(testChainID, id, name, block, tx, logIndex, recordIndex)
}

func roundEventOn(chainID int64, id uint64, name string, block uint64, tx string, logIndex uint, recordIndex int) ledger.RoundEvent {
	return ledger.RoundEvent{
		Provenance: ledger.Provenance{
			ChainID: chainID, BlockNumber: block, BlockHash: "0xblock",
			BlockTime: time.Unix(1700000000, 0).UTC(),
			TxHash:    tx, LogIndex: logIndex, RecordIndex: recordIndex,
			Contract: "ParimutuelRound", EventName: name,
		},
		Market:  testMarket,
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

	events, err := st.RoundEventsByRefs(ctx, testChainID, []ledger.RoundRef{ref(id)})
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

	events, err := st.RoundEventsByRefs(ctx, testChainID, []ledger.RoundRef{ref(id)})
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
	// Its own chain. A rollback deletes by block across every account and
	// every round, so on the shared chain this quietly took rows other tests
	// had written above block 150. See chainOf.
	chainID := chainOf(t)

	kept := roundEventOn(chainID, id, ledger.PositionTaken, 100, "0xrb1", 0, 0)
	kept.Account, kept.Side, kept.Amount = "0xAlice", ledger.SideUp, big.NewInt(100)

	resolved := roundEventOn(chainID, id, ledger.RoundResolved, 200, "0xrb2", 0, 0)
	resolved.Data = map[string]string{"closePrice": "2600", "winner": "up", "rakeTaken": "0"}

	if err := st.Append(ctx, ledger.Batch{Rounds: []ledger.RoundEvent{kept, resolved}},
		cursorOn(t, chainID, 200)); err != nil {
		t.Fatalf("append: %v", err)
	}

	deleted, err := st.RollbackFrom(ctx, chainID, t.Name(), 150)
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if deleted < 1 {
		t.Fatalf("rollback deleted %d rows, want at least the resolution", deleted)
	}

	events, err := st.RoundEventsByRefs(ctx, chainID, []ledger.RoundRef{ref(id)})
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
	got, err := st.RoundEventsByRefs(ctx, testChainID, []ledger.RoundRef{ref(second)})
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

// The limit is what makes "the most recent N rounds" a page rather than an
// arbitrary slice.
//
// Ordering is asserted by TestRecentRoundsAreOrderedByRecencyNotByRoundID
// rather than here. This test reads a table every other test in the package
// has written to, and since GHO-43 the order is by the block a round was last
// touched at — which says nothing about the round ids, deliberately. Asserting
// descending ids here passed only while a single market made the two the same
// thing.
func TestRecentRoundsHonourTheirLimit(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	refs, err := st.RecentRounds(ctx, testChainID, "", 3)
	if err != nil {
		t.Fatalf("recent: %v", err)
	}
	if len(refs) > 3 {
		t.Fatalf("limit ignored: got %d refs", len(refs))
	}
}

// The listing spans markets, and narrows to one when asked. This is the whole
// point of GHO-43: the same round id exists in every market, and before this
// the table could only hold one market's worth of them.
func TestRecentRoundsSpanMarketsAndCanBeNarrowed(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	id := roundID(t, 1)

	here := roundEvent(id, ledger.RoundOpened, 500, "0xmm1", 0, 0)
	there := roundEvent(id, ledger.RoundOpened, 500, "0xmm1", 1, 0)
	there.Market = otherMarket

	if err := st.Append(ctx, ledger.Batch{Rounds: []ledger.RoundEvent{here, there}},
		cursorAt(500, "0xh500")); err != nil {
		t.Fatalf("append: %v", err)
	}

	// Same id in two markets is two rounds, not one.
	all, err := st.RecentRounds(ctx, testChainID, "", 100)
	if err != nil {
		t.Fatalf("recent: %v", err)
	}
	var seen int
	for _, r := range all {
		if r.RoundID == id {
			seen++
		}
	}
	if seen != 2 {
		t.Fatalf("want round %d from both markets, saw it %d time(s)", id, seen)
	}

	narrowed, err := st.RecentRounds(ctx, testChainID, otherMarket, 100)
	if err != nil {
		t.Fatalf("recent narrowed: %v", err)
	}
	for _, r := range narrowed {
		if r.Market != otherMarket {
			t.Fatalf("filter leaked market %s", r.Market)
		}
	}
}

// And the event fetch must not return the cross product. Asking for round 7 of
// one market and round 9 of another must not also drag in round 9 of the first
// — those project perfectly well, so the response would simply be longer than
// asked for with nothing to indicate why.
func TestRoundEventsByRefsDoesNotReturnTheCrossProduct(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	seven, nine := roundID(t, 7), roundID(t, 9)

	events := []ledger.RoundEvent{
		roundEvent(seven, ledger.RoundOpened, 600, "0xcp1", 0, 0),
		roundEvent(nine, ledger.RoundOpened, 600, "0xcp1", 1, 0),
		roundEvent(seven, ledger.RoundOpened, 600, "0xcp1", 2, 0),
		roundEvent(nine, ledger.RoundOpened, 600, "0xcp1", 3, 0),
	}
	events[2].Market, events[3].Market = otherMarket, otherMarket

	if err := st.Append(ctx, ledger.Batch{Rounds: events}, cursorAt(600, "0xh600")); err != nil {
		t.Fatalf("append: %v", err)
	}

	want := []ledger.RoundRef{
		{Market: testMarket, RoundID: seven},
		{Market: otherMarket, RoundID: nine},
	}
	got, err := st.RoundEventsByRefs(ctx, testChainID, want)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want exactly the two named rounds, got %d events", len(got))
	}
	for _, e := range got {
		pair := ledger.RoundRef{Market: e.Market, RoundID: e.RoundID}
		if pair != want[0] && pair != want[1] {
			t.Fatalf("unasked-for round came back: %+v", pair)
		}
	}
}

// The account index has to find the rounds a user is in, and only those.
func TestRoundsForAccountFindsOnlyTheirRounds(t *testing.T) {
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

	ids, err := st.RoundsForAccount(ctx, testChainID, me, "", 10)
	if err != nil {
		t.Fatalf("account rounds: %v", err)
	}
	if len(ids) != 1 || ids[0] != ref(mine) {
		t.Fatalf("got %v, want [%v]", ids, ref(mine))
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

	events, err := st.RoundEventsByRefs(ctx, testChainID, []ledger.RoundRef{ref(id)})
	if err != nil || len(events) != 1 {
		t.Fatalf("round events: %d, %v", len(events), err)
	}
}

// The listing must not be ordered by round id across markets.
//
// The id is a clock within one market and nothing across them. A market
// deployed in June sits at round 900 while one deployed today is at round 3,
// so `ORDER BY round_id DESC LIMIT n` fills the page with June's rounds and
// the new market vanishes — the endpoint answers, every row is real, and a
// whole market is missing. That is the blindness GHO-43 exists to remove,
// reintroduced one layer down.
func TestRecentRoundsAreOrderedByRecencyNotByRoundID(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// An old market with a high id, touched early.
	old := roundEvent(roundID(t, 900), ledger.RoundOpened, 700, "0xord1", 0, 0)
	// A new market with a low id, touched later. This is the one a listing
	// ordered by id would drop.
	fresh := roundEvent(roundID(t, 3), ledger.RoundOpened, 701, "0xord2", 0, 0)
	fresh.Market = otherMarket

	if err := st.Append(ctx, ledger.Batch{Rounds: []ledger.RoundEvent{old, fresh}},
		cursorAt(701, "0xh701")); err != nil {
		t.Fatalf("append: %v", err)
	}

	refs, err := st.RecentRounds(ctx, testChainID, "", 1)
	if err != nil {
		t.Fatalf("recent: %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("want one round, got %d", len(refs))
	}
	// The newest *block*, not the highest id.
	if refs[0].Market != otherMarket || refs[0].RoundID != roundID(t, 3) {
		t.Fatalf("got %+v, want the more recently touched round %d in %s",
			refs[0], roundID(t, 3), otherMarket)
	}
}

// The same for an account's own listing: a position in a freshly deployed
// market must not be pushed off the page by an older market's higher ids.
func TestRoundsForAccountAreOrderedByRecencyNotByRoundID(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	me := "0x" + t.Name()

	old := roundEvent(roundID(t, 900), ledger.PositionTaken, 800, "0xord3", 0, 0)
	old.Account, old.Side, old.Amount = me, ledger.SideUp, big.NewInt(100)
	fresh := roundEvent(roundID(t, 3), ledger.PositionTaken, 801, "0xord4", 0, 0)
	fresh.Market = otherMarket
	fresh.Account, fresh.Side, fresh.Amount = me, ledger.SideUp, big.NewInt(100)

	if err := st.Append(ctx, ledger.Batch{Rounds: []ledger.RoundEvent{old, fresh}},
		cursorAt(801, "0xh801")); err != nil {
		t.Fatalf("append: %v", err)
	}

	refs, err := st.RoundsForAccount(ctx, testChainID, me, "", 1)
	if err != nil {
		t.Fatalf("account rounds: %v", err)
	}
	if len(refs) != 1 || refs[0].Market != otherMarket {
		t.Fatalf("got %+v, want the more recently touched round in %s", refs, otherMarket)
	}
}
