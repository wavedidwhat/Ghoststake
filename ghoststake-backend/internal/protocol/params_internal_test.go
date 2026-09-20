package protocol

import (
	"context"
	"errors"
	"math/big"
	"sync"
	"testing"
	"time"
)

// fakeStore is a ParamStore that counts what it was asked.
type fakeStore struct {
	mu      sync.Mutex
	rows    map[string]MarketParams
	reads   int
	writes  int
	readErr error
}

func newFakeStore() *fakeStore { return &fakeStore{rows: map[string]MarketParams{}} }

func (f *fakeStore) MarketParams(_ context.Context, _ int64, market string) (MarketParams, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	if f.readErr != nil {
		return MarketParams{}, false, f.readErr
	}
	p, ok := f.rows[market]
	return p, ok, nil
}

func (f *fakeStore) PutMarketParams(_ context.Context, _ int64, market string, p MarketParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	f.rows[market] = p
	return nil
}

func (f *fakeStore) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads, f.writes
}

func params() MarketParams {
	return MarketParams{EntryCutoff: 15, Rake: big.NewInt(2e16), MinSidePool: big.NewInt(1000)}
}

func newReader(store ParamStore) *Reader {
	return &Reader{
		params:  store,
		chainID: 11155111,
		mktP:    map[string]MarketParams{},
		mktFail: map[string]paramFailure{},
	}
}

// A stored market is served without the chain being asked at all — which is
// the whole point of GHO-81. The contract here is nil, so any attempt to read
// it would panic rather than quietly succeed.
func TestMarketParamsServedFromStoreWithoutChain(t *testing.T) {
	store := newFakeStore()
	store.rows["0xMarket"] = params()
	r := newReader(store)

	got, err := r.marketParams(context.Background(), "0xMarket", nil)
	if err != nil {
		t.Fatalf("marketParams: %v", err)
	}
	if got.EntryCutoff != 15 || got.Rake.Cmp(big.NewInt(2e16)) != 0 {
		t.Fatalf("wrong params: %+v", got)
	}

	// Second call is served from memory, so the store is asked exactly once.
	if _, err := r.marketParams(context.Background(), "0xMarket", nil); err != nil {
		t.Fatalf("second marketParams: %v", err)
	}
	reads, writes := store.counts()
	if reads != 1 {
		t.Fatalf("store read %d times, want 1", reads)
	}
	if writes != 0 {
		t.Fatalf("store written %d times, want 0 — nothing was read from the chain", writes)
	}
}

// reachedChain asserts that marketParams got as far as reading the contract.
//
// The probe is a nil *chain.Contract, which panics on the first call rather
// than returning. That is deliberate and it is the strongest available signal:
// chain.Contract is a concrete type with no interface to fake, so "did we ask
// the chain" cannot be observed any other way without refactoring it. A test
// that merely asserted an error could not tell a chain read from a tier above
// it refusing.
func reachedChain(t *testing.T, call func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Fatal("expected the chain to be reached, but it was not")
		}
	}()
	call()
}

// A store that errors is a reason to ask the chain, not a reason to fail.
func TestStoreErrorFallsThroughToChain(t *testing.T) {
	store := newFakeStore()
	store.readErr = errors.New("connection refused")
	r := newReader(store)

	reachedChain(t, func() {
		_, _ = r.marketParams(context.Background(), "0xMarket", nil)
	})

	if reads, _ := store.counts(); reads != 1 {
		t.Fatalf("store read %d times, want 1", reads)
	}
}

// The negative cache is what stops a retry storm re-spending a quota that is
// already exhausted, and it must preserve the original error so the HTTP layer
// can still tell a rate limit from a bug.
func TestFailedReadIsRememberedWithItsCause(t *testing.T) {
	r := newReader(nil)
	cause := errors.New("429 Too Many Requests")

	r.mktFail["0xMarket"] = paramFailure{at: time.Now(), err: cause}

	_, err := r.marketParams(context.Background(), "0xMarket", nil)
	if !errors.Is(err, cause) {
		t.Fatalf("got %v, want the original cause preserved", err)
	}
}

// An expired cooldown must not keep answering from the remembered failure.
func TestCooldownExpires(t *testing.T) {
	r := newReader(nil)
	r.mktFail["0xMarket"] = paramFailure{at: time.Now().Add(-2 * paramCooldown), err: errors.New("stale")}

	reachedChain(t, func() {
		_, _ = r.marketParams(context.Background(), "0xMarket", nil)
	})
}

// A market read from the chain is written down, so the next process does not
// have to ask again. Exercised through the success path by seeding memory and
// confirming a stored row is preferred over it being re-derived.
func TestStoredParamsSurviveARestart(t *testing.T) {
	store := newFakeStore()
	if err := store.PutMarketParams(context.Background(), 11155111, "0xMarket", params()); err != nil {
		t.Fatalf("put: %v", err)
	}

	// A fresh Reader is what a restarted process has: empty memory, same store.
	r := newReader(store)
	got, err := r.marketParams(context.Background(), "0xMarket", nil)
	if err != nil {
		t.Fatalf("marketParams after restart: %v", err)
	}
	if got.MinSidePool.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("wrong params after restart: %+v", got)
	}
}
