#!/usr/bin/env bash
set -euo pipefail
# pulse-deploy: the one true pipeline for any committed UI/native change.
# Usage: ./scripts/deploy/pulse-deploy.sh [--phone] [--no-apk] [--no-restart] [--clean] [--force-restart]
#
# Stage order is the whole point of this file, and it is NOT arbitrary:
#
#   1. vite build            → public/app   (relative base, no sourcemaps)
#   2. capacitor copy        → Android assets (same React UI and recovery page)
#   3. runtime lib           → scripts/android/build-runtime.sh: the aarch64 musl
#                              daemon packaged as libomppulse.so for phone mode
#   4. gradle assembleRelease→ publish public/app-release.apk + app-release.json
#   5. cargo build --release → embeds public/ (the app AND the freshly built APK)
#   6. scripts/deploy/pulse-restart.sh → restart when no daemon-hosted turn is live,
#                              then verify the funnel serves this release
#
# WHY this order: `include_dir!` bakes `public/` into the binary at COMPILE time,
# so anything that writes into `public/` must finish BEFORE cargo runs. This
# script used to build cargo at step 3 and gradle at step 5, which meant the
# binary always embedded the PREVIOUS release's APK; the download link served a
# stale build forever. `build.rs` now tells cargo that `public/` is an input, so
# the rebuild is triggered — but only if the order above is respected. The
# runtime lib (3) embeds public/ too, so it also runs after vite, and before
# gradle because the APK packages it.
#
# There is deliberately NO static preview server any more. The selected
# system or user service serves embedded assets at /app/, so the phone and
# offline fallback share the actual deployed endpoint.
#
# Improve this file, not ad-hoc cargo/cap/gradle invocations.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

source "$ROOT/scripts/deploy/pulse-target.sh"

# JDK 21 for Gradle (the newer system default fails in jlink). OMP_PULSE_JDK
# overrides the path, as in scripts/android/build-on-phone.sh.
JDK="${OMP_PULSE_JDK:-/usr/lib/jvm/java-21-openjdk}"

# Pinned node through mise when it is installed, else node/npx on PATH (must
# satisfy web/package.json "engines").
node_exec() {
  if command -v mise >/dev/null 2>&1; then
    mise exec node@22.23.2 -- "$@"
  else
    "$@"
  fi
}

NO_APK=0
NO_RESTART=0
DO_CLEAN=0
FORCE_RESTART=0
PHONE=0
for arg in "$@"; do
  case "$arg" in
  --phone) PHONE=1; NO_APK=1 ;;
  --no-apk) NO_APK=1 ;;
  --no-restart) NO_RESTART=1 ;;
  --force-restart) FORCE_RESTART=1 ;;
  --clean) DO_CLEAN=1 ;;
  *)
    echo "unknown flag: $arg" >&2
    exit 2
    ;;
  esac
done

# Phone mode has no systemd service or laptop HTTPS endpoint. Its WebView
# consumes the local daemon's embedded UI; the existing APK stays installed.
if [ "$PHONE" -eq 1 ]; then
  if [ "$FORCE_RESTART" -eq 1 ]; then
    echo "--phone waits for idle turns; --force-restart is not supported" >&2
    exit 2
  fi
  PULSE_ORIGIN="http://127.0.0.1:7681"
  PULSE_URL="$PULSE_ORIGIN/app/"
  export PULSE_ORIGIN PULSE_URL
else
  pulse_endpoint
fi
export OMP_PULSE_SERVER_URL="$PULSE_URL"
export OMP_PULSE_DEPLOY_PHONE="$PHONE"

# Compute once before any generated output is written. The same value is
# consumed by Vite, Gradle, and build.rs; generated APK/web bytes are excluded
# from the source fingerprint so the identity is not circular.
RELEASE_ID="$(scripts/release/release-id.sh)"
export RELEASE_ID
export OMP_PULSE_RELEASE_ID="$RELEASE_ID"
export VITE_RELEASE_ID="$RELEASE_ID"
echo "→ release id: $RELEASE_ID"

# Protocol numbers come from protocol-version.json, the one source shared with
# build.rs, Gradle and the web build. Read with the same shape checks.
PROTOCOL_METADATA="$(node_exec node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync("protocol-version.json", "utf8"));
  const keys = Object.keys(data).sort();
  const { protocolVersion, minClientProtocolVersion } = data;
  const ok = keys.length === 2 && keys[0] === "minClientProtocolVersion" && keys[1] === "protocolVersion" &&
    Number.isSafeInteger(protocolVersion) && protocolVersion > 0 &&
    Number.isSafeInteger(minClientProtocolVersion) && minClientProtocolVersion > 0 &&
    minClientProtocolVersion <= protocolVersion;
  if (!ok) { console.error("protocol-version.json must contain exactly protocolVersion and minClientProtocolVersion, both positive, minimum <= version"); process.exit(1); }
  process.stdout.write(`${protocolVersion} ${minClientProtocolVersion}`);
