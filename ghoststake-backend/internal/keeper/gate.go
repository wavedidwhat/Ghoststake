package keeper

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// The open gate: three layers, cheapest and most authoritative first.
//
// Only `openRound` is gated. Nothing here can stop a round already in flight
// from locking, settling or being refunded — those are the contract's
// business and stay permissionless. This decides one thing: whether creating
// a *new* round right now is a good idea.
//
// The layers, and why they are in this order:
//
//  1. **Is the feed publishing?** Measured from the feed's own history and
//     compared against the clock. Nothing to configure, nothing to maintain,
//     and it covers every reason a feed goes quiet at once — weekend,
//     holiday, half-day, corporate action, outage, deprecation. See Liveness.
//
//  2. **Does the venue say it is open?** Only when a market-status feed is
//     configured, and authoritative when it is — for the question it answers,
//     which is about now. It does not replace layer 3: knowing a venue is
//     trading says nothing about when it stops.
//
//  3. **Will it still be publishing at `closeTime`?** The only question the
//     first two cannot answer, because it is about the future. This is what
//     the trading calendar is now for, and all it is for.
//
// A round refused here is not lost — it is simply not created, and the next
// tick asks again.

// gateDisqualifyMargin is how far outside its session a feed must publish
// before the calendar is judged not to describe it.
//
// Not zero, because a closing auction print can land a little after the bell
// and a calendar should not be thrown away over thirty seconds. Half an hour
// is comfortably past any edge print and comfortably short of "it is
// publishing all night", which is the case worth detecting.
const gateDisqualifyMargin = 30 * time.Minute

// gateDecision is the answer, plus why, so a market that is not opening
// rounds can say so.
//
// `code` and `reason` are deliberately separate. The reason is written for a
// human and carries the numbers that make it useful — how long the feed has
// been quiet, which date the calendar stops at. Those numbers change on every
// tick, which makes the reason useless as an identity: the first version of
// this deduplicated log lines by comparing reasons, and since "quiet for
// 12h6m37s" never equals "quiet for 12h6m41s" it deduplicated nothing and
// logged the same standing condition every four seconds.
//
// The code is the identity. It does not move while the condition does not.
type gateDecision struct {
	ok     bool
	code   string
	reason string
}

func allow() gateDecision { return gateDecision{ok: true} }

func refuse(code, f string, a ...any) gateDecision {
	return gateDecision{code: code, reason: fmt.Sprintf(f, a...)}
}

// Refusal codes. Stable identities for the conditions that stop a market
// opening rounds.
const (
	refusedFeedEmpty       = "feed-empty"
	refusedFeedQuiet       = "feed-quiet"
	refusedVenueClosed     = "venue-closed"
	refusedSessionClosed   = "session-closed"
	refusedCalendarExpired = "calendar-expired"
)

// canOpen runs the three layers for one market and schedule.
func (k *Keeper) canOpen(ctx context.Context, m *Market, s Schedule, now uint64) (gateDecision, error) {
	at := time.Unix(int64(now), 0)

	// ---- 1. Is the feed publishing? ------------------------------------
	//
	// Read fresh every time rather than cached with the heartbeat: the
	// cadence is a property of the feed and does not move, but "when did it
	// last publish" is the whole question and is stale the moment it is read.
	live := m.Liveness
	if live.Known {
		_, latest, err := m.LatestFeedRound(ctx)
		if err != nil {
			return gateDecision{}, err
		}
		if latest == nil {
			return refuse(refusedFeedEmpty, "the feed has published nothing"), nil
		}
		live.LastPublished = time.Unix(int64(latest.UpdatedAt), 0)

		if !live.Live(at) {
			// Worth refusing rather than opening and hoping. A round opened
			// against a feed that is not publishing cannot lock — the
			// adapter reads it as unavailable — so it voids at the end of
			// its lock window. GHO-24's own soak run opened about ninety
			// such rounds against a dormant demo feed and voided every one.
			return refuse(refusedFeedQuiet,
				"the feed has been quiet for %s, which is past its %s deadline on a %s heartbeat",
				live.Silence(at).Round(time.Second), live.Deadline(), live.Heartbeat), nil
		}
	}

	// ---- 2. Does the venue say it is open? ------------------------------
	if m.status != nil {
		open, err := m.VenueOpen(ctx)
		if err != nil {
			// Not swallowed. A configured status feed that cannot be read is
			// a broken dependency, and guessing past it in either direction
			// is how the gate becomes decoration.
			return gateDecision{}, fmt.Errorf("market status feed: %w", err)
		}
		if !open {
			return refuse(refusedVenueClosed, "the venue's status feed reports the market closed"), nil
		}
		// Open — but that is a statement about *now*, and it does not skip the
		// forward check below. A status feed says the venue is trading; it
		// does not say when it stops, so a round opened at 15:58 against an
		// open venue can still run past a 16:00 close. Authoritative about
		// its own question, not about a different one.
	}

	// ---- 3. Will it still be publishing at closeTime? -------------------
	return k.forwardCheck(m, s, live), nil
}

// forwardCheck is the straddle question: this round ends at `closeTime`, and
// settlement needs a feed round at or before it *with a successor after it*.
// A round whose observation window runs past the point the feed stops has
// neither.
//
// Only the calendar can answer it, and only for a feed the calendar actually
// describes — which is the interesting part.
func (k *Keeper) forwardCheck(m *Market, s Schedule, live Liveness) gateDecision {
	if m.Session == nil {
		// A feed with no schedule. Nothing to straddle.
		return allow()
	}

	openAt := time.Unix(int64(s.OpenTime), 0)
	closeAt := time.Unix(int64(s.CloseTime), 0)

	// The calendar disqualifies itself. If this feed has been seen publishing
	// well outside the session the calendar claims it keeps, then the
	// calendar is not a description of this feed and applying it would idle a
	// market that is demonstrably working.
	//
	// This is what settles the "24/5 versus a 09:30 bell" argument without
	// anybody having to settle it: whichever is true, the feed shows us
	// inside one dark period, and we believe the feed.
	if m.calendarDisqualified {
		return allow()
	}
	if live.Known && m.Session.WellOutside(live.LastPublished, gateDisqualifyMargin) {
		m.calendarDisqualified = true
		slog.Info("keeper: this feed publishes outside the trading session, so the session calendar does not describe it — dropping the calendar for this market",
			"market", m.String(),
			"last_published", live.LastPublished.UTC())
		return allow()
	}

	// Past the end of the written-down holidays. Degrade rather than stop:
	// an expired list used to make every date read as closed, which is a
	// maintenance oversight taking the market down with it. A short round
	// opened against a feed we have just confirmed is publishing is a small,
	// bounded bet, and the contract refunds it if it turns out wrong.
	if !m.Session.Covers(closeAt) {
		length := closeAt.Sub(openAt)
		if length > k.cfg.MaxUncalendaredRound {
			return refuse(refusedCalendarExpired,
				"the trading calendar does not cover %s and a %s round is longer than the %s allowed without one — extend Session's holiday list",
				closeAt.UTC().Format("2006-01-02"), length, k.cfg.MaxUncalendaredRound)
		}
		slog.Warn("keeper: opening a round on a date the trading calendar does not cover",
			"market", m.String(), "close", closeAt.UTC(), "length", length)
		return allow()
	}

	if !m.Session.OpenThroughout(openAt, closeAt) {
		return refuse(refusedSessionClosed, "the trading session is not open from %s through %s",
			openAt.UTC().Format(time.TimeOnly), closeAt.UTC().Format(time.TimeOnly))
	}
	return allow()
}
