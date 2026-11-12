package com.omppulse.app;

import java.util.ArrayList;
import java.util.List;

final class ChangeSignalTest {
    // EXACT_CHANGE_SIGNAL

    private static long now;
    private static int calls;
    private static int assertions;
    private static final List<Task> scheduled = new ArrayList<>();
    private static final List<Long> times = new ArrayList<>();

    private static final class Task {
        final Runnable action;
        final long at;
        Task(Runnable action, long at) { this.action = action; this.at = at; }
    }

    private static void check(boolean condition, String message) {
        assertions++;
        if (!condition) throw new AssertionError(message);
    }

    private static ChangeSignal fresh(boolean listening) {
        now = 1_000;
        calls = 0;
        times.clear();
        scheduled.clear();
        ChangeSignal signal = new ChangeSignal(() -> now, (action, delay) -> {
            Task task = new Task(action, now + delay);
            scheduled.add(task);
            return () -> scheduled.remove(task);
        });
        if (listening) signal.setListener(() -> { calls++; times.add(now); });
        return signal;
    }

    private static void runDue(long until) {
        while (!scheduled.isEmpty()) {
            Task task = scheduled.get(0);
            if (task.at > until) break;
            scheduled.remove(task);
            now = task.at;
            task.action.run();
        }
        now = until;
    }

    public static void main(String[] args) {
        ChangeSignal idle = fresh(false);
        idle.signal();
        check(calls == 0 && scheduled.isEmpty(), "no renderer schedules no timers");
        ChangeSignal burst = fresh(true);
        burst.signal();
        for (int i = 0; i < 10; i++) { now += 10; burst.signal(); }
        check(calls == 1 && scheduled.size() == 1, "burst has one immediate and one trailing hint");
        runDue(1_250);
        check(calls == 2 && scheduled.isEmpty(), "last state is announced");
        ChangeSignal stream = fresh(true);
        for (long time = 1_000; time < 3_000; time += 10) {
            runDue(time);
            stream.signal();
        }
        runDue(10_000);
        check(calls <= 9 && times.get(times.size() - 1) >= 2_990, "stream is bounded and final change retained");
        for (int i = 1; i < times.size(); i++) check(times.get(i) - times.get(i - 1) >= 250, "four Hz ceiling");
        stream.signal();
        now += 10;
        stream.signal();
        check(scheduled.size() == 1, "trailing timer is armed");
        Runnable obsolete = scheduled.get(0).action;
        stream.setListener(null);
        int before = calls;
        check(scheduled.isEmpty(), "last renderer removal cancels trailing timer");
        stream.setListener(() -> calls++);
        obsolete.run();
        check(calls == before, "already queued old generation timer cannot notify a replacement");
        stream.signal();
        check(calls == before + 1, "new renderer resumes signalling immediately");

        OutboxPageRegistry<Object, Runnable> pages = new OutboxPageRegistry<>();
        Object main = new Object(), bubble = new Object();
        OutboxPageRegistry.Owner<Runnable> mainOwner = pages.install(main);
        OutboxPageRegistry.Owner<Runnable> bubbleOwner = pages.install(bubble);
        int[] received = {0, 0};
        Runnable mainPage = () -> received[0]++;
        check(pages.attach(main, mainOwner, mainPage), "first main request registers channel");
        check(!pages.attach(main, mainOwner, mainPage), "ordinary list requests do not generate refresh loops");
        check(pages.attach(bubble, bubbleOwner, () -> received[1]++), "bubble has independent channel");
        pages.broadcast(Runnable::run);
        check(received[0] == 1 && received[1] == 1, "both pages receive native mutations");
        pages.navigate(main);
        pages.broadcast(Runnable::run);
        check(received[0] == 1 && received[1] == 2, "main navigation cannot clear bubble channel");
        pages.remove(main);
        check(pages.hasPages(), "surviving bubble keeps listener");
        OutboxPageRegistry.Owner<Runnable> replacement = pages.install(main);
        check(!pages.attach(main, mainOwner, mainPage), "obsolete renderer generation cannot reattach");
        check(pages.attach(main, replacement, () -> { throw new IllegalStateException("gone"); }), "new main owner attaches");
        pages.broadcast(Runnable::run);
        check(received[1] == 3, "failed renderer delivery cannot suppress another page");
        pages.remove(bubble);
        check(!pages.hasPages(), "last live subscription removal disables signal listener");
        System.out.println("PASS " + assertions + " outbox event and two-page ownership assertions");
    }
}
