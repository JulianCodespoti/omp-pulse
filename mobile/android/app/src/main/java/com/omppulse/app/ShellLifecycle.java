package com.omppulse.app;

import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Set;

/** Main-thread shell membership; WebView timers are process-global, not Activity-local. */
final class ShellLifecycle<K, V> {
    private final Set<K> started = Collections.newSetFromMap(new IdentityHashMap<>());
    private final Map<K, V> views = new IdentityHashMap<>();
    private final Set<K> returning = Collections.newSetFromMap(new IdentityHashMap<>());

    void attach(K shell, V view) { views.put(shell, view); }
    void start(K shell) { started.add(shell); }
    void stop(K shell) {
        if (started.remove(shell)) returning.add(shell);
    }
    void rendererGone(K shell) { views.remove(shell); returning.remove(shell); }
    void destroy(K shell) { started.remove(shell); views.remove(shell); returning.remove(shell); }

    boolean ownsView(K shell, V view) {
        return view != null && views.get(shell) == view;
    }

    boolean ownsStartedView(K shell, V view) {
        return started.contains(shell) && ownsView(shell, view);
    }

    /** Consume only when the returning owner's actual fallback can be retried. */
    boolean claimForegroundRetry(K shell, V view, boolean onFallback) {
        return onFallback && ownsStartedView(shell, view) && returning.remove(shell);
    }

    /** A retry already in flight, or a recovered document, satisfies the return. */
    void recovered(K shell) { returning.remove(shell); }

    V hiddenTimerView() {
        return started.isEmpty() && !views.isEmpty() ? views.values().iterator().next() : null;
    }

    /** Callback-thread-only. Initial registrations are not connectivity restorations. */
    static final class NetworkArrivals<N> {
        private final Set<N> present = new HashSet<>();

        NetworkArrivals(Iterable<N> initial) {
            for (N network : initial) present.add(network);
        }

        boolean available(N network) { return present.add(network); }
        void lost(N network) { present.remove(network); }
    }
}
