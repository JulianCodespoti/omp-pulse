//! The WebSocket endpoints: the per-session `/ws` stream, the sessions-list
//! socket and the self-hosted relay socket.

use super::*;
use crate::{
    server::assets, server::ws::ClientCaps, sessions::index, sessions::jsonl, types::Config,
};
use axum::{
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path as FsPath,
    sync::{Arc, Mutex},
    time::Duration,
};

const HISTORY_BACKWARD_DEFAULT: usize = 50;
const HISTORY_BACKWARD_MAX: usize = 200;

/// Parse the WS `caps` query parameter (`&caps=delta,defl,bundle`):
/// comma-separated capability tokens, unknown tokens ignored so the list
/// stays forward-compatible. A client that sends no `caps` gets every
/// legacy frame byte-identical (delta/deflate/bundle all off).
pub(super) fn parse_caps(raw: Option<&str>) -> ClientCaps {
    let mut caps = ClientCaps::default();
    let Some(raw) = raw else { return caps };
    for tok in raw.split(',') {
        match tok.trim() {
            "delta" => caps.delta = true,
            "defl" => caps.deflate = true,
            "bundle" => caps.bundle = true,
            _ => {} // unknown token — ignore, keep the rest
        }
    }
    caps
}

/// Raw DEFLATE (RFC 1951), no zlib/gzip wrapper — `DeflateEncoder` at the
/// default level 6 (measured: within 1% of level 9 on these payloads, see
/// docs/internals/performance.md F3). Browsers decode it natively via
/// `DecompressionStream('deflate-raw')`; the WS frame is `Message::Binary`
/// so it is never mistaken for text.
fn raw_deflate(data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    // Vec<u8> writes are infallible; the Result is only an API artifact.
    let _ = enc.write_all(data);
    enc.finish().unwrap_or_default()
}

/// First-screen bundle, sent as the ONE frame before anything else to clients
/// advertising `bundle`. It replaces the open + history + state + commands +
/// sessions-validator dance (6 requests ≈ 6 RTTs — on 150 ms cellular that
/// is most of a second) with a single frame. Built only from data that
/// already exists: the first history page comes from the file (never spawns
/// a child), `state` is included only when a child is already live
/// (`children.cached_state` is a registry lookup), the listing ETag lets the
/// client's first poll revalidate, and the ~51 KB command list is
/// deliberately omitted (a live child broadcasts it itself; a client that
/// needs it can still fetch /api/commands).
fn bundle_frame(state: &Arc<AppState>, session: &str, history_limit: usize) -> String {
    let mut history = json!({ "entries": [], "endOffset": 0, "fileSize": 0, "nextBefore": null });
    let path = FsPath::new(session);
    if path.is_file() {
        let br = jsonl::read_backward(path, None, history_limit);
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        history = json!({
            "entries": br.entries,
            // The read's own cursor, not `size`: see `BackwardRead::end_offset`.
            "endOffset": br.end_offset,
            "fileSize": size,
            // Load-bearing: the bundle is the ONLY history source on first
            // paint, and the client sets its paging cursor only when the
            // payload defines this field — dropping it silently disabled all
            // scroll-up paging (the reported "when I scroll up it just
            // stops": 19 rows and a hidden Load-earlier control while
            // /api/history correctly returned a cursor).
            "nextBefore": br.next_before,
        });
        let configuration = index::session_configuration(session);
        history["sessionModelPending"] = json!(configuration.is_none());
        if let Some(configuration) = configuration {
            history["sessionModel"] = json!(configuration);
        }
    }
    let state_json = match state.children.cached_state(session) {
        Some((session_name, model, message_count, streaming)) => json!({
            "sessionFile": session,
            "sessionName": session_name,
            "model": model,
            "messageCount": message_count,
            "streaming": streaming,
            // Same liveness rule as /api/open: registry membership alone once
            // reported a live badge over a link that could not carry a write.
            "collabAttached": state.collab.is_live(session),
        }),
        None => Value::Null,
    };
    let turn = turn_state(state, session);
    json!({
        "type": "bundle",
        "history": history,
        "state": state_json,
        "etag": index::current_etag(),
        // The daemon's own view of the running turn (null when idle), so the
        // chat header starts from the real turn clock and tool count.
        "now": turn.now,
        // The daemon's clock when this frame was built; the phone rebases
        // `now`'s daemon-clock times onto its own clock with it.
        "at": turn.at,
        "running": turn.running,
        "sessionState": turn.authority,
        // A turn the last shutdown (or a dead agent) cut off; null otherwise.
        "interrupted": turn.interrupted,
    })
    .to_string()
}

