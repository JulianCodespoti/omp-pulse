# Deploying to your own daemon

How to put a change live on a daemon you run yourself (web client, APK and
binary together), and how to check it afterwards. Releases for other people are
in [releasing.md](releasing.md).

## The pipeline: `scripts/deploy/pulse-deploy.sh`

```sh
scripts/deploy/pulse-deploy.sh                  # build everything, restart, verify
scripts/deploy/pulse-deploy.sh --no-apk         # skip the Android build; keep the published APK
scripts/deploy/pulse-deploy.sh --no-restart     # build only; nothing goes live
scripts/deploy/pulse-deploy.sh --clean          # gradle clean first (after AGP/Gradle, signing, R8 or SDK changes)
scripts/deploy/pulse-deploy.sh --force-restart  # restart without waiting for turns (see below)
scripts/deploy/pulse-deploy.sh --phone          # build the phone daemon/UI and queue an idle-safe swap
```

Improve this script rather than running ad-hoc build sequences. It finds the
running service and its HTTPS endpoint through `scripts/deploy/pulse-target.sh`
(Tailscale Serve discovery, which needs `tailscale` and `jq`), or takes the
endpoint from `OMP_PULSE_SERVER_URL`; that URL is baked into the deployment
APK. Gradle needs JDK 21 (a newer default JDK fails in jlink); set
`OMP_PULSE_JDK` if it is not at `/usr/lib/jvm/java-21-openjdk`.

### Stage order is load-bearing

1. `vite build` writes the web client to `public/app`.
2. Capacitor copies the same UI into the Android assets.
3. `scripts/android/build-runtime.sh` builds the phone-mode daemon (which embeds
   `public/` too) into the APK's jniLibs.
4. `gradle assembleRelease` publishes `public/app-release.apk` and
   `public/app-release.json`.
5. `cargo build --release` embeds `public/`: the web client and the fresh APK.
6. `scripts/deploy/pulse-restart.sh` puts the binary live.

`include_dir!` bakes `public/` into the binary at compile time, so everything
that writes into `public/` must finish before cargo runs. The script once built
cargo before Gradle, and every binary served the previous release's APK. The
runtime library embeds `public/` as well, so it runs after vite and before
Gradle, which packages it.

## The restart: `scripts/deploy/pulse-restart.sh`

```sh
scripts/deploy/pulse-restart.sh            # hand the restart to a detached waiter (default)
scripts/deploy/pulse-restart.sh --status   # is a restart pending, what is it waiting on, is the build live?
scripts/deploy/pulse-restart.sh --cancel   # drop a pending restart
scripts/deploy/pulse-restart.sh --force    # restart now, killing daemon-hosted turns
```

`pulse-deploy.sh` ends by calling it; run it on its own after a `--no-restart`
build. A restart kills every omp child the daemon hosts, so it waits until
`/api/status.busyChildren` reports none mid-turn. Desktop-bridged and terminal
turns run in their own omp processes and survive, so they are not waited on.
The wait runs as a transient user unit outside the daemon's process tree, with
no deadline: an agent deploying from a phone-hosted conversation is itself a
live turn, and an inline wait once waited on itself, while a 5-minute deadline
once left a build looking deployed but never live. A new run replaces a pending
one, so rerunning is always safe.

Once idle it installs the built binary at the service's executable path,
restarts the service and checks that the built and live release IDs match. A
200 on `/app/` alone does not prove the new release is live.

Do not bypass the wait with `--force`, `--force-restart` or a bare
`systemctl restart` unless the person running the daemon asks: a restart ends
every turn the daemon hosts.

`scripts/deploy/pulse-deploy.test.sh` (in the gate) covers target selection,
idle waiting and binary cutover against sandboxed commands.

## Phone-hosted daemon

`--phone` uses `http://127.0.0.1:7681/app/` instead of discovering a desktop HTTPS
endpoint. It implies `--no-apk`: the installed app's WebView loads the daemon's
embedded client, so a web-only change needs a daemon rebuild, not a new APK.
The web build still finishes before cargo embeds it, including the local offline
fallback URL.

For an isolated smoke check before scheduling the swap:

```sh
scripts/deploy/pulse-deploy.sh --phone --no-restart
# Run release smoke checks through e2e/with-test-daemon.sh, never the live port.
release_id=$(cat target/release/omp-pulse.release-id)
binary="$HOME/.local/opt/omp-pulse/omp-pulse-$release_id"
install -Dm755 target/release/omp-pulse "$binary"
/root/projects/phone-harness/bin/pulse-swap "$binary"
```

Without `--no-restart`, the pipeline installs the same release-specific binary
and invokes that helper automatically. `OMP_PULSE_PHONE_SWAP` can select its path.
The phone harness must provide its idle-safe waiter: it waits until all
daemon-hosted turns finish before restarting. A deployment conversation hosted by
that daemon cannot observe its own cutover before ending. Do not claim the new
release is live merely because the swap was queued; compare `/api/version`'s
`releaseId` with the built ID after reconnecting. `--force-restart` is rejected in
phone mode. The helper falls back to the APK daemon if the new binary fails during
startup.


## Checks against a deployed daemon

These three scripts read a real, deployed daemon. They are not in the gate,
because the gate never touches a real daemon, and because what they compare
(the phone's view, herdr's panes, network timing) only exists on a live
machine. All three are read-only. Send and state-transition regressions run
only through `e2e/with-test-daemon.sh`; see [testing.md](testing.md).

| Script | What it checks | Run |
|---|---|---|
| `scripts/deploy/verify-as-user.mjs` | loads the deployed app as the owner, opens every live laptop session plus N recent ones, and diffs rendered state (message counts, titles, exact rendered paths, console errors, dead sockets) against the daemon | `OMP_PULSE_BASE=https://host OMP_PULSE_TOKEN=... node scripts/deploy/verify-as-user.mjs [N]` (N defaults to 5) |
| `scripts/deploy/verify-perf.mjs` | the load-performance budget of the deployed app on a mid-range phone profile (4x CPU throttle, about 4 Mbps, 150 ms RTT), median of several runs | `OMP_PULSE_BASE=https://host OMP_PULSE_TOKEN=... node scripts/deploy/verify-perf.mjs` |
| `scripts/deploy/verify-herdr-alignment.py` | every herdr pane against the daemon's listing: herdr's view against real files and API ownership | `python3 scripts/deploy/verify-herdr-alignment.py` (`OMP_PULSE_BASE`, default `http://127.0.0.1:7682`; `OMP_PULSE_TOKEN_FILE`, default the state directory's `token`) |

Each exits with the number of failures or mismatches.
