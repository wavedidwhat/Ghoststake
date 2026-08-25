package keeper

import (
	"context"
	"fmt"
	"math/big"
)

// FeedRound is the one field a settlement search cares about.
type FeedRound struct {
	UpdatedAt uint64
}

// RoundReader reads one feed round.
//
// A nil round with a nil error means the id holds no data, which is a real
// answer and not a failure — Chainlink proxies revert on ids below the
// current phase's first round. An error means the question could not be
// asked, and must not be read as "no data": see chain.IsRevert.
type RoundReader func(ctx context.Context, id *big.Int) (*FeedRound, error)

// FindCloseRound returns the feed round a resolve has to name: the last one
// published at or before `closeTime`. Nil means there is nothing to settle
// against yet.
//
// # Why a binary search
//
// A feed on a 20-second heartbeat has published tens of thousands of rounds
// by the time anyone settles anything, so walking back from the latest is one
// RPC request per round.
//
// # Why the search is over a predicate rather than over timestamps
//
// The obvious version seeds a range by walking back in doubling steps, and
// gets the seeding wrong on every feed whose history does not start at id 1.
// The fix is to notice that this predicate —
//
//	P(id) = the id holds no data, OR its price is at or before the close
//
// — is true for every id below the answer and false for every id above it.
// Empty ids below the phase floor are true and sort with the low half; rounds
// published after the close are false and sort with the high half. That is
// monotone across the whole range, which is the only property a binary search
// needs, and it needs no seeding at all.
//
// # What the answer is worth
//
// The round returned always has a successor published strictly after the
// close, because the id above the answer fails the predicate and failing it
// means existing *and* being after the close. That is exactly the pair of
// facts `ChainlinkRoundOracle.readAt` verifies — but this function is not the
// authority on it. The adapter is, and the keeper dry-runs `readAt` against
// this candidate before spending gas on it. The search only has to be right
// often enough to be worth doing; the contract is what makes it safe.
//
// This mirrors `findCloseRound` in the operator console's `src/lib/operator.ts`.
func FindCloseRound(ctx context.Context, read RoundReader, latestID *big.Int, closeTime uint64) (*big.Int, error) {
	if latestID == nil || latestID.Sign() <= 0 {
		return nil, nil
	}

	latest, err := read(ctx, latestID)
	if err != nil {
		return nil, fmt.Errorf("keeper: read latest feed round: %w", err)
	}
	// Nothing published since the close, so no round can be both the last one
	// before it and have a successor after it. Waiting is the answer, and the
	// round contract knows how long it is willing to wait.
	if latest == nil || latest.UpdatedAt <= closeTime {
		return nil, nil
	}

	holds := func(id *big.Int) (bool, error) {
		round, err := read(ctx, id)
		if err != nil {
			return false, err
		}
		return round == nil || round.UpdatedAt <= closeTime, nil
	}

	// Invariant: P(lo) is true, P(hi) is false. Id 0 exists on no feed, so it
	// holds no data and satisfies P — a valid floor without a read.
	lo := big.NewInt(0)
	hi := new(big.Int).Set(latestID)
	one := big.NewInt(1)

	for new(big.Int).Sub(hi, lo).Cmp(one) > 0 {
		mid := new(big.Int).Add(lo, new(big.Int).Rsh(new(big.Int).Sub(hi, lo), 1))
		ok, err := holds(mid)
		if err != nil {
			return nil, fmt.Errorf("keeper: feed round search: %w", err)
		}
		if ok {
			lo = mid
		} else {
			hi = mid
		}
	}

	if lo.Sign() == 0 {
		return nil, nil
	}
	// `lo` satisfies P, which is either "at or before the close" or "holds no
	// data". Only the first is an answer, and a feed whose history begins
	// after the close lands on the second.
	answer, err := read(ctx, lo)
	if err != nil {
		return nil, fmt.Errorf("keeper: read candidate feed round: %w", err)
	}
	if answer == nil {
		return nil, nil
	}
	return lo, nil
}
