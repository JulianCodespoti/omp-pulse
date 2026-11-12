//! The relay's internal tap: a guest connection to our own relay that decrypts a
//! live room and feeds the phone hub.

use super::*;

use crate::server::delta::DeltaEncoder;
use crate::server::push::Push;
use crate::server::ws::WsHub;
use crate::types::SharedConfig;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{info, warn};

/// Spawn the internal tap for a live room: one attempt only, guarded by the
/// room's `tap_gen` (a newer tap supersedes an older one; the room must
/// still be live).
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_tap(
    rooms: &Arc<Mutex<HashMap<String, RelayRoom>>>,
    room_id: &str,
    link: String,
    hub: Arc<WsHub>,
    delta: Arc<DeltaEncoder>,
    push: Arc<Push>,
    links: Arc<LinkRegistry>,
    config: SharedConfig,
    generation: u64,
) {
    let tap_gen = {
        let mut g = match rooms.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match g.get_mut(room_id) {
            Some(room) if room.generation == generation => {
                room.tap_gen += 1;
                room.tap_gen
            }
            _ => {
                info!(room = room_id, "collab relay tap skipped (room not live)");
                return;
            }
        }
    };
    tokio::spawn(relay_tap_task(
        room_id.to_string(),
        link,
        hub,
        delta,
        push,
        links,
        Arc::clone(rooms),
        config,
        generation,
        tap_gen,
    ));
}

/// How a relay tap's read/write loop ended, deciding its exit cleanup — the
/// same three-way split the guest task's [`End`] makes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum TapEnding {
    /// Shutdown requested (detach): the caller owns the cleanup.
    Shutdown,
    /// The registry entry vanished (the manager dropped the frame sender —
    /// detach, or a newer attach replaced the entry): that owner cleans up.
    EntryGone,
    /// The connection dropped but the room may come back (host left or
    /// replaced — a host reconnect re-taps): announce `reconnecting`, keep
    /// the entry so answers queue during the gap.
    Transient,
    /// The room is gone for good (fatal close code, room-closed, bad key,
    /// bye): announce `lost`, retire questions, remove the entry.
    Terminal,
}

/// Register the tap as a real write path for `session`: insert a
/// [`CollabSession`] carrying the link's write token (None for a view-only
/// link, so `check_writable` still answers "view-only link"), taking a
/// FRESH generation from the manager's counter — the same one
/// [`CollabManager::attach`] uses, so a newer attach is never torn down by
/// this tap's generation-guarded cleanup. Then flip the link state to
/// Attached and broadcast it, exactly where the guest path does it after
/// its welcome. Returns the generation; the caller keeps `frame_rx` /
/// `shutdown_rx` and drives them in its select loop.
pub(super) fn register_tap_session(
    mgr: &CollabManager,
    session: &str,
    write_token: Option<String>,
    frame_tx: mpsc::UnboundedSender<OutboundFrame>,
    shutdown_tx: watch::Sender<bool>,
) -> u64 {
    let generation = mgr.next_gen.fetch_add(1, Ordering::Relaxed);
    let entry = CollabSession {
        generation,
        frame_tx,
        shutdown_tx,
        write_token,
        // The tap is always parked in its select! loop once registered, so
        // detach stops it through the shutdown watch — there is no guest
        // task handle to abort.
        task: None,
    };
    let mut g = match mgr.sessions.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    mgr.transcript_reads.disconnect(session);
    g.insert(session.to_string(), entry);
    drop(g);
    // The join has already succeeded at this point — the same post-welcome
    // attach point as conn_lifetime on the guest path.
    set_link_state(session, LinkState::Attached);
    broadcast_link_state(
        &mgr.delta,
        &mgr.hub,
        session,
        LinkState::Attached,
        "connected",
    );
    generation
}

