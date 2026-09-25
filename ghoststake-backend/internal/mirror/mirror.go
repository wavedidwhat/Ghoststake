// Package mirror republishes a real price feed from one chain onto a
// GhostStake-operated feed on another (GHO-21).
//
// # Why this exists
//
// Robinhood Chain is the deployment target because it is the only chain where
// tokenized equities have Chainlink feeds — betting on RHTSLA is a market that
// only makes sense there. Verified on 2026-09-25, those feeds are **mainnet
// only**: `feeds-robinhood-mainnet.json` lists 58 of them, there is no testnet
// directory, and every Chainlink-named contract on testnet is another team's
// mock, none of which even returns a decodable `latestRoundData`.
//
// Deploying unaudited lending contracts to mainnet to reach a price feed is
// not a trade anyone should make. So the price crosses instead: this reads the
// genuine mainnet feed and republishes each answer onto a `DemoPriceFeed` on
// testnet, carrying the mainnet publication timestamp with it.
//
// # What it does and does not claim
//
// The number is really Robinhood's tokenized equity price, read from the real
// Chainlink aggregator at its real address. The *transport* is us, and that is
// the part a user has to see: nothing here is secured by Chainlink once it
// lands on testnet, because a GhostStake key signs the push.
//
// So the destination is a `DemoPriceFeed` and nothing else. Its description
// carries "GHOSTSTAKE DEMO FEED (operator-set price)", which is the exact
// string the app matches to show its unmissable badge. A mirror that
// presented itself as a first-class feed would be the dishonest version of
// this, and it would be one constructor argument away.
package mirror

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"forge.wavedidwhat.com/wave/ghoststake/internal/abis"
	"forge.wavedidwhat.com/wave/ghoststake/internal/chain"
)

// demoMarker is the substring the app matches to badge a feed as
// operator-set. Asserted against the destination at startup: the honesty of
// this whole arrangement rests on the badge appearing, and the badge is driven
// by a string.
const demoMarker = "GHOSTSTAKE DEMO FEED"

// Pair is one feed mirrored onto another.
type Pair struct {
	// Source is the real aggregator on the source chain.
	Source common.Address
	// Dest is the DemoPriceFeed this process owns on the destination chain.
	Dest common.Address
}

// Reading is one answer taken from a source feed.
type Reading struct {
	Answer    *big.Int
	UpdatedAt uint64
}

// Config is what a Mirror needs beyond its clients.
type Config struct {
	Pairs        []Pair
	PollInterval time.Duration
}

// Mirror copies answers from source feeds onto destination feeds.
type Mirror struct {
	source *chain.Client
	dest   *chain.Client
	signer *chain.Signer
	cfg    Config

	// feeds holds the bound contracts per pair, resolved once at startup.
	feeds []boundPair
}

type boundPair struct {
	Pair
	src   *chain.Contract
	dst   *chain.Contract
	label string
	// lastPushed is the newest source timestamp this process has written, so a
	// destination read is not needed on every tick. Zero until the first push,
	// and re-derived from the chain at startup.
	lastPushed uint64
}

// New binds every pair and asserts the two ends agree.
//
// Every check here is a startup error rather than a per-tick warning. A mirror
// that runs with a mismatched scale does not fail — it publishes a price that
// is wrong by a factor of a hundred, onto a feed a market settles against.
func New(ctx context.Context, source, dest *chain.Client, signer *chain.Signer, cfg Config) (*Mirror, error) {
	if len(cfg.Pairs) == 0 {
		return nil, fmt.Errorf("mirror: no pairs configured")
	}
	if cfg.PollInterval <= 0 {
		return nil, fmt.Errorf("mirror: poll interval must be positive, got %s", cfg.PollInterval)
	}

	m := &Mirror{source: source, dest: dest, signer: signer, cfg: cfg}

	for _, p := range cfg.Pairs {
		src, err := source.Bind(abis.AggregatorV3Interface, p.Source.Hex())
		if err != nil {
			return nil, err
		}
		dst, err := dest.Bind(abis.DemoPriceFeed, p.Dest.Hex())
		if err != nil {
			return nil, err
		}

		bound := boundPair{Pair: p, src: src, dst: dst}
		if err := verifyPair(ctx, &bound); err != nil {
			return nil, err
		}
		m.feeds = append(m.feeds, bound)
	}

	return m, nil
}

