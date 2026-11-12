use super::*;

#[test]
fn poll_refresh_backs_off_only_while_change_nudges_are_live() {
    assert_eq!(ttl(true, 1), NUDGED_TTL);
    // No listing socket: nobody receives nudges, so polls keep the 3 s TTL.
    assert_eq!(ttl(true, 0), TTL);
    // No discovery watch: file changes produce no nudge at all.
    assert_eq!(ttl(false, 2), TTL);
}

#[test]
fn validator_matches_exact_and_weak() {
    // The exact tag we hand out.
    assert!(validator_matches(
        "\"ab12cd34ef56ab78\"",
        "\"ab12cd34ef56ab78\""
    ));
    // Weak form matches a strong tag (If-None-Match uses weak comparison).
    assert!(validator_matches(
        "W/\"ab12cd34ef56ab78\"",
        "\"ab12cd34ef56ab78\""
    ));
    // Unquoted (URL-mangled ?since= form) still matches.
    assert!(validator_matches(
        "ab12cd34ef56ab78",
        "\"ab12cd34ef56ab78\""
    ));
    // Whitespace tolerance.
    assert!(validator_matches(
        "  \"ab12cd34ef56ab78\"  ",
        "\"ab12cd34ef56ab78\""
    ));
}

#[test]
fn validator_matches_star_and_lists() {
    assert!(validator_matches("*", "\"whatever\""));
    assert!(validator_matches(
        "\"a\", \"ab12cd34ef56ab78\"",
        "\"ab12cd34ef56ab78\""
    ));
    assert!(validator_matches(
        "\"ab12cd34ef56ab78\", \"b\"",
        "\"ab12cd34ef56ab78\""
    ));
}

#[test]
fn validator_matches_rejects_different() {
    assert!(!validator_matches(
        "\"deadbeefdeadbeef\"",
        "\"ab12cd34ef56ab78\""
    ));
    assert!(!validator_matches("", "\"ab12cd34ef56ab78\""));
    assert!(!validator_matches(
        "W/\"deadbeefdeadbeef\"",
        "\"ab12cd34ef56ab78\""
    ));
}

