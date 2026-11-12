# Architecture

What the daemon is, where its boundaries are, and which invariants hold. This page
is the entry point; the [topic pages](#topic-pages) carry the detail.
[modules.md](modules.md) is the generated per-module index and
[performance.md](performance.md) holds the measurements. Code is named by file and
symbol, never by line number: line numbers rot, symbol search does not.

## The problem being solved

`omp` is a terminal coding agent that keeps each conversation in an append-only JSONL
session file. This daemon lets a phone read those conversations live and send prompts
into them, without the desktop giving up ownership. Everything hard about it follows
from two facts:

1. **omp rewrites a session file wholesale from memory.** Two writers therefore
   destroy history. This is why ownership detection exists at all, and why the daemon
   refuses rather than guesses.
2. **A file append is not an event stream.** Tailing a file gives coarse, committed
   content; token-level streaming only exists inside the process that is generating
   it. Hence several live paths: three token-level producers and one file tail,
   described below.

## Shape

One process. `src/bin/omp-pulse/main.rs` builds every module, then runs exactly one
router task that serializes events onto the client hub. Requests arrive over
HTTP/WebSocket (`src/server/http.rs`), content arrives from four sources, and
everything converges on the hub in `src/server/ws.rs`. Paths in the diagram are
relative to `src/`.

```
phone ──HTTP/WS──> server/http.rs ──> server/ws.rs (hub) ──> phone
                        │                ▲  ▲  ▲  ▲
                        │                │  │  │  └── omp/collab.rs  (desktop relay, token level)
                        │                │  │  └───── omp/bridge.rs  (desktop extension, token level)
                        │                │  └──────── omp/child.rs   (phone-driven, token level)
                        └───────────────>│  sessions/watcher.rs      (file tail, coarse)
                                         │
              server/delta.rs (wire encoding)   authority/activity.rs (what runs now)
```

## Where the code lives

The library (`src/lib.rs`) has one module per subsystem directory, plus a few
crate-wide modules at the top level. A large module is a parent file plus a
directory of parts named for what they hold: the parent keeps the module's
header, its public types and API, and the parts hold the implementation
(`http.rs` is the router; `http/prompt.rs`, `http/files.rs` and `http/socket.rs`
are handlers). Every file starts with a `//!` header stating its job;
[modules.md](modules.md) lists them all.

- **`src/server/`: what the phone talks to.** `http.rs` builds the router and its
  `http/` parts hold the handlers by area (auth and pairing, history, prompt,
  control, files, sockets, receipts, rpc, search, notifications, status); `ws.rs`
  is the bounded per-client fan-out hub and `delta.rs` its streaming-text
  encoding; `assets.rs` serves the embedded web app; `device_auth.rs` enrols
  devices; `push.rs` (with `push/` for turn bookkeeping, alerts and the RFC 8291
  Web Push code) builds notifications for Web Push and the Android stream;
  `asr.rs` and its `asr-server.py` sidecar do dictation; `git_changes.rs` backs
  the Changes tab.
- **`src/omp/`: driving omp processes.** `child.rs` (and `child/`) is the pool of
  `omp --mode rpc-ui` children the daemon spawns, including the helper extension
  they load; `collab.rs` (and `collab/`) is the collab guest and the self-hosted
  relay; `bridge.rs` reads the desktop extension's event stream;
  `desktop_control.rs` drives desktop model settings; `native_collab.rs` asks omp
  for collab links; `ui_dialog.rs` builds dialog replies; `autotitle.rs` names new
  sessions; `ansi.rs` strips terminal escapes.
- **`src/sessions/`: omp's session files on disk.** `jsonl.rs` is the only parser
  (with `jsonl/usage.rs` for cost and context tallies); `watcher.rs` tails files as
  they grow; `index.rs` (and `index/`) is the listing index and its memos;
  `branch.rs` forks a session; `model_usage.rs` reads omp's model-usage index.
- **`src/authority/`: who may write each session and what it is doing.** `guard.rs`
  and `owner.rs` detect ownership; `session_state.rs` is the canonical per-session
  record; `activity.rs` tracks what runs now; `command_ledger.rs` and
  `receipt_proof.rs` keep durable delivery receipts; `interrupted.rs` records turns
  cut off by an exit or restart.
- **`src/terminal/`: the laptop's terminals.** `adopt.rs` adopts a TUI already
  running in kitty, tmux or herdr and adopts an already-sharing Tern omp through
  its native Collab (`adopt/tern.rs`, which refuses rather than typing) and
  `linkscrape.rs` reads its collab link;
  `handoff.rs` moves a conversation into a herdr tab; `herdr_startup.rs` starts
  herdr safely; `herdr_state.rs` polls herdr's per-pane agent state.
- **Top level:** `cli.rs` (the command line), `types.rs` (configuration and the
  shared vocabulary), `paths.rs`, `metrics.rs`, `service.rs` (login service
  install) and `doctor.rs` (self-test).
- **`src/bin/omp-pulse/`: the binary.** `main.rs` dispatches the CLI, wires
  `serve` and runs the router task; `term.rs` is the pty host behind
  `omp-pulse term`.

Outside `src/`: `web/` is the React client the binary embeds, `mobile/` the Android
app, `extensions/` the two omp extensions the daemon ships, and `phone-harness/` the
phone agent's tooling seed.

## The live paths, and why there are four

- **Desktop bridge** (`src/omp/bridge.rs`, preferred): the desktop omp runs the
  bundled `extensions/omp-pulse-control.ts`, which streams the same events
  `omp --mode rpc-ui` prints. The daemon republishes them into the child-event
  channel, so a laptop turn reaches the phone through the child pipeline unchanged,
  and phone prompts go back through the extension, which keeps the desktop the only
  writer.
- **Phone-driven** (`src/omp/child.rs`): the phone prompts a session the desktop is
  not holding. The daemon spawns `omp --mode rpc-ui` as a child, and that child's
  event stream is authoritative: token-level, ordered, complete. The pool is capped
  and never stops a busy child to make room.
- **Desktop relay** (`src/omp/collab.rs`): a TUI already owns the session but runs no
  bridge-capable extension. The daemon joins that session's collab room as a guest
  and forwards the host's frames. Without a bridge this is the only way to see
  desktop typing at token level.
- **File tail** (`src/sessions/watcher.rs`): no live producer. The session file is
  the only truth, read incrementally and paged over HTTP.

The bridge and relay are described in [desktop-integration.md](desktop-integration.md);
the child pool, its admission and reaping in [session-state.md](session-state.md#the-child-pool).

**INVARIANT: the file tail is suppressed only while a child is streaming.** Not
merely while a child is alive. The user's own prompt row reaches the phone through
the file, and suppressing on liveness dropped it: a bug the browser suite caught as
a pill that never appeared.

## Boundaries (stated as absences, because that is what is load-bearing)

- Nothing except the `child` module (`src/omp/child.rs` and `src/omp/child/`)
  spawns an omp process that writes a session: it owns the only `--mode rpc-ui`
  spawn (`ChildManager`'s `spawn`, in `child/spawn.rs`). The other omp
  invocations write no session file: version probes (the drift check in `main.rs`,
  `doctor.rs`), the one-shot `omp -p --no-session` title request in `autotitle.rs`,
  the `omp collab list|link --json` queries in `native_collab.rs`, and `term.rs`,
  which launches the user's own TUI under a daemon-owned pty. The laptop handoff
  spawns no omp itself: it asks herdr to start the user's TUI, after our child has
  exited.
- Nothing at all writes a session JSONL file. Fresh sessions from `/api/new`
  materialize when the child first writes, which is why that endpoint is lazy and a
  phone list can 404 a path it just created.
- Nothing except the `http` module (`src/server/http.rs` and its parts) speaks
  HTTP, and nothing except `src/server/ws.rs` holds a client socket. A module that
  wants to reach a phone publishes an event.
- Nothing except the `collab` module (`src/omp/collab.rs` and its parts) knows the
  collab wire protocol or its AES-256-GCM envelope; nothing except
  `src/server/delta.rs` knows the delta format; nothing except the `jsonl` module
  (`src/sessions/jsonl.rs` and its parts) parses a session file.
- `src/types.rs` is the shared vocabulary. It imports `std`, `serde` and
  `crate::paths` (for `Paths`), and names one more crate type by path:
  `authority::session_state::SourceStamp`, the producer stamp a `ChildEvent`
  carries. Nothing else in the crate; every other module may depend on it.
- There is no OpenSSL in the dependency tree, on any target, deliberately (see
  the dependency rules in `AGENTS.md`). Web Push encryption and VAPID signing are
  implemented in `src/server/push.rs` for that reason.
- There is no runtime read of `public/` outside `src/server/assets.rs`: the web app
  is compiled in. `--public-dir` overrides it for development only, and `assets.rs`
  is the single place that consults the override.
- Process-wide mutable state is NOT absent: there are 94 statics across 25 modules
  (counted over every file of a module, tests included), and pretending otherwise
  would mislead. They fall into six categories, and a new one should fit an existing
  category or justify itself:
  1. **Caches keyed by content, path or file identity.** `index.rs` (the listing
     index, the lock that coalesces cold scans, and the snippet, metadata, model,
     activity and per-file usage memos behind the cost and context meters),
     `jsonl.rs` (the session tree keyed by path+len+mtime, so scrolling a 44 MB
     file back does not re-parse it: measured 105 ms cold against 17 µs cached, and
     a header memo), `assets.rs` (the embedded tree and the development override),
     `child.rs` (command catalogues keyed by cwd, mirrored on disk, plus the
     per-key gate that makes concurrent misses share one fetch),
     `child/extension.rs` (the content-hashed extension file name),
     `collab/transcript.rs` (a connection prefix), `adopt.rs` (the newest-herdr
     choice keyed by install path+mtime), `http.rs` (the prebuilt heartbeat
     frame) and `plugins/sources.rs` (the latest reading of each declared plugin
     source, keyed by plugin id, plugin hash and source id, so one command run
     serves every device for its interval).
  2. **Short-lived dedup, debounce and per-turn holding maps.** `http.rs` (recent
     `/api/new` calls, owner verdicts, adoption attempts, the per-chat gates that
     keep a held send ahead of later ones), `autotitle.rs` (sessions with a title
     request in flight), `push.rs` (the per-(kind, session) notification debounce,
     the last assistant reply held between `message_end` and the `agent_end` that
     turns it into the notification body, aborted and failed turns),
     `adopt.rs` (submit cooldown) and `handoff.rs` (the sessions mid-move).
  3. **Process-lifetime registries.** `collab.rs` (link registries, the weak
     collab and relay manager handles, through which a tapped room gets the same
     write path a guest attach does, the pending-dialog store a phone with no socket
     is replayed from, the answers held while the desktop's link is reconnecting and
     the wake that parks their expiry sweep while none are held,
     the per-session desktop-link state the phone's badge reads, and the session
     authority handle and active source stamps), `bridge.rs` (the pid→session link
     registry and its reconcile wake: the truth the bridged desktops report about
     themselves), `activity.rs` (the live activity map with its hub, authority
     handle and notification wake: one small entry per working session, removed at
     turn end), `index.rs` (the listing socket hub, refresh notification and
     discovery flag), `interrupted.rs` (the in-flight turn journal),
     `ui_dialog.rs` (a phone child's typed `ask` answers held until its last
     question) and `herdr_state.rs` (herdr's pane→status snapshot polled at 1 s, a
     registry of herdr's view rather than ours, its change wake, and the answers
     the phone has typed into each pane's current multi-question `ask`, the only
     record of which question the laptop is on until omp writes the result).
  4. **Locks and gates that make a multi-step operation atomic.** `http` (the
     lock in `http/socket.rs` that makes a socket's attach and the last socket's
     detach-and-unwatch one step, and the one in `http/dialog.rs` that keeps a
     question's position check and its delivery together), `http/files/file_io.rs`
     (the two-slot admission gate for blocking file work, see
     [io-bounds.md](io-bounds.md)), `handoff.rs` (the lock that serializes moves so
     two taps cannot both take a workspace's last tab), `http/providers.rs` (the
     one `omp login` allowed at a time, machine-wide, since omp's credential store
     is per user), `plugins/registry.rs` (the lock that makes a plugin decision's
     read-modify-write of `plugins.json` one step), `plugins/sources.rs` (the
     daemon-wide limit on plugin source and action commands running at once),
     `plugins/actions.rs` (the plugins with a host action running, so one
     plugin runs one action at a time), and the test-only environment locks in
     `paths.rs` and `collab.rs`.
  5. **Diagnostics and compiled regexes.** `metrics.rs`, `linkscrape.rs`, and the
     boot timestamp in `index.rs`.
  6. **Unique identities.** The provider sign-in generation in `http/providers.rs`
     (so a poll never reads a newer sign-in as its own); counters for temporary-file names (`herdr_startup.rs`,
     `child/spawn.rs`, `child/extension.rs`, `http/export.rs`,
     `http/files/file_write.rs`), producer generations and binding epochs
     (`bridge.rs`, `collab.rs`), request IDs (`collab/transcript.rs`) and test
     fixtures (including the scratch-folder counter in `plugins/testkit.rs`).

## Back-pressure, which is where the subtlety lives

A phone on cellular is slow; a session file can grow by megabytes in a second.
`src/server/ws.rs` gives each client a bounded queue with **two** ceilings, frame
count and total bytes, because count alone is not a memory bound when one frame can
be megabytes. Past either ceiling the client is handed exactly one resync order and
stops accumulating; it then refetches history over HTTP, which is paged and
compressed. Deltas are keyed by `base_seq`, so a client that fell behind gets a full
snapshot, never a delta it cannot apply.

Two refinements were forced by measurement, not design:

- A resync frame is tiny, so it always fits the socket, so the gate reopened
  immediately and oscillated 123 times under a storm. A stall flag now holds it.
- The watcher skips the read *and the parse* when no client can receive it: no
  client with queue headroom, or only hidden ones (a locked phone keeps its socket
  open). A 150 MiB append with no audience cost 320 MiB of RSS before that gate and
  0 after. A hidden client that missed a skipped tail gets one resync order when it
  reports visible, and with no audience at all the watcher's 250 ms tick parks.

The measurements and the full mechanism are in [performance.md](performance.md).

## Ownership, and honesty about it

`src/authority/guard.rs` and `src/authority/owner.rs` answer one question: does
another process own this session? Three layers, each with a stated blind spot: a
sidecar file (works everywhere, including Windows, and is the only layer that sees a
TUI which never wrote), process arguments via `sysinfo` (cross-platform), and open
file handles (`/proc` on Linux, `libproc` on macOS, nothing on Windows).
`src/doctor.rs` reports which layers are live on this platform instead of implying
protection that is absent.

**INVARIANT: our own RPC children are never treated as foreign owners**, and when no
layer can prove ownership the daemon refuses to spawn a writer.

## Platform gating

`src/bin/omp-pulse/term.rs` compiles only on Unix: raw parent stdin, `TIOCGWINSZ` and
`SIGWINCH` have no Windows equivalent, so `main.rs` supplies a stub module there.
Native collab discovery runs on all platforms. The terminal-control fallback in
`src/terminal/adopt.rs` is unreachable on Windows but stays compiled so the
cross-check catches platform drift, including the past macOS `ProcFdinfo`/`Clone`
FFI break.

## What is deliberately not done

- No compression of small WebSocket frames. Deltas made streaming frames 100–200 B,
  where per-frame deflate measured only 0.34×, and a shared-dictionary scheme would
  need a WASM decoder on the phone. Frames of at least `ws_deflate_min` bytes
  (default 4096, `OMP_PULSE_WS_DEFLATE_MIN`) go as raw-DEFLATE binary to clients
  that advertise `defl`; the on-phone daemon's own loopback WebView gets none (see
  F3 in [performance.md](performance.md)).
- No session multiplexing over one child: `switch_session` accumulates RSS
  (291–582 MiB over five switches), so a warm child is retargeted only when the pool
  is full, and recycled past `child_rss_mb`.

## Topic pages

- [session-state.md](session-state.md): the per-session authority record, turns
  (stop, interrupted, mid-turn delivery) and the daemon's pool of omp children.
- [delivery.md](delivery.md): command ledger, receipts and receipt binding, device
  enrolment, browser and Android outboxes, drafts and migration.
- [desktop-integration.md](desktop-integration.md): desktop bridge, collab relay,
  desktop control, laptop handoff and herdr.
- [dialogs-and-controls.md](dialogs-and-controls.md): `ask` dialogs on both
  transports, finding blocked conversations, and the phone controls (plan mode,
  Go here, labels, `!!`).
- [web-client.md](web-client.md): web client internals: read state, session status,
  listing, usage meters, workspace tabs, images, file saves, offline cache, HTTPS.
- [io-bounds.md](io-bounds.md): daemon I/O and memory bounds: file-I/O admission,
  session-index memos, watcher boundaries, socket queue accounting.
- [notifications.md](notifications.md): Web Push and the Android native stream: one
  payload, two transports.
- [dictation.md](dictation.md): local speech-to-text.
- [phone-mode.md](phone-mode.md): the phone-mode runtime (proot, Alpine guest,
  install and upgrades, phone harness wiring).
- [performance.md](performance.md): measured baseline and findings F1–F13.
