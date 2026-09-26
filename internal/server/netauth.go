// Guards the network address --net opens up. config.NetToken is short enough to type or read off a phone,
// so the defense isn't its length: a valid ?token= is remembered via a cookie so the rest of a browser's own
// requests pass automatically, and an address that guesses wrong too many times is locked out for a while.
package server

import (
	"net"
	"net/http"
	"sync"
	"time"

	"claude-ui/internal/config"
)

const (
	netCookie      = "drawa_net"
	maxNetAttempts = 5
	netLockout     = 5 * time.Minute
)

var (
	netAuthMu sync.Mutex
	netFails  = map[string]int{}       // remote address -> consecutive wrong tokens
	netLocked = map[string]time.Time{} // remote address -> locked out until
)

// netAuthorized reports whether this request may proceed. On a first valid ?token= it also sets the cookie
// that lets the rest of this browser's requests (the SSE stream, images, posts) skip the check.
func netAuthorized(w http.ResponseWriter, r *http.Request) bool {
	if !config.Net || config.IsLocalHost(r.Host) {
		return true
	}
	addr := remoteAddr(r)

	netAuthMu.Lock()
	locked := netLocked[addr]
	netAuthMu.Unlock()
	if time.Now().Before(locked) {
		return false
	}

	token := r.URL.Query().Get("token")
	if token == "" {
		if c, err := r.Cookie(netCookie); err == nil {
			token = c.Value
		}
	}
	if token != "" && token == config.NetToken {
		netAuthMu.Lock()
		delete(netFails, addr)
		delete(netLocked, addr)
		netAuthMu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: netCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode})
		return true
	}

	netAuthMu.Lock()
	netFails[addr]++
	if netFails[addr] >= maxNetAttempts {
		netLocked[addr] = time.Now().Add(netLockout)
		delete(netFails, addr)
	}
	netAuthMu.Unlock()
	return false
}

func remoteAddr(r *http.Request) string {
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return h
	}
	return r.RemoteAddr
}
