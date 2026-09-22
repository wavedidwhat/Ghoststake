package httpx

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/go-chi/chi/v5"

	"forge.wavedidwhat.com/wave/ghoststake/internal/chain"
	"forge.wavedidwhat.com/wave/ghoststake/internal/config"
	"forge.wavedidwhat.com/wave/ghoststake/internal/protocol"
)

// fakeParams is a ParamStore that counts reads.
type fakeParams struct {
	rows  map[string]protocol.MarketParams
	err   error
	reads int
}

func (f *fakeParams) MarketParams(_ context.Context, _ int64, market string) (protocol.MarketParams, bool, error) {
	f.reads++
	if f.err != nil {
		return protocol.MarketParams{}, false, f.err
	}
	p, ok := f.rows[market]
	return p, ok, nil
}

func (f *fakeParams) PutMarketParams(context.Context, int64, string, protocol.MarketParams) error {
	return nil
}

const (
	primaryMarket = "0x00000000000000000000000000000000000000aa"
	otherMarket   = "0x00000000000000000000000000000000000000bb"
)

// noChainServer is a server that booted with contracts configured and no chain
// reachable: the state GHO-88 makes survivable.
func noChainServer(params *fakeParams) *Server {
	cfg := config.Config{ChainID: 421614}
	cfg.Indexer.Enabled = true
	cfg.Indexer.MarketAddresses = []string{primaryMarket, otherMarket}
	return &Server{cfg: cfg, params: params}
}

// The point of booting without a chain: a market read while the chain was up
// can still be rendered while it is down.
func TestMarketParamsComeFromTheStoreWithNoChain(t *testing.T) {
	want := testParams()
	store := &fakeParams{rows: map[string]protocol.MarketParams{
		common.HexToAddress(otherMarket).Hex(): want,
	}}
	s := noChainServer(store)

	// Deliberately lower-case: the store is keyed by checksum, and a
	// mismatched spelling would find nothing while looking correct.
	got, err := s.marketParamsFor(t.Context(), otherMarket)
	if err != nil {
		t.Fatalf("expected the stored params, got %v", err)
	}
	if got.Rake.Cmp(want.Rake) != 0 || got.EntryCutoff != want.EntryCutoff {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// The primary market has no address at the call site; it must resolve to the
// first configured one, not to nothing.
func TestPrimaryMarketParamsComeFromTheStoreWithNoChain(t *testing.T) {
	store := &fakeParams{rows: map[string]protocol.MarketParams{
		common.HexToAddress(primaryMarket).Hex(): testParams(),
	}}
	if _, err := noChainServer(store).marketParams(t.Context()); err != nil {
		t.Fatalf("expected the primary market's stored params, got %v", err)
	}
}

// A market never read while the chain was up has nothing stored, and the
// reason reported is still the chain — so the caller gets "later", not a bug.
func TestUnstoredMarketWithNoChainIsUnavailableNotBroken(t *testing.T) {
	s := noChainServer(&fakeParams{rows: map[string]protocol.MarketParams{}})
	_, err := s.marketParamsFor(t.Context(), otherMarket)
	if !errors.Is(err, errChainUnavailable) {
		t.Fatalf("got %v, want errChainUnavailable", err)
	}

	rec := httptest.NewRecorder()
	serverError(rec, "test", err)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("got %d Retry-After=%q, want 503 with Retry-After", rec.Code, rec.Header().Get("Retry-After"))
	}
}

// With no contracts configured, rows some earlier configuration left behind
// are not this deployment's to render.
func TestNotConfiguredDoesNotReadTheStore(t *testing.T) {
	store := &fakeParams{rows: map[string]protocol.MarketParams{
		common.HexToAddress(primaryMarket).Hex(): testParams(),
	}}
	s := &Server{cfg: config.Config{ChainID: 421614}, params: store}

	if _, err := s.marketParams(t.Context()); !errors.Is(err, errNoChainReader) {
		t.Fatalf("got %v, want errNoChainReader", err)
	}
	if store.reads != 0 {
		t.Fatalf("store read %d times, want 0", store.reads)
	}
	if got := s.chainStatus(); got != "not_configured" {
		t.Fatalf("chainStatus = %q, want not_configured", got)
	}
}

// Endpoints that genuinely need a live read say "later", with Retry-After, and
// the process stays up to say it.
func TestHealthWithNoChainIs503WithRetryAfter(t *testing.T) {
	s := noChainServer(&fakeParams{})
	r := chi.NewRouter()
	r.Get("/health/{address}", s.handleHealth)
	r.Get("/at-risk", s.handleAtRisk)

	for _, path := range []string{"/health/0x00000000000000000000000000000000000000cc", "/at-risk"} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
			t.Fatalf("%s: got %d Retry-After=%q, want 503 with Retry-After", path, rec.Code, rec.Header().Get("Retry-After"))
		}
	}
}

// The chain coming back is picked up without a restart: once a Reader is
// promoted, reads go to it and /readyz stops reporting the chain as down.
func TestPromotingAReaderRecoversWithoutARestart(t *testing.T) {
	s := noChainServer(&fakeParams{})
	if got := s.chainStatus(); got != "unreachable" {
		t.Fatalf("before: chainStatus = %q, want unreachable", got)
	}

	s.SetReader(testReader(t))

	if got := s.chainStatus(); got != "ok" {
		t.Fatalf("after: chainStatus = %q, want ok", got)
	}
	if r, err := s.chainReader(); err != nil || r == nil {
		t.Fatalf("after: chainReader = %v, %v, want the promoted reader", r, err)
	}
}

// testReader builds a real protocol.Reader against an endpoint that only
// answers eth_chainId, which is all binding needs.
func testReader(t *testing.T) *protocol.Reader {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":1,"result":"0x%x"}`, 421614)
	}))
	t.Cleanup(srv.Close)

	ch, err := chain.Dial(t.Context(), srv.URL, 421614)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(ch.Close)
	reader, err := protocol.New(ch, "0x00000000000000000000000000000000000000dd", "0x00000000000000000000000000000000000000ee", []string{primaryMarket})
	if err != nil {
		t.Fatalf("reader: %v", err)
	}
	return reader
}
