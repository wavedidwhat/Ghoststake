package config_test

import (
	"strings"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/config"
)

const (
	testKey      = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
	testRegistry = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
)

// keeperBase sets the minimum the keeper needs, so each test can break
// exactly one thing.
func keeperBase(t *testing.T) {
	t.Helper()
	t.Setenv("KEEPER_PRIVATE_KEY", testKey)
	t.Setenv("REGISTRY_ADDRESS", testRegistry)
}

func TestKeeperConfigLoads(t *testing.T) {
	keeperBase(t)
	cfg, err := config.LoadKeeper()
	if err != nil {
		t.Fatalf("want a valid config, got %v", err)
	}
	if cfg.RegistryAddress != testRegistry {
		t.Fatalf("registry: got %q", cfg.RegistryAddress)
	}
	// Opening rounds is the default, and a default lead has to be non-zero
	// or every open reverts on an openTime already in the past.
	if !cfg.OpenRounds || cfg.Lead == 0 {
		t.Fatalf("defaults: open=%v lead=%d", cfg.OpenRounds, cfg.Lead)
	}
}

// The key is the whole reason this is a separate binary. Without one there is
// nothing to run.
func TestKeeperRefusesToStartWithoutAKey(t *testing.T) {
	t.Setenv("REGISTRY_ADDRESS", testRegistry)
	t.Setenv("KEEPER_PRIVATE_KEY", "")
	if _, err := config.LoadKeeper(); err == nil {
		t.Fatal("a keeper with no key was accepted")
	}
}

// A keeper with no markets is a process that polls nothing and reports
// healthy, which is the failure mode the indexer's own address checks exist
// to prevent.
func TestKeeperRefusesToStartWithNoMarkets(t *testing.T) {
	t.Setenv("KEEPER_PRIVATE_KEY", testKey)
	t.Setenv("REGISTRY_ADDRESS", "")
	t.Setenv("KEEPER_MARKET_ADDRESSES", "")
	t.Setenv("MARKET_ADDRESS", "")
	if _, err := config.LoadKeeper(); err == nil {
		t.Fatal("a keeper with nothing to drive was accepted")
	}
}

// `common.HexToAddress` pads or truncates whatever it is handed, so a typo
// becomes a valid-looking address with no code. Every read off it then
// returns a plausible zero and the keeper drives nothing, forever, quietly.
func TestKeeperRejectsMalformedAddresses(t *testing.T) {
	for _, tc := range []struct{ name, key, value string }{
		{"registry too short", "REGISTRY_ADDRESS", "0xdeadbeef"},
		{"registry zero", "REGISTRY_ADDRESS", "0x0000000000000000000000000000000000000000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			keeperBase(t)
			t.Setenv(tc.key, tc.value)
			if _, err := config.LoadKeeper(); err == nil {
				t.Fatalf("%s=%s was accepted", tc.key, tc.value)
			}
		})
	}

	t.Run("market list", func(t *testing.T) {
		t.Setenv("KEEPER_PRIVATE_KEY", testKey)
		t.Setenv("REGISTRY_ADDRESS", "")
		t.Setenv("KEEPER_MARKET_ADDRESSES", testRegistry+",0xnope")
		if _, err := config.LoadKeeper(); err == nil {
			t.Fatal("a malformed address in the market list was accepted")
		}
	})
}

// A deployment predating the registry names its market directly, and the
// backend already has MARKET_ADDRESS set for the indexer — so that is the
// fallback rather than a second variable nobody remembers to set.
func TestKeeperFallsBackToTheIndexersMarketAddress(t *testing.T) {
	t.Setenv("KEEPER_PRIVATE_KEY", testKey)
	t.Setenv("REGISTRY_ADDRESS", "")
	t.Setenv("KEEPER_MARKET_ADDRESSES", "")
	t.Setenv("MARKET_ADDRESS", testRegistry)

	cfg, err := config.LoadKeeper()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.MarketAddresses) != 1 || cfg.MarketAddresses[0] != testRegistry {
		t.Fatalf("got %v", cfg.MarketAddresses)
	}
}

func TestKeeperRefusesAZeroLeadWhenItOpensRounds(t *testing.T) {
	keeperBase(t)
	t.Setenv("KEEPER_LEAD", "0")
	if _, err := config.LoadKeeper(); err == nil {
		t.Fatal("a zero lead would revert on every open")
	}

	// With opening off there is nothing for a lead to be wrong about.
	t.Setenv("KEEPER_OPEN_ROUNDS", "false")
	if _, err := config.LoadKeeper(); err != nil {
		t.Fatalf("a keeper that only advances rounds needs no lead: %v", err)
	}
}

// Status feeds are per market, because a status feed speaks for one venue and
// a deployment can list markets on several.
func TestKeeperParsesPerMarketStatusFeeds(t *testing.T) {
	const status = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
	keeperBase(t)
	t.Setenv("KEEPER_MARKET_STATUS_FEEDS", testRegistry+"="+status)

	cfg, err := config.LoadKeeper()
	if err != nil {
		t.Fatal(err)
	}
	// Keyed lowercase, so a checksummed address in one variable and a
	// lowercase one in another still name the same market.
	got := cfg.StatusFeeds[strings.ToLower(testRegistry)]
	if got != status {
		t.Fatalf("got %q, want %q", got, status)
	}
}

// Unset is the normal case and must not be an error: nothing depends on a
// venue publishing its status.
func TestKeeperStatusFeedsAreOptional(t *testing.T) {
	keeperBase(t)
	cfg, err := config.LoadKeeper()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.StatusFeeds) != 0 {
		t.Fatalf("got %v, want none", cfg.StatusFeeds)
	}
}

// A malformed pair is refused rather than skipped. A status feed that
// silently did not apply is a gate quietly missing, which is worse than one
// that never existed — the operator believes it is there.
func TestKeeperRejectsMalformedStatusFeeds(t *testing.T) {
	for _, tc := range []struct{ name, value string }{
		{"no equals", testRegistry},
		{"bad market", "0xnope=" + testRegistry},
		{"bad feed", testRegistry + "=0xnope"},
		{"zero feed", testRegistry + "=0x0000000000000000000000000000000000000000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			keeperBase(t)
			t.Setenv("KEEPER_MARKET_STATUS_FEEDS", tc.value)
			if _, err := config.LoadKeeper(); err == nil {
				t.Fatalf("%q was accepted", tc.value)
			}
		})
	}
}
