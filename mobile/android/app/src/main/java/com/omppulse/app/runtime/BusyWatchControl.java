package com.omppulse.app.runtime;

import java.net.HttpURLConnection;

/** Cancellation and report ownership; no network operation is performed under this monitor. */
final class BusyWatchControl {
    private boolean stopped;
    private HttpURLConnection current;

    synchronized boolean publish(HttpURLConnection connection) {
        if (stopped) return false;
        current = connection;
        return true;
    }

    synchronized void clear(HttpURLConnection connection) {
        if (current == connection) current = null;
    }

    synchronized boolean update(Runnable action) {
        if (stopped) return false;
        action.run();
        return true;
    }

    /** Marks the generation stopped before returning the connection to close off the UI thread. */
    synchronized HttpURLConnection stop() {
        stopped = true;
        HttpURLConnection connection = current;
        current = null;
        return connection;
    }
}
