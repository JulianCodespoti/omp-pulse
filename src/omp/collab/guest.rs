//! The guest task: joining a relay room, keeping the connection alive and
//! forwarding its frames, with relay-client reconnect backoff.

use super::*;

use crate::server::delta::DeltaEncoder;
use crate::server::push::Push;
use crate::server::ws::WsHub;
use crate::types::Config;

use axum::body::Bytes;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use rand::{RngExt, rng};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, info, warn};

/// Owns the whole attach lifetime: first join (result reported to the caller
/// via `first_join`), then an infinite reconnect loop while attached.
#[allow(clippy::too_many_arguments)]
pub(super) async fn guest_task(
    ws_url: String,
    room_id: String,
    codec: Codec,
    write_token: Option<String>,
    session_path: String,
    hub: Arc<WsHub>,
    delta: Arc<DeltaEncoder>,
    push: Arc<Push>,
    links: Arc<LinkRegistry>,
    mut shutdown: watch::Receiver<bool>,
    mut frames: mpsc::UnboundedReceiver<OutboundFrame>,
    first_join: oneshot::Sender<Result<(), String>>,
    registry: Arc<Mutex<HashMap<String, CollabSession>>>,
    transcript_reads: Arc<transcript::Reads>,
    generation: u64,
) {
    let mut attempt: u32 = 0;
    let mut joined_once = false;
    let mut first = Some(first_join);

    loop {
        if *shutdown.borrow() {
            break;
        }
        let end = conn_lifetime(
            &ws_url,
            &codec,
            write_token.as_deref(),
            &session_path,
            &room_id,
            generation,
            &registry,
            &transcript_reads,
            &hub,
            &delta,
            &push,
            &mut shutdown,
            &mut frames,
            first.take(),
        )
        .await;
        // A replaced attach owns lifecycle, links and pending questions now.
        if registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&session_path)
            .is_none_or(|entry| entry.generation != generation)
        {
            break;
        }
        match &end {
            End::Shutdown => break,
            End::Fatal(reason) => {
                warn!(session = %session_path, reason = %reason, "collab connection ended, no reconnect");
                // The phone UI clears its collab badge on "collab ended:" notices.
                if joined_once {
                    broadcast_notice(
                        &delta,
                        &hub,
                        &session_path,
                        &format!("collab ended: {reason}"),
                    );
                    // Terminal, no reconnect: announce `lost` (distinct from
                    // `reconnecting`) and persist the state so /api/status
                    // keeps reporting the link as gone until a re-attach.
                    set_link_state(&session_path, LinkState::Lost);
                    broadcast_link_state(&delta, &hub, &session_path, LinkState::Lost, reason);
                    // Notify-only-on-agent-end: link_lost pushes disabled per user preference.
                    // Was: push::maybe_push_link_lost(&push, &session_path, reason);
                }
                // The room itself is gone (no such room / room closed): prune
                // the stored link so auto-attach never retries a dead room
                // forever. Transient failures keep the mapping.
                if room_gone_reason(reason) {
                    links.forget_link(&session_path);
                    info!(session = %session_path, reason = %reason, "collab room is gone, pruned stored link");
                }
                // The link is TERMINAL — no reconnect, so no remembered
                // dialog can ever be answered: retire each with a
                // `collab_ui_request_end` frame plus one notice, instead of
                // leaving a card that replays and can never succeed (the
                // "answer not received … try again" bug). Runs whether or
                // not THIS task had joined: dialogs left by a previous
                // attach die with the room too. The `bye` arm already
                // retired, so this is a no-op there.
                retire_collab_questions(&delta, &hub, &session_path, reason);
                // Self-cleanup; a newer attach with a different generation is
                // left alone.
                if let Ok(mut g) = registry.lock()
                    && g.get(&session_path)
                        .is_some_and(|e| e.generation == generation)
                {
                    g.remove(&session_path);
                }
                break;
            }
            End::Transient(reason) => {
                // Only reachable after a successful join (a failed FIRST join
                // is always End::Fatal), so joined_once is implied.
                warn!(session = %session_path, reason = %reason, "collab connection lost, reconnecting");
                // Reconnect backoff: tell the phone the link is NOT live, and
                // refuse writes until it comes back.
                set_link_state(&session_path, LinkState::Reconnecting);
                broadcast_link_state(&delta, &hub, &session_path, LinkState::Reconnecting, reason);
            }
        }
        joined_once = true;
        if *shutdown.borrow() {
            break;
        }
        let delay = backoff_delay(attempt);
        attempt = attempt.saturating_add(1).min(10);
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = tokio::time::sleep(delay) => {}
        }
    }
    info!(session = %session_path, "collab guest task exited");
}

