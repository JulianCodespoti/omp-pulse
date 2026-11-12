/// Tests exercise the tailing logic itself, so every session has an
/// audience; the no-audience path is covered by `skips_tail_without_audience`.
fn always_watch() -> Audience {
    std::sync::Arc::new(|_: &str| true)
}

use super::*;
use std::path::PathBuf;

/// Unique-per-test temp file (tempfile is not a dependency; matches the
/// collab.rs/doctor.rs precedent of temp_dir + unique tag).
fn scratch(tag: &str, content: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "omp-pulse-watcher-{}-{tag}.jsonl",
        std::process::id()
    ));
    std::fs::write(&path, content).unwrap();
    path
}

fn append(path: &Path, bytes: &str) {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(bytes.as_bytes())
        .unwrap();
}

fn rewrite(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
}

/// Minimal config; the watcher only reads `watch_interval_ms` from it.
fn test_config() -> SharedConfig {
    Arc::new(Config {
        // Speech-to-text is off in tests: no interpreter, no model.
        asr_python: None,
        asr_model_dir: None,
        asr_threads: 6,
        host: "127.0.0.1".into(),
        port: 0,
        sessions_root: std::env::temp_dir(),
        omp_bin: "/bin/true".into(),
        public_dir: None,
        token_hash: None,
        max_children: 1,
        push_store_path: std::env::temp_dir().join("push.json"),
        vapid_path: std::env::temp_dir().join("vapid.json"),
        state_dir: std::env::temp_dir(),
        home: std::env::temp_dir(),
        paths: std::sync::Arc::new(crate::paths::Paths::default()),
        watch_interval_ms: 250,
        ws_queue_cap: 64,
        ws_queue_bytes: 1 << 20,
        child_idle_secs: 900,
        child_unwatched_secs: 300,
        child_rss_mb: 0,
        child_lean_js: false,
        prewarm_on_attach: false,
        owner_cache_ms: 3000,
        ws_deflate_min: 4096,
    })
}

#[test]
fn a_huge_jump_becomes_a_repaint_not_a_tail() {
    // Growth past MAX_TAIL_CATCHUP is a repaint event: the client gets a
    // Poll (refetch history over HTTP, paged and compressed) and the offset
    // jumps, instead of the daemon parsing megabytes into frame after frame.
    let path = scratch("huge-jump", "{\"i\":0}\n");
    let (tx, _) = tokio::sync::broadcast::channel::<WatchEvent>(16);
    let watcher = Watcher::new(test_config(), tx.clone(), always_watch());
    let mut rx = tx.subscribe();
    watcher.watch(path.to_str().unwrap());
    // One line, comfortably past the cap.
    let line = format!("{{\"pad\":\"{}\"}}\n", "x".repeat(9 * 1024 * 1024));
    append(&path, &line);
    watcher.drain(path.to_str().unwrap());
    match rx.try_recv().unwrap() {
        WatchEvent::Poll { session } => assert_eq!(session, path.to_str().unwrap()),
        other => panic!("expected Poll, got {other:?}"),
    }
    let size = std::fs::metadata(&path).unwrap().len();
    assert_eq!(watcher.offset_for(path.to_str().unwrap()), Some(size));
}

#[test]
fn skips_tail_without_audience() {
    // No audience: the offset must jump to EOF and NOTHING may be emitted.
    // This is the bound on a real hazard — a session with a live child grew
    // by 150 MiB and the daemon parsed all of it for frames the router then
    // discarded (320 MiB of RSS, hub queue never held one frame).
    let path = scratch("no-audience", "{\"i\":0}\n");
    let (tx, _) = tokio::sync::broadcast::channel::<WatchEvent>(16);
    let silent: Audience = std::sync::Arc::new(|_: &str| false);
    let watcher = Watcher::new(test_config(), tx.clone(), silent);
    let mut rx = tx.subscribe();
    watcher.watch(path.to_str().unwrap());
    append(&path, "{\"i\":1}\n{\"i\":2}\n");
    watcher.drain(path.to_str().unwrap());
    assert!(
        matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "a session with no audience must emit nothing"
    );
    // Offset advanced to EOF, so restoring the audience streams only NEW
    // bytes rather than replaying a backlog.
    let size = std::fs::metadata(&path).unwrap().len();
    let watched = watcher.offset_for(path.to_str().unwrap());
    assert_eq!(watched, Some(size));
}

