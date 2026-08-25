package indexer

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"github.com/wavedidwhat/ghoststake/internal/abis"
	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// topicUint encodes an indexed uint256 — the round id — as a topic.
func topicUint(v int64) common.Hash {
	return common.BigToHash(big.NewInt(v))
}

func roundSpec(t *testing.T) contractSpec {
	t.Helper()
	return mustABI(t, abis.ParimutuelRound)
}

func only(t *testing.T, batch ledger.Batch) ledger.RoundEvent {
	t.Helper()
	if len(batch.Entries) != 0 {
		t.Fatalf("a market event produced %d ledger entries; the market is not a book", len(batch.Entries))
	}
	if len(batch.Rounds) != 1 {
		t.Fatalf("want 1 round event, got %d", len(batch.Rounds))
	}
	return batch.Rounds[0]
}

func TestRoundOpenedCarriesItsSchedule(t *testing.T) {
	spec := roundSpec(t)
	log := makeLog(t, spec, "RoundOpened", []common.Hash{topicUint(7)},
		uint64(1_000), uint64(2_000), uint64(3_000))

	event := only(t, decodeBatch(t, spec, log))

	if event.RoundID != 7 {
		t.Fatalf("round id %d, want 7", event.RoundID)
	}
	for key, want := range map[string]string{"openTime": "1000", "lockTime": "2000", "closeTime": "3000"} {
		if got := event.Data[key]; got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
	// Round-level events name no account: filing them under one would put a
	// round's schedule in somebody's position history.
	if event.Account != "" {
		t.Fatalf("account %q on a round-level event", event.Account)
	}
}

// The side enum decides which pool a stake lands in, so it has to survive
// decoding intact. Both values, explicitly.
func TestPositionTakenDecodesBothSides(t *testing.T) {
	spec := roundSpec(t)

	for _, tc := range []struct {
		enum uint8
		want string
	}{
		{enum: 0, want: ledger.SideUp},
		{enum: 1, want: ledger.SideDown},
	} {
		log := makeLog(t, spec, "PositionTaken",
			[]common.Hash{topicUint(7), topicAddr(alice)},
			tc.enum, wei(500), common.HexToAddress(alice))

		event := only(t, decodeBatch(t, spec, log))
		if event.Side != tc.want {
			t.Fatalf("side enum %d decoded to %q, want %q", tc.enum, event.Side, tc.want)
		}
		if event.Amount.Cmp(wei(500)) != 0 {
			t.Fatalf("amount %s, want 500", event.Amount)
		}
		if event.Account != common.HexToAddress(alice).Hex() {
			t.Fatalf("account %q, want the checksummed form of alice", event.Account)
		}
	}
}

// The funder is what distinguishes a leveraged stake from a cash one after
// the fact, and there is no other record of it.
func TestPositionTakenRecordsTheFunder(t *testing.T) {
	spec := roundSpec(t)
	log := makeLog(t, spec, "PositionTaken",
		[]common.Hash{topicUint(7), topicAddr(alice)},
		uint8(0), wei(5_000), common.HexToAddress(bob))

	event := only(t, decodeBatch(t, spec, log))
	if got := event.Data["funder"]; got != common.HexToAddress(bob).Hex() {
		t.Fatalf("funder %q, want bob", got)
	}
}

func TestRoundResolvedCarriesTheWinnerAndRake(t *testing.T) {
	spec := roundSpec(t)
	log := makeLog(t, spec, "RoundResolved", []common.Hash{topicUint(7)},
		wei(2_600), uint8(1), wei(200))

	event := only(t, decodeBatch(t, spec, log))
	if got := event.Data["winner"]; got != ledger.SideDown {
		t.Fatalf("winner %q, want down", got)
	}
	if got := event.Data["closePrice"]; got != "2600" {
		t.Fatalf("close price %q", got)
	}
	if got := event.Data["rakeTaken"]; got != "200" {
		t.Fatalf("rake taken %q", got)
	}
}

// The void reason is the contract's own string. A user who can only be told
// "void" has to open a support ticket to find out why.
func TestRoundVoidedKeepsTheReason(t *testing.T) {
	spec := roundSpec(t)
	log := makeLog(t, spec, "RoundVoided", []common.Hash{topicUint(7)}, "one-sided pool")

	event := only(t, decodeBatch(t, spec, log))
	if got := event.Data["reason"]; got != "one-sided pool" {
		t.Fatalf("reason %q", got)
	}
}

// A claim's recipient is the router, not the user, on a leveraged position:
// the payout repays the debt before anything reaches the user.
func TestClaimedRecordsAmountAndRecipient(t *testing.T) {
	spec := roundSpec(t)
	log := makeLog(t, spec, "Claimed",
		[]common.Hash{topicUint(7), topicAddr(alice)},
		wei(980), common.HexToAddress(bob))

	event := only(t, decodeBatch(t, spec, log))
	if event.Amount.Cmp(wei(980)) != 0 {
		t.Fatalf("amount %s, want 980", event.Amount)
	}
	if got := event.Data["recipient"]; got != common.HexToAddress(bob).Hex() {
		t.Fatalf("recipient %q", got)
	}
}

// Administrative events are not part of anyone's view of a round.
func TestAdministrativeMarketEventsAreIgnored(t *testing.T) {
	spec := roundSpec(t)
	log := makeLog(t, spec, "RouterSet", []common.Hash{topicAddr(bob)}, true)

	if batch := decodeBatch(t, spec, log); batch.Len() != 0 {
		t.Fatalf("RouterSet produced %d records", batch.Len())
	}
}

// Provenance is stamped on round events exactly as it is on ledger entries.
// Without it a reorg rollback, which deletes by block, could not find them.
func TestRoundEventsCarryProvenance(t *testing.T) {
	spec := roundSpec(t)
	log := makeLog(t, spec, "RoundOpened", []common.Hash{topicUint(7)},
		uint64(1_000), uint64(2_000), uint64(3_000))

	event := only(t, decodeBatch(t, spec, log))
	if event.ChainID != 421614 || event.BlockNumber != log.BlockNumber {
		t.Fatalf("provenance not stamped: %+v", event.Provenance)
	}
	if event.TxHash != log.TxHash.Hex() || event.LogIndex != log.Index {
		t.Fatalf("log coordinates not stamped: %+v", event.Provenance)
	}
	if event.Contract != abis.ParimutuelRound || event.EventName != ledger.RoundOpened {
		t.Fatalf("contract/event not stamped: %s/%s", event.Contract, event.EventName)
	}
}
