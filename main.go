// Browser UI for Claude Code.
//
//	drawa [--net] [project-folder]   (default: the current folder, like `code .`); opens http://127.0.0.1:8765
//
// --net also listens on the machine's network address, so another device on the same network can open it;
// without it the server only answers on localhost. Builds web/ on first run (needs npm); after UI changes run
// `npm run build` in web/, or use `npm run dev` for UI work. DRAWA_PORT overrides the port; CLAUDE_CONFIG_DIR
// overrides where Claude Code's own config/sessions live (see internal/config).
package main

import (
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/server"
	"drawa/internal/webassets"
)

var binPath = filepath.Join(config.Repo, ".bin", "drawa-server")

const banner = `
██████╗  ██████╗  █████╗ ██╗    ██╗ █████╗
██╔══██╗██╔══██╗██╔══██╗██║    ██║██╔══██╗
██║  ██║██████╔╝███████║██║ █╗ ██║███████║
██║  ██║██╔══██╗██╔══██║██║███╗██║██╔══██║
██████╔╝██║  ██║██║  ██║╚███╔███╔╝██║  ██║
╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝  ╚═╝
`

// lineDelay paces startup output so it reads as a sequence instead of dumping everything at once.
const lineDelay = 500 * time.Millisecond

// printLines prints each line on its own, pausing lineDelay between them.
func printLines(lines ...string) {
	for _, l := range lines {
		fmt.Println(l)
		time.Sleep(lineDelay)
	}
}

const (
	green  = "\033[32m"
	yellow = "\033[33m"
	red    = "\033[31m"
	reset  = "\033[0m"
)

// spinFrames renders frame-by-frame in place (each call to render overwrites the last) for d.
func spinFrames(d time.Duration, render func(frame rune)) {
	frames := []rune("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
	for deadline, i := time.Now().Add(d), 0; time.Now().Before(deadline); i++ {
		render(frames[i%len(frames)])
		time.Sleep(90 * time.Millisecond)
	}
}

// spin shows a brief indeterminate loader (motion, not a percentage) for d, then clears the line.
func spin(d time.Duration, label string) {
	spinFrames(d, func(f rune) { fmt.Printf("\r%c %s", f, label) })
	fmt.Print("\r" + strings.Repeat(" ", len(label)+2) + "\r")
}

// spinStatus spins for d, then resolves in place into a colored symbol: how a check "finishes" once its result
// is already known (the checks themselves are near-instant; the spin is purely so it doesn't just flash).
func spinStatus(d time.Duration, label, color, symbol string) {
	spinFrames(d, func(f rune) { fmt.Printf("\r%c %s", f, label) })
	fmt.Printf("\r%s%s%s %s\n", color, symbol, reset, label)
}

// preflight checks the external tools this app shells out to and prints a pass/fail line for each. claude is
// required (every card is a `claude` process); git and gh are optional (the Git/GitHub windows and their
// per-call code already degrade gracefully without them), so those only warn.
func preflight() {
	if st, err := os.Stat(config.Root); err != nil || !st.IsDir() { // claude can't start in it: every send would fail
		fmt.Printf("%s isn't a folder.\n", config.Root)
		if len(os.Args) > 1 && strings.Contains(os.Args[1], "=") {
			fmt.Printf("Environment variables go before the command: %s drawa\n", os.Args[1])
		}
		os.Exit(1)
	}
	checks := []struct {
		cmd, label, help string
		required         bool
	}{
		{"claude", "claude (Claude Code CLI)", "install it: https://claude.com/claude-code", true},
		{"git", "git", "the Git window and file history won't work", false},
		{"gh", "gh (GitHub CLI)", "the GitHub window won't work — get it: https://cli.github.com", false},
	}
	ok, missing := true, false
	var lines []string
	for _, c := range checks {
		if _, err := exec.LookPath(c.cmd); err != nil {
			lines = append(lines, fmt.Sprintf("  [x] %s — not found (%s)", c.label, c.help))
			if c.required {
				ok = false
			} else {
				missing = true
			}
		} else {
			lines = append(lines, fmt.Sprintf("  [✓] %s", c.label))
		}
	}
	color, symbol := green, "✓"
	if !ok {
		color, symbol = red, "✗" // claude missing (or everything missing): can't run at all
	} else if missing {
		color, symbol = yellow, "!" // git and/or gh missing: degraded, but drawa still runs
	}
	spinStatus(900*time.Millisecond, "Checking prerequisites...", color, symbol)
	printLines(lines...)
	fmt.Println()
	if !ok {
		os.Exit(1)
	}
}

// watchedFiles is every non-test .go source file plus go.mod in the repo (skipping web/ and dot-directories: no reason to walk
// node_modules or .git for a change that can never affect the server).
func watchedFiles() []string {
	var files []string
	filepath.WalkDir(config.Repo, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != config.Repo && (d.Name() == "web" || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		// tests can't change the running server, and a restart kills every live session
		if (strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go")) || d.Name() == "go.mod" {
			files = append(files, path)
		}
		return nil
	})
	return files
}

func mtimeSnapshot() map[string]time.Time {
	m := map[string]time.Time{}
	for _, f := range watchedFiles() {
		if info, err := os.Stat(f); err == nil {
			m[f] = info.ModTime()
		}
	}
	return m
}

func mapsEqual(a, b map[string]time.Time) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if !b[k].Equal(v) {
			return false
		}
	}
	return true
}