')"
read -r PROTOCOL_VERSION MIN_CLIENT_PROTOCOL_VERSION <<<"$PROTOCOL_METADATA"
echo "→ protocol: $PROTOCOL_VERSION (min client $MIN_CLIENT_PROTOCOL_VERSION)"

# ── 1. web build → public/app ────────────────────────────────────────────────
# The independently available PWA uses a relative base for portable hosting.
# --sourcemap false because these files are embedded in the binary: 87 maps,
# the three largest ~1.9 MB each, is not something to compile into a daemon.
if [ -d web ]; then
  echo "→ web build (vite → public/app)"
  # The exported release id is the exact value shared with build.rs and Gradle.
  (cd web && node_exec npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false)
  # Native and offline fallbacks share the endpoint selected above.
  node_exec node -e '
    const fs = require("fs");
    const url = process.env.OMP_PULSE_SERVER_URL;
    const phone = process.env.OMP_PULSE_DEPLOY_PHONE === "1";
    if (!url || !(phone ? url === "http://127.0.0.1:7681/app/" : url.startsWith("https://"))) {
      console.error("refusing invalid release server address");
      process.exit(1);
    }
    const path = "public/app/offline.html";
    if (!fs.existsSync(path)) { console.error("offline.html missing from the web build"); process.exit(1); }
    const out = fs.readFileSync(path, "utf8").replace("__OMP_PULSE_SERVER_URL__", url);
    if (out.includes("__OMP_PULSE_SERVER_URL__")) { console.error("offline.html placeholder not substituted"); process.exit(1); }
    fs.writeFileSync(path, out);
    console.log("  offline fallback configured");
  '
  # No precompression here: these bytes become part of the binary, and the
  # daemon's CompressionLayer negotiates encoding at request time. Writing
  # .gz/.br siblings into public/ would embed every asset twice.
  for f in public/app/assets/index-*.js; do
    [ -f "$f" ] || continue
    printf "  %s: %sB raw → %sB gzip\n" "$(basename "$f")" "$(wc -c <"$f")" "$(gzip -c "$f" | wc -c)"
    break
  done
else
  echo "→ skip web build (no web/ dir)"
fi

# ── 2. copy the same web interface into the Android shell ──────────────────
if [ "$NO_APK" -eq 0 ] && [ -d mobile/android ]; then
  # mobile/node_modules is not committed: install it from the lockfile when it
  # is missing or older than the lock (Gradle builds Capacitor from it).
  [ mobile/node_modules/.package-lock.json -nt mobile/package-lock.json ] ||
    (cd mobile && node_exec npm ci --no-audit --no-fund)
  echo "→ capacitor sync android"
  (cd mobile && node_exec npx cap sync android)
fi

# ── 3. phone-mode runtime daemon → APK jniLibs ──────────────────────────────
# Same web client, cross-built for the phone's Alpine guest. It must exist
# before gradle (the build fails without it) and it never embeds the APK.
# The library lives under app/build/, so `gradle clean` would delete it: --clean
# therefore runs here, BEFORE the library is produced, not with assembleRelease.
if [ "$NO_APK" -eq 0 ] && [ -d mobile/android ]; then
  # `clean` costs 30-60s and wipes incremental state, so it is opt-in: pass
  # --clean after AGP/Gradle bumps, signing or R8 rule changes, or a namespace
  # or compileSdk change. Plain assembleRelease is correct for source edits.
  if [ "$DO_CLEAN" -eq 1 ]; then
    echo "→ gradle clean (JAVA_HOME=21)"
    (cd mobile/android && JAVA_HOME="$JDK" ./gradlew clean)
  fi
  scripts/android/build-runtime.sh
fi

