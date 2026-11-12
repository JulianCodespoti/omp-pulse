package com.omppulse.app;

import java.util.IdentityHashMap;
import java.util.Map;

/** Main-thread-only subscriptions, separately owned by each installed WebView generation. */
final class OutboxPageRegistry<K, P> {
    interface Delivery<P> { void deliver(P page); }
    static final class Owner<P> {
        private P page;
    }

    private final Map<K, Owner<P>> owners = new IdentityHashMap<>();

    Owner<P> install(K key) {
        Owner<P> owner = new Owner<>();
        owners.put(key, owner);
        return owner;
    }

    boolean attach(K key, Owner<P> owner, P page) {
        if (owners.get(key) != owner) return false;
        boolean first = owner.page == null;
        owner.page = page;
        return first;
    }

    void navigate(K key) {
        Owner<P> owner = owners.get(key);
        if (owner != null) owner.page = null;
    }

    void remove(K key) {
        owners.remove(key);
    }

    boolean hasPages() {
        for (Owner<P> owner : owners.values()) if (owner.page != null) return true;
        return false;
    }

    void broadcast(Delivery<P> deliver) {
        for (Owner<P> owner : owners.values()) {
            if (owner.page == null) continue;
            try {
                deliver.deliver(owner.page);
            } catch (RuntimeException gone) {
                owner.page = null;
            }
        }
    }
}