/// One connection lifetime: connect → hello → welcome → snapshot chunks
/// (discarded) → forward live frames until the connection drops, a terminal
/// condition fires, or shutdown is requested.
#[allow(clippy::too_many_arguments)]
async fn conn_lifetime(
    ws_url: &str,
    codec: &Codec,
    write_token: Option<&str>,
    session_path: &str,
    room_id: &str,
    binding_epoch: u64,
    sessions: &Mutex<HashMap<String, CollabSession>>,
    transcript_reads: &Arc<transcript::Reads>,
    hub: &Arc<WsHub>,
    delta: &Arc<DeltaEncoder>,
    push: &Arc<Push>,
    shutdown: &mut watch::Receiver<bool>,
    frames: &mut mpsc::UnboundedReceiver<OutboundFrame>,
    first: Option<oneshot::Sender<Result<(), String>>>,
) -> End {
    let local_route = RelayManager::current().and_then(|relay| relay.capture_read_route(room_id));
    let connect = tokio::time::timeout(
        Duration::from_millis(WELCOME_TIMEOUT_MS),
        connect_async(ws_url),
    )
    .await;
    let (ws, _resp) = match connect {
        Ok(Ok(ok)) => ok,
        Ok(Err(e)) => return join_error(first, format!("connect failed: {e}"), false),
        Err(_) => return join_error(first, "timed out connecting to relay".to_string(), false),
    };
    let local_route = local_route.filter(|route| route.verifies(&ws));
    let (mut sink, mut stream) = ws.split();

    let (welcome, verified_host) =
        match join_session(&mut sink, &mut stream, codec, write_token).await {
            Ok(w) => w,
            Err(je) => return join_error(first, je.message, je.terminal),
        };
    let mut source = CollabEventSource::begin(
        session_path,
        room_id,
        binding_epoch,
        write_token.is_some(),
        SESSION_AUTHORITY.get().cloned(),
    );
    if let Some(local_route) = local_route.filter(|route| {
        verified_host && welcome_matches_parent(&route.relay.config, session_path, &welcome)
    }) {
        let sessions = sessions.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = sessions
            .get(session_path)
            .filter(|e| e.generation == binding_epoch)
        {
            source.transcript = Some(transcript_reads.connect(
                session_path,
                source.identity.source_id,
                welcome["header"]["id"].as_str().unwrap_or_default(),
                local_route.closed,
                welcome.get("agents").unwrap_or(&Value::Null),
                entry.frame_tx.clone(),
            ));
        }
    }
    if let Some(tx) = first {
        let _ = tx.send(Ok(()));
    }
    let started = tokio::time::Instant::now();
    let (heard_tx, heard_rx) = watch::channel(started);
    let mut silence_ticks = Box::pin(guest_liveness::ticks(started));
    if source.is_current() {
        set_link_state(session_path, LinkState::Attached);
        broadcast_link_state(delta, hub, session_path, LinkState::Attached, "connected");
        let mut sender = guest_liveness::GuardedAnswers {
            inner: GuestSinkSender {
                sink: &mut sink,
                codec,
                session_path,
            },
            shutdown,
            heard: &heard_rx,
            ticks: &mut silence_ticks,
            end: None,
            requeue: |req_id, value: Option<&str>, token: &str| {
                let _delivery = COLLAB_UI_DELIVERY.lock().unwrap_or_else(|p| p.into_inner());
                let entries = sessions.lock().unwrap_or_else(|p| p.into_inner());
                if entries
                    .get(session_path)
                    .is_some_and(|entry| entry.generation == binding_epoch)
                    && collab_question_matches(session_path, req_id, token)
                {
                    queue_collab_answer(session_path, req_id, value, token);
                }
            },
            is_current: || {
                sessions
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(session_path)
                    .is_some_and(|entry| entry.generation == binding_epoch)
            },
        };
        flush_pending_answers(&mut sender, delta, hub, session_path).await;
        if let Some(end) = sender.end {
            return end;
        }
        forward_welcome_meta(delta, hub, session_path, &welcome);
    } else if source
        .transcript
        .as_ref()
        .is_some_and(|read| read.is_current())
        && let Some(agents) = welcome.get("agents")
    {
        broadcast_agents(delta, hub, session_path, agents);
    }
    let mut assistant_synced = false;
    let mut ping_ticks = Box::pin(guest_liveness::ticks(started));
    let live = async {
        loop {
            tokio::select! {
                _ = ping_ticks.next() => {
                    if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        return End::Transient("ping send failed".to_string());
                    }
                }
                sent = frames.recv() => {
                    match sent {
                        // The manager dropped the sender (detach/removal).
                        None => return End::Shutdown,
                        Some(frame) => {
                            // The ONLY outbound seal+envelope path; the relay
                            // tap drives its writes through the same helper so
                            // the wire shape cannot drift between attach paths.
                            if !transcript_dispatch_allowed(&source, &frame.payload) {
                                continue;
                            }
                            if !forward_outbound_frame(&mut sink, codec, session_path, frame).await {
                                return End::Transient("send failed".to_string());
                            }
                        }
                    }
                }
                msg = stream.next() => {
                    guest_liveness::received(&msg, &heard_tx, tokio::time::Instant::now());
                    match msg {
                        None => return End::Transient("connection closed".to_string()),
                        Some(Err(e)) => return End::Transient(format!("ws error: {e}")),
                        Some(Ok(Message::Binary(bytes))) => {
                            let Some((peer_id, payload)) = unpack_envelope(&bytes) else { continue };
                            let frame = match codec.open(payload) {
                                Ok(f) => f,
                                // Decryption failure is FATAL — wrong key or
                                // corruption; never reconnect.
                                Err(e) => return End::Fatal(format!("bad key or corrupted frame: {e}")),
                            };
                            if let Some(reason) = forward_collab_frame(&mut source, peer_id, delta, hub, push, session_path, &frame, &mut assistant_synced) {
                                return End::Fatal(reason);
                            }
                        }
                        Some(Ok(Message::Text(text))) => {
                            // Plaintext relay control frames (unencrypted JSON).
                            if let Ok(v) = serde_json::from_str::<Value>(text.as_str())
                                && v.get("t").and_then(Value::as_str) == Some("room-closed") {
                                    return End::Fatal("room closed".to_string());
                                }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1000);
                            if let Some(reason) = fatal_close_reason(code) {
                                return End::Fatal(reason.to_string());
                            }
                            return End::Transient(format!("connection closed (code {code})"));
                        }
                        Some(Ok(Message::Ping(p))) => {
                            let _ = sink.send(Message::Pong(p)).await;
                        }
                        Some(Ok(_)) => {}
                    }
                }
            }
        }
    };
    guest_liveness::ending(
        guest_liveness::guard(live, shutdown, &heard_rx, &mut silence_ticks).await,
    )
}

