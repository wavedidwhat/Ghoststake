package httpx

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"

	"forge.wavedidwhat.com/wave/ghoststake/internal/auth"
)

type ctxKey string

const ctxKeyAddress ctxKey = "address"

// AddressFromContext returns the wallet address attached by RequireAuth.
func AddressFromContext(ctx context.Context) (string, bool) {
	addr, ok := ctx.Value(ctxKeyAddress).(string)
	return addr, ok
}

// clientIP is the rate limiters' key: the address the trusted proxy saw.
//
// It used to be chi's `RealIP` feeding `httprate.LimitByIP`, and that pair
// limited nobody. `RealIP` copies `True-Client-IP` into `RemoteAddr` ahead of
// every other header, Traefik passes that header through untouched, and
// `LimitByIP` keys on `RemoteAddr` — so a caller who sent a different value on
// each request got a fresh bucket each time. Both are deprecated upstream for
// exactly this (GHSA-9g5q-2w5x-hmxf). The tests passed throughout, because no
// test sent the header.
//
// Now the address comes from `ClientIPFromXFF`, which walks X-Forwarded-For
// from the right past the proxies we name, so only an entry our own proxy
// wrote can become the key. With no header at all — local dev, a test, a
// health check from inside the network — the TCP peer is used, which nobody
// can forge. Never "": an empty key would put every such caller in one
// shared bucket.
func clientIP(r *http.Request) (string, error) {
	if ip := middleware.GetClientIP(r.Context()); ip != "" {
		return httprate.CanonicalizeIP(ip), nil
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return httprate.CanonicalizeIP(host), nil
}

// limitByClient rate-limits per client as clientIP resolves it.
func limitByClient(requests int, window time.Duration) func(http.Handler) http.Handler {
	return httprate.LimitBy(requests, window, clientIP)
}

// requestLogger emits one structured line per request.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

		next.ServeHTTP(ww, r)

		slog.Info("http request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.Status(),
			"bytes", ww.BytesWritten(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", middleware.GetReqID(r.Context()),
		)
	})
}

// RequireAuth rejects requests without a valid bearer token and puts the
// verified wallet address on the request context.
func (s *Server) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		prefix := "Bearer "
		if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}

		claims, err := s.tokens.Parse(strings.TrimSpace(header[len(prefix):]))
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}

		// Re-normalize rather than trusting the casing inside the token.
		addr, err := auth.NormalizeAddress(claims.Address)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}

		ctx := context.WithValue(r.Context(), ctxKeyAddress, addr)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
