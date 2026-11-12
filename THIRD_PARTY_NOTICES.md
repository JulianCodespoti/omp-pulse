# Third-party notices

omp-pulse is MIT-licensed (see [`LICENSE`](LICENSE)). This file lists the third-party software
and assets that omp-pulse redistributes or downloads, with their licences.

## Relationship to omp (Oh My Pi)

omp-pulse is an independent, unofficial companion for [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi).
It is not affiliated with, sponsored by or endorsed by the omp authors. It contains no omp source
code: it drives the `omp` you install yourself through omp's RPC mode and its extension API, and
the Android app's phone mode downloads the official omp release binary from omp's GitHub releases
onto your device. omp is MIT-licensed by its authors. "omp", "Oh My Pi" and the other product
names and logos shown in the app (for example, model providers' logos) are trademarks of their
respective owners and are used only to identify them.

## What ships where

| Artifact | Contains |
|---|---|
| `omp-pulse` daemon (Linux, Windows) | omp-pulse, Rust crates (below), the web client with its fonts and icons |
| Android APK | the web client, Capacitor, AndroidX, the phone-mode daemon (`libomppulse.so`, same crates), PRoot, talloc, libandroid-shmem |
| Downloaded on the phone at first run | omp, Alpine Linux (not redistributed by omp-pulse) |

Licence texts travel with the binaries: the web client carries `licenses/` (from
`web/public/licenses/`, plus the generated `rust-crates.txt` and `npm-packages.txt`, see
below), and the APK carries `assets/licenses/` (from
`mobile/android/app/src/main/assets/licenses/`, which also has a plain-text `NOTICE.txt`).

## Redistributed in the Android APK

Unmodified Termux builds, renamed `lib*.so` so Android installs them executable. Versions,
sha256 checksums and refresh steps: [`mobile/android/vendor/proot/PROVENANCE.md`](mobile/android/vendor/proot/PROVENANCE.md).
They run as separate programs and libraries; none is linked into omp-pulse.

### PRoot 5.1.107.96 (`libproot.so`, `libproot-loader.so`)

Copyright (C) 2015 STMicroelectronics and the PRoot contributors; Termux fork
<https://github.com/termux/proot>. Licensed under the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or (at your option) any later
version (text: `assets/licenses/GPL-2.0.txt` in the APK,
<https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>). PRoot is distributed WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

Source:

- <https://github.com/termux/proot/archive/v5.1.107.96.zip>, sha256
  `75f654fe60dea92dabff2bf083ae8bfe4f91baa6a1a374786a6bf391015eebaa`. Every GitHub release that
  ships the APK also carries this archive as `proot-5.1.107.96-source.zip`.
- Build recipe (the scripts that control compilation):
  <https://github.com/termux/termux-packages/blob/de39661946f7e8175b5dd0755121fa28cb0aebd1/packages/proot/build.sh>.
- Written offer: for at least three years after the last omp-pulse release that ships these
  binaries, anyone may obtain the complete corresponding source of PRoot and talloc as shipped,
  at no charge beyond the cost of providing it, by opening an issue in the omp-pulse repository.

### talloc 2.5.0 (`libtalloc.so`)

Copyright (C) Andrew Tridgell 2004-2005, Stefan Metzmacher 2006, and the Samba team. Licensed
under the GNU Lesser General Public License as published by the Free Software Foundation; either
version 3 of the License, or (at your option) any later version (texts: `assets/licenses/LGPL-3.0.txt`
and `assets/licenses/GPL-3.0.txt` in the APK, <https://www.gnu.org/licenses/lgpl-3.0.html>).

Source: every release that ships the APK carries `talloc-2.5.0.tar.gz`, identical to
<https://www.samba.org/ftp/talloc/talloc-2.5.0.tar.gz>, sha256
`912afa237510ae542a7733998eb18a12bcda35ab6729c8e2ddb43e8d0ebab007`; build recipe
<https://github.com/termux/termux-packages/blob/bddd9721910e56bc36412a764b4b4f7bbdbb1eb1/packages/libtalloc/build.sh>.
Used only by PRoot, which loads it as a separate shared library; you may replace it in the
installed app with a compatible build of your own.

### libandroid-shmem 0.7 (`libandroid-shmem.so`)

Source: <https://github.com/termux/libandroid-shmem/archive/refs/tags/v0.7.tar.gz>, sha256
`1e5ff8459bc0a8c229dd8a94b27d119987e09ef3414331c2b5ebfff20b98e867`. Licence, verbatim:

```
Copyright (c) 2013, Sergii Pylypenko
Copyright (c) 2017, Fredrik Fornwall
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice, this
  list of conditions and the following disclaimer in the documentation and/or
  other materials provided with the distribution.

* Neither the name of the {organization} nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Android libraries

- Capacitor (`@capacitor/android` 6.2.1), MIT, Copyright (c) 2017-present Drifty Co.
  (text: `assets/licenses/capacitor-MIT.txt`). It pulls in Apache Cordova's Android framework
  10.1.1.
- AndroidX (`appcompat`, `activity`, `fragment`, `core`, `core-splashscreen`,
  `coordinatorlayout`, `webkit`), Apache Cordova and the Kotlin standard library: Apache License
  2.0 (text: `assets/licenses/Apache-2.0.txt`).
- The Gradle wrapper (`mobile/android/gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`)
  is a build tool kept in the repository, not shipped in the APK: Apache License 2.0, Copyright
  2015-2021 the original authors.

## Downloaded at runtime (not in the APK)

Phone mode downloads these on the user's device from their publishers, pinned by sha256 in
[`mobile/android/app/src/main/assets/runtime/runtime.json`](mobile/android/app/src/main/assets/runtime/runtime.json).
omp-pulse does not redistribute them.

- **omp** (Oh My Pi) `v18.10.4`, `omp-linux-musl-arm64` from
  <https://github.com/can1357/oh-my-pi/releases>. MIT licence, Copyright (c) 2025 Mario Zechner,
  (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.
- **Alpine Linux** 3.24.2 aarch64 minirootfs from <https://dl-cdn.alpinelinux.org>, then the
  packages `libstdc++`, `bash`, `git`, `curl`, `ca-certificates`, `python3`, `openssh-client` and
  their dependencies from the Alpine v3.24 repository. Each package carries its own licence
  (for example musl: MIT; BusyBox and apk-tools: GPL-2.0), recorded in Alpine's package metadata
  (`apk info -a <package>` inside the guest): <https://alpinelinux.org>.

## Bundled in the web client

The web client is built into the daemon binary and the APK. Licence texts ship in
[`web/public/licenses/`](web/public/licenses/) (served as `licenses/` beside the client), with an
index in `licenses/NOTICE.txt`.

- **Geist** and **Geist Mono** variable fonts (via `@fontsource-variable/geist` and
  `@fontsource-variable/geist-mono` 5.3.0): Copyright (c) 2023 Vercel, in collaboration with
  basement.studio; SIL Open Font License 1.1 (`licenses/geist-OFL-1.1.txt`).
- **Lucide** icons (`lucide-react` 1.34.0): ISC, Copyright (c) Lucide Icons and Contributors;
  icons derived from Feather are MIT, Copyright (c) 2013-present Cole Bemis
  (`licenses/lucide-ISC.txt`).
- **Model maker logos** (`web/public/providers/*.svg`): from LobeHub's
  [lobe-icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg`; `zenmux.svg`
  rescaled), MIT, Copyright (c) 2023 LobeHub (`licenses/lobe-icons-MIT.txt`); `xiaomi.svg` from
  [Simple Icons](https://github.com/simple-icons/simple-icons), CC0-1.0; `generic.svg`, the
  fallback sparkle, is covered by the same MIT terms. The logos are trademarks of their owners and
  are shown only to identify which company makes a model.
- **AI Elements** (<https://github.com/vercel/ai-elements>): `web/src/components/ai-elements/`
  `conversation.tsx`, `message.tsx` and `prompt-input.tsx` are derived from it and modified for
  omp-pulse. Copyright 2023 Vercel, Inc., Apache License 2.0 (`licenses/Apache-2.0.txt`;
  attribution and licence also in that directory's `NOTICE` and `LICENSE`).
- **shadcn/ui**: the primitives in `web/src/components/ui/` were generated with the shadcn/ui CLI
  (MIT, Copyright (c) 2023 shadcn; `licenses/shadcn-ui-MIT.txt`).
- The app icon (`web/public/icon*.{svg,png}`) and the Android launcher icons and splash screens
  generated from it are omp-pulse's own artwork, MIT with the rest of the project.

## Dependency licence summary

The complete notices are generated on every web build by `scripts/release/third-party-licenses.mjs`
(run by a plugin in `web/vite.config.ts`) into the web client's `licenses/` directory, so they are
embedded in the daemon and bundled in the APK:

- `licenses/rust-crates.txt`: every crate, with version, licence expression and the full text of
  each `LICENSE*`/`COPYING*`/`NOTICE*` file in the published crate (identical texts written once).
- `licenses/npm-packages.txt`: every production npm package of the web client, likewise.

They are build output (ignored under `public/app/`), not committed. The build fails if a crate or
package declares no licence and ships no licence file. The tables below summarise them.

### Rust crates (daemon and phone-mode daemon)

`cargo metadata --format-version 1 --locked --filter-platform <triple>` for every target
`scripts/release/third-party-licenses.mjs` lists: the published daemons
(`scripts/release/targets.json`: musl Linux x86_64 and aarch64, macOS x86_64 and aarch64,
`x86_64-pc-windows-msvc`), the phone-mode daemon (`aarch64-unknown-linux-musl`) and the local
glibc and MinGW builds, keeping the normal dependencies reachable from `omp-pulse` (dev- and
build-dependencies excluded): 293 crate versions. The `license` field as declared by each crate:

| Licence expression | Crates | Notable |
|---|---:|---|
| MIT OR Apache-2.0 | 195 | serde, ureq, url, p256, aes-gcm, hkdf, `core-foundation`, `security-framework` (macOS) |
| MIT | 48 | tokio, axum, hyper, `objc2`, `fsevent-sys` (macOS) |
| Unicode-3.0 | 18 | ICU4X (`icu_*`, `zerovec`, `yoke`, `tinystr`, `litemap`, ...) via `idna` |
| MIT OR Unlicense | 6 | `memchr`, `aho-corasick`, `walkdir` |
| ISC | 4 | `rustls-webpki`, `untrusted`, `inotify` |
| other permissive choices | 15 | `rustls`, `rustls-native-certs` (Apache-2.0 OR ISC OR MIT), `ryu` (Apache-2.0 OR BSL-1.0), `zerocopy`, `bytemuck`, `miniz_oxide`, `adler2`, `serial2`, `moxcms`, `pxfm`, `dispatch2` and `objc2-*` (Zlib OR Apache-2.0 OR MIT; macOS), `unicode-ident` ((MIT OR Apache-2.0) AND Unicode-3.0) |
| Apache-2.0 AND ISC | 1 | `ring` |
| MIT AND BSD-3-Clause | 1 | `matchit` |
| BSD-3-Clause | 1 | `subtle` |
| Apache-2.0 | 1 | `sync_wrapper` |
| CC0-1.0 | 1 | `notify` |
| CDLA-Permissive-2.0 | 1 | `webpki-roots` (Mozilla's root certificate data; agreement text: <https://cdla.dev/permissive-2-0/>) |
| MPL-2.0 | 1 | `option-ext` (unmodified; source: <https://crates.io/crates/option-ext>) |

No GPL, LGPL or AGPL crate, and no crate without a declared licence. The Rust standard library
(MIT OR Apache-2.0) is linked into every build; the musl builds (including `libomppulse.so`)
statically link musl libc (MIT), the published Windows build statically links the Microsoft C
runtime, and local MinGW builds link the MinGW-w64 runtime.

### npm packages (web client)

The packages reachable from the `dependencies` of `web/package.json` (the same 200 that
`web/package-lock.json` marks as not development-only), by their declared `license`. Bundling
keeps only what the client imports, so the shipped set is smaller.

| Licence | Packages | Notable |
|---|---:|---|
| MIT | 182 | React, Base UI, Radix UI, shiki, unified/remark/micromark, Tailwind CSS, zustand, zod |
| Apache-2.0 | 11 | `ai`, `@ai-sdk/*`, `streamdown`, `@streamdown/code`, `class-variance-authority`, `jsqr` |
| ISC | 2 | `lucide-react`, `@ungap/structured-clone` |
| OFL-1.1 | 2 | `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` |
| BSD-2-Clause | 1 | `entities` |
| AFL-2.1 OR BSD-3-Clause | 1 | `json-schema` (used under BSD-3-Clause) |
| 0BSD | 1 | `tslib` |

shiki's bundled TextMate grammars and themes come from their upstream projects under their own
permissive licences, recorded in the shiki repository.

`mobile/package-lock.json`: only `@capacitor/android` (MIT) is compiled into the APK;
`@capacitor/core` (MIT), `tslib` (0BSD) and the Capacitor CLI are build-time tools.
