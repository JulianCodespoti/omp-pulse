# Security policy

## Supported versions

Only the latest release receives security fixes. The first public release is 0.1.0.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
<https://github.com/JulianCodespoti/omp-pulse/security/advisories/new>

Do not open a public issue, discussion or pull request for a suspected vulnerability.

Please include:

- the omp-pulse version (`omp-pulse version`) and platform (Linux, macOS, Windows, Android
  phone mode or laptop mode);
- how the daemon is exposed (loopback, Tailscale Serve, Cloudflare tunnel, LAN);
- steps to reproduce, or a proof of concept;
- the impact you expect (who can do what they should not be able to).

This is a volunteer project. Reports are handled on a best-effort basis; the goal is to acknowledge
a report within a few days and to coordinate disclosure with you once a fix is available.

## Threat model: pairing and credentials (desktop daemon)

The daemon gives anyone holding a valid credential access to your omp sessions: it can read
transcripts and files, and a credential with control rights can send prompts, which means it can
make the agent run commands on your machine. Treat every credential as equivalent to a shell
account at the level of its role.

### Credentials

- **Owner credential.** A desktop-only administration credential stored in the daemon's state
  directory as `<state_dir>/token`. It is never put in a pairing QR code. Rotate it with
  `omp-pulse migrate-owner-token` (stop the daemon first).
- **Device credentials.** Each phone or browser gets its own credential by redeeming an
  enrollment code. Roles:
  - `read`: read and stream sessions;
  - `control`: read, stream and control (send prompts, act on sessions); the default;
  - `admin`: control, plus device management (issuing enrollment codes, listing devices,
    revoking other devices).
- **Enrollment codes.** Issued by `omp-pulse setup` or `omp-pulse pair [--role read|control|admin]
  [--name NAME]`. A code is single-use and expires after 5 minutes.
- **Storage on the daemon.** The device registry (`<state_dir>/devices.json`) stores only SHA-256
  digests of device tokens and pending enrollment codes; the clear values exist only in memory long
  enough to hand them to the caller. Comparisons are constant-time. A copy of the registry cannot
  be used to pair a new device or to authenticate. The owner `token` file itself is a live secret:
  protect the state directory.
- **Revocation.** Any device can revoke itself; an `admin` device (or the owner) can revoke
  another device (`DELETE /api/devices/{id}`, exposed in the app's settings). A revoked
  credential stops authenticating immediately.
- **Storage on Android.** The app's `TokenStore` uses `EncryptedSharedPreferences` (Android
  Keystore-backed) when it is available and falls back to the app's private `SharedPreferences`
  otherwise. In the fallback case the token is protected only by Android's per-app storage
  isolation.

### Transport

- The daemon binds `127.0.0.1:7681` by default (loopback only).
- API requests authenticate with `Authorization: Bearer <token>`. The WebSocket (`/ws`) and the
  server-sent event stream accept the token as a `?token=` query parameter because browser
  WebSocket and `EventSource` APIs cannot set headers; anything that logs full URLs (reverse
  proxies, tunnels) can therefore record it.
- Recommended remote access: **Tailscale Serve** (HTTPS, reachable only from your tailnet).
  A Cloudflare tunnel works but puts the daemon behind Cloudflare's edge; protect it with Cloudflare
  Access. Binding to a LAN address sends credentials over plain HTTP and is a degraded mode for
  trusted networks only. See [docs/user/networking.md](docs/user/networking.md).
- **Never expose the port to the public internet.** No router port forwarding, no `0.0.0.0` bind
  on an untrusted network. `tailscale funnel` is public internet exposure, not a private tailnet
  share.

### Web Push

Push notifications are encrypted (AES-128-GCM) before they reach the browser vendor's
push service, which sees only ciphertext and metadata (endpoint, size, timing). The decrypted
payload contains the session title, a short message body, the session file path and the
notification kind.

## Threat model: on-device runtime (phone mode)

In phone mode the app installs an Alpine Linux guest in its private storage and runs `omp` and
`omp-pulse` inside it under proot. See [docs/user/phone-mode.md](docs/user/phone-mode.md) for using it
and [docs/internals/phone-mode.md](docs/internals/phone-mode.md) for how the runtime works.

- **proot is not a sandbox.** It translates paths with `ptrace`; it is not a security boundary.
  Everything in the guest runs as the app's Android Linux UID, with the app's Android permissions
  and access to its private data.
- **The agent can run arbitrary code.** That is what a coding agent does. It can also drive the
  phone through **PhoneApi**, a loopback-only HTTP API (`127.0.0.1`, default port 7690) used by the
  guest's `android` CLI. Its commands include listing, launching, installing and uninstalling apps,
  sending intents and broadcasts, reading and writing the clipboard, posting notifications, reading
  the screen's UI tree, taking screenshots, and tapping, typing, swiping and pressing keys (the
  latter through the accessibility service, once you enable it). There is no per-action approval
  prompt: the gates are the Android permissions you grant and whether the accessibility service is
  on.
- **PhoneApi token.** Regenerated on every start and written to `/root/.config/omp-phone/token`
  (mode 0600) inside the guest. It is compared in constant time. Requests carrying an `Origin`
  header are rejected so web pages, including ones served on localhost, cannot call the API.
- **Provider credentials.** Model provider API keys or OAuth tokens from signing in are stored by
  omp inside the guest filesystem, in the app's private storage. Anything the agent runs can read
  them.
- **Downloads are pinned.** The Alpine rootfs and the `omp` binary are downloaded from URLs pinned
  in `assets/runtime/runtime.json` with their SHA-256 digests; nothing is moved to its final name
  until its digest matches. Alpine packages are then installed by `apk` from the pinned repository
  and verified by `apk`'s own signatures.
- **The phone harness is opt-in.** The harness (instructions, skills, the `android` CLI and tools
  that let the agent operate the phone) is installed only when you turn on **Phone tools for the
  agent** in Settings; it is off by default. When on, the app merges the bundled harness into
  `/root/projects/phone-harness` in the guest on daemon start and links it into omp's agent
  directory. The agent may edit it, and those edits survive app updates. Review it first: see
  [phone-harness/README.md](phone-harness/README.md).
- **Prompt injection.** Web pages, files, notifications, screen contents and tool output that the
  agent reads can contain instructions. They can steer it into using phone APIs, sending messages,
  or exfiltrating files and credentials.

Recommendations:

- grant only the Android permissions you need (all-files access, accessibility, install packages
  are each a large expansion of what the agent can do);
- review the phone harness and what you ask the agent to read;
- use a dedicated model provider key with a spending limit;
- keep Android and the app updated.

## Out of scope

- A compromised host OS, Android device, or app-private storage.
- Anyone who already holds the owner credential or an `admin`/`control` device credential acting
  within that role.
- Actions the agent takes because you, or content you pointed it at, told it to.
- Vulnerabilities in omp itself: report them upstream to
  [oh-my-pi](https://github.com/can1357/oh-my-pi).
- Vulnerabilities in proot, Alpine packages, or other third-party components: report them to those
  projects.
