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
	"math/big"
	"os"
	"os/signal"
	"syscall"

	"forge.wavedidwhat.com/wave/ghoststake/internal/chain"
	"forge.wavedidwhat.com/wave/ghoststake/internal/config"
	"forge.wavedidwhat.com/wave/ghoststake/internal/keeper"
	"forge.wavedidwhat.com/wave/ghoststake/internal/redact"
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

	// Startup reads retry rather than exit: a provider rate limit is transient,
	// but a keeper that treats it as fatal is restarted straight back into the
	// same limit, turning a passing 429 into a crash loop (Part 7.61). A wrong
	// chain ID still fails on the first attempt.
	//
	// Fatal once the retries run out, and on a 402 at once. That is the
	// opposite of the API, which boots without a chain (GHO-88), and it is
	// deliberate: the API serves an index that lives in Postgres, while the
	// keeper exists only to send transactions. A keeper with no chain has
	// nothing to do, and staying up would make a stopped keeper look like a
	// running one. Exiting puts it in front of whoever watches restarts.
	client, err := chain.DialWithRetry(ctx, cfg.RPCURL, cfg.ChainID, chain.DefaultBackoff)
	if err != nil {
		return err
	}
	defer client.Close()

	signer, err := chain.NewSigner(client, cfg.PrivateKey)
	if err != nil {
		return err
	}
	var balance *big.Int
	if err := chain.Retry(ctx, "keeper balance", chain.DefaultBackoff, func(ctx context.Context) error {
		var err error
		balance, err = signer.Balance(ctx)
		return err
	}); err != nil {
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
	var markets []*keeper.Market
	if err := chain.Retry(ctx, "read market registry", chain.DefaultBackoff, func(ctx context.Context) error {
		var err error
		markets, err = source.Markets(ctx)
		return err
	}); err != nil {
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
			"feed_heartbeat", m.HeartbeatLabel(),
			// Which shape of `openRound` this deployment takes (GHO-79), so
			// "why does that market not state its question" is answerable
			// from the boot log rather than from the bytecode.
			"strike_at_open", m.StrikeAtOpen)
	}

	k, err := keeper.New(client, signer, source, markets, keeper.Config{
		PollInterval:         cfg.PollInterval,
		OpenRounds:           cfg.OpenRounds,
		Lead:                 cfg.Lead,
		EntryWindow:          cfg.EntryWindow,
		Horizon:              cfg.Horizon,
		MaxUncalendaredRound: cfg.MaxUncalendaredRound,
		RefreshInterval:      cfg.RefreshInterval,
		GasCheckInterval:     cfg.GasCheckInterval,
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
	// The RPC URL carries the provider key, and transport errors quote it in
	// full (a failed startup read logs "fatal" with that error).
	opts := &slog.HandlerOptions{Level: level, ReplaceAttr: redact.ReplaceAttr(redact.Secrets(cfg.RPCURL))}
	var h slog.Handler = slog.NewJSONHandler(os.Stdout, opts)
	if cfg.IsDev() {
		h = slog.NewTextHandler(os.Stdout, opts)
	}
	slog.SetDefault(slog.New(h))
}
