package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"drawa/internal/config"
)

func TestNetAuth(t *testing.T) {
	oldNet, oldToken, oldHosts := config.Net, config.NetToken, config.Hosts
	config.Net = true
	config.NetToken = "testtok1"
	config.Hosts = map[string]bool{"127.0.0.1:8765": true, "localhost:8765": true, "10.0.0.5:8765": true}
	t.Cleanup(func() {
		config.Net, config.NetToken, config.Hosts = oldNet, oldToken, oldHosts
		netAuthMu.Lock()
		netFails, netLocked = map[string]int{}, map[string]time.Time{}
		netAuthMu.Unlock()
	})

	srv := httptest.NewServer(Handler())
	defer srv.Close()
	const netHost = "10.0.0.5:8765" // stands in for this machine's LAN address

	get := func(path, host string, cookies []*http.Cookie) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		req.Host = host
		for _, c := range cookies {
			req.AddCookie(c)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}

	if resp := get("/api/info", netHost, nil); resp.StatusCode != 403 {
		t.Errorf("network host, no token: status %d, want 403", resp.StatusCode)
	}
	if resp := get("/api/info", "127.0.0.1:8765", nil); resp.StatusCode != 200 {
		t.Errorf("localhost, no token: status %d, want 200 (localhost never needs one)", resp.StatusCode)
	}

	resp := get("/api/info?token=testtok1", netHost, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("network host, valid token: status %d, want 200", resp.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == netCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("valid token didn't set the auth cookie")
	}
	if resp := get("/api/info", netHost, []*http.Cookie{cookie}); resp.StatusCode != 200 {
		t.Errorf("cookie from earlier valid token: status %d, want 200", resp.StatusCode)
	}

	for i := 0; i < maxNetAttempts; i++ {
		get("/api/info?token=wrong", netHost, nil)
	}
	if resp := get("/api/info?token=testtok1", netHost, nil); resp.StatusCode != 403 {
		t.Errorf("locked-out address, even with the right token: status %d, want 403", resp.StatusCode)
	}
}