/// How long one frame may take to reach the socket before the client is
/// dropped. Android freezes a backgrounded WebView's renderer, which stops
/// it reading its WebSocket; the loopback send then blocks forever, the pump
/// never reaches its heartbeat (whose own 5 s bound only covers the heartbeat
/// send), and the hub keeps the client attached for the life of the daemon.
/// Observed on the phone: one such client's queue overflowed 15 times per
/// 10 s (566 resyncs) with zero frames delivered, every overflow a fresh
/// round of serialized frames buffered for nobody. A slow-but-live link
/// drains a deflated frame well inside this; a frozen one never does.
/// Dropping the client frees its queue, its watcher tail and its socket
/// buffers; the client's own stale-socket watchdog reconnects on resume and
/// refetches history, exactly as after a resync.
const WS_SEND_DEADLINE: Duration = Duration::from_secs(15);

/// One frame to the socket. Clients advertising `defl` get frames at or
/// above `cfg.ws_deflate_min` as raw-DEFLATE binary (measured: a 66 KB
/// bundle history page compresses ~50x); everyone else always gets text —
/// never binary to a client that did not advertise `defl`. `false` when the
/// send failed or missed [`WS_SEND_DEADLINE`]: the caller drops the client.
async fn send_frame<S>(sink: &mut S, caps: ClientCaps, cfg: &Config, text: Arc<str>) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    let frame = if caps.deflate && text.len() >= cfg.ws_deflate_min {
        Message::Binary(raw_deflate(text.as_bytes()).into())
    } else {
        Message::Text(text.to_string().into())
    };
    send_bounded(sink, frame, WS_SEND_DEADLINE).await
}

/// Send one message, giving up after `deadline`. `true` only when the sink
/// accepted it in time; every socket write goes through here so a client that
/// stops reading can never wedge its pump.
async fn send_bounded<S>(sink: &mut S, message: Message, deadline: Duration) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    matches!(
        tokio::time::timeout(deadline, sink.send(message)).await,
        Ok(Ok(()))
    )
}

