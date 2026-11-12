#!/usr/bin/env bash
# Upload <dir>/* to GitHub release <tag>, then rewrite SHA256SUMS over EVERY
# asset the release carries.
#
# WHY: two producers feed one release. The release workflow
# (.github/workflows/release.yml) builds the daemon archives for every target
# in targets.json; scripts/release/release.sh builds the signed public APK and
# the GPL/LGPL sources it owes on the maintainer's machine, because the signing
# key never leaves it. Whichever uploads second recomputes the manifest, so
# SHA256SUMS lists both halves in either order.
#
# A release that does not exist yet is created as a DRAFT on the existing tag.
# --publish makes it public and refuses unless SHA256SUMS lists every daemon
# archive and the APK: a public release missing one is an installer 404.
#
# Usage: scripts/release/publish-assets.sh <tag> <dir> [--publish]
# gh must be authenticated for the repository (GH_TOKEN in the workflow).
set -euo pipefail
cd "$(dirname "$0")/../.."

[ $# -ge 2 ] || {
  echo "usage: $0 <tag> <dir> [--publish]" >&2
  exit 2
}
tag="$1" dir="$2" mode="${3:-}"
version="${tag#v}"
# A SemVer pre-release (0.1.0-rc.1) is marked as one and never becomes
# "latest", which is what install.sh and install.ps1 resolve by default.
case "$version" in
  *-*) kind=(--prerelease) latest=(--prerelease) ;;
  *) kind=() latest=(--latest) ;;
esac

if ! gh release view "$tag" >/dev/null 2>&1; then
  echo "=== creating draft release $tag"
  gh release create "$tag" --draft "${kind[@]}" --verify-tag --title "$tag" --notes "\
Prebuilt daemon for Linux (x86_64, arm64; static, any distribution), macOS
(Intel, Apple silicon) and Windows x86_64, plus the public Android APK for arm64
phones (omp-pulse-$version-android-arm64.apk).

Install the daemon with install.sh or install.ps1 (README: Install); both verify
the download against SHA256SUMS.

The APK runs omp directly on the phone (it downloads a pinned Linux runtime on
first use) or connects to a laptop running omp-pulse. Install it by sideloading
or with Obtainium; it is not on Google Play. See docs/user/phone-mode.md.
proot-5.1.107.96-source.zip is the GPL-2.0 source of the proot binaries in the APK;
talloc-2.5.0.tar.gz is the LGPL-3.0 source of the talloc library in the APK."
fi

files=()
while IFS= read -r -d '' f; do files+=("$f"); done \
  < <(find "$dir" -maxdepth 1 -type f ! -name SHA256SUMS -print0 | sort -z)
if [ "${#files[@]}" -gt 0 ]; then
  echo "=== uploading ${#files[@]} assets to $tag"
  gh release upload "$tag" "${files[@]}" --clobber
fi

# The manifest covers what the release HOLDS, not what this run built. It is
# written beside the assets, never among them, or the glob would hash it too.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/assets"
gh release download "$tag" --dir "$work/assets" --pattern '*'
rm -f "$work/assets/SHA256SUMS"
(cd "$work/assets" && sha256sum -- * | LC_ALL=C sort -k2) >"$work/SHA256SUMS"
gh release upload "$tag" "$work/SHA256SUMS" --clobber
echo "=== SHA256SUMS"
sed 's/^/  /' "$work/SHA256SUMS"

[ "$mode" = "--publish" ] || exit 0

# An assignment, not `for t in $(jq ...)`: set -e ignores a failed substitution
# in a for list, and an empty list would publish without a single archive.
targets="$(jq -r '.[].target' scripts/release/targets.json)"
[ -n "$targets" ] || {
  echo "refusing to publish: scripts/release/targets.json lists no targets" >&2
  exit 1
}
required=("omp-pulse-$version-android-arm64.apk")
for target in $targets; do
  case "$target" in
    *-windows-*) required+=("omp-pulse-$version-$target.zip") ;;
    *) required+=("omp-pulse-$version-$target.tar.gz") ;;
  esac
done
missing=()
for name in "${required[@]}"; do
  awk -v a="$name" '$2 == a { found = 1 } END { exit !found }' "$work/SHA256SUMS" || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "refusing to publish $tag; missing:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi
gh release edit "$tag" --draft=false "${latest[@]}"
echo "=== published $tag"
