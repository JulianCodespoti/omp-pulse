//! Versioned CPU-work signal for the phone wake lock: every OMP child
//! (including boots and one-shot scopes), native maintenance and active ASR.
//! `GET /api/busy` long-polls this signal.
//!
//! WHY: phone mode held a `PARTIAL_WAKE_LOCK` for the whole service lifetime,
//! so the phone never slept and every daemon, WebView and proot timer fired
//! around the clock while nobody could see the result. The Android shell now
//! holds the lock only while this signal says busy (plus a short grace).

use super::*;
use tokio::sync::{Notify, watch};

/// While busy, re-check at least this often even when no write site pokes:
/// `background_pending` and `PromptLifecycle::outstanding` expire with time,
/// and nothing else would notice. Idle never ticks (nothing expires into busy).
const BUSY_RECHECK: Duration = Duration::from_secs(30);

/// While busy, recompute at most once per this interval. Every child stdout
/// line pokes, and a streaming turn emits dozens a second; the lock only cares
/// about the busy→idle edge, which then waits a 60 s grace on the phone anyway.
const BUSY_COALESCE: Duration = Duration::from_secs(1);

/// What `/api/busy` and `/api/status.busyWork` report. `version` moves on
/// every flip of `busy`, so a client long-polls with the last version it saw
/// and can never miss a flip between two polls.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BusyState {
    pub busy: bool,
    pub version: u64,
}

/// Every live daemon child, including booting and one-shot RPC children.
/// Weak entries do not change physical ownership; each scan prunes finished
/// children even if a caller still holds an Arc. This lock is never taken
/// under a child gate or the route registry.
pub(super) fn any_busy(children: &Mutex<Vec<std::sync::Weak<Child>>>, now: u64) -> bool {
    let mut busy = false;
    lock_poisoned(children).retain(|weak| {
        let Some(child) = weak.upgrade() else {
            return false;
        };
        if !child.alive.load(Ordering::SeqCst) {
            return false;
        }
        busy = busy || child.unrouted_work.load(Ordering::SeqCst) || child_busy(&child, now);
        true
    });
    busy
}

/// Apply one observation. Returns whether the published state flipped.
fn publish(tx: &watch::Sender<BusyState>, busy: bool) -> bool {
    tx.send_if_modified(|state| {
        if state.busy == busy {
            return false;
        }
        state.busy = busy;
        state.version = state.version.wrapping_add(1);
        true
    })
}

/// One active non-OMP operation. Dropping the guard releases busy on success,
/// error, cancellation or panic; an idle resident ASR sidecar holds no guard.
pub struct BusyWork {
    active: Arc<AtomicUsize>,
    wake: Arc<Notify>,
}

impl BusyWork {
    fn new(active: Arc<AtomicUsize>, wake: Arc<Notify>) -> Self {
        active.fetch_add(1, Ordering::SeqCst);
        wake.notify_one();
        Self { active, wake }
    }
}

impl Drop for BusyWork {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
        self.wake.notify_one();
    }
}

/// Recompute on every poke (see [`Child::busy_may_have_changed`]); while
/// busy, also every [`BUSY_RECHECK`]. Ends once every receiver is gone.
pub(super) async fn busy_watcher(
    children: Arc<Mutex<Vec<std::sync::Weak<Child>>>>,
    extra_work: Arc<AtomicUsize>,
    wake: Arc<Notify>,
    tx: watch::Sender<BusyState>,
) {
    loop {
        if tx.is_closed() {
            return;
        }
        // Always scan the weak inventory so finished entries are pruned even
        // when an ASR operation is keeping the daemon busy.
        let busy = any_busy(&children, now_ms()) || extra_work.load(Ordering::SeqCst) > 0;
        publish(&tx, busy);
        if busy {
            // A poke during the coalescing sleep stores a permit, so the
            // next pass still sees it: no flip is lost, only delayed.
            tokio::select! {
                () = tx.closed() => return,
                () = tokio::time::sleep(BUSY_RECHECK) => {}
                () = wake.notified() => tokio::time::sleep(BUSY_COALESCE).await,
            }
        } else {
            tokio::select! {
                () = tx.closed() => return,
                () = wake.notified() => {}
            }
        }
    }
}

