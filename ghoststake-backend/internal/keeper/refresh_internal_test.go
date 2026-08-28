package keeper

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// The refresh is the part of GHO-56 worth testing: what the keeper keeps,
// what it adds and — the case that costs somebody money if it is wrong — what
// it refuses to drop. An internal test because it reads the keeper's own
// bookkeeping, which is where the answers live.

// fakeSource stands in for the registry. Markets returns whatever it was last
// set to, or an error, which is the two things refreshMarkets branches on.
type fakeSource struct {
	markets []*Market
	err     error
}

func (f *fakeSource) Markets(context.Context) ([]*Market, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.markets, nil
}

func (f *fakeSource) Dynamic() bool { return true }

// testMarket is a Market with only the fields refreshMarkets and
// validateMarket read. Everything else needs a chain.
func testMarket(n byte) *Market {
	return &Market{
		Address: common.Address{n},
		Horizon: 3600,
		Timing:  Timing{LockWindow: 60, EntryCutoff: 30, ResolveDeadline: 600},
	}
}

func refreshKeeper(t *testing.T, source MarketSource, markets ...*Market) *Keeper {
	t.Helper()
	k, err := New(nil, nil, source, markets, Config{
		PollInterval:    10 * time.Second,
		RefreshInterval: time.Minute,
		Horizon:         3600,
		Lead:            45,
	})
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func addresses(markets []*Market) []string {
	out := make([]string, 0, len(markets))
	for _, m := range markets {
		out = append(out, m.Address.Hex())
	}
	return out
}

func TestRefreshAddsANewlyListedMarket(t *testing.T) {
	a, b := testMarket(1), testMarket(2)
	source := &fakeSource{markets: []*Market{a, b}}
	k := refreshKeeper(t, source, a)

	k.refreshMarkets(context.Background())

	if len(k.markets) != 2 {
		t.Fatalf("expected both markets, got %v", addresses(k.markets))
	}
}

// The same Market pointer has to survive a refresh. Rebuilding it would throw
// away calendarDisqualified — evidence accumulated at runtime — and re-read
// the feed's heartbeat for nothing.
func TestRefreshKeepsTheMarketItAlreadyLoaded(t *testing.T) {
	a := testMarket(1)
	k := refreshKeeper(t, &fakeSource{markets: []*Market{a}}, a)
	a.calendarDisqualified = true

	k.refreshMarkets(context.Background())

	if len(k.markets) != 1 || k.markets[0] != a {
		t.Fatalf("expected the same *Market back, got %v", addresses(k.markets))
	}
	if !k.markets[0].calendarDisqualified {
		t.Fatal("refresh threw away runtime state on the market")
	}
}

func TestRefreshDropsADelistedMarketWithNothingOpen(t *testing.T) {
	a, b := testMarket(1), testMarket(2)
	k := refreshKeeper(t, &fakeSource{markets: []*Market{a}}, a, b)
	k.pending[b.Address] = false
	k.cursor[b.Address] = 7

	k.refreshMarkets(context.Background())

	if len(k.markets) != 1 || k.markets[0] != a {
		t.Fatalf("expected only the listed market, got %v", addresses(k.markets))
	}
	if _, ok := k.cursor[b.Address]; ok {
		t.Fatal("dropping a market left its bookkeeping behind")
	}
}

// The case the issue calls out. Delisting hides a market from browsing; it
// does not settle anybody's stake. A keeper that dropped a delisted market
// with a round still in flight would strand it.
func TestRefreshRetiresRatherThanDropsAMarketWithARoundInFlight(t *testing.T) {
	a, b := testMarket(1), testMarket(2)
	k := refreshKeeper(t, &fakeSource{markets: []*Market{a}}, a, b)
	k.pending[b.Address] = true

	k.refreshMarkets(context.Background())

	if len(k.markets) != 2 {
		t.Fatalf("expected the delisted market to be kept, got %v", addresses(k.markets))
	}
	if !k.retiring[b.Address] {
		t.Fatal("the delisted market should be retiring, so no new round opens on it")
	}

	// Its last round settles, and the next tick lets it go.
	k.pending[b.Address] = false
	k.retireFinished()

	if len(k.markets) != 1 || k.markets[0] != a {
		t.Fatalf("expected it dropped once settled, got %v", addresses(k.markets))
	}
}

func TestRefreshUnretiresAMarketThatIsListedAgain(t *testing.T) {
	a := testMarket(1)
	source := &fakeSource{markets: []*Market{}}
	k := refreshKeeper(t, source, a)
	k.pending[a.Address] = true

	k.refreshMarkets(context.Background())
	if !k.retiring[a.Address] {
		t.Fatal("expected it retiring after the delist")
	}

	source.markets = []*Market{a}
	k.refreshMarkets(context.Background())

	if k.retiring[a.Address] {
		t.Fatal("a market listed again should open rounds again")
	}
	if len(k.markets) != 1 {
		t.Fatalf("expected one market, got %v", addresses(k.markets))
	}
}

// The failure mode that would be silent. One bad registry read must not read
// as "every market was delisted" — a keeper driving nothing looks exactly like
// a keeper with nothing to do.
func TestRefreshKeepsTheSetWhenTheRegistryReadFails(t *testing.T) {
	a, b := testMarket(1), testMarket(2)
	k := refreshKeeper(t, &fakeSource{err: fmt.Errorf("dial tcp: connection refused")}, a, b)

	k.refreshMarkets(context.Background())

	if len(k.markets) != 2 {
		t.Fatalf("a failed read emptied the market set: %v", addresses(k.markets))
	}
}

// Fatal at startup, skipped at runtime. A keeper already driving four markets
// should not exit because somebody listed a fifth with a lock window shorter
// than the poll interval.
func TestRefreshSkipsANewlyListedMarketItCannotDrive(t *testing.T) {
	a := testMarket(1)
	bad := testMarket(2)
	bad.Timing.LockWindow = 5 // shorter than the 10s poll interval
	k := refreshKeeper(t, &fakeSource{markets: []*Market{a, bad}}, a)

	k.refreshMarkets(context.Background())

	if len(k.markets) != 1 || k.markets[0] != a {
		t.Fatalf("expected the undrivable market skipped, got %v", addresses(k.markets))
	}
	if k.rejected[bad.Address] == "" {
		t.Fatal("expected the reason recorded, so it is logged once and not once a minute")
	}
}

// Every market delisted is a thing an operator can do. The keeper stays up so
// that listing one again is still just a transaction.
func TestRefreshSurvivesEveryMarketBeingDelisted(t *testing.T) {
	a := testMarket(1)
	k := refreshKeeper(t, &fakeSource{markets: []*Market{}}, a)

	k.refreshMarkets(context.Background())

	if len(k.markets) != 0 {
		t.Fatalf("expected an empty set, got %v", addresses(k.markets))
	}
	if k.maxBackoff <= 0 {
		t.Fatal("an empty set left an unusable backoff limit")
	}
}

// A market listed and then delisted before its first tick has no `pending`
// entry, and must not be dropped on the strength of one that was never
// written — it may have arrived carrying an open round from a previous keeper.
func TestRefreshDoesNotDropAMarketItHasNeverDriven(t *testing.T) {
	a, b := testMarket(1), testMarket(2)
	source := &fakeSource{markets: []*Market{a, b}}
	k := refreshKeeper(t, source, a)

	k.refreshMarkets(context.Background())

	source.markets = []*Market{a}
	k.refreshMarkets(context.Background())

	if len(k.markets) != 2 {
		t.Fatalf("expected the never-driven market kept until a pass says otherwise, got %v", addresses(k.markets))
	}
	if !k.retiring[b.Address] {
		t.Fatal("expected it retiring rather than dropped")
	}
}
