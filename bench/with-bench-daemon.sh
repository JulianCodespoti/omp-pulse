#!/usr/bin/env bash
# Run a benchmark against an ISOLATED omp-pulse instance with a realistic corpus.
#
# Same isolation contract as e2e/with-test-daemon.sh (own port, token, sessions
# root, state dir) so a benchmark can never touch a real conversation, plus:
#   * a PERSISTENT synthetic corpus (~4 GB, 3365 sessions) under
#     $HOME/.cache/omp-pulse-bench/corpus, seeded once;
#   * RSS sampling of the daemon every 200 ms into $BENCH_RSS_LOG, with the peak
#     printed on exit — memory numbers are worthless if nobody records them;
#   * the daemon PID exported, so a benchmark can read /proc itself.
#
# Usage:
#   bench/with-bench-daemon.sh python3 bench/wire.py
#   BENCH_PORT=7691 bench/with-bench-daemon.sh python3 bench/lat.py
#   BENCH_FRESH=1 bench/with-bench-daemon.sh ...   # empty corpus (no seed)
#
# Exports: BENCH_BASE, BENCH_WS, BENCH_TOKEN, BENCH_CORPUS, BENCH_STATE,
#          BENCH_PID, BENCH_RSS_LOG, BENCH_TMP.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/target/release/omp-pulse"
PORT="${BENCH_PORT:-7690}"
CACHE="${BENCH_CACHE:-$HOME/.cache/omp-pulse-bench}"
CORPUS="${BENCH_CORPUS:-$CACHE/corpus}"
FILES="${BENCH_FILES:-3365}"
DIRS="${BENCH_DIRS:-60}"

[ -x "$BIN" ] || { echo "build first: cargo build --release (missing $BIN)" >&2; exit 2; }
if curl -sf -o /dev/null -m 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
  echo "port $PORT is already serving something; set BENCH_PORT" >&2
  exit 2
fi

if [ "${BENCH_FRESH:-0}" = "1" ]; then
  CORPUS="$(mktemp -d "${TMPDIR:-/tmp}/omp-pulse-bench-fresh-XXXXXX")/sessions"
  mkdir -p "$CORPUS"
else
  mkdir -p "$CORPUS"
  python3 "$ROOT/bench/seed-corpus.py" --root "$CORPUS" --files "$FILES" --dirs "$DIRS" >&2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/omp-pulse-bench-XXXXXX")"
TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
mkdir -p "$TMP/state"
RSS_LOG="$TMP/rss.tsv"

PID=""; SAMPLER=""
cleanup() {
  local code=$?
  [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null || true
  if [ -s "$RSS_LOG" ]; then
    awk -F'\t' 'NR==1{min=$2} {n++; s+=$2; if($2>max)max=$2; if($2<min)min=$2}
      END{if(n)printf "daemon RSS: start %.1f MB, peak %.1f MB, mean %.1f MB, %d samples\n", min/1024, max/1024, s/n/1024, n}' "$RSS_LOG" >&2
  fi
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$PID" 2>/dev/null || true
  fi
  pkill -f "omp --mode rpc-ui --cwd /tmp/pulse-bench" 2>/dev/null || true
  if [ "$code" -ne 0 ] && [ -f "$TMP/daemon.log" ]; then
    echo "--- bench daemon log (tail) ---" >&2; tail -30 "$TMP/daemon.log" >&2 || true
  fi
  [ "${BENCH_KEEP:-0}" = "1" ] || rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT INT TERM

OMP_REMOTE_PORT="$PORT" \
OMP_REMOTE_HOST="127.0.0.1" \
OMP_REMOTE_TOKEN="$TOKEN" \
OMP_REMOTE_SESSIONS_ROOT="$CORPUS" \
OMP_REMOTE_STATE_DIR="$TMP/state" \
OMP_PULSE_PLUGINS_DIR="$TMP/plugins" \
OMP_PULSE_SKIP_SKILL_REFRESH=1 \
RUST_LOG="${RUST_LOG:-warn}" \
  "$BIN" >"$TMP/daemon.log" 2>&1 &
PID=$!

for _ in $(seq 1 200); do
  curl -sf -o /dev/null -m 1 "http://127.0.0.1:$PORT/" && break
  kill -0 "$PID" 2>/dev/null || { echo "bench daemon died on startup" >&2; exit 1; }
  sleep 0.1
done

# RSS sampler: 200 ms cadence, cheap, and the only record of memory behaviour.
( while kill -0 "$PID" 2>/dev/null; do
    printf '%s\t%s\n' "$(date +%s.%N)" "$(awk '/VmRSS/{print $2}' /proc/$PID/status 2>/dev/null || echo 0)" >>"$RSS_LOG"
    sleep 0.2
  done ) &
SAMPLER=$!

export BENCH_BASE="http://127.0.0.1:$PORT"
export BENCH_WS="ws://127.0.0.1:$PORT"
export BENCH_TOKEN="$TOKEN"
export BENCH_CORPUS="$CORPUS"
export BENCH_STATE="$TMP/state"
export BENCH_PID="$PID"
export BENCH_RSS_LOG="$RSS_LOG"
export BENCH_TMP="$TMP"

"$@"
