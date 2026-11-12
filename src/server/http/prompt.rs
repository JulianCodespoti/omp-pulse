//! The send path: opening and pre-warming sessions, then admitting a prompt and
//! dispatching it to the writer that owns the session.

use super::*;
use crate::{
    authority::command_ledger::{CommandLedger, ReceiptState},
    metrics,
    omp::child::ChildManager,
    sessions::index,
    sessions::jsonl,
};
use axum::{
    Json,
    extract::{Extension, State},
    http::StatusCode,
    response::Response,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// How long `/api/prompt` waits for the child to take the prompt before it
/// answers with the in-flight receipt (dispatch continues in the background).
const PROMPT_ACK_WAIT: Duration = Duration::from_secs(5);

/// File stem of a session path (the "name" fallback for a fresh session whose
/// file has no header yet).
fn basename(path: &str) -> String {
    FsPath::new(path)
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub(super) async fn open(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<AuthContext>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let Some(raw) = session_path_from_body(&body) else {
        return err_status(StatusCode::BAD_REQUEST, "sessionPath required");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    // LAZY: no child spawn. Missing file → 404 UNLESS the session was just
    // created by /api/new (its file materializes on the first write — open it
    // as an empty session so "Start session in …" works immediately).
    if !path.is_file() {
        let Ok(session) = session_str(&path) else {
            return err("invalid session path");
        };
        if is_recent_new(&session) {
            let authority = session_authority(&state, &session);
            return ok(json!({
                "sessionState": authority,
                "ok": true,
                "state": {
                    "sessionFile": session,
                    "sessionName": basename(&session),
                    "model": "",
                    "messageCount": 0,
                    "streaming": match authority.turn {
                        crate::authority::session_state::Turn::Running => Some(true),
                        crate::authority::session_state::Turn::Idle => Some(false),
                        crate::authority::session_state::Turn::Unknown => None,
                    },
                    "collabAttached": false,
                }
            }));
        }
        return err_status(StatusCode::NOT_FOUND, "session file not found");
    }
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    let header = jsonl::parse_header(&path);
    let (session_name, model, message_count) = match state.children.cached_state(&session) {
        Some((name, model, mc, _)) => (name, model, mc),
        None => {
            let file = path.clone();
            let lines = tokio::task::spawn_blocking(move || jsonl::line_count(&file))
                .await
                .unwrap_or(0);
            (
                header.title.unwrap_or_default(),
                String::new(),
                lines as u64,
            )
        }
    };

    // PRE-WARM — gated behind cfg.prewarm_on_attach (default false): merely
    // OPENING a conversation must not cost a ~281 MiB child (measured F1/F8
    // in docs/internals/performance.md). The phone signals intent explicitly via
    // POST /api/prewarm on composer focus, where the 1.3-2.7 s child boot
    // (measured) hides inside human typing latency. Set
    // OMP_REMOTE_PREWARM_ON_ATTACH=1 to restore the old eager behavior.
    // Fire-and-forget either way: `open` returns immediately.
    //
    // Skipped when a live path already exists (collab-attached sessions route
    // prompts through the desktop host and need no child of ours), when a
    // stored collab link exists (the host path is the likely route — the
    // cheap attach replaces the pre-warm), when the relay already streams the
    // session, and when the session file belongs to a desktop TUI (do_open
    // refuses those to protect the file — see guard.rs); the error is
    // swallowed at debug level because both are normal states, not faults.
    if context.can_control()
        && state.cfg.prewarm_on_attach
        && !state.collab.is_attached(&session)
        && !state.relay.is_attached(&session)
        && !state.children.has_child(&session)
        && state.collab.stored_link(&session).is_none()
    {
        let children = Arc::clone(&state.children);
        let warm = session.clone();
        tokio::spawn(async move {
            if let Err(e) = children.open(&warm).await {
                tracing::debug!(session = %warm, error = %e, "pre-warm skipped");
            }
        });
    }
    let authority = session_authority(&state, &session);
    ok(json!({
        "sessionState": authority,
        "ok": true,
        "state": {
            "sessionFile": session,
            "sessionName": session_name,
            "model": model,
            "messageCount": message_count,
            "streaming": match authority.turn {
                crate::authority::session_state::Turn::Running => Some(true),
                crate::authority::session_state::Turn::Idle => Some(false),
                crate::authority::session_state::Turn::Unknown => None,
            },
            // Liveness, not registry membership. Measured: a session whose frames
            // arrived over the relay tap reported attached here while
            // `link_state_summary()` said "none" and every write was refused - the
            // phone showed a live badge over a link that could not carry an answer.
            "collabAttached": state.collab.is_live(&session),
        }
    }))
}

/// Intent-based pre-warm: the phone calls this when the composer gains focus,
/// so the ~1.3-2.7 s child boot (measured) hides inside human typing latency
/// instead of in front of the first message. Best-effort and fire-and-forget:
/// the response is always `{"ok":true}` and the spawn runs detached.
///
/// Respects the same guard rails as the write-adjacent endpoints: a session a
/// terminal owns must NOT get a second writer (checked via the cached
/// ownership verdict — see `session_owner`), a collab/relay-hosted session
/// needs no child of ours, and an already-warm child makes this a no-op. So
/// does a pool whose every slot holds a busy agent: a warm-up is never worth
/// a refusal, let alone someone's running turn.
pub(super) async fn prewarm(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let Some(raw) = session_path_from_body(&body) else {
        return err_status(StatusCode::BAD_REQUEST, "sessionPath required");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    if !state.collab.is_attached(&session)
        && !state.relay.is_attached(&session)
        && !state.children.has_child(&session)
        && state.children.can_admit(&session)
        && state.collab.stored_link(&session).is_none()
        && session_owner(&state, &session).is_none()
    {
        let children = Arc::clone(&state.children);
        let warm = session.clone();
        tokio::spawn(async move {
            if let Err(e) = children.open(&warm).await {
                tracing::debug!(session = %warm, error = %e, "prewarm skipped");
            }
        });
    }
    ok(json!({ "ok": true }))
}

/// The user dismissed the "cut off" notice on a chat: forget the
/// interruption so the list and the chat stop offering Continue. Idempotent;
/// `dismissed` says whether one was showing.
pub(super) async fn dismiss_interrupted(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let Some(raw) = session_path_from_body(&body) else {
        return err_status(StatusCode::BAD_REQUEST, "sessionPath required");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    let dismissed =
        crate::authority::interrupted::journal().is_some_and(|journal| journal.dismiss(&session));
    if dismissed {
        index::trigger_refresh(&state);
    }
    ok(json!({ "ok": true, "dismissed": dismissed }))
}

pub(super) async fn prompt(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let Some(raw) = session_path_from_body(&body) else {
        return err_status(StatusCode::BAD_REQUEST, "sessionPath required");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    let command_id = body
        .get("commandId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if command_id.is_empty() {
        return err_status(StatusCode::BAD_REQUEST, "commandId required");
    }
    let text = body.get("text").and_then(Value::as_str).unwrap_or("");
    let mut images: Vec<Value> = Vec::new();
    if let Some(arr) = body.get("images").and_then(Value::as_array) {
        if arr.len() > MAX_PROMPT_IMAGES {
            return payload_too_large();
        }
        for img in arr {
            let data = img.get("data").and_then(Value::as_str).unwrap_or("");
            if data.len() > MAX_IMAGE_BASE64_CHARS {
                return payload_too_large();
            }
            images.push(img.clone());
        }
    }
    // An image-only prompt is valid. Reject only a genuinely empty request.
    if text.is_empty() && images.is_empty() {
        return err_status(StatusCode::BAD_REQUEST, "text or images required");
    }
    // Validated before the ledger records anything, so a bad mode never
    // leaves a receipt behind. JSON null reads as absent (steer).
    let delivery = match crate::omp::child::PromptDelivery::from_wire(
        body.get("delivery")
            .filter(|value| !value.is_null())
            .map(|value| value.as_str().unwrap_or("")),
    ) {
        Ok(delivery) => delivery,
        Err(e) => return err_status(StatusCode::BAD_REQUEST, &e),
    };
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    let fingerprint = CommandLedger::fingerprint(&session, text, &images);
    let witness = CommandLedger::transcript_witness(&session, text, images.len());
    if let Some(response) = prompt_admission_response(
        state
            .commands
            .submit_witnessed(command_id, &session, &fingerprint, Some(&witness)),
        raw,
        &session,
    ) {
        return response;
    }
    if let Err(e) = state
        .commands
        .update(command_id, ReceiptState::Dispatching, None, None)
    {
        return err_status(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }
    // Everything past `dispatching` runs in a task the request does not own.
    // Routing awaits (stored-link attach, adoption, closing our child, the
    // desktop bridge RPC) and hyper drops a handler future when its client
    // goes away — the Android client gives up after 20 s, a backgrounded
    // WebView sooner. A dropped handler left the receipt at `dispatching`
    // until the next daemon restart, and every outbox retry of the same
    // commandId replayed that receipt: a send pending forever. A JoinHandle
    // dropped with the request leaves the task running to its final receipt.
    let route = tokio::spawn(prompt_route(
        Arc::clone(&state),
        raw.to_owned(),
        session,
        command_id.to_owned(),
        text.to_owned(),
        images,
        delivery,
    ));
    match route.await {
        Ok(response) => response,
        Err(e) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// Route and dispatch an admitted prompt whose receipt is `dispatching`, and
/// answer with its receipt. Spawned by [`prompt`]; see the comment there.
async fn prompt_route(
    state: Arc<AppState>,
    raw: String,
    session: String,
    command_id: String,
    text: String,
    images: Vec<Value>,
    delivery: crate::omp::child::PromptDelivery,
) -> Response {
    let (raw, command_id, text) = (raw.as_str(), command_id.as_str(), text.as_str());
    let use_host = match write_path(&state, &session).await {
        WritePath::Refused(reason) => {
            // The receipt is the phone's only explanation for a refused send,
            // so it carries the daemon's reason (the adoption failure after the
            // guard's boilerplate) instead of a fixed sentence: the client
            // strips the pid/command-line boilerplate and says what actually
            // went wrong, which is the difference between "held on the desktop,
            // nowhere to go" and "/collab there, or here is why that failed".
            let receipt = state.commands.update(
                command_id,
                ReceiptState::Failed,
                Some("session_owned_by_terminal"),
                Some(&reason),
            );
            return match receipt {
                Ok(receipt) => bound_receipt_response(raw, &session, receipt),
                Err(e) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e),
            };
        }
        WritePath::Bridge(pid) => {
            let params = json!({
                "text": text,
                "images": images,
                "deliverAs": delivery.bridge_deliver_as(),
            });
            let outcome = crate::omp::desktop_control::rpc_for_owner(
                &state.cfg, &session, pid, "prompt", params,
            )
            .await;
            // The owner answers only after omp accepted the message into its
            // prompt flow, so a success is a real hand-off, not a socket
            // write. A transport error is ambiguous (the body may have been
            // accepted before the reply was lost): uncertain, never resent.
            let (receipt_state, code, error) = match &outcome {
                Ok(v) if v.get("ok").and_then(Value::as_bool) == Some(true) => {
                    // An input handler (a `fileMention` skip, say) consumed it: omp ran
                    // no turn, so "forwarded" would leave the row waiting for one.
                    if v.pointer("/data/delivery").and_then(Value::as_str) == Some("local") {
                        (ReceiptState::Completed, Some("handled_locally"), None)
                    } else {
                        (ReceiptState::Forwarded, None, None)
                    }
                }
                Ok(v) => (
                    ReceiptState::Failed,
                    Some("desktop_rejected"),
                    Some(
                        v.get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("the desktop rejected the prompt")
                            .to_string(),
                    ),
                ),
                Err(e) => (
                    ReceiptState::Uncertain,
                    Some("desktop_transport_unacknowledged"),
                    Some(e.clone()),
                ),
            };
            return match state
                .commands
                .update(command_id, receipt_state, code, error.as_deref())
            {
                Ok(receipt) => bound_receipt_response(raw, &session, receipt),
                Err(e) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e),
            };
        }
        WritePath::Host => true,
        WritePath::Child => false,
    };

    let children = Arc::clone(&state.children);
    let collab = Arc::clone(&state.collab);
    let hub = Arc::clone(&state.hub);
    let ledger = Arc::clone(&state.commands);
    let text = text.to_string();
    let events = children.subscribe();
    // Dispatch only through the selected route; a disconnect must not spawn a second writer.
    // The collab host has no mode in its `prompt` frame: omp's host always
    // steers a guest prompt into a running turn, so `delivery` cannot apply
    // here and session capabilities report queue/interrupt as unavailable.
    if use_host {
        match collab.send_prompt(&session, &text, images) {
            Ok(forwarded) => {
                // Persist the observed socket-write result even if the phone
                // disconnects before receiving HTTP. The desktop protocol has
                // no per-command execution ack: never manufacture completion.
                let command_id = command_id.to_string();
                let delivery = tokio::spawn(async move {
                    let (state, code, error) = match tokio::time::timeout(
                        Duration::from_secs(10),
                        forwarded,
                    )
                    .await
                    {
                        Ok(Ok(true)) => (ReceiptState::Forwarded, None, None),
                        _ => (
                            ReceiptState::Uncertain,
                            Some("host_transport_unacknowledged"),
                            Some(
                                "desktop socket write could not be confirmed; nothing will be resent",
                            ),
                        ),
                    };
                    ledger.update(&command_id, state, code, error)
                });
                return match delivery.await {
                    Ok(Ok(receipt)) => bound_receipt_response(raw, &session, receipt),
                    Ok(Err(e)) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e),
                    Err(e) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
                };
            }
            Err(e) => {
                hub.broadcast(&session, &collab_state_frame());
                tracing::warn!(%session, error = %e, "collab prompt failed");
                let result = ledger.update(
                    command_id,
                    ReceiptState::Failed,
                    Some("host_transport_rejected"),
                    Some(&e),
                );
                return match result {
                    Ok(receipt) => bound_receipt_response(raw, &session, receipt),
                    Err(update_err) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &update_err),
                };
            }
        }
    }
    // The child boot and prompt RPC acknowledgement run in a task the HTTP
    // request does not own. A slow link or a cold child (session switch, model
    // negotiation) used to hold this response past the Android client's 20 s
    // read deadline, so a prompt omp had already accepted looked unsent on the
    // phone. The ledger already records `dispatching`; whichever way the task
    // ends it writes the final receipt, and the client's receipt reconciliation
    // picks it up. A fast child still answers inline with the final receipt.
    let command_id = command_id.to_string();
    let source_states = Arc::clone(&state.session_states);
    let mut dispatch = tokio::spawn({
        let ledger = Arc::clone(&ledger);
        let command_id = command_id.clone();
        let session = session.clone();
        let title_state = Arc::clone(&state);
        async move {
            let (result, events) = dispatch_child_prompt(
                &children,
                &ledger,
                events,
                &command_id,
                &session,
                &text,
                &images,
                delivery,
            )
            .await;
            match result {
                Ok(source) => {
                    tokio::spawn(title_untitled_session(title_state, session.clone(), text));
                    let receipt = ledger.update(&command_id, ReceiptState::Received, None, None);
                    if receipt.is_ok() {
                        tokio::spawn(watch_child_receipt(
                            Arc::clone(&ledger),
                            events,
                            command_id.clone(),
                            session,
                            source,
                            source_states,
                        ));
                    }
                    receipt
                }
                // Held past AGENT_WAIT_MAX: never reached an agent.
                Err(e) if crate::omp::child::agents_busy_message(&e).is_some() => ledger.update(
                    &command_id,
                    ReceiptState::Failed,
                    Some(crate::omp::child::AGENTS_BUSY),
                    crate::omp::child::agents_busy_message(&e),
                ),
                Err(e) => {
                    // A timeout/channel loss is ambiguous: the child may have accepted
                    // the frame before the response disappeared. Provider rejections
                    // are explicit failures and preserve their detail.
                    let ambiguous = e.contains("timed out")
                        || e.contains("channel closed")
                        || e.contains("stdin write failed");
                    let (state, code) = if ambiguous {
                        (ReceiptState::Uncertain, "child_transport_unacknowledged")
                    } else {
                        (ReceiptState::Failed, "agent_rejected")
                    };
                    ledger.update(&command_id, state, Some(code), Some(&e))
                }
            }
        }
    });
    match tokio::time::timeout(PROMPT_ACK_WAIT, &mut dispatch).await {
        Ok(Ok(Ok(receipt))) => bound_receipt_response(raw, &session, receipt),
        Ok(Ok(Err(e))) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e),
        Ok(Err(e)) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        // Still dispatching: answer with the durable receipt as it stands.
        Err(_) => match ledger.get(&command_id) {
            Ok(Some(receipt)) => bound_receipt_response(raw, &session, receipt),
            Ok(None) => err_status(StatusCode::INTERNAL_SERVER_ERROR, "command receipt missing"),
            Err(e) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e),
        },
    }
}

/// How long a send waits for a free agent before it is given up as never
/// sent. Turns on the phone routinely run 10-30 minutes; an hour covers a
/// long one without holding a message forever.
const AGENT_WAIT_MAX: Duration = Duration::from_secs(60 * 60);
/// While waiting, the pool is re-checked on every turn end or child exit, and
/// at least this often (a dialog answered or an RPC finished frees a child
/// without an event).
const AGENT_WAIT_RECHECK: Duration = Duration::from_secs(15);

/// One FIFO gate per session for child prompt dispatch, so a send held for a
/// free agent is never overtaken by a later send to the same chat.
static PROMPT_ORDER: std::sync::LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Hand a prompt to the session's child. When every agent slot holds a
/// working agent the prompt is HELD, not refused: its receipt says
/// `accepted`/`agents_busy` ("Waiting for a free agent…") and it is sent the
/// moment a slot frees, in order with any later sends to the same chat.
///
/// Why hold instead of answering 503: the installed Android outbox treats a
/// 5xx as "delivery could not be confirmed", marks the message uncertain and
/// re-posts it (images included) every 8 s; a 4xx marks it failed and makes
/// the user resend by hand. A held receipt is a known non-terminal state the
/// outbox simply polls, the ledger entry is the single copy (no duplicate
/// can be dispatched), and a daemon restart turns it into a definite "never
/// sent" failure (see `CommandLedger::open`).
///
/// Returns the dispatch result and the event receiver the receipt watcher
/// must use: re-subscribed right before the final attempt, so a long wait
/// cannot leave it lagged.
#[allow(clippy::too_many_arguments)]
pub(super) async fn dispatch_child_prompt(
    children: &ChildManager,
    ledger: &CommandLedger,
    mut events: tokio::sync::broadcast::Receiver<crate::types::ChildEvent>,
    command_id: &str,
    session: &str,
    text: &str,
    images: &[Value],
    delivery: crate::omp::child::PromptDelivery,
) -> (
    Result<crate::authority::session_state::SourceIdentity, String>,
    tokio::sync::broadcast::Receiver<crate::types::ChildEvent>,
) {
    let gate = Arc::clone(
        PROMPT_ORDER
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(session.to_string())
            .or_default(),
    );
    let order = gate.lock().await;
    let started = Instant::now();
    let mut wake: Option<tokio::sync::broadcast::Receiver<crate::types::ChildEvent>> = None;
    let result = loop {
        if wake.is_none() || children.can_admit(session) {
            if wake.is_some() {
                if let Err(e) = ledger.update(command_id, ReceiptState::Dispatching, None, None) {
                    break Err(e);
                }
                events = children.subscribe();
            }
            match children
                .prompt(session, command_id, text, images, delivery)
                .await
            {
                Err(e) if crate::omp::child::agents_busy_message(&e).is_some() => {}
                other => break other,
            }
            let waiting = crate::omp::child::agents_busy_waiting_sentence(children.cap());
            if let Err(e) = ledger.update(
                command_id,
                ReceiptState::Accepted,
                Some(crate::omp::child::AGENTS_BUSY),
                Some(&waiting),
            ) {
                break Err(e);
            }
            if wake.is_none() {
                tracing::info!(%session, %command_id, "every agent is busy; holding the send");
                metrics::inc("prompt_held_agents_busy");
                wake = Some(children.subscribe());
            }
        }
        if started.elapsed() >= AGENT_WAIT_MAX {
            break Err(children.busy_error());
        }
        if let Some(wake) = wake.as_mut() {
            wait_for_free_agent(wake, AGENT_WAIT_RECHECK).await;
        }
    };
    drop(order);
    {
        let mut gates = PROMPT_ORDER.lock().unwrap_or_else(|p| p.into_inner());
        // Two references (the map's and ours) mean nobody else is queued.
        if gates.get(session).is_some_and(|g| Arc::ptr_eq(g, &gate))
            && Arc::strong_count(&gate) == 2
        {
            gates.remove(session);
        }
    }
    (result, events)
}

/// Sleep until something that can free an agent happens (a turn ends, a
/// child exits or is stopped), or `recheck` passes.
async fn wait_for_free_agent(
    wake: &mut tokio::sync::broadcast::Receiver<crate::types::ChildEvent>,
    recheck: Duration,
) {
    use crate::types::ChildEvent;
    use tokio::sync::broadcast::error::RecvError;
    let _ = tokio::time::timeout(recheck, async {
        loop {
            match wake.recv().await {
                Ok(ChildEvent::Stopped { .. } | ChildEvent::Notice { .. }) => return,
                Ok(ChildEvent::Event { event, .. })
                    if matches!(
                        event.get("type").and_then(Value::as_str),
                        Some("agent_end" | "session_settled")
                    ) =>
                {
                    return;
                }
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => return,
                Err(RecvError::Closed) => std::future::pending::<()>().await,
            }
        }
    })
    .await;
}

/// Title a conversation our own child runs, after a prompt it accepted. omp
/// never auto-titles in RPC mode (see `autotitle.rs`), so without this every
/// phone-started conversation stays untitled.
///
// INVARIANT: the name is applied only through our live child, and only while
// that child is still the session's sole writer. The model call takes
// seconds, during which the desktop may take the session over; a
// `children.rpc` then would boot a second writer.
async fn title_untitled_session(state: Arc<AppState>, session: String, text: String) {
    let file = PathBuf::from(&session);
    if !crate::omp::autotitle::wants_title(&file, &text) {
        return;
    }
    // Skips this prompt when another generator runs or this session missed
    // recently; dropping the claim without `titled()` records a miss.
    let Some(mut claim) = crate::omp::autotitle::claim(&session) else {
        return;
    };
    let model = state
        .children
        .cached_state(&session)
        .map(|(_, model, _, _)| model)
        .unwrap_or_default();
    let Some(title) = crate::omp::autotitle::generate(&state.cfg.omp_bin, &model, &text).await
    else {
        return;
    };
    // Renamed by hand while the model ran: the person's name wins.
    if jsonl::parse_header(&file).chosen_title().is_some() {
        claim.titled();
        return;
    }
    let sole_writer = state.children.has_child(&session)
        && session_authority(&state, &session).owner.kind == "child"
        && crate::omp::bridge::live_pid(&session).is_none()
        && session_owner(&state, &session).is_none()
        // Deleted while the title was being generated: naming it would
        // write the file back.
        && file.exists();
    if !sole_writer {
        return;
    }
    match state
        .children
        .rpc(&session, "set_session_name", json!({ "name": title }))
        .await
    {
        Ok(_) => {
            claim.titled();
            tracing::info!(%session, %title, "autotitle: named session");
        }
        Err(e) => tracing::warn!(%session, error = %e, "autotitle: set_session_name failed"),
    }
}
