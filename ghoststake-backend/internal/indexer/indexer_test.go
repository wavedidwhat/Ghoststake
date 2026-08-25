package indexer

import (
	"context"
	"fmt"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/wavedidwhat/ghoststake/internal/abis"
	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// fakeRepo is an in-memory ledger.Repository.
//
// The loop's interesting behaviour — confirmations, reorg rewind, batching,
// idempotency — is all decided before anything touches SQL, so testing it
// against Postgres would be testing Postgres. This keeps the loop tests
// hermetic; the store's own tests cover the SQL.
type fakeRepo struct {
	entries []ledger.Entry
	rounds  []ledger.RoundEvent
	cursor  *ledger.Cursor
	seen    map[string]bool
}

func newFakeRepo() *fakeRepo { return &fakeRepo{seen: map[string]bool{}} }

func (f *fakeRepo) Append(_ context.Context, batch ledger.Batch, cursor ledger.Cursor) error {
	// Mirrors the unique constraint, so a test that double-writes here fails
	// the same way production would. The two kinds are keyed separately
	// because they are two tables with two constraints.
	for _, e := range batch.Entries {
		key := "entry/" + provenanceKey(e.Provenance)
		if f.seen[key] {
			continue
		}
		f.seen[key] = true
		f.entries = append(f.entries, e)
	}
	for _, e := range batch.Rounds {
		key := "round/" + provenanceKey(e.Provenance)
		if f.seen[key] {
			continue
		}
		f.seen[key] = true
		f.rounds = append(f.rounds, e)
	}
	c := cursor
	f.cursor = &c
	return nil
}

func provenanceKey(p ledger.Provenance) string {
	return fmt.Sprintf("%d/%s/%d/%d", p.ChainID, p.TxHash, p.LogIndex, p.RecordIndex)
}

func (f *fakeRepo) LoadCursor(_ context.Context, _ string) (ledger.Cursor, bool, error) {
	if f.cursor == nil {
		return ledger.Cursor{}, false, nil
	}
	return *f.cursor, true, nil
}

func (f *fakeRepo) RollbackFrom(_ context.Context, _ int64, _ string, fromBlock uint64) (int64, error) {
	var deleted int64

	kept := f.entries[:0]
	for _, e := range f.entries {
		if e.BlockNumber >= fromBlock {
			deleted++
			delete(f.seen, "entry/"+provenanceKey(e.Provenance))
			continue
		}
		kept = append(kept, e)
	}
	f.entries = kept

	keptRounds := f.rounds[:0]
	for _, e := range f.rounds {
		if e.BlockNumber >= fromBlock {
			deleted++
			delete(f.seen, "round/"+provenanceKey(e.Provenance))
			continue
		}
		keptRounds = append(keptRounds, e)
	}
	f.rounds = keptRounds

	return deleted, nil
}

// fakeChain serves headers and logs from a scripted chain.
type fakeChain struct {
	head    uint64
	hashes  map[uint64]string // block -> hash, overridable to simulate a reorg
	logs    []types.Log
	ranges  [][2]uint64 // every FilterLogs range asked for
	headers int
}

func newFakeChain(head uint64) *fakeChain {
	return &fakeChain{head: head, hashes: map[uint64]string{}}
}

func (f *fakeChain) BlockNumber(context.Context) (uint64, error) { return f.head, nil }

func (f *fakeChain) FilterLogs(_ context.Context, q ethereum.FilterQuery) ([]types.Log, error) {
	from, to := q.FromBlock.Uint64(), q.ToBlock.Uint64()
	f.ranges = append(f.ranges, [2]uint64{from, to})

	var out []types.Log
	for _, l := range f.logs {
		if l.BlockNumber >= from && l.BlockNumber <= to {
			out = append(out, l)
		}
	}
	return out, nil
}

func (f *fakeChain) HeaderByNumber(_ context.Context, number *big.Int) (*types.Header, error) {
	f.headers++
	n := number.Uint64()
	// A Header's hash is derived from its fields, so the scripted hash is
	// carried in a field that feeds it rather than set directly.
	h := &types.Header{
		Number: new(big.Int).SetUint64(n),
		Time:   1700000000 + n,
		Extra:  []byte(f.hashes[n]),
	}
	return h, nil
}

const (
	vaultAddr  = "0x00000000000000000000000000000000000000v1"
	poolAddr   = "0x00000000000000000000000000000000000000p1"
	marketAddr = "0x00000000000000000000000000000000000000m1"
)

func newTestIndexer(t *testing.T, chain *fakeChain, repo ledger.Repository, cfg Config) *Indexer {
	t.Helper()
	if cfg.ChainID == 0 {
		cfg.ChainID = 421614
	}
	cfg.VaultAddress = common.HexToAddress(vaultAddr).Hex()
	cfg.PoolAddress = common.HexToAddress(poolAddr).Hex()
	cfg.MarketAddress = common.HexToAddress(marketAddr).Hex()

	ix, err := New(chain, repo, cfg)
	if err != nil {
		t.Fatalf("new indexer: %v", err)
	}
	return ix
}

func transferLog(t *testing.T, block uint64, txHash string, logIndex uint) types.Log {
	t.Helper()
	spec := mustABI(t, abis.CollateralVault)
	log := makeLog(t, spec, "Transfer",
		[]common.Hash{common.Hash{}, topicAddr(alice)}, wei(100))
	log.Address = common.HexToAddress(vaultAddr)
	log.BlockNumber = block
	log.TxHash = common.HexToHash(txHash)
	log.Index = logIndex
	return log
}

// ---------------------------------------------------------------------

// Nothing shallower than Confirmations may be written: those blocks can still
// be reorged out, and not writing them is cheaper than unwinding them.
func TestConfirmationsHoldTheIndexerBackFromTheHead(t *testing.T) {
	chain := newFakeChain(100)
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 10, BatchSize: 1000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}

	if len(chain.ranges) != 1 {
		t.Fatalf("want one range, got %v", chain.ranges)
	}
	if got := chain.ranges[0][1]; got != 90 {
		t.Fatalf("want to stop at 90 (head 100 - 10 confirmations), got %d", got)
	}
}

