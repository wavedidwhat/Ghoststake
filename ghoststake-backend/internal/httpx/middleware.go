package httpx

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/wavedidwhat/ghoststake/internal/auth"
)

type ctxKey string

const ctxKeyAddress ctxKey = "address"

// AddressFromContext returns the wallet address attached by RequireAuth.
func AddressFromContext(ctx context.Context) (string, bool) {
	addr, ok := ctx.Value(ctxKeyAddress).(string)
	return addr, ok
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
