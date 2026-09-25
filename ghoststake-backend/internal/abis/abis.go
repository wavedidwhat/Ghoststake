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

	// EventRoundOracle is the other shape an oracle comes in (GHO-80): a
	// question settled by a bonded claim rather than a price feed. Read by
	// the keeper, which has to drive such a market without a feed, and by
	// the indexer, which carries its lifecycle to the app.
	EventRoundOracle = "EventRoundOracle"

	// ParimutuelRoundPreStrike is the shape `openRound` had before GHO-79:
	// three timestamps and no strike. Markets deployed then are still live,
	// still hold positions and are still driven — see keeper.SupportsStrikeAtOpen.
	//
	// The one hand-written file in this package, and it has to be. Every
	// other ABI here is copied from a forge artifact precisely so it cannot
	// drift from the source, but this source no longer exists: GHO-79
	// replaced `openRound` in place, so there is nothing left for
	// `make gen-abis` to copy. The alternative — keeping a dead copy of the
	// contract compiling in the repo purely to generate four lines of JSON —
	// is worse. What keeps it honest instead is a test: the selector this
	// file produces is checked against one computed from the signature by
	// keccak, so a typo fails in CI rather than on a market tick.
	//
	// It holds only `openRound`. Everything else the keeper calls on a
	// market is identical in both shapes and is read through
	// ParimutuelRound; a second full copy would be the drift this package
	// exists to prevent.
	ParimutuelRoundPreStrike = "ParimutuelRoundPreStrike"

	// DemoPriceFeed is the operator-published aggregator a mirrored market
	// settles against (GHO-21). Written to, not just read: `pushAt` is the
	// only state-changing call the backend makes outside a market.
	DemoPriceFeed = "DemoPriceFeed"
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
