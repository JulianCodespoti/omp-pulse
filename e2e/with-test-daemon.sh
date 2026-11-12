#!/usr/bin/env bash
# Run a command against an ISOLATED omp-pulse instance.
#
# WHY: the suites used to point at the live daemon on 7682 — the one serving the
# user's phone. That bit hard: a fixture session in ~/.omp got attached to a real
# conversation's collab room, and four test prompts were delivered into that
# conversation. Tests must not be able to reach anything real.
#
# This instance gets its own port, token, sessions root and state directory, so:
#   * `/api/sessions` sees only sessions this run creates (OMP_REMOTE_SESSIONS_ROOT;
#     XDG_DATA_HOME must stay real or omp's native addon fails to load);
#   * the collab link registry, push store and VAPID keys are throwaway;
#   * terminal adoption can never match a pane: no real conversation's text
#     exists in this instance's sessions, AND the terminal-integration
#     variables are unset below (see the comment there — the sessions root
#     alone was not enough).
#
# Usage:  e2e/with-test-daemon.sh python3 e2e/daemon/pulse-smoke.py
#         e2e/with-test-daemon.sh node e2e/browser/verify-sockets.mjs
#
# Exports OMP_PULSE_TEST_BASE, OMP_PULSE_TEST_WS, OMP_PULSE_TEST_TOKEN,
# OMP_PULSE_TEST_STATE_DIR, OMP_PULSE_TEST_SESSIONS, OMP_PULSE_TEST_TMP,
# OMP_PULSE_TEST_HERDR_SESSION, OMP_PULSE_TEST_DAEMON_PID, HERDR_SESSION,
# HERDR_CONFIG_PATH, OMP_PULSE_STATE_DIR, and a temporary wrapper PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/target/release/omp-pulse"
PORT="${OMP_PULSE_TEST_PORT:-7699}"

case "$PORT" in
'' | *[!0-9]*)
  echo "OMP_PULSE_TEST_PORT must be a numeric isolated port" >&2
  exit 2
  ;;
