// Package indexer reads contract logs and turns them into append-only ledger
// entries.
package indexer

import (
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// contractSpec binds a deployed address to the ABI and the decoder for it.
type contractSpec struct {
	name    string
	address common.Address
	abi     abi.ABI
	decode  func(name string, f *fields, log types.Log) ledger.Batch
}

// decodeLog turns one log into zero or more ledger records.
func (c contractSpec) decodeLog(chainID int64, log types.Log, blockTime time.Time) (ledger.Batch, error) {
	if len(log.Topics) == 0 {
		return ledger.Batch{}, nil
	}
	event, err := c.abi.EventByID(log.Topics[0])
	if err != nil {
		// Not an event we track. Normal: the filter is by address, so
		// everything a watched contract emits arrives here.
		return ledger.Batch{}, nil
	}

	args := map[string]any{}
	if len(log.Data) > 0 {
		if err := c.abi.UnpackIntoMap(args, event.Name, log.Data); err != nil {
			return ledger.Batch{}, fmt.Errorf("unpack %s: %w", event.Name, err)
		}
	}
	// Indexed arguments live in topics, not in data, and UnpackIntoMap does
	// not touch them.
	indexed := make(abi.Arguments, 0, len(event.Inputs))
	for _, input := range event.Inputs {
		if input.Indexed {
			indexed = append(indexed, input)
		}
	}
	if len(indexed) > 0 {
		if err := abi.ParseTopicsIntoMap(args, indexed, log.Topics[1:]); err != nil {
			return ledger.Batch{}, fmt.Errorf("parse topics %s: %w", event.Name, err)
		}
	}

	f := &fields{args: args}
	batch := c.decode(event.Name, f, log)
	// Checked after decoding rather than per-field, so one bad event names
	// everything it could not read instead of only the first thing.
	if err := f.err(event.Name); err != nil {
		return ledger.Batch{}, err
	}

	// Provenance is stamped here, once, rather than in every decoder: a
	// decoder that forgot a field would write a record no rollback could find.
	//
	// RecordIndex restarts at zero for each kind because the two kinds are
	// written to different tables, each with its own uniqueness constraint on
	// (chain, tx, log index, record index).
	stamp := ledger.Provenance{
		ChainID:     chainID,
		BlockNumber: log.BlockNumber,
		BlockHash:   log.BlockHash.Hex(),
		BlockTime:   blockTime,
		TxHash:      log.TxHash.Hex(),
		LogIndex:    log.Index,
		Contract:    c.name,
		EventName:   event.Name,
	}
	for i := range batch.Entries {
		batch.Entries[i].Provenance = stamp
		batch.Entries[i].RecordIndex = i
	}
	for i := range batch.Rounds {
		batch.Rounds[i].Provenance = stamp
		batch.Rounds[i].RecordIndex = i
	}
	return batch, nil
}

// fields reads decoded event arguments, remembering anything it could not
// find rather than substituting a zero.
//
// The helpers used to return 0 and "" for a missing key. That is the worst
// available behaviour here: rename a field in a contract and the decoder
// keeps producing entries, with zero deltas and empty accounts, while the
// indexer reports healthy. A ledger that records nothing is easier to notice
// than one that records nonsense.
type fields struct {
	args    map[string]any
	missing []string
}

func (f *fields) addr(key string) string {
	v, ok := f.args[key].(common.Address)
	if !ok {
		f.missing = append(f.missing, key)
		return ""
	}
	// EIP-55 checksummed, matching auth.NormalizeAddress. The two must agree
	// or nothing joins a user to their entries — see
	// TestAccountFormatMatchesAuth.
	return v.Hex()
}

func (f *fields) amount(key string) *big.Int {
	v, ok := f.args[key].(*big.Int)
	if !ok {
		f.missing = append(f.missing, key)
		return new(big.Int)
	}
	return new(big.Int).Set(v)
}

// u64 reads a uint64 argument (the round timing fields).
func (f *fields) u64(key string) uint64 {
	v, ok := f.args[key].(uint64)
	if !ok {
		f.missing = append(f.missing, key)
		return 0
	}
	return v
}

// enum reads a Solidity enum, which arrives as a uint8.
func (f *fields) enum(key string) uint8 {
	v, ok := f.args[key].(uint8)
	if !ok {
		f.missing = append(f.missing, key)
		return 0
	}
	return v
}

func (f *fields) str(key string) string {
	v, ok := f.args[key].(string)
	if !ok {
		f.missing = append(f.missing, key)
		return ""
	}
	return v
}

// roundID reads the indexed uint256 round id.
//
// Narrowed to uint64 because it is a counter incremented once per round, and
// a uint64 is what the database column and every URL that names a round use.
// The narrowing is checked rather than assumed: a value that does not fit is
// a decoder bug, not a round id.
func (f *fields) roundID(key string) uint64 {
	v, ok := f.args[key].(*big.Int)
	if !ok || !v.IsUint64() {
		f.missing = append(f.missing, key)
		return 0
	}
	return v.Uint64()
}

func (f *fields) err(event string) error {
	if len(f.missing) == 0 {
		return nil
	}
	return fmt.Errorf("event %s: missing or mistyped fields %v (regenerate abis with `make gen-abis`)", event, f.missing)
}

func neg(v *big.Int) *big.Int { return new(big.Int).Neg(v) }

// entriesOnly adapts a decoder that produces ledger entries and nothing else.
// The vault and the pool are money-only; only the market produces both kinds.
func entriesOnly(fn func(string, *fields, types.Log) []ledger.Entry) func(string, *fields, types.Log) ledger.Batch {
	return func(name string, f *fields, log types.Log) ledger.Batch {
		return ledger.Batch{Entries: fn(name, f, log)}
	}
}

// The mint/burn sentinel, in the same checksummed form fields.addr emits.
// (It has no letters, so the case would not matter — but relying on that is
// an invisible dependency on the checksum algorithm.)
var zeroAddress = common.Address{}.Hex()

// decodeVault maps CollateralVault events to entries.
//
// Two double-counting traps live here, both verified against the contract
// rather than inferred from the event names:
//
//  1. The exit path emits Withdraw, LienSettledAtExit *and* Withdrawn for a
//     single withdrawal, where `assets = lienAmount + collateralReturned`.
//     Only one of them may touch a given book.
//  2. Vault.borrow and Vault.repay each emit their own event *and* cause the
//     pool to emit Borrowed/Repaid for the same movement. The pool's are the
//     balance-bearing ones because they carry the scaled amount; the vault's
//     are recorded as flows.
func decodeVault(name string, f *fields, _ types.Log) []ledger.Entry {
	switch name {
	// The shares book. Mint, burn and transfer in one event.
	case "Transfer":
		from, to := f.addr("from"), f.addr("to")
		value := f.amount("value")
		var out []ledger.Entry
		if from != zeroAddress {
			out = append(out, ledger.Entry{
				Kind: ledger.KindBalance, Account: from, Ledger: ledger.Shares,
				Delta: neg(value), Counterparty: to,
			})
		}
		if to != zeroAddress {
			out = append(out, ledger.Entry{
				Kind: ledger.KindBalance, Account: to, Ledger: ledger.Shares,
				Delta: value, Counterparty: from,
			})
		}
		return out

	case "Deposited":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: f.addr("user"), Ledger: ledger.Deposits,
			Delta: f.amount("assets"),
		}}

	case "Withdrawn":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: f.addr("user"), Ledger: ledger.Withdrawals,
			Delta: f.amount("assets"),
		}}

	case "YieldSettled":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: f.addr("user"), Ledger: ledger.YieldSettled,
			Delta: f.amount("yieldAccrued"),
		}}

	case "LienSettledAtExit":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: f.addr("user"), Ledger: ledger.LienSettled,
			Delta: f.amount("lienAmount"),
		}}

	case "Borrowed":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: f.addr("user"), Ledger: ledger.BorrowFlow,
			Delta: f.amount("amount"),
		}}

	case "Repaid":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: f.addr("user"), Ledger: ledger.RepayFlow,
			Delta: f.amount("amount"), Counterparty: f.addr("payer"),
		}}

	case "Liquidated":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: f.addr("user"), Ledger: ledger.Liquidations,
			Delta: f.amount("debtRepaid"), Counterparty: f.addr("liquidator"),
		}}
	}
	// Deposit, Withdraw, Approval, PositionTransferred: either an ERC-4626
	// restatement of an event already handled, or not ledger-bearing.
	return nil
}

