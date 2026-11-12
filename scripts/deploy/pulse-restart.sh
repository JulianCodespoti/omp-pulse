#!/usr/bin/env bash
set -euo pipefail
# pulse-restart: put the built daemon live, safely, from anywhere. Rerunnable.
#
#   scripts/deploy/pulse-restart.sh            hand the restart to a detached waiter and
#                                       report what happened (default)
#   scripts/deploy/pulse-restart.sh --status   is a restart pending, what is it waiting
#                                       on, and is the built release live yet?
#   scripts/deploy/pulse-restart.sh --cancel   drop a pending restart
#   scripts/deploy/pulse-restart.sh --force    restart now, killing daemon-hosted turns
#
# `scripts/deploy/pulse-deploy.sh` ends by calling this; run it on its own after a
# `--no-restart` build.
#
# WHY a detached waiter. A restart kills every omp child the daemon hosts, so it
# must wait until none is mid-turn. The old inline wait failed two ways:
#   * an agent deploying from a phone-hosted conversation IS a live turn, and
#     its shell is in the daemon's cgroup: the wait waited on itself, and a
#     restart would have killed the deploy before it verified anything;
#   * it gave up after 5 minutes. A long daemon-hosted turn elsewhere (a
#     boggle-unhinged run, 2026-09-25) made every deploy exit "not restarting",
#     and the new build never went live while it looked deployed.
# So the wait runs as a transient user unit outside the daemon's process tree,
# with no deadline by default. It survives the restart it performs, and a new
# run replaces a pending one, so rerunning is always safe.
#
# It waits only on turns a restart actually kills: `/api/status.busyChildren`,
# the daemon's own children mid-turn. Desktop-bridged and terminal turns run in
# their own omp processes and survive. A daemon missing or malforming that field
# is refused; absence is never treated as evidence that restart is safe.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

STATE="$HOME/.local/state/omp-pulse"
LOG="$STATE/logs/restart.log"
UNIT="omp-pulse-restart"
BUILT_ID_FILE="$ROOT/target/release/omp-pulse.release-id"
BUILT_URL_FILE="$ROOT/target/release/omp-pulse.server-url"
BUILT_EXE="$ROOT/target/release/omp-pulse"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

MODE=launch
FORCE=0
MAX_WAIT=0 # seconds; 0 = wait as long as it takes
while [ $# -gt 0 ]; do
  case "$1" in
  --status) MODE=status ;;
  --cancel) MODE=cancel ;;
  --force) FORCE=1 ;;
  --max-wait)
    [ $# -ge 2 ] || { echo "--max-wait requires seconds" >&2; exit 2; }
    MAX_WAIT="$2"
    shift
    ;;
  --run) MODE=run ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# The waiter is always a user transient unit, even when it restarts a system
# service. Cancellation deliberately precedes target/endpoint discovery.
if [ "$MODE" = cancel ]; then
  systemctl --user stop "$UNIT" 2>/dev/null && echo "pending restart cancelled" || echo "nothing pending"
  exit 0
fi

source "$ROOT/scripts/deploy/pulse-target.sh"
if ! pulse_target; then
  echo "could not resolve exactly one active omp-pulse service" >&2
  exit 1
fi
if [ "$MODE" != status ] && ! pulse_endpoint; then
  echo "could not resolve phone endpoint" >&2
  exit 1
fi

token() { cat "$STATE/token" 2>/dev/null || true; }
api() { curl -fsS --max-time 5 -H "Authorization: Bearer $(token)" "$PULSE_LOCAL$1"; }
live_release() {
  api /api/version | jq -er '.releaseId | select(type == "string" and length > 0)' 2>/dev/null
}
phone_live_release() {
  pulse_curl -fsS --max-time 10 -H "Authorization: Bearer $(token)" "$PULSE_ORIGIN/api/version" |
    jq -er '.releaseId | select(type == "string" and length > 0)' 2>/dev/null
}
built_release() { cat "$BUILT_ID_FILE" 2>/dev/null || true; }
built_endpoint() { cat "$BUILT_URL_FILE" 2>/dev/null || true; }
unit_active() { systemctl --user is-active --quiet "$UNIT" 2>/dev/null; }

