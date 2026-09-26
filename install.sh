#!/bin/sh
# Installs the latest drawa release for this machine's OS/arch. See INSTALL.md for manual steps and troubleshooting.
#   curl -fsSL https://raw.githubusercontent.com/probablysamir/drawa/main/install.sh | sh
set -e

repo="probablysamir/drawa"
bin="drawa"
install_dir="${DRAWA_INSTALL_DIR:-$HOME/.local/bin}"

# colors only on a terminal, and never with NO_COLOR (https://no-color.org)
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	bold=$(printf '\033[1m') dim=$(printf '\033[2m') red=$(printf '\033[31m') green=$(printf '\033[32m')
	yellow=$(printf '\033[33m') reset=$(printf '\033[0m')
else
	bold='' dim='' red='' green='' yellow='' reset=''
fi
ok() { printf '  %s✓%s %-14s %s\n' "$green" "$reset" "$1" "$2"; }
warn() { printf '  %s!%s %-14s %s\n' "$yellow" "$reset" "$1" "$2"; }
step() { printf '  %s→%s %-14s %s\n' "$dim" "$reset" "$1" "$2"; }
fail() {
	printf '  %s✗%s %-14s %s\n' "$red" "$reset" "$1" "$2" >&2
	[ -n "${3:-}" ] && printf '    %s\n' "$3" >&2
	exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

printf '\n%sInstalling drawa%s\n\n' "$bold" "$reset"

os=$(uname -s)
case "$os" in
	Darwin) goos=darwin ;;
	Linux) goos=linux ;;
	*) fail "Platform" "$os isn't supported" "Build from source instead: see INSTALL.md." ;;
esac
arch=$(uname -m)
case "$arch" in
	arm64 | aarch64) goarch=arm64 ;;
	x86_64 | amd64) goarch=amd64 ;;
	*) fail "Platform" "$arch isn't supported" "Build from source instead: see INSTALL.md." ;;
esac
ok "Platform" "$goos/$goarch"

for t in curl tar; do have "$t" || fail "Tools" "$t not found" "Install $t and run this again."; done
if have sha256sum; then sha="sha256sum"; elif have shasum; then sha="shasum -a 256"; else sha=""; fi
ok "Tools" "curl, tar${sha:+, ${sha%% *}}"

# /releases/latest redirects to /releases/tag/<version>: the version without an API call (no rate limit)
latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") ||
	fail "Release" "couldn't reach GitHub" "Check your connection and try again."
version=${latest##*/}
case "$version" in v*) ok "Release" "$version" ;; *) fail "Release" "no release found" "See https://github.com/$repo/releases" ;; esac

asset="$bin-$goos-$goarch.tar.gz"
base="https://github.com/$repo/releases/download/$version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

step "Downloading" "$asset"
curl -fSL --progress-bar "$base/$asset" -o "$tmp/$asset" ||
	fail "Download" "$asset failed" "Try again, or download it by hand: https://github.com/$repo/releases/latest"
ok "Downloaded" "$asset ($(($(wc -c <"$tmp/$asset") / 1024 / 1024)) MB)"

# releases before checksums.txt existed can't be verified: say so rather than fail
if [ -z "$sha" ]; then
	warn "Checksum" "skipped (no sha256sum or shasum on this machine)"
elif curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" 2>/dev/null; then
	want=$(grep " $asset\$" "$tmp/checksums.txt" | cut -d' ' -f1)
	got=$(cd "$tmp" && $sha "$asset" | cut -d' ' -f1)
	[ -n "$want" ] && [ "$want" = "$got" ] || fail "Checksum" "mismatch for $asset" "The download is corrupt or was tampered with. Nothing was installed."
	ok "Checksum" "sha256 verified"
else
	warn "Checksum" "skipped ($version has no checksums.txt)"
fi

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$install_dir" 2>/dev/null && [ -w "$install_dir" ] ||
	fail "Install" "$install_dir isn't writable" "Pick another folder with DRAWA_INSTALL_DIR, or run with sudo sh."
[ -e "$install_dir/$bin" ] && replaced=" (replaced the existing one)" || replaced=""
mv "$tmp/$bin" "$install_dir/$bin"
chmod +x "$install_dir/$bin"
ok "Installed" "$install_dir/$bin$replaced"

printf '\n%sRequirements%s\n\n' "$bold" "$reset"
missing=0
if have claude; then ok "claude" "found"; else
	warn "claude" "not found (required): drawa won't start without it. https://claude.com/claude-code"
	missing=1
fi
if have git; then ok "git" "found"; else warn "git" "not found (optional): the Git window won't work. https://git-scm.com/downloads"; fi
if have gh; then ok "gh" "found"; else warn "gh" "not found (optional): the GitHub window won't work. https://cli.github.com"; fi

case ":$PATH:" in
	*":$install_dir:"*) ;;
	*)
		printf '\n%s%s isn'"'"'t on your PATH.%s Add it, then open a new terminal:\n' "$yellow" "$install_dir" "$reset"
		printf '  echo '"'"'export PATH="%s:$PATH"'"'"' >> ~/.zshrc   # or ~/.bashrc\n' "$install_dir"
		;;
esac

if [ "$missing" = 1 ]; then
	printf '\n%sdrawa %s is installed.%s Install Claude Code, then run %sdrawa%s in a project folder.\n\n' "$bold" "$version" "$reset" "$bold" "$reset"
else
	printf '\n%sdrawa %s is ready.%s Run %sdrawa%s in a project folder to start.\n\n' "$bold" "$version" "$reset" "$bold" "$reset"
fi
