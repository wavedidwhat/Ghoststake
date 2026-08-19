package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrNonceUnusable = errors.New("nonce is unknown, expired, or already used")

type Nonce struct {
	Nonce   string
	Address string
	Message string
}

func (s *Store) CreateNonce(ctx context.Context, n Nonce, expiresAt time.Time) error {
	const q = `INSERT INTO auth_nonces (nonce, address, message, expires_at) VALUES ($1, $2, $3, $4)`
	if _, err := s.pool.Exec(ctx, q, n.Nonce, n.Address, n.Message, expiresAt); err != nil {
		return fmt.Errorf("create nonce: %w", err)
	}
	return nil
}

// ConsumeNonce atomically claims a nonce and returns what the server originally
// issued for it.
//
// The UPDATE ... WHERE consumed_at IS NULL RETURNING pattern makes this a
// single atomic step: two concurrent verifications of the same nonce cannot
// both succeed, because only one UPDATE can match the row. Doing this as a
// SELECT-then-UPDATE would leave a replay window between the two statements.
func (s *Store) ConsumeNonce(ctx context.Context, nonce string) (Nonce, error) {
	const q = `
		UPDATE auth_nonces
		   SET consumed_at = now()
		 WHERE nonce = $1
		   AND consumed_at IS NULL
		   AND expires_at > now()
		RETURNING nonce, address, message`

	var n Nonce
	err := s.pool.QueryRow(ctx, q, nonce).Scan(&n.Nonce, &n.Address, &n.Message)
	if errors.Is(err, pgx.ErrNoRows) {
		return Nonce{}, ErrNonceUnusable
	}
	if err != nil {
		return Nonce{}, fmt.Errorf("consume nonce: %w", err)
	}
	return n, nil
}

// DeleteExpiredNonces clears out spent and stale challenges.
func (s *Store) DeleteExpiredNonces(ctx context.Context) (int64, error) {
	const q = `DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 hour'`
	tag, err := s.pool.Exec(ctx, q)
	if err != nil {
		return 0, fmt.Errorf("delete expired nonces: %w", err)
	}
	return tag.RowsAffected(), nil
}
