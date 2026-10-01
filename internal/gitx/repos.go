package gitx

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
)

const (
	maxRepos  = 40 // nested repositories the Git window lists; each one is a git status per poll
	repoDepth = 4  // folders below Root searched for them
)

// folders never searched for repositories: dependencies and build output (hidden folders, .git among them, are skipped too)
var skipDirs = map[string]bool{"node_modules": true, "vendor": true, "dist": true, "build": true, "target": true, "venv": true, "__pycache__": true}

var ErrNoRepo = errors.New("not a repository in this project")

var nestedCache = struct {
	sync.Mutex
	at   time.Time
	list []string
}{}

// Nested lists the git repositories in folders below Root (slash-separated, relative to Root, sorted): cloned repos
// side by side in a workspace folder, or repos inside the project's own. Root's own repo isn't one of them. Searched
// again every 30 seconds at most, so a repo cloned meanwhile shows up soon after.
func Nested() []string {
	nestedCache.Lock()
	defer nestedCache.Unlock()
	if nestedCache.list == nil || time.Since(nestedCache.at) > 30*time.Second {
		nestedCache.list = findRepos(config.Root)
		nestedCache.at = time.Now()
	}
	return nestedCache.list
}

func findRepos(root string) []string {
	found := []string{}
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		// symlinked folders aren't followed (d.IsDir is false for them): a repo found here is really inside Root
		if err != nil || !d.IsDir() || p == root {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") || skipDirs[d.Name()] {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(root, p)
		if strings.Count(rel, string(filepath.Separator)) >= repoDepth {
			return filepath.SkipDir
		}
		if _, err := os.Lstat(filepath.Join(p, ".git")); err == nil { // a folder, or a file for submodules and worktrees
			found = append(found, filepath.ToSlash(rel))
			if len(found) >= maxRepos {
				return filepath.SkipAll
			}
		}
		return nil // keep looking inside: a repo may hold repos of its own
	})
	slices.Sort(found)
	return found
}

// Repos are the repositories the Git and GitHub windows offer: "" (Root's own) when Root is in one, then Nested.
func Repos() []string {
	prefix()
	prefixCache.Lock()
	own := prefixCache.ok // known once git answered: Root is in a repo (a failure isn't cached, so a git init shows up)
	prefixCache.Unlock()
	if own {
		return append([]string{""}, Nested()...)
	}
	return Nested()
}

// Check is repoDir's verdict alone, for callers that run other programs in a repo (gh).
func Check(repo string) error { _, err := repoDir(repo); return err }

// Path is repo's folder (Root for ""); check it first.
func Path(repo string) string { return filepath.Join(config.Root, filepath.FromSlash(repo)) }

// repoDir checks repo names Root ("") or one of the Nested repos: the page can only point git at a folder Drawa found.
func repoDir(repo string) (string, error) {
	if repo == "" || slices.Contains(Nested(), repo) {
		return repo, nil
	}
	return "", ErrNoRepo
}

// inRepo turns rel (relative to Root, from rootRel) into a path relative to repo, the folder git runs in for it. A path
// outside that repo is refused: staging it there would name a file of another repo, or none.
func inRepo(repo, rel string) (string, error) {
	if repo == "" {
		return rel, nil
	}
	dir := filepath.FromSlash(repo)
	r, err := filepath.Rel(dir, rel)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", config.ErrOutside
	}
	return r, nil
}
