package com.omppulse.app.runtime;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The concrete install steps for one {@link RuntimeSpec}, in dependency order:
 * rootfs → packages → omp → omp-pulse link → omp-pulse setup.
 *
 * Step keys decide what a spec change re-runs:
 * - rootfs: constant. An installed rootfs holds the user's home and projects, so it is never
 *   replaced; a newer Alpine pin only affects fresh installs (packages upgrade through apk).
 * - packages: repository + package list.
 * - omp: version + sha256. A new pin replaces the binary on the next prepare(); with an unchanged
 *   pin a binary the user upgraded in place (`omp update`) is left alone.
 */
final class InstallPlan {
    /** Unpacked size of the Alpine packages (python3, git, …) with margin. */
    private static final long PACKAGES_HEADROOM = 200L << 20;
    /** Unpacked rootfs relative to its .tar.gz, with margin. */
    private static final int ROOTFS_EXPANSION = 4;
    /** Alpine's single static binary; proves a complete extraction (bin/sh is an absolute symlink). */
    private static final String ROOTFS_PROOF = "/bin/busybox";
    private static final String OMP_GUEST = "/usr/local/bin/omp";
    private static final String OMP_PULSE_GUEST = "/usr/local/bin/omp-pulse";
    private static final String APK_DB = "/lib/apk/db/installed";

    private final RuntimePaths paths;
    private final RuntimeSpec spec;
    private final RuntimeSpec.Target target;
    private final GuestLauncher guest;
    private final GuestFiles guestFiles;
    private final RuntimeStatus status;
    private final Posix posix;
    /** Port handed to `omp-pulse setup`; set by {@link #install(int)}, the only path that runs steps. */
    private int daemonPort;
    private final Fetcher fetcher;
    private final Installer installer;

    private final Installer.Step rootfsStep = new RootfsStep();
    private final Installer.Step packagesStep = new PackagesStep();
    private final Installer.Step ompStep = new OmpStep();

    InstallPlan(RuntimePaths paths, RuntimeSpec spec, GuestLauncher guest, GuestFiles guestFiles,
                RuntimeStatus status, Posix posix) {
        if (!spec.supported()) throw new IllegalArgumentException("no runtime pins for this device");
        this.paths = paths;
        this.spec = spec;
        this.target = spec.target;
        this.guest = guest;
        this.guestFiles = guestFiles;
        this.status = status;
        this.posix = posix;
        this.fetcher = new Fetcher(paths.downloads());
        this.installer = new Installer(paths.installState());
    }

    List<Installer.Step> steps() {
        return Arrays.asList(rootfsStep, packagesStep, ompStep, new LinkStep(), new SetupStep());
    }

    boolean installed() {
        return installer.allDone(steps());
    }

    /** Bytes still to download for a complete install. */
    long remainingDownloadBytes() {
        long n = 0;
        if (!rootfsStep.present()) n += fetcher.remaining(target.rootfs);
        if (!installer.done(ompStep)) n += fetcher.remaining(target.omp);
        return n;
    }

    /**
     * Adopts a runtime installed before step tracking existed (marker file "installed"): every
     * step whose result is present is recorded as done, so the upgrade neither needs the network
     * nor swaps a working, possibly newer omp for the pin.
     */
    void migrateLegacy() throws IOException {
        File marker = paths.legacyInstalledMarker();
        if (!marker.isFile()) return;
        installer.adoptPresent(steps());
        marker.delete();
    }

    /** Runs every unfinished step; status carries the step messages and progress. */
    void install(int daemonPort) throws Exception {
        this.daemonPort = daemonPort;
        migrateLegacy();
        fetcher.pruneExcept(target.rootfs, target.omp);
        requireFreeSpace();
        installer.run(steps());
    }

    private void requireFreeSpace() throws IOException {
        long need = remainingDownloadBytes();
        if (!rootfsStep.present()) need += target.rootfs.bytes * ROOTFS_EXPANSION;
        if (!installer.done(packagesStep)) need += PACKAGES_HEADROOM;
        File dir = paths.base;
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        long free = dir.getUsableSpace();
        if (free < need) {
            throw new IOException("Not enough free space: running omp on this phone needs about "
                    + RuntimeIo.megabytes(need) + ", but only " + RuntimeIo.megabytes(free)
                    + " are free. Free up some space and try again.");
        }
    }

    private Progress percent() {
        return (done, total) -> status.progress(total > 0 ? (int) (done * 100 / total) : -1);
    }

    private final class RootfsStep extends Installer.Step {
        @Override String name() { return "rootfs"; }

        @Override String key() { return "1"; }

        // Once recorded, the directory alone is the proof: rootfs/ only ever appears complete
        // (atomic rename below), and a missing or host-unresolvable /bin/busybox in a live rootfs
        // must not make the step re-run. The busybox check remains only to adopt an unrecorded
        // rootfs, which the pre-staging runtime extracted in place.
        @Override boolean present() {
            File rootfs = paths.rootfs();
            if (!rootfs.isDirectory()) return false;
            File proof = paths.inRootfs(ROOTFS_PROOF);
            return installer.recorded(this) || proof.exists() || posix.isSymlink(proof);
        }

