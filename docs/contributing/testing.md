# Testing

Every kind of test in the repository: where it lives, how it runs, and how to
add one. The gate, `scripts/ci.sh`, runs all of them; adding a test means adding
a file in the right folder, because every runner discovers its files.

## The gate

`scripts/ci.sh` is the gate, and its header lists the prerequisites. Hosted CI
(`.github/workflows/ci.yml`) runs its default tier on Linux for every push to
main and every pull request, split into two parallel jobs (`--group web`:
every step up to e2e helper tests; `--group rust`: cargo fmt onwards; both
build the web client first), plus `cargo test` on real macOS and Windows, which
the Linux gate can only cross-check (Windows) or not compile (macOS). Each
step prints its duration.

```sh
scripts/ci.sh              # default tier: no browser, emulator, container or model provider
scripts/ci.sh --group web  # one half of it (or --group rust)
scripts/ci.sh --full       # also the musl build, the Android JVM tests and every e2e tier
```

| Step (as `scripts/ci.sh` prints it) | Runs | Tier |
|---|---|---|
| web client (public/app) | `npm ci` in `web/` if needed, and the embedded client build if `public/app` is missing | default |
| docs match the code | `scripts/docs/check-docs.sh` | default |
| web typecheck | `npm --prefix web run typecheck` | default |
| web unit tests | `node --test` over `web/test/**/*.test.mjs`, at least three files at a time, with `NODE_COMPILE_CACHE` | default |
| extension and tooling tests | `node --test "extensions/test/*.test.mjs" "scripts/**/*.test.mjs"` | default |
| deploy scripts | `scripts/deploy/pulse-deploy.test.sh` | default |
| Android host-JVM tests | every `mobile/android/host-tests/*/run.py` | default |
| phone harness tests | `python3 -m unittest discover -s phone-harness/tests` | default |
| e2e helper tests | `python3 -m unittest discover -s e2e/daemon -p 'test_*.py'` | default |
| cargo fmt --check | | default |
| cargo clippy -D warnings | `cargo clippy --locked --release --all-targets -- -D warnings` | default |
| cargo build --release | `cargo build --locked --release` | default |
| cargo test --release | `cargo test --locked --release` | default |
| windows cross-check | `cargo check --locked --target x86_64-pc-windows-gnu --all-targets` | default |
| windows zero warnings | `cargo build --locked --release --target x86_64-pc-windows-gnu` with `-Dwarnings` | default |
| e2e: daemon | `e2e/run.sh daemon` | default |
| fresh-machine acceptance | `bash e2e/fresh-install.sh` | default |
| musl static build | `cargo build --release --locked --target x86_64-unknown-linux-musl` in Docker | `--full` |
| Android unit tests | `npx cap sync android`, `scripts/android/build-runtime.sh`, then `./gradlew testDebugUnitTest` | `--full` |
| e2e: omp / browser / android | `e2e/run.sh omp`, `browser`, `android` | `--full` |

Paste its final summary (`N passed, M failed`) into the pull request.

## Rust: unit and integration tests

- **Where:** a single-file module keeps its unit tests inline in
  `#[cfg(test)] mod tests`; a module with a directory keeps them in
  `<module>/tests.rs`, with larger topic suites in `<module>/tests/<topic>.rs`
  declared from it. Integration tests against the public API are in `tests/`.
- **Run:** `cargo test --release`. Hermetic and offline.
- **Rules:** a test that sets environment variables must use
  `paths::testenv::set_env_owned` (a process-wide lock; the guard restores every
  changed variable when it drops) and set every `XDG_*` variable it depends on.
  To change more under a lock you already hold, use `EnvGuard::set`; a raw
  `std::env::set_var` corrupts other tests at random. Use
  `paths::testenv::scratch()` for temporary directories.
- **Portability:** hosted CI runs these tests on Linux, macOS and Windows. Join
  fixture paths by component, never with `/` in one string; canonicalize a
  fixture root when the code under test canonicalizes; gate a test of
  single-platform behaviour with `#[cfg(unix)]` or `#[cfg(target_os = "linux")]`
  and say why in a comment.
- **Add one:** in the module's tests (inline or `<module>/tests.rs`, as above), or
  a new file in `tests/` for behaviour visible only through the crate's public API.

## Web client unit tests

- **Where:** `web/test/<name>.test.mjs`, with shared helpers in
  `web/test/support/` and JSON fixtures in `web/test/fixtures/`.
