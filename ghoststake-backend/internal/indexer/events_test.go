package indexer

import (
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

func mustABI(t *testing.T, file string) contractSpec {
	t.Helper()
	parsed, err := loadABI(file)
	if err != nil {
		t.Fatalf("load %s: %v", file, err)
	}
	name, decode := "CollateralVault", decodeVault
	if file != "CollateralVault.json" {
		name, decode = "BorrowLiquidityPool", decodePool
	}
	return contractSpec{name: name, address: common.HexToAddress("0x1"), abi: parsed, decode: decode}
}

// makeLog builds a log the way the chain would: indexed arguments in topics,
// everything else ABI-encoded in data.
func makeLog(t *testing.T, spec contractSpec, event string, indexed []common.Hash, args ...any) types.Log {
	t.Helper()
	ev, ok := spec.abi.Events[event]
	if !ok {
		t.Fatalf("event %s not in abi", event)
	}

	var nonIndexed []any
	for _, in := range ev.Inputs {
		if !in.Indexed {
			nonIndexed = append(nonIndexed, args[0])
			args = args[1:]
		}
	}
	data, err := ev.Inputs.NonIndexed().Pack(nonIndexed...)
	if err != nil {
		t.Fatalf("pack %s: %v", event, err)
	}

	topics := append([]common.Hash{ev.ID}, indexed...)
	return types.Log{
		Address: spec.address, Topics: topics, Data: data,
		BlockNumber: 100, BlockHash: common.HexToHash("0xbb"),
		TxHash: common.HexToHash("0xaa"), Index: 3,
	}
}

func topicAddr(a string) common.Hash { return common.HexToHash(a) }

func wei(n int64) *big.Int { return big.NewInt(n) }

const (
	alice = "0x000000000000000000000000000000000000a11c"
	bob   = "0x000000000000000000000000000000000000b0b0"
)

func decode(t *testing.T, spec contractSpec, log types.Log) []ledger.Entry {
	t.Helper()
	entries, err := spec.decodeLog(421614, log, time.Unix(1700000000, 0).UTC())
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return entries
}

// ---------------------------------------------------------------------
// The shares book
// ---------------------------------------------------------------------

func TestTransferDebitsAndCreditsBothSides(t *testing.T) {
	spec := mustABI(t, "CollateralVault.json")
	log := makeLog(t, spec, "Transfer", []common.Hash{topicAddr(alice), topicAddr(bob)}, wei(500))

	entries := decode(t, spec, log)
	if len(entries) != 2 {
		t.Fatalf("want 2 entries, got %d", len(entries))
	}

	// A transfer must net to zero across the two accounts, or the shares
	// book invents or destroys supply.
	sum := new(big.Int)
	for _, e := range entries {
		if e.Ledger != ledger.Shares || e.Kind != ledger.KindBalance {
			t.Fatalf("unexpected entry: %+v", e)
		}
		sum.Add(sum, e.Delta)
	}
	if sum.Sign() != 0 {
		t.Fatalf("transfer did not net to zero: %s", sum)
	}

	// Entry indices must differ, or the unique constraint collapses them
	// into one row and half the transfer is silently dropped.
	if entries[0].EntryIndex == entries[1].EntryIndex {
		t.Fatal("both entries share an entry_index")
	}
}

func TestMintOnlyCreditsTheReceiver(t *testing.T) {
	spec := mustABI(t, "CollateralVault.json")
	zero := common.Hash{}
	log := makeLog(t, spec, "Transfer", []common.Hash{zero, topicAddr(alice)}, wei(1000))

	entries := decode(t, spec, log)
	if len(entries) != 1 {
		t.Fatalf("want 1 entry for a mint, got %d", len(entries))
	}
	if entries[0].Delta.Cmp(wei(1000)) != 0 {
		t.Fatalf("want +1000, got %s", entries[0].Delta)
	}
	// Crediting the zero address would make it look like a holder.
	if entries[0].Account == zeroAddress {
		t.Fatal("mint credited the zero address")
	}
}

func TestBurnOnlyDebitsTheSender(t *testing.T) {
	spec := mustABI(t, "CollateralVault.json")
	log := makeLog(t, spec, "Transfer", []common.Hash{topicAddr(alice), common.Hash{}}, wei(250))

	entries := decode(t, spec, log)
	if len(entries) != 1 {
		t.Fatalf("want 1 entry for a burn, got %d", len(entries))
	}
	if entries[0].Delta.Sign() >= 0 {
		t.Fatalf("burn should debit, got %s", entries[0].Delta)
	}
}

// ---------------------------------------------------------------------
// The double-counting traps
// ---------------------------------------------------------------------

// The exit path emits Withdraw, LienSettledAtExit and Withdrawn for one
// withdrawal, where assets = lienAmount + collateralReturned. If more than
// one of them touched the same book, a single exit would be counted twice.
func TestExitPathEventsDoNotShareABook(t *testing.T) {
	spec := mustABI(t, "CollateralVault.json")

	withdrawn := decode(t, spec, makeLog(t, spec, "Withdrawn",
		[]common.Hash{topicAddr(alice)}, wei(1000), wei(900)))
	lien := decode(t, spec, makeLog(t, spec, "LienSettledAtExit",
		[]common.Hash{topicAddr(alice)}, wei(400), wei(600)))

	books := map[string]bool{}
	for _, e := range append(withdrawn, lien...) {
		if books[e.Ledger] {
			t.Fatalf("exit path writes %q twice", e.Ledger)
		}
		books[e.Ledger] = true
		// Neither may be balance-bearing: the shares book already covers
		// this withdrawal via the burn.
		if e.Kind == ledger.KindBalance {
			t.Fatalf("%s is balance-bearing and would double count", e.EventName)
		}
	}
}

// Vault.borrow emits its own Borrowed and causes the pool to emit one too,
// for the same movement. Only the pool's may be balance-bearing, because
// only it carries the scaled amount.
func TestOnlyThePoolOwnsTheDebtBook(t *testing.T) {
	vault := mustABI(t, "CollateralVault.json")
	pool := mustABI(t, "BorrowLiquidityPool.json")

	fromVault := decode(t, vault, makeLog(t, vault, "Borrowed",
		[]common.Hash{topicAddr(alice)}, wei(100), wei(100)))
	fromPool := decode(t, pool, makeLog(t, pool, "Borrowed",
		[]common.Hash{topicAddr(alice)}, wei(100), wei(97)))

	if len(fromVault) != 1 || fromVault[0].Kind != ledger.KindFlow {
		t.Fatalf("vault Borrowed must be a flow, got %+v", fromVault)
	}
	if len(fromPool) != 1 || fromPool[0].Kind != ledger.KindBalance {
		t.Fatalf("pool Borrowed must be balance-bearing, got %+v", fromPool)
	}
	if fromPool[0].Ledger != ledger.DebtScaled {
		t.Fatalf("want %s, got %s", ledger.DebtScaled, fromPool[0].Ledger)
	}
	// The scaled amount is the summable one, not the nominal.
	if fromPool[0].Delta.Cmp(wei(97)) != 0 {
		t.Fatalf("want the scaled amount 97, got %s", fromPool[0].Delta)
	}
}

func TestRepayDebitsTheScaledDebtAndKeepsThePayer(t *testing.T) {
	pool := mustABI(t, "BorrowLiquidityPool.json")
	log := makeLog(t, pool, "Repaid",
		[]common.Hash{topicAddr(bob), topicAddr(alice)}, wei(50), wei(48))

	entries := decode(t, pool, log)
	if len(entries) != 1 {
		t.Fatalf("want 1 entry, got %d", len(entries))
	}
	e := entries[0]
	// The debt belongs to the borrower, not to whoever paid it off.
	if e.Account != alice {
		t.Fatalf("want account %s, got %s", alice, e.Account)
	}
	if e.Counterparty != bob {
		t.Fatalf("want counterparty %s, got %s", bob, e.Counterparty)
	}
	if e.Delta.Cmp(wei(-48)) != 0 {
		t.Fatalf("want -48 scaled, got %s", e.Delta)
	}
}

// ---------------------------------------------------------------------
// Provenance and unknown events
// ---------------------------------------------------------------------

func TestEveryEntryCarriesItsProvenance(t *testing.T) {
	spec := mustABI(t, "CollateralVault.json")
	log := makeLog(t, spec, "Deposited", []common.Hash{topicAddr(alice)}, wei(10), wei(9))

	entries := decode(t, spec, log)
	if len(entries) != 1 {
		t.Fatalf("want 1 entry, got %d", len(entries))
	}
	e := entries[0]
	if e.ChainID != 421614 || e.BlockNumber != 100 || e.LogIndex != 3 {
		t.Fatalf("provenance not stamped: %+v", e)
	}
	if e.TxHash == "" || e.BlockHash == "" || e.BlockTime.IsZero() {
		t.Fatalf("provenance incomplete: %+v", e)
	}
}

func TestProtocolLevelEventsProduceNoEntries(t *testing.T) {
	pool := mustABI(t, "BorrowLiquidityPool.json")
	// Accrued moves the indices, which changes what every scaled balance is
	// worth — but it is not one account's movement and must not become one.
	log := makeLog(t, pool, "Accrued", nil, wei(1), wei(2), wei(3))

	if entries := decode(t, pool, log); len(entries) != 0 {
		t.Fatalf("want no entries, got %+v", entries)
	}
}

func TestUnknownEventIsIgnoredRatherThanFailing(t *testing.T) {
	spec := mustABI(t, "CollateralVault.json")
	// Filtering is by address, so anything the contract emits arrives here.
	// An unrecognised topic must not stall the whole range.
	log := types.Log{
		Address: spec.address,
		Topics:  []common.Hash{crypto.Keccak256Hash([]byte("NotOurEvent(uint256)"))},
	}
	entries, err := spec.decodeLog(421614, log, time.Now())
	if err != nil {
		t.Fatalf("unknown event should not error: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("want no entries, got %d", len(entries))
	}
}
