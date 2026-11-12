# Phone mode

Phone mode runs the omp coding agent entirely on an Android phone, with no computer.
The Android app installs a small Alpine Linux runtime in its private storage, runs
`omp` and the omp-pulse daemon inside it, and shows the same interface you would get
from a laptop's daemon. A laptop stays optional: the same app can instead connect to
a laptop's daemon.

How it works inside is in [docs/internals/phone-mode.md](../internals/phone-mode.md).

## Requirements

- An **arm64** (64-bit ARM) phone with **Android 7.0** or newer.
- About **500 MB** of free storage: omp is about 230 MB, the Linux packages about
  200 MB unpacked, the base system about 16 MB unpacked (its 4 MB download is deleted
  after extraction).
- A network connection on first run, to download the runtime. Later starts download
  nothing unless an app update changes a pinned version; the agent itself still needs
  its model provider.

## First run

1. Install the app (see [Getting the app](#getting-the-app-and-updates)).
2. Open it and choose **Run on this phone**. It downloads the pinned Alpine runtime
   and omp, showing progress, and checks every file against a SHA-256 pin before
   using it.
3. Sign in to a model provider.
4. Start a chat.

To use a laptop instead, choose **Connect a laptop** and enter your daemon's
`https://…/app/` address; pairing then works as described in the
[README](../../README.md).

## Device compatibility

| Condition | Status | Why |
|---|---|---|
| ABI arm64-v8a only | Supported | The app is deliberately arm64-only and carries no native libraries for other ABIs, so Android refuses to install it on 32-bit ARM, x86 or x86_64. On those devices use the web app instead: open your daemon's `https://…/app/` address in the browser and install it from the browser menu. |
| Android 7.0 (API 24)+ | Supported | The bundled proot build targets API 24. The app installs from Android 5.1 (API 22), but API 22–23 offer laptop mode only. |
| 4 KB and 16 KB page sizes | Supported | Every shipped binary is aligned for 16 KB-page kernels (Android 15+ devices). |
| Secondary users and work profiles | Supported | Each user or profile gets its own runtime and its own storage. |
| OEM battery killers (Xiaomi/MIUI, Huawei, Samsung, OnePlus, Oppo/Realme, Vivo) | Mitigated, not solved | See [Keeping it running](#keeping-it-running). |

## Settings and stopping phone mode

Settings groups the active runtime's controls under **Run on this phone** or
**Run on PC**. Model providers apply to that runtime. Phone access and stopping
phone mode appear only when running on the phone; pairing repair and **Unpair
this phone** apply only to a computer connection.

To free the phone's runtime resources, open **Settings › Stop phone mode** and
confirm **Stop**. This ends running phone tasks and returns to the run-location
chooser. Your conversations, project files and provider sign-ins stay installed.
Phone mode stays off when you reopen the app or restart the phone.

Choose **Run on this phone** to resume without repeating provider or permission
setup. If you have saved computers, the off screen lists them with **Online** or
**Offline** status. Tap one to continue using its existing pairing; nothing
switches automatically. Offline computers remain selectable in case they have
just become available. **Connect another computer** pairs a new PC.

## Keeping it running

The daemon runs in a foreground service, and onboarding asks you to let the app
ignore battery optimisations. Some manufacturers still kill background apps; the
per-vendor steps are at <https://dontkillmyapp.com>. Opening the app in phone mode
starts the service again.

## Getting the app and updates

Install the APK from the GitHub release (`omp-pulse-<version>-android-arm64.apk`,
listed in `SHA256SUMS`; `omp-pulse.apk` always points at the newest), or track the
releases with [Obtainium](https://github.com/ImranR98/Obtainium). Public releases are
signed with the same stable key, so updates install in place.

The app is not on Google Play and is not designed to be: it downloads and runs code
that is not in the APK (Alpine packages, omp), which Play's Device and Network Abuse
policy forbids, and it uses permissions Play restricts (all-files access,
`QUERY_ALL_PACKAGES`, `REQUEST_INSTALL_PACKAGES`, an accessibility service for phone
control).

An app update upgrades omp-pulse itself with no download, and replaces omp only
when it pins a new version (an omp you upgraded yourself with `omp update` is left
alone otherwise). Your home directory and projects are never replaced. The full
policy is in [phone-mode internals](../internals/phone-mode.md#upgrade-policy).

## Phone tools for the agent

By default the agent on the phone can work on files and run code in its Linux
runtime, but cannot operate the phone. Settings › Phone access › **Phone tools for
the agent** turns on a set of tools that can: an `android` command and a `phone`
tool server that list, launch and install apps, read and write the clipboard, read
the screen, take screenshots and (once you enable the app's accessibility service)
tap, type and swipe, plus instructions and skills that teach the agent to use them.
Turning it off removes the tools again; files you or the agent created stay.

The accessibility service reads the screen only when the agent asks for it and does
not react to what you do in other apps, which keeps its battery cost low while it is
switched on.

Read this before turning it on:

- **proot is not a sandbox.** Everything in the runtime, including the agent and any
  code it runs, runs as the app, with the app's Android permissions and access to
  its private data.
- **There is no per-action approval.** The gates are the Android permissions you
  grant and whether the accessibility service is on.

The full threat model is in [SECURITY.md](../../SECURITY.md#threat-model-on-device-runtime-phone-mode).

## Licences

The app includes third-party binaries: proot (GPL-2.0-or-later), talloc
(LGPL-3.0-or-later) and libandroid-shmem (BSD-3-Clause). It downloads omp (MIT) and
Alpine Linux packages (each under its own licence) at runtime. Each release that
ships the APK also carries `proot-5.1.107.96-source.zip`, the complete proot source
(GPL-2.0 §3). Versions and checksums are in
[mobile/android/vendor/proot/PROVENANCE.md](../../mobile/android/vendor/proot/PROVENANCE.md);
licence texts and notices are in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
