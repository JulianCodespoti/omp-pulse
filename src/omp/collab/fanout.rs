//! Live frame mapping (host → phone WS hub): turning decrypted collab frames into
//! hub broadcasts, link-state notices and dialog bookkeeping.

use super::*;

use crate::server::delta::DeltaEncoder;
use crate::server::push::Push;
use crate::server::ws::{Collapse, WsHub};

use serde_json::Value;
use std::fmt::Write as _;
use std::sync::Arc;
use tracing::{debug, info};

/// Borrowed `Value::Null` for wrapper frames whose optional field is absent
/// (the collab bus frame's `channel`/`data`).
const NULL_VALUE: &Value = &Value::Null;

/// Serialize a daemon→client WS frame once and fan it out to the session's
/// connected clients through the shared delta encoder: the frame gets a seq
/// from the hub and `collapse` as its supersession key. `frame` is already a
/// serialized string — never re-serialize a `Value` tree here (measured F7:
/// the old path built a wrapper tree, then serialized it a second time).
pub(super) fn broadcast_frame(
    delta: &DeltaEncoder,
    hub: &WsHub,
    session: &str,
    frame: &str,
    collapse: Collapse,
) {
    let out = delta.encode_plain(hub, session, stamp_frame(session, frame), collapse);
    hub.broadcast_frame(session, out);
}

