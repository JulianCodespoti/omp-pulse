package com.omppulse.app.runtime;

/**
 * Timed work leases, driven by authenticated daemon reports, never by a wake-up timer.
 * Transport failure is unknown, not idle: it neither shortens nor renews the last lease.
 * Even a supervisor exit does not prove every descendant stopped, so it preserves that lease.
 * A healthy busy report renews two hours of coverage; an explicit idle report leaves one
 * minute of grace. Startup has ten minutes of coverage without shortening known busy work.
 */
final class BusyLockPolicy {
    interface Clock { long now(); }
    interface Lock {
        /** Non-reference-counted; replace the previous timeout. Never acquire untimed. */
        void acquire(long timeoutMs);
        void release();
    }

    enum State { STARTING, IDLE, BUSY, GRACE, DAEMON_DOWN }

    static final long STARTING_MS = 10 * 60_000L;
    static final long BUSY_MS = 2 * 60 * 60_000L;
    static final long GRACE_MS = 60_000L;

    private final Clock clock;
    private final Lock lock;
    private State state = State.IDLE;
    private long holdUntil;
    private boolean stopped;

    BusyLockPolicy(Clock clock, Lock lock) {
        this.clock = clock;
        this.lock = lock;
    }

    synchronized State state() {
        return state;
    }

    synchronized void starting() {
        if (stopped) return;
        state = State.STARTING;
        long now = clock.now();
        holdUntil = Math.max(holdUntil, now + STARTING_MS);
        lock.acquire(holdUntil - now);
    }

    synchronized void report(boolean busy) {
        if (stopped) return;
        long now = clock.now();
        if (busy) {
            state = State.BUSY;
            holdUntil = now + BUSY_MS;
            lock.acquire(BUSY_MS);
        } else if (state == State.BUSY || (state == State.DAEMON_DOWN && holdUntil > now)) {
            state = State.GRACE;
            holdUntil = now + GRACE_MS;
            lock.acquire(GRACE_MS);
        } else if (state != State.GRACE || now >= holdUntil) {
            toIdle();
        }
    }

    /** True when unknown work has exhausted its bounded protection; callers surface a warning. */
    synchronized boolean transportFailure() {
        return !stopped && state != State.IDLE && clock.now() >= holdUntil;
    }

    /** Only the supervisor calls this, on process exit, never on an HTTP error. */
    synchronized void daemonDown() {
        if (!stopped) state = State.DAEMON_DOWN;
    }

    /** Terminal: a late callback from a stopped service cannot re-acquire the lock. */
    synchronized void stop() {
        stopped = true;
        toIdle();
    }

    private void toIdle() {
        state = State.IDLE;
        holdUntil = 0;
        lock.release();
    }
}
