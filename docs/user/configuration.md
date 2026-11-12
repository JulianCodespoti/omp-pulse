# Configuration and operation reference

Everything about running the desktop daemon after it is installed: commands,
configuration, environment variables, platform differences and troubleshooting.
Networking is in [networking.md](networking.md), Windows specifics in
[windows.md](windows.md), phone mode in [phone-mode.md](phone-mode.md), and the
security model in [SECURITY.md](../../SECURITY.md). Every other guide is
indexed in [docs/README.md](../README.md).

## Commands

`serve` is the default: `omp-pulse` with no arguments runs the daemon.

| Command | Purpose |
|---|---|
| `omp-pulse serve` | run the daemon in the foreground |
| `omp-pulse setup [--bind HOST] [--port PORT]` | first-run configuration: writes `config.toml`, creates the desktop owner credential, installs the desktop-control extension, prints a one-use enrollment QR |
| `omp-pulse pair [--role control\|read\|admin] [--name NAME]` | ask the running daemon for a five-minute, single-use enrollment QR (default role `control`) |
| `omp-pulse doctor` | walk the live-sync chain and print one line per check, with a remedy on every failure |
| `omp-pulse service install [--bind HOST] [--port PORT]` / `status` / `uninstall` | run as a background service: systemd user unit on Linux, launchd on macOS, Task Scheduler on Windows |
| `omp-pulse push-test [--session PATH]` | send a real notification to every subscribed device |
| `omp-pulse migrate-owner-token` | rotate the desktop owner credential while the daemon is stopped |
| `omp-pulse desktop-control install` | install or update the omp extension used for desktop model and reasoning controls |
| `omp-pulse asr install [--multilingual]` / `asr status` | install or check the local speech-to-text model behind the dictation button (about 650 MB) |
| `omp-pulse version` | print the version, paths and the detected omp binary |

Flags on `serve`: `--bind HOST`, `--port PORT`, `--token TOKEN`,
`--public-dir DIR`, `--omp-bin BIN`, `--config FILE`.

### Pairing roles

Each phone or browser gets its own credential. `read` can watch sessions,
`control` can also send prompts and run actions, and `admin` can also manage
devices. Revoke a lost device from Settings on an admin device. The owner
credential in `<state_dir>/token` stays on the desktop and is never put in a
pairing link.

### Desktop model and reasoning controls

`setup` installs the bundled omp extension. After upgrading an existing setup, run:

```sh
omp-pulse desktop-control install
```

Reopen idle desktop omp sessions to load it; leave active turns running until
they finish. The installer respects omp's agent-directory and profile
configuration and refuses to overwrite an unrelated extension. Set
`OMP_PULSE_STATE_DIR` to match the daemon if it uses a non-default state directory.

The phone's model picker applies the model and reasoning level through the real
desktop settings API; it never sends `/model` as chat text. The companion
listens on loopback only, authenticates each request with a private per-process
credential and binds it to the active session.

## Files

Precedence, highest first: command-line flag, environment variable,
`config.toml`, built-in default.

