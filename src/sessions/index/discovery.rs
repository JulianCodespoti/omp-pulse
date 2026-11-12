//! Session discovery: watching the sessions root and its project directories,
//! and turning file events into refresh nudges for the listing.

use super::*;

use crate::server::http::AppState;
use std::collections::HashMap;
use std::path::Path as FsPath;
use std::sync::Arc;
use std::time::Duration;

/// Watch discovery hints separately from exact-file transcript tailing. The
/// bounded channel coalesces bursts; scans still obey the audience/throttle gate.
/// With no listing socket attached the hints only set a flag, so they are
/// coalesced over [`IDLE_DEBOUNCE`] (see [`hint_debounce`]).
/// A failed native watch leaves the ordinary HTTP polling fallback intact.
///
/// Watches the root and each project directory, never the whole tree: the
/// catalogue reads one project level, so deeper events were all dropped by
/// `discovery_event`, while notify's recursive mode stat()s every entry of
/// every session artifact directory (800 entries, ~250 ms of trapped calls
/// under proot before the daemon could bind) and re-walks each new one.
pub fn start_session_discovery(state: &Arc<AppState>) {
    use notify::Watcher as _;
    let root = state.cfg.sessions_root.clone();
    let event_root = root.clone();
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    // Coalesced like `tx`: a rewatch re-lists the root, so one pending is enough.
    let (rewatch_tx, mut rewatch_rx) = tokio::sync::mpsc::channel(1);
    let watcher = notify::RecommendedWatcher::new(
        move |event: notify::Result<notify::Event>| {
            if event
                .as_ref()
                .map_or(true, |event| project_set_event(&event_root, event))
            {
                let _ = rewatch_tx.try_send(());
            }
            if event
                .as_ref()
                .map_or(true, |event| discovery_event(&event_root, event))
            {
                let _ = tx.try_send(());
            }
        },
        notify::Config::default().with_follow_symlinks(false),
    );
    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(error) => {
            tracing::warn!(%error, "session discovery watch unavailable; using HTTP fallback");
            return;
        }
    };
    if let Err(error) = watcher.watch(&root, notify::RecursiveMode::NonRecursive) {
        tracing::warn!(%error, "session discovery root unavailable; using HTTP fallback");
        return;
    }
    watch_project_dirs(&mut watcher, &root);
    DISCOVERY_LIVE.store(true, std::sync::atomic::Ordering::Relaxed);
    let state = Arc::downgrade(state);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                hint = rx.recv() => {
                    if hint.is_none() {
                        break;
                    }
                    // Rewatches stay prompt during the debounce: a session
                    // created in a brand-new project directory must not wait
                    // a second to be watched.
                    let quiet = tokio::time::sleep(hint_debounce(sessions_clients()));
                    tokio::pin!(quiet);
                    loop {
                        tokio::select! {
                            () = &mut quiet => break,
                            Some(()) = rewatch_rx.recv() => watch_project_dirs(&mut watcher, &root),
                        }
                    }
                    while rx.try_recv().is_ok() {}
                    let Some(state) = state.upgrade() else { break };
                    trigger_refresh(&state);
                }
                Some(()) = rewatch_rx.recv() => watch_project_dirs(&mut watcher, &root),
            }
        }
        DISCOVERY_LIVE.store(false, std::sync::atomic::Ordering::Relaxed);
    });
}

/// Coalescing window for discovery hints while a listing socket is attached:
/// short, so a chip or preview follows the file within a frame or two.
const LIVE_DEBOUNCE: Duration = Duration::from_millis(50);
/// Coalescing window with no listing socket attached (a chat is open, or the
/// app is backgrounded). A turn appends to its session file many times a
/// second, and at 50 ms every burst woke this task, only for
/// [`trigger_refresh`] to set the `changed` flag and return: wakeups (each a
/// proot-trapped syscall on the phone) that kept it from sleeping. The flag
/// is all a later poll or [`refresh_on_attach`] needs, so a second's delay
/// costs nothing visible. The watch itself stays armed: re-arming the project
/// watches on the phone costs a trapped call per directory.
const IDLE_DEBOUNCE: Duration = Duration::from_secs(1);

fn hint_debounce(sessions_clients: usize) -> Duration {
    if sessions_clients == 0 {
        IDLE_DEBOUNCE
    } else {
        LIVE_DEBOUNCE
    }
}

