#!/usr/bin/env bash
# build-android-runtime: build the omp-pulse daemon that runs INSIDE the phone's
# Alpine guest and install it where Gradle packages it into the APK:
#
#   mobile/android/app/build/generated/runtime-jni/arm64-v8a/libomppulse.so
#
# Usage: scripts/android/build-runtime.sh
#
# WHY a "lib…so" that is really an executable: Android only extracts files named
# lib*.so from an APK into nativeLibraryDir, and nativeLibraryDir is the one
# app-owned location Android lets an app exec from (W^X: app data is noexec for
# apps targeting API 29+). The guest binds that directory at /opt/pulse and runs
# /opt/pulse/libomppulse.so as `omp-pulse`. It is a static musl executable so it
# runs in the Alpine guest without depending on any guest package.
#
# Toolchain, picked in this order:
#   1. host is already aarch64 + musl (Alpine on a phone or an arm64 box):
#      build natively for the host triple, statically.
#   2. a cross linker is configured for aarch64-unknown-linux-musl
#      (CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER or a
#      [target.aarch64-unknown-linux-musl] table in a cargo config file).
#   3. `cargo zigbuild` is installed (cargo install cargo-zigbuild + zig).
#   Otherwise it stops and says how to get one of them.
#
# INVARIANT: public/ must already hold the built web client. The daemon embeds
# public/ at compile time (include_dir!), so this runs AFTER vite; build.rs
# refuses to build without public/app/index.html.
# INVARIANT: the runtime daemon never embeds public/app-release.apk. That APK
# contains this library, so embedding it would nest every previous release
# inside the next one and grow the APK without bound.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ABI="arm64-v8a"
CROSS_TRIPLE="aarch64-unknown-linux-musl"
DEST_DIR="$ROOT/mobile/android/app/build/generated/runtime-jni/$ABI"
DEST="$DEST_DIR/libomppulse.so"
# A target dir of its own, inside THIS checkout, whatever CARGO_TARGET_DIR says:
# a shared target dir lets another checkout's build (or the live daemon's)
# block on the same cargo lock or hand back an artefact built from other
# sources. Override only with OMP_PULSE_RUNTIME_TARGET_DIR.
TARGET_DIR="${OMP_PULSE_RUNTIME_TARGET_DIR:-$ROOT/target/android-runtime}"
export CARGO_TARGET_DIR="$TARGET_DIR"
# Outside public/ so nothing parked here is embedded, inside target/ so it is
# ignored by git and by release-id.sh.
ASIDE="$TARGET_DIR/aside"

die() {
  echo "build-android-runtime: $*" >&2
  exit 1
}

command -v cargo >/dev/null || die "cargo not found"
command -v node >/dev/null || die "node not found (used to verify the produced ELF)"
[ -f public/app/index.html ] || die "public/app is not built. Build the web client first:
  (cd web && npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false)
or run scripts/deploy/pulse-deploy.sh, which orders the stages for you."

# ── keep the downloadable APK out of the embedded tree ──────────────────────
# A previous run killed with SIGKILL could not run its trap; put the files back
# before anything else so the host daemon never loses its download link.
restore_apk() {
  local f
  for f in app-release.apk app-release.json; do
    if [ -f "$ASIDE/$f" ]; then
      mv -f "$ASIDE/$f" "public/$f"
    fi
  done
}
restore_apk
trap restore_apk EXIT
mkdir -p "$ASIDE"
for f in app-release.apk app-release.json; do
  if [ -f "public/$f" ]; then
    mv -f "public/$f" "$ASIDE/$f"
  fi
done

# ── pick the toolchain ───────────────────────────────────────────────────────
HOST="$(rustc -vV | sed -n 's/^host: //p')"
cross_linker_configured() {
  [ -n "${CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER:-}" ] && return 0
  local dir="$ROOT" cfg
  # Cargo reads .cargo/config{,.toml} from the cwd up to /, then CARGO_HOME.
  while :; do
    for cfg in "$dir/.cargo/config.toml" "$dir/.cargo/config"; do
      [ -f "$cfg" ] && grep -q "^\[target\.$CROSS_TRIPLE\]" "$cfg" && return 0
    done
    [ "$dir" = / ] && break
    dir="$(dirname "$dir")"
  done
  for cfg in "${CARGO_HOME:-$HOME/.cargo}/config.toml" "${CARGO_HOME:-$HOME/.cargo}/config"; do
    [ -f "$cfg" ] && grep -q "^\[target\.$CROSS_TRIPLE\]" "$cfg" && return 0
  done
  return 1
}

case "$HOST" in
aarch64-*-linux-musl)
  # Native: build for the HOST triple (Alpine's rustc ships only
  # aarch64-alpine-linux-musl). Passing --target anyway keeps these flags out of
  # build scripts and keeps target/release (the host daemon) untouched.
  TRIPLE="$HOST"
  BUILD=(cargo build)
  MODE="native ($HOST)"
  ;;
