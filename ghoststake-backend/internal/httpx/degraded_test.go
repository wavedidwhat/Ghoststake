package httpx

import (
	"errors"
	"math/big"
	"testing"

	"forge.wavedidwhat.com/wave/ghoststake/internal/protocol"
)

// GHO-51 made round history span deployments on purpose, so a listing
// legitimately contains markets this process has never watched. One of them
// being unreadable used to take down every other market's data with it.
func TestOneUnreadableMarketDoesNotTakeDownTheRest(t *testing.T) {
	boom := errors.New("429 Too Many Requests")
	lookup := func(market string) (protocol.MarketParams, error) {
		if market == "0xBad" {
			return protocol.MarketParams{}, boom
		}
		return testParams(), nil
	}

	got, degraded, firstErr := partitionMarketParams([]string{"0xGood", "0xBad", "0xAlsoGood"}, lookup)

	if len(got) != 2 {
		t.Fatalf("resolved %d markets, want the 2 that could be read", len(got))
	}
	if _, ok := got["0xGood"]; !ok {
		t.Fatal("a readable market was dropped because another one failed")
	}
	if len(degraded) != 1 || degraded[0] != "0xBad" {
		t.Fatalf("degraded = %v, want [0xBad]", degraded)
	}
	// The original error, so serverError can still tell a rate limit from a
	// bug in the case where nothing at all could be rendered.
	if !errors.Is(firstErr, boom) {
		t.Fatalf("firstErr = %v, want the original cause", firstErr)
	}
}

// Every market failing is the only case that is still a failure, and the
// caller needs the cause to classify it.
func TestEveryMarketFailingKeepsTheCause(t *testing.T) {
	boom := errors.New("402 Payment Required")
	got, degraded, firstErr := partitionMarketParams(
		[]string{"0xA", "0xB"},
		func(string) (protocol.MarketParams, error) { return protocol.MarketParams{}, boom },
	)

	if len(got) != 0 {
		t.Fatalf("resolved %d markets, want none", len(got))
	}
	if len(degraded) != 2 {
		t.Fatalf("degraded = %v, want both", degraded)
	}
	if !errors.Is(firstErr, boom) {
		t.Fatalf("firstErr = %v, want the original cause", firstErr)
	}
}

// A listing is mostly repeats of a handful of markets. Asking once per round
// would multiply an RPC failure by the size of the page.
func TestEachMarketIsAskedOnce(t *testing.T) {
	calls := map[string]int{}
	lookup := func(market string) (protocol.MarketParams, error) {
		calls[market]++
		if market == "0xBad" {
			return protocol.MarketParams{}, errors.New("nope")
		}
		return testParams(), nil
	}

	markets := []string{"0xGood", "0xBad", "0xGood", "0xBad", "0xGood"}
	if _, _, _ = partitionMarketParams(markets, lookup); calls["0xGood"] != 1 {
		t.Fatalf("0xGood looked up %d times, want 1", calls["0xGood"])
	}
	if calls["0xBad"] != 1 {
		t.Fatalf("0xBad looked up %d times, want 1 — a failure must not be retried per round", calls["0xBad"])
	}
}

// Nothing degraded is the common case and must not put an empty array on
// every response.
func TestNothingDegradedIsNil(t *testing.T) {
	_, degraded, firstErr := partitionMarketParams(
		[]string{"0xGood"},
		func(string) (protocol.MarketParams, error) {
			return protocol.MarketParams{EntryCutoff: 15, Rake: big.NewInt(0), MinSidePool: big.NewInt(0)}, nil
		},
	)
	if degraded != nil {
		t.Fatalf("degraded = %v, want nil so it is omitted from JSON", degraded)
	}
	if firstErr != nil {
		t.Fatalf("firstErr = %v, want nil", firstErr)
	}
}

// Stable across requests. An unstable list looks like markets flapping when
// it is only map iteration order.
func TestDegradedIsSorted(t *testing.T) {
	_, degraded, _ := partitionMarketParams(
		[]string{"0xC", "0xA", "0xB"},
		func(string) (protocol.MarketParams, error) { return protocol.MarketParams{}, errors.New("nope") },
	)
	for i := 1; i < len(degraded); i++ {
		if degraded[i-1] > degraded[i] {
			t.Fatalf("degraded is not sorted: %v", degraded)
		}
	}
}