#[test]
fn a_skipped_tail_is_reported_once_per_skip() {
    // The hub owes hidden clients a resync only for tails actually skipped;
    // a drain that finds nothing new, or that delivers, reports nothing.
    let path = scratch("skip-report", "{\"i\":0}\n");
    let p = path.to_str().unwrap();
    let (tx, _) = tokio::sync::broadcast::channel::<WatchEvent>(16);
    let live = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let audience: Audience = {
        let live = Arc::clone(&live);
        Arc::new(move |_: &str| live.load(std::sync::atomic::Ordering::Relaxed))
    };
    let watcher = Watcher::new(test_config(), tx.clone(), audience);
    let skipped = Arc::new(Mutex::new(Vec::<String>::new()));
    watcher.on_tail_skipped({
        let skipped = Arc::clone(&skipped);
        Arc::new(move |session: &str| skipped.lock().unwrap().push(session.to_owned()))
    });
    watcher.watch(p);
    watcher.drain(p);
    assert!(
        skipped.lock().unwrap().is_empty(),
        "nothing appended, nothing skipped"
    );
    append(&path, "{\"i\":1}\n");
    watcher.drain(p);
    assert_eq!(*skipped.lock().unwrap(), vec![p.to_owned()]);
    live.store(true, std::sync::atomic::Ordering::Relaxed);
    append(&path, "{\"i\":2}\n");
    watcher.drain(p);
    assert_eq!(
        skipped.lock().unwrap().len(),
        1,
        "a delivered tail is no skip"
    );
    std::fs::remove_file(&path).ok();
}

#[tokio::test(start_paused = true)]
async fn tick_parks_without_audience_and_resumes_on_wake() {
    // The bug: with a chat open on a locked phone the tick still woke 4×/s
    // for nobody, so the phone never slept. With no audience it must not wake
    // at all, and the hub's wake must restart it with an immediate catch-up.
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let path = scratch("tick-park", "{\"i\":0}\n");
    let p = path.to_str().unwrap();
    let (tx, _) = tokio::sync::broadcast::channel::<WatchEvent>(16);
    let live = Arc::new(AtomicBool::new(false));
    let asks = Arc::new(AtomicUsize::new(0));
    let audience: Audience = {
        let (live, asks) = (Arc::clone(&live), Arc::clone(&asks));
        Arc::new(move |_: &str| {
            asks.fetch_add(1, Ordering::Relaxed);
            live.load(Ordering::Relaxed)
        })
    };
    let watcher = Watcher::new(test_config(), tx.clone(), audience);
    let mut rx = tx.subscribe();
    watcher.watch(p);
    let task = tokio::spawn(tick_task(Arc::clone(&watcher)));
    tokio::time::sleep(Duration::from_secs(1)).await;
    let parked = asks.load(Ordering::Relaxed);
    assert!(parked > 0, "the tick asked before parking");
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(
        asks.load(Ordering::Relaxed),
        parked,
        "a parked tick does no work while there is no audience"
    );

    append(&path, "{\"i\":1}\n");
    live.store(true, Ordering::Relaxed);
    watcher.audience_changed();
    tokio::time::sleep(Duration::from_millis(1)).await;
    match rx.try_recv() {
        Ok(WatchEvent::Entries { session, entries }) => {
            assert_eq!(session, p);
            assert_eq!(entries.len(), 1);
        }
        other => panic!("the wake must catch up at once, got {other:?}"),
    }
    let resumed = asks.load(Ordering::Relaxed);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        asks.load(Ordering::Relaxed) > resumed,
        "with an audience the tick runs again"
    );
    task.abort();
    std::fs::remove_file(&path).ok();
}

