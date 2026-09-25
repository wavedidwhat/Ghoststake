package indexer

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/core/types"

	"forge.wavedidwhat.com/wave/ghoststake/internal/config"
	"forge.wavedidwhat.com/wave/ghoststake/internal/ledger"
)

// decodeEventOracle maps an EventRoundOracle's events onto the round it
// settles (GHO-91).
//
// # Why this needs to be told which round it is
//
// Every other decoder here reads the round id off the log. This one cannot:
// the oracle is a separate contract that answers one question, and its events
// say what was claimed without saying which market round is waiting on the
// answer. The contract does store the pair — `setMarket(market, roundId)` —
// but the indexer's stream identity is a fingerprint of the addresses it
// watches, fixed before any RPC call, so resolving the pair from the chain
// would mean either a call at construction time or a fingerprint that changes
// once one succeeds. Since GHO-89 a changed fingerprint means a full re-read
// that a pruned endpoint refuses outright.
//
// So the pair is configured, and then *checked*: `MarketSet` carries the
// oracle's own copy, and a log that disagrees with the configuration stops
// the indexer rather than filing a question's whole lifecycle — the claim,
// the challenge, the ruling — under somebody else's round.
func decodeEventOracle(o config.EventOracle) func(string, *fields, types.Log) ledger.Batch {
	return func(name string, f *fields, _ types.Log) ledger.Batch {
		event := func(e ledger.RoundEvent) ledger.Batch {
			e.RoundID = o.RoundID
			return roundBatch(e)
		}

		switch name {
		case ledger.MarketSet:
			// The check, not the record. A mismatch is a mis-set
			// EVENT_ORACLES entry, and the loud failure is the point: the
			// alternative is a question's lifecycle appearing on a round
			// that has nothing to do with it, which nobody would query for.
			market := f.addr("market")
			roundID := f.roundID("roundId")
			if !strings.EqualFold(market, o.Market) || roundID != o.RoundID {
				f.missing = append(f.missing, fmt.Sprintf(
					"MarketSet says %s round %d, EVENT_ORACLES says %s round %d",
					market, roundID, o.Market, o.RoundID))
				return ledger.Batch{}
			}
			return event(ledger.RoundEvent{Data: map[string]string{"oracle": o.Oracle}})

		case ledger.Proposed:
			outcome, err := ledger.OutcomeFromEnum(f.enum("outcome"))
			if err != nil {
				f.missing = append(f.missing, "outcome")
				return ledger.Batch{}
			}
			return event(ledger.RoundEvent{
				// The proposer, in the same slot a position's user goes in,
				// so "everything this address did to this round" is one
				// query rather than two.
				Account: f.addr("proposer"),
				Data: map[string]string{
					"outcome":           outcome,
					"evidenceURI":       f.str("evidenceURI"),
					"evidenceDigest":    f.digest("evidenceDigest"),
					"proposerStake":     f.amount("proposerStake").String(),
					"challengeClosesAt": strconv.FormatUint(f.u64("challengeClosesAt"), 10),
				},
			})

		case ledger.Challenged:
			return event(ledger.RoundEvent{
				Account: f.addr("challenger"),
				Data:    map[string]string{"rulingDueAt": strconv.FormatUint(f.u64("rulingDueAt"), 10)},
			})

		case ledger.Ruled:
			outcome, err := ledger.OutcomeFromEnum(f.enum("outcome"))
			if err != nil {
				f.missing = append(f.missing, "outcome")
				return ledger.Batch{}
			}
			return event(ledger.RoundEvent{
				Account: f.addr("arbiter"),
				Data: map[string]string{
					"outcome":   outcome,
					"paid":      f.addr("paid"),
					"reasonURI": f.str("reasonURI"),
				},
			})

		case ledger.Finalised:
			outcome, err := ledger.OutcomeFromEnum(f.enum("outcome"))
			if err != nil {
				f.missing = append(f.missing, "outcome")
				return ledger.Batch{}
			}
			return event(ledger.RoundEvent{Data: map[string]string{"outcome": outcome}})

		case ledger.Abandoned:
			return event(ledger.RoundEvent{
				Data: map[string]string{"at": strconv.FormatUint(f.u64("at"), 10)},
			})
		}
		// ArbiterSet and OwnershipTransferred: who may rule is worth knowing,
		// but it is a property of the oracle rather than of the round, and
		// folding it into a round's state would put an administrative change
		// in a user's view of their question.
		return ledger.Batch{}
	}
}