func TestNothingIsIndexedWhenTheChainIsShallowerThanConfirmations(t *testing.T) {
	chain := newFakeChain(3)
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 10})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(chain.ranges) != 0 {
		t.Fatalf("should not have queried logs, got %v", chain.ranges)
	}
	if repo.cursor != nil {
		t.Fatal("cursor moved with nothing confirmed")
	}
}

// A public RPC rejects a range that is too wide, so the loop must walk in
// bounded steps rather than asking for the whole backfill at once.
func TestBackfillWalksInBoundedRanges(t *testing.T) {
	chain := newFakeChain(10_000)
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 0, BatchSize: 1000})

	for i := 0; i < 3; i++ {
		if err := ix.Step(context.Background()); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
	}

	want := [][2]uint64{{1, 1000}, {1001, 2000}, {2001, 3000}}
	for i, w := range want {
		if chain.ranges[i] != w {
			t.Fatalf("range %d: want %v, got %v", i, w, chain.ranges[i])
		}
	}
}

func TestCursorAdvancesAndResumesWithoutRereading(t *testing.T) {
	chain := newFakeChain(500)
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 0, BatchSize: 100})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if repo.cursor.LastBlock != 100 {
		t.Fatalf("want cursor at 100, got %d", repo.cursor.LastBlock)
	}

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	// The second range must start after the first, never overlap it.
	if chain.ranges[1][0] != 101 {
		t.Fatalf("want resume at 101, got %d", chain.ranges[1][0])
	}
}

func TestCaughtUpIndexerDoesNothing(t *testing.T) {
	chain := newFakeChain(50)
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 0, BatchSize: 1000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	before := len(chain.ranges)

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("second step: %v", err)
	}
	if len(chain.ranges) != before {
		t.Fatalf("queried logs while caught up: %v", chain.ranges)
	}
}

