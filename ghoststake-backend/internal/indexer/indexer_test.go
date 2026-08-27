package indexer

import (
	"context"
	"fmt"
	"math/big"
	"strings"
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
	// replayedFrom records every block a decoder-version replay rewound to,
	// so a test can assert it happened once and not on every boot.
	replayedFrom []uint64
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

// UnattributedRoundEvents and AttributeRoundEvents back the preflight repair
// for rows indexed before the market column existed. The fake counts and
// rewrites its own slice, so the test exercises the decision rather than the
// SQL.
func (f *fakeRepo) UnattributedRoundEvents(_ context.Context, chainID int64) (int64, error) {
	var n int64
	for _, e := range f.rounds {
		if e.ChainID == chainID && e.Market == "" {
			n++
		}
	}
	return n, nil
}

func (f *fakeRepo) AttributeRoundEvents(_ context.Context, chainID int64, market string) (int64, error) {
	var n int64
	for i := range f.rounds {
		if f.rounds[i].ChainID == chainID && f.rounds[i].Market == "" {
			f.rounds[i].Market = market
			n++
		}
	}
	return n, nil
}

// RecordsInRange counts what the fake already holds, so the pruned-RPC guard
// is exercised against real row counts rather than a stub that always says
// zero — a fake returning zero would make the guard untestably inert.
func (f *fakeRepo) RecordsInRange(_ context.Context, chainID int64, from, to uint64) (int64, error) {
	var n int64
	for _, e := range f.entries {
		if e.ChainID == chainID && e.BlockNumber >= from && e.BlockNumber <= to {
			n++
		}
	}
	for _, e := range f.rounds {
		if e.ChainID == chainID && e.BlockNumber >= from && e.BlockNumber <= to {
			n++
		}
	}
	return n, nil
}

// ReplayFrom rewinds without deleting, which is the whole distinction from
// RollbackFrom — so the fake keeps its `seen` map intact. A fake that cleared
// it would let a replay re-insert every row, and the test would then prove
// idempotency that production does not have.
func (f *fakeRepo) ReplayFrom(_ context.Context, stream string, fromBlock uint64) error {
	f.replayedFrom = append(f.replayedFrom, fromBlock)
	if f.cursor != nil {
		f.cursor.LastBlock = fromBlock - 1
		f.cursor.LastHash = ""
	}
	return nil
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
	// pruneBelow reproduces what a public endpoint does to old blocks: the
	// header is still served, the logs behind it are not, and the omission
	// comes back as an empty result rather than an error. Zero means the node
	// serves everything.
	pruneBelow uint64
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
		if l.BlockNumber < f.pruneBelow {
			continue
		}
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
	// Valid hex, and distinct.
	//
	// These read "v1", "p1", "m1" until GHO-43 — which are not hex digits, so
	// common.HexToAddress silently returned the zero address for all three and
	// every log in every test here routed to whichever spec was registered
	// first. The mnemonics survive in hex: 0f for the vault, 900 for the pool,
	// 3a for the market.
	vaultAddr  = "0x000000000000000000000000000000000000000f"
	poolAddr   = "0x0000000000000000000000000000000000000900"
	marketAddr = "0x000000000000000000000000000000000000003a"
)

func newTestIndexer(t *testing.T, chain *fakeChain, repo ledger.Repository, cfg Config) *Indexer {
	t.Helper()
	if cfg.ChainID == 0 {
		cfg.ChainID = 421614
	}
	cfg.VaultAddress = common.HexToAddress(vaultAddr).Hex()
	cfg.PoolAddress = common.HexToAddress(poolAddr).Hex()
	return newTestIndexerWithMarkets(t, chain, repo, cfg,
		[]string{common.HexToAddress(marketAddr).Hex()})
}

// newTestIndexerWithMarkets is newTestIndexer with the market list named, for
// the tests that are about there being more than one.
func newTestIndexerWithMarkets(t *testing.T, chain *fakeChain, repo ledger.Repository, cfg Config, markets []string) *Indexer {
	t.Helper()
	if cfg.ChainID == 0 {
		cfg.ChainID = 421614
	}
	cfg.VaultAddress = common.HexToAddress(vaultAddr).Hex()
	cfg.PoolAddress = common.HexToAddress(poolAddr).Hex()
	cfg.MarketAddresses = markets

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
func (f *failingRepo) UnattributedRoundEvents(context.Context, int64) (int64, error) {
	return 0, nil
}
func (f *failingRepo) AttributeRoundEvents(context.Context, int64, string) (int64, error) {
	return 0, nil
}
func (f *failingRepo) ReplayFrom(context.Context, string, uint64) error { return nil }
func (f *failingRepo) RecordsInRange(context.Context, int64, uint64, uint64) (int64, error) {
	return 0, nil
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

// A rollback against an RPC that has pruned the range must refuse rather than
// delete. This is GHO-50: the destructive half of the re-read paths, on the
// infrastructure the deployment actually runs against.
func TestReorgRefusesToDeleteWhatTheRPCNoLongerServes(t *testing.T) {
	chain := newFakeChain(100)
	chain.hashes[95] = "original"
	chain.logs = []types.Log{
		transferLog(t, 20, "0x01", 0),
		transferLog(t, 90, "0x02", 0),
	}
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 5, BatchSize: 1000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(repo.entries) != 2 {
		t.Fatalf("want 2 entries indexed, got %d", len(repo.entries))
	}
	before := *repo.cursor

	// The node prunes its log index behind us, and the chain reorganises. The
	// first is what makes the second unrecoverable.
	chain.pruneBelow = 96
	chain.hashes[95] = "reorged"

	err := ix.Step(context.Background())
	if err == nil {
		t.Fatal("want a refusal when the range to be deleted can no longer be re-read, got none")
	}
	if !strings.Contains(err.Error(), "not serving what it served before") {
		t.Fatalf("error does not name the cause: %v", err)
	}

	// The whole point: the rows are still here.
	if len(repo.entries) != 2 {
		t.Fatalf("refusing to roll back still lost entries: have %d, want 2", len(repo.entries))
	}
	if *repo.cursor != before {
		t.Fatalf("cursor moved on a refused rollback: %+v -> %+v", before, *repo.cursor)
	}
}

// The guard must not fire on a range that is simply quiet. A rewind over
// blocks we hold nothing for tells us nothing about the RPC, and refusing
// there would stall every indexer whose reorg landed in an empty stretch.
func TestReorgProceedsWhenTheRewoundRangeHoldsNothing(t *testing.T) {
	chain := newFakeChain(100)
	chain.hashes[95] = "original"
	// Well below the rewind point, so blocks 90-95 hold nothing.
	chain.logs = []types.Log{transferLog(t, 20, "0x01", 0)}
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 5, BatchSize: 1000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	chain.pruneBelow = 96 // would trip the guard if it looked at logs alone
	chain.hashes[95] = "reorged"

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("quiet range refused a rollback it had no evidence against: %v", err)
	}
	if len(repo.entries) != 1 {
		t.Fatalf("want the block 20 entry kept, got %d entries", len(repo.entries))
	}
}

// The replay path is not destructive, but a replay that recovers nothing is
// worse than none: the cursor stamps the new decoder version on its way back
// up, so the gap is recorded as handled and never retried. Refusing at
// preflight leaves it unstamped and retryable.
func TestDecoderReplayRefusesAgainstAPrunedRPC(t *testing.T) {
	chain := newFakeChain(100)
	chain.logs = []types.Log{transferLog(t, 20, "0x01", 0)}
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 5, BatchSize: 1000})

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	// A decoder bump, against a node that has since pruned the indexed range.
	repo.cursor.Decoders = "older-decoders"
	chain.pruneBelow = 96

	err := ix.Preflight(context.Background())
	if err == nil {
		t.Fatal("want preflight to refuse a replay that would recover nothing, got none")
	}
	if !strings.Contains(err.Error(), "decoder replay") {
		t.Fatalf("error does not name the path: %v", err)
	}
	if len(repo.replayedFrom) != 0 {
		t.Fatalf("rewound the cursor for a replay it had already refused: %v", repo.replayedFrom)
	}
	if repo.cursor.Decoders == ledger.DecoderVersion {
		t.Fatal("stamped the new decoder version without replaying: the gap is now recorded as handled")
	}
}

