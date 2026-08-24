// Package ledger holds the append-only ledger domain: the entry type, the
// book names, and the port the indexer writes through.
//
// It depends on nothing else in this module. The store implements the port
// and the indexer consumes it, so neither imports the other — replacing
// Postgres or the log source touches one adapter and leaves this untouched.
package ledger

import (
	"context"
	"math/big"
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
)

// Entry is one line of the ledger, derived from one log.
type Entry struct {
	// Provenance: every entry names the log it came from.
	ChainID     int64
	BlockNumber uint64
	BlockHash   string
	BlockTime   time.Time
	TxHash      string
	LogIndex    uint
	// EntryIndex disambiguates entries from a single log: a transfer debits
	// one account and credits another, so the log's coordinates are not
	// unique on their own.
	EntryIndex int

	Contract  string
	EventName string

	Kind         string
	Account      string
	Ledger       string
	Delta        *big.Int
	Counterparty string
}

// Cursor is how far a stream has been read.
type Cursor struct {
	Stream    string
	ChainID   int64
	LastBlock uint64
	// LastHash is what makes reorg detection possible: the next cycle
	// re-reads that block and compares. Empty means unverified.
	LastHash string
}

// Repository is the port the indexer writes through.
//
// Declared here, next to the domain it serves, rather than in the package
// that implements it — the indexer depends on this interface and on nothing
// about Postgres, which is what lets the whole polling loop be tested against
// an in-memory fake instead of a database.
type Repository interface {
	// AppendEntries writes entries and advances the cursor atomically.
	// Implementations must be idempotent on
	// (ChainID, TxHash, LogIndex, EntryIndex).
	AppendEntries(ctx context.Context, entries []Entry, cursor Cursor) error

	// LoadCursor returns a stream's position, or ok=false if never run.
	LoadCursor(ctx context.Context, stream string) (Cursor, bool, error)

	// RollbackFrom deletes entries at or above a block and rewinds the
	// cursor below it, returning how many entries went.
	RollbackFrom(ctx context.Context, chainID int64, stream string, fromBlock uint64) (int64, error)
}
