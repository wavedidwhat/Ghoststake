// Package ledger holds the append-only ledger domain: the entry type, the
// book names, and the port the indexer writes through.
//
// It depends on nothing else in this module. The store implements the port
// and the indexer consumes it, so neither imports the other — replacing
// Postgres or the log source touches one adapter and leaves this untouched.
package ledger

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// Kind separates books from history.
//
// A balance entry sums into an account's book. A flow entry is a record of
// something that happened and must never be summed into one — several events
// describe the same movement from different angles, and adding them together
// would count it twice.
const (
	KindBalance = "balance"
	KindFlow    = "flow"
)

// Book names: summing these gives a balance.
const (
	// Shares is vault share ownership, derived from ERC-20 Transfer.
	//
	// Transfer rather than Deposited/Withdrawn because it is the complete
	// picture: mint (from zero), burn (to zero) and user-to-user transfers
	// are one event. Shares are freely transferable here, so deriving from
	// the deposit events alone would drift the moment anyone moved shares
	// without touching the vault.
	Shares = "shares"

	// DebtScaled and SupplyScaled hold the pool's index-scaled amounts.
	//
	// This is why the pool's events carry `scaledAmount`. Interest accrues
	// per second and emits nothing, so nominal borrow and repay amounts do
	// not sum to current debt — they sum to principal movements and lose
	// every second of accrual between them. The scaled amount is invariant
	// under accrual, so it does sum. Current debt is `scaled x borrowIndex`,
	// with the index read live.
	DebtScaled   = "debt_scaled"
	SupplyScaled = "supply_scaled"
)

// Flow names: history, never summed into a balance.
const (
	Deposits     = "deposits"
	Withdrawals  = "withdrawals"
	YieldSettled = "yield_settled"
	Liquidations = "liquidations"
	LienSettled  = "lien_settled"
	BorrowFlow   = "borrow_flow"
	RepayFlow    = "repay_flow"

	// The three below were added by GHO-49, which needed a history feed and
	// found three things a user does that left no nominal record anywhere.
	//
	// Supplying to the pool and withdrawing from it were recorded only as
	// SupplyScaled balance entries, because that is the figure a balance is
	// summed from. But a scaled amount is not what the user did — it is that
	// amount divided by the supply index at the time — so a history row drawn
	// from it shows a number the user never saw. The contract emits both
	// (`Supplied(user, amount, scaledAmount)`), and the nominal half was
	// simply being discarded.
	//
	// A share transfer between two users had no flow record at all: it moved
	// the Shares book and nothing else. Mints and burns are already narrated
	// by Deposits and Withdrawals, so only the user-to-user case is recorded
	// here — the two entries a Transfer already writes cover the balance.
	SupplyFlow        = "supply_flow"
	PoolWithdrawFlow  = "pool_withdraw_flow"
	ShareTransferFlow = "share_transfer_flow"
)

// Provenance names the log a record was derived from.
//
// Shared by every kind of record this package defines, because the rule is the
// same for all of them: nothing is written that cannot be traced back to a
// specific log on a specific block, and nothing is trusted that a reorg
// rollback could not find again by block number.
type Provenance struct {
	ChainID     int64
	BlockNumber uint64
	BlockHash   string
	BlockTime   time.Time
	TxHash      string
	LogIndex    uint
	// RecordIndex disambiguates records from a single log: a transfer debits
	// one account and credits another, so the log's coordinates are not
	// unique on their own.
	RecordIndex int

	// Contract is the contract's *name* — "CollateralVault". Kept because it
	// is what a log line and an activity row read well as.
	Contract string
	// ContractAddress is which one, and it is the identity (GHO-51).
	//
	// The name was enough while there was only ever one of each. Two
	// deployments both write "CollateralVault", and a balance summed across
	// them adds an old vault's shares to a new vault's — silently, because
	// nothing in the sum knows the two are different contracts. The address
	// comes off the log itself, so it cannot disagree with the row it
	// describes.
	ContractAddress string
	EventName       string
}

// Entry is one line of the ledger, derived from one log.
type Entry struct {
	Provenance

	Kind         string
	Account      string
	Ledger       string
	Delta        *big.Int
	Counterparty string
}

