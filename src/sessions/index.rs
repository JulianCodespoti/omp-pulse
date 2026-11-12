//! Incremental session index: one scan per refresh serves every
//! listing query from a pre-serialized, content-addressed payload.
//! File memos independently bound retained path/value bytes and entry counts.
//!
//! WHY (measured, docs/internals/performance.md F6): the old 3 s cache TTL sat exactly in
//! phase with the client's 3 s poll, so nearly every poll paid the cold
//! 134 ms path (scan 3365 files + header parse + `/proc` sweep + per-row
//! stat) AND downloaded 1.87 MB. This index (a) serves STALE-WHILE-REVALIDATE
//! so a poll never blocks on a refresh, (b) caches the SERIALIZED payload as
//! `Arc<str>` per query so a hit is a hash lookup + headers, (c) answers
//! `If-None-Match` / `?since=<etag>` with 304, turning the steady-state poll
//! from 1.87 MB to ~0 bytes, and (d) bounds the per-query payload cache by a
//! byte budget (FIFO eviction; the default listing exempt), so a phone typing
//! into a search box cannot accumulate one megabyte-scale payload per
//! keystroke. The wire shape is byte-identical to the old
//! handler for a client that sends no validator.

mod caches;
mod discovery;
mod memo;
mod page;
mod scan;

use caches::*;
use discovery::*;
use page::*;
use scan::*;

pub(crate) use caches::mtime_ms;
pub use discovery::{refresh_on_attach, start_session_discovery, trigger_refresh};
pub(crate) use page::project_cached_authority;

/// A bounded continuation of the listing's existing whole-file fold. History
/// and passive state can recover controls older than their transcript page
/// without another unbounded scan or a second metadata cache.
pub(crate) fn session_configuration(
    path: &str,
) -> Option<crate::sessions::jsonl::usage::SessionConfiguration> {
    let mut budget = USAGE_FOLD_BUDGET;
    usage_at(path, stamp(path), &mut budget).map(|tally| tally.configuration)
}

use crate::{server::http::AppState, types::SessionInfo};
use axum::body::Bytes;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a completed scan's payloads are served before a refresh is due.
/// The client polls every 3 s; a poll that finds the index past TTL is
/// served the STALE payload immediately and spawns exactly one background
/// refresh (SWR) — the poll never waits for the 134 ms scan.
const TTL: Duration = Duration::from_secs(3);
/// Minimum gap between two scan starts (`trigger_refresh` producers only —
/// the poll path keeps its own TTL logic). 750 ms: under the ~1 s threshold
/// at which a chip change still reads as instant (the whole reason the
/// `__sessions__` socket exists), above the herdr poller's 1 s sampling
/// floor so oracle resolution is not degraded, and capping scan duty at
/// ~18% of one worker instead of ~100% during a turn.
const MIN_INTERVAL: Duration = Duration::from_millis(750);

/// Byte budget for the per-query payload cache (the default "" listing is
/// always resident and exempt). A phone typing into a search box creates one
/// entry per keystroke, and a broad query's payload approaches the size of
/// the whole listing — so the query cache is bounded by BYTES, not count:
/// a handful of single-char queries must not accumulate megabytes, while
/// dozens of narrow ones stay cached. Eviction is FIFO (oldest query first)
/// because a search box only ever cares about the latest keystroke.
const MAX_QUERY_CACHE_BYTES: usize = 8 * 1024 * 1024;
/// Session pages are bounded; callers that need the archive walk the cursor.
pub const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 50;
const MAX_PINNED_PATHS: usize = 50;

/// Total-order key of the final row on a page. Store float bits so cursors are
/// hashable and preserve the same comparison semantics across refreshes.
#[derive(Clone, Debug, Eq, Hash, PartialEq, serde::Deserialize, serde::Serialize)]
struct PageCursor {
    active_at: u64,
    path: String,
    project: Option<String>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, serde::Deserialize, serde::Serialize)]
struct ListingKey {
    q: String,
    project: Option<String>,
    limit: usize,
    cursor: Option<PageCursor>,
    pinned: Vec<String>,
    include_live: bool,
}

