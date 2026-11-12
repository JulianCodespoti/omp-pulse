//! Pool admission: reserving a slot under the cap, retiring the least recently
//! used child for room, and trimming the pool back to the cap.

use super::*;
use crate::metrics;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tracing::info;

/// Free physical admission slots, including boot reservations and all
/// retained charges. Logical route counts must never be added again.
pub(super) fn slots_free(occupied: usize, cap: usize) -> usize {
    cap.saturating_sub(occupied)
}

pub(super) fn try_reserve_slot(occupied: &AtomicUsize, cap: usize) -> bool {
    let mut current = occupied.load(Ordering::SeqCst);
    loop {
        if slots_free(current, cap) == 0 {
            return false;
        }
        match occupied.compare_exchange_weak(
            current,
            current + 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => return true,
            Err(observed) => current = observed,
        }
    }
}

impl ChildManager {
    /// Reserve one physical slot. A full request may submit one eligible
    /// retirement; it never loops through unrelated victims while wait is
    /// pending. Existing registered retirement blocks another capacity stop.
    pub(super) async fn try_reserve(&self) -> Option<Reservation> {
        let cap = self.config.max_children;
        let victim = {
            let _admission = lock_poisoned(&self.admission);
            if try_reserve_slot(&self.occupied, cap) {
                return Some(Reservation::new(Arc::clone(&self.occupied)));
            }
            if self.physical.pending_retirement() {
                None
            } else {
                self.retire_lru_candidate(true)
            }
        };
        // Stop acceptance was marked under the owner lock before releasing
        // admission. Other admissions see it while logical effects run.
        if let Some((path, child)) = victim {
            self.finish_eviction(&path, &child);
        }
        let reserved = {
            let _admission = lock_poisoned(&self.admission);
            try_reserve_slot(&self.occupied, cap)
        };
        if reserved {
            metrics::inc("child_cap_blocked");
            Some(Reservation::new(Arc::clone(&self.occupied)))
        } else {
            metrics::inc("child_cap_refused");
            None
        }
    }

    /// Evict the least-recently-active IDLE child. A busy child (a live turn,
    /// a dialog awaiting an answer, an RPC in flight) is never a victim:
    /// evicting one aborted the user's running turn whenever another chat
    /// needed a slot (11 times in an hour on the phone, 2026-10-14). Returns
    /// whether a victim was found; absence makes the caller refuse instead.
    /// Minimum time a child is protected from eviction. Long enough that a
    /// concurrent burst cannot cannibalise fresh boots, short enough that the
    /// pool converges quickly after one.
    const MIN_CHILD_LIFETIME_MS: u64 = 5_000;

    /// Caller holds admission through selection and accepted stop marking.
    fn retire_lru_candidate(&self, respect_lifetime: bool) -> Option<(String, Arc<Child>)> {
        // Selection is a hint; the final Arc/epoch/busy/lifetime checks remain
        // under the registry and gate through synchronous stop submission.
        let victim: Option<(String, Arc<Child>)> = {
            let map = lock_poisoned(&self.children);
            let now = now_ms();
            let pick = || -> Option<(String, Arc<Child>)> {
                let mut oldest: Option<(String, Arc<Child>)> = None;
                for (path, c) in map.iter() {
                    if child_busy(c, now) {
                        continue;
                    }
                    if respect_lifetime {
                        let age = now.saturating_sub(c.spawned_at.load(Ordering::SeqCst));
                        if age < Self::MIN_CHILD_LIFETIME_MS {
                            continue; // someone's fresh boot — not ours to cannibalise
                        }
                    }
                    let better = match &oldest {
                        None => true,
                        Some((_, oc)) => {
                            c.last_active.load(Ordering::SeqCst)
                                < oc.last_active.load(Ordering::SeqCst)
                        }
                    };
                    if better {
                        oldest = Some((path.clone(), Arc::clone(c)));
                    }
                }
                oldest
            };
            pick()
        };
        let (path, child) = victim?;
        let epoch = child.binding_epoch.load(Ordering::SeqCst);
        let policy = RetirementPolicy::Capacity {
            min_lifetime_ms: if respect_lifetime {
                Self::MIN_CHILD_LIFETIME_MS
            } else {
                0
            },
        };
        try_retire_child(&self.children, &path, &child, epoch, policy)?;
        Some((path, child))
    }

