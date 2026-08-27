package httpx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httprate"
	"github.com/gorilla/websocket"

	"github.com/wavedidwhat/ghoststake/internal/auth"
	"github.com/wavedidwhat/ghoststake/internal/chain"
	"github.com/wavedidwhat/ghoststake/internal/config"
	"github.com/wavedidwhat/ghoststake/internal/live"
	"github.com/wavedidwhat/ghoststake/internal/protocol"
	"github.com/wavedidwhat/ghoststake/internal/store"
)

type Server struct {
	cfg    config.Config
	store  *store.Store
	chain  *chain.Client
	tokens *auth.TokenIssuer
	http   *http.Server

	// reader is nil when the contract addresses are not configured. The
	// endpoints that need contract state say so rather than guessing.
	reader *protocol.Reader
	// broker is nil when the indexer is off: with nothing writing, there is
	// nothing to push.
	broker   *live.Broker
	upgrader websocket.Upgrader
}

// Deps are the optional collaborators the API is given when they exist.
//
// Passed as a struct rather than as three more positional arguments, because
// two of them are pointers that may legitimately be nil and a call site of
// `NewServer(cfg, st, ch, nil, nil)` says nothing about which nil is which.
type Deps struct {
	Reader *protocol.Reader
	Broker *live.Broker
}

func NewServer(cfg config.Config, st *store.Store, ch *chain.Client, deps Deps) *Server {
	s := &Server{
		cfg:    cfg,
		store:  st,
		chain:  ch,
		tokens: auth.NewTokenIssuer(cfg.JWTSecret, cfg.JWTTTL),
		reader: deps.Reader,
		broker: deps.Broker,
	}

	// The websocket handshake is not subject to CORS — the browser sends no
	// preflight and honours no `Access-Control-Allow-Origin` on it — so the
	// origin check has to happen here, against the same list. Gorilla's
	// default compares against the Host header, which would reject the
	// frontend on :3000 talking to the API on :8080 and accept nothing at all
	// in production.
	s.upgrader = websocket.Upgrader{
		HandshakeTimeout: 10 * time.Second,
		ReadBufferSize:   1024,
		WriteBufferSize:  4096,
		CheckOrigin:      func(r *http.Request) bool { return s.originAllowed(r.Header.Get("Origin")) },
	}

	s.http = &http.Server{
		Addr:    ":" + cfg.HTTPPort,
		Handler: s.routes(),
		// Timeouts are set explicitly: Go's zero value means "no timeout",
		// which lets a slow or idle client hold a connection indefinitely.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	return s
}

func (s *Server) routes() http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(requestLogger)
	r.Use(middleware.Timeout(20 * time.Second))

	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   s.cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	// Liveness: process is up. Must not touch dependencies, or a database
	// blip would make the orchestrator kill an otherwise healthy container.
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Readiness: safe to receive traffic, so this DOES check dependencies.
	r.Get("/readyz", s.handleReady)

	r.Route("/api/v1", func(r chi.Router) {
		r.Route("/auth", func(r chi.Router) {
			// Auth endpoints are rate limited per IP: they are unauthenticated
			// and do elliptic-curve recovery, which is comparatively expensive.
			r.Use(httprate.LimitByIP(20, time.Minute))
			r.Post("/nonce", s.handleNonce)
			r.Post("/verify", s.handleVerify)
		})

		r.Group(func(r chi.Router) {
			r.Use(s.RequireAuth)
			r.Get("/me", s.handleMe)
		})

		// Read endpoints are unauthenticated on purpose: every figure they
		// serve is derived from public chain state, and requiring a login to
		// read a public blockchain would be theatre. They are rate limited
		// because each one costs a database read or an RPC call.
		r.Group(func(r chi.Router) {
			r.Use(httprate.LimitByIP(120, time.Minute))
			r.Get("/rounds", s.handleRounds)
			r.Get("/positions/{address}", s.handlePositions)
			r.Get("/activity/{address}", s.handleActivity)
			r.Get("/health/{address}", s.handleHealth)
		})

		// The websocket is outside the rate limiter: it is one request that
		// then lives for minutes, and counting it per-minute would either
		// throttle a reconnect storm at the wrong moment or do nothing at
		// all. The connection's own limits — read deadline, message size,
		// ping timeout — are what bound it.
		r.Get("/ws", s.handleWS)
	})

	return r
}

// originAllowed matches an Origin header against the configured CORS list.
//
// An empty Origin is allowed: non-browser clients (a `websocat` session, a
// server-side subscriber) send none, and they are not what the same-origin
// policy protects. What it must refuse is a *browser* on an origin we did not
// name, which always sends one.
func (s *Server) originAllowed(origin string) bool {
	if origin == "" {
		return true
	}
	for _, allowed := range s.cfg.CORSOrigins {
		if allowed == "*" || strings.EqualFold(allowed, origin) {
			return true
		}
	}
	return false
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	if err := s.store.Ping(ctx); err != nil {
		slog.Warn("readiness: database unreachable", "err", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "degraded", "database": "unreachable",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "database": "ok"})
}

func (s *Server) Start() error {
	slog.Info("http server listening", "addr", s.http.Addr, "env", s.cfg.Env)
	if err := s.http.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("listen: %w", err)
	}
	return nil
}

func (s *Server) Shutdown(ctx context.Context) error { return s.http.Shutdown(ctx) }
