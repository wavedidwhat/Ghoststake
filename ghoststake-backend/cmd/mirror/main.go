// Command mirror republishes a real Chainlink feed from one chain onto a
// GhostStake-operated feed on another (GHO-21).
//
// Robinhood Chain has Chainlink feeds for tokenized equities — RHTSLA, RHNVDA,
// RHAMZN, RHSPY — and they are the reason to deploy there rather than anywhere
// else. Verified on 2026-09-25: they exist on **mainnet only**. The testnet has
// no Chainlink feeds at all, just other teams' mocks.
//
// Reaching a real feed by putting unaudited lending contracts on mainnet is not
// a trade worth making, so the price crosses instead of the contracts.
//
// A separate binary from the keeper, though both hold a key and both write on a
// timer. The keeper settles rounds and the mirror feeds them, so a mirror that
// crashed inside the keeper would stop rounds settling as well as stop the
// price moving — and the reverse, a keeper restart, would drop the feed. They
// fail apart on purpose.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"forge.wavedidwhat.com/wave/ghoststake/internal/chain"
	"forge.wavedidwhat.com/wave/ghoststake/internal/config"
	"forge.wavedidwhat.com/wave/ghoststake/internal/mirror"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.LoadMirror()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Same retrying dial as the keeper: a provider rate limit at startup is
	// transient, and a process that treats it as fatal is restarted straight
	// back into it. A wrong chain id still fails on the first attempt, which
	// matters more here than anywhere — mirroring from the wrong chain would
	// publish a real, plausible, completely unrelated price.
	source, err := chain.DialWithRetry(ctx, cfg.SourceRPCURL, cfg.SourceChainID, chain.DefaultBackoff)
	if err != nil {
		return err
	}
	dest, err := chain.DialWithRetry(ctx, cfg.DestRPCURL, cfg.DestChainID, chain.DefaultBackoff)
	if err != nil {
		return err
	}

	signer, err := chain.NewSigner(dest, cfg.PrivateKey)
	if err != nil {
		return err
	}

	pairs := make([]mirror.Pair, 0, len(cfg.Pairs))
	for _, p := range cfg.Pairs {
		pairs = append(pairs, mirror.Pair{Source: p.Source, Dest: p.Dest})
	}

	m, err := mirror.New(ctx, source, dest, signer, mirror.Config{
		Pairs:        pairs,
		PollInterval: cfg.PollInterval,
	})
	if err != nil {
		return err
	}

	slog.Info("mirror started",
		"from_chain", cfg.SourceChainID, "to_chain", cfg.DestChainID,
		"publisher", signer.Address().Hex(), "pairs", len(pairs), "poll", cfg.PollInterval)

	if err := m.Run(ctx); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}
