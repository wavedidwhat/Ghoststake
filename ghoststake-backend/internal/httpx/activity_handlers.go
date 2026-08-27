package httpx

import (
	"math/big"
	"net/http"
	"strconv"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// How many activity rows a page returns by default and at most.
//
// Larger than the round limits because a row here is one already-decoded
// database row rather than a whole round's events projected and priced, and
// the page this feeds is a scrolling list rather than a grid of cards.
const (
	defaultActivityLimit = 50
	maxActivityLimit     = 200
)

// activityJSON is one thing an address did.
//
// Amounts cross the wire as decimal strings for the reason every other
// uint256 here does: JSON numbers are IEEE-754 doubles and a wei figure
// exceeds their 53 bits of integer precision routinely, so `JSON.parse` would
// silently round the low digits of the number a user is checking.
type activityJSON struct {
	// ID is the log's coordinates, which are unique across both tables. A
	// stable key for a list, and the same string the cursor uses.
	ID string `json:"id"`

	// Type is the stable name for what happened — "deposit", "borrow",
	// "position". Mapped here rather than passed through as the contract's
	// event name so a client renders a label from one vocabulary: the vault
	// and the pool both emit "Withdrawn", meaning two entirely different
	// things, and a client switching on the raw name gets that wrong.
	Type string `json:"type"`
	// EventName and Contract are the raw provenance, kept beside the mapped
	// type so a row can always be traced to the log it came from without
	// trusting the mapping above.
	EventName string `json:"eventName"`
	Contract  string `json:"contract"`

	// Amount is nominal, as emitted, and never index-scaled — see
	// ledger.Activity. Absolute: direction is carried by Type, not by a sign
	// a reader has to notice.
	Amount string `json:"amount"`
	// Asset names what Amount is denominated in: "asset" for the underlying
	// token, "shares" for vault shares.
	Asset string `json:"asset"`

	Counterparty string `json:"counterparty,omitempty"`

	// Market, RoundID and Side are set on betting rows only.
	Market  string `json:"market,omitempty"`
	RoundID uint64 `json:"roundId,omitempty"`
	Side    string `json:"side,omitempty"`

	// Data is whatever else the event carried: a funder, a payout recipient.
	Data map[string]string `json:"data,omitempty"`

	BlockNumber uint64    `json:"blockNumber"`
	BlockTime   time.Time `json:"blockTime"`
	TxHash      string    `json:"txHash"`
	LogIndex    uint      `json:"logIndex"`
}

type activityResponse struct {
	Address string `json:"address"`
	ChainID int64  `json:"chainId"`
	// IndexedBlock is how far the indexer has read.
	//
	// Load-bearing on this page more than anywhere else. The indexer is
	// deliberately INDEXER_CONFIRMATIONS behind the head, so someone who just
	// staked and opens their history sees nothing, and "my transaction is
	// missing from my own history" reads as lost money rather than as a lag.
	// The number is here so the page can say what it is showing and as of
	// when.
	IndexedBlock uint64    `json:"indexedBlock"`
	AsOf         time.Time `json:"asOf"`

	Events []activityJSON `json:"events"`
	// NextCursor is the `?cursor=` value for the following page, or null on
	// the last one. Null rather than absent so a client can branch on it
	// without distinguishing "missing" from "empty".
	NextCursor *string `json:"nextCursor"`
}

// handleActivity lists everything one address has done, newest first.
//
// One endpoint over both tables rather than one per table: the user borrowed
// and then staked what they borrowed, and those two rows belong next to each
// other in the order they happened. Merging them client-side means every
// consumer reimplements the same sort and the same paging, and gets the
// within-block tie-breaks wrong.
func (s *Server) handleActivity(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	address, ok := pathAddress(w, r)
	if !ok {
		return
	}

	limit := clampActivityLimit(r.URL.Query().Get("limit"))

	// A malformed cursor is a 400, not a silent first page. Treating it as
	// "start from the top" answers a request for page four with page one,
	// which a client paging through a list reads as a list that never ends.
	var after *ledger.ActivityCursor
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		cursor, err := ledger.ParseActivityCursor(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid cursor")
			return
		}
		after = &cursor
	}

	events, next, err := s.store.ActivityFor(ctx, s.cfg.ChainID, address, after, limit)
	if err != nil {
		serverError(w, "read activity", err)
		return
	}

	out := make([]activityJSON, 0, len(events))
	for _, event := range events {
		out = append(out, renderActivity(event))
	}

	var nextCursor *string
	if next != nil {
		encoded := next.String()
		nextCursor = &encoded
	}

	writeJSON(w, http.StatusOK, activityResponse{
		Address:      address,
		ChainID:      s.cfg.ChainID,
		IndexedBlock: s.indexedBlock(ctx),
		AsOf:         time.Now().UTC(),
		Events:       out,
		NextCursor:   nextCursor,
	})
}

