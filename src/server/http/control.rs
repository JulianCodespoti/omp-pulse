//! Session control endpoints: bash, slash commands, delete, abort and new session.

use super::*;
use crate::{sessions::index, sessions::jsonl};
use axum::{Json, extract::State, http::StatusCode, response::Response};
use serde_json::{Value, json};
use std::{path::Path as FsPath, sync::Arc, time::Instant};

pub(super) async fn bash(
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
    let command = body.get("command").and_then(|v| v.as_str()).unwrap_or("");
    if command.is_empty() {
        return err_status(StatusCode::BAD_REQUEST, "command required");
    }
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    match write_path(&state, &session).await {
        WritePath::Refused(reason) => return refusal_body(&reason),
        // The collab host is the session's writer, but the collab protocol has
        // no bash channel — a child would be a second writer to a file the
        // desktop's omp owns (its wholesale rewrites destroy appended output).
        // Refuse with the stable owned-by-terminal shape so the phone offers
        // the manual fallback (run it in the desktop terminal) instead of
        // silently losing the result.
        WritePath::Host => {
            return ok(json!({
                "ok": false,
                // The code is unchanged (the client's sticky banner keys on it
                // and offers the /collab connect sheet); the human text must be
                // actionable for a phone-only user, so it names the one action
                // that helps from here instead of telling them to open a
                // terminal they do not have.
                "error": "session is collab-hosted by the desktop omp, which has no bash channel — run the command in the desktop terminal, or connect via /collab to drive the session from the phone",
                "code": "session_owned_by_terminal",
            }));
        }
        // The bridged owner runs turns, not ad-hoc shell commands: omp's
        // extension API has no bash action, and a child here would be the
        // second writer the bridge exists to avoid.
        WritePath::Bridge(_) => {
            return ok(json!({
                "ok": false,
                "error": "this conversation is open in omp on the desktop, which runs shell commands only for its agent — ask the agent to run it",
                "code": "session_owned_by_terminal",
            }));
        }
        WritePath::Child => {}
    }
    // `!!cmd`: the output lands in the transcript but is kept out of the
    // model's context, exactly as in the TUI. Same response shape either way.
    let exclude_from_context =
        body.get("excludeFromContext").and_then(Value::as_bool) == Some(true);
    // The client's name for this run: live output reaches every client as
    // `bash_output` frames carrying it, so the sheet that started the
    // command can tell its own stream apart.
    let run_id = body
        .get("runId")
        .and_then(Value::as_str)
        .filter(|id| valid_run_id(id))
        .map(str::to_owned);
    // A user command has no deadline, so the phone's request may drop long
    // before it ends (WebView backgrounded, network change). Dropping the
    // wait would abandon the RPC, and an abandoned RPC fences the child
    // against the `abort_bash` that Stop sends. Detached, only the command's
    // end or Stop settles it; every client still gets the `bash_result`.
    let children = Arc::clone(&state.children);
    let command = command.to_string();
    let run = tokio::spawn(async move {
        children
            .bash(&session, &command, exclude_from_context, run_id.as_deref())
            .await
    });
    match run
        .await
        .unwrap_or_else(|e| Err(format!("bash task failed: {e}")))
    {
        Ok(result) => {
            ok(json!({ "ok": true, "result": serde_json::to_value(result).unwrap_or(json!({})) }))
        }
        Err(e) => {
            if owned_by_terminal(&e) {
                ok(json!({ "ok": false, "error": e, "code": "session_owned_by_terminal" }))
            } else {
                child_error(&e)
            }
        }
    }
}

/// A client run id is echoed into every client's frames and the child's
/// status keys: short, and only characters that need no escaping anywhere.
fn valid_run_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Slash commands whose answer belongs to the account or the omp build, not to
/// a conversation. They run on a throwaway child, so they work while the
/// desktop owns the session and never touch its file.
const ACCOUNT_SCOPED_COMMANDS: &[&str] = &["usage"];

/// `/name args` -> `name`, lowercased. omp's parser also treats `:` as the
/// name/args separator (`/model:foo` runs `/model`), so the name stops there.
fn slash_command_name(text: &str) -> Option<String> {
    let rest = text.trim_start().strip_prefix('/')?;
    let name: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != ':')
        .collect();
    (!name.is_empty()).then(|| name.to_lowercase())
}

