package gitx

import (
	"errors"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"drawa/internal/procx"
)

// Ref is one line in the project that uses a name.
type Ref struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

var refName = regexp.MustCompile(`^[A-Za-z_$][\w$]{0,99}$`)

const (
	refsMax     = 200
	refsPerFile = 20
	refTextMax  = 200
	refsOutMax  = 1 << 20
)

// Refs lists the lines in repo's files that use `name` as a whole word (find references from a diff's names), up to
// 20 a file; more says some were left out. repo is the diff's: "" the project's own, a nested repo, or a worktree
// (gitx.Check). Paths are relative to Root, so the page can open them; outside says the repo is a worktree outside
// Root, whose paths are its own folder's and can't be opened from here. An error means the search couldn't run (not
// a repo, git failed): not the same as no uses. ponytail: a word match with git grep, not a language server: it finds
// comments and strings too, and a repo's own nested repos aren't searched with it.
func Refs(repo, name string) (refs []Ref, more, outside bool, err error) {
	out := []Ref{}
	if !refName.MatchString(name) {
		return out, false, false, nil
	}
	if repo, err = repoDir(repo); err != nil {
		return out, false, false, err
	}
	// what the paths git prints (relative to the folder it runs in) need in front of them to be Root's
	prefix := ""
	if outside = filepath.IsAbs(filepath.FromSlash(repo)); !outside && repo != "" {
		prefix = repo + "/"
	}
	// no --max-count (git 2.38+): the cap per file is counted here, and RunLimit keeps a common name's output bounded
	env, argv := command(repo, []string{"grep", "-n", "-z", "-I", "-w", "-F", "--no-color", "--untracked", "-e", name, "--", "."})
	r, err := procx.RunLimit(30*time.Second, refsOutMax, "", env, argv...)
	if err != nil {
		return out, false, outside, err
	}
	if r.Code != 0 && !r.Truncated {
		if r.Code == 1 { // no match
			return out, false, outside, nil
		}
		return out, false, outside, errors.New("could not search: " + firstLine(r.Stderr))
	}
	lines := strings.Split(r.Stdout, "\n")
	if r.Truncated {
		lines, more = lines[:len(lines)-1], true // the last one was cut off
	}
	per := map[string]int{}
	for _, l := range lines {
		f := strings.SplitN(l, "\x00", 3) // -z: path\0line\0text, so a path with a colon still splits right
		if len(f) < 3 {
			continue
		}
		n, err := strconv.Atoi(f[1])
		if err != nil {
			continue
		}
		if per[f[0]] == refsPerFile || len(out) == refsMax {
			more = true
			if len(out) == refsMax {
				break
			}
			continue
		}
		per[f[0]]++
		line := strings.TrimSpace(f[2])
		if len(line) > refTextMax {
			line = strings.ToValidUTF8(line[:refTextMax], "") + "…"
		}
		out = append(out, Ref{Path: prefix + f[0], Line: n, Text: line})
	}
	return out, more, outside, nil
}

// firstLine is the first line of git's error output, without its "fatal: ".
func firstLine(s string) string {
	l, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return strings.TrimPrefix(l, "fatal: ")
}
