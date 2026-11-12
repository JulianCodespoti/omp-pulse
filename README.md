<p align="center">
  <img src="web/public/icon.svg" width="76" height="76" alt="OMP Pulse icon">
</p>

<h1 align="center">OMP Pulse</h1>

<p align="center">
  <strong>Your coding agent, in your pocket.</strong> Follow, answer and steer <a href="https://github.com/can1357/oh-my-pi">omp</a> from your phone, or run it on Android with no computer at all.
</p>

<p align="center">
  <a href="https://github.com/JulianCodespoti/omp-pulse/actions/workflows/ci.yml"><img src="https://github.com/JulianCodespoti/omp-pulse/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/JulianCodespoti/omp-pulse/releases/latest"><img src="https://img.shields.io/github/v/release/JulianCodespoti/omp-pulse?label=release&color=7c65ec" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-34d399" alt="MIT Licence"></a>
</p>

<p align="center">
  <a href="https://juliancodespoti.github.io/omp-pulse/">Website</a> ·
  <a href="docs/user/getting-started.md">Get started</a> ·
  <a href="#phone-mode-android-no-computer">Phone mode</a> ·
  <a href="https://github.com/JulianCodespoti/omp-pulse/releases/latest/download/omp-pulse.apk">Download APK</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="SECURITY.md">Security</a>
</p>

<br>

<p align="center">
  <a href="docs/media/demo.gif"><img src="docs/media/demo.gif" width="270" alt="Opening a running session from the side panel, then watching the agent edit a file, run its tests and write its reply"></a>
  &nbsp;&nbsp;
  <a href="docs/media/screenshot-chat.png"><img src="docs/media/screenshot-chat.png" width="270" alt="A conversation in Pulse: the agent's steps listed above its reply, with the message box at the bottom"></a>
  &nbsp;&nbsp;
  <a href="docs/media/screenshot-workspace.png"><img src="docs/media/screenshot-workspace.png" width="270" alt="The workspace panel open on Changes, showing the lines added and removed in a file"></a>
</p>

<p align="center">
  <em>Left: opening a session and watching the agent edit code and run its tests. Middle: a conversation, with the agent's steps above its reply. Right: the files the agent changed, line by line.</em>
</p>

---

## What you can do

Everything you would check at your desk, from wherever you are. Pulse shows the agent's real work as it happens, laid out for one thumb.

<table>
  <tr>
    <td align="center" width="33%">
      <a href="docs/media/screenshot-drawer.png"><img src="docs/media/screenshot-drawer.png" width="240" alt="The side panel listing projects, conversations that need you, pinned and recent conversations"></a>
      <br>
      <sub>Every conversation, one swipe away, with the ones waiting on you at the top.</sub>
    </td>
    <td align="center" width="33%">
      <a href="docs/media/screenshot-ask.png"><img src="docs/media/screenshot-ask.png" width="240" alt="A question from the agent with several choices, one marked as recommended"></a>
      <br>
      <sub>Answer the agent's questions in one tap.</sub>
    </td>
    <td align="center" width="33%">
      <a href="docs/media/screenshot-phone-tools.png"><img src="docs/media/screenshot-phone-tools.png" width="240" alt="Settings, Phone access, with the Phone tools for the agent switch and the Android permissions it uses"></a>
      <br>
      <sub>On Android, let the agent use your phone, only when you allow it.</sub>
    </td>
  </tr>
</table>

- **See what it's doing, as it does it.** Every file it reads, change it makes and test it runs appears the moment it happens; step in mid-task or stop it.
- **Get a tap when it needs you.** Pulse notifies you when a reply is ready or the agent is waiting on you, even when the app is closed.
- **Answer in one tap.** When the agent needs a decision, pick a choice and it carries on, with no typing.
- **Check the work before it lands.** See exactly what changed, open any file, run a command in a terminal, and watch helper agents and the to-do list.
- **Every conversation, one swipe away.** Sessions are grouped by project, and you can search every conversation by title or by what was said.
- **Make it yours.** Add your own buttons, status chips and cards with [plugins](docs/user/plugins.md), or type `/pulse-plugin` and ask your agent to build one. Nothing runs until you approve it.

And:

