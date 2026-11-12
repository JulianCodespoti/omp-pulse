#!/usr/bin/env bash
# Print the immutable release identity for one source tree.
# Generated web/APK/daemon outputs are ignored and deliberately excluded from
# this fingerprint. Hashing their bytes would be circular because the client
# embeds this same ID. The selected phone endpoint is a build input too, so an
# APK aimed at another host cannot share this release identity.
# Source edits, staged edits, and untracked source files remain part of it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

commit="$(git rev-parse HEAD 2>/dev/null || printf 'nogit')"
if [ "$commit" = nogit ]; then
  fingerprint="$(printf 'commit:nogit\nphone-endpoint:%s\n' "${OMP_PULSE_SERVER_URL:-}" | sha256sum | cut -c1-20)"
  printf 'r2-nogit-%s\n' "$fingerprint"
  exit 0
fi

fingerprint="$({
  printf 'commit:%s\n' "$commit"
  if [ -n "${OMP_PULSE_SERVER_URL:-}" ]; then
    printf 'phone-endpoint:%s\n' "$OMP_PULSE_SERVER_URL"
  fi
  git status --porcelain=v1 --untracked-files=all
  git diff --no-ext-diff --binary HEAD
  while IFS= read -r -d '' path; do
    case "$path" in
      public/app/*|public/app-release.apk|public/app-release.json|target/*|mobile/android/app/build/*|mobile/android/.gradle/*)
        continue
        ;;
    esac
    printf 'untracked:%s\n' "$path"
    sha256sum -- "$path"
  done < <(git ls-files --others --exclude-standard -z)
} | sha256sum | cut -c1-20)"

short="$(git rev-parse --short=12 HEAD)"
printf 'r2-%s-%s\n' "$short" "$fingerprint"