/// The guest→host `{t:"ui-response",reqId,value?}` frame for a dialog
/// answer. An absent `value` is how the collab protocol expresses a
/// cancelled dialog — the `value` key is then omitted entirely.
pub(super) fn build_ui_response_frame(req_id: u64, value: Option<&str>) -> Value {
    let mut frame = serde_json::Map::new();
    frame.insert("t".to_string(), Value::String("ui-response".into()));
    frame.insert("reqId".to_string(), Value::Number(req_id.into()));
    if let Some(v) = value {
        frame.insert("value".to_string(), Value::String(v.to_string()));
    }
    Value::Object(frame)
}

pub(super) fn transcript_dispatch_allowed(source: &CollabEventSource, frame: &Value) -> bool {
    !matches!(
        frame.get("t").and_then(Value::as_str),
        Some("fetch-transcript" | "pulse-agent-follow-up")
    ) || source
        .transcript
        .as_ref()
        .is_some_and(|read| read.can_send(frame))
}

/// A connection's welcome identifies the parent; the API never supplies a
/// child session path. Missing/mismatched headers disable reads on that link.
pub(super) fn welcome_matches_parent(config: &Config, session: &str, welcome: &Value) -> bool {
    let Some(id) = welcome
        .get("header")
        .and_then(|h| h.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return false;
    };
    let Some(unique) = resolve_session_path(config, id) else {
        return false;
    };
    std::path::Path::new(session)
        .canonicalize()
        .ok()
        .is_some_and(|path| path.to_str() == Some(unique.as_str()))
}

