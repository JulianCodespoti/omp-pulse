# Phone mode internals

This page covers how the Android app runs omp and the omp-pulse daemon on the phone
itself: the runtime's architecture, its endpoints, install steps, upgrade policy and
the phone-harness wiring. Using phone mode is described in
[docs/user/phone-mode.md](../user/phone-mode.md); building the APK in
[docs/contributing/android.md](../contributing/android.md). The daemon's own
architecture is in [architecture.md](architecture.md).

The Capacitor shell installs a small Alpine Linux guest, runs `omp` and an
`omp-pulse` daemon inside it under proot, and points its WebView at that daemon. The
same APK can instead connect to a laptop's daemon, exactly like a laptop-paired
build.

## Architecture

```
Android app (Capacitor shell, Java)
├── MainActivity / NativeConfig ── mode routing: UNSET → bundled React app (first run or stopped)
│                                                 PHONE  → http://127.0.0.1:<daemon>/app/
│                                                 LAPTOP → the configured https://…/app/
├── bridge/   window.OmpLocal ─── onboarding, provider login, permission checks (trusted origins only)
├── runtime/  LocalRuntime ────── install, upgrade, start/stop; LocalPulseService (specialUse FGS)
│               └─ proot (libproot.so + libproot-loader.so from nativeLibraryDir)
│                    └─ Alpine guest (files/phone/rootfs)
│                         ├─ omp-pulse serve  = /opt/pulse/libomppulse.so (the APK's own lib)
│                         │    └─ omp --mode rpc-ui children (/usr/local/bin/omp)
│                         └─ `android` CLI ──► PhoneApi
└── phone/    PhoneApi (127.0.0.1:<phoneApi>/v1/) + PhoneAccessibilityService
```

Java sources are under `mobile/android/app/src/main/java/com/omppulse/app/`.