#[tokio::test]
async fn restore_racing_a_real_tail_skip_recovers_before_new_live_entries() {
    use crate::server::ws::{ClientCaps, WsHub};
    let path = scratch("restore-race", "{\"i\":0}\n");
    let p = path.to_str().unwrap();
    let hub = WsHub::new(test_config());
    let (id, mut client) = hub.attach(p.to_owned(), ClientCaps::default());
    hub.set_visible(id, false);
    let audience: Audience = {
        let hub = Arc::clone(&hub);
        Arc::new(move |session: &str| {
            let visible = hub.has_audience(session);
            if !visible {
                // Deterministically restore after the audience observation,
                // but before drain advances its offset and reports the skip.
                hub.set_visible(id, true);
            }
            visible
        })
    };
    let (tx, _) = tokio::sync::broadcast::channel(16);
    let watcher = Watcher::new(test_config(), tx.clone(), audience);
    watcher.on_tail_skipped({
        let hub = Arc::clone(&hub);
        Arc::new(move |session| hub.tail_skipped(session))
    });
    let mut entries = tx.subscribe();
    watcher.watch(p);
    append(&path, "{\"i\":1}\n");
    watcher.drain(p);
    assert_eq!(
        watcher.offset_for(p),
        Some(std::fs::metadata(&path).unwrap().len())
    );
    let recovery = tokio::time::timeout(Duration::from_secs(1), client.recv())
        .await
        .expect("restore must be ordered to recover")
        .expect("client remains attached");
    assert_eq!(&*recovery, r#"{"type":"resync","reason":"hidden"}"#);
    assert!(
        entries.try_recv().is_err(),
        "the skipped entry was not streamed"
    );
    append(&path, "{\"i\":2}\n");
    watcher.drain(p);
    match entries.try_recv().expect("new live tail resumes") {
        WatchEvent::Entries { entries, .. } => {
            assert_eq!(entries, vec![serde_json::json!({"i":2})])
        }
        other => panic!("expected live entries after recovery, got {other:?}"),
    }
    hub.detach(id);
    std::fs::remove_file(path).ok();
}

#[test]
fn partial_grows_incrementally_and_clears_on_completion() {
    let path = scratch("partial", "{\"i\":0}\n");
    let (tx, _) = tokio::sync::broadcast::channel::<WatchEvent>(16);
    let watcher = Watcher::new(test_config(), tx.clone(), always_watch());
    let mut rx = tx.subscribe();
    watcher.watch(path.to_str().unwrap());

    // Growing unterminated line: seeded once, then only the delta is
    // folded in — and the full growing text is what reaches the client.
    append(&path, "growing");
    watcher.drain(path.to_str().unwrap());
    match rx.try_recv().unwrap() {
        WatchEvent::Partial { text, offset, .. } => {
            assert_eq!(text, "growing");
            assert_eq!(offset, 8);
        }
        other => panic!("expected Partial, got {other:?}"),
    }
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    append(&path, " slowly");
    watcher.drain(path.to_str().unwrap());
    match rx.try_recv().unwrap() {
        WatchEvent::Partial { text, offset, .. } => {
            assert_eq!(text, "growing slowly");
            assert_eq!(offset, 8);
        }
        other => panic!("expected Partial, got {other:?}"),
    }
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    // A drain with no file change must not re-broadcast the tail.
    watcher.drain(path.to_str().unwrap());
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    // The newline completes the line: the partial is cleared and nothing
    // is broadcast (the unparseable "growing slowly" is consumed
    // silently, its bytes advancing the offset).
    append(&path, "\n");
    watcher.drain(path.to_str().unwrap());
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    // A fresh JSON line after the completed one streams as entries.
    append(&path, "{\"i\":1}\n");
    watcher.drain(path.to_str().unwrap());
    match rx.try_recv().unwrap() {
        WatchEvent::Entries { entries, .. } => {
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0]["i"], 1);
        }
        other => panic!("expected Entries, got {other:?}"),
    }
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    std::fs::remove_file(&path).ok();
}

