package chain

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"reflect"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/rpc"

	"github.com/wavedidwhat/ghoststake/internal/abis"
)

// Contract is a bound address plus its ABI: enough to call a view on it.
//
// Hand-rolled rather than abigen'd. abigen generates a few thousand lines per
// contract, all of it committed, all of it regenerated on any ABI change, and
// almost none of it used — the backend reads eight views and writes nothing.
// The ABI is already embedded and already the single source of truth for the
// indexer; this is fifty lines that use it for calls too.
type Contract struct {
	client  *Client
	address common.Address
	abi     abi.ABI
	name    string
}

// Bind prepares calls against a deployed contract by its generated ABI name.
func (c *Client) Bind(name, address string) (*Contract, error) {
	parsed, err := abis.Load(name)
	if err != nil {
		return nil, err
	}
	if !common.IsHexAddress(address) {
		// Checked because common.HexToAddress does not fail — it pads or
		// truncates whatever it is handed, so a typo becomes a valid-looking
		// address with no code, and every call to it returns empty data that
		// unpacks to zero. A zero collateral value is a liquidatable position.
		return nil, fmt.Errorf("chain: %s address is not valid hex: %q", name, address)
	}
	return &Contract{client: c, address: common.HexToAddress(address), abi: parsed, name: name}, nil
}

func (c *Contract) Address() common.Address { return c.address }

// CallAt invokes a view at a specific block and unpacks the result.
//
// The block is a parameter, never "latest", for every call in a request. A
// health factor is a ratio between a collateral value and a debt, and reading
// the two from different blocks produces a number that was true at no point
// in the chain's history. Pinning them costs nothing and removes the whole
// class of it.
func (c *Contract) CallAt(ctx context.Context, block *big.Int, method string, args ...any) ([]any, error) {
	packed, err := c.abi.Pack(method, args...)
	if err != nil {
		return nil, fmt.Errorf("chain: pack %s.%s: %w", c.name, method, err)
	}

	out, err := c.client.eth.CallContract(ctx, ethereum.CallMsg{To: &c.address, Data: packed}, block)
	if err != nil {
		return nil, fmt.Errorf("chain: call %s.%s: %w", c.name, method, err)
	}
	if len(out) == 0 {
		// An empty return from a successful call means there is no code at
		// the address. Reported rather than unpacked, because unpacking it
		// yields zeros that look like real answers.
		return nil, fmt.Errorf("chain: %s.%s returned no data — is %s deployed at %s?",
			c.name, method, c.name, c.address.Hex())
	}

	values, err := c.abi.Unpack(method, out)
	if err != nil {
		return nil, fmt.Errorf("chain: unpack %s.%s: %w", c.name, method, err)
	}
	return values, nil
}

// CallBig is CallAt for the common case: one uint256 out.
func (c *Contract) CallBig(ctx context.Context, block *big.Int, method string, args ...any) (*big.Int, error) {
	values, err := c.CallAt(ctx, block, method, args...)
	if err != nil {
		return nil, err
	}
	v, ok := values[0].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("chain: %s.%s returned %T, want *big.Int", c.name, method, values[0])
	}
	return v, nil
}

// CallUint64 is CallBig for a view whose return type is narrower than 256
// bits.
//
// Solidity's smaller integer types do not decode to *big.Int — `uint64`
// arrives as a Go `uint64`, `uint80` as a *big.Int — so a caller that assumed
// the wide type gets a type error at runtime on exactly the views whose
// declaration it did not check. The round's three timing windows are `uint64`
// and its pools are `uint256`, side by side on the same contract.
func (c *Contract) CallUint64(ctx context.Context, block *big.Int, method string, args ...any) (uint64, error) {
	values, err := c.CallAt(ctx, block, method, args...)
	if err != nil {
		return 0, err
	}
	switch v := values[0].(type) {
	case uint64:
		return v, nil
	case uint32:
		return uint64(v), nil
	case uint16:
		return uint64(v), nil
	case uint8:
		return uint64(v), nil
	case *big.Int:
		if !v.IsUint64() {
			return 0, fmt.Errorf("chain: %s.%s returned %s, which does not fit in a uint64", c.name, method, v)
		}
		return v.Uint64(), nil
	default:
		return 0, fmt.Errorf("chain: %s.%s returned %T, want an unsigned integer", c.name, method, values[0])
	}
}

