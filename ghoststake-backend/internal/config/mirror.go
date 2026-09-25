package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// MirrorConfig is what `cmd/mirror` needs (GHO-21).
//
// Two chains, because that is the whole point: the source is wherever the real
// Chainlink feed lives (Robinhood Chain mainnet) and the destination is
// wherever GhostStake is deployed (its testnet).
type MirrorConfig struct {
	Env string

	// Source is read-only. No key is configured for it and none is needed —
	// nothing is ever sent to the chain the price comes from, and a mirror
	// that could write to mainnet would be a mirror that could be made to.
	SourceRPCURL  string
	SourceChainID int64

	DestRPCURL  string
	DestChainID int64
	PrivateKey  string

	Pairs        []MirrorPair
	PollInterval time.Duration
}

// MirrorPair is one `source:dest` entry of MIRROR_PAIRS.
type MirrorPair struct {
	Source common.Address
	Dest   common.Address
	// Raw is the entry as written, for an error that names what the operator
	// typed rather than a normalised form they will not recognise.
	Raw string
}

func LoadMirror() (MirrorConfig, error) {
	c := MirrorConfig{
		Env:           env("APP_ENV", "development"),
		SourceRPCURL:  env("MIRROR_SOURCE_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
		SourceChainID: envInt64("MIRROR_SOURCE_CHAIN_ID", 4663),
		DestRPCURL:    env("RPC_URL", env("ARBITRUM_RPC_URL", "")),
		DestChainID:   envInt64("CHAIN_ID", 46630),
		PrivateKey:    env("MIRROR_PRIVATE_KEY", env("KEEPER_PRIVATE_KEY", "")),
		// Polled faster than the source publishes. The source is
		// deviation-driven and updated every 3–21 minutes when measured on
		// 2026-09-25, so a minute keeps the mirrored feed within a minute of
		// the real one without making most ticks do anything.
		PollInterval: envDuration("MIRROR_POLL_INTERVAL", time.Minute),
	}

	pairs, err := parseMirrorPairs(env("MIRROR_PAIRS", ""))
	if err != nil {
		return MirrorConfig{}, err
	}
	c.Pairs = pairs

	if c.PrivateKey == "" {
		return MirrorConfig{}, fmt.Errorf("MIRROR_PRIVATE_KEY is required (it must own each destination DemoPriceFeed)")
	}
	if c.DestRPCURL == "" {
		return MirrorConfig{}, fmt.Errorf("RPC_URL is required: the chain the mirrored feed is published to")
	}
	if len(c.Pairs) == 0 {
		return MirrorConfig{}, fmt.Errorf("MIRROR_PAIRS is required, as `sourceFeed:destFeed` entries separated by commas")
	}
	// A mirror pointed at its own source would read a price and publish it
	// back, which cannot work (the destination must be a DemoPriceFeed we own)
	// but would fail obscurely at the first push rather than here.
	if c.SourceChainID == c.DestChainID {
		return MirrorConfig{}, fmt.Errorf(
			"MIRROR_SOURCE_CHAIN_ID and CHAIN_ID are both %d — a mirror copies a price *between* chains",
			c.SourceChainID)
	}

	return c, nil
}

// parseMirrorPairs reads `source:dest,source:dest`.
//
// Both halves are validated here rather than at the first call, for the reason
// every other address in this package is: common.HexToAddress does not fail.
// It pads or truncates whatever it is handed, so a typo becomes a valid-looking
// address with no code — and a mirror whose source has no code would read zeros
// and publish them as a price.
func parseMirrorPairs(raw string) ([]MirrorPair, error) {
	var out []MirrorPair
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}

		source, dest, ok := strings.Cut(entry, ":")
		if !ok {
			return nil, fmt.Errorf("MIRROR_PAIRS entry %q is not `sourceFeed:destFeed`", entry)
		}
		source, dest = strings.TrimSpace(source), strings.TrimSpace(dest)

		if !common.IsHexAddress(source) {
			return nil, fmt.Errorf("MIRROR_PAIRS entry %q: source %q is not an address", entry, source)
		}
		if !common.IsHexAddress(dest) {
			return nil, fmt.Errorf("MIRROR_PAIRS entry %q: destination %q is not an address", entry, dest)
		}
		if strings.EqualFold(source, dest) {
			return nil, fmt.Errorf("MIRROR_PAIRS entry %q mirrors a feed onto itself", entry)
		}

		out = append(out, MirrorPair{
			Source: common.HexToAddress(source),
			Dest:   common.HexToAddress(dest),
			Raw:    entry,
		})
	}
	return out, nil
}
