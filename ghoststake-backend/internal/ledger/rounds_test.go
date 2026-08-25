package ledger_test

import (
	"math/big"
	"strconv"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

const (
	alice = "0x000000000000000000000000000000000000a11c"
	bob   = "0x000000000000000000000000000000000000B0B0"
	// The borrow-to-position router, which funds a leveraged stake.
	router = "0x0000000000000000000000000000000000R0Ute7"
)

func event(block uint64, logIndex uint, name string, roundID uint64) ledger.RoundEvent {
	return ledger.RoundEvent{
		Provenance: ledger.Provenance{
			ChainID: 31337, BlockNumber: block, LogIndex: logIndex,
			BlockHash: "0xb", TxHash: "0xt" + strconv.FormatUint(block, 10),
			Contract: "ParimutuelRound", EventName: name,
		},
		RoundID: roundID,
		Data:    map[string]string{},
	}
}

func opened(block uint64, id uint64, open, lock, close int64) ledger.RoundEvent {
	e := event(block, 0, ledger.RoundOpened, id)
	e.Data = map[string]string{
		"openTime":  strconv.FormatInt(open, 10),
		"lockTime":  strconv.FormatInt(lock, 10),
		"closeTime": strconv.FormatInt(close, 10),
	}
	return e
}

func staked(block uint64, logIndex uint, id uint64, account, side string, amount int64, funder string) ledger.RoundEvent {
	e := event(block, logIndex, ledger.PositionTaken, id)
	e.Account = account
	e.Side = side
	e.Amount = big.NewInt(amount)
	e.Data = map[string]string{"funder": funder}
	return e
}

func find(t *testing.T, rounds []ledger.Round, id uint64) ledger.Round {
	t.Helper()
	for _, r := range rounds {
		if r.RoundID == id {
			return r
		}
	}
	t.Fatalf("round %d not projected", id)
	return ledger.Round{}
}

// The whole lifecycle, folded.
func TestARoundFoldsThroughItsLifecycle(t *testing.T) {
	locked := event(12, 0, ledger.RoundLocked, 1)
	locked.Data = map[string]string{"lockPrice": "2500", "oracleRoundId": "77"}

	resolved := event(14, 0, ledger.RoundResolved, 1)
	resolved.Data = map[string]string{"closePrice": "2600", "winner": "up", "rakeTaken": "200"}

	round := find(t, ledger.Project([]ledger.RoundEvent{
		opened(10, 1, 1_000, 2_000, 3_000),
		staked(11, 0, 1, alice, ledger.SideUp, 600, alice),
		staked(11, 1, 1, bob, ledger.SideDown, 400, bob),
		locked,
		resolved,
	}), 1)

	if round.Status != ledger.StatusResolved {
		t.Fatalf("status %q, want resolved", round.Status)
	}
	if round.UpPool.Cmp(big.NewInt(600)) != 0 || round.DownPool.Cmp(big.NewInt(400)) != 0 {
		t.Fatalf("pools up=%s down=%s, want 600/400", round.UpPool, round.DownPool)
	}
	if round.TotalPool().Cmp(big.NewInt(1_000)) != 0 {
		t.Fatalf("total pool %s, want 1000", round.TotalPool())
	}
	if round.Winner != "up" || round.LockPrice.Cmp(big.NewInt(2_500)) != 0 {
		t.Fatalf("winner %q lock price %s", round.Winner, round.LockPrice)
	}
	if round.LastBlock != 14 {
		t.Fatalf("last block %d, want 14", round.LastBlock)
	}
	if round.OpenTime.Unix() != 1_000 || round.LockTime.Unix() != 2_000 {
		t.Fatalf("times %v / %v", round.OpenTime, round.LockTime)
	}
}

// The fold must not depend on the order the rows arrive in. A caller that
// queried without an ORDER BY, or a batch stitched from two ranges, has to
// produce the same answer — otherwise the projection is a race.
func TestProjectionIsIndependentOfInputOrder(t *testing.T) {
	locked := event(12, 0, ledger.RoundLocked, 1)
	locked.Data = map[string]string{"lockPrice": "2500"}
	voided := event(13, 0, ledger.RoundVoided, 1)
	voided.Data = map[string]string{"reason": "one-sided pool"}

	forwards := []ledger.RoundEvent{
		opened(10, 1, 1_000, 2_000, 3_000),
		staked(11, 0, 1, alice, ledger.SideUp, 600, alice),
		locked,
		voided,
	}
	backwards := []ledger.RoundEvent{voided, locked, forwards[1], forwards[0]}

	a := find(t, ledger.Project(forwards), 1)
	b := find(t, ledger.Project(backwards), 1)

	if a.Status != b.Status || a.Status != ledger.StatusVoid {
		t.Fatalf("statuses differ: %q vs %q", a.Status, b.Status)
	}
	if a.UpPool.Cmp(b.UpPool) != 0 {
		t.Fatalf("pools differ: %s vs %s", a.UpPool, b.UpPool)
	}
	if a.VoidReason != "one-sided pool" {
		t.Fatalf("void reason %q — the contract's own reason must survive", a.VoidReason)
	}
}

// Two rounds in one batch must not bleed into each other, which is the bug a
// projection keyed on anything but the round id would have.
func TestRoundsAreProjectedIndependently(t *testing.T) {
	rounds := ledger.Project([]ledger.RoundEvent{
		opened(10, 1, 1_000, 2_000, 3_000),
		opened(10, 2, 3_000, 4_000, 5_000),
		staked(11, 0, 1, alice, ledger.SideUp, 600, alice),
		staked(11, 1, 2, alice, ledger.SideUp, 100, alice),
	})
	if len(rounds) != 2 {
		t.Fatalf("want 2 rounds, got %d", len(rounds))
	}
	if got := find(t, rounds, 1).UpPool; got.Cmp(big.NewInt(600)) != 0 {
		t.Fatalf("round 1 up pool %s, want 600", got)
	}
	if got := find(t, rounds, 2).UpPool; got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("round 2 up pool %s, want 100", got)
	}
}

