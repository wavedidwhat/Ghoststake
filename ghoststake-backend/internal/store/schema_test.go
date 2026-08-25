package store

import (
	"errors"
	"strings"
	"testing"
)

// The three directions, and the override. In-package because the decision is
// deliberately not exported — what callers see is Migrate refusing to run.
func TestCheckSchemaVersion(t *testing.T) {
	cases := []struct {
		name       string
		applied    int64
		built      int64
		allowAhead bool
		wantErr    bool
	}{
		{
			// First boot. goose reports 0 for a database with no bookkeeping
			// table yet, so this must not need a special case.
			name: "fresh database", applied: 0, built: 4,
		},
		{
			// The ordinary deploy: new binary, older database. goose.Up
			// applies the difference.
			name: "database behind the binary", applied: 2, built: 4,
		},
		{
			name: "level", applied: 4, built: 4,
		},
		{
			// The failure this exists for. A binary built at 2 against a
			// database migrated to 3 wrote entry_index into a table where
			// 0003 had renamed it to record_index.
			name: "database ahead", applied: 3, built: 2, wantErr: true,
		},
		{
			// Far ahead is the same answer. There is no distance at which
			// guessing becomes safe.
			name: "database far ahead", applied: 99, built: 4, wantErr: true,
		},
		{
			name: "database ahead, override set", applied: 3, built: 2, allowAhead: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkSchemaVersion(tc.applied, tc.built, tc.allowAhead)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("applied=%d built=%d: expected a refusal", tc.applied, tc.built)
				}
				// Callers distinguish this from a connection failure, so it
				// has to stay matchable rather than being a bare string.
				if !errors.Is(err, ErrSchemaAhead) {
					t.Fatalf("error is not ErrSchemaAhead: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("applied=%d built=%d: unexpected refusal: %v", tc.applied, tc.built, err)
			}
		})
	}
}

// The message is the whole product of this check: it is read by someone
// mid-deploy who does not have the source open.
func TestSchemaAheadErrorNamesBothVersionsAndTheWayOut(t *testing.T) {
	err := checkSchemaVersion(7, 4, false)
	if err == nil {
		t.Fatal("expected a refusal")
	}
	for _, want := range []string{"7", "4", "ALLOW_SCHEMA_AHEAD"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message is missing %q:\n%v", want, err)
		}
	}
}
