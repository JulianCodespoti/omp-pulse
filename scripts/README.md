# scripts/

Maintainer tooling, grouped by purpose. Every script's header comment states
its usage and why it exists; the guides linked below explain how they fit
together.

## The gate

- `ci.sh`: the gate (hosted CI runs it on every pull request); `--full` adds
  the musl build, the Android JVM tests and every e2e tier. See
  [docs/contributing/testing.md](../docs/contributing/testing.md).

## `android/`: building the APK and its runtime

See [docs/contributing/android.md](../docs/contributing/android.md).

- `build-runtime.sh`: builds the phone-mode daemon (`libomppulse.so`, an aarch64
  musl executable) into the APK's jniLibs.
- `build-on-phone.sh [debug|release] [gradle args...]`: builds the whole APK on
  an arm64 phone.
- `build-on-phone.init.gradle`: Gradle init script used by `build-on-phone.sh`
  (pins build-tools for the phone SDK).
- `runtime-pins.mjs --check | --update-omp <tag|latest>`: verifies and bumps the
  sha256 and size pins in the APK's `runtime.json`; the only thing that should
  write that file.
- `install-phone.sh [--no-build]`: builds the signed release APK in stage
  order and installs it on an adb-paired phone, then checks the phone serves
  the new release ID. Never touches the desktop daemon.

## `deploy/`: putting a change live on your own daemon

See [docs/contributing/deploying.md](../docs/contributing/deploying.md).

- `pulse-deploy.sh`: the build-and-deploy pipeline (web, Capacitor, runtime
  library, Gradle, cargo, restart) in its load-bearing order.
- `pulse-restart.sh`: waits until no daemon-hosted turn is running, then
  installs the binary, restarts and verifies the release ID; `--status`,
  `--cancel`, `--force`.
- `pulse-target.sh`: sourced helper that finds the running service and its
  HTTPS endpoint.
- `pulse-deploy.test.sh`: sandboxed test of the scripts above (in the gate).
- `verify-as-user.mjs`, `verify-perf.mjs`, `verify-herdr-alignment.py`:
  read-only checks against a deployed daemon (not in the gate).

## `docs/`: keeping the docs true

- `check-docs.sh`: asserts the docs match the code (generated module index,
  `//!` headers, checkable claims in the architecture doc, every path and
  link). In the gate.
- `codemap.sh`: regenerates [docs/internals/modules.md](../docs/internals/modules.md)
  from the `//!` header of every `src/**/*.rs`.
- `capture-readme-media.mjs`: regenerates the screenshots and GIF in
  `docs/media/`; see [docs/contributing/ui-review.md](../docs/contributing/ui-review.md).

## `release/`: public releases and forks

See [docs/contributing/releasing.md](../docs/contributing/releasing.md).

- `release.sh [--draft|--publish]`: builds the signed public APK and the
  proot/talloc sources, attaches them to the tag's release and optionally
  publishes it.
- `targets.json`: the daemon targets every release ships (the release
  workflow's build matrix).
- `package.sh <bins-dir> <out-dir>`: packs those binaries into the archive
  names the installers expect.
- `publish-assets.sh <tag> <dir> [--publish]`: uploads to the tag's release
  and rewrites `SHA256SUMS` over every asset it holds.
- `release-id.sh`: prints the release ID of the source tree.
- `third-party-licenses.mjs <outDir>`: writes the licence notices of every
  bundled crate and npm package (run by every web build).
- `set-repo.sh <owner> [name]`: points every repository reference at a fork.

## `ui/`: looking at the web client

See [docs/contributing/ui-review.md](../docs/contributing/ui-review.md).

- `states/capture.mjs`: photographs every UI state against a baseline (with
  its recipes, fixtures and review tooling beside it in `states/`).
- `review-daemon.sh`: a long-lived isolated daemon seeded with synthetic
  sessions for UI review.
- `review-daemon.test.mjs`: its test (in the gate).

## Where a new script goes

- In the folder for its purpose; a new purpose gets a new folder.
- It starts with a header comment: usage, and why it exists.
- A `*.test.mjs` anywhere under `scripts/` is run by the gate's "extension and
  tooling tests" step.
- Anything that starts a daemon must start its own through
  `e2e/with-test-daemon.sh`, never reach port 7682.
- Add a line to this file.

End-to-end suites are not scripts: they go in [e2e/](../e2e/README.md).
Benchmarks are in `bench/` ([docs/contributing/benchmarks.md](../docs/contributing/benchmarks.md)).
