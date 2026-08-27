package config

import (
	"fmt"
	"math/big"
	"strings"
	"time"
)

// KeeperConfig configures the round keeper (GHO-24).
//
// Loaded by its own entrypoint, not by Load. The keeper is the one process in
// the Go layer that holds a private key, and it is a separate binary for that
// reason — so this struct, and the key in it, never exist inside the API or
// the indexer. A shared Config with a nil-able key field would put the
// material one misread environment away from the process that answers the
// internet.
type KeeperConfig struct {
	Env     string
	ChainID int64
	RPCURL  string

	// PrivateKey signs the keeper's transactions. Hex, with or without 0x.
	PrivateKey string

	// RegistryAddress is the market registry to enumerate. Takes precedence
	// over MarketAddresses.
	RegistryAddress string

	// MarketAddresses is the explicit list, for a deployment with no
	// registry.
	MarketAddresses []string

	PollInterval time.Duration

	// OpenRounds is whether to open new rounds, which needs the owner key.
	OpenRounds bool

	Lead        uint64
	EntryWindow uint64
	Horizon     uint64

	// StatusFeeds maps a market address (lowercased) to the venue
	// market-status feed that speaks for it. Optional and usually empty.
	StatusFeeds map[string]string

	// MaxUncalendaredRound bounds round length on dates the trading calendar
	// does not cover.
	MaxUncalendaredRound time.Duration

	MinGasBalanceWei *big.Int
}

func (c KeeperConfig) IsDev() bool { return c.Env == "development" }

// LoadKeeper reads the keeper's environment.
func LoadKeeper() (KeeperConfig, error) {
	c := KeeperConfig{
		Env:             env("APP_ENV", "development"),
		ChainID:         envInt64("CHAIN_ID", 421614),
		RPCURL:          env("RPC_URL", env("ARBITRUM_RPC_URL", "https://sepolia-rollup.arbitrum.io/rpc")),
		PrivateKey:      env("KEEPER_PRIVATE_KEY", ""),
		RegistryAddress: env("REGISTRY_ADDRESS", ""),
		// Falls back through the indexer's list and then its old singular
		// name. Both are kept: GHO-43 renamed MARKET_ADDRESS to
		// MARKET_ADDRESSES, and a keeper that silently found no markets
		// because of a rename would advance nothing while reporting healthy.
		MarketAddresses: envList("KEEPER_MARKET_ADDRESSES",
			env("MARKET_ADDRESSES", env("MARKET_ADDRESS", ""))),
		PollInterval: envDuration("KEEPER_POLL_INTERVAL", 10*time.Second),
		OpenRounds:   envBool("KEEPER_OPEN_ROUNDS", true),
		Lead:         uint64(envInt64("KEEPER_LEAD", 45)),
		EntryWindow:  uint64(envInt64("KEEPER_ENTRY_WINDOW", 0)),
		Horizon:      uint64(envInt64("KEEPER_HORIZON", 3600)),

		MaxUncalendaredRound: envDuration("KEEPER_MAX_UNCALENDARED_ROUND", 15*time.Minute),
	}

	statusFeeds, err := parseStatusFeeds(env("KEEPER_MARKET_STATUS_FEEDS", ""))
	if err != nil {
		return KeeperConfig{}, err
	}
	c.StatusFeeds = statusFeeds

	if c.PrivateKey == "" {
		return KeeperConfig{}, fmt.Errorf("KEEPER_PRIVATE_KEY is required")
	}

	if c.RegistryAddress == "" && len(c.MarketAddresses) == 0 {
		return KeeperConfig{}, fmt.Errorf("set REGISTRY_ADDRESS, or KEEPER_MARKET_ADDRESSES for a deployment with no registry")
	}
	// Validated here rather than at first call, for the reason the indexer's
	// addresses are: common.HexToAddress does not fail, so a typo becomes an
	// address with no code and every read off it returns a plausible zero.
	if c.RegistryAddress != "" {
		if err := validateAddress("REGISTRY_ADDRESS", c.RegistryAddress); err != nil {
			return KeeperConfig{}, err
		}
	}
	for _, address := range c.MarketAddresses {
		if err := validateAddress("KEEPER_MARKET_ADDRESSES", address); err != nil {
			return KeeperConfig{}, err
		}
	}

	if c.PollInterval <= 0 {
		return KeeperConfig{}, fmt.Errorf("KEEPER_POLL_INTERVAL must be positive")
	}
	// A round opened with no lead has already failed by the time the
	// transaction is mined: `openRound` reverts on an openTime in the past,
	// and simulating then mining takes longer than zero seconds.
	if c.OpenRounds && c.Lead == 0 {
		return KeeperConfig{}, fmt.Errorf("KEEPER_LEAD must be non-zero when KEEPER_OPEN_ROUNDS=true")
	}

	if c.MaxUncalendaredRound <= 0 {
		return KeeperConfig{}, fmt.Errorf("KEEPER_MAX_UNCALENDARED_ROUND must be positive")
	}

	balance, ok := new(big.Int).SetString(strings.TrimSpace(env("KEEPER_MIN_GAS_BALANCE_WEI", "10000000000000000")), 10)
	if !ok {
		return KeeperConfig{}, fmt.Errorf("KEEPER_MIN_GAS_BALANCE_WEI is not a base-10 integer")
	}
	c.MinGasBalanceWei = balance

	return c, nil
}

// parseStatusFeeds reads `market=statusFeed` pairs.
//
//	KEEPER_MARKET_STATUS_FEEDS=0xMarket=0xStatus,0xOther=0xOtherStatus
//
// Per market rather than one global address, because a status feed speaks for
// one venue and a deployment can list markets on several. Keyed lowercase so a
// checksummed address in one variable and a lowercase one in another still
// name the same market.
//
// Both halves are validated here for the reason every other address in this
// package is: `common.HexToAddress` pads whatever it is handed, so a typo
// becomes an address with no code, and a status feed with no code would fail
// the gate closed on every tick — a market that silently stops opening rounds.
func parseStatusFeeds(raw string) (map[string]string, error) {
	out := map[string]string{}
	if strings.TrimSpace(raw) == "" {
		return out, nil
	}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		market, status, found := strings.Cut(pair, "=")
		if !found {
			return nil, fmt.Errorf("KEEPER_MARKET_STATUS_FEEDS entry %q is not market=statusFeed", pair)
		}
		market, status = strings.TrimSpace(market), strings.TrimSpace(status)
		if err := validateAddress("KEEPER_MARKET_STATUS_FEEDS market", market); err != nil {
			return nil, err
		}
		if err := validateAddress("KEEPER_MARKET_STATUS_FEEDS status feed", status); err != nil {
			return nil, err
		}
		out[strings.ToLower(market)] = status
	}
	return out, nil
}