impl ListingKey {
    fn default_page() -> Self {
        Self {
            q: String::new(),
            project: None,
            limit: DEFAULT_PAGE_SIZE,
            cursor: None,
            pinned: Vec::new(),
            include_live: true,
        }
    }

    fn is_default(&self) -> bool {
        self == &Self::default_page()
    }

    fn cache_key(&self) -> String {
        if self.is_default() {
            String::new()
        } else {
            serde_json::to_string(self).expect("listing cache key serializes")
        }
    }
}

/// Request options for one bounded page. Pins/live are first-page inclusions;
/// cursor pages then walk the complete matching archive.
fn listing_key_from_cache_key(key: &str) -> ListingKey {
    if key.is_empty() {
        ListingKey::default_page()
    } else {
        serde_json::from_str(key).expect("listing cache key deserializes")
    }
}

pub struct ListingRequest {
    pub q: String,
    pub project: Option<String>,
    pub limit: usize,
    pub cursor: Option<String>,
    pub pinned: Vec<String>,
    pub include_live: bool,
}

pub enum ListingError {
    InvalidCursor,
    Worker(tokio::task::JoinError),
}

impl From<tokio::task::JoinError> for ListingError {
    fn from(error: tokio::task::JoinError) -> Self {
        Self::Worker(error)
    }
}

/// One query's serialized listing: the payload and its content-addressed
/// strong ETag. `Bytes` owns the original `Arc<str>` allocation, so response
/// clones share one copy without materializing a `String`.
#[derive(Clone)]
struct ListingEntry {
    payload: Bytes,
    etag: String,
}

/// `Bytes` needs a byte-slice owner; keep the serialized string's allocation
/// alive instead of copying its bytes into a new body buffer.
struct ListingPayload(Arc<str>);

