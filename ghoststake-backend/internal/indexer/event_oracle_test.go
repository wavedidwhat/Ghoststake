package indexer

import (
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"forge.wavedidwhat.com/wave/ghoststake/internal/abis"
	"forge.wavedidwhat.com/wave/ghoststake/internal/config"
	"forge.wavedidwhat.com/wave/ghoststake/internal/ledger"
)

// A question's lifecycle, carried from the oracle to the round it settles
// (GHO-91). The decoder's whole job is the attribution — everything else is
// field copying — so that is what these test.

const (
	oracleAddr = "0x00000000000000000000000000000000000acc1e"
	eventMkt   = "0x000000000000000000000000000000000000117e"
)

func oracleSpec(t *testing.T, o config.EventOracle) contractSpec {
	t.Helper()
	parsed, err := abis.Load(abis.EventRoundOracle)
	if err != nil {
		t.Fatal(err)
	}
	address := common.HexToAddress(o.Oracle)
	return contractSpec{
		name:   abis.EventRoundOracle,
		abi:    parsed,
		decode: decodeEventOracle(o),
		// What the wiring in New does: an oracle's round events are filed
		// under the market it answers for, never under its own address.
		market:  common.HexToAddress(o.Market).Hex(),
		address: address,
	}
}

func configuredOracle() config.EventOracle {
	return config.EventOracle{Oracle: oracleAddr, Market: eventMkt, RoundID: 7}
}

func TestAClaimIsFiledAgainstTheRoundItSettles(t *testing.T) {
	spec := oracleSpec(t, configuredOracle())
	log := makeLog(t, spec, ledger.Proposed,
		[]common.Hash{topicAddr(alice)},
		uint8(1),           // outcome: Yes
		"ipfs://evidence",  // evidenceURI
		[32]byte{0xab},     // evidenceDigest
		big.NewInt(250),    // proposerStake
		uint64(1700003600), // challengeClosesAt
	)

	batch := decodeBatch(t, spec, log)
	if len(batch.Rounds) != 1 {
		t.Fatalf("got %d round events, want 1", len(batch.Rounds))
	}
	e := batch.Rounds[0]

	// The two facts nothing in the log itself carries. Getting either wrong
	// files a question's whole lifecycle somewhere nobody will look for it.
	if !strings.EqualFold(e.Market, eventMkt) {
		t.Fatalf("filed under %s, want the market %s — not the oracle", e.Market, eventMkt)
	}
	if e.RoundID != 7 {
		t.Fatalf("filed under round %d, want 7", e.RoundID)
	}

	if e.Account != common.HexToAddress(alice).Hex() {
		t.Fatalf("proposer %q", e.Account)
	}
	if e.Data["outcome"] != ledger.OutcomeYes {
		t.Fatalf("outcome %q, want yes", e.Data["outcome"])
	}
	if e.Data["proposerStake"] != "250" {
		t.Fatalf("proposer stake %q — the disclosure is the point of allowing it", e.Data["proposerStake"])
	}
	// Checkable by hand against `sha256sum` of the criteria document, which
	// is the only thing that makes the URI worth anything.
	if !strings.HasPrefix(e.Data["evidenceDigest"], "0xab00") {
		t.Fatalf("digest %q", e.Data["evidenceDigest"])
	}
}

func TestAnOracleWiredToTheWrongRoundStopsTheIndexer(t *testing.T) {
	spec := oracleSpec(t, configuredOracle())
	// The oracle's own copy says round 9; EVENT_ORACLES says 7.
	log := makeLog(t, spec, ledger.MarketSet,
		[]common.Hash{topicAddr(eventMkt)},
		big.NewInt(9),
	)

	if _, err := spec.decodeLog(421614, log, testTime()); err == nil {
		t.Fatal("a mis-wired oracle was accepted: the question's lifecycle would attach to the wrong round")
	}
}

func TestTheConfiguredPairIsAcceptedWhenTheContractAgrees(t *testing.T) {
	spec := oracleSpec(t, configuredOracle())
	log := makeLog(t, spec, ledger.MarketSet,
		[]common.Hash{topicAddr(eventMkt)},
		big.NewInt(7),
	)

	batch := decodeBatch(t, spec, log)
	if len(batch.Rounds) != 1 {
		t.Fatalf("got %d round events, want 1", len(batch.Rounds))
	}
	if batch.Rounds[0].Data["oracle"] != oracleAddr {
		t.Fatalf("oracle %q", batch.Rounds[0].Data["oracle"])
	}
}

func TestAnUnknownOutcomeIsRefusedRatherThanGuessed(t *testing.T) {
	spec := oracleSpec(t, configuredOracle())
	// 3 is not in the enum. Defaulting would show everyone a confident
	// answer to a question with money on it.
	log := makeLog(t, spec, ledger.Finalised, nil, uint8(3))

	if _, err := spec.decodeLog(421614, log, testTime()); err == nil {
		t.Fatal("an outcome outside the enum was decoded as something")
	}
}

func TestAdministrativeOracleEventsAreNotRoundEvents(t *testing.T) {
	spec := oracleSpec(t, configuredOracle())
	log := makeLog(t, spec, "ArbiterSet",
		[]common.Hash{topicAddr(alice), topicAddr(bob)},
	)

	batch := decodeBatch(t, spec, log)
	if len(batch.Rounds) != 0 {
		t.Fatalf("who may rule ended up in a user's view of their round: %v", batch.Rounds)
	}
}
