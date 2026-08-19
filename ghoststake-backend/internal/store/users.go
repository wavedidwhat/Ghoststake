package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrNotFound = errors.New("not found")

type User struct {
	ID          int64
	Address     string
	CreatedAt   time.Time
	LastLoginAt *time.Time
}

// UpsertUserOnLogin creates the wallet's user row on first sign-in and bumps
// last_login_at on every sign-in after that.
func (s *Store) UpsertUserOnLogin(ctx context.Context, address string) (User, error) {
	const q = `
		INSERT INTO users (address, last_login_at)
		VALUES ($1, now())
		ON CONFLICT (address) DO UPDATE SET last_login_at = now()
		RETURNING id, address, created_at, last_login_at`

	var u User
	err := s.pool.QueryRow(ctx, q, address).Scan(&u.ID, &u.Address, &u.CreatedAt, &u.LastLoginAt)
	if err != nil {
		return User{}, fmt.Errorf("upsert user: %w", err)
	}
	return u, nil
}

func (s *Store) UserByAddress(ctx context.Context, address string) (User, error) {
	const q = `SELECT id, address, created_at, last_login_at FROM users WHERE address = $1`

	var u User
	err := s.pool.QueryRow(ctx, q, address).Scan(&u.ID, &u.Address, &u.CreatedAt, &u.LastLoginAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("get user: %w", err)
	}
	return u, nil
}
