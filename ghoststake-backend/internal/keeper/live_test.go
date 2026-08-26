package keeper_test

import (
	"context"
	"math/big"
	"os"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/abis"
	"github.com/wavedidwhat/ghoststake/internal/chain"
	"github.com/wavedidwhat/ghoststake/internal/keeper"
)

// The keeper's rules are a Go restatement of guards written in Solidity, and
// a restatement that drifts is a keeper paying gas for transactions that
// revert. The unit tests pin the restatement against itself; this pins it
// against the contract.
//
// `phaseOf` is the contract's own answer to "what state is this round in",
// derived from the same stored status and the same clock. If ActionFor and
// phaseOf ever disagree about a round, one of them is wrong about the
// contract — and it is not phaseOf.
//
// Needs the local stack up (scripts/local-stack.sh). Run it with
// `make test-live`.
func TestKeeperRulesAgreeWithTheContract(t *testing.T) {
	rpcURL, registry := os.Getenv("LIVE_RPC_URL"), os.Getenv("REGISTRY_ADDRESS")
	if rpcURL == "" || registry == "" {
		t.Skip("needs LIVE_RPC_URL and REGISTRY_ADDRESS")
	}

	ctx := context.Background()
	client, err := chain.Dial(ctx, rpcURL, 31337)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	nyse, err := keeper.NYSESession()
	if err != nil {
		t.Fatal(err)
	}
	markets, err := keeper.Discover(ctx, client, registry, nil, nyse, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(markets) == 0 {
		t.Fatal("the registry lists no enabled markets")
	}

	head, err := client.HeaderByNumber(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := head.Time

	// The contract's own view, bound separately so the comparison is against
	// what the chain says rather than against another copy of our reading.
	checked := 0
	for _, m := range markets {
		market, err := client.Bind(abis.ParimutuelRound, m.Address.Hex())
		if err != nil {
			t.Fatal(err)
		}
		count, err := m.RoundCount(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for id := uint64(1); id <= count; id++ {
			round, err := m.RoundAt(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			phase, err := market.CallUint64(ctx, new(big.Int).SetUint64(head.Number.Uint64()), "phaseOf", new(big.Int).SetUint64(id))
			if err != nil {
				t.Fatal(err)
			}
			assertActionMatchesPhase(t, m, id, round, phase, now)
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no rounds to check — seed the stack first")
	}
	t.Logf("checked %d rounds across %d markets", checked, len(markets))
}

// ParimutuelRound.Phase, in declaration order.
const (
	phaseNone uint64 = iota
	phaseOpen
	phaseCutoff
	phaseObservation
	phaseResolved
	phaseVoid
)

func assertActionMatchesPhase(t *testing.T, m *keeper.Market, id uint64, round keeper.Round, phase, now uint64) {
	t.Helper()
	action := keeper.ActionFor(round, m.Timing, now)

	switch phase {
	case phaseResolved, phaseVoid, phaseNone:
		// Terminal. Anything but None here is the keeper about to spend gas
		// on a round that cannot move.
		if action != keeper.ActionNone {
			t.Fatalf("%s round %d: contract says settled, keeper wants %q", m.Address.Hex(), id, action)
		}
	case phaseOpen, phaseCutoff:
		// Stored Open. Which of lock, void or wait is right depends on the
		// clock, but Resolve never is: nothing has captured a strike.
		if action == keeper.ActionResolve || action == keeper.ActionVoidUnsettled {
			t.Fatalf("%s round %d: contract says unlocked, keeper wants %q", m.Address.Hex(), id, action)
		}
	case phaseObservation:
		// Stored Locked. Locking again is the error to catch here.
		if action == keeper.ActionLock || action == keeper.ActionVoidUnlocked {
			t.Fatalf("%s round %d: contract says locked, keeper wants %q", m.Address.Hex(), id, action)
		}
	default:
		t.Fatalf("unknown phase %d", phase)
	}
}

// The market-hours gate reads the chain rather than an environment variable:
// a feed implementing the advisory `oraclePaused()` is a Robinhood Stock
// Token feed and follows a trading session, and one that does not is 24/7.
//
// Locally both markets run on a DemoPriceFeed, which implements no such
// thing — so both must come back ungated. A keeper that decided otherwise
// would open no rounds at all outside US market hours, which is most of the
// time the demo is likely to be run.
func TestLocalMarketsAreNotSessionGated(t *testing.T) {
	rpcURL, registry := os.Getenv("LIVE_RPC_URL"), os.Getenv("REGISTRY_ADDRESS")
	if rpcURL == "" || registry == "" {
		t.Skip("needs LIVE_RPC_URL and REGISTRY_ADDRESS")
	}

	ctx := context.Background()
	client, err := chain.Dial(ctx, rpcURL, 31337)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	nyse, err := keeper.NYSESession()
	if err != nil {
		t.Fatal(err)
	}
	markets, err := keeper.Discover(ctx, client, registry, nil, nyse, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range markets {
		if m.Session != nil {
			t.Fatalf("%s was gated on US market hours, but its feed is a DemoPriceFeed", m.String())
		}
		if m.Description == "" {
			t.Fatalf("%s: no feed description read", m.Address.Hex())
		}
	}
}
