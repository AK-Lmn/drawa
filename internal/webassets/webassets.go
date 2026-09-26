// Package webassets embeds a built frontend for standalone release binaries. The release workflow
// (.github/workflows/release.yml) builds web/ and copies web/dist here before `go build`, so the resulting
// binary can serve the UI on its own, with no web/ folder or Node needed on the machine that runs it.
// Everyday dev is unaffected: main.go and internal/server/handler.go serve straight from disk (config.Dist,
// i.e. web/dist) whenever that's present, and only fall back to this embedded copy when it isn't.
package webassets

import "embed"

//go:embed all:dist
var Dist embed.FS

// Available reports whether a real build was embedded, as opposed to just the placeholder .gitkeep that keeps
// `go build` working in a checkout that hasn't run the release copy step.
func Available() bool {
	_, err := Dist.Open("dist/index.html")
	return err == nil
}
