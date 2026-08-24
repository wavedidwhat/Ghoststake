// Command genabi extracts event definitions from the forge build artifacts
// into internal/indexer/abis, which the indexer embeds.
//
// Copying rather than hand-writing them is the point: a mistyped event
// signature does not fail, it silently matches no logs, and the indexer would
// run forever writing nothing. Regenerate with `make gen-abis` after changing
// a contract.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// Only the contracts the indexer watches. Rounds are GHO-17.
var contracts = []string{"CollateralVault", "BorrowLiquidityPool"}

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

		events := make([]json.RawMessage, 0, len(artifact.ABI))
		for _, entry := range artifact.ABI {
			var kind struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(entry, &kind); err != nil {
				return err
			}
			if kind.Type == "event" {
				events = append(events, entry)
			}
		}
		if len(events) == 0 {
			return fmt.Errorf("%s: no events found", name)
		}

		out, err := json.MarshalIndent(events, "", "  ")
		if err != nil {
			return err
		}
		dst := filepath.Join("internal", "indexer", "abis", name+".json")
		if err := os.WriteFile(dst, append(out, '\n'), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", dst, err)
		}
		fmt.Printf("%s: %d events -> %s\n", name, len(events), dst)
	}
	return nil
}