pub(super) async fn forward_outbound_frame<S>(
    sink: &mut S,
    codec: &Codec,
    session_path: &str,
    frame: OutboundFrame,
) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    // A timed-out command must not sit in the reconnect queue and execute later.
    if frame.forwarded.as_ref().is_some_and(|ack| ack.is_closed()) {
        return true;
    }
    let payload = if frame.payload["t"] == "pulse-agent-follow-up" {
        json!({"t":"agent-cmd", "cmd":"chat", "agentId":frame.payload["agentId"], "text":frame.payload["text"]})
    } else {
        frame.payload
    };
    let sent = send_outbound_frame(sink, codec, session_path, &payload).await;
    if let Some(ack) = frame.forwarded {
        let _ = ack.send(sent);
    }
    sent
}

/// Seal one outbound frame and write it onto a guest connection — the ONLY
/// envelope packing for guest→host frames. The guest task's frame loop and
/// the relay tap's write path both go through here, so the wire shape
/// cannot drift between the two attach paths. `false` when the frame would
/// not seal or the socket died.
async fn send_outbound_frame<S>(
    sink: &mut S,
    codec: &Codec,
    session_path: &str,
    frame: &Value,
) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    match codec.seal(frame) {
        Ok(sealed) => sink
            .send(Message::binary(pack_envelope(0, sealed)))
            .await
            .is_ok(),
        Err(e) => {
            warn!(session = session_path, error = %e, "collab failed to seal outbound frame");
            false
        }
    }
}

/// Seal and write one queued answer onto the live guest sink. `false` when
/// the frame would not seal or the connection died mid-send — the caller
/// keeps the answer queued for the next attach.
async fn send_queued_answer(
    sink: &mut SplitSink<WsStream, Message>,
    codec: &Codec,
    session_path: &str,
    req_id: u64,
    value: Option<&str>,
) -> bool {
    let frame = build_ui_response_frame(req_id, value);
    send_outbound_frame(sink, codec, session_path, &frame).await
}

/// The flush loop's delivery seam: write one guest→host answer frame onto
/// the live connection. Generic so tests can record deliveries instead of
/// opening a real socket (a closure could not hold the sink borrow — the
/// returned future would outlive the FnMut call).
pub(super) trait UiResponseSink {
    /// Deliver one queued answer; `false` = not delivered (stays queued).
    async fn send_answer(&mut self, req_id: u64, value: Option<&str>) -> bool;
    /// Ordinary guest cancellation must not restore answers owned by a detached
    /// or replaced attachment. Existing tap/test sinks retain their behavior.
    fn requeue_failed_answer(&self, session: &str, req_id: u64, value: Option<&str>, token: &str) {
        let _delivery = COLLAB_UI_DELIVERY.lock().unwrap_or_else(|p| p.into_inner());
        if collab_question_matches(session, req_id, token) {
            queue_collab_answer(session, req_id, value, token);
        }
    }
}

/// Production [`UiResponseSink`]: seals with the room codec and writes onto
/// the guest connection's socket.
pub(super) struct GuestSinkSender<'a> {
    pub(super) sink: &'a mut SplitSink<WsStream, Message>,
    pub(super) codec: &'a Codec,
    pub(super) session_path: &'a str,
}

impl UiResponseSink for GuestSinkSender<'_> {
    async fn send_answer(&mut self, req_id: u64, value: Option<&str>) -> bool {
        send_queued_answer(self.sink, self.codec, self.session_path, req_id, value).await
    }
}

