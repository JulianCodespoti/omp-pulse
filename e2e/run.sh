#!/usr/bin/env bash
# Run end-to-end suites one at a time, each against its own throwaway daemon.
#
#   e2e/run.sh daemon                         # every suite in e2e/daemon/
#   e2e/run.sh omp browser android            # several tiers, in that order
#   e2e/run.sh e2e/browser/verify-send.mjs    # one suite
#
# A tier is a directory of suites grouped by what running them needs (see
# e2e/README.md). A suite is any *.mjs or *.py file directly in it, except the
# unit tests of the suites' own helpers (*.test.mjs, test_*.py), which the gate
# runs separately. So adding a suite is adding a file: nothing to register.
#
# Every suite runs under e2e/with-test-daemon.sh (its own port, token, sessions
# root, state and runtime directories); android suites also under
# e2e/with-emulator.sh. Suites run sequentially on purpose: they spawn real omp
# children and are load-sensitive, so running two at once produces failures
# that look exactly like regressions.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -eq 0 ]; then
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi

suites=()
for target in "$@"; do
  if [ -d "e2e/$target" ] && [ "$target" != lib ]; then
    while IFS= read -r suite; do suites+=("$suite"); done < <(
      find "e2e/$target" -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.py' \) \
        ! -name '*.test.mjs' ! -name 'test_*.py' | LC_ALL=C sort
    )
  elif [ -f "$target" ]; then
    suites+=("$target")
  else
    echo "e2e/run.sh: no tier or suite named '$target' (tiers: daemon omp browser android)" >&2
    exit 2
  fi
done

pass=0
declare -a failed=()
for suite in "${suites[@]}"; do
  case "$suite" in
  *.py) command=(python3 "$suite") ;;
  *) command=(node "$suite") ;;
  esac
  case "$suite" in
  e2e/android/*) harness=(e2e/with-test-daemon.sh e2e/with-emulator.sh) ;;
  *) harness=(e2e/with-test-daemon.sh) ;;
  esac
  printf '  %-52s' "$suite"
  started=$SECONDS
  # Each suite gets its own TMPDIR, removed afterwards. Suites mkdtemp
  # fixture trees (~130 MB each) and never deleted them; a few tier runs
  # filled the per-user /tmp quota, after which the daemon aborted on start
  # ("Disk quota exceeded") and 40 suites failed in 0 s like a regression.
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/e2e.XXXXXX")"
  if output="$(TMPDIR="$scratch" "${harness[@]}" "${command[@]}" 2>&1)"; then
    echo "ok ($((SECONDS - started))s)"
    pass=$((pass + 1))
  else
    echo "FAIL ($((SECONDS - started))s)"
    failed+=("$suite")
    echo "$output" | tail -25 | sed 's/^/      /'
  fi
  rm -rf "$scratch"
done

echo "e2e: ${pass} passed, ${#failed[@]} failed"
if [ "${#failed[@]}" -ne 0 ]; then
  printf 'failed: %s\n' "${failed[*]}"
  exit 1
fi
