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
	return c, nil
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
