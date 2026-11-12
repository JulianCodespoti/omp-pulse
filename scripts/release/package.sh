#!/usr/bin/env bash
# Package the daemon binaries into the archive names install.sh and install.ps1
# derive from the platform they detect:
#   omp-pulse-<version>-<target>.tar.gz   (omp-pulse at the archive root)
#   omp-pulse-<version>-<target>.zip      (omp-pulse.exe at the root; Windows)
#
# Every target in scripts/release/targets.json must be present: a release
# missing one is an installer 404 for that platform, so a gap fails here.
#
# Usage: scripts/release/package.sh <bins-dir> <out-dir>
#   <bins-dir>/bin-<target>/omp-pulse[.exe] for every target (the layout the
#   release workflow's artifact download produces)
set -euo pipefail
cd "$(dirname "$0")/../.."

[ $# -eq 2 ] || {
  echo "usage: $0 <bins-dir> <out-dir>" >&2
  exit 2
}
bins="$1"
mkdir -p "$2"
out="$(cd "$2" && pwd)"
version="$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)"

# An assignment, not `for t in $(jq ...)`: set -e ignores a failed substitution
# in a for list, which would package nothing and exit 0.
targets="$(jq -r '.[].target' scripts/release/targets.json)"
[ -n "$targets" ] || {
  echo "package: scripts/release/targets.json lists no targets" >&2
  exit 1
}
for target in $targets; do
  dir="$bins/bin-$target"
  case "$target" in
    *-windows-*) exe="omp-pulse.exe" ;;
    *) exe="omp-pulse" ;;
  esac
  [ -f "$dir/$exe" ] || {
    echo "package: $dir/$exe is missing" >&2
    exit 1
  }
  # Artifact transfer drops the executable bit; the archive must carry it.
  chmod 0755 "$dir/$exe"
  name="omp-pulse-$version-$target"
  case "$target" in
    *-windows-*) (cd "$dir" && zip -q -X "$out/$name.zip" "$exe") && echo "  $name.zip" ;;
    *) tar -czf "$out/$name.tar.gz" -C "$dir" "$exe" && echo "  $name.tar.gz" ;;
  esac
done
