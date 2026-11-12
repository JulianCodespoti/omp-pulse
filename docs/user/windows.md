# Running omp-pulse on Windows

This is the whole setup for a Windows machine, plus an honest account of what is
degraded there and what has not been tested.

## What you need

- Windows 10 or 11 (64-bit). The binary imports only system DLLs and the
  universal CRT, so there is nothing else to install.
- `omp` already working on that machine. omp-pulse drives your existing omp; it
  does not bundle it. Check with `omp --version` in PowerShell.
- A phone on the same network, or Tailscale on both.

## 1. Install

The simplest route is the installer, from a checkout or a downloaded `install.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

It downloads the Windows release archive, verifies it against the release's
`SHA256SUMS` and installs `omp-pulse.exe` to `%LOCALAPPDATA%\Programs\omp-pulse\`.
If that folder is not on your PATH it prints safely quoted advice for the current
PowerShell session. For future sessions, add the folder through Windows user
environment settings. Until then, call the exe by full path everywhere below.

To install by hand instead, download `omp-pulse-<version>-x86_64-pc-windows-msvc.zip`
and `SHA256SUMS` from the release, compare the hashes, and unzip `omp-pulse.exe`
somewhere stable:

```powershell
Get-FileHash .\omp-pulse-<version>-x86_64-pc-windows-msvc.zip -Algorithm SHA256
```

## 2. First run

```powershell
omp-pulse.exe setup
```

That creates the owner credential, writes a config file, installs the desktop
extension and prints a pairing URL with a QR code. Nothing is exposed yet: the
default bind is `127.0.0.1`, which only this machine can reach.

Configuration and state both live in `%APPDATA%\omp-pulse\` (`config.toml`,
the owner credential `token`, which you should treat like a password, and the
rest of the files listed in [configuration.md](configuration.md#files)).

Your omp sessions are read from `%USERPROFILE%\.local\share\omp\sessions`, which
is where omp itself puts them on every platform (omp follows the XDG layout rather
than using `%APPDATA%`). Confirm what omp-pulse resolved with:

```powershell
omp-pulse.exe version
```

If that says `omp binary:  (not found; install omp or set OMP_BIN)`, set
`OMP_BIN` to the full path of your omp executable, or add its folder to PATH.

## 3. Let your phone reach it

The app needs a **secure context** (HTTPS or `localhost`) to install, keep an
offline cache and receive notifications; a plain `http://192.168.x.x` address
does not qualify. [networking.md](networking.md) explains the three ways in and
the trade-offs; the commands are the same on Windows. In short:

### Tailscale (recommended)

Install Tailscale on the Windows machine and on the phone, keep the daemon on
its default `127.0.0.1` bind, and let `tailscale serve` provide HTTPS:

```powershell
omp-pulse.exe serve
tailscale serve --bg --set-path / http://127.0.0.1:7681
```

Binding the daemon to the tailnet address instead (`--bind` with
`tailscale ip -4`) does not give you HTTPS: the phone would reach it over plain
HTTP, which is the degraded tier.

### Cloudflare Tunnel

```powershell
omp-pulse.exe serve
cloudflared tunnel --url http://127.0.0.1:7681
```

The quick-tunnel URL is public and changes on every start; read the caveats in
[networking.md](networking.md#tier-2-cloudflare-tunnel) first.

### LAN (degraded)

```powershell
omp-pulse.exe setup --bind 192.168.1.50   # your LAN address
```

Windows Defender Firewall blocks inbound connections by default, so add a rule.
This needs an elevated PowerShell **once**:

```powershell
New-NetFirewallRule -DisplayName "omp-pulse" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 7681 -Profile Private
```

Keep it on `Private` so it never applies on a coffee-shop network. On this tier the
app still works for browsing and prompting, but it cannot be installed to the home
screen and notifications will not arrive.

## 4. Pair the phone

```powershell
omp-pulse.exe pair
```

Scan the QR code or open the printed URL and submit the enrollment form.
The code expires after five minutes and can be used once. The phone receives
an independent credential; use `pair --role read` for read-only access or
`pair --role admin` for device administration. Keep enrollment links private.

## 5. Start it automatically

```powershell
omp-pulse.exe service install
omp-pulse.exe service status
```

On Windows this registers a Task Scheduler task called `OmpPulse` that runs at
logon as you, with no admin rights. Installation also starts it immediately and
waits up to 30 seconds for its listener; failure or timeout is reported instead of
claiming it is ready to pair. A real Windows Service would need a
service-control binary; a logon task keeps this user-level. Remove it with
`omp-pulse.exe service uninstall`.

## 6. Check it

```powershell
omp-pulse.exe doctor
```

Every line either passes or says why. It reports the omp binary it found, the
sessions it can see, the address the running daemon actually bound, whether that
address is a secure context, and what ownership protection this platform gives.

Once the phone has the app installed and has allowed notifications:

```powershell
omp-pulse.exe push-test
```

That sends one real notification per subscribed device. If none arrive, the app is
either not installed to the home screen or notifications are blocked for it.

## What is degraded on Windows

Some features are reduced or missing on Windows:

| feature | Windows | why |
|---|---|---|
| phone browsing, prompting, streaming | full | no platform dependency |
| notifications | full | needs a secure context, as everywhere |
| history, search, file browsing | full | |
| autostart | Task Scheduler logon task | a real service needs a service-control binary |
| terminal auto-adoption (`/collab` typed for you) | **not available** | Pulse's terminal-control fallback (herdr, kitty, tmux) is Unix-only; native bridge and Collab still work |
| protection against two writers on one session | **reduced** | see below |

**Desktop sharing.** Native Collab discovery works without terminal control:
enable omp’s opt-in `collab.autoStart: control` and point `collab.relayUrl`
at Pulse. On attach/send, Pulse retrieves the exact host’s generation-bound
link through the supported omp CLI. View-only hosts remain view-only.
If no native host exists, Windows still requires one manual `/collab` per
room; Linux/macOS can instead use herdr, kitty or tmux terminal adoption.

**Two-writer protection.** omp rewrites a session file wholesale from memory, so
two processes writing one session destroys history. omp-pulse refuses to spawn a
writer for a session another omp already holds. It detects that in three layers:
a sidecar `.owner` file, matching process arguments, and inspecting open file
handles. The third layer needs `/proc` (Linux) or libproc (macOS); Windows has no
cheap equivalent, so it runs with the first two. In practice: if the other omp was
started with the session path or id on its command line, or by another omp-pulse,
it is detected. A session opened in a way that names neither is not.
`omp-pulse.exe doctor` states this plainly under `ownership-guard`.

## What has not been tested

omp-pulse is compiled for Windows, its test suite runs on real Windows in hosted
CI, and the release build links the C runtime statically (the release workflow
checks it imports no Visual C++ runtime DLL). **It has not been used interactively
on Windows.** The Linux and Alpine paths are exercised end to end; on Windows only
the tests have run.

So if you are the first person to run this on Windows, expect the rough edges to be
in the platform-specific corners: the Task Scheduler task, path handling with
spaces, and the ownership guard. `omp-pulse.exe doctor` is the first thing to run
when something looks wrong, and its output is the most useful thing to send back.
