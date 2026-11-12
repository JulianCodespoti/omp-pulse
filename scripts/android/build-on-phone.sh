#!/usr/bin/env bash
# android-phone-build: build the omp-pulse APK on the phone itself (arm64
# Alpine/Termux-style environment with the Android SDK in ~/android-sdk).
#
# Usage:
#   scripts/android/build-on-phone.sh [debug|release] [gradle args...]
#   scripts/android/build-on-phone.sh debug -PompPulseAppIdSuffix=.dev   # side-by-side install
#
# Stages, in the order the embedding rules require (see scripts/deploy/pulse-deploy.sh):
#   web (vite → public/app) → cap sync android → runtime lib (cargo) → gradle
# OMP_PULSE_SERVER_URL is passed through untouched: unset builds the public APK
# (first run asks "Run on this phone" / "Connect a laptop"), set bakes a laptop.
#
# Every fact below was learned the hard way on a phone with ~1.5 GB free RAM:
# - JDK 17 only: Gradle under JDK 21 aborts on this device.
# - system `gradle` (8.14.4), not ./gradlew: the wrapper would download 8.2.1
#   and an x86_64-only toolchain around it.
# - aapt2 from tools-aarch64: build-tools' aapt2 is x86_64 even on arm64 SDKs.
# - build-tools pinned by android-phone-init.gradle (AGP wants 34.0.0, absent).
# - nice -n 19, serial GC, 1280 MB heap, two workers, two cargo jobs, no
#   daemon: anything bigger and the low-memory killer takes the build, or the
#   phone's foreground apps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VARIANT=debug
case "${1:-}" in
debug | release)
  VARIANT="$1"
  shift
  ;;
esac
for arg in "$@"; do
  case "$arg" in
  -*) ;;
  *)
    echo "android-phone-build: unexpected argument '$arg' (usage: [debug|release] [gradle -P/-D/--flags...])" >&2
    exit 2
    ;;
  esac
done

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
JDK="${OMP_PULSE_JDK:-/usr/lib/jvm/java-17-openjdk}"
AAPT2="${OMP_PULSE_AAPT2:-$SDK/tools-aarch64/aapt2}"
export OMP_PULSE_BUILD_TOOLS="${OMP_PULSE_BUILD_TOOLS:-36.0.0}"

die() {
  echo "android-phone-build: $*" >&2
  exit 1
}
[ -x "$JDK/bin/java" ] || die "JDK 17 not found at $JDK (set OMP_PULSE_JDK); JDK 21 aborts Gradle on phones"
command -v gradle >/dev/null || die "system gradle not found (Alpine: apk add gradle)"
[ -x "$AAPT2" ] || die "arm64 aapt2 not found at $AAPT2 (set OMP_PULSE_AAPT2)"
[ -d "$SDK/build-tools/$OMP_PULSE_BUILD_TOOLS" ] ||
  die "build-tools $OMP_PULSE_BUILD_TOOLS missing from $SDK (installed: $(ls "$SDK/build-tools" 2>/dev/null | tr '\n' ' '); set OMP_PULSE_BUILD_TOOLS)"
[ -d web/node_modules ] || die "web/node_modules missing: (cd web && npm ci)"
# mobile/node_modules is not committed: install it from the lockfile when it is
# missing or older than the lock (Gradle builds Capacitor from it).
[ mobile/node_modules/.package-lock.json -nt mobile/package-lock.json ] ||
  (cd mobile && nice -n 19 npm ci --no-audit --no-fund)

export ANDROID_HOME="$SDK"
export JAVA_HOME="$JDK"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
# One identity for the web client, the embedded daemon and the APK; build.rs
# and Gradle both refuse mismatched values.
RELEASE_ID="$(scripts/release/release-id.sh)"
export RELEASE_ID OMP_PULSE_RELEASE_ID="$RELEASE_ID" VITE_RELEASE_ID="$RELEASE_ID"
echo "→ release id: $RELEASE_ID; server url: ${OMP_PULSE_SERVER_URL:-<unset: public build>}"

echo "→ web build (vite → public/app)"
(cd web && nice -n 19 npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false)

echo "→ capacitor sync android"
(cd mobile && nice -n 19 npx cap sync android)

echo "→ runtime daemon"
nice -n 19 scripts/android/build-runtime.sh

TASK="assemble${VARIANT^}"
echo "→ gradle $TASK"
(cd mobile/android && nice -n 19 gradle --no-daemon \
  -Dorg.gradle.jvmargs="-Xmx1280m -XX:MaxMetaspaceSize=512m -XX:+UseSerialGC" \
  -Dorg.gradle.workers.max=2 \
  -Pandroid.aapt2FromMavenOverride="$AAPT2" \
  --init-script "$ROOT/scripts/android/build-on-phone.init.gradle" \
  "$TASK" "$@")

ls -l "mobile/android/app/build/outputs/apk/$VARIANT/"*.apk