/// `{"type":"event","event":<event>}` — the shape the router task emits for
/// child events, so the ported UI's `handleEvent` dispatches it natively.
/// The wrapper is built by BORROWING the event (`format!` over the `&Value`,
/// not a new Value tree); assistant `message_update`s are prefix-diffed into
/// `{"type":"md",…}` deltas by the encoder, everything else passes through
/// with its collapse key.
pub(super) fn broadcast_event(delta: &DeltaEncoder, hub: &WsHub, session: &str, event: &Value) {
    let frame = stamp_frame(session, &format!(r#"{{"type":"event","event":{}}}"#, event));
    let mut out = delta.encode_event(hub, session, frame, event);
    if let Some((_, payload)) = out.delta.as_mut() {
        *payload = stamp_frame(session, payload);
    }
    hub.broadcast_frame(session, out);
}

fn stamp_frame(session: &str, frame: &str) -> Arc<str> {
    let Some(state) = SESSION_AUTHORITY
        .get()
        .and_then(|registry| registry.current(session))
    else {
        return Arc::from(frame);
    };
    let metadata = serde_json::to_string(&state).expect("session authority serializes");
    let mut stamped = String::with_capacity(frame.len() + metadata.len() + 48);
    stamped.push_str(&frame[..frame.len() - 1]);
    stamped.push_str(",\"sessionState\":");
    stamped.push_str(&metadata);
    write!(
        stamped,
        ",\"at\":{}}}",
        crate::authority::activity::now_ms()
    )
    .expect("string write");
    Arc::from(stamped)
}

/// `{"type":"event","event":{"type":"notice","message":<m>}}` — the daemon's
/// one notice wire shape (collab ended / stream lost). One-shot: never
/// collapsible.
pub(super) fn broadcast_notice(delta: &DeltaEncoder, hub: &WsHub, session: &str, message: &str) {
    let msg = Value::String(message.to_string());
    let frame = format!(
        r#"{{"type":"event","event":{{"type":"notice","message":{}}}}}"#,
        msg
    );
    broadcast_frame(delta, hub, session, &frame, Collapse::None);
}

/// `{"type":"event","event":{"type":"collab_link_state","state":<s>,"detail":<d>}}` —
/// the daemon's link-state wire shape. One-shot lifecycle frame, never
/// collapsible, exactly like a notice. `state` comes from the fixed
/// [`LinkState`] set (safe to interpolate literally); `detail` is free text
/// so it goes through `Value` escaping.
pub(super) fn broadcast_link_state(
    delta: &DeltaEncoder,
    hub: &WsHub,
    session: &str,
    state: LinkState,
    detail: &str,
) {
    let frame = format!(
        r#"{{"type":"event","event":{{"type":"collab_link_state","state":"{}","detail":{}}}}}"#,
        state.name(),
        Value::String(detail.to_string())
    );
    broadcast_frame(delta, hub, session, &frame, Collapse::None);
}

/// Retire every pending dialog of a session: one `collab_ui_request_end`
/// broadcast per pending reqId, then drop the remembered dialogs AND any
/// queued answers, then ONE notice explaining the cards vanished.
///
/// WHY THE END FRAMES COME FIRST: the store is the source of truth for what
/// to emit — clearing it before broadcasting would leave a card stuck on
/// any phone that missed the frames. The phone's existing
/// `collab_ui_request_end` handler drops each card; the notice carries the
/// reason (`reason` becomes the tail of "collab questions ended: <reason>").
///
/// Also clears queued answers: the room is ending, so an answer saved for
/// the next attach must not flush into a future room whose reqIds restart
/// from 1.
///
/// Idempotent: a session with nothing pending broadcasts nothing (and skips
/// the notice — there are no cards to explain).
pub(super) fn retire_collab_questions(
    delta: &DeltaEncoder,
    hub: &WsHub,
    session: &str,
    reason: &str,
) {
    let _delivery = COLLAB_UI_DELIVERY.lock().unwrap_or_else(|p| p.into_inner());
    let req_ids: Vec<u64> = {
        let map = match PENDING_COLLAB_UI.lock() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        };
        map.get(session)
            .map(|l| l.iter().map(|(id, _)| *id).collect())
            .unwrap_or_default()
    };
    if req_ids.is_empty() {
        // Nothing was waiting; queued answers from an earlier transient gap
        // are still dead — the room is gone, not reconnecting.
        forget_pending_answers(session);
        return;
    }
    for req_id in req_ids {
        let event = forget_collab_ui(session, req_id);
        broadcast_event(delta, hub, session, &event);
    }
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    broadcast_notice(
        delta,
        hub,
        session,
        &format!("collab questions ended: {reason}"),
    );
}

/// A transport handoff acknowledgement, including after reconnect flush.
/// This is NOT a callback receipt; only the host's ui-request-end closes it.
pub(super) fn ack_ui_response_ok(
    delta: &DeltaEncoder,
    hub: &WsHub,
    session: &str,
    req_id: u64,
    question_token: &str,
) {
    let event = json!({"type":"ui_response_ack","reqId":req_id,"pulseQuestionToken":question_token,"ok":true});
    broadcast_event(delta, hub, session, &event);
}

/// `ui_response_ack {ok:false}` from a free function: the sweep and the flush both
/// need it without a `CollabManager` in hand.
pub(super) fn ack_ui_response_err(
    delta: &DeltaEncoder,
    hub: &WsHub,
    session: &str,
    req_id: u64,
    question_token: &str,
    error: &str,
) {
    let actionable = collab_question_matches(session, req_id, question_token);
    let event = json!({
        "type":"ui_response_ack","reqId":req_id,"pulseQuestionToken":question_token,
        "ok":false,"actionable":actionable,"error":error
    });
    broadcast_event(delta, hub, session, &event);
}

/// Tell every phone about answers that waited out their TTL, and forget them.
///
/// Runs on a timer because the only other place expiry is noticed is an attach, and
/// the case that produces expiries is precisely a desktop that never attaches again.
pub fn sweep_expired_answers(delta: &DeltaEncoder, hub: &WsHub) {
    let _delivery = COLLAB_UI_DELIVERY.lock().unwrap_or_else(|p| p.into_inner());
    for (session, req_ids) in expired_pending_answers() {
        for (req_id, token) in req_ids {
            info!(session = %session, req_id, "queued collab answer expired");
            ack_ui_response_err(delta, hub, &session, req_id, &token, ANSWER_EXPIRED);
        }
    }
}

/// Welcome metadata: initial `state` (collab_state) + `agents` (collab_agents).
/// Each is a full snapshot of a DIFFERENT projection. Only matching kinds may
/// conflate; state updates cannot replace the agent roster (or vice versa).
pub(super) fn forward_welcome_meta(
    delta: &DeltaEncoder,
    hub: &WsHub,
    session: &str,
    welcome: &Value,
) {
    if let Some(state) = welcome.get("state") {
        let frame = format!(
            r#"{{"type":"event","event":{{"type":"collab_state","state":{}}}}}"#,
            state
        );
        broadcast_frame(delta, hub, session, &frame, Collapse::State);
    }
    if let Some(agents) = welcome.get("agents") {
        broadcast_agents(delta, hub, session, agents);
    }
}

/// Full agent snapshots share one dedicated delivery key on welcome and live
/// paths, including the empty roster that clears agents from an older snapshot.
pub(super) fn broadcast_agents(delta: &DeltaEncoder, hub: &WsHub, session: &str, agents: &Value) {
    let frame = format!(
        r#"{{"type":"event","event":{{"type":"collab_agents","agents":{}}}}}"#,
        agents
    );
    broadcast_frame(delta, hub, session, &frame, Collapse::Agents);
}

/// Handle one decrypted live frame: map it to daemon→client WS frames
/// (entries/event/state/agents/bus/ui-request + the synthesized
/// `message_start` for orphaned assistant `message_update`s) and fan them
/// out to the session's clients. Shared by the guest task and the
/// self-hosted relay so the phone's wire shape is byte-identical on both
/// paths. Returns `Some(reason)` for a terminal frame (bye) — the caller
/// ends the connection (guest: no-reconnect fatal; relay: drop the room).
#[allow(clippy::too_many_arguments)]
pub(super) fn forward_collab_frame(
    source: &mut CollabEventSource,
    peer_id: u32,
    delta: &DeltaEncoder,
    hub: &WsHub,
    push: &Arc<Push>,
    session: &str,
    frame: &Value,
    assistant_synced: &mut bool,
) -> Option<String> {
    let t = frame.get("t").and_then(Value::as_str).unwrap_or("");
    if t == "transcript" {
        if source.session == session
            && let Some(read) = &source.transcript
        {
            read.receive(peer_id, frame);
        }
        return None;
    }
    if peer_id == HOST_PEER_ID
        && t == "agents"
        && source.session == session
        && let Some(read) = source.transcript.as_ref().filter(|read| read.is_current())
    {
        let agents = frame.get("agents").unwrap_or(&Value::Null);
        read.update_agents(agents);
        broadcast_agents(delta, hub, session, agents);
        return None;
    }
    // A new welcome is a new parent/snapshot binding; do not keep reading
    // against the earlier identity even if this source mirrors a bridge.
    if peer_id == HOST_PEER_ID && matches!(t, "bye" | "welcome") {
        source.transcript.take();
    }
    if !source.accept_frame(peer_id, frame) {
        return None;
    }
    match t {
        "entry" => {
            if let Some(entry) = frame.get("entry") {
                let f = format!(r#"{{"type":"entries","entries":[{}]}}"#, entry);
                broadcast_frame(delta, hub, session, &f, Collapse::None);
            }
        }
        "event" => {
            if let Some(evt) = frame.get("event") {
                apply_event(delta, hub, push, session, evt, assistant_synced);
            }
        }
        "state" => {
            if let Some(state) = frame.get("state") {
                let f = format!(
                    r#"{{"type":"event","event":{{"type":"collab_state","state":{}}}}}"#,
                    state
                );
                broadcast_frame(delta, hub, session, &f, Collapse::State);
            }
        }
        "agents" => {
            if let Some(agents) = frame.get("agents") {
                broadcast_agents(delta, hub, session, agents);
            }
        }
        "bus" => {
            let channel = frame.get("channel").unwrap_or(NULL_VALUE);
            let data = frame.get("data").unwrap_or(NULL_VALUE);
            let f = format!(
                r#"{{"type":"event","event":{{"type":"collab_bus","channel":{},"data":{}}}}}"#,
                channel, data
            );
            broadcast_frame(delta, hub, session, &f, Collapse::None);
        }
        "ui-request" => {
            if let Some(request) = frame.get("request") {
                let _delivery = COLLAB_UI_DELIVERY.lock().unwrap_or_else(|p| p.into_inner());
                if !source.is_current() {
                    return None;
                }
                // Store before broadcasting. The snapshot barrier and lifecycle
                // revision fence queued pre-snapshot frames on socket attach.
                if let Some(req_id) = request.get("reqId").and_then(Value::as_u64) {
                    let mut owned = request.clone();
                    owned["pulseRoomId"] = json!(source.identity.room_id);
                    let event = remember_collab_ui(session, req_id, &owned);
                    broadcast_event(delta, hub, session, &event);
                }
                // A collab dialog must buzz the phone exactly like a child
                // extension_ui_request, through the SAME debounced push
                // (`push::maybe_push_needs_input`). Only blocking kinds
                // count: `confirm` arrives in the collab protocol as a
                // select of ["Yes","No"], so select + editor are the whole
                // blocking set. The request's numeric `reqId` rides along so
                // a notification tap can land on the exact dialog.
                if matches!(
                    request.get("kind").and_then(Value::as_str),
                    Some("select") | Some("editor")
                ) {
                    let body = request
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("agent needs your input");
                    crate::server::push::maybe_push_needs_input_with_req_id(
                        push,
                        session,
                        body,
                        request.get("reqId").and_then(Value::as_u64),
                    );
                }
            }
        }
        "ui-request-end" => {
            if let Some(req_id) = frame.get("reqId").and_then(Value::as_u64) {
                let _delivery = COLLAB_UI_DELIVERY.lock().unwrap_or_else(|p| p.into_inner());
                if !source.is_current() {
                    return None;
                }
                let event = forget_collab_ui(session, req_id);
                broadcast_event(delta, hub, session, &event);
                // Answered or withdrawn: the next question buzzes again.
                crate::server::push::rearm_needs_input(session);
            }
        }
        "bye" => {
            let reason = frame
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("host ended the session");
            // The room is gone, so no remembered dialog can ever be
            // answered: retire each with a `collab_ui_request_end` frame and
            // one notice BEFORE the task's terminal-loss branch runs — that
            // branch would otherwise see an already-cleared store and a
            // phone that missed these frames would keep a dead card.
            retire_collab_questions(delta, hub, session, reason);
            // Raw reason; the task formats the "collab ended: <reason>"
            // notice exactly once on terminal exit.
            return Some(reason.to_string());
        }
        "error" => {
            let message = frame
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            broadcast_notice(delta, hub, session, &format!("collab host: {message}"));
        }
        _ => debug!(t, "collab guest ignoring unexpected frame type"),
    }
    None
}

/// Event mapping with the orphan-delta guard: when joining mid-turn the
/// `message_start` for the in-flight assistant message predates the snapshot,
/// so synthesize the missing start before the first orphaned `message_update`.
fn apply_event(
    delta: &DeltaEncoder,
    hub: &WsHub,
    push: &Arc<Push>,
    session: &str,
    event: &Value,
    assistant_synced: &mut bool,
) {
    // The desktop's own extension bridge already delivers this session's
    // events (and its completion buzz) through the router; forwarding the
    // relay's copy too would render every token and notification twice.
    if crate::omp::bridge::live_pid(session).is_some() {
        return;
    }
    crate::authority::activity::observe(session, event);
    let etype = event.get("type").and_then(Value::as_str).unwrap_or("");
    let is_assistant = event
        .get("message")
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str)
        == Some("assistant");
    if etype == "message_start" && is_assistant {
        *assistant_synced = true;
    } else if etype == "message_update" && is_assistant && !*assistant_synced {
        *assistant_synced = true;
        if let Some(msg) = event.get("message") {
            // Built by borrowing `msg` (measured F7: the old path deep-cloned
            // it into a Value tree, then serialized the wrapper).
            let f = format!(
                r#"{{"type":"event","event":{{"type":"message_start","message":{}}}}}"#,
                msg
            );
            broadcast_frame(delta, hub, session, &f, Collapse::None);
        }
    }
    // Forward the event verbatim (type preserved: message_update, tool_*,
    // notice, …) so the ported UI's handleEvent dispatches it natively. No
    // clone: broadcast_event borrows the event to build its wrapper.
    broadcast_event(delta, hub, session, event);

    // Collab sessions never went through handle_child_event, so their
    // agent_end never buzzed. Mirror the always-notify path: remember the
    // last assistant text at message_end (like handle_child_event does) and
    // use it as the notify body at agent_end. This gives the phone the
    // actual closing line instead of the generic fallback, while still
    // buzzing even while foregrounded. Body is capped to 140 chars via
    // push::summarise_assistant (same as child).
    if etype == "message_end" {
        let message = event.get("message");
        let stop = message
            .and_then(|m| m.get("stopReason"))
            .and_then(|s| s.as_str());
        let failed = stop == Some("error");
        if failed {
            crate::server::push::note_turn_failed(session);
            crate::server::push::take_assistant_text(session);
        } else if stop == Some("aborted") {
            crate::server::push::clear_turn_failed(session);
            let owner =
                crate::omp::collab::authority_snapshot(session).map(|(stamp, _)| stamp.identity);
            crate::server::push::note_turn_aborted(
                session,
                owner.as_ref(),
                event.get("commandId").and_then(Value::as_str),
            );
            crate::server::push::take_assistant_text(session);
        } else if stop.is_some() {
            crate::server::push::clear_turn_failed(session);
            if let Some(text) = message.and_then(crate::server::push::summarise_assistant) {
                crate::server::push::note_assistant_text(session, text);
            }
        }
    } else if etype == "agent_start" {
        crate::server::push::clear_turn_failed(session);
        crate::server::push::clear_turn_aborted(session);
    } else if etype == "agent_end" {
        let is_terminal = event
            .get("isTerminal")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if is_terminal && event.get("bridgeLost").and_then(Value::as_bool) != Some(true) {
            let owner =
                crate::omp::collab::authority_snapshot(session).map(|(stamp, _)| stamp.identity);
            if crate::server::push::turn_was_aborted(
                session,
                owner.as_ref(),
                event.get("commandId").and_then(Value::as_str),
                event.get("stopReason").and_then(Value::as_str),
            ) || crate::server::push::take_turn_failed(session)
            {
                crate::server::push::take_assistant_text(session);
            } else {
                let push = Arc::clone(push);
                let session_owned = session.to_string();
                let title = crate::server::push::session_title(&session_owned);
                let body = crate::server::push::take_assistant_text(session)
                    .unwrap_or_else(|| "agent finished".to_string());
                tokio::spawn(async move {
                    push.notify(
                        &session_owned,
                        &title,
                        &body,
                        crate::server::push::KIND_AGENT_END,
                    )
                    .await;
                });
            }
        }
    }
}