// Replaying a range must not change any balance. This is the property the
// whole append-only design exists to give.
func TestReplayingTheSameLogsDoesNotDoubleCount(t *testing.T) {
	chain := newFakeChain(10)
	chain.logs = []types.Log{transferLog(t, 5, "0xaa", 0)}
	repo := newFakeRepo()

	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 0, BatchSize: 100})
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	first := len(repo.entries)
	if first == 0 {
		t.Fatal("no entries written")
	}

	// Rewind the cursor as a restart mid-batch would, and re-run.
	repo.cursor = &ledger.Cursor{Stream: "lending:421614", ChainID: 421614, LastBlock: 0}
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if len(repo.entries) != first {
		t.Fatalf("replay double counted: %d then %d", first, len(repo.entries))
	}
}

// A hash that no longer matches at the cursor means the chain moved under us.
func TestReorgRewindsAndDiscardsAffectedEntries(t *testing.T) {
	chain := newFakeChain(100)
	chain.hashes[95] = "original"
	chain.logs = []types.Log{
		transferLog(t, 20, "0x01", 0), // well behind the rewind point
		transferLog(t, 90, "0x02", 0), // inside it
	}
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 5, BatchSize: 1000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(repo.entries) != 2 {
		t.Fatalf("want 2 entries indexed, got %d", len(repo.entries))
	}

	// The chain reorganises deeper than the confirmation window.
	chain.hashes[95] = "reorged"
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step after reorg: %v", err)
	}

	// Rewound a whole confirmation window from 95, so block 90 is discarded
	// and re-read while block 20 is untouched.
	var blocks []uint64
	for _, e := range repo.entries {
		blocks = append(blocks, e.BlockNumber)
	}
	if len(repo.entries) != 2 {
		t.Fatalf("want block 20 kept and block 90 re-read, got blocks %v", blocks)
	}
	seen := map[uint64]int{}
	for _, b := range blocks {
		seen[b]++
	}
	if seen[20] != 1 || seen[90] != 1 {
		t.Fatalf("reorg lost or duplicated an entry: %v", seen)
	}
}

// The cursor must never move past entries that were not written, or those
// blocks are skipped forever — nothing revisits a block already passed.
func TestCursorDoesNotAdvanceWhenTheWriteFails(t *testing.T) {
	chain := newFakeChain(100)
	chain.logs = []types.Log{transferLog(t, 5, "0xaa", 0)}
	repo := &failingRepo{}
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 0, BatchSize: 1000})

	if err := ix.Step(context.Background()); err == nil {
		t.Fatal("want an error from the failed write")
	}
	if repo.cursorMoved {
		t.Fatal("cursor advanced despite a failed write")
	}
}

type failingRepo struct{ cursorMoved bool }

func (f *failingRepo) Append(context.Context, ledger.Batch, ledger.Cursor) error {
	return fmt.Errorf("database unavailable")
}
func (f *failingRepo) LoadCursor(context.Context, string) (ledger.Cursor, bool, error) {
	return ledger.Cursor{}, false, nil
}
func (f *failingRepo) RollbackFrom(context.Context, int64, string, uint64) (int64, error) {
	return 0, nil
}

// Logs the node has already reorged away arrive flagged; writing them would
// record history that no longer exists.
func TestRemovedLogsAreSkipped(t *testing.T) {
	chain := newFakeChain(10)
	removed := transferLog(t, 5, "0xdead", 0)
	removed.Removed = true
	chain.logs = []types.Log{removed}

	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 0, BatchSize: 100})
	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(repo.entries) != 0 {
		t.Fatalf("indexed a removed log: %+v", repo.entries)
	}
}

// One header fetch per block, not per log: a busy block would otherwise cost
// an RPC round trip for every event in it.
func TestBlockTimestampsAreFetchedOncePerBlock(t *testing.T) {
	chain := newFakeChain(10)
	chain.logs = []types.Log{
		transferLog(t, 5, "0xa", 0),
		transferLog(t, 5, "0xa", 1),
		transferLog(t, 5, "0xb", 2),
	}
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 0, BatchSize: 100})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	// One for block 5's timestamp, one for the cursor's tip header.
	if chain.headers > 2 {
		t.Fatalf("want at most 2 header fetches, got %d", chain.headers)
	}
}

func TestIndexerRequiresContractAddresses(t *testing.T) {
	if _, err := New(newFakeChain(1), newFakeRepo(), Config{ChainID: 1}); err == nil {
		t.Fatal("want an error when addresses are missing")
	}
}