require_built_release() {
  local id
  id="$(built_release)"
  if [[ ! "$id" =~ ^[A-Za-z0-9._+-]+$ ]]; then
    echo "built release identity is missing or malformed; refusing restart" >&2
    return 1
  fi
  printf '%s' "$id"
}
require_build_endpoint() {
  local expected
  expected="$(built_endpoint)"
  if [ -z "$expected" ] || [[ "$expected" == *$'\n'* ]] || [ "$expected" != "$PULSE_URL" ]; then
    echo "built phone endpoint differs from selected HTTPS endpoint; rebuild or select the matching endpoint" >&2
    return 1
  fi
}
file_hash() { sha256sum -- "$1" | cut -d ' ' -f 1; }
require_built_executable() {
  if [ -L "$BUILT_EXE" ] || [ ! -f "$BUILT_EXE" ] || [ ! -x "$BUILT_EXE" ]; then
    echo "built executable is missing, unsafe, or not executable: $BUILT_EXE" >&2
    return 1
  fi
}

# Fail closed unless the daemon explicitly reports the complete list of busy
# daemon-hosted turns. Missing fields, malformed JSON, and transport failures
# are not evidence that it is safe to restart.
busy_turns() {
  local status valid
  status="$(api /api/status)" || { echo "could not read daemon busy telemetry" >&2; return 1; }
  valid="$(printf '%s' "$status" | jq -e '
    type == "object" and (.busyChildren | type == "array") and
    all(.busyChildren[]; type == "string" and length > 0)
  ' 2>/dev/null)" || { echo "daemon busy telemetry is missing or malformed" >&2; return 1; }
  [ "$valid" = true ] || { echo "daemon busy telemetry is missing or malformed" >&2; return 1; }
  printf '%s' "$status" | jq -r '.busyChildren[]'
}