/// Flush retained answers to a live transport. Only the host's request-end
/// closes the question; a successful socket write is merely handoff.
pub(super) async fn flush_pending_answers<S>(
    sink: &mut S,
    delta: &Arc<DeltaEncoder>,
    hub: &Arc<WsHub>,
    session_path: &str,
) where
    S: UiResponseSink + ?Sized,
{
    let (queued, expired) = {
        let _delivery = COLLAB_UI_DELIVERY.lock().unwrap_or_else(|p| p.into_inner());
        take_pending_answers(session_path)
    };
    // Report the expiries first: the desktop is back but these answers are too old
    // to deliver, and their dialogs are still pending, so the phone must be able to
    // answer them again rather than keep a card that claims the answer is held.
    for (req_id, token) in expired {
        ack_ui_response_err(delta, hub, session_path, req_id, &token, ANSWER_EXPIRED);
    }
    if queued.is_empty() {
        return;
    }
    for (req_id, value, token) in queued {
        if !collab_question_matches(session_path, req_id, token.as_str()) {
            ack_ui_response_err(
                delta,
                hub,
                session_path,
                req_id,
                &token,
                "that question is no longer waiting",
            );
            continue;
        }
        if sink.send_answer(req_id, value.as_deref()).await {
            let _delivery = COLLAB_UI_DELIVERY.lock().unwrap_or_else(|p| p.into_inner());
            if collab_question_matches(session_path, req_id, token.as_str()) {
                mark_collab_answer_handoff(session_path, req_id);
            }
            ack_ui_response_ok(delta, hub, session_path, req_id, &token);
        } else {
            // The connection died mid-flush (or the frame would not seal);
            // keep the answer for the next successful attach. Its TTL still
            // applies, so a desktop that never comes back eventually drops
            // it rather than delivering into a new room.
            sink.requeue_failed_answer(session_path, req_id, value.as_deref(), &token);
        }
    }
}

/// Send the first-join result to the caller and classify the failure:
/// a failed FIRST join always ends the task; later failures are transient
/// unless `terminal` (room closed / host conflict / bad key).
fn join_error(
    first: Option<oneshot::Sender<Result<(), String>>>,
    message: String,
    terminal: bool,
) -> End {
    if let Some(tx) = first {
        let _ = tx.send(Err(message.clone()));
        return End::Fatal(message);
    }
    if terminal {
        End::Fatal(message)
    } else {
        End::Transient(message)
    }
}

