//! Command receipts: the receipt endpoints, prompt admission responses and the
//! watcher that settles a prompt's receipt from its child's events.

use super::*;
use crate::{
    authority::command_ledger::{
        CommandLedger, CommandReceipt, ReceiptState, Submission, SubmitError,
    },
    types::Config,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Response,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub(super) async fn receipts(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ReceiptsQuery>,
) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err_status(StatusCode::BAD_REQUEST, "session required");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    let receipts = state.commands.for_session(&session);
    ok(json!({ "ok": true, "receipts": receipts }))
}

/// The request and resolver supply the witness; the receipt cannot certify its
/// own relationship to a raw alias. Keep this check shared by POST and scoped GET.
pub(super) fn bound_receipt_response(
    raw: &str,
    canonical: &str,
    receipt: CommandReceipt,
) -> Response {
    if receipt.session_path != canonical {
        return json_response(
            StatusCode::CONFLICT,
            json!({
                "ok": false,
                "code": "receipt_session_mismatch",
                "error": "receipt belongs to a different session",
            }),
        );
    }
    ok(json!({
        "ok": true,
        "receipt": receipt,
        "receiptBinding": {
            "version": 1,
            "requestedSessionPath": raw,
            "canonicalSessionPath": canonical,
        },
    }))
}

