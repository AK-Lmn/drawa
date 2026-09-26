#!/bin/sh
# Installs the latest drawa release for this machine's OS/arch. See INSTALL.md for manual steps and troubleshooting.
#   curl -fsSL https://raw.githubusercontent.com/probablysamir/drawa/main/install.sh | sh
set -e

repo="probablysamir/drawa"
bin="drawa"
install_dir="${DRAWA_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s)
case "$os" in
	Darwin) goos=darwin ;;
	Linux) goos=linux ;;
	*)
		echo "No release binary for $os. Build from source: see INSTALL.md." >&2
		exit 1
		;;
esac

arch=$(uname -m)
case "$arch" in
	arm64 | aarch64) goarch=arm64 ;;
	x86_64 | amd64) goarch=amd64 ;;
	*)
		echo "No release binary for $arch. Build from source: see INSTALL.md." >&2
		exit 1
		;;
esac

asset="$bin-$goos-$goarch.tar.gz"
url="https://github.com/$repo/releases/latest/download/$asset"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset..."
curl -fsSL "$url" -o "$tmp/$asset"
tar -xzf "$tmp/$asset" -C "$tmp"

mkdir -p "$install_dir"
mv "$tmp/$bin" "$install_dir/$bin"
chmod +x "$install_dir/$bin"
echo "Installed to $install_dir/$bin"

case ":$PATH:" in
	*":$install_dir:"*) ;;
	*)
		echo
		echo "$install_dir isn't on your PATH. Add it, e.g.:"
		echo "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
		;;
esac
