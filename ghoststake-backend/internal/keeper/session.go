package keeper

import (
	"fmt"
	"time"

	// Embeds the IANA database in the binary. The runtime image is
	// distroless-static: no shell, no package manager, and no
	// /usr/share/zoneinfo. Without this, `time.LoadLocation("America/New_York")`
	// fails inside the container and succeeds on every developer's laptop,
	// which is the worst possible place for a difference like that to live.
	_ "time/tzdata"
)

// Session is a trading calendar: when a feed's market is expected to be open.
//
// # What this is for, and what it is no longer for
//
// It used to be the whole gate: a stock-feed round was opened only when the
// NYSE session was open now and stayed open through `closeTime`. That put a
// hand-written list in charge of whether a market ran, and the list was both
// disputed (Robinhood's docs describe Stock Token feeds as 24/5 *and* as
// following market hours, which are different calendars) and finite.
//
// GHO-48 moved the "is it publishing now" half to the feed itself, where the
// answer is observable rather than asserted — see Liveness. What is left here
// is the half no observation can cover: **will it still be publishing at
// `closeTime`?** A round whose observation window runs past the closing bell
// settles against a feed that stopped moving partway through it, and finds no
// round published after the close to settle against at all.
//
// So this is now a forward-looking check, consulted by `forwardCheck` and
// nothing else.
//
// # The calendar can be wrong, and says so
//
// Because the feed is watched independently, the calendar's claim is now
// falsifiable. A feed seen publishing well outside the session it supposedly
// keeps is a feed this calendar does not describe, and `forwardCheck` drops
// it for that market rather than idling something demonstrably working. That
// is how the 24/5 question resolves itself in production without anyone
// having to resolve it here.
//
// # The list is finite, and that is now survivable
//
// Holidays are a list, not a rule — the NYSE observes ten of them, moves them
// when they fall at a weekend, and closes early on a handful of afternoons.
// The dates are written down through 2027.
//
// Past that, `Covers` reports false and the gate degrades to a short-round
// bound against a feed it has just confirmed is publishing, rather than the
// previous behaviour of reading every date as closed. An expired list should
// not be a dead man's switch on the product.
type Session struct {
	loc *time.Location

	// open and close are offsets from local midnight.
	open, close time.Duration

	// holidays are days with no session at all, keyed "2006-01-02" local.
	holidays map[string]bool

	// earlyCloses replace `close` on the days listed.
	earlyCloses map[string]time.Duration

	// lastCoveredYear is the last year the lists above are known good for.
	// Past it every day reads as closed.
	lastCoveredYear int
}

// NYSE hours, as offsets from midnight in America/New_York.
const (
	nyseOpen       = 9*time.Hour + 30*time.Minute
	nyseClose      = 16 * time.Hour
	nyseEarlyClose = 13 * time.Hour
)

// NYSESession is the US equity trading calendar, which is the one Robinhood
// Chain's Stock Token feeds follow.
//
// Covers 2026 and 2027. Extend both lists — and lastCoveredYear — before the
// second one runs out; see the type doc for what happens if nobody does.
func NYSESession() (*Session, error) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return nil, fmt.Errorf("keeper: load market timezone: %w", err)
	}
	return &Session{
		loc:   loc,
		open:  nyseOpen,
		close: nyseClose,
		holidays: set(
			// 2026
			"2026-01-01", // New Year's Day
			"2026-01-19", // Martin Luther King Jr. Day
			"2026-02-16", // Washington's Birthday
			"2026-04-03", // Good Friday
			"2026-05-25", // Memorial Day
			"2026-06-19", // Juneteenth
			"2026-07-03", // Independence Day (4th falls on a Saturday)
			"2026-09-07", // Labor Day
			"2026-11-26", // Thanksgiving
			"2026-12-25", // Christmas
			// 2027
			"2027-01-01", // New Year's Day
			"2027-01-18", // Martin Luther King Jr. Day
			"2027-02-15", // Washington's Birthday
			"2027-03-26", // Good Friday
			"2027-05-31", // Memorial Day
			"2027-06-18", // Juneteenth (19th falls on a Saturday)
			"2027-07-05", // Independence Day (4th falls on a Sunday)
			"2027-09-06", // Labor Day
			"2027-11-25", // Thanksgiving
			"2027-12-24", // Christmas (25th falls on a Saturday)
		),
		earlyCloses: map[string]time.Duration{
			"2026-11-27": nyseEarlyClose, // day after Thanksgiving
			"2026-12-24": nyseEarlyClose, // Christmas Eve
			"2027-11-26": nyseEarlyClose, // day after Thanksgiving
		},
		lastCoveredYear: 2027,
	}, nil
}

