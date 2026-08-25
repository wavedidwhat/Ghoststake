package chain

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/rpc"
)

// Signer sends transactions from one hot key.
//
// The only writer in the Go layer, and deliberately the only thing in it that
// holds a key. Everything else in this backend — the indexer, the API, the
// protocol reader — is strictly read-only, and the keeper (GHO-24) is a
// separate binary precisely so that stays true: an API process that cannot
// sign cannot be made to sign.
//
// Sends are serialised. The nonce is read fresh per transaction rather than
// tracked in memory, which is correct only if nothing else is in flight from
// the same address — so the mutex is what makes the simple nonce policy safe
// rather than an optimisation.
type Signer struct {
	client *Client
	key    *ecdsa.PrivateKey
	from   common.Address

	// mu serialises the read-nonce/sign/send/wait sequence.
	mu sync.Mutex

	// receiptTimeout bounds how long to wait for a transaction to be mined
	// before giving up on it. Giving up is not the same as the transaction
	// failing: it may still land, so the caller must treat a timeout as
	// "unknown", not as "did not happen".
	receiptTimeout time.Duration
	pollInterval   time.Duration
}

// ErrReceiptTimeout means the transaction was accepted by the node but had
// not been mined when we stopped waiting. It may still be mined.
var ErrReceiptTimeout = errors.New("chain: timed out waiting for receipt")

// NewSigner parses a hex private key, with or without the 0x prefix.
func NewSigner(client *Client, hexKey string) (*Signer, error) {
	key, err := crypto.HexToECDSA(strings.TrimPrefix(strings.TrimSpace(hexKey), "0x"))
	if err != nil {
		// Deliberately not wrapped: the underlying error from a malformed key
		// can echo the key material back into the logs.
		return nil, fmt.Errorf("chain: private key is not valid hex-encoded ECDSA")
	}
	return &Signer{
		client:         client,
		key:            key,
		from:           crypto.PubkeyToAddress(key.PublicKey),
		receiptTimeout: 2 * time.Minute,
		pollInterval:   2 * time.Second,
	}, nil
}

// Address is the hot wallet's address — the one that needs gas, and the one
// `openRound` has to see as the market's owner.
func (s *Signer) Address() common.Address { return s.from }

// Balance is the signer's own gas balance.
func (s *Signer) Balance(ctx context.Context) (*big.Int, error) {
	return s.client.BalanceOf(ctx, s.from.Hex())
}

// Simulate runs the call without sending it, and returns the contract's own
// revert reason when it would fail.
//
// Every write goes through this first. A reverted transaction still costs
// gas, and on a chain where a keeper retries on a timer that is a slow leak
// of the one thing the keeper needs to keep working. It also turns the
// contract's custom errors into something a log line can carry: "TooEarly"
// says the caller is ahead of a deadline, where a bare "execution reverted"
// says nothing at all.
//
// Run against the *pending* block, not the latest one, and that is not a
// detail. A time-dependent guard is evaluated against `block.timestamp`, and
// the latest block's timestamp is whenever the chain last had a reason to
// mine — on an idle chain, minutes ago. Simulating there while the caller
// decided what to do from the pending clock is two clocks disagreeing, and it
// showed up exactly as it should have: half of a keeper run's rounds refused
// their lock with TooEarly, backed off through the whole lock window, and
// voided instead of settling. Estimation already runs against pending; this
// is what makes the check before it agree.
func (s *Signer) Simulate(ctx context.Context, c *Contract, method string, args ...any) error {
	packed, err := c.abi.Pack(method, args...)
	if err != nil {
		return fmt.Errorf("chain: pack %s.%s: %w", c.name, method, err)
	}
	_, err = s.client.eth.CallContract(ctx, ethereum.CallMsg{
		From: s.from,
		To:   &c.address,
		Data: packed,
	}, PendingBlockNumber)
	if err != nil {
		return fmt.Errorf("chain: %s.%s would revert: %s", c.name, method, describeRevert(c.abi, err))
	}
	return nil
}

// Send simulates, signs and submits the call, then waits for its receipt.
//
// Returns the hash alongside the error whenever there is one to return, so a
// caller that times out waiting can still say which transaction it lost track
// of.
func (s *Signer) Send(ctx context.Context, c *Contract, method string, args ...any) (common.Hash, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.Simulate(ctx, c, method, args...); err != nil {
		return common.Hash{}, err
	}

	packed, err := c.abi.Pack(method, args...)
	if err != nil {
		return common.Hash{}, fmt.Errorf("chain: pack %s.%s: %w", c.name, method, err)
	}

	tx, err := s.build(ctx, c, packed)
	if err != nil {
		return common.Hash{}, err
	}

	signed, err := types.SignTx(tx, types.LatestSignerForChainID(big.NewInt(s.client.chainID)), s.key)
	if err != nil {
		return common.Hash{}, fmt.Errorf("chain: sign %s.%s: %w", c.name, method, err)
	}
	if err := s.client.eth.SendTransaction(ctx, signed); err != nil {
		return signed.Hash(), fmt.Errorf("chain: send %s.%s: %w", c.name, method, err)
	}

	receipt, err := s.wait(ctx, signed.Hash())
	if err != nil {
		return signed.Hash(), err
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		// Reached despite the simulation above when the chain moved between
		// the two — another caller locked the same round a block earlier,
		// say. Worth a distinct message: it means a race, not a bug in the
		// keeper's rules.
		return signed.Hash(), fmt.Errorf("chain: %s.%s reverted on chain in block %d", c.name, method, receipt.BlockNumber)
	}
	return signed.Hash(), nil
}