    fn finish_eviction(&self, path: &str, child: &Arc<Child>) {
        info!("LRU eviction: terminating oldest child ({path})");
        metrics::inc("child_evict");
        finish_child(
            &self.tx,
            &self.children,
            child,
            "terminated (LRU eviction)",
            Exit::Planned,
        );
    }

    /// Defensive trim keeps the existing alive-route target. Booting,
    /// ephemeral and already-finished owners do not become extra victims.
    pub(super) async fn trim_to_cap(&self) {
        self.trim_to_cap_inner(true).await
    }

    /// Hard trim used by the maintenance ticker: ignores the lifetime floor so a
    /// transient overshoot always converges, even if every child is young.
    pub(super) async fn trim_to_cap_forced(&self) {
        self.trim_to_cap_inner(false).await
    }

    /// A submitted stop already satisfies one unit of defensive trim, even
    /// while its logical finish effects run outside admission. Concurrent
    /// trimmers must not select an extra victim from that same overshoot.
    fn live_after_retirements(&self) -> usize {
        lock_poisoned(&self.children)
            .values()
            .filter(|child| {
                let gate = lock_poisoned(&child.gate);
                child.alive.load(Ordering::SeqCst)
                    && !matches!(gate.phase, ChildPhase::Terminating | ChildPhase::Finished)
            })
            .count()
    }

    async fn trim_to_cap_inner(&self, respect_lifetime: bool) {
        loop {
            let victim = {
                let _admission = lock_poisoned(&self.admission);
                if self.live_after_retirements() <= self.config.max_children {
                    return;
                }
                self.retire_lru_candidate(respect_lifetime)
            };
            let Some((path, child)) = victim else {
                return;
            };
            self.finish_eviction(&path, &child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_free_counts_all_retained_charges_against_the_cap() {
        assert_eq!(slots_free(0, 3), 3);
        assert_eq!(slots_free(2, 3), 1);
        assert_eq!(slots_free(3, 3), 0);
        assert_eq!(slots_free(12, 3), 0);
        assert_eq!(slots_free(0, 0), 0);
    }

    #[test]
    fn concurrent_distinct_path_reservations_never_oversubscribe_cap() {
        const REQUESTS: usize = 32;
        const CAP: usize = 5;
        let in_flight = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(std::sync::Barrier::new(REQUESTS));

        // Distinct paths bypass same-path coalescing and race the shared slot
        // claim directly; holding every successful reservation makes the
        // number admitted observable without spawning an omp child.
        let requests = (0..REQUESTS)
            .map(|_| {
                let in_flight = Arc::clone(&in_flight);
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    try_reserve_slot(&in_flight, CAP)
                })
            })
            .collect::<Vec<_>>();
        let admitted = requests
            .into_iter()
            .map(|request| request.join().unwrap())
            .filter(|admitted| *admitted)
            .count();

        assert_eq!(admitted, CAP);
        assert_eq!(in_flight.load(Ordering::SeqCst), CAP);
    }

    #[test]
    fn ephemeral_admission_stays_charged_until_observed_reap() {
        use ephemeral::Lifecycle as _;

        let slots = Arc::new(AtomicUsize::new(0));
        assert!(try_reserve_slot(&slots, 1));
        let owner =
            ephemeral::Owner::new(Reservation::new(Arc::clone(&slots)).retain(), |_: &str| {});
        owner.request_stop("caller canceled");
        assert!(!try_reserve_slot(&slots, 1));
        owner.observed_reap();
        assert!(try_reserve_slot(&slots, 1));
        let next = Reservation::new(Arc::clone(&slots));
        owner.observed_reap();
        assert_eq!(slots.load(Ordering::SeqCst), 1);
        drop(next);
        assert_eq!(slots.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn reservation_guard_releases_exactly_once() {
        let slots = Arc::new(AtomicUsize::new(0));
        {
            let _r = Reservation::new(Arc::clone(&slots));
            slots.fetch_add(1, Ordering::SeqCst); // the reserve() itself
            assert_eq!(slots.load(Ordering::SeqCst), 1);
        } // drop -> released
        assert_eq!(slots.load(Ordering::SeqCst), 0);
        // Nested guards each release their own reservation independently.
        {
            let _a = Reservation::new(Arc::clone(&slots));
            slots.fetch_add(1, Ordering::SeqCst);
            let _b = Reservation::new(Arc::clone(&slots));
            slots.fetch_add(1, Ordering::SeqCst);
            assert_eq!(slots.load(Ordering::SeqCst), 2);
        }
        assert_eq!(slots.load(Ordering::SeqCst), 0);
    }
}