pub(super) async fn ws_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let header_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer_token);
    let token = q.token.as_deref().or(header_token).unwrap_or("");
    let Some(context) = authenticate_token(&state, token) else {
        return err_status(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    if !context.role().can_stream() {
        return err_status(StatusCode::FORBIDDEN, "forbidden");
    }
    let Some(raw) = q.session.as_deref() else {
        return err_status(StatusCode::NOT_FOUND, "session file not found");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err_status(StatusCode::NOT_FOUND, "session file not found");
    };
    // The session file must exist; a live child is NOT required (viewing is
    // watcher-fed — the lazy-open change). Fresh /api/new sessions are
    // tolerated: the watcher picks the file up when omp materializes it.
    if !path.is_file() {
        let Ok(session) = session_str(&path) else {
            return err_status(StatusCode::NOT_FOUND, "session file not found");
        };
        if !is_recent_new(&session) {
            return err_status(StatusCode::NOT_FOUND, "session file not found");
        }
    }
    let Ok(session) = session_str(&path) else {
        return err_status(StatusCode::NOT_FOUND, "session file not found");
    };
    let caps = socket_caps(q.caps.as_deref(), &headers);
    let history_limit = backward_limit(q.limit.as_deref());
    ws.on_upgrade(move |socket| handle_ws(socket, state, session, caps, context, history_limit))
}

/// A backward history page size from a raw query value: absent, empty,
/// unparseable or zero means the default; anything larger is capped.
pub(super) fn backward_limit(raw: Option<&str>) -> usize {
    match raw.filter(|s| !s.is_empty()) {
        Some(l) => l
            .parse::<usize>()
            .ok()
            .filter(|n| *n >= 1)
            .unwrap_or(HISTORY_BACKWARD_DEFAULT)
            .min(HISTORY_BACKWARD_MAX),
        None => HISTORY_BACKWARD_DEFAULT,
    }
}
/// `GET /ws/sessions` — the listing's live nudge channel. The client holds
/// this socket from the sessions screen and refetches on every
/// `{"type":"sessions","etag"}` frame; without it the phone is pure 3 s
/// poll and mid-turn chip updates arrive late. Deliberately separate from
/// `/ws`: that socket is per-conversation (attach, watcher tail, prewarm,
/// collab auto-attach, bundle, pending dialogs) and NONE of that applies to
/// a channel key — attaching those sides to `__sessions__` would watch a
/// nonsense path and prewarm/collab against it. This pump is attach,
/// heartbeat (liveness + hub-slot pruning, same 20 s shape), forward, and
/// detach.
pub(super) async fn sessions_ws_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let header_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer_token);
    let token = q.token.as_deref().or(header_token).unwrap_or("");
    let Some(context) = authenticate_token(&state, token) else {
        return err_status(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    if !context.role().can_stream() {
        return err_status(StatusCode::FORBIDDEN, "forbidden");
    }
    let caps = socket_caps(q.caps.as_deref(), &headers);
    ws.on_upgrade(move |socket| handle_sessions_ws(socket, state, caps, context))
}

async fn handle_sessions_ws(
    socket: WebSocket,
    state: Arc<AppState>,
    caps: ClientCaps,
    context: AuthContext,
) {
    const CHANNEL: &str = "__sessions__";
    let (client_id, mut hub_rx) = state.hub.attach(CHANNEL.into(), caps);
    // Changes recorded while no listing socket was attached were only flagged
    // (discovery coalesces them for a second then); scan now so the etag that
    // follows is current, not whenever the client next polls.
    crate::sessions::index::refresh_on_attach(&state);
    let (mut sink, mut stream) = socket.split();
    // Current etag first: a just-connected client reconciles immediately
    // instead of sitting on an empty list until something moves.
    if let Some(etag) = crate::sessions::index::current_etag() {
        let frame: Arc<str> = json!({"type": "sessions", "etag": etag}).to_string().into();
        if context
            .device_id()
            .is_some_and(|id| state.devices.is_revoked(id))
            || !send_frame(&mut sink, caps, &state.cfg, frame).await
        {
            state.hub.detach(client_id);
            return;
        }
    }
    // Working sessions next, so a phone opening the list mid-turn sees what
    // each agent is doing now rather than after its next state change.
    for (path, now) in crate::authority::activity::snapshot() {
        let frame: Arc<str> = crate::authority::activity::sessions_frame(&path, &now).into();
        if !send_frame(&mut sink, caps, &state.cfg, frame).await {
            state.hub.detach(client_id);
            return;
        }
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if context
                    .device_id()
                    .is_some_and(|id| state.devices.is_revoked(id))
                {
                    break;
                }
                let frame = heartbeat_frame();
                if !send_bounded(&mut sink, Message::Text(frame), Duration::from_secs(5)).await {
                    break;
                }
            }
            incoming = hub_rx.recv() => {
                match incoming {
                    Some(text) => {
                        if context.device_id().is_some_and(|id| state.devices.is_revoked(id))
                            || !send_frame(&mut sink, caps, &state.cfg, text).await {
                            break;
                        }
                    }
                    None => break,
                }
            }
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
        }
    }
    state.hub.detach(client_id);
}

/// Serializes a session viewer's hub attach against the last viewer's
/// detach-and-unwatch. Without it a reconnecting socket could attach (and
/// watch) between the old socket seeing zero clients and its `unwatch`,
/// leaving a viewer whose session file nobody tails: a live transcript that
/// silently stops updating.
static SESSION_VIEWERS: Mutex<()> = Mutex::new(());

/// Attach a `/ws` viewer to `session` and make sure its file is tailed.
fn attach_viewer(
    state: &AppState,
    session: &str,
    caps: ClientCaps,
) -> (crate::server::ws::ClientId, crate::server::ws::ClientRx) {
    let attached = {
        let _viewers = SESSION_VIEWERS.lock().unwrap_or_else(|p| p.into_inner());
        state.hub.attach(session.to_owned(), caps)
    };
    // INVARIANT: outside the lock is safe because the attach above is
    // visible to any detach that runs after it, so no later `unwatch` can
    // see zero clients until this viewer leaves; `watch` does file I/O.
    state.watcher.watch(session);
    attached
}

