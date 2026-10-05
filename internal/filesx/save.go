package filesx

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"unicode/utf8"

	"drawa/internal/config"
)

// ErrChanged: the file on disk isn't the text the editor started from (changed since, or too big or not
// UTF-8 text when it was read), so saving would throw away what's there.
var ErrChanged = errors.New("the file changed on disk since it was opened")

// ErrReadOnly: the file isn't writable; replacing it by rename would get around that.
var ErrReadOnly = errors.New("the file is read-only")

// editable: Get's text is the whole file, byte for byte, so saving the editor's copy loses nothing.
func editable(data []byte) bool {
	return len(data) <= maxRead && bytes.IndexByte(data, 0) < 0 && utf8.Valid(data)
}

// Save writes text over an existing project file, only if the file still holds base, the text the page read
// with Get. It writes a temporary file beside it and renames it over, so a failed write leaves the file as it
// was; the file keeps its permissions. ponytail: a hard link to the file is left pointing at the old copy.
func Save(rel, base, text string) error {
	f, info, err := Open(rel)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(f, maxRead+1))
	f.Close()
	if err != nil {
		return err
	}
	if !editable(data) || string(data) != base {
		return ErrChanged
	}
	// Open approved where it really is; resolve and check again, so a link swapped in since can't send the
	// write outside the project, and replace that file, not a link to it
	p, err := config.Inside(f.Name())
	if err != nil {
		return err
	}
	if syscall.Access(p, 2) != nil { // W_OK
		return ErrReadOnly
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".drawa-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // gone once renamed; cleans up after a failure
	if _, err = tmp.WriteString(text); err == nil {
		err = tmp.Chmod(info.Mode().Perm())
	}
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
