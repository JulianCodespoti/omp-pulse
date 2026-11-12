# Vendored proot (arm64-v8a)

These four libraries run the phone-mode Linux guest. They are unmodified binaries from Termux's
package builds, renamed `lib*.so` so Android extracts them into the app's `nativeLibraryDir`, the
only app-owned location Android allows a process to execute from (app data is mounted noexec for
targetSdk 29+). The APK packages them from `arm64-v8a/` via `jniLibs.srcDirs`.

| File | Termux package | Upstream version | sha256 | Licence |
|---|---|---|---|---|
| `libproot.so` | `proot` (the `proot` executable) | 5.1.107.96 | `0df9240e08015aa7f5194c32b3fe5d9c8a8ea16dfb895ccafb65847a7f392c7d` | GPL-2.0-or-later |
| `libproot-loader.so` | `proot` (`libexec/proot/loader`) | 5.1.107.96 | `cbdef0e652c2b78af25d867e1719fdebbb0915e25aae2dd35b3b5c1835f6b551` | GPL-2.0-or-later |
| `libtalloc.so` | `libtalloc` (SONAME `libtalloc.so.2`) | 2.5.0 | `742b438c4d09e276985a61d44164c9de207b6d8cc268f3018cb3001961bcb309` | LGPL-3.0-or-later |
| `libandroid-shmem.so` | `libandroid-shmem` | 0.7 | `84475798e07c8174dbbfaec70a827fdb02f19ffa69a589380c13e7507fd0e731` | BSD-3-Clause |

Evidence in the binaries (checked 2026-10-14):

- `libproot.so` carries the version string `5.1.107.96` (Termux passes `-DVERSION=` from
  `TERMUX_PKG_VERSION`), the Termux loader path `/data/data/com.termux/files/usr/libexec/proot/loader`,
  and needs `libtalloc.so`, `libandroid-shmem.so`, `libc.so`. Built by NDK r30 (`.note.android.ident`
  targets API 24).
- `libproot-loader.so` is a static ET_EXEC; `libtalloc.so` reports major 2, minor 5
  (`talloc_version_major/minor`); `libandroid-shmem.so` is NDK r29, API 24.
- Every `PT_LOAD` segment of all four files is aligned to 0x4000, so they load on 16 KB-page devices.

## Runtime requirements these binaries impose

The Termux build hard-codes Termux paths, so the launcher (`runtime/GuestLauncher.java`) must set:

- `PROOT_LOADER` → `<nativeLibraryDir>/libproot-loader.so` (otherwise proot looks under
  `/data/data/com.termux/…` and every exec fails),
- `LD_LIBRARY_PATH` → `<nativeLibraryDir>` (so `libtalloc.so` and `libandroid-shmem.so` resolve),
- `PROOT_TMP_DIR` → an app-private writable directory.

## Source (GPL-2.0 source offer)

Corresponding source, as used by the Termux recipes:

- proot: <https://github.com/termux/proot/archive/v5.1.107.96.zip>, sha256
  `75f654fe60dea92dabff2bf083ae8bfe4f91baa6a1a374786a6bf391015eebaa`
  (recipe: <https://github.com/termux/termux-packages/blob/de39661946f7e8175b5dd0755121fa28cb0aebd1/packages/proot/build.sh>, built with
  `make -C src PROOT_WITH_LIBANDROID_SHMEM=true`, `PROOT_UNBUNDLE_LOADER`, `-DARG_MAX=131072`)
- talloc: <https://www.samba.org/ftp/talloc/talloc-2.5.0.tar.gz>, sha256
  `912afa237510ae542a7733998eb18a12bcda35ab6729c8e2ddb43e8d0ebab007`
  (recipe: <https://github.com/termux/termux-packages/blob/bddd9721910e56bc36412a764b4b4f7bbdbb1eb1/packages/libtalloc/build.sh>)
- libandroid-shmem: <https://github.com/termux/libandroid-shmem/archive/refs/tags/v0.7.tar.gz>, sha256
  `1e5ff8459bc0a8c229dd8a94b27d119987e09ef3414331c2b5ebfff20b98e867`

The recipe links are pinned to the commits that built these versions; Termux master has since
moved on.

omp-pulse redistributes these binaries unmodified. GPL-2.0 section 3 asks that the source be
offered from the same place as the binary, so `scripts/release/release.sh` downloads the proot
archive above, checks that sha256, and attaches it to every release as
`proot-5.1.107.96-source.zip`. A proot bump must update that URL and checksum too. The APK also
carries the licence texts in `app/src/main/assets/licenses/`.

## Refreshing

1. Install the new Termux packages on an arm64 device (`pkg install proot`), or download the
   `proot`, `libtalloc` and `libandroid-shmem` `.deb` files for `aarch64` from the Termux package
   repository and unpack them (`ar x`, then `tar xf data.tar.xz`).
2. Copy, renaming:
   `usr/bin/proot` → `libproot.so`, `usr/libexec/proot/loader` → `libproot-loader.so`,
   `usr/lib/libtalloc.so.2` → `libtalloc.so`, `usr/lib/libandroid-shmem.so` → `libandroid-shmem.so`.
   (No `loader32`: phone mode runs 64-bit guests only.)
3. Check every `PT_LOAD` alignment is at least 0x4000: `readelf -lW <file> | grep LOAD`.
4. Update the table above (version, `sha256sum`), and `THIRD_PARTY_NOTICES.md` if a licence changed.
5. Install the APK on a 4 KB-page and a 16 KB-page device and run first-run setup end to end.

Adding an ABI: put the same four files, built for that ABI, in a sibling directory named after
the Android ABI (`x86_64/`, …); see `docs/contributing/android.md` ("Adding an ABI").
