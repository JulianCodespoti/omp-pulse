# Contributing

Thanks for your interest. omp-pulse is a small project: a Rust daemon, a React web
client and a Capacitor Android app. Bug reports, fixes and focused features are
welcome. For anything large, open an issue first so we can agree on the shape
before you write it.

Security problems are not reported here: see [SECURITY.md](SECURITY.md).
Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

If you use an AI coding agent, point it at [AGENTS.md](AGENTS.md); the rules there
apply to humans too. All documentation is indexed in [docs/README.md](docs/README.md).

## Setup

The development host is assumed to be Linux (x86_64 or arm64). macOS works for
the daemon and web client.

### Web client (React/Vite)

Build it first: the daemon embeds `public/app` at compile time and `build.rs`
refuses to build without it. Needs Node.js matching `web/package.json`
"engines" (22.22+, 24.15+ or 26+) and npm.

```sh
cd web
npm ci
npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false
npm test                # unit tests
npm run typecheck       # tsc --noEmit
```

Rebuild the Rust binary after a web change: the client is embedded at compile
time. Never edit `public/app` by hand; it is generated. `npm run build` writes
`web/dist`, which nothing uses. Boundaries inside the client are in
[web/AGENTS.md](web/AGENTS.md).

### Daemon (Rust)

Rust 1.95 or newer (`rust-version` in `Cargo.toml`) via
[rustup](https://rustup.rs), with `rustfmt` and `clippy`.

```sh
cargo build --release          # binary at target/release/omp-pulse
cargo test --release           # hermetic, offline
```

To try it against your own omp sessions, run `target/release/omp-pulse setup`,
then `target/release/omp-pulse serve`. To serve a working copy of the web client
instead of the embedded one, pass `--public-dir public`.

### Android app (Capacitor)

Needs JDK 21, the Android SDK and an aarch64 musl toolchain for the phone-mode
daemon. Building on a laptop or on the phone, side-by-side installs, runtime
pins and bumping omp are in [docs/contributing/android.md](docs/contributing/android.md).

## The gate

`scripts/ci.sh` is the gate, and it must pass before you open a pull request.
Hosted CI runs it on Linux for every pull request, plus `cargo test` on real
macOS and Windows (`.github/workflows/ci.yml`); running it locally first saves
a round trip.

```sh
scripts/ci.sh              # default tier
scripts/ci.sh --group web  # only the non-cargo steps (or --group rust: only the cargo ones)
scripts/ci.sh --full       # also the musl build, the Android JVM tests and every e2e tier
```

The default tier runs, in order: web client (public/app), docs match the code,
web typecheck, web unit tests, extension and tooling tests, deploy scripts,
Android host-JVM tests, phone harness tests, e2e helper tests, cargo fmt
--check, cargo clippy -D warnings, cargo build --release, cargo test --release,
windows cross-check, windows zero warnings, e2e: daemon, fresh-machine
acceptance. `--full` adds musl static build, Android unit tests, e2e: omp,
e2e: browser and e2e: android. What each step runs is in
[docs/contributing/testing.md](docs/contributing/testing.md#the-gate).

Prerequisites (the script's header is authoritative):

- Rust stable with `rustfmt` and `clippy`, the Windows target and a MinGW-w64 C
  compiler, which `ring` needs:

  ```sh
  rustup target add x86_64-pc-windows-gnu
  sudo apt install gcc-mingw-w64-x86-64      # Debian/Ubuntu; provides x86_64-w64-mingw32-gcc
  ```

- Node.js per `web/package.json` "engines", and npm.
- python3, a JDK 17 or newer with `java` on PATH, curl, jq.
- `omp` on PATH is optional: the daemon tier skips its live-child checks
  without it and names them.
- `--full` only: Docker (`DOCKER="sudo docker"` if your user cannot reach the
  Docker daemon); `omp` with a model provider configured (`OMP_PULSE_TEST_MODEL`
  picks the model; several suites make real model calls); Chromium
  (`OMP_PULSE_CHROMIUM`); `herdr`; and for the Android steps the Android SDK,
  JDK 21 (`OMP_PULSE_JDK`), an aarch64 musl toolchain and an AVD.

Zero warnings on both the host and `x86_64-pc-windows-gnu` is part of the gate:
Windows-only warnings are invisible from a host build.

The end-to-end suites spawn real omp children and some make real model calls.
Run them only through `e2e/run.sh` (or `e2e/with-test-daemon.sh`), one at a
time, and never against your own daemon; [e2e/README.md](e2e/README.md) explains
why.

## Where things live

| Path | What |
|---|---|
| `src/` | the daemon (Rust): `server/` (HTTP, WebSocket, push, pairing), `omp/` (driving omp processes), `sessions/` (session files on disk), `authority/` (who may write each session), `terminal/` (the laptop's terminals), `bin/omp-pulse/` (the binary), plus crate-wide modules |
| `tests/` | Rust integration tests |
| `web/` | the React/Vite client; `web/test/` holds its unit tests |
| `website/` | static product & documentation website generator (`node website/build.mjs`), verified by `website/site.test.mjs` and published via `.github/workflows/website.yml` |
| `mobile/` | the Capacitor Android app; `mobile/android/` is the Gradle project, `mobile/android/host-tests/` the host-JDK harnesses |
| `extensions/` | the two omp extensions the daemon embeds, and the `pulse-plugin` skill it installs into omp ([README](extensions/README.md)) |
| `examples/` | example plugins, one folder each ([guide](docs/user/plugins.md)) |
| `phone-harness/` | the phone agent's optional tools, shipped in the APK ([README](phone-harness/README.md)) |
| `e2e/` | end-to-end suites in tiers by what they need ([README](e2e/README.md)) |
| `bench/` | benchmarks against an isolated daemon |
| `scripts/` | maintainer tooling by purpose: `ci.sh`, `android/`, `deploy/`, `docs/`, `release/`, `ui/` ([README](scripts/README.md)) |
| `docs/` | documentation by reader: `user/`, `contributing/`, `internals/`, plus `media/` ([index](docs/README.md)) |
| `public/` | generated: the built web client (`public/app`) and published APK, embedded into the binary at compile time |

## Where new things go

| You are adding | Put it in | Then |
|---|---|---|
| a daemon feature | the `src/` subsystem it belongs to (see the table above and [docs/internals/modules.md](docs/internals/modules.md)) | every `.rs` file starts with a `//!` header stating its job; run `scripts/docs/codemap.sh` |
| a web feature | `web/src/`, respecting the boundaries in [web/AGENTS.md](web/AGENTS.md) | |
| a web unit test | `web/test/<name>.test.mjs` | picked up by `npm test` |
| an end-to-end suite | `e2e/<tier>/verify-<name>.mjs` or `.py`, tier by what it needs | picked up by `e2e/run.sh`; see [e2e/README.md](e2e/README.md#adding-a-suite) |
| an Android JVM test | `mobile/android/app/src/test/java/` | run by `scripts/ci.sh --full` |
| an Android host-JDK harness | `mobile/android/host-tests/<name>/run.py` | picked up by the gate; see [its README](mobile/android/host-tests/README.md) |
| a Rust test | the module's tests: inline `mod tests` in a single-file module, `<module>/tests.rs` in a module with a directory; or `tests/` for the public API | run by `cargo test` |
| a script | `scripts/<purpose>/` | header comment with usage; a line in [scripts/README.md](scripts/README.md) |
| a doc page | `docs/user/`, `docs/contributing/` or `docs/internals/` by reader | link it from [docs/README.md](docs/README.md) |
| a phone tool | `phone-harness/`: an `android` subcommand or a script in `phone-harness/bin/` | per [phone-harness/AGENTS.md](phone-harness/AGENTS.md) |

How each kind of test runs: [docs/contributing/testing.md](docs/contributing/testing.md).
Other guides: [deploying](docs/contributing/deploying.md) to your own daemon,
[releasing](docs/contributing/releasing.md) and forks,
[benchmarks](docs/contributing/benchmarks.md), [UI review](docs/contributing/ui-review.md)
(including the README media).

## Style

- `cargo fmt`; clippy clean with `-D warnings`.
- No `unwrap()`/`expect()` outside tests; never hold a lock across `.await`.
- Platform-specific code is `#[cfg(...)]`-gated with a working fallback: the
  daemon builds for Linux, macOS and Windows.
- No new dependency may pull `openssl-sys` (`cargo tree -i openssl-sys` must find
  nothing).
- Comments explain why, especially when they name the bug that motivated the code.
- Every `src/**/*.rs` starts with a `//!` header. `docs/internals/modules.md` is
  generated from those headers: run `scripts/docs/codemap.sh` after changing one.
- British/neutral English in user-facing strings, no emoji.
- Never log tokens, collab links, push endpoints or session content.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep one logical change per pull request. Unrelated clean-ups go in their own PR.
3. Write a short summary in conventional style, for example
   `fix(watcher): resync a client that fell behind` or
   `feat(web): show queued prompts as chips`. Explain what changed and why.
4. Add or update tests for behaviour changes, and update docs that describe the
   behaviour you changed. Add a line under `## [Unreleased]` in
   [CHANGELOG.md](CHANGELOG.md) for anything a user or contributor would notice.
5. Run `scripts/ci.sh` and paste its final summary into the PR description.
   Say which E2E suites you ran, if any.
6. Fill in the pull request template checklist.
