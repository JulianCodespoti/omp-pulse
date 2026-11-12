#!/usr/bin/env bash
# Run a command against the APK on a local Android emulator.
#
# Drive the actual Android WebView against an isolated daemon. Debug builds receive
# their loopback endpoint through Gradle environment, never a config rewrite.
#
# USAGE
#
#   e2e/with-test-daemon.sh e2e/with-emulator.sh node e2e/android/verify-native.mjs
#
# ENVIRONMENT (all optional)
#
#   ANDROID_SDK_ROOT   SDK with platform-tools and emulator  (default ~/Android/Sdk)
#   OMP_PULSE_EMU_AVD  AVD to boot when none is running      (default Pixel4_Debug)
#   OMP_PULSE_EMU_PORT emulator console port                  (default 5556)
#   ANDROID_AVD_HOME   AVD directory (default: ~/.android/avd, else ~/.config/.android/avd)
#   OMP_PULSE_JDK      JDK 21 home for Gradle                 (default /usr/lib/jvm/java-21-openjdk)
#
# MUST run INSIDE with-test-daemon.sh: this points the APK at that throwaway
# daemon over `adb reverse`, so the emulator talks to a daemon this run started
# and to no other. It never reads the live token and never resolves the tailnet
# name; if the harness variables are absent it fails rather than guessing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
ADB="$SDK/platform-tools/adb"
EMULATOR="$SDK/emulator/emulator"
AVD="${OMP_PULSE_EMU_AVD:-Pixel4_Debug}"
PORT_NUM="${OMP_PULSE_EMU_PORT:-5556}"
SERIAL="emulator-$PORT_NUM"
if [ -z "${ANDROID_AVD_HOME:-}" ]; then
  for dir in "$HOME/.android/avd" "$HOME/.config/.android/avd"; do
    if [ -d "$dir" ]; then
      export ANDROID_AVD_HOME="$dir"
      break
    fi
  done
fi

node_exec() {
  if command -v mise >/dev/null 2>&1; then
    mise exec node@22.23.2 -- "$@"
  else
    "$@"
  fi
}

if [ -z "${OMP_PULSE_TEST_TOKEN:-}" ] || [ -z "${OMP_PULSE_TEST_BASE:-}" ] \
  || [ -z "${OMP_PULSE_TEST_TMP:-}" ] || [ -z "${OMP_PULSE_TEST_SESSIONS:-}" ] \
  || [ -z "${OMP_PULSE_TEST_DAEMON_PID:-}" ]; then
  echo "run inside e2e/with-test-daemon.sh — this harness requires its isolated daemon, token, sessions and scratch root." >&2
  echo "It never falls back to the live daemon or credential." >&2
  exit 2
fi
if ! [[ "$OMP_PULSE_TEST_BASE" =~ ^http://127\.0\.0\.1:[0-9]+$ ]]; then
  echo "refusing non-loopback isolated daemon URL: $OMP_PULSE_TEST_BASE" >&2
  exit 2
fi
# The daemon's port, taken from the harness rather than assumed.
DAEMON_PORT="${OMP_PULSE_TEST_BASE##*:}"
if [ "$DAEMON_PORT" = "7682" ]; then
  echo "refusing reserved live daemon port 7682" >&2
  exit 2
fi
if ! [[ "$OMP_PULSE_TEST_DAEMON_PID" =~ ^[0-9]+$ ]] || ((OMP_PULSE_TEST_DAEMON_PID <= 1)) \
  || ! kill -0 "$OMP_PULSE_TEST_DAEMON_PID" 2>/dev/null; then
  echo "OMP_PULSE_TEST_DAEMON_PID is not a running isolated child; start through e2e/with-test-daemon.sh" >&2
  exit 2
fi
TEST_ROOT="$(realpath "$OMP_PULSE_TEST_TMP")"
TEST_SESSIONS="$(realpath "$OMP_PULSE_TEST_SESSIONS")"
case "$TEST_SESSIONS/" in
  "$TEST_ROOT/"*) : ;;
  *) echo "refusing sessions root outside isolated OMP_PULSE_TEST_TMP" >&2; exit 2 ;;
esac

