package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
)

// signAs produces an EIP-191 personal_sign signature the way a wallet would,
// so the test exercises the real recovery path rather than a stub.
func signAs(t *testing.T, message string) (address, signature string) {
	t.Helper()

	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)

	sig, err := crypto.Sign(accountsTextHash([]byte(message)), key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	// Wallets return V as 27/28; mirror that so we test the normalization.
	sig[64] += 27

	return addr.Hex(), "0x" + toHex(sig)
}

func toHex(b []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, hexdigits[c>>4], hexdigits[c&0x0f])
	}
	return string(out)
}

func TestVerifySignature_ValidSignature(t *testing.T) {
	msg := BuildMessage("ghoststake.io", "0x0000000000000000000000000000000000000000",
		"https://ghoststake.io", 42161, "abc123", time.Now())

	addr, sig := signAs(t, msg)

	if err := VerifySignature(msg, sig, addr); err != nil {
		t.Fatalf("expected valid signature to verify, got %v", err)
	}
}

func TestVerifySignature_WrongAddressRejected(t *testing.T) {
	msg := "hello ghoststake"
	_, sig := signAs(t, msg)

	other := "0x1111111111111111111111111111111111111111"
	if err := VerifySignature(msg, sig, other); err == nil {
		t.Fatal("expected signature from a different key to be rejected")
	}
}

// The core replay guarantee: a signature is bound to the exact bytes signed, so
// it cannot be lifted onto a different challenge.
func TestVerifySignature_TamperedMessageRejected(t *testing.T) {
	msg := BuildMessage("ghoststake.io", "0x0000000000000000000000000000000000000000",
		"https://ghoststake.io", 42161, "nonce-one", time.Now())

	addr, sig := signAs(t, msg)

	tampered := strings.Replace(msg, "nonce-one", "nonce-two", 1)
	if err := VerifySignature(tampered, sig, addr); err == nil {
		t.Fatal("expected signature over a different message to be rejected")
	}
}

func TestNormalizeAddress(t *testing.T) {
	// Same address, different casing, must normalize to one checksummed form.
	lower := "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
	upper := "0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045"

	a, err := NormalizeAddress(lower)
	if err != nil {
		t.Fatalf("normalize lower: %v", err)
	}
	b, err := NormalizeAddress(upper)
	if err != nil {
		t.Fatalf("normalize upper: %v", err)
	}
	if a != b {
		t.Fatalf("casing must normalize to the same address: %q vs %q", a, b)
	}

	for _, bad := range []string{"", "0x123", "not-an-address", "d8da6bf26964af9d7eed9e03e53415d37aa96045"} {
		if _, err := NormalizeAddress(bad); err == nil {
			t.Errorf("expected %q to be rejected", bad)
		}
	}
}

func TestNewNonce_UniqueAndLong(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		n, err := NewNonce()
		if err != nil {
			t.Fatalf("new nonce: %v", err)
		}
		if len(n) != 64 {
			t.Fatalf("expected 64 hex chars (32 bytes), got %d", len(n))
		}
		if seen[n] {
			t.Fatal("nonce collision — generator is not random")
		}
		seen[n] = true
	}
}
