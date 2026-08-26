package keeper_test

import (
	"testing"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/keeper"
)

func nyse(t *testing.T) *keeper.Session {
	t.Helper()
	s, err := keeper.NYSESession()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// New York, because every rule in the calendar is stated in local time and a
// test written in UTC would pass or fail depending on the season.
func ny(t *testing.T, value string) time.Time {
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

// A crypto feed has no calendar, and the ungated market is a nil Session
// rather than a branch at every call site.
func TestAnAlwaysOpenMarketIsAlwaysOpen(t *testing.T) {
	always := keeper.AlwaysOpen()
	// A Sunday at 3am, which is the least open moment the NYSE calendar has.
	sunday := ny(t, "2026-08-30 03:00")
	if !always.OpenThroughout(sunday, sunday.Add(time.Hour)) {
		t.Fatal("a 24/7 feed does not stop for the weekend")
	}
}

func TestTheSessionBoundariesAreTheOpeningAndClosingBells(t *testing.T) {
	s := nyse(t)
	// Wednesday 26 August 2026, an ordinary trading day.
	cases := []struct {
		at   string
		want bool
	}{
		{"2026-08-26 09:29", false},
		{"2026-08-26 09:30", true},
		{"2026-08-26 15:59", true},
		// The close itself is not a moment you can open a round at: there is
		// no window left after it.
		{"2026-08-26 16:00", false},
		{"2026-08-26 20:00", false},
	}
	for _, c := range cases {
		if got := s.OpenAt(ny(t, c.at)); got != c.want {
			t.Fatalf("%s: got open=%v, want %v", c.at, got, c.want)
		}
	}
}

// The rule the issue calls out by name: do not open a round whose observation
// window straddles the closing bell. Both ends are checked, and they are not
// the same question — the start is inside a session in every one of these.
func TestARoundMayNotStraddleTheClosingBell(t *testing.T) {
	s := nyse(t)
	start := ny(t, "2026-08-26 15:30")

	if !s.OpenThroughout(start, ny(t, "2026-08-26 16:00")) {
		t.Fatal("a round ending exactly at the bell still settles inside the session")
	}
	if s.OpenThroughout(start, ny(t, "2026-08-26 16:01")) {
		t.Fatal("a round ending one minute after the bell must not be opened")
	}
	// Overnight into the next session is the same failure, not a different
	// one: the feed stops publishing in between.
	if s.OpenThroughout(start, ny(t, "2026-08-27 10:00")) {
		t.Fatal("a round spanning two sessions must not be opened")
	}
}

func TestWeekendsAndHolidaysHaveNoSession(t *testing.T) {
	s := nyse(t)
	closed := []string{
		"2026-08-29 12:00", // Saturday
		"2026-08-30 12:00", // Sunday
		"2026-09-07 12:00", // Labor Day
		"2026-11-26 12:00", // Thanksgiving
		"2026-07-03 12:00", // Independence Day, observed (the 4th is a Saturday)
		"2027-06-18 12:00", // Juneteenth, observed (the 19th is a Saturday)
	}
	for _, at := range closed {
		if s.OpenAt(ny(t, at)) {
			t.Fatalf("%s should be closed", at)
		}
	}
	if !s.OpenAt(ny(t, "2026-07-02 12:00")) {
		t.Fatal("the day before an observed holiday is a normal session")
	}
}

// Early closes are the quiet ones: the market is open, at a normal hour, and
// a round scheduled to settle at 3pm has nothing to settle against.
func TestEarlyClosesEndTheSessionAtOne(t *testing.T) {
	s := nyse(t)
	// The Friday after Thanksgiving 2026.
	if !s.OpenAt(ny(t, "2026-11-27 12:59")) {
		t.Fatal("an early-close day is still open in the morning")
	}
	if s.OpenAt(ny(t, "2026-11-27 13:00")) {
		t.Fatal("an early close ends the session at one")
	}
	if s.OpenThroughout(ny(t, "2026-11-27 12:30"), ny(t, "2026-11-27 15:00")) {
		t.Fatal("a round running past an early close must not be opened")
	}
}

// The calendar is a hardcoded list, so it runs out. What it must not do when
// it runs out is default to open — that would silently resume the exact
// failure the gate exists to prevent, on a date nobody is watching.
func TestPastTheCalendarEverythingReadsAsClosed(t *testing.T) {
	s := nyse(t)
	// A Wednesday at midday, well inside what would be a session.
	if s.OpenAt(ny(t, "2028-03-15 12:00")) {
		t.Fatal("beyond the last covered year the calendar must fail closed")
	}
}

// Session bounds are built from the local date rather than by adding hours to
// a UTC instant, so they follow the clock through a DST change instead of
// drifting by an hour for half the year.
func TestTheSessionHoldsAcrossDaylightSaving(t *testing.T) {
	s := nyse(t)
	// US DST ends on 1 November 2026, so these two Mondays sit on opposite
	// sides of it. Both open at 09:30 local.
	for _, day := range []string{"2026-10-26", "2026-11-02"} {
		if !s.OpenAt(ny(t, day+" 09:30")) {
			t.Fatalf("%s should open at 09:30 local", day)
		}
		if s.OpenAt(ny(t, day+" 09:29")) {
			t.Fatalf("%s should not be open at 09:29 local", day)
		}
	}
}

// The calendar now knows where it ends, and that is a different answer from
// "closed". Conflating the two is what made an expired holiday list take a
// market down with it.
func TestTheCalendarKnowsWhereItEnds(t *testing.T) {
	s := nyse(t)

	if !s.Covers(ny(t, "2027-12-31 12:00")) {
		t.Fatal("2027 is written down")
	}
	if s.Covers(ny(t, "2028-01-01 12:00")) {
		t.Fatal("2028 is not")
	}
	// A market with no calendar at all covers everything, because there is
	// nothing to run out of.
	if !keeper.AlwaysOpen().Covers(ny(t, "2099-01-01 12:00")) {
		t.Fatal("an ungated market has no calendar to expire")
	}
}

// The falsifiability test, and the reason the "24/5 versus a closing bell"
// argument no longer has to be won.
//
// If a feed is seen publishing in the middle of the night or over a weekend,
// then whatever the docs say, this feed does not keep these hours — and the
// keeper believes the feed rather than the list.
func TestAFeedPublishingOvernightDiscreditsTheCalendar(t *testing.T) {
	s := nyse(t)
	margin := 30 * time.Minute

	// 02:00 on a Wednesday. If Stock Token feeds really are 24/5, this is
	// exactly what their history looks like.
	if !s.WellOutside(ny(t, "2026-08-26 02:00"), margin) {
		t.Fatal("a publication at 2am is not this session's")
	}
	// A Saturday. No session at all, so any publication is outside it.
	if !s.WellOutside(ny(t, "2026-08-29 12:00"), margin) {
		t.Fatal("a publication on a Saturday is not this session's")
	}
	// A holiday, same reasoning.
	if !s.WellOutside(ny(t, "2026-09-07 12:00"), margin) {
		t.Fatal("a publication on Labor Day is not this session's")
	}
}

// The margin, which stops a correct calendar being thrown away over an edge
// print. A closing auction lands a little after the bell and that is normal;
// it is not evidence the feed runs all night.
func TestAnEdgePrintDoesNotDiscreditTheCalendar(t *testing.T) {
	s := nyse(t)
	margin := 30 * time.Minute

	for _, at := range []string{
		"2026-08-26 09:30", // the open
		"2026-08-26 09:05", // pre-open, inside the margin
		"2026-08-26 16:00", // the bell
		"2026-08-26 16:25", // a late print, inside the margin
	} {
		if s.WellOutside(ny(t, at), margin) {
			t.Fatalf("%s is within the margin and must not discredit the calendar", at)
		}
	}
	// Well past it, though, is a different schedule.
	if !s.WellOutside(ny(t, "2026-08-26 17:30"), margin) {
		t.Fatal("ninety minutes after the bell is outside the margin")
	}
}

// A date the calendar does not cover proves nothing about the feed. Judging a
// feed off-schedule needs a schedule to judge it against.
func TestAnUncoveredDateIsNotEvidence(t *testing.T) {
	s := nyse(t)
	if s.WellOutside(ny(t, "2028-08-26 02:00"), 30*time.Minute) {
		t.Fatal("we have no calendar for 2028, so we cannot say this is off-schedule")
	}
}
