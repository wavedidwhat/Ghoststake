package httpx

import (
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/config"
	"github.com/wavedidwhat/ghoststake/internal/finance"
	"github.com/wavedidwhat/ghoststake/internal/ledger"
	"github.com/wavedidwhat/ghoststake/internal/protocol"
)

func testParams() protocol.MarketParams {
	return protocol.MarketParams{
		EntryCutoff: 15,
		Rake:        finance.MulDiv(finance.WAD, big.NewInt(2), big.NewInt(100)), // 2%
		MinSidePool: big.NewInt(1_000_000),
	}
}

func openRound(open, lock int64) ledger.Round {
	return ledger.Round{
		ChainID: 31337, RoundID: 7, Status: ledger.StatusOpen,
		OpenTime: time.Unix(open, 0).UTC(),
		LockTime: time.Unix(lock, 0).UTC(),
		UpPool:   big.NewInt(6_000_000_000),
		DownPool: big.NewInt(4_000_000_000),
	}
}

// The phase and the stake button are decided on the clock, so the response
// has to be rendered against a time — not against whatever the row says.
func TestRenderedPhaseFollowsTheClock(t *testing.T) {
	round := openRound(1_000, 2_000)

	during := renderRound(round, testParams(), time.Unix(1_500, 0).UTC())
	if during.Phase != string(finance.PhaseOpen) || !during.EntryOpen {
		t.Fatalf("mid-round: phase %q entryOpen %v", during.Phase, during.EntryOpen)
	}

	// Fifteen seconds before the lock, entry is closed but the round is not
	// locked. A response that said "open" here would offer a transaction the
	// contract reverts.
	after := renderRound(round, testParams(), time.Unix(1_990, 0).UTC())
	if after.Phase != string(finance.PhaseCutoff) || after.EntryOpen {
		t.Fatalf("after cutoff: phase %q entryOpen %v", after.Phase, after.EntryOpen)
	}
}

// Every uint256 must leave as a string. A JSON number would be parsed into a
// double by every browser and lose the low digits of a balance.
func TestUint256FieldsAreEncodedAsStrings(t *testing.T) {
	round := openRound(1_000, 2_000)
	// Larger than 2^53, which is where a double starts fabricating digits.
	round.UpPool, _ = new(big.Int).SetString("123456789012345678901234567890", 10)
	round.LockPrice = big.NewInt(2_500)

	raw, err := json.Marshal(renderRound(round, testParams(), time.Unix(1_500, 0).UTC()))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body := string(raw)

	if !strings.Contains(body, `"upPool":"123456789012345678901234567890"`) {
		t.Fatalf("upPool is not a string: %s", body)
	}
	// Round-trip it the way a browser would, and check nothing changed.
	var decoded roundJSON
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.UpPool != round.UpPool.String() {
		t.Fatalf("up pool changed in transit: %s -> %s", round.UpPool, decoded.UpPool)
	}
}

// Fields that have no value yet must be null, not zero. "The lock price is 0"
// and "this round has not locked" are different statements, and a client that
// cannot tell them apart will draw the first one.
func TestAbsentFiguresAreNullRatherThanZero(t *testing.T) {
	rendered := renderRound(openRound(1_000, 2_000), testParams(), time.Unix(1_500, 0).UTC())

	if rendered.LockPrice != nil || rendered.ClosePrice != nil || rendered.RakeTaken != nil {
		t.Fatalf("an unlocked round reported prices: %+v", rendered)
	}
	if rendered.Winner != "" || rendered.VoidReason != "" {
		t.Fatalf("an unlocked round reported an outcome: %+v", rendered)
	}
}

// A position's claimable figure has to come from the whole round's pools, not
// from the holder's own stake — which is why the handler reads every event of
// a round rather than only the ones naming the account.
func TestRenderedPositionQuotesAPayoutFromTheWholePool(t *testing.T) {
	round := openRound(1_000, 2_000)
	round.Status = ledger.StatusResolved
	round.Winner = ledger.SideUp
	round.RakeTaken = big.NewInt(200_000_000) // 2% of 10,000

	position := ledger.AccountPosition{
		RoundID:       7,
		UpStake:       big.NewInt(600_000_000), // a tenth of the winning side
		DownStake:     new(big.Int),
		ClaimedAmount: new(big.Int),
	}

	rendered := renderPosition(position, round, testParams(), time.Unix(3_000, 0).UTC())
	if rendered.Claimable != "980000000" {
		t.Fatalf("claimable %s, want 980000000 (a tenth of the 9,800 net pot)", rendered.Claimable)
	}
	if rendered.Round.Phase != string(finance.PhaseResolved) {
		t.Fatalf("phase %q", rendered.Round.Phase)
	}
}

// `?limit=` is user input, and the query behind it reads every event of every
// round it returns. Unbounded, it is a request that reads the whole table.
func TestLimitIsClamped(t *testing.T) {
	for raw, want := range map[string]int{
		"":         defaultRoundLimit,
		"nonsense": defaultRoundLimit,
		"0":        defaultRoundLimit,
		"-5":       defaultRoundLimit,
		"10":       10,
		"1000000":  maxRoundLimit,
	} {
		if got := clampLimit(raw); got != want {
			t.Errorf("limit %q -> %d, want %d", raw, got, want)
		}
	}
}

// The websocket handshake is not subject to CORS — no preflight, and the
// browser ignores the response's allow-origin header — so the origin check
// has to happen in the upgrader, against the same list.
func TestWebsocketOriginsMatchTheCORSList(t *testing.T) {
	s := &Server{cfg: config.Config{CORSOrigins: []string{"https://app.example.com"}}}

	if !s.originAllowed("https://app.example.com") {
		t.Fatal("the configured origin was rejected")
	}
	if !s.originAllowed("HTTPS://APP.EXAMPLE.COM") {
		t.Fatal("origin comparison is case sensitive")
	}
	if s.originAllowed("https://evil.example.com") {
		t.Fatal("an unlisted origin was accepted")
	}
	// No Origin header at all: a non-browser client, which the same-origin
	// policy does not protect anyway.
	if !s.originAllowed("") {
		t.Fatal("a client sending no origin was rejected")
	}
}