// decodePool maps BorrowLiquidityPool events to entries.
//
// The scaled amount is the balance-bearing figure; see ledger.DebtScaled.
func decodePool(name string, f *fields, _ types.Log) []ledger.Entry {
	switch name {
	case "Supplied":
		return []ledger.Entry{{
			Kind: ledger.KindBalance, Account: f.addr("user"), Ledger: ledger.SupplyScaled,
			Delta: f.amount("scaledAmount"),
		}}

	case "Withdrawn":
		return []ledger.Entry{{
			Kind: ledger.KindBalance, Account: f.addr("user"), Ledger: ledger.SupplyScaled,
			Delta: neg(f.amount("scaledAmount")),
		}}

	case "Borrowed":
		return []ledger.Entry{{
			Kind: ledger.KindBalance, Account: f.addr("user"), Ledger: ledger.DebtScaled,
			Delta: f.amount("scaledAmount"),
		}}

	case "Repaid":
		return []ledger.Entry{{
			Kind: ledger.KindBalance, Account: f.addr("user"), Ledger: ledger.DebtScaled,
			Delta: neg(f.amount("scaledAmount")), Counterparty: f.addr("payer"),
		}}
	}
	// Accrued, BorrowModuleSet, ReservesWithdrawn, OwnershipTransferred:
	// protocol-level, not per-account.
	return nil
}
