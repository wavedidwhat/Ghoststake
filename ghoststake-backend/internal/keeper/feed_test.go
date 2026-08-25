package keeper_test

import (
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/keeper"
)

// A feed as a map from round id to publication time, plus a count of how many
// reads the search made — the whole reason the search is a binary one.
type fakeFeed struct {
	rounds map[uint64]uint64
	latest uint64
	reads  int
	fail   error
}

func (f *fakeFeed) read(_ context.Context, id *big.Int) (*keeper.FeedRound, error) {
	f.reads++
	if f.fail != nil {
		return nil, f.fail
	}
	at, ok := f.rounds[id.Uint64()]
	if !ok {
		// What a Chainlink proxy does for an id it holds nothing for.
		return nil, nil
	}
	return &keeper.FeedRound{UpdatedAt: at}, nil
}

// A feed publishing every 20 seconds, with history starting at a phase floor
// well above 1 — which is the case the first version of this search got
// wrong.
func heartbeatFeed(first, count, start, period uint64) *fakeFeed {
	f := &fakeFeed{rounds: map[uint64]uint64{}}
	for i := uint64(0); i < count; i++ {
		f.rounds[first+i] = start + i*period
	}
	f.latest = first + count - 1
	return f
}

func find(t *testing.T, f *fakeFeed, closeTime uint64) *big.Int {
	t.Helper()
	got, err := keeper.FindCloseRound(context.Background(), f.read, new(big.Int).SetUint64(f.latest), closeTime)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// The answer is the last round published at or before the close — and, just
// as importantly, one whose successor lands strictly after it. That pair is
// exactly what `ChainlinkRoundOracle.readAt` verifies.
func TestFindsTheLastRoundAtOrBeforeTheClose(t *testing.T) {
	// ids 5_000..5_099, published at 100_000, 100_020, ...
	f := heartbeatFeed(5_000, 100, 100_000, 20)

	// A close halfway through: 100_500 is round 5_025 exactly, and the next
	// one lands at 100_520.
	got := find(t, f, 100_500)
	if got == nil || got.Uint64() != 5_025 {
		t.Fatalf("got %v, want 5025", got)
	}

	// A close between two publications takes the earlier one.
	got = find(t, f, 100_519)
	if got == nil || got.Uint64() != 5_025 {
		t.Fatalf("got %v, want 5025", got)
	}

	// A close exactly on a publication takes that one, not the one before.
	got = find(t, f, 100_520)
	if got == nil || got.Uint64() != 5_026 {
		t.Fatalf("got %v, want 5026", got)
	}
}

// The search must not walk the feed. A hundred rounds is nothing; a real feed
// has tens of thousands, and one request per round is the difference between
// a settlement and a rate limit.
func TestTheSearchIsLogarithmic(t *testing.T) {
	f := heartbeatFeed(5_000, 100_000, 100_000, 20)
	f.reads = 0
	find(t, f, 1_100_000)

	// log2(105_000) is about 17, plus the latest read and the confirming one.
	if f.reads > 25 {
		t.Fatalf("%d reads for a 100k-round feed — the search is walking, not halving", f.reads)
	}
}

// Nothing published since the close means no round can be both the last one
// before it and have a successor after it. Waiting is the answer, and the
// round contract knows how long it is willing to wait.
func TestNothingPublishedSinceTheCloseMeansWait(t *testing.T) {
	f := heartbeatFeed(5_000, 100, 100_000, 20)
	// The feed's last publication is at 101_980.
	if got := find(t, f, 101_980); got != nil {
		t.Fatalf("got %v, want nil — the last round is not strictly after the close", got)
	}
	if got := find(t, f, 200_000); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

// A feed whose history begins after the close. The predicate makes the empty
// ids below the phase floor sort with the low half, so the search lands on an
// id that holds no data — which is not an answer.
func TestAFeedThatStartsAfterTheCloseHasNoAnswer(t *testing.T) {
	f := heartbeatFeed(5_000, 100, 100_000, 20)
	if got := find(t, f, 99_999); got != nil {
		t.Fatalf("got %v, want nil — nothing was published at or before the close", got)
	}
}

// A feed that has never published anything.
func TestAnEmptyFeedHasNoAnswer(t *testing.T) {
	f := &fakeFeed{rounds: map[uint64]uint64{}, latest: 0}
	if got := find(t, f, 100_000); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

// A transport failure is not "no data". Reading it as one is how a flaky RPC
// becomes a confident wrong candidate, so it comes back as an error and the
// keeper retries rather than resolving on it.
func TestATransportFailureIsNotAnAnswer(t *testing.T) {
	boom := errors.New("connection reset")
	f := heartbeatFeed(5_000, 100, 100_000, 20)
	f.fail = boom

	_, err := keeper.FindCloseRound(context.Background(), f.read, big.NewInt(5_099), 100_500)
	if !errors.Is(err, boom) {
		t.Fatalf("got %v, want the transport error", err)
	}
}
