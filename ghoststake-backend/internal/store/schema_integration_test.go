package store_test

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/wavedidwhat/ghoststake/internal/store"
	"github.com/wavedidwhat/ghoststake/migrations"
)

// Proves the wiring the pure test cannot: that Migrate reads the real applied
// version out of goose's bookkeeping table and compares it against what this
// binary embeds.
//
// Deliberately not parallel, and it puts the row back in a Cleanup. It edits
// state every other test in this package shares, and a version left behind
// would fail every subsequent Migrate rather than just this test.
func TestMigrateRefusesADatabaseAheadOfTheBinary(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("TEST_DATABASE_URL is unset in CI: the Postgres service is not wired up")
		}
		t.Skip("TEST_DATABASE_URL not set (run `make test-remote`)")
	}
	ctx := context.Background()

	// Migrate first, so goose's table exists to be tampered with.
	st := newTestStore(t)

	built, err := migrations.MaxVersion()
	if err != nil {
		t.Fatalf("max version: %v", err)
	}
	ahead := built + 1

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	// A migration this binary has never heard of, exactly as a newer deploy
	// would have left it.
	if _, err := conn.Exec(ctx,
		`INSERT INTO goose_db_version (version_id, is_applied) VALUES ($1, true)`, ahead); err != nil {
		t.Fatalf("insert future version: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(),
			`DELETE FROM goose_db_version WHERE version_id = $1`, ahead); err != nil {
			t.Errorf("failed to remove the planted version %d — later runs against this "+
				"database will refuse to migrate until it is deleted by hand: %v", ahead, err)
		}
	})

	err = st.Migrate(false)
	if err == nil {
		t.Fatal("Migrate accepted a database ahead of the binary")
	}
	if !errors.Is(err, store.ErrSchemaAhead) {
		t.Fatalf("want ErrSchemaAhead, got: %v", err)
	}

	// And the override really does let it through, rather than being a flag
	// that is only honoured in the unit test.
	if err := st.Migrate(true); err != nil {
		t.Fatalf("ALLOW_SCHEMA_AHEAD did not permit the boot: %v", err)
	}
}
