package indexer

import (
	"context"
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

// Redeploying used to be a boot failure whose documented recovery was
// "DELETE FROM ledger_entries; DELETE FROM round_events; DELETE FROM
// indexer_cursor" — every user's history, thrown away to ship a contract
// change. GHO-51 makes it a new stream instead.
//
// The refusal was not wrong, and this is not a relaxation of it. It was the
// only thing standing between us and summing two deployments' books together,
// and it is replaced rather than removed: entries now carry the address that
// wrote them, and every balance query is scoped to one deployment's contracts.
func TestPreflightStartsAFreshStreamForADifferentContractSet(t *testing.T) {
	repo := newFakeRepo()
	previous := ledger.Cursor{
		Stream:    ledger.StreamName(421614, ledger.Fingerprint([]string{"0xdeadbeef"})),
		ChainID:   421614,
		LastBlock: 900,
		Contracts: ledger.Fingerprint([]string{"0xdeadbeef"}),
	}
	if err := repo.Append(context.Background(), ledger.Batch{}, previous); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}

	chain := newFakeChain(1000)
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 10, Confirmations: 1})
	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight refused a redeployment instead of starting a new stream: %v", err)
	}

	// The previous deployment's position is untouched — which is what makes
	// its rows still readable rather than orphaned at an unknown block.
	if repo.cursor.LastBlock != 900 || repo.cursor.Stream != previous.Stream {
		t.Fatalf("a redeployment moved the previous deployment's cursor: %+v", *repo.cursor)
	}

	// And this deployment reads from its own start block rather than
	// inheriting a position 890 blocks past its own history.
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(chain.ranges) == 0 {
		t.Fatal("no range was read at all")
	}
	if got := chain.ranges[0][0]; got != 10 {
		t.Fatalf("first read started at block %d, want the configured start block 10", got)
	}
}

// A cursor written before the stream carried a fingerprint is filed under a
// name nothing looks for any more. Left alone it is not lost but invisible:
// the indexer would see a stream that has never run and re-read its whole
// range to arrive exactly where it already was.
func TestPreflightAdoptsAPreDeploymentScopedCursor(t *testing.T) {
	repo := newFakeRepo()
	if err := repo.Append(context.Background(), ledger.Batch{}, ledger.Cursor{
		Stream:    ledger.StreamName(421614, ""),
		ChainID:   421614,
		LastBlock: 50,
		Contracts: "", // predates the fingerprint entirely
		// Current, so the decoder replay stays out of this test. A cursor
		// carrying a stale decoder stamp is *also* rewound by preflight, which
		// is correct and covered separately — but it would land the position
		// at StartBlock-1 here and make an adoption that worked perfectly look
		// like one that lost 41 blocks.
		Decoders: ledger.DecoderVersion,
	}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}

	ix := newTestIndexer(t, newFakeChain(1000), repo, Config{StartBlock: 10, Confirmations: 1})
	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight rejected a legacy cursor: %v", err)
	}

	if repo.cursor.Stream != ix.stream {
		t.Fatalf("legacy cursor was not adopted: still at %q, want %q", repo.cursor.Stream, ix.stream)
	}
	if repo.cursor.LastBlock != 50 {
		t.Fatalf("adoption moved the position to %d, want 50", repo.cursor.LastBlock)
	}
}

// Somebody else's cursor is not ours to take. Adopting one would put this
// deployment's stream at a block it never read, which is the exact failure the
// fingerprint check was written for.
func TestPreflightLeavesAnotherDeploymentsLegacyCursorAlone(t *testing.T) {
	repo := newFakeRepo()
	if err := repo.Append(context.Background(), ledger.Batch{}, ledger.Cursor{
		Stream:    ledger.StreamName(421614, ""),
		ChainID:   421614,
		LastBlock: 900,
		Contracts: ledger.Fingerprint([]string{"0xdeadbeef"}),
	}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}

	ix := newTestIndexer(t, newFakeChain(1000), repo, Config{StartBlock: 10, Confirmations: 1})
	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if repo.cursor.Stream == ix.stream {
		t.Fatal("adopted a cursor belonging to a different contract set")
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
