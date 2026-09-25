package ledger_test

import (
	"math/big"
	"testing"
	"time"

	"forge.wavedidwhat.com/wave/ghoststake/internal/ledger"
)

// A question's events fold into the same Round as the market's own, because
// they describe the same round (GHO-91).

const questionMarket = "0x000000000000000000000000000000000000117e"

func oracleEvent(block uint64, index uint, name string, account string, data map[string]string) ledger.RoundEvent {
	return ledger.RoundEvent{
		Provenance: ledger.Provenance{
			ChainID:     421614,
			BlockNumber: block,
			LogIndex:    index,
			BlockTime:   time.Unix(1700000000+int64(block), 0).UTC(),
			EventName:   name,
		},
		Market:  questionMarket,
		RoundID: 7,
		Account: account,
		Data:    data,
	}
}

func TestAQuestionsLifecycleFoldsIntoItsRound(t *testing.T) {
	events := []ledger.RoundEvent{
		oracleEvent(1, 0, ledger.RoundOpened, "", map[string]string{
			"openTime": "1700000000", "lockTime": "1700003600", "closeTime": "1700007200",
		}),
		oracleEvent(2, 0, ledger.MarketSet, "", map[string]string{"oracle": "0xacc1e"}),
		oracleEvent(3, 0, ledger.Proposed, "0xa11ce", map[string]string{
			"outcome": ledger.OutcomeYes, "evidenceURI": "ipfs://x",
			"evidenceDigest": "0xab", "proposerStake": "250",
			"challengeClosesAt": "1700010000",
		}),
		oracleEvent(4, 0, ledger.Challenged, "0xb0b", map[string]string{"rulingDueAt": "1700020000"}),
		oracleEvent(5, 0, ledger.Ruled, "0xa4b1", map[string]string{
			"outcome": ledger.OutcomeNo, "paid": "0xb0b", "reasonURI": "ipfs://why",
		}),
		oracleEvent(6, 0, ledger.Finalised, "", map[string]string{"outcome": ledger.OutcomeNo}),
	}

	rounds := ledger.Project(events)
	if len(rounds) != 1 {
		t.Fatalf("got %d rounds, want 1 — the question and the market must be the same round", len(rounds))
	}
	q := rounds[0].Question
	if q == nil {
		t.Fatal("the round has no question state, so the app would render it as a price round")
	}

	if q.State != ledger.QuestionFinal {
		t.Fatalf("state %q, want final", q.State)
	}
	// The ruling overturned the claim. Showing the proposer's "yes" here
	// would tell everyone the losing answer won.
	if q.Outcome != ledger.OutcomeNo {
		t.Fatalf("outcome %q, want no — the arbiter ruled against the proposer", q.Outcome)
	}
	if q.Proposer != "0xa11ce" || q.Challenger != "0xb0b" || q.Arbiter != "0xa4b1" {
		t.Fatalf("who did what: proposer %q challenger %q arbiter %q", q.Proposer, q.Challenger, q.Arbiter)
	}
	if q.ProposerStake == nil || q.ProposerStake.Cmp(big.NewInt(250)) != 0 {
		t.Fatalf("proposer stake %v — the disclosure is why holding a position is allowed", q.ProposerStake)
	}
	if q.ChallengeClosesAt.Unix() != 1700010000 {
		t.Fatalf("challenge deadline %v — it is what makes 'nobody argued' mean anything", q.ChallengeClosesAt)
	}
	if q.PaidTo != "0xb0b" {
		t.Fatalf("paid %q, want the challenger", q.PaidTo)
	}
}

func TestAPriceRoundHasNoQuestion(t *testing.T) {
	rounds := ledger.Project([]ledger.RoundEvent{
		oracleEvent(1, 0, ledger.RoundOpened, "", map[string]string{
			"openTime": "1700000000", "lockTime": "1700003600", "closeTime": "1700007200",
		}),
		oracleEvent(2, 0, ledger.RoundLocked, "", map[string]string{"lockPrice": "2690"}),
	})
	if rounds[0].Question != nil {
		t.Fatal("a price round grew a question, so every round would render a resolution panel")
	}
}

