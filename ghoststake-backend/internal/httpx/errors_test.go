package httpx

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A provider rate-limiting us is not a bug in this code, and a 500 says it is.
// It also invites an immediate retry, which is what kept the Infura limit
// exhausted on 2026-09-19 (runbook Part 7.71).
func TestServerErrorReportsATransientUpstreamAs503(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"rate limited", errors.New("chain: call ParimutuelRound.entryCutoff: 429 Too Many Requests"), http.StatusServiceUnavailable},
		{"quota exceeded", errors.New("quota exceeded"), http.StatusServiceUnavailable},
		{"connection refused", errors.New("dial tcp: connection refused"), http.StatusServiceUnavailable},
		{"no chain reader", errNoChainReader, http.StatusServiceUnavailable},
		{"a real bug", errors.New("entryCutoff returned string"), http.StatusInternalServerError},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			serverError(rec, "read market params", c.err)

			if rec.Code != c.want {
				t.Fatalf("status %d, want %d", rec.Code, c.want)
			}

			// The detail stays in the log. An error string from an RPC call
			// names internal hosts, and a read endpoint is where someone
			// probing would look for them.
			var body struct {
				Error string `json:"error"`
			}
			if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if body.Error == c.err.Error() {
				t.Fatalf("the upstream error was echoed to the client: %q", body.Error)
			}

			// Retry-After only where retrying is the right advice.
			retryAfter := rec.Header().Get("Retry-After")
			wantRetryAfter := c.want == http.StatusServiceUnavailable && !errors.Is(c.err, errNoChainReader)
			if wantRetryAfter && retryAfter == "" {
				t.Fatal("a temporarily unreachable chain should say when to come back")
			}
			if !wantRetryAfter && retryAfter != "" {
				t.Fatalf("Retry-After set to %q where retrying is not the advice", retryAfter)
			}
		})
	}
}
