// Package abis embeds the contract ABIs the backend needs, generated from the
// forge build artifacts by `make gen-abis`.
//
// One copy, shared by both consumers. The indexer matches event topics against
// these; the chain package builds `eth_call` payloads from the same files. A
// second, drifting copy is exactly the failure this package exists to prevent:
// a mistyped event signature matches no logs and a mistyped function selector
// reverts, and neither says why.
//
// The files hold the whole ABI, functions included, not just events. Events
// alone were enough while the backend only read logs; GHO-17 calls views.
package abis

import (
	"embed"
	"fmt"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

//go:embed *.json
var files embed.FS

// Contract names, matching the file names and the Solidity contracts.
const (
	CollateralVault     = "CollateralVault"
	BorrowLiquidityPool = "BorrowLiquidityPool"
	ParimutuelRound     = "ParimutuelRound"

	// The keeper's four (GHO-24). MarketRegistry enumerates the markets to
	// drive; ChainlinkRoundOracle is dry-run before a settlement is sent;
	// AggregatorV3Interface is searched for the feed round that settlement
	// must name; IPausableOracle is the advisory flag that only Robinhood
	// Chain's Stock Token feeds implement, which is how a market that
	// follows a trading session is told apart from one that runs 24/7.
	MarketRegistry        = "MarketRegistry"
	ChainlinkRoundOracle  = "ChainlinkRoundOracle"
	AggregatorV3Interface = "AggregatorV3Interface"
	IPausableOracle       = "IPausableOracle"
)

var (
	mu     sync.Mutex
	parsed = map[string]abi.ABI{}
)

// Load returns a parsed ABI by contract name.
//
// Cached: parsing is not free and every caller wants the same handful of
// documents. The cache is keyed by name and the files are embedded, so there
// is nothing to invalidate.
func Load(name string) (abi.ABI, error) {
	mu.Lock()
	defer mu.Unlock()

	if a, ok := parsed[name]; ok {
		return a, nil
	}
	raw, err := files.ReadFile(name + ".json")
	if err != nil {
		return abi.ABI{}, fmt.Errorf("abis: no embedded abi for %q (run `make gen-abis`): %w", name, err)
	}
	a, err := abi.JSON(strings.NewReader(string(raw)))
	if err != nil {
		return abi.ABI{}, fmt.Errorf("abis: parse %s: %w", name, err)
	}
	parsed[name] = a
	return a, nil
}

// MustLoad is Load for package-level initialisation, where a missing ABI is a
// build-time mistake rather than a runtime condition.
func MustLoad(name string) abi.ABI {
	a, err := Load(name)
	if err != nil {
		panic(err)
	}
	return a
}