/// Join handshake: send `hello`, then collect `welcome` + the snapshot chunk
/// train (entries DISCARDED — the phone already has history via REST). The
/// welcome frame (header/state/agents metadata) is returned on completion.
pub(super) async fn join_session(
    sink: &mut SplitSink<WsStream, Message>,
    stream: &mut SplitStream<WsStream>,
    codec: &Codec,
    write_token: Option<&str>,
) -> Result<(Value, bool), JoinError> {
    let mut hello = serde_json::Map::new();
    hello.insert("t".to_string(), Value::String("hello".into()));
    hello.insert("proto".to_string(), json!(COLLAB_PROTO));
    hello.insert("name".to_string(), Value::String(GUEST_NAME.into()));
    if let Some(tok) = write_token {
        hello.insert("writeToken".to_string(), Value::String(tok.to_string()));
    }
    let sealed = codec.seal(&Value::Object(hello)).map_err(|e| JoinError {
        message: format!("failed to seal hello: {e}"),
        terminal: true,
    })?;
    sink.send(Message::binary(pack_envelope(0, sealed)))
        .await
        .map_err(|e| JoinError {
            message: format!("hello send failed: {e}"),
            terminal: false,
        })?;

    let mut welcome: Option<Value> = None;
    let mut verified_host = false;
    let mut saw_welcome = false;
    let mut entry_count: usize = 0;
    let mut received: usize = 0;
    let welcome_deadline = tokio::time::Instant::now() + Duration::from_millis(WELCOME_TIMEOUT_MS);
    let mut chunk_deadline: Option<tokio::time::Instant> = None;

    loop {
        let deadline = chunk_deadline.unwrap_or(welcome_deadline);
        let msg = tokio::time::timeout_at(deadline, stream.next())
            .await
            .map_err(|_| JoinError {
                message: if saw_welcome {
                    "timed out waiting for the host's session snapshot".to_string()
                } else {
                    "timed out waiting for the host's welcome".to_string()
                },
                terminal: false,
            })?
            .ok_or_else(|| JoinError {
                message: "connection closed before welcome".to_string(),
                terminal: false,
            })?
            .map_err(|e| JoinError {
                message: format!("ws error: {e}"),
                terminal: false,
            })?;

        match msg {
            Message::Binary(bytes) => {
                let Some((peer, payload)) = unpack_envelope(&bytes) else {
                    continue;
                };
                let frame = codec.open(payload).map_err(|e| JoinError {
                    message: format!("failed to decrypt frame: {e}"),
                    terminal: true,
                })?;
                let t = frame.get("t").and_then(Value::as_str).unwrap_or("");
                match t {
                    "welcome" => {
                        verified_host = peer == HOST_PEER_ID;
                        saw_welcome = true;
                        entry_count =
                            frame.get("entryCount").and_then(Value::as_u64).unwrap_or(0) as usize;
                        received = 0;
                        welcome = Some(frame);
                        if entry_count == 0 {
                            // Host promises zero entries: the snapshot is done.
                            return welcome.map(|welcome| (welcome, verified_host)).ok_or_else(
                                || JoinError {
                                    message: "malformed welcome".to_string(),
                                    terminal: true,
                                },
                            );
                        }
                        chunk_deadline = Some(
                            tokio::time::Instant::now()
                                + Duration::from_millis(SNAPSHOT_PROGRESS_TIMEOUT_MS),
                        );
                    }
                    "agents" if verified_host && peer == HOST_PEER_ID => {
                        if let Some(welcome) = welcome.as_mut() {
                            welcome["agents"] = frame.get("agents").cloned().unwrap_or(Value::Null);
                        }
                    }
                    "snapshot-chunk" => {
                        if !saw_welcome {
                            continue; // orphan chunk — drop
                        }
                        if let Some(entries) = frame.get("entries").and_then(Value::as_array) {
                            received += entries.len();
                        }
                        let final_flag =
                            frame.get("final").and_then(Value::as_bool).unwrap_or(false);
                        if final_flag || received >= entry_count {
                            return welcome.map(|welcome| (welcome, verified_host)).ok_or_else(
                                || JoinError {
                                    message: "malformed welcome".to_string(),
                                    terminal: true,
                                },
                            );
                        }
                        chunk_deadline = Some(
                            tokio::time::Instant::now()
                                + Duration::from_millis(SNAPSHOT_PROGRESS_TIMEOUT_MS),
                        );
                    }
                    // Pre-welcome errors are the host's targeted reply to our
                    // hello (e.g. protocol mismatch): no welcome will follow.
                    "error" if !saw_welcome => {
                        let m = frame
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("join rejected");
                        return Err(JoinError {
                            message: format!("collab host: {m}"),
                            terminal: true,
                        });
                    }
                    _ => debug!(t, "collab guest ignoring pre-welcome frame"),
                }
            }
            Message::Text(text) => {
                if let Ok(v) = serde_json::from_str::<Value>(text.as_str())
                    && v.get("t").and_then(Value::as_str) == Some("room-closed")
                {
                    return Err(JoinError {
                        message: "room closed".to_string(),
                        terminal: true,
                    });
                }
            }
            Message::Close(frame) => {
                let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1000);
                if let Some(reason) = fatal_close_reason(code) {
                    return Err(JoinError {
                        message: reason.to_string(),
                        terminal: true,
                    });
                }
                return Err(JoinError {
                    message: format!("connection closed before welcome (code {code})"),
                    terminal: false,
                });
            }
            Message::Ping(p) => {
                let _ = sink.send(Message::Pong(p)).await;
            }
            _ => {}
        }
    }
}

/// Fatal relay close codes (relay-client.ts): no reconnect on these.
pub(super) fn fatal_close_reason(code: u16) -> Option<&'static str> {
    match code {
        4001 => Some("room closed"),
        4004 => Some("no such room"),
        4009 => Some("host conflict"),
        4029 => Some("room is full"),
        _ => None,
    }
}

/// Fatal reasons that mean the ROOM itself is gone — relay close 4004
/// ("no such room") and the `room-closed` control frame / close 4001
/// ("room closed"). These prune the stored link so auto-attach never retries
/// a vanished room forever; every other failure (host conflict, room full,
/// bad key, host bye) keeps the mapping.
fn room_gone_reason(reason: &str) -> bool {
    matches!(reason, "no such room" | "room closed")
}

