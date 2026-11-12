# Documentation

Start with the [README](../README.md) to install and pair a phone. Everything
else is here, by reader.

## For users

- [Configuration and operation](user/configuration.md): commands, `config.toml`, environment variables, files, platform support, troubleshooting.
- [Networking](user/networking.md): reaching the daemon from a phone (Tailscale, Cloudflare Tunnel, LAN) and why HTTPS matters.
- [Windows](user/windows.md): setup on Windows and what is degraded there.
- [Phone mode](user/phone-mode.md): running omp and the daemon on an Android phone.
- [Plugins](user/plugins.md): adding small views fed by host commands, the manifest, the script API, review and the security model.
- [Security policy](../SECURITY.md): threat model, credentials and roles, reporting a vulnerability.

## For contributors

- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, the gate, where things live and where new things go.
- [AGENTS.md](../AGENTS.md): the rules for coding agents (and humans).
- [Testing](contributing/testing.md): every kind of test, how it runs, and what the gate runs.
- [Android](contributing/android.md): building the APK on a laptop or a phone, side-by-side installs, runtime pins, bumping omp, adding an ABI.
- [Deploying](contributing/deploying.md): putting a change live on your own daemon, and checks against a deployed daemon.
- [Releasing](contributing/releasing.md): release builds, release identity, licences, forks.
- [Benchmarks](contributing/benchmarks.md): the bench harness, corpus, running each suite.
- [UI review](contributing/ui-review.md): photographing every UI state, the review daemon, README media.

Directory guides:

- [e2e/README.md](../e2e/README.md): end-to-end tiers and every suite.
- [scripts/README.md](../scripts/README.md): every maintainer script.
- [mobile/android/host-tests/README.md](../mobile/android/host-tests/README.md): the Android host-JDK harnesses.
- [extensions/README.md](../extensions/README.md): the two omp extensions the daemon embeds.
- [phone-harness/README.md](../phone-harness/README.md): the phone agent's optional tools (shipped in the APK).
- [web/AGENTS.md](../web/AGENTS.md): web client boundaries and commands.

## Internals

- [Architecture](internals/architecture.md): the problem, the shape, where code lives, the four live paths, boundaries and invariants.
- [Module index](internals/modules.md): one line per Rust module, generated from the `//!` headers by `scripts/docs/codemap.sh`.
- [Session state](internals/session-state.md): the per-session authority record, turns, and the pool of omp children.
- [Delivery](internals/delivery.md): command ledger, receipts, device enrolment, browser and Android outboxes, drafts.
- [Desktop integration](internals/desktop-integration.md): desktop bridge, collab relay, desktop control, laptop handoff and herdr.
- [Dialogs and controls](internals/dialogs-and-controls.md): `ask` dialogs, blocked conversations, phone controls.
- [Web client](internals/web-client.md): read state, session listing, usage meters, workspace tabs, images, offline cache.
- [I/O bounds](internals/io-bounds.md): file-I/O admission, session-index memos, watcher boundaries, socket queue accounting.
- [Notifications](internals/notifications.md): Web Push and the Android native stream.
- [Dictation](internals/dictation.md): local speech-to-text.
- [Performance](internals/performance.md): measured baseline and findings F1 to F13.
- [Phone mode internals](internals/phone-mode.md): the on-device runtime, install, upgrades and harness wiring.
