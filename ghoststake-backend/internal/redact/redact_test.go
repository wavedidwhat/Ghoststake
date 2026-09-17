package redact

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"forge.wavedidwhat.com/wave/ghoststake/internal/chain"
)

const infuraKey = "0123456789abcdef0123456789abcdef"

func TestSecretsCoverWhereProvidersPutKeys(t *testing.T) {
	cases := map[string]string{
		"infura path":   "https://sepolia.infura.io/v3/" + infuraKey,
		"alchemy path":  "https://arb-sepolia.g.alchemy.com/v2/" + infuraKey,
		"query param":   "https://rpc.example.com/?apikey=" + infuraKey,
		"userinfo":      "https://user:" + infuraKey + "@rpc.example.com/",
		"websocket key": "wss://sepolia.infura.io/ws/v3/" + infuraKey,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			got := String("dialing "+raw+" and again with bare key "+infuraKey, Secrets(raw))
			if strings.Contains(got, infuraKey) {
				t.Fatalf("key survived redaction: %q", got)
			}
		})
	}
}

// A public endpoint has nothing secret in it, and scrubbing its short path
// would mangle unrelated log text.
func TestPublicEndpointDoesNotScrubShortFragments(t *testing.T) {
	secrets := Secrets("https://sepolia-rollup.arbitrum.io/rpc")
	got := String("POST /rpc returned 200", secrets)
	if got != "POST /rpc returned 200" {
		t.Fatalf("short fragment was scrubbed: %q", got)
	}
}

func TestHostDropsPathQueryAndUserinfo(t *testing.T) {
	for raw, want := range map[string]string{
		"https://sepolia.infura.io/v3/" + infuraKey:       "https://sepolia.infura.io",
		"https://user:" + infuraKey + "@rpc.example.com/": "https://rpc.example.com",
		"not a url": Placeholder,
	} {
		if got := Host(raw); got != want {
			t.Errorf("Host(%q) = %q, want %q", raw, got, want)
		}
	}
}

// The regression that matters: a real transport error from our own chain
// client quotes the full URL, and the logger must not print the key. Uses an
// unroutable local port, so no network is needed.
func TestLoggerScrubsRealChainClientError(t *testing.T) {
	rpcURL := "http://127.0.0.1:1/v3/" + infuraKey

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, dialErr := chain.Dial(ctx, rpcURL, 1)
	if dialErr == nil || !strings.Contains(dialErr.Error(), infuraKey) {
		t.Fatalf("precondition: expected the client error to contain the key, got %v", dialErr)
	}

	for name, newHandler := range map[string]func(*bytes.Buffer, *slog.HandlerOptions) slog.Handler{
		"json": func(b *bytes.Buffer, o *slog.HandlerOptions) slog.Handler { return slog.NewJSONHandler(b, o) },
		"text": func(b *bytes.Buffer, o *slog.HandlerOptions) slog.Handler { return slog.NewTextHandler(b, o) },
	} {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			log := slog.New(newHandler(&buf, &slog.HandlerOptions{ReplaceAttr: ReplaceAttr(Secrets(rpcURL))}))

			log.Error("fatal", "err", dialErr)
			log.Error("wrapped", "err", fmt.Errorf("indexer cycle failed: %w", dialErr))
			log.Info("message itself "+rpcURL, "rpc", rpcURL)
			log.Info("grouped", slog.Group("chain", "url", rpcURL, "err", errors.New("boom at "+rpcURL)))
			log.With("rpc", rpcURL).Info("with attrs")

			if out := buf.String(); strings.Contains(out, infuraKey) {
				t.Fatalf("key leaked into %s log output:\n%s", name, out)
			}
			if !strings.Contains(buf.String(), "connection refused") {
				t.Fatalf("redaction removed the useful part of the error:\n%s", buf.String())
			}
		})
	}
}
