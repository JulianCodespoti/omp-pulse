package com.omppulse.app;

import java.util.List;

final class ShellLifecycleTest {
    private static int assertions;
    private static void check(boolean condition, String message) {
        assertions++;
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        ShellLifecycle<Object, Object> shells = new ShellLifecycle<>();
        Object main = new Object(), bubble = new Object();
        Object mainView = new Object(), bubbleView = new Object();
        shells.attach(main, mainView);
        shells.attach(bubble, bubbleView);
        shells.start(main);
        shells.start(bubble);
        shells.stop(main);
        check(shells.hiddenTimerView() == null, "outgoing main cannot freeze incoming bubble");
        shells.stop(main);
        check(shells.hiddenTimerView() == null, "duplicate stop cannot underflow active membership");
        shells.stop(bubble);
        check(shells.hiddenTimerView() != null, "last stopped shell can pause process timers");
        shells.start(main);
        shells.start(main);
        shells.stop(main);
        check(shells.hiddenTimerView() != null, "duplicate start cannot leak an active reference");
        shells.start(bubble);
        shells.rendererGone(bubble);
        shells.stop(bubble);
        check(shells.hiddenTimerView() == mainView, "dead last renderer still pauses a surviving hidden view");
        shells.start(main);
        shells.destroy(main);
        check(shells.hiddenTimerView() == null, "destroy clears started membership and live view");
        Object replacementView = new Object();
        shells.attach(main, replacementView);
        check(shells.hiddenTimerView() == replacementView, "renderer recreation has no leaked active membership");
        shells.start(main);
        check(shells.hiddenTimerView() == null, "restored shell resumes globally paused timers");

        Object network = new Object(), newNetwork = new Object();
        ShellLifecycle.NetworkArrivals<Object> arrivals = new ShellLifecycle.NetworkArrivals<>(List.of(network));
        check(!arrivals.available(network), "registration snapshot never loops retry over failed network");
        arrivals.lost(network);
        check(arrivals.available(network), "lost then available same network identity retries");
        check(!arrivals.available(network), "duplicate availability cannot loop retries");
        check(arrivals.available(newNetwork), "new network is a restoration");
        arrivals.lost(newNetwork);
        check(arrivals.available(newNetwork), "repeated restoration is observed");

        // The callback is absent while stopped. The restored network is already
        // in the next registration's snapshot, so only foreground reconciliation
        // can initiate the retry.
        ShellLifecycle<Object, Object> recovery = new ShellLifecycle<>();
        Object owner = new Object(), ownerView = new Object();
        recovery.attach(owner, ownerView);
        recovery.start(owner);
        check(!recovery.claimForegroundRetry(owner, ownerView, true),
                "initial fallback does not automatically retry its failed load");
        recovery.stop(owner);
        check(!recovery.claimForegroundRetry(owner, ownerView, true),
                "stopped activity cannot retry");
        ShellLifecycle.NetworkArrivals<Object> restored =
                new ShellLifecycle.NetworkArrivals<>(List.of(newNetwork));
        recovery.start(owner);
        int retries = 0;
        if (restored.available(newNetwork)) retries++;
        check(!recovery.claimForegroundRetry(owner, ownerView, false),
                "return waits until the owner's actual fallback commits");
        if (recovery.claimForegroundRetry(owner, ownerView, true)) retries++;
        check(retries == 1, "network change while stopped invokes exactly one foreground retry");
        check(!recovery.claimForegroundRetry(owner, ownerView, true),
                "duplicate fallback completion cannot repeat foreground retry");

        // A failed retry goes back to fallback and registers again with the
        // same network. Neither its initial callback nor another finish loops.
        ShellLifecycle.NetworkArrivals<Object> failedRetry =
                new ShellLifecycle.NetworkArrivals<>(List.of(newNetwork));
        if (failedRetry.available(newNetwork)) retries++;
        if (recovery.claimForegroundRetry(owner, ownerView, true)) retries++;
        check(retries == 1, "failed retry cannot loop via callback registration or page finish");
        failedRetry.lost(newNetwork);
        check(failedRetry.available(newNetwork),
                "same network lost and returned still permits a later retry");

        recovery.stop(owner);
        recovery.start(owner);
        recovery.recovered(owner);
        check(!recovery.claimForegroundRetry(owner, ownerView, true),
                "network retry or recovered document satisfies pending foreground recovery");
        recovery.stop(owner);
        recovery.start(owner);
        check(recovery.claimForegroundRetry(owner, ownerView, true),
                "a subsequent foreground return has one fresh retry opportunity");

        recovery.stop(owner);
        recovery.start(owner);
        Object newView = new Object();
        recovery.attach(owner, newView);
        check(!recovery.ownsStartedView(owner, ownerView),
                "callback from a replaced WebView cannot navigate");
        check(!recovery.claimForegroundRetry(owner, ownerView, true),
                "obsolete view cannot consume its replacement's retry");
        check(recovery.claimForegroundRetry(owner, newView, true),
                "only the current started owner can claim fallback recovery");
        recovery.stop(owner);
        recovery.start(owner);
        recovery.rendererGone(owner);
        check(!recovery.ownsStartedView(owner, newView)
                        && !recovery.claimForegroundRetry(owner, newView, true),
                "renderer loss invalidates pending navigation and foreground retry");
        Object replacement = new Object(), replacementPage = new Object();
        recovery.destroy(owner);
        recovery.attach(replacement, replacementPage);
        recovery.start(replacement);
        check(!recovery.ownsStartedView(owner, newView)
                        && !recovery.claimForegroundRetry(owner, newView, true),
                "destroyed activity cannot navigate its replacement's page");
        check(recovery.ownsStartedView(replacement, replacementPage),
                "replacement activity retains independent live ownership");
        System.out.println("PASS " + assertions + " shell visibility and fallback network assertions");
    }
}
