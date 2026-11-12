package com.omppulse.app.runtime;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** Builds and runs commands inside the Alpine guest under proot. */
final class GuestLauncher implements GuestExec {
    private static final String GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

    private final RuntimePaths paths;

    GuestLauncher(RuntimePaths paths) {
        this.paths = paths;
    }

    /**
     * proot command for {@code argv}, stdout and stderr merged.
     *
     * Binds: host /dev,/proc,/sys; the APK's nativeLibraryDir at /opt/pulse (omp-pulse binary);
     * this user's shared storage at /sdcard. The guest environment is reset (env -i) so nothing
     * from the Android app process leaks into omp.
     */
    ProcessBuilder command(String... argv) {
        String lib = paths.nativeLibDir.getAbsolutePath();
        File tmp = paths.prootTmp();
        tmp.mkdirs();
        List<String> cmd = new ArrayList<>(Arrays.asList(
                paths.proot().getAbsolutePath(),
                "--kill-on-exit",
                // Android's SELinux denies hard links in app data; proot emulates them.
                "--link2symlink",
                "-0",
                "-r", paths.rootfs().getAbsolutePath(),
                "-b", "/dev",
                "-b", "/proc",
                "-b", "/sys",
                "-b", lib + ":" + RuntimePaths.GUEST_OPT_PULSE,
                "-b", paths.externalStorage.getAbsolutePath() + ":" + RuntimePaths.GUEST_SDCARD,
                "-w", "/root",
                "/usr/bin/env", "-i",
                "HOME=/root",
                "USER=root",
                "SHELL=/bin/bash",
                "PATH=" + GUEST_PATH,
                "LANG=C.UTF-8",
                "TERM=xterm-256color",
                "TMPDIR=/tmp"));
        cmd.addAll(Arrays.asList(argv));
        ProcessBuilder pb = new ProcessBuilder(cmd);
        Map<String, String> env = pb.environment();
        // proot's own shared libraries (libtalloc, …) live next to it in nativeLibraryDir.
        env.put("LD_LIBRARY_PATH", lib);
        env.put("PROOT_LOADER", paths.prootLoader().getAbsolutePath());
        env.put("PROOT_TMP_DIR", tmp.getAbsolutePath());
        pb.redirectErrorStream(true);
        return pb;
    }

    /** Runs {@code argv} to completion; returns its output, or throws with the output's tail. */
    String run(String... argv) throws IOException, InterruptedException {
        Result r = exec(argv);
        if (!r.ok()) {
            throw new IOException(RuntimeIo.join(" ", argv) + " failed (" + r.code + "): " + RuntimeIo.tail(r.output));
        }
        return r.output;
    }

    /**
     * Runs {@code argv} to completion and returns its exit code and output.
     *
     * Interruptible: output is drained on a helper thread so the caller blocks in waitFor(), and an
     * interrupt (service stopped) destroys proot, which --kill-on-exit propagates to the guest.
     */
    @Override
    public Result exec(String... argv) throws IOException, InterruptedException {
        Process p = command(argv).start();
        final String[] out = new String[1];
        final IOException[] readError = new IOException[1];
        Thread reader = new Thread(() -> {
            try {
                out[0] = RuntimeIo.drain(p.getInputStream());
            } catch (IOException e) {
                readError[0] = e;
            }
        }, "omp-guest-output");
        reader.setDaemon(true);
        reader.start();
        try {
            int code = p.waitFor();
            reader.join();
            if (readError[0] != null) throw readError[0];
            return new Result(code, out[0]);
        } finally {
            p.destroy();
        }
    }
}
