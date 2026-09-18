package chain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// fastBackoff keeps the tests in milliseconds while exercising the real
// growth, ceiling and jitter.
var fastBackoff = Backoff{Base: time.Millisecond, Max: 5 * time.Millisecond, Factor: 2, Jitter: 0.2, Limit: 2 * time.Second}

// rpcServer answers eth_chainId with chainID, after rejecting the first
// rejects requests the way a rate-limited provider does.
func rpcServer(t *testing.T, rejects int, status int, chainID int64) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if int(calls.Add(1)) <= rejects {
			http.Error(w, "Too Many Requests", status)
			return
		}
		var req struct {
			ID json.RawMessage `json:"id"`
		}
		body, _ := io.ReadAll(r.Body)
		if json.Unmarshal(body, &req) != nil || len(req.ID) == 0 {
			req.ID = json.RawMessage("1")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":"0x%x"}`, req.ID, chainID)
	}))
	t.Cleanup(s.Close)
	return s, &calls
}

func TestDialWithRetrySurvivesRateLimit(t *testing.T) {
	srv, calls := rpcServer(t, 3, http.StatusTooManyRequests, ChainIDArbitrumSepolia)

	c, err := DialWithRetry(t.Context(), srv.URL, ChainIDArbitrumSepolia, fastBackoff)
	if err != nil {
		t.Fatalf("expected the dial to survive 3 rate limits, got %v", err)
	}
	defer c.Close()
	if got := calls.Load(); got != 4 {
		t.Fatalf("expected 4 attempts (3 rejected, 1 served), got %d", got)
	}
}

// The regression from Part 7.61: 429 at startup crash-looped the keeper.
// A 503 from a provider's proxy has to behave the same way.
func TestDialWithRetrySurvivesServerError(t *testing.T) {
	srv, _ := rpcServer(t, 2, http.StatusServiceUnavailable, ChainIDArbitrumSepolia)
	c, err := DialWithRetry(t.Context(), srv.URL, ChainIDArbitrumSepolia, fastBackoff)
	if err != nil {
		t.Fatalf("expected the dial to survive 5xx, got %v", err)
	}
	c.Close()
}

// The check that must not be retried away: pointing at the wrong network is a
// standing misconfiguration, and waiting only delays the report.
func TestWrongChainIDFailsImmediately(t *testing.T) {
	srv, calls := rpcServer(t, 0, 0, ChainIDArbitrumOne)

	start := time.Now()
	_, err := DialWithRetry(t.Context(), srv.URL, ChainIDArbitrumSepolia, fastBackoff)
	if err == nil {
		t.Fatal("expected a chain id mismatch to fail")
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("expected exactly 1 attempt, got %d", got)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("mismatch took %s: it was retried", time.Since(start))
	}
}

// A provider that never recovers must still end the process rather than hang
// forever pretending to start.
func TestRetryGivesUpAtLimit(t *testing.T) {
	srv, calls := rpcServer(t, 1000, http.StatusTooManyRequests, ChainIDArbitrumSepolia)

	b := fastBackoff
	b.Limit = 50 * time.Millisecond
	start := time.Now()
	_, err := DialWithRetry(t.Context(), srv.URL, ChainIDArbitrumSepolia, b)
	if err == nil {
		t.Fatal("expected failure once the limit passed")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("took %s, expected to give up near the 50ms limit", elapsed)
	}
	if calls.Load() < 2 {
		t.Fatalf("expected at least one retry before giving up, got %d attempts", calls.Load())
	}
}

func TestRetryStopsOnShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()

	err := Retry(ctx, "test", fastBackoff, func(context.Context) error { return syscall.ECONNREFUSED })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected the shutdown to stop retries, got %v", err)
	}
}

func TestTransientClassification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"connection refused", fmt.Errorf("fetch chain id: %w", syscall.ECONNREFUSED), true},
		{"connection reset", syscall.ECONNRESET, true},
		{"deadline", fmt.Errorf("head: %w", context.DeadlineExceeded), true},
		{"eof", io.EOF, true},
		{"429 text", errors.New("429 Too Many Requests: Too Many Requests"), true},
		{"provider rate limit text", errors.New("daily request limit exceeded"), true},
		{"dns", errors.New(`Post "https://x": dial tcp: lookup x: no such host`), true},
		{"chain id mismatch", errors.New("chain id mismatch: rpc reports 42161, config expects 421614"), false},
		{"shutdown", context.Canceled, false},
		{"bad key", errors.New("invalid private key"), false},
		{"execution revert", errors.New("execution reverted: gas limit exceeded for this call"), false},
		{"nil", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Transient(c.err); got != c.want {
				t.Fatalf("Transient(%v) = %v, want %v", c.err, got, c.want)
			}
		})
	}
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	b := Backoff{Base: time.Second, Max: 8 * time.Second, Factor: 2}
	for attempt, want := range map[int]time.Duration{0: time.Second, 1: 2 * time.Second, 2: 4 * time.Second, 3: 8 * time.Second, 9: 8 * time.Second} {
		if got := b.wait(attempt); got != want {
			t.Errorf("wait(%d) = %s, want %s", attempt, got, want)
		}
	}
	jittered := Backoff{Base: time.Second, Max: time.Second, Factor: 2, Jitter: 0.2}
	for range 20 {
		d := jittered.wait(0)
		if d < 800*time.Millisecond || d > 1200*time.Millisecond {
			t.Fatalf("jittered wait %s outside ±20%%", d)
		}
	}
}