/// Watch every project directory directly under `root` (re-watching one is
/// a no-op). Directory-ness comes from the dirent type, so symlinks are not
/// followed and no entry is stat()ed.
fn watch_project_dirs(watcher: &mut notify::RecommendedWatcher, root: &FsPath) {
    use notify::Watcher as _;
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let dir = entry.path();
        if let Err(error) = watcher.watch(&dir, notify::RecursiveMode::NonRecursive) {
            tracing::warn!(%error, path = %dir.display(), "session discovery cannot watch project directory");
        }
    }
}

/// Whether the set of project directories may have changed: an entry
/// directly under the root appeared, vanished or was renamed, or the event
/// queue overflowed and such an event may have been lost. Appends to a
/// stranded root-level session file are not one.
fn project_set_event(root: &FsPath, event: &notify::Event) -> bool {
    use notify::{EventKind, event::ModifyKind};
    if event.need_rescan() {
        return true;
    }
    matches!(
        event.kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Any
    ) && event.paths.iter().any(|path| path.parent() == Some(root))
}

fn discovery_event(root: &FsPath, event: &notify::Event) -> bool {
    if event.need_rescan() {
        return true;
    }
    if !matches!(
        event.kind,
        notify::EventKind::Create(_)
            | notify::EventKind::Modify(_)
            | notify::EventKind::Remove(_)
            | notify::EventKind::Any
    ) {
        return false;
    }
    event.paths.iter().any(|path| {
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        let parts: Vec<_> = relative.components().collect();
        if parts
            .iter()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return false;
        }
        // The catalogue scans one project level; deeper sidecars and reads
        // are irrelevant. Project renames/removals affect all their sessions.
        parts.len() <= 1 || (parts.len() == 2 && path.extension().is_some_and(|ext| ext == "jsonl"))
    })
}

pub(super) fn changed_listing_etag(
    entries: &HashMap<String, Arc<ListingEntry>>,
    fresh: &[(String, Arc<ListingEntry>)],
) -> Option<String> {
    fresh.iter().find_map(|(key, entry)| {
        entries
            .get(key)
            .filter(|old| old.etag != entry.etag)
            .map(|_| entry.etag.clone())
    })
}

pub fn trigger_refresh(state: &Arc<AppState>) {
    // Record the change first, whoever is listening: a poll then knows the
    // cache is out of date (see `Inner::changed`). That costs one flag.
    // Then the audience gate: with no sessions-socket client attached there
    // is nobody to nudge, and the next HTTP poll pays its own scan — an idle
    // laptop with flapping panes and no phone attached does zero scans. The
    // poll path (`listing()`) is demand-driven and ungated.
    let decision = {
        let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
        let Some(inner) = g.as_mut() else {
            return;
        };
        inner.changed = true;
        if sessions_clients() == 0 {
            return;
        }
        refresh_decision(inner)
    };
    run_decision(state, decision);
}

/// A `/ws/sessions` client just attached. Changes recorded while nobody was
/// listening (a chat open, the app backgrounded) only set `changed`, so the
/// listing it is about to reconcile against may be stale: start the refresh
/// now, and its new etag is pushed to the socket when the scan lands, rather
/// than waiting for the client's next HTTP poll. Nothing recorded, no scan.
pub fn refresh_on_attach(state: &Arc<AppState>) {
    let decision = {
        let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
        g.as_mut().and_then(attach_decision)
    };
    if let Some(decision) = decision {
        run_decision(state, decision);
    }
}

/// The pure core of [`refresh_on_attach`].
pub(super) fn attach_decision(inner: &mut Inner) -> Option<RefreshDecision> {
    inner.changed.then(|| refresh_decision(inner))
}