func renderActivity(a ledger.Activity) activityJSON {
	// `known` is deliberately discarded here. An unrecognised event still
	// renders, under its own name — a row that is visibly itself is
	// diagnosable, where one labelled "unknown" or dropped entirely looks
	// like corrupt data or lost money. The flag exists so a test can assert
	// nothing the decoders write reaches this state; see
	// TestEveryFlowBookHasAType.
	kind, asset, _ := activityType(a)

	// Absolute, because Type already says which way the movement went. The
	// only signed delta that reaches here is a share transfer, where the sign
	// is what distinguishes the two sides of one log — and that distinction
	// is folded into the type above rather than left in a minus sign the
	// reader has to spot.
	amount := new(big.Int).Abs(a.Amount)

	out := activityJSON{
		ID:           a.CursorOf().String(),
		Type:         kind,
		EventName:    a.EventName,
		Contract:     a.Contract,
		Amount:       amount.String(),
		Asset:        asset,
		Counterparty: a.Counterparty,
		Market:       a.Market,
		RoundID:      a.RoundID,
		Side:         a.Side,
		BlockNumber:  a.BlockNumber,
		BlockTime:    a.BlockTime,
		TxHash:       a.TxHash,
		LogIndex:     a.LogIndex,
	}
	if len(a.Data) > 0 {
		out.Data = a.Data
	}
	return out
}

// Denominations. What a row's amount is counted in, which is not something a
// reader can infer from the number.
const (
	assetUnderlying = "asset"
	assetShares     = "shares"
)

// activityType maps a row to its client-facing type and denomination.
//
// A switch over the ledger's own names rather than over the contract's event
// names, because the event names collide: the vault and the pool both emit
// "Withdrawn" and they mean different things — leaving the vault, and pulling
// supply out of the lending pool. The book the entry was filed under is what
// tells them apart, and it is what the decoder already decided.
//
// The default is deliberately the raw name rather than "unknown". A new event
// that reaches here before this switch does should show up as itself in the
// feed, which is visible and diagnosable, rather than as a row labelled
// "unknown" that looks like a bug in the data.
func activityType(a ledger.Activity) (kind, asset string, known bool) {
	if a.Source == ledger.SourceRound {
		switch a.EventName {
		case ledger.PositionTaken:
			return "position", assetUnderlying, true
		case ledger.Claimed:
			return "claim", assetUnderlying, true
		}
		return a.EventName, assetUnderlying, false
	}

	switch a.Ledger {
	case ledger.Deposits:
		return "deposit", assetUnderlying, true
	case ledger.Withdrawals:
		return "vault_withdraw", assetUnderlying, true
	case ledger.SupplyFlow:
		return "supply", assetUnderlying, true
	case ledger.PoolWithdrawFlow:
		return "pool_withdraw", assetUnderlying, true
	case ledger.BorrowFlow:
		return "borrow", assetUnderlying, true
	case ledger.RepayFlow:
		return "repay", assetUnderlying, true
	case ledger.YieldSettled:
		return "yield", assetUnderlying, true
	case ledger.LienSettled:
		return "lien_settled", assetUnderlying, true
	case ledger.Liquidations:
		return "liquidation", assetUnderlying, true
	case ledger.ShareTransferFlow:
		// The one place the stored sign decides the answer. A single Transfer
		// writes two rows, one per side, identical but for the sign — so
		// without this both sides of the same movement would render as the
		// same row and an outgoing transfer would read as an incoming one.
		if a.Amount.Sign() < 0 {
			return "share_transfer_out", assetShares, true
		}
		return "share_transfer_in", assetShares, true
	}
	return a.Ledger, assetUnderlying, false
}

func clampActivityLimit(raw string) int {
	if raw == "" {
		return defaultActivityLimit
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return defaultActivityLimit
	}
	if n > maxActivityLimit {
		return maxActivityLimit
	}
	return n
}
