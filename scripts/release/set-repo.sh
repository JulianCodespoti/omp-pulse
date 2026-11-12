#!/usr/bin/env bash
# Point every repository reference at YOUR GitHub account.
#
# WHY THIS EXISTS: the repository slug appears across the README, both
# installers, the docs, the Android app and Cargo.toml. Every one of them has to
# agree or a user gets a 404 halfway through an install, so changing them by
# hand is a job you do once and get wrong once.
#
#   scripts/release/set-repo.sh <github-owner> [repo-name]
#
# Example:
#   scripts/release/set-repo.sh acme            # -> acme/omp-pulse
#   scripts/release/set-repo.sh acme pulse      # -> acme/pulse
#
# Run it from anywhere inside the checkout, then review and commit the diff. It
# is idempotent: a second run with the same arguments changes nothing, and a
# run with different arguments rewrites cleanly from the current values.
#
# What it rewrites (every tracked or untracked, non-ignored text file outside
# node_modules): "<owner>/<name>" slugs. Cargo.toml's `repository` is the
# source of the CURRENT values and is rewritten last, so an interrupted run can
# simply be rerun.
set -euo pipefail

if [ $# -lt 1 ]; then
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

NEW_OWNER="$1"
NEW_NAME="${2:-omp-pulse}"
# Restrict both parts to GitHub's own character sets so the rewrite patterns
# below never need escaping beyond re_escape.
if [[ ! $NEW_OWNER =~ ^[A-Za-z0-9-]+$ || ! $NEW_NAME =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "owner must match [A-Za-z0-9-]+ and repo name [A-Za-z0-9_-]+" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Current values, read from Cargo.toml so this script never needs updating when
# the slug changes.
CUR_SLUG="$(grep -m1 '^repository' Cargo.toml | sed 's|.*github.com/||; s|"||g; s|/*$||')"
CUR_OWNER="${CUR_SLUG%%/*}"
CUR_NAME="${CUR_SLUG##*/}"

if [ -z "$CUR_OWNER" ] || [ -z "$CUR_NAME" ] || [ "$CUR_OWNER/$CUR_NAME" != "$CUR_SLUG" ]; then
  echo "could not read the current slug from Cargo.toml's repository field" >&2
  exit 1
fi

echo "rewriting $CUR_OWNER/$CUR_NAME -> $NEW_OWNER/$NEW_NAME"

# Every non-ignored text file containing a fixed string. node_modules is
# vendored third-party code, and this script names the slug only in examples.
files_with() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git grep -lIF --untracked -e "$1" -- . ':!*node_modules/*' ':!scripts/release/set-repo.sh' || true
  else
    grep -rlIF --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.git -e "$1" . |
      sed 's|^\./||' | grep -vx 'scripts/release/set-repo.sh' || true
  fi
}

re_escape() { printf '%s' "$1" | sed 's/[][\.*^$#+?(){}|]/\\&/g'; }

declare -A CHANGED=()

# rewrite <old> <new> <file>...: replace <old> only where it is a whole token.
# Unbounded, "owner/omp-pulse" also matched inside "owner/omp-pulse-oss", so
# retargeting to a name that extends the current one appended the suffix twice
# on the next pass.
rewrite() {
  local old="$1" new="$2" pat f before expr
  shift 2
  pat="$(re_escape "$old")"
  for f in "$@"; do
    [ -f "$f" ] || continue
    before="$(cksum <"$f")"
    # Applied twice: each match consumes its trailing boundary character, so an
    # occurrence directly after another (one separator between) needs a pass.
    expr="s#(^|[^A-Za-z0-9_-])${pat}([^A-Za-z0-9_-]|\$)#\\1${new}\\2#g"
    sed -E -i -e "$expr" -e "$expr" "$f"
    [ "$before" = "$(cksum <"$f")" ] || CHANGED["$f"]=1
  done
}

# 1. "<owner>/<name>": URLs, raw.githubusercontent paths, cargo install --git.
mapfile -t slug_files < <(files_with "$CUR_OWNER/$CUR_NAME" | grep -vx Cargo.toml)
rewrite "$CUR_OWNER/$CUR_NAME" "$NEW_OWNER/$NEW_NAME" "${slug_files[@]}"

# 2. Cargo.toml last: it is where the next run reads the current slug from.
rewrite "$CUR_OWNER/$CUR_NAME" "$NEW_OWNER/$NEW_NAME" Cargo.toml

if [ "${#CHANGED[@]}" -eq 0 ]; then
  echo "  nothing to change"
else
  printf '  updated %s\n' "${!CHANGED[@]}" | sort
fi

echo
echo "done. Remaining manual steps:"
echo "  1. git remote add origin https://github.com/$NEW_OWNER/$NEW_NAME.git"
echo "  2. review the diff (git diff), then commit"
echo "  3. push, then tag: the release workflow attaches the daemon archives, and"
echo "     release.sh attaches the APK and publishes (docs/contributing/releasing.md):"
echo "     git tag v0.1.0 && git push origin v0.1.0 && scripts/release/release.sh --publish"
