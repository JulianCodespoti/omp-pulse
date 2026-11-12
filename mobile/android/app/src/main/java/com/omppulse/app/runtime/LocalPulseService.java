package com.omppulse.app.runtime;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import com.omppulse.app.MainActivity;
import com.omppulse.app.NotificationHelper;
import com.omppulse.app.TokenStore;
import com.omppulse.app.phone.PhoneApi;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Foreground service that installs the runtime if needed and keeps omp-pulse running.
 *
 * Supervision: a daemon that exits is restarted with exponential backoff; after
 * {@link #MAX_QUICK_FAILURES} consecutive attempts that did not stay up for
 * {@link #STABLE_MS}, the service gives up, reports the error and stops.
 *
 * Wake lock: held only while the daemon has work ({@link BusyLockPolicy}, fed by a
 * {@code /api/busy} long-poll while READY), never for the service's whole life.
 */
public class LocalPulseService extends Service {
    private static final String TAG = "OmpLocalService";
    private static final int NOTIFICATION_ID = 1002;
    private static final long STARTUP_TIMEOUT_MS = 60_000;
    private static final long STABLE_MS = 30_000;
    private static final long BACKOFF_START_MS = 2_000;
    private static final long BACKOFF_MAX_MS = 60_000;
    private static final int MAX_QUICK_FAILURES = 5;
    /** Serialises supervision across service instances; see {@link #supervise()}. */
    private static final ReentrantLock SUPERVISOR = new ReentrantLock();

    private static final long SHUTDOWN_WAIT_MS = 3_000;

    private volatile boolean running;
    private BusyLockPolicy lockPolicy;
    /** The READY daemon's busy long-poll; written by the worker, stopped from either thread. */
    private volatile BusyWatcher busyWatcher;
    private Thread worker;

    public static void start(Context c) {
        ContextCompat.startForegroundService(c, new Intent(c, LocalPulseService.class));
    }

    public static void stop(Context c) {
        c.stopService(new Intent(c, LocalPulseService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!startAsForeground()) return START_NOT_STICKY;
        if (worker == null || !worker.isAlive()) {
            running = true;
            if (lockPolicy == null) {
                // The daemon serves the WebView and agents run for minutes with the screen off;
                // without a partial wake lock the CPU sleeps mid-turn. It used to be acquired
                // here, untimed, for the service's whole life, so the phone never slept and every
                // daemon, WebView and proot timer fired around the clock while nobody could see
                // the result. BusyLockPolicy now holds it only while the daemon reports work.
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                PowerManager.WakeLock wakeLock = pm.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK, "omp-pulse:local-daemon");
                wakeLock.setReferenceCounted(false);
                lockPolicy = new BusyLockPolicy(SystemClock::elapsedRealtime, new BusyLockPolicy.Lock() {
                    @Override
                    public void acquire(long timeoutMs) {
                        // Non-reference-counted: a new timed acquire replaces the old timeout.
                        wakeLock.acquire(timeoutMs);
                    }

                    @Override
                    public void release() {
                        if (wakeLock.isHeld()) wakeLock.release();
                    }
                });
            }
            worker = new Thread(this::supervise, "omp-local-daemon");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        // Atomic against publishReady/startBusyWatcher: after this block no READY, phone API or
        // busy watcher of this instance can appear.
        synchronized (this) {
            running = false;
            stopBusyWatcher();
            PhoneApi.stop();
        }
        // The supervisor thread stops the daemon under SUPERVISOR (see shutdownDaemon): doing it here
        // would block or race the main thread and a SIGKILL from here would orphan the guest.
        Thread t = worker;
        if (t != null) t.interrupt();
        if (lockPolicy != null) lockPolicy.stop();
        LocalRuntime.get(this).statusHolder().stopped();
        super.onDestroy();
    }

    private boolean startAsForeground() {
        NotificationHelper.ensureChannels(this);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Notification n = new NotificationCompat.Builder(this, NotificationHelper.CH_FG)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("omp-pulse")
                .setContentText("Running omp on this phone")
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(PendingIntent.getActivity(this, NOTIFICATION_ID, open, piFlags))
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                // INVARIANT: the manifest declares foregroundServiceType="specialUse"; API 34+
                // requires the type at startForeground. Older releases reject unknown types, so
                // they get the untyped call.
                ServiceCompat.startForeground(this, NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            return true;
        } catch (RuntimeException e) {
            Log.e(TAG, "startForeground failed", e);
            LocalRuntime.get(this).statusHolder().fail("Could not start the background service: " + e.getClass().getSimpleName());
            stopSelf();
            return false;
        }
    }

    private void supervise() {
        // INVARIANT: one supervisor per process. A quick stop()/start() creates a new service
        // instance while the old worker may still be blocked in an install step or HTTP read;
        // without this lock both would install concurrently and the old one could start a
        // daemon nobody stops. onDestroy interrupts the old worker, which releases the lock.
        try {
            SUPERVISOR.lockInterruptibly();
        } catch (InterruptedException e) {
            return;
        }
        Process mine = null;
        LocalRuntime rt = LocalRuntime.get(this);
        try {
            if (!running) return;
            mine = superviseLocked();
        } finally {
            // Whatever ends supervision, the daemon this thread started must not outlive it, nor
            // the phone API of a service that was stopped while this thread was still starting up.
            // Still under SUPERVISOR, so a quick restart cannot start a daemon before this one is gone.
            boolean stopped = !running;
            // Explicit stop to "unset" (persisted before the service is stopped) also stops guest
            // commands the daemon did not start, even when stopped mid-install (mine == null). A
            // stop for another mode, or an immediate resume, keeps sign-in and installs.
            boolean allGuests = stopped && rt.mode() == LocalRuntime.Mode.UNSET;
            if (mine != null || allGuests) shutdownDaemon(rt, mine, allGuests);
            if (stopped) {
                PhoneApi.stop();
                // Last word on the status: nothing of this instance can enter READY or STARTING later.
                rt.statusHolder().stopped();
            }
            SUPERVISOR.unlock();
        }
        if (running) stopSelf();
    }

    /** Returns the last daemon process this thread started (null if none). */
    private Process superviseLocked() {
        LocalRuntime rt = LocalRuntime.get(this);
        RuntimeStatus status = rt.statusHolder();
        try {
            lockPolicy.starting();
            rt.installIfNeeded();
        } catch (InterruptedException e) {
            return null;
        } catch (Exception e) {
            if (!running) return null; // cancelled by stop(); not a failure
            Log.e(TAG, "install failed", e);
            status.fail(message(e));
            return null;
        }

        // A previous service instance in this process may have left the phone API running.
        PhoneApi.stop();
        rt.claimPhoneApiPort();
        int quickFailures = 0;
        long backoff = BACKOFF_START_MS;
        String lastError = null;
        Process p = null;
        while (running) {
            long upSince = 0;
            try {
                status.enter(RuntimeStatus.STARTING, quickFailures == 0 ? "Starting omp-pulse" : "Restarting omp-pulse");
                lockPolicy.starting();
                rt.killOrphanedDaemons();
                rt.claimDaemonPort();
                rt.refreshGuestFiles();
                if (!running) break;
                p = rt.startDaemon();
                if (!running) break;
                awaitAnswer(rt, p);
                if (!running) break;
                rt.daemonClient().ensurePaired(this, rt.ownerToken());
                // The agent's route to the phone; only with "Phone tools for the agent" on.
                boolean phoneTools = rt.phoneTools();
                if (!publishReady(rt, phoneTools)) break;
                upSince = System.currentTimeMillis();
                p.waitFor();
                if (!running) break;
                lastError = "omp-pulse keeps exiting; see daemon.log";
                Log.w(TAG, "daemon exited; restarting");
            } catch (InterruptedException e) {
                break;
            } catch (Exception e) {
                if (!running) break;
                lastError = message(e);
                Log.e(TAG, "daemon start failed", e);
                shutdownDaemon(rt, p, false);
            } finally {
                stopBusyWatcher();
            }
            // A supervisor exit does not prove its descendants stopped: the policy keeps the lease.
            lockPolicy.daemonDown();
            boolean stable = upSince > 0 && System.currentTimeMillis() - upSince >= STABLE_MS;
            if (stable) {
                quickFailures = 0;
                backoff = BACKOFF_START_MS;
            } else if (++quickFailures >= MAX_QUICK_FAILURES) {
                status.fail(lastError);
                break;
            }
            // Leave READY: nothing listens during the backoff, and READY tells the shell and
            // onboarding to load the app.
            status.enter(RuntimeStatus.STARTING, "omp-pulse stopped; restarting in " + (backoff / 1000) + " s");
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                break;
            }
            if (!stable) backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
        return p;
    }

    /**
     * Waits until our daemon answers HTTP, failing fast if the process dies. The port was free
     * when claimed; a process that exits while something answers lost the bind to a squatter,
     * so liveness is re-checked after the answer before any credential is sent.
     */
    private void awaitAnswer(LocalRuntime rt, Process p) throws IOException, InterruptedException {
        DaemonClient client = rt.daemonClient();
        long deadline = System.currentTimeMillis() + STARTUP_TIMEOUT_MS;
        while (running && client.probe(null) == DaemonClient.UNREACHABLE) {
            if (!alive(p)) throw new IOException("omp-pulse exited during startup; see daemon.log");
            if (System.currentTimeMillis() > deadline) {
                throw new IOException("omp-pulse did not answer within " + (STARTUP_TIMEOUT_MS / 1000) + " s");
            }
            Thread.sleep(250);
        }
        if (!alive(p)) throw new IOException("omp-pulse exited during startup; see daemon.log");
    }

    /**
     * Publishes READY together with what belongs to it (phone API, busy watcher) unless the service
     * was stopped. Synchronized with onDestroy, so a stop cannot land between the check and the
     * publication and leave a stale READY or a restarted API behind.
     */
    private synchronized boolean publishReady(LocalRuntime rt, boolean phoneTools) {
        if (!running) return false;
        if (phoneTools) PhoneApi.start(this);
        rt.statusHolder().enter(RuntimeStatus.READY, "Running on this phone");
        startBusyWatcher(rt);
        return true;
    }

    private synchronized void startBusyWatcher(LocalRuntime rt) {
        stopBusyWatcher();
        if (!running) return;
        BusyWatcher watcher = new BusyWatcher(getApplicationContext(), rt.daemonClient(), lockPolicy);
        busyWatcher = watcher;
        watcher.start();
    }

    private synchronized void stopBusyWatcher() {
        BusyWatcher watcher = busyWatcher;
        busyWatcher = null;
        if (watcher != null) watcher.stop();
    }

    /** Long-poll while READY. HTTP failure preserves the last bounded work lease. */
    private static final class BusyWatcher implements Runnable {
        private static final int WAIT_SECONDS = 240;
        private final Context ctx;
        private final DaemonClient client;
        private final BusyLockPolicy policy;
        private final BusyWatchControl control = new BusyWatchControl();
        private final Thread thread = new Thread(this, "omp-busy-watch");
        private volatile boolean stopped;
        private boolean warnedExpired;

        BusyWatcher(Context ctx, DaemonClient client, BusyLockPolicy policy) {
            this.ctx = ctx;
            this.client = client;
            this.policy = policy;
        }

        void start() {
            thread.start();
        }

        void stop() {
            stopped = true;
            HttpURLConnection connection = control.stop();
            thread.interrupt();
            if (connection != null) {
                // Some platform disconnects wait for socket teardown. Never do that on the
                // main thread; generation fencing above already prevents any stale report.
                Thread close = new Thread(connection::disconnect, "omp-busy-close");
                close.setDaemon(true);
                close.start();
            }
        }

        @Override public void run() {
            long after = -1;
            long backoff = 1_000;
            while (!stopped) {
                try {
                    String token = TokenStore.getTokenFor(ctx, DaemonClient.TOKEN_SLOT);
                    DaemonClient.Busy answer = client.busy(token, after, WAIT_SECONDS, control);
                    if (!control.update(() -> policy.report(answer.busy))) return;
                    after = answer.version;
                    backoff = 1_000;
                    warnedExpired = false;
                } catch (IOException error) {
                    if (stopped) return;
                    Log.w(TAG, "busy watch unavailable; preserving last work lease: " + message(error));
                    if (!control.update(this::reportTransportFailure)) return;
                    after = -1;
                    try {
                        Thread.sleep(backoff);
                    } catch (InterruptedException interrupted) {
                        return;
                    }
                    backoff = Math.min(backoff * 2, 60_000);
                }
            }
        }

        private void reportTransportFailure() {
            if (policy.transportFailure() && !warnedExpired) {
                Log.e(TAG, "Busy reporting is still unavailable; bounded wake protection expired. "
                        + "Work is unconfirmed, not idle; reconnect to inspect daemon.log.");
                warnedExpired = true;
            }
        }
    }

    /**
     * Stops the daemon and its guest tree, then waits (bounded) for proot to exit. Runs on the
     * supervisor thread only. {@code Process.destroy()} alone is not enough: proot ignores SIGTERM
     * and a SIGKILL on it detaches the guest instead of killing it (see
     * {@link LocalRuntime#signalGuest}), so proot is sent SIGQUIT first and destroy() stays only
     * as the backstop. {@code allGuests} also stops every other guest command (sign-in, install):
     * only for an explicit stop to "unset"; a daemon restart or switch to a computer keeps them.
     * Interrupts are held until done: a stop is exactly when this must complete.
     */
    private static void shutdownDaemon(LocalRuntime rt, Process p, boolean allGuests) {
        boolean interrupted = Thread.interrupted();
        if (allGuests) rt.stopGuestProcesses();
        else rt.stopDaemonProcesses();
        if (p != null) {
            long deadline = SystemClock.elapsedRealtime() + SHUTDOWN_WAIT_MS;
            while (alive(p) && SystemClock.elapsedRealtime() < deadline) {
                try {
                    Thread.sleep(50);
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
            p.destroy();
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    private static boolean alive(Process p) {
        try {
            p.exitValue();
            return false;
        } catch (IllegalThreadStateException e) {
            return true;
        }
    }

    private static String message(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }
}