| Piece | Where | Notes |
|---|---|---|
| Mode routing | `NativeConfig`, `MainActivity` | Mode `unset`/`phone`/`laptop` is a pref. Explicit `unset` persists a stopped runtime even in a build with a default laptop URL. The Capacitor `server.url` is derived per mode at runtime. |
| JS bridge | `bridge/LocalModeBridge` (`window.OmpLocal`) | `state()`, `setMode()`, `connectLaptop()`, `useComputer()`, `forgetComputer()`, `computerStatus(active)`, `prepare()`, provider login, `access()`/`grant()` for storage, accessibility, battery, notifications. Calls from untrusted origins return `{}`/`[]`. Web side: `web/src/platform/local-mode.ts`. |
| Runtime | `runtime/LocalRuntime` | The only API the rest of the app uses: `mode()`, `isSupported()`, `isInstalled()`, `status()`, `prepare()`, `endpoints()`, `guest(argv)`, `hostPath()`. |
| Daemon supervision | `runtime/LocalPulseService` | Foreground service (`specialUse`): starts `omp-pulse serve` in the guest, restarts it, starts/stops `PhoneApi`, and holds the partial wake lock only while the daemon has work (see [Wake lock](#wake-lock)). |
| Phone control | `phone/PhoneApi`, `phone/PhoneAccessibilityService` | Loopback HTTP API used by the guest's `android` CLI (screen, apps, files, …). Bearer token at `/root/.config/omp-phone/token`. The accessibility service is pull-only: dumps and gestures run on request, and it subscribes only to window-state changes (`res/xml/phone_accessibility.xml`), since every event it receives wakes the app and nothing reads them. |
| Pins | `assets/runtime/runtime.json` | Alpine repo, package list, rootfs and omp URL + sha256 + size per ABI. Written only by `scripts/android/runtime-pins.mjs`. |
| Harness | repo `phone-harness/` → APK assets `phone/harness*` (build) → guest `/root/projects/phone-harness` | The agent's self-editable instructions, skills, `android` CLI and tools; see [Phone harness](#phone-harness). |

`libomppulse.so` is not a library: it is the daemon as a static, non-PIE `aarch64`
musl executable, named `lib*.so` so Android extracts it to `nativeLibraryDir`, the
one place an app may exec from. How it is built is in
[android.md](../contributing/android.md#the-phone-mode-daemon-libomppulseso).

## Platform constraints the runtime works around

- **W^X (targetSdk 29+: no exec from app data).** Android executes only
  `libproot.so` from `nativeLibraryDir`. Guest binaries in app data are mapped by
  `libproot-loader.so`, which the kernel executes from `nativeLibraryDir`. This
  requires `extractNativeLibs="true"` (`useLegacyPackaging true` in
  `mobile/android/app/build.gradle`); with compressed-in-APK libs `nativeLibraryDir`
  is empty and nothing runs.
- **SELinux hard-link denial.** proot runs with `--link2symlink`, so `apk`, `git`
  and friends can still hard-link.
- **4 KB and 16 KB page sizes.** Every shipped `PT_LOAD` is aligned to 16 KB (proot
  libs) or 64 KB (omp, Alpine, `libomppulse.so`), which is what 16 KB-page kernels
  (Android 15+ devices) require. `scripts/android/build-runtime.sh` refuses a
  `libomppulse.so` with smaller alignment.
- **Secondary users and work profiles.** Each user or profile has its own app data
  and therefore its own runtime. Storage maps to the CURRENT user's shared storage
  (`Environment.getExternalStorageDirectory()`, e.g. `/storage/emulated/10`), never
  a hard-coded `/storage/emulated/0`.

## Endpoints

The daemon prefers `127.0.0.1:7681` and PhoneApi `127.0.0.1:7690`; if either port is
taken (another app, a second profile, a `.dev` install) a free loopback port is
chosen and persisted. Every start writes `/root/.config/omp-phone/endpoint.json`
(mode 0600):

```json
{"phoneApi":"http://127.0.0.1:<P>/v1/","daemon":"http://127.0.0.1:<D>/",
 "package":"com.omppulse.app","nativeLibraryDir":"/data/app/…/lib/arm64"}
```

The harness tools read it and fall back to 7690/7681 (builds before it existed).
`package` and `nativeLibraryDir` let the shell tier (adb, outside the guest) find
this install: the package has a suffix in side-by-side builds and the library
directory moves on every app update. Every start also writes
`/root/.config/omp-phone/device.json` (manufacturer, brand, model, device, Android
release, SDK, ABI, `memTotalMb`): the guest has no `getprop`, and the harness gates
OEM-specific tools and scales its memory thresholds by these. The WebView loads
`http://127.0.0.1:<D>/app/`; cleartext is allowed only to loopback.

## Wake lock

The service used to hold an untimed `PARTIAL_WAKE_LOCK` for its whole life, so the
phone never slept: every daemon, WebView and proot timer fired around the clock
while nobody could see the result. The lock (`omp-pulse:local-daemon`,
non-reference-counted) now follows the daemon's own busy signal.

- **Daemon side.** `ChildManager` publishes `{busy, version}`
  (`src/omp/child/busy.rs`): busy while any live daemon child satisfies the
  reaper's predicate (a turn, an accepted prompt not yet started, background jobs
  or subagents omp reported after the turn, a side question, a dialog awaiting an
  answer, an RPC or phone control in flight). The inventory is a weak list of every
  physical child, including boot and one-shot children that are not yet routed.
  Native `/handoff` compaction stays busy through a maintenance probe that polls
  `get_state.isCompacting` every 5 s (an older omp that cannot report it stays
  busy for the maintenance window), and active ASR operations hold a `BusyWork`
  guard that kills the sidecar if the request is cancelled. Every write that can flip
  it pokes a watcher task; while busy it also re-checks every 30 s for the time-based
  expiry of background work and prompt reservations, and while idle nothing ticks.
  `version` moves on every flip. Desktop-bridged and collab turns run on the laptop
  and do not count; detached extension work has no general completion signal and is
  not covered. `GET /api/busy?after=<version>&wait=<s>` (authenticated like
  `/api/status`, `wait` capped at 300 s) answers at once when the version differs
  from `after` (or `after` is absent), else on the next flip, else unchanged when
  `wait` runs out. `/api/status.busyWork` reports the same predicate;
  `busyChildren` is still the restart gate.
- **App side.** After READY a watcher thread long-polls `/api/busy` (`wait=240`,
  read timeout 300 s) and feeds `runtime/BusyLockPolicy`. A long-poll, not a timer,
  so a sleeping phone is never woken to ask. `DaemonClient.busy` requires a token,
  refuses redirects and closes the response; `BusyWatchControl` publishes the
  connection together with the stop flag so `stop()` cannot miss it. A transport
  failure is unknown, not idle: it backs off 1 s to 60 s and neither shortens nor
  renews the last lease. The thread stops when the daemon exits and in `onDestroy`.

| State | Lock |
|---|---|
| STARTING (install, extraction, daemon start) | held, 10 min timeout, never shortening a known BUSY hold |
| IDLE | released |
| BUSY | held, 2 h timeout, re-armed on every busy answer (including an unchanged one at the end of a wait) |
| GRACE (busy turned idle) | held 60 s more as the lock's own timeout; busy again cancels it |
| DAEMON_DOWN (supervisor exit, crash backoff) | the last lease is kept, neither shortened nor renewed; the next healthy report renews it, or turns it into GRACE |

Every hold is timed, and the grace is the lock's timeout rather than a timer of
the app's, so nothing in the policy wakes the phone. A prompt is always sent while
the phone is awake (its UI or a local client), so the busy flip arrives long before
the phone could suspend; a turn that continues with the screen off already holds the
lock. A failed report or daemon exit does not prove idle, because descendants of
the supervisor may outlive it, so a startup lasting over ten minutes or a
permanently unavailable busy endpoint can outlast, or run short of, its protection;
`transportFailure()` surfaces that as a warning once the lease has run out. These are
bounded policies, not a guarantee against Android killing the process. Host test:
`mobile/android/host-tests/busy-lock-policy/`.

## Install steps and state

All state lives in the app's private storage under `files/phone/`:

| Path | Purpose |
|---|---|
| `rootfs/` | The Alpine guest. Appears only complete (extracted to `rootfs.staging/`, then renamed). |
| `downloads/<sha256>` | Content-addressed downloads; `.part` files resume from any mirror. Nothing reaches its final name before its sha256 matches the pin. |
| `install-state.properties` | Which step ran for which key. |
| `tmp/` | `PROOT_TMP_DIR`. |
| `daemon.log` | Output of the supervised daemon. Buffered: written at most 2 s after it is produced, sooner in bursts, and in full when the daemon exits. |

`prepare()` runs the unfinished steps in order:

1. **rootfs**: download the pinned minirootfs, verify, extract with the in-app tar
   extractor.
2. **packages**: write `/etc/apk/repositories` from the pinned `alpineRepo`, then
   `apk add --upgrade` the pinned package list (`libstdc++ bash git curl
   ca-certificates python3 openssh-client`).
3. **omp**: download the pinned binary to `/usr/local/bin/omp`, run `omp --version`.
4. **omp-pulse link**: `/usr/local/bin/omp-pulse` → `/opt/pulse/libomppulse.so`.
5. **setup**: `omp-pulse setup --bind 127.0.0.1 --port <D>` (writes the owner token
   once).

Then `LocalPulseService` starts `omp-pulse serve`, and the shell pairs with the local
daemon using the `phone` entry in `TokenStore`. On the phone the daemon's child pool
defaults to 3 children rather than 6 (see
[session-state.md](session-state.md#the-child-pool)).

**Stop phone mode** uses the same bridge's `setMode("unset")` path: persist the
off choice, stop the local and notification services, then restart the shell onto
the bundled chooser. There is no separate paused state and nothing in the guest
or token store is deleted. App launch and boot do not start the runtime in
`unset`, and notification delivery requires a configured daemon. An installed
runtime's chooser prepares it on explicit **Run on this phone**, then switches
straight to `phone` when ready instead of repeating first-run provider and
permission steps.

The supervisor releases its busy watcher and wake lock, stops `PhoneApi`, and
signals proot with `SIGQUIT`, which kills its traced guest processes. Ordinary
process destruction is insufficient: this proot ignores `SIGTERM`, and `SIGKILL`
can detach a still-running guest. Daemon teardown stays under `SUPERVISOR` so a
quick resume waits for it. Explicit `unset` also ends separate guest commands,
including provider sign-in; normal daemon restarts and computer switches leave
those commands alone.

The stopped chooser lists saved computers and reuses `useComputer()` for an
explicit selection. `computerStatus(true)` reads a cached status map and starts
a bounded background sweep of saved canonical `/app/` URLs. The check sends no
pairing credential or cookie and follows no redirects: HTTP 200 is online;
failed requests and other statuses, including a reverse proxy's 502, are offline.
There are at most four workers and a four-second gap between completed sweeps.
The web polls only while the list is visible; `computerStatus(false)` stops
queued work and fences late replies on hide, step change or unmount. In-flight
requests use 1.5-second connect and 3-second read timeouts.

## Upgrade policy

- **omp-pulse** runs straight from the APK (`/opt/pulse` is the APK's
  `nativeLibraryDir`), so an app update upgrades the daemon with no download.
- **omp**: a new pin (version or sha256) replaces the binary on the next
  `prepare()`. With an unchanged pin, an omp the user upgraded in place
  (`omp update`) is left alone.
- **packages**: re-run when the repository or the package list changes.
- **rootfs**: never replaced. It holds the user's home and projects; a newer Alpine
  pin only affects fresh installs, and existing guests upgrade through `apk`.
- **harness**: merged, never overwritten; see [Phone harness](#phone-harness).

## Phone harness

`phone-harness/` in this repository is the agent's harness for phone mode: global
instructions (`agent/AGENTS.md`, linked as omp's `~/.omp/agent/AGENTS.md`), skills,
the `android` CLI, the job broker (`bin/heavy`, its omp extension and toolchain
shims), `bin/mem-guard`, the `phone` MCP server and tools for specific apps or OEMs,
which check that they apply before doing anything. Its own `AGENTS.md` and
`README.md` describe it; its tests are part of the gate (see
[testing](../contributing/testing.md)).

Only generic content lives there. Per-device state stays on the phone and is never
committed upstream: the user-actions ledger (`phone-harness/docs/user-actions.md`
ships as an empty template), anything naming one device.

**Opt-in.** The harness is applied only while Settings › Phone access › **Phone tools
for the agent** is on (`LocalRuntime.phoneTools()`, SharedPreferences
`omp_pulse_runtime`/`phone_tools`; bridge `OmpLocal.state().phoneTools` and
`OmpLocal.setPhoneTools(on)`). Unset, it is decided once and stored by
`runtime/HarnessInstall.enabled`: on when `/root/projects/phone-harness` already
exists (an install that had the harness before the setting existed keeps it), off
otherwise, so a new install starts without it. Before every daemon start,
`LocalRuntime.refreshGuestFiles()` → `GuestFiles.applyHarness(phoneTools())` →
`HarnessInstall.apply`; flipping the switch applies it at once on an installed
runtime (`LocalRuntime.setPhoneTools`). The phone API (`PhoneApi`, which the
`android` CLI and `phone` MCP server call) runs only while it is on.

- **On:** seed and upgrade as below, then the links and MCP entry listed at the end
  of this section. Each one the app created is recorded in
  `/root/.config/omp-phone/harness-links.json`.
- **Off:** nothing is seeded or merged. The recorded links are removed while they
  still point where the app pointed them, and the `phone` MCP entry while it is
  exactly the app's; without a record (builds before the setting) the candidates are
  the harness links at their fixed places, under the same rule. Files of the user's
  own and the harness repo (the agent's commits) stay.

**Packaging.** Gradle's `packageHarnessSeed` (a `preBuild` dependency) turns
`phone-harness/` into `assets/phone/harness.manifest` plus content-addressed blobs
`assets/phone/harness/<sha256>`; every embedded file is a declared task input. Tests,
caches (`__pycache__`, `node_modules`) and secrets patterns are excluded. The
manifest records each file's exec bit; blobs are content-addressed because aapt
drops dotfiles and the build's ignored extensions.

**Seed and upgrade** (`runtime/HarnessSeed`, `runtime/HarnessMerge`, run before every
daemon start while phone tools are on; git runs in the guest):

1. Nothing happens when `/root/.config/omp-phone/harness-seed.json` already records
   this seed's digest (the manifest's sha256): an ordinary start spawns no guest
   command.
2. The seed is committed to branch `upstream` of `/root/projects/phone-harness`,
   parented on the previous seed, through a private index file: the agent's working
   tree and index are untouched.
3. First run: the checked-out branch is reset to `upstream` (`seeded`).
4. Later: `git merge --no-ff upstream` into the checked-out branch. The merge base is
   the last seed the device merged, so only upstream's changes since then apply and
   the agent's commits stay. A conflicted path keeps the device's whole file (or its
   deletion) and is listed (`conflicts`); `android doctor` shows a FIX line for each
   one the agent has not touched since. HEAD detached, a merge or rebase in progress,
   uncommitted tracked changes, or an untracked file in the way leave it `pending`
   (retried next start; `git merge upstream` finishes it by hand).
5. Repos seeded by builds before this scheme: a root commit "Seed phone harness from
   omp-pulse …" becomes the start of `upstream` and hence the merge base. Any other
   history merges as unrelated histories: differing files keep the device's version,
   missing ones are added.

A failed seed is recorded as `pending` with the reason and never keeps the daemon
from starting. The old read-only `shipped/` mirror is deleted. After seeding, the app
links `AGENTS.md`, `skills` and `android` into place, links `.env`, the job-broker
extension and the `cargo`/`node`/`npx`/`gradle` shims only where no file of the
user's own is in the way, and registers the `phone` MCP server in
`~/.omp/agent/mcp.json` when it has no `phone` entry.

## Licences

The APK redistributes third-party binaries (proot, talloc, libandroid-shmem) and
downloads omp and Alpine packages at runtime. Licences, versions and the source
offer are summarised in [docs/user/phone-mode.md](../user/phone-mode.md#licences);
checksums are in `mobile/android/vendor/proot/PROVENANCE.md` and licence texts in
`THIRD_PARTY_NOTICES.md`.
