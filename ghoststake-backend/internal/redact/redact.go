// Package redact keeps credentials that live inside connection URLs out of
// logs.
//
// RPC providers put the API key in the URL itself: Infura and Alchemy in the
// path (/v3/<key>), others in the query or userinfo. Logging the URL leaks
// the key, and so does logging an error from the client: Go's HTTP client
// quotes the full URL in transport errors, e.g.
//
//	fetch chain id: Post "https://sepolia.infura.io/v3/<key>": context deadline exceeded
//
// Fixing call sites one by one misses the next error that wraps the URL, so
// the scrubbing happens once, in the logger.
package redact

import (
	"fmt"
	"log/slog"
	"net/url"
	"slices"
	"strings"
)

// Placeholder replaces every secret in log output.
const Placeholder = "[REDACTED]"

// minSecretLen stops short, common fragments from being treated as secrets.
// A public endpoint like https://sepolia-rollup.arbitrum.io/rpc has the path
// "/rpc"; scrubbing that would mangle unrelated log text and hide nothing.
// Provider keys are 32+ characters.
const minSecretLen = 12

// Secrets returns the substrings of rawURL that can carry a credential, longest
// first so that replacing one never leaves a fragment of another behind.
func Secrets(rawURL string) []string {
	if rawURL == "" {
		return nil
	}
	secrets := []string{rawURL}
	u, err := url.Parse(rawURL)
	if err != nil {
		return secrets
	}
	if pw, ok := u.User.Password(); ok && len(pw) >= minSecretLen {
		secrets = append(secrets, pw)
	}
	tail := u.EscapedPath()
	if u.RawQuery != "" {
		tail += "?" + u.RawQuery
	}
	if len(tail) >= minSecretLen {
		secrets = append(secrets, tail)
	}
	for seg := range strings.SplitSeq(u.Path, "/") {
		if len(seg) >= minSecretLen {
			secrets = append(secrets, seg)
		}
	}
	for _, vs := range u.Query() {
		for _, v := range vs {
			if len(v) >= minSecretLen {
				secrets = append(secrets, v)
			}
		}
	}
	// Longest first: the full URL contains the path, which contains the key.
	slices.SortStableFunc(secrets, func(a, b string) int { return len(b) - len(a) })
	return secrets
}

// Host returns the scheme and host of rawURL, the part that is safe to log.
func Host(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return Placeholder
	}
	return u.Scheme + "://" + u.Host
}

// String replaces every secret in s.
func String(s string, secrets []string) string {
	for _, sec := range secrets {
		if sec != "" {
			s = strings.ReplaceAll(s, sec, Placeholder)
		}
	}
	return s
}

// ReplaceAttr returns a slog.HandlerOptions.ReplaceAttr that scrubs secrets
// from the message and from every string, error or Stringer attribute,
// including those nested in groups.
func ReplaceAttr(secrets []string) func(groups []string, a slog.Attr) slog.Attr {
	return func(_ []string, a slog.Attr) slog.Attr {
		if len(secrets) == 0 {
			return a
		}
		var s string
		switch a.Value.Kind() {
		case slog.KindString:
			s = a.Value.String()
		case slog.KindAny:
			switch v := a.Value.Any().(type) {
			case error:
				s = v.Error()
			case fmt.Stringer:
				s = v.String()
			default:
				return a
			}
		default:
			return a
		}
		if clean := String(s, secrets); clean != s {
			return slog.String(a.Key, clean)
		}
		return a
	}
}