// StreamName is the cursor key for a chain's single indexing stream.
//
// Named here rather than in the indexer because the API reads it too, to
// report how far behind the chain a projection is — and a reader that guesses
// the key it was written under reports "never indexed" forever.
//
// It was "lending:<chain>" while the indexer only watched the vault and the
// pool; migration 0003 renames existing cursors so that adding the market did
// not silently restart the backfill from the deploy block.
//
// Deployment-scoped since GHO-51. It was chain-scoped, and that is exactly why
// a redeployment inherited the previous deployment's cursor: same chain, same
// name, a position at the old contracts' head that sits *above* the new
// deployment's history. GHO-17 caught that with a fingerprint check that
// refuses to boot. Putting the fingerprint in the name means there is nothing
// to collide — two deployments have two cursors, and the old one survives
// beside the new rather than being overwritten or deleted.
func StreamName(chainID int64, contracts string) string {
	if contracts == "" {
		// The pre-GHO-51 name. Returned so a running deployment can find the
		// cursor it already has; see Indexer.adoptLegacyCursor.
		return fmt.Sprintf("ghoststake:%d", chainID)
	}
	return fmt.Sprintf("ghoststake:%d:%s", chainID, contracts)
}

// Cursor is how far a stream has been read.
type Cursor struct {
	Stream    string
	ChainID   int64
	LastBlock uint64
	// LastHash is what makes reorg detection possible: the next cycle
	// re-reads that block and compares. Empty means unverified.
	LastHash string
	// Contracts identifies the address set this position was reached by
	// reading. See Fingerprint. Empty means a cursor written before the
	// fingerprint existed.
	Contracts string
	// Decoders identifies the decoder that wrote the rows behind this
	// position. See DecoderVersion. Empty means a cursor written before the
	// column existed.
	Decoders string
}

// DecoderVersion names the current shape of what the decoders derive from a
// log. Bump it whenever a decoder starts producing a record it did not
// produce before.
//
// The reason this exists: adding a record to a decoder fixes every log indexed
// from that moment on and does nothing whatsoever for the ones already read.
// Nothing revisits a block the cursor has passed, so the new record simply
// does not exist for any of the protocol's history — and the gap is invisible.
// The endpoint answers, the rows are real, and a whole class of the user's
// past actions is missing with nothing to indicate it. That is the same shape
// of failure the contract fingerprint was written to catch, one layer down.
//
// A cursor stamped with an older version is replayed: rewound to the start
// block and re-read, with every insert idempotent on
// (chain, tx, log index, record index), so existing rows are untouched and
// only the newly-derived ones land. Adding records to a decoder is therefore
// safe only if they are *appended* — see the RecordIndex note on
// decodeVault's Transfer.
//
// A date-stamped name rather than a counter, so a bump is legible in a log
// line without a table to look it up in.
//
// Bumped for GHO-50 without a decoder change. The stamp means "the rows behind
// this cursor were derived by this decoder", and on the Sepolia deployment
// that became untrue: the 2026-08-27 replay rewound 22,192 blocks, recovered
// nothing because the RPC had pruned the range, and stamped itself as handled
// on the way back up — so the gap it existed to close was recorded as closed
// and would never be attempted again. Bumping makes that cursor stale a second
// time, so the replay runs once more against whatever endpoint is configured
// now. It is not free elsewhere: every healthy deployment re-reads its range
// too. That re-read is idempotent and costs one pass of eth_getLogs, which is
// the cheaper half of the trade against leaving known-missing rows missing
// forever.
const DecoderVersion = "2026-08-28-replay-after-prune"

// Fingerprint identifies a set of watched contract addresses.
//
// The stream name is chain-scoped, so a redeployment of the contracts reuses
// the previous deployment's cursor. That cursor is at the old deployment's
// head, which is almost always *past* the new deployment's start block — so
// the indexer resumes ahead of the new contracts' history and never backfills
// it. Nothing errors: it polls, finds nothing, and reports healthy while the
// tables stay empty. This is that failure made detectable.
//
// The addresses are lowercased and sorted, so the fingerprint describes which
// contracts are watched and not the order they were configured in or how they
// happened to be cased.
func Fingerprint(addresses []string) string {
	normalized := make([]string, 0, len(addresses))
	for _, a := range addresses {
		if a = strings.ToLower(strings.TrimSpace(a)); a != "" {
			normalized = append(normalized, a)
		}
	}
	sort.Strings(normalized)

	sum := sha256.Sum256([]byte(strings.Join(normalized, ",")))
	// Truncated: this is an identity check between two values we produced,
	// not a defence against anyone constructing a collision. Full width would
	// only make the log line harder to read.
	return hex.EncodeToString(sum[:8])
}

