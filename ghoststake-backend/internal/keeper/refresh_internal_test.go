package keeper

import (
	"context"
	"fmt"
	"math/big"
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

// GHO-76: the settlement search is memoised per (market, round) against the
// feed head it ran at. Terminal rounds and dropped markets must take their
// memo with them, or a long-lived keeper carries a row per round it ever saw.

func TestASettledRoundDropsItsSearchMemo(t *testing.T) {
	m := testMarket(1)
	k := refreshKeeper(t, &fakeSource{markets: []*Market{m}}, m)

	probe := retryKey(m, 7, actionSearch)
	k.searched[probe] = searchResult{head: big.NewInt(5_099), candidate: big.NewInt(5_050)}

	k.forget(m, 7)

	if _, ok := k.searched[probe]; ok {
		t.Fatal("the memo for a terminal round is still there")
	}
}

func TestADroppedMarketDropsEverySearchMemo(t *testing.T) {
	m := testMarket(1)
	other := testMarket(2)
	k := refreshKeeper(t, &fakeSource{markets: []*Market{m, other}}, m, other)

	k.searched[retryKey(m, 1, actionSearch)] = searchResult{head: big.NewInt(1), candidate: nil}
	k.searched[retryKey(m, 2, actionSearch)] = searchResult{head: big.NewInt(2), candidate: nil}
	keep := retryKey(other, 1, actionSearch)
	k.searched[keep] = searchResult{head: big.NewInt(3), candidate: nil}

	k.forgetMarket(m)

	if len(k.searched) != 1 {
		t.Fatalf("kept %d memos, want 1", len(k.searched))
	}
	if _, ok := k.searched[keep]; !ok {
		t.Fatal("dropping one market took another market's memo with it")
	}
}

// The gas check moved off the round loop. A keeper configured without one
// still has to check it at the poll interval rather than never.
func TestTheGasCheckFallsBackToThePollInterval(t *testing.T) {
	m := testMarket(1)
	k := refreshKeeper(t, &fakeSource{markets: []*Market{m}}, m)

	if got := k.gasCheckInterval(); got != 10*time.Second {
		t.Fatalf("gas check interval = %s, want the 10s poll interval", got)
	}

	k.cfg.GasCheckInterval = 5 * time.Minute
	if got := k.gasCheckInterval(); got != 5*time.Minute {
		t.Fatalf("gas check interval = %s, want 5m", got)
	}
}

// The budget an operator is shown at startup. Two markets on a ten-second
// poll: 6 polls/min x (1 shared header + 4 per market) = 54, plus the
// registry refresh (1 + 2) and one gas check.
func TestTheStartupBudgetCountsWhatEveryPollPays(t *testing.T) {
	a, b := testMarket(1), testMarket(2)
	k := refreshKeeper(t, &fakeSource{markets: []*Market{a, b}}, a, b)
	k.cfg.GasCheckInterval = time.Minute

	if got, want := k.callsPerMinute(), 54+3+1; got != want {
		t.Fatalf("callsPerMinute = %d, want %d", got, want)
	}

	// The whole point of the change: a slower gas check is fewer calls.
	k.cfg.GasCheckInterval = 5 * time.Minute
	if got := k.callsPerMinute(); got != 54+3 {
		t.Fatalf("callsPerMinute = %d, want %d with a 5m gas check", got, 54+3)
	}
}

// A deployment with no registry never re-reads one, so the budget must not
// bill it for a refresh it does not make.
func TestAStaticMarketListIsNotBilledForARefresh(t *testing.T) {
	m := testMarket(1)
	k := refreshKeeper(t, staticSource{m}, m)
	k.cfg.GasCheckInterval = time.Minute

	if k.refreshes() {
		t.Fatal("a static source reports as refreshing")
	}
	if got, want := k.callsPerMinute(), 30+1; got != want {
		t.Fatalf("callsPerMinute = %d, want %d with no registry refresh", got, want)
	}
}

// A MarketSource that can never return a different set, which is what a
// configured list of addresses is.
type staticSource []*Market

func (s staticSource) Markets(context.Context) ([]*Market, error) { return s, nil }
func (s staticSource) Dynamic() bool                              { return false }