- **Run:** `npm test` in `web/` (Node's built-in `node --test` over
  `test/**/*.test.mjs`). No daemon, browser or model. The gate runs the same
  files at least three at a time and with `NODE_COMPILE_CACHE`, because Node's
  default runs only one at a time on a 2-vCPU machine.
- **How they load `web/src`:** pure modules are imported directly as `.ts`
  files; Node strips the types itself, so no build step is involved. Tests that
  need React render through `web/test/support/react-dom.mjs`, which bundles a
  fixture with rolldown (resolving `@` to `web/src`) and mounts it in jsdom: real
  React state, effects and events on a synthetic DOM, with no layout.
  VM fixtures that need non-erasable TypeScript syntax, such as parameter
  properties, use Vite's `transformWithOxc`; Node 26's
  `stripTypeScriptTypes` supports stripping only, not transform mode.
- **Includes** the focused stability regressions that need no daemon, for
  example `controller-races`, `outbox-deadline`, `request-deadlines`,
  `outbox-hydration-race` and `session-pagination`.
- **Add one:** a new `web/test/<name>.test.mjs`; `npm test` picks it up.

`npm run typecheck` (`tsc --noEmit`) is a separate gate step.

## Extension and tooling tests

- **Where:** `extensions/test/*.test.mjs` (the two omp extensions; see
  [extensions/README.md](../../extensions/README.md)) and any
  `scripts/**/*.test.mjs` (today `scripts/ui/review-daemon.test.mjs`).
- **Run:** `node --test "extensions/test/*.test.mjs" "scripts/**/*.test.mjs"`.
- **Add one:** a `*.test.mjs` in either place.

## Deploy-script test

`scripts/deploy/pulse-deploy.test.sh` checks target selection, idle waiting and
binary cutover of the deploy scripts against sandboxed commands. Extend it when
you change `scripts/deploy/`.

## Android host-JDK harnesses

- **Where:** `mobile/android/host-tests/<name>/run.py`, one folder per harness.
- **What:** they extract production Java from the app, compile it with the host
  JDK against small fakes of the Android classes, and run it. No Android SDK,
  Gradle or device.
- **Run:** `python3 mobile/android/host-tests/<name>/run.py`.
- **Add one:** a new folder with a `run.py`; the gate runs every one.

Why they live outside Gradle's unit-test source set, and each harness's scope, is in
[mobile/android/host-tests/README.md](../../mobile/android/host-tests/README.md).

## Android JVM tests (Gradle)

- **Where:** `mobile/android/app/src/test/java/`.
- **Run:** `./gradlew testDebugUnitTest` in `mobile/android`, after the Capacitor
  sync and the phone-mode runtime build; `scripts/ci.sh --full` does all three.
  Needs JDK 21 and the Android SDK.
- **Add one:** a JUnit class under that tree.

Details are in [docs/contributing/android.md](android.md#jvm-tests).

## Phone-harness tests

- **Where:** `phone-harness/tests/test_*.py`.
- **Run:** `python3 -m unittest discover -s phone-harness/tests`.
- **Add one:** a `test_*.py` file there.

## End-to-end suites

Real daemon, real `omp` children (about 280 MiB each), and in some suites real
model calls. Grouped in tiers by what they need: `e2e/daemon/` (default gate),
`e2e/omp/`, `e2e/browser/` and `e2e/android/` (`--full`). Run with
`e2e/run.sh <tier|suite>`. [e2e/README.md](../../e2e/README.md) lists every
suite, the isolation the harness provides, the overrides and how to add one. The
model-free Tern adoption suite, `e2e/omp/verify-tern-adoption.py`, needs Linux,
`tern`, `xvfb-run`, `Xvfb` and GL or software rendering (it runs a real private
Tern GUI); it skips with a named reason when one is missing, and
`OMP_PULSE_TEST_REQUIRE_TERN=1` makes that skip a failure. Its cases are a manual
old share then stop, unshared refusal, active adoption, draft unchanged and no GUI.

Three rules, all learned the hard way:

1. **Only through the harness** (`e2e/run.sh` or `e2e/with-test-daemon.sh`).
   Never point a suite at a daemon you did not start.
2. **Never port 7682, never a real session file** under
   `~/.local/share/omp/sessions`. Those belong to live conversations.
3. **Alone.** Concurrent cargo builds or suites cause false failures that mimic
   regressions.

## Other checks outside the gate

- Benchmarks: [docs/contributing/benchmarks.md](benchmarks.md).
- UI state capture and review: [docs/contributing/ui-review.md](ui-review.md).
- Checks against a deployed daemon: [docs/contributing/deploying.md](deploying.md#checks-against-a-deployed-daemon).
