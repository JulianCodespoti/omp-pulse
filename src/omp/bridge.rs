//! Desktop event bridge: the desktop omp streams its OWN agent events here.
//!
//! Every interactive omp runs the omp-pulse extension
//! (`extensions/omp-pulse-control.ts`), which publishes a pid-keyed
//! descriptor under `state_dir/desktop-controls/` and serves `GET /events`: an
//! NDJSON stream of exactly the `AgentSessionEvent`s `omp --mode rpc` prints.
//! This module keeps one reader per live desktop process and republishes
//! those events into the router's child-event channel, so a turn typed on the
//! laptop reaches the phone through the SAME pipeline as a turn the daemon's
//! own RPC child runs: delta encoding, listing refresh, activity, the
//! completion buzz. No collab relay, no pty, no screen scraping, no inference
//! from the file tail.
//!
//! It is also the strongest ownership proof the daemon has: the descriptor is
//! written by the owning process itself, names the exact session file it has
//! open, and the stream's first line re-states it. `http::write_path` routes
//! phone prompts to a bridged session through the extension, which executes
//! them via omp's own API — the owner stays the only writer.
//!
//! Readers are plain threads doing blocking reads (one per desktop omp, a
//! handful at most); everything they learn is published through a lock held
//! for map operations only.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tokio::sync::{Notify, broadcast};

use crate::authority::session_state::{SourceIdentity, SourceKind, SourceStamp};
use crate::omp::desktop_control::{self, Descriptor};
use crate::server::http::AppState;
use crate::types::ChildEvent;

/// Dead-pid pruning interval while descriptors exist: a desktop omp that
/// crashed or was SIGKILLed never removes its descriptor and produces no
/// filesystem event, so only polling notices it. With no descriptors there
/// is nothing to prune and the reconciler parks on the directory watch.
const RESCAN: Duration = Duration::from_secs(5);
/// A descriptor whose stream refused us is not retried until it changes or
/// this passes: a crashed omp's leftover port may belong to anything now.
const RETRY_BACKOFF: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
// No response or body timeout: ureq applies `timeout_recv_response` to the
// body reads too, and a 5 s value tore the stream down every 5 s (each
// reconnect replayed the turn as lost + resumed). A dead desktop closes its
// socket, which ends the read; a merely quiet one is silent by design.
/// One event line: a `message_update` carries the whole assistant message,
/// which can hold large tool arguments. Longer lines are skipped, not
/// buffered: the phone recovers the content from the session file.
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
/// How long a closed stream counts as "reconnecting" rather than gone. The
/// desktop drops and re-opens the stream on its own (an idle-timed-out
/// socket, a session switch); within this window the phone sees nothing: the
/// turn is not ended and restarted, and writes still route to the owner.
/// Measured reconnects take 20-50 ms; a dead desktop is declared gone after
/// this, which only delays the "turn ended" signal of a crashed omp.
const RECONNECT_GRACE: Duration = Duration::from_secs(3);

#[derive(Clone)]
struct Link {
    session: String,
    streaming: bool,
    connected: bool,
    identity: SourceIdentity,
    sequence: u64,
    feedback: crate::omp::ui_feedback::Feedback,
}

#[derive(Default)]
struct Registry {
    /// pid -> bound session, present only while its stream is open.
    links: HashMap<i32, Link>,
    /// Current reader generation per pid, connecting or connected.
    active: HashMap<i32, Reader>,
    /// pid -> (descriptor identity, when it failed) for the retry backoff.
    failures: HashMap<i32, (String, Instant)>,
    /// session -> the link that just closed, while inside RECONNECT_GRACE.
    lost: HashMap<String, Lost>,
}

#[derive(Clone)]
struct Lost {
    pid: i32,
    at: Instant,
    streaming: bool,
    generation: u64,
}

#[derive(Clone)]
struct Reader {
    key: String,
    generation: u64,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static NEXT_BINDING_EPOCH: AtomicU64 = AtomicU64::new(1);

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|p| p.into_inner())
}

fn link_is_current(reg: &Registry, pid: i32, link: &Link) -> bool {
    link.connected
        && reg
            .active
            .get(&pid)
            .is_some_and(|reader| reader.generation == link.identity.source_id)
}
/// One-lock bridge authority snapshot for HTTP. Only an open stream bound to
/// the current reader generation is authoritative; reconnect grace is not a
/// connected source.
pub fn authority_snapshot(session: &str) -> Option<(SourceStamp, bool)> {
    let reg = registry();
    reg.links.iter().find_map(|(pid, link)| {
        (link.session == session && link_is_current(&reg, *pid, link)).then(|| {
            (
                SourceStamp {
                    identity: link.identity.clone(),
                    sequence: link.sequence,
                },
                link.streaming,
            )
        })
    })
}

/// Current owner feedback only; a dead/replaced desktop must not replay stale keys.
pub fn feedback_snapshot(session: &str) -> Option<Value> {
    let mut reg = registry();
    let pid = reg.links.iter().find_map(|(pid, link)| {
        (link.session == session && link_is_current(&reg, *pid, link)).then_some(*pid)
    })?;
    Some(
        reg.links
            .get_mut(&pid)?
            .feedback
            .snapshot(crate::authority::activity::now_ms()),
    )
}