/// The `/api/busy` long-poll: answer at once when the published version
/// differs from `after` (or `after` is absent), else on the next flip, else
/// with the unchanged state once `wait` runs out.
pub async fn wait_busy_change(
    mut rx: watch::Receiver<BusyState>,
    after: Option<u64>,
    wait: Duration,
) -> BusyState {
    let current = *rx.borrow_and_update();
    let Some(after) = after else {
        return current;
    };
    if current.version != after {
        return current;
    }
    let flipped = tokio::time::timeout(wait, rx.wait_for(|s| s.version != after))
        .await
        .ok()
        .and_then(|changed| changed.ok().map(|state| *state));
    // Timed out, or the manager is gone: report what we last saw.
    flipped.unwrap_or_else(|| *rx.borrow())
}

/// Native manual /handoff starts its maintenance before acknowledging, but
/// emits no agent turn or generic command-completion event. get_state's
/// isCompacting is the authoritative read. One probe per child, only while
/// maintenance is known active; failures park with busy still uncertain.
const MAINTENANCE_PROBE_INTERVAL: Duration = Duration::from_secs(5);

pub(super) fn start_maintenance_probe(child: &Arc<Child>, gate: &mut ChildGate) {
    if gate.maintenance_probe_running
        || (!gate.maintenance_pending && !child.compacting.load(Ordering::SeqCst))
        || gate.maintenance_commands_pending()
        || !child.alive.load(Ordering::SeqCst)
        || gate.phase != ChildPhase::Active
    {
        return;
    }
    let mut epoch = child.binding_epoch.load(Ordering::SeqCst);
    let mut session = lock_poisoned(&child.session).clone();
    gate.maintenance_probe_running = true;
    let child = Arc::clone(child);
    tokio::spawn(async move {
        loop {
            let id = {
                let mut gate = lock_poisoned(&child.gate);
                if !child.alive.load(Ordering::SeqCst)
                    || gate.phase != ChildPhase::Active
                    || (!gate.maintenance_pending && !child.compacting.load(Ordering::SeqCst))
                    || gate.maintenance_commands_pending()
                {
                    gate.maintenance_probe_running = false;
                    return;
                }
                let current_epoch = child.binding_epoch.load(Ordering::SeqCst);
                if current_epoch != epoch {
                    // An idle child can be retargeted while this probe sleeps.
                    // Keep the single probe and transfer it to the new owner.
                    epoch = current_epoch;
                    session = lock_poisoned(&child.session).clone();
                }
                let Ok(token) = gate.token() else {
                    gate.maintenance_probe_running = false;
                    return;
                };
                format!("pulse-maintenance:{token}")
            };
            // Same admission, binding/epoch and abandoned-RPC fences as a
            // foreground request; never bypass a quarantined writer.
            let result = ChildManager::rpc_with_id(
                &child,
                &id,
                "get_state",
                Value::Null,
                REFRESH_STATE_TIMEOUT,
                RpcAccess::Bound(&session, epoch),
            )
            .await;
            {
                let mut gate = lock_poisoned(&child.gate);
                if child.binding_epoch.load(Ordering::SeqCst) != epoch {
                    // The old request cannot settle the new binding. Recheck
                    // its current work before issuing another probe.
                    continue;
                }
                // Missing state or transport failure is not completion.
                // A late correlated response or later foreground state read
                // can recover it; never spin RPCs at an uncertain process.
                if result
                    .as_ref()
                    .ok()
                    .and_then(|data| data.get("isCompacting"))
                    .and_then(Value::as_bool)
                    .is_none()
                    || !child.alive.load(Ordering::SeqCst)
                    || (!gate.maintenance_pending && !child.compacting.load(Ordering::SeqCst))
                {
                    gate.maintenance_probe_running = false;
                    return;
                }
            }
            tokio::time::sleep(MAINTENANCE_PROBE_INTERVAL).await;
        }
    });
}

impl Child {
    /// Poke the busy watcher after a write that can flip [`child_busy_locked`].
    /// Cheap and lock-free, so it is safe under the gate or any other lock.
    pub(super) fn busy_may_have_changed(&self) {
        self.busy_wake.notify_one();
    }
}

