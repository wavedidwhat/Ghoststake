package chain

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"strings"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/rpc"
)

// Backoff controls how a retried startup read waits between attempts.
type Backoff struct {
	Base   time.Duration // first wait
	Max    time.Duration // ceiling for a single wait
	Factor float64       // multiplier per attempt
	Jitter float64       // fraction of the wait to randomise, 0.2 = ±20%
	Limit  time.Duration // give up after this long in total; 0 means never
}

// DefaultBackoff retries for five minutes. A provider's rate limit is usually
// measured in seconds, and a process that keeps waiting is cheaper than one
// that exits and is restarted into the same limit. Past that, exiting gets
// the failure in front of a human.
var DefaultBackoff = Backoff{Base: time.Second, Max: 30 * time.Second, Factor: 2, Jitter: 0.2, Limit: 5 * time.Minute}

func (b Backoff) wait(attempt int) time.Duration {
	d := float64(b.Base)
	for range attempt {
		d *= b.Factor
		if d >= float64(b.Max) {
			d = float64(b.Max)
			break
		}
	}
	if b.Jitter > 0 {
		// Jitter spreads retries out, so a restarted keeper and API don't
		// hammer a rate-limited endpoint in lockstep.
		d *= 1 + b.Jitter*(2*rand.Float64()-1)
	}
	return time.Duration(d)
}

// Transient reports whether err is the kind that passes on its own: a rate
// limit, a server-side fault, or a broken connection. Everything else —
// notably a chain ID mismatch or bad credentials — is a standing condition
// that retrying only hides.
func Transient(err error) bool {
	if err == nil {
		return false
	}
	// A cancelled parent context means we are shutting down, not failing.
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	for _, se := range []error{syscall.ECONNREFUSED, syscall.ECONNRESET, syscall.EPIPE, syscall.EHOSTUNREACH, syscall.ENETUNREACH, syscall.ETIMEDOUT} {
		if errors.Is(err, se) {
			return true
		}
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	if he, ok := errors.AsType[rpc.HTTPError](err); ok {
		return he.StatusCode == 429 || he.StatusCode >= 500
	}
	if re, ok := errors.AsType[rpc.Error](err); ok {
		// -32005 is the JSON-RPC code providers use for "limit exceeded".
		return re.ErrorCode() == -32005
	}
	// Providers also report rate limits as plain text through proxies that
	// never produce a typed error. The wording has to stay specific to rate
	// limiting: a bare "limit exceeded" also matches "execution reverted: gas
	// limit exceeded", which is a failing call, not a transient one.
	msg := strings.ToLower(err.Error())
	for _, s := range []string{"too many requests", "rate limit", "request limit", "quota exceeded", "connection reset", "connection refused", "no such host"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// Retry runs fn until it succeeds, its error stops being transient, the
// context ends, or the backoff's Limit passes. Each retry is logged, so a
// container that looks stuck says why.
func Retry(ctx context.Context, op string, b Backoff, fn func(context.Context) error) error {
	start := time.Now()
	for attempt := 0; ; attempt++ {
		err := fn(ctx)
		if err == nil {
			if attempt > 0 {
				slog.Info("rpc call recovered", "op", op, "attempts", attempt+1, "waited", time.Since(start).Round(time.Second).String())
			}
			return nil
		}
		if !Transient(err) {
			return err
		}
		wait := b.wait(attempt)
		if b.Limit > 0 && time.Since(start)+wait > b.Limit {
			return err
		}
		slog.Warn("rpc call failed, retrying",
			"op", op, "attempt", attempt+1, "retry_in", wait.Round(time.Millisecond).String(), "err", err)
		select {
		case <-ctx.Done():
			return errors.Join(err, ctx.Err())
		case <-time.After(wait):
		}
	}
}

// DialWithRetry is Dial, waiting out a provider that is rate limiting or
// briefly down. A wrong chain ID still fails on the first attempt.
func DialWithRetry(ctx context.Context, rpcURL string, expectedChainID int64, b Backoff) (*Client, error) {
	var c *Client
	err := Retry(ctx, "dial rpc", b, func(ctx context.Context) error {
		var err error
		c, err = Dial(ctx, rpcURL, expectedChainID)
		return err
	})
	return c, err
}