#[test]
fn completed_large_partial_does_not_pin_idle_watcher_memory() {
    let path = scratch("large-partial-release", "{\"i\":0}\n");
    let (tx, _) = tokio::sync::broadcast::channel::<WatchEvent>(16);
    let watcher = Watcher::new(test_config(), tx.clone(), always_watch());
    let mut rx = tx.subscribe();
    watcher.watch(path.to_str().unwrap());

    append(&path, &"x".repeat(MAX_IDLE_PARTIAL_CAPACITY + 1));
    watcher.drain(path.to_str().unwrap());
    assert!(matches!(rx.try_recv().unwrap(), WatchEvent::Partial { .. }));
    append(&path, "\n");
    watcher.drain(path.to_str().unwrap());
    let entry = watcher.state().get(path.to_str().unwrap()).unwrap().clone();
    let state = entry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(
        state.tail.bytes.capacity() <= MAX_IDLE_PARTIAL_CAPACITY,
        "a completed large partial must not retain its buffer while idle"
    );
    std::fs::remove_file(&path).ok();
}

#[test]
fn shrink_below_offset_resets_state_and_re_emits() {
    let path = scratch("shrink", "{\"i\":0}\n");
    let (tx, _) = tokio::sync::broadcast::channel::<WatchEvent>(16);
    let watcher = Watcher::new(test_config(), tx.clone(), always_watch());
    let mut rx = tx.subscribe();
    watcher.watch(path.to_str().unwrap());

    append(&path, "tail");
    watcher.drain(path.to_str().unwrap());
    assert!(matches!(rx.try_recv().unwrap(), WatchEvent::Partial { .. }));

    // Truncate BELOW the delivered offset: clients must refetch history.
    rewrite(&path, "{\"i");
    watcher.drain(path.to_str().unwrap());
    match rx.try_recv().unwrap() {
        WatchEvent::Poll { .. } => {}
        other => panic!("expected Poll, got {other:?}"),
    }
    // The stale partial must not survive the reset.
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    // Re-emit from the reset offset; the torn "{\"i" prefix is skipped.
    append(&path, "{\"i\":1}\n");
    watcher.drain(path.to_str().unwrap());
    match rx.try_recv().unwrap() {
        WatchEvent::Entries { entries, .. } => {
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0]["i"], 1);
        }
        other => panic!("expected Entries, got {other:?}"),
    }
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    std::fs::remove_file(&path).ok();
}

#[test]
fn truncation_within_partial_reseeds_tail() {
    let path = scratch("midtrunc", "{\"i\":0}\n");
    let (tx, _) = tokio::sync::broadcast::channel::<WatchEvent>(16);
    let watcher = Watcher::new(test_config(), tx.clone(), always_watch());
    let mut rx = tx.subscribe();
    watcher.watch(path.to_str().unwrap());

    append(&path, "growing");
    watcher.drain(path.to_str().unwrap());
    match rx.try_recv().unwrap() {
        WatchEvent::Partial { text, .. } => assert_eq!(text, "growing"),
        other => panic!("expected Partial, got {other:?}"),
    }

    // Truncate back into the partial (still at/above the delivered
    // offset): the tail must be re-seeded from the file, not appended to
    // a stale base.
    rewrite(&path, "{\"i\":0}\ngro");
    watcher.drain(path.to_str().unwrap());
    match rx.try_recv().unwrap() {
        WatchEvent::Partial { text, offset, .. } => {
            assert_eq!(text, "gro");
            assert_eq!(offset, 8);
        }
        other => panic!("expected Partial, got {other:?}"),
    }
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    std::fs::remove_file(&path).ok();
}

#[test]
fn event_for_unwatched_sibling_path_is_ignored() {
    // The event-mapping rule: an event is acted on only when its path is
    // EXACTLY a watched path. Sibling files and parent-directory noise are
    // ignored rather than guessed at; the tick's stat-compare covers
    // anything the native layer never reported.
    let mut nw = NativeWatches::new(true);
    nw.added("/sessions/a.jsonl");

    // Watched path, a sibling, and parent-directory noise in one batch:
    // only the watched path drains.
    let events = vec![
        "/sessions/a.jsonl".to_string(),
        "/sessions/b.jsonl".to_string(),
        "/sessions".to_string(),
    ];
    assert_eq!(nw.matched(&events), vec!["/sessions/a.jsonl"]);

    // Only unwatched paths: nothing drains.
    let events = vec!["/sessions/b.jsonl".to_string(), "/sessions".to_string()];
    assert!(nw.matched(&events).is_empty());
}

