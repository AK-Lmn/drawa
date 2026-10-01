package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// The page reads and changes ~/.drawa/config.json through /api/prefs; a change outside a setting's choices is refused.
func TestPrefsRoutes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	for _, c := range []struct {
		method, body string
		code         int
		want         string
	}{
		{"GET", "", 200, `"ui":"full"`},
		{"POST", `{"ui":"minimal"}`, 200, `"ui":"minimal"`},
		{"POST", `{"ui":"huge"}`, 400, `invalid setting`},
		{"POST", `{}`, 400, `nothing to change`},
		{"GET", "", 200, `"ui":"minimal"`},
	} {
		if code, body := call(t, srv, c.method, "/api/prefs", c.body); code != c.code || !strings.Contains(body, c.want) {
			t.Errorf("%s %s: %d %s, want %d with %s", c.method, c.body, code, body, c.code, c.want)
		}
	}
}

// /api/symbols says whether ctags is there; with symbols turned off in your settings, lookups answer an empty list.
func TestSymbolsRoute(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	if code, body := call(t, srv, "GET", "/api/symbols", ""); code != 200 || !strings.Contains(body, `"installed":`) {
		t.Errorf("status: %d %s", code, body)
	}
	if code, body := call(t, srv, "POST", "/api/prefs", `{"symbols":"off"}`); code != 200 || !strings.Contains(body, `"symbols":"off"`) {
		t.Fatalf("turning symbols off: %d %s", code, body)
	}
	for _, path := range []string{"/api/symbols?q=find", "/api/symbols?def=Find"} {
		if code, body := call(t, srv, "GET", path, ""); code != 200 || body != "[]" {
			t.Errorf("%s with symbols off: %d %s", path, code, body)
		}
	}
}