/// Run a builtin slash command and return what it printed, WITHOUT queueing a
/// prompt: no user message, no receipt, no transcript entry. The phone shows
/// the text in a sheet. (Sending `/usage` through `/api/prompt` echoed it into
/// the chat as if the user had said it.)
pub(super) async fn command(
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
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let Some(name) = slash_command_name(text) else {
        return err_status(StatusCode::BAD_REQUEST, "text must be a slash command");
    };
    if text.len() > 4096 {
        return err_status(StatusCode::BAD_REQUEST, "command too long");
    }
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    let run = if ACCOUNT_SCOPED_COMMANDS.contains(&name.as_str()) {
        let cwd = jsonl::parse_header(&path)
            .cwd
            .filter(|c| FsPath::new(c).is_dir())
            .unwrap_or_else(|| state.cfg.home.to_string_lossy().into_owned());
        state.children.run_command_detached(&cwd, text).await
    } else {
        // Everything else may read or change the conversation, so the same
        // single-writer rule as every other mutation applies.
        if let Some(response) = ownership_refusal(write_path(&state, &session).await) {
            return response;
        }
        state.children.run_command(&session, text).await
    };
    match run {
        Ok(run) => {
            ok(json!({ "ok": true, "output": run.output, "agentInvoked": run.agent_invoked }))
        }
        Err(e) if owned_by_terminal(&e) => {
            ok(json!({ "ok": false, "error": e, "code": "session_owned_by_terminal" }))
        }
        Err(e) => child_error(&e),
    }
}

/// Delete a conversation from the phone through omp's own `/session delete`,
/// which closes omp's writer before removing the file and its artifacts.
/// Only when the daemon's child is (or may become) the ONLY writer: a
/// session open on the desktop, shared over collab, held by any process the
/// guard can see, or with work still running is refused untouched.
pub(super) async fn delete_session(
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
    if let Some(refusal) = daemon_child_refusal(&state, &session, "delete it there") {
        return refusal;
    }
    let authority = session_authority(&state, &session);
    if authority.turn == crate::authority::session_state::Turn::Running
        || state
            .session_states
            .current(&session)
            .is_some_and(|s| s.background_work)
    {
        return err_status(
            StatusCode::CONFLICT,
            "the agent is still working in this conversation; stop it or wait, then delete",
        );
    }
    let run = match state
        .children
        .run_command(&session, "/session delete")
        .await
    {
        Ok(run) => run,
        Err(e) if owned_by_terminal(&e) => return refusal_body(&e),
        Err(e) => return child_error(&e),
    };
    // omp answers a refusal ("Cannot delete the session while streaming.")
    // as printed text too; only its success line means the file is gone.
    if !run.output.trim_start().starts_with("Session deleted:") {
        let reason = run.output.trim();
        return err_status(
            StatusCode::CONFLICT,
            if reason.is_empty() {
                "omp did not delete the session"
            } else {
                reason
            },
        );
    }
    // The stopped child was the only writer (checked above), but omp's
    // session manager still named the deleted path until it exited, and an
    // exiting writer can flush one last entry and resurrect the file
    // (observed in verify-small-parity: `{ok:true}` and the file back a
    // moment later). `stop_deleted` returns once the process is reaped
    // (SIGKILL past a deadline); `has_child` turns false at SIGTERM and
    // never measured the exit. With the writer gone, finish what omp started.
    let exited = state.children.stop_deleted(&session).await;
    if !exited {
        tracing::warn!(%session, "deleted session's agent process did not exit in time");
    }
    if path.exists() && !state.children.has_child(&session) {
        let _ = tokio::fs::remove_file(&path).await;
    }
    crate::sessions::index::trigger_refresh(&state);
    if path.exists() {
        return err_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            "omp reported the session deleted, but its file is still there",
        );
    }
    ok(json!({ "ok": true }))
}

