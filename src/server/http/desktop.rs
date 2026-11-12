//! Desktop endpoints: collab attach/detach, collab link registration and
//! announcement, and handing a conversation to the laptop or closing it there.

use super::*;
use crate::sessions::jsonl;
use axum::{Json, extract::State, http::StatusCode, response::Response};
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) async fn collab_attach(
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
    // Already live: rejoining would flap the guest task for nothing.
    if state.collab.is_attached(&session) && state.collab.can_write(&session) {
        return ok(json!({ "ok": true }));
    }
    // With a link: attach first, remember only on SUCCESS (a bogus link must
    // never poison the stored mapping).
    let explicit = body
        .get("link")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(l) = explicit {
        // Explicit link: report its own failure precisely (a typo must not
        // turn into a terminal scan with a vaguer error).
        return match state.collab.attach(&session, &l).await {
            Ok(()) => {
                state.collab.remember_link(&session, &l);
                ok(json!({ "ok": true }))
            }
            Err(e) => err(&e),
        };
    }
    // No link: every non-intrusive path first (stored, then announced),
    // falling through on failure exactly like the write path, and only then
    // asking the laptop to share (display adoption — explicit tap, no cooldown).
    let session_id = jsonl::parse_header(&path).id;
    if let Some(l) = state
        .collab
        .auto_attach_link(&session, session_id.as_deref())
        && state.collab.attach(&session, &l).await.is_ok()
    {
        return ok(json!({ "ok": true }));
    }
    match display_adoption_link(&state, &session, false).await {
        Adoption::Live(link) => {
            state.collab.remember_link(&session, &link);
            ok(json!({ "ok": true }))
        }
        // The reason matters on this path: the user tapped BECAUSE the phone
        // said the desktop held the conversation, so "couldn't find this
        // conversation in any terminal" is the wrong answer when a terminal
        // was found and its share could not be joined (measured 2026-09-14,
        // while the desktop was visibly showing its collab box).
        Adoption::Failed(e) => err(&e),
        Adoption::Skipped(why) => err(why),
    }
}

pub(super) async fn collab_detach(
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
    state.collab.detach(&session);
    // The badge must honestly return to "file only" immediately, not on the
    // next host broadcast (the host is gone, so none will come).
    state.hub.broadcast(&session, &collab_state_frame());
    ok(json!({ "ok": true }))
}

/// Move a conversation the laptop is not running into a new herdr tab there
/// (`handoff.rs`): the owner's omp TUI resumes it, and its extension bridges
/// it back to the phone. Refusals keep HTTP 200 with a stable `code`
/// (`already_on_laptop`, `turn_running`, `herdr_start_failed`, …) and a
/// sentence the phone shows as it is.
pub(super) async fn desktop_open(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let Some(raw) = session_path_from_body(&body) else {
        return err_status(StatusCode::BAD_REQUEST, "sessionPath required");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err_status(StatusCode::BAD_REQUEST, "invalid session path");
    };
    // A fresh `/api/new` session has no file until its first write, and omp
    // cannot resume what does not exist.
    if !path.is_file() {
        return err_status(StatusCode::NOT_FOUND, "session file not found");
    }
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    let cwd = session_cwd(&state.cfg, &path);
    match crate::terminal::handoff::open_in_herdr(&state, &session, &cwd).await {
        Ok(opened) => ok(opened.to_json()),
        Err(refusal) => ok(json!({
            "ok": false,
            "error": refusal.message,
            "code": refusal.code,
        })),
    }
}
pub(super) async fn desktop_close(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let Some(raw) = session_path_from_body(&body) else {
        return err_status(StatusCode::BAD_REQUEST, "sessionPath required");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err_status(StatusCode::BAD_REQUEST, "invalid session path");
    };
    if !path.is_file() {
        return err_status(StatusCode::NOT_FOUND, "session file not found");
    }
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    match crate::terminal::handoff::close_in_herdr(&state, &session).await {
        Ok(closed) => ok(closed.to_json()),
        Err(refusal) => ok(json!({
            "ok": false,
            "error": refusal.message,
            "code": refusal.code,
        })),
    }
}

/// Register a collab link keyed by ROOM id only — the `omp_pulse term` host
/// path: the daemon auto-runs `/collab`, scrapes the printed link from the
/// pty stream and posts it here BEFORE any session file exists. The link is
/// validated and stored durably so the relay taps the room as soon as the
/// host connects.
pub(super) async fn collab_register(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let link = match body.get("link").and_then(|v| v.as_str()) {
        Some(l) if !l.is_empty() => l,
        _ => return ok(json!({ "ok": false, "error": "invalid link" })),
    };
    match state.collab.register_and_tap(link) {
        Ok(()) => ok(json!({ "ok": true })),
        Err(_) => ok(json!({ "ok": false, "error": "invalid link" })),
    }
}

/// Announce a host link for an omp session id — the zero-link introduction
/// path. A host that can reach the daemon (the future auto-sharing TUI over
/// loopback+pairing-token; the phone never sees links) declares which room
/// carries a session; opening that session then auto-attaches with no scan,
/// paste, or terminal ceremony. Token-gated like every mutating route (the
/// pairing token already guards driving sessions, which strictly dominates
/// announcing a room for one). Returns the room id.
pub(super) async fn collab_announce(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let session_id = match body.get("sessionId").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.trim(),
        _ => return ok(json!({ "ok": false, "error": "sessionId required" })),
    };
    let link = match body.get("link").and_then(|v| v.as_str()) {
        Some(l) if !l.is_empty() => l,
        _ => return ok(json!({ "ok": false, "error": "invalid link" })),
    };
    match state.collab.announce_session_link(session_id, link) {
        Ok(room) => {
            // A live room starts streaming to whoever watches it without
            // waiting for the next host reconnect.
            state.relay.tap_room_if_live(&room);
            ok(json!({ "ok": true, "room": room }))
        }
        Err(_) => ok(json!({ "ok": false, "error": "invalid link" })),
    }
}
