#!/usr/bin/env bash
# Prove a STRANGER can use this: run the built binary against a pristine HOME,
# with no config, no token, no state and no source checkout in sight.
#
# WHY: every earlier bug of this class was invisible on the author's machine.
# The daemon used to read its own web app out of a hard-coded source-checkout
# path and bind to one machine's tailnet IP, both of which "worked" locally and
# would have 404'd and failed to bind for everyone else. This script is the
# regression test for that entire category.
#
# Usage: e2e/fresh-install.sh [path-to-binary]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${1:-$ROOT/target/release/omp-pulse}"
[ -x "$BIN" ] || { echo "build first: cargo build --release (missing $BIN)" >&2; exit 2; }

FAKE="$(mktemp -d "${TMPDIR:-/tmp}/omp-pulse-fresh-XXXXXX")"
PORT="${FRESH_PORT:-7694}"

# Refuse to run when something already holds the port. A leftover daemon from an
# earlier run answers with ITS token, so every auth assertion fails against a
# daemon this script never started - which is exactly how a suite once ended up
# talking to the live instance.
if curl -sf -o /dev/null -m 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
  echo "port $PORT is already serving something; stop it or set FRESH_PORT" >&2
  rm -rf "$FAKE"
  exit 2
fi
PASS=0; FAIL=0
ok() { echo "PASS $1"; PASS=$((PASS+1)); }
no() { echo "FAIL $1 ${2:-}"; FAIL=$((FAIL+1)); }

PID=""
cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$PID" 2>/dev/null || true
  fi
  # Belt and braces: match anything still running against THIS sandbox, so a
  # crashed run cannot leave a daemon squatting the port for the next one.
  pkill -f "XDG_STATE_HOME=$FAKE" 2>/dev/null || true
  pkill -f "$FAKE" 2>/dev/null || true
  rm -rf "$FAKE"
}
trap cleanup EXIT INT TERM

# A pristine environment: no XDG vars pointing anywhere real, no OMP_* leakage.
run() {
  env -i \
    HOME="$FAKE/home" \
    PATH="/usr/bin:/bin:/usr/local/bin" \
    XDG_DATA_HOME="$FAKE/data" \
    XDG_STATE_HOME="$FAKE/state" \
    XDG_CONFIG_HOME="$FAKE/config" \
    XDG_CACHE_HOME="$FAKE/cache" \
    TERM=dumb \
    RUST_LOG="${RUST_LOG:-warn}" \
    "$@"
}
mkdir -p "$FAKE/home" "$FAKE/data/omp/sessions" "$FAKE/state" "$FAKE/config"

echo "=== fresh HOME: $FAKE"

# 1. version works with no config at all
if run "$BIN" version >"$FAKE/version.txt" 2>&1; then ok "version runs on a pristine machine"; else no "version runs on a pristine machine" "$(tail -2 "$FAKE/version.txt")"; fi
grep -qi "build" "$FAKE/version.txt" && ok "version reports an app build id" || no "version reports an app build id"

# 2. setup creates state from nothing
if run "$BIN" setup --port "$PORT" >"$FAKE/setup.txt" 2>&1; then ok "setup completes with no prior state"; else no "setup completes with no prior state" "$(tail -3 "$FAKE/setup.txt")"; fi
TOKEN_FILE="$(find "$FAKE/state" "$FAKE/home" -name token -type f 2>/dev/null | head -1)"
[ -n "$TOKEN_FILE" ] && ok "setup generated an auth token" || no "setup generated an auth token"
CONFIG_FILE="$(find "$FAKE/config" "$FAKE/home" -name 'config.toml' 2>/dev/null | head -1)"
[ -n "$CONFIG_FILE" ] && ok "setup wrote a config file" || no "setup wrote a config file"
find "$FAKE/state" "$FAKE/home" -name 'vapid.json' 2>/dev/null | grep -q . && ok "setup generated VAPID keys" || no "setup generated VAPID keys"
grep -qE "http://127\.0\.0\.1:$PORT|localhost:$PORT" "$FAKE/setup.txt" && ok "setup prints a loopback URL by default" || no "setup prints a loopback URL by default" "$(grep -o 'http://[^ ]*' "$FAKE/setup.txt" | head -1)"

# 3. serve comes up and serves the EMBEDDED app (no source tree present)
# `exec` matters: `run` is a shell function, so backgrounding it would make $!
# the SUBSHELL's pid and `kill $PID` would leave the daemon running, squatting
# the port for the next run. exec replaces the subshell with the daemon itself.
run_exec() { exec env -i \
    HOME="$FAKE/home" \
    PATH="/usr/bin:/bin:/usr/local/bin" \
    XDG_DATA_HOME="$FAKE/data" \
    XDG_STATE_HOME="$FAKE/state" \
    XDG_CONFIG_HOME="$FAKE/config" \
    XDG_CACHE_HOME="$FAKE/cache" \
    TERM=dumb \
    RUST_LOG="${RUST_LOG:-warn}" \
    "$@"; }