/// `1s * 2^attempt`, capped at 30s, jittered ×(0.75..1.25).
fn backoff_delay(attempt: u32) -> Duration {
    let base_ms = BACKOFF_BASE_MS
        .saturating_mul(1u64 << attempt.min(10))
        .min(BACKOFF_MAX_MS);
    let jitter = rng().random_range(0.75f64..1.25f64);
    Duration::from_millis((base_ms as f64 * jitter) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prompt_forwarding_ack_tracks_socket_write_and_cancellation() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
                let bytes = socket.next().await.unwrap().unwrap().into_data();
                let (_, encrypted) = unpack_envelope(&bytes).unwrap();
                let received = Codec::new(&[7; 32]).unwrap().open(encrypted).unwrap();
                assert_eq!(received["text"], "deliver once");
                while let Some(message) = socket.next().await {
                    if matches!(message, Ok(Message::Close(_))) {
                        break;
                    }
                    assert!(
                        !matches!(message, Ok(Message::Binary(_))),
                        "no second prompt"
                    );
                }
            });
            let (socket, _) = connect_async(format!("ws://{address}")).await.unwrap();
            let (mut sink, _) = socket.split();
            let codec = Codec::new(&[7; 32]).unwrap();
            let (cancelled, receiver) = oneshot::channel();
            drop(receiver);
            assert!(
                forward_outbound_frame(
                    &mut sink,
                    &codec,
                    "/isolated",
                    OutboundFrame {
                        payload: json!({"t":"prompt","text":"must not send after timeout"}),
                        forwarded: Some(cancelled),
                    }
                )
                .await
            );
            let (ack, mut receipt) = oneshot::channel();
            assert!(matches!(
                receipt.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            assert!(
                forward_outbound_frame(
                    &mut sink,
                    &codec,
                    "/isolated",
                    OutboundFrame {
                        payload: json!({"t":"prompt","text":"deliver once"}),
                        forwarded: Some(ack),
                    }
                )
                .await
            );
            assert!(
                receipt.await.unwrap(),
                "successful socket write resolves delivery"
            );
            sink.close().await.unwrap();
            let (ack, receipt) = oneshot::channel();
            assert!(
                !forward_outbound_frame(
                    &mut sink,
                    &codec,
                    "/isolated",
                    OutboundFrame {
                        payload: json!({"t":"prompt","text":"closed socket"}),
                        forwarded: Some(ack),
                    }
                )
                .await
            );
            assert!(
                !receipt.await.unwrap(),
                "closed socket must not confirm delivery"
            );
            server.await.unwrap();
        })
        .await
        .expect("local socket proof must finish");
    }

    #[tokio::test]
    async fn desktop_follow_up_serializes_only_the_native_agent_chat_contract() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
                let bytes = socket.next().await.unwrap().unwrap().into_data();
                let (_, encrypted) = unpack_envelope(&bytes).unwrap();
                let received = Codec::new(&[7; 32]).unwrap().open(encrypted).unwrap();
                assert_eq!(received, json!({"t":"agent-cmd","cmd":"chat","agentId":"agent-a","text":"Review the patch"}));
            });
            let (socket, _) = connect_async(format!("ws://{address}")).await.unwrap();
            let (mut sink, _) = socket.split();
            let (ack, receipt) = oneshot::channel();
            assert!(forward_outbound_frame(&mut sink, &Codec::new(&[7; 32]).unwrap(), "/isolated", OutboundFrame {
                payload: json!({"t":"pulse-agent-follow-up","agentId":"agent-a","text":"Review the patch",
                    "connectionId":"captured","createdAt":1234,"parentId":"parent"}),
                forwarded: Some(ack),
            }).await);
            assert!(receipt.await.unwrap());
            server.await.unwrap();
        }).await.unwrap();
    }

    #[test]
    fn backoff_stays_in_bounds() {
        for attempt in 0..20 {
            let d = backoff_delay(attempt);
            let ms = d.as_millis() as f64;
            assert!(ms >= 750.0, "attempt {attempt}: {ms}");
            assert!(ms <= 37_500.0, "attempt {attempt}: {ms}");
        }
    }
}