pub(super) fn receipt_response(
    cfg: &Config,
    commands: &CommandLedger,
    command_id: &str,
    raw: Option<&str>,
) -> Response {
    // Validate before looking up the ID: 404 means absent after a valid scope,
    // never an invalid path or a receipt for a different canonical session.
    let canonical = if let Some(raw) = raw {
        let resolved =
            resolve_session_path(cfg, raw).and_then(|path| path.to_str().map(str::to_owned));
        let Some(canonical) = resolved else {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({
                    "ok": false,
                    "code": "receipt_session_invalid",
                    "error": "invalid session path",
                }),
            );
        };
        Some(canonical)
    } else {
        None
    };
    // Exact-ID reads include the archive. The hot session list cannot prove absence.
    match commands.get(command_id) {
        Ok(Some(receipt)) => match (raw, canonical.as_deref()) {
            (Some(raw), Some(canonical)) => bound_receipt_response(raw, canonical, receipt),
            _ => ok(json!({ "ok": true, "receipt": receipt })),
        },
        Ok(None) => err_status(StatusCode::NOT_FOUND, "receipt not found"),
        Err(error) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

pub(super) async fn receipt(
    State(state): State<Arc<AppState>>,
    Path(command_id): Path<String>,
    Query(q): Query<ReceiptsQuery>,
) -> Response {
    receipt_response(
        &state.cfg,
        &state.commands,
        &command_id,
        q.session.as_deref(),
    )
}

/// Only a new durable admission can continue to writer selection/dispatch.
/// Replays and failures return here, before any transport is touched.
pub(super) fn prompt_admission_response(
    submission: Result<Submission, SubmitError>,
    raw: &str,
    canonical: &str,
) -> Option<Response> {
    match submission {
        Ok(Submission::New(_)) => None,
        Ok(Submission::Existing(receipt)) => Some(bound_receipt_response(raw, canonical, receipt)),
        Err(SubmitError::Conflict(existing)) => Some(json_response(
            StatusCode::CONFLICT,
            json!({"ok": false, "error": "commandId already used for a different request", "receipt": existing}),
        )),
        Err(SubmitError::Capacity) => Some(err_status(
            StatusCode::SERVICE_UNAVAILABLE,
            "command receipt ledger is full",
        )),
        Err(SubmitError::Persistence(error)) => {
            Some(err_status(StatusCode::INTERNAL_SERVER_ERROR, &error))
        }
    }
}

fn receipt_source_is_current(
    session_states: &crate::authority::session_state::SessionStateRegistry,
    session: &str,
    expected_source: &crate::authority::session_state::SourceIdentity,
) -> bool {
    let Some(state) = session_states.current(session) else {
        // The prompt response can race the first event that seeds authority.
        // No record is not evidence that this source has been retired.
        return true;
    };
    state.owner.kind != "ambiguous"
        && session_states
            .source_snapshot(session)
            .is_some_and(|current| current.identity == *expected_source)
}
const RECEIPT_WATCH_STEP: Duration = Duration::from_secs(600);
const RECEIPT_WATCH_MAX: Duration = Duration::from_secs(24 * 3600);
/// omp emits a prompt's authoritative `prompt_result` just after `agent_end`
/// (setImmediate). The watcher waits this long for it before settling from
/// the turn's own messages.
const AGENT_END_GRACE: Duration = Duration::from_millis(750);

/// Outcome of a turn the agent received but that did not end cleanly.
fn turn_failure(message: String) -> (String, String) {
    (
        crate::authority::command_ledger::turn_error_code(&message).to_owned(),
        message,
    )
}

/// A prompt the agent received settles `completed`; a stopped, errored,
/// refused or interrupted turn keeps its outcome as the code (and detail).
/// `failed` is reserved for prompts that never reached the agent.
fn settle_received(ledger: &CommandLedger, command_id: &str, outcome: Option<(String, String)>) {
    let _ = match outcome {
        Some((code, error)) => ledger.update(
            command_id,
            ReceiptState::Completed,
            Some(&code),
            Some(&error),
        ),
        None => ledger.update(command_id, ReceiptState::Completed, None, None),
    };
}
pub(super) async fn watch_child_receipt(
    ledger: Arc<CommandLedger>,
    mut events: tokio::sync::broadcast::Receiver<crate::types::ChildEvent>,
    command_id: String,
    session: String,
    expected_source: crate::authority::session_state::SourceIdentity,
    session_states: Arc<crate::authority::session_state::SessionStateRegistry>,
) {
    // An accepted turn may legitimately run for hours (agent work on a phone
    // routinely passes ten minutes). The deadline only catches a turn whose
    // events stopped: while the agent that started it is still the session's
    // current source it re-arms, up to RECEIPT_WATCH_MAX in total.
    let watch_started = tokio::time::Instant::now();
    let deadline = tokio::time::sleep(RECEIPT_WATCH_STEP);
    tokio::pin!(deadline);
    let mut started = false;
    let mut failure: Option<(String, String)> = None;
    // Set by a terminal `agent_end`: the outcome to settle with unless the
    // authoritative `prompt_result` lands within AGENT_END_GRACE.
    let mut ended: Option<Option<(String, String)>> = None;
    // Outcome of a `prompt_result` seen with `sessionSettled: false`: the
    // turn yielded but background work may still wake the session, so the
    // receipt waits for the follow-up `session_settled` frame.
    let mut pending_prompt: Option<Option<(String, String)>> = None;
    loop {
        tokio::select! {
            _ = &mut deadline => {
                if let Some(outcome) = ended.take() {
                    settle_received(&ledger, &command_id, outcome);
                    return;
                }
                // The child acknowledged this prompt (the watcher only starts
                // after it did). A follow-up sent mid-turn never gets its own
                // `agent_start`; its `prompt_result` comes when the whole turn
                // ends, so re-arm for any received prompt while its agent is
                // still the session's source.
                if watch_started.elapsed() < RECEIPT_WATCH_MAX
                    && receipt_source_is_current(&session_states, &session, &expected_source)
                {
                    deadline.as_mut().reset(tokio::time::Instant::now() + RECEIPT_WATCH_STEP);
                    continue;
                }
                let _ = ledger.update(
                    &command_id,
                    ReceiptState::Uncertain,
                    Some("child_lifecycle_timeout"),
                    Some("child accepted the prompt but emitted no terminal lifecycle event"),
                );
                return;
            }
            event = events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(error) => {
                        let _ = ledger.update(&command_id, ReceiptState::Uncertain,
                            Some("child_lifecycle_lost"), Some(&error.to_string()));
                        return;
                    }
                };
                let (event_session, event) = match event {
                    crate::types::ChildEvent::Event { session, event, source: Some(source) }
                        if source.identity == expected_source => (session, event),
                    crate::types::ChildEvent::Notice { session: notice_session, message, source: Some(source) }
                        if source.identity == expected_source
                            && notice_session == session
                            && message.starts_with("agent process ")
                            && receipt_source_is_current(&session_states, &session, &expected_source) =>
                    {
                        // The agent process exited (or was restarted) after it
                        // took this prompt: delivered, turn interrupted.
                        settle_received(&ledger, &command_id, Some((
                            crate::authority::command_ledger::AGENT_INTERRUPTED.to_owned(),
                            message,
                        )));
                        return;
                    }
                    _ => continue,
                };
                if event_session != session { continue; }
                // The receipt watcher has its own broadcast receiver, so it
                // independently fences events against the current binding.
                // Delayed events from a retired source must not settle a newer
                // turn's receipt even when they carry the same command ID.
                if !receipt_source_is_current(&session_states, &session, &expected_source) {
                    continue;
                }
                let typ = event.get("type").and_then(Value::as_str).unwrap_or("");
                // `session_settled` carries no `commandId` (upstream
                // `RpcSessionSettledFrame` is `{type}` only): it settles the
                // pending `prompt_result` above for this session.
                if typ == "session_settled" {
                    if let Some(outcome) = pending_prompt.take() {
                        settle_received(&ledger, &command_id, outcome);
                        return;
                    }
                    continue;
                }
                if event.get("commandId").and_then(Value::as_str) != Some(command_id.as_str()) {
                    continue;
                }
                if typ == "prompt_response" && event.get("success").and_then(Value::as_bool) == Some(false) {
                    let error = event.get("error").and_then(Value::as_str).unwrap_or("agent rejected the prompt");
                    let _ = ledger.update(&command_id, ReceiptState::Failed, Some("agent_rejected"), Some(error));
                    return;
                }
                // `prompt_result` is the terminal frame for an accepted prompt
                // (emitted exactly once; upstream `RpcPromptResultFrame`): its
                // `status` carries the outcome and `sessionSettled` says whether
                // anything can still wake the session. When `sessionSettled` is
                // false a `session_settled` frame follows once background work
                // drains — that, not `agent_end`, is the terminal event.
                if typ == "prompt_result" {
                    if event.get("agentInvoked").and_then(Value::as_bool) == Some(false) {
                        settle_received(&ledger, &command_id, None);
                        return;
                    }
                    let status = event.get("status").and_then(Value::as_str).unwrap_or("");
                    let settled = event.get("sessionSettled").and_then(Value::as_bool).unwrap_or(true);
                    let outcome: Option<(String, String)> = match status {
                        "aborted" => Some((crate::authority::command_ledger::AGENT_ABORTED.to_owned(), "The turn was stopped.".to_owned())),
                        "error" => {
                            let detail = event.get("error");
                            let message = detail
                                .and_then(|e| e.get("message").and_then(Value::as_str))
                                .or_else(|| detail.and_then(Value::as_str))
                                .unwrap_or("Agent reported an error.");
                            let retryable = detail
                                .and_then(|e| e.get("retryable").and_then(Value::as_bool))
                                .unwrap_or(false);
                            let message = if retryable {
                                format!("{message} (retryable)")
                            } else {
                                message.to_owned()
                            };
                            Some(turn_failure(message))
                        }
                        _ => None,
                    };
                    if settled {
                        settle_received(&ledger, &command_id, outcome);
                        return;
                    }
                    ended = None;
                    // Unsettled: background work may still inject a follow-up.
                    pending_prompt = Some(outcome);
                    started = true;
                    let _ = ledger.update(&command_id, ReceiptState::Running, None, None);
                    continue;
                }
                if typ == "prompt_response" && event.pointer("/data/agentInvoked").and_then(Value::as_bool) == Some(false) {
                    settle_received(&ledger, &command_id, None);
                    return;
                }
                if typ == "agent_start" {
                    started = true;
                    ended = None;
                    let _ = ledger.update(&command_id, ReceiptState::Running, None, None);
                } else if typ == "message_end" {
                    let message = event.get("message").unwrap_or(&event);
                    let stop = message.get("stopReason").and_then(Value::as_str);
                    let error = message.get("errorMessage").or_else(|| message.get("error")).and_then(Value::as_str);
                    if stop == Some("aborted") {
                        failure = Some((crate::authority::command_ledger::AGENT_ABORTED.to_owned(), "The turn was stopped.".to_owned()));
                    } else if let Some(error) = error {
                        failure = Some(turn_failure(error.to_owned()));
                    } else if stop == Some("error") {
                        failure = Some(turn_failure("Agent reported an error.".to_owned()));
                    } else if matches!(stop, Some("stop" | "toolUse")) {
                        // omp retried past an earlier error and the turn went on.
                        failure = None;
                    }
                } else if typ == "agent_end"
                    && started
                    && event.get("isTerminal").and_then(Value::as_bool) != Some(false)
                    && event.get("bridgeLost").and_then(Value::as_bool) != Some(true)
                {
                    if pending_prompt.is_some() {
                        // A `prompt_result` with `sessionSettled: false` owns
                        // this receipt now; `agent_end` is only one run
                        // yielding, not the work settling.
                        continue;
                    }
                    // Prefer the `prompt_result` that follows; settle from the
                    // turn's messages only if it does not arrive.
                    ended = Some(failure.take());
                    deadline.as_mut().reset(tokio::time::Instant::now() + AGENT_END_GRACE);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn receipt_after(events: &[Value]) -> crate::authority::command_ledger::CommandReceipt {
        let root = std::env::temp_dir().join(format!(
            "pulse-receipt-events-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let ledger = Arc::new(CommandLedger::open(&root).unwrap());
        ledger
            .submit("mine", "/isolated/session.jsonl", "fingerprint")
            .unwrap();
        ledger
            .update("mine", ReceiptState::Received, None, None)
            .unwrap();
        let source = crate::authority::session_state::SourceIdentity {
            kind: crate::authority::session_state::SourceKind::Child,
            source_id: 1,
            binding_epoch: 1,
            pid: Some(123),
            process_start: Some(1),
            peer_id: None,
            room_id: None,
            can_write: None,
        };
        let (tx, rx) = tokio::sync::broadcast::channel(16);
        for event in events {
            tx.send(crate::types::ChildEvent::Event {
                session: "/isolated/session.jsonl".to_owned(),
                event: event.clone(),
                source: Some(crate::authority::session_state::SourceStamp {
                    identity: source.clone(),
                    sequence: 1,
                }),
            })
            .unwrap();
        }
        tokio::time::timeout(
            Duration::from_secs(2),
            watch_child_receipt(
                Arc::clone(&ledger),
                rx,
                "mine".to_owned(),
                "/isolated/session.jsonl".to_owned(),
                source.clone(),
                {
                    let registry =
                        Arc::new(crate::authority::session_state::SessionStateRegistry::default());
                    registry.project(
                        "/isolated/session.jsonl",
                        crate::authority::session_state::Seed {
                            owner: source.wire_owner(),
                            turn: crate::authority::session_state::Turn::Unknown,
                            confidence: crate::authority::session_state::Confidence::Confirmed,
                            connection: crate::authority::session_state::Connection::Connected,
                            activity: None,
                            capabilities: crate::authority::session_state::Capabilities::default(),
                            source: Some(source),
                            sequence: 0,
                        },
                    );
                    registry
                },
            ),
        )
        .await
        .expect("receipt must settle from the supplied terminal evidence");
        let receipt = ledger.get("mine").unwrap().unwrap();
        std::fs::remove_dir_all(root).unwrap();
        receipt
    }
    #[test]
    fn receipt_source_fence_rejects_retired_binding() {
        let registry = crate::authority::session_state::SessionStateRegistry::default();
        let source = crate::authority::session_state::SourceIdentity {
            kind: crate::authority::session_state::SourceKind::Child,
            source_id: 4,
            binding_epoch: 9,
            pid: Some(234),
            process_start: Some(5),
            peer_id: None,
            room_id: None,
            can_write: None,
        };
        registry.project(
            "/isolated/session.jsonl",
            crate::authority::session_state::Seed {
                owner: source.wire_owner(),
                turn: crate::authority::session_state::Turn::Unknown,
                confidence: crate::authority::session_state::Confidence::Confirmed,
                connection: crate::authority::session_state::Connection::Connected,
                activity: None,
                capabilities: crate::authority::session_state::Capabilities::default(),
                source: Some(source.clone()),
                sequence: 1,
            },
        );
        assert!(receipt_source_is_current(
            &registry,
            "/isolated/session.jsonl",
            &source
        ));
        registry.retire_source("/isolated/session.jsonl", &source);
        assert!(!receipt_source_is_current(
            &registry,
            "/isolated/session.jsonl",
            &source
        ));
    }
    #[tokio::test]
    async fn receipt_waits_past_tool_messages_and_other_commands_for_its_turn_outcome() {
        let receipt = receipt_after(&[
            json!({"type":"agent_start","commandId":"other"}),
            json!({"type":"agent_end","commandId":"other"}),
            json!({"type":"agent_start","commandId":"mine"}),
            json!({"type":"message_end","commandId":"mine","message":{"role":"assistant","stopReason":"toolUse"}}),
            json!({"type":"message_end","commandId":"mine","message":{"role":"assistant","stopReason":"error","errorMessage":"provider denied the request"}}),
            json!({"type":"agent_end","commandId":"mine"}),
        ]).await;
        // Delivered: the turn's error is the code, never a send failure.
        assert!(matches!(receipt.state, ReceiptState::Completed));
        assert_eq!(receipt.code.as_deref(), Some("agent_failed"));
        assert_eq!(
            receipt.error.as_deref(),
            Some("provider denied the request")
        );
    }

    #[tokio::test]
    async fn a_turn_that_recovers_from_an_error_completes_clean() {
        let receipt = receipt_after(&[
            json!({"type":"agent_start","commandId":"mine"}),
            json!({"type":"message_end","commandId":"mine","message":{"role":"assistant","stopReason":"error","errorMessage":"socket closed"}}),
            json!({"type":"message_end","commandId":"mine","message":{"role":"assistant","stopReason":"toolUse"}}),
            json!({"type":"message_end","commandId":"mine","message":{"role":"assistant","stopReason":"stop"}}),
            json!({"type":"agent_end","commandId":"mine"}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Completed));
        assert_eq!(receipt.code, None);
        assert_eq!(receipt.error, None);
    }

    #[tokio::test]
    async fn prompt_result_after_agent_end_decides_the_outcome() {
        let receipt = receipt_after(&[
            json!({"type":"agent_start","commandId":"mine"}),
            json!({"type":"message_end","commandId":"mine","message":{"role":"assistant","stopReason":"error","errorMessage":"socket closed"}}),
            json!({"type":"agent_end","commandId":"mine"}),
            json!({"type":"prompt_result","commandId":"mine","agentInvoked":true,"status":"completed","sessionSettled":true}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Completed));
        assert_eq!(receipt.code, None);
    }

    #[tokio::test]
    async fn a_refused_turn_settles_completed_as_refused() {
        let receipt = receipt_after(&[
            json!({"type":"prompt_result","commandId":"mine","agentInvoked":true,"status":"error","sessionSettled":true,"error":{"message":"Refusal (cyber): no"}}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Completed));
        assert_eq!(receipt.code.as_deref(), Some("agent_refused"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_mid_turn_follow_up_outlives_the_watch_step_and_settles_at_its_prompt_result() {
        // A follow-up never gets its own `agent_start`; omp emits its
        // `prompt_result` only when the whole (long) turn ends.
        let root = std::env::temp_dir().join(format!(
            "pulse-receipt-followup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let ledger = Arc::new(CommandLedger::open(&root).unwrap());
        ledger
            .submit("mine", "/isolated/session.jsonl", "fingerprint")
            .unwrap();
        ledger
            .update("mine", ReceiptState::Received, None, None)
            .unwrap();
        let source = crate::authority::session_state::SourceIdentity {
            kind: crate::authority::session_state::SourceKind::Child,
            source_id: 1,
            binding_epoch: 1,
            pid: Some(123),
            process_start: Some(1),
            peer_id: None,
            room_id: None,
            can_write: None,
        };
        let registry = Arc::new(crate::authority::session_state::SessionStateRegistry::default());
        registry.project(
            "/isolated/session.jsonl",
            crate::authority::session_state::Seed {
                owner: source.wire_owner(),
                turn: crate::authority::session_state::Turn::Unknown,
                confidence: crate::authority::session_state::Confidence::Confirmed,
                connection: crate::authority::session_state::Connection::Connected,
                activity: None,
                capabilities: crate::authority::session_state::Capabilities::default(),
                source: Some(source.clone()),
                sequence: 0,
            },
        );
        let (tx, rx) = tokio::sync::broadcast::channel(16);
        let watcher = tokio::spawn(watch_child_receipt(
            Arc::clone(&ledger),
            rx,
            "mine".to_owned(),
            "/isolated/session.jsonl".to_owned(),
            source.clone(),
            registry,
        ));
        tokio::time::sleep(RECEIPT_WATCH_STEP * 3).await;
        let receipt = ledger.get("mine").unwrap().unwrap();
        assert!(
            matches!(receipt.state, ReceiptState::Received),
            "still waiting, not uncertain"
        );
        tx.send(crate::types::ChildEvent::Event {
            session: "/isolated/session.jsonl".to_owned(),
            event: json!({"type":"prompt_result","commandId":"mine","agentInvoked":true,"status":"completed","sessionSettled":true}),
            source: Some(crate::authority::session_state::SourceStamp { identity: source, sequence: 1 }),
        })
        .unwrap();
        watcher.await.unwrap();
        let receipt = ledger.get("mine").unwrap().unwrap();
        assert!(matches!(receipt.state, ReceiptState::Completed));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn acknowledged_prompt_can_still_report_a_correlated_async_rejection() {
        let receipt = receipt_after(&[
            json!({"type":"prompt_response","commandId":"mine","success":true}),
            json!({"type":"prompt_response","commandId":"mine","success":false,"error":"provider refused"}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Failed));
        assert_eq!(receipt.error.as_deref(), Some("provider refused"));
    }
    #[tokio::test]
    async fn nonterminal_end_does_not_hide_a_later_prompt_failure() {
        let receipt = receipt_after(&[
            json!({"type":"agent_start","commandId":"mine"}),
            json!({"type":"agent_end","commandId":"mine","isTerminal":false}),
            json!({"type":"prompt_result","commandId":"mine","agentInvoked":true,"status":"error","sessionSettled":true,"error":{"message":"follow-up failed"}}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Completed));
        assert_eq!(receipt.code.as_deref(), Some("agent_failed"));
        assert_eq!(receipt.error.as_deref(), Some("follow-up failed"));
    }

    #[tokio::test]
    async fn receipt_completes_on_settled_prompt_result() {
        let receipt = receipt_after(&[
            json!({"type":"agent_start","commandId":"mine"}),
            json!({"type":"prompt_result","commandId":"mine","agentInvoked":true,"status":"completed","sessionSettled":true}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Completed));
    }

    #[tokio::test]
    async fn receipt_reports_provider_error_from_prompt_result() {
        let receipt = receipt_after(&[
            json!({"type":"prompt_result","commandId":"mine","agentInvoked":true,"status":"error","sessionSettled":true,"error":{"message":"quota exhausted","retryable":true}}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Completed));
        assert_eq!(receipt.code.as_deref(), Some("agent_failed"));
        assert_eq!(
            receipt.error.as_deref(),
            Some("quota exhausted (retryable)")
        );
    }

    #[tokio::test]
    async fn receipt_reports_abort_from_prompt_result() {
        let receipt = receipt_after(&[
            json!({"type":"agent_start","commandId":"mine"}),
            json!({"type":"prompt_result","commandId":"mine","agentInvoked":true,"status":"aborted","sessionSettled":true}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Completed));
        assert_eq!(receipt.code.as_deref(), Some("agent_aborted"));
    }

    #[tokio::test]
    async fn receipt_waits_for_session_settled_after_unsettled_prompt_result() {
        // `agent_end` after an unsettled `prompt_result` is one run yielding,
        // not the work settling: the receipt must survive it and terminate on
        // the follow-up `session_settled` (which carries no `commandId`).
        let receipt = receipt_after(&[
            json!({"type":"agent_start","commandId":"mine"}),
            json!({"type":"prompt_result","commandId":"mine","agentInvoked":true,"status":"completed","sessionSettled":false}),
            json!({"type":"agent_end","commandId":"mine"}),
            json!({"type":"session_settled"}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Completed));
    }

    #[tokio::test]
    async fn receipt_carries_unsettled_error_through_session_settled() {
        let receipt = receipt_after(&[
            json!({"type":"prompt_result","commandId":"mine","agentInvoked":true,"status":"error","sessionSettled":false,"error":{"message":"provider blew up","retryable":false}}),
            json!({"type":"session_settled"}),
        ]).await;
        assert!(matches!(receipt.state, ReceiptState::Completed));
        assert_eq!(receipt.error.as_deref(), Some("provider blew up"));
    }
}