*)
  TRIPLE="$CROSS_TRIPLE"
  if cross_linker_configured; then
    BUILD=(cargo build)
    MODE="configured cross linker"
  # cargo-zigbuild 0.24 rejects `cargo zigbuild --version`; the binary itself still answers it.
  elif cargo-zigbuild --version >/dev/null 2>&1; then
    BUILD=(cargo zigbuild)
    MODE="cargo zigbuild"
  else
    die "no way to link for $CROSS_TRIPLE on $HOST. Pick one:
  - cargo install cargo-zigbuild, and install zig (https://ziglang.org/download/)
  - or configure a cross linker, e.g. in ~/.cargo/config.toml:
      [target.$CROSS_TRIPLE]
      linker = \"rust-lld\"
    plus CC_aarch64_unknown_linux_musl=clang CFLAGS_aarch64_unknown_linux_musl=--target=$CROSS_TRIPLE for ring's C
  - or build on an aarch64 musl host (Alpine), e.g. the phone itself"
  fi
  if [ ! -d "$(rustc --print sysroot)/lib/rustlib/$TRIPLE" ]; then
    command -v rustup >/dev/null || die "the Rust standard library for $TRIPLE is not installed and rustup is absent"
    rustup target add "$TRIPLE"
  fi
  ;;
esac

# Flags apply to the target triple only (never to build.rs or proc macros):
# - crt-static: a static binary needs nothing from the guest's /lib.
# - relocation-model=static: a non-PIE ET_EXEC, the exact shape of the
#   libomppulse.so that shipped and runs under proot's loader.
# - strip=symbols: Android extracts the library uncompressed onto every device;
#   symbols only cost storage there.
# RUSTFLAGS/CARGO_ENCODED_RUSTFLAGS would silently override these; the ELF check
# below catches a dynamic result, but say why up front.
if [ -n "${RUSTFLAGS:-}${CARGO_ENCODED_RUSTFLAGS:-}" ]; then
  die "unset RUSTFLAGS/CARGO_ENCODED_RUSTFLAGS: they override the per-target flags this build needs"
fi
TRIPLE_ENV="$(printf '%s' "$TRIPLE" | tr 'a-z-' 'A-Z_')"
export "CARGO_TARGET_${TRIPLE_ENV}_RUSTFLAGS=-C target-feature=+crt-static -C relocation-model=static -C strip=symbols"

echo "→ runtime daemon for $ABI via $MODE"
"${BUILD[@]}" --release --target "$TRIPLE"
BIN="$TARGET_DIR/$TRIPLE/release/omp-pulse"
[ -f "$BIN" ] || die "$BIN was not produced"

# ── verify the artefact before Gradle packages it ────────────────────────────
# A dynamic or wrongly aligned binary still packages fine and fails only on a
# user's phone, so the checks run here: AArch64, ET_EXEC (non-PIE, the shape
# verified under proot), no ELF interpreter (static: Alpine's default output
# needs /lib/ld-musl-aarch64.so.1), and every LOAD segment aligned to at least
# 16 KB (Android 15+ devices with 16 KB pages cannot map 4 KB-aligned segments).
node - "$BIN" <<'JS'
const fs = require("fs");
const file = process.argv[2];
const b = fs.readFileSync(file);
const fail = (m) => { console.error(`build-android-runtime: ${file}: ${m}`); process.exit(1); };
if (b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2 || b[5] !== 1) fail("not a 64-bit little-endian ELF");
if (b.readUInt16LE(18) !== 183) fail("not an AArch64 binary");
if (b.readUInt16LE(16) !== 2) fail("not ET_EXEC; expected a static non-PIE executable (relocation-model=static)");
const phoff = Number(b.readBigUInt64LE(32)), phentsize = b.readUInt16LE(54), phnum = b.readUInt16LE(56);
for (let i = 0; i < phnum; i++) {
  const p = phoff + i * phentsize;
  const type = b.readUInt32LE(p), align = Number(b.readBigUInt64LE(p + 48));
  if (type === 3) fail("has an ELF interpreter (dynamically linked); it must be static");
  if (type === 1 && align < 0x4000) fail(`LOAD segment aligned to ${align} bytes; 16 KB-page devices need >= 16384`);
}
JS

mkdir -p "$DEST_DIR"
# Atomic: Gradle must never package a half-copied executable.
cp "$BIN" "$DEST.tmp"
mv -f "$DEST.tmp" "$DEST"
printf '  %s: %.1f MB, sha256 %s\n' "${DEST#"$ROOT"/}" \
  "$(awk "BEGIN{print $(wc -c <"$DEST")/1048576}")" "$(sha256sum "$DEST" | cut -d' ' -f1)"
