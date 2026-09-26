// Package config holds paths and constants shared by the rest of the server, and Inside() (the path-safety
// check every file route uses).
package config

import (
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

const defaultPort = 8765

// Port is 8765 unless DRAWA_PORT overrides it (e.g. two projects open at once, or 8765 is already taken).
var Port = port()

func port() int {
	if v := os.Getenv("DRAWA_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 && p < 65536 {
			return p
		}
	}
	return defaultPort
}

// Repo is this module's root: where main.go and web/ live. runtime.Caller embeds the build-time source path,
// so this resolves correctly whether launched via `go run` or a built binary, as long as the source tree hasn't
// moved since the binary was built (true here: the restart-on-change loop always rebuilds before re-exec'ing).
var Repo = repoRoot()

func repoRoot() string {
	_, thisFile, _, _ := runtime.Caller(0) // .../internal/config/config.go
	dir, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	if err != nil {
		dir = "."
	}
	return dir
}

var Dist = filepath.Join(Repo, "web", "dist")

// Net is true when --net was passed: listen on every interface, not just loopback, so other devices on the
// network can reach the server too. Off by default, since this endpoint runs Claude Code with your permissions.
var Net = hasFlag("--net")

func hasFlag(name string) bool {
	for _, a := range os.Args[1:] {
		if a == name {
			return true
		}
	}
	return false
}

const tokenChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// NetToken guards the network address when --net is passed (127.0.0.1/localhost never need it: see
// IsLocalHost). It's short (8 characters — a URL you can read out or type), so the request path that checks
// it (internal/server's netAuthorized) also locks out an address after repeated wrong guesses; the length
// alone isn't the defense. Empty, and unused, when --net wasn't passed.
var NetToken = netToken()

func netToken() string {
	if !Net {
		return ""
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the OS RNG failing is not something we can recover from
	}
	out := make([]byte, len(b))
	for i, c := range b {
		out[i] = tokenChars[int(c)%len(tokenChars)]
	}
	return string(out)
}

// IsLocalHost is true for the loopback Host header: always trusted, so it never needs NetToken. Anything else
// accepted by Hosts is one of this machine's LAN addresses (only present there when --net was passed).
func IsLocalHost(host string) bool {
	return host == fmt.Sprintf("127.0.0.1:%d", Port) || host == fmt.Sprintf("localhost:%d", Port)
}

// Root is the project folder Claude works in: the first non-flag argument, default the current folder.
var Root = rootDir()

func rootDir() string {
	arg := "."
	for _, a := range os.Args[1:] {
		if !strings.HasPrefix(a, "-") {
			arg = a
			break
		}
	}
	abs, err := filepath.Abs(arg)
	if err != nil {
		abs = arg
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return abs
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

// Sessions is where Claude Code stores this project's transcripts: path mangled to dashes, one char at a time
// (must match the CLI's own mangling exactly, so `re.sub` semantics: no collapsing runs of separators).
var Sessions = filepath.Join(sessionsBase(), "projects", nonAlnum.ReplaceAllString(Root, "-"))

func sessionsBase() string {
	if v := os.Getenv("CLAUDE_CONFIG_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

var Modes = map[string]bool{
	"default": true, "acceptEdits": true, "auto": true, "plan": true, "bypassPermissions": true,
}

// With --net the server listens on every interface (see main.go), so its own LAN address(es) must pass the
// same Host-header allowlist that 127.0.0.1/localhost do; LocalIPs() is what finds them.
var Hosts = hosts()

func hosts() map[string]bool {
	m := map[string]bool{
		fmt.Sprintf("127.0.0.1:%d", Port): true,
		fmt.Sprintf("localhost:%d", Port): true,
	}
	if Net {
		for _, ip := range LocalIPs() {
			m[fmt.Sprintf("%s:%d", ip, Port)] = true
		}
	}
	return m
}

// LocalIPs returns this machine's outward-facing IPv4 address (how another device on the same network would
// reach it) — or none when there's no network route (e.g. fully offline). A UDP dial doesn't send any packets;
// it just asks the OS which local address it would use to reach that destination, which is also the standard
// trick for finding the real NIC's address instead of a VM/container bridge's.
func LocalIPs() []string {
	conn, err := net.Dial("udp4", "8.8.8.8:80")
	if err != nil {
		return nil
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP.IsLoopback() || addr.IP.IsUnspecified() {
		return nil
	}
	return []string{addr.IP.String()}
}

// + the Vite dev server, which proxies to us
var Origins = mergeOrigins()

func mergeOrigins() map[string]bool {
	m := map[string]bool{"127.0.0.1:5173": true, "localhost:5173": true}
	for k := range Hosts {
		m[k] = true
	}
	return m
}

var UUIDRe = regexp.MustCompile(`^[0-9a-f-]{36}$`)

// live Claude processes with no traffic for this long are closed (the next message resumes them)
const IdleSecs = 30 * 60

// This UI renders Mermaid; models often name a node "graph", which Mermaid rejects.
const SystemNote = `Replies are shown in a web UI that renders Markdown and Mermaid. In Mermaid diagrams never use keywords (graph, end, subgraph, flowchart, class, style, click) as node ids; e.g. write graphMod["graph.ts"].`

var ErrOutside = errors.New("outside project folder")

// Inside resolves rel against Root and refuses anything that escapes it. Like Python's (ROOT / rel).resolve(),
// an absolute rel stands alone (so it's only accepted when it already lies inside Root).
func Inside(rel string) (string, error) {
	p := rel
	if !filepath.IsAbs(p) {
		p = filepath.Join(Root, rel)
	}
	resolved, err := resolve(filepath.Clean(p))
	if err != nil {
		return "", err
	}
	// Rel, not a string prefix: /root2 isn't inside /root, and everything is inside Root == "/"
	if r, err := filepath.Rel(Root, resolved); err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", ErrOutside
	}
	return resolved, nil
}

// resolve follows symlinks in p even when its leaf doesn't exist yet: the deepest existing ancestor is resolved
// and the rest re-appended, so lnk/new with lnk -> /etc resolves to /etc/new.
func resolve(p string) (string, error) {
	tail := ""
	for {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Join(r, tail), nil
		}
		if _, err := os.Lstat(p); err == nil { // exists but won't resolve: a dangling or looping link
			return "", ErrOutside
		}
		parent := filepath.Dir(p)
		if parent == p {
			return filepath.Join(p, tail), nil
		}
		tail = filepath.Join(filepath.Base(p), tail)
		p = parent
	}
}
