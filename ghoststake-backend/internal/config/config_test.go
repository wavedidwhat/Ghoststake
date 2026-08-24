package config_test

import (
	"strings"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/config"
)

// base sets the minimum a production config needs, so each test can break
// exactly one thing.
func base(t *testing.T) {
	t.Helper()
	t.Setenv("APP_ENV", "production")
	t.Setenv("JWT_SECRET", strings.Repeat("x", 32))
	t.Setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
	t.Setenv("APP_DOMAIN", "ghoststake.example.com")
	t.Setenv("APP_URI", "https://ghoststake.example.com")
	t.Setenv("CORS_ORIGINS", "https://ghoststake.example.com")
}

func TestProductionConfigLoads(t *testing.T) {
	base(t)
	if _, err := config.Load(); err != nil {
		t.Fatalf("want a valid config, got %v", err)
	}
}

// Audit finding: the SIWE origin defaults to localhost, and the comment on
// those fields says a mismatch is phishable. Nothing enforced it, so a
// production deploy that forgot them bound every signature to localhost.
func TestProductionRejectsLocalhostSiweOrigin(t *testing.T) {
	for _, tc := range []struct{ name, key, value string }{
		{"domain", "APP_DOMAIN", "localhost:3000"},
		{"uri", "APP_URI", "http://localhost:3000"},
		{"cors", "CORS_ORIGINS", "http://localhost:3000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base(t)
			t.Setenv(tc.key, tc.value)
			if _, err := config.Load(); err == nil {
				t.Fatalf("%s=%s was accepted in production", tc.key, tc.value)
			}
		})
	}
}

func TestDevelopmentStillAllowsLocalhost(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
	if _, err := config.Load(); err != nil {
		t.Fatalf("localhost should be fine in development: %v", err)
	}
}

// Audit finding: common.HexToAddress never errors. It zero-fills or left-pads
// whatever it is handed, so a typo becomes an address with no code — and the
// indexer polls it forever, logging healthy cycles and writing nothing.
func TestIndexerRejectsAMalformedAddress(t *testing.T) {
	for _, bad := range []string{
		"not-an-address",
		"0xdeadbeef", // too short; HexToAddress would left-pad it
		"0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
		"0x0000000000000000000000000000000000000000", // zero address
	} {
		t.Run(bad, func(t *testing.T) {
			base(t)
			t.Setenv("INDEXER_ENABLED", "true")
			t.Setenv("INDEXER_START_BLOCK", "100")
			t.Setenv("VAULT_ADDRESS", bad)
			t.Setenv("POOL_ADDRESS", "0x47804e9acD330b10eb17480252b6602b500598d6")
			t.Setenv("MARKET_ADDRESS", "0x2b5A4e5493d4a54E717057B127cf0C000d876f5F")
			if _, err := config.Load(); err == nil {
				t.Fatalf("VAULT_ADDRESS=%q was accepted", bad)
			}
		})
	}
}

func TestIndexerAcceptsAValidAddress(t *testing.T) {
	base(t)
	t.Setenv("INDEXER_ENABLED", "true")
	t.Setenv("INDEXER_START_BLOCK", "100")
	t.Setenv("VAULT_ADDRESS", "0xb733034613Ed737666eA378ECA74B2E615367A59")
	t.Setenv("POOL_ADDRESS", "0x47804e9acD330b10eb17480252b6602b500598d6")
	t.Setenv("MARKET_ADDRESS", "0x2b5A4e5493d4a54E717057B127cf0C000d876f5F")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("valid addresses rejected: %v", err)
	}
	if !cfg.Indexer.Enabled {
		t.Fatal("indexer should be enabled")
	}
}

func TestIndexerRequiresAStartBlock(t *testing.T) {
	base(t)
	t.Setenv("INDEXER_ENABLED", "true")
	t.Setenv("VAULT_ADDRESS", "0xb733034613Ed737666eA378ECA74B2E615367A59")
	t.Setenv("POOL_ADDRESS", "0x47804e9acD330b10eb17480252b6602b500598d6")
	t.Setenv("MARKET_ADDRESS", "0x2b5A4e5493d4a54E717057B127cf0C000d876f5F")
	if _, err := config.Load(); err == nil {
		t.Fatal("a zero start block was accepted")
	}
}
