#!/usr/bin/env bash
# Verify target selection, idle waiting, and binary cutover using sandbox commands.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/scripts/deploy" "$fixture/target/release" "$fixture/bin" "$fixture/home/.local/state/omp-pulse/logs"
cp "$root/scripts/deploy/pulse-target.sh" "$root/scripts/deploy/pulse-restart.sh" "$fixture/scripts/deploy/"
printf 'old service binary\n' >"$fixture/installed"
printf 'new built binary\n' >"$fixture/target/release/omp-pulse"
chmod 755 "$fixture/installed" "$fixture/target/release/omp-pulse"
printf 'release-new\n' >"$fixture/target/release/omp-pulse.release-id"
printf 'https://phone.test.ts.net/app/\n' >"$fixture/target/release/omp-pulse.server-url"
printf 'fixture-token\n' >"$fixture/home/.local/state/omp-pulse/token"
export PULSE_TEST_ROOT="$fixture" PULSE_TEST_EXE="$fixture/installed" PULSE_TEST_PORT=7681
export HOME="$fixture/home" PATH="$fixture/bin:$PATH"
unset OMP_PULSE_SERVER_URL OMP_PULSE_FUNNEL PULSE_SERVE_HOST || true

cat >"$fixture/bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
scope=system
if [[ ${1:-} == --user ]]; then scope=user; shift; elif [[ ${1:-} == --system ]]; then shift; fi
action=${1:-}; shift || true
case "$action $*" in
  'is-active --quiet omp-pulse.service')
    if [[ $scope == user ]]; then active=${PULSE_TEST_USER_ACTIVE:-0}
    else active=${PULSE_TEST_SYSTEM_ACTIVE:-1}; fi
    [[ $active == 1 ]] && exit 0 || exit 3 ;;
  'show omp-pulse.service --property=ExecStart --value')
    printf 'path=%s ; argv[]=%s serve --bind 127.0.0.1 --port %s ;\n' "$PULSE_TEST_EXE" "$PULSE_TEST_EXE" "$PULSE_TEST_PORT" ;;
  'restart omp-pulse.service')
    [[ $scope == "${PULSE_TEST_EXPECT_SCOPE:-system}" ]] || { echo "wrong restart scope: $scope" >&2; exit 1; }
    [[ ${PULSE_TEST_EXPECT_RESTART:-1} == 1 ]] || { echo 'unexpected service restart' >&2; exit 1; }
    if [[ $PULSE_TEST_EXE != "$PULSE_TEST_ROOT/target/release/omp-pulse" ]]; then
      cmp "$PULSE_TEST_EXE" "$PULSE_TEST_ROOT/target/release/omp-pulse"
    fi
    touch "$PULSE_TEST_ROOT/restarted" ;;
  'stop omp-pulse-restart')
    rm -f "$PULSE_TEST_ROOT/waiter-active"
    touch "$PULSE_TEST_ROOT/cancelled" ;;
  'reset-failed omp-pulse-restart') : ;;
  'is-active --quiet omp-pulse-restart') [[ -e $PULSE_TEST_ROOT/waiter-active ]] ;;
  *) echo "unexpected sandbox systemctl call ($scope): $action $*" >&2; exit 1 ;;
esac
SH

# Never permit the fixture to invoke the host escalation path. Model the exact
# noninteractive system restart while keeping systemctl inside this sandbox.
cat >"$fixture/bin/sudo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "-n systemctl --system restart omp-pulse.service" ]] || exit 1
exec "$PULSE_TEST_ROOT/bin/systemctl" --system restart omp-pulse.service
SH

cat >"$fixture/bin/systemd-run" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ " $* " == *' --user '* && " $* " == *' --unit=omp-pulse-restart '* ]] || { echo "unsafe systemd-run request: $*" >&2; exit 1; }
[[ " $* " == *"--setenv=OMP_PULSE_SERVER_URL=https://phone.test.ts.net"* ]] || { echo 'detached waiter did not receive selected endpoint' >&2; exit 1; }
[[ " $* " == *"--setenv=PULSE_SERVE_HOST=phone.test.ts.net"* ]] || { echo 'detached waiter did not preserve Serve host' >&2; exit 1; }
touch "$PULSE_TEST_ROOT/waiter-active"
printf '[fixture] waiter queued\nwaiting for daemon-hosted turn(s) to finish:\n' >"$HOME/.local/state/omp-pulse/logs/restart.log"
SH

