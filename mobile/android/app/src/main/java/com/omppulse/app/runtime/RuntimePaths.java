package com.omppulse.app.runtime;

import java.io.File;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;

/**
 * Host locations of the runtime and the guest↔host path mapping.
 *
 * Pure Java (no android.* types) so the mapping is unit-testable; {@link LocalRuntime} supplies
 * the Android directories.
 */
final class RuntimePaths {
    /** Guest mount point of the APK's nativeLibraryDir (omp-pulse is libomppulse.so there). */
    static final String GUEST_OPT_PULSE = "/opt/pulse";
    /** Guest mount point of the user's shared storage. */
    static final String GUEST_SDCARD = "/sdcard";
    static final String GUEST_OMP_PULSE_LINK = GUEST_OPT_PULSE + "/libomppulse.so";
    static final String GUEST_ENDPOINT_JSON = "/root/.config/omp-phone/endpoint.json";
    /** Device facts for the harness (the guest has no getprop). */
    static final String GUEST_DEVICE_JSON = "/root/.config/omp-phone/device.json";
    /** Outcome of the last harness seed/upgrade; read by `android doctor`. */
    static final String GUEST_HARNESS_STATUS = "/root/.config/omp-phone/harness-seed.json";
    /** Written by `omp-pulse setup`; the daemon's owner credential. */
    static final String GUEST_OWNER_TOKEN = "/root/.local/state/omp-pulse/token";

    /** Linux's MAXSYMLINKS: the guest kernel would give up at the same depth (ELOOP). */
    private static final int MAX_SYMLINK_HOPS = 40;

    final File base;
    final File nativeLibDir;
    /**
     * Shared storage of the CURRENT Android user (e.g. /storage/emulated/10 in a work profile).
     * INVARIANT: never hard-code /storage/emulated/0; it is only correct for the primary user.
     */
    final File externalStorage;

    private final Posix posix;

    RuntimePaths(File base, File nativeLibDir, File externalStorage, Posix posix) {
        this.base = base;
        this.posix = posix;
        this.nativeLibDir = nativeLibDir;
        this.externalStorage = externalStorage;
    }

    File rootfs() {
        return new File(base, "rootfs");
    }

    /** Extraction target; renamed onto {@link #rootfs()} only once complete. */
    File rootfsStaging() {
        return new File(base, "rootfs.staging");
    }

    File downloads() {
        return new File(base, "downloads");
    }

    /** PROOT_TMP_DIR: proot needs a host-writable scratch directory. */
    File prootTmp() {
        return new File(base, "tmp");
    }

    File daemonLog() {
        return new File(base, "daemon.log");
    }

    File installState() {
        return new File(base, "install-state.properties");
    }

    /** Marker written by the pre-step-file runtime ("1" once installed); migrated, then deleted. */
    File legacyInstalledMarker() {
        return new File(base, "installed");
    }

    File proot() {
        return new File(nativeLibDir, "libproot.so");
    }

    File prootLoader() {
        return new File(nativeLibDir, "libproot-loader.so");
    }

    File ompPulseLib() {
        return new File(nativeLibDir, "libomppulse.so");
    }

    /** A path inside the guest filesystem, without the storage mapping of {@link #hostPath}. */
    File inRootfs(String guestPath) {
        return new File(rootfs(), guestPath);
    }

    /**
     * Maps a guest path to the host file it denotes: {@code /sdcard/**} and paths already under
     * this user's shared storage go to real storage (that is what proot binds); everything else
     * lives inside the rootfs.
     *
     * WHY guest symlink resolution and containment: callers (the phone API) receive paths from an
     * agent that may be prompt-injected. A lexical mapping lets {@code ..} or a symlink climb out of
     * the rootfs into app-private files (token prefs, cacheDir). Symlinks inside the rootfs are
     * resolved the way the guest sees them (absolute targets are guest-absolute, e.g. AGENTS.md →
     * the harness), and the result must canonically stay under the rootfs or shared storage.
     *
     * @throws IllegalArgumentException for relative paths, {@code ..} segments, symlink loops and
     *     anything that resolves outside both roots
     */
    File hostPath(String guestPath) {
        if (!guestPath.startsWith("/")) throw new IllegalArgumentException("not an absolute path: " + guestPath);
        for (String seg : guestPath.split("/")) {
            if (seg.equals("..")) throw new IllegalArgumentException("'..' is not allowed: " + guestPath);
        }
        String resolved = resolveGuest(guestPath);
        File host = mapResolved(resolved);
        File root = storageRelative(resolved) != null ? externalStorage : rootfs();
        try {
            String canonRoot = root.getCanonicalPath();
            String canon = host.getCanonicalPath();
            if (!canon.equals(canonRoot) && !canon.startsWith(canonRoot + "/")) {
                throw new IllegalArgumentException("path escapes " + (root == externalStorage ? "shared storage" : "the guest") + ": " + guestPath);
            }
        } catch (IOException e) {
            throw new IllegalArgumentException("cannot resolve " + guestPath + ": " + e.getMessage(), e);
        }
        return host;
    }

    /**
     * Resolves symlinks inside the rootfs with guest semantics, stopping at the storage mapping
     * (storage symlinks are host links; {@link #hostPath}'s canonical check covers them).
     */
    private String resolveGuest(String guestPath) {
        ArrayDeque<String> pending = new ArrayDeque<>(Arrays.asList(guestPath.split("/")));
        ArrayList<String> out = new ArrayList<>();
        int hops = 0;
        while (!pending.isEmpty()) {
            String seg = pending.pollFirst();
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) {
                // Only reachable from a link target; the guest root's parent is the root.
                if (!out.isEmpty()) out.remove(out.size() - 1);
                continue;
            }
            out.add(seg);
            String current = "/" + RuntimeIo.join("/", out.toArray(new String[0]));
            if (storageRelative(current) != null) {
                StringBuilder rest = new StringBuilder(current);
                for (String r : pending) if (!r.isEmpty()) rest.append('/').append(r);
                return rest.toString();
            }
            String target = posix.readlink(inRootfs(current));
            if (target == null) continue;
            if (++hops > MAX_SYMLINK_HOPS) throw new IllegalArgumentException("too many symlinks: " + guestPath);
            out.remove(out.size() - 1);
            if (target.startsWith("/")) out.clear();
            String[] parts = target.split("/");
            for (int i = parts.length - 1; i >= 0; i--) pending.addFirst(parts[i]);
        }
        return "/" + RuntimeIo.join("/", out.toArray(new String[0]));
    }

    /** The part of {@code guestPath} below shared storage ("" for its root), or null if outside. */
    private String storageRelative(String guestPath) {
        String ext = externalStorage.getAbsolutePath();
        if (guestPath.equals(GUEST_SDCARD) || guestPath.startsWith(GUEST_SDCARD + "/")) {
            return guestPath.substring(GUEST_SDCARD.length());
        }
        if (guestPath.equals(ext) || guestPath.startsWith(ext + "/")) return guestPath.substring(ext.length());
        return null;
    }

    private File mapResolved(String guestPath) {
        String rel = storageRelative(guestPath);
        return rel != null ? new File(externalStorage.getAbsolutePath() + rel) : inRootfs(guestPath);
    }
}
