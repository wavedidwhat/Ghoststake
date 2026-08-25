package migrations_test

import (
	"io/fs"
	"strconv"
	"strings"
	"testing"

	"github.com/wavedidwhat/ghoststake/migrations"
)

// The version this binary reports must be the highest file actually embedded.
// Computed here the long way round rather than hardcoded, so adding a
// migration does not require editing this test — and so the assertion is
// about the embed, not about a number someone remembered to bump.
func TestMaxVersionMatchesTheEmbeddedFiles(t *testing.T) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}

	var highest int64
	var count int
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		prefix, _, _ := strings.Cut(e.Name(), "_")
		v, err := strconv.ParseInt(prefix, 10, 64)
		if err != nil {
			continue
		}
		count++
		if v > highest {
			highest = v
		}
	}
	if count == 0 {
		t.Fatal("no .sql migrations are embedded at all")
	}

	got, err := migrations.MaxVersion()
	if err != nil {
		t.Fatalf("MaxVersion: %v", err)
	}
	if got != highest {
		t.Fatalf("MaxVersion = %d, highest embedded file is %d", got, highest)
	}
}

// Every migration must be uniquely numbered. Two files sharing a version
// means goose applies one and silently skips the other, and the schema check
// built on these numbers would compare against a version that does not
// describe the schema.
func TestMigrationVersionsAreUnique(t *testing.T) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}

	seen := map[int64]string{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		prefix, _, _ := strings.Cut(e.Name(), "_")
		v, err := strconv.ParseInt(prefix, 10, 64)
		if err != nil {
			t.Errorf("%s has no numeric version prefix; goose will ignore it", e.Name())
			continue
		}
		if first, dup := seen[v]; dup {
			t.Errorf("version %d used by both %s and %s", v, first, e.Name())
		}
		seen[v] = e.Name()
	}
}