        @Override void run() throws Exception {
            if (present()) return; // adopted: see key()
            RuntimeSpec.Artifact a = target.rootfs;
            status.step("Downloading Linux environment (" + RuntimeIo.megabytes(a.bytes) + ")", 0);
            File tarball = fetcher.fetch(a, percent());
            status.step("Unpacking Linux environment", 0);
            File staging = paths.rootfsStaging();
            RuntimeIo.deleteTree(staging, posix);
            new TarExtractor(posix).extractTarGz(tarball, staging, percent());
            if (!new File(staging, ROOTFS_PROOF.substring(1)).isFile()) {
                throw new IOException("the Linux environment archive has no " + ROOTFS_PROOF);
            }
            new File(staging, "root/projects").mkdirs();
            // INVARIANT: rootfs/ appears only complete; a crash before this rename leaves only
            // the staging directory, which the next run discards.
            File rootfs = paths.rootfs();
            // Never delete an existing rootfs (a non-directory there is not ours to remove either).
            if (rootfs.exists() || posix.isSymlink(rootfs)) throw new IOException(rootfs + " already exists; not replacing it");
            if (!staging.renameTo(rootfs)) throw new IOException("cannot move " + staging + " to " + rootfs);
            tarball.delete();
        }
    }

    private final class PackagesStep extends Installer.Step {
        @Override String name() { return "packages"; }

        @Override String key() {
            return target.alpineRepo + "|" + RuntimeIo.join(",", spec.packages.toArray(new String[0]));
        }

        @Override boolean present() {
            String db = RuntimeIo.readTextOrNull(paths.inRootfs(APK_DB));
            return db != null && installedNames(db).containsAll(spec.packages);
        }

        @Override void run() throws Exception {
            status.step("Installing packages", -1);
            guestFiles.writeNetworkConfig();
            // The pinned repository is authoritative, whatever the rootfs shipped with.
            RuntimeIo.writeTextAtomic(paths.inRootfs("/etc/apk/repositories"),
                    target.alpineRepo + "/main\n" + target.alpineRepo + "/community\n");
            List<String> argv = new ArrayList<>(Arrays.asList("apk", "add", "--no-progress", "--upgrade"));
            argv.addAll(spec.packages);
            guest.run(argv.toArray(new String[0]));
        }
    }

    private final class OmpStep extends Installer.Step {
        @Override String name() { return "omp"; }

        @Override String key() { return target.omp.version + "@" + target.omp.sha256; }

        @Override boolean present() {
            return paths.inRootfs(OMP_GUEST).isFile();
        }

        @Override void run() throws Exception {
            RuntimeSpec.Artifact a = target.omp;
            status.step("Downloading omp " + a.version + " (" + RuntimeIo.megabytes(a.bytes) + ")", 0);
            File binary = fetcher.fetch(a, percent());
            posix.chmod(binary, 0755);
            File dest = paths.inRootfs(OMP_GUEST);
            File dir = dest.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
            // rename(2) replaces atomically; a running omp keeps its old inode.
            if (!binary.renameTo(dest)) throw new IOException("cannot install omp to " + dest);
            status.step("Checking omp", -1);
            guest.run("omp", "--version");
        }
    }

    private final class LinkStep extends Installer.Step {
        @Override String name() { return "omp-pulse-link"; }

        @Override String key() { return RuntimePaths.GUEST_OMP_PULSE_LINK; }

        @Override boolean present() {
            return RuntimePaths.GUEST_OMP_PULSE_LINK.equals(posix.readlink(paths.inRootfs(OMP_PULSE_GUEST)));
        }

        @Override void run() throws Exception {
            // omp-pulse runs straight from the APK (bound at /opt/pulse), so app updates upgrade it.
            File link = paths.inRootfs(OMP_PULSE_GUEST);
            RuntimeIo.deleteTree(link, posix);
            posix.symlink(RuntimePaths.GUEST_OMP_PULSE_LINK, link);
        }
    }

    private final class SetupStep extends Installer.Step {
        @Override String name() { return "setup"; }

        // setup writes its config once and never clobbers it; serve receives --port every start.
        @Override String key() { return "1"; }

        @Override boolean present() {
            return paths.inRootfs(RuntimePaths.GUEST_OWNER_TOKEN).isFile();
        }

        @Override void run() throws Exception {
            status.step("Configuring omp-pulse", -1);
            guest.run("omp-pulse", "setup", "--bind", "127.0.0.1", "--port", String.valueOf(daemonPort));
        }
    }

    /**
     * Every name apk would resolve to an installed package: real names (`P:`) and provided names
     * (`p:name=version ...`). WHY provides count: Alpine 3.24 turned `openssh-client` into a name
     * only `openssh-client-default` provides, so a check of `P:` lines alone never passed, the
     * runtime read as "omp is not installed" forever and every start re-ran `apk add`.
     */
    static Set<String> installedNames(String db) {
        Set<String> names = new HashSet<>();
        for (String line : db.split("\n")) {
            if (line.startsWith("P:")) {
                names.add(line.substring(2));
            } else if (line.startsWith("p:")) {
                for (String token : line.substring(2).split(" ")) {
                    int eq = token.indexOf('=');
                    names.add(eq < 0 ? token : token.substring(0, eq));
                }
            }
        }
        return names;
    }
}
