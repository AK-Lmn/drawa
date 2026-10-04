package agy

import (
	"slices"
	"testing"

	"drawa/internal/live"
)

func TestArgvMode(t *testing.T) {
	if a := argv(live.Spec{Mode: "bypassPermissions"}); !slices.Contains(a, "--dangerously-skip-permissions") {
		t.Errorf("bypass without the flag: %v", a)
	}
	for _, m := range []string{"", "default", "acceptEdits", "plan"} {
		if a := argv(live.Spec{Mode: m}); slices.Contains(a, "--dangerously-skip-permissions") {
			t.Errorf("%q skips permissions: %v", m, a)
		}
	}
	if a := argv(live.Spec{}); a[len(a)-1] != "-p=" {
		t.Errorf("-p= must come last: %v", a)
	}
}

func TestSetModeOnlyAtStart(t *testing.T) {
	a := &agent{mode: mode("bypassPermissions")}
	if a.SetMode("bypassPermissions") != nil {
		t.Error("same mode refused")
	}
	if err := a.SetMode("default"); err == nil {
		t.Error("mid-session switch accepted")
	} else if _, ok := err.(*live.Refused); !ok {
		t.Errorf("not a Refused (would mark the process gone): %v", err)
	}
}
