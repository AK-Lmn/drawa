package symbols

import (
	"strings"
	"testing"
	"time"
)

// captured from `ctags --options=NONE --output-format=json --fields=+nl-P` (Universal Ctags 6.2), plus a pseudo
// tag and a broken line
const fixture = `{"_type": "ptag", "name": "JSON_OUTPUT_VERSION", "path": "0.0", "pattern": "in development"}
{"_type": "tag", "name": "Find", "path": "internal/filesx/filesx.go", "language": "Go", "line": 198, "typeref": "typename:[]string", "kind": "func", "scope": "filesx", "scopeKind": "package"}
{"_type": "tag", "name": "fileOpener", "path": "web/src/canvas/find.ts", "language": "TypeScript", "line": 54, "kind": "constant"}
{"_type": "tag", "name": "answer", "path": "web/src/canvas/find.ts", "language": "TypeScript", "line": 80, "kind": "constant", "scope": "findFiles", "scopeKind": "function"}
{"_type": "tag", "name": "name", "path": "package.json", "language": "JSON", "line": 2, "kind": "string"}
{"_type": "tag", "name": "findFiles", "path": "web/src/canvas/find.ts", "language": "TypeScript", "line": 74, "kind": "function"}
{"_type": "tag", "name": "Live", "path": "internal/live/live.go", "language": "Go", "line": 23, "kind": "struct", "scope": "live", "scopeKind": "package"}
{"_type": "tag", "name": "answer", "path": "internal/server/handler.go", "language": "Go", "line": 9, "kind": "func", "scope": "server", "scopeKind": "package"}
{"_type": "tag", "name":
{"_type": "tag", "name": ".finder .finder-row", "path": "web/src/styles/chrome.css", "language": "CSS", "line": 99, "kind": "class"}
{"_type": "tag", "name": "fixtureOfDynamicPrefixes", "path": "web/src/y.ts", "language": "TypeScript", "line": 1, "kind": "function"}
{"_type": "tag", "name": "findAll", "path": "web/src/x.ts", "language": "TypeScript", "line": 3, "kind": "function"}`

func useFixture(t *testing.T) {
	syms := parse(strings.NewReader(fixture))
	low := make([]string, len(syms))
	for i, s := range syms {
		low[i] = strings.ToLower(s.Name)
	}
	found.Lock()
	oldBin := found.bin
	found.bin = "ctags" // lookups only need to believe it's there: the index below is already built
	found.Unlock()
	cache.Lock()
	at, index, oldSyms, oldLow := cache.at, cache.index, cache.syms, cache.low
	cache.at, cache.index, cache.syms, cache.low = time.Now().Add(time.Hour), time.Time{}, syms, low
	cache.Unlock()
	t.Cleanup(func() {
		found.Lock()
		found.bin = oldBin
		found.Unlock()
		cache.Lock()
		cache.at, cache.index, cache.syms, cache.low = at, index, oldSyms, oldLow
		cache.Unlock()
	})
}

func TestParse(t *testing.T) {
	syms := parse(strings.NewReader(fixture))
	if len(syms) != 8 { // not the pseudo tag, the JSON key, the compound selector or the broken line
		t.Fatalf("got %d symbols: %+v", len(syms), syms)
	}
	want := Symbol{Name: "Find", Path: "internal/filesx/filesx.go", Line: 198, Kind: "func", Scope: "filesx"}
	if syms[0] != want {
		t.Errorf("got %+v, want %+v", syms[0], want)
	}
	if !syms[2].local || syms[1].local {
		t.Errorf("a function's const should be local, a top-level one not: %+v %+v", syms[2], syms[1])
	}
}

func names(syms []Symbol) string {
	out := []string{}
	for _, s := range syms {
		out = append(out, s.Name+"@"+s.Path)
	}
	return strings.Join(out, " ")
}

func TestFuzzy(t *testing.T) {
	useFixture(t)
	// the whole name, then its start, then the letters in order; locals left out
	if got := names(Fuzzy("find", 10)); got != "Find@internal/filesx/filesx.go findAll@web/src/x.ts findFiles@web/src/canvas/find.ts" {
		t.Errorf("find: %s", got)
	}
	// fileOpener's f-o-p are close together; fixtureOfDynamicPrefixes' are too far apart to count
	if got := names(Fuzzy("fop", 10)); got != "fileOpener@web/src/canvas/find.ts" {
		t.Errorf("fop: %s", got)
	}
	if got := names(Fuzzy("answer", 10)); got != "answer@internal/server/handler.go" {
		t.Errorf("answer: %s", got)
	}
	if got := Fuzzy("find", 1); len(got) != 1 || got[0].Name != "Find" {
		t.Errorf("limit 1: %+v", got)
	}
	if got := Fuzzy("  ", 10); got == nil || len(got) != 0 {
		t.Errorf("empty query: %#v", got)
	}
}

func TestExact(t *testing.T) {
	useFixture(t)
	// project-wide definitions before a function's local of the same name
	if got := names(Exact("answer", 10)); got != "answer@internal/server/handler.go answer@web/src/canvas/find.ts" {
		t.Errorf("answer: %s", got)
	}
	if got := Exact("find", 10); got == nil || len(got) != 0 { // case matters
		t.Errorf("find: %+v", got)
	}
}

func TestNotInstalled(t *testing.T) {
	found.Lock()
	old, oldAt := found.bin, found.checked
	found.bin, found.checked = "", time.Now() // checked just now: not looked for again
	found.Unlock()
	t.Cleanup(func() { found.Lock(); found.bin, found.checked = old, oldAt; found.Unlock() })
	if Installed() || len(Fuzzy("find", 10)) != 0 || len(Exact("Find", 10)) != 0 {
		t.Error("without ctags every lookup should be empty")
	}
}