/// Exit cleanup for a tap, mirroring the guest task's terminal/transient
/// branches. A TERMINAL end (room closed, no such room, host conflict, bad
/// key, host bye) means nothing is coming back: announce `lost`, retire
/// every pending dialog through the shared retire helper (a dead room must
/// not leave answerable cards) and drop the session entry —
/// generation-guarded, so a newer attach is never torn down by a stale
/// tap's cleanup. A TRANSIENT end (plain connection close — host left or
/// the room was replaced) announces `reconnecting` and KEEPS the entry: a
/// host reconnect re-taps and flips it back, and answers sent during the
/// gap are queued (exactly like the guest path's backoff) instead of being
/// refused as "the desktop that asked is gone". Shutdown (detach) and a
/// vanished entry (replaced) touch nothing — their owners already cleaned
/// up. When the entry is no longer THIS tap's generation, nothing at all is
/// touched: the newer owner's live state and questions are not ours to
/// change.
pub(super) fn tap_exit_cleanup(
    mgr: &CollabManager,
    delta: &DeltaEncoder,
    hub: &WsHub,
    session: &str,
    generation: u64,
    reason: &str,
    ending: TapEnding,
) {
    let still_ours = match mgr.sessions.lock() {
        Ok(g) => g.get(session).is_some_and(|e| e.generation == generation),
        Err(p) => p
            .into_inner()
            .get(session)
            .is_some_and(|e| e.generation == generation),
    };
    match ending {
        TapEnding::Shutdown | TapEnding::EntryGone => {}
        TapEnding::Transient if !still_ours => {}
        TapEnding::Transient => {
            set_link_state(session, LinkState::Reconnecting);
            broadcast_link_state(delta, hub, session, LinkState::Reconnecting, reason);
        }
        TapEnding::Terminal if !still_ours => {}
        TapEnding::Terminal => {
            set_link_state(session, LinkState::Lost);
            broadcast_link_state(delta, hub, session, LinkState::Lost, reason);
            retire_collab_questions(delta, hub, session, reason);
            // Self-cleanup; a newer attach with a different generation is
            // left alone — the same discipline as the guest task's Fatal
            // branch. The Lost state deliberately STAYS (this is not
            // remove_if_generation, which drops the state entry): a
            // terminal end must keep /api/status reporting the link as
            // gone until a re-attach, exactly like the guest path.
            if let Ok(mut g) = mgr.sessions.lock()
                && g.get(session).is_some_and(|e| e.generation == generation)
            {
                g.remove(session);
            }
        }
    }
}