#[test]
fn etag_is_content_addressed_and_quoted() {
    let a = etag_for(r#"{"sessions":[]}"#, None);
    let b = etag_for(r#"{"sessions":[]}"#, None);
    let c = etag_for(r#"{"sessions":[{"id":"x"}]}"#, None);
    assert_eq!(a, b);
    assert_ne!(a, c);
    // Strong ETag syntax: quoted, 32 hex chars inside.
    assert!(a.starts_with('"') && a.ends_with('"'));
    let inner = a.trim_matches('"');
    assert_eq!(inner.len(), 32);
    assert!(inner.bytes().all(|b| b.is_ascii_hexdigit()));
}

/// Unique-per-test temp session file (tempfile is not a dependency; the
/// jsonl.rs precedent of temp_dir + unique tag). Removed first so a stale
/// file from an earlier run can never be served by the snippet cache,
/// which is keyed by path + mtime.
pub(super) fn scratch_session(tag: &str, content: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "omp-pulse-index-{}-{tag}.jsonl",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::write(&path, content).unwrap();
    path
}

pub(super) fn row(path: &str, id: &str, title: &str, cwd: &str) -> SessionInfo {
    SessionInfo {
        path: path.to_string(),
        id: id.to_string(),
        title: title.to_string(),
        cwd: cwd.to_string(),
        mtime: 1.0,
        active_at: 1.0,
        size: 100,
        running: false,
        owner_pid: None,
        live: false,
        shared: false,
    }
}

#[test]
fn project_scope_changes_validator_even_for_same_payload() {
    let payload = r#"{"sessions":[],"projects":[]}"#;
    assert_ne!(
        etag_for(payload, Some("/one")),
        etag_for(payload, Some("/two"))
    );
}

#[test]
fn refresh_throttle_leading_trailing_and_timer() {
    fn inner_for_test(refreshed: Instant, refreshing: bool) -> Inner {
        Inner {
            rows: Some(Arc::new(Vec::new())),
            entries: HashMap::new(),
            order: VecDeque::new(),
            query_bytes: 0,
            evictions: 0,
            refreshed,
            projects_expire: None,
            refreshing,
            pending: false,
            changed: false,
            timer_armed: false,
            refreshes: 0,
            hits_304: 0,
            served: 0,
            last_scan_ms: 0.0,
        }
    }
    let mut cold = inner_for_test(Instant::now() - TTL, false);
    cold.rows = None;
    assert_eq!(refresh_decision(&mut cold), RefreshDecision::Drop);
    assert!(cold.pending && !cold.refreshing);
    // Past the interval and idle: leading edge spawns.
    let mut idle = inner_for_test(
        Instant::now() - MIN_INTERVAL - Duration::from_secs(1),
        false,
    );
    assert_eq!(refresh_decision(&mut idle), RefreshDecision::Spawn);
    assert!(idle.refreshing);
    assert!(!idle.pending);
    // While refreshing: drop but mark pending (trailing edge kept).
    assert_eq!(refresh_decision(&mut idle), RefreshDecision::Drop);
    assert!(idle.pending);
    // Inside the interval, no timer yet: arm one for the remainder.
    let mut cool = inner_for_test(Instant::now(), false);
    let d = refresh_decision(&mut cool);
    assert!(matches!(d, RefreshDecision::Later(_)));
    assert!(cool.pending && cool.timer_armed);
    // Second trigger inside the interval: timer already armed, just drop
    // (pending is already set — the trailing edge is covered).
    assert_eq!(refresh_decision(&mut cool), RefreshDecision::Drop);
    // The trailing scan consumes its hint. Only a NEW event during that
    // scan may schedule another, regardless of whether its payload changes.
    cool.refreshed = Instant::now() - MIN_INTERVAL - Duration::from_secs(1);
    assert_eq!(refresh_decision(&mut cool), RefreshDecision::Spawn);
    assert!(!cool.pending && !cool.timer_armed);
    // A recorded change is consumed by the scan that starts after it.
    cool.refreshing = false;
    cool.changed = true;
    cool.refreshed = Instant::now() - MIN_INTERVAL - Duration::from_secs(1);
    assert_eq!(refresh_decision(&mut cool), RefreshDecision::Spawn);
    assert!(!cool.changed);
    // A poll after a recorded change starts the refresh and waits for it;
    // a poll during that refresh waits for the same one; no change, no wait.
    let mut poll = inner_for_test(Instant::now(), false);
    assert_eq!(change_refresh(&mut poll), None);
    poll.changed = true;
    assert_eq!(change_refresh(&mut poll), Some(true));
    assert!(poll.refreshing && !poll.changed);
    poll.changed = true;
    assert_eq!(change_refresh(&mut poll), Some(false));
    assert!(poll.changed, "a change during the scan outlives it");
    // Before the first scan, the cold path builds the listing.
    let mut cold_change = inner_for_test(Instant::now(), false);
    cold_change.rows = None;
    cold_change.changed = true;
    assert_eq!(change_refresh(&mut cold_change), None);
}

#[test]
fn query_cache_evicts_oldest_queries_past_the_byte_budget() {
    let mut inner = Inner {
        rows: None,
        entries: HashMap::new(),
        order: VecDeque::new(),
        query_bytes: 0,
        evictions: 0,
        refreshed: Instant::now(),
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
    let entry = |text: &str| make_entry(Arc::<str>::from(text), None);
    // Two 5 MiB payloads exceed the 8 MiB budget together; the oldest
    // (first-inserted) query must go and the newest stays.
    insert_entry(&mut inner, "a", entry(&"x".repeat(5 * 1024 * 1024)));
    assert_eq!(inner.entries.len(), 1);
    insert_entry(&mut inner, "b", entry(&"y".repeat(5 * 1024 * 1024)));
    assert!(!inner.entries.contains_key("a"));
    assert!(inner.entries.contains_key("b"));
    assert_eq!(inner.evictions, 1);
    assert!(inner.query_bytes <= MAX_QUERY_CACHE_BYTES);
    // Updating an existing query keeps its queue position and never
    // evicts it (a refresh re-serialization is not a new query).
    insert_entry(&mut inner, "b", entry(&"z".repeat(5 * 1024 * 1024)));
    assert!(inner.entries.contains_key("b"));
    assert_eq!(inner.evictions, 1);
    // The default listing is exempt from the budget and never evicted;
    // its bytes are not counted against the budget either.
    insert_entry(&mut inner, "", entry(&"w".repeat(7 * 1024 * 1024)));
    assert!(inner.entries.contains_key(""));
    let b = inner.entries.get("b").unwrap();
    assert_eq!(inner.query_bytes, b.payload.len() + b.etag.len());
}
