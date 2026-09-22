// Command api is the GhostStake backend HTTP service.
package main

import (
	"context"
	"errors"
	"log/slog"
	"math/big"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/core/types"

	"forge.wavedidwhat.com/wave/ghoststake/internal/chain"
	"forge.wavedidwhat.com/wave/ghoststake/internal/config"
	"forge.wavedidwhat.com/wave/ghoststake/internal/httpx"
	"forge.wavedidwhat.com/wave/ghoststake/internal/indexer"
	"forge.wavedidwhat.com/wave/ghoststake/internal/live"
	"forge.wavedidwhat.com/wave/ghoststake/internal/protocol"
	"forge.wavedidwhat.com/wave/ghoststake/internal/redact"
	"forge.wavedidwhat.com/wave/ghoststake/internal/store"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	setupLogger(cfg)

	// Signal-aware root context: Ctrl-C or a container SIGTERM cancels it,
	// which is what starts the graceful shutdown below.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := st.Migrate(cfg.AllowSchemaAhead); err != nil {
		return err
	}

	go sweepNonces(ctx, st)

	// Buffered for both writers: the listener, and the chain connector, which
	// reports a configuration error it discovers after boot.
	errCh := make(chan error, 2)

	deps, attach, err := prepareIndexer(ctx, cfg, st)
	if err != nil {
		return err
	}
	srv := httpx.NewServer(cfg, st, deps)

	// Before listening, so a healthy chain is attached before the first
	// request and a wrong CHAIN_ID refuses to boot rather than half-starting.
	// Skipped entirely with no contracts configured: nothing would read it.
	if attach != nil {
		closeChain, err := connectChain(ctx, cfg, func(ch *chain.Client) error { return attach(ch, srv) }, errCh)
		if err != nil {
			return err
		}
		defer closeChain()
	}

	go func() { errCh <- srv.Start() }()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("shutdown signal received")
	}

	// Drain in-flight requests before exiting rather than cutting them off.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	slog.Info("shutdown complete")
	return nil
}

func setupLogger(cfg config.Config) {
	level := slog.LevelInfo
	if cfg.IsDev() {
		level = slog.LevelDebug
	}
	// JSON in production so log aggregators can parse it; text locally so it
	// stays readable in a terminal.
	var h slog.Handler
	// The RPC URL carries the provider key, and transport errors quote it in
	// full, so every line is scrubbed rather than trusting each call site.
	opts := &slog.HandlerOptions{Level: level, ReplaceAttr: redact.ReplaceAttr(redact.Secrets(cfg.RPCURL))}
	if cfg.IsDev() {
		h = slog.NewTextHandler(os.Stdout, opts)
	} else {
		h = slog.NewJSONHandler(os.Stdout, opts)
	}
	slog.SetDefault(slog.New(h))
}

// prepareIndexer builds the event indexer and the live broker, if the contract
// addresses are configured, and returns the function that brings them to life
// once there is a chain to read.
//
// It runs in-process rather than as a second binary. One deployable, one
// database connection pool, one set of migrations — and the indexer is a
// polling loop with no inbound surface, so it costs the API nothing to
// carry. Splitting it out is a scaling decision to take when there is
// something to scale.
//
// Split in two (GHO-88) because the two halves fail differently. Everything
// here reads configuration and the database, and a failure is a
// misconfiguration the API should refuse to boot over. Everything in the
// returned attach needs the chain, which may not be reachable yet and is not a
// reason to stop serving what is already indexed.
//
// The broker is created only when the indexer is configured, because it is
// the indexer that publishes to it. It exists before the chain does, so a
// websocket opened during an outage gets its opening snapshot from the
// database and then hears nothing until the indexer starts — the same as a
// quiet chain, and correct as soon as it is not.
func prepareIndexer(ctx context.Context, cfg config.Config, st *store.Store) (httpx.Deps, func(*chain.Client, *httpx.Server) error, error) {
	if !cfg.Indexer.Enabled {
		slog.Info("indexer disabled", "hint", "set INDEXER_ENABLED=true once contracts are deployed")
		return httpx.Deps{}, nil, nil
	}

	broker := live.NewBroker()
	gate := &chainGate{}
	ix, err := indexer.New(gate, st, indexer.Config{
		ChainID:           cfg.ChainID,
		VaultAddress:      cfg.Indexer.VaultAddress,
		PoolAddress:       cfg.Indexer.PoolAddress,
		MarketAddresses:   cfg.Indexer.MarketAddresses,
		StartBlock:        cfg.Indexer.StartBlock,
		Confirmations:     cfg.Indexer.Confirmations,
		SkipDecoderReplay: cfg.Indexer.SkipDecoderReplay,
		BatchSize:         cfg.Indexer.BatchSize,
		PollInterval:      cfg.Indexer.PollInterval,
		Publisher:         broker,
	})
	if err != nil {
		return httpx.Deps{}, nil, err
	}

	// Synchronously, before anything serves: a cursor built from a different
	// contract set is a configuration error, and the API refusing to boot is
	// how config errors are reported here. Backgrounding it would leave the
	// API serving empty rounds and positions as if they were the answer.
	// Preflight reads only the database, which is why it can run before the
	// chain is reachable.
	if err := ix.Preflight(ctx); err != nil {
		return httpx.Deps{}, nil, err
	}

	attach := func(ch *chain.Client, srv *httpx.Server) error {
		reader, err := protocol.New(ch, cfg.Indexer.VaultAddress, cfg.Indexer.PoolAddress, cfg.Indexer.MarketAddresses)
		if err != nil {
			return err
		}
		// Market immutables get somewhere durable to live (GHO-81), so a
		// restart does not re-ask the chain three questions per market whose
		// answers are fixed at construction and cannot change.
		srv.SetReader(reader.WithParamStore(cfg.ChainID, st))

		gate.set(ch)
		go func() {
			if err := ix.Run(ctx); err != nil {
				slog.Error("indexer stopped", "err", err)
			}
		}()
		return nil
	}
	return httpx.Deps{Broker: broker}, attach, nil
}