// verifyPair asserts the two ends of one mirror are compatible, and records
// where the destination has already got to.
func verifyPair(ctx context.Context, b *boundPair) error {
	srcDecimals, err := readUint8(ctx, b.src, "decimals")
	if err != nil {
		return fmt.Errorf("mirror: source %s has no readable decimals(): %w", b.Source.Hex(), err)
	}
	dstDecimals, err := readUint8(ctx, b.dst, "decimals")
	if err != nil {
		return fmt.Errorf("mirror: destination %s has no readable decimals(): %w", b.Dest.Hex(), err)
	}
	// The one mismatch that is silent on chain and catastrophic on screen. An
	// answer is a bare integer; nothing downstream can tell 374.92 scaled by
	// 1e8 from 37492.00 scaled by 1e6, and a market would settle against it.
	if srcDecimals != dstDecimals {
		return fmt.Errorf(
			"mirror: %s publishes %d decimals but %s expects %d — the mirrored price would be wrong by a factor of %d",
			b.Source.Hex(), srcDecimals, b.Dest.Hex(), dstDecimals,
			pow10(absDiff(srcDecimals, dstDecimals)))
	}

	description, err := readString(ctx, b.src, "description")
	if err != nil {
		return fmt.Errorf("mirror: source %s has no readable description(): %w", b.Source.Hex(), err)
	}
	b.label = description

	// The destination must be a feed the app will badge. This is the check
	// that keeps the arrangement honest, and it is deliberately a refusal to
	// start rather than a warning: a mirror pointed at an unbadged feed would
	// present a price we sign as though Chainlink secured it.
	dstDescription, err := readString(ctx, b.dst, "description")
	if err != nil {
		return fmt.Errorf("mirror: destination %s has no readable description(): %w", b.Dest.Hex(), err)
	}
	if !strings.Contains(dstDescription, demoMarker) {
		return fmt.Errorf(
			"mirror: destination %s describes itself as %q, which does not contain %q — "+
				"the app would not mark this price as operator-set, and a price we sign must never look like one Chainlink secured",
			b.Dest.Hex(), dstDescription, demoMarker)
	}

	// Where the destination already is, so a restart does not try to republish
	// answers it has already written and log a revert every tick.
	latest, err := b.dst.CallUint64(ctx, nil, "latestRoundId")
	if err != nil {
		return fmt.Errorf("mirror: destination %s has no readable latestRoundId(): %w", b.Dest.Hex(), err)
	}
	if latest > 0 {
		round, err := ReadRound(ctx, b.dst)
		if err != nil {
			return fmt.Errorf("mirror: destination %s has %d rounds but none readable: %w", b.Dest.Hex(), latest, err)
		}
		b.lastPushed = round.UpdatedAt
	}

	return nil
}

// Run mirrors on a timer until the context is cancelled.
func (m *Mirror) Run(ctx context.Context) error {
	for _, f := range m.feeds {
		slog.Info("mirroring", "from", f.Source.Hex(), "to", f.Dest.Hex(),
			"feed", f.label, "already_at", f.lastPushed)
	}

	ticker := time.NewTicker(m.cfg.PollInterval)
	defer ticker.Stop()

	m.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			m.tick(ctx)
		}
	}
}

// tick mirrors every pair once.
//
// One pair's failure never stops another's — the same per-item rule the keeper
// and the app both had to learn (GHO-91): a per-item action must not have a
// whole-list failure mode.
func (m *Mirror) tick(ctx context.Context) {
	for i := range m.feeds {
		if err := m.mirrorOne(ctx, &m.feeds[i]); err != nil {
			slog.Warn("mirror: pair failed", "from", m.feeds[i].Source.Hex(),
				"to", m.feeds[i].Dest.Hex(), "err", err)
		}
	}
}

func (m *Mirror) mirrorOne(ctx context.Context, b *boundPair) error {
	reading, err := ReadLatest(ctx, b.src)
	if err != nil {
		return err
	}

	if !Advances(reading, b.lastPushed) {
		return nil
	}

	// Refused here rather than left to revert on chain, so the reason is in
	// our log rather than in a failed transaction's receipt. A feed answering
	// zero or negative is a feed in trouble, and republishing it would put a
	// price on testnet that the source itself would not settle on.
	if reading.Answer == nil || reading.Answer.Sign() <= 0 {
		return fmt.Errorf("source answered %v, which is not a price", reading.Answer)
	}

	hash, err := m.signer.Send(ctx, b.dst, "pushAt",
		reading.Answer, new(big.Int).SetUint64(reading.UpdatedAt))
	if err != nil {
		return fmt.Errorf("pushAt: %w", err)
	}

	b.lastPushed = reading.UpdatedAt
	slog.Info("mirror: published", "feed", b.label, "answer", reading.Answer.String(),
		"source_updated_at", reading.UpdatedAt, "tx", hash.Hex())
	return nil
}

// Advances reports whether a source reading is newer than what has been
// published.
//
// Strictly newer, matching `DemoPriceFeed._push`, which reverts on a timestamp
// that has not advanced. Mirroring an unchanged feed is the ordinary case —
// the source publishes every few minutes and this polls faster than that — so
// this is the check that stops every idle tick becoming a failed transaction.
func Advances(r Reading, lastPushed uint64) bool {
	return r.UpdatedAt > lastPushed
}

func absDiff(a, b uint8) uint8 {
	if a > b {
		return a - b
	}
	return b - a
}

func pow10(n uint8) uint64 {
	out := uint64(1)
	for range n {
		out *= 10
	}
	return out
}