- **Talk instead of typing.** Dictate a message; your speech is turned into text on your own computer, not in the cloud.
- **Switch models on the fly.** Change the model or how hard it thinks, mid-conversation.
- **Never lose a message.** Drafts and unsent messages survive a dropped connection.
- **Keep an eye on limits.** See how much of your model provider's usage limits you have left.
- **Watch-only devices.** Pair a second device that can follow along but not send.

## Two ways to use it

The same app either way. There is no Pulse account and no Pulse server in the middle: your code stays on your hardware, and the agent talks straight to the model provider you already use.

| | [With your computer](#desktop-daemon-mode) | [Phone only](#phone-mode-android-no-computer) |
|---|---|---|
| Works on | Android and iPhone | Android |
| Where the agent runs | Your Mac, Windows or Linux computer | The phone itself |
| Good for | Following long tasks away from your desk, answering questions, reviewing changes | Coding with no computer: clone, test, fix |

---

## Quick start

### Desktop daemon mode

Install and configure [omp](https://github.com/can1357/oh-my-pi) on your computer first (`omp --version`). The [Getting started guide](docs/user/getting-started.md) walks through the same steps with more detail.

#### 1. Install `omp-pulse`

**Linux** (`x86_64` or `aarch64`, static `musl` — any distro) and **macOS** (Apple Silicon or Intel):

```sh
curl -fsSL https://raw.githubusercontent.com/JulianCodespoti/omp-pulse/main/install.sh | sh
```

**Windows** (`x86_64`, PowerShell 5.1+):

```powershell
irm https://raw.githubusercontent.com/JulianCodespoti/omp-pulse/main/install.ps1 | iex
```

*(Or download [`install.ps1`](https://raw.githubusercontent.com/JulianCodespoti/omp-pulse/main/install.ps1) to inspect it first and run `powershell -ExecutionPolicy Bypass -File install.ps1`.)*

Both installers verify the archive against the release's `SHA256SUMS` before installing to `~/.local/bin` (Unix) or `%LOCALAPPDATA%\Programs\omp-pulse` (Windows).

#### 2. Set up and start the background service

```sh
omp-pulse setup
omp-pulse service install
```

`setup` prepares Pulse and connects it to omp: it writes `config.toml`, generates the desktop owner credential and installs the `omp` desktop-control extension (reopen idle `omp` sessions to load it). The service starts Pulse in the background whenever you log in. Prefer a terminal window? Run `omp-pulse serve`.

#### 3. Give it a private https address (recommended)

The daemon binds to `127.0.0.1:7681` by default. With [Tailscale](https://tailscale.com) signed into the same tailnet on your computer and phone:

```sh
tailscale serve --bg --set-path / http://127.0.0.1:7681
```

Tailscale provides a trusted https address (`https://<machine>.<tailnet>.ts.net/`), which Pulse needs to be added to your Home Screen, keep history offline and send notifications. For Cloudflare Tunnel or LAN setups, see [Networking](docs/user/networking.md).

#### 4. Pair your phone

```sh
omp-pulse pair
```

- **iPhone or Android browser (PWA):** Open the printed URL or scan the QR code, complete enrollment, and add the app to your Home Screen.
- **Android native app:** Install [`omp-pulse.apk`](https://github.com/JulianCodespoti/omp-pulse/releases/latest/download/omp-pulse.apk), tap **Connect a computer**, enter your `https://…/app/` URL, and scan or type the 6-digit pairing code.

Pairing codes are single-use and expire after 5 minutes. Use `omp-pulse pair --role read` for a watch-only device, or run `omp-pulse doctor` anytime to verify every link in the live-sync chain.

---

### Phone mode (Android, no computer)

Run `omp` and an Alpine Linux workspace directly on an **arm64** phone running **Android 7.0+**. Reserve roughly **500 MB** of free storage for the unpacked runtime (~250 MB one-time download) plus space for your repositories.

<p align="center">
  <a href="docs/media/screenshot-phone-mode.png"><img src="docs/media/screenshot-phone-mode.png" width="250" alt="Android onboarding screen offering Run on this phone or Connect a computer"></a>
</p>

1. Download and install **[`omp-pulse.apk`](https://github.com/JulianCodespoti/omp-pulse/releases/latest/download/omp-pulse.apk)** from the latest GitHub Release (updates are signed with a stable key and work cleanly with [Obtainium](https://github.com/ImranR98/Obtainium)).
2. Open the app and tap **Run on this phone**. Every Alpine package and the `omp` binary are verified against pinned SHA-256 digests before unpacking.
3. Open **Settings › Model providers** to sign in (Anthropic, OpenAI Codex, GitHub Copilot, Gemini, OpenRouter, DeepSeek, or API key), pick a folder, and start a chat.

Want the agent to interact with Android itself? Enable **Settings › Phone access › Phone tools for the agent** to expose the `android` CLI and `phone` tool server (app launching, clipboard, screenshots, and accessibility-gated UI actions). Read the [Phone Mode Guide](docs/user/phone-mode.md) for full details.

---

## How it works

Pulse is one small program that runs next to omp on your computer, plus the app on your phone. The program keeps your phone and your terminal in step, makes sure only one of them writes to a session at a time, and does almost nothing while nobody is watching. The Android app contains the same web app, so every client matches the program. For the full picture, read [Architecture](docs/internals/architecture.md) and [Performance](docs/internals/performance.md).

---

## Privacy, Security & Limitations

- **Your credentials stay with you.** Devices are stored on your computer by a hash of their key, each with a role (`read`, `control` or `admin`). Pairing QR links carry a short-lived code, never your owner secrets.
- **Phone mode is not sandboxed.** In Android phone mode, **`proot` is not a security sandbox**: commands the agent runs have the same Android user ID and permissions as the Pulse app. Read [SECURITY.md](SECURITY.md) before you turn on Android phone tools.
- **Platform limits.** There is no native iOS app and no on-device runtime for iPhone; iPhone uses the web app connected to a computer. The Android app is for arm64 phones only (`arm64-v8a`, with both 4 KB and Android 15+ 16 KB page sizes). Automatic joining of terminal sessions (`herdr`, `kitty`, `tmux`) works on Mac and Linux only; on Windows, sessions pair through native collab or `/collab` ([Windows guide](docs/user/windows.md)).

---

## Build from Source

Requires **Rust 1.95+** and **Node.js** matching `engines` in [`web/package.json`](web/package.json) (`22.22+`, `24.15+`, or `26+`). Build the embedded web client before compiling the Rust binary:

```sh
git clone https://github.com/JulianCodespoti/omp-pulse.git omp-pulse
cd omp-pulse
(cd web && npm ci && npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false)
cargo build --release
# binary: target/release/omp-pulse
```

To build the static product & documentation website locally into `website/dist/`:

```sh
node website/build.mjs
```

---

## Documentation

| Guide | What it covers |
|---|---|
| [Getting started](docs/user/getting-started.md) | Install Pulse, pair your phone and start your first conversation |
| [Configuration & CLI](docs/user/configuration.md) | All commands, `config.toml`, state files, environment variables, local speech-to-text |
| [Networking & HTTPS](docs/user/networking.md) | Tailscale Serve, Cloudflare Tunnel, LAN trade-offs, and PWA secure-context requirements |
| [Android Phone Mode](docs/user/phone-mode.md) | On-device Alpine runtime, storage & battery setup, Obtainium updates, Android agent tools |
| [Sandboxed Plugins](docs/user/plugins.md) | Custom drawer chips, transcript cards, quick actions, and host-command data sources |
| [Windows Setup](docs/user/windows.md) | Installing, running as a Task Scheduler task, and platform differences on Windows |
| [Architecture](docs/internals/architecture.md) · [Performance](docs/internals/performance.md) | Subsystem map, the four live paths, ownership arbitration, and measured benchmarks |
| [Documentation Index](docs/README.md) | Full user, contributor, Android build, UI review, and internals index |

---

## Contributing & Licence

Bug reports and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for workspace setup and run `scripts/ci.sh` before opening a PR (AI coding agents: read [AGENTS.md](AGENTS.md) first). Community participation follows the [Code of Conduct](CODE_OF_CONDUCT.md). Release notes live in [CHANGELOG.md](CHANGELOG.md).

**Relationship to omp:** OMP Pulse is an independent, unofficial companion for [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi), not affiliated with or endorsed by its authors. It contains no `omp` source code.

**Licence:** [MIT](LICENSE). Third-party notices — including the unmodified GPL-2.0 `proot` binaries bundled in the Android APK and accompanied by complete source archives on every release — are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
