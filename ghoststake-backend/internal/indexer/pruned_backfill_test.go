package indexer

import (
	"context"
	"errors"
	"testing"

	"github.com/ethereum/go-ethereum/core/types"
)

/*
GHO-89: a range the endpoint no longer serves logs for must stop the indexer,
not be walked and recorded as empty.

GHO-50's guard compares a re-read against rows we already hold, so it cannot
see this: a range being read for the first time has none. These drive the
other comparison — the block header's own `logsBloom`, which is the chain's
record that the block had logs at all.

`head` is far above `probeDepth` in each of these, because a range close to
the head is deliberately not probed.
*/

const deepHead = 100_000

// The 2026-09-22 measurement, as a test: publicnode served headers for block
// 11,706,699 with a non-zero bloom while answering eth_getLogs for it with
// nothing, and a fresh backfill through it recorded zero logs across ~170,000
// blocks.
func TestBackfillRefusesARangeTheRPCHasPruned(t *testing.T) {
	chain := newFakeChain(deepHead)
	chain.logs = []types.Log{transferLog(t, 1000, "0x01", 0)}
	chain.pruneBelow = 90_000 // everything older is answered with an empty result
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1000, Confirmations: 5, BatchSize: 2000})

	err := ix.Step(context.Background())
	if !errors.Is(err, ErrLogsNotServed) {
		t.Fatalf("want ErrLogsNotServed, got %v", err)
	}
	// The cursor must not advance: advancing is what turns a pruned range into
	// a permanent gap nothing revisits.
	if repo.cursor != nil {
		t.Fatalf("cursor advanced over a range that served no logs: %+v", repo.cursor)
	}
	if len(repo.entries) != 0 {
		t.Fatalf("want nothing indexed, got %d entries", len(repo.entries))
	}
}

// The same range, served. The probe must not stand between a healthy endpoint
// and a backfill.
func TestBackfillProceedsWhenTheRangeIsServed(t *testing.T) {
	chain := newFakeChain(deepHead)
	chain.logs = []types.Log{transferLog(t, 1000, "0x01", 0)}
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1000, Confirmations: 5, BatchSize: 2000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(repo.entries) != 1 {
		t.Fatalf("want the block 1000 entry indexed, got %d", len(repo.entries))
	}
}

// A chain where nothing has happened proves nothing about the endpoint. An
// empty bloom is the one case the probe must stay silent on, or every local
// anvil run would refuse to index.
func TestAQuietRangeIsNotRefused(t *testing.T) {
	chain := newFakeChain(deepHead)
	chain.pruneBelow = 90_000 // and yet there is nothing to serve anyway
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1000, Confirmations: 5, BatchSize: 2000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("a range with no logs in it was refused: %v", err)
	}
	if repo.cursor == nil {
		t.Fatal("want the cursor to advance across an empty range")
	}
}

// Following the head is the hot path, and GHO-76 counted what an extra call
// per poll costs. A range within probeDepth of the head is not probed at all —
// checked here by making the probe *would* fire if it ran.
func TestFollowingTheHeadIsNotProbed(t *testing.T) {
	chain := newFakeChain(deepHead)
	start := uint64(deepHead - 50)
	chain.logs = []types.Log{transferLog(t, start, "0x01", 0)}
	chain.pruneBelow = deepHead // nothing is served, which a probe would catch
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: start, Confirmations: 5, BatchSize: 2000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("a range at the head was probed and refused: %v", err)
	}
	if repo.cursor == nil {
		t.Fatal("want the cursor to advance while following the head")
	}
}

// A false alarm the probe must not raise: some public endpoints decline a
// query with no address filter and report it as an empty result. If they
// serve our own contracts' logs for that block, they are serving us fine.
func TestAnEndpointThatOnlyAnswersFilteredQueriesIsNotRefused(t *testing.T) {
	chain := newFakeChain(deepHead)
	chain.logs = []types.Log{transferLog(t, 1000, "0x01", 0)}
	chain.unfilteredEmpty = true
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1000, Confirmations: 5, BatchSize: 2000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("refused an endpoint that serves our logs: %v", err)
	}
	if len(repo.entries) != 1 {
		t.Fatalf("want the block 1000 entry indexed, got %d", len(repo.entries))
	}
}
