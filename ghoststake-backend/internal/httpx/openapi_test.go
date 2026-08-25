package httpx

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"gopkg.in/yaml.v3"
)

// The spec is only worth having if it cannot quietly stop being true. A
// document that drifts is worse than none: it becomes a confident description
// of behaviour the server no longer has, and the people it misleads are the
// ones who trusted it enough not to read the source.
//
// So: walk the routes chi actually registered and compare them against the
// paths in openapi.yaml, both directions. Adding an endpoint without
// documenting it fails here, and so does documenting one that was removed.
//
// Response *shapes* are not checked — that needs a heavier toolchain than this
// earns. Routes and methods are the drift that actually bites a consumer, and
// they are nearly free to pin.
func TestOpenAPIMatchesTheRegisteredRoutes(t *testing.T) {
	documented := documentedOperations(t)
	registered := registeredOperations(t)

	for op := range registered {
		if !documented[op] {
			t.Errorf("%s is served but not in openapi.yaml", op)
		}
	}
	for op := range documented {
		if !registered[op] {
			t.Errorf("%s is in openapi.yaml but not served", op)
		}
	}

	if t.Failed() {
		t.Logf("served:     %s", sortedKeys(registered))
		t.Logf("documented: %s", sortedKeys(documented))
	}
}

// documentedOperations reads "METHOD /path" out of the spec's `paths` block.
func documentedOperations(t *testing.T) map[string]bool {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join("..", "..", "openapi.yaml"))
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}

	var doc struct {
		Paths map[string]map[string]any `yaml:"paths"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse openapi.yaml: %v", err)
	}
	if len(doc.Paths) == 0 {
		t.Fatal("openapi.yaml documents no paths at all")
	}

	methods := map[string]bool{
		"get": true, "post": true, "put": true, "patch": true, "delete": true,
	}
	out := map[string]bool{}
	for path, item := range doc.Paths {
		for key := range item {
			if methods[strings.ToLower(key)] {
				out[strings.ToUpper(key)+" "+path] = true
			}
		}
	}
	return out
}

// registeredOperations walks the real router.
func registeredOperations(t *testing.T) map[string]bool {
	t.Helper()

	// A zero-value server is enough: routes() only reads config for CORS
	// options and handler receivers, and nothing here is called.
	s := &Server{}
	router, ok := s.routes().(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}

	out := map[string]bool{}
	err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		// chi reports "/api/v1/rounds/" for a route registered as
		// "/api/v1/rounds"; the trailing slash is an artefact of the walk,
		// not a second endpoint.
		if route != "/" {
			route = strings.TrimSuffix(route, "/")
		}
		out[method+" "+route] = true
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	return out
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
