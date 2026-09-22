package httpx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httprate"
	"github.com/gorilla/websocket"

	"forge.wavedidwhat.com/wave/ghoststake/internal/auth"
	"forge.wavedidwhat.com/wave/ghoststake/internal/config"
	"forge.wavedidwhat.com/wave/ghoststake/internal/live"
	"forge.wavedidwhat.com/wave/ghoststake/internal/protocol"
	"forge.wavedidwhat.com/wave/ghoststake/internal/store"
)

type Server struct {
	cfg    config.Config
	store  *store.Store
	tokens *auth.TokenIssuer
	http   *http.Server

	// deployment identifies which contracts this process serves (GHO-51).
	// Computed once at construction: every balance read has to be scoped to
	// it, and recomputing per request is a chance for two requests to disagree
	// about which deployment they are describing.
	deployment []string
	// reader is nil when the contract addresses are not configured, and also
	// while the chain is unreachable (GHO-88): the process boots and serves
	// indexed data without one, and main promotes a Reader in with SetReader
	// once a dial succeeds. Atomic because that promotion happens while
	// requests are in flight.
	reader atomic.Pointer[protocol.Reader]
	// params is where market immutables are persisted (GHO-81), consulted
	// directly while there is no Reader. Without it a process with no chain
	// would 503 every round even though the three numbers needed to render
	// one are sitting in Postgres.
	params protocol.ParamStore
	// broker is nil when the indexer is off: with nothing writing, there is
	// nothing to push.
	broker   *live.Broker
	upgrader websocket.Upgrader
}

// deploymentContracts is the address set every ledger read is scoped to.
//
// Checksummed the same way the indexer writes them, because these are compared
// against `contract_address` with `= ANY(...)` and a differently-cased spelling
// of the same contract matches nothing while looking entirely correct — which
// would empty the at-risk list rather than erroring.
func deploymentContracts(cfg config.Config) []string {
	raw := append([]string{cfg.Indexer.VaultAddress, cfg.Indexer.PoolAddress},
		cfg.Indexer.MarketAddresses...)

	out := make([]string, 0, len(raw))
	for _, a := range raw {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, common.HexToAddress(a).Hex())
		}
	}
	return out
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

func NewServer(cfg config.Config, st *store.Store, deps Deps) *Server {
	s := &Server{
		cfg:        cfg,
		store:      st,
		tokens:     auth.NewTokenIssuer(cfg.JWTSecret, cfg.JWTTTL),
		broker:     deps.Broker,
		deployment: deploymentContracts(cfg),
	}
	if st != nil {
		s.params = st
	}
	if deps.Reader != nil {
		s.reader.Store(deps.Reader)
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
			// Before the /{address} route above in intent though not in
			// registration: chi matches literal segments ahead of wildcards,
			// so "at-risk" cannot be swallowed as an address.
			r.Get("/positions/at-risk", s.handleAtRisk)
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

// SetReader promotes a Reader in once the chain is reachable (GHO-88).
func (s *Server) SetReader(r *protocol.Reader) { s.reader.Store(r) }

// chainReader returns the Reader, or the reason there is not one.
//
// Two reasons, kept apart because they call for different things from whoever
// is looking: "not configured" is a deployment that was never given contract
// addresses and will not change by waiting; "unavailable" is a configured
// chain the process cannot currently reach, which will.
func (s *Server) chainReader() (*protocol.Reader, error) {
	if r := s.reader.Load(); r != nil {
		return r, nil
	}
	if !s.cfg.Indexer.Enabled {
		return nil, errNoChainReader
	}
	return nil, errChainUnavailable
}

// chainStatus is /readyz's word for the chain.
func (s *Server) chainStatus() string {
	switch _, err := s.chainReader(); {
	case err == nil:
		return "ok"
	case errors.Is(err, errNoChainReader):
		return "not_configured"
	default:
		return "unreachable"
	}
}

// handleReady reports the database and the chain, and fails only on the
// database.
//
// The asymmetry is the point of GHO-88. Nearly everything this API serves comes
// out of Postgres, so a process with a database and no chain is still the best
// thing available to route a request to — and if readiness failed on the chain,
// an orchestrator would pull every replica out of rotation during exactly the
// provider outage the process was built to ride out. The chain is reported so a
// human can see it; "status" says "degraded" so nothing mistakes it for fine.
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	chainState := s.chainStatus()
	if err := s.store.Ping(ctx); err != nil {
		slog.Warn("readiness: database unreachable", "err", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "degraded", "database": "unreachable", "chain": chainState,
		})
		return
	}
	status := "ok"
	if chainState == "unreachable" {
		status = "degraded"
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status, "database": "ok", "chain": chainState})
}

func (s *Server) Start() error {
	slog.Info("http server listening", "addr", s.http.Addr, "env", s.cfg.Env)
	if err := s.http.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("listen: %w", err)
	}
	return nil
}

func (s *Server) Shutdown(ctx context.Context) error { return s.http.Shutdown(ctx) }