cat >"$fixture/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ ${PULSE_TEST_CANCEL_ONLY:-0} != 1 ]] || { echo 'curl used during cancellation' >&2; exit 1; }
args=" $* "
url=${!#}
if [[ $url == https://phone.test.ts.net/* && $args != *' --resolve phone.test.ts.net:443:100.101.102.103 '* ]]; then
  echo 'phone probe lost TLS hostname-preserving Tailscale resolution' >&2; exit 1
fi
case "$url" in
  http://127.0.0.1:7681/api/status)
    case ${PULSE_TEST_BUSY:-0} in
      malformed) printf '{bad json\n';;
      unreachable) exit 7;;
      wait)
        if [[ ! -e $PULSE_TEST_ROOT/slept ]]; then printf '{"busyChildren":["/fixture/sessions/active"]}\n'
        else printf '{"busyChildren":[]}\n'; fi;;
      *) printf '{"busyChildren":[]}\n';;
    esac ;;
  http://127.0.0.1:7681/api/version)
    if [[ -e $PULSE_TEST_ROOT/restarted || ${PULSE_TEST_LIVE_NEW:-0} == 1 ]]; then
      if [[ ${PULSE_TEST_LOCAL_EMPTY:-0} == 1 ]]; then printf '{"releaseId":""}\n'
      elif [[ ${PULSE_TEST_LOCAL_STALE:-0} == 1 ]]; then printf '{"releaseId":"release-old"}\n'
      else printf '{"releaseId":"release-new"}\n'; fi
    else printf '{"releaseId":"release-old"}\n'; fi ;;
  https://phone.test.ts.net/api/version)
    if [[ ${PULSE_TEST_PHONE_EMPTY:-0} == 1 ]]; then printf '{"releaseId":""}\n'
    elif [[ ${PULSE_TEST_PHONE_STALE:-0} == 1 ]]; then printf '{"releaseId":"release-old"}\n'
    else printf '{"releaseId":"release-new"}\n'; fi ;;
  https://phone.test.ts.net/app/)
    if [[ $args == *' -w '* ]]; then printf '200 text/html'
    else printf '<script src="assets/index-abc.js"></script>\n'; fi ;;
  https://phone.test.ts.net/app/sw.js|https://phone.test.ts.net/app/assets/index-abc.js)
    printf '200 text/javascript' ;;
  https://phone.test.ts.net/app-release.apk) printf '200 application/octet-stream' ;;
  https://phone.test.ts.net/app-release.json) printf '200 application/json' ;;
  *) echo "unexpected sandbox curl URL: $url" >&2; exit 1 ;;
esac
SH

cat >"$fixture/bin/tailscale" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ ${PULSE_TEST_CANCEL_ONLY:-0} != 1 ]] || { echo 'tailscale used during cancellation' >&2; exit 1; }
case "$*" in
  'serve status --json')
    cat >"$PULSE_TEST_ROOT/serve.json" <<JSON
{"TCP":{"443":{"HTTPS":true}},"Web":{"phone.test.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:$PULSE_TEST_PORT"}}}}}
JSON
    cat "$PULSE_TEST_ROOT/serve.json" ;;
  'ip -4') printf '100.101.102.103\n' ;;
  *) echo "unexpected sandbox tailscale call: $*" >&2; exit 1 ;;
esac
SH

cat >"$fixture/bin/sleep" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case ${1:-} in
  5)
    touch "$PULSE_TEST_ROOT/slept"
    if [[ ${PULSE_TEST_CHANGE_BUILD:-0} == 1 ]]; then printf 'release-changed\n' >"$PULSE_TEST_ROOT/target/release/omp-pulse.release-id"; fi
    if [[ ${PULSE_TEST_CHANGE_TARGET:-0} == 1 ]]; then printf 'changed service binary\n' >"$PULSE_TEST_EXE"; fi
    ;;
  1) : ;;
  *) echo "unexpected sleep interval: $*" >&2; exit 1 ;;
esac
SH
chmod 755 "$fixture/bin/"*

reset_case() {
  rm -f "$fixture/restarted" "$fixture/cancelled" "$fixture/slept" "$fixture/waiter-active"
  printf 'old service binary\n' >"$fixture/installed"
  chmod 755 "$fixture/installed"
  printf 'release-new\n' >"$fixture/target/release/omp-pulse.release-id"
  printf 'https://phone.test.ts.net/app/\n' >"$fixture/target/release/omp-pulse.server-url"
  unset PULSE_TEST_USER_ACTIVE PULSE_TEST_SYSTEM_ACTIVE PULSE_TEST_EXPECT_SCOPE PULSE_TEST_BUSY PULSE_TEST_LOCAL_STALE PULSE_TEST_PHONE_STALE PULSE_TEST_LOCAL_EMPTY PULSE_TEST_PHONE_EMPTY PULSE_TEST_LIVE_NEW PULSE_TEST_EXPECT_RESTART PULSE_TEST_CHANGE_BUILD PULSE_TEST_CHANGE_TARGET || true
}
expect_refusal() {
  local name=$1; shift
  if "$fixture/scripts/deploy/pulse-restart.sh" --run "$@" >"$fixture/$name.log" 2>&1; then
    echo "accepted unsafe deployment case: $name" >&2; exit 1
  fi
  [[ ! -e $fixture/restarted ]] || { echo "restarted during refused case: $name" >&2; exit 1; }
}

