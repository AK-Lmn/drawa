package filesx

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSave(t *testing.T) {
	root := useRoot(t)
	p := filepath.Join(root, "a.sh")
	os.WriteFile(p, []byte("echo 1\n"), 0o755)

	if err := Save("a.sh", "echo 1\n", "echo 2\n"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "echo 2\n" {
		t.Errorf("saved %q", b)
	}
	if info, _ := os.Stat(p); info.Mode().Perm() != 0o755 {
		t.Errorf("mode %v, want 0755", info.Mode().Perm())
	}
	// the page's copy is stale: refuse rather than throw away what's on disk
	if err := Save("a.sh", "echo 1\n", "echo 3\n"); !errors.Is(err, ErrChanged) {
		t.Errorf("stale base: %v", err)
	}
	// too big to have been read whole: the page only ever saw the start
	big := make([]byte, maxRead+10)
	for i := range big {
		big[i] = 'x'
	}
	os.WriteFile(filepath.Join(root, "big"), big, 0o644)
	if err := Save("big", string(big[:maxRead]), "x"); !errors.Is(err, ErrChanged) {
		t.Errorf("big file: %v", err)
	}
	// not UTF-8: the page saw replacement characters, saving them would rewrite every such byte
	os.WriteFile(filepath.Join(root, "latin1"), []byte("caf\xe9\n"), 0o644)
	if err := Save("latin1", "caf\uFFFD\n", "x"); !errors.Is(err, ErrChanged) {
		t.Errorf("not UTF-8: %v", err)
	}
	if os.Getuid() != 0 { // root may write anything
		os.WriteFile(filepath.Join(root, "ro"), []byte("a"), 0o444)
		if err := Save("ro", "a", "b"); !errors.Is(err, ErrReadOnly) {
			t.Errorf("read-only: %v", err)
		}
	}
	if err := Save("../outside", "", "x"); err == nil {
		t.Error("saved outside the project")
	}
	if left, _ := filepath.Glob(filepath.Join(root, ".*drawa-*")); len(left) > 0 {
		t.Errorf("temp files left: %v", left)
	}
}
