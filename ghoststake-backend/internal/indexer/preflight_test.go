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

// ---------------------------------------------------------------------
// Decoder version replay (GHO-49)
// ---------------------------------------------------------------------

// The failure this removes: a decoder that starts deriving a new record fixes
// every log read after the upgrade and does nothing for the ones already
// read. History is then complete from the deploy onward and missing before
// it, with nothing anywhere to say so.
func TestPreflightReplaysWhenTheDecoderVersionChanged(t *testing.T) {
	repo := newFakeRepo()
	cfg := Config{StartBlock: 10, Confirmations: 1}

	// A cursor written by an older build: right contracts, older decoder.
	ix := newTestIndexer(t, newFakeChain(100), repo, cfg)
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	repo.cursor.Decoders = "an-older-decoder"

	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if len(repo.replayedFrom) != 1 || repo.replayedFrom[0] != cfg.StartBlock {
		t.Fatalf("want one replay from the start block, got %v", repo.replayedFrom)
	}
	// Rewound, not emptied. The rows are correct and incomplete, not wrong —
	// deleting them would throw away good data to re-derive it from an RPC
	// that may no longer serve those logs, so the cursor moves and the tables
	// do not.
	if repo.cursor.LastBlock != cfg.StartBlock-1 {
		t.Fatalf("cursor is at %d, want %d", repo.cursor.LastBlock, cfg.StartBlock-1)
	}
	if repo.cursor.LastHash != "" {
		// A stale hash would make the next reorg check compare against a
		// block the cursor no longer sits on, and see a false match.
		t.Fatalf("the replay left a stale block hash: %q", repo.cursor.LastHash)
	}
}

// The stamp is written by the transaction that advances the cursor, so one
// committed range clears the condition. A replay on every boot would mean an
// indexer that never catches up.
func TestTheReplayHappensOnceAndNotOnEveryBoot(t *testing.T) {
	repo := newFakeRepo()
	cfg := Config{StartBlock: 10, Confirmations: 1}

	ix := newTestIndexer(t, newFakeChain(100), repo, cfg)
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	repo.cursor.Decoders = "an-older-decoder"

	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("first preflight: %v", err)
	}
	// One cycle of the replay, which stamps the current version.
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step during replay: %v", err)
	}

	restarted := newTestIndexer(t, newFakeChain(100), repo, cfg)
	if err := restarted.Preflight(context.Background()); err != nil {
		t.Fatalf("second preflight: %v", err)
	}
	if len(repo.replayedFrom) != 1 {
		t.Fatalf("replayed %d times, want once: %v", len(repo.replayedFrom), repo.replayedFrom)
	}
}

// An ordinary restart on the current decoder must not re-read anything.
func TestNoReplayWhenTheDecoderIsUnchanged(t *testing.T) {
	repo := newFakeRepo()
	cfg := Config{StartBlock: 10, Confirmations: 1}

	ix := newTestIndexer(t, newFakeChain(100), repo, cfg)
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if got := repo.cursor.Decoders; got != ledger.DecoderVersion {
		t.Fatalf("the cursor was stamped %q, want %q", got, ledger.DecoderVersion)
	}

	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if len(repo.replayedFrom) != 0 {
		t.Fatalf("a clean restart replayed: %v", repo.replayedFrom)
	}
}

// The escape hatch keeps the gap knowingly rather than by accident, for a
// deployment where re-reading the range is genuinely not worth it.
func TestSkipDecoderReplayDeclinesTheReRead(t *testing.T) {
	repo := newFakeRepo()
	cfg := Config{StartBlock: 10, Confirmations: 1}

	ix := newTestIndexer(t, newFakeChain(100), repo, cfg)
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	repo.cursor.Decoders = "an-older-decoder"

	skipping := newTestIndexer(t, newFakeChain(100), repo,
		Config{StartBlock: 10, Confirmations: 1, SkipDecoderReplay: true})
	if err := skipping.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if len(repo.replayedFrom) != 0 {
		t.Fatalf("replayed despite the skip flag: %v", repo.replayedFrom)
	}
}

// A first run has nothing to re-read, and asking for one would rewind a
// cursor that is already at the start.
func TestNoReplayOnAFirstRun(t *testing.T) {
	repo := newFakeRepo()
	ix := newTestIndexer(t, newFakeChain(100), repo, Config{StartBlock: 10, Confirmations: 1})

	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if len(repo.replayedFrom) != 0 {
		t.Fatalf("a first run replayed: %v", repo.replayedFrom)
	}
}