# Both service scopes resolve independently; simultaneous active units are refused.
(
  source "$fixture/scripts/deploy/pulse-target.sh"
  pulse_target && pulse_endpoint
  [[ $PULSE_SCOPE == system && $PULSE_UNIT == omp-pulse.service && $PULSE_EXE == "$fixture/installed" && $PULSE_PORT == 7681 && $PULSE_LOCAL == http://127.0.0.1:7681 ]]
  [[ $PULSE_ORIGIN == https://phone.test.ts.net && $PULSE_URL == https://phone.test.ts.net/app/ && $PULSE_SERVE_HOST == phone.test.ts.net ]]
)
if (PULSE_TEST_USER_ACTIVE=1; export PULSE_TEST_USER_ACTIVE; source "$fixture/scripts/deploy/pulse-target.sh"; pulse_target); then
  echo 'accepted ambiguous active user and system services' >&2; exit 1
fi
if (PULSE_TEST_SYSTEM_ACTIVE=0; PULSE_TEST_USER_ACTIVE=0; export PULSE_TEST_SYSTEM_ACTIVE PULSE_TEST_USER_ACTIVE; source "$fixture/scripts/deploy/pulse-target.sh"; pulse_target); then
  echo 'accepted no active service' >&2; exit 1
fi

# The detached waiter is still a user unit, reports a pending idle wait, and status reads it.
reset_case
PULSE_TEST_BUSY=wait "$fixture/scripts/deploy/pulse-restart.sh" --max-wait 30 >"$fixture/queued.log"
grep -q 'restart is queued' "$fixture/queued.log"
PULSE_TEST_BUSY=wait "$fixture/scripts/deploy/pulse-restart.sh" --status >"$fixture/status.log"
grep -q 'restart:       PENDING' "$fixture/status.log"
grep -q 'daemon-hosted turns in progress:' "$fixture/status.log" || { cat "$fixture/status.log" >&2; exit 1; }
"$fixture/scripts/deploy/pulse-restart.sh" --cancel >"$fixture/cancel-idle.log"
[[ -e $fixture/cancelled && ! -e $fixture/restarted ]]

# A no-op requires both local and phone release IDs to match exactly.
reset_case
PULSE_TEST_LIVE_NEW=1 "$fixture/scripts/deploy/pulse-restart.sh" >"$fixture/already-live.log"
grep -q 'already live locally and at the phone endpoint' "$fixture/already-live.log"
[[ ! -e $fixture/waiter-active ]]
reset_case
PULSE_TEST_LIVE_NEW=1 PULSE_TEST_PHONE_STALE=1 "$fixture/scripts/deploy/pulse-restart.sh" >"$fixture/phone-stale-noop.log"
grep -q 'restart is queued' "$fixture/phone-stale-noop.log"
[[ -e $fixture/waiter-active ]]
reset_case

# A new build identity during the idle wait invalidates the pending cutover.
reset_case
if PULSE_TEST_BUSY=wait PULSE_TEST_CHANGE_BUILD=1 "$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/changed-build.log" 2>&1; then
  echo 'restarted after the built release identity changed while waiting' >&2; exit 1
fi
[[ ! -e $fixture/restarted ]]
grep -q 'identity changed while waiting' "$fixture/changed-build.log"
reset_case

# Replacing the selected service binary while idle also invalidates cutover.
if PULSE_TEST_BUSY=wait PULSE_TEST_CHANGE_TARGET=1 "$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/changed-target.log" 2>&1; then
  echo 'restarted after the service target changed while waiting' >&2; exit 1
fi
[[ ! -e $fixture/restarted ]]
grep -q 'identity changed while waiting' "$fixture/changed-target.log"

# System service cutover waits for busy turns to clear, installs atomically, and verifies phone TLS routing.
reset_case
PULSE_TEST_EXPECT_SCOPE=system PULSE_TEST_BUSY=wait "$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/system-cutover.log"
[[ -e $fixture/slept && -e $fixture/restarted ]]
cmp "$fixture/installed" "$fixture/target/release/omp-pulse"
grep -q '^RESULT ok: release release-new' "$fixture/system-cutover.log"

# User service is selected and restarted in user scope, not as system.
reset_case
PULSE_TEST_USER_ACTIVE=1 PULSE_TEST_SYSTEM_ACTIVE=0 PULSE_TEST_EXPECT_SCOPE=user "$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/user-cutover.log"
[[ -e $fixture/restarted ]]
grep -q 'restarting user service omp-pulse.service' "$fixture/user-cutover.log"

# Already-running built path skips replacement (and still restarts the selected service).
reset_case
export PULSE_TEST_EXE="$fixture/target/release/omp-pulse" PULSE_TEST_EXPECT_SCOPE=system
before=$(stat -c '%d:%i:%s:%Y' "$PULSE_TEST_EXE")
"$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/same-path.log"
after=$(stat -c '%d:%i:%s:%Y' "$PULSE_TEST_EXE")
[[ $before == "$after" && -e $fixture/restarted ]]
grep -q 'skipping replacement' "$fixture/same-path.log"
export PULSE_TEST_EXE="$fixture/installed"

# A different destination already containing the exact build is not recopied.
reset_case
cp "$fixture/target/release/omp-pulse" "$fixture/installed"
before=$(stat -c '%d:%i:%s:%Y' "$fixture/installed")
"$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/identical-binary.log"
after=$(stat -c '%d:%i:%s:%Y' "$fixture/installed")
[[ $before == "$after" && -e $fixture/restarted ]]
grep -q 'already matches the built binary' "$fixture/identical-binary.log"

# Bad or unreachable telemetry, mismatched endpoint, unsafe destinations, and stale IDs all refuse safely.
reset_case
PULSE_TEST_BUSY=malformed expect_refusal malformed-busy
reset_case
PULSE_TEST_BUSY=unreachable expect_refusal unreachable-busy
reset_case
printf 'https://other.example/app/\n' >"$fixture/target/release/omp-pulse.server-url"
expect_refusal mismatched-endpoint
reset_case
mv "$fixture/installed" "$fixture/real-installed"
ln -s "$fixture/real-installed" "$fixture/installed"
expect_refusal symlink-target
rm "$fixture/installed"
mv "$fixture/real-installed" "$fixture/installed"
chmod 444 "$fixture/installed"
expect_refusal unwritable-target
chmod 755 "$fixture/installed"
reset_case
mkdir -p "$fixture/real-target"
printf 'old service binary\n' >"$fixture/real-target/omp-pulse"
chmod 755 "$fixture/real-target/omp-pulse"
ln -s "$fixture/real-target" "$fixture/unsafe-parent"
PULSE_TEST_EXE="$fixture/unsafe-parent/omp-pulse" expect_refusal symlink-parent
rm "$fixture/unsafe-parent"
rm -rf "$fixture/real-target"
reset_case
PULSE_TEST_LOCAL_EMPTY=1 "$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/local-empty.log" 2>&1 && { echo 'accepted a missing local release ID' >&2; exit 1; }
grep -q 'FAIL local release <missing>' "$fixture/local-empty.log"
reset_case
PULSE_TEST_PHONE_EMPTY=1 "$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/phone-empty.log" 2>&1 && { echo 'accepted a missing phone release ID' >&2; exit 1; }
grep -q 'FAIL phone endpoint release <missing>' "$fixture/phone-empty.log"
reset_case
PULSE_TEST_LOCAL_STALE=1 "$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/local-stale.log" 2>&1 && { echo 'accepted a mismatched local release' >&2; exit 1; }
grep -q 'FAIL local release release-old' "$fixture/local-stale.log"
reset_case
PULSE_TEST_PHONE_STALE=1 "$fixture/scripts/deploy/pulse-restart.sh" --run >"$fixture/phone-stale.log" 2>&1 && { echo 'accepted a mismatched phone release' >&2; exit 1; }
grep -q 'FAIL phone endpoint release release-old' "$fixture/phone-stale.log"

# Cancellation remains independent of target, daemon, and Tailscale availability.
reset_case
PULSE_TEST_CANCEL_ONLY=1 PULSE_TEST_SYSTEM_ACTIVE=0 PULSE_TEST_USER_ACTIVE=0 "$fixture/scripts/deploy/pulse-restart.sh" --cancel >"$fixture/cancel.log"

printf 'isolated dual-scope endpoint selection, busy wait, safe cutover, release verification, and cancellation: ok\n'