/// The desktop pid driving session: a connected bridge, or one that closed
/// moments ago and is reconnecting. The owner's control endpoint does not
/// depend on the event stream, so a write routed to it during a reconnect is
/// delivered; treating the gap as no bridge refused it instead.
pub fn live_pid(session: &str) -> Option<i32> {
    let reg = registry();
    reg.links
        .iter()
        .find(|(pid, link)| link.session == session && link_is_current(&reg, **pid, link))
        .map(|(pid, _)| *pid)
        .or_else(|| {
            reg.lost
                .get(session)
                .filter(|l| l.at.elapsed() < RECONNECT_GRACE)
                .map(|l| l.pid)
        })
}

/// Whether the bridged desktop is mid-turn for session (a reconnecting
/// bridge keeps its last known state).
pub fn is_streaming(session: &str) -> bool {
    let reg = registry();
    reg.links.iter().any(|(pid, link)| {
        link.session == session && link.streaming && link_is_current(&reg, *pid, link)
    }) || reg
        .lost
        .get(session)
        .is_some_and(|l| l.streaming && l.at.elapsed() < RECONNECT_GRACE)
}

/// True only when a known owner is idle; absence is not evidence of idle.
pub(crate) fn is_idle(session: &str) -> bool {
    let reg = registry();
    let mut owned = false;
    for (_, link) in reg
        .links
        .iter()
        .filter(|(pid, link)| link.session == session && link_is_current(&reg, **pid, link))
    {
        if link.streaming {
            return false;
        }
        owned = true;
    }
    if let Some(lost) = reg
        .lost
        .get(session)
        .filter(|lost| lost.at.elapsed() < RECONNECT_GRACE)
    {
        if lost.streaming {
            return false;
        }
        owned = true;
    }
    owned
}

/// Every bridged session with its (pid, streaming), taken under ONE lock
/// for the listing scan. Reconnecting bridges are included so a routine
/// reconnect does not flip the listing's live/running chips.
pub fn live_sessions() -> HashMap<String, (i32, bool)> {
    let reg = registry();
    let mut out: HashMap<String, (i32, bool)> = reg
        .lost
        .iter()
        .filter(|(_, l)| l.at.elapsed() < RECONNECT_GRACE)
        .map(|(s, l)| (s.clone(), (l.pid, l.streaming)))
        .collect();
    out.extend(
        reg.links
            .iter()
            .filter(|(pid, link)| link_is_current(&reg, **pid, link))
            .map(|(pid, link)| (link.session.clone(), (*pid, link.streaming))),
    );
    out
}

fn descriptor_event(
    event: notify::Result<notify::Event>,
    dir: &std::path::Path,
    watching: &AtomicBool,
    wake: &Notify,
) {
    match event {
        Ok(event) => {
            if crate::sessions::watcher::is_open_event(&event) {
                return;
            }
            // Removing/replacing the watched directory invalidates its inode
            // watch. Keep rescanning so its replacement can publish work.
            if event.paths.iter().any(|path| path == dir)
                && matches!(
                    event.kind,
                    notify::EventKind::Remove(_)
                        | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                )
            {
                watching.store(false, Ordering::Relaxed);
            }
        }
        Err(error) => {
            tracing::warn!(%error, "desktop bridge watch lost; falling back to rescans");
            watching.store(false, Ordering::Relaxed);
        }
    }
    wake.notify_one();
}

/// Start the reconciler for daemon lifetime.
pub fn spawn(state: Arc<AppState>) {
    let dir = desktop_control::descriptor_dir(&state.cfg.state_dir);
    tokio::spawn(async move {
        // The extension creates the directory on first publish; creating it
        // here lets the watch start before any desktop omp ever ran.
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(path = %dir.display(), error = %e, "desktop bridge disabled: descriptor dir unavailable");
            return;
        }
        // INVARIANT: opens never wake the reconciler. notify's inotify mask
        // includes IN_OPEN, and `reconcile` opens this very directory (and
        // each descriptor in it), so waking on Access(Open) made every scan
        // schedule the next one 50 ms later: a 20 Hz loop of trapped opens
        // under proot on an idle phone with no desktop omp at all.
        let watching = Arc::new(AtomicBool::new(true));
        let watch_live = Arc::clone(&watching);
        let watched_dir = dir.clone();
        let _watcher = match notify::recommended_watcher(move |event| {
            descriptor_event(event, &watched_dir, &watch_live, &WAKE)
        }) {
            Ok(mut w) => {
                use notify::Watcher;
                match w.watch(&dir, notify::RecursiveMode::NonRecursive) {
                    Ok(()) => Some(w),
                    Err(e) => {
                        tracing::warn!(error = %e, "desktop bridge watch failed; falling back to rescans");
                        watching.store(false, Ordering::Relaxed);
                        Some(w)
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "desktop bridge watch failed; falling back to rescans");
                watching.store(false, Ordering::Relaxed);
                None
            }
        };
        // Without a watch only rescans can see a new descriptor, so the
        // rescan stays on whether or not descriptors exist.
        loop {
            let state_for_scan = Arc::clone(&state);
            let descriptors_remain =
                match tokio::task::spawn_blocking(move || reconcile(&state_for_scan)).await {
                    Ok(remain) => remain,
                    Err(e) => {
                        tracing::warn!(error = %e, "desktop bridge reconcile panicked");
                        true
                    }
                };
            wait_for_change(
                &WAKE,
                descriptors_remain || !watching.load(Ordering::Relaxed),
            )
            .await;
        }
    });
}