impl ChildManager {
    /// [`any_busy`] right now, for `/api/status.busyWork`.
    pub fn any_busy(&self) -> bool {
        any_busy(&self.work_children, now_ms()) || self.extra_work.load(Ordering::SeqCst) > 0
    }

    /// Keep CPU work outside an OMP child (ASR) awake until its scope ends.
    pub fn track_work(&self) -> BusyWork {
        BusyWork::new(Arc::clone(&self.extra_work), Arc::clone(&self.busy_wake))
    }

    /// A receiver on the published busy state, for `/api/busy`.
    pub fn busy_state(&self) -> watch::Receiver<BusyState> {
        self.busy_rx.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn background_and_btw_work_count_as_busy_without_a_turn() {
        let child = crate::omp::child::tests::stand_in_child();
        let children = Mutex::new(vec![Arc::downgrade(&child)]);
        let now = now_ms();
        assert!(!any_busy(&children, now));
        child.background_since.store(now, Ordering::SeqCst);
        assert!(!child.streaming.load(Ordering::SeqCst));
        assert!(
            any_busy(&children, now),
            "a background job keeps the phone awake"
        );
        child.background_since.store(0, Ordering::SeqCst);
        child.btw_since.store(now, Ordering::SeqCst);
        assert!(
            any_busy(&children, now),
            "a side question keeps the phone awake"
        );
        child.btw_since.store(0, Ordering::SeqCst);
        assert!(!any_busy(&children, now));
        // A dead child's leftovers never hold the lock.
        child.background_since.store(now, Ordering::SeqCst);
        child.alive.store(false, Ordering::SeqCst);
        assert!(!any_busy(&children, now));
    }

    #[test]
    fn version_moves_only_on_a_flip() {
        let (tx, rx) = watch::channel(BusyState::default());
        assert!(!publish(&tx, false));
        assert!(publish(&tx, true));
        assert!(!publish(&tx, true));
        assert_eq!(
            *rx.borrow(),
            BusyState {
                busy: true,
                version: 1
            }
        );
        assert!(publish(&tx, false));
        assert_eq!(
            *rx.borrow(),
            BusyState {
                busy: false,
                version: 2
            }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn long_poll_answers_a_stale_version_at_once() {
        let (tx, rx) = watch::channel(BusyState::default());
        publish(&tx, true);
        let started = tokio::time::Instant::now();
        let got = wait_busy_change(rx.clone(), Some(0), Duration::from_secs(300)).await;
        assert_eq!(
            got,
            BusyState {
                busy: true,
                version: 1
            }
        );
        assert_eq!(
            wait_busy_change(rx, None, Duration::from_secs(300)).await,
            got
        );
        assert_eq!(tokio::time::Instant::now(), started, "no wait at all");
    }

    #[tokio::test(start_paused = true)]
    async fn long_poll_times_out_unchanged_or_returns_the_flip() {
        let (tx, rx) = watch::channel(BusyState::default());
        let got = wait_busy_change(rx.clone(), Some(0), Duration::from_secs(5)).await;
        assert_eq!(got, BusyState::default(), "timeout keeps the version");

        let waiter = tokio::spawn(wait_busy_change(rx, Some(0), Duration::from_secs(300)));
        tokio::task::yield_now().await;
        publish(&tx, true);
        assert_eq!(
            waiter.await.expect("waiter"),
            BusyState {
                busy: true,
                version: 1
            }
        );
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn watcher_publishes_a_poked_flip_and_parks_when_idle() {
        let child = crate::omp::child::tests::stand_in_child();
        let children = Arc::new(Mutex::new(vec![Arc::downgrade(&child)]));
        let (tx, mut rx) = watch::channel(BusyState::default());
        tokio::spawn(busy_watcher(
            Arc::clone(&children),
            Arc::new(AtomicUsize::new(0)),
            Arc::clone(&child.busy_wake),
            tx,
        ));
        child.streaming.store(true, Ordering::SeqCst);
        child.busy_may_have_changed();
        rx.wait_for(|s| s.busy).await.expect("busy published");
        child.streaming.store(false, Ordering::SeqCst);
        child.busy_may_have_changed();
        let idle = *rx.wait_for(|s| !s.busy).await.expect("idle published");
        assert_eq!(idle.version, 2);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn boot_and_one_shot_work_are_busy_without_a_published_route() {
        let boot = crate::omp::child::tests::stand_in_child();
        boot.unrouted_work.store(true, Ordering::SeqCst);
        let children = Mutex::new(vec![Arc::downgrade(&boot)]);
        assert!(any_busy(&children, now_ms()), "boot is work before routing");
        // A prompt can start before boot publishes its route. Publication must
        // not hide that work when it clears the boot lifecycle flag.
        boot.streaming.store(true, Ordering::SeqCst);
        boot.unrouted_work.store(false, Ordering::SeqCst);
        assert!(any_busy(&children, now_ms()));
        boot.streaming.store(false, Ordering::SeqCst);
        assert!(!any_busy(&children, now_ms()));

        let one_shot = crate::omp::child::tests::stand_in_child();
        one_shot.unrouted_work.store(true, Ordering::SeqCst);
        lock_poisoned(&children).push(Arc::downgrade(&one_shot));
        assert!(any_busy(&children, now_ms()), "one-shot scopes never route");
        let (tx, _) = broadcast::channel(8);
        finish_child(
            &tx,
            &Arc::new(Mutex::new(HashMap::new())),
            &one_shot,
            "test scope finished",
            Exit::Planned,
        );
        assert!(!any_busy(&children, now_ms()));
        assert_eq!(
            lock_poisoned(&children).len(),
            1,
            "finished refs are pruned"
        );
        drop(boot);
        assert!(!any_busy(&children, now_ms()));
        assert!(
            lock_poisoned(&children).is_empty(),
            "expired refs are pruned"
        );
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn unrouted_scope_start_and_finish_wake_an_idle_watcher() {
        let child = crate::omp::child::tests::stand_in_child();
        let children = Arc::new(Mutex::new(Vec::new()));
        let (tx, mut rx) = watch::channel(BusyState::default());
        let watcher = tokio::spawn(busy_watcher(
            Arc::clone(&children),
            Arc::new(AtomicUsize::new(0)),
            Arc::clone(&child.busy_wake),
            tx,
        ));
        tokio::task::yield_now().await;
        child.unrouted_work.store(true, Ordering::SeqCst);
        lock_poisoned(&children).push(Arc::downgrade(&child));
        child.busy_may_have_changed();
        assert!(rx.wait_for(|s| s.busy).await.expect("boot published").busy);
        let (events, _) = broadcast::channel(8);
        finish_child(
            &events,
            &Arc::new(Mutex::new(HashMap::new())),
            &child,
            "test scope finished",
            Exit::Planned,
        );
        assert_eq!(
            rx.wait_for(|s| !s.busy)
                .await
                .expect("finish published")
                .version,
            2
        );
        assert!(lock_poisoned(&children).is_empty());
        watcher.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn external_work_tracks_overlap_and_releases_on_cancellation() {
        let active = Arc::new(AtomicUsize::new(0));
        let wake = Arc::new(Notify::new());
        let (tx, mut rx) = watch::channel(BusyState::default());
        let watcher = tokio::spawn(busy_watcher(
            Arc::new(Mutex::new(Vec::new())),
            Arc::clone(&active),
            Arc::clone(&wake),
            tx,
        ));
        tokio::task::yield_now().await;
        let first = BusyWork::new(Arc::clone(&active), Arc::clone(&wake));
        let queued = BusyWork::new(Arc::clone(&active), Arc::clone(&wake));
        rx.wait_for(|s| s.busy).await.expect("ASR work published");
        drop(first);
        assert_eq!(active.load(Ordering::SeqCst), 1, "overlapping work remains");
        let operation = tokio::spawn(async move {
            let _work = queued;
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        operation.abort();
        let _ = operation.await;
        let idle = *rx
            .wait_for(|s| !s.busy)
            .await
            .expect("cancellation published");
        assert_eq!(idle.version, 2);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        watcher.abort();
    }
}
