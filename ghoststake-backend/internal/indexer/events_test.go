package indexer

import (
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/wavedidwhat/ghoststake/internal/abis"
	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

func mustABI(t *testing.T, name string) contractSpec {
	t.Helper()
	parsed, err := abis.Load(name)
	if err != nil {
		t.Fatalf("load %s: %v", name, err)
	}
	decode := entriesOnly(decodeVault)
	switch name {
	case abis.BorrowLiquidityPool:
		decode = entriesOnly(decodePool)
	case abis.ParimutuelRound:
		decode = decodeRound
	}
	address := common.HexToAddress("0x1")
	return contractSpec{
		name: name, address: address, abi: parsed, decode: decode,
		market: marketOf(name, address),
	}
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

func testTime() time.Time { return time.Unix(1700000000, 0).UTC() }

func decode(t *testing.T, spec contractSpec, log types.Log) []ledger.Entry {
	t.Helper()
	return decodeBatch(t, spec, log).Entries
}

func decodeBatch(t *testing.T, spec contractSpec, log types.Log) ledger.Batch {
	t.Helper()
	batch, err := spec.decodeLog(421614, log, time.Unix(1700000000, 0).UTC())
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return batch
}

// ---------------------------------------------------------------------
// The shares book
// ---------------------------------------------------------------------

func TestTransferDebitsAndCreditsBothSides(t *testing.T) {
	spec := mustABI(t, abis.CollateralVault)
	log := makeLog(t, spec, "Transfer", []common.Hash{topicAddr(alice), topicAddr(bob)}, wei(500))

	entries := decode(t, spec, log)
	// Four: the two balance entries that move the shares book, and the two
	// flow entries GHO-49 added so a transfer appears in both parties'
	// history. The flows must not be summed into the book — hence the split.
	if len(entries) != 4 {
		t.Fatalf("want 4 entries, got %d", len(entries))
	}

	// A transfer must net to zero across the two accounts, or the shares
	// book invents or destroys supply.
	sum := new(big.Int)
	var balances, flows int
	for _, e := range entries {
		switch e.Kind {
		case ledger.KindBalance:
			if e.Ledger != ledger.Shares {
				t.Fatalf("unexpected balance entry: %+v", e)
			}
			balances++
			sum.Add(sum, e.Delta)
		case ledger.KindFlow:
			if e.Ledger != ledger.ShareTransferFlow {
				t.Fatalf("unexpected flow entry: %+v", e)
			}
			flows++
		default:
			t.Fatalf("unexpected kind: %+v", e)
		}
	}
	if balances != 2 || flows != 2 {
		t.Fatalf("want 2 balance and 2 flow entries, got %d and %d", balances, flows)
	}
	if sum.Sign() != 0 {
		t.Fatalf("transfer did not net to zero: %s", sum)
	}

	// Entry indices must differ, or the unique constraint collapses them
	// into one row and half the transfer is silently dropped.
	seen := map[int]bool{}
	for _, e := range entries {
		if seen[e.RecordIndex] {
			t.Fatalf("record_index %d used twice", e.RecordIndex)
		}
		seen[e.RecordIndex] = true
	}
}

// The balance entries must keep record indices 0 and 1, with anything new
// appended after them.
//
// Not style: RecordIndex is assigned by position and the insert is idempotent
// on (chain, tx, log index, record index). Rows for every share movement ever
// indexed are already in the table under 0 and 1. Put the new flow entries
// first and those indices now belong to different records — a replay would
// write a second copy of every balance entry under the vacated indices, and
// the shares book would double.
func TestNewTransferEntriesAreAppendedAfterTheBalanceOnes(t *testing.T) {
	spec := mustABI(t, abis.CollateralVault)
	log := makeLog(t, spec, "Transfer", []common.Hash{topicAddr(alice), topicAddr(bob)}, wei(500))

	for _, e := range decode(t, spec, log) {
		if e.Kind == ledger.KindBalance && e.RecordIndex > 1 {
			t.Fatalf("balance entry moved to record_index %d", e.RecordIndex)
		}
		if e.Kind == ledger.KindFlow && e.RecordIndex < 2 {
			t.Fatalf("flow entry took record_index %d, which a balance entry already owns", e.RecordIndex)
		}
	}
}

// The two sides of one transfer are distinguished only by the sign, which is
// what the API's share_transfer_in/out mapping reads. Both positive and the
// same log renders as two incoming transfers.
func TestShareTransferFlowsAreSignedByDirection(t *testing.T) {
	spec := mustABI(t, abis.CollateralVault)
	log := makeLog(t, spec, "Transfer", []common.Hash{topicAddr(alice), topicAddr(bob)}, wei(500))

	byAccount := map[string]*big.Int{}
	for _, e := range decode(t, spec, log) {
		if e.Ledger == ledger.ShareTransferFlow {
			byAccount[e.Account] = e.Delta
		}
	}
	sender := common.HexToAddress(alice).Hex()
	receiver := common.HexToAddress(bob).Hex()

	if got := byAccount[sender]; got == nil || got.Sign() >= 0 {
		t.Fatalf("sender's flow should be negative, got %v", got)
	}
	if got := byAccount[receiver]; got == nil || got.Sign() <= 0 {
		t.Fatalf("receiver's flow should be positive, got %v", got)
	}
}

// A mint and a burn are already narrated by Deposited and Withdrawn. A second
// flow row for the same movement reads as a double count whether or not the
// books actually double.
func TestMintAndBurnWriteNoTransferFlow(t *testing.T) {
	spec := mustABI(t, abis.CollateralVault)
	zero := common.Hash{}

	for _, tc := range []struct {
		name   string
		topics []common.Hash
	}{
		{"mint", []common.Hash{zero, topicAddr(alice)}},
		{"burn", []common.Hash{topicAddr(alice), zero}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			log := makeLog(t, spec, "Transfer", tc.topics, wei(1000))
			for _, e := range decode(t, spec, log) {
				if e.Ledger == ledger.ShareTransferFlow {
					t.Fatalf("%s wrote a transfer flow: %+v", tc.name, e)
				}
			}
		})
	}
}

func TestMintOnlyCreditsTheReceiver(t *testing.T) {
	spec := mustABI(t, abis.CollateralVault)
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
	spec := mustABI(t, abis.CollateralVault)
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
	spec := mustABI(t, abis.CollateralVault)

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
	vault := mustABI(t, abis.CollateralVault)
	pool := mustABI(t, abis.BorrowLiquidityPool)

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
	pool := mustABI(t, abis.BorrowLiquidityPool)
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

// Supplying to the pool is the case GHO-49 found: the contract emits both the
// nominal amount and the scaled one, and only the scaled one was being kept.
// A history page then had nothing nominal to show for the action, and the
// scaled figure is not what the lender did — it is that amount divided by the
// supply index at the time.
func TestSupplyKeepsBothTheScaledBalanceAndTheNominalAmount(t *testing.T) {
	pool := mustABI(t, abis.BorrowLiquidityPool)
	log := makeLog(t, pool, "Supplied", []common.Hash{topicAddr(alice)}, wei(1000), wei(970))

	entries := decode(t, pool, log)
	if len(entries) != 2 {
		t.Fatalf("want 2 entries, got %d", len(entries))
	}

	balance, flow := entries[0], entries[1]
	// Balance first. The RecordIndex argument from
	// TestNewTransferEntriesAreAppendedAfterTheBalanceOnes applies identically
	// here: index 0 already belongs to the scaled balance entry in every row
	// already written.
	if balance.Kind != ledger.KindBalance || balance.RecordIndex != 0 {
		t.Fatalf("want the balance entry at index 0, got %+v", balance)
	}
	if balance.Ledger != ledger.SupplyScaled || balance.Delta.Cmp(wei(970)) != 0 {
		t.Fatalf("want +970 scaled in %s, got %+v", ledger.SupplyScaled, balance)
	}
	if flow.Kind != ledger.KindFlow || flow.Ledger != ledger.SupplyFlow {
		t.Fatalf("want a %s flow, got %+v", ledger.SupplyFlow, flow)
	}
	// The nominal amount, which is what the lender actually handed over.
	if flow.Delta.Cmp(wei(1000)) != 0 {
		t.Fatalf("want the nominal 1000, got %s", flow.Delta)
	}
}

// The two entries a pool withdrawal writes disagree about sign on purpose:
// the balance must go down, and the history row must not read as something to
// subtract from a total.
func TestPoolWithdrawDebitsTheBalanceAndRecordsAPositiveFlow(t *testing.T) {
	pool := mustABI(t, abis.BorrowLiquidityPool)
	log := makeLog(t, pool, "Withdrawn", []common.Hash{topicAddr(alice)}, wei(500), wei(480))

	entries := decode(t, pool, log)
	if len(entries) != 2 {
		t.Fatalf("want 2 entries, got %d", len(entries))
	}
	balance, flow := entries[0], entries[1]

	if balance.Ledger != ledger.SupplyScaled || balance.Delta.Cmp(wei(-480)) != 0 {
		t.Fatalf("want -480 scaled, got %+v", balance)
	}
	if flow.Ledger != ledger.PoolWithdrawFlow || flow.Delta.Cmp(wei(500)) != 0 {
		t.Fatalf("want a positive nominal 500 flow, got %+v", flow)
	}
}

// The vault and the pool both emit "Withdrawn", meaning different things.
// Nothing downstream may switch on the event name alone, and the two must end
// up in different books or a lender's pool exit and a depositor's vault exit
// are the same row.
func TestTheTwoWithdrawnEventsAreNotTheSameThing(t *testing.T) {
	vault := mustABI(t, abis.CollateralVault)
	pool := mustABI(t, abis.BorrowLiquidityPool)

	fromVault := decode(t, vault, makeLog(t, vault, "Withdrawn",
		[]common.Hash{topicAddr(alice)}, wei(300), wei(290)))
	fromPool := decode(t, pool, makeLog(t, pool, "Withdrawn",
		[]common.Hash{topicAddr(alice)}, wei(300), wei(290)))

	vaultBook := ""
	for _, e := range fromVault {
		if e.Kind == ledger.KindFlow {
			vaultBook = e.Ledger
		}
	}
	poolBook := ""
	for _, e := range fromPool {
		if e.Kind == ledger.KindFlow {
			poolBook = e.Ledger
		}
	}
	if vaultBook != ledger.Withdrawals {
		t.Fatalf("vault Withdrawn should be %s, got %q", ledger.Withdrawals, vaultBook)
	}
	if poolBook != ledger.PoolWithdrawFlow {
		t.Fatalf("pool Withdrawn should be %s, got %q", ledger.PoolWithdrawFlow, poolBook)
	}
}

// ---------------------------------------------------------------------
// Provenance and unknown events
// ---------------------------------------------------------------------

func TestEveryEntryCarriesItsProvenance(t *testing.T) {
	spec := mustABI(t, abis.CollateralVault)
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
	pool := mustABI(t, abis.BorrowLiquidityPool)
	// Accrued moves the indices, which changes what every scaled balance is
	// worth — but it is not one account's movement and must not become one.
	log := makeLog(t, pool, "Accrued", nil, wei(1), wei(2), wei(3))

	if entries := decode(t, pool, log); len(entries) != 0 {
		t.Fatalf("want no entries, got %+v", entries)
	}
}

func TestUnknownEventIsIgnoredRatherThanFailing(t *testing.T) {
	spec := mustABI(t, abis.CollateralVault)
	// Filtering is by address, so anything the contract emits arrives here.
	// An unrecognised topic must not stall the whole range.
	log := types.Log{
		Address: spec.address,
		Topics:  []common.Hash{crypto.Keccak256Hash([]byte("NotOurEvent(uint256)"))},
	}
	batch, err := spec.decodeLog(421614, log, time.Now())
	if err != nil {
		t.Fatalf("unknown event should not error: %v", err)
	}
	if batch.Len() != 0 {
		t.Fatalf("want no records, got %d", batch.Len())
	}
}