// build fills in nonce, gas and fees.
//
// EIP-1559 where the chain offers a base fee, legacy pricing where it does
// not. The fee cap is the tip plus twice the current base fee, which is the
// usual headroom for a base fee that can double over a few blocks: too tight
// and the transaction sits unmined until the keeper gives up on it, which for
// a lock is the difference between a settled round and a refunded one.
func (s *Signer) build(ctx context.Context, c *Contract, data []byte) (*types.Transaction, error) {
	to := c.address
	nonce, err := s.client.eth.PendingNonceAt(ctx, s.from)
	if err != nil {
		return nil, fmt.Errorf("chain: pending nonce: %w", err)
	}

	gas, err := s.client.eth.EstimateGas(ctx, ethereum.CallMsg{From: s.from, To: &to, Data: data})
	if err != nil {
		// Estimation executes the call, so it fails for the same reasons
		// Simulate does — and reaching here after Simulate passed means the
		// chain moved between the two. Decoded the same way regardless: a
		// named custom error is what says which guard closed.
		return nil, fmt.Errorf("chain: estimate gas: %s", describeRevert(c.abi, err))
	}
	// Estimation is exact for a deterministic call, but the state it ran
	// against is one block behind the one that executes it. A fifth of
	// headroom costs nothing on a chain that refunds unused gas and avoids an
	// out-of-gas revert that would look identical to a rule being wrong.
	gas = gas + gas/5

	head, err := s.client.eth.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("chain: head: %w", err)
	}

	if head.BaseFee == nil {
		price, err := s.client.eth.SuggestGasPrice(ctx)
		if err != nil {
			return nil, fmt.Errorf("chain: suggest gas price: %w", err)
		}
		return types.NewTx(&types.LegacyTx{
			Nonce:    nonce,
			To:       &to,
			Gas:      gas,
			GasPrice: price,
			Data:     data,
		}), nil
	}

	tip, err := s.client.eth.SuggestGasTipCap(ctx)
	if err != nil {
		return nil, fmt.Errorf("chain: suggest gas tip: %w", err)
	}
	feeCap := new(big.Int).Add(tip, new(big.Int).Mul(head.BaseFee, big.NewInt(2)))

	return types.NewTx(&types.DynamicFeeTx{
		ChainID:   big.NewInt(s.client.chainID),
		Nonce:     nonce,
		To:        &to,
		Gas:       gas,
		GasTipCap: tip,
		GasFeeCap: feeCap,
		Data:      data,
	}), nil
}

func (s *Signer) wait(ctx context.Context, hash common.Hash) (*types.Receipt, error) {
	ctx, cancel := context.WithTimeout(ctx, s.receiptTimeout)
	defer cancel()

	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()

	for {
		receipt, err := s.client.eth.TransactionReceipt(ctx, hash)
		if err == nil {
			return receipt, nil
		}
		if !errors.Is(err, ethereum.NotFound) {
			return nil, fmt.Errorf("chain: receipt %s: %w", hash.Hex(), err)
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("%w: %s", ErrReceiptTimeout, hash.Hex())
		case <-ticker.C:
		}
	}
}

// describeRevert turns an eth_call failure into the contract's own vocabulary.
//
// Nodes return the revert payload out of band, in the JSON-RPC error's `data`
// field, so it never appears in the error string. Matching its four-byte
// selector against the ABI's declared errors recovers the name and the
// arguments — `TooEarly(3, 1756100000)` rather than "execution reverted".
//
// Falls back to the raw error whenever anything about that does not line up:
// this runs on the failure path, and a decoder that panicked or masked the
// original message would be worse than one that gave up.
func describeRevert(parsed abi.ABI, err error) string {
	var dataErr rpc.DataError
	if !errors.As(err, &dataErr) {
		return err.Error()
	}
	hexData, ok := dataErr.ErrorData().(string)
	if !ok {
		return err.Error()
	}
	data := common.FromHex(hexData)

	// A plain `revert("reason")` is Error(string), which the ABI does not
	// declare but every contract can emit.
	if reason, unpackErr := abi.UnpackRevert(data); unpackErr == nil {
		return reason
	}
	if len(data) < 4 {
		return err.Error()
	}

	for _, declared := range parsed.Errors {
		if !strings.EqualFold(common.Bytes2Hex(declared.ID[:4]), common.Bytes2Hex(data[:4])) {
			continue
		}
		values, unpackErr := declared.Inputs.Unpack(data[4:])
		if unpackErr != nil || len(values) == 0 {
			return declared.Name
		}
		parts := make([]string, len(values))
		for i, v := range values {
			parts[i] = fmt.Sprint(v)
		}
		return fmt.Sprintf("%s(%s)", declared.Name, strings.Join(parts, ", "))
	}
	return err.Error()
}
