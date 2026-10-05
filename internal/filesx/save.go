package filesx

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// ErrChanged: the file on disk isn't the text the editor started from (changed since, or too big or not
// text when it was read), so saving would throw away what's there.
var ErrChanged = errors.New("the file changed on disk since it was opened")

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
	if len(data) > maxRead || bytes.IndexByte(data, 0) >= 0 || toUTF8(data) != base {
		return ErrChanged
	}
	p, err := filepath.EvalSymlinks(f.Name()) // Open approved where it really is; replace that file, not a link to it
	if err != nil {
		return err
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
