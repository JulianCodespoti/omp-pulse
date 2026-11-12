#!/usr/bin/env bash
# The project's validation gate. Hosted CI (.github/workflows/ci.yml) runs the
# default tier on Linux for every push to main and every pull request; this
# script is the single definition of what that gate checks, so a new check
# goes here and both places pick it up.
#
# It also runs locally, with the cross-compile checks that stand in for real
# Windows runners (CI adds native macOS and Windows test jobs on top).
#
# Usage:
#   scripts/ci.sh              # everything that needs no browser, emulator,
#                              # container or model provider
#   scripts/ci.sh --group web  # only the non-cargo half (web, docs, tooling,
#                              # Android host-JVM, harness tests)
#   scripts/ci.sh --group rust # only the cargo half (fmt, clippy, build,
#                              # test, Windows, e2e daemon, fresh install)
#   scripts/ci.sh --full       # also the musl build, the Android JVM tests and
#                              # every end-to-end tier (browser, omp, emulator)
# Hosted CI runs the two groups as parallel jobs; together they are exactly
# the default tier. Both build the web client first (build.rs embeds it).
#
# Prerequisites on a fresh clone (Linux host):
#   - Rust stable with rustfmt + clippy, and the Windows target:
#       rustup target add x86_64-pc-windows-gnu
#     plus a MinGW-w64 C toolchain (x86_64-w64-mingw32-gcc) for `ring`.
#   - Node.js matching web/package.json "engines" (22.22+, 24.15+ or 26+), npm.
#     The first run installs web/node_modules and builds the embedded web
#     client into public/app, which build.rs requires.
#   - python3 with the websockets module (e2e: daemon), a JDK (17+; `java` on
#     PATH), curl, jq.
#   - omp on PATH is optional: the smoke suite skips its live-child checks
#     without it and names them.
#   - --full only: docker (set DOCKER="sudo docker" if your user cannot reach
#     the daemon); omp on PATH with a model provider configured (several
#     suites make real model calls; OMP_PULSE_TEST_MODEL picks the model);
#     Chromium (OMP_PULSE_CHROMIUM, see e2e/lib/env.mjs); herdr on PATH; and
#     for the Android steps the Android SDK, JDK 21 (OMP_PULSE_JDK), an
#     aarch64 musl toolchain for the phone-mode daemon and an AVD (see the
#     header of e2e/with-emulator.sh).
set -uo pipefail
cd "$(dirname "$0")/.."
# The gate builds the web client and the daemon under one identity of its
# own. A release ID left exported by an earlier manual build (a shell that ran
# a deploy-style `export OMP_PULSE_RELEASE_ID=...`) made build.rs refuse every
# cargo step in 0 s with "identities differ", which reads like a regression.
unset OMP_PULSE_RELEASE_ID VITE_RELEASE_ID

FULL=0
GROUP=all
while [ $# -gt 0 ]; do
  case "$1" in
  --full) FULL=1 ;;
  --group)
    GROUP="${2:-}"
    shift
    ;;
  *)
    echo "unknown argument: $1 (use --full or --group web|rust)" >&2
    exit 2
    ;;
  esac
  shift
done
case "$GROUP" in
all | web | rust) ;;
*)
  echo "unknown group: $GROUP (use web or rust)" >&2
  exit 2
  ;;
esac
if [ "$FULL" = 1 ] && [ "$GROUP" != all ]; then
  echo "--full runs every group; drop --group" >&2
  exit 2
fi
want() { [ "$GROUP" = all ] || [ "$GROUP" = "$1" ]; }

pass=0
fail=0
declare -a failed

step() {
  local name="$1"
  shift
  local start=$SECONDS
  printf '%-42s' "$name"
  if out="$("$@" 2>&1)"; then
    echo "ok    $((SECONDS - start))s"
    pass=$((pass + 1))
  else
    echo "FAIL  $((SECONDS - start))s"
    fail=$((fail + 1))
    failed+=("$name")
    echo "$out" | tail -12 | sed 's/^/    /'
  fi
}

# build.rs refuses to compile without public/app, the embedded web client. It
# is generated (ignored by git), so a fresh clone has none: build it once.
# An existing build is left alone; scripts/deploy/pulse-deploy.sh owns rebuilds.
web_client() {
  (cd web && { [ -d node_modules ] || npm ci --no-audit --no-fund; }) || return 1
  [ -f public/app/index.html ] && [ -f public/app/release-id ] && return 0
  (cd web && npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false)
}

