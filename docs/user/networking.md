# Networking: reaching your daemon from a phone

There are three ways to get from your phone to the daemon. They are not equal:
two give you HTTPS and the full app, one is degraded. This document gives the
commands for each and explains why the difference matters.

## Why HTTPS matters

The phone app is a progressive web app. It registers a service worker, keeps
an offline queue, subscribes to Web Push for background notifications, and
uses binary WebSocket frames for compressed payloads. Browsers only permit
service workers, the Push API, and those binary frames in a **secure context**
(an HTTPS page, or `http://localhost`). On a plain-http LAN address:

- the service worker will not register, so the app cannot be installed and has
  no offline cache;
- Web Push subscriptions are refused, so background notifications never
  arrive;
- the app falls back to text frames and polling. That still works, it just is
  not what the app was built for, and every byte costs more.

So: use a TLS-terminating tier for everyday use, and treat plain LAN as a
quick-look tier.

## Tier 1: Tailscale (recommended)

Install Tailscale on the machine running the daemon and on the phone (the
Tailscale app for iOS or Android). Both devices must be signed into the same
tailnet.

```sh
sudo tailscale up
```

Start the daemon. It binds to `127.0.0.1:7681` by default; that is exactly
right for this tier, because Tailscale proxies to the loopback interface and
nothing else on the network can reach the daemon directly.

```sh
omp-pulse serve
```

Expose the local port through Tailscale's HTTPS proxy (this is the command
`omp-pulse setup` and `omp-pulse pair` print when they find no HTTPS front door):

```sh
tailscale serve --bg --set-path / http://127.0.0.1:7681
```

The command prints your URL, `https://<machine>.<tailnet>.ts.net/`. Open it on
the phone. `tailscale serve` terminates TLS with a certificate your devices
trust automatically, so this is a secure context: the app installs, Web Push
registers, and binary frames work. The URL is only reachable by devices on
your tailnet. The daemon detects this front door and uses it in pairing links.

Binding the daemon to the tailnet IP instead does not give you HTTPS: the phone
would reach it over plain HTTP, which is tier 3 with extra steps.

To stop serving (all original flags are required, `off` replaces the target):

```sh
tailscale serve --bg --set-path / off
```

To clear the whole serve configuration: `tailscale serve reset`.

If you want to reach the daemon from outside the tailnet, `tailscale funnel`
can publish the same proxy publicly. Think hard before doing that: device
credentials are then your only protection, and the daemon was designed
for a private network. See the security model in [SECURITY.md](../../SECURITY.md).

## Tier 2: Cloudflare Tunnel

A quick tunnel needs no account, no DNS, and no inbound firewall rules; it
works from anywhere, including machines behind CGNAT:

```sh
cloudflared tunnel --url http://127.0.0.1:7681
```

`cloudflared` prints a `https://<random>.trycloudflare.com` URL. It is HTTPS,
so this is a secure context and the full app works. Caveats:

- the quick-tunnel URL is random and changes every time the process starts, so
  you must re-open it on the phone each time;
- the URL is public: anyone who finds it reaches your daemon. Device
  credentials are then your only protection. The pairing link carries only a
  short-lived, single-use enrollment code in its URL fragment, and fragments
  are never sent to servers;
- traffic passes through Cloudflare's edge.

For a stable hostname, use a named tunnel:

```sh
cloudflared tunnel create omp-pulse
cloudflared tunnel route dns omp-pulse pulse.example.com
cloudflared tunnel --url http://127.0.0.1:7681 run omp-pulse
```

You can lock the named tunnel down further with a Cloudflare Access policy.
Run `cloudflared tunnel run` under the service manager of your choice so it
survives reboots.

## Tier 3: LAN plus token (degraded)

On a trusted home network, no tunnel is needed, but the daemon must listen on
the LAN interface rather than loopback:

```sh
omp-pulse serve --bind 0.0.0.0
```

(Or set the bind address in `config.toml`; see the
[configuration reference](configuration.md).) Find the laptop's LAN address with `ip addr` (Linux), `ifconfig`
(macOS) or `ipconfig` (Windows), then run `omp-pulse pair` against the running
daemon and open its `/app/#pair=<code>` URL on the phone. Submit the enrollment
form before the five-minute, single-use code expires.

Firewall note: open TCP 7681 on the laptop's firewall, and only on the
interface/subnet you trust. On Linux with UFW:

```sh
sudo ufw allow from 192.168.1.0/24 to any port 7681 proto tcp
```

On macOS, allow incoming connections when prompted; on Windows, add an inbound
rule for private networks in Windows Defender Firewall.

Why this tier is degraded: plain http is not a secure context, so the app
cannot install, Web Push subscriptions are refused, and binary frames are
unavailable; the app falls back to text frames and polling. Device credentials
also cross the LAN in the clear, which is acceptable on a trusted home
network and not on public Wi-Fi. Tailscale is free for personal use and takes
two commands; prefer it.

## Revocation and migration from shared-token pairing

Each enrolled device has its own read, control or administrator credential.
An administrator can revoke one device in Settings without disrupting other
devices or stopping desktop sessions. The affected device must pair again.

Older versions shared the desktop owner credential with phones. Merely
installing the new binary cannot invalidate a credential still used for
desktop administration. Perform the explicit cutover when ready to re-pair:

1. Stop the daemon or its service. Do not stop the desktop omp sessions.
2. Unset `OMP_PULSE_TOKEN` and `OMP_REMOTE_TOKEN` overrides if configured.
   `omp-pulse migrate-owner-token` refuses to rotate while an override remains.
3. Run `omp-pulse migrate-owner-token`. It replaces the desktop owner token
   on disk and refuses to run while the daemon is active.
4. Start the daemon, then run `omp-pulse pair --role admin` for a trusted
   administrative device. Pair other devices with the least privilege needed.
5. Forget the old pairing on each phone and redeem a fresh enrollment code.
   Old shared credentials are rejected by the restarted daemon.

The owner credential is never printed in the pairing QR. Treat both enrollment
links and device credentials as secrets. Use HTTPS: URL fragments are not sent
in HTTP requests, but pairing redemption and authenticated API requests do
transmit credentials.