// The replay path hands the guard the entire indexed history, which on the
// deployment is tens of thousands of blocks. Probing that in one eth_getLogs
// is the request width BatchSize exists to avoid, and a public RPC rejecting
// it would refuse the boot of a perfectly healthy indexer.
//
// It also has to probe the OLDEST range it holds rows in, not the newest:
// pruning takes old blocks first, so a check that looked at recent history
// would be served happily and pass while the range it is about to re-read is
// gone.
func TestPrunedRPCGuardProbesTheOldestWindowInBatchSizedRequests(t *testing.T) {
	const batch = 1000
	chain := newFakeChain(5010)
	chain.logs = []types.Log{
		transferLog(t, 20, "0x01", 0),   // oldest, and the one that gets pruned
		transferLog(t, 4500, "0x02", 0), // recent, still served
	}
	repo := newFakeRepo()
	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 5, BatchSize: batch})

	for i := 0; i < 10; i++ {
		if err := ix.Step(context.Background()); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
	}
	if len(repo.entries) != 2 {
		t.Fatalf("want both entries indexed, got %d", len(repo.entries))
	}

	// The node has pruned everything below block 1000. Block 4500 is still
	// served, so a guard looking at recent history would see nothing wrong.
	chain.pruneBelow = 1000
	repo.cursor.Decoders = "older-decoders"
	chain.ranges = nil

	err := ix.Preflight(context.Background())
	if err == nil {
		t.Fatal("want a refusal: the oldest indexed range is no longer served")
	}
	if !strings.Contains(err.Error(), "blocks 1-1000") {
		t.Fatalf("guard did not report the oldest window as the pruned one: %v", err)
	}

	for _, r := range chain.ranges {
		if width := r[1] - r[0] + 1; width > batch {
			t.Fatalf("asked for %d blocks in one eth_getLogs, over the %d batch size: %v",
				width, batch, chain.ranges)
		}
	}
}
