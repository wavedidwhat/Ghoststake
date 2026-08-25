package indexer

import (
	"strconv"

	"github.com/ethereum/go-ethereum/core/types"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// decodeRound maps ParimutuelRound events to round records.
//
// None of these become ledger entries. The market is not a book: a stake is
// not a balance the user can draw on, it is a claim on a pot whose size
// depends on how the round settles, and the payout is decided at resolution
// by the contract's own division. Recording a stake as a positive delta in
// some "stake" book would produce a number that looks spendable and is not —
// and the moment a round voids, the same book would have to be unwound by an
// event that never fires, because the contract does not reduce `stakeOf` on
// a claim. It sets a flag.
//
// So the money side of a round is deliberately absent from the ledger, and
// present here as history. What the user is owed comes from the contract's
// `claimableOf`, which is the only thing entitled to answer it.
func decodeRound(name string, f *fields, _ types.Log) ledger.Batch {
	switch name {
	case ledger.RoundOpened:
		return roundBatch(ledger.RoundEvent{
			RoundID: f.roundID("roundId"),
			Data: map[string]string{
				"openTime":  strconv.FormatUint(f.u64("openTime"), 10),
				"lockTime":  strconv.FormatUint(f.u64("lockTime"), 10),
				"closeTime": strconv.FormatUint(f.u64("closeTime"), 10),
			},
		})

	case ledger.PositionTaken:
		side, err := ledger.SideFromEnum(f.enum("side"))
		if err != nil {
			// Treated as a missing field rather than dropped: an unknown side
			// means the contract's enum grew, and a position silently filed
			// under neither pool would understate one side of the market.
			f.missing = append(f.missing, "side")
			return ledger.Batch{}
		}
		return roundBatch(ledger.RoundEvent{
			RoundID: f.roundID("roundId"),
			Account: f.addr("user"),
			Side:    side,
			Amount:  f.amount("amount"),
			// The funder is who actually paid. It differs from the user when
			// the borrow-to-position router opened the position with borrowed
			// funds, and that is the only way to tell a leveraged stake from
			// a cash one after the fact.
			Data: map[string]string{"funder": f.addr("funder")},
		})

	case ledger.RoundLocked:
		return roundBatch(ledger.RoundEvent{
			RoundID: f.roundID("roundId"),
			Data: map[string]string{
				"lockPrice":     f.amount("lockPrice").String(),
				"oracleRoundId": f.amount("oracleRoundId").String(),
			},
		})

	case ledger.RoundResolved:
		winner, err := ledger.SideFromEnum(f.enum("winner"))
		if err != nil {
			f.missing = append(f.missing, "winner")
			return ledger.Batch{}
		}
		return roundBatch(ledger.RoundEvent{
			RoundID: f.roundID("roundId"),
			Data: map[string]string{
				"closePrice": f.amount("closePrice").String(),
				"winner":     winner,
				"rakeTaken":  f.amount("rakeTaken").String(),
			},
		})

	case ledger.RoundVoided:
		// The reason is the contract's own string. Stored verbatim: a void
		// the user can only see as "void" is a support ticket.
		return roundBatch(ledger.RoundEvent{
			RoundID: f.roundID("roundId"),
			Data:    map[string]string{"reason": f.str("reason")},
		})

	case ledger.Claimed:
		return roundBatch(ledger.RoundEvent{
			RoundID: f.roundID("roundId"),
			Account: f.addr("user"),
			Amount:  f.amount("amount"),
			// The recipient is the router, not the user, when the position
			// was leveraged: the payout goes to repay the debt first.
			Data: map[string]string{"recipient": f.addr("recipient")},
		})
	}
	// RouterSet, FeesWithdrawn, OwnershipTransferred: administrative, and
	// nothing a user's view of a round depends on.
	return ledger.Batch{}
}

func roundBatch(e ledger.RoundEvent) ledger.Batch {
	if e.Data == nil {
		e.Data = map[string]string{}
	}
	return ledger.Batch{Rounds: []ledger.RoundEvent{e}}
}
