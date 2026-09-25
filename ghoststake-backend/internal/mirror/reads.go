package mirror

import (
	"context"
	"fmt"
	"math/big"

	"forge.wavedidwhat.com/wave/ghoststake/internal/chain"
)

// The reads a mirror makes, kept together because each one is a place where a
// wrong type would become a wrong price rather than an error.

// ReadLatest reads an aggregator's newest answer.
//
// `latestRoundData` returns (roundId, answer, startedAt, updatedAt,
// answeredInRound). The mirror wants the answer and `updatedAt` — the moment
// the source *published*, not `startedAt`, which is when its round began
// collecting and is earlier. Carrying the wrong one across would age every
// mirrored price by the length of a source round.
func ReadLatest(ctx context.Context, feed *chain.Contract) (Reading, error) {
	values, err := feed.CallAt(ctx, nil, "latestRoundData")
	if err != nil {
		return Reading{}, err
	}
	if len(values) < 4 {
		return Reading{}, fmt.Errorf("latestRoundData returned %d values, want 5", len(values))
	}

	answer, ok := values[1].(*big.Int)
	if !ok {
		return Reading{}, fmt.Errorf("latestRoundData answer is %T, want *big.Int", values[1])
	}
	updatedAt, ok := values[3].(*big.Int)
	if !ok {
		return Reading{}, fmt.Errorf("latestRoundData updatedAt is %T, want *big.Int", values[3])
	}
	if !updatedAt.IsUint64() {
		return Reading{}, fmt.Errorf("latestRoundData updatedAt is %s, which is not a timestamp", updatedAt)
	}

	return Reading{Answer: answer, UpdatedAt: updatedAt.Uint64()}, nil
}

// ReadRound reads a DemoPriceFeed's newest published round.
//
// Used once, at startup, to learn where a destination already is. Without it a
// restarted mirror would try to republish an answer it has already written and
// revert with TimestampNotAdvanced on every tick — working, in the sense that
// nothing is corrupted, and indistinguishable in the log from a mirror that is
// genuinely broken.
func ReadRound(ctx context.Context, feed *chain.Contract) (Reading, error) {
	return ReadLatest(ctx, feed)
}

// readUint8 reads a view declared `uint8`.
func readUint8(ctx context.Context, c *chain.Contract, method string) (uint8, error) {
	v, err := c.CallUint64(ctx, nil, method)
	if err != nil {
		return 0, err
	}
	if v > 255 {
		return 0, fmt.Errorf("%s returned %d, which is not a uint8", method, v)
	}
	return uint8(v), nil
}

// readString reads a view declared `string`.
func readString(ctx context.Context, c *chain.Contract, method string) (string, error) {
	values, err := c.CallAt(ctx, nil, method)
	if err != nil {
		return "", err
	}
	text, ok := values[0].(string)
	if !ok {
		return "", fmt.Errorf("%s returned %T, want string", method, values[0])
	}
	return text, nil
}
