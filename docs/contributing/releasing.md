# Releasing

How public releases are built, how a build is identified, how third-party
licences travel with it, and how to point a fork at your own repository.
Deploying to your own daemon is in [deploying.md](deploying.md).

## Cutting a release

A release is one GitHub release, tag `v<version>` from `Cargo.toml`, fed by two
producers:

- **The release workflow** (`.github/workflows/release.yml`), started by pushing
  the tag, builds the daemon for every target in `scripts/release/targets.json`:
  static musl Linux (x86_64, aarch64; runs on any distribution), macOS (x86_64,
  aarch64) and Windows x86_64 (msvc). One web build feeds all of them, so they
  share one release ID.
- **`scripts/release/release.sh`**, on your machine, builds the signed public
  APK and the proot/talloc sources the GPL and LGPL require. The signing key
  never leaves your machine, which is why this half is not in the workflow.

Both upload through `scripts/release/publish-assets.sh`, which rewrites
`SHA256SUMS` over every asset the release holds, so the order does not matter.

```sh
git tag v0.1.0 && git push origin v0.1.0   # workflow: daemon archives, draft release
git checkout v0.1.0                        # clean checkout of the tag
scripts/release/release.sh                 # build the APK into dist/, no upload
scripts/release/release.sh --draft         # attach it to the draft release
scripts/release/release.sh --publish       # attach it, then publish
```

`--draft` and `--publish` refuse unless HEAD is the tag and the tree is clean:
the APK's release ID must match the one the workflow embedded in the daemons.
`--publish` also refuses while `SHA256SUMS` lacks any daemon archive or the APK,
because a public release missing one is an installer 404. To rebuild the
archives of an existing tag, run the workflow by hand (Actions → Release → Run
workflow) with the tag.

The public APK is built with `OMP_PULSE_SERVER_URL` unset, so its first run
offers "Run on this phone" or "Connect a laptop" instead of baking one
developer's server. It is signed with the same stable release key as a
self-hosted deployment APK (Gradle refuses a debug fallback), so sideloaded
installs update in place. A deployment APK with a baked URL is built only by
`scripts/deploy/pulse-deploy.sh`, and the release keeps it out of every public
artifact.

Requirements for `release.sh`: a Linux host with Rust and an aarch64 musl
toolchain for the phone-mode daemon ([android.md](android.md)), the Android
SDK, JDK 21 (`OMP_PULSE_JDK`, default `/usr/lib/jvm/java-21-openjdk`), your
release signing key (see `mobile/android/gradle.properties`), `jq`, and `gh`
authenticated as the owner of `origin` for `--draft` or `--publish`. Node runs
through `mise` when it is installed, otherwise the `node` on PATH must satisfy
`web/package.json` "engines".

`--publish` creates a public release: it has real side effects.

### Adding a platform

Add an entry to `scripts/release/targets.json` (`target` triple, hosted
`runner` label). The workflow matrix, the archive packaging, the publish check
and the licence notices (`third-party-licenses.mjs`) all read it; the
installers need the matching detection.

## Release identity: `scripts/release/release-id.sh`

Prints the immutable release ID of the source tree. Vite, Gradle and `build.rs`
all consume the same value (the web build writes it to `public/app/release-id`,
and `build.rs` refuses to build without it), so the daemon, the web client and
the APK can tell whether they come from the same build. The phone's stale-client
check and `pulse-restart.sh`'s "is the build live" check both compare it.

Generated outputs (web, APK, daemon) are excluded from the fingerprint, which
would otherwise be circular. Source edits, staged edits and untracked source
files are included, and so is the selected phone endpoint, so an APK aimed at
another host never shares a release ID.

## Licences: `scripts/release/third-party-licenses.mjs`

Writes the licence notices of every third-party Rust crate and production npm
package compiled into omp-pulse into `<outDir>/licenses/` (`rust-crates.txt`,
`npm-packages.txt`). `web/vite.config.ts` runs it after every `vite build`, so
the notices land in `public/app`, which the daemon embeds and the APK bundles.
By hand:

```sh
node scripts/release/third-party-licenses.mjs public/app
```

It needs a working `cargo metadata` and `npm ci` in `web/`, and fails when a
crate or package has neither a licence file nor a licence expression.
Components that are not crates or npm packages (proot, the runtime downloads,
icons) are listed by hand in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Forks: `scripts/release/set-repo.sh`

The GitHub owner/repo slug appears in the README, both installers, the docs,
the Android app, `Cargo.toml` and the changelog, and they must all agree or a
user gets a 404 halfway through an install. Never edit it by hand:

```sh
scripts/release/set-repo.sh <github-owner> [repo-name]   # repo-name defaults to omp-pulse
```

Run it once from anywhere in the checkout, then review and commit the diff. It
is idempotent, and `Cargo.toml`'s `repository` is the source of the current
values and is rewritten last, so an interrupted run can simply be rerun.
