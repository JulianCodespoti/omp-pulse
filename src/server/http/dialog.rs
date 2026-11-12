//! Pending dialogs: which sessions wait for an answer, and answering one from
//! the phone.

use super::*;
use axum::{Json, extract::State, http::StatusCode, response::Response};
use serde_json::{Value, json};
use std::sync::Arc;

/// Live daemon health/metrics snapshot (behind the same auth as every
/// `/api/*` route). `sessions_cached` reports whether the session-listing
/// index has been populated yet; `index` carries its ETag + refresh/304
/// counters so the whole design is observable from one endpoint.
///
/// The identity block (`version`, `buildId`, `platform`, `bindLoopback`,
/// `sessionsRoot`) exists so a stranger diagnosing their own install can
/// confirm which binary is running, where it expects omp's sessions, and
/// whether it is reachable only from this machine. No secrets: no token, no
/// collab links.
/// Sessions with a question waiting for an answer.
///
/// Small and deliberately uncached, unlike `/api/sessions` whose payload is
/// ETag-validated against file state. A pending dialog is not a property of the
/// file, so folding it into that payload would either defeat the validator or make
/// it churn on every poll. The inbox needs this because a question is only
/// deliverable once the phone opens that specific conversation — without a marker
/// in the list, a blocked session is indistinguishable from an idle one.
pub(super) async fn awaiting(State(state): State<Arc<AppState>>) -> Response {
    let mut sessions = state.children.sessions_awaiting_ui();
    sessions.extend(crate::omp::collab::sessions_awaiting_ui());
    // Oracle blocks: a laptop pane herdr reports blocked is waiting for input
    // exactly like a daemon pending_ui — same asking chip, same answer sheet.
    sessions.extend(
        crate::terminal::herdr_state::blocked_snapshot_global()
            .into_iter()
            .filter_map(|(_, s, _)| s),
    );
    sessions.sort();
    sessions.dedup();
    ok(json!({ "ok": true, "sessions": sessions }))
}
/// Answer a blocked dialog from the phone — either a daemon child's
/// `extension_ui_request` (a turn the phone itself started) or a laptop
/// pane's blocked dialog (`ask` question or tool approval, typed in via
/// herdr). The daemon branches come first: they carry the dialog's exact id,
/// while the pane branch re-derives the target. Either way the guard is
/// still-open-at-send-time; answering something that already moved on would
/// type into (or resolve) the wrong thing.
///
/// A child dialog is answered in the shape its method reads
/// (`ui_dialog`): the chat's dialog sheet sends `requestId` plus a structured
/// `response`; the answer sheet and quick-reply chips send `text` (and
/// `optionIndex`), mapped onto the oldest pending dialog.
pub(super) async fn answer_pane(
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
    if !path.is_file() {
        return err_status(StatusCode::NOT_FOUND, "session file not found");
    }
    let request_id = body.get("requestId").and_then(Value::as_str);
    let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
    // The typed-answer rules (one plain line, 500 chars) exist because a pane
    // answer is typed key by key; a structured reply is checked against its
    // dialog instead, and an editor answer is a whole multi-line document.
    if request_id.is_none()
        && let Err(e) = crate::terminal::herdr_state::validate_answer_text(text)
    {
        return err_status(StatusCode::BAD_REQUEST, e);
    }
    let session = session_str(&path).unwrap_or_default();
    // Keep the question-position guard and its delivery indivisible for phone taps.
    static ANSWERING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _answer = ANSWERING.lock().await;
    if session_authority(&state, &session).owner.kind == "ambiguous" {
        return err_status(
            StatusCode::CONFLICT,
            "conflicting live session owners; no answer was dispatched",
        );
    }
    let pending = state.children.pending_ui_requests(&session);
    // An explicitly separate terminal submission must never resolve a native
    // or collab exact-ID dialog merely because the catalogue has no pendingAsk.
    if body.get("terminalOnly").and_then(Value::as_bool) == Some(true)
        && (request_id.is_some()
            || !pending.is_empty()
            || crate::omp::collab::pending_collab_ui_request(&session)
            || matches!(
                session_authority(&state, &session).owner.kind.as_str(),
                "child" | "collab"
            ))
    {
        return err_status(
            StatusCode::CONFLICT,
            "open the session to answer its exact dialog",
        );
    }
    // Branch 1 — a structured reply to one exact child dialog. The id must
    // still be pending for THIS session: a dialog omp cancelled or another
    // phone answered is gone from the map.
    if let Some(request_id) = request_id {
        let Some(request) = pending
            .iter()
            .find(|r| r.get("id").and_then(Value::as_str) == Some(request_id))
        else {
            return err_status(StatusCode::CONFLICT, "that question is no longer waiting");
        };
        let response = body.get("response").cloned().unwrap_or(Value::Null);
        let reply = match crate::omp::ui_dialog::reply_frame(request, &response) {
            Ok(reply) => reply,
            Err(e) => return err_status(StatusCode::BAD_REQUEST, &e),
        };
        if let Err(error) = state.children.answer_ui_response(&session, &reply).await {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "ok": false, "code": "answer_delivery_uncertain", "error": error
                }),
            );
        }
        crate::omp::ui_dialog::forget_partial(request_id);
        tracing::info!(%session, id = request_id, "child dialog answered");
        // The listing's waiting chip clears now, not at the next file change.
        crate::sessions::index::trigger_refresh(&state);
        return ok(json!({ "ok": true, "delivery": "handoff" }));
    }
    // Question guard: omp's `ask` asks its questions one after another, so a
    // phone sheet built for question N must not land on question N+1. The
    // client names the call and index it answered; a mismatch means someone
    // (another tap, the laptop keyboard) already moved it on. Both branches
    // below record every delivered answer, so the index means the same thing
    // whether a child or a laptop pane is asking.
    let ask = crate::sessions::jsonl::pending_ask(&path);
    if body.get("terminalOnly").and_then(Value::as_bool) == Some(true) && ask.is_some() {
        return err_status(
            StatusCode::CONFLICT,
            "a structured question is waiting; reopen its answer sheet",
        );
    }
    let asked_index = body.get("questionIndex").and_then(Value::as_u64);
    if asked_index.is_some() && ask.is_none() {
        return err_status(StatusCode::CONFLICT, "that question is no longer waiting");
    }
    if let (Some(ask), Some(idx)) = (&ask, asked_index) {
        let call = body.get("askId").and_then(|v| v.as_str()).unwrap_or("");
        let delivered = crate::terminal::herdr_state::ask_answers_delivered(&session, &ask.call_id);
        if call != ask.call_id || idx as usize != delivered {
            return err_status(
                StatusCode::CONFLICT,
                "that question was already answered; reopen the sheet for the current one",
            );
        }
    }
    let option = body
        .get("optionIndex")
        .and_then(Value::as_u64)
        .map(|i| i as usize);
    // Branch 2 — a typed answer to an unreserved child dialog. A previous
    // pipe handoff remains pending until closure, but is not an answer target.
    // A structured `ask` is held until its last question is answered.
    if let Some(request) = crate::omp::ui_dialog::text_answer_target(&pending) {
        let reply = match crate::omp::ui_dialog::text_reply(request, text, option) {
            Ok(reply) => reply,
            Err(e) => return err_status(StatusCode::BAD_REQUEST, &e),
        };
        if let crate::omp::ui_dialog::TextReply::Send(frame) = &reply
            && let Err(error) = state.children.answer_ui_response(&session, frame).await
        {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "ok": false, "code": "answer_delivery_uncertain", "error": error
                }),
            );
        }
        // A confirm is never one of the ask's questions (tool approval can
        // interrupt an ask); every other answer is, including the one-select-
        // per-question fallback of an omp that refused `set_ask_dialog`.
        let delivered = ask
            .as_ref()
            .filter(|_| request.get("method").and_then(Value::as_str) != Some("confirm"))
            .map(|ask| {
                crate::terminal::herdr_state::record_ask_answer(&session, &ask.call_id);
                crate::terminal::herdr_state::ask_answers_delivered(&session, &ask.call_id)
            });
        let sent = matches!(reply, crate::omp::ui_dialog::TextReply::Send(_));
        tracing::info!(%session, sent, ?delivered, chars = text.chars().count(), "child dialog answered from text");
        crate::sessions::index::trigger_refresh(&state);
        return ok(
            json!({ "ok": true, "answered": delivered, "delivery": if sent { "handoff" } else { "held" } }),
        );
    }
    if !pending.is_empty() {
        return err_status(
            StatusCode::CONFLICT,
            "an answer is already waiting for this question",
        );
    }
    // Branch 3 — laptop pane via the oracle's self-reported session mapping
    // (exact — never a title or recency guess). Pane addressing is direct
    // (pane id, not focus), so typing can never land in a neighbouring
    // conversation the way window-level injection could.
    let Some(pane) = crate::terminal::herdr_state::pane_for_session_global(&session) else {
        return err_status(
            StatusCode::CONFLICT,
            "session is not waiting for input anywhere answerable",
        );
    };
    // Still-blocked guard: answering a pane that already moved on would type
    // into whatever it is doing now.
    if crate::terminal::herdr_state::status_for_pane_global(&pane)
        != Some(crate::terminal::herdr_state::HerdrStatus::Blocked)
    {
        return err_status(StatusCode::CONFLICT, "pane is no longer waiting for input");
    }
    let sent = if let Some(ask) = &ask {
        let index = crate::terminal::herdr_state::ask_answers_delivered(&session, &ask.call_id);
        crate::terminal::herdr_state::send_ask_answer(&pane, ask, index, option, text).await
    } else {
        crate::terminal::herdr_state::send_answer(&pane, text).await
    };
    match sent {
        Ok(()) => {
            let delivered = ask.as_ref().map(|ask| {
                crate::terminal::herdr_state::record_ask_answer(&session, &ask.call_id);
                crate::terminal::herdr_state::ask_answers_delivered(&session, &ask.call_id)
            });
            tracing::info!(%session, pane, chars = text.chars().count(), ?delivered, "pane answer sent");
            // The listing's pendingAsk moves to the next question now, not
            // at the next file change (there is none until the last answer).
            crate::sessions::index::trigger_refresh(&state);
            ok(json!({ "ok": true, "answered": delivered, "delivery": "handoff" }))
        }
        Err(e) => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "ok": false, "code": "answer_delivery_uncertain", "error": e
            }),
        ),
    }
}
