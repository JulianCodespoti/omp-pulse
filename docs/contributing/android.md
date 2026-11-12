# Building the Android app

How to build the Capacitor Android app (`mobile/`), on a laptop or on the phone
itself, how to test it, and how to maintain the phone-mode runtime it ships: runtime
pins, omp upgrades and new ABIs. How phone mode works inside is in
[docs/internals/phone-mode.md](../internals/phone-mode.md); shipping a change to your
own daemon end to end is in [deploying.md](deploying.md); release builds are in
[releasing.md](releasing.md).

## Prerequisites

- Node.js and npm (for `web/` and `mobile/`).
- Rust plus an aarch64 musl toolchain for the phone-mode daemon: an aarch64 musl
  host, a configured `aarch64-unknown-linux-musl` linker, or `cargo-zigbuild` with
  zig (see [The phone-mode daemon](#the-phone-mode-daemon-libomppulseso)).
- JDK 21. A newer default JDK fails in jlink; point `OMP_PULSE_JDK` (used by
  `scripts/ci.sh` and `scripts/deploy/pulse-deploy.sh`) or `JAVA_HOME` at a JDK 21
  if it is not the system default.
- The Android SDK: `ANDROID_HOME`, or `sdk.dir=` in `mobile/android/local.properties`.

Gradle runs through the wrapper, `mobile/android/gradlew`.

## A public debug build on a laptop

No baked daemon URL; the app shows onboarding on first run.

```sh
(cd web && npm ci)
(cd mobile && npm ci)
export RELEASE_ID="$(scripts/release/release-id.sh)" OMP_PULSE_RELEASE_ID="$RELEASE_ID" VITE_RELEASE_ID="$RELEASE_ID"
(cd web && npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false)
(cd mobile && npx cap sync android)
scripts/android/build-runtime.sh      # phone-mode daemon → libomppulse.so
(cd mobile/android && JAVA_HOME=/path/to/jdk-21 ./gradlew assembleDebug)
# → mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

The order is the embedding order: the web build lands in `public/app`, Capacitor
copies it into the Android project, the runtime build embeds `public/` into the
phone-mode daemon, and Gradle packages that daemon. Why the order is load-bearing
for a full deploy (which also rebuilds the desktop binary) is in
[deploying.md](deploying.md).

## Public and laptop-paired builds

- **`OMP_PULSE_SERVER_URL` unset** builds the public APK: no baked server, no https
  deep-link filter, and first run shows onboarding (**Run on this phone** /
  **Connect a laptop**).
- **`OMP_PULSE_SERVER_URL` set** bakes that laptop's daemon into the APK, with
  default mode `laptop`. This is what `scripts/deploy/pulse-deploy.sh` builds for
  your own daemon.

`scripts/android/build-on-phone.sh` passes the variable through untouched.

## Release builds and signing

`assembleRelease` needs your own signing key. The keystore is never committed: the
comments in `mobile/android/gradle.properties` say how to create one and which
properties to put in `~/.gradle/gradle.properties`. Public releases are cut by
`scripts/release/release.sh` ([releasing.md](releasing.md)).

## Side-by-side installs

```sh
(cd mobile/android && ./gradlew assembleDebug -PompPulseAppIdSuffix=.dev)
scripts/android/build-on-phone.sh debug -PompPulseAppIdSuffix=.dev     # the same on a phone
```

`-PompPulseAppIdSuffix=.dev` installs as `com.omppulse.app.dev` next to the release
app: its own data, its own runtime, its own token. Every authority and permission
uses `${applicationId}`, and the ports fall back automatically when the release
app's daemon already holds 7681/7690. The suffix must look like `.dev`
(dot-separated Java identifiers); Gradle rejects anything else.

### Private conversation transfer

`scripts/android/transfer-conversations.py` transfers a stable snapshot of
`~/.local/share/omp/sessions` and `blobs` between separate app installations.
It requires Linux `renameat2(RENAME_NOREPLACE)`, Python 3 and JDK 17. The signing
configuration must match the **destination APK**, not the source app.
Never put the archive or `request-state.json` on shared storage: both are private,
and the latter contains the loopback receipt credential.

From the source guest, prepare an empty private output directory:

```sh
python3 scripts/android/transfer-conversations.py prepare \
  --output-dir "$HOME/conversation-transfer" \
  --target-package com.omppulse.app.next --callback-port 18765
python3 scripts/android/transfer-conversations.py serve \
  --output-dir "$HOME/conversation-transfer" --port 18765
```

Keep the receipt listener running. From a second source-guest shell, use the
authenticated phone API to grant only the signed archive to the destination:

```sh
android intent --action com.omppulse.app.IMPORT_CONVERSATIONS \
  --package com.omppulse.app.next \
  --component com.omppulse.app.next/com.omppulse.app.runtime.ConversationImportActivity \
  --data "$HOME/conversation-transfer/transfer.jar" --type application/java-archive
```

The receiver authenticates every entry against its installed APK signing
certificate before publishing files. It stages in persistent app-private storage,
not reclaimable cache storage. Existing identical files are retained; different
files and symlink destinations are refused. A directly launched APK-native helper
publishes with `renameat2(RENAME_NOREPLACE)`: Android denies hard links, and an
ordinary rename could overwrite a concurrent destination. There is no replacement
fallback. Publication is followed by destination size/SHA-256 readback and a
paginated daemon session-index check. Compare the
authenticated `receipt.json` file list against `source-manifest.json`; intent
dispatch or a successful install alone does not prove a transfer.

Source files are never modified. Concurrent source changes abort preparation.
Ownership/lock files and symlinks are excluded; provider credentials, native
drafts/outbox and project contents are not transferred. Eligible missing working
directories under `/root/projects` or `/tmp` can be created without following
symlinks. An unset destination is prepared in phone mode; an existing laptop
configuration is not switched.

Limits include 512 MiB per data file, 4 GiB total, 100,000 ZIP entries and 64 KiB
of transfer properties. Additional pre-authentication signature limits apply:
4 MiB per manifest/signature text, 10,000 combined manifest/signature sections,
40,000 attributes and 4 MiB of retained text. Thus the ZIP-entry ceiling is not a
guarantee that 100,000 data files fit. Binary signature blocks are capped at
256 KiB each and 1 MiB combined. Both exporter and importer enforce these bounds.

A failed publication may leave already-published files intact. Preserve its
receipt, then retry the **same** signed archive after resolving the reported
phase/operation; do not overwrite destination chats or silently replace the
snapshot. Stop the receipt listener and remove its private archive/credential
only after successful verification. Android installation/security approvals
remain operator-only; never disable protection to force an update.

## The phone-mode daemon: `libomppulse.so`

`libomppulse.so` is not a library. It is the omp-pulse daemon as a static, non-PIE
`aarch64` musl executable, named `lib*.so` so Android extracts it to
`nativeLibraryDir`, the one place an app may exec from.
`scripts/android/build-runtime.sh` builds it into
`mobile/android/app/build/generated/runtime-jni/arm64-v8a/`, choosing the toolchain
in this order: natively on an aarch64 musl host (Alpine on a phone or an arm64 box),
a configured cross linker for `aarch64-unknown-linux-musl`, then `cargo zigbuild`.
Otherwise it stops and says how to get one. It uses a cargo target directory of its
own inside the checkout (override with `OMP_PULSE_RUNTIME_TARGET_DIR`).

- **It embeds `public/` like the desktop daemon**, so run it after the web build.
- **It never embeds `public/app-release.apk`.** That APK contains this library, so
  embedding it would nest every previous release inside the next. The build parks
  `public/app-release.apk` (and its `.json`) outside `public/` while compiling and
  restores it afterwards.
- **`gradle clean` deletes it**, because it lives under `app/build/`;
  `scripts/deploy/pulse-deploy.sh --clean` therefore cleans before building it.
- **It must be aligned for 16 KB pages.** The script refuses a library whose
  `PT_LOAD` alignment is smaller.

Gradle's `preBuild` checks every runtime input and fails naming the fix:
`libomppulse.so`, the four vendored proot libraries and `runtime.json`. It also
requires the Capacitor sync output (`npx cap sync android`).

The proot libraries in `mobile/android/vendor/proot/arm64-v8a/` are unmodified Termux
binaries; their versions, checksums, source offer and refresh procedure are in
[PROVENANCE.md](../../mobile/android/vendor/proot/PROVENANCE.md). They only run while
the APK keeps `useLegacyPackaging true` in `mobile/android/app/build.gradle` (see the
W^X note in [phone-mode internals](../internals/phone-mode.md#platform-constraints-the-runtime-works-around)).

## Building on the phone

`scripts/android/build-on-phone.sh [debug|release] [gradle args…]` builds the whole
APK on an arm64 phone, in the order the embedding rules require: web, cap sync,
runtime library, Gradle. It encodes what works with ~1.5 GB of free RAM:

- JDK 17 (`/usr/lib/jvm/java-17-openjdk`): Gradle under JDK 21 aborts there.
- The system `gradle` 8.x instead of the wrapper, which would download another
  Gradle and an x86_64-only toolchain around it.
- The arm64 `aapt2` from `~/android-sdk/tools-aarch64` (SDK build-tools ship an
  x86_64 one).
- Build-tools pinned by `scripts/android/build-on-phone.init.gradle`
  (`OMP_PULSE_BUILD_TOOLS`, default 36.0.0).
- `nice -n 19`, a 1280 MB serial-GC heap, two Gradle workers and two cargo jobs:
  anything bigger and the low-memory killer takes the build, or the phone's
  foreground apps.

Measured on the reference phone, `scripts/android/build-on-phone.sh debug` took
11 min 32 s end to end: the runtime library (`cargo`) 10 min 39 s producing a 14.3 MB
`libomppulse.so`, then Gradle 40 s. The debug APK was 11.7 MB.

## JVM tests

The app's JUnit tests live under `mobile/android/app/src/test/java/` and run with
Gradle's `testDebugUnitTest`:

```sh
(cd mobile && npx cap sync android)
scripts/android/build-runtime.sh
(cd mobile/android && JAVA_HOME=/path/to/jdk-21 ./gradlew testDebugUnitTest)
```

The sync and the runtime build are needed even for unit tests, because `preBuild`
checks their outputs. `scripts/ci.sh --full` runs all three. On the reference phone
the same tests passed via `:app:testDebugUnitTest` with the `build-on-phone.sh`
setup (JDK 17, system Gradle).

Logic that can be tested without Android (the notification stream's reconnect
backoff, native receipt recovery, attachment recovery) is covered by host-JDK
harnesses in `mobile/android/host-tests/`, which need no SDK or Gradle and run in the
default gate; see [testing.md](testing.md#android-host-jdk-harnesses).

## Runtime pins

`mobile/android/app/src/main/assets/runtime/runtime.json` pins every download the
phone runtime trusts (the Alpine repository and package list, the minirootfs and the
omp binary, per ABI) by sha256 and size. The app refuses any byte stream that
differs, so this file is the trust anchor of phone mode: a wrong pin breaks first run
on every phone, a stale one silently ships an old omp. Edit it only with
`scripts/android/runtime-pins.mjs`:

```sh
node scripts/android/runtime-pins.mjs --check                 # verify every pin against upstream
node scripts/android/runtime-pins.mjs --update-omp latest     # pin the newest omp release
node scripts/android/runtime-pins.mjs --update-omp v18.10.4   # or a specific tag
```

`--check` verifies every pin against upstream (GitHub's published asset digests,
Alpine's `.sha256` files, and the `Content-Length` each URL and mirror serves)
without downloading the large files. `--file <path>` operates on another
`runtime.json`; `GITHUB_TOKEN`, when set, lifts the anonymous API rate limit. The
tool uses the Node standard library only, so it runs on a phone without
`npm install`.

## Bumping omp

```sh
node scripts/android/runtime-pins.mjs --update-omp latest   # or a tag
node scripts/android/runtime-pins.mjs --check
```

`--update-omp` keeps each ABI's asset name, moves the tag, and pins GitHub's
published `digest` and `size`. Then rebuild the APK; installed phones replace omp on
their next `prepare()`.

## Adding an ABI

No Java change is needed:

1. Add an `abis.<android-abi>` entry to `runtime.json` (the Alpine rootfs for that
   architecture, the matching omp release asset), then run
   `node scripts/android/runtime-pins.mjs --check`; add the ABI to the tool's
   `ALPINE_ARCH` map if it is new to it.
2. Vendor the four Termux proot libraries for that ABI under
   `mobile/android/vendor/proot/<abi>/`, with checksums in `PROVENANCE.md`.
3. Teach `scripts/android/build-runtime.sh` the ABI's Rust musl target and install
   directory, and add the ABI to `abiFilters` in `mobile/android/app/build.gradle`.
