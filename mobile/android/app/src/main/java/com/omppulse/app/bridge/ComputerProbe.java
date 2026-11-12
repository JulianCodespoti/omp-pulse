package com.omppulse.app.bridge;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Read-only reachability of the computers this phone has saved, for the
 * stopped-phone-mode chooser. A check changes nothing: no active mode, token
 * or computer order, and the request carries no credential of any kind.
 *
 * INVARIANT: all state sits under {@link #lock}. A sweep is single-flight: at
 * most {@link #MAX_WORKERS} short-lived daemon threads exist at once, and a new
 * sweep starts only once every worker of the previous one has exited, however
 * often {@link #refresh} or {@link #cancel} are called. A worker publishes a
 * result only while its generation is current, so a reply that lands after
 * {@link #cancel} is dropped. No thread outlives its sweep and nothing is
 * scheduled while no one is asking.
 */
final class ComputerProbe {
    static final String CHECKING = "checking";
    static final String ONLINE = "online";
    static final String OFFLINE = "offline";

    static final int CONNECT_TIMEOUT_MS = 1500;
    static final int READ_TIMEOUT_MS = 3000;
    static final int MAX_WORKERS = 4;
    /** Time between the end of one sweep and the start of the next while the chooser stays open. */
    static final long SWEEP_GAP_MS = 4000;
    private static final long NEVER = Long.MIN_VALUE;

    /** True when {@code url} answered a plain GET with 200. May block up to its own deadlines. */
    interface Transport {
        boolean online(String url);
    }

    /** True for a saved address that is safe to contact (the canonical computer URL form). */
    interface Trust {
        boolean allows(String url);
    }

    // Laptop-only Android 22–23 predates java.util.function.
    interface Clock {
        long now();
    }

    private final Transport transport;
    private final Trust trust;
    private final Clock clock;
    private final long gapMs;

    private final Object lock = new Object();
    private long generation;
    private boolean active;
    private int live;
    private long finishedAt = NEVER;
    private final List<String> queue = new ArrayList<>();
    private int next;
    private final Map<String, Boolean> results = new HashMap<>();

    ComputerProbe(Transport transport, Trust trust, Clock clock, long gapMs) {
        this.transport = transport;
        this.trust = trust;
        this.clock = clock;
        this.gapMs = gapMs;
    }

    /**
     * The status of each of {@code urls}, starting a sweep when none is running
     * and the last one ended at least the gap ago. A result stays until its
     * replacement arrives; an address with no result yet is "checking".
     */
    Map<String, String> refresh(List<String> urls) {
        synchronized (lock) {
            if (!active) {
                // A fresh visit never shows the previous visit's answers.
                active = true;
                generation++;
                results.clear();
                finishedAt = NEVER;
            }
            if (live == 0 && (finishedAt == NEVER || clock.now() - finishedAt >= gapMs)) start(urls);
            Map<String, String> out = new LinkedHashMap<>();
            for (String url : urls) {
                Boolean online = results.get(url);
                out.put(url, online == null ? CHECKING : online ? ONLINE : OFFLINE);
            }
            return out;
        }
    }

    /** Forget every answer and fence replies still in flight. Idempotent. */
    void cancel() {
        synchronized (lock) {
            active = false;
            generation++;
            results.clear();
            finishedAt = NEVER;
            queue.clear();
            next = 0;
        }
    }

    // Caller holds lock, and no worker is alive.
    private void start(List<String> urls) {
        queue.clear();
        next = 0;
        for (String url : urls) {
            if (trust.allows(url)) queue.add(url);
            else results.put(url, false);
        }
        if (queue.isEmpty()) {
            finishedAt = clock.now();
            return;
        }
        long mine = generation;
        int wanted = Math.min(MAX_WORKERS, queue.size());
        live = wanted;
        int started = 0;
        try {
            while (started < wanted) {
                Thread worker = new Thread(() -> work(mine), "computer-probe");
                worker.setDaemon(true);
                worker.start();
                started++;
            }
        } finally {
            if (started < wanted) {
                live = started;
                if (started == 0) finishedAt = clock.now();
            }
        }
    }

    private void work(long mine) {
        try {
            while (true) {
                String url;
                synchronized (lock) {
                    if (mine != generation || next >= queue.size()) return;
                    url = queue.get(next++);
                }
                boolean online;
                try {
                    online = transport.online(url);
                } catch (RuntimeException e) {
                    online = false;
                }
                synchronized (lock) {
                    if (mine == generation) results.put(url, online);
                }
            }
        } finally {
            synchronized (lock) {
                live--;
                if (live == 0 && mine == generation) finishedAt = clock.now();
            }
        }
    }

    /**
     * A single unauthenticated GET. Only 200 is online: any other status
     * (a reverse proxy's 502 included), a redirect, a refusal or a timeout is
     * not. Redirects are never followed, so the request cannot leave the saved
     * address.
     */
    static boolean fetchOnline(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) URI.create(url).toURL().openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            return conn.getResponseCode() == 200;
        } catch (IOException e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
