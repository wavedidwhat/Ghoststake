package httpx

import (
	"math/big"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

func lendingRow(book string, delta int64) ledger.Activity {
	return ledger.Activity{
		Provenance: ledger.Provenance{
			ChainID: 421614, BlockNumber: 9_421_133, LogIndex: 4, RecordIndex: 0,
			TxHash: "0xtx", Contract: "CollateralVault", EventName: "Deposited",
		},
		Source: ledger.SourceLedger,
		Ledger: book,
		Amount: big.NewInt(delta),
	}
}

// The vault and the pool both emit "Withdrawn" and they mean entirely
// different things: leaving the vault, and pulling supply out of the lending
// pool. Anything switching on the event name renders one as the other, and
// the row looks perfectly plausible either way.
func TestTheTwoWithdrawnEventsGetDifferentTypes(t *testing.T) {
	vault := lendingRow(ledger.Withdrawals, 300)
	vault.EventName = "Withdrawn"
	pool := lendingRow(ledger.PoolWithdrawFlow, 300)
	pool.EventName = "Withdrawn"
	pool.Contract = "BorrowLiquidityPool"

	if got := renderActivity(vault).Type; got != "vault_withdraw" {
		t.Fatalf("vault withdraw typed as %q", got)
	}
	if got := renderActivity(pool).Type; got != "pool_withdraw" {
		t.Fatalf("pool withdraw typed as %q", got)
	}
}

// One Transfer writes two rows that differ only in sign. Without reading the
// sign both sides render identically, and an outgoing transfer reads as money
// arriving.
func TestShareTransferDirectionComesFromTheSign(t *testing.T) {
	out := renderActivity(lendingRow(ledger.ShareTransferFlow, -500))
	in := renderActivity(lendingRow(ledger.ShareTransferFlow, 500))

	if out.Type != "share_transfer_out" || in.Type != "share_transfer_in" {
		t.Fatalf("directions crossed: %q and %q", out.Type, in.Type)
	}
	// Absolute on the wire. The sign has already been read into the type, and
	// a "-500" beside a label that says "sent" invites the reader to subtract
	// it twice.
	if out.Amount != "500" {
		t.Fatalf("want an absolute amount, got %q", out.Amount)
	}
	if out.Asset != assetShares || in.Asset != assetShares {
		t.Fatalf("share transfers must be denominated in shares: %q / %q", out.Asset, in.Asset)
	}
}

// Everything else is denominated in the underlying token, and a client that
// has to guess gets it wrong exactly once — on the row where it matters.
func TestNonShareRowsAreDenominatedInTheAsset(t *testing.T) {
	for _, book := range []string{
		ledger.Deposits, ledger.Withdrawals, ledger.SupplyFlow, ledger.PoolWithdrawFlow,
		ledger.BorrowFlow, ledger.RepayFlow, ledger.YieldSettled, ledger.LienSettled,
		ledger.Liquidations,
	} {
		if got := renderActivity(lendingRow(book, 1)).Asset; got != assetUnderlying {
			t.Fatalf("%s is denominated in %q", book, got)
		}
	}
}

// Every flow the decoders write must have a type, or it reaches the feed
// under its raw book name — visible, but not something a client can render.
//
// The list is the ledger's flow constants, written out. A new one added to
// the domain and not to the switch fails here rather than in front of a user.
func TestEveryFlowBookHasAType(t *testing.T) {
	var raw []string
	for _, book := range []string{
		ledger.Deposits, ledger.Withdrawals, ledger.YieldSettled, ledger.Liquidations,
		ledger.LienSettled, ledger.BorrowFlow, ledger.RepayFlow,
		ledger.SupplyFlow, ledger.PoolWithdrawFlow, ledger.ShareTransferFlow,
	} {
		if _, _, known := activityType(lendingRow(book, 1)); !known {
			raw = append(raw, book)
		}
	}
	if len(raw) > 0 {
		t.Fatalf("these books fell through to their raw name: %v", raw)
	}
}

func TestRoundRowsAreTypedByTheirEvent(t *testing.T) {
	if _, _, known := activityType(ledger.Activity{
		Source:     ledger.SourceRound,
		Provenance: ledger.Provenance{EventName: ledger.RoundVoided},
		Amount:     big.NewInt(0),
	}); known {
		t.Fatal("an unmapped round event reported itself as known")
	}

	position := ledger.Activity{
		Provenance: ledger.Provenance{EventName: ledger.PositionTaken},
		Source:     ledger.SourceRound,
		Amount:     big.NewInt(500),
		Market:     "0x00000000000000000000000000000000000B7C00",
		RoundID:    7,
		Side:       ledger.SideUp,
		Data:       map[string]string{"funder": "0xrouter"},
	}
	rendered := renderActivity(position)

	if rendered.Type != "position" {
		t.Fatalf("typed as %q", rendered.Type)
	}
	// The market has to survive: round ids restart at 1 in every market, so a
	// row saying "round 7" and nothing else names as many rounds as there are
	// markets.
	if rendered.Market == "" || rendered.RoundID != 7 || rendered.Side != ledger.SideUp {
		t.Fatalf("round identity lost: %+v", rendered)
	}
	// The funder is how a leveraged stake is told from a cash one after the
	// fact, and there is nowhere else it survives.
	if rendered.Data["funder"] != "0xrouter" {
		t.Fatalf("funder dropped: %v", rendered.Data)
	}

	claim := position
	claim.EventName = ledger.Claimed
	if got := renderActivity(claim).Type; got != "claim" {
		t.Fatalf("claim typed as %q", got)
	}
}

// The id has to be unique across both tables, or a client keying a list on it
// collapses two rows into one and drops whichever it saw second.
func TestRowIDsAreTheLogsCoordinates(t *testing.T) {
	first := lendingRow(ledger.Deposits, 1)
	second := lendingRow(ledger.Deposits, 2)
	second.RecordIndex = 1

	a, b := renderActivity(first), renderActivity(second)
	if a.ID == b.ID {
		t.Fatalf("two records of one log share an id: %s", a.ID)
	}
	if a.ID != "9421133-4-0" {
		t.Fatalf("id is %q, want block-log-record", a.ID)
	}
}

// The cursor is handed to a client and comes back as a URL parameter, so it
// has to survive the round trip exactly. Anything lost here silently moves
// the page boundary.
func TestCursorsRoundTrip(t *testing.T) {
	want := ledger.ActivityCursor{BlockNumber: 9_421_133, LogIndex: 4, RecordIndex: 1}
	got, err := ledger.ParseActivityCursor(want.String())
	if err != nil {
		t.Fatalf("parse %q: %v", want.String(), err)
	}
	if got != want {
		t.Fatalf("round trip changed it: %+v -> %+v", want, got)
	}
}

// A malformed cursor must be an error the handler can turn into a 400.
// Parsing it leniently into "start from the top" answers a request for page
// four with page one, which a client paging through reads as a list that
// never ends.
func TestMalformedCursorsAreRefused(t *testing.T) {
	for _, bad := range []string{
		"", "abc", "1-2", "1-2-3-4", "-1-2-3", "x-2-3", "1-y-3", "1-2-z",
		"99999999999999999999999-0-0", // past uint64
	} {
		if _, err := ledger.ParseActivityCursor(bad); err == nil {
			t.Errorf("cursor %q was accepted", bad)
		}
	}
}
