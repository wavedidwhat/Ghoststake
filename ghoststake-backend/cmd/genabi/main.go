// Command genabi copies contract ABIs out of the forge build artifacts into
// internal/abis, which the backend embeds.
//
// Copying rather than hand-writing them is the point: a mistyped event
// signature does not fail, it silently matches no logs, and a mistyped
// function signature produces a selector no contract answers to. Regenerate
// with `make gen-abis` after changing a contract.
//
// The whole ABI is copied, not just the events. The indexer only needs events,
// but the API calls views (health factor, indices, round state) and those need
// the function entries from the same document — one file per contract, one
// source of truth.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// artifact names a contract and where forge puts it.
//
// `file` exists because forge keys the output directory by the *source file*,
// not the contract: the two Chainlink interfaces are declared side by side in
// `interfaces/AggregatorV3Interface.sol`, so `IPausableOracle` does not live
// where the name alone would suggest.
type artifact struct {
	name string
	// file is the source file's basename without `.sol`. Empty means it
	// matches the contract name, which is the usual case.
	file string
	// hasEvents guards against reading the wrong artifact: a contract known
	// to declare events whose ABI has none is a path mistake, not an empty
	// contract. Interfaces legitimately have none, so it is opt-out.
	hasEvents bool
}

// Contracts the backend reads and writes.
//
// The first three are the indexer's and the API's: events to match, views to
// call. The last four are the keeper's (GHO-24) — the registry to enumerate
// markets, the oracle adapter to dry-run a settlement read against, and the
// two feed interfaces to search for the round that settlement has to name.
var contracts = []artifact{
	{name: "CollateralVault", hasEvents: true},
	{name: "BorrowLiquidityPool", hasEvents: true},
	{name: "ParimutuelRound", hasEvents: true},
	{name: "MarketRegistry", hasEvents: true},
	{name: "ChainlinkRoundOracle"},
	{name: "AggregatorV3Interface"},
	{name: "IPausableOracle", file: "AggregatorV3Interface"},
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	root, err := filepath.Abs("../ghoststake-contracts")
	if err != nil {
		return err
	}
	if _, err := os.Stat(root); err != nil {
		return fmt.Errorf("contracts not found at %s (run from ghoststake-backend, after `forge build`): %w", root, err)
	}

	for _, c := range contracts {
		dir := c.file
		if dir == "" {
			dir = c.name
		}
		src := filepath.Join(root, "out", dir+".sol", c.name+".json")
		raw, err := os.ReadFile(src)
		if err != nil {
			return fmt.Errorf("read %s: %w", src, err)
		}

		var parsed struct {
			ABI []json.RawMessage `json:"abi"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return fmt.Errorf("parse %s: %w", src, err)
		}

		// Counted by kind purely so the output says what was copied. An
		// artifact with no functions would mean the wrong file was read.
		var events, functions int
		for _, entry := range parsed.ABI {
			var kind struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(entry, &kind); err != nil {
				return err
			}
			switch kind.Type {
			case "event":
				events++
			case "function":
				functions++
			}
		}
		if c.hasEvents && events == 0 {
			return fmt.Errorf("%s: no events found", c.name)
		}
		if functions == 0 {
			return fmt.Errorf("%s: no functions found", c.name)
		}

		out, err := json.MarshalIndent(parsed.ABI, "", "  ")
		if err != nil {
			return err
		}
		dst := filepath.Join("internal", "abis", c.name+".json")
		if err := os.WriteFile(dst, append(out, '\n'), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", dst, err)
		}
		fmt.Printf("%s: %d events, %d functions -> %s\n", c.name, events, functions, dst)
	}
	return nil
}
