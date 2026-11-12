# AGENTS.md

Instructions for AI coding agents (and humans) changing this repository: the
things that are easy to get wrong without being told. For layout, use search:
every `src/**/*.rs` starts with a `//!` header stating its job, and
`docs/internals/modules.md` is the generated index. The repository map and
where new things go are in [CONTRIBUTING.md](CONTRIBUTING.md); every other doc
is indexed in [docs/README.md](docs/README.md).

## What this is

`omp-pulse` is a single-binary Rust daemon (tokio/axum) with an embedded React web
client. It lets a phone browse and drive [omp](https://github.com/can1357/oh-my-pi)
coding sessions over authenticated HTTP/WebSocket APIs. The same web client ships
in a Capacitor Android app, which can also run omp and the daemon on the phone
itself ("phone mode").

Live data reaches the phone four ways: `omp --mode rpc-ui` children the daemon
spawns (`src/omp/child.rs`), the desktop bridge extension (`src/omp/bridge.rs`),
the collab relay (`src/omp/collab.rs`), and session-file tailing
(`src/sessions/watcher.rs` → `src/sessions/jsonl.rs`). `src/server/ws.rs` is
the bounded per-client fan-out hub; `src/server/delta.rs` encodes streaming
text deltas. Why four, and how they meet:
[docs/internals/architecture.md](docs/internals/architecture.md#the-live-paths-and-why-there-are-four).

## The gate: `scripts/ci.sh`

`scripts/ci.sh` is the gate. Hosted CI (`.github/workflows/ci.yml`) runs it on
Linux for every push to main and every PR, as two parallel jobs
(`--group web` and `--group rust`), plus `cargo test` on real macOS and
Windows. Run it before every commit; to add a check, add it to `ci.sh` inside
the group it belongs to.

```sh
scripts/ci.sh          # web client (public/app), docs match the code, web typecheck,
                       # web unit tests, extension and tooling tests, deploy scripts,
                       # Android host-JVM tests, phone harness tests, e2e helper tests,
                       # cargo fmt --check, cargo clippy -D warnings, cargo build --release,
                       # cargo test --release, windows cross-check, windows zero warnings,
                       # e2e: daemon, fresh-machine acceptance
scripts/ci.sh --group web|rust   # one half: the non-cargo steps, or the cargo ones
scripts/ci.sh --full   # adds musl static build, Android unit tests, e2e: omp, e2e: browser,
                       # e2e: android
```

Prerequisites are in its header (JDK 17+ with `java` on PATH; the
`x86_64-pc-windows-gnu` target and MinGW-w64). Every test kind and how to add
one: [docs/contributing/testing.md](docs/contributing/testing.md).

**Two targets, both at zero warnings.** `cargo build --release` and
`cargo build --release --target x86_64-pc-windows-gnu` must each emit zero
warnings. Windows-only warnings are invisible from a host build. Platform-gated
code is real here: `src/bin/omp-pulse/term.rs` compiles only on Unix
(`src/bin/omp-pulse/main.rs` supplies a Windows stub), and
`src/terminal/adopt.rs` compiles everywhere but is unreachable on Windows.
Check both targets after touching either.

## Changing the web client: the fast loop

A UI change should cost the edit plus a few minutes of checks. In order:

1. **Look at it** with the state camera, not a hand-driven browser:
   `node scripts/ui/states/capture.mjs --serve --vite` keeps a throwaway
   daemon, corpus, vite and headless Chromium up; each Enter re-shoots in
   seconds (`--only <id>` for one state). Shots land in `audit/ui-states.html`
   with a diff against the baseline. A new screen or state gets a recipe in
   `scripts/ui/states/recipes.mjs`. Do not drive a shared desktop browser for
   this: a backgrounded tab renders no frames, so screenshots show stale
   state and timing-based checks lie. [Details](docs/contributing/ui-review.md).
2. **Check it**: `cd web && npx tsc --noEmit -p . && npm test` (about a
   minute), then `scripts/ci.sh --group web`. The full gate runs before the
   commit.
3. **Browser suites only where the change reaches**: grep the `data-testid`s
   you touched under `e2e/browser/` and run those suites with `e2e/run.sh
   <suite>`. The whole tier (`e2e/run.sh browser`, ~16 min) is for changes to
   navigation, the transcript or the composer, and before merging. Rebuild
   first (`public/app` then `cargo build --release`): suites serve the
   embedded client.
4. **On the phone**: `scripts/android/install-phone.sh` builds the signed APK
   in stage order, installs it over adb and checks the phone serves the new
   release ID.

An agent harness that formats on write (omp's `lsp.formatOnWrite`) reflows all
of `web/src/styles.css` on any edit: blank lines everywhere and `a > b`
squashed to `a>b`, which also breaks the unit tests that parse its selectors.
If an edit's diff balloons, restore the file and reapply only your lines.

**One route per job; no legacy paths.** When a flow is replaced (connecting a
computer, switching machines, pairing), delete the old one in the same change:
its UI, its bridge method on both sides (`web/src/platform/local-mode.ts` and
`mobile/.../bridge/*.java`), its stubs and its tests. Do not keep "older shell"
fallbacks or `typeof bridge.x === "function"` checks: the APK and the web client
it shows are built and shipped together (`scripts/android/install-phone.sh`,
`scripts/deploy/pulse-deploy.sh`). Every entry point to a job (a settings row,
the pair screen, a scanner) calls the same function; a second implementation
is how a scan ended up on a route that only half-worked.

## `public/` is a compile-time input

`include_dir!` bakes `public/` into the binary when cargo compiles, and cargo
cannot see that on its own. `build.rs` emits `cargo:rerun-if-changed` for the
whole tree and refuses to build when `public/app/index.html` is missing (a binary
without it 404s `/app/` while looking healthy). A `public/` or `web/` change
therefore needs a rebuild of the Rust binary. Any new directory embedded at
compile time MUST be declared in `build.rs`. The web build command is in
[CONTRIBUTING.md](CONTRIBUTING.md#web-client-reactvite); `npm run build` writes
`web/dist`, which nothing embeds.

## Deploy order is load-bearing

`scripts/deploy/pulse-deploy.sh` is the pipeline for shipping a change to your
own daemon: web → Capacitor → `scripts/android/build-runtime.sh` → Gradle →
cargo → `scripts/deploy/pulse-restart.sh`. Improve it rather than running ad-hoc
build sequences. Everything that writes into `public/` must finish before cargo
embeds it; building cargo before Gradle once made every binary serve the
previous release's APK.

The restart waits until no daemon-hosted turn is running, then checks that the
built and live release IDs match (a 200 on `/app/` proves nothing).
`scripts/deploy/pulse-restart.sh --status` reports what it is waiting on. Do not
bypass the wait with `--force`/`--force-restart` or a bare `systemctl restart`
unless the person running the daemon asks: a restart kills every turn the
daemon hosts. Details: [docs/contributing/deploying.md](docs/contributing/deploying.md).

## Phone mode

Building the APK, runtime pins and bumping omp:
[docs/contributing/android.md](docs/contributing/android.md); the runtime itself:
[docs/internals/phone-mode.md](docs/internals/phone-mode.md). The rules:

- `libomppulse.so` is the daemon as a static aarch64 musl executable, not a
  library. `scripts/android/build-runtime.sh` builds it into
  `mobile/android/app/build/generated/runtime-jni/arm64-v8a/`; Gradle fails
  without it and `gradle clean` deletes it.
- Edit `mobile/android/app/src/main/assets/runtime/runtime.json` only with
  `node scripts/android/runtime-pins.mjs --update-omp <tag|latest>`, then
  `--check`. A wrong pin breaks first run on every phone.
- `mobile/android/vendor/proot/arm64-v8a/*.so` are unmodified Termux binaries
  (see `PROVENANCE.md` there) and only run while the APK keeps
  `useLegacyPackaging true`.
- Gradle needs JDK 21 (a newer JDK fails in jlink); set `OMP_PULSE_JDK`.

## Tests that touch the outside world

`cargo test` is hermetic. The suites under `e2e/` are not: they spawn real
`omp --mode rpc-ui` children (about 280 MiB each) and some make real model
calls. Rules:

1. **Always run them through the harness**: `e2e/run.sh <tier|suite>`, or
   `e2e/with-test-daemon.sh <command>` by hand. It creates a throwaway port,
   token, sessions root, state directory, runtime directory and herdr session.
   Never point a suite at a daemon you did not start (the conventional
   real-daemon port 7682 is refused), never write to a session file under
   `~/.local/share/omp/sessions`, and never fall back to a real token when the
   harness variables are missing: fail with a clear message instead. A suite
   that once reached a real daemon delivered its test prompts into a live
   conversation.
2. **Run them alone.** Concurrent cargo builds cause false failures that look
   exactly like regressions.

Tiers, every suite and its overrides: [e2e/README.md](e2e/README.md). Fixture
session `cwd`s must exist on disk, or omp cannot switch into them. After
changing `src/sessions/watcher.rs`, `src/server/ws.rs` or `src/server/delta.rs`,
run the memory bench ([docs/contributing/benchmarks.md](docs/contributing/benchmarks.md)),
not just unit tests.

## Dependencies: no OpenSSL

No dependency may pull `openssl-sys`, on any target: it breaks the Windows and
musl builds. Web Push (RFC 8291 encryption, RFC 8292 VAPID) is implemented in
`src/server/push.rs` over `p256`/`hkdf`/`aes-gcm`/`ureq` for exactly this reason.
`tokio-tungstenite` uses `rustls-tls-native-roots`, never `native-tls`. `termios` is
a Unix-only dependency. After editing `Cargo.toml`, check:

```sh
cargo tree -i openssl-sys     # "did not match any packages" is the pass
cargo check --target x86_64-pc-windows-gnu --all-targets
```

## Invariants worth knowing before you edit

- **One writer per session file.** omp rewrites a session file wholesale from
  memory, so a second writer destroys history. Route writes through the existing
  ownership decision (`src/authority/guard.rs`, `src/authority/owner.rs`,
  `src/omp/child.rs`, `src/omp/collab.rs`). When no detection layer can prove
  who owns a file, refuse and tell the user to share with `/collab`; never write
  and hope.
- **Bounded hot path.** The watcher skips reading and parsing when no client is
  listening. `ws.rs` caps each client by frame count and bytes, and a client over
  either cap gets one resync order. `delta.rs` deltas are keyed by `base_seq`; a
  client that fell behind must get a full snapshot. Never add unbounded buffering.
- **State paths.** Legacy `~/.omp/omp-remote.*` state is copied to the new state
  directory, never moved, and migration never overwrites an existing file.
  Configuration precedence: CLI flag, then `OMP_PULSE_*` env (legacy
  `OMP_REMOTE_*` accepted), then `config.toml`, then the default.
- Tests that set environment variables must use `paths::testenv::set_env_owned`
  (a process-wide lock; the guard restores every changed variable when it drops)
  and set every `XDG_*` variable they depend on. To change more under a lock you
  already hold, use `EnvGuard::set`. A raw `std::env::set_var` corrupts other
  tests at random.
- Tests must pass on Linux, macOS and Windows (hosted CI runs all three). Build
  fixture paths by component (`dir.join("a").join("b")`, not `"a/b"`), and
  canonicalize a fixture root when the code under test canonicalizes (macOS
  temp is behind `/var` → `/private/var`; Windows temp is an 8.3 name). A test
  of behaviour that exists on one platform only gets `#[cfg(unix)]` or
  `#[cfg(target_os = "linux")]` with a comment saying why.
- Never hold a mutex or other blocking lock across `.await`. No `unwrap`/`expect`
  outside tests or genuinely infallible local operations.
- Never log tokens, collab links, push endpoints or session content.

## Conventions

- Comments explain WHY, and name the bug that motivated the code. Several are
  load-bearing history; do not compress them into restatements.
- `// INVARIANT:` marks a rule the code depends on. Read it before editing nearby.
- `docs/internals/modules.md` is generated: change the module's `//!` header and
  run `scripts/docs/codemap.sh`. `scripts/docs/check-docs.sh` (part of the gate)
  fails when the index drifts, a path or link in a doc does not exist, or a
  checkable claim in `docs/internals/architecture.md` stops being true.
- The GitHub owner/repo appears in many files. Never hand-edit it: run
  `scripts/release/set-repo.sh <owner> [name]`.
- User-facing strings: British/neutral English, no emoji.

## Commands with real side effects

- `omp-pulse push-test` sends real notifications to subscribed devices.
- `scripts/release/release.sh --publish` publishes a public GitHub release.
- Pushing a `v*` tag starts `.github/workflows/release.yml`, which attaches
  daemon archives to that tag's (draft) release.
- Restarting the daemon service ends every turn it hosts.
