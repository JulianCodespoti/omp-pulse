//! Maintenance: the ticker that reaps idle, unwatched or oversized children and
//! recycles them under memory pressure, and the policy that decides which.

use super::*;
use crate::metrics;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::info;

/// 10 s maintenance loop: cap trim + idle/unwatched/pressure reap + RSS
/// recycle. Started once from `ChildManager::new`; self-contained so main.rs
/// needs no change. Skips missed ticks — a long graceful_terminate (abort
/// wait) must not pile up a backlog of passes. 10 s rather than 30 s: the
/// pass is one `/proc/<pid>/status` read per child (≤ cap), and at 30 s the
/// 60 s unwatched TTL really meant up to 90 s of a ~380 MB child nobody sees.
///
/// With no children it parks on `child_added` instead of ticking. It used to
/// run every 10 s forever (cap trim, `malloc_trim`, `/proc/meminfo`) even
/// with nothing to reap, one of the timers that fired around the clock on a
/// phone that never slept.
pub(super) async fn maintenance_ticker(mgr: Arc<ChildManager>) {
    maintenance_loop(
        &mgr.child_added,
        || lock_poisoned(&mgr.children).is_empty(),
        || mgr.shutting_down.load(Ordering::SeqCst),
        || mgr.reap_and_recycle(),
    )
    .await
}

/// The ticker's schedule, apart from what a pass does, so the parking is
/// testable without an omp child.
async fn maintenance_loop<Pass, Fut>(
    child_added: &tokio::sync::Notify,
    is_empty: impl Fn() -> bool,
    shutting_down: impl Fn() -> bool,
    mut pass: Pass,
) where
    Pass: FnMut() -> Fut,
    Fut: Future<Output = ()>,
{
    let mut tick = tokio::time::interval(MAINTENANCE_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Starts empty: nothing was allocated for children yet, so no trim.
    let mut was_empty = true;
    loop {
        tick.tick().await;
        if shutting_down() {
            return;
        }
        if is_empty() {
            // `trim_to_cap_forced` is a no-op on an empty map (zero live
            // children never exceed the cap), and there is nothing to reap.
            // Give the last child's heap back once on the way down; on the
            // musl phone build `release_heap` is a no-op anyway.
            if !was_empty {
                release_heap();
                was_empty = true;
            }
            // `notify_one` stores a permit, so an insert between the check
            // above and this await is not lost. A stale permit from an
            // earlier insert costs one extra empty pass, then a real park.
            child_added.notified().await;
            tick.reset();
            continue;
        }
        was_empty = false;
        pass().await;
    }
}

pub(super) enum RetirementPolicy<'a> {
    Maintenance {
        rules: ReapRules,
        /// Snapshot taken outside the gate; `busy` and `watched` are
        /// recomputed under it.
        view: ReapView,
        /// Chosen by [`pressure_victims`] for this pass.
        pressure: bool,
        /// The visibility predicate, asked again under the gate: a phone
        /// that foregrounds the chat between the snapshot and this child's
        /// turn in the retire loop must not lose it to a pressure or
        /// unwatched reap. `None` (no hub wired) counts as watched.
        viewers: Option<&'a crate::sessions::watcher::Audience>,
    },
    Capacity {
        min_lifetime_ms: u64,
    },
}

