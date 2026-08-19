package httpx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httprate"

	"github.com/wavedidwhat/ghoststake/internal/auth"
	"github.com/wavedidwhat/ghoststake/internal/chain"
	"github.com/wavedidwhat/ghoststake/internal/config"
	"github.com/wavedidwhat/ghoststake/internal/store"
)

type Server struct {
	cfg    config.Config
	store  *store.Store
	chain  *chain.Client
	tokens *auth.TokenIssuer
	http   *http.Server
}

func NewServer(cfg config.Config, st *store.Store, ch *chain.Client) *Server {
	s := &Server{
		cfg:    cfg,
		store:  st,
		chain:  ch,
		tokens: auth.NewTokenIssuer(cfg.JWTSecret, cfg.JWTTTL),
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
	})

	return r
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
