#!/bin/sh
# omp-pulse installer for Linux and macOS.
#
# Downloads the release binary for this OS/arch, verifies its SHA256 against
# the release's SHA256SUMS file, and installs it to ~/.local/bin.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/JulianCodespoti/omp-pulse/main/install.sh | sh
#   OMP_PULSE_VERSION=0.1.0 sh install.sh          # pin a version
#   OMP_PULSE_INSTALL_DIR="$HOME/bin" sh install.sh # override the install dir
#   OMP_PULSE_BASE_URL=http://localhost:8000 sh install.sh  # mirror or local test
#
# POSIX sh only; no bashisms. Windows users: install.ps1.
set -eu

# --- detect OS and architecture ----------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
Linux) os="linux" ;;
Darwin) os="macos" ;;
*)
  echo "unsupported OS: $os (only Linux and macOS have a binary release)" >&2
  exit 1
  ;;
esac

case "$arch" in
x86_64 | amd64) target_arch="x86_64" ;;
aarch64 | arm64) target_arch="aarch64" ;;
*)
  echo "unsupported architecture: $arch" >&2
  exit 1
  ;;
esac

if [ "$os" = "linux" ]; then
  # Linux releases are static musl builds: one binary per architecture runs on
  # every distribution, glibc or musl, old or new.
  target="$target_arch-unknown-linux-musl"
else
  target="$target_arch-apple-darwin"
fi

# --- locate fetch and hash tools ---------------------------------------------
fetch=""
if command -v curl >/dev/null 2>&1; then
  fetch="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  fetch="wget -qO-"
else
  echo "need curl or wget to download the release" >&2
  exit 1
fi

sha_tool=""
if command -v sha256sum >/dev/null 2>&1; then
  sha_tool="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  sha_tool="shasum -a 256"
else
  echo "need sha256sum or shasum to verify the download" >&2
  exit 1
fi

# --- resolve the version (override with OMP_PULSE_VERSION) --------------------
version="${OMP_PULSE_VERSION:-}"
if [ -z "$version" ]; then
  version="$($fetch https://api.github.com/repos/JulianCodespoti/omp-pulse/releases/latest |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' |
    head -n 1)"
  if [ -z "$version" ]; then
    echo "could not resolve the latest release version; set OMP_PULSE_VERSION" >&2
    exit 1
  fi
fi

# Release asset base. Overridable so the script can be TESTED against a local
# server or an internal mirror; an installer nobody has run is not an installer.
base="${OMP_PULSE_BASE_URL:-https://github.com/JulianCodespoti/omp-pulse/releases/download/v$version}"
dest="${OMP_PULSE_INSTALL_DIR:-$HOME/.local/bin}"

# --- pick an asset the release actually lists ---------------------------------
# Read SHA256SUMS FIRST: it is the release's manifest. An older release may not
# carry this platform, and a 404 halfway through says nothing useful.
sums="$($fetch "$base/SHA256SUMS")" || {
  echo "could not download $base/SHA256SUMS" >&2
  exit 1
}
listed() {
  printf '%s\n' "$sums" | awk -v a="$1" '$2 == a || $2 == "*" a { print $1 }' | head -n 1
}
asset="omp-pulse-$version-$target.tar.gz"
expected="$(listed "$asset")"
if [ -z "$expected" ]; then
  echo "release v$version has no prebuilt binary for $target." >&2
  echo "build from source instead:" >&2
  echo "  https://github.com/JulianCodespoti/omp-pulse#build-from-source" >&2
  exit 1
fi

# --- download, verify, install ------------------------------------------------
tmp="$(mktemp -d "${TMPDIR:-/tmp}/omp-pulse-install-XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "downloading $asset"
$fetch "$base/$asset" >"$tmp/omp-pulse.tar.gz"

echo "verifying SHA256"
actual="$($sha_tool "$tmp/omp-pulse.tar.gz" | awk '{ print $1 }')"
if [ "$actual" != "$expected" ]; then
  echo "SHA256 mismatch: expected $expected, got $actual" >&2
  exit 1
fi

mkdir -p "$dest"
tar -xzf "$tmp/omp-pulse.tar.gz" -C "$tmp"
install -m 0755 "$tmp/omp-pulse" "$dest/omp-pulse"

echo "installed $dest/omp-pulse"
if ! printf '%s\n' "$PATH" | tr ':' '\n' | grep -Fxq -- "$dest"; then
  echo
  echo "note: $dest is not on your PATH. Add it, for example:"
  echo "  echo 'export PATH=\"$dest:\$PATH\"' >> ~/.profile"
fi
echo
echo "next step: run  omp-pulse setup  then  omp-pulse service install  (or omp-pulse serve)."