// DeploymentOf identifies a deployment from the addresses that make it up.
//
// One implementation, called by both the indexer and the API, because the two
// have to agree exactly: the indexer writes a cursor under this name and the
// API reads it back to report how far the index has got. A second normalising
// rule anywhere would make the API report "never indexed" forever against a
// perfectly healthy indexer — which is a bug that looks like an outage.
//
// Addresses are checksummed through common.HexToAddress before hashing for
// the same reason Fingerprint lowercases: it must describe the contracts, not
// how somebody happened to type them.
func DeploymentOf(vault, pool string, markets []string) string {
	all := make([]string, 0, len(markets)+2)
	for _, a := range append([]string{vault, pool}, markets...) {
		if a = strings.TrimSpace(a); a != "" {
			all = append(all, common.HexToAddress(a).Hex())
		}
	}
	return Fingerprint(all)
}

// Repository is the port the indexer writes through.
//
// Declared here, next to the domain it serves, rather than in the package
// that implements it — the indexer depends on this interface and on nothing
// about Postgres, which is what lets the whole polling loop be tested against
// an in-memory fake instead of a database.
type Repository interface {
	// Append writes one indexed range and advances the cursor atomically.
	// Implementations must be idempotent on
	// (ChainID, TxHash, LogIndex, RecordIndex).
	Append(ctx context.Context, batch Batch, cursor Cursor) error

	// LoadCursor returns a stream's position, or ok=false if never run.
	LoadCursor(ctx context.Context, stream string) (Cursor, bool, error)

	// RollbackFrom deletes every record at or above a block and rewinds the
	// cursor below it, returning how many records went.
	RollbackFrom(ctx context.Context, chainID int64, stream string, fromBlock uint64) (int64, error)

	// UnattributedRoundEvents counts round events carrying no market.
	//
	// Only ever non-zero on the first boot after the market column was added
	// (migration 0005), which could not fill it: the address is in the
	// process's configuration, not in SQL.
	UnattributedRoundEvents(ctx context.Context, chainID int64) (int64, error)

	// AttributeRoundEvents assigns a market to every round event that has
	// none, returning how many rows it touched.
	AttributeRoundEvents(ctx context.Context, chainID int64, market string) (int64, error)

	// RecordsInRange counts the records already held for a block range,
	// across both tables, inclusive of both ends.
	//
	// This exists to answer one question the indexer cannot answer from the
	// chain alone: has the RPC stopped serving logs it used to serve? A
	// re-read of a range that returns zero logs is indistinguishable from a
	// quiet range — unless we already hold rows there, in which case the node
	// is provably not serving what it served before. See
	// Indexer.assertLogsStillServed.
	RecordsInRange(ctx context.Context, chainID int64, fromBlock, toBlock uint64) (int64, error)

	// AdoptCursor renames a stream, returning false if there was nothing
	// under the old name or something already under the new one.
	//
	// Migration 0003 did this in SQL when the stream was renamed from
	// "lending:" to "ghoststake:". GHO-51's rename cannot: the new name
	// contains the contract fingerprint, and SQL has no idea which contracts a
	// process was started with.
	AdoptCursor(ctx context.Context, from, to string) (bool, error)

	// UnattributedEntries counts ledger entries carrying no contract address.
	//
	// Only ever non-zero on the first boot after migration 0009, which could
	// not fill the column: the addresses are in the process's configuration,
	// not in SQL.
	UnattributedEntries(ctx context.Context, chainID int64) (int64, error)

	// AttributeEntries stamps every entry a named contract wrote with that
	// contract's address, returning how many rows it touched.
	AttributeEntries(ctx context.Context, chainID int64, contract, address string) (int64, error)

	// ReplayFrom rewinds a cursor to just below a block WITHOUT deleting
	// anything, so the range is read again.
	//
	// Deliberately not RollbackFrom. A reorg means the rows were never
	// history and must go; a decoder change means they are correct but
	// incomplete, and deleting them would throw away good data to re-derive
	// it from an RPC that may no longer serve those logs. Re-reading over
	// them is a no-op for what exists and an insert for what does not.
	ReplayFrom(ctx context.Context, stream string, fromBlock uint64) error
}
