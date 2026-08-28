package keeper

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"strings"

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

// MarketSource answers "which markets should be driven right now".
//
// An interface rather than the concrete Source below because the keeper's
// re-read logic — what to keep, what to add, what to retire — is the part
// worth testing, and testing it against a registry would mean a chain.
type MarketSource interface {
	// Markets is the current set. Returning an error must leave the keeper's
	// existing set alone; see Keeper.refreshMarkets.
	Markets(ctx context.Context) ([]*Market, error)

	// Dynamic reports whether this source can ever return a different set. A
	// configured list of addresses cannot, so there is nothing to re-read and
	// the keeper does not start a refresh ticker for one.
	Dynamic() bool
}

// Source resolves the set of markets to drive, and can be re-read.
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
// A delisted market is skipped here. Delisting does not pause a market —
// rounds already open still lock, settle and pay out — so a market that
// disappears from this set is retired by the keeper rather than dropped; see
// Keeper.refreshMarkets.
type Source struct {
	client          *chain.Client
	registryAddress string
	marketAddresses []string
	nyse            *Session
	statusFeeds     map[string]string

	// loaded caches by address. LoadMarket does real work per market — it
	// reads the timing immutables, resolves the oracle and the feed, reads
	// the feed's description and measures its heartbeat (GHO-48) — so
	// re-reading the registry every minute must not re-do all of that for
	// markets that have not changed. It also carries state worth keeping:
	// `calendarDisqualified` is evidence accumulated at runtime, and
	// rebuilding the Market would throw it away.
	loaded map[common.Address]*Market
}

// NewSource builds the market source. Only one of registryAddress and
// marketAddresses is used, the registry taking precedence.
func NewSource(client *chain.Client, registryAddress string, marketAddresses []string, nyse *Session, statusFeeds map[string]string) *Source {
	return &Source{
		client:          client,
		registryAddress: registryAddress,
		marketAddresses: marketAddresses,
		nyse:            nyse,
		statusFeeds:     statusFeeds,
		loaded:          map[common.Address]*Market{},
	}
}

func (s *Source) Dynamic() bool { return s.registryAddress != "" }

// Markets is the enabled set, reusing anything already loaded.
func (s *Source) Markets(ctx context.Context) ([]*Market, error) {
	if s.registryAddress != "" {
		return s.fromRegistry(ctx)
	}

	out := make([]*Market, 0, len(s.marketAddresses))
	for _, address := range s.marketAddresses {
		m, err := s.load(ctx, address, 0)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

// load returns the cached Market for an address, reading it off the chain the
// first time.
func (s *Source) load(ctx context.Context, address string, horizon uint64) (*Market, error) {
	if cached, ok := s.loaded[common.HexToAddress(address)]; ok {
		// The horizon is the one listing field that can change without the
		// market changing, and it decides the cadence rounds are opened at.
		// Everything else on a Market is a Solidity immutable.
		cached.Horizon = horizon
		return cached, nil
	}
	m, err := LoadMarket(ctx, s.client, address, horizon, s.nyse, statusFeedFor(s.statusFeeds, address))
	if err != nil {
		return nil, err
	}
	s.loaded[m.Address] = m
	return m, nil
}

// Discover builds the initial set of markets to drive.
func Discover(ctx context.Context, client *chain.Client, registryAddress string, marketAddresses []string, nyse *Session, statusFeeds map[string]string) ([]*Market, error) {
	return NewSource(client, registryAddress, marketAddresses, nyse, statusFeeds).Markets(ctx)
}

// statusFeedFor looks a market's venue status feed up by address.
//
// Case-insensitively, because an address is the same address whether or not
// somebody pasted it checksummed — and a status feed that silently did not
// apply because of a capital letter would be a gate quietly missing.
func statusFeedFor(statusFeeds map[string]string, market string) string {
	return statusFeeds[strings.ToLower(market)]
}

func (s *Source) fromRegistry(ctx context.Context) ([]*Market, error) {
	registry, err := s.client.Bind(abis.MarketRegistry, s.registryAddress)
	if err != nil {
		return nil, err
	}

	count, err := registry.CallBig(ctx, nil, "count")
	if err != nil {
		return nil, fmt.Errorf("keeper: read registry at %s: %w", s.registryAddress, err)
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
			// Debug, not info. This runs every refresh interval now rather
			// than once at boot, and a permanently delisted market would
			// otherwise print a line a minute forever. The keeper logs the
			// listing *change* instead — see refreshMarkets.
			slog.Debug("skipping delisted market", "id", id, "market", l.Market.Hex())
			continue
		}
		m, err := s.load(ctx, l.Market.Hex(), l.Horizon)
		if err != nil {
			return nil, fmt.Errorf("keeper: load listed market %d (%s): %w", id, l.Market.Hex(), err)
		}
		out = append(out, m)
	}
	return out, nil
}