# Each file boots its own jsdom and compiles the app, so the step is bounded by
# memory, not by cores: `nproc - 1` on a 16-core desktop is 15 copies and drove
# this machine into swap until it froze. Four is the most that has been safe
# here, and three is the floor that still hides process start-up. The compile
# cache lets the ~190 test processes reuse each other's jsdom, rolldown and
# support code.
web_unit_tests() {
  local jobs=$(($(nproc) - 1))
  [ "$jobs" -le 4 ] || jobs=4
  [ "$jobs" -ge 3 ] || jobs=3
  (cd web && NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-${TMPDIR:-/tmp}/omp-pulse-node-compile-cache}" \
    node --experimental-vm-modules --test --test-concurrency="$jobs" "test/**/*.test.mjs")
}

# Each harness is a folder with a run.py; a new one is picked up by adding it.
android_host_tests() {
  local runner out status=0
  for runner in mobile/android/host-tests/*/run.py; do
    if ! out="$(python3 "$runner" 2>&1)"; then
      echo "FAIL $runner"
      echo "$out" | tail -20
      status=1
    fi
  done
  return "$status"
}

# The container command is configurable because docker access differs per host
# (group membership, rootless, or sudo).
musl_build() {
  ${DOCKER:-docker} run --rm -v "$PWD":/src:ro -v /tmp/musl-target:/target -w /src \
    -e CARGO_TARGET_DIR=/target rust:1-slim sh -c \
    "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq musl-tools >/dev/null 2>&1 &&
     rustup target add x86_64-unknown-linux-musl >/dev/null 2>&1 &&
     cargo build --release --locked --target x86_64-unknown-linux-musl"
}

# Gradle's preBuild requires the Capacitor sync output and the phone-mode
# daemon library even for JVM tests, so produce both first.
android_unit_tests() {
  (cd mobile && { [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund; } &&
    npx cap sync android) &&
    scripts/android/build-runtime.sh &&
    (cd mobile/android && JAVA_HOME="${OMP_PULSE_JDK:-${JAVA_HOME:-}}" ./gradlew --no-daemon testDebugUnitTest)
}

# A hosted matrix's three OSes reduce to: build+test on this host, and type-check
# the other platforms. windows-gnu covers the Windows code paths. The macOS FFI
# needs the Apple SDK, so `cargo check --target *-apple-darwin` fails on `ring`
# from Linux and is not part of this gate.
step "web client (public/app)" web_client
if want web; then
  step "docs match the code" scripts/docs/check-docs.sh
  step "brand tokens in sync" node scripts/brand/sync-tokens.mjs --check
  step "web typecheck" npm --prefix web run --silent typecheck
  step "web unit tests" web_unit_tests
  step "website build and tests" sh -c 'node website/build.mjs && node --test website/site.test.mjs'
  step "extension and tooling tests" node --test "extensions/test/*.test.mjs" "scripts/**/*.test.mjs"
  step "deploy scripts" scripts/deploy/pulse-deploy.test.sh
  step "Android host-JVM tests" android_host_tests
  step "Android transfer tooling" python3 -m unittest discover -s scripts/android/tests -p 'test_*.py'
  step "phone harness tests" python3 -m unittest discover -s phone-harness/tests
  step "e2e helper tests" python3 -m unittest discover -s e2e/daemon -p 'test_*.py'
fi
if want rust; then
  step "cargo fmt --check" cargo fmt --check
  # --locked: a Cargo.lock that disagrees with Cargo.toml fails here instead of
  # being silently re-resolved.
  step "cargo clippy -D warnings" cargo clippy --locked --release --all-targets -- -D warnings
  step "cargo build --release" cargo build --locked --release
  step "cargo test --release" cargo test --locked --release
  step "windows cross-check" cargo check --locked --target x86_64-pc-windows-gnu --all-targets
  step "windows zero warnings" env RUSTFLAGS="${RUSTFLAGS:-} -Dwarnings" cargo build --locked --release --target x86_64-pc-windows-gnu
  step "e2e: daemon" e2e/run.sh daemon
  step "fresh-machine acceptance" bash e2e/fresh-install.sh
fi

if [ "$FULL" = "1" ]; then
  step "musl static build" musl_build
  step "Android unit tests" android_unit_tests
  step "e2e: omp" e2e/run.sh omp
  step "e2e: browser" e2e/run.sh browser
  step "e2e: android" e2e/run.sh android
fi

echo
echo "$pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  printf 'failed: %s\n' "${failed[*]}"
  exit 1
fi