esac
PORT_NUMBER=$((10#$PORT))
if ((PORT_NUMBER == 7682)); then
  echo "refusing reserved live daemon port 7682; choose an isolated test port" >&2
  exit 2
fi
if ((PORT_NUMBER < 1 || PORT_NUMBER > 65535)); then
  echo "OMP_PULSE_TEST_PORT must be between 1 and 65535" >&2
  exit 2
fi
PORT="$PORT_NUMBER"
if [ ! -x "$BIN" ]; then
  echo "build first: cargo build --release (missing $BIN)" >&2
  exit 2
fi
if curl -sf -o /dev/null -m 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
  echo "port $PORT is already serving something; set OMP_PULSE_TEST_PORT" >&2
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/omp-pulse-test-XXXXXX")"
TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n')"
mkdir -p "$TMP/data/omp/sessions" "$TMP/state" "$TMP/handoff-bin"
export HERDR_CONFIG_PATH="$TMP/herdr.toml"
export OMP_PULSE_STATE_DIR="$TMP/state"
# Plugins live under the CONFIG directory, which this harness leaves real. Point
# them at the scratch tree, or a test daemon would serve the developer's own
# plugins and run their host commands.
export OMP_PULSE_PLUGINS_DIR="$TMP/plugins"
# The agent directory stays real too (omp's sign-ins live there). Without this a
# test daemon refreshes the developer's installed pulse-plugin skill with this
# checkout's copy on every start.
export OMP_PULSE_SKIP_SKILL_REFRESH=1
export PATH="$TMP/handoff-bin:$PATH"

# The runtime directory is where omp hosts publish collab announcements
# ($XDG_RUNTIME_DIR/omp/collab). A suite that tests announcements writes one
# there; with the developer's real directory it would land beside their live
# hosts. Every suite gets a private one instead.
mkdir -m 700 "$TMP/runtime"
export XDG_RUNTIME_DIR="$TMP/runtime"

# Terminal identity must not survive into the daemon or anything it spawns.
#
# A fixture that fakes a session owner (an `exec -a …/omp` holder with the
# session file open) inherits THIS process's environment. Under herdr the agent
# runs inside a pane, so `HERDR_PANE_ID` named the developer's own pane; the
# daemon resolves an owner's pane from /proc/<pid>/environ, found that pane, and
# — because an owner-resolved pane deliberately BYPASSES the content
# fingerprint — typed `/collab` into the live conversation and then forwarded
# the fixture's prompt into it as a guest on the live relay. Measured
# 2026-09-14: the run's test prompt arrived in the session the agent was working
# in, and the pane's conversation was made to share a room it never asked for.
#
# The sessions root does not cover this: nothing here is a session path, it is
# pane identity. Unset it for the daemon and for the command under test.
unset HERDR_PANE_ID HERDR_SOCKET_PATH HERDR_TAB_ID \
  KITTY_LISTEN_ON KITTY_WINDOW_ID TMUX TMUX_PANE

# Herdr server identity and configuration must be throwaway as well. Unsetting
# HERDR_SOCKET_PATH alone made every call fall back to the developer's default
# server/config. This harness provides a named session and a config path inside
# TMP; tests may start Herdr explicitly or let the isolated daemon autostart it.
# The temporary PATH prefix lets that auto-start inherit each suite's omp test
# wrapper, which is created before any autostart scenario.
#
# NEVER isolate with HERDR_SOCKET_PATH alone: a `herdr server` started that way
# still restores ~/.config/herdr/session.json, relaunches `omp --resume` in
# every restored pane (a second writer on each of the developer's live
# sessions) and overwrites that file on exit. Measured 2026-09-25.
export HERDR_SESSION="omp-pulse-test-${TMP##*-}"

# Tern is isolated the same way: clear pane/window identity (Tern routes by
# inherited TERN_PANE / TERN_WINDOW_KEY) and point config AND daemon socket at
# private paths. Unsetting the socket alone falls back to the developer's real
# daemon. Nothing is started here; with empty private paths Tern CLI calls fail
# rather than reach real state.
unset TERN_PANE TERN_PANE_SOCKET TERN_WINDOW_KEY TERN_WINDOW_SOCKET \
  TERN_IDENTITY TERN_ACP TERN_COMPLETE TERN_PROMPT_ENV TERN_PROMPT_FILE \
  TERN_BLOB_DIR TERN_LENSES TERN_EXE
mkdir -p "$TMP/tern"
export TERN_CONFIG_DIR="$TMP/tern"
export TERN_DAEMON_SOCKET="$TMP/tern/daemon.sock"

PID=""
cleanup() {
  local code=$?
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$PID" 2>/dev/null || true
  fi
  # Keep the log when the run failed — it is the only record of why.
  if [ "$code" -ne 0 ] && [ -f "$TMP/daemon.log" ]; then
    echo "--- test daemon log (tail) ---" >&2
    tail -30 "$TMP/daemon.log" >&2 || true
  fi
  # A suite that started this run's herdr server normally stops it; a crashed
  # one must not leave it, and the omp TUIs in its panes, running.
  if command -v herdr >/dev/null 2>&1; then
    herdr session stop "$HERDR_SESSION" >/dev/null 2>&1 || true
    herdr session delete "$HERDR_SESSION" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT INT TERM

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
  if curl -sf -o /dev/null -m 1 "http://127.0.0.1:$PORT/"; then
    ready=1
    break
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo "test daemon failed to start on $PORT" >&2
  exit 1
fi

export OMP_PULSE_TEST_BASE="http://127.0.0.1:$PORT"
export OMP_PULSE_TEST_WS="ws://127.0.0.1:$PORT"
export OMP_PULSE_TEST_TOKEN="$TOKEN"
export OMP_PULSE_TEST_STATE_DIR="$TMP/state"
export OMP_PULSE_TEST_SESSIONS="$TMP/data/omp/sessions"
export OMP_PULSE_TEST_TMP="$TMP"
export OMP_PULSE_TEST_HERDR_SESSION="$HERDR_SESSION"
export OMP_PULSE_TEST_DAEMON_PID="$PID"

"$@"