func TestAnAbandonedQuestionSaysSoRatherThanStayingChallenged(t *testing.T) {
	// Nobody ruled in time. The round now cannot resolve and is waiting for
	// its refund — and a UI still showing "awaiting a ruling" would be
	// telling people to wait for something that is never coming.
	rounds := ledger.Project([]ledger.RoundEvent{
		oracleEvent(1, 0, ledger.Proposed, "0xa11ce", map[string]string{
			"outcome": ledger.OutcomeYes, "proposerStake": "0", "challengeClosesAt": "1700010000",
		}),
		oracleEvent(2, 0, ledger.Challenged, "0xb0b", map[string]string{"rulingDueAt": "1700020000"}),
		oracleEvent(3, 0, ledger.Abandoned, "", map[string]string{"at": "1700020001"}),
	})
	q := rounds[0].Question
	if q.State != ledger.QuestionAbandoned {
		t.Fatalf("state %q, want abandoned", q.State)
	}
	if q.AbandonedAt.Unix() != 1700020001 {
		t.Fatalf("abandoned at %v", q.AbandonedAt)
	}
}

func TestOutOfOrderQuestionEventsStillFoldToTheSameAnswer(t *testing.T) {
	// Project sorts by (block, log index) rather than trusting the slice.
	// Folding a Finalised before the Ruled that decided it would show the
	// proposer's claim as the final outcome.
	late := oracleEvent(6, 0, ledger.Finalised, "", map[string]string{"outcome": ledger.OutcomeNo})
	ruled := oracleEvent(5, 0, ledger.Ruled, "0xa4b1", map[string]string{
		"outcome": ledger.OutcomeNo, "paid": "0xb0b", "reasonURI": "",
	})
	proposed := oracleEvent(3, 0, ledger.Proposed, "0xa11ce", map[string]string{
		"outcome": ledger.OutcomeYes, "proposerStake": "0", "challengeClosesAt": "1700010000",
	})

	rounds := ledger.Project([]ledger.RoundEvent{late, proposed, ruled})
	if got := rounds[0].Question.Outcome; got != ledger.OutcomeNo {
		t.Fatalf("outcome %q, want no", got)
	}
}

func TestRulingOnAQuestionIsNotAPosition(t *testing.T) {
	// An arbiter, a proposer and a challenger are all recorded against the
	// round they touched, and the positions query filters by account. Without
	// a guard each of them would find the round in their own portfolio,
	// rendered as a stake of zero — which reads as "you are in this round".
	events := []ledger.RoundEvent{
		oracleEvent(3, 0, ledger.Proposed, "0xa11ce", map[string]string{
			"outcome": ledger.OutcomeYes, "proposerStake": "0", "challengeClosesAt": "1700010000",
		}),
		oracleEvent(5, 0, ledger.Ruled, "0xa4b1", map[string]string{
			"outcome": ledger.OutcomeYes, "paid": "0xa11ce", "reasonURI": "",
		}),
	}

	for _, account := range []string{"0xa11ce", "0xa4b1"} {
		if got := ledger.ProjectPositions(events, account); len(got) != 0 {
			t.Fatalf("%s was given a position they never took: %+v", account, got)
		}
	}
}

func TestAProposerWhoAlsoStakedKeepsTheirPosition(t *testing.T) {
	// The other half of the same rule, and the case that matters: holding a
	// position and proposing is allowed, so the stake must survive.
	staked := oracleEvent(2, 0, ledger.PositionTaken, "0xa11ce", map[string]string{"funder": "0xa11ce"})
	staked.Side = ledger.SideUp
	staked.Amount = big.NewInt(250)

	events := []ledger.RoundEvent{
		staked,
		oracleEvent(3, 0, ledger.Proposed, "0xa11ce", map[string]string{
			"outcome": ledger.OutcomeYes, "proposerStake": "250", "challengeClosesAt": "1700010000",
		}),
	}

	got := ledger.ProjectPositions(events, "0xa11ce")
	if len(got) != 1 {
		t.Fatalf("got %d positions, want 1", len(got))
	}
	if got[0].UpStake.Cmp(big.NewInt(250)) != 0 {
		t.Fatalf("stake %v, want 250", got[0].UpStake)
	}
}
