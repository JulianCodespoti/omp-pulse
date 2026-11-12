#!/usr/bin/env bash
# Assert the docs still match the code.
#
# WHY: agents obey docs over their own reading, so a stale doc actively misleads.
# Three of these checks caught real errors when first written: two false invariants
# in the architecture doc ("types.rs depends only on std+serde", "four singletons")
# and a generated module purpose truncated to nonsense.
set -uo pipefail
cd "$(dirname "$0")/../.."

fail=0
note() {
  printf '  %-46s %s\n' "$1" "$2"
  [ "$2" = FAIL ] && fail=$((fail + 1))
  return 0
}

# 1. The module index is exactly what the generator produces (ignoring its date
# line). Generate to a temp file: a check must never modify what it is checking,
# or its first run "fails" and its second passes for the wrong reason.
gen="$(mktemp)"
trap 'rm -f "$gen"' EXIT
scripts/docs/codemap.sh "$gen" >/dev/null
if diff <(grep -v '^Last verified:' docs/internals/modules.md) \
  <(grep -v '^Last verified:' "$gen") >/dev/null; then
  note "modules.md matches the generator" ok
else
  note "modules.md matches the generator" FAIL
  echo "    run scripts/docs/codemap.sh and commit the result"
fi

# 2. Every module has a //! header (the generator's own source of truth).
# Nested module files count too; test-only files (`*tests.rs`, `tests/`) do not.
missing="$(for f in $(find src -name '*.rs' ! -name '*tests.rs' ! -path '*/tests/*' | sort); do
  head -1 "$f" | grep -q '^//!' || echo "$f"
done)"
[ -z "$missing" ] && note "every module has a //! header" ok || {
  note "every module has a //! header" FAIL
  echo "$missing" | sed 's/^/    /'
}

# 3. The architecture doc's checkable absences.
spawns="$(cat src/omp/child.rs $(find src/omp/child -name '*.rs') | grep -c 'Command::new(&self.config.omp_bin)')"
[ "$spawns" = 1 ] && note "child.rs owns the only rpc spawn" ok || note "child.rs owns the only rpc spawn" FAIL

deps="$(grep -c '^use crate::' src/types.rs)"
[ "$deps" -le 1 ] && note "types.rs imports at most one crate module" ok || note "types.rs imports at most one crate module" FAIL

# Counted over every file of every module (tests included), so moving code
# between a module's files never changes the number. A module is a top-level
# file (src/paths.rs), a file directly inside a subsystem directory
# (src/omp/child.rs) or the binary (src/bin/omp-pulse/term.rs), together with
# its own directory (src/omp/child/...). Subsystems are the modules lib.rs
# declares that have a directory.
# `find` rather than `grep --include`: BusyBox grep (the phone) has no --include.
rs_files="$(find src -name '*.rs' | sort)"
subsystems="$(sed -nE 's/^pub mod ([a-z_]+);$/\1/p' src/lib.rs | while read -r m; do [ -d "src/$m" ] && echo "$m"; done | paste -sd'|' -)|bin/[^/]+"
statics="$(cat $rs_files | grep -o 'static [A-Z_]*:' | awk 'END{print NR}')"
static_modules="$(grep -lo 'static [A-Z_]*:' $rs_files | sed -E "s#^src/(($subsystems)/)?([^/.]+).*#\\1\\3#" | sort -u | awk 'END{print NR}')"
claimed="$(grep -oE 'there are [0-9]+ statics across [0-9]+ modules' docs/internals/architecture.md | grep -oE '[0-9]+' | tr '\n' ' ')"
[ "$claimed" = "$statics $static_modules " ] && note "static count matches architecture.md ($statics)" ok ||
  {
    note "static count matches architecture.md" FAIL
    echo "    code has $statics statics across $static_modules modules, doc claims ${claimed:-none}"
  }

# The invariant is that assets.rs is the only place that READS the public_dir
# override at runtime. Matching any MENTION of the identifier tripped on test
# fixtures that merely construct a `Config { public_dir: None, .. }` — an
# unavoidable consequence of the field existing, not a second reader. So match
# field ACCESSES (`.public_dir`) and exempt the places that must legitimately
# handle it: assets.rs (the reader), types.rs/cli.rs (where the config layer
# resolves it) and main.rs (which hands it to assets exactly once at startup).
allowed='^src/(server/assets|types|cli|bin/omp-pulse/main)[./]'
readers="$(grep -ln '\.public_dir' $rs_files | grep -vcE "$allowed")"
if grep -q "public_dir" src/server/assets.rs && [ "$readers" = 0 ]; then
  note "assets.rs is the only public_dir reader" ok
else
  note "assets.rs is the only public_dir reader" FAIL
  grep -ln '\.public_dir' $rs_files | grep -vE "$allowed" | sed 's/^/    unexpected reader: /'
fi

# 4. Every repository path a doc names, and every relative link, exists: a
# reader who copies a command or follows a link must land on something real.
# A path may be relative to the repository root or to the doc's own directory
# (web/AGENTS.md says src/app/). phone-harness/ is excluded because its docs
# describe the device-side clone, generated or machine-local files (public/app,
# target/, web/dist, node_modules, audit/, Gradle's build/, local.properties)
# only exist after a build or a setup step, and a path containing `*`, `{` or
# `<` is a pattern, not a file.
dangling="$(
  for doc in $(find . -name '*.md' ! -path '*/node_modules/*' ! -path './target/*' ! -path './phone-harness/*' | sed 's#^\./##' | sort); do
    dir="$(dirname "$doc")"
    grep -noE '(^|[^A-Za-z0-9_./~-])(scripts|e2e|docs|web|website|mobile|src|extensions|phone-harness|bench|tests|\.github)/[A-Za-z0-9_./*{}<>-]*' "$doc" |
      sed -E 's#^([0-9]+):[^A-Za-z0-9_./~-]?#\1 #; s#[.,:;-]+$##' |
      while read -r line path; do
        case "$path" in *'*'* | *'{'* | *'<'* | *public/app* | *target/* | *web/dist* | *website/dist* | *node_modules* | *audit/* | */build/* | */.gradle/* | *local.properties) continue ;; esac
        [ -e "$path" ] || [ -e "$dir/$path" ] || echo "$doc:$line: $path"
      done
    grep -noE '\]\([^)#: ]+[)#]' "$doc" | sed -E 's#^([0-9]+):\]\((.*).$#\1 \2#' |
      while read -r line link; do
        [ -e "$dir/$link" ] || echo "$doc:$line: link $link"
      done
  done
)"
[ -z "$dangling" ] && note "every path and link in the docs exists" ok || {
  note "every path and link in the docs exists" FAIL
  echo "$dangling" | sed 's/^/    /'
}

# 5. No dangling build-slice codenames (they named agents that no longer exist).
slop="$(grep -rnoE '\((PortableCore|Slice [A-Z]|module [AB][0-9]|Wave [AB])\)' src/ docs/ 2>/dev/null || true)"
[ -z "$slop" ] && note "no dangling build-slice codenames" ok || {
  note "no dangling build-slice codenames" FAIL
  echo "$slop" | sed 's/^/    /'
}

echo
[ "$fail" -eq 0 ] && echo "docs check: all passed" || {
  echo "docs check: $fail failed"
  exit 1
}