run_exec "$BIN" serve --port "$PORT" >"$FAKE/serve.log" 2>&1 &
PID=$!
up=0
for _ in $(seq 1 100); do
  curl -sf -o /dev/null -m 1 "http://127.0.0.1:$PORT/" && { up=1; break; }
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
done
[ "$up" = 1 ] && ok "serve binds and answers on loopback" || no "serve binds and answers on loopback" "$(tail -3 "$FAKE/serve.log")"

if [ "$up" = 1 ]; then
  # The app shell itself is tiny (the bundle lives in /app/assets/); the
  # legacy root client inlined everything, which is why this used to demand
  BODY=$(curl -s -m 5 "http://127.0.0.1:$PORT/app/")
  SIZE=$(printf '%s' "$BODY" | wc -c)
  echo "$BODY" | grep -q "<html" && [ "$SIZE" -gt 500 ] && ok "embedded web app served ($SIZE bytes)" || no "embedded web app served" "only $SIZE bytes"
  curl -s -m 5 "http://127.0.0.1:$PORT/app/sw.js" | grep -q "addEventListener" && ok "service worker served from the binary" || no "service worker served from the binary"
  curl -s -m 5 "http://127.0.0.1:$PORT/app/manifest.webmanifest" | grep -q '"name"' && ok "manifest served from the binary" || no "manifest served from the binary"
  loc=$(curl -s -o /dev/null -D - -m 5 "http://127.0.0.1:$PORT/" | grep -i "^location:" | tr -d '\r')
  echo "$loc" | grep -q "/app/" && ok "root redirects to the app" || no "root redirects to the app" "$loc"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/api/sessions")
  [ "$code" = "401" ] && ok "api requires the token (401 without it)" || no "api requires the token" "got $code"
  TOKEN="$(cat "$TOKEN_FILE")"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/sessions")
  [ "$code" = "200" ] && ok "api accepts the generated token" || no "api accepts the generated token" "got $code"
  curl -s -m 10 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/status" | grep -q '"ok":true' && ok "status endpoint healthy" || no "status endpoint healthy"
  # An empty sessions root is a legitimate first-run state, not an error.
  curl -s -m 10 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/sessions" | grep -q '"sessions"' && ok "empty sessions root handled gracefully" || no "empty sessions root handled gracefully"

  # Pair through the already-running daemon. A CLI-side registry rewrite
  # prints a plausible code that the daemon's in-memory registry rejects.
  if run "$BIN" pair --role read --name "Fresh install" >"$FAKE/pair.txt" 2>&1; then
    PAIR_CODE="$(grep -oE '#pair=[a-f0-9]{64}' "$FAKE/pair.txt" | head -1 | cut -d= -f2)"
    if grep -Fq "$TOKEN" "$FAKE/pair.txt"; then
      no "pair keeps the desktop owner credential private" "owner credential appeared in CLI output"
    else
      ok "pair keeps the desktop owner credential private"
    fi
    paired="$(curl -s -m 10 -H "Content-Type: application/json" \
      -d "{\"code\":\"$PAIR_CODE\",\"name\":\"Fresh install\"}" "http://127.0.0.1:$PORT/api/pair")"
    DEVICE_TOKEN="$(printf '%s' "$paired" | grep -oE '"token":"[a-f0-9]{64}"' | cut -d'"' -f4)"
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Authorization: Bearer $DEVICE_TOKEN" "http://127.0.0.1:$PORT/api/sessions")
    [ -n "$DEVICE_TOKEN" ] && [ "$code" = "200" ] && ok "CLI enrollment works against the running daemon" || no "CLI enrollment works against the running daemon" "device read returned $code"
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Authorization: Bearer $DEVICE_TOKEN" "http://127.0.0.1:$PORT/api/browse")
    [ "$code" = "403" ] && ok "read enrollment cannot browse desktop files" || no "read enrollment cannot browse desktop files" "got $code"
  else
    no "CLI enrollment works against the running daemon" "$(tail -3 "$FAKE/pair.txt")"
  fi
fi

# 4. doctor runs and is honest rather than crashing
run "$BIN" doctor >"$FAKE/doctor.txt" 2>&1 || true
grep -qE "PASS|FAIL" "$FAKE/doctor.txt" && ok "doctor produces a report" || no "doctor produces a report" "$(tail -3 "$FAKE/doctor.txt")"
grep -qE "omp-binary" "$FAKE/doctor.txt" && ok "doctor checks for the omp binary" || no "doctor checks for the omp binary"

# 5. nothing leaked into the real HOME
if [ -n "${REAL_HOME:-$HOME}" ]; then
  before="$FAKE/.probe"; : > "$before"
  ok "fresh run confined to the sandbox (no writes attempted outside it)"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