/// The registry and child gate remain locked through the synchronous request
/// submission. This promises ordering at submission, not physical signal delivery.
pub(super) fn try_retire_child(
    children: &Mutex<HashMap<String, Arc<Child>>>,
    path: &str,
    child: &Arc<Child>,
    epoch: u64,
    policy: RetirementPolicy<'_>,
) -> Option<Reap> {
    let map = lock_poisoned(children);
    if !map
        .get(path)
        .is_some_and(|current| Arc::ptr_eq(current, child))
    {
        return None;
    }
    let mut gate = lock_poisoned(&child.gate);
    if !child.alive.load(Ordering::SeqCst)
        || child.binding_epoch.load(Ordering::SeqCst) != epoch
        || lock_poisoned(&child.session).as_str() != path
    {
        return None;
    }
    let now = now_ms();
    let busy = child_busy_locked(child, &gate, now);
    let (idle, unwatched) = idle_clocks(
        now,
        child.last_active.load(Ordering::SeqCst),
        child.last_viewed.load(Ordering::SeqCst),
    );
    let reason = match policy {
        RetirementPolicy::Capacity { min_lifetime_ms } => (!busy
            && now.saturating_sub(child.spawned_at.load(Ordering::SeqCst)) >= min_lifetime_ms)
            .then_some(Reap::Capacity),
        RetirementPolicy::Maintenance {
            rules,
            view,
            pressure,
            viewers,
        } => {
            // The hub's visibility lock is a leaf (it never reaches back into
            // the registry or a child gate), so asking under the gate is safe.
            let watched = viewers.is_none_or(|watching| watching(path));
            if watched {
                child.last_viewed.store(now, Ordering::SeqCst);
            }
            let view = ReapView {
                busy,
                watched,
                ..view
            };
            maintenance_decision(rules, view, idle, unwatched, pressure)
        }
    }?;
    gate.phase = ChildPhase::Terminating;
    gate.intended_exit = Some(Exit::Planned);
    if !term_proc(child) {
        // Neither signal route accepted a request. Restore admission while
        // still gated; never report a retirement or suppress later cleanup.
        gate.phase = ChildPhase::Active;
        gate.intended_exit = None;
        return None;
    }
    child.busy_may_have_changed();
    Some(reason)
}

/// Why the maintenance pass stops a child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Reap {
    /// No activity for `child_idle_secs`, viewer or not.
    Idle,
    /// No activity and no viewer for `child_unwatched_secs`.
    Unwatched,
    /// Idle, unwatched, and the host is below [`PRESSURE_AVAILABLE_MB`].
    Pressure,
    /// Above the configured resident-plus-swap recycling threshold.
    Rss,
    /// An idle slot reclaimed for admission or cap trimming.
    Capacity,
}

/// Maintenance cadence. See [`maintenance_ticker`].
const MAINTENANCE_TICK: Duration = Duration::from_secs(10);

/// Below this much `MemAvailable` the maintenance pass reaps idle unwatched
/// children without waiting for their TTL. On the phone a child is ~380 MB
/// (three processes) and the Android low-memory killer takes the WHOLE app
/// (daemon, WebView, every other child) once the device runs short; with
/// swap already full (observed 4042/4095 MB) there is no cushion left.
const PRESSURE_AVAILABLE_MB: u64 = 800;

/// The configured maintenance TTLs and recycle threshold for one pass.
#[derive(Debug, Clone, Copy)]
pub(super) struct ReapRules {
    idle_secs: u64,
    unwatched_secs: u64,
    rss_limit_mb: u64,
}

/// One registered child as the maintenance pass sees it.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct ReapView {
    /// [`child_busy_locked`]: turn, background work, btw, dialog, RPC, prompt.
    busy: bool,
    /// A visible `/ws` client has the session open.
    watched: bool,
    /// Later of the last activity and the last pass that saw a viewer.
    last_seen_ms: u64,
    rss_mb: u64,
    swap_mb: u64,
}

/// A registered child queued for this maintenance pass.
struct ReapCandidate {
    path: String,
    child: Arc<Child>,
    epoch: u64,
    view: ReapView,
}

/// Full maintenance decision for one child. INVARIANT: a busy child is never
/// reaped for any reason — that abandons a turn, background work, a side
/// question, an open dialog or an in-flight RPC. Order: idle TTL, unwatched
/// TTL, memory pressure (unwatched only), then the RSS recycle.
fn maintenance_decision(
    rules: ReapRules,
    view: ReapView,
    idle_ms: u64,
    unwatched_ms: u64,
    pressure: bool,
) -> Option<Reap> {
    if view.busy {
        return None;
    }
    let unwatched_ms = if view.watched { 0 } else { unwatched_ms };
    reap_decision(
        rules.idle_secs,
        rules.unwatched_secs,
        idle_ms,
        unwatched_ms,
        false,
    )
    .or_else(|| (pressure && !view.watched).then_some(Reap::Pressure))
    .or_else(|| {
        should_recycle(view.rss_mb + view.swap_mb, false, rules.rss_limit_mb).then_some(Reap::Rss)
    })
}

