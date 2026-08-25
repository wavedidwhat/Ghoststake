package keeper

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	"github.com/wavedidwhat/ghoststake/internal/abis"
	"github.com/wavedidwhat/ghoststake/internal/chain"
)

// listing mirrors `MarketRegistry.Listing`. Field names match the Solidity
// struct's, which is what CallInto unpacks by.
type listing struct {
	Market  common.Address
	Router  common.Address
	Horizon uint64
	Enabled bool
}

// Discover builds the set of markets to drive.
//
// The registry is the source when one is configured, because that is what it
// is for: adding a market became a transaction in GHO-34, and a keeper that
// still learned its markets from an environment variable would mean listing a
// market and then redeploying the keeper before anything ran on it.
//
// The explicit list is the fallback, and is kept rather than deleted for the
// same reason the frontend keeps `envMarkets()`: the Sepolia deployment
// predates the registry.
//
// A delisted market is skipped. Delisting does not pause a market — rounds
// already open still lock, settle and pay out — so the keeper drives the
// rounds that already exist on one and simply stops opening new ones. That
// falls out of the design rather than needing a rule: an unlisted market is
// not in this set at all, and the console is where anyone finishes off its
// last round.
func Discover(ctx context.Context, client *chain.Client, registryAddress string, marketAddresses []string, nyse *Session) ([]*Market, error) {
	if registryAddress != "" {
		return discoverFromRegistry(ctx, client, registryAddress, nyse)
	}

	out := make([]*Market, 0, len(marketAddresses))
	for _, address := range marketAddresses {
		m, err := LoadMarket(ctx, client, address, 0, nyse)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

func discoverFromRegistry(ctx context.Context, client *chain.Client, registryAddress string, nyse *Session) ([]*Market, error) {
	registry, err := client.Bind(abis.MarketRegistry, registryAddress)
	if err != nil {
		return nil, err
	}

	count, err := registry.CallBig(ctx, nil, "count")
	if err != nil {
		return nil, fmt.Errorf("keeper: read registry at %s: %w", registryAddress, err)
	}

	// Read one at a time rather than through `all()`. The registry's `all()`
	// returns every listing including the delisted ones, and this loop wants
	// to name the id it skipped — which `at(id)` gives for free and an array
	// index only gives by convention.
	out := make([]*Market, 0, count.Uint64())
	for id := uint64(0); id < count.Uint64(); id++ {
		var l listing
		if err := registry.CallInto(ctx, nil, &l, "at", new(big.Int).SetUint64(id)); err != nil {
			return nil, fmt.Errorf("keeper: read registry listing %d: %w", id, err)
		}
		if !l.Enabled {
			slog.Info("skipping delisted market", "id", id, "market", l.Market.Hex())
			continue
		}
		m, err := LoadMarket(ctx, client, l.Market.Hex(), l.Horizon, nyse)
		if err != nil {
			return nil, fmt.Errorf("keeper: load listed market %d (%s): %w", id, l.Market.Hex(), err)
		}
		out = append(out, m)
	}
	return out, nil
}
