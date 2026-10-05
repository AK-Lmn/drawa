package gitx

import (
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/procx"
)

const maxWorktrees = 40 // listed per repo; each is a git status per poll

// Worktree is a linked worktree of a repository: its folder, the branch checked out there ("" when detached), and
// whether it's locked (git worktree lock: not to be removed).
type Worktree struct {
	Path   string
	Branch string
	Locked bool
}

// worktrees lists the linked worktrees of the repository whose folder is dir, from `git worktree list --porcelain -z`
// (run through command(), so untrusted-mode flags apply; not GitOpts, whose Check would ask for this very list). The
// first entry is the main worktree: left out, and if it isn't dir, dir is itself a linked worktree, which lists none
// of its own. Bare and prunable (folder gone) entries are left out.
func worktrees(dir string) []Worktree {
	env, argv := command(dir, []string{"worktree", "list", "--porcelain", "-z"})
	r, err := procx.RunEnv(10*time.Second, "", env, argv...)
	if err != nil || r.Code != 0 {
		return nil
	}
	return parseWorktrees(r.Stdout, dir)
}

// parseWorktrees reads porcelain -z output: attribute lines end in NUL, an entry ends in an empty one.
func parseWorktrees(out, dir string) []Worktree {
	var list []Worktree
	var w Worktree
	first, skip, started := true, false, false
	for _, line := range strings.Split(out, "\x00") {
		key, val, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			w, skip, started = Worktree{Path: filepath.Clean(val)}, false, true
		case "branch":
			w.Branch = strings.TrimPrefix(val, "refs/heads/")
		case "locked":
			w.Locked = true
		case "bare", "prunable":
			skip = true
		case "":
			if !started {
				continue
			}
			started = false
			if first {
				first = false
				if !samePath(w.Path, dir) {
					return nil
				}
				continue
			}
			if !skip {
				list = append(list, w)
			}
		}
	}
	return list
}

func samePath(a, b string) bool { return real(a) == real(b) }

func real(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

// linked is a listed repo's worktree: id is its repo id (slash path relative to Root, or absolute outside it), main
// the id of the repo it belongs to ("" for Root's).
type linked struct {
	id, main string
	locked   bool
}

var wtCache = struct {
	sync.Mutex
	at   time.Time
	list []linked
}{}

// allWorktrees lists the worktrees of Root's repo and of the Nested ones. Kept as long as the status cache (3s), so
// Check and the status poll don't run git per request; one the agent just added is usable a few seconds later.
func allWorktrees() []linked {
	wtCache.Lock()
	defer wtCache.Unlock()
	if wtCache.list != nil && time.Since(wtCache.at) <= 3*time.Second {
		return wtCache.list
	}
	list := []linked{}
	for _, repo := range Repos() {
		for i, w := range worktrees(top(repo)) {
			if i >= maxWorktrees {
				break
			}
			list = append(list, linked{wtID(w.Path), repo, w.Locked})
		}
	}
	wtCache.list, wtCache.at = list, time.Now()
	return list
}

// forgetWorktrees drops the cached lists, after a worktree was removed.
func forgetWorktrees() {
	wtCache.Lock()
	wtCache.list = nil
	wtCache.Unlock()
	nestedCache.Lock()
	nestedCache.list = nil // a worktree inside Root may have been hidden from it
	nestedCache.Unlock()
}

func isWorktree(id string) bool { _, ok := worktreeOf(id); return ok }

// worktreeOf is the listed worktree whose id is id; false if it isn't one.
func worktreeOf(id string) (linked, bool) {
	for _, l := range allWorktrees() {
		if id != "" && l.id == id {
			return l, true
		}
	}
	return linked{}, false
}

func wtID(path string) string {
	if r, err := filepath.Rel(config.Root, path); err == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return filepath.ToSlash(r)
	}
	return filepath.ToSlash(path)
}

// top is repo's top folder: Root may be a subfolder of its own repo, whose worktrees are listed in the top's git dir.
func top(repo string) string {
	if repo != "" {
		return Path(repo)
	}
	dir := config.Root
	for _, seg := range strings.Split(strings.Trim(prefix(), "/"), "/") {
		if seg != "" {
			dir = filepath.Dir(dir)
		}
	}
	return dir
}

// dropWorktrees leaves out of found (repos in Root's subfolders) the linked worktrees of Root's repo or of another
// found one: they're listed under their repo. A worktree whose repo isn't listed stays a repo of its own.
func dropWorktrees(found []string) []string {
	var paths []string
	dirs := []string{top("")}
	for _, f := range found {
		dirs = append(dirs, Path(f))
	}
	for _, d := range dirs {
		for _, w := range worktrees(d) {
			paths = append(paths, real(w.Path))
		}
	}
	return slices.DeleteFunc(found, func(f string) bool { return slices.Contains(paths, real(Path(f))) })
}
