// Package auth implements Sign-In With Ethereum (EIP-4361) wallet
// authentication and the session tokens issued from it.
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

var (
	ErrBadSignature = errors.New("signature does not recover to the claimed address")
	ErrBadAddress   = errors.New("invalid ethereum address")
)

var addressRe = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

// NormalizeAddress validates an address and returns it EIP-55 checksummed, so
// the same wallet can never land in the database under two different casings.
func NormalizeAddress(addr string) (string, error) {
	addr = strings.TrimSpace(addr)
	if !addressRe.MatchString(addr) {
		return "", ErrBadAddress
	}
	return common.HexToAddress(addr).Hex(), nil
}

// NewNonce returns a 32-byte cryptographically random challenge.
func NewNonce() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// BuildMessage renders an EIP-4361 message. Wallets detect this exact shape and
// render it as a readable sign-in prompt instead of an opaque hex blob.
//
// domain, uri and chainID are bound into the text on purpose: the signature is
// then only meaningful for this site and this chain, so a signature phished on
// another origin cannot be replayed here.
func BuildMessage(domain, address, uri string, chainID int64, nonce string, issuedAt time.Time) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s wants you to sign in with your Ethereum account:\n", domain)
	fmt.Fprintf(&b, "%s\n\n", address)
	b.WriteString("Sign in to GhostStake. This request will not trigger a blockchain transaction or cost any gas fees.\n\n")
	fmt.Fprintf(&b, "URI: %s\n", uri)
	b.WriteString("Version: 1\n")
	fmt.Fprintf(&b, "Chain ID: %d\n", chainID)
	fmt.Fprintf(&b, "Nonce: %s\n", nonce)
	fmt.Fprintf(&b, "Issued At: %s", issuedAt.UTC().Format(time.RFC3339))
	return b.String()
}

// VerifySignature recovers the signer of an EIP-191 personal_sign signature and
// checks it matches expectedAddress.
//
// The caller passes the message the SERVER stored, never one supplied by the
// client. That removes any need to parse untrusted SIWE text and closes the
// class of bugs where a client signs a different message than the one the
// server believes it validated.
func VerifySignature(message, signatureHex, expectedAddress string) error {
	sig, err := hexutil.Decode(signatureHex)
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}
	if len(sig) != 65 {
		return fmt.Errorf("signature must be 65 bytes, got %d", len(sig))
	}

	// personal_sign produces V as 27/28; go-ethereum's recovery wants 0/1.
	switch sig[64] {
	case 27, 28:
		sig[64] -= 27
	case 0, 1:
		// already normalized
	default:
		return fmt.Errorf("unexpected signature V value %d", sig[64])
	}

	pub, err := crypto.SigToPub(accountsTextHash([]byte(message)), sig)
	if err != nil {
		return fmt.Errorf("recover public key: %w", err)
	}

	recovered := crypto.PubkeyToAddress(*pub)
	if !strings.EqualFold(recovered.Hex(), expectedAddress) {
		return ErrBadSignature
	}
	return nil
}

// accountsTextHash implements the EIP-191 personal_sign digest:
//
//	keccak256("\x19Ethereum Signed Message:\n" + len(msg) + msg)
//
// The prefix is what stops a signed login message from ever being replayed as a
// valid transaction, since a transaction hash is computed without it.
func accountsTextHash(data []byte) []byte {
	msg := fmt.Sprintf("\x19Ethereum Signed Message:\n%d%s", len(data), data)
	return crypto.Keccak256([]byte(msg))
}
