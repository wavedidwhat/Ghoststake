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

// Session is a trading calendar: when a feed's market is actually open.
//
// # Why the keeper needs one at all
//
// Robinhood Chain's Stock Token feeds follow US equity market hours. Crypto
// feeds do not — they publish continuously. A round scheduled across a
// closing bell settles against a feed that stopped moving partway through it,
// which resolves as a tie and voids, or finds no round published after the
// close and cannot resolve at all. Either way the market shows a user nothing
// happening, and the cause is invisible from the app.
//
// So the gate is on *opening*: a stock-feed round is only opened when the
// session is open now and will still be open at `closeTime`. Crypto-feed
// markets skip this entirely.
//
// # The calendar is hardcoded, and refuses to guess
//
// Holidays are a list, not a rule — the NYSE observes ten of them, moves them
// when they fall at a weekend, and closes early on a handful of afternoons.
// Deriving that is more code than the buildathon needs, so the dates are
// written down.
//
// The important consequence is what happens past the end of the list:
// `OpenThroughout` reports closed, not open. A calendar that ran out and
// defaulted to "open" would silently resume the exact failure it exists to
// prevent, on a date nobody was looking at.
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
