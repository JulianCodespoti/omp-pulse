package com.omppulse.app.runtime;

import android.util.Log;

/**
 * Progress of the on-device runtime, written by the installer/service, read by the UI.
 *
 * WHY a single volatile immutable snapshot: the bridge polls from the WebView thread while the
 * service worker writes; publishing one object keeps phase, message, progress and error mutually
 * consistent without locks on the read path.
 */
public final class RuntimeStatus {
    static final String IDLE = "idle";
    static final String INSTALLING = "installing";
    static final String STARTING = "starting";
    static final String READY = "ready";
    static final String ERROR = "error";

    private static final String TAG = "OmpLocalRuntime";

    /** Immutable view of the runtime state. */
    public static final class Snapshot {
        private final String phase;
        private final String message;
        private final int progress;
        private final String error;

        Snapshot(String phase, String message, int progress, String error) {
            this.phase = phase;
            this.message = message;
            this.progress = progress;
            this.error = error;
        }

        /** "idle" | "installing" | "starting" | "ready" | "error". */
        public String phase() {
            return phase;
        }

        /** Human-readable current step; "" when there is none. */
        public String message() {
            return message;
        }

        /** -1 when indeterminate, else 0..100. */
        public int progress() {
            return progress;
        }

        /** Human-readable failure, or null. */
        public String error() {
            return error;
        }
    }

    private volatile Snapshot current = new Snapshot(IDLE, "", -1, null);

    Snapshot snapshot() {
        return current;
    }

    /** Enters {@code phase} with a fresh message and no error. */
    synchronized void enter(String phase, String message) {
        current = new Snapshot(phase, message, -1, null);
        Log.i(TAG, phase + ": " + message);
    }

    /** New step within the current phase. */
    synchronized void step(String message, int progress) {
        Snapshot s = current;
        current = new Snapshot(s.phase, message, clamp(progress), s.error);
        Log.i(TAG, message);
    }

    /** Progress update within the current step; cheap enough to call per buffer. */
    synchronized void progress(int progress) {
        Snapshot s = current;
        int p = clamp(progress);
        if (p != s.progress) current = new Snapshot(s.phase, s.message, p, s.error);
    }

    synchronized void fail(String error) {
        Snapshot s = current;
        current = new Snapshot(ERROR, s.message, -1, error == null || error.isEmpty() ? "Unknown error" : error);
        Log.e(TAG, "error: " + error);
    }

    /** Service stopped: back to idle unless the stop was caused by an error the UI must show. */
    synchronized void stopped() {
        if (!ERROR.equals(current.phase)) current = new Snapshot(IDLE, "", -1, null);
    }

    private static int clamp(int p) {
        return p < 0 ? -1 : Math.min(p, 100);
    }
}
