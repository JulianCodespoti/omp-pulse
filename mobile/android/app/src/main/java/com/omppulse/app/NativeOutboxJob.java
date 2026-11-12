package com.omppulse.app;

import android.app.job.JobScheduler;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

/** Persistent network-constrained retry entry point independent of notifications. */
public final class NativeOutboxJob extends JobService {
    private static final String TAG = "OmpNativeOutboxJob";
    private static final int JOB_ID = 0x4f4d50;
    private static final long NO_RETRY = Long.MAX_VALUE;
    private static final Object LOCK = new Object();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static boolean scheduled;
    private static boolean running;
    private static long scheduledDelay = NO_RETRY;
    private static long nextDelay = NO_RETRY;
    private static Context application;
    private static JobParameters activeJob;
    private static long activeGeneration;
    private long startedGeneration;

    public static void schedule(Context context, long delayMillis) {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            application = app;
            if (running) {
                nextDelay = Math.min(nextDelay, Math.max(0, delayMillis));
                return;
            }
            long boundedDelay = Math.max(0, delayMillis);
            scheduleLocked(app, boundedDelay);
        }
    }

    @Override public boolean onStartJob(JobParameters parameters) {
        final long generation;
        synchronized (LOCK) {
            scheduled = false;
            scheduledDelay = NO_RETRY;
            running = true;
            nextDelay = NO_RETRY;
            application = getApplicationContext();
            activeJob = parameters;
            generation = ++activeGeneration;
            startedGeneration = generation;
        }
        // Android lifecycle callbacks run on main; delivery completes on its worker.
        // Queue completion on main as well, so a stop either precedes or follows the
        // entire scheduler handoff, never an ownership-cleared persistence gap.
        NativeOutbox.runJob(this,
                () -> MAIN.post(() -> finishDeliveryJob(parameters, generation)));
        return true;
    }

    private void finishDeliveryJob(JobParameters parameters, long generation) {
        synchronized (LOCK) {
            if (activeJob == null || activeGeneration != generation || !running) return;
            long retry = nextDelay;
            boolean persisted = retry == NO_RETRY || scheduleLocked(application, retry);
            // Scheduling this ID replaces the running scheduler job. Its callbacks
            // may retire this run or establish a newer generation during the handoff.
            if (activeJob == null || activeGeneration != generation || !running) return;
            if (!persisted) {
                running = false;
                nextDelay = NO_RETRY;
                // jobFinished queues a framework message, not a synchronous scheduler
                // acknowledgement. Retain ownership until stop/start so an already
                // queued stop still requests recovery if that message has not run.
                jobFinished(parameters, true);
                return;
            }
            // A pending retry is persisted before ownership can be retired. An empty
            // completed drain needs neither a replacement job nor stop-time recovery.
            jobFinished(parameters, false);
            if (activeJob == null || activeGeneration != generation) return;
            activeJob = null;
            running = false;
            nextDelay = NO_RETRY;
        }
    }

    @Override public boolean onStopJob(JobParameters parameters) {
        synchronized (LOCK) {
            // Start/stop parameters are separately parceled objects. Android orders
            // lifecycle calls on main; match its job ID, and reject an old service's
            // callback using our own run generation rather than Java object identity.
            if (activeJob == null || activeJob.getJobId() != parameters.getJobId()
                    || startedGeneration != activeGeneration) return false;
            activeJob = null;
            running = false;
            nextDelay = NO_RETRY;
        }
        // Pending state is unknown (or completion's scheduler handoff failed).
        // Acknowledge recovery in the stop response itself, before process reclamation.
        return true;
    }

    /** Called under LOCK; a successful return acknowledges durable scheduler ownership. */
    private static boolean scheduleLocked(Context app, long boundedDelay) {
        if (scheduled && scheduledDelay <= boundedDelay) return true;
        JobScheduler scheduler = (JobScheduler) app.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return false;
        JobInfo.Builder builder = new JobInfo.Builder(
                JOB_ID, new ComponentName(app, NativeOutboxJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true);
        if (boundedDelay > 0) builder.setMinimumLatency(boundedDelay);
        long generation = activeGeneration;
        int result = scheduler.schedule(builder.build());
        if (result == JobScheduler.RESULT_SUCCESS) {
            // Replacing this ID can stop the old job and start another run. Do not
            // overwrite bookkeeping that a newer onStartJob has already initialized.
            if (activeGeneration == generation) {
                scheduled = true;
                scheduledDelay = boundedDelay;
            }
            return true;
        }
        Log.w(TAG, "JobScheduler declined native sender recovery job");
        return false;
    }
}
