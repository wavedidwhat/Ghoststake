package keeper

import (
	"strings"
	"testing"
	"time"
)

// The forward check is the half of the gate that a live feed cannot answer,
// so it is the half worth testing on its own. An internal test because it
// reads a Market's calendar state, which nothing outside this package has any
// business setting.

func nyseSession(t *testing.T) *Session {
	t.Helper()
	s, err := NYSESession()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func at(t *testing.T, value string) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := time.ParseInLocation("2006-01-02 15:04", value, loc)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func scheduleBetween(t *testing.T, open, close string) Schedule {
	t.Helper()
	return Schedule{
		OpenTime:  uint64(at(t, open).Unix()),
		CloseTime: uint64(at(t, close).Unix()),
	}
}

func gateKeeper() *Keeper {
	return &Keeper{cfg: Config{MaxUncalendaredRound: 15 * time.Minute}}
}

// A feed with no schedule has nothing to straddle.
func TestForwardCheckPassesAMarketWithNoCalendar(t *testing.T) {
	k := gateKeeper()
	m := &Market{Session: AlwaysOpen()}

	// Across a weekend, which would fail every other case here.
	s := scheduleBetween(t, "2026-08-28 20:00", "2026-08-31 06:00")
	if d := k.forwardCheck(m, s, Liveness{}); !d.ok {
		t.Fatalf("refused: %s", d.reason)
	}
}

func TestForwardCheckRefusesARoundThatStraddlesTheBell(t *testing.T) {
	k := gateKeeper()
	m := &Market{Session: nyseSession(t)}

	inside := scheduleBetween(t, "2026-08-26 15:00", "2026-08-26 15:55")
	if d := k.forwardCheck(m, inside, Liveness{}); !d.ok {
		t.Fatalf("a round finishing before the bell was refused: %s", d.reason)
	}

	straddles := scheduleBetween(t, "2026-08-26 15:45", "2026-08-26 16:10")
	if d := k.forwardCheck(m, straddles, Liveness{}); d.ok {
		t.Fatal("a round finishing after the bell must be refused")
	}
}

// The one that matters. A feed observed publishing overnight is not keeping
// market hours, so the calendar does not describe it and is dropped — which
// is how the "24/5 versus a closing bell" question stops needing an answer.
//
// Note what this buys: under the 24/5 reading the market runs through the
// night instead of idling eighteen hours a day, and nobody had to decide
// which reading was true.
func TestAFeedSeenPublishingOvernightDropsTheCalendar(t *testing.T) {
	k := gateKeeper()
	m := &Market{Session: nyseSession(t)}

	// A round entirely outside the session — refused, on the evidence
	// available so far.
	overnight := scheduleBetween(t, "2026-08-26 02:00", "2026-08-26 02:05")
	if d := k.forwardCheck(m, overnight, Liveness{}); d.ok {
		t.Fatal("with no evidence about the feed, the calendar stands")
	}

	// Now the feed is seen publishing at 02:00, which no market-hours feed
	// does.
	live := Liveness{Known: true, LastPublished: at(t, "2026-08-26 02:00")}
	if d := k.forwardCheck(m, overnight, live); !d.ok {
		t.Fatalf("a feed publishing overnight discredits the calendar: %s", d.reason)
	}
	if !m.calendarDisqualified {
		t.Fatal("the market should have recorded that its calendar does not apply")
	}

	// And it stays dropped, without needing the evidence again. Evidence that
	// a calendar is wrong does not expire, and a flag that flapped would have
	// the market opening rounds on alternate ticks.
	if d := k.forwardCheck(m, overnight, Liveness{}); !d.ok {
		t.Fatalf("the calendar came back: %s", d.reason)
	}
}

// An expired holiday list degrades instead of stopping the market. A short
// round against a feed just confirmed to be publishing is a small, bounded
// bet, and the contract refunds it if it turns out wrong.
func TestAnExpiredCalendarDegradesRatherThanStopping(t *testing.T) {
	k := gateKeeper()
	m := &Market{Session: nyseSession(t)}

	short := scheduleBetween(t, "2028-03-15 12:00", "2028-03-15 12:10")
	if d := k.forwardCheck(m, short, Liveness{}); !d.ok {
		t.Fatalf("a ten-minute round past the calendar was refused: %s", d.reason)
	}

	long := scheduleBetween(t, "2028-03-15 12:00", "2028-03-15 14:00")
	d := k.forwardCheck(m, long, Liveness{})
	if d.ok {
		t.Fatal("a two-hour round past the calendar must be refused")
	}
	// The reason has to name the fix, because this is a maintenance failure
	// and the log line is where somebody finds out.
	if !strings.Contains(d.reason, "extend") {
		t.Fatalf("the refusal should say what to do about it, got %q", d.reason)
	}
}

// A refusal's identity must not move while the condition does not.
//
// The first version of the log deduplication compared reasons, and a reason
// carries the numbers that make it readable — "quiet for 12h6m37s". Those
// change every tick, so nothing ever matched and a market sitting closed
// logged the same line every four seconds. The code is what holds still.
func TestARefusalsIdentityDoesNotMoveWithItsNumbers(t *testing.T) {
	k := gateKeeper()
	m := &Market{Session: nyseSession(t)}

	long := scheduleBetween(t, "2028-03-15 12:00", "2028-03-15 14:00")
	longer := scheduleBetween(t, "2028-03-15 12:00", "2028-03-15 18:00")

	first := k.forwardCheck(m, long, Liveness{})
	second := k.forwardCheck(m, longer, Liveness{})

	if first.ok || second.ok {
		t.Fatal("both should be refused")
	}
	if first.code != second.code {
		t.Fatalf("same condition, different codes: %q and %q", first.code, second.code)
	}
	if first.reason == second.reason {
		t.Fatal("the reasons should differ — they carry the numbers, which is why they cannot be the identity")
	}
	if first.code == "" {
		t.Fatal("a refusal with no code deduplicates against every other refusal")
	}
}

// Every refusal path has to carry a code, or two unrelated conditions
// deduplicate against each other and the second one never gets logged.
func TestEveryRefusalCarriesACode(t *testing.T) {
	k := gateKeeper()
	straddle := k.forwardCheck(&Market{Session: nyseSession(t)},
		scheduleBetween(t, "2026-08-26 15:45", "2026-08-26 16:10"), Liveness{})
	expired := k.forwardCheck(&Market{Session: nyseSession(t)},
		scheduleBetween(t, "2028-03-15 12:00", "2028-03-15 14:00"), Liveness{})

	for _, d := range []gateDecision{straddle, expired} {
		if d.code == "" {
			t.Fatalf("refusal %q has no code", d.reason)
		}
	}
	if straddle.code == expired.code {
		t.Fatal("a closed session and an expired calendar are different conditions and need different codes")
	}
}
