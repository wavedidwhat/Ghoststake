package indexer

import (
	"context"
	"strings"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// A fresh database has no cursor to disagree with.
func TestPreflightAllowsAFirstRun(t *testing.T) {
	ix := newTestIndexer(t, newFakeChain(100), newFakeRepo(), Config{StartBlock: 1, Confirmations: 1})

	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight on an empty repo: %v", err)
	}
}

// The ordinary restart: same contracts, resume where we left off.
func TestPreflightAllowsTheSameContracts(t *testing.T) {
	repo := newFakeRepo()
	ix := newTestIndexer(t, newFakeChain(100), repo, Config{StartBlock: 1, Confirmations: 1})

	// One cycle, so the cursor is written with this process's fingerprint.
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}

	restarted := newTestIndexer(t, newFakeChain(100), repo, Config{StartBlock: 1, Confirmations: 1})
	if err := restarted.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight after a clean restart: %v", err)
	}
}

// The bug this exists for: contracts redeployed, cursor left at the old
// deployment's head. Resuming would skip the new deployment's history
// entirely and report healthy while indexing nothing.
func TestPreflightRefusesADifferentContractSet(t *testing.T) {
	repo := newFakeRepo()
	// A cursor from some other deployment, already past our start block.
	if err := repo.Append(context.Background(), ledger.Batch{}, ledger.Cursor{
		Stream:    ledger.StreamName(421614),
		ChainID:   421614,
		LastBlock: 900,
		Contracts: ledger.Fingerprint([]string{"0xdeadbeef"}),
	}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}

	ix := newTestIndexer(t, newFakeChain(1000), repo, Config{StartBlock: 10, Confirmations: 1})

	err := ix.Preflight(context.Background())
	if err == nil {
		t.Fatal("preflight accepted a cursor built from different contracts")
	}
	// The operator has to be able to act on this without reading the source,
	// so the message must carry both positions and the way out.
	for _, want := range []string{"redeployed", "900", "10", "DELETE FROM ledger_entries"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error message missing %q:\n%v", want, err)
		}
	}
}

// A cursor written before the fingerprint column existed has nothing to
// compare against. Refusing would break every running deployment on upgrade,
// so it is adopted — the one assumption in here.
func TestPreflightAdoptsALegacyCursor(t *testing.T) {
	repo := newFakeRepo()
	if err := repo.Append(context.Background(), ledger.Batch{}, ledger.Cursor{
		Stream:    ledger.StreamName(421614),
		ChainID:   421614,
		LastBlock: 50,
		Contracts: "", // pre-migration
	}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}

	ix := newTestIndexer(t, newFakeChain(1000), repo, Config{StartBlock: 10, Confirmations: 1})
	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight rejected a legacy cursor: %v", err)
	}
}
