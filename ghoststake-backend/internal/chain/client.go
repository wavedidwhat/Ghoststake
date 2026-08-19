// Package chain wraps JSON-RPC access to Arbitrum.
//
// Arbitrum is an Ethereum L2 and speaks the standard Ethereum JSON-RPC API, so
// the ordinary go-ethereum client works unchanged. Only the RPC URL and chain
// ID differ from L1.
package chain

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
)

// Known Arbitrum chain IDs.
const (
	ChainIDArbitrumOne     int64 = 42161
	ChainIDArbitrumSepolia int64 = 421614
)

type Client struct {
	eth     *ethclient.Client
	chainID int64
}

// Dial connects and verifies the endpoint really is the chain we expect.
//
// The chain ID check matters: pointing at the wrong RPC (mainnet instead of
// testnet, say) would otherwise fail silently and produce signatures and reads
// against the wrong network.
func Dial(ctx context.Context, rpcURL string, expectedChainID int64) (*Client, error) {
	c, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial rpc: %w", err)
	}

	got, err := c.ChainID(ctx)
	if err != nil {
		c.Close()
		return nil, fmt.Errorf("fetch chain id: %w", err)
	}
	if got.Int64() != expectedChainID {
		c.Close()
		return nil, fmt.Errorf("chain id mismatch: rpc reports %d, config expects %d", got.Int64(), expectedChainID)
	}

	return &Client{eth: c, chainID: expectedChainID}, nil
}

func (c *Client) Close() { c.eth.Close() }

func (c *Client) ChainID() int64 { return c.chainID }

func (c *Client) BlockNumber(ctx context.Context) (uint64, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	n, err := c.eth.BlockNumber(ctx)
	if err != nil {
		return 0, fmt.Errorf("block number: %w", err)
	}
	return n, nil
}

// BalanceOf returns the native ETH balance in wei.
func (c *Client) BalanceOf(ctx context.Context, address string) (*big.Int, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	bal, err := c.eth.BalanceAt(ctx, commonAddress(address), nil)
	if err != nil {
		return nil, fmt.Errorf("balance of %s: %w", address, err)
	}
	return bal, nil
}
