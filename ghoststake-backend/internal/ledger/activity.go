package ledger

import (
	"fmt"
	"math/big"
	"strconv"
	"strings"
)

// Activity is one thing an address did, ready to be listed.
//
// # Why this is not two lists
//
// An address's history lives in two tables. The lending side is in
// ledger_entries; the betting side is in round_events. They are separate
// because their shapes are (see RoundEvent), not because they are separate
// subjects — the user borrowed, then staked what they borrowed, and reading
// those from two endpoints and interleaving them client-side means every
// consumer reimplements the same merge and gets the tie-breaks wrong.
//
// The merge key is the log's own coordinates: (block, log index, record
// index). Not the timestamp — several logs share a block, so a timestamp sort
// is not a total order and a page boundary landing inside a block would
// repeat or drop rows depending on which way the tie fell that time.
//
// # Why nothing here is a balance
//
// Only flow entries and round events reach this type. Never a balance entry,
// and the query enforces it rather than trusting a caller.
//
// The reason is DebtScaled and SupplyScaled. Those hold index-scaled amounts,
// which is what makes them summable into a live balance — and exactly what
// makes them wrong as history. A scaled amount is the nominal one divided by
// the index at the time, so rendering it as "you supplied 97.3" reports a
// number the user never saw, and converting it back with today's index gives
// a completed transaction whose amount changes on every reload. A finished
// action whose figure moves destroys confidence in a history page faster than
// an outright error does, because there is nothing to report.
//
// So every amount on this type is nominal, at the time, as emitted. GHO-49
// added SupplyFlow, PoolWithdrawFlow and ShareTransferFlow precisely so that
// the three actions with no nominal record could be listed without reaching
// for a scaled one.
type Activity struct {
	Provenance

	// Source is which table the row came from: SourceLedger or SourceRound.
	Source string

	// Ledger is the flow name for a lending row, empty for a round row.
	Ledger string
	// Amount is nominal and, for a share transfer, signed by direction.
	Amount *big.Int
	// Counterparty is the other party where the event named one.
	Counterparty string

	// Market, RoundID and Side are set on round rows only.
	Market  string
	RoundID uint64
	Side    string

	Data map[string]string
}

const (
	SourceLedger = "ledger"
	SourceRound  = "round"
)

// ActivityCursor is a position in the merged stream.
//
// The log's coordinates rather than an offset. The indexer writes to the head
// continuously, so an OFFSET page shifts under anyone reading it: rows arrive
// above the window between two requests and the reader sees the row they just
// read a second time, or never sees the one that got pushed past the
// boundary. Keyed on the row itself, a page means "everything strictly older
// than this log", which is stable no matter what arrives while it is read.
type ActivityCursor struct {
	BlockNumber uint64
	LogIndex    uint
	RecordIndex int
}

// String encodes a cursor for a URL: "<block>-<logIndex>-<recordIndex>".
//
// Readable rather than opaque. The values are already public — they are
// coordinates into a public chain — so encoding them would buy nothing but a
// support call that cannot be diagnosed from the URL.
func (c ActivityCursor) String() string {
	return fmt.Sprintf("%d-%d-%d", c.BlockNumber, c.LogIndex, c.RecordIndex)
}

// ParseActivityCursor reads a cursor back, refusing anything malformed.
//
// Refused rather than ignored. A cursor that fails to parse and is silently
// treated as "start from the top" answers a paging request with page one,
// which a client reads as a list that loops forever.
func ParseActivityCursor(raw string) (ActivityCursor, error) {
	parts := strings.Split(strings.TrimSpace(raw), "-")
	if len(parts) != 3 {
		return ActivityCursor{}, fmt.Errorf("cursor %q is not block-logIndex-recordIndex", raw)
	}
	block, err := strconv.ParseUint(parts[0], 10, 64)
	if err != nil {
		return ActivityCursor{}, fmt.Errorf("cursor %q: bad block: %w", raw, err)
	}
	logIndex, err := strconv.ParseUint(parts[1], 10, 32)
	if err != nil {
		return ActivityCursor{}, fmt.Errorf("cursor %q: bad log index: %w", raw, err)
	}
	record, err := strconv.ParseUint(parts[2], 10, 16)
	if err != nil {
		return ActivityCursor{}, fmt.Errorf("cursor %q: bad record index: %w", raw, err)
	}
	return ActivityCursor{
		BlockNumber: block,
		LogIndex:    uint(logIndex),
		RecordIndex: int(record),
	}, nil
}

// CursorOf is the position of a row, for handing back as the next page's
// starting point.
func (a Activity) CursorOf() ActivityCursor {
	return ActivityCursor{
		BlockNumber: a.BlockNumber,
		LogIndex:    a.LogIndex,
		RecordIndex: a.RecordIndex,
	}
}
