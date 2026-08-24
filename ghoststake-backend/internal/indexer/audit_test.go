package indexer

import (
	"context"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/wavedidwhat/ghoststake/internal/auth"
	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// Audit finding 1: the indexer lowercased addresses while auth stores them
// EIP-55 checksummed, so `users.address` and `ledger_entries.account` never
// matched. GHO-17's first query is "this signed-in user's balances", which
// would have returned nothing at all.
//
// Pinned across packages so the two cannot drift apart again.
func TestAccountFormatMatchesAuth(t *testing.T) {
	const mixed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"

	fromAuth, err := auth.NormalizeAddress(mixed)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}

	spec := mustABI(t, "CollateralVault.json")
	log := makeLog(t, spec, "Deposited",
		[]common.Hash{common.HexToHash(mixed)}, wei(1), wei(1))
	entries := decode(t, spec, log)

	if entries[0].Account != fromAuth {
		t.Fatalf("account format drifted from auth:\n  auth:    %s\n  indexer: %s", fromAuth, entries[0].Account)
	}
	// Guards the specific regression: a lowercased form compares equal to
	// neither the checksummed one nor a user row.
	if entries[0].Account == strings.ToLower(mixed) && fromAuth != strings.ToLower(mixed) {
		t.Fatal("indexer is still lowercasing accounts")
	}
}

// Audit finding 2: a missing or renamed ABI field decoded to zero and empty
// string, so the indexer kept writing entries — zero deltas, blank accounts —
// while reporting healthy. Silence is worse than failure here.
func TestMissingFieldFailsRatherThanWritingZero(t *testing.T) {
	f := &fields{args: map[string]any{}}

	if got := f.amount("scaledAmount"); got.Sign() != 0 {
		t.Fatalf("expected the zero placeholder, got %s", got)
	}
	if got := f.addr("user"); got != "" {
		t.Fatalf("expected the empty placeholder, got %q", got)
	}

	err := f.err("Borrowed")
	if err == nil {
		t.Fatal("missing fields did not produce an error")
	}
	// The message has to name what was missing: the whole point is that
	// someone reads it and regenerates the ABIs.
	for _, want := range []string{"Borrowed", "scaledAmount", "user"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error does not mention %q: %v", want, err)
		}
	}
}

// The failure must reach the caller, not be swallowed inside decodeLog.
func TestDecodeSurfacesAFieldMismatch(t *testing.T) {
	spec := mustABI(t, "CollateralVault.json")
	spec.decode = func(_ string, f *fields, _ types.Log) []ledger.Entry {
		// Stands in for a contract that renamed a field.
		return []ledger.Entry{{Account: f.addr("renamed"), Delta: f.amount("alsoRenamed")}}
	}

	log := makeLog(t, spec, "Deposited", []common.Hash{topicAddr(alice)}, wei(1), wei(1))
	if _, err := spec.decodeLog(421614, log, testTime()); err == nil {
		t.Fatal("decodeLog swallowed a field mismatch")
	}
}

// Audit finding 3: StartBlock is unsigned and the first cursor is
// `StartBlock - 1`, so zero wrapped to the top of uint64 and the opening
// range came out of an overflow rather than a decision.
func TestStartBlockZeroIsRejected(t *testing.T) {
	_, err := New(newFakeChain(10), newFakeRepo(), Config{
		ChainID:      421614,
		VaultAddress: common.HexToAddress(vaultAddr).Hex(),
		PoolAddress:  common.HexToAddress(poolAddr).Hex(),
		StartBlock:   0,
	})
	if err == nil {
		t.Fatal("StartBlock 0 was accepted")
	}
}

// A decode failure must stop the cycle rather than committing a partial
// batch and advancing the cursor past the logs it could not read.
func TestADecodeFailureDoesNotAdvanceTheCursor(t *testing.T) {
	chain := newFakeChain(100)
	chain.logs = []types.Log{transferLog(t, 5, "0x01", 0)}
	repo := newFakeRepo()

	ix := newTestIndexer(t, chain, repo, Config{StartBlock: 1, Confirmations: 0, BatchSize: 100})
	ix.contracts[0].decode = func(_ string, f *fields, _ types.Log) []ledger.Entry {
		return []ledger.Entry{{Account: f.addr("nope")}}
	}

	if err := ix.Step(context.Background()); err == nil {
		t.Fatal("want an error from the failed decode")
	}
	if repo.cursor != nil {
		t.Fatal("cursor advanced past logs that could not be decoded")
	}
	if len(repo.entries) != 0 {
		t.Fatalf("wrote %d entries despite the failure", len(repo.entries))
	}
}
