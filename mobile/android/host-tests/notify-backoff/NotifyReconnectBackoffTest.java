package com.omppulse.app;

/** Standalone, dependency-free behavior checks for the production policy seam. */
public final class NotifyReconnectBackoffTest {
    private static int passed;

    private static void expect(String name, long expected, long actual) {
        if (expected != actual) throw new AssertionError(name + ": " + actual + " != " + expected);
        passed++;
        System.out.println("PASS " + name);
    }

    public static void main(String[] args) {
        NotifyReconnectBackoff retry = new NotifyReconnectBackoff();
        long[] delays = {1000, 2000, 4000, 8000, 16000, 30000, 30000};
        for (long delay : delays) {
            expect("bounded failure sequence " + delay, delay, retry.delayMs());
            retry.recordFailure();
        }
        for (int count = 0; count < 1000; count++) retry.recordFailure();
        expect("cap remains bounded after many failures", 30000, retry.delayMs());
        retry.streamOpened(100000);
        expect("opening does not reset failures", 30000, retry.delayMs());
        retry.observedLiveness(100000);
        expect("immediate liveness does not reset failures", 30000, retry.delayMs());
        retry.observedLiveness(124999);
        expect("threshold minus one", 30000, retry.delayMs());
        retry.observedLiveness(125000);
        expect("exact threshold", 1000, retry.delayMs());
        retry.recordFailure();
        retry.streamOpened(125001);
        retry.observedLiveness(125001);
        expect("new connection starts fresh health window", 2000, retry.delayMs());
        retry.streamOpened(Long.MAX_VALUE - 25000);
        retry.observedLiveness(Long.MAX_VALUE - 1);
        expect("long uptime before threshold", 2000, retry.delayMs());
        retry.observedLiveness(Long.MAX_VALUE);
        expect("long uptime at threshold", 1000, retry.delayMs());
        NotifyReconnectBackoff successor = new NotifyReconnectBackoff();
        successor.recordFailure();
        retry.observedLiveness(Long.MAX_VALUE);
        expect("retired policy cannot reset successor", 2000, successor.delayMs());
        for (int count = 0; count < 40; count++) retry.recordFailure();
        retry.streamOpened(Long.MAX_VALUE - 10000);
        retry.observedLiveness(Long.MIN_VALUE + 14998);
        expect("signed clock wrap below threshold", 30000, retry.delayMs());
        retry.observedLiveness(Long.MIN_VALUE + 14999);
        expect("signed clock wrap at threshold", 1000, retry.delayMs());
        retry.recordFailure();
        retry.streamOpened(100000);
        retry.observedLiveness(99999);
        expect("clock regression cannot manufacture health", 2000, retry.delayMs());
        retry.observedLiveness(124999);
        retry.streamOpened(124999);
        retry.observedLiveness(125000);
        expect("opening fences previous connection age", 2000, retry.delayMs());
        retry.observedLiveness(149999);
        expect("later healthy frame resets current connection", 1000, retry.delayMs());
        System.out.println("POLICY_TOTAL_PASS " + passed);
    }
}