// A user's position, including the fact that a claim does not reduce a stake.
func TestPositionsFoldPerAccount(t *testing.T) {
	claim := event(15, 0, ledger.Claimed, 1)
	claim.Account = alice
	claim.Amount = big.NewInt(980)
	claim.Data = map[string]string{"recipient": alice}

	events := []ledger.RoundEvent{
		opened(10, 1, 1_000, 2_000, 3_000),
		staked(11, 0, 1, alice, ledger.SideUp, 400, alice),
		staked(11, 1, 1, alice, ledger.SideUp, 200, alice), // topped up
		staked(11, 2, 1, bob, ledger.SideDown, 400, bob),
		claim,
	}

	positions := ledger.ProjectPositions(events, alice)
	if len(positions) != 1 {
		t.Fatalf("want 1 position, got %d", len(positions))
	}
	position := positions[0]

	if position.UpStake.Cmp(big.NewInt(600)) != 0 {
		t.Fatalf("up stake %s, want 600 (two entries summed)", position.UpStake)
	}
	if position.DownStake.Sign() != 0 {
		t.Fatalf("bob's stake leaked into alice's position: %s", position.DownStake)
	}
	if !position.Claimed || position.ClaimedAmount.Cmp(big.NewInt(980)) != 0 {
		t.Fatalf("claim not folded: claimed=%v amount=%s", position.Claimed, position.ClaimedAmount)
	}
	// The contract sets a flag rather than zeroing the stake, and the
	// projection must say the same thing — the stake is what the payout was
	// computed from.
	if position.TotalStake().Cmp(big.NewInt(600)) != 0 {
		t.Fatalf("claiming reduced the recorded stake to %s", position.TotalStake())
	}
	if position.Leveraged {
		t.Fatal("a self-funded stake was marked leveraged")
	}
}

// A stake the router funded is leveraged: the payout routes back through it
// to repay the debt before anything reaches the user.
func TestARouterFundedStakeIsLeveraged(t *testing.T) {
	positions := ledger.ProjectPositions([]ledger.RoundEvent{
		opened(10, 1, 1_000, 2_000, 3_000),
		staked(11, 0, 1, alice, ledger.SideUp, 5_000, router),
	}, alice)

	if len(positions) != 1 || !positions[0].Leveraged {
		t.Fatalf("want one leveraged position, got %+v", positions)
	}
}

// Newest round first: a positions list is read top down, and the round
// someone is in right now is the one they came to look at.
func TestPositionsAreNewestRoundFirst(t *testing.T) {
	positions := ledger.ProjectPositions([]ledger.RoundEvent{
		staked(11, 0, 1, alice, ledger.SideUp, 100, alice),
		staked(12, 0, 3, alice, ledger.SideUp, 100, alice),
		staked(13, 0, 2, alice, ledger.SideUp, 100, alice),
	}, alice)

	var ids []uint64
	for _, p := range positions {
		ids = append(ids, p.RoundID)
	}
	if len(ids) != 3 || ids[0] != 3 || ids[1] != 2 || ids[2] != 1 {
		t.Fatalf("order %v, want [3 2 1]", ids)
	}
}

// An account with no events has no positions — and asking for "" must not
// match the round-level events, which carry no account.
func TestAnEmptyAccountMatchesNothing(t *testing.T) {
	events := []ledger.RoundEvent{
		opened(10, 1, 1_000, 2_000, 3_000),
		staked(11, 0, 1, alice, ledger.SideUp, 100, alice),
	}
	if got := ledger.ProjectPositions(events, ""); len(got) != 0 {
		t.Fatalf("the empty account matched %d positions", len(got))
	}
	if got := ledger.ProjectPositions(events, bob); len(got) != 0 {
		t.Fatalf("an uninvolved account matched %d positions", len(got))
	}
}

// The contract's Side enum, mapped by position. A third value must be an
// error rather than silently becoming "up" — a position filed under the wrong
// side understates one pool and overstates the other.
func TestSideEnumRejectsUnknownValues(t *testing.T) {
	if side, err := ledger.SideFromEnum(0); err != nil || side != ledger.SideUp {
		t.Fatalf("0 -> %q, %v", side, err)
	}
	if side, err := ledger.SideFromEnum(1); err != nil || side != ledger.SideDown {
		t.Fatalf("1 -> %q, %v", side, err)
	}
	if _, err := ledger.SideFromEnum(2); err == nil {
		t.Fatal("an unknown side was accepted")
	}
}
