package com.omppulse.app;

/** Retry state owned by one notification SSE loop; all times are monotonic. */
final class NotifyReconnectBackoff {
    private static final long INITIAL_DELAY_MS = 1_000;
    private static final long MAX_DELAY_MS = 30_000;
    // The server deliberately delays its first ordinary ping by 25 seconds.
    // HTTP success or immediate retained replay alone must not clear failures.
    private static final long HEALTHY_STREAM_MS = 25_000;

    private long delayMs = INITIAL_DELAY_MS;
    private long openedAtMs;

    long delayMs() {
        return delayMs;
    }

    void recordFailure() {
        delayMs = Math.min(MAX_DELAY_MS, delayMs * 2);
    }

    void streamOpened(long nowMs) {
        openedAtMs = nowMs;
    }

    void observedLiveness(long nowMs) {
        if (nowMs - openedAtMs >= HEALTHY_STREAM_MS) {
            delayMs = INITIAL_DELAY_MS;
        }
    }
}