pub(super) async fn abort(
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
    let authority = session_authority(&state, &session);
    if authority.owner.kind == "ambiguous" {
        return err_status(
            StatusCode::CONFLICT,
            "conflicting live session owners; no command was dispatched",
        );
    }
    let restore_queue = body.get("restoreQueue").and_then(Value::as_bool) == Some(true);
    // Stop uses the accepted owner, never a second route after transport failure.
    if let Some(pid) = authority
        .owner
        .pid
        .filter(|_| authority.owner.kind == "bridge")
    {
        return match crate::omp::desktop_control::rpc_for_owner(
            &state.cfg,
            &session,
            pid,
            if restore_queue {
                "abort_and_restore_queue"
            } else {
                "abort"
            },
            json!({}),
        )
        .await
        {
            Ok(mut v) if v.get("ok").and_then(Value::as_bool) == Some(true) => {
                if restore_queue {
                    ok(json!({
                        "ok": true,
                        "stopped": true,
                        "withdrawn": withdrawn_queue(v["data"].take()),
                    }))
                } else {
                    ok(json!({ "ok": true }))
                }
            }
            Ok(v) => err(v
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("the desktop refused to stop")),
            Err(e) => err(&e),
        };
    }
    if restore_queue && authority.owner.kind == "foreign" {
        return err(
            "the desktop control bridge is unavailable; queued messages cannot be restored safely",
        );
    }
    // Mirror the prompt routing: when collab-attached, abort the HOST's turn
    // (the laptop runs it), else the daemon child.
    if authority.owner.kind == "collab" {
        if restore_queue {
            return err(
                "the desktop control bridge is unavailable; queued messages cannot be restored safely",
            );
        }
        return match state.collab.send_abort(&session) {
            Ok(()) => ok(json!({ "ok": true })),
            Err(e) => err(&e),
        };
    }
    // No agent of ours took the Stop (none running, or it died answering).
    // A turn the record still shows running belonged to a child that exited
    // without ending it; nothing else will ever settle it, so Stop does.
    // `restoreQueue`: the app's Stop withdraws omp's queued messages and puts
    // their text and photos back in the composer. Callers that ignore the reply (the
    // notification Stop action) keep plain `abort`, which lets omp run them
    // later instead of losing them.
    let outcome = if restore_queue {
        // The withdrawal and its journal write outlive a dropped HTTP waiter.
        let children = Arc::clone(&state.children);
        let withdrawal_session = session.clone();
        queue_recovery::capture(
            state.cfg.state_dir.clone(),
            session.clone(),
            "queue",
            None,
            async move { children.abort(&withdrawal_session, true).await },
        )
        .await
    } else {
        state.children.abort(&session, false).await
    };
    match outcome {
        Ok(Some(restored)) if restore_queue => ok(json!({
            "ok": true,
            "stopped": true,
            "withdrawn": withdrawn_queue(restored),
        })),
        Ok(Some(_)) => ok(json!({ "ok": true, "stopped": true })),
        Ok(None) => {
            if state.session_states.release_retired_child(&session) {
                crate::authority::activity::publish_idle(&session);
                index::trigger_refresh(&state);
            }
            ok(json!({ "ok": true, "stopped": false, "reason": "no agent running" }))
        }
        Err(e) => err(&e),
    }
}

/// Keep each owner's text paired with its photos in delivery order without
/// copying payloads: attachment reference numbers restart for every message.
/// Loss flags describe only an actual upstream frame-fit fallback.
fn withdrawn_queue(mut restored: Value) -> Value {
    let capacity = ["steering", "followUp"]
        .iter()
        .filter_map(|queue| restored.get(queue).and_then(Value::as_array))
        .map(Vec::len)
        .sum();
    let mut messages = Vec::with_capacity(capacity);
    let images_dropped = restored.get("imagesDropped").and_then(Value::as_bool) == Some(true);
    let truncated = restored.get("truncated").and_then(Value::as_bool) == Some(true);
    for queue in ["steering", "followUp"] {
        if let Some(entries) = restored.get_mut(queue).and_then(Value::as_array_mut) {
            for mut entry in std::mem::take(entries) {
                let text = match entry.get_mut("text") {
                    Some(text @ Value::String(_)) => text.take(),
                    _ => Value::String(String::new()),
                };
                let mut images = entry
                    .get_mut("images")
                    .and_then(Value::as_array_mut)
                    .map(std::mem::take)
                    .unwrap_or_default();
                for image in &mut images {
                    if let Some(object) = image.as_object_mut() {
                        object.remove("type");
                    }
                }
                messages.push(Value::Object(serde_json::Map::from_iter([
                    ("text".into(), text),
                    ("images".into(), Value::Array(images)),
                ])));
            }
        }
    }
    let mut output = serde_json::Map::from_iter([
        ("messages".into(), Value::Array(messages)),
        ("imagesDropped".into(), Value::Bool(images_dropped)),
        ("truncated".into(), Value::Bool(truncated)),
    ]);
    // The journal id the phone acknowledges once its own draft save lands, or
    // `recoveryPending` when the record is too large for the reply frame.
    for key in ["recoveryId", "recoveryPending"] {
        if let Some(value) = restored.get_mut(key) {
            output.insert(key.into(), value.take());
        }
    }
    Value::Object(output)
}