if [ -z "${OMP_PULSE_RELEASE_ID:-}" ]; then
  export OMP_PULSE_RELEASE_ID="$(cat "$ROOT/target/release/omp-pulse.release-id")"
fi

for tool in "$ADB" "$EMULATOR"; do
  [ -x "$tool" ] || {
    echo "missing $tool — install the Android SDK" >&2
    exit 2
  }
done

# A wedged emulator can report device while its shell hangs. Bound every probe.
adb_bounded() { timeout 20s "$ADB" "$@"; }

# ── emulator ────────────────────────────────────────────────────────────────
if ! adb_bounded devices | grep -q "^$SERIAL[[:space:]]*device"; then
  echo "→ booting $AVD (headless)"
  "$EMULATOR" -avd "$AVD" -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect -no-snapshot -port "$PORT_NUM" >/tmp/omp-emu.log 2>&1 &
  for _ in $(seq 1 180); do
    if [ "$(adb_bounded -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then break; fi
    sleep 1
  done
fi
[ "$(adb_bounded -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] ||
  {
    echo "emulator did not boot; see /tmp/omp-emu.log" >&2
    exit 2
  }

# A reused AVD can retain a dead inspection proxy, even for adb reverse traffic.
# Scope this override to the harness rather than changing native client routing.
OLD_PROXY="$(adb_bounded -s "$SERIAL" shell settings get global http_proxy | tr -d '\r')"
restore_proxy() {
  if [ "$OLD_PROXY" = null ]; then
    adb_bounded -s "$SERIAL" shell settings delete global http_proxy >/dev/null
  else
    adb_bounded -s "$SERIAL" shell settings put global http_proxy "$OLD_PROXY" >/dev/null
  fi
}
trap restore_proxy EXIT
adb_bounded -s "$SERIAL" shell settings put global http_proxy :0 >/dev/null

# The emulator's own localhost, forwarded to the harness daemon on the host.
# Keeps the app on loopback: no tailnet name, no LAN exposure.
"$ADB" -s "$SERIAL" reverse "tcp:$DAEMON_PORT" "tcp:$DAEMON_PORT" >/dev/null

# Debug-only endpoint override; the release config is never mutated.
export OMP_PULSE_SERVER_URL="http://localhost:$DAEMON_PORT/app/"
echo "→ copying React UI and building debug shell against $OMP_PULSE_SERVER_URL"
# mobile/node_modules is not committed: install it from the lockfile when it is
# missing or older than the lock (Gradle builds Capacitor from it).
[ "$ROOT/mobile/node_modules/.package-lock.json" -nt "$ROOT/mobile/package-lock.json" ] ||
  (cd "$ROOT/mobile" && node_exec npm ci --no-audit --no-fund >/dev/null)
(cd "$ROOT/mobile" && node_exec npx cap sync android >/dev/null)
# Gradle refuses to package without the phone-mode runtime library. This
# harness drives the laptop-mode shell only, so an existing (even older)
# library is good enough and saves a cross-build per run.
[ -f "$ROOT/mobile/android/app/build/generated/runtime-jni/arm64-v8a/libomppulse.so" ] ||
  "$ROOT/scripts/android/build-runtime.sh" >/dev/null
# JDK 21, matching scripts/deploy/pulse-deploy.sh. A newer system default fails this
# build in jlink.
(cd "$ROOT/mobile/android" && JAVA_HOME="${OMP_PULSE_JDK:-/usr/lib/jvm/java-21-openjdk}" ./gradlew --quiet assembleDebug >/dev/null)
APK="$ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK" ] || {
  echo "debug APK not produced" >&2
  exit 2
}

# A debug build is signed with the debug key; the release build on this
# emulator is not, so replace it outright rather than failing on signatures.
"$ADB" -s "$SERIAL" uninstall com.omppulse.app >/dev/null 2>&1 || true
"$ADB" -s "$SERIAL" install -r "$APK" >/dev/null
echo "→ installed on $SERIAL"

export OMP_PULSE_EMU_SERIAL="$SERIAL"
export OMP_PULSE_EMU_APP_URL="http://localhost:$DAEMON_PORT/app/"
# Keep this shell alive until the native verification command returns.
"$@"