safe_service_target() {
  local path="$PULSE_EXE" current part parent owner
  local -a parts=()
  if [[ "$path" != /* ]] || [ -L "$path" ] || [ ! -f "$path" ] || [ ! -x "$path" ] || [ ! -w "$path" ]; then
    echo "unsafe or non-writable service executable: $path" >&2
    return 1
  fi
  IFS='/' read -r -a parts <<<"$path"
  current=""
  for part in "${parts[@]}"; do
    [ -n "$part" ] || continue
    if [[ "$part" == . || "$part" == .. ]]; then
      echo "service executable path contains an unsafe component: $path" >&2
      return 1
    fi
    current="$current/$part"
    if [ "$current" != "$path" ] && { [ -L "$current" ] || [ ! -d "$current" ]; }; then
      echo "service executable has an unsafe parent path: $current" >&2
      return 1
    fi
  done
  parent="$(dirname -- "$path")"
  if [ ! -w "$parent" ]; then
    echo "service executable directory is not writable: $parent" >&2
    return 1
  fi
  owner="$(stat -c '%u' -- "$path")" || return 1
  if [ "$owner" != "$(id -u)" ]; then
    echo "refusing to replace service executable owned by uid $owner: $path" >&2
    return 1
  fi
}

install_built_binary() {
  local target_dir temporary
  safe_service_target || return 1
  require_built_executable || return 1
  if [ "$PULSE_EXE" = "$BUILT_EXE" ] || [ "$INITIAL_TARGET_HASH" = "$INITIAL_BUILD_HASH" ]; then
    echo "service executable already matches the built binary; skipping replacement"
    return 0
  fi
  target_dir="$(dirname -- "$PULSE_EXE")"
  temporary="$(mktemp "$target_dir/.omp-pulse.XXXXXX")" || return 1
  # `stat -c %a` instead of `chmod --reference`: BusyBox (Alpine) has no --reference.
  if ! cp -- "$BUILT_EXE" "$temporary" || ! chmod "$(stat -c %a -- "$PULSE_EXE")" "$temporary" || ! mv -f -- "$temporary" "$PULSE_EXE"; then
    rm -f -- "$temporary"
    echo "could not atomically install the built service executable" >&2
    return 1
  fi
}

revalidate_before_cutover() {
  local current_id current_endpoint current_build_hash current_target_hash
  pulse_target || { echo "active service target changed or became ambiguous while waiting" >&2; return 1; }
  if [ "$PULSE_SCOPE" != "$INITIAL_SCOPE" ] || [ "$PULSE_UNIT" != "$INITIAL_UNIT" ] ||
     [ "$PULSE_EXE" != "$INITIAL_EXE" ] || [ "$PULSE_PORT" != "$INITIAL_PORT" ] ||
     [ "$PULSE_LOCAL" != "$INITIAL_LOCAL" ]; then
    echo "active service target changed while waiting; refusing cutover" >&2
    return 1
  fi
  pulse_endpoint || { echo "phone endpoint became unavailable while waiting" >&2; return 1; }
  require_build_endpoint || return 1
  current_id="$(require_built_release)" || return 1
  current_endpoint="$(built_endpoint)"
  current_build_hash="$(file_hash "$BUILT_EXE")" || return 1
  current_target_hash="$(file_hash "$PULSE_EXE")" || return 1
  if [ "$current_id" != "$WANT" ] || [ "$current_endpoint" != "$INITIAL_BUILD_ENDPOINT" ] ||
     [ "$current_build_hash" != "$INITIAL_BUILD_HASH" ] || [ "$current_target_hash" != "$INITIAL_TARGET_HASH" ]; then
    echo "service target or built release identity changed while waiting; refusing cutover" >&2
    return 1
  fi
}

# ── the detached waiter ──────────────────────────────────────────────────────
if [ "$MODE" = run ]; then
  WANT="$(require_built_release)" || exit 1
  require_build_endpoint || exit 1
  require_built_executable || exit 1
  safe_service_target || exit 1
  INITIAL_SCOPE="$PULSE_SCOPE"
  INITIAL_UNIT="$PULSE_UNIT"
  INITIAL_EXE="$PULSE_EXE"
  INITIAL_PORT="$PULSE_PORT"
  INITIAL_LOCAL="$PULSE_LOCAL"
  INITIAL_BUILD_ENDPOINT="$(built_endpoint)"
  INITIAL_BUILD_HASH="$(file_hash "$BUILT_EXE")" || exit 1
  INITIAL_TARGET_HASH="$(file_hash "$PULSE_EXE")" || exit 1
  printf '[%s] restart requested; built release %s, live %s (%s service)\n' "$(date +%T)" "$WANT" "$(live_release || true)" "$PULSE_SCOPE"
  if ! busy="$(busy_turns)"; then
    echo "RESULT failed: busy telemetry unavailable; nothing restarted"
    exit 1
  fi
  if [ "$FORCE" -eq 0 ]; then
    started=$(date +%s)
    last=""
    while [ -n "$busy" ]; do
      if [ "$busy" != "$last" ]; then
        echo "[$(date +%T)] waiting for daemon-hosted turn(s) to finish:"
        printf '%s\n' "$busy" | sed 's#^.*/sessions/#    #'
        last="$busy"
      fi
      if [ "$MAX_WAIT" -gt 0 ] && [ $(($(date +%s) - started)) -ge "$MAX_WAIT" ]; then
        echo "RESULT gave-up: turns still live after ${MAX_WAIT}s; nothing restarted"
        exit 2
      fi
      sleep 5
      if ! busy="$(busy_turns)"; then
        echo "RESULT failed: busy telemetry unavailable; nothing restarted"
        exit 1
      fi
    done
  fi
  revalidate_before_cutover || exit 1
  install_built_binary || exit 1
  echo "[$(date +%T)] restarting $PULSE_SCOPE service $PULSE_UNIT (executable $PULSE_EXE)"
  if [ "$PULSE_SCOPE" = system ]; then
    sudo -n systemctl --system restart "$PULSE_UNIT"
  else
    systemctl --user restart "$PULSE_UNIT"
  fi

  got=""
  for _ in $(seq 1 60); do
    got="$(live_release || true)"
    [ "$got" = "$WANT" ] && break
    sleep 1
  done
  fail=0
  if [ -z "$got" ] || [ "$got" != "$WANT" ]; then
    echo "  FAIL local release ${got:-<missing>}, built $WANT"
    fail=1
  else
    echo "  ok   local release $got"
  fi
  phone_release="$(phone_live_release || true)"
  if [ -z "$phone_release" ] || [ "$phone_release" != "$WANT" ]; then
    echo "  FAIL phone endpoint release ${phone_release:-<missing>}, built $WANT"
    fail=1
  else
    echo "  ok   phone endpoint release $phone_release"
  fi
  check() {
    local probe got_status got_type
    probe="$(pulse_curl -s --max-time 10 -o /dev/null -w '%{http_code} %{content_type}' "$PULSE_ORIGIN$1" || true)"
    got_status="${probe%% *}"
    got_type="${probe#* }"
    if [ "$got_status" != "$2" ] || [[ "$got_type" != *"$3"* ]]; then
      echo "  FAIL $1 → $got_status $got_type (want $2 $3)"
      fail=1
    else
      echo "  ok   $1 → $got_status $got_type"
    fi
  }
  check /app/ 200 text/html
  check /app/sw.js 200 text/javascript
  check /app-release.apk 200 application/octet-stream
  check /app-release.json 200 application/json
  BUNDLE="$(pulse_curl -fsS --max-time 10 "$PULSE_URL" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -n1 || true)"
  if [ -n "$BUNDLE" ]; then check "/app/$BUNDLE" 200 text/javascript
  else echo "  FAIL could not find the app bundle in /app/"; fail=1; fi
  if [ "$fail" -eq 0 ]; then
    echo "RESULT ok: release $got live at $PULSE_URL"
  else
    echo "RESULT failed: see checks above"
    exit 1
  fi
  exit 0
fi

# ── status ───────────────────────────────────────────────────────────────────
if [ "$MODE" = status ]; then
  echo "service:       $PULSE_SCOPE $PULSE_UNIT ($PULSE_EXE)"
  echo "built release: $(built_release)"
  echo "live release:  $(live_release || true)"
  if unit_active; then echo "restart:       PENDING"; else echo "restart:       none pending"; fi
  if busy="$(busy_turns)"; then
    if [ -n "$busy" ]; then
      echo "daemon-hosted turns in progress:"
      printf '%s\n' "$busy" | sed 's#^.*/sessions/#    #'
    else echo "daemon-hosted turns: none"; fi
  else
    echo "daemon-hosted turns: unavailable; restart will fail closed"
    exit 1
  fi
  [ -f "$LOG" ] && { echo "--- $LOG"; tail -n 12 "$LOG"; }
  exit 0
fi

# ── launch ───────────────────────────────────────────────────────────────────
require_built_executable || { echo "build first (scripts/deploy/pulse-deploy.sh --no-restart)" >&2; exit 1; }
want="$(require_built_release)" || exit 1
require_build_endpoint || exit 1
if [ "$FORCE" -eq 0 ] && [ "$want" = "$(live_release || true)" ]; then
  if [ "$(phone_live_release || true)" = "$want" ]; then
    echo "release $want is already live locally and at the phone endpoint; nothing to do"
    exit 0
  fi
fi
mkdir -p "$(dirname "$LOG")"
systemctl --user stop "$UNIT" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
: >"$LOG"
args=(--run)
[ "$FORCE" -eq 1 ] && args+=(--force)
[ "$MAX_WAIT" -gt 0 ] && args+=(--max-wait "$MAX_WAIT")
endpoint_env=(--setenv=OMP_PULSE_SERVER_URL="$PULSE_URL")
if [ -n "$PULSE_SERVE_HOST" ]; then endpoint_env+=(--setenv=PULSE_SERVE_HOST="$PULSE_SERVE_HOST"); fi
systemd-run --user --quiet --collect --unit="$UNIT" \
  --working-directory="$ROOT" --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
  "${endpoint_env[@]}" \
  bash -c "exec '$ROOT/scripts/deploy/pulse-restart.sh' ${args[*]} >>'$LOG' 2>&1"

# Follow until it finishes, or report what it is waiting on. If this shell is
# itself a daemon-hosted turn (an agent deploying), the restart ends it here;
# the waiter carries on regardless.
seen=0
for _ in $(seq 1 120); do
  sleep 1
  lines=$(wc -l <"$LOG")
  if [ "$lines" -gt "$seen" ]; then
    sed -n "$((seen + 1)),${lines}p" "$LOG"
    seen=$lines
  fi
  if grep -q '^RESULT ok' "$LOG"; then exit 0; fi
  if grep -q '^RESULT' "$LOG"; then exit 1; fi
  if ! unit_active && ! grep -q '^RESULT' "$LOG"; then
    echo "restart waiter exited without a result; see $LOG" >&2
    exit 1
  fi
  if grep -q 'waiting for daemon-hosted' "$LOG"; then
    echo
    echo "→ restart is queued and will run the moment those turns finish."
    echo "  Check on it: scripts/deploy/pulse-restart.sh --status"
    exit 0
  fi
done
echo "→ still working; check: scripts/deploy/pulse-restart.sh --status"
