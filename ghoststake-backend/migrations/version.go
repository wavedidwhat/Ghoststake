package migrations

import (
	"fmt"
	"io/fs"
	"strconv"
	"strings"
)

// MaxVersion is the highest migration version this binary carries.
//
// This is the whole reason the schema check costs nothing: the binary embeds
// its own migrations, so it already knows which schema it was built against.
// Nothing has to be annotated, and no compatibility matrix has to be kept
// correct by hand — the answer is a property of what was compiled in.
//
// goose parses versions the same way, from the numeric prefix of the file
// name, so this cannot disagree with what goose records as applied.
func MaxVersion() (int64, error) {
	entries, err := fs.ReadDir(FS, ".")
	if err != nil {
		return 0, fmt.Errorf("read embedded migrations: %w", err)
	}

	var max int64
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".sql") {
			continue
		}
		// goose's own rule: everything before the first underscore.
		prefix, _, found := strings.Cut(name, "_")
		if !found {
			continue
		}
		version, err := strconv.ParseInt(prefix, 10, 64)
		if err != nil {
			// Not a versioned migration. Skipped rather than failed, since
			// goose ignores it too and a stray file must not stop the boot.
			continue
		}
		if version > max {
			max = version
		}
	}
	if max == 0 {
		// The embed matched nothing usable. Loud, because the alternative is
		// a binary that believes it is at schema 0 and refuses every
		// database it meets.
		return 0, fmt.Errorf("no versioned migrations embedded")
	}
	return max, nil
}