/// Wait for the next reconcile. The 5 s rescan used to run forever, so a
/// phone that never had a desktop omp still woke (and paid a proot-trapped
/// directory read) every 5 s, keeping it from sleeping. Now it only runs
/// while `rescan` (descriptors exist, so dead pids need pruning, or the
/// watch is unavailable); otherwise the directory watch is the only wake.
/// `notify_one` stores a permit, so a descriptor published between the
/// scan and this wait still wakes it.
async fn wait_for_change(wake: &Notify, rescan: bool) {
    let woken = if rescan {
        tokio::select! {
            _ = tokio::time::sleep(RESCAN) => false,
            _ = wake.notified() => true,
        }
    } else {
        wake.notified().await;
        true
    };
    if woken {
        // Coalesce the burst a single atomic publish produces
        // (temp create, rename, modify) into one reconcile.
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn identity(d: &Descriptor) -> String {
    format!("{}:{}:{}", d.port, d.token, d.session_path)
}

/// Bring readers in line with the descriptors on disk: prune files left by
/// dead processes, start a reader for every live, bridge-capable desktop
/// that has none. Returns whether any live descriptor remains, which keeps
/// the dead-pid rescan running.
fn reconcile(state: &Arc<AppState>) -> bool {
    let descriptors = desktop_control::read_descriptors(&state.cfg.state_dir);
    if descriptors.is_empty() {
        return false;
    }
    let pids: Vec<Pid> = descriptors
        .iter()
        .map(|(_, d)| Pid::from_u32(d.pid as u32))
        .collect();
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing(),
    );
    let ours = state.children.live_pids();
    let me = std::process::id() as i32;
    let mut live = false;
    for (path, descriptor) in descriptors {
        if sys.process(Pid::from_u32(descriptor.pid as u32)).is_none() {
            // A crashed or SIGKILLed omp never removed its descriptor (329 of
            // them had accumulated on one development machine). Its port and
            // token are dead weight at best and someone else's port at worst.
            let _ = std::fs::remove_file(&path);
            registry().failures.remove(&descriptor.pid);
            continue;
        }
        live = true;
        if !descriptor.has("events") || descriptor.pid == me || ours.contains(&descriptor.pid) {
            continue;
        }
        let key = identity(&descriptor);
        let pid = descriptor.pid;
        let process_start =
            crate::authority::session_state::process_start_time(pid).or_else(|| {
                sys.process(Pid::from_u32(pid as u32))
                    .map(|process| process.start_time())
                    .filter(|start| *start != 0)
            });
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let superseded = {
            let mut reg = registry();
            if reg.active.get(&pid).is_some_and(|reader| reader.key == key) {
                continue;
            }
            if let Some((failed_key, at)) = reg.failures.get(&pid)
                && *failed_key == key
                && at.elapsed() < RETRY_BACKOFF
            {
                continue;
            }
            let previous = reg.active.insert(
                pid,
                Reader {
                    key: key.clone(),
                    generation,
                },
            );
            let old_link = previous.and_then(|reader| {
                reg.links
                    .remove(&pid)
                    .filter(|link| link.identity.source_id == reader.generation)
            });
            old_link.map(|link| {
                let at = Instant::now();
                let reconnecting_same_session = link.session == descriptor.session_path;
                if reconnecting_same_session {
                    reg.lost.insert(
                        link.session.clone(),
                        Lost {
                            pid,
                            at,
                            streaming: link.streaming,
                            generation: link.identity.source_id,
                        },
                    );
                } else {
                    reg.lost.remove(&link.session);
                }
                (link, at, reconnecting_same_session)
            })
        };
        if let Some((link, at, reconnecting_same_session)) = superseded {
            announce_bridge_lost(
                state,
                &state.children.event_sender(),
                pid,
                link,
                at,
                reconnecting_same_session,
            );
        }
        let state = Arc::clone(state);
        // Readers block on a socket, so they are OS threads — but listing
        // refreshes spawn tokio tasks, which panics outside a runtime context
        // (observed: "there is no reactor running" from index.rs). Carry the
        // runtime in with them.
        let runtime = tokio::runtime::Handle::current();
        let spawned = std::thread::Builder::new()
            .name(format!("bridge-{pid}"))
            .spawn(move || {
                let _entered = runtime.enter();
                run_reader(state, descriptor, key, generation, process_start);
            });
        if let Err(e) = spawned {
            let mut reg = registry();
            if reg
                .active
                .get(&pid)
                .is_some_and(|reader| reader.generation == generation)
            {
                reg.active.remove(&pid);
            }
            tracing::warn!(error = %e, "desktop bridge: cannot start reader thread");
        }
    }
    live
}

enum StreamEnd {
    /// Never connected, or the stream was not a bridge for this session.
    Refused(String),
    /// Connected and later closed (session switch, omp exit, error).
    Closed(String),
}

fn run_reader(
    state: Arc<AppState>,
    descriptor: Descriptor,
    key: String,
    generation: u64,
    process_start: Option<u64>,
) {
    let pid = descriptor.pid;
    let tx = state.children.event_sender();
    let end = stream_events(&state, &descriptor, &tx, generation, process_start);
    let disconnected = {
        let mut reg = registry();
        let current = reg
            .active
            .get(&pid)
            .is_some_and(|reader| reader.generation == generation);
        let link = if current {
            reg.active.remove(&pid);
            match &end {
                StreamEnd::Refused(_) => {
                    reg.failures.insert(pid, (key, Instant::now()));
                }
                StreamEnd::Closed(_) => {
                    reg.failures.remove(&pid);
                }
            }
            reg.links
                .remove(&pid)
                .filter(|link| link.identity.source_id == generation)
        } else if reg
            .links
            .get(&pid)
            .is_some_and(|link| link.identity.source_id == generation)
        {
            // A superseded reader may clean up only its own stale link.
            reg.links.remove(&pid);
            None
        } else {
            None
        };
        link.map(|link| {
            let at = Instant::now();
            reg.lost.insert(
                link.session.clone(),
                Lost {
                    pid,
                    at,
                    streaming: link.streaming,
                    generation,
                },
            );
            (link, at)
        })
    };
    match end {
        StreamEnd::Refused(why) => {
            tracing::debug!(pid, reason = %why, "desktop bridge refused");
        }
        StreamEnd::Closed(why) => {
            tracing::debug!(pid, reason = %why, "desktop bridge closed");
        }
    }
    if let Some((link, at)) = disconnected {
        announce_bridge_lost(&state, &tx, pid, link, at, true);
    }
    // A session switch closes the stream and republishes the descriptor;
    // reconnect now rather than on the next rescan.
    WAKE.notify_one();
}

fn announce_bridge_lost(
    state: &Arc<AppState>,
    tx: &broadcast::Sender<ChildEvent>,
    pid: i32,
    link: Link,
    at: Instant,
    reconnect_grace: bool,
) {
    let generation = link.identity.source_id;
    let session = link.session;
    let _ = tx.send(ChildEvent::Event {
        session: session.clone(),
        event: json!({"type": "extension_ui_snapshot", "requests": []}),
        source: Some(SourceStamp {
            identity: link.identity.clone(),
            sequence: link.sequence.saturating_add(1),
        }),
    });
    let _ = tx.send(ChildEvent::Event {
        session: session.clone(),
        event: json!({"type": "agent_end", "messages": [], "isTerminal": false, "bridgeLost": true}),
        source: Some(SourceStamp {
            identity: link.identity,
            sequence: link.sequence.saturating_add(2),
        }),
    });

    if !reconnect_grace {
        crate::authority::activity::end(&session);
        crate::sessions::index::trigger_refresh(state);
        return;
    }

    let state = Arc::clone(state);
    // Cleanup needs the runtime: an OS sleeper panicked in trigger_refresh
    // and left the entire listing permanently stuck in its refreshing state.
    tokio::spawn(async move {
        tokio::time::sleep(RECONNECT_GRACE).await;
        let expired = {
            let mut reg = registry();
            match reg.lost.get(&session) {
                Some(l) if l.at == at && l.generation == generation => reg.lost.remove(&session),
                _ => None,
            }
        };
        if expired.is_some() {
            tracing::info!(pid, session = %session, "desktop bridge gone");
            crate::authority::activity::end(&session);
            crate::sessions::index::trigger_refresh(&state);
        }
    });
}

fn reader_is_current(pid: i32, session: &str, generation: u64) -> bool {
    let reg = registry();
    reg.active
        .get(&pid)
        .is_some_and(|reader| reader.generation == generation)
        && reg.links.get(&pid).is_some_and(|link| {
            link.connected && link.session == session && link.identity.source_id == generation
        })
}

fn mark_disconnected(pid: i32, session: &str, generation: u64) {
    let mut reg = registry();
    if reg
        .active
        .get(&pid)
        .is_none_or(|reader| reader.generation != generation)
    {
        return;
    }
    if let Some(link) = reg.links.get_mut(&pid)
        && link.session == session
        && link.identity.source_id == generation
    {
        link.connected = false;
    }
}

fn closed_stream(pid: i32, session: &str, generation: u64, reason: String) -> StreamEnd {
    mark_disconnected(pid, session, generation);
    StreamEnd::Closed(reason)
}

fn next_source_stamp(pid: i32, session: &str, generation: u64) -> Option<SourceStamp> {
    let mut reg = registry();
    if reg
        .active
        .get(&pid)
        .is_none_or(|reader| reader.generation != generation)
    {
        return None;
    }
    let link = reg.links.get_mut(&pid)?;
    if link.session != session || !link.connected || link.identity.source_id != generation {
        return None;
    }
    link.sequence = link.sequence.saturating_add(1);
    Some(SourceStamp {
        identity: link.identity.clone(),
        sequence: link.sequence,
    })
}

fn emit_event(
    tx: &broadcast::Sender<ChildEvent>,
    pid: i32,
    session: &str,
    generation: u64,
    event: Value,
) -> bool {
    let Some(source) = next_source_stamp(pid, session, generation) else {
        return false;
    };
    let _ = tx.send(ChildEvent::Event {
        session: session.to_owned(),
        event,
        source: Some(source),
    });
    true
}

fn set_streaming(
    pid: i32,
    session: &str,
    generation: u64,
    streaming: &mut bool,
    value: bool,
) -> bool {
    let mut reg = registry();
    if reg
        .active
        .get(&pid)
        .is_none_or(|reader| reader.generation != generation)
    {
        return false;
    }
    let Some(link) = reg.links.get_mut(&pid) else {
        return false;
    };
    if !link.connected || link.session != session || link.identity.source_id != generation {
        return false;
    }
    link.streaming = value;
    *streaming = value;
    true
}

fn stream_events(
    state: &Arc<AppState>,
    descriptor: &Descriptor,
    tx: &broadcast::Sender<ChildEvent>,
    generation: u64,
    process_start: Option<u64>,
) -> StreamEnd {
    let agent = ureq::Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .http_status_as_error(false)
        .max_redirects(0)
        .proxy(None)
        .build()
        .new_agent();
    let url = format!("http://127.0.0.1:{}/events", descriptor.port);
    let response = match agent
        .get(&url)
        .header("Authorization", format!("Bearer {}", descriptor.token))
        .header("Accept", "application/x-ndjson")
        .call()
    {
        Ok(r) => r,
        Err(e) => return StreamEnd::Refused(format!("connect: {e}")),
    };
    if response.status() != 200 {
        return StreamEnd::Refused(format!("status {}", response.status()));
    }
    let mut reader = BufReader::new(response.into_body().into_reader());
    let mut line = Vec::new();

    // The legacy hello proves this stream belongs to the descriptor's session.
    let hello = match read_line_bounded(&mut reader, &mut line) {
        Ok(Some(true)) => serde_json::from_slice::<Value>(&line).ok(),
        _ => None,
    };
    let Some(hello) =
        hello.filter(|h| h.get("type").and_then(Value::as_str) == Some("bridge_hello"))
    else {
        return StreamEnd::Refused("no bridge_hello".to_string());
    };
    let session = hello
        .get("sessionPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if session != descriptor.session_path {
        return StreamEnd::Refused("stream bound to a different session".to_string());
    }
    let mut streaming = hello.get("isStreaming").and_then(Value::as_bool) == Some(true);
    let source_identity = SourceIdentity {
        kind: SourceKind::Bridge,
        source_id: generation,
        binding_epoch: NEXT_BINDING_EPOCH.fetch_add(1, Ordering::Relaxed),
        pid: Some(descriptor.pid),
        process_start,
        peer_id: None,
        room_id: None,
        can_write: Some(true),
    };
    let resumed = {
        let mut reg = registry();
        if reg
            .active
            .get(&descriptor.pid)
            .is_none_or(|active| active.generation != generation)
        {
            return StreamEnd::Closed("reader generation superseded".to_string());
        }
        reg.links.insert(
            descriptor.pid,
            Link {
                session: session.clone(),
                streaming,
                connected: true,
                identity: source_identity,
                sequence: 0,
                feedback: {
                    let mut feedback = crate::omp::ui_feedback::Feedback::default();
                    feedback.replace(
                        &hello["feedbackRequests"],
                        crate::authority::activity::now_ms(),
                    );
                    feedback
                },
            },
        );
        reg.lost.remove(&session)
    };
    let was_streaming = match &resumed {
        Some(lost) => {
            tracing::debug!(pid = descriptor.pid, %session, streaming, "desktop bridge reconnected");
            Some(lost.streaming)
        }
        None => {
            tracing::info!(pid = descriptor.pid, %session, streaming, "desktop bridge connected");
            None
        }
    };

    // INVARIANT: one writer per session file (omp rewrites it wholesale from
    // memory). A bridge must retire a daemon child before its events can affect
    // the session, and a superseded reader may not retire that writer.
    if !reader_is_current(descriptor.pid, &session, generation) {
        return StreamEnd::Closed("reader generation superseded".to_string());
    }
    if state.children.has_child(&session) {
        tracing::warn!(pid = descriptor.pid, %session,
            "desktop bridge connected to a session we host — shutting our writer down");
        let state = Arc::clone(state);
        let session = session.clone();
        tokio::spawn(async move { state.children.close(&session).await });
    }
    if was_streaming != Some(streaming) && reader_is_current(descriptor.pid, &session, generation) {
        // The bridge is now the session's live path; the collab tap must not
        // double-deliver alongside it, and the listing should say so at once.
        crate::sessions::index::trigger_refresh(state);
    }

    // A new source generation must re-establish connected state even after a
    // quick reconnect. Never represent an idle hello as a running turn.
    if streaming {
        if !emit_event(
            tx,
            descriptor.pid,
            &session,
            generation,
            json!({"type": "agent_start", "bridgeResumed": true}),
        ) {
            return StreamEnd::Closed("reader generation superseded".to_string());
        }
    } else if resumed.is_some()
        && !emit_event(
            tx,
            descriptor.pid,
            &session,
            generation,
            json!({"type": "agent_end", "messages": [], "isTerminal": false, "bridgeResumed": true}),
        )
    {
        return StreamEnd::Closed("reader generation superseded".to_string());
    }

    if let Some(snapshot) = feedback_snapshot(&session)
        && !emit_event(tx, descriptor.pid, &session, generation, snapshot)
    {
        return StreamEnd::Closed("reader generation superseded".to_string());
    }
    // An assistant message_update with no open message (joined mid-stream)
    // needs a message_start first, the same repair collab applies.
    let mut assistant_open = false;
    loop {
        match read_line_bounded(&mut reader, &mut line) {
            Ok(Some(true)) => {}
            Ok(Some(false)) => {
                tracing::warn!(%session, "desktop bridge: oversized event skipped");
                continue;
            }
            Ok(None) => {
                return closed_stream(
                    descriptor.pid,
                    &session,
                    generation,
                    "end of stream".to_string(),
                );
            }
            Err(e) => {
                return closed_stream(descriptor.pid, &session, generation, format!("read: {e}"));
            }
        }
        let Ok(event) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if !forward_event(
            tx,
            descriptor.pid,
            &session,
            generation,
            &mut streaming,
            &mut assistant_open,
            event,
        ) {
            return StreamEnd::Closed("reader generation superseded".to_string());
        }
    }
}

/// Apply one decoded owner event before publishing it to the shared pipeline.
fn forward_event(
    tx: &broadcast::Sender<ChildEvent>,
    pid: i32,
    session: &str,
    generation: u64,
    streaming: &mut bool,
    assistant_open: &mut bool,
    event: Value,
) -> bool {
    if !reader_is_current(pid, session, generation) {
        return false;
    }
    let etype = event.get("type").and_then(Value::as_str).unwrap_or("");
    if etype == "extension_ui_snapshot" {
        let snapshot = {
            let mut reg = registry();
            let Some(link) = reg.links.get_mut(&pid) else {
                return false;
            };
            if link.identity.source_id != generation || link.session != session || !link.connected {
                return false;
            }
            let now = crate::authority::activity::now_ms();
            link.feedback.replace(&event["requests"], now);
            link.feedback.snapshot(now)
        };
        return emit_event(tx, pid, session, generation, snapshot);
    }
    if etype == "extension_ui_request" {
        if crate::omp::ui_feedback::is_internal(&event) {
            return true;
        }
        let mut reg = registry();
        let Some(link) = reg.links.get_mut(&pid) else {
            return false;
        };
        if link.identity.source_id != generation || link.session != session || !link.connected {
            return false;
        }
        link.feedback
            .apply(&event, crate::authority::activity::now_ms());
    }
    let is_assistant = event
        .get("message")
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str)
        == Some("assistant");
    match etype {
        "bridge_ping" | "bridge_hello" | "" => return true,
        "agent_start" => {
            if !set_streaming(pid, session, generation, streaming, true) {
                return false;
            }
        }
        "agent_end" => {
            if event.get("isTerminal").and_then(Value::as_bool) != Some(false)
                && !set_streaming(pid, session, generation, streaming, false)
            {
                return false;
            }
        }
        "message_start" if is_assistant => *assistant_open = true,
        "message_end" if is_assistant => *assistant_open = false,
        "message_update" if is_assistant && !*assistant_open => {
            if let Some(message) = event.get("message")
                && !emit_event(
                    tx,
                    pid,
                    session,
                    generation,
                    json!({"type": "message_start", "message": message.clone()}),
                )
            {
                return false;
            }
            *assistant_open = true;
        }
        _ => {}
    }
    emit_event(tx, pid, session, generation, event)
}
/// Read one `\n`-terminated line into `buf` (terminator stripped).
/// `Ok(Some(true))` a line, `Ok(Some(false))` a line longer than
/// `MAX_LINE_BYTES` that was consumed and discarded, `Ok(None)` clean EOF.
fn read_line_bounded<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> io::Result<Option<bool>> {
    buf.clear();
    let mut overflow = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return Ok(if buf.is_empty() && !overflow {
                None
            } else {
                Some(!overflow)
            });
        }
        let (chunk, done) = match available.iter().position(|b| *b == b'\n') {
            Some(i) => (&available[..i], Some(i + 1)),
            None => (available, None),
        };
        if !overflow {
            if buf.len() + chunk.len() > MAX_LINE_BYTES {
                overflow = true;
                buf.clear();
            } else {
                buf.extend_from_slice(chunk);
            }
        }
        let consumed = done.unwrap_or(available.len());
        reader.consume(consumed);
        if done.is_some() {
            return Ok(Some(!overflow));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_identity(source_id: u64, pid: i32) -> SourceIdentity {
        SourceIdentity {
            kind: SourceKind::Bridge,
            source_id,
            binding_epoch: source_id,
            pid: Some(pid),
            process_start: Some(42),
            peer_id: None,
            room_id: None,
            can_write: Some(true),
        }
    }

    #[test]
    fn bridged_continuation_stays_running_until_terminal_owner_event() {
        let session = "/tmp/bridge-continuation.jsonl";
        let pid = -91236;
        let generation = 9_123_600;
        {
            let mut reg = registry();
            reg.active.insert(
                pid,
                Reader {
                    key: "continuation-test".into(),
                    generation,
                },
            );
            reg.links.insert(
                pid,
                Link {
                    session: session.into(),
                    streaming: false,
                    connected: true,
                    identity: test_identity(generation, pid),
                    sequence: 0,
                    feedback: crate::omp::ui_feedback::Feedback::default(),
                },
            );
        }
        let (tx, mut rx) = broadcast::channel(8);
        let mut streaming = false;
        let mut assistant_open = false;
        let wire = b"{\"type\":\"agent_start\"}\n\
            {\"type\":\"agent_end\",\"messages\":[],\"willContinue\":true,\"isTerminal\":false}\n\
            {\"type\":\"auto_compaction_start\",\"reason\":\"overflow\"}\n\
            {\"type\":\"auto_retry_start\",\"attempt\":1}\n\
            {\"type\":\"agent_end\",\"messages\":[],\"isTerminal\":true}\n";
        let mut reader = io::Cursor::new(wire);
        let mut line = Vec::new();
        for sequence in 1..=5 {
            assert_eq!(
                read_line_bounded(&mut reader, &mut line).unwrap(),
                Some(true)
            );
            let event: Value = serde_json::from_slice(&line).unwrap();
            assert!(forward_event(
                &tx,
                pid,
                session,
                generation,
                &mut streaming,
                &mut assistant_open,
                event.clone(),
            ));
            let ChildEvent::Event {
                session: emitted_session,
                event: emitted,
                source: Some(stamp),
            } = rx.try_recv().unwrap()
            else {
                panic!("expected a source-stamped bridge event");
            };
            assert_eq!(emitted_session, session);
            assert_eq!(emitted, event);
            assert_eq!(stamp.sequence, sequence);
            assert_eq!(stamp.identity.source_id, generation);
            crate::authority::activity::observe(session, &emitted);
            if sequence < 5 {
                assert!(streaming);
                assert!(is_streaming(session));
                assert!(!is_idle(session));
                assert!(!crate::authority::activity::current(session).is_null());
            } else {
                assert!(!streaming);
                assert!(is_idle(session));
                assert!(crate::authority::activity::current(session).is_null());
            }
        }
        assert!(rx.try_recv().is_err(), "no synthetic completion events");
        // A lost/superseded owner cannot end the turn or publish more events.
        mark_disconnected(pid, session, generation);
        assert!(!is_idle(session));
        assert!(!forward_event(
            &tx,
            pid,
            session,
            generation,
            &mut streaming,
            &mut assistant_open,
            json!({"type":"agent_end","isTerminal":true}),
        ));
        assert!(rx.try_recv().is_err());
        {
            let mut reg = registry();
            reg.links.remove(&pid);
            reg.active.remove(&pid);
        }
        crate::authority::activity::end(session);
    }

    #[test]
    fn idle_owner_overrules_stale_activity_without_expiring_live_turns() {
        let session = "/tmp/bridge-idle-activity.jsonl";
        let pid = -91234;
        let generation = 9_123_400;
        let token = json!({"type":"message_update", "message":{"role":"assistant"},
            "assistantMessageEvent":{"type":"text_delta"}});
        crate::authority::activity::observe(session, &token);
        assert_eq!(
            crate::authority::activity::current(session)["state"],
            "writing"
        );
        {
            let identity = test_identity(generation, pid);
            let mut reg = registry();
            reg.active.insert(
                pid,
                Reader {
                    key: "idle-test".into(),
                    generation,
                },
            );
            reg.links.insert(
                pid,
                Link {
                    session: session.into(),
                    streaming: false,
                    connected: true,
                    identity,
                    sequence: 0,
                    feedback: crate::omp::ui_feedback::Feedback::default(),
                },
            );
        }
        assert!(crate::authority::activity::current(session).is_null());
        crate::authority::activity::observe(session, &token);
        assert!(
            !crate::authority::activity::snapshot()
                .iter()
                .any(|(path, _)| path == session)
        );
        registry().links.get_mut(&pid).unwrap().streaming = true;
        crate::authority::activity::observe(session, &json!({"type":"agent_start"}));
        crate::authority::activity::observe(session, &token);
        assert_eq!(
            crate::authority::activity::current(session)["state"],
            "writing"
        );
        {
            let mut reg = registry();
            reg.links.remove(&pid);
            reg.active.remove(&pid);
            reg.lost.insert(
                session.into(),
                Lost {
                    pid,
                    at: Instant::now(),
                    streaming: true,
                    generation,
                },
            );
        }
        assert_eq!(
            crate::authority::activity::current(session)["state"],
            "writing"
        );
        registry().lost.get_mut(session).unwrap().streaming = false;
        assert!(crate::authority::activity::current(session).is_null());
        registry().lost.remove(session);
        crate::authority::activity::end(session);
    }

    #[test]
    fn authority_snapshot_requires_a_current_connected_generation() {
        let session = "/tmp/bridge-authority-snapshot.jsonl";
        let pid = -91235;
        let generation = 9_123_500;
        let identity = test_identity(generation, pid);
        {
            let mut reg = registry();
            reg.active.insert(
                pid,
                Reader {
                    key: "snapshot-test".into(),
                    generation,
                },
            );
            reg.links.insert(
                pid,
                Link {
                    session: session.into(),
                    streaming: true,
                    connected: true,
                    identity: identity.clone(),
                    sequence: 7,
                    feedback: crate::omp::ui_feedback::Feedback::default(),
                },
            );
        }

        let (stamp, streaming) = authority_snapshot(session).unwrap();
        assert_eq!(stamp.identity, identity);
        assert_eq!(stamp.sequence, 7);
        assert!(streaming);
        assert_eq!(
            next_source_stamp(pid, session, generation)
                .unwrap()
                .sequence,
            8
        );
        assert_eq!(authority_snapshot(session).unwrap().0.sequence, 8);
        assert!(authority_snapshot("/tmp/other-session.jsonl").is_none());

        {
            let mut reg = registry();
            reg.links.get_mut(&pid).unwrap().connected = false;
        }
        assert!(authority_snapshot(session).is_none());

        {
            let mut reg = registry();
            reg.links.get_mut(&pid).unwrap().connected = true;
            reg.active.get_mut(&pid).unwrap().generation = generation + 1;
        }
        assert!(authority_snapshot(session).is_none());
        assert!(next_source_stamp(pid, session, generation).is_none());

        let mut reg = registry();
        reg.links.remove(&pid);
        reg.active.remove(&pid);
    }

    #[test]
    fn feedback_replay_is_owner_scoped_filtered_and_authoritative() {
        let session = "/tmp/bridge-feedback.jsonl";
        let pid = -91239;
        let generation = 9_123_900;
        {
            let mut reg = registry();
            reg.active.insert(
                pid,
                Reader {
                    key: "feedback-test".into(),
                    generation,
                },
            );
            reg.links.insert(
                pid,
                Link {
                    session: session.into(),
                    streaming: false,
                    connected: true,
                    identity: test_identity(generation, pid),
                    sequence: 0,
                    feedback: crate::omp::ui_feedback::Feedback::default(),
                },
            );
        }
        let (tx, mut rx) = broadcast::channel(16);
        let mut streaming = false;
        let mut assistant_open = false;
        let status = json!({"type":"extension_ui_request","method":"setStatus","id":"owner-status","statusKey":"git","statusText":"main"});
        assert!(forward_event(
            &tx,
            pid,
            session,
            generation,
            &mut streaming,
            &mut assistant_open,
            status.clone()
        ));
        match rx.try_recv().unwrap() {
            ChildEvent::Event { event, .. } => assert_eq!(event, status),
            other => panic!("expected untouched feedback, got {other:?}"),
        }
        assert!(!streaming);
        assert_eq!(
            feedback_snapshot(session).unwrap()["requests"],
            json!([status])
        );
        assert!(feedback_snapshot("/tmp/unrelated-feedback.jsonl").is_none());
        assert!(forward_event(
            &tx,
            pid,
            session,
            generation,
            &mut streaming,
            &mut assistant_open,
            json!({"type":"extension_ui_request","method":"notify","message":"omp-pulse:secret","id":"hidden"})
        ));
        assert!(rx.try_recv().is_err());
        assert!(forward_event(
            &tx,
            pid,
            session,
            generation,
            &mut streaming,
            &mut assistant_open,
            json!({"type":"extension_ui_snapshot","requests":[]})
        ));
        assert_eq!(feedback_snapshot(session).unwrap()["requests"], json!([]));
        registry().links.get_mut(&pid).unwrap().connected = false;
        assert!(feedback_snapshot(session).is_none());
        assert!(!forward_event(
            &tx,
            pid,
            session,
            generation,
            &mut streaming,
            &mut assistant_open,
            json!({"type":"extension_ui_request","method":"notify","message":"late","id":"late"})
        ));
        let mut reg = registry();
        reg.links.remove(&pid);
        reg.active.remove(&pid);
    }

    #[tokio::test(start_paused = true)]
    async fn lost_descriptor_watch_wakes_a_parked_reconciler_and_enables_rescans() {
        let dir = std::path::Path::new("/synthetic/desktop-controls");
        let watching = AtomicBool::new(true);
        let wake = Notify::new();
        descriptor_event(
            Err(notify::Error::generic("watch lost")),
            dir,
            &watching,
            &wake,
        );
        assert!(!watching.load(Ordering::Relaxed));
        tokio::time::timeout(Duration::from_secs(1), wait_for_change(&wake, false))
            .await
            .expect("watch failure wakes the parked reconcile");
        tokio::time::timeout(RESCAN * 2, wait_for_change(&wake, true))
            .await
            .expect("fallback still finds a later descriptor without events");
        watching.store(true, Ordering::Relaxed);
        descriptor_event(
            Ok(
                notify::Event::new(notify::EventKind::Remove(notify::event::RemoveKind::Folder))
                    .add_path(dir.to_path_buf()),
            ),
            dir,
            &watching,
            &wake,
        );
        assert!(
            !watching.load(Ordering::Relaxed),
            "directory replacement loses its watch"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reconciler_parks_without_descriptors_until_the_directory_wakes_it() {
        use tokio::time::timeout;
        let wake = Notify::new();
        // No descriptors and a working watch: no rescan at all, however long.
        assert!(
            timeout(Duration::from_secs(3600), wait_for_change(&wake, false))
                .await
                .is_err()
        );
        // A descriptor published while the reconciler is between scans leaves
        // a permit, so the next wait returns and the reconcile runs.
        wake.notify_one();
        assert!(
            timeout(Duration::from_secs(1), wait_for_change(&wake, false))
                .await
                .is_ok()
        );
        // Descriptors present: dead-pid pruning still runs with no event.
        assert!(
            timeout(RESCAN * 2, wait_for_change(&wake, true))
                .await
                .is_ok()
        );
    }
    #[test]
    fn bounded_lines_split_skip_and_end_cleanly() {
        let long = "x".repeat(MAX_LINE_BYTES + 10);
        let input = format!("{{\"a\":1}}\n{long}\n{{\"b\":2}}\npartial");
        let mut reader = BufReader::with_capacity(4096, input.as_bytes());
        let mut buf = Vec::new();
        assert_eq!(
            read_line_bounded(&mut reader, &mut buf).unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"{\"a\":1}");
        // The oversized line is consumed whole and reported, not buffered.
        assert_eq!(
            read_line_bounded(&mut reader, &mut buf).unwrap(),
            Some(false)
        );
        assert!(buf.is_empty());
        assert_eq!(
            read_line_bounded(&mut reader, &mut buf).unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"{\"b\":2}");
        // A final unterminated line still counts; then clean EOF.
        assert_eq!(
            read_line_bounded(&mut reader, &mut buf).unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"partial");
        assert_eq!(read_line_bounded(&mut reader, &mut buf).unwrap(), None);
    }
}
