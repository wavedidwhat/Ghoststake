// Package config loads runtime configuration from the environment.
package config

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
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

	// AllowSchemaAhead permits booting against a database that has applied
	// migrations this binary does not carry. Off by default: the binary would
	// otherwise read and write columns a later migration may have renamed,
	// and nothing downstream would notice. See store.Migrate.
	AllowSchemaAhead bool

	Indexer IndexerConfig
}

// IndexerConfig configures the event indexer. Disabled by default: the
// contracts are not deployed yet, and an indexer pointed at an address with
// no code polls forever finding nothing.
type IndexerConfig struct {
	Enabled bool

	VaultAddress string
	PoolAddress  string

	// MarketAddresses is every ParimutuelRound to index.
	//
	// Read from MARKET_ADDRESSES (comma-separated), falling back to the
	// singular MARKET_ADDRESS. The fallback is kept because every deployed
	// .env still uses it, and an indexer that silently indexes nothing
	// because a variable was renamed is the exact failure mode the
	// fingerprint check exists to catch — no reason to create a new one.
	MarketAddresses []string

	// EventOracles is every EventRoundOracle to index, each named with the
	// market and round it settles (GHO-91).
	//
	// Read from EVENT_ORACLES as a comma-separated list of
	// `oracle:market:roundId`. The pair is configured rather than read off
	// the chain because the indexer's stream identity is a fingerprint of the
	// addresses it watches, fixed before any RPC call is made — resolving it
	// later would change the fingerprint and start a fresh stream, which
	// since GHO-89 means a full re-read a pruned endpoint refuses outright.
	//
	// A configured copy of a fact the contract also stores is the thing this
	// codebase argues against everywhere else, so it is *checked* rather than
	// trusted: the oracle emits `MarketSet(market, roundId)` when it is
	// pointed at a round, and the decoder refuses a log whose pair disagrees
	// with the one configured here. A typo then stops the indexer instead of
	// filing a question's whole lifecycle under somebody else's round.
	EventOracles []EventOracle

	// StartBlock should be the deployment block. Scanning from genesis on a
	// public RPC is slow and returns nothing for the whole range.
	StartBlock uint64

	// SkipDecoderReplay declines the one-time replay a decoder version change
	// asks for.
	//
	// Off by default, so the correct thing happens to a deployment nobody
	// touches: a decoder that starts deriving a new record backfills it, and
	// history is complete rather than complete-from-the-upgrade-onwards. The
	// flag exists for the deployment where re-reading the range is genuinely
	// not worth it — a pruned RPC, or history older than anything anyone will
	// look at — and it keeps the gap knowingly instead of by accident.
	SkipDecoderReplay bool

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
		// RPC_URL is the name that survives; ARBITRUM_RPC_URL is kept as a
		// fallback because the deployed .env files already use it. The chain
		// is no longer necessarily Arbitrum — chain.Dial's id check is what
		// actually guarantees we are where we think we are.
		RPCURL:           env("RPC_URL", env("ARBITRUM_RPC_URL", "https://sepolia-rollup.arbitrum.io/rpc")),
		CORSOrigins:      envList("CORS_ORIGINS", "http://localhost:3000"),
		AllowSchemaAhead: envBool("ALLOW_SCHEMA_AHEAD", false),
		Indexer: IndexerConfig{
			Enabled:           envBool("INDEXER_ENABLED", false),
			VaultAddress:      env("VAULT_ADDRESS", ""),
			PoolAddress:       env("POOL_ADDRESS", ""),
			MarketAddresses:   envList("MARKET_ADDRESSES", env("MARKET_ADDRESS", "")),
			EventOracles:      parseEventOracles(envList("EVENT_ORACLES", "")),
			StartBlock:        uint64(envInt64("INDEXER_START_BLOCK", 0)),
			Confirmations:     uint64(envInt64("INDEXER_CONFIRMATIONS", 5)),
			SkipDecoderReplay: envBool("INDEXER_SKIP_DECODER_REPLAY", false),
			BatchSize:         uint64(envInt64("INDEXER_BATCH_SIZE", 2000)),
			PollInterval:      envDuration("INDEXER_POLL_INTERVAL", 12*time.Second),
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

	// Outside development these must be set explicitly. The defaults point at
	// localhost, and a production deploy that silently keeps them binds every
	// SIWE message to the wrong origin — which the comment on these fields
	// already says is phishable, while nothing enforced it.
	if !c.IsDev() {
		if c.AppDomain == "localhost:3000" || c.AppURI == "http://localhost:3000" {
			return Config{}, fmt.Errorf("APP_DOMAIN and APP_URI must be set when APP_ENV=%s", c.Env)
		}
		// A localhost origin is a mistake in production and the normal case on
		// a remote dev box (APP_ENV=staging), where the API runs on the VPS
		// under RDK and the frontend runs on the developer's laptop. Before
		// this, that combination could not work at all: the deployment refused
		// to boot with localhost in the list, so `pnpm dev` against the RDK API
		// failed every request on CORS.
		//
		// Staging keeps every other guard — a real JWT secret, a real
		// APP_DOMAIN — because it is a real deployment on a real domain. This
		// is the one rule it relaxes, and only for origins that are literally
		// loopback.
		if c.IsProd() {
			for _, origin := range c.CORSOrigins {
				if isLoopbackOrigin(origin) {
					return Config{}, fmt.Errorf("CORS_ORIGINS must not contain a loopback origin when APP_ENV=%s, got %q", c.Env, origin)
				}
			}
		}
	}

	// Checked at load rather than at first poll: an indexer that starts,
	// looks healthy and silently indexes nothing is worse than a refusal to
	// boot.
	if c.Indexer.Enabled {
		if c.Indexer.VaultAddress == "" || c.Indexer.PoolAddress == "" || len(c.Indexer.MarketAddresses) == 0 {
			return Config{}, fmt.Errorf("VAULT_ADDRESS, POOL_ADDRESS and MARKET_ADDRESSES are required when INDEXER_ENABLED=true")
		}
		// Validated here because nothing downstream will. common.HexToAddress
		// does not return an error — it left-pads or zero-fills whatever it is
		// given, so a typo becomes an address with no code and the indexer
		// polls it forever, reporting healthy and writing nothing.
		for name, addr := range map[string]string{
			"VAULT_ADDRESS": c.Indexer.VaultAddress,
			"POOL_ADDRESS":  c.Indexer.PoolAddress,
		} {
			if err := validateAddress(name, addr); err != nil {
				return Config{}, err
			}
		}
		// Each market named individually. A list validated as a whole reports
		// "MARKET_ADDRESSES is invalid" for a list of four, which is a worse
		// message than the one it replaces.
		for i, addr := range c.Indexer.MarketAddresses {
			if err := validateAddress(fmt.Sprintf("MARKET_ADDRESSES[%d]", i), addr); err != nil {
				return Config{}, err
			}
		}
		for i, o := range c.Indexer.EventOracles {
			if o.Malformed != "" {
				return Config{}, fmt.Errorf("EVENT_ORACLES[%d] is not oracle:market:roundId: %q", i, o.Malformed)
			}
			if err := validateAddress(fmt.Sprintf("EVENT_ORACLES[%d] oracle", i), o.Oracle); err != nil {
				return Config{}, err
			}
			if err := validateAddress(fmt.Sprintf("EVENT_ORACLES[%d] market", i), o.Market); err != nil {
				return Config{}, err
			}
			// Round ids start at 1. Zero means the round was left off the
			// entry, and a lifecycle filed under round 0 would be attached to
			// nothing and visible nowhere.
			if o.RoundID == 0 {
				return Config{}, fmt.Errorf("EVENT_ORACLES[%d] has no round id: %q", i, o.Raw)
			}
		}
		if c.Indexer.StartBlock == 0 {
			return Config{}, fmt.Errorf("INDEXER_START_BLOCK is required when INDEXER_ENABLED=true")
		}
	}
	return c, nil
}

// EventOracle is one question's oracle and the round it settles.
type EventOracle struct {
	Oracle  string
	Market  string
	RoundID uint64

	// Raw is the entry as it was written, for error messages.
	Raw string

	// Malformed is set, to Raw, when the entry could not be split into three
	// parts. Carried rather than returned as an error from the parser so
	// that, like every other bad value here, it is reported by Load's
	// validation with the variable named — a parser that returned an error
	// would fail before the "is the indexer even enabled" check.
	Malformed string
}

// parseEventOracles splits `oracle:market:roundId` entries.
func parseEventOracles(entries []string) []EventOracle {
	out := make([]EventOracle, 0, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.Split(entry, ":")
		if len(parts) != 3 {
			out = append(out, EventOracle{Raw: entry, Malformed: entry})
			continue
		}
		id, err := strconv.ParseUint(strings.TrimSpace(parts[2]), 10, 64)
		if err != nil {
			out = append(out, EventOracle{Raw: entry, Malformed: entry})
			continue
		}
		out = append(out, EventOracle{
			Raw:     entry,
			Oracle:  strings.TrimSpace(parts[0]),
			Market:  strings.TrimSpace(parts[1]),
			RoundID: id,
		})
	}
	return out
}

var addressRe = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

func validateAddress(name, value string) error {
	if !addressRe.MatchString(value) {
		return fmt.Errorf("%s is not a valid address: %q", name, value)
	}
	if strings.EqualFold(value, "0x0000000000000000000000000000000000000000") {
		return fmt.Errorf("%s is the zero address", name)
	}
	return nil
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

// IsProd is deliberately not `!IsDev()`: "staging" is a third thing. It is a
// real deployment — real secret, real domain, real TLS — that a developer is
// expected to point a local frontend at.
func (c Config) IsProd() bool { return c.Env == "production" }

// isLoopbackOrigin reports whether an origin refers to the machine the browser
// is running on.
//
// Checked by host rather than by string prefix: `http://localhost.evil.com`
// starts with "http://localhost" and is not loopback at all, which is exactly
// the kind of origin an attacker would ask to have allowlisted.
func isLoopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}

	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "0.0.0.0"
}

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
