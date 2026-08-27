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
	// market is set on the ParimutuelRound specs and empty on the others.
	// There is one spec per deployed market, so this is what tells two
	// otherwise identical decoders apart.
	market string
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
		// Stamped from the spec that decoded it, which is bound to one
		// deployed address — so it cannot disagree with where the log came
		// from. `Contract` above is the ABI's *name* ("ParimutuelRound"),
		// which is identical for every market and cannot serve as this.
		batch.Rounds[i].Market = c.market
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
		// A user-to-user move, recorded again as history (GHO-49).
		//
		// Appended *after* the balance entries, never before. RecordIndex is
		// assigned by position, and the insert is idempotent on
		// (chain, tx, log index, record index) — so putting these first would
		// renumber the balance entries already in the table, and a replay
		// would write a second copy of every share movement ever indexed
		// under the vacated indices. Appending leaves 0 and 1 exactly where
		// they are and adds 2 and 3.
		//
		// Mints and burns are excluded because Deposited and Withdrawn
		// already narrate them, and two rows for one deposit reads as a
		// double count whether or not it is one.
		if from != zeroAddress && to != zeroAddress {
			out = append(out,
				ledger.Entry{
					Kind: ledger.KindFlow, Account: from, Ledger: ledger.ShareTransferFlow,
					// Signed, because direction is the whole content of this
					// record: the same log is an outgoing transfer for one
					// account and an incoming one for the other, and an
					// unsigned magnitude on both would make them
					// indistinguishable in a list.
					Delta: neg(value), Counterparty: to,
				},
				ledger.Entry{
					Kind: ledger.KindFlow, Account: to, Ledger: ledger.ShareTransferFlow,
					Delta: value, Counterparty: from,
				},
			)
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
	// Supplied and Withdrawn each write two entries: the scaled balance, and
	// the nominal amount as history (GHO-49).
	//
	// Both come off the same log — `Supplied(user, amount, scaledAmount)` —
	// and the nominal half used to be discarded. That left supplying to the
	// pool as the one user action with no nominal record anywhere, so the
	// only number a history page could show was the scaled one, which is not
	// what the user did. See ledger.SupplyFlow.
	//
	// Balance first, flow second, for the RecordIndex reason spelled out on
	// the vault's Transfer above: these indices are already in the table.
	case "Supplied":
		user := f.addr("user")
		return []ledger.Entry{
			{
				Kind: ledger.KindBalance, Account: user, Ledger: ledger.SupplyScaled,
				Delta: f.amount("scaledAmount"),
			},
			{
				Kind: ledger.KindFlow, Account: user, Ledger: ledger.SupplyFlow,
				Delta: f.amount("amount"),
			},
		}

	case "Withdrawn":
		user := f.addr("user")
		return []ledger.Entry{
			{
				Kind: ledger.KindBalance, Account: user, Ledger: ledger.SupplyScaled,
				Delta: neg(f.amount("scaledAmount")),
			},
			{
				// Positive, unlike the balance entry beside it. A flow is a
				// record of a movement and its name says which way it went;
				// the sign is what makes the balance sum correctly, and a
				// history row reading "-500" for a withdrawal invites the
				// reader to add it to something.
				Kind: ledger.KindFlow, Account: user, Ledger: ledger.PoolWithdrawFlow,
				Delta: f.amount("amount"),
			},
		}

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
