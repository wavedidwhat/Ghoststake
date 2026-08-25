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

// Contracts the backend reads: the indexer watches all three, and the API
// calls views on all three.
var contracts = []string{"CollateralVault", "BorrowLiquidityPool", "ParimutuelRound"}

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

	for _, name := range contracts {
		src := filepath.Join(root, "out", name+".sol", name+".json")
		raw, err := os.ReadFile(src)
		if err != nil {
			return fmt.Errorf("read %s: %w", src, err)
		}

		var artifact struct {
			ABI []json.RawMessage `json:"abi"`
		}
		if err := json.Unmarshal(raw, &artifact); err != nil {
			return fmt.Errorf("parse %s: %w", src, err)
		}

		// Counted by kind purely so the output says what was copied. An
		// artifact with no events would mean the wrong file was read.
		var events, functions int
		for _, entry := range artifact.ABI {
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
		if events == 0 {
			return fmt.Errorf("%s: no events found", name)
		}

		out, err := json.MarshalIndent(artifact.ABI, "", "  ")
		if err != nil {
			return err
		}
		dst := filepath.Join("internal", "abis", name+".json")
		if err := os.WriteFile(dst, append(out, '\n'), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", dst, err)
		}
		fmt.Printf("%s: %d events, %d functions -> %s\n", name, events, functions, dst)
	}
	return nil
}
