// Command keeper drives round phase transitions (GHO-24).
//
// A timer that calls `openRound`, `lockRound` and `resolveRound` when a round
// needs them. It is a separate binary from the API on purpose: it is the only
// process in the Go layer that holds a private key, and the API and indexer
// stay strictly read-only because they are not this.
//
// It needs no database. Everything it decides comes from the chain, which
// means it can be restarted, moved or run twice without any state to
// reconcile — a second instance simply loses the races and logs that the
// round was already locked.
//
// Chainlink Automation is the production answer to this problem. This exists
// because the protocol is built so that a keeper outage costs liveness and
// not safety — `lockRound` and `resolveRound` are permissionless, and the
// operator console (GHO-28) lets any user advance their own round — and
// demonstrating that is worth more than outsourcing it.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/wavedidwhat/ghoststake/internal/chain"
	"github.com/wavedidwhat/ghoststake/internal/config"
	"github.com/wavedidwhat/ghoststake/internal/keeper"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.LoadKeeper()
	if err != nil {
		return err
	}
	setupKeeperLogger(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client, err := chain.Dial(ctx, cfg.RPCURL, cfg.ChainID)
	if err != nil {
		return err
	}
	defer client.Close()

	signer, err := chain.NewSigner(client, cfg.PrivateKey)
	if err != nil {
		return err
	}
	balance, err := signer.Balance(ctx)
	if err != nil {
		return err
	}
	slog.Info("keeper wallet",
		"chain_id", client.ChainID(),
		"address", signer.Address().Hex(),
		"balance_wei", balance.String())

	// Built once even when no market turns out to need it. A calendar that
	// failed to load is a configuration problem, and finding out at the first
	// stock-feed round — hours later, at the moment gating matters — is the
	// worst time to find out.
	nyse, err := keeper.NYSESession()
	if err != nil {
		return err
	}

	// The source, rather than a one-off read. GHO-34 made listing a market a
	// transaction; reading the registry once at boot meant it was a
	// transaction and a restart, and the restart is the half that gets
	// forgotten. See Keeper.refreshMarkets.
	source := keeper.NewSource(client, cfg.RegistryAddress, cfg.MarketAddresses, nyse, cfg.StatusFeeds)
	markets, err := source.Markets(ctx)
	if err != nil {
		return err
	}
	for _, m := range markets {
		slog.Info("driving market",
			"market", m.String(),
			"horizon_s", m.Horizon,
			"entry_cutoff_s", m.Timing.EntryCutoff,
			"lock_window_s", m.Timing.LockWindow,
			"resolve_deadline_s", m.Timing.ResolveDeadline,
			"session", m.SessionLabel(),
			"feed_heartbeat", m.HeartbeatLabel())
	}

	k, err := keeper.New(client, signer, source, markets, keeper.Config{
		PollInterval:         cfg.PollInterval,
		OpenRounds:           cfg.OpenRounds,
		Lead:                 cfg.Lead,
		EntryWindow:          cfg.EntryWindow,
		Horizon:              cfg.Horizon,
		MaxUncalendaredRound: cfg.MaxUncalendaredRound,
		RefreshInterval:      cfg.RefreshInterval,
		MinGasBalance:        cfg.MinGasBalanceWei,
	})
	if err != nil {
		return err
	}
	return k.Run(ctx)
}

func setupKeeperLogger(cfg config.KeeperConfig) {
	level := slog.LevelInfo
	if cfg.IsDev() {
		level = slog.LevelDebug
	}
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler = slog.NewJSONHandler(os.Stdout, opts)
	if cfg.IsDev() {
		h = slog.NewTextHandler(os.Stdout, opts)
	}
	slog.SetDefault(slog.New(h))
}
