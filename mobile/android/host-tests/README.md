# Android host-JDK harnesses

Fast, hermetic checks of the Android app's Java that run with nothing but
`python3` and a JDK (17 or newer, `java` on PATH): no Android SDK, Gradle,
emulator, device, external network or daemon. Each harness compiles production
methods or classes from `mobile/android/app/src/main/java/`, either intact or
extracted verbatim, with small fakes for any Android and `org.json` classes it
touches. The availability transport uses a local loopback HTTP server. The
default gate (`scripts/ci.sh`) runs every harness.

| Harness | What it checks |
|---|---|
| `notify-backoff/` | the native notification stream's reconnect backoff |
| `native-receipts/` | the native outbox's receipts, delivery and SQLite migration ([README](native-receipts/README.md)) |
| `native-attachments/` | the native attachment recovery ([README](native-attachments/README.md)) |
| `busy-lock-policy/` | timed busy leases, report ownership and daemon client behaviour |
| `native-lifecycle/` | shell timer/connectivity ownership and persistent outbox job recovery |
| `native-outbox-changes/` | per-WebView outbox change-channel ownership and coalescing |
| `phone-stop/` | stopping phone mode: explicit unset persists even in baked builds, credentials survive, no listener or token write while unset, and real subprocesses mimicking proot (SIGTERM ignored, SIGQUIT kills the guest) are shut down with their guest. The subprocess proofs need Linux (`/proc`, `/bin/sh`, `kill`); elsewhere they print a `SKIP` line and the logical checks still run |
| `computer-probe/` | the stopped-phone chooser's saved-computer availability checks: a real GET against a loopback server (200 online; 502/404, a redirect, a refusal and a silent server offline; no `Authorization`/`Cookie` header, no redirect followed, read deadline respected) and the single-flight, bounded, cancel-fenced sweep policy. The only network use in this folder is 127.0.0.1 |

## Why outside Gradle's unit-test source set

The fakes define classes in the `android.*` and `org.json` packages. In
`mobile/android/app/src/test` they would collide with the real classes on
`android.jar`, and Gradle would need the full SDK and the phone-mode runtime
build just to run them. Out here they compile against the fakes alone, so they
run in seconds on any machine with a JDK. JVM tests that need the real Android
classpath belong in `mobile/android/app/src/test/java/` instead (see
[docs/contributing/android.md](../../../docs/contributing/android.md#jvm-tests)).

These are source-bound proofs, not Android runtime acceptance. The receipt and
attachment harness READMEs describe their additional limits.

## Running

From the repository root:

```sh
python3 mobile/android/host-tests/notify-backoff/run.py          # one
for r in mobile/android/host-tests/*/run.py; do python3 "$r"; done   # all, as the gate does
```

`native-receipts` and `native-attachments` also take `--mutations` (recompile
deliberately broken fixtures and require each to fail) and `--output DIR`
(keep the generated sources and evidence).

## Adding a harness

Create `mobile/android/host-tests/<name>/run.py` that exits non-zero on failure.
The gate picks up any folder with a `run.py`; there is nothing to register.
Extract production code mechanically rather than copying it, so the harness
fails when the source drifts, and add a `README.md` stating what is real and
what is faked.
