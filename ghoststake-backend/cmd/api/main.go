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

	if err := st.Migrate(); err != nil {
		return err
	}
	slog.Info("migrations applied")

	ch, err := chain.Dial(ctx, cfg.RPCURL, cfg.ChainID)
	if err != nil {
		return err
	}
	defer ch.Close()
	slog.Info("chain connected", "chain_id", ch.ChainID(), "rpc", cfg.RPCURL)

	go sweepNonces(ctx, st)

	srv := httpx.NewServer(cfg, st, ch)

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
