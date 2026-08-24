package chain

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

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

// BlockNumberBig is the current head, for pinning a set of calls to one block.
func (c *Client) BlockNumberBig(ctx context.Context) (*big.Int, error) {
	n, err := c.BlockNumber(ctx)
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetUint64(n), nil
}
