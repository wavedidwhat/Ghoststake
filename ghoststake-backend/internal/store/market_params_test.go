package store_test

import (
	"context"
	"fmt"
	"math/big"
	"testing"
	"time"

	"forge.wavedidwhat.com/wave/ghoststake/internal/protocol"
)

// uniqueMarket returns an address no previous run has used.
//
// These tests assert on "not stored yet", which is only true once against a
// database that persists between runs — and TEST_DATABASE_URL may well be one.
// A fresh key per run is cheaper and more honest than deleting rows afterwards,
// which would need the pool exposed on Store purely so a test could reach it.
func uniqueMarket() string {
	return fmt.Sprintf("0x%040x", time.Now().UnixNano())
}

// A market's immutables survive the round trip through Postgres with their
// full precision. The point of persisting them at all (GHO-81) is that a
// restarted process does not have to ask an RPC endpoint three questions whose
// answers cannot change — which only holds if what comes back is what went in.
func TestMarketParamsRoundTrip(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	const chainID = 999111
	market := uniqueMarket()

	// A wei-scale value, deliberately past what float64 and int64 can hold:
	// NUMERIC(78,0) is the convention here precisely because a uint256 does
	// not fit any fixed-width type, and a lossy round trip would show up as a
	// rake that is subtly wrong rather than an error.
	rake, _ := new(big.Int).SetString("20000000000000000", 10)
	minSide, _ := new(big.Int).SetString("115792089237316195423570985008687907853269984665640564039457584007913129639935", 10)

	want := protocol.MarketParams{EntryCutoff: 15, Rake: rake, MinSidePool: minSide}

	if _, found, err := st.MarketParams(ctx, chainID, market); err != nil {
		t.Fatalf("read before write: %v", err)
	} else if found {
		t.Fatal("a market nobody has stored should not be found")
	}

	if err := st.PutMarketParams(ctx, chainID, market, want); err != nil {
		t.Fatalf("put: %v", err)
	}

	got, found, err := st.MarketParams(ctx, chainID, market)
	if err != nil {
		t.Fatalf("read after write: %v", err)
	}
	if !found {
		t.Fatal("stored params were not found")
	}
	if got.EntryCutoff != want.EntryCutoff {
		t.Fatalf("entry cutoff %d, want %d", got.EntryCutoff, want.EntryCutoff)
	}
	if got.Rake.Cmp(want.Rake) != 0 {
		t.Fatalf("rake %s, want %s", got.Rake, want.Rake)
	}
	if got.MinSidePool.Cmp(want.MinSidePool) != 0 {
		t.Fatalf("min side pool %s, want %s", got.MinSidePool, want.MinSidePool)
	}
}

// Writing twice keeps the first answer. These values are immutable, so a
// second write is either the same answer or a bug, and silently taking the
// newer one would hide the bug.
func TestPutMarketParamsKeepsTheFirstRead(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	const chainID = 999112
	market := uniqueMarket()

	first := protocol.MarketParams{EntryCutoff: 15, Rake: big.NewInt(2e16), MinSidePool: big.NewInt(1000)}
	second := protocol.MarketParams{EntryCutoff: 60, Rake: big.NewInt(9e16), MinSidePool: big.NewInt(5)}

	if err := st.PutMarketParams(ctx, chainID, market, first); err != nil {
		t.Fatalf("first put: %v", err)
	}

	if err := st.PutMarketParams(ctx, chainID, market, second); err != nil {
		t.Fatalf("second put: %v", err)
	}

	got, found, err := st.MarketParams(ctx, chainID, market)
	if err != nil || !found {
		t.Fatalf("read back: found=%v err=%v", found, err)
	}
	if got.EntryCutoff != first.EntryCutoff {
		t.Fatalf("entry cutoff %d, want the first read's %d", got.EntryCutoff, first.EntryCutoff)
	}
}

// Rake and min side pool are required: a nil *big.Int would otherwise reach
// the driver as a NULL into a NOT NULL column, which is a constraint violation
// several layers from the caller that caused it.
func TestPutMarketParamsRejectsMissingValues(t *testing.T) {
	st := newTestStore(t)

	err := st.PutMarketParams(context.Background(), 999113, uniqueMarket(), protocol.MarketParams{EntryCutoff: 15})
	if err == nil {
		t.Fatal("want an error for params with no rake")
	}
}