/// The internal-guest tap: a real tokio-tungstenite client to OUR OWN relay
/// (`ws://127.0.0.1:7682/r/<roomId>?role=guest` — the stored link's own host
/// and port), carrying the room key from the stored link. The router treats
/// it as just another guest peer and can never decrypt, so decryption
/// happens HERE, exactly like the CollabManager guest path: hello → welcome
/// (session mapping via header.id) → snapshot (discarded — history arrives
/// over REST) → forward live frames through the shared `forward_collab_frame`
/// to the phone hub. No reconnect loop: the tap lives exactly as long as the
/// host — its socket is closed by the router's room teardown, and a new host
/// connection re-taps.
#[allow(clippy::too_many_arguments)]
async fn relay_tap_task(
    room_id: String,
    link: String,
    hub: Arc<WsHub>,
    delta: Arc<DeltaEncoder>,
    push: Arc<Push>,
    links: Arc<LinkRegistry>,
    rooms: Arc<Mutex<HashMap<String, RelayRoom>>>,
    config: SharedConfig,
    generation: u64,
    tap_generation: u64,
) {
    let parsed = match parse_collab_link(&link) {
        Ok(p) => p,
        Err(e) => {
            warn!(room = %room_id, error = %e, "collab relay tap: stored link unparseable");
            return;
        }
    };
    let codec = match Codec::new(&parsed.key) {
        Ok(c) => c,
        Err(e) => {
            warn!(room = %room_id, error = %e, "collab relay tap: bad stored room key");
            return;
        }
    };
    let write_token = parsed
        .write_token
        .as_deref()
        .map(|t| URL_SAFE_NO_PAD.encode(t));
    let ws_url = format!("{}?role=guest", parsed.ws_url);

    let local_route = RelayManager::current().and_then(|relay| relay.capture_read_route(&room_id));
    let connect = tokio::time::timeout(
        Duration::from_millis(WELCOME_TIMEOUT_MS),
        connect_async(&ws_url),
    )
    .await;
    let (ws, _resp) = match connect {
        Ok(Ok(ok)) => ok,
        Ok(Err(e)) => {
            info!(room = %room_id, error = %e, "collab relay tap connect failed");
            return;
        }
        Err(_) => {
            info!(room = %room_id, "collab relay tap connect timed out");
            return;
        }
    };
    let local_route = local_route.filter(|route| route.verifies(&ws));
    let (mut sink, mut stream) = ws.split();

    let (welcome, verified_host) =
        match join_session(&mut sink, &mut stream, &codec, write_token.as_deref()).await {
            Ok(w) => w,
            Err(je) => {
                info!(room = %room_id, error = %je.message, "collab relay tap join failed");
                return;
            }
        };

    // Session mapping: the welcome's header carries the host session id;
    // resolve it to a local session path. The TUI's session file only
    // materializes on its FIRST prompt, so a tap that joins before that
    // polls briefly for the file to appear before giving up quietly (a host
    // reconnect re-taps).
    let Some(id) = welcome
        .get("header")
        .and_then(|h| h.get("id"))
        .and_then(Value::as_str)
    else {
        warn!(room = %room_id, "collab relay tap: welcome missing session id; frames dropped");
        return;
    };
    let session = async {
        if let Some(s) = resolve_session_path(&config, id) {
            return Some(s);
        }
        // Late-materialized session file: poll every 2s for as long as the
        // room is still OURS (the host connection is what keeps it alive) —
        // a fresh TUI session's file only materializes on its FIRST prompt,
        // which can be minutes after startup. A fixed cap races that.
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let room_alive = match rooms.lock() {
                Ok(g) => g
                    .get(&room_id)
                    .map(|r| r.generation == generation && r.tap_gen == tap_generation)
                    .unwrap_or(false),
                Err(_) => false,
            };
            if !room_alive {
                break None;
            }
            if let Some(s) = resolve_session_path(&config, id) {
                break Some(s);
            }
        }
    }
    .await;
    let Some(session) = session else {
        info!(room = %room_id, "collab relay tap: host room gone before session file materialized; frames dropped");
        return;
    };

    // Register the mapping only if the room is still ours (a newer tap or a
    // replaced room makes this one stale).
    let live = {
        let mut g = match rooms.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match g.get_mut(&room_id) {
            Some(room) if room.generation == generation && room.tap_gen == tap_generation => {
                room.session_path = Some(session.clone());
                true
            }
            _ => false,
        }
    };
    if !live {
        info!(room = %room_id, "collab relay tap stale (room replaced or superseded)");
        return;
    }
    info!(room = %room_id, session = %session, "collab relay tap mapped room -> session");

    // Remember the link under the resolved session too, so session-keyed
    // auto-attach (WS) finds it without waiting for an explicit attach.
    links.remember_link(&session, &link);

    // The tap becomes a REAL write path the moment it maps to a session:
    // register a CollabSession (fresh generation from the manager's own
    // counter) so send_prompt / send_abort / send_agent_cmd /
    // send_ui_response / can_write / the queued-answer flush / the link
    // badge all treat this session exactly like a guest attach. Before
    // this, a tap-attached session was READ-ONLY: the phone saw the
    // question, but every answer was refused with "not attached to a collab
    // session" (measured live: a session with a tapped room had a pending
    // ask the phone could not answer, while /api/open reported
    // collabAttached:true and link_state_summary() said "none").
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    // The SESSION's generation (fresh from the manager's counter) — kept
    // distinct from the task's `generation` parameter, which is the ROOM's
    // host generation used by the was_mapped teardown check below.
    let mut session_generation = 0u64;
    let mut mgr = None;
    let mut source = CollabEventSource::begin(
        &session,
        &room_id,
        tap_generation,
        parsed.write_token.is_some(),
        SESSION_AUTHORITY.get().cloned(),
    );
    if let Some(m) = CollabManager::current() {
        session_generation = register_tap_session(&m, &session, write_token, frame_tx, shutdown_tx);
        if let Some(local_route) = local_route
            .filter(|_| verified_host && welcome_matches_parent(&config, &session, &welcome))
        {
            let sessions = m.sessions.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(entry) = sessions
                .get(&session)
                .filter(|e| e.generation == session_generation)
            {
                source.transcript = Some(m.transcript_reads.connect(
                    &session,
                    source.identity.source_id,
                    id,
                    local_route.closed,
                    welcome.get("agents").unwrap_or(&Value::Null),
                    entry.frame_tx.clone(),
                ));
            }
        }
        // The guest connection is live (this is THE attach point, exactly
        // like conn_lifetime's post-welcome flush): deliver any answers
        // queued while the link was down, oldest first, and re-ack each
        // ok:true so the phone clears its "waiting for the desktop" mark.
        let mut sender = GuestSinkSender {
            sink: &mut sink,
            codec: &codec,
            session_path: &session,
        };
        if source.is_current() {
            flush_pending_answers(&mut sender, &delta, &hub, &session).await;
        }
        mgr = Some(m);
    }
    // (No manager live — relay-only configuration — the tap stays read-only
    // as before: the select arms below are inert because the channel
    // senders are held in scope, so nothing ever arrives on them.)

    // Mirror the guest path: welcome metadata first, then live frames.
    if source.is_current() {
        forward_welcome_meta(&delta, &hub, &session, &welcome);
    } else if source
        .transcript
        .as_ref()
        .is_some_and(|read| read.is_current())
        && let Some(agents) = welcome.get("agents")
    {
        broadcast_agents(&delta, &hub, &session, agents);
    }

    let mut assistant_synced = false;
    // Set by whichever arm ends the loop; the initial None is never read, so it
    // exists only to give the binding a type.
    #[allow(unused_assignments)]
    let mut reason: Option<String> = None;
    let mut ending = TapEnding::Transient;
    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                // Detach (or the sender dropped): the caller owns cleanup.
                ending = TapEnding::Shutdown;
                break;
            }
            sent = frame_rx.recv() => {
                match sent {
                    // The manager dropped our sender: the entry was removed
                    // or replaced by a newer attach — that owner cleans up.
                    None => {
                        ending = TapEnding::EntryGone;
                        break;
                    }
                    Some(frame) => {
                        // Same seal + envelope packing as the guest task —
                        // no second implementation of the wire format.
                        if !transcript_dispatch_allowed(&source, &frame.payload) {
                            continue;
                        }
                        if !forward_outbound_frame(&mut sink, &codec, &session, frame).await {
                            reason = Some("send failed".to_string());
                            break;
                        }
                    }
                }
            }
            msg = stream.next() => {
                match msg {
                    None => {
                        reason = Some("connection closed".to_string());
                        break;
                    }
                    Some(Err(e)) => {
                        reason = Some(format!("ws error: {e}"));
                        break;
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        let Some((peer_id, payload)) = unpack_envelope(&bytes) else {
                            continue;
                        };
                        let frame = match codec.open(payload) {
                            Ok(f) => f,
                            // Decryption failure is FATAL — wrong key or corruption.
                            Err(e) => {
                                reason = Some(format!("bad key or corrupted frame: {e}"));
                                ending = TapEnding::Terminal;
                                break;
                            }
                        };
                        if let Some(r) = forward_collab_frame(
                            &mut source,
                            peer_id,
                            &delta,
                            &hub,
                            &push,
                            &session,
                            &frame,
                            &mut assistant_synced,
                        ) {
                            reason = Some(r);
                            ending = TapEnding::Terminal;
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(v) = serde_json::from_str::<Value>(text.as_str())
                            && v.get("t").and_then(Value::as_str) == Some("room-closed") {
                                reason = Some("room closed".to_string());
                                ending = TapEnding::Terminal;
                                break;
                            }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1000);
                        reason = Some(
                            fatal_close_reason(code)
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("connection closed (code {code})")),
                        );
                        // Fatal close codes (4001/4004/4009/4029) mean the
                        // room is gone — terminal, nothing is coming back. A
                        // plain close is the host leaving or the room being
                        // replaced — transient, a host reconnect re-taps.
                        if fatal_close_reason(code).is_some() {
                            ending = TapEnding::Terminal;
                        }
                        break;
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = sink.send(Message::Pong(p)).await;
                    }
                    Some(Ok(_)) => {}
                }
            }
        }
    }
    // Publish the retired source before cleanup frames project its state.
    drop(source);

    if let Some(mgr) = &mgr {
        tap_exit_cleanup(
            mgr,
            &delta,
            &hub,
            &session,
            session_generation,
            reason.as_deref().unwrap_or("stream lost"),
            ending,
        );
    }

    // Teardown: clear the mapping and broadcast the notice ONLY if this room
    // is still live — otherwise the room task's teardown owns the notice.
    // The notice is skipped on a deliberate detach (Shutdown): detach's own
    // retirement already told the phone the session ended.
    let was_mapped = {
        let mut g = match rooms.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match g.get_mut(&room_id) {
            Some(room) if room.generation == generation && room.tap_gen == tap_generation => {
                room.session_path.take().is_some()
            }
            _ => false,
        }
    };
    if was_mapped && !matches!(ending, TapEnding::Shutdown) {
        broadcast_notice(&delta, &hub, &session, "collab relay: stream lost");
    }
    info!(room = %room_id, reason = ?reason, "collab relay tap ended");
}