#[test]
fn another_viewer_does_not_discard_a_parked_watchers_tail() {
    let path = scratch("second-viewer", "{\"i\":0}\n");
    let p = path.to_str().unwrap();
    let (tx, _) = tokio::sync::broadcast::channel(16);
    let mut rx = tx.subscribe();
    let watcher = Watcher::new(test_config(), tx, always_watch());
    watcher.watch(p);
    let offset = watcher.offset_for(p);
    append(&path, "{\"i\":1}\n");
    // A native event has not drained yet; attaching must preserve the gap.
    watcher.watch(p);
    assert_eq!(watcher.offset_for(p), offset);
    watcher.drain(p);
    match rx
        .try_recv()
        .expect("existing viewer gets the pending tail")
    {
        WatchEvent::Entries { entries, .. } => {
            assert_eq!(entries, vec![serde_json::json!({"i":1})])
        }
        other => panic!("expected pending entries, got {other:?}"),
    }
    std::fs::remove_file(path).ok();
}

#[test]
fn unwatch_removes_state_and_native_watch() {
    let path = scratch("unwatch", "{\"i\":0}\n");
    let (tx, _) = tokio::sync::broadcast::channel::<WatchEvent>(16);
    let watcher = Watcher::new(test_config(), tx.clone(), always_watch());

    watcher.watch(path.to_str().unwrap());
    assert_eq!(watcher.watched_count(), 1);
    assert_eq!(
        watcher.offset_for(path.to_str().unwrap()),
        Some(std::fs::metadata(&path).unwrap().len())
    );

    // Re-watching the same path stays one entry (idempotent).
    watcher.watch(path.to_str().unwrap());
    assert_eq!(watcher.watched_count(), 1);

    watcher.unwatch(path.to_str().unwrap());
    // State removed: no longer tailed, delivered offset gone.
    assert_eq!(watcher.watched_count(), 0);
    assert_eq!(watcher.offset_for(path.to_str().unwrap()), None);
    // The native-watch removal command is queued, and the native task's
    // bookkeeping drops the path from its watched set so stale events
    // for it are ignored.
    let cmds = watcher.queued_commands();
    assert!(matches!(
        cmds.last(),
        Some(Cmd::Remove(p)) if p == path.to_str().unwrap()
    ));
    let mut nw = NativeWatches::new(true);
    nw.added(path.to_str().unwrap());
    nw.on_remove(path.to_str().unwrap());
    assert!(nw.matched(&[path.to_str().unwrap().to_string()]).is_empty());

    std::fs::remove_file(&path).ok();
}

#[test]
fn poll_backend_selection_honours_env_override() {
    // Only OMP_PULSE_WATCH_POLL=1 opts in; anything else keeps the native
    // backend. The pure core is tested so the OS never matters.
    assert_eq!(select_backend_for(None), Backend::Native);
    assert_eq!(select_backend_for(Some("")), Backend::Native);
    assert_eq!(select_backend_for(Some("0")), Backend::Native);
    assert_eq!(select_backend_for(Some("true")), Backend::Native);
    assert_eq!(select_backend_for(Some("1")), Backend::Poll);
    // Poll mode re-arms safely on every platform (HashMap insert).
    assert!(Backend::Poll.rearms());
}

#[test]
fn only_opens_count_as_open_events() {
    use notify::event::{AccessKind, AccessMode, CreateKind, EventKind, ModifyKind};
    let ev = |kind| notify::Event::new(kind).add_path(PathBuf::from("/s/a.jsonl"));
    assert!(is_open_event(&ev(EventKind::Access(AccessKind::Open(
        AccessMode::Any
    )))));
    // A finished write still wakes the tailer and the bridge.
    assert!(!is_open_event(&ev(EventKind::Access(AccessKind::Close(
        AccessMode::Write
    )))));
    assert!(!is_open_event(&ev(EventKind::Modify(ModifyKind::Any))));
    assert!(!is_open_event(&ev(EventKind::Create(CreateKind::File))));
    assert!(!is_open_event(&ev(EventKind::Any)));
}

mod attachment;
