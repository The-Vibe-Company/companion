#!/usr/bin/env sh
set -eu

repo="${COMPANION_REPO:-The-Vibe-Company/companion}"
version="${COMPANION_VERSION:-latest}"
bindir="${BINDIR:-$HOME/.local/bin}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$os" in
    linux|darwin) ;;
    *)
        echo "unsupported OS: $os" >&2
        exit 1
        ;;
esac

case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
        echo "unsupported architecture: $arch" >&2
        exit 1
        ;;
esac

asset="companion_${os}_${arch}.tar.gz"
tmpdir="$(mktemp -d)"

cleanup() {
    rm -rf "$tmpdir"
}
trap cleanup EXIT INT TERM

if [ "$version" = "latest" ]; then
    url="https://github.com/${repo}/releases/latest/download/${asset}"
else
    url="https://github.com/${repo}/releases/download/${version}/${asset}"
fi

download() {
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$1" -o "$2"
    else
        curl -fsSL "$1" -o "$2"
    fi
}

echo "downloading ${url}"
download "$url" "$tmpdir/$asset"
download "${url}.sha256" "$tmpdir/$asset.sha256"

if command -v sha256sum >/dev/null 2>&1; then
    (cd "$tmpdir" && sha256sum -c "$asset.sha256")
elif command -v shasum >/dev/null 2>&1; then
    expected="$(awk '{print $1}' "$tmpdir/$asset.sha256")"
    actual="$(shasum -a 256 "$tmpdir/$asset" | awk '{print $1}')"
    if [ "$expected" != "$actual" ]; then
        echo "checksum mismatch for $asset" >&2
        exit 1
    fi
else
    echo "warning: sha256sum or shasum not found; skipping checksum verification" >&2
fi

tar -xzf "$tmpdir/$asset" -C "$tmpdir"
mkdir -p "$bindir"
install -m 0755 "$tmpdir/companion" "$bindir/companion"

echo "installed companion to ${bindir}/companion"
if [ -x "$bindir/companion" ]; then
    "$bindir/companion" version
fi

case ":$PATH:" in
    *":$bindir:"*) ;;
    *)
        echo "note: ${bindir} is not on PATH"
        ;;
esac