// AlwaysOpen is the calendar for a feed that never stops: crypto, and the
// demo feed, whose only schedule is whoever is pushing prices to it.
//
// A value rather than a nil check at every call site, so "this market is not
// gated" is a thing the keeper holds rather than a branch it keeps taking.
func AlwaysOpen() *Session { return nil }

// OpenThroughout reports whether a session is open at `from` and stays open
// through `to`.
//
// Both halves matter and they are not the same question. Opening a round
// during a session that ends before `closeTime` is precisely the
// straddles-the-bell case: entry works, the lock works, and then the feed
// stops publishing before there is anything to settle against.
//
// A nil Session is the ungated one and is always open.
func (s *Session) OpenThroughout(from, to time.Time) bool {
	if s == nil {
		return true
	}
	if to.Before(from) {
		return false
	}
	opensAt, closesAt, ok := s.boundsFor(from)
	if !ok {
		return false
	}
	// `from` inside the session, and `to` at or before the same session's
	// close. Comparing `to` against *this* session's close, rather than
	// asking whether `to` is in any session, is what rejects a window that
	// closes and reopens the next morning.
	return !from.Before(opensAt) && from.Before(closesAt) && !to.After(closesAt)
}

// OpenAt reports whether the session is open at a single instant.
func (s *Session) OpenAt(t time.Time) bool { return s.OpenThroughout(t, t) }

// Covers reports whether the holiday and early-close lists are known good for
// `t`. False past the last written-down year.
//
// Separate from OpenThroughout because "closed that day" and "I have no idea
// about that day" want different handling, and conflating them is what made
// an expired list take the market down with it.
func (s *Session) Covers(t time.Time) bool {
	if s == nil {
		return true
	}
	return t.In(s.loc).Year() <= s.lastCoveredYear
}

// WellOutside reports whether `t` falls more than `margin` outside any session
// on its own calendar day — evidence that this feed is not keeping the hours
// this calendar describes.
//
// The margin exists so a closing-auction print landing a little after the bell
// does not discredit an otherwise correct calendar. What it is meant to catch
// is a feed publishing in the middle of the night or over a weekend, which is
// not an edge case but a different schedule entirely.
//
// A date the calendar does not cover is not evidence of anything, so it
// reports false: we cannot say a feed is off-schedule using a schedule we do
// not have.
func (s *Session) WellOutside(t time.Time, margin time.Duration) bool {
	if s == nil || !s.Covers(t) {
		return false
	}
	opensAt, closesAt, ok := s.boundsFor(t)
	if !ok {
		// A weekend or a holiday. Any publication at all is outside, and no
		// margin applies — there is no bell to have printed just after.
		return true
	}
	return t.Before(opensAt.Add(-margin)) || t.After(closesAt.Add(margin))
}

// boundsFor returns the session on `t`'s local calendar day. ok is false on a
// weekend, a holiday, or a date the calendar does not cover.
func (s *Session) boundsFor(t time.Time) (opensAt, closesAt time.Time, ok bool) {
	local := t.In(s.loc)
	if local.Year() > s.lastCoveredYear {
		return time.Time{}, time.Time{}, false
	}
	switch local.Weekday() {
	case time.Saturday, time.Sunday:
		return time.Time{}, time.Time{}, false
	}

	day := local.Format("2006-01-02")
	if s.holidays[day] {
		return time.Time{}, time.Time{}, false
	}

	closeOffset := s.close
	if early, isEarly := s.earlyCloses[day]; isEarly {
		closeOffset = early
	}

	// Built from the local date at midnight rather than by truncating, so the
	// arithmetic follows the clock through a DST transition instead of
	// assuming every day is 24 hours long.
	midnight := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, s.loc)
	return midnight.Add(s.open), midnight.Add(closeOffset), true
}

func set(days ...string) map[string]bool {
	out := make(map[string]bool, len(days))
	for _, d := range days {
		out[d] = true
	}
	return out
}