// connectChain dials once, and if that fails for any reason but the wrong
// chain, keeps dialling in the background while the API serves without it.
//
// This is the API's half of GHO-88. Before it, a failed dial was fatal, and on
// 2026-09-19 Infura's 402 Payment Required crash-looped the API for as long as
// nobody changed RPC_URL — while every round, position and activity row it
// serves sat in Postgres, readable. The API can do almost all of its job with
// no chain, so it no longer refuses to start without one.
//
// The keeper deliberately does the opposite; see cmd/keeper.
//
// A chain ID mismatch is still fatal, found at boot or later: serving another
// network's contract reads beside this network's ledger is worse than serving
// none.
func connectChain(ctx context.Context, cfg config.Config, attach func(*chain.Client) error, errCh chan<- error) (func(), error) {
	var client atomic.Pointer[chain.Client]
	closeChain := func() {
		if c := client.Load(); c != nil {
			c.Close()
		}
	}
	connected := func(ch *chain.Client) error {
		client.Store(ch)
		slog.Info("chain connected", "chain_id", ch.ChainID(), "rpc", redact.Host(cfg.RPCURL))
		return attach(ch)
	}

	// One bounded attempt, so a healthy chain is attached before the first
	// request and a slow endpoint cannot hold the boot.
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	ch, err := chain.Dial(dialCtx, cfg.RPCURL, cfg.ChainID)
	cancel()
	switch {
	case err == nil:
		return closeChain, connected(ch)
	case errors.Is(err, chain.ErrChainIDMismatch):
		return closeChain, err
	}

	slog.Error("chain unreachable at boot; serving indexed data without it",
		"err", err, "rpc", redact.Host(cfg.RPCURL),
		"hint", "chain-backed endpoints answer 503 until a redial succeeds; /readyz reports chain=unreachable")

	go func() {
		ch, err := chain.DialPersistently(ctx, cfg.RPCURL, cfg.ChainID, chain.DefaultBackoff)
		if err != nil {
			if ctx.Err() == nil {
				errCh <- err
			}
			return
		}
		if err := connected(ch); err != nil {
			errCh <- err
		}
	}()
	return closeChain, nil
}

// chainGate is the indexer's chain until there is one.
//
// The indexer is built at boot so its Preflight can refuse a misconfigured
// database before anything serves, and it takes its client at construction.
// This lets it be built before the dial succeeds. Run is only started once the
// gate is set, so the unset branch is a guard, not a path.
type chainGate struct{ c atomic.Pointer[chain.Client] }

var errNotConnected = errors.New("chain not connected yet")

func (g *chainGate) set(c *chain.Client) { g.c.Store(c) }

func (g *chainGate) BlockNumber(ctx context.Context) (uint64, error) {
	if c := g.c.Load(); c != nil {
		return c.BlockNumber(ctx)
	}
	return 0, errNotConnected
}

func (g *chainGate) FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error) {
	if c := g.c.Load(); c != nil {
		return c.FilterLogs(ctx, q)
	}
	return nil, errNotConnected
}

func (g *chainGate) HeaderByNumber(ctx context.Context, n *big.Int) (*types.Header, error) {
	if c := g.c.Load(); c != nil {
		return c.HeaderByNumber(ctx, n)
	}
	return nil, errNotConnected
}

// sweepNonces periodically clears spent and expired login challenges so the
// table does not grow without bound.
func sweepNonces(ctx context.Context, st *store.Store) {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			n, err := st.DeleteExpiredNonces(ctx)
			if err != nil {
				slog.Warn("nonce sweep failed", "err", err)
				continue
			}
			if n > 0 {
				slog.Debug("nonce sweep", "deleted", n)
			}
		}
	}
}