/// Detach a `/ws` viewer; the last one out stops tailing the session file.
fn detach_viewer(state: &AppState, client_id: crate::server::ws::ClientId, session: &str) {
    let _viewers = SESSION_VIEWERS.lock().unwrap_or_else(|p| p.into_inner());
    state.hub.detach(client_id);
    if state.hub.client_count(session) == 0 {
        state.watcher.unwatch(session);
    }
}

async fn handle_ws(
    socket: WebSocket,
    state: Arc<AppState>,
    session: String,
    caps: ClientCaps,
    context: AuthContext,
    history_limit: usize,
) {
    let (client_id, mut hub_rx) = attach_viewer(&state, &session, caps);
    // Capture before the first await: subsequent live frames queue behind this
    // authoritative replay rather than a slow history bundle's newer snapshot.
    let feedback = crate::omp::bridge::feedback_snapshot(&session)
        .unwrap_or_else(|| state.children.feedback_snapshot(&session));
    let collab_questions = crate::omp::collab::collab_ui_snapshot(&session);
    // PRE-WARM on socket attach — gated behind cfg.prewarm_on_attach
    // (default false): merely ATTACHING a socket must not cost a ~281 MiB
    // child (measured F1/F8 in docs/internals/performance.md). The phone signals intent
    // explicitly via POST /api/prewarm on composer focus instead. Set
    // OMP_REMOTE_PREWARM_ON_ATTACH=1 to restore the old eager behavior.
    // Same exemptions as /api/open: a live collab path needs no child of
    // ours, a stored collab link means the host path is the likely route,
    // and a session a terminal owns must not get a second writer.
    if state.cfg.prewarm_on_attach
        && !state.collab.is_attached(&session)
        && !state.relay.is_attached(&session)
        && !state.children.has_child(&session)
        && state.collab.stored_link(&session).is_none()
    {
        let children = Arc::clone(&state.children);
        let warm = session.clone();
        tokio::spawn(async move {
            if let Err(e) = children.open(&warm).await {
                tracing::debug!(session = %warm, error = %e, "ws pre-warm skipped");
            }
        });
    }
    // Best-effort auto-attach: a session with a stored or announced collab
    // link that is not attached yet gets a background attach attempt. Skipped
    // when the relay tap already streams this session — the tap and a
    // redundant guest must not both run. Failures are log-only (info) —
    // viewing must never break on collab trouble.
    if !state.collab.is_attached(&session) && !state.relay.is_attached(&session) {
        let session_id = jsonl::parse_header(std::path::Path::new(&session)).id;
        if let Some(link) = state
            .collab
            .auto_attach_link(&session, session_id.as_deref())
        {
            let collab = Arc::clone(&state.collab);
            let s = session.clone();
            tokio::spawn(async move {
                if let Err(e) = collab.attach(&s, &link).await {
                    tracing::info!(%s, error = %e, "auto collab attach failed");
                }
            });
        }
    }
    let (mut sink, mut stream) = socket.split();
    // First-screen bundle BEFORE the pump loop starts: the hub's receiver
    // queues everything broadcast after attach, so this is guaranteed to be
    // the first frame the client sees. A vanished client is pruned right
    // here (detach + unwatch) instead of leaking a hub slot.
    if caps.bundle {
        // Built on the blocking pool: it reads the transcript tail, the same
        // worker-holding read as a history page (see `off_runtime`).
        let built = {
            let (state, session) = (Arc::clone(&state), session.clone());
            off_runtime(move || bundle_frame(&state, &session, history_limit)).await
        };
        let delivered = match built {
            Some(frame) => {
                !context
                    .device_id()
                    .is_some_and(|id| state.devices.is_revoked(id))
                    && send_frame(&mut sink, caps, &state.cfg, Arc::from(frame)).await
            }
            // The build panicked: prune the slot like a vanished client.
            None => false,
        };
        if !delivered {
            detach_viewer(&state, client_id, &session);
            return;
        }
    }
    // Only this attaching viewer receives the replay; no dialog/busy accounting.
    let feedback_frame: Arc<str> = Arc::from(format!(r#"{{"type":"event","event":{feedback}}}"#));
    if context
        .device_id()
        .is_some_and(|id| state.devices.is_revoked(id))
        || !send_frame(&mut sink, caps, &state.cfg, feedback_frame).await
    {
        detach_viewer(&state, client_id, &session);
        return;
    }
    // Replay every still-pending child dialog (extension_ui_request payloads)
    // straight to THIS client: a phone that reloads mid-prompt must re-render
    // the agent's question or the turn hangs forever. Sent directly to the
    // attaching client's sink (NOT broadcast) because the hub has no
    // single-client targeting primitive and the sink is right here — other
    // attached clients already hold these dialogs from their own attach time.
    // The frames use the same `{"type":"event","event":<payload>}` shape the
    // router emits (with `timeout` shortened by the time already waited), so
    // the chat's dialog sheet renders them exactly like a live request.
    for payload in state.children.pending_ui_requests(&session) {
        let frame: Arc<str> = Arc::from(format!(r#"{{"type":"event","event":{payload}}}"#));
        if context
            .device_id()
            .is_some_and(|id| state.devices.is_revoked(id))
            || !send_frame(&mut sink, caps, &state.cfg, frame).await
        {
            detach_viewer(&state, client_id, &session);
            return;
        }
    }
    // One complete pending set is also exact settlement evidence for retained
    // answers whose end frame was missed. Captured before the first await,
    // its lifecycle revision fences older live frames already in hub_rx.
    let frame: Arc<str> = Arc::from(format!(r#"{{"type":"event","event":{collab_questions}}}"#));
    if context
        .device_id()
        .is_some_and(|id| state.devices.is_revoked(id))
        || !send_frame(&mut sink, caps, &state.cfg, frame).await
    {
        detach_viewer(&state, client_id, &session);
        return;
    }
    // Heartbeat. An idle session broadcasts NOTHING (measured: zero frames over
    // 50s), which costs us twice:
    //   * the client cannot distinguish a live socket from one that died
    //     silently on a cell handover, so it never knows to reconnect;
    //   * a vanished client is never noticed here either — the send that would
    //     fail never happens — so its hub slot, and this session's watcher,
    //     stay alive indefinitely.
    // A VISIBLE json frame fixes both. A protocol ping would not: browsers
    // answer those without telling page code, so the client's liveness clock
    // would never advance.
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await; // first tick fires immediately — discard it
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if context
                    .device_id()
                    .is_some_and(|id| state.devices.is_revoked(id))
                {
                    break;
                }
                // The fingerprint lets a long-lived PWA notice it is running
                // stale code and offer a reload (same value as /api/version:
                // `assets::build_id`). Tiny frame — always text, never worth
                // deflating.
                let frame = heartbeat_frame();
                // The 20s heartbeat is the liveness probe. Bound the send so
                // half-closed TCP sockets do not leak the hub slot forever.
                if !send_bounded(&mut sink, Message::Text(frame), Duration::from_secs(5)).await {
                    break;
                }
            }
            // Router task → this client: hub receiver → socket. The hub has
            // already resolved delta-vs-full per client; we only decide
            // deflate-vs-text here.
            incoming = hub_rx.recv() => {
                match incoming {
                    Some(text) => {
                        if context.device_id().is_some_and(|id| state.devices.is_revoked(id))
                            || !send_frame(&mut sink, caps, &state.cfg, text).await {
                            break;
                        }
                    }
                    None => break,
                }
            }
            // Client → daemon.
            msg = stream.next() => {
                match msg {
                Some(Ok(Message::Text(text))) => {
                        if context
                            .device_id()
                            .is_some_and(|id| state.devices.is_revoked(id))
                        {
                            break;
                        }
                        let frame: Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::debug!(%session, error = %e, "unparseable ws frame");
                                continue;
                            }
                        };
                        if matches!(frame.get("type").and_then(Value::as_str), Some("extension_ui_response" | "agent-cmd" | "collab-ui-response")) {
                            let refusal = if session_authority(&state, &session).owner.kind == "ambiguous" {
                                Some("Conflicting session owners; the answer was not sent")
                            } else if !context.can_control() {
                                Some("This connection is read-only; the answer was not sent")
                            } else { None };
                            if let Some(error) = refusal {
                                // A silent drop would leave the phone's answer "sending"
                                // forever: tell it the answer was refused.
                                if frame["type"] == "collab-ui-response"
                                    && frame["reqId"].is_u64()
                                    && frame["pulseQuestionToken"].is_string()
                                {
                                    let ack: Arc<str> = Arc::from(json!({
                                        "type":"event",
                                        "event":{
                                            "type":"ui_response_ack","reqId":frame["reqId"],
                                            "pulseQuestionToken":frame["pulseQuestionToken"],
                                            "ok":false,"error":error
                                        }
                                    }).to_string());
                                    if !send_frame(&mut sink, caps, &state.cfg, ack).await { break; }
                                }
                                tracing::debug!(%session, error, "refused websocket control");
                                continue;
                            }
                        }
                        match frame.get("type").and_then(|t| t.as_str()) {
                            Some("extension_ui_response") if context.can_control() => {
                                // Only a reply to a dialog still pending on this
                                // session, in the shape its method reads.
                                let pending = state.children.pending_ui_requests(&session);
                                match crate::omp::ui_dialog::socket_reply(&pending, &frame) {
                                    Ok(reply) => state.children.forward_ui_response(&session, &reply),
                                    Err(e) => tracing::debug!(%session, error = %e, "dropped a dialog reply"),
                                }
                            }
                            Some("agent-cmd") if context.can_control() => {
                                let cmd = frame.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                                let agent_id = frame.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
                                let text = frame.get("text").and_then(|v| v.as_str());
                                if let Err(e) = state.collab.send_agent_cmd(&session, cmd, agent_id, text) {
                                    tracing::warn!(%session, error = %e, "agent-cmd failed");
                                }
                            }
                            Some("collab-ui-response") if context.can_control() => {
                                // A phone answer to a collab dialog; `value`
                                // null or absent means cancelled.
                                let Some(req_id) = frame.get("reqId").and_then(|v| v.as_u64()) else {
                                    tracing::debug!(%session, "collab-ui-response without numeric reqId; ignoring");
                                    continue;
                                };
                                let Some(question_token) = frame.get("pulseQuestionToken").and_then(Value::as_str) else {
                                    tracing::debug!(%session, "collab-ui-response without exact question token; ignoring");
                                    continue;
                                };
                                let value = frame.get("value").and_then(|v| v.as_str());
                                if let Err(e) = state.collab.send_ui_response(&session, req_id, question_token, value) {
                                    tracing::warn!(%session, error = %e, "collab-ui-response failed");
                                }
                            }
                            Some("visibility") => {
                                // Reaping only: a hidden page keeps its socket,
                                // its stream and its notifications, but no
                                // longer keeps an idle omp child alive.
                                if let Some(visible) = frame.get("visible").and_then(Value::as_bool) {
                                    state.hub.set_visible(client_id, visible);
                                }
                            }
                            other => {
                                tracing::debug!(%session, ?other, "ignoring ws frame type");
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) => break,
                    // Ping/Pong/Binary are handled internally (axum
                    // auto-responds to pings) or are irrelevant — ignore.
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        tracing::debug!(%session, error = %e, "ws read error");
                        break;
                    }
                    None => break,
                }
            }
        }
    }
    detach_viewer(&state, client_id, &session);
}

// --- Relay WebSocket endpoint -------------------------------------------------

/// UNAUTHENTICATED collab-relay endpoint (`GET /r/{token}`): the canonical
/// room URL is `/r/<roomId>.<secret>` — ONE path segment (roomId and secret
/// are dot-joined; base64url never contains dots, so the LAST dot splits
/// them). The secret IS the auth (32B room key, or 48B key+write token), so
/// this route lives outside the `/api` token middleware. The secret must
/// NEVER be logged — this handler logs the room id only.
pub(super) async fn relay_ws_handler(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let role = q.get("role").cloned();
    match token.rsplit_once('.') {
        Some((room, secret)) => {
            let room = room.to_string();
            let secret = secret.to_string();
            ws.on_upgrade(move |socket| relay_handle_ws(socket, state, room, secret, role))
        }
        None => {
            // Bare room id — the REAL omp client's connection form: T36 in
            // the omp binary strips the link secret before connecting, so
            // `/r/<roomId>` has no dot (the link's `<roomId>.<secret>` is
            // one dot-joined segment only on paper). The relay ignores the
            // secret, and the room id is not secret — pass it through with
            // an empty secret and never log it.
            ws.on_upgrade(move |socket| relay_handle_ws(socket, state, token, String::new(), role))
        }
    }
}

/// Two-segment form (`GET /r/{room}/{secret}`) kept for link-shape
/// compatibility with the assignment spec; the relay ignores the secret
/// (clients hold the key). Logs room id only.
pub(super) async fn relay_ws_handler_with_secret(
    State(state): State<Arc<AppState>>,
    Path((room, secret)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let role = q.get("role").cloned();
    ws.on_upgrade(move |socket| relay_handle_ws(socket, state, room, secret, role))
}

async fn relay_handle_ws(
    socket: WebSocket,
    state: Arc<AppState>,
    room: String,
    secret: String,
    role: Option<String>,
) {
    if let Err(e) = state
        .relay
        .handle_ws(socket, &room, &secret, role.as_deref())
        .await
    {
        // `handle_ws` closes refused sockets itself: 4004 for a missing room,
        // 4009 for a competing host. This side is log-only and never logs the
        // secret or the full URL, just the room id.
        tracing::warn!(room = %room, error = %e, "relay session failed");
    }
}

fn heartbeat_frame() -> axum::extract::ws::Utf8Bytes {
    static FRAME: std::sync::LazyLock<axum::extract::ws::Utf8Bytes> =
        std::sync::LazyLock::new(|| {
            json!({
                "type": "hb",
                "v": assets::build_id(),
                "releaseId": assets::build_id(),
                "protocolVersion": assets::PROTOCOL_VERSION,
                "minClientProtocolVersion": assets::MIN_CLIENT_PROTOCOL_VERSION,
            })
            .to_string()
            .into()
        });
    FRAME.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// A socket sink that either accepts at once or, like a frozen WebView's
    /// loopback socket once its buffers fill, never becomes ready.
    struct TestSink {
        reading: bool,
    }

    impl futures_util::Sink<Message> for TestSink {
        type Error = std::convert::Infallible;
        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            if self.reading {
                std::task::Poll::Ready(Ok(()))
            } else {
                std::task::Poll::Pending
            }
        }
        fn start_send(self: std::pin::Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
            Ok(())
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            futures_util::Sink::poll_ready(self, cx)
        }
        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            futures_util::Sink::poll_ready(self, cx)
        }
    }

    #[tokio::test]
    async fn a_socket_that_stops_reading_is_given_up_on() {
        let deadline = Duration::from_millis(50);
        let started = std::time::Instant::now();
        let mut frozen = TestSink { reading: false };
        assert!(!send_bounded(&mut frozen, Message::Text("x".into()), deadline).await);
        assert!(started.elapsed() < Duration::from_secs(5));
        let mut live = TestSink { reading: true };
        assert!(send_bounded(&mut live, Message::Text("x".into()), deadline).await);
    }

    #[test]
    fn caps_parse_full() {
        let caps = parse_caps(Some("delta,defl,bundle"));
        assert!(caps.delta && caps.deflate && caps.bundle);
    }

    #[test]
    fn caps_parse_unknown_tokens_ignored() {
        let caps = parse_caps(Some("defl,foo, bundle ,bar"));
        assert!(!caps.delta && caps.deflate && caps.bundle);
    }

    #[test]
    fn caps_parse_empty_and_absent() {
        let none = parse_caps(None);
        assert!(!none.delta && !none.deflate && !none.bundle);
        let empty = parse_caps(Some(""));
        assert!(!empty.delta && !empty.deflate && !empty.bundle);
    }
    #[test]
    fn raw_deflate_round_trips() {
        use flate2::read::DeflateDecoder;
        use std::io::Read;
        let payload = "the quick brown fox jumps over the lazy dog ".repeat(400);
        let compressed = raw_deflate(payload.as_bytes());
        // Meaningful compression for repetitive text, and raw-DEFLATE proof:
        // DeflateDecoder expects RFC 1951 raw; a zlib-wrapped stream (0x78
        // header) would fail to decode here.
        assert!(compressed.len() < payload.len());
        let mut out = Vec::new();
        DeflateDecoder::new(compressed.as_slice())
            .read_to_end(&mut out)
            .unwrap();
        assert_eq!(out, payload.as_bytes());
    }

    #[test]
    fn raw_deflate_handles_empty() {
        let compressed = raw_deflate(b"");
        let mut out = Vec::new();
        flate2::read::DeflateDecoder::new(compressed.as_slice())
            .read_to_end(&mut out)
            .unwrap();
        assert!(out.is_empty());
    }
}
