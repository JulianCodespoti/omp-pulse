#!/usr/bin/env bash
# Build the signed release APK from the working tree and install it on a
# paired phone over adb, then prove the phone runs it.
#
#   scripts/android/install-phone.sh                 # first adb device
#   OMP_PULSE_ADB_SERIAL=192.168.1.50:5555 scripts/android/install-phone.sh
#   scripts/android/install-phone.sh --no-build      # install the last built APK
#
# WHY: the stage order is load-bearing (vite -> cap sync -> runtime library ->
# Gradle -> cargo, see pulse-deploy.sh) and the release ID must be exported to
# every stage, or the APK and its embedded daemon disagree. Doing it by hand
# took a long command per install and was easy to get subtly wrong. This
# never touches the desktop daemon or its service; it only replaces the app
# on the phone (`adb install -r`, data kept), which ends turns running there.
#
# Needs: the release signing properties in ~/.gradle/gradle.properties, a
# Java 21 JDK (OMP_PULSE_JDK, default /usr/lib/jvm/java-21-openjdk), and a
# device in `adb devices` (wireless: `adb connect <ip:port>` first).
set -euo pipefail
cd "$(dirname "$0")/../.."

build=1
[ "${1:-}" = "--no-build" ] && build=0

serial="${OMP_PULSE_ADB_SERIAL:-$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')}"
[ -n "$serial" ] || {
  echo "install-phone: no adb device; pair or 'adb connect' first" >&2
  exit 2
}
adb_() { timeout "${ADB_TIMEOUT:-60}" adb -s "$serial" "$@"; }

apk=mobile/android/app/build/outputs/apk/release/app-release.apk
release_id="$(scripts/release/release-id.sh)"

if [ "$build" = 1 ]; then
  export RELEASE_ID="$release_id" OMP_PULSE_RELEASE_ID="$release_id" VITE_RELEASE_ID="$release_id"
  unset OMP_PULSE_SERVER_URL # public build: the app's saved mode decides where it connects
  echo "install-phone: building $release_id"
  (cd web && npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false >/dev/null)
  (cd mobile && npx cap sync android >/dev/null)
  scripts/android/build-runtime.sh >/dev/null
  (cd mobile/android && JAVA_HOME="${OMP_PULSE_JDK:-/usr/lib/jvm/java-21-openjdk}" ./gradlew -q assembleRelease)
  cargo build --locked --release -q
fi

bt="$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/* | sort -V | tail -1)"
"$bt/apksigner" verify "$apk" >/dev/null 2>&1 || {
  echo "install-phone: $apk is not validly signed" >&2
  exit 1
}
echo "install-phone: $("$bt/aapt2" dump badging "$apk" | grep -o "versionCode='[0-9]*'") on $serial"
ADB_TIMEOUT=300 adb_ install -r "$apk" >/dev/null
adb_ shell monkey -p com.omppulse.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true

# The app's own daemon serves its release ID once it is up.
adb_ forward tcp:17681 tcp:7681 >/dev/null
trap 'adb_ forward --remove tcp:17681 >/dev/null 2>&1 || true' EXIT
live=""
for _ in $(seq 1 20); do
  live="$(curl -s -m 3 http://127.0.0.1:17681/app/release-id || true)"
  [ -n "$live" ] && break
  sleep 2
done
# Only phone mode serves a release ID on the phone; in computer mode the app
# shows the computer's page, so the installed versionCode is the proof.
if [ -z "$live" ]; then
  want="$("$bt/aapt2" dump badging "$apk" | grep -o "versionCode='[0-9]*'" | tr -dc 0-9)"
  have="$(adb_ shell dumpsys package com.omppulse.app | grep -o 'versionCode=[0-9]*' | head -n1 | tr -dc 0-9)"
  [ "$have" = "$want" ] || {
    echo "install-phone: installed versionCode $have, expected $want" >&2
    exit 1
  }
  echo "install-phone: installed versionCode $have (phone is in computer mode; no on-phone release to check)"
elif [ "$build" = 1 ] && [ "$live" != "$release_id" ]; then
  echo "install-phone: phone serves '$live', expected $release_id" >&2
  exit 1
else
  echo "install-phone: phone runs $live"
fi
