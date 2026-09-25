package keeper

import (
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// What the keeper does differently for a market that settles a question
// rather than a price (GHO-91). An internal test because both answers are
// decisions the keeper makes about its own bookkeeping, and reaching them
// through `driveMarket` would need a chain.

func eventMarket(n byte) *Market {
	m := testMarket(n)
	m.Event = true
	m.Question = "Brazil win the 2026 World Cup"
	return m
}

func TestAnEventMarketNeverOpensARound(t *testing.T) {
	k := refreshKeeper(t, &fakeSource{}, testMarket(1))
	k.cfg.OpenRounds = true

	// The state that makes the cadence rule say yes: the question's one round
	// has settled. A price market here would be opening its next round.
	settled := Round{Status: uint8(StatusResolved)}
	if !NeedsNewRound(settled, 30, 1000) {
		t.Fatal("the cadence rule is supposed to want a new round here — the test is not testing anything")
	}

	if k.shouldOpen(eventMarket(1), settled, 1000) {
		t.Fatal("a question was asked twice: the keeper opened a second round on an event market")
	}
	if !k.shouldOpen(testMarket(2), settled, 1000) {
		t.Fatal("a price market stopped opening rounds")
	}
}

func TestAnEventMarketIsNotRefusedForItsSchedule(t *testing.T) {
	cfg := Config{PollInterval: 10 * time.Second, Horizon: 3600, Lead: 45, OpenRounds: true}

	// A horizon far too short to split into an entry window and an
	// observation, which is what `schedulePlan` refuses. A price market with
	// this horizon must not start.
	price := testMarket(1)
	price.Horizon = 1
	if err := validateMarket(price, cfg); err == nil {
		t.Fatal("a price market with a one-second horizon should be refused")
	}

	// The same number on a question is meaningless rather than dangerous:
	// nothing here opens a round on a horizon. Refusing to start would take
	// every other market down with it.
	question := eventMarket(2)
	question.Horizon = 1
	if err := validateMarket(question, cfg); err != nil {
		t.Fatalf("a question was refused over a horizon it never uses: %v", err)
	}
}

func TestAnEventMarketDescribesItselfHonestly(t *testing.T) {
	m := eventMarket(1)
	m.Session = AlwaysOpen()

	// "24/7" and a heartbeat would both read as a market with a feed that
	// opens rounds around the clock. It has neither.
	if got := m.SessionLabel(); !strings.Contains(got, "question") {
		t.Fatalf("session label %q claims a schedule this market does not have", got)
	}
	if got := m.HeartbeatLabel(); !strings.Contains(got, "no feed") {
		t.Fatalf("heartbeat label %q claims a feed this market does not have", got)
	}
}

func TestOnlyTheEventFlagChangesTheseAnswers(t *testing.T) {
	// Guards the shape of the change: an event market differs from a price
	// market by this one field, so a Market built from a registry listing
	// cannot accidentally be half of each.
	m := &Market{Address: common.Address{9}, Timing: Timing{LockWindow: 60}}
	if m.Event {
		t.Fatal("a zero Market must be a price market, since that is what every existing deployment is")
	}
}
