package com.omppulse.app.runtime;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Environment;
import android.util.Log;
import com.omppulse.app.BuildConfig;
import com.omppulse.app.TokenStore;
import com.omppulse.app.phone.PhoneApi;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Entry point of the on-device runtime: Alpine Linux under proot running omp and omp-pulse.
 *
 * This class wires the single-purpose parts together and is the only API other packages use:
 * {@link RuntimeSpec} (pins), {@link RuntimePaths} (layout), {@link GuestLauncher} (proot),
 * {@link InstallPlan}/{@link Installer} (steps), {@link Fetcher}/{@link TarExtractor},
 * {@link Endpoints} (ports), {@link DaemonClient} (HTTP) and {@link LocalPulseService}
 * (supervision).
 */
public final class LocalRuntime {
    /** Where the app's UI comes from. JSON: "unset" | "phone" | "laptop". */
    public enum Mode {
        UNSET, PHONE, LAPTOP;

        public String json() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }

        /** Parses a JSON mode name; null for anything else. */
        public static Mode fromJson(String s) {
            for (Mode m : values()) {
                if (m.json().equals(s)) return m;
            }
            return null;
        }
    }

    private static final String TAG = "OmpLocalRuntime";
    /** Same file and key as the original phone-mode build, so an upgrade keeps the user's choice. */
    private static final String MODE_PREFS = "omp_pulse_run_mode";
    private static final String KEY_MODE = "mode";
    /** SIGQUIT asks proot to kill its whole guest; see {@link #signalGuest}. */
    private static final int SIGQUIT = 3;
    private static final String RUNTIME_PREFS = "omp_pulse_runtime";
    /** "Phone tools for the agent" (see {@link HarnessInstall}); absent until first read. */
    private static final String KEY_PHONE_TOOLS = "phone_tools";
    private static final String SPEC_ASSET = "runtime/runtime.json";
    private static final long LOG_ROTATE_BYTES = 4L << 20;
    private static final int MIN_SDK = 24;
    private static final String PAIRING = "Pairing with omp-pulse";

    private static LocalRuntime instance;

    private final Context app;
    private final RuntimePaths paths;
    private final RuntimeSpec spec;
    private final RuntimeStatus status = new RuntimeStatus();
    private final GuestLauncher guest;
    private final GuestFiles guestFiles;
    private volatile Endpoints endpoints;
    /** Serializes applying "Phone tools for the agent" from the Settings switch. */
    private final Object phoneToolsLock = new Object();

    // getExternalStorageDirectory is deprecated for scoped storage, but proot needs the real
    // per-user path to bind; there is no non-deprecated equivalent for a raw path.
    @SuppressWarnings("deprecation")
    private LocalRuntime(Context app) {
        this.app = app;
        this.paths = new RuntimePaths(new File(app.getFilesDir(), "phone"),
                new File(app.getApplicationInfo().nativeLibraryDir),
                // Per-user storage root: correct in secondary users and work profiles.
                Environment.getExternalStorageDirectory(), AndroidPosix.INSTANCE);
        this.spec = loadSpec(app);
        this.guest = new GuestLauncher(paths);
        this.guestFiles = new GuestFiles(app, paths, guest, AndroidPosix.INSTANCE);
        if (spec.supported()) {
            try {
                plan().migrateLegacy();
            } catch (IOException e) {
                Log.w(TAG, "legacy install migration failed", e);
            }
        }
    }

    /** App-context singleton. */
    public static synchronized LocalRuntime get(Context ctx) {
        if (instance == null) instance = new LocalRuntime(ctx.getApplicationContext());
        return instance;
    }

    public Mode mode() {
        Mode m = Mode.fromJson(modePrefs().getString(KEY_MODE, null));
        if (m != null) return m;
        String baked = BuildConfig.OMP_PULSE_SERVER_URL;
        return baked != null && !baked.isEmpty() ? Mode.LAPTOP : Mode.UNSET;
    }

    /**
     * Persists the choice, including an explicit {@link Mode#UNSET} ("stopped": the chooser). The
     * baked-server default in {@link #mode()} applies only while nothing was ever stored, so an
     * explicit UNSET must be written, not removed, or a baked build would fall back to LAPTOP.
     */
    public void setMode(Mode m) {
        // commit, not apply: callers restart the activity right after, which must see the value.
        modePrefs().edit().putString(KEY_MODE, m.json()).commit();
    }

    public boolean isSupported() {
        return Build.VERSION.SDK_INT >= MIN_SDK
                && spec.supported()
                && paths.proot().isFile()
                && paths.prootLoader().isFile()
                && paths.ompPulseLib().isFile();
    }

    public boolean isInstalled() {
        return isSupported() && plan().installed();
    }

    public RuntimeStatus.Snapshot status() {
        return status.snapshot();
    }

    /**
     * "Phone tools for the agent": whether the agent gets the phone harness (the `android` command,
     * the `phone` MCP server, phone-mode instructions and skills) and the phone API. Never chosen:
     * decided once by {@link HarnessInstall#enabled} (on only when an earlier build already seeded
     * the harness) and stored, so the answer cannot change under the user later.
     */
    public boolean phoneTools() {
        SharedPreferences prefs = runtimePrefs();
        if (prefs.contains(KEY_PHONE_TOOLS)) return prefs.getBoolean(KEY_PHONE_TOOLS, false);
        boolean on = guestFiles.phoneToolsEnabled(null);
        prefs.edit().putBoolean(KEY_PHONE_TOOLS, on).apply();
        return on;
    }

    /**
     * Saves "Phone tools for the agent" and applies it to an installed guest at once, off the
     * caller's thread; new chats see the change. Not installed yet: the first daemon start applies it.
     */
    public void setPhoneTools(boolean on) {
        runtimePrefs().edit().putBoolean(KEY_PHONE_TOOLS, on).commit();
        if (!isInstalled()) return;
        Thread t = new Thread(this::applyPhoneTools, "omp-local-phone-tools");
        t.setDaemon(true);
        t.start();
    }

    /**
     * Applies the stored setting (read under the lock, so the last of several quick toggles wins):
     * the guest's harness links and MCP entry, and the phone API, which runs only while the daemon is
     * up ({@link LocalPulseService} starts it there).
     */
    private void applyPhoneTools() {
        synchronized (phoneToolsLock) {
            boolean on = phoneTools();
            try {
                guestFiles.applyHarness(on);
            } catch (IOException e) {
                Log.w(TAG, "cannot apply phone tools setting", e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            if (!on) PhoneApi.stop();
            else if (RuntimeStatus.READY.equals(status.snapshot().phase())) PhoneApi.start(app);
        }
    }

    /**
     * Installs/upgrades as needed, then runs the daemon, all in {@link LocalPulseService}: the
     * foreground service keeps the process alive through a 230 MB download. Returns at once;
     * outcome lands in {@link #status()}.
     */
    public void prepare() {
        if (!isSupported()) {
            status.fail(unsupportedReason());
            return;
        }
        // Synchronously leave a stale error/idle so pollers never re-read the previous outcome.
        if (!RuntimeStatus.READY.equals(status.snapshot().phase())) {
            status.enter(RuntimeStatus.STARTING, "Starting");
        } else if (!hasPhoneToken()) {
            // The web side dropped the phone token (401 after re-setup, "forget pairing") while the
            // daemon keeps running. The service pairs only once per daemon start, so re-pair here;
            // otherwise the app shows a pair screen that needs a laptop. Leaving READY first keeps
            // pollers from loading the app before the new token exists.
            status.enter(RuntimeStatus.STARTING, PAIRING);
            Thread t = new Thread(this::repair, "omp-local-repair");
            t.setDaemon(true);
            t.start();
        }
        try {
            LocalPulseService.start(app);
        } catch (RuntimeException e) {
            // e.g. ForegroundServiceStartNotAllowedException when called from the background.
            Log.e(TAG, "cannot start the runtime service", e);
            status.fail("Could not start the background service: " + e.getClass().getSimpleName());
        }
    }

    public Endpoints endpoints() {
        Endpoints e = endpoints;
        if (e != null) return e;
        synchronized (this) {
            if (endpoints == null) endpoints = Endpoints.load(runtimePrefs());
            return endpoints;
        }
    }

    public String appUrl() {
        return "http://127.0.0.1:" + endpoints().daemonPort() + "/app/";
    }

    public RuntimeSpec spec() {
        return isSupported() ? spec.withDownloadBytes(plan().remainingDownloadBytes()) : spec;
    }

    public ProcessBuilder guest(String... argv) {
        return guest.command(argv);
    }

    public File hostPath(String guestPath) {
        return paths.hostPath(guestPath);
    }

    public File rootfs() {
        return paths.rootfs();
    }

    /** Blocks until the daemon answers /api/version; false on timeout or a terminal error. */
    public boolean awaitReady(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (true) {
            String phase = status.snapshot().phase();
            if (RuntimeStatus.ERROR.equals(phase)) return false;
            if (RuntimeStatus.READY.equals(phase) && daemonClient().probe(null) != DaemonClient.UNREACHABLE) return true;
            if (System.currentTimeMillis() >= deadline) return false;
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
    }

    // ---- service-facing (package-private) ----

    RuntimeStatus statusHolder() {
        return status;
    }

    DaemonClient daemonClient() {
        return new DaemonClient(endpoints().daemonPort());
    }

    /** Runs every unfinished install step for the current spec. */
    void installIfNeeded() throws Exception {
        if (!isSupported()) throw new IOException(unsupportedReason());
        InstallPlan plan = plan();
        if (plan.installed()) return;
        status.enter(RuntimeStatus.INSTALLING, "Preparing");
        plan.install(endpoints().daemonPort());
    }

    /**
     * Makes sure the daemon port is free for the daemon this service is about to start, moving to
     * a free port when anything listens there.
     *
     * WHY never adopt a listener: the caller then sends the phone token and the owner credential
     * to whatever answers. A listener cannot be proven ours without sending a credential, so the
     * service kills its own orphaned daemons first ({@link #killOrphanedDaemons}) and treats any
     * remaining listener as foreign. Probing carries no token.
     */
    synchronized void claimDaemonPort() {
        int port = endpoints().daemonPort();
        if (daemonClient().probe(null) != DaemonClient.UNREACHABLE || !Endpoints.isFree(port)) {
            Log.w(TAG, "port " + port + " is held by another process; moving");
            endpoints = endpoints().withNewDaemonPort(runtimePrefs());
        }
    }

    /**
     * Kills omp-pulse daemons (proot and guest) left by an earlier service instance or app process
     * of this app. Call only while no daemon of the current supervisor runs. Returns after their
     * port is released or a short grace period. Serve-only: a provider sign-in or install command
     * running in its own proot is left alone.
     */
    void killOrphanedDaemons() throws InterruptedException {
        if (!signalGuest(new File("/proc"), true, false)) return;
        long deadline = System.currentTimeMillis() + 3_000;
        while (!Endpoints.isFree(endpoints().daemonPort()) && System.currentTimeMillis() < deadline) Thread.sleep(100);
    }

    /** Stops this app's omp-pulse daemons and everything they started; does not wait. */
    void stopDaemonProcesses() {
        signalGuest(new File("/proc"), true, false);
    }

    /**
     * Explicit stop of the whole runtime ("unset"): the daemons plus every other guest command of
     * this runtime (provider sign-in, install or harness commands); does not wait.
     */
    void stopGuestProcesses() {
        signalGuest(new File("/proc"), true, true);
    }

    /**
     * Stops only the guest commands that are not the daemon (a provider sign-in), so an explicit
     * stop does not make the supervisor see its daemon die first; does not wait.
     */
    public void stopGuestCommands() {
        signalGuest(new File("/proc"), false, true);
    }

    /**
     * Sends the stop signals under {@code procRoot}; true when any process was signalled. Only
     * this app's uid is visible in /proc and killable, so nothing foreign is touched.
     * {@code daemons} selects the omp-pulse daemon (its proot and guest process), {@code commands}
     * every other proot started from this runtime's exact native proot path.
     *
     * WHY SIGQUIT for proot (proot 5.1.107.96 src/tracee/event.c event_loop): proot ignores
     * SIGTERM; SIGQUIT invokes kill_all_tracees2 to kill the guest processes. It sets no
     * PTRACE_O_EXITKILL, so SIGKILL on proot detaches the guest, leaving omp-pulse and the agents
     * it spawned running. Process.destroy() alone therefore cannot request reliable cleanup.
     * The guest daemon is signalled afterwards as a backstop for a proot that is already gone.
     */
    boolean signalGuest(File procRoot, boolean daemons, boolean commands) {
        String proot = paths.proot().getAbsolutePath();
        int self = android.os.Process.myPid();
        List<Integer> prootPids = new ArrayList<>();
        List<Integer> guestPids = new ArrayList<>();
        File[] procs = procRoot.listFiles();
        if (procs == null) return false;
        for (File dir : procs) {
            int pid;
            try {
                pid = Integer.parseInt(dir.getName());
            } catch (NumberFormatException e) {
                continue;
            }
            if (pid == self) continue;
            String cmd = RuntimeIo.readTextOrNull(new File(dir, "cmdline"));
            if (cmd == null) continue;
            List<String> argv = Arrays.asList(cmd.split("\0"));
            boolean isProot = proot.equals(argv.get(0));
            boolean daemon = argv.contains("serve")
                    && (argv.contains(proot) || argv.contains("omp-pulse") || argv.contains(RuntimePaths.GUEST_OMP_PULSE_LINK));
            if (daemon ? !daemons : !(commands && isProot)) continue;
            Log.w(TAG, "stopping guest process " + pid);
            (isProot ? prootPids : guestPids).add(pid);
        }
        for (int pid : prootPids) android.os.Process.sendSignal(pid, SIGQUIT);
        for (int pid : guestPids) android.os.Process.killProcess(pid);
        return !prootPids.isEmpty() || !guestPids.isEmpty();
    }

    /** Re-pairs with the running daemon after the phone token was dropped; see {@link #prepare()}. */
    private void repair() {
        try {
            daemonClient().ensurePaired(app, ownerToken());
            // The service may have left READY meanwhile (daemon exit, stop); keep its phase then.
            RuntimeStatus.Snapshot now = status.snapshot();
            if (RuntimeStatus.STARTING.equals(now.phase()) && PAIRING.equals(now.message())) {
                status.enter(RuntimeStatus.READY, "Running on this phone");
            }
        } catch (IOException e) {
            Log.e(TAG, "re-pairing failed", e);
            status.fail(e.getMessage());
        }
    }

    private boolean hasPhoneToken() {
        String t = TokenStore.getTokenFor(app, DaemonClient.TOKEN_SLOT);
        return t != null && !t.isEmpty();
    }

    /**
     * Moves the phone API to a fresh port after its bind failed (another process won the race
     * since {@link #claimPhoneApiPort}) and republishes endpoint.json. Returns the new port.
     */
    public synchronized int movePhoneApiPort() throws IOException {
        endpoints = endpoints().withNewPhoneApiPort(runtimePrefs());
        guestFiles.writeEndpoint(endpoints());
        return endpoints().phoneApiPort();
    }

    /** Moves the phone API to a free port when something else holds it. Call before PhoneApi.start. */
    synchronized void claimPhoneApiPort() {
        if (!Endpoints.isFree(endpoints().phoneApiPort())) {
            endpoints = endpoints().withNewPhoneApiPort(runtimePrefs());
        }
    }

    /** Refreshes guest files that depend on the current network, ports, device and APK. */
    void refreshGuestFiles() throws IOException, InterruptedException {
        guestFiles.writeNetworkConfig();
        guestFiles.writeEndpoint(endpoints());
        guestFiles.writeDeviceInfo();
        guestFiles.applyHarness(phoneTools());
    }

    /** Starts `omp-pulse serve`, appending its output to daemon.log (reset past 4 MiB). */
    Process startDaemon() throws IOException {
        File log = paths.daemonLog();
        if (log.length() > LOG_ROTATE_BYTES) log.delete();
        Process p = guest.command("omp-pulse", "serve", "--bind", "127.0.0.1",
                "--port", String.valueOf(endpoints().daemonPort())).start();
        Thread pump = new Thread(() -> pumpLog(p, log), "omp-local-log");
        pump.setDaemon(true);
        pump.start();
        return p;
    }

    String ownerToken() {
        return RuntimeIo.readTextOrNull(paths.inRootfs(RuntimePaths.GUEST_OWNER_TOKEN));
    }

    // ---- internals ----

    private InstallPlan plan() {
        return new InstallPlan(paths, spec, guest, guestFiles, status, AndroidPosix.INSTANCE);
    }

    private String unsupportedReason() {
        if (Build.VERSION.SDK_INT < MIN_SDK) return "Running omp on this phone needs Android 7.0 or newer.";
        if (!spec.supported()) return "Running omp on this phone is not available for this processor (" + Build.SUPPORTED_ABIS[0] + ").";
        return "This app build does not include the on-device runtime.";
    }

    private SharedPreferences modePrefs() {
        return app.getSharedPreferences(MODE_PREFS, Context.MODE_PRIVATE);
    }

    private SharedPreferences runtimePrefs() {
        return app.getSharedPreferences(RUNTIME_PREFS, Context.MODE_PRIVATE);
    }

    private static RuntimeSpec loadSpec(Context ctx) {
        try (InputStream in = ctx.getAssets().open(SPEC_ASSET)) {
            return RuntimeSpec.parse(RuntimeIo.drain(in), Build.SUPPORTED_ABIS);
        } catch (IOException | IllegalArgumentException e) {
            // A broken pin file is a build bug; it must disable phone mode, not crash laptop mode.
            Log.e(TAG, "cannot load " + SPEC_ASSET, e);
            return RuntimeSpec.unsupported();
        }
    }

    private static void pumpLog(Process p, File log) {
        byte[] buf = new byte[8192];
        try (InputStream in = p.getInputStream(); LogSink out = new LogSink(new FileOutputStream(log, true))) {
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, n);
        } catch (IOException ignored) {
            // The daemon exited or the log became unwritable; supervision reports the exit.
        }
    }

    /** Batch log writes; one bounded delayed flush only while bytes are pending. */
    private static final class LogSink implements Closeable {
        private final OutputStream out;
        private final ScheduledThreadPoolExecutor timer = new ScheduledThreadPoolExecutor(1, task -> {
            Thread thread = new Thread(task, "omp-local-log-flush");
            thread.setDaemon(true);
            return thread;
        });
        private ScheduledFuture<?> flushTask;
        private int pending;
        private boolean closed;

        LogSink(OutputStream file) {
            out = new BufferedOutputStream(file, 8192);
            timer.setRemoveOnCancelPolicy(true);
        }

        synchronized void write(byte[] bytes, int count) throws IOException {
            out.write(bytes, 0, count);
            pending += count;
            if (pending >= 4096 && bytes[count - 1] == '\n') {
                flush();
            } else if (flushTask == null) {
                flushTask = timer.schedule(this::flushQuietly, 2_000, TimeUnit.MILLISECONDS);
            }
        }

        private synchronized void flushQuietly() {
            if (closed) return;
            try {
                flush();
            } catch (IOException error) {
                Log.w(TAG, "Could not flush daemon.log", error);
            }
        }

        private void flush() throws IOException {
            if (flushTask != null) flushTask.cancel(false);
            flushTask = null;
            out.flush();
            pending = 0;
        }

        @Override public synchronized void close() throws IOException {
            closed = true;
            timer.shutdownNow();
            out.close();
        }
    }
}
