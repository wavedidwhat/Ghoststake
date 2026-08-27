package httpx

import (
	"go/ast"
	"go/parser"
	"go/token"
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

// The same argument as the route check, one level down: a query parameter the
// server reads and the spec does not mention is undiscoverable, and one the
// spec promises and nothing reads is a lie a client will build against.
//
// GHO-43 added `?market=`, which is the first query parameter here that
// changes *which rows* an answer is drawn from rather than how many. Getting
// that undocumented would mean the only way to ask a multi-market API about
// one market is to read the source.
//
// Set-level rather than per-route: mapping a handler back to its route needs
// either reflection that Go does not offer over closures or a hand-kept table,
// and a hand-kept table is the drift this file exists to prevent. Both
// directions across the whole surface catches the two failures that actually
// happen — a new parameter nobody documented, and a documented one nobody
// reads.
func TestOpenAPIDocumentsEveryQueryParameterTheServerReads(t *testing.T) {
	read := queryParametersRead(t)
	documented := documentedQueryParameters(t)

	for name := range read {
		if !documented[name] {
			t.Errorf("the server reads ?%s= but openapi.yaml does not document it", name)
		}
	}
	for name := range documented {
		if !read[name] {
			t.Errorf("openapi.yaml documents ?%s= but nothing reads it", name)
		}
	}

	if t.Failed() {
		t.Logf("read:       %s", sortedKeys(read))
		t.Logf("documented: %s", sortedKeys(documented))
	}
}

// queryParametersRead finds every `r.URL.Query().Get("name")` in this package
// by parsing it, rather than by anyone remembering to update a list.
func queryParametersRead(t *testing.T) map[string]bool {
	t.Helper()

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}

	out := map[string]bool{}
	fset := token.NewFileSet()
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) != 1 {
				return true
			}
			// The shape being matched is `<something>.Get("literal")` where the
			// receiver is itself a call to `Query()`. Narrow enough not to
			// catch a map lookup or an http.Get.
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Get" {
				return true
			}
			inner, ok := sel.X.(*ast.CallExpr)
			if !ok {
				return true
			}
			innerSel, ok := inner.Fun.(*ast.SelectorExpr)
			if !ok || innerSel.Sel.Name != "Query" {
				return true
			}
			lit, ok := call.Args[0].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				// A non-literal parameter name cannot be checked against a
				// static document, and silently skipping it would make this
				// test pass by not looking. Fail instead.
				t.Errorf("%s: query parameter name is not a string literal", fset.Position(call.Pos()))
				return true
			}
			out[strings.Trim(lit.Value, `"`)] = true
			return true
		})
	}
	if len(out) == 0 {
		t.Fatal("found no query parameters at all, which means the match stopped working")
	}
	return out
}

// documentedQueryParameters collects `in: query` parameters from the spec,
// following the $ref indirection into components.
func documentedQueryParameters(t *testing.T) map[string]bool {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join("..", "..", "openapi.yaml"))
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}

	var doc struct {
		Paths map[string]map[string]struct {
			Parameters []struct {
				Name string `yaml:"name"`
				In   string `yaml:"in"`
				Ref  string `yaml:"$ref"`
			} `yaml:"parameters"`
		} `yaml:"paths"`
		Components struct {
			Parameters map[string]struct {
				Name string `yaml:"name"`
				In   string `yaml:"in"`
			} `yaml:"parameters"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse openapi.yaml: %v", err)
	}

	out := map[string]bool{}
	for _, item := range doc.Paths {
		for _, op := range item {
			for _, p := range op.Parameters {
				switch {
				case p.Ref != "":
					// Only a parameter actually referenced by an operation
					// counts. One defined in components and referenced by
					// nothing documents no endpoint.
					key := p.Ref[strings.LastIndex(p.Ref, "/")+1:]
					if c, ok := doc.Components.Parameters[key]; ok && c.In == "query" {
						out[c.Name] = true
					}
				case p.In == "query":
					out[p.Name] = true
				}
			}
		}
	}
	return out
}
