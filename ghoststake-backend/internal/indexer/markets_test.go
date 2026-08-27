package indexer

import (
	"context"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/wavedidwhat/ghoststake/internal/abis"
	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// A second market, distinct from `marketAddr`.
const secondMarketAddr = "0x000000000000000000000000000000000000003b"

// The routing test that never existed.
//
// `rounds_test.go` builds a contractSpec by hand and calls decodeLog on it, so
// it proves the decoders and nothing about which decoder a log reaches. That
// gap was invisible because vaultAddr, poolAddr and marketAddr were "…v1",
// "…p1" and "…m1" — not hex, so common.HexToAddress returned the zero address
// for all three and every log in the package routed to whichever spec came
// first. Now that the market is stamped from the spec that decoded a log,
// routing is what decides whether a position is filed under the right market.
func TestLogsReachTheMarketTheyWereEmittedBy(t *testing.T) {
	chain := newFakeChain(10)
	repo := newFakeRepo()

	first := common.HexToAddress(marketAddr)
	second := common.HexToAddress(secondMarketAddr)

	ix := newTestIndexerWithMarkets(t, chain, repo,
		Config{StartBlock: 1, Confirmations: 0, BatchSize: 1000},
		[]string{first.Hex(), second.Hex()})

	spec := mustABI(t, abis.ParimutuelRound)
	// The same round id in both markets, which is the normal case rather than
	// a contrived one: ids restart at 1 in every ParimutuelRound.
	a := makeLog(t, spec, "RoundOpened", []common.Hash{topicUint(7)}, uint64(1), uint64(2), uint64(3))
	a.Address, a.BlockNumber, a.TxHash, a.Index = first, 5, common.HexToHash("0xaa"), 0
	b := makeLog(t, spec, "RoundOpened", []common.Hash{topicUint(7)}, uint64(1), uint64(2), uint64(3))
	b.Address, b.BlockNumber, b.TxHash, b.Index = second, 5, common.HexToHash("0xbb"), 0

	chain.logs = []types.Log{a, b}

	if err := ix.Step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}

	if len(repo.rounds) != 2 {
		t.Fatalf("want both markets' round 7, got %d events", len(repo.rounds))
	}
	seen := map[string]bool{}
	for _, e := range repo.rounds {
		if e.RoundID != 7 {
			t.Fatalf("wrong round id %d", e.RoundID)
		}
		seen[e.Market] = true
	}
	if !seen[first.Hex()] || !seen[second.Hex()] {
		t.Fatalf("markets not distinguished: %v", seen)
	}
}

// A market listed twice is a copy-paste in an env var. Every one of its logs
// would decode twice — harmless at the insert, which is idempotent, but the
// fingerprint and the log lines would both describe a set that does not exist.
func TestADuplicateMarketIsRefused(t *testing.T) {
	_, err := New(&fakeChain{}, newFakeRepo(), Config{
		ChainID:      421614,
		VaultAddress: common.HexToAddress(vaultAddr).Hex(),
		PoolAddress:  common.HexToAddress(poolAddr).Hex(),
		MarketAddresses: []string{
			common.HexToAddress(marketAddr).Hex(),
			common.HexToAddress(marketAddr).Hex(),
		},
		StartBlock: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "more than once") {
		t.Fatalf("want a duplicate-market refusal, got %v", err)
	}
}

// Migration 0005 added the market column and could not fill it: SQL has no
// access to which market this process watches. With exactly one configured the
// attribution is a fact, so preflight makes it.
func TestPreflightAttributesLegacyRowsToTheOnlyMarket(t *testing.T) {
	repo := newFakeRepo()
	repo.rounds = append(repo.rounds, ledger.RoundEvent{
		Provenance: ledger.Provenance{ChainID: 421614, BlockNumber: 3},
		RoundID:    1,
	})
	ix := newTestIndexer(t, newFakeChain(10), repo, Config{StartBlock: 1})

	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if got := repo.rounds[0].Market; got != common.HexToAddress(marketAddr).Hex() {
		t.Fatalf("legacy row not attributed, market is %q", got)
	}
}

// With more than one it is a guess, and a wrong guess is invisible forever
// after: it does not fail, it files someone's position under a market they
// never entered and sums it into the wrong pool.
func TestPreflightRefusesToGuessAmongSeveralMarkets(t *testing.T) {
	repo := newFakeRepo()
	repo.rounds = append(repo.rounds, ledger.RoundEvent{
		Provenance: ledger.Provenance{ChainID: 421614, BlockNumber: 3},
		RoundID:    1,
	})
	ix := newTestIndexerWithMarkets(t, newFakeChain(10), repo, Config{StartBlock: 1},
		[]string{
			common.HexToAddress(marketAddr).Hex(),
			common.HexToAddress(secondMarketAddr).Hex(),
		})

	err := ix.Preflight(context.Background())
	if err == nil {
		t.Fatal("want a refusal rather than a guess")
	}
	// The message has to name both the count and the addresses, because the
	// person reading it is the only one who can say which market those rows
	// belong to.
	for _, want := range []string{"carry no market", common.HexToAddress(secondMarketAddr).Hex()} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("refusal does not mention %q: %v", want, err)
		}
	}
	if repo.rounds[0].Market != "" {
		t.Fatal("rows were attributed despite the refusal")
	}
}

// Nothing to attribute is the steady state, and must not log or write.
func TestPreflightIsAQuietNoOpWithNothingToAttribute(t *testing.T) {
	repo := newFakeRepo()
	ix := newTestIndexer(t, newFakeChain(10), repo, Config{StartBlock: 1})
	if err := ix.Preflight(context.Background()); err != nil {
		t.Fatalf("preflight: %v", err)
	}
}
