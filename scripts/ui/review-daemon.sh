#!/usr/bin/env bash
# A long-lived, ISOLATED omp-pulse instance for UI review.
#
# WHY NOT THE DEPLOYED APP: it serves your real conversations. A review
# swarm clicking through every flow will eventually hit Send, Fork, Delete or
# Rename, and there is no undo for any of those. This instance has its own
# port, token, sessions root and state dir, seeded with e2e/lib/ux-fixture.mjs, so
# a reviewer can click anything at all.
#
# It also serves the built client itself at /app/, so no vite is involved:
# whatever `cargo build --release` last embedded is what reviewers see. Build
# the web app and the binary before starting, or you are reviewing a stale UI:
#
#   (cd web && npx vite build --base=./ --outDir ../public/app) && cargo build --release
#
# Runs in the FOREGROUND so a supervisor owns its lifetime.
#
#   scripts/ui/review-daemon.sh            # port 7690, prints BASE and private credential-file path
#   OMP_PULSE_UX_PORT=7691 scripts/ui/review-daemon.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="$ROOT/target/release/omp-pulse"
PORT="${OMP_PULSE_UX_PORT:-7690}"
# Credential is private to this synthetic stage; never print it or a URL containing it.
TOKEN="${OMP_PULSE_UX_TOKEN:-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d '[:space:]')}"

case "$PORT" in
  ''|*[!0-9]*) echo "OMP_PULSE_UX_PORT must be numeric" >&2; exit 2 ;;
esac
if [ "${#PORT}" -gt 5 ]; then echo "isolated port is too long" >&2; exit 2; fi
PORT_NUMBER=$((10#$PORT))
if (( PORT_NUMBER < 1 || PORT_NUMBER > 65535 || PORT_NUMBER == 7682 )); then
  echo "choose an isolated port between 1 and 65535, never live port 7682" >&2
  exit 2
fi
PORT="$PORT_NUMBER"
if [ ! -x "$BIN" ]; then
  echo "build first: cargo build --release (missing $BIN)" >&2
  exit 2
fi
if curl -sf -o /dev/null -m 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
  echo "port $PORT is already serving something; set OMP_PULSE_UX_PORT" >&2
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/omp-pulse-ux-XXXXXX")"
mkdir -p "$TMP/data/omp/sessions" "$TMP/state"
(umask 077; printf '%s' "$TOKEN" > "$TMP/credential")
# Session paths alone do not isolate terminal adoption or Herdr restore state.
unset HERDR_PANE_ID HERDR_SOCKET_PATH HERDR_TAB_ID \
  KITTY_LISTEN_ON KITTY_WINDOW_ID TMUX TMUX_PANE
export HERDR_SESSION="omp-pulse-ux-${TMP##*-}"
export HERDR_CONFIG_PATH="$TMP/herdr.toml"
export OMP_PULSE_STATE_DIR="$TMP/state"
export XDG_CONFIG_HOME="$TMP/config"


PID=""
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$PID" 2>/dev/null; then kill -9 "$PID" 2>/dev/null || true; fi
    wait "$PID" 2>/dev/null || true
  fi
  if command -v herdr >/dev/null 2>&1; then
    herdr session stop "$HERDR_SESSION" >/dev/null 2>&1 || true
    herdr session delete "$HERDR_SESSION" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TMP"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node "$ROOT/e2e/lib/ux-fixture.mjs" "$TMP/data/omp/sessions"

# A synthetic model_usage table, so the picker's recently-used group has data.
# The daemon reads MRU order from `<data>/omp/agent.db`, which is the file omp
# itself writes. Pointing the review stage at your REAL agent.db would
# expose live data to a swarm for no benefit, so seed a throwaway one with the
# same schema (model_usage(model_key TEXT PRIMARY KEY, last_used_at INTEGER),
# read newest-first). Absence is handled by the daemon, so a machine without
# python3 just loses the Recent group rather than breaking the stage.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$TMP/data/omp/agent.db" <<'SEED'
import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE IF NOT EXISTS model_usage (model_key TEXT PRIMARY KEY, last_used_at INTEGER)")
now = int(time.time())
# Newest first in this list; spaced so the ordering is unambiguous.
for i, key in enumerate([
    "anthropic/claude-opus-5",
    "anthropic/claude-3-5-sonnet-20241022",
    "anthropic/claude-3-7-sonnet-20250219",
    "anthropic/claude-3-haiku-20240307",
]):
    db.execute(
        "INSERT OR REPLACE INTO model_usage (model_key, last_used_at) VALUES (?, ?)",
        (key, now - i * 3600),
    )
db.commit()
db.close()
SEED
fi

OMP_REMOTE_PORT="$PORT" \
OMP_REMOTE_HOST="127.0.0.1" \
OMP_REMOTE_TOKEN="$TOKEN" \
OMP_REMOTE_SESSIONS_ROOT="$TMP/data/omp/sessions" \
OMP_REMOTE_STATE_DIR="$TMP/state" \
RUST_LOG="${RUST_LOG:-warn}" \
  "$BIN" >"$TMP/daemon.log" 2>&1 &
PID=$!

ready=0
for _ in $(seq 1 100); do
  kill -0 "$PID" 2>/dev/null || { echo "test daemon exited before readiness" >&2; exit 1; }
  if curl -sf -o /dev/null -m 1 "http://127.0.0.1:$PORT/"; then
    ready=1
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo "isolated UX stage did not become ready" >&2
  exit 1
fi

kill -0 "$PID" 2>/dev/null || { echo "test daemon exited before readiness" >&2; exit 1; }
echo "UX_STAGE_READY"
echo "  base:  http://127.0.0.1:$PORT"
echo "  app:   http://127.0.0.1:$PORT/app/"
echo "  credential file: $TMP/credential"
echo "  log:   $TMP/daemon.log"
wait "$PID"
