package com.omppulse.app.runtime;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

final class BusyLockPolicyTest {
    private static long now;
    private static int assertions;

    private static final class Lock implements BusyLockPolicy.Lock {
        long until;
        int acquisitions;
        @Override public void acquire(long timeoutMs) {
            check(timeoutMs > 0, "all holds are timed and positive");
            until = now + timeoutMs;
            acquisitions++;
        }
        @Override public void release() { until = 0; }
        boolean held() { return until > now; }
    }

    private static void check(boolean condition, String message) {
        assertions++;
        if (!condition) throw new AssertionError(message);
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(3, TimeUnit.SECONDS)) throw new AssertionError("barrier timed out");
        } catch (InterruptedException error) {
            throw new AssertionError(error);
        }
    }

    private static final class Connection extends HttpURLConnection {
        boolean disconnected;
        Connection() throws Exception { super(java.net.URI.create("http://127.0.0.1/unused").toURL()); }
        @Override public void disconnect() { disconnected = true; }
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() { throw new AssertionError("no sockets in host tests"); }
    }

    public static void main(String[] args) throws Exception {
        now = 0;
        Lock lock = new Lock();
        BusyLockPolicy policy = new BusyLockPolicy(() -> now, lock);
        policy.starting();
        check(lock.until == BusyLockPolicy.STARTING_MS, "startup is bounded");
        now += 1_000;
        long startingUntil = lock.until;
        check(!policy.transportFailure() && lock.until == startingUntil, "startup HTTP error preserves lease");
        policy.report(false);
        check(!lock.held(), "first confirmed idle releases startup");
        policy.report(true);
        long busyUntil = lock.until;
        now += 30_000;
        int acquisitions = lock.acquisitions;
        check(!policy.transportFailure() && lock.until == busyUntil && lock.acquisitions == acquisitions,
                "transient failure neither releases nor renews known busy work");
        policy.daemonDown();
        check(lock.until == busyUntil, "supervisor exit is not proof descendants died");
        policy.starting();
        check(lock.until == busyUntil, "restart cannot shorten the previous busy lease");
        policy.report(true);
        check(lock.until == now + BusyLockPolicy.BUSY_MS, "healthy report renews coverage");
        policy.report(false);
        long graceUntil = lock.until;
        check(graceUntil == now + BusyLockPolicy.GRACE_MS, "explicit busy-to-idle grants grace");
        now += 1_000;
        policy.report(false);
        policy.transportFailure();
        check(lock.until == graceUntil, "idle reports and failures never extend grace");
        now = graceUntil;
        check(!lock.held(), "grace expires without a policy timer");
        policy.report(false);
        check(policy.state() == BusyLockPolicy.State.IDLE, "expired idle is recorded");
        policy.report(true);
        busyUntil = lock.until;
        now = busyUntil - 1;
        check(!policy.transportFailure() && lock.held(), "unknown busy protected until exact lease boundary");
        now++;
        check(policy.transportFailure() && !lock.held(), "permanent failure is bounded and reportably expired");
        policy.transportFailure();
        check(lock.until == busyUntil, "repeated failures do not create an endless lock");
        policy.report(true);
        check(lock.held(), "successful recovery can cover remaining work");
        policy.stop();
        policy.report(true);
        policy.starting();
        policy.daemonDown();
        check(!lock.held() && policy.state() == BusyLockPolicy.State.IDLE, "late stopped callbacks cannot rearm");

        Lock extra = new Lock();
        BusyLockPolicy continued = new BusyLockPolicy(() -> now, extra);
        continued.starting();
        now = extra.until;
        check(!extra.held() && continued.transportFailure(), "unreported startup lapses without a timer");
        continued.report(false);
        acquisitions = extra.acquisitions;
        continued.report(false);
        continued.daemonDown();
        continued.report(false);
        check(!extra.held() && extra.acquisitions == acquisitions, "idle and idle-down reports never acquire");
        continued.report(true);
        long originalUntil = extra.until;
        now = originalUntil - 1_000;
        continued.report(true);
        now = originalUntil + 1_000;
        check(extra.held(), "healthy repeated reports cover a turn beyond two hours");
        continued.report(false);
        now += BusyLockPolicy.GRACE_MS / 2;
        continued.report(true);
        now += BusyLockPolicy.GRACE_MS;
        check(extra.held() && continued.state() == BusyLockPolicy.State.BUSY, "busy again cancels idle grace");
        continued.stop();

        BusyWatchControl stopped = new BusyWatchControl();
        check(stopped.stop() == null, "stop before publication captures no connection");
        Connection late = new Connection();
        check(!stopped.publish(late), "stopped generation cannot publish a new blocking read");
        AtomicBoolean stale = new AtomicBoolean();
        check(!stopped.update(() -> stale.set(true)) && !stale.get(), "late reports are fenced");

        BusyWatchControl old = new BusyWatchControl();
        Connection owned = new Connection();
        check(old.publish(owned), "live generation owns connection");
        check(old.stop() == owned, "stop captures the published connection for off-main cancellation");
        owned.disconnect();
        check(owned.disconnected, "captured transport is disconnected");
        Connection replacement = new Connection();
        check(!old.publish(replacement), "stop/publication race cannot strand a later connection");
        Lock nextLock = new Lock();
        BusyLockPolicy nextPolicy = new BusyLockPolicy(() -> now, nextLock);
        nextPolicy.starting();
        check(!old.update(() -> nextPolicy.report(false))
                && nextPolicy.state() == BusyLockPolicy.State.STARTING && nextLock.held(),
                "stale idle cannot release replacement startup");
        nextPolicy.report(true);
        long nextUntil = nextLock.until;
        check(!old.update(() -> nextPolicy.report(false))
                && !old.update(nextPolicy::transportFailure)
                && nextPolicy.state() == BusyLockPolicy.State.BUSY && nextLock.until == nextUntil,
                "stale report or failure cannot alter replacement busy coverage");
        nextPolicy.stop();

        BusyWatchControl racing = new BusyWatchControl();
        CountDownLatch updating = new CountDownLatch(1);
        CountDownLatch finishUpdate = new CountDownLatch(1);
        CountDownLatch stopping = new CountDownLatch(1);
        AtomicBoolean stopReturned = new AtomicBoolean();
        Thread report = new Thread(() -> racing.update(() -> {
            updating.countDown();
            await(finishUpdate);
        }));
        report.start();
        await(updating);
        Thread stop = new Thread(() -> {
            stopping.countDown();
            racing.stop();
            stopReturned.set(true);
        });
        stop.start();
        await(stopping);
        check(!stopReturned.get(), "stop cannot cross an in-flight policy update");
        finishUpdate.countDown();
        report.join(3_000);
        stop.join(3_000);
        check(!report.isAlive() && !stop.isAlive() && stopReturned.get(), "ownership fence completes");
        check(!racing.update(() -> stale.set(true)), "replacement cannot be changed by old generation");
        System.out.println("PASS " + assertions + " busy lease and watcher ownership assertions");
    }
}
