// Package config loads runtime configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env      string
	HTTPPort string

	DatabaseURL string

	// JWTSecret signs session tokens. Must be set explicitly outside dev.
	JWTSecret []byte
	JWTTTL    time.Duration

	// NonceTTL bounds how long a login challenge stays valid. Short by
	// design: the nonce is the replay protection for wallet auth.
	NonceTTL time.Duration

	// AppDomain and AppURI are bound into the SIWE message the wallet signs.
	// They must match the site the user is actually on, or the signature is
	// phishable across origins.
	AppDomain string
	AppURI    string

	// ChainID pins which chain a signature is valid for.
	// 42161 = Arbitrum One, 421614 = Arbitrum Sepolia.
	ChainID int64
	RPCURL  string

	CORSOrigins []string

	Indexer IndexerConfig
}

// IndexerConfig configures the event indexer. Disabled by default: the
// contracts are not deployed yet, and an indexer pointed at an address with
// no code polls forever finding nothing.
type IndexerConfig struct {
	Enabled bool

	VaultAddress string
	PoolAddress  string

	// StartBlock should be the deployment block. Scanning from genesis on a
	// public RPC is slow and returns nothing for the whole range.
	StartBlock uint64

	// Confirmations is how far behind the head to stay before writing.
	//
	// Arbitrum blocks are final once posted to L1, but the sequencer can
	// reorder before that, so this is not zero. It is also not an L1-sized
	// number, because the risk being covered is sequencer reordering rather
	// than proof-of-work depth.
	Confirmations uint64

	// BatchSize bounds one eth_getLogs range; public RPCs reject wide ones.
	BatchSize uint64

	PollInterval time.Duration
}

func Load() (Config, error) {
	c := Config{
		Env:         env("APP_ENV", "development"),
		HTTPPort:    env("HTTP_PORT", "8080"),
		DatabaseURL: env("DATABASE_URL", ""),
		JWTTTL:      envDuration("JWT_TTL", 24*time.Hour),
		NonceTTL:    envDuration("NONCE_TTL", 5*time.Minute),
		AppDomain:   env("APP_DOMAIN", "localhost:3000"),
		AppURI:      env("APP_URI", "http://localhost:3000"),
		ChainID:     envInt64("CHAIN_ID", 421614),
		RPCURL:      env("ARBITRUM_RPC_URL", "https://sepolia-rollup.arbitrum.io/rpc"),
		CORSOrigins: envList("CORS_ORIGINS", "http://localhost:3000"),
		Indexer: IndexerConfig{
			Enabled:       envBool("INDEXER_ENABLED", false),
			VaultAddress:  env("VAULT_ADDRESS", ""),
			PoolAddress:   env("POOL_ADDRESS", ""),
			StartBlock:    uint64(envInt64("INDEXER_START_BLOCK", 0)),
			Confirmations: uint64(envInt64("INDEXER_CONFIRMATIONS", 5)),
			BatchSize:     uint64(envInt64("INDEXER_BATCH_SIZE", 2000)),
			PollInterval:  envDuration("INDEXER_POLL_INTERVAL", 12*time.Second),
		},
	}

	secret := env("JWT_SECRET", "")
	if secret == "" {
		if c.Env != "development" {
			return Config{}, fmt.Errorf("JWT_SECRET is required when APP_ENV=%s", c.Env)
		}
		// Dev-only fallback so `go run` works with no setup. Never reached in
		// staging or production because of the guard above.
		secret = "dev-only-insecure-secret-change-me"
	}
	if len(secret) < 32 && c.Env != "development" {
		return Config{}, fmt.Errorf("JWT_SECRET must be at least 32 bytes, got %d", len(secret))
	}
	c.JWTSecret = []byte(secret)

	if c.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}

	// Checked at load rather than at first poll: an indexer that starts,
	// looks healthy and silently indexes nothing is worse than a refusal to
	// boot.
	if c.Indexer.Enabled {
		if c.Indexer.VaultAddress == "" || c.Indexer.PoolAddress == "" {
			return Config{}, fmt.Errorf("VAULT_ADDRESS and POOL_ADDRESS are required when INDEXER_ENABLED=true")
		}
		if c.Indexer.StartBlock == 0 {
			return Config{}, fmt.Errorf("INDEXER_START_BLOCK is required when INDEXER_ENABLED=true")
		}
	}
	return c, nil
}

func envBool(k string, def bool) bool {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return parsed
}

func (c Config) IsDev() bool { return c.Env == "development" }

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envList(k, def string) []string {
	parts := strings.Split(env(k, def), ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envInt64(k string, def int64) int64 {
	v, err := strconv.ParseInt(env(k, ""), 10, 64)
	if err != nil {
		return def
	}
	return v
}

func envDuration(k string, def time.Duration) time.Duration {
	d, err := time.ParseDuration(env(k, ""))
	if err != nil {
		return def
	}
	return d
}