| Platform | Config dir | State dir |
|---|---|---|
| Linux | `~/.config/omp-pulse/` | `~/.local/state/omp-pulse/` |
| macOS | `~/Library/Application Support/omp-pulse/` | same |
| Windows | `%APPDATA%\omp-pulse\` | same |

The state directory holds:

| File | What |
|---|---|
| `token` | the owner credential (a live secret: protect the directory) |
| `devices.json` | the device registry (digests only, see [SECURITY.md](../../SECURITY.md)) |
| `vapid.json`, `push.json` | Web Push keys and subscriptions |
| `collab.json` | the collab link registry |
| `daemon.json` | written while the daemon runs, so `doctor` and `pair` can find it whatever flags it was started with |
| `commands.json`, `command-receipts/` | the command ledger and archived delivery receipts |
| `turns-in-flight.json` | turns running when the daemon stopped, so the phone can say they were interrupted |
| `child-extension/`, `desktop-controls/` | the child extension the daemon's omp children load, and the desktop bridge's per-process descriptors |
| `asr/` | the speech-to-text runtime and model, when installed |
| `logs/` | service logs |
| `catalogues/`, `exports/`, `omp-child-settings.yml`, `doctor-version.json` | caches and scratch files the daemon regenerates |

If you have files from the older `omp-remote` daemon (`~/.omp/omp-remote.token`
and friends) and no state in the new location yet, the first run copies them
across.

### config.toml

`setup` writes a commented `config.toml`. Every key is optional and unknown keys
are ignored: `host`, `port`, `sessions_root`, `omp_bin`, `public_dir`,
`max_children`, `watch_interval_ms`, `ws_queue_cap`, `ws_queue_bytes`,
`child_idle_secs`, `child_unwatched_secs`, `child_rss_mb`, `child_lean_js`,
`prewarm_on_attach`, `owner_cache_ms`, `ws_deflate_min`, `asr_python`,
`asr_model_dir`, `asr_threads`.

```toml
host = "127.0.0.1"
port = 7681
max_children = 4
```

`public_dir` serves the web app from a directory instead of the copy embedded in
the binary; leave it unset normally. A missing default config file means
defaults. A config file you name explicitly (`--config FILE` or
`OMP_PULSE_CONFIG`) that does not exist is an error, and so is one that does not
parse.

## Environment variables

Every variable has an `OMP_PULSE_*` name; the legacy `OMP_REMOTE_*` name is
still honoured for existing units and scripts. `OMP_BIN` has no prefix (it
names an external binary) and `XDG_DATA_HOME` is standard.

| Variable | Default | Meaning |
|---|---|---|
| `OMP_PULSE_HOST` (`OMP_PULSE_BIND`, `OMP_REMOTE_HOST`) | `127.0.0.1` | address to bind |
| `OMP_PULSE_PORT` (`OMP_REMOTE_PORT`) | `7681` | port to listen on |
| `OMP_PULSE_TOKEN` (`OMP_REMOTE_TOKEN`) | token file | owner credential override |
| `OMP_PULSE_SESSIONS_ROOT` (`OMP_REMOTE_SESSIONS_ROOT`) | omp's session store | where sessions are found |
| `OMP_PULSE_STATE_DIR` (`OMP_REMOTE_STATE_DIR`) | platform state dir | daemon-owned state location |
| `OMP_PULSE_MAX_CHILDREN` (`OMP_REMOTE_MAX_CHILDREN`) | `6` (`3` on Android) | cap on live RPC children (about 280 MiB each); busy children are never evicted |
| `OMP_PULSE_WATCH_INTERVAL_MS` (`OMP_REMOTE_WATCH_INTERVAL_MS`) | `250` | fallback poll interval (native file events are primary) |
| `OMP_PULSE_WATCH_POLL` | unset | `1` forces the polling watcher (network filesystems, WSL2) |
| `OMP_PULSE_WS_QUEUE_CAP` (`OMP_REMOTE_WS_QUEUE_CAP`) | `64` | per-client WebSocket frame queue depth |
| `OMP_PULSE_WS_QUEUE_BYTES` (`OMP_REMOTE_WS_QUEUE_BYTES`) | `1048576` | per-client WebSocket queue byte budget |
| `OMP_PULSE_CHILD_IDLE_SECS` (`OMP_REMOTE_CHILD_IDLE_SECS`) | `900` | reap a child idle this long |
| `OMP_PULSE_CHILD_UNWATCHED_SECS` | `60` | reap sooner when there is no running turn, open dialog or visible viewer for this long (`0` disables); idle unwatched children go at once when `MemAvailable` drops below 800 MiB |
| `OMP_PULSE_CHILD_RSS_MB` (`OMP_REMOTE_CHILD_RSS_MB`) | `700` | recycle a child past this resident + swapped size (MiB) |
| `OMP_PULSE_CHILD_LEAN_JS` | `true` | start children with JavaScriptCore unlinked-code jettisoning: ~23 MiB less per child, ~50 ms more CPU per turn |
| `OMP_PULSE_PREWARM_ON_ATTACH` (`OMP_REMOTE_PREWARM_ON_ATTACH`) | `false` | spawn a child as soon as a socket attaches |
| `OMP_PULSE_OWNER_CACHE_MS` (`OMP_REMOTE_OWNER_CACHE_MS`) | `3000` | terminal-ownership verdict cache |
| `OMP_PULSE_WS_DEFLATE_MIN` (`OMP_REMOTE_WS_DEFLATE_MIN`) | `4096` | frames at or above this size are sent as deflated binary |
| `OMP_PULSE_WORKER_THREADS` | `2` (fewer on a single core) | async runtime worker threads |
| `OMP_PULSE_PUBLIC_DIR` | embedded assets | serve the web app from a directory (development) |
| `OMP_PULSE_CONFIG` | `<config_dir>/omp-pulse/config.toml` | explicit config file |
| `OMP_BIN` | `omp` on PATH, then `~/.bun/bin/omp`, `~/.local/bin/omp` | the omp executable |
| `XDG_DATA_HOME` | `~/.local/share` | where omp sessions live (`$XDG_DATA_HOME/omp/sessions`) |
| `OMP_PULSE_ASR_PYTHON` | `<state_dir>/asr/venv/bin/python` if present | Python interpreter for the dictation sidecar |
| `OMP_PULSE_ASR_MODEL_DIR` | the newest model directory under `<state_dir>/asr/` | sherpa-onnx model directory (must contain `encoder.int8.onnx` and `tokens.txt`) |
| `OMP_PULSE_ASR_THREADS` (`OMP_REMOTE_ASR_THREADS`) | `6` | decoder threads; more stop helping well before the core count |
| `OMP_PULSE_FFMPEG` | `ffmpeg` on PATH | ffmpeg used to convert recordings to 16 kHz mono WAV for dictation |

Dictation is available only when both an interpreter and a model directory
resolve; `omp-pulse asr install` puts both under the state directory and
`omp-pulse asr status` says what is missing. How it works:
[docs/internals/dictation.md](../internals/dictation.md).

### The daemon's service environment

Environment set for the daemon's service (for example a systemd
`EnvironmentFile`) takes precedence over omp's own agent `.env` for the
children the daemon spawns. A stale `OPENCODE_API_KEY` left there once made
phone chats use an old account while laptop launches loaded the current key:
remove obsolete service-only overrides rather than copying keys into another
place. Phone-created chats use the installed `omp` and its model registry,
including `~/.omp/agent/models.yml`; omp-pulse has no provider settings of its
own.

## Live sharing with the desktop terminal

### Binding and the collab relay

When you bind a LAN or Tailscale address, the daemon also listens on
`127.0.0.1` on the same port. That second listener is for the desktop omp TUI:
its collab relay dials `ws://127.0.0.1:<port>` when you run `/collab`. If the
loopback port is already taken, the daemon logs a warning and carries on; only
terminal sharing is affected.