# ── 4. gradle assembleRelease → publish APK + version JSON ───────────────────
if [ "$NO_APK" -eq 0 ] && [ -d mobile/android ]; then
  echo "→ gradle assembleRelease (JAVA_HOME=21)"
  (cd mobile/android && JAVA_HOME="$JDK" ./gradlew assembleRelease)

  APK="mobile/android/app/build/outputs/apk/release/app-release.apk"
  [ -f "$APK" ] || {
    echo "  error: $APK not produced" >&2
    exit 1
  }

  # A debug-signed APK cannot update an installed release-signed one, so an
  # unsigned or debug fallback here would be worse than failing.
  AAPT2="$(find "${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools" -name aapt2 -type f 2>/dev/null | sort -r | head -n1)"
  [ -n "$AAPT2" ] || {
    echo "  error: aapt2 not found" >&2
    exit 1
  }
  BADGING="$("$AAPT2" dump badging "$APK")"
  VERSION_CODE="$(sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" <<<"$BADGING" | head -n1)"
  VERSION_NAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -n1)"
  # Read the version from the ARTEFACT, never from build.gradle: versionCode is
  # computed there (epoch minutes + commit count) and a grep returns the
  # expression, not the value.
  [ -n "$VERSION_CODE" ] || {
    echo "  error: could not read versionCode from APK" >&2
    exit 1
  }
  APK_MANIFEST="$("$AAPT2" dump xmltree "$APK" --file AndroidManifest.xml)"
  if ! grep -Fq "$RELEASE_ID" <<<"$APK_MANIFEST"; then
    echo "  error: APK native metadata release id does not match $RELEASE_ID" >&2
    exit 1
  fi

  # Atomic publish: a half-copied APK served to a phone mid-download is a
  # corrupt install, not a retry.
  cp "$APK" public/.app-release.apk.tmp && mv -f public/.app-release.apk.tmp public/app-release.apk
  APK_SIZE="$(wc -c <public/app-release.apk | tr -d ' ')"
  cat >public/app-release.json <<JSON
{
  "apk": "app-release.apk",
  "releaseId": "$RELEASE_ID",
  "protocolVersion": $PROTOCOL_VERSION,
  "minClientProtocolVersion": $MIN_CLIENT_PROTOCOL_VERSION,
  "capabilities": ["offlineRecovery", "deepLinks", "notifications", "bubbles", "explicitUpdates"],
  "versionCode": $VERSION_CODE,
  "versionName": "$VERSION_NAME",
  "size": $APK_SIZE,
  "buildTime": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "gitSha": "$(git rev-parse --short HEAD 2>/dev/null || echo no-git)"
}
JSON
  printf "  apk: %s bytes (%.2f MB), versionCode %s, %s\n" \
    "$APK_SIZE" "$(awk "BEGIN{print $APK_SIZE/1048576}")" "$VERSION_CODE" "$VERSION_NAME"
else
  # --no-apk is a web-only rebuild. Preserve the last published APK and its
  # honest native release manifest; native and web releases may differ while
  # their protocol and capability contracts remain compatible.
  echo "→ skip apk (--no-apk or no mobile/android); preserving published APK artifact"
fi

# ── 5. cargo build → embed public/ (app + APK + version JSON) ────────────────
echo "→ cargo build --release (embeds public/)"
cargo build --release
printf "  binary: %.1f MB\n" "$(awk "BEGIN{print $(wc -c <target/release/omp-pulse)/1048576}")"
# pulse-restart.sh compares this with the live daemon's releaseId: "built" and
# "live" were indistinguishable before, so a deploy that never restarted looked
# exactly like one that had.
printf '%s\n' "$RELEASE_ID" >target/release/omp-pulse.release-id
printf '%s\n' "$PULSE_URL" >target/release/omp-pulse.server-url

# ── 6. restart + verify ──────────────────────────────────────────────────────
if [ "$NO_RESTART" -eq 1 ]; then
  echo "→ skip restart (--no-restart); build identity is in target/release/omp-pulse.release-id"
  exit 0
fi
if [ "$PHONE" -eq 1 ]; then
  # Keep every deployed binary immutable and outside the replaceable rootfs.
  PHONE_BINARY="$HOME/.local/opt/omp-pulse/omp-pulse-$RELEASE_ID"
  install -Dm755 target/release/omp-pulse "$PHONE_BINARY"
  exec "${OMP_PULSE_PHONE_SWAP:-/root/projects/phone-harness/bin/pulse-swap}" "$PHONE_BINARY"
fi
# Restarting kills every omp child the daemon hosts, so a restart during a live
# turn destroys it (it happened, mid-turn from the phone). pulse-restart.sh
# waits for those turns in a detached unit that survives the restart; see it.
restart_args=()
[ "$FORCE_RESTART" -eq 1 ] && restart_args+=(--force)
exec scripts/deploy/pulse-restart.sh "${restart_args[@]}"