fn run_decision(state: &Arc<AppState>, decision: RefreshDecision) {
    match decision {
        RefreshDecision::Spawn => spawn_refresh(state),
        RefreshDecision::Later(wait) => {
            let state = Arc::clone(state);
            tokio::spawn(async move {
                tokio::time::sleep(wait).await;
                trigger_refresh(&state);
            });
        }
        RefreshDecision::Drop => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_listing_client_refreshes_what_idle_discovery_only_flagged() {
        // With no listing socket the hints are coalesced longer and only set
        // `changed`; the first client to attach must still get a scan.
        assert!(hint_debounce(0) > hint_debounce(1));
        assert_eq!(hint_debounce(0), IDLE_DEBOUNCE);
        assert_eq!(hint_debounce(3), LIVE_DEBOUNCE);
        let mut inner = Inner {
            rows: Some(Arc::new(Vec::new())),
            entries: HashMap::new(),
            order: std::collections::VecDeque::new(),
            query_bytes: 0,
            evictions: 0,
            refreshed: std::time::Instant::now() - MIN_INTERVAL - Duration::from_secs(1),
            projects_expire: None,
            refreshing: false,
            pending: false,
            changed: false,
            timer_armed: false,
            refreshes: 0,
            hits_304: 0,
            served: 0,
            last_scan_ms: 0.0,
        };
        assert_eq!(
            attach_decision(&mut inner),
            None,
            "nothing recorded, no scan"
        );
        // What `trigger_refresh` records while `sessions_clients() == 0`.
        inner.changed = true;
        assert_eq!(attach_decision(&mut inner), Some(RefreshDecision::Spawn));
        assert!(inner.refreshing && !inner.changed);
        // The scan consumed the flag: a second attach does not rescan.
        inner.refreshing = false;
        assert_eq!(attach_decision(&mut inner), None);
    }

    #[test]
    fn discovery_filters_access_sidecars_and_unrelated_paths() {
        use notify::{
            Event, EventKind,
            event::{AccessKind, CreateKind, Flag, ModifyKind, RemoveKind},
        };
        let root = FsPath::new("sessions");
        for kind in [
            EventKind::Create(CreateKind::Any),
            EventKind::Modify(ModifyKind::Any),
            EventKind::Remove(RemoveKind::Any),
        ] {
            for path in ["sessions/project", "sessions/project/chat.jsonl"] {
                assert!(discovery_event(
                    root,
                    &Event::new(kind).add_path(path.into())
                ));
            }
            for path in [
                "other/chat.jsonl",
                "sessions/project/sidecar.txt",
                "sessions/project/nested/chat.jsonl",
                "sessions/../private/chat.jsonl",
            ] {
                assert!(!discovery_event(
                    root,
                    &Event::new(kind).add_path(path.into())
                ));
            }
        }
        assert!(!discovery_event(
            root,
            &Event::new(EventKind::Access(AccessKind::Any))
                .add_path("sessions/project/chat.jsonl".into())
        ));
        assert!(discovery_event(
            root,
            &Event::new(EventKind::Other).set_flag(Flag::Rescan)
        ));
    }

    #[test]
    fn project_set_changes_only_on_root_entries_and_rescans() {
        use notify::{
            Event, EventKind,
            event::{AccessKind, CreateKind, DataChange, Flag, ModifyKind, RemoveKind, RenameMode},
        };
        let root = FsPath::new("sessions");
        for kind in [
            EventKind::Create(CreateKind::Folder),
            EventKind::Remove(RemoveKind::Folder),
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
        ] {
            assert!(project_set_event(
                root,
                &Event::new(kind).add_path("sessions/project".into())
            ));
            // Deeper entries never change which directories are watched.
            assert!(!project_set_event(
                root,
                &Event::new(kind).add_path("sessions/project/chat.jsonl".into())
            ));
        }
        // An append to a stranded root-level session is not a new project.
        assert!(!project_set_event(
            root,
            &Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
                .add_path("sessions/chat.jsonl".into())
        ));
        assert!(!project_set_event(
            root,
            &Event::new(EventKind::Access(AccessKind::Any)).add_path("sessions/project".into())
        ));
        assert!(project_set_event(
            root,
            &Event::new(EventKind::Other).set_flag(Flag::Rescan)
        ));
    }

    #[test]
    fn discovery_notifies_changed_filter_even_when_default_is_unchanged() {
        let entry = |text: &str| make_entry(text.into(), None);
        let entries = HashMap::from([
            (String::new(), entry("default")),
            ("filter".into(), entry("before")),
        ]);
        let unchanged = vec![
            (String::new(), entry("default")),
            ("filter".into(), entry("before")),
        ];
        assert_eq!(changed_listing_etag(&entries, &unchanged), None);
        let changed = vec![
            (String::new(), entry("default")),
            ("filter".into(), entry("after")),
        ];
        assert_eq!(
            changed_listing_etag(&entries, &changed),
            Some(entry("after").etag.clone())
        );
    }
}
