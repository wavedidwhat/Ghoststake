package httpx

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"forge.wavedidwhat.com/wave/ghoststake/internal/config"
)

// authLimit is the per-minute budget on /auth, as set in routes().
const authLimit = 20

// nonceFrom sends one malformed nonce request through the real router. The
// body is rejected with 400 before the store is touched, so the only way to
// get anything else back is the rate limiter.
func nonceFrom(h http.Handler, peer string, headers map[string]string) int {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/nonce", strings.NewReader("not json"))
	req.RemoteAddr = peer
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func limiterServer() http.Handler {
	return (&Server{cfg: config.Config{CORSOrigins: []string{"http://localhost:3000"}}}).routes()
}

// The audit finding: chi's RealIP took True-Client-IP ahead of everything and
// Traefik passes it through, so rotating it bought a fresh bucket per request
// and the limit limited nobody.
func TestRotatingTrueClientIPDoesNotEscapeTheLimit(t *testing.T) {
	h := limiterServer()
	const traefik = "10.0.0.2:41000"

	for i := range authLimit {
		code := nonceFrom(h, traefik, map[string]string{
			"True-Client-IP":  fmt.Sprintf("198.51.100.%d", i+1),
			"X-Forwarded-For": "203.0.113.7",
		})
		if code != http.StatusBadRequest {
			t.Fatalf("request %d: got %d, want 400 while inside the limit", i+1, code)
		}
	}

	code := nonceFrom(h, traefik, map[string]string{
		"True-Client-IP":  "198.51.100.250",
		"X-Forwarded-For": "203.0.113.7",
	})
	if code != http.StatusTooManyRequests {
		t.Fatalf("request %d with a fresh True-Client-IP: got %d, want 429", authLimit+1, code)
	}
}

// A client can put anything on the left of X-Forwarded-For; the proxy appends
// the address it actually saw on the right, and that is the one that counts.
func TestForgedLeftXFFEntriesShareTheRealClientsBucket(t *testing.T) {
	h := limiterServer()
	const traefik = "10.0.0.2:41000"

	for i := range authLimit {
		nonceFrom(h, traefik, map[string]string{
			"X-Forwarded-For": fmt.Sprintf("198.51.100.%d, 203.0.113.7", i+1),
		})
	}
	code := nonceFrom(h, traefik, map[string]string{"X-Forwarded-For": "198.51.100.250, 203.0.113.7"})
	if code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429: the forged left entry must not pick the bucket", code)
	}
}

// The other half of a limiter being right: two real clients behind the same
// proxy are two buckets, not one. Keying on the proxy's own address would pass
// the tests above and throttle every user together.
func TestDistinctClientsBehindTheProxyHaveTheirOwnBuckets(t *testing.T) {
	h := limiterServer()
	const traefik = "10.0.0.2:41000"

	for range authLimit {
		nonceFrom(h, traefik, map[string]string{"X-Forwarded-For": "203.0.113.7"})
	}
	if code := nonceFrom(h, traefik, map[string]string{"X-Forwarded-For": "203.0.113.8"}); code != http.StatusBadRequest {
		t.Fatalf("a second client got %d, want 400: it must not share the first client's bucket", code)
	}
}

// With no forwarding header — local dev, an in-network health check — the TCP
// peer is the key. An empty key would lump all of them into one bucket.
func TestWithoutAProxyTheTCPPeerIsTheKey(t *testing.T) {
	h := limiterServer()

	for range authLimit {
		nonceFrom(h, "192.0.2.1:5000", nil)
	}
	if code := nonceFrom(h, "192.0.2.1:5001", nil); code != http.StatusTooManyRequests {
		t.Fatalf("same peer: got %d, want 429", code)
	}
	if code := nonceFrom(h, "192.0.2.2:5000", nil); code != http.StatusBadRequest {
		t.Fatalf("different peer: got %d, want 400", code)
	}
}