// BlockNumberBig is the current head, for pinning a set of calls to one block.
func (c *Client) BlockNumberBig(ctx context.Context) (*big.Int, error) {
	n, err := c.BlockNumber(ctx)
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetUint64(n), nil
}

// CallInto is CallAt for a view returning a struct, copied into `out`.
//
// `rounds(uint256)` returns a Solidity struct with eleven fields, and reading
// it out of a `[]any` by position is exactly the kind of code that keeps
// working after somebody reorders two `uint256`s. Copying by field name into
// a declared type does not: a renamed or removed field fails here, loudly,
// instead of arriving as a zero that reads like a real answer.
//
// `out` must be a pointer to a struct whose exported fields match the tuple's,
// in go-ethereum's capitalised spelling — `lockOracleRoundId` becomes
// `LockOracleRoundId`. Extra fields on the returned tuple are ignored; a field
// on `out` with no counterpart is an error.
//
// Not go-ethereum's own `UnpackIntoInterface`. For a method with a single
// anonymous tuple output that function assigns the whole tuple to `out`'s
// *first field*, expecting a wrapper struct — so handing it the struct itself
// silently targets field zero, and with an address there it panics inside
// reflect rather than returning an error.
func (c *Contract) CallInto(ctx context.Context, block *big.Int, out any, method string, args ...any) error {
	values, err := c.CallAt(ctx, block, method, args...)
	if err != nil {
		return err
	}
	if len(values) != 1 {
		return fmt.Errorf("chain: %s.%s returns %d values, not one struct", c.name, method, len(values))
	}
	if err := copyStruct(out, values[0]); err != nil {
		return fmt.Errorf("chain: unpack %s.%s: %w", c.name, method, err)
	}
	return nil
}

// copyStruct assigns matching exported fields from a decoded ABI tuple.
func copyStruct(out any, src any) error {
	pointer := reflect.ValueOf(out)
	if pointer.Kind() != reflect.Pointer || pointer.IsNil() {
		return fmt.Errorf("out must be a non-nil pointer, got %T", out)
	}
	dst := pointer.Elem()
	if dst.Kind() != reflect.Struct {
		return fmt.Errorf("out must point at a struct, got %T", out)
	}
	from := reflect.ValueOf(src)
	if from.Kind() != reflect.Struct {
		return fmt.Errorf("returned value is %T, not a struct", src)
	}

	for i := range dst.NumField() {
		field := dst.Type().Field(i)
		if !field.IsExported() {
			continue
		}
		value := from.FieldByName(field.Name)
		if !value.IsValid() {
			return fmt.Errorf("the returned tuple has no field %q — has the Solidity struct changed?", field.Name)
		}
		if !value.Type().AssignableTo(field.Type) {
			return fmt.Errorf("field %q is %s on chain and %s here", field.Name, value.Type(), field.Type)
		}
		dst.Field(i).Set(value)
	}
	return nil
}

// IsRevert reports whether an error from a call is the contract refusing,
// rather than the network failing to ask it.
//
// The difference decides retries. A revert is an answer — "this round holds no
// data" — and repeating the call gets the same one. A transport failure is not
// an answer at all, and treating it as one is how a flaky RPC turns into a
// confident wrong conclusion.
//
// Nodes report a revert by attaching the revert payload to the JSON-RPC error,
// which is what `rpc.DataError` exposes and what a dial failure or a timeout
// never carries.
func IsRevert(err error) bool {
	var dataErr rpc.DataError
	return errors.As(err, &dataErr)
}
