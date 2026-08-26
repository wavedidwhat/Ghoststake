package keeper

import (
	"context"
	"fmt"
	"math/big"
	"sort"
	"time"
)

// Liveness answers the only question the open gate actually cares about:
// **will this feed still be publishing when the round needs settling?**
//
// # Why not just read a trading calendar
//
// GHO-24 gated stock markets on the NYSE session — 09:30 to 16:00 New York,
// weekdays, minus a holiday list. It is the safe reading and it worked, and it
// is the wrong shape for anything that has to keep running.
//
// It answers a proxy question. The keeper does not care what the NYSE is
// doing; it cares whether *this feed* will publish a round at or before
// `closeTime` with a successor after it. Every gap between the proxy and the
// thing — a feed that keeps publishing after the bell, a venue that halts one
// ticker mid-session, a feed deprecated entirely — is a gap where the gate is
// confidently wrong.
//
// It also could not be made right, because the premise was disputed.
// Robinhood's docs say Stock Token feeds update 24/5 *and* that they follow US
// market hours; those are different calendars, and nobody here has a live feed
// to settle it with. A gate built on either reading is a coin flip.
//
// And it expired. Past the last year in the holiday list every date read as
// closed, which is a loud failure but a total one — a list somebody has to
// remember to extend is a dead man's switch on the product.
//
// # What this does instead
//
// Asks the feed. `Observe` measures the feed's own publication cadence from
// its own history, and `Live` reports whether it has gone quiet relative to
// that cadence.
//
// This subsumes the entire calendar for free. On Thanksgiving the feed is not
// publishing. At 02:00 on a Sunday it is not publishing. During a
// corporate-action pause it is not publishing. During an outage nobody
// announced it is not publishing. One check, nothing to maintain, and it never
// expires.
//
// The part worth noticing: it gives the *right answer under either reading of
// the docs*, without anybody having to find out which is true. If the feeds
// really are 24/5, the feed is publishing at 02:00 ET, the check passes, and
// stock markets run through the night instead of idling eighteen hours a day.
// If they follow the session, the feed is quiet then and no round opens. Same
// code, and the disputed fact stops mattering.
//
// # What it cannot do
//
// It is a statement about now, and the straddle risk is about the future — a
// feed publishing happily at 15:58 says nothing about 16:03. That half still
// needs a schedule, which is what `Session` is now for and all it is for. See
// `CanOpen`.
type Liveness struct {
	// Heartbeat is the feed's observed publication interval: the median gap
	// between consecutive rounds in the sample.
	//
	// Median rather than mean, because one overnight gap in the sample would
	// drag a mean into uselessness — which is exactly the sample a stock feed
	// gives you on a Monday morning.
	Heartbeat time.Duration

	// LastPublished is when the newest round in the sample landed.
	LastPublished time.Time

	// Known is false when the feed has published too few rounds to measure.
	// An unmeasurable feed is not gated: "I could not tell" and "it is dead"
	// are different answers, and a fresh DemoPriceFeed with two rounds on it
	// is the first one.
	Known bool
}

// livenessSample is how many recent feed rounds Observe reads.
//
// Twenty is enough for a stable median and cheap enough to do per market at
// startup. It deliberately does not try to span a dark period: this measures
// the cadence when the feed *is* publishing, and whether it is publishing now
// is a separate comparison against the clock.
const livenessSample = 20

// livenessTolerance is how many heartbeats of silence still count as alive.
//
// Chainlink feeds publish on a heartbeat *or* a deviation threshold, whichever
// comes first, so a quiet market legitimately stretches past one interval. The
// adapter's own staleness bound is the real authority on whether a price is
// usable; this is the looser question of whether anyone is home, and being
// generous here only costs a round that voids rather than a round that never
// opened.
const livenessTolerance = 4

// livenessFloor is the least silence that counts as dead, whatever the
// measured heartbeat says. A demo feed pushed twice in quick succession
// measures a two-second heartbeat, and eight seconds of quiet is not an
// outage.
const livenessFloor = 2 * time.Minute

// Observe measures a feed's cadence from its recent rounds.
//
// Walks back from the latest round rather than binary-searching, because the
// sample is small, bounded, and wants to be *contiguous* — the gaps between
// consecutive rounds are the measurement, and a sparse sample would measure
// something else.
//
// Ids that hold no data are skipped rather than fatal. Chainlink proxies
// return nothing below the current phase's first round, so a feed that
// recently rolled over a phase has empty ids inside the walk.
func Observe(ctx context.Context, read RoundReader, latestID *big.Int) (Liveness, error) {
	if latestID == nil || latestID.Sign() <= 0 {
		return Liveness{}, nil
	}

	stamps := make([]uint64, 0, livenessSample)
	id := new(big.Int).Set(latestID)
	one := big.NewInt(1)
	for range livenessSample {
		if id.Sign() <= 0 {
			break
		}
		round, err := read(ctx, id)
		if err != nil {
			return Liveness{}, fmt.Errorf("keeper: sample feed round %s: %w", id, err)
		}
		if round != nil {
			stamps = append(stamps, round.UpdatedAt)
		}
		id = new(big.Int).Sub(id, one)
	}

	// Two rounds make one gap, which is a sample of one and not a cadence.
	// Three is the least that can have a median.
	if len(stamps) < 3 {
		return Liveness{}, nil
	}

	gaps := make([]time.Duration, 0, len(stamps)-1)
	for i := 0; i+1 < len(stamps); i++ {
		// stamps is newest-first, so the gap is the earlier subtracted from
		// the later. A non-increasing pair means the feed reported timestamps
		// out of order; skipped rather than trusted, since a negative gap
		// would poison the median.
		if stamps[i] <= stamps[i+1] {
			continue
		}
		gaps = append(gaps, time.Duration(stamps[i]-stamps[i+1])*time.Second)
	}
	if len(gaps) == 0 {
		return Liveness{}, nil
	}

	sort.Slice(gaps, func(a, b int) bool { return gaps[a] < gaps[b] })
	return Liveness{
		Heartbeat:     gaps[len(gaps)/2],
		LastPublished: time.Unix(int64(stamps[0]), 0),
		Known:         true,
	}, nil
}

// Silence is how long the feed has been quiet at `now`.
func (l Liveness) Silence(now time.Time) time.Duration {
	return now.Sub(l.LastPublished)
}

// Deadline is how much silence this feed is allowed before it reads as dead.
func (l Liveness) Deadline() time.Duration {
	allowed := l.Heartbeat * livenessTolerance
	if allowed < livenessFloor {
		return livenessFloor
	}
	return allowed
}

// Live reports whether the feed is still publishing as of `now`.
//
// An unmeasured feed is live: see Liveness.Known. A feed reporting a future
// timestamp is live too — the silence is negative, which is nonsense but not
// evidence of death, and the adapter refuses such a reading on its own.
func (l Liveness) Live(now time.Time) bool {
	if !l.Known {
		return true
	}
	return l.Silence(now) <= l.Deadline()
}