func rebuild() error {
	if err := os.MkdirAll(filepath.Dir(binPath), 0o755); err != nil {
		return err
	}
	cmd := exec.Command("go", "build", "-o", binPath, ".")
	cmd.Dir = config.Repo
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return nil
}

// restartOnChange rebuilds and replaces this process (exec) whenever a source file changes. A build that fails
// to compile keeps the old server running rather than replacing it with nothing.
func restartOnChange() {
	seen := mtimeSnapshot()
	for {
		time.Sleep(time.Second)
		now := mtimeSnapshot()
		if mapsEqual(seen, now) {
			continue
		}
		seen = now
		if err := rebuild(); err != nil {
			fmt.Println("not restarting:", err, "\n(fix the build to pick this up)")
			continue
		}
		fmt.Println("server changed, restarting")
		live.Mu.Lock()
		for _, lv := range live.Registry { // exec would orphan them; the page resumes each session on its next message
			lv.Kill()
		}
		live.Mu.Unlock()
		exe, err := filepath.Abs(binPath)
		if err != nil {
			continue
		}
		if err := syscall.Exec(exe, append([]string{exe}, os.Args[1:]...), os.Environ()); err != nil {
			fmt.Println("restart failed:", err)
		}
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		return
	}
	cmd.Start()
}

func main() {
	fmt.Print(banner)
	preflight()
	if _, err := os.Stat(filepath.Join(config.Dist, "index.html")); err != nil && !webassets.Available() {
		// first run from a fresh clone: build the UI so there is one command to learn. A standalone release
		// binary skips this: its UI is embedded, and config.Repo (baked in at its own build time) names a path
		// that only existed on the machine that built it.
		fmt.Println("Building the UI (first run only)...")
		cmd := exec.Command("sh", "-c", "npm install && npm run build")
		cmd.Dir = filepath.Join(config.Repo, "web")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			fmt.Println("UI build failed. Needs Node.js 18+ (npm on PATH).")
			os.Exit(1)
		}
	}
	go restartOnChange()
	go live.Reap()
	url := fmt.Sprintf("http://127.0.0.1:%d", config.Port)
	fmt.Printf("Opening drawa UI for %s\n\n", config.Root)
	fmt.Printf("  - Local:   %s\n", url)
	addr := fmt.Sprintf("127.0.0.1:%d", config.Port) // localhost only unless --net: this endpoint runs Claude Code with your permissions
	if config.Net {
		for _, ip := range config.LocalIPs() {
			fmt.Printf("  - Network: http://%s:%d/?token=%s\n", ip, config.Port, config.NetToken)
		}
		fmt.Println("\nThat Network link's token is only good for this run. Anyone who has it can run commands as you, so don't share it beyond people you trust on this network.")
		addr = fmt.Sprintf(":%d", config.Port) // every interface, not just loopback; config.Hosts still keeps DNS rebinding and outside hosts out
	} else {
		fmt.Println()
	}
	spin(1400*time.Millisecond, "Starting drawa...")
	if os.Getenv("DRAWA_OPENED") == "" { // set before exec, so self-restarts don't open another tab
		os.Setenv("DRAWA_OPENED", "1")
		openBrowser(url)
	}
	if err := http.ListenAndServe(addr, server.Handler()); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
