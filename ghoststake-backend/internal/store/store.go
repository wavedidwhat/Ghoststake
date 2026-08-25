// Package store holds all Postgres access.
package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/wavedidwhat/ghoststake/migrations"
)

type Store struct{ pool *pgxpool.Pool }

func New(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MaxConnLifetime = time.Hour
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// ErrSchemaAhead is returned when the database has applied a migration this
// binary does not carry.
var ErrSchemaAhead = errors.New("database schema is ahead of this binary")

// Migrate runs the embedded migrations. Running them in-process on boot keeps
// the schema and the binary that expects it deployed as a single unit.
//
// It first refuses to proceed against a schema this binary was not built for.
// goose records which migrations have been applied, but nothing checks the
// converse — that the binary understands what it found — and `goose.Up`
// against a database ahead of the binary applies nothing and returns no
// error. That gap put a pre-GHO-17 binary on top of GHO-17's schema, where
// `0003` had renamed `entry_index` to `record_index`: every indexer cycle
// failed on a column that no longer existed, while `/healthz` stayed green
// and the HTTP layer served normally.
//
// allowAhead is the escape hatch for the honest false positive — an additive
// migration followed by a binary rollback is safe, and this refuses it
// anyway. Overriding is a decision someone makes and the log records, which
// is the part that was missing.
func (s *Store) Migrate(allowAhead bool) error {
	goose.SetBaseFS(migrations.FS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set dialect: %w", err)
	}
	db := stdlib.OpenDBFromPool(s.pool)
	defer db.Close()

	built, err := migrations.MaxVersion()
	if err != nil {
		return err
	}
	// Creates goose's bookkeeping table if this is a fresh database, and
	// reports 0 for one — so a first boot compares 0 against `built` and
	// proceeds, rather than needing a special case.
	applied, err := goose.GetDBVersion(db)
	if err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}

	if err := checkSchemaVersion(applied, built, allowAhead); err != nil {
		return err
	}

	if err := goose.Up(db, "."); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	slog.Info("migrations applied", "schema_version", max(applied, built))
	return nil
}

// checkSchemaVersion decides whether this binary may run against the schema it
// found. Split out from Migrate so the decision is testable without a
// database — the interesting cases are three integer comparisons, and needing
// Postgres to exercise them is how they end up untested.
func checkSchemaVersion(applied, built int64, allowAhead bool) error {
	if applied <= built {
		// Behind or level. goose.Up applies the difference, which is the
		// ordinary deploy.
		return nil
	}
	if allowAhead {
		slog.Warn("database schema is ahead of this binary, continuing because ALLOW_SCHEMA_AHEAD is set",
			"applied", applied, "built_for", built)
		return nil
	}
	return fmt.Errorf(
		"%w: database is at %d, this binary carries up to %d. It was built before this "+
			"schema and would read and write columns that a later migration may have "+
			"renamed or removed — silently, because a migration it cannot see is one it "+
			"cannot fail on. Deploy the build that matches, or set ALLOW_SCHEMA_AHEAD=true "+
			"if you have checked that every migration in between is additive",
		ErrSchemaAhead, applied, built)
}