impl AsRef<[u8]> for ListingPayload {
    fn as_ref(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

fn make_entry(payload: Arc<str>, project: Option<&str>) -> Arc<ListingEntry> {
    let etag = etag_for(&payload, project);
    Arc::new(ListingEntry {
        payload: Bytes::from_owner(ListingPayload(payload)),
        etag,
    })
}

/// The whole index. `rows` is the enriched snapshot from the latest scan,
/// shared by every query (one scan per refresh — the expensive part is the
/// scan, not the serialization); `entries` holds one serialized payload per
/// normalized query string.
struct Inner {
    rows: Option<Arc<Vec<SessionInfo>>>,
    entries: HashMap<String, Arc<ListingEntry>>,
    /// FIFO eviction queue: insertion order of the NON-default query keys
    /// (the default "" listing is exempt from the budget and never queued).
    order: VecDeque<String>,
    /// Total payload+etag bytes of the non-default entries, so the budget is
    /// enforced on bytes, not entry count.
    query_bytes: usize,
    /// Lifetime count of budget evictions (observable via stats()).
    evictions: u64,
    /// When the latest scan completed; TTL is measured from here.
    refreshed: Instant,
    projects_expire: Option<Instant>,
    /// A background refresh is in flight — spawn at most one at a time.
    refreshing: bool,
    /// A trigger arrived while refreshing or inside the interval: run once
    /// more when the worker frees (leading+trailing — the last change of a
    /// turn must never be dropped into a stale chip).
    pending: bool,
    /// A trailing timer is already armed — at most one sleeper per interval.
    timer_armed: bool,
    /// A session file or child/herdr state changed since the latest scan
    /// began. [`trigger_refresh`] records it even with no listing socket
    /// attached (while a chat is open the phone has none), so the cached
    /// payloads are known to be out of date and the next poll waits for a
    /// refresh instead of being answered with the old listing for a whole
    /// TTL: Back from a chat showed the previous preview for ~6 s.
    changed: bool,
    // Observability for /api/status.
    refreshes: u64,
    hits_304: u64,
    served: u64,
    last_scan_ms: f64,
}

/// TTL while change nudges are live: the discovery watch is armed AND a
/// `/ws/sessions` client is attached, so every session-file create/append/
/// remove and every child or herdr state change already refreshes the index
/// through [`trigger_refresh`]. The poll-driven refresh then only catches what
/// has no event (a desktop process opening or closing a session file), and
/// re-running the scan on every 3 s poll took 222 ms per scan measured
/// on the phone (/proc sweep, fd readlinks, header parse), each syscall also
/// trapped by proot.
const NUDGED_TTL: Duration = Duration::from_secs(15);

/// Set once the recursive discovery watch on the sessions root is armed.
static DISCOVERY_LIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn ttl(discovery_live: bool, sessions_clients: usize) -> Duration {
    if discovery_live && sessions_clients > 0 {
        NUDGED_TTL
    } else {
        TTL
    }
}

fn is_stale(inner: &Inner) -> bool {
    let ttl = ttl(
        DISCOVERY_LIVE.load(std::sync::atomic::Ordering::Relaxed),
        sessions_clients(),
    );
    inner.refreshed.elapsed() >= ttl
        || inner
            .projects_expire
            .is_some_and(|deadline| Instant::now() >= deadline)
}

fn sessions_clients() -> usize {
    SESSIONS_HUB
        .get()
        .map_or(0, |h| h.client_count("__sessions__"))
}

static INDEX: Mutex<Option<Inner>> = Mutex::new(None);

/// Woken whenever a background refresh finishes (or gives up), so a poll
/// waiting on a known change re-reads the index.
static REFRESHED: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// Longest a poll waits for the refresh a known change needs (one scan took
/// 222 ms on the phone); past it the poll is served the cached listing.
const CHANGE_WAIT: Duration = Duration::from_secs(2);

/// Mark a refresh as started. The scan reads the files after this, so it
/// covers every change recorded before; later ones set `changed` again.
fn begin_refresh(inner: &mut Inner) {
    inner.refreshing = true;
    inner.changed = false;
}

/// How a poll treats a recorded change: `None` serves the cache as usual,
/// `Some(true)` starts a refresh and waits for it, `Some(false)` waits for
/// the one already running. Without rows the cold scan owns the first build.
fn change_refresh(inner: &mut Inner) -> Option<bool> {
    if !inner.changed || inner.rows.is_none() {
        return None;
    }
    if inner.refreshing {
        return Some(false);
    }
    begin_refresh(inner);
    Some(true)
}

static SESSIONS_HUB: std::sync::OnceLock<std::sync::Arc<crate::server::ws::WsHub>> =
    std::sync::OnceLock::new();

pub fn set_sessions_hub(hub: std::sync::Arc<crate::server::ws::WsHub>) {
    let _ = SESSIONS_HUB.set(hub);
}

fn notify_sessions_clients(etag: &str) {
    if let Some(hub) = SESSIONS_HUB.get() {
        hub.broadcast(
            "__sessions__",
            &serde_json::json!({"type": "sessions", "etag": etag}).to_string(),
        );
    }
}

/// What one listing request resolves to.
pub enum Listing {
    /// The client's validator matched the current payload: serve 304 with an
    /// empty body (the poll just went from 1.87 MB to ~0 bytes).
    NotModified { etag: String },
    /// The serialized payload plus its strong ETag.
    Payload { body: Bytes, etag: String },
}

/// Serve one listing request. Cache hits and validator handling stay
/// synchronous; cold scans and uncached query serialization run on Tokio's
/// blocking pool.
pub async fn listing(
    state: &Arc<AppState>,
    request: ListingRequest,
    validator: Option<&str>,
) -> Result<Listing, ListingError> {
    let project = request.project.filter(|cwd| !cwd.is_empty());
    let cursor = match request.cursor.as_deref() {
        Some(token) => {
            let cursor = decode_cursor(token).ok_or(ListingError::InvalidCursor)?;
            if cursor.project != project {
                return Err(ListingError::InvalidCursor);
            }
            Some(cursor)
        }
        None => None,
    };
    let limit = request.limit.clamp(1, MAX_PAGE_SIZE);
    let mut pinned = if cursor.is_none() {
        request
            .pinned
            .into_iter()
            .filter(|path| !path.is_empty() && path.len() <= 4096)
            .take(MAX_PINNED_PATHS)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    pinned.sort();
    pinned.dedup();
    let key = ListingKey {
        q: request.q.trim().to_lowercase(),
        project,
        limit,
        cursor,
        pinned,
        include_live: request.include_live && request.cursor.is_none(),
    };
    let entry = entry_for(state, key).await?;
    Ok(serve(&entry, validator))
}

/// Build the default first page in the background after the listener binds.
pub async fn warm_default(state: &Arc<AppState>) -> Result<(), tokio::task::JoinError> {
    entry_for(state, ListingKey::default_page()).await?;
    Ok(())
}

/// Serialises cold scans. The startup warm and the phone's reconnect race on
/// every restart; without this each ran the full multi-second scan.
static COLD_SCAN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn entry_for(
    state: &Arc<AppState>,
    key: ListingKey,
) -> Result<Arc<ListingEntry>, tokio::task::JoinError> {
    let cache_key = key.cache_key();
    let t0 = Instant::now();

    // A recorded change outdates every cached payload: wait (bounded) for
    // the refresh it needs rather than serving the old listing. The waiter is
    // registered under the lock, before the refresh can finish and notify.
    let after_change = {
        let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
        g.as_mut().and_then(|inner| {
            let start = change_refresh(inner)?;
            let refreshed = REFRESHED.notified();
            if start {
                spawn_refresh(state);
            }
            Some(refreshed)
        })
    };
    if let Some(refreshed) = after_change {
        let _ = tokio::time::timeout(CHANGE_WAIT, refreshed).await;
    }

    enum Step {
        Serve(Arc<ListingEntry>),
        Serialize(Arc<Vec<SessionInfo>>),
        ColdScan,
    }
    // The decision block holds the lock only for the lookup + flags; nothing
    // slow (scan, serialize) ever runs under it.
    let step = {
        let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
        let inner = g.get_or_insert_with(|| Inner {
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
        });
        match inner.entries.get(&cache_key).map(Arc::clone) {
            Some(e) => {
                // Fresh entry → serve. Stale entry → serve it anyway (SWR)
                // and start exactly one background refresh.
                if is_stale(inner) && !inner.refreshing {
                    begin_refresh(inner);
                    spawn_refresh(state);
                }
                Step::Serve(e)
            }
            None => match inner.rows.as_ref().map(Arc::clone) {
                // This query was never serialized, but a scan exists: build
                // the payload from the current rows (the expensive part is
                // already done). Kick a refresh too when the rows are stale.
                Some(rows) => {
                    if is_stale(inner) && !inner.refreshing {
                        begin_refresh(inner);
                        spawn_refresh(state);
                    }
                    Step::Serialize(rows)
                }
                // First request ever: move the old 134 ms cold path off the
                // Tokio worker so it stays available for HTTP and socket work.
                None => Step::ColdScan,
            },
        }
    };

    match step {
        Step::Serve(entry) => Ok(entry),
        Step::Serialize(rows) => {
            let projection_state = Arc::clone(state);
            let key_for_task = key.clone();
            let entry = tokio::task::spawn_blocking(move || {
                make_entry(
                    serialize_listing(&projection_state, &rows, &key_for_task),
                    key_for_task.project.as_deref(),
                )
            })
            .await?;
            insert_if_absent(&cache_key, &entry);
            Ok(entry)
        }
        Step::ColdScan => {
            let _cold = COLD_SCAN.lock().await;
            // Whoever held the lock may have just built this entry.
            let built = {
                let g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
                g.as_ref()
                    .and_then(|inner| inner.entries.get(&cache_key).map(Arc::clone))
            };
            if let Some(entry) = built {
                return Ok(entry);
            }
            {
                // The scan below reads the files after this point.
                let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(inner) = g.as_mut() {
                    inner.changed = false;
                }
            }
            let children = Arc::clone(&state.children);
            let collab = Arc::clone(&state.collab);
            let cfg = Arc::clone(&state.cfg);
            let key_for_task = key.clone();
            let projection_state = Arc::clone(state);
            let (rows, entry) = tokio::task::spawn_blocking(move || {
                let rows = Arc::new(scan(&children, &collab, &cfg));
                let payload = serialize_listing(&projection_state, &rows, &key_for_task);
                (rows, make_entry(payload, key_for_task.project.as_deref()))
            })
            .await?;
            // Scope the guard: `serve` bumps a counter, which locks INDEX
            // again, and this Mutex is NOT reentrant — holding `g` across that
            // call deadlocked every /api/sessions request outright.
            let drain_pending = {
                let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(inner) = g.as_mut() {
                    inner.projects_expire = next_project_expiry(rows.as_slice(), now_epoch_ms());
                    inner.rows = Some(rows);
                    insert_entry(inner, &cache_key, Arc::clone(&entry));
                    inner.refreshed = Instant::now();
                    inner.refreshing = false;
                    inner.refreshes += 1;
                    inner.last_scan_ms = t0.elapsed().as_secs_f64() * 1000.0;
                    std::mem::replace(&mut inner.pending, false)
                } else {
                    false
                }
            };
            if drain_pending {
                trigger_refresh(state);
            }
            Ok(entry)
        }
    }
}

/// Serve an entry against the client's validator and bump the matching
/// counter. The etag is content-addressed, so "matches" is an honest
/// statement about the payload we are serving.
fn serve(entry: &ListingEntry, validator: Option<&str>) -> Listing {
    if validator.is_some_and(|v| validator_matches(v, &entry.etag)) {
        bump(|i| i.hits_304 += 1);
        Listing::NotModified {
            etag: entry.etag.clone(),
        }
    } else {
        bump(|i| i.served += 1);
        Listing::Payload {
            body: entry.payload.clone(),
            etag: entry.etag.clone(),
        }
    }
}

fn bump(f: impl FnOnce(&mut Inner)) {
    if let Ok(mut g) = INDEX.lock()
        && let Some(i) = g.as_mut()
    {
        f(i);
    }
}

/// Insert a serialized entry only when none exists yet. A concurrent refresh
/// may have re-serialized this query from fresher rows while we were
/// serializing from older ones — ours would be a regression, so never
/// overwrite. (The entry we serve either way is self-consistent: payload and
/// etag come from the same bytes.)
fn insert_if_absent(key: &str, entry: &Arc<ListingEntry>) {
    let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(inner) = g.as_mut()
        && !inner.entries.contains_key(key)
    {
        insert_entry(inner, key, Arc::clone(entry));
    }
}

/// Insert or update a serialized entry, enforcing the query-cache byte
/// budget. A new key is queued FIFO and the oldest queries are evicted until
/// the budget fits again; an update (a refresh re-serialization) replaces the
/// payload WITHOUT moving the queue position — a query's recency is when the
/// user typed it, not when the scan last refreshed it. The default ""
/// listing is exempt from the budget entirely (it is the steady-state poll
/// payload, and `current_etag()` / `is_cached()` depend on it), so it is
/// never queued and can never be evicted. All callers hold the INDEX lock.
fn insert_entry(inner: &mut Inner, key: &str, entry: Arc<ListingEntry>) {
    if key.is_empty() {
        inner.entries.insert(key.to_string(), entry);
        return;
    }
    let bytes = entry.payload.len() + entry.etag.len();
    if let Some(old) = inner.entries.get(key) {
        inner.query_bytes = inner
            .query_bytes
            .saturating_sub(old.payload.len() + old.etag.len());
        inner.entries.insert(key.to_string(), entry);
        inner.query_bytes += bytes;
    } else {
        inner.entries.insert(key.to_string(), entry);
        inner.query_bytes += bytes;
        inner.order.push_back(key.to_string());
    }
    while inner.query_bytes > MAX_QUERY_CACHE_BYTES {
        // `order` holds only non-default keys, so the default listing cannot
        // be evicted here. A stale key (already removed) is skipped.
        let Some(k) = inner.order.pop_front() else {
            break;
        };
        if let Some(e) = inner.entries.remove(&k) {
            inner.query_bytes = inner
                .query_bytes
                .saturating_sub(e.payload.len() + e.etag.len());
            inner.evictions += 1;
        }
    }
}

/// One background SWR refresh: full scan, then re-serialize every query
/// currently in the index from the new rows and swap atomically. Both the
/// scan (directory walk, header parse, double `/proc` sweep, per-row tail
/// reads, sort — ~134 ms with no await point) and query serialization run on
/// the BLOCKING pool, never on a runtime worker: those run the WS pump and
/// every HTTP handler, and a refresh storm during a turn is exactly when the
/// phone needs frames on time. A panicking scan or serializer resets the flags
/// and skips the cycle instead of wedging `refreshing` true forever (which
/// would freeze the index, since every path checks that flag first).
fn spawn_refresh(state: &Arc<AppState>) {
    let projection_state = Arc::clone(state);
    let cfg = Arc::clone(&state.cfg);
    let state_again = Arc::clone(state);
    // Blocking-pool clones move into the scan worker; the originals are
    // retained for the later blocking serialization job.
    let bchildren = Arc::clone(&state.children);
    let bcollab = Arc::clone(&state.collab);
    let bcfg = Arc::clone(&cfg);
    tokio::spawn(async move {
        let t0 = Instant::now();
        let rows =
            match tokio::task::spawn_blocking(move || scan(&bchildren, &bcollab, &bcfg)).await {
                Ok(rows) => Arc::new(rows),
                Err(e) => {
                    tracing::error!(error = ?e, "listing scan panicked; skipping refresh cycle");
                    let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(inner) = g.as_mut() {
                        inner.refreshing = false;
                        inner.timer_armed = false;
                    }
                    drop(g);
                    REFRESHED.notify_waiters();
                    return;
                }
            };
        // Snapshot cache keys briefly; query-sized serialization must not run
        // on a runtime worker or while INDEX is locked.
        let keys: Vec<String> = {
            let g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
            g.as_ref()
                .map(|i| i.entries.keys().cloned().collect())
                .unwrap_or_default()
        };
        let rows_for_store = Arc::clone(&rows);
        let fresh = match tokio::task::spawn_blocking(move || {
            let mut fresh = Vec::with_capacity(keys.len());
            for cache_key in keys {
                let key = listing_key_from_cache_key(&cache_key);
                let payload = serialize_listing(&projection_state, &rows, &key);
                fresh.push((cache_key, make_entry(payload, key.project.as_deref())));
            }
            fresh
        })
        .await
        {
            Ok(fresh) => fresh,
            Err(e) => {
                tracing::error!(error = ?e, "listing serialization failed; skipping refresh cycle");
                let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(inner) = g.as_mut() {
                    inner.refreshing = false;
                    inner.timer_armed = false;
                }
                drop(g);
                REFRESHED.notify_waiters();
                return;
            }
        };
        let mut g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
        // Draining `pending` re-enters through `trigger_refresh`, which
        // re-applies the interval/audience rules — a burst during the scan
        // becomes exactly one trailing refresh, never a storm. `state_again`
        // was cloned outside the spawn; the lock is not held across the
        // re-entry (trigger takes and releases it synchronously).
        let (drain_pending, etag_to_notify) = if let Some(inner) = g.as_mut() {
            let changed_etag = changed_listing_etag(&inner.entries, &fresh);
            for (key, entry) in fresh {
                insert_entry(inner, &key, entry);
            }
            inner.projects_expire = next_project_expiry(rows_for_store.as_slice(), now_epoch_ms());
            inner.rows = Some(rows_for_store);
            inner.refreshed = Instant::now();
            inner.refreshing = false;
            inner.timer_armed = false;
            inner.refreshes += 1;
            inner.last_scan_ms = t0.elapsed().as_secs_f64() * 1000.0;
            // Any cached filter can be the phone's active view. A default-page
            // validator alone misses edits outside that page. Pending hints
            // may arrive after the scan passed a file, even on a no-op scan.
            let drain = std::mem::replace(&mut inner.pending, false);
            (drain, changed_etag)
        } else {
            (false, None)
        };
        drop(g);
        REFRESHED.notify_waiters();
        if drain_pending {
            trigger_refresh(&state_again);
        }
        if let Some(etag) = etag_to_notify {
            notify_sessions_clients(&etag);
        }
    });
}

/// Leading+trailing throttle core, pure over `Inner` so tests can drive it
/// without an AppState: a trigger while refreshing or inside the interval
/// marks `pending` (the trailing edge is never lost); the first within-
/// interval trigger also arms the single trailing timer.
#[derive(Debug, PartialEq, Eq)]
enum RefreshDecision {
    Spawn,
    Later(std::time::Duration),
    Drop,
}
fn refresh_decision(inner: &mut Inner) -> RefreshDecision {
    // Let the serialized cold scan establish the first snapshot. Discovery
    // remembers its hint rather than racing that scan with a second worker.
    if inner.rows.is_none() || inner.refreshing {
        inner.pending = true;
        return RefreshDecision::Drop;
    }
    if inner.refreshed.elapsed() < MIN_INTERVAL {
        inner.pending = true;
        if inner.timer_armed {
            RefreshDecision::Drop
        } else {
            inner.timer_armed = true;
            RefreshDecision::Later(MIN_INTERVAL - inner.refreshed.elapsed())
        }
    } else {
        begin_refresh(inner);
        inner.pending = false;
        inner.timer_armed = false;
        RefreshDecision::Spawn
    }
}

/// Strong ETag over the serialized representation and exact project scope.
fn etag_for(payload: &str, project: Option<&str>) -> String {
    let mut digest = Sha256::new();
    digest.update(project.unwrap_or("").as_bytes());
    digest.update([0]);
    digest.update(payload.as_bytes());
    let digest = digest.finalize();
    use std::fmt::Write as _;
    let mut etag = String::with_capacity(34);
    etag.push('"');
    for byte in digest.iter().take(16) {
        let _ = write!(etag, "{byte:02x}");
    }
    etag.push('"');
    etag
}

/// RFC 9110 `If-None-Match` matching: a comma-separated list of entity tags
/// (`"abc", W/"xyz"`), plus `*` for any current representation. We also
/// accept the `?since=<etag>` form where URL constraints may have stripped
/// the quotes — comparison strips `W/` and quotes from both sides, which is
/// the mandated weak comparison for If-None-Match anyway.
fn validator_matches(validator: &str, etag: &str) -> bool {
    fn strip(s: &str) -> &str {
        s.strip_prefix("W/").unwrap_or(s).trim().trim_matches('"')
    }
    let v = validator.trim();
    if v == "*" {
        return true;
    }
    v.split(',').any(|item| strip(item) == strip(etag))
}

/// The current ETag for the default (unfiltered) listing — what the phone's
/// 3 s poll revalidates against, and what the WS bundle carries so the
/// client's first poll already sends a validator.
pub fn current_etag() -> Option<String> {
    let g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
    g.as_ref()
        .and_then(|i| i.entries.get(""))
        .map(|e| e.etag.clone())
}

/// True once the default listing payload exists (feeds `/api/status`
/// `sessions_cached`, same semantics as the old cache flag).
pub fn is_cached() -> bool {
    let g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
    g.as_ref().is_some_and(|i| i.entries.contains_key(""))
}

/// Observability snapshot for `/api/status`: the current ETag plus the
/// refresh / 304 counters, so the whole design is observable from one place.
pub fn stats() -> Value {
    let g = INDEX.lock().unwrap_or_else(|p| p.into_inner());
    match g.as_ref() {
        Some(i) => json!({
            "etag": i.entries.get("").map(|e| e.etag.as_str()),
            "refreshes": i.refreshes,
            "hits_304": i.hits_304,
            "served": i.served,
            "last_scan_ms": i.last_scan_ms,
            "queries": i.entries.len(),
            "query_bytes": i.query_bytes,
            "query_cap_bytes": MAX_QUERY_CACHE_BYTES,
            "query_evictions": i.evictions,
        }),
        None => json!({
            "etag": Value::Null,
            "refreshes": 0,
            "hits_304": 0,
            "served": 0,
            "last_scan_ms": 0.0,
            "queries": 0,
            "query_bytes": 0,
            "query_cap_bytes": MAX_QUERY_CACHE_BYTES,
            "query_evictions": 0,
        }),
    }
}

#[cfg(test)]
mod tests;
