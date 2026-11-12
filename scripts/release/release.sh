#!/usr/bin/env bash
# Build the public Android APK for a release and attach it to the GitHub
# release of the current tag.
#
# WHY THIS STAYS LOCAL: the APK is signed with the stable release key, which
# never leaves the maintainer's machine. Everything else in a release (the
# daemon archives for every target in targets.json) is built by the release
# workflow, .github/workflows/release.yml, when the tag is pushed. Both halves
# go through scripts/release/publish-assets.sh, which rewrites SHA256SUMS over
# every asset the release carries, so the order does not matter.
#
# ANDROID: the public APK (omp-pulse-<version>-android-arm64.apk) is built with
# OMP_PULSE_SERVER_URL unset, so first run offers "Run on this phone" or
# "Connect a laptop" instead of baking one developer's server. It is signed
# with the same stable release key as a self-hosted deployment APK (gradle
# refuses a debug fallback), so sideloaded installs update in place. A
# deployment APK with a baked server URL is built only by
# scripts/deploy/pulse-deploy.sh.
#
# Usage (from a clean checkout of the tag v<version in Cargo.toml>):
#   scripts/release/release.sh            # build into dist/, no upload
#   scripts/release/release.sh --draft    # also attach to the (draft) release
#   scripts/release/release.sh --publish  # attach, then publish the release;
#                                         # refuses while any daemon archive
#                                         # is still missing
#
# Environment:
#   OMP_PULSE_JDK  JDK 21 home for Gradle (default /usr/lib/jvm/java-21-openjdk)
# Node runs through `mise exec node@22.23.2` when mise is installed, otherwise
# the node/npx on PATH (see web/package.json "engines").
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE="${1:-build-only}"
case "$MODE" in
build-only | --draft | --publish) ;;
*)
  echo "unknown mode: $MODE (use --draft or --publish)" >&2
  exit 2
  ;;
esac
VERSION="$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)"
TAG="v$VERSION"
DIST="dist"
BIN="omp-pulse"

# The release workflow computes the release ID from the tagged commit of a
# clean checkout; the APK carries one too, and they must agree. An upload from
# any other tree would attach an APK that belongs to a different build.
if [ "$MODE" != build-only ]; then
  tag_commit="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}")" || {
    echo "tag $TAG does not exist; create and push it first (it starts the release workflow)" >&2
    exit 1
  }
  [ "$(git rev-parse HEAD)" = "$tag_commit" ] || {
    echo "HEAD is not $TAG; check out the tag before attaching its APK" >&2
    exit 1
  }
  [ -z "$(git status --porcelain)" ] || {
    echo "the working tree has changes; the APK would not match $TAG's release ID" >&2
    exit 1
  }
fi

[ -d web/node_modules ] || {
  echo "web/node_modules is missing: run npm ci in web/ first" >&2
  exit 1
}

JDK="${OMP_PULSE_JDK:-/usr/lib/jvm/java-21-openjdk}"
node_exec() {
  if command -v mise >/dev/null 2>&1; then
    mise exec node@22.23.2 -- "$@"
  else
    "$@"
  fi
}

rm -rf "$DIST"
mkdir -p "$DIST"

echo "=== android-arm64 (public APK)"
# mobile/node_modules is not committed; a release installs it fresh from the
# lockfile (Gradle builds Capacitor from it).
(cd mobile && node_exec npm ci --no-audit --no-fund) >/dev/null
(
  unset OMP_PULSE_SERVER_URL
  # release-id.sh fingerprints the server URL, so the public build gets its
  # own identity; web, runtime daemon and APK must all carry it.
  RELEASE_ID="$(scripts/release/release-id.sh)"
  export RELEASE_ID OMP_PULSE_RELEASE_ID="$RELEASE_ID" VITE_RELEASE_ID="$RELEASE_ID"
  (cd web && node_exec npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false) >/dev/null
  (cd mobile && node_exec npx cap sync android) >/dev/null
  scripts/android/build-runtime.sh >/dev/null
  # JDK 21 matches scripts/deploy/pulse-deploy.sh; the system default fails in jlink.
  (cd mobile/android && JAVA_HOME="$JDK" ./gradlew --quiet assembleRelease) >/dev/null
)
name="$BIN-$VERSION-android-arm64.apk"
cp mobile/android/app/build/outputs/apk/release/app-release.apk "$DIST/$name"
echo "  $name"
# The same bytes under a version-free name, so the README's
# releases/latest/download/omp-pulse.apk link always resolves to the newest APK.
cp "$DIST/$name" "$DIST/$BIN.apk"
echo "  $BIN.apk"
# GPL-2.0 §3: the APK ships proot binaries, so the release offers their
# complete source from the same place. Pinned to the Termux recipe's sha256
# (mobile/android/vendor/proot/PROVENANCE.md); bump both together.
src="proot-5.1.107.96-source.zip"
curl -fsSL -o "$DIST/$src" https://github.com/termux/proot/archive/v5.1.107.96.zip
echo "75f654fe60dea92dabff2bf083ae8bfe4f91baa6a1a374786a6bf391015eebaa  $DIST/$src" | sha256sum -c --quiet -
echo "  $src"
# LGPL-3.0 (GPL-3.0 §6) applies to the talloc library the APK carries, so its
# source travels with the release too. Pinned to the Termux recipe's sha256.
tsrc="talloc-2.5.0.tar.gz"
curl -fsSL -o "$DIST/$tsrc" https://www.samba.org/ftp/talloc/talloc-2.5.0.tar.gz
echo "912afa237510ae542a7733998eb18a12bcda35ab6729c8e2ddb43e8d0ebab007  $DIST/$tsrc" | sha256sum -c --quiet -
echo "  $tsrc"

if [ "$MODE" = build-only ]; then
  echo
  echo "built only. Re-run with --draft or --publish to attach it to $TAG."
  exit 0
fi

command -v gh >/dev/null || {
  echo "gh not found" >&2
  exit 1
}
# gh talks to whichever account is active; use the one that owns origin.
owner="$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+)/.*#\1#')"
if tok="$(gh auth token -u "$owner" 2>/dev/null)" && [ -n "$tok" ]; then export GH_TOKEN="$tok"; fi
flag=()
[ "$MODE" = "--publish" ] && flag=(--publish)
scripts/release/publish-assets.sh "$TAG" "$DIST" "${flag[@]}"
