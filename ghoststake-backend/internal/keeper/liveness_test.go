package keeper_test

import (
	"context"
	"errors"
	"math/big"
	"testing"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/keeper"
)

func observe(t *testing.T, f *fakeFeed) keeper.Liveness {
	t.Helper()
	live, err := keeper.Observe(context.Background(), f.read, new(big.Int).SetUint64(f.latest))
	if err != nil {
		t.Fatal(err)
	}
	return live
}

// The heartbeat is measured, not configured. A feed publishing every twenty
// seconds says so itself, and nothing has to be told.
func TestTheHeartbeatIsMeasuredFromTheFeed(t *testing.T) {
	f := heartbeatFeed(5_000, 100, 100_000, 20)
	live := observe(t, f)

	if !live.Known {
		t.Fatal("a hundred rounds is plenty to measure")
	}
	if live.Heartbeat != 20*time.Second {
		t.Fatalf("heartbeat %s, want 20s", live.Heartbeat)
	}
	// The newest round in the sample, which is what silence is measured from.
	if want := time.Unix(101_980, 0); !live.LastPublished.Equal(want) {
		t.Fatalf("last published %s, want %s", live.LastPublished, want)
	}
}

// The median, not the mean. A stock feed sampled on a Monday morning carries
// one seventeen-hour gap among nineteen twenty-second ones, and a mean would
// report a heartbeat of nearly an hour — which would then declare the feed
// alive through most of a weekend.
func TestOneOvernightGapDoesNotMoveTheHeartbeat(t *testing.T) {
	f := &fakeFeed{rounds: map[uint64]uint64{}}
	at := uint64(100_000)
	for i := uint64(0); i < 20; i++ {
		f.rounds[5_000+i] = at
		at += 20
		if i == 10 {
			at += 17 * 3600 // the overnight
		}
	}
	f.latest = 5_019

	live := observe(t, f)
	if live.Heartbeat != 20*time.Second {
		t.Fatalf("heartbeat %s, want 20s — one overnight gap has moved the median", live.Heartbeat)
	}
}

// "I could not tell" and "it is dead" are different answers. A DemoPriceFeed
// with two rounds pushed into it must not gate a market, or a fresh local
// stack would open no rounds at all.
func TestAFeedWithTooFewRoundsIsNotGated(t *testing.T) {
	f := &fakeFeed{rounds: map[uint64]uint64{1: 100_000, 2: 100_020}, latest: 2}
	live := observe(t, f)

	if live.Known {
		t.Fatal("two rounds is one gap, which is not a cadence")
	}
	// And an unmeasured feed reads as live, however long ago that was.
	if !live.Live(time.Unix(200_000, 0)) {
		t.Fatal("an unmeasured feed must not be treated as dead")
	}
}

// The check that replaces the calendar. A feed that has stopped publishing is
// a feed no round can settle against — whatever the reason, and without
// anything having to know what the reason is.
func TestAQuietFeedReadsAsDead(t *testing.T) {
	f := heartbeatFeed(5_000, 100, 100_000, 20)
	live := observe(t, f) // last published at 101_980, 20s heartbeat

	// Four heartbeats of tolerance, floored at two minutes — so the floor
	// governs here.
	cases := []struct {
		at   int64
		want bool
	}{
		{101_980, true},  // just published
		{102_040, true},  // three heartbeats
		{102_100, true},  // exactly the two-minute floor
		{102_101, false}, // past it
		{160_000, false}, // overnight
	}
	for _, c := range cases {
		if got := live.Live(time.Unix(c.at, 0)); got != c.want {
			t.Fatalf("at +%ds: live=%v, want %v", c.at-101_980, got, c.want)
		}
	}
}

// A slow feed gets proportionally more rope. An hourly feed is not dead two
// minutes after its last publication, and gating it on the floor would refuse
// every round it ever had.
func TestASlowFeedGetsProportionallyMoreRope(t *testing.T) {
	hourly := heartbeatFeed(1, 30, 0, 3600)
	live := observe(t, hourly)

	if live.Heartbeat != time.Hour {
		t.Fatalf("heartbeat %s, want 1h", live.Heartbeat)
	}
	if live.Deadline() != 4*time.Hour {
		t.Fatalf("deadline %s, want 4h", live.Deadline())
	}

	last := live.LastPublished
	if !live.Live(last.Add(3 * time.Hour)) {
		t.Fatal("three hours is not an outage on an hourly feed")
	}
	if live.Live(last.Add(5 * time.Hour)) {
		t.Fatal("five hours on an hourly feed is an outage")
	}
}

// A transport failure is not evidence of anything. Reading it as "no data"
// would shorten the sample silently and could invent a heartbeat.
func TestObserveDoesNotGuessThroughATransportFailure(t *testing.T) {
	boom := errors.New("connection reset")
	f := heartbeatFeed(5_000, 100, 100_000, 20)
	f.fail = boom

	if _, err := keeper.Observe(context.Background(), f.read, big.NewInt(5_099)); !errors.Is(err, boom) {
		t.Fatalf("got %v, want the transport error", err)
	}
}
