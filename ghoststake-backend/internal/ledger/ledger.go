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

	Contract  string
	EventName string
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
func StreamName(chainID int64) string { return fmt.Sprintf("ghoststake:%d", chainID) }

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
const DecoderVersion = "2026-08-27-nominal-flows"

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
