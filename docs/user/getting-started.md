# Getting started

Install Pulse on your computer, pair your phone and start your first
conversation. If you only want the agent on an Android phone, with no computer,
skip this guide and read [Phone mode](phone-mode.md).

## 1. What you need

- A Mac, Windows or Linux computer with [omp](https://github.com/can1357/oh-my-pi) installed and working. Check with `omp --version`.
- An Android phone or an iPhone.
- [Tailscale](https://tailscale.com) signed in on both the computer and the phone. It is optional but recommended: it gives your computer a private, secure address that works anywhere.

## 2. Install Pulse

On Mac and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/JulianCodespoti/omp-pulse/main/install.sh | sh
```

On Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/JulianCodespoti/omp-pulse/main/install.ps1 | iex
```

Both installers check the download against the release's published checksums
(`SHA256SUMS`) before installing. Pulse goes to `~/.local/bin` on Mac and Linux,
and to `%LOCALAPPDATA%\Programs\omp-pulse` on Windows. The Windows guide has
more detail, including how to inspect the script first:
[Windows](windows.md).

## 3. Start it

```sh
omp-pulse setup
omp-pulse service install
```

`setup` prepares Pulse and connects it to omp. `service install` starts Pulse in
the background whenever you log in. If you would rather run it in a terminal
window, use `omp-pulse serve` instead.

Reopen any omp sessions that were already open, so they load the Pulse
extension.

## 4. Give it a secure address

Pulse listens on `127.0.0.1:7681`, which only your computer can reach. With
Tailscale signed in, one command gives it a private https address:

```sh
tailscale serve --bg --set-path / http://127.0.0.1:7681
```

Your address will look like `https://<machine>.<tailnet>.ts.net/`.

Why https matters: browsers only allow notifications and adding Pulse to your
Home Screen on a secure (https) address. Without one, Pulse still works on your
home Wi-Fi, but you lose both. See
[Why HTTPS matters](networking.md#why-https-matters).

Prefer not to use Tailscale? [Networking](networking.md) covers Cloudflare
Tunnel and plain home Wi-Fi.

## 5. Pair your phone

```sh
omp-pulse pair
```

Pulse prints a QR code and a link.

- **Android app:** install the [Android app](https://github.com/JulianCodespoti/omp-pulse/releases/latest/download/omp-pulse.apk), tap **Connect a computer**, enter your address (it ends in `/app/`), then scan the QR code or type the code.
- **Any phone's browser, including iPhone:** open the link or scan the QR code, finish pairing, then add Pulse to your Home Screen. On iPhone, use Safari and choose **Add to Home Screen**.

Each code works once and expires after five minutes; run `omp-pulse pair` again
for a fresh one. To pair a watch-only device that can follow along but not send,
run `omp-pulse pair --role read`. More on roles:
[Pairing roles](configuration.md#pairing-roles).

## 6. Start a conversation

Start a new conversation in a project folder, or open a session that is already
running on your computer, including one you began in your terminal. You can read
any session straight away.

Sending to a session that is open in a terminal needs the terminal to share it,
so Pulse never overwrites your terminal's work. Pulse joins by itself in tmux,
kitty and herdr (Mac and Linux only), and in Tern once the session is shared.
Anywhere else, type `/collab` in the session once. The details are in
[Live sharing with the desktop terminal](configuration.md#live-sharing-with-the-desktop-terminal).

## 7. Turn on notifications

Open **Settings** in the app and choose **Notifications** to get a tap when a
reply is ready or the agent is waiting on you. To check that everything is
connected, run this on your computer:

```sh
omp-pulse push-test
```

It sends a real notification to every device that has them on. On iPhone,
notifications work only once Pulse is added to your Home Screen. See
[Notifications](configuration.md#notifications).

## 8. If something doesn't work

Run:

```sh
omp-pulse doctor
```

It checks every link between your phone, Pulse and omp. If that does not point
you at the problem, see [Troubleshooting](configuration.md#troubleshooting).

## 9. Next

- [Phone mode](phone-mode.md): run the agent on your Android phone.
- [Plugins](plugins.md): add your own buttons, chips and cards.
- [Networking](networking.md): Tailscale, Cloudflare Tunnel and home Wi-Fi.
- [Configuration and operation](configuration.md): every command and setting.