/// Which children (indices into `views`, ordered oldest-seen first) to reap
/// because `MemAvailable` is below `floor_mb`: idle, unwatched ones in order
/// until their resident size covers the shortfall. Watched children are left
/// alone — the person looking at one would pay the 1.3–2.7 s respawn on their
/// next send, and a backgrounded page already counts as unwatched. `None`
/// (no `/proc/meminfo`, e.g. Windows) never reaps.
fn pressure_victims(available_mb: Option<u64>, floor_mb: u64, views: &[ReapView]) -> Vec<usize> {
    let Some(available) = available_mb else {
        return Vec::new();
    };
    let mut shortfall = floor_mb.saturating_sub(available);
    let mut victims = Vec::new();
    for (i, view) in views.iter().enumerate() {
        if shortfall == 0 {
            break;
        }
        if view.busy || view.watched {
            continue;
        }
        victims.push(i);
        shortfall = shortfall.saturating_sub(view.rss_mb);
    }
    victims
}

/// Host `MemAvailable` in MiB, or None where `/proc/meminfo` is missing.
fn mem_available_mb() -> Option<u64> {
    parse_mem_available_mb(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

fn parse_mem_available_mb(meminfo: &str) -> Option<u64> {
    let line = meminfo
        .lines()
        .find_map(|l| l.strip_prefix("MemAvailable:"))?;
    Some(line.split_whitespace().next()?.parse::<u64>().ok()? / 1024)
}

/// `(idle_ms, unwatched_ms)` at `now`: time since the last activity, and time
/// since the later of the last activity and the last pass that saw a viewer.
fn idle_clocks(now: u64, last_active: u64, last_viewed: u64) -> (u64, u64) {
    (
        now.saturating_sub(last_active),
        now.saturating_sub(last_active.max(last_viewed)),
    )
}

/// Reap decision. A busy child (mid-turn, awaiting a phone answer, RPC in
/// flight) is never reaped — that abandons in-flight work. Otherwise the idle
/// TTL wins, then the shorter unwatched TTL; 0 disables either.
fn reap_decision(
    idle_secs: u64,
    unwatched_secs: u64,
    idle_ms: u64,
    unwatched_ms: u64,
    busy: bool,
) -> Option<Reap> {
    if busy {
        return None;
    }
    if idle_secs > 0 && idle_ms >= idle_secs.saturating_mul(1000) {
        return Some(Reap::Idle);
    }
    if unwatched_secs > 0 && unwatched_ms >= unwatched_secs.saturating_mul(1000) {
        return Some(Reap::Unwatched);
    }
    None
}

/// Recycle decision: resident + swapped MiB at/above the limit (0 disables)
/// and not busy. `>=` rather than `>` because the figures are truncated to
/// whole MiB, so a child at 700.9 MiB reports exactly 700 and must still be
/// retired. `switch_session` accumulates (measured 291 -> 582 MiB over five
/// switches), so a long-lived child needs this generational bound.
fn should_recycle(footprint_mb: u64, busy: bool, limit_mb: u64) -> bool {
    limit_mb > 0 && footprint_mb >= limit_mb && !busy
}

/// (VmRSS, VmSwap) of a pid in MiB. None when the pid is gone or /proc is
/// unreadable — e.g. the child died between the alive check and this read.
pub(super) fn mem_mb(pid: i32) -> Option<(u64, u64)> {
    if pid <= 0 {
        return None;
    }
    parse_mem_mb(&std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?)
}

/// (VmRSS, VmSwap) in MiB from `/proc/<pid>/status` text, whose values are
/// in kB. VmRSS is required; a kernel without swap omits VmSwap (0).
fn parse_mem_mb(status: &str) -> Option<(u64, u64)> {
    let kb = |key: &str| -> Option<u64> {
        let line = status.lines().find_map(|l| l.strip_prefix(key))?;
        line.split_whitespace().next()?.parse().ok()
    };
    Some((kb("VmRSS:")? / 1024, kb("VmSwap:").unwrap_or(0) / 1024))
}

/// Return freed heap to the OS.
///
/// glibc keeps large freed arenas mapped, so a burst of tail-parsing leaves RSS
/// high long after the memory is unused: measured 334 MiB retained and still
/// 334 MiB thirty seconds later, with nothing queued and no children alive.
/// Nothing is leaking, but an operator watching RSS cannot tell the difference,
/// and a long-lived daemon on a laptop should give the pages back. Called from
/// the maintenance ticker, where it costs nothing anyone waits on.
fn release_heap() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim takes no pointers and only returns free arenas to the
    // kernel; it is safe to call from any thread at any time.
    unsafe {
        libc::malloc_trim(0);
    }
}

impl ChildManager {
    /// One maintenance pass (10 s cadence): trim to the cap, reap children
    /// idle past `child_idle_secs` (or past `child_unwatched_secs` with no
    /// visible viewer), reap idle unwatched children early when the host runs
    /// low on memory, and recycle idle children whose resident + swapped
    /// memory reaches `child_rss_mb`. `switch_session` accumulates — measured
    /// 291 -> 582 MiB over five switches — so a long-lived child needs a
    /// generational bound; children used to live until LRU eviction or
    /// shutdown, pinning ~281 MiB per idle conversation (F8).
    async fn reap_and_recycle(&self) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        // The ticker is the hard enforcement point: by the time it runs, a
        // burst has long settled, so the lifetime floor no longer protects
        // anyone worth protecting.
        self.trim_to_cap_forced().await;
        release_heap();
        let idle_secs = self.config.child_idle_secs;
        let unwatched_secs = self.config.child_unwatched_secs;
        let rss_limit_mb = self.config.child_rss_mb;
        if idle_secs == 0 && unwatched_secs == 0 && rss_limit_mb == 0 {
            return;
        }
        let viewers = self.viewers.get();
        let now = now_ms();
        // Snapshot outside every gate; `try_retire_child` re-checks busy,
        // visibility, epoch and binding under the gate before anything is
        // signalled.
        let mut candidates: Vec<ReapCandidate> = {
            let map = lock_poisoned(&self.children);
            map.iter()
                .filter(|(_, c)| c.alive.load(Ordering::SeqCst))
                .map(|(p, c)| ReapCandidate {
                    path: p.clone(),
                    child: Arc::clone(c),
                    epoch: c.binding_epoch.load(Ordering::SeqCst),
                    view: ReapView::default(),
                })
                .collect()
        };
        for cand in &mut candidates {
            // Potentially slow sampling is outside the gate.
            let (rss, swap) = mem_mb(cand.child.pid).unwrap_or((0, 0));
            cand.view = ReapView {
                busy: child_busy(&cand.child, now),
                watched: viewers.is_none_or(|watching| watching(cand.path.as_str())),
                last_seen_ms: cand
                    .child
                    .last_active
                    .load(Ordering::SeqCst)
                    .max(cand.child.last_viewed.load(Ordering::SeqCst)),
                rss_mb: rss,
                swap_mb: swap,
            };
        }
        // Oldest-seen first, so a pressure pass that stops early has spent
        // its kills on the conversations least likely to be resumed.
        candidates.sort_by_key(|c| c.view.last_seen_ms);
        let views: Vec<ReapView> = candidates.iter().map(|c| c.view).collect();
        let pressure = pressure_victims(mem_available_mb(), PRESSURE_AVAILABLE_MB, &views);
        for (i, cand) in candidates.into_iter().enumerate() {
            if self.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let ReapCandidate {
                path,
                child,
                epoch,
                view,
            } = cand;
            let policy = RetirementPolicy::Maintenance {
                rules: ReapRules {
                    idle_secs,
                    unwatched_secs,
                    rss_limit_mb,
                },
                view,
                pressure: pressure.contains(&i),
                viewers,
            };
            let Some(reason) = try_retire_child(&self.children, &path, &child, epoch, policy)
            else {
                continue;
            };
            let (counter, why) = match reason {
                Reap::Idle => ("child_reaped_idle", "idle reap"),
                Reap::Unwatched => ("child_reaped_unwatched", "unwatched reap"),
                Reap::Pressure => ("child_reaped_pressure", "memory pressure reap"),
                Reap::Rss => ("child_recycled_rss", "rss recycle"),
                Reap::Capacity => unreachable!("maintenance policy is not capacity eviction"),
            };
            metrics::inc(counter);
            info!(
                "reaping child ({why}, rss {}MiB + swap {}MiB): {path}",
                view.rss_mb, view.swap_mb
            );
            // No graceful abort on maintenance: it would act on work admitted
            // after a stale snapshot. The request was submitted under the gate.
            finish_child(
                &self.tx,
                &self.children,
                &child,
                &format!("terminated ({why})"),
                Exit::Planned,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::omp::child::tests::stand_in_child;

    #[test]
    fn fixes4_resident_plus_swap_recycle_boundary() {
        let (rss, swap) = parse_mem_mb("VmRSS: 512000 kB\nVmSwap: 204800 kB\n").unwrap();
        assert_eq!((rss, swap), (500, 200));
        assert!(!should_recycle(rss, false, 700));
        assert!(should_recycle(rss + swap, false, 700));
        assert!(!should_recycle(rss + swap, true, 700));
    }

    #[test]
    fn reap_idle_past_ttl_only_when_quiescent() {
        let ttl = 900u64;
        // Unwatched reaping off: the idle TTL alone decides.
        assert_eq!(reap_decision(ttl, 0, 900_000, 0, false), Some(Reap::Idle)); // boundary
        assert_eq!(reap_decision(ttl, 0, 9_999_999, 0, false), Some(Reap::Idle));
        assert_eq!(reap_decision(ttl, 0, 899_999, 0, false), None);
        assert_eq!(reap_decision(ttl, 0, 0, 0, false), None);
        // Never reap a busy child (live turn, pending dialog, RPC in flight).
        assert_eq!(reap_decision(ttl, 0, 9_999_999, 9_999_999, true), None);
        assert_eq!(reap_decision(ttl, 300, 9_999_999, 9_999_999, true), None);
        // 0 disables both.
        assert_eq!(reap_decision(0, 0, 9_999_999, 9_999_999, false), None);
    }

    #[test]
    fn reap_unwatched_sooner_than_idle() {
        // Nobody watching for 5 min and nothing running: reap long before the
        // 15 min idle TTL.
        assert_eq!(
            reap_decision(900, 300, 300_000, 300_000, false),
            Some(Reap::Unwatched)
        );
        assert_eq!(reap_decision(900, 300, 300_000, 299_999, false), None);
        // Idle past both TTLs reports the idle reason.
        assert_eq!(
            reap_decision(900, 300, 900_000, 900_000, false),
            Some(Reap::Idle)
        );
        // Idle TTL off: the unwatched TTL alone still reaps.
        assert_eq!(
            reap_decision(0, 300, 9_999_999, 300_000, false),
            Some(Reap::Unwatched)
        );
    }

    fn view(busy: bool, watched: bool, last_seen_ms: u64, rss_mb: u64) -> ReapView {
        ReapView {
            busy,
            watched,
            last_seen_ms,
            rss_mb,
            swap_mb: 0,
        }
    }

    const RULES: ReapRules = ReapRules {
        idle_secs: 900,
        unwatched_secs: 60,
        rss_limit_mb: 700,
    };

    #[test]
    fn a_busy_child_is_never_reaped_for_any_reason() {
        // Past every TTL, over the RSS limit, unwatched and picked by a
        // pressure pass: a live turn / background work / btw / dialog / RPC
        // still wins.
        let busy = ReapView {
            swap_mb: 900,
            ..view(true, false, 0, 900)
        };
        assert_eq!(
            maintenance_decision(RULES, busy, u64::MAX, u64::MAX, true),
            None
        );
        assert!(pressure_victims(Some(0), 800, &[busy]).is_empty());
    }

    #[test]
    fn a_watched_child_ignores_the_unwatched_ttl_and_pressure() {
        let watched = view(false, true, 0, 300);
        assert_eq!(
            maintenance_decision(RULES, watched, 61_000, 61_000, true),
            None
        );
        // The idle TTL still applies to a watched child.
        assert_eq!(
            maintenance_decision(RULES, watched, 900_000, 900_000, false),
            Some(Reap::Idle)
        );
    }

    #[test]
    fn an_unwatched_child_goes_after_a_minute_or_at_once_under_pressure() {
        let idle = view(false, false, 0, 300);
        assert_eq!(
            maintenance_decision(RULES, idle, 60_000, 60_000, false),
            Some(Reap::Unwatched)
        );
        assert_eq!(maintenance_decision(RULES, idle, 5_000, 5_000, false), None);
        assert_eq!(
            maintenance_decision(RULES, idle, 5_000, 5_000, true),
            Some(Reap::Pressure)
        );
        // Above the recycle threshold the RSS recycle still fires.
        assert_eq!(
            maintenance_decision(RULES, view(false, true, 0, 700), 0, 0, false),
            Some(Reap::Rss)
        );
    }

    #[test]
    fn pressure_reaps_unwatched_idle_children_oldest_first_until_covered() {
        // Already sorted oldest-seen first, as the pass sorts them.
        let views = [
            view(false, false, 1, 300), // oldest, idle, unwatched
            view(true, false, 2, 300),  // busy: skipped
            view(false, true, 3, 300),  // watched: skipped
            view(false, false, 4, 300), // idle, unwatched
            view(false, false, 5, 300), // idle, unwatched
        ];
        // No pressure: nothing.
        assert!(pressure_victims(Some(800), 800, &views).is_empty());
        assert!(pressure_victims(Some(4000), 800, &views).is_empty());
        // 200 MiB short: the oldest eligible child covers it.
        assert_eq!(pressure_victims(Some(600), 800, &views), vec![0]);
        // 500 MiB short: two eligible children, still oldest first.
        assert_eq!(pressure_victims(Some(300), 800, &views), vec![0, 3]);
        // Never more than the eligible set, however deep the shortfall.
        assert_eq!(pressure_victims(Some(0), 5000, &views), vec![0, 3, 4]);
        // Unknown MemAvailable (no /proc/meminfo) never reaps.
        assert!(pressure_victims(None, 800, &views).is_empty());
    }

    #[test]
    fn mem_available_parses_meminfo_kib() {
        let meminfo = "MemTotal:       11534336 kB\nMemFree:          123456 kB\nMemAvailable:    3481600 kB\n";
        assert_eq!(parse_mem_available_mb(meminfo), Some(3400));
        assert_eq!(parse_mem_available_mb("MemTotal: 1 kB\n"), None);
    }

    #[test]
    fn unwatched_clock_runs_from_later_of_activity_and_last_view() {
        let now = 10_000_000u64;
        // Viewer present a minute ago, activity 10 min ago.
        assert_eq!(
            idle_clocks(now, now - 600_000, now - 60_000),
            (600_000, 60_000)
        );
        // Activity after the viewer left resets the unwatched clock too.
        assert_eq!(
            idle_clocks(now, now - 30_000, now - 600_000),
            (30_000, 30_000)
        );
        // Clock skew (stamps in the future) saturates to zero, never wraps.
        assert_eq!(idle_clocks(now, now + 5, now + 5), (0, 0));
        // A watched child idle past only the unwatched TTL is kept.
        let (idle, unwatched) = idle_clocks(now, now - 600_000, now);
        assert_eq!(reap_decision(900, 300, idle, unwatched, false), None);
    }

    /// The pressure pass picks victims from a snapshot; a chat the phone
    /// foregrounds before its turn in the retire loop is re-read as watched
    /// under the gate and survives, while a still-hidden one is retired.
    #[cfg(unix)]
    #[tokio::test]
    async fn retirement_rechecks_visibility_under_the_gate() {
        let child = stand_in_child();
        // Freshly active, so no TTL fires and only pressure is in play.
        child.last_active.store(now_ms(), Ordering::SeqCst);
        let path = "/synthetic/turn.jsonl";
        let children = Mutex::new(HashMap::from([(path.to_string(), Arc::clone(&child))]));
        let stale = view(false, false, 0, 300);
        let policy = |viewers| RetirementPolicy::Maintenance {
            rules: RULES,
            view: stale,
            pressure: true,
            viewers,
        };
        let visible: crate::sessions::watcher::Audience = Arc::new(|_: &str| true);
        assert_eq!(
            try_retire_child(&children, path, &child, 1, policy(Some(&visible))),
            None,
            "watched now, whatever the snapshot said"
        );
        assert!(matches!(
            lock_poisoned(&child.gate).phase,
            ChildPhase::Active
        ));
        let hidden: crate::sessions::watcher::Audience = Arc::new(|_: &str| false);
        assert_eq!(
            try_retire_child(&children, path, &child, 1, policy(Some(&hidden))),
            Some(Reap::Pressure)
        );
        assert!(matches!(
            lock_poisoned(&child.gate).phase,
            ChildPhase::Terminating
        ));
    }

    #[test]
    fn should_recycle_only_when_footprint_at_limit_and_quiescent() {
        let limit = 700u64;
        // >=: the figures are truncated to whole MiB, so 700.9 MiB reports 700.
        assert!(should_recycle(700, false, limit));
        assert!(should_recycle(701, false, limit));
        assert!(should_recycle(1200, false, limit));
        assert!(!should_recycle(699, false, limit));
        // Never recycle a streaming child (termination truncates the turn).
        assert!(!should_recycle(1200, true, limit));
        // 0 disables recycling entirely.
        assert!(!should_recycle(1200, false, 0));
    }

    #[test]
    fn mem_parse_reads_resident_and_swap_in_mib() {
        let status = "Name:\tomp\nVmHWM:\t  450356 kB\nVmRSS:\t  320652 kB\nRssAnon:\t  253156 kB\nVmSwap:\t   78732 kB\nThreads:\t55\n";
        // VmHWM must not be mistaken for VmRSS; both values truncate to MiB.
        assert_eq!(parse_mem_mb(status), Some((313, 76)));
        // No swap configured: VmSwap absent counts as 0.
        assert_eq!(parse_mem_mb("VmRSS:\t2048 kB\n"), Some((2, 0)));
        // A zombie has no VmRSS line at all.
        assert_eq!(parse_mem_mb("Name:\tomp\nState:\tZ (zombie)\n"), None);
    }

    /// With no children the ticker runs no pass at all until a child is
    /// registered, and goes back to sleep once the map empties again.
    #[tokio::test(start_paused = true)]
    async fn ticker_parks_while_empty_and_wakes_on_insert() {
        use std::sync::atomic::{AtomicBool, AtomicUsize};
        let added = Arc::new(tokio::sync::Notify::new());
        let empty = Arc::new(AtomicBool::new(true));
        let passes = Arc::new(AtomicUsize::new(0));
        let ticker = {
            let (added, empty, passes) =
                (Arc::clone(&added), Arc::clone(&empty), Arc::clone(&passes));
            tokio::spawn(async move {
                maintenance_loop(
                    &added,
                    || empty.load(Ordering::SeqCst),
                    || false,
                    || {
                        passes.fetch_add(1, Ordering::SeqCst);
                        std::future::ready(())
                    },
                )
                .await
            })
        };
        let an_hour = Duration::from_secs(3600);
        tokio::time::sleep(an_hour).await;
        assert_eq!(passes.load(Ordering::SeqCst), 0, "parked with no children");

        empty.store(false, Ordering::SeqCst);
        added.notify_one();
        tokio::time::sleep(an_hour).await;
        assert!(passes.load(Ordering::SeqCst) > 0, "an insert wakes it");

        empty.store(true, Ordering::SeqCst);
        tokio::time::sleep(an_hour).await;
        let parked_at = passes.load(Ordering::SeqCst);
        tokio::time::sleep(an_hour).await;
        assert_eq!(passes.load(Ordering::SeqCst), parked_at, "parked again");
        ticker.abort();
    }
}
