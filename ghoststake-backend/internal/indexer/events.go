// Package indexer reads contract logs and turns them into append-only ledger
// entries.
package indexer

import (
	"embed"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

//go:embed abis/*.json
var abiFS embed.FS

// contractSpec binds a deployed address to the ABI and the decoder for it.
type contractSpec struct {
	name    string
	address common.Address
	abi     abi.ABI
	decode  func(name string, args map[string]any, log types.Log) []ledger.Entry
}

func loadABI(file string) (abi.ABI, error) {
	raw, err := abiFS.ReadFile("abis/" + file)
	if err != nil {
		return abi.ABI{}, fmt.Errorf("read embedded abi %s: %w", file, err)
	}
	// The generated files hold a bare array of event objects, which is a
	// valid ABI document on its own.
	parsed, err := abi.JSON(strings.NewReader(string(raw)))
	if err != nil {
		return abi.ABI{}, fmt.Errorf("parse abi %s: %w", file, err)
	}
	return parsed, nil
}

// decodeLog turns one log into zero or more ledger entries.
func (c contractSpec) decodeLog(chainID int64, log types.Log, blockTime time.Time) ([]ledger.Entry, error) {
	if len(log.Topics) == 0 {
		return nil, nil
	}
	event, err := c.abi.EventByID(log.Topics[0])
	if err != nil {
		// Not an event we track. Normal: the filter is by address, so
		// everything a watched contract emits arrives here.
		return nil, nil
	}

	args := map[string]any{}
	if len(log.Data) > 0 {
		if err := c.abi.UnpackIntoMap(args, event.Name, log.Data); err != nil {
			return nil, fmt.Errorf("unpack %s: %w", event.Name, err)
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
			return nil, fmt.Errorf("parse topics %s: %w", event.Name, err)
		}
	}

	entries := c.decode(event.Name, args, log)
	for i := range entries {
		entries[i].ChainID = chainID
		entries[i].BlockNumber = log.BlockNumber
		entries[i].BlockHash = log.BlockHash.Hex()
		entries[i].BlockTime = blockTime
		entries[i].TxHash = log.TxHash.Hex()
		entries[i].LogIndex = log.Index
		entries[i].EntryIndex = i
		entries[i].Contract = c.name
		entries[i].EventName = event.Name
	}
	return entries, nil
}

func addr(args map[string]any, key string) string {
	v, ok := args[key].(common.Address)
	if !ok {
		return ""
	}
	return strings.ToLower(v.Hex())
}

func amount(args map[string]any, key string) *big.Int {
	v, ok := args[key].(*big.Int)
	if !ok {
		return new(big.Int)
	}
	return new(big.Int).Set(v)
}

func neg(v *big.Int) *big.Int { return new(big.Int).Neg(v) }

var zeroAddress = strings.ToLower(common.Address{}.Hex())

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
func decodeVault(name string, args map[string]any, _ types.Log) []ledger.Entry {
	switch name {
	// The shares book. Mint, burn and transfer in one event.
	case "Transfer":
		from, to := addr(args, "from"), addr(args, "to")
		value := amount(args, "value")
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
			Kind: ledger.KindFlow, Account: addr(args, "user"), Ledger: ledger.Deposits,
			Delta: amount(args, "assets"),
		}}

	case "Withdrawn":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: addr(args, "user"), Ledger: ledger.Withdrawals,
			Delta: amount(args, "assets"),
		}}

	case "YieldSettled":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: addr(args, "user"), Ledger: ledger.YieldSettled,
			Delta: amount(args, "yieldAccrued"),
		}}

	case "LienSettledAtExit":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: addr(args, "user"), Ledger: ledger.LienSettled,
			Delta: amount(args, "lienAmount"),
		}}

	case "Borrowed":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: addr(args, "user"), Ledger: ledger.BorrowFlow,
			Delta: amount(args, "amount"),
		}}

	case "Repaid":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: addr(args, "user"), Ledger: ledger.RepayFlow,
			Delta: amount(args, "amount"), Counterparty: addr(args, "payer"),
		}}

	case "Liquidated":
		return []ledger.Entry{{
			Kind: ledger.KindFlow, Account: addr(args, "user"), Ledger: ledger.Liquidations,
			Delta: amount(args, "debtRepaid"), Counterparty: addr(args, "liquidator"),
		}}
	}
	// Deposit, Withdraw, Approval, PositionTransferred: either an ERC-4626
	// restatement of an event already handled, or not ledger-bearing.
	return nil
}

// decodePool maps BorrowLiquidityPool events to entries.
//
// The scaled amount is the balance-bearing figure; see ledger.DebtScaled.
func decodePool(name string, args map[string]any, _ types.Log) []ledger.Entry {
	switch name {
	case "Supplied":
		return []ledger.Entry{{
			Kind: ledger.KindBalance, Account: addr(args, "user"), Ledger: ledger.SupplyScaled,
			Delta: amount(args, "scaledAmount"),
		}}

	case "Withdrawn":
		return []ledger.Entry{{
			Kind: ledger.KindBalance, Account: addr(args, "user"), Ledger: ledger.SupplyScaled,
			Delta: neg(amount(args, "scaledAmount")),
		}}

	case "Borrowed":
		return []ledger.Entry{{
			Kind: ledger.KindBalance, Account: addr(args, "user"), Ledger: ledger.DebtScaled,
			Delta: amount(args, "scaledAmount"),
		}}

	case "Repaid":
		return []ledger.Entry{{
			Kind: ledger.KindBalance, Account: addr(args, "user"), Ledger: ledger.DebtScaled,
			Delta: neg(amount(args, "scaledAmount")), Counterparty: addr(args, "payer"),
		}}
	}
	// Accrued, BorrowModuleSet, ReservesWithdrawn, OwnershipTransferred:
	// protocol-level, not per-account.
	return nil
}
