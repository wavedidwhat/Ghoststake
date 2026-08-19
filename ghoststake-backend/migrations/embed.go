// Package migrations embeds the SQL schema so the binary carries its own
// migrations. go:embed cannot reference parent directories, so the embed has to
// live in the same package as the .sql files.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
