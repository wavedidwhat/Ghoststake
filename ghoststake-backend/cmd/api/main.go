// Command api is the GhostStake backend HTTP service.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/chain"
	"github.com/wavedidwhat/ghoststake/internal/config"
	"github.com/wavedidwhat/ghoststake/internal/httpx"
	"github.com/wavedidwhat/ghoststake/internal/indexer"
	"github.com/wavedidwhat/ghoststake/internal/live"
	"github.com/wavedidwhat/ghoststake/internal/protocol"
	"github.com/wavedidwhat/ghoststake/internal/store"
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

	ch, err := chain.Dial(ctx, cfg.RPCURL, cfg.ChainID)
	if err != nil {
		return err
	}
	defer ch.Close()
	slog.Info("chain connected", "chain_id", ch.ChainID(), "rpc", cfg.RPCURL)

	go sweepNonces(ctx, st)

	deps, err := startIndexer(ctx, cfg, st, ch)
	if err != nil {
		return err
	}

	srv := httpx.NewServer(cfg, st, ch, deps)

	errCh := make(chan error, 1)
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
	opts := &slog.HandlerOptions{Level: level}
	if cfg.IsDev() {
		h = slog.NewTextHandler(os.Stdout, opts)
	} else {
		h = slog.NewJSONHandler(os.Stdout, opts)
	}
	slog.SetDefault(slog.New(h))
}

// startIndexer wires the event indexer, the contract reader and the live
// broker, if the contract addresses are configured.
//
// It runs in-process rather than as a second binary. One deployable, one
// database connection pool, one set of migrations — and the indexer is a
// polling loop with no inbound surface, so it costs the API nothing to
// carry. Splitting it out is a scaling decision to take when there is
// something to scale.
//
// The broker is created only when the indexer runs, because it is the
// indexer that publishes to it: a websocket subscribed to a broker nothing
// writes to would connect, send its opening snapshot, and then sit silent
// forever, which looks exactly like a working connection.
func startIndexer(ctx context.Context, cfg config.Config, st *store.Store, ch *chain.Client) (httpx.Deps, error) {
	if !cfg.Indexer.Enabled {
		slog.Info("indexer disabled", "hint", "set INDEXER_ENABLED=true once contracts are deployed")
		return httpx.Deps{}, nil
	}

	reader, err := protocol.New(ch, cfg.Indexer.VaultAddress, cfg.Indexer.PoolAddress, cfg.Indexer.MarketAddresses)
	if err != nil {
		return httpx.Deps{}, err
	}
	broker := live.NewBroker()

	ix, err := indexer.New(ch, st, indexer.Config{
		ChainID:         cfg.ChainID,
		VaultAddress:    cfg.Indexer.VaultAddress,
		PoolAddress:     cfg.Indexer.PoolAddress,
		MarketAddresses: cfg.Indexer.MarketAddresses,
		StartBlock:      cfg.Indexer.StartBlock,
		Confirmations:   cfg.Indexer.Confirmations,
		BatchSize:       cfg.Indexer.BatchSize,
		PollInterval:    cfg.Indexer.PollInterval,
		Publisher:       broker,
	})
	if err != nil {
		return httpx.Deps{}, err
	}

	// Synchronously, before the loop starts: a cursor built from a different
	// contract set is a configuration error, and the API refusing to boot is
	// how config errors are reported here. Backgrounding it would leave the
	// API serving empty rounds and positions as if they were the answer.
	if err := ix.Preflight(ctx); err != nil {
		return httpx.Deps{}, err
	}

	go func() {
		if err := ix.Run(ctx); err != nil {
			slog.Error("indexer stopped", "err", err)
		}
	}()
	return httpx.Deps{Reader: reader, Broker: broker}, nil
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