Which relay the TUI dials is omp's `collab.relayUrl` setting (or
`/collab <relayUrl>` per run). Point it at this daemon's loopback listener with
`omp config set collab.relayUrl ws://127.0.0.1:<port>`, or at a `wss://` relay.
A plaintext `ws://` relay on any other host is refused, because the room key
rides in the link's path and would cross the network in the clear.

### Native collab autostart

With omp 18.1.20 or newer, `collab.autoStart: control` makes interactive
sessions host themselves through `collab.relayUrl`. Configure the relay first.
This is an opt-in sharing permission that installing omp-pulse does not enable.
When attaching or sending to the desktop, omp-pulse finds the exact session with
`omp collab list --json` and requests a link from `omp collab link`, so no
terminal keystrokes or QR transfer are needed. A view-only host is never
upgraded to control. Without a native host, terminal adoption (herdr, kitty or
tmux) and a manual `/collab` remain available. Tern has its own safe path, below.

### Tern

Pulse never types into a Tern pane. Tern runs omp as a native surface, and omp's
native Collab hosting is what Pulse adopts. There is no Tern helper, plugin or
spool to install; reuse the normal Pulse extension setup (`omp-pulse setup` or
`omp-pulse desktop-control install`).

- **Pulse control extension loaded.** The existing bridge works in a Tern pane
  unchanged.
- **Otherwise, share once.** Enable `collab.autoStart: control` so future omp
  sessions host themselves, or run `/collab` yourself once in the Tern session.

Pulse then adopts the active Tern host by the exact session file and owner process
id. It uses omp's native Collab list and link, run with that owner's own home,
config directory, profile and runtime, and checks the session, control access and
generation of the link. Persistent screen or transcript hints are never
authority, so a share you stopped is not revived from an old link.

If a known Tern owner is not sharing, Pulse refuses. It sends no keystrokes, does
not focus a window or pane and launches no GUI, and an unsent draft in the composer
is left untouched. A refusal is final: Pulse does not fall back to kitty, tmux or
herdr typing. Share the session (above) and retry.

**Why no raw input.** Tern's native surface can lag by about 5 seconds, and a native
ask replaces the composer draft with no atomic empty-check-and-send guard (omp
18.18.1, `packages/tui/src/prompt/custom-editor.ts`). Typing `/collab` could
therefore destroy what you were writing.

Tested on Linux with Tern 0.9.12 and omp 18.18.1; no minimum version is claimed.
The native fallback was not exercised on macOS or Windows. Adoption is not a
desktop launch: "Open on laptop" still starts conversations only in herdr.

## Notifications

Push needs a secure context, so it works over Tailscale Serve, a tunnel or
`localhost`, but not over a plain-http LAN address. After pairing, check the
whole chain with:

```sh
omp-pulse push-test
```

It sends one real notification per subscribed device through the same code path
a finished turn uses and prints how many were accepted. If nothing arrives, the
app is not installed to the home screen or notifications are blocked on the
phone. The Android app delivers notifications over its own connection to the
daemon, not Firebase.

Browser Web Push and the Android app's native notifications are separate
opt-ins. If both are enabled on the same phone you get every alert twice: turn
one off. The daemon does not merge separately enrolled devices. How the two
transports share one payload: [docs/internals/notifications.md](../internals/notifications.md).

## Platform support

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| Daemon, REST + WebSocket API, web app | full | full | full |
| File watching | inotify | FSEvents | ReadDirectoryChangesW |
| Terminal auto-adoption (herdr / kitty / tmux) | yes | yes | no |
| Session ownership detection | owner records, process arguments, open files (`/proc`) | owner records, process arguments, open files (`proc_pidinfo`) | owner records, process arguments |
| Collab relay, Web Push, delta streaming | full | full | full |
| Service manager | systemd (user) | launchd | Task Scheduler |

Before spawning a writer for a session, the daemon checks three layers: a small
owner record its own children write next to each session, a sweep for an omp
process whose arguments name the session, and, on Linux and macOS, which
process holds the session file open. Windows has no cheap equivalent of the
third layer, so a session opened from inside a running omp (the picker,
`/resume`) is not detected there; see [windows.md](windows.md#what-is-degraded-on-windows).
On Windows, and on macOS without a supported terminal, enable native collab
autostart or run `/collab` once per session.

## Troubleshooting

Errors that need another screen offer a direct recovery action. Opening recovery
settings preserves the current chat, new-session draft and workspace; Back
returns to that work. Model/provider errors lead to the model picker or provider
setup. Computer-side setup offers the relevant command or guide rather than
pretending to configure the computer from the phone.

Recovery notices keep the main action visible beside a short explanation.
Expand **Details**, **Next steps** or the contextual help to see supporting
instructions and diagnostics. Copy icons beside commands copy the command;
they do not run it. Icon-only controls have accessible labels, and recovery
actions and sheet close buttons have 48-pixel touch targets.

**Not sent** includes the reason and the available recovery action. Fixing setup
does not automatically resend the message. If delivery is uncertain, use
**Check** rather than sending another copy.

**Pair this device** repairs a rejected pairing without silently discarding its
saved work. After a successful repair, **View saved work** opens read-only draft
and queued-message copies, original saved attachments, and later browser draft
changes. Select a conversation row to read its saved content, then use
**Copy text**, the attachment controls, **Open conversation** or **Open new draft**
as needed. **Source details** reveals the original path. Nothing in this archive is automatically sent,
and some saved content may already have reached the computer. The archive is
local to the browser's storage, not a cloud backup; clearing that storage removes
it. In **Run on PC** settings, **Unpair this phone** revokes its credential on the
computer, stops its notifications and removes its access to its recovery archive.
Phone mode instead offers **Stop phone mode**, which preserves its conversations,
files and sign-ins; see [phone mode](phone-mode.md#settings-and-stopping-phone-mode).

Android app and network settings buttons are available when the installed shell
supports them. Browsers and older shells show contextual help instead. Opening
settings does not grant permission or change a setting on the user's behalf.

- **Run `omp-pulse doctor` first.** It checks that the daemon answers, the collab
  relay URL points at this daemon, the link registry is intact, terminal
  adoption has a control surface, the auto-collab probe works end to end, and
  whether omp's version changed since the last passing probe.
- **The phone cannot reach the daemon.** Check that `omp-pulse serve` (or the
  service) is running, and that your front door ([networking.md](networking.md))
  points at the right port.
- **The app works but will not install, and no notifications arrive.** You are on
  plain-http LAN, which is not a secure context. Use Tailscale Serve or a tunnel.
- **The session list is empty.** The daemon looks in omp's session store
  (`$XDG_DATA_HOME/omp/sessions` on every platform, because omp follows the XDG
  rule even on macOS and Windows). Point `OMP_PULSE_SESSIONS_ROOT` elsewhere if
  needed.
- **Live sync stopped after an omp upgrade.** omp version changes can break the
  collab link format; `doctor`'s `omp-version-drift` check reports it.
- **Open on laptop with herdr stopped.** omp-pulse starts herdr and waits for it
  before moving the conversation. If startup fails, the phone conversation keeps
  running; run `herdr config check` on the computer for configuration errors.
- **The phone app shows stale data after an upgrade.** Reload the app once; the
  daemon's release id drives a stale-client check.