pub(super) async fn new_session(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let cwd = body
        .get("cwd")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.cfg.home.to_str().unwrap_or("/"));
    if !FsPath::new(cwd).is_dir() {
        return err_status(StatusCode::BAD_REQUEST, "invalid cwd");
    }
    match state.children.new_session(cwd).await {
        Ok(session_path) => {
            // A fresh session's .jsonl is materialized by omp on first write —
            // until then /api/open and /ws tolerate it via RECENT_NEW. It is
            // deliberately NOT named here: omp records any `set_session_name`
            // as a user title, so naming it after its folder blocked every
            // real title for good. The first prompt titles it instead
            // (`title_untitled_session`); until that lands the list shows the
            // prompt itself (`jsonl::first_prompt_title`).
            if let Ok(mut g) = RECENT_NEW.lock() {
                g.insert(session_path.clone(), Instant::now());
            }
            ok(json!({ "ok": true, "sessionPath": session_path }))
        }
        Err(e) => child_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn withdrawn_queue_preserves_text_and_images_in_delivery_order() {
        let restored = json!({
            "steering": [{ "text": " steer me\n", "images": [
                { "type": "image", "data": "original-steering", "mimeType": "image/png" }
            ] }],
            "followUp": [
                { "text": "", "images": [{ "type": "image", "data": "original-photo", "mimeType": "image/jpeg" }] },
                { "text": "and that" },
            ],
        });
        assert_eq!(
            withdrawn_queue(restored),
            json!({
                "messages": [
                    { "text": " steer me\n", "images": [{ "data": "original-steering", "mimeType": "image/png" }] },
                    { "text": "", "images": [{ "data": "original-photo", "mimeType": "image/jpeg" }] },
                    { "text": "and that", "images": [] },
                ],
                "imagesDropped": false,
                "truncated": false,
            })
        );
    }

    #[test]
    fn withdrawn_queue_keeps_actual_upstream_loss_flags() {
        let fitted = json!({ "steering": [], "followUp": [{ "text": "a" }], "imagesDropped": true, "truncated": true });
        assert_eq!(
            withdrawn_queue(fitted),
            json!({ "messages": [{ "text": "a", "images": [] }], "imagesDropped": true, "truncated": true })
        );
        assert_eq!(
            withdrawn_queue(Value::Null),
            json!({ "messages": [], "imagesDropped": false, "truncated": false })
        );
        assert_eq!(
            withdrawn_queue(
                json!({ "steering": [{ "images": [{ "type": "image", "data": "image-only", "mimeType": "image/png" }] }] })
            ),
            json!({ "messages": [{ "text": "", "images": [{ "data": "image-only", "mimeType": "image/png" }] }], "imagesDropped": false, "truncated": false })
        );
    }

    #[test]
    fn slash_command_name_matches_how_omp_parses_it() {
        // The account-scoped allowlist keys on this: `/usage:x` runs /usage in
        // omp, so it must not slip past as a different name; and a plain
        // message is not a command at all.
        assert_eq!(slash_command_name("/usage"), Some("usage".to_string()));
        assert_eq!(
            slash_command_name("  /Usage  extra args"),
            Some("usage".to_string())
        );
        assert_eq!(slash_command_name("/usage:all"), Some("usage".to_string()));
        assert_eq!(slash_command_name("usage"), None);
        assert_eq!(slash_command_name("/"), None);
        assert_eq!(slash_command_name("/ usage"), None);
    }

    #[test]
    fn bash_run_ids_are_short_and_need_no_escaping() {
        assert!(valid_run_id("bash-lx3k9-a1B2_c"));
        assert!(valid_run_id(&"a".repeat(64)));
        assert!(!valid_run_id(""));
        assert!(!valid_run_id(&"a".repeat(65)));
        assert!(!valid_run_id("run 1"));
        assert!(!valid_run_id("run:1"));
        assert!(!valid_run_id("run\"1"));
        assert!(!valid_run_id("rün"));
    }
}
