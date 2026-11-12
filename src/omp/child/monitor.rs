//! The monitor task: reading a child's stdout and stderr, dispatching events and
//! RPC responses, and mapping omp state onto the child.

use super::*;
use crate::types::ChildEvent;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};
use tokio::sync::broadcast;
use tracing::{debug, warn};

/// Called under the gate only after actual settlement evidence, not a pipe
/// handoff. RPC has no callback receipt; an ask tool result does prove the
/// exclusive ask finished. Broadcast its cancellation-shaped closure so every
/// client and the session authority stop offering that question. This never
/// claims which device's answer won. Repeated or stale closures do nothing.
/// The caller holds both the gate and the session binding through the send.
pub(super) fn close_settled_dialog(
    tx: &broadcast::Sender<ChildEvent>,
    child: &Child,
    session: &str,
    id: &str,
) -> bool {
    if lock_poisoned(&child.pending_ui).remove(id).is_none() {
        return false;
    }
    // Stamped and sent under the gate, like the monitor's own events, so the
    // authority never sees this sequence number overtake (and discard) a
    // frame stamped just before it.
    let source = child_source_stamp(child);
    let _ = tx.send(ChildEvent::Event {
        session: session.to_owned(),
        event: json!({
            "type": "extension_ui_request",
            "method": "cancel",
            "id": format!("pulse-answered:{id}"),
            "targetId": id,
            "settled": true,
        }),
        source: Some(source),
    });
    true
}

/// The shared raw-response path for client dialogs and the daemon-only tree
/// cancellation channel. No gate or stdin lock survives the write.
pub(super) fn forward_ui_response_to_child(
    tx: &broadcast::Sender<ChildEvent>,
    child: Arc<Child>,
    session_path: &str,
    frame: &Value,
) {
    if let Err(error) = start_ui_response_to_child(tx, child, session_path, frame) {
        warn!("forward_ui_response refused: {error}");
    }
}

/// HTTP callers await the actual pipe write. Scheduling it is not delivery,
/// and even a complete write is not a receipt from OMP's callback.
pub(super) fn start_ui_response_to_child(
    tx: &broadcast::Sender<ChildEvent>,
    child: Arc<Child>,
    session_path: &str,
    frame: &Value,
) -> Result<tokio::task::JoinHandle<Result<(), String>>, String> {
    let epoch = child.binding_epoch.load(Ordering::SeqCst);
    let id = frame
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "response has no question id".to_string())?
        .to_string();
    let mut line = serde_json::to_string(frame).map_err(|error| error.to_string())?;
    line.push('\n');
    let mut lease = {
        let mut gate = lock_poisoned(&child.gate);
        if !child.alive.load(Ordering::SeqCst)
            || !gate.ordinary_ready()
            || child.binding_epoch.load(Ordering::SeqCst) != epoch
            || lock_poisoned(&child.session).as_str() != session_path
        {
            return Err("the session cannot accept this answer now".to_string());
        }
        let internal_tree_cancel =
            Some(id.as_str()) == lock_poisoned(&child.tree_cancel).request_id.as_deref();
        let mut pending = lock_poisoned(&child.pending_ui);
        if let Some(request) = pending.get_mut(&id) {
            if request.get("pulseDelivery").is_some() {
                return Err("an answer is already waiting for this question".to_string());
            }
            request["pulseDelivery"] = json!("sending");
        } else if !internal_tree_cancel {
            return Err("that question is no longer waiting".to_string());
        }
        gate.raw_writes += 1;
        touch_locked(&child);
        child.busy_may_have_changed();
        RawWriteLease {
            child: Arc::clone(&child),
            complete: false,
        }
    };
    let tx = tx.clone();
    Ok(tokio::spawn(async move {
        let result = child.stdin.lock().await.write_all(line.as_bytes()).await;
        let phase = if result.is_ok() {
            "handoff"
        } else {
            "uncertain"
        };
        {
            let _gate = lock_poisoned(&child.gate);
            if let Some(request) = lock_poisoned(&child.pending_ui).get_mut(&id) {
                request["pulseDelivery"] = json!(phase);
            }
            let (session, source) = child_bound_stamp(&child);
            let _ = tx.send(ChildEvent::Event {
                session,
                event: json!({"type":"extension_ui_response_ack","id":id,"phase":phase}),
                source: Some(source),
            });
        }
        if let Err(error) = result {
            warn!("forward_ui_response write failed: {error}");
            return Err("answer delivery is unknown; the session connection failed".to_string());
        }
        lease.complete();
        Ok(())
    }))
}

const TREE_CANCEL_TITLE: &str = "omp-pulse-tree-cancel";

fn consume_tree_cancel(
    tx: &broadcast::Sender<ChildEvent>,
    child: &Arc<Child>,
    frame: &Value,
) -> bool {
    if frame.get("method").and_then(Value::as_str) == Some("confirm")
        && frame.get("title").and_then(Value::as_str) == Some(TREE_CANCEL_TITLE)
    {
        let Some(id) = frame.get("id").and_then(Value::as_str) else {
            return true;
        };
        let stop_requested = {
            let mut cancel = lock_poisoned(&child.tree_cancel);
            cancel.request_id = Some(id.to_string());
            cancel.stop_requested
        };
        if stop_requested {
            let session = lock_poisoned(&child.session).clone();
            forward_ui_response_to_child(
                tx,
                Arc::clone(child),
                &session,
                &json!({
                    "type":"extension_ui_response", "id":id, "cancelled":true,
                }),
            );
        }
        return true;
    }
    if frame.get("method").and_then(Value::as_str) == Some("cancel") {
        let mut cancel = lock_poisoned(&child.tree_cancel);
        if frame.get("targetId").and_then(Value::as_str) == cancel.request_id.as_deref()
            && cancel.request_id.is_some()
        {
            cancel.request_id = None;
            return true;
        }
    }
    false
}

pub(super) async fn monitor_loop(
    tx: broadcast::Sender<ChildEvent>,
    children: Arc<Mutex<HashMap<String, Arc<Child>>>>,
    child: Arc<Child>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    ephemeral: Option<&dyn ephemeral::Lifecycle>,
) {
    let mut out = BufReader::new(stdout);
    let mut err = BufReader::new(stderr);
    // Caller-owned buffers: a cancelled read_until keeps partial bytes here,
    // so no line data is ever lost or duplicated across select iterations.
    let mut out_buf: Vec<u8> = Vec::new();
    let mut err_buf: Vec<u8> = Vec::new();
    let mut out_open = true;
    let mut err_open = true;
    // The last stderr lines, attached to the exit failure. WHY: an omp that
    // refuses to start ("No default model selected", on a fresh phone with no
    // provider signed in) said so only on stderr, and the phone showed "The
    // agent stopped unexpectedly" with nothing to act on.
    let mut err_tail: VecDeque<String> = VecDeque::new();
    while out_open || err_open {
        tokio::select! {
            r = out.read_until(b'\n', &mut out_buf), if out_open => {
                match r {
                    Ok(0) => out_open = false, // stdout EOF
                    Ok(_) => {
                        let line = std::mem::take(&mut out_buf);
                        dispatch_bytes(&tx, &children, &child, &line);
                        // Any frame may flip busy (turn, prompt receipt,
                        // background/btw, dialog, RPC response, plan
                        // transition); the watcher coalesces the bursts.
                        child.busy_may_have_changed();
                    }
                    Err(e) => { warn!("child stdout read error: {e}"); out_open = false; }
                }
            }
            r = err.read_until(b'\n', &mut err_buf), if err_open => {
                match r {
                    Ok(0) => err_open = false,
                    Ok(_) => {
                        let raw = std::mem::take(&mut err_buf);
                        let text = String::from_utf8_lossy(&raw);
                        let text = text.trim();
                        if !text.is_empty() {
                            if err_tail.len() == STDERR_TAIL_LINES {
                                err_tail.pop_front();
                            }
                            err_tail.push_back(text.chars().take(STDERR_TAIL_CHARS).collect());
                            let (session, source) = child_bound_stamp(&child);
                            let _ = tx.send(ChildEvent::Notice {
                                session,
                                message: text.to_string(),
                                source: Some(source),
                            });
                        }
                    }
                    Err(e) => { warn!("child stderr read error: {e}"); err_open = false; }
                }
            }
        }
    }
    // Drain both streams before logical finish, preserving final responses.
    // EOF is not physical-exit evidence; registered capacity remains charged.
    let why = if err_tail.is_empty() {
        "exited".to_string()
    } else {
        format!("exited: {}", Vec::from(err_tail).join(" "))
    };
    finish_child(&tx, &children, &child, &why, Exit::Unexpected);
    if child.physical.is_some() {
        // The registered monitor adapter waits through durable ownership.
        return;
    }
    // Reap the ephemeral zombie through its unchanged ownership lane.
    let proc = {
        let mut guard = lock_poisoned(&child.proc);
        guard.take()
    };
    if let Some(mut p) = proc {
        match p.wait().await {
            Ok(st) => {
                if let Some(owner) = ephemeral {
                    owner.observed_reap();
                }
                debug!("child {} reaped: {st}", lock_poisoned(&child.session));
            }
            Err(e) => warn!("child wait() failed: {e}"),
        }
    }
}

/// One stdout line: dispatch as response, rpc_chunk, ready, or session event.
fn dispatch_bytes(
    tx: &broadcast::Sender<ChildEvent>,
    children: &Arc<Mutex<HashMap<String, Arc<Child>>>>,
    child: &Arc<Child>,
    raw: &[u8],
) {
    let line = String::from_utf8_lossy(raw);
    dispatch_line(tx, children, child, line.trim_end_matches(['\n', '\r']));
}

fn dispatch_line(
    tx: &broadcast::Sender<ChildEvent>,
    children: &Arc<Mutex<HashMap<String, Arc<Child>>>>,
    child: &Arc<Child>,
    line: &str,
) {
    if line.trim().is_empty() {
        return;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            warn!("unparseable frame from child: {e}");
            return;
        }
    };
    if plan_transition::consume(tx, children, child, &v) {
        return;
    }
    dispatch_value(tx, child, &v);
}

fn dispatch_value(tx: &broadcast::Sender<ChildEvent>, child: &Arc<Child>, v: &Value) {
    let Some(t) = v.get("type").and_then(|t| t.as_str()) else {
        warn!("malformed frame from child (missing type)");
        return;
    };
    // Replies from the phone-control extension are the daemon's own
    // bookkeeping: settle the waiting request and never forward them.
    // Live `/pulse-bash` output is re-sent as its own event, never as a
    // status line.
    if t == "extension_ui_request" {
        if v.get("method").and_then(Value::as_str) == Some("setStatus")
            && v.get("statusKey").and_then(Value::as_str) == Some("omp-pulse-queue")
        {
            if let Some(text) = v.get("statusText").and_then(Value::as_str)
                && let Ok(Value::Object(mut snapshot)) = serde_json::from_str::<Value>(text)
            {
                snapshot.insert("type".to_string(), json!("queue_update"));
                let _gate = lock_poisoned(&child.gate);
                let (session, source) = child_bound_stamp(child);
                let _ = tx.send(ChildEvent::Event {
                    session,
                    event: Value::Object(snapshot),
                    source: Some(source),
                });
            }
            return;
        }
        if v.get("method").and_then(Value::as_str) == Some("setStatus")
            && v.get("statusKey").and_then(Value::as_str) == Some("omp-pulse-dialog-scope")
        {
            if let Some(text) = v.get("statusText").and_then(Value::as_str)
                && let Ok(marker) = serde_json::from_str::<Value>(text)
                && let Some(scope) = marker.get("scope").and_then(Value::as_str)
            {
                let _gate = lock_poisoned(&child.gate);
                let binding = lock_poisoned(&child.session);
                match marker.get("phase").and_then(Value::as_str) {
                    Some("begin") => *lock_poisoned(&child.dialog_scope) = Some(scope.to_owned()),
                    Some("end") => {
                        let mut waiting = lock_poisoned(&child.dialog_scope);
                        if waiting.as_deref() == Some(scope) {
                            waiting.take();
                        }
                        drop(waiting);
                        let id =
                            lock_poisoned(&child.pending_ui)
                                .iter()
                                .find_map(|(id, request)| {
                                    (request.get("pulseDialogScope").and_then(Value::as_str)
                                        == Some(scope))
                                    .then(|| id.clone())
                                });
                        if let Some(id) = id {
                            close_settled_dialog(tx, child, &binding, &id);
                        }
                    }
                    _ => {}
                }
            }
            return;
        }
        if v.get("method").and_then(Value::as_str) == Some("setStatus")
            && v.get("statusKey").and_then(Value::as_str) == Some("omp-pulse-thinking")
        {
            if let Some(text) = v.get("statusText").and_then(Value::as_str)
                && let Ok(snapshot) = serde_json::from_str::<Value>(text)
                && let Some(level) = snapshot
                    .get("configuredThinkingLevel")
                    .and_then(Value::as_str)
            {
                let _gate = lock_poisoned(&child.gate);
                *lock_poisoned(&child.configured_thinking) = Some(level.to_owned());
                if let Some(fallback) = snapshot.get("modelFallback") {
                    *lock_poisoned(&child.model_fallback) = Some(fallback.clone());
                }
            }
            return;
        }
        if consume_tree_cancel(tx, child, v) {
            return;
        }
        if let Some((req_id, reply)) = extension::parse_reply(v) {
            if req_id.starts_with("tree-") {
                lock_poisoned(&child.tree_cancel).request_id = None;
            }
            if let Some(waiter) = lock_poisoned(&child.extension_replies).remove(&req_id) {
                let _ = waiter.send(reply);
            }
            return;
        }
        if let Some((stream, text)) = extension::parse_output(v) {
            // Stamped under the gate like every other event sender, so the
            // authority receives this child's sequence numbers in order.
            let _gate = lock_poisoned(&child.gate);
            let (session, source) = child_bound_stamp(child);
            let _ = tx.send(ChildEvent::BashOutput {
                session,
                id: stream,
                text,
                source: Some(source),
            });
            return;
        }
        if crate::omp::ui_feedback::is_internal(v) {
            return;
        }
    }
    match t {
        // Handshake frame, not a session event.
        "ready" => {}
        "response" => {
            handle_response(child, v);
            if let Some(command_id) = v
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| id.strip_prefix("pulse-prompt:"))
            {
                if v.get("success").and_then(Value::as_bool) == Some(false)
                    || v.pointer("/data/agentInvoked").and_then(Value::as_bool) == Some(false)
                {
                    let _gate = lock_poisoned(&child.gate);
                    lock_poisoned(&child.active_prompt).clear_if(command_id);
                }
                // OMP can acknowledge first, then asynchronously reject with
                // the SAME RPC id. The one-shot waiter is already gone then;
                // keep this correlated failure observable to the receipt.
                let mut event = v.clone();
                event["type"] = json!("prompt_response");
                event["commandId"] = json!(command_id);
                // Under the gate, like every stamped send that can race
                // `forward_ui_response`'s (see the fallthrough arm below).
                let _gate = lock_poisoned(&child.gate);
                let (session, source) = child_bound_stamp(child);
                let _ = tx.send(ChildEvent::Event {
                    session,
                    event,
                    source: Some(source),
                });
            }
        }
        "rpc_chunk" => handle_chunk(tx, child, v),
        // A control command's completion is not a conversation turn; the
        // receipt and turn tracking below must not see it.
        "prompt_result"
            if v.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with(extension::RPC_ID_PREFIX)) => {}
        _ => {
            let mut gate = lock_poisoned(&child.gate);
            let binding = lock_poisoned(&child.session);
            if t == "thinking_level_changed" {
                let selector = v
                    .get("configured")
                    .and_then(Value::as_str)
                    .or_else(|| v.get("thinkingLevel").and_then(Value::as_str))
                    .unwrap_or("");
                *lock_poisoned(&child.configured_thinking) = Some(selector.to_owned());
            }
            // A resolved prompt ends its run too (omp sends it once per
            // prompt): with a background job pending, omp's `agent_end` is
            // not final and `session_settled` only comes when the job drains,
            // so the phone showed "Working…" for the job's whole life while
            // the TUI's editor is free. A printing slash command
            // (`pulse-command:*`, `agentInvoked: false`) never ran the agent
            // and must not end a real turn. Mirrors session_state's reducer.
            let resolved_prompt = t == "prompt_result"
                && v.get("agentInvoked").and_then(Value::as_bool) != Some(false)
                && !v
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.starts_with("pulse-command:"));
            let terminal = (t == "agent_end"
                && v.get("isTerminal").and_then(Value::as_bool) != Some(false)
                && v.get("bridgeLost").and_then(Value::as_bool) != Some(true))
                || t == "session_settled"
                || resolved_prompt;
            // Tool-call messages end while the agent is still working. Only
            // agent-level boundaries may clear the running/follow-up signal.
            // Turn boundaries count as activity: `last_active` otherwise dates
            // from the prompt RPC, so a turn that ran longer than the idle TTL
            // was reaped on the first pass after it ended, while the user was
            // still reading the answer.
            if matches!(t, "auto_compaction_start" | "auto_compaction_end") {
                gate.maintenance_generation = gate.maintenance_generation.wrapping_add(1);
                child
                    .compacting
                    .store(t == "auto_compaction_start", Ordering::SeqCst);
            }
            if t == "agent_start" {
                gate.stream_generation = gate.stream_generation.wrapping_add(1);
                child.streaming.store(true, Ordering::SeqCst);
                touch_locked(child);
            } else if terminal {
                gate.stream_generation = gate.stream_generation.wrapping_add(1);
                child.streaming.store(false, Ordering::SeqCst);
                touch_locked(child);
            }
            // Background work outliving the turn: omp's `prompt_result` says
            // `sessionSettled: false` while an async job or subagent can still
            // wake the session, and `session_settled` follows once it drains
            // (rpc-mode settle check: no queued messages, no pending async
            // work). Until then the child is busy for reaping and eviction.
            if t == "prompt_result"
                && v.get("sessionSettled").and_then(Value::as_bool) == Some(false)
            {
                gate.stream_generation = gate.stream_generation.wrapping_add(1);
                child.background_since.store(now_ms(), Ordering::SeqCst);
                touch_locked(child);
            } else if t == "session_settled" {
                child.background_since.store(0, Ordering::SeqCst);
            }
            // omp: "a record's latest turn is its last follow-up, else the
            // record itself"; every lifecycle change re-sends the record.
            if t == "btw_record" {
                let record = v.get("record");
                let latest = record
                    .and_then(|r| r.get("followUps"))
                    .and_then(Value::as_array)
                    .and_then(|turns| turns.last())
                    .or(record);
                let running = latest
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    == Some("running");
                child
                    .btw_since
                    .store(if running { now_ms() } else { 0 }, Ordering::SeqCst);
                // The gate is held here: `touch` would lock it again and
                // wedge this child's reader on its first side question.
                touch_locked(child);
            }
            // Track open extension UI requests so pending_ui_request() can
            // answer "does this child need phone input?". A `method:"cancel"`
            // request carries the targetId of the request it cancels (there
            // is no separate extension_ui_cancel frame type — verified in
            // rpc-mode.ts); its own fresh id is never tracked. agent_end
            // clears the whole set.
            if t == "extension_ui_request" {
                lock_poisoned(&child.feedback).apply(v, now_ms());
                let mut pending_ui = lock_poisoned(&child.pending_ui);
                match v.get("method").and_then(|m| m.as_str()) {
                    Some("cancel") => {
                        if let Some(target) = v.get("targetId").and_then(|x| x.as_str()) {
                            pending_ui.remove(target);
                            crate::omp::ui_dialog::forget_partial(target);
                        }
                    }
                    // Only dialogs that block on a phone response count as
                    // "waiting"; setWidget/notify/setStatus/setTitle/
                    // set_editor_text/open_url are fire-and-forget pushes
                    // (verified in rpc-mode.ts). The FULL request frame is
                    // retained, stamped with its arrival time, so a reloading
                    // client can re-render the dialog with the time it has
                    // left; a re-issued id replaces the older payload.
                    method if crate::omp::ui_dialog::is_blocking(method) => {
                        if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                            let mut stored = crate::omp::ui_dialog::stored_request(v, now_ms());
                            if let Some(scope) = lock_poisoned(&child.dialog_scope).take() {
                                stored["pulseDialogScope"] = json!(scope);
                            }
                            pending_ui.insert(id.to_string(), stored);
                        }
                    }
                    _ => {}
                }
            } else if t == "tool_execution_end"
                && v.get("toolName").and_then(Value::as_str) == Some("ask")
            {
                // RPC has no callback receipt. A real ask tool result does
                // prove that its exclusive question is no longer waiting.
                let settled = lock_poisoned(&child.pending_ui)
                    .iter()
                    .find_map(|(id, request)| {
                        (request.get("method").and_then(Value::as_str) == Some("ask")
                            && request.get("pulseDelivery").is_some())
                        .then(|| id.clone())
                    });
                if let Some(id) = settled {
                    close_settled_dialog(tx, child, &binding, &id);
                }
            } else if terminal {
                lock_poisoned(&child.pending_ui).clear();
            }
            let mut event = v.clone();
            let command_id = if t == "prompt_result" {
                let id = v
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| id.strip_prefix("pulse-prompt:"));
                if let Some(id) = id {
                    lock_poisoned(&child.active_prompt).clear_if(id);
                }
                id.map(str::to_owned)
            } else if matches!(t, "agent_start" | "message_end" | "agent_end") {
                let mut active = lock_poisoned(&child.active_prompt);
                if terminal {
                    active.finish()
                } else {
                    active.command_id().map(str::to_owned)
                }
            } else {
                None
            };
            if let Some(command_id) = command_id {
                event["commandId"] = json!(command_id);
            }
            let session = binding.clone();
            let source = child_source_stamp(child);
            if matches!(t, "extension_error" | "command_output") {
                let id = format!(
                    "native:{}:{}:{}",
                    child.source_id, source.identity.binding_epoch, source.sequence
                );
                if let Some(mut feedback) =
                    lock_poisoned(&child.feedback).apply_native(&event, &id, now_ms())
                {
                    event["feedbackId"] = json!(id);
                    if t == "command_output" {
                        event["text"] = feedback["message"].take();
                    }
                }
            }
            if matches!(t, "subagent_lifecycle" | "subagent_progress") {
                lock_poisoned(&child.retained_agents).observe(
                    source.identity.binding_epoch,
                    source.sequence,
                    &event,
                );
            }
            // Sent before the gate drops: another stamping sender
            // (`forward_ui_response`) holds the gate too, so the authority
            // receives this child's sequence numbers in order and never
            // discards this frame as stale. A broadcast send never blocks.
            let _ = tx.send(ChildEvent::Event {
                session,
                event,
                source: Some(source),
            });
            drop(binding);
            drop(gate);
        }
    }
}

/// Correlate a response frame with its pending request — strictly by id; bash
/// is background-dispatched child-side, so ordering is never FIFO.
fn handle_response(child: &Arc<Child>, v: &Value) {
    let Some(id) = v.get("id").and_then(Value::as_str) else {
        warn!("response frame without id — ignoring");
        return;
    };
    let mut result = if v.get("success").and_then(Value::as_bool).unwrap_or(false) {
        Ok(v.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(v
            .get("error")
            .map(|e| {
                e.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| e.to_string())
            })
            .unwrap_or_else(|| "rpc failed".to_string()))
    };
    let pending = {
        let mut gate = lock_poisoned(&child.gate);
        let request = gate.pending.get(id).map(|rpc| {
            (
                rpc.command == "get_state",
                rpc.command == "switch_session",
                rpc.binding_epoch,
                rpc.stream_generation,
                rpc.maintenance_generation,
                rpc.maintenance_after_commands,
            )
        });
        if let Some((
            is_state,
            is_switch,
            epoch,
            generation,
            maintenance_generation,
            after_commands,
        )) = request
        {
            if is_state
                && epoch == child.binding_epoch.load(Ordering::SeqCst)
                && let Ok(data) = &mut result
            {
                // Apply in wire order. A snapshot admitted before a newer
                // event or positive snapshot cannot overwrite its stream.
                let apply_streaming = gate.accept_stream_snapshot(
                    generation,
                    data.get("isStreaming")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                );
                apply_state_locked(child, data, apply_streaming);
                if let Some(compacting) = data.get("isCompacting").and_then(Value::as_bool)
                    && gate.accept_maintenance_snapshot(
                        maintenance_generation,
                        compacting,
                        after_commands,
                    )
                {
                    child.compacting.store(compacting, Ordering::SeqCst);
                }
                if let Some(level) = lock_poisoned(&child.configured_thinking).as_ref() {
                    data["configuredThinkingLevel"] = json!(level);
                }
                if let Some(fallback) = lock_poisoned(&child.model_fallback).as_ref() {
                    data["modelFallback"] = fallback.clone();
                }
            }
            if is_switch && result.is_err() {
                gate.unknown_binding = true;
            }
        }
        let pending = gate.complete_rpc(id);
        if pending.is_some() {
            busy::start_maintenance_probe(child, &mut gate);
        }
        pending
    };
    if let Some(rpc) = pending {
        let _ = rpc.tx.send(result);
    } else {
        debug!("response for unknown id {id} — ignoring");
    }
}

/// Reassemble an rpc_chunk train. `byteLength` is the TOTAL logical frame
/// length, identical on every chunk — the concatenated buffer is validated
/// against it (NOT per-chunk; the old daemon compared per-chunk, a real bug
/// that silently dropped every multi-chunk frame).
fn handle_chunk(tx: &broadcast::Sender<ChildEvent>, child: &Arc<Child>, v: &Value) {
    let Some(chunk_id) = v.get("chunkId").and_then(|c| c.as_str()) else {
        warn!("rpc_chunk without chunkId");
        return;
    };
    let Some(index) = v.get("index").and_then(|i| i.as_u64()) else {
        warn!("rpc_chunk without index");
        return;
    };
    let Some(count) = v.get("count").and_then(|c| c.as_u64()) else {
        warn!("rpc_chunk without count");
        return;
    };
    let Some(byte_len) = v.get("byteLength").and_then(|b| b.as_u64()) else {
        warn!("rpc_chunk without byteLength");
        return;
    };
    let Some(data_b64) = v.get("data").and_then(|d| d.as_str()) else {
        warn!("rpc_chunk without data");
        return;
    };
    if count == 0 || index >= count {
        warn!("rpc_chunk index {index} out of range for {chunk_id} (count {count})");
        return;
    }
    let decoded = match STANDARD.decode(data_b64) {
        Ok(d) => d,
        Err(e) => {
            warn!("rpc_chunk base64 decode failed: {e}");
            return;
        }
    };
    let mut chunks = lock_poisoned(&child.chunks);
    let acc = chunks
        .entry(chunk_id.to_string())
        .or_insert_with(|| ChunkAcc {
            count: count as usize,
            parts: vec![None; count as usize],
            received: 0,
            bytes: 0,
        });
    if acc.count != count as usize {
        warn!("rpc_chunk count mismatch for {chunk_id}");
        return;
    }
    if acc.parts[index as usize].is_some() {
        return; // duplicate chunk index — ignore
    }
    if acc.bytes.saturating_add(decoded.len()) > MAX_REASSEMBLED_BYTES {
        warn!("rpc_chunk reassembly for {chunk_id} exceeded 64MiB cap — dropping chunk set");
        chunks.remove(chunk_id);
        return;
    }
    acc.bytes += decoded.len();
    acc.parts[index as usize] = Some(decoded);
    acc.received += 1;
    if acc.received == acc.count {
        let total_bytes = acc.bytes;
        let parts = std::mem::take(&mut acc.parts);
        chunks.remove(chunk_id);
        let mut buf: Vec<u8> = Vec::with_capacity(total_bytes);
        for p in parts.iter().flatten() {
            buf.extend_from_slice(p);
        }
        if buf.len() as u64 != byte_len {
            warn!(
                "rpc_chunk reassembled length {} != byteLength {byte_len} for {chunk_id} — dropping frame",
                buf.len()
            );
            return;
        }
        match serde_json::from_slice::<Value>(&buf) {
            Ok(frame) => dispatch_value(tx, child, &frame),
            Err(e) => warn!("rpc_chunk reassembly produced invalid JSON for {chunk_id}: {e}"),
        }
    }
}

/// Cache get_state fields on the child: sessionName, model (object
/// `{provider,id}` or plain string), messageCount, isStreaming, and
/// `contextUsage.percent` (RpcSessionState in rpc-types.ts).
fn apply_state_locked(child: &Child, data: &Value, apply_streaming: bool) {
    if let Some(m) = data.get("model") {
        if let Some(obj) = m.as_object() {
            if let (Some(prov), Some(id)) = (
                obj.get("provider").and_then(|p| p.as_str()),
                obj.get("id").and_then(|i| i.as_str()),
            ) {
                *lock_poisoned(&child.model) = format!("{prov}/{id}");
            }
        } else if let Some(s) = m.as_str() {
            *lock_poisoned(&child.model) = s.to_string();
        }
    }
    if let Some(n) = data.get("sessionName").and_then(|n| n.as_str()) {
        *lock_poisoned(&child.session_name) = n.to_string();
    }
    if let Some(mc) = data.get("messageCount").and_then(|m| m.as_u64()) {
        *lock_poisoned(&child.message_count) = mc;
    }
    // `contextUsage.percent` is (usedTokens / contextWindow) * 100 and can
    // exceed 100 when the session is over budget; the wire contract is 0-100
    // and "at 100%" is the actionable fact for the phone either way, so round
    // to a whole percent and clamp.
    if let Some(p) = data
        .get("contextUsage")
        .and_then(|cu| cu.get("percent"))
        .and_then(|p| p.as_f64())
    {
        *lock_poisoned(&child.context_percent) = Some(p.round().clamp(0.0, 100.0) as u32);
    }
    if apply_streaming {
        child.streaming.store(
            data.get("isStreaming")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            Ordering::SeqCst,
        );
    }
}

// Every test here drives `stand_in_child`, a real `cat` process, so the module
// only exists where those tests compile: on Unix.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::omp::child::tests::stand_in_child;
    use std::process::Stdio;

    fn admit_command(child: &Arc<Child>, id: &str) {
        let (reply, _rx) = oneshot::channel();
        lock_poisoned(&child.gate)
            .admit_rpc(id, "prompt", 1, reply, RpcAccess::Bound("/fixture", 1))
            .unwrap();
    }

    async fn maintenance_request(child: &Arc<Child>) -> String {
        for _ in 0..100 {
            if let Some(id) = lock_poisoned(&child.gate)
                .pending
                .keys()
                .find(|id| id.starts_with("pulse-maintenance:"))
                .cloned()
            {
                return id;
            }
            tokio::task::yield_now().await;
        }
        panic!("maintenance probe was not admitted");
    }

    fn finish_test_child(events: &broadcast::Sender<ChildEvent>, child: &Arc<Child>) {
        finish_child(
            events,
            &Arc::new(Mutex::new(HashMap::new())),
            child,
            "test scope finished",
            Exit::Planned,
        );
    }

    #[tokio::test(start_paused = true)]
    async fn early_command_ack_keeps_busy_until_native_maintenance_finishes_without_a_turn() {
        let child = stand_in_child();
        let (events, _rx) = broadcast::channel(16);
        admit_command(&child, "pulse-command:handoff");
        assert!(child_busy(&child, now_ms()));
        dispatch_value(
            &events,
            &child,
            &json!({"type":"response","id":"pulse-command:handoff","command":"prompt",
                "success":true,"data":{"agentInvoked":false}}),
        );
        assert!(child_busy(&child, now_ms()));
        let first = maintenance_request(&child).await;
        dispatch_value(
            &events,
            &child,
            &json!({"type":"response","id":first,"command":"get_state","success":true,
                "data":{"isStreaming":false,"isCompacting":true}}),
        );
        assert!(child.compacting.load(Ordering::SeqCst));
        assert!(!child.streaming.load(Ordering::SeqCst));
        dispatch_value(
            &events,
            &child,
            &json!({"type":"command_output","text":"unrelated feedback is not completion"}),
        );
        assert!(child_busy(&child, now_ms()));
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_secs(5)).await;
        let second = maintenance_request(&child).await;
        assert_ne!(first, second);
        dispatch_value(
            &events,
            &child,
            &json!({"type":"response","id":second,"command":"get_state","success":true,
                "data":{"isStreaming":false,"isCompacting":false}}),
        );
        assert!(!child_busy(&child, now_ms()));
        finish_test_child(&events, &child);
    }

    #[tokio::test(start_paused = true)]
    async fn unavailable_maintenance_state_parks_conservatively_and_a_fresh_read_recovers() {
        for data in [Some(json!({"isStreaming":false})), None] {
            let child = stand_in_child();
            let (events, _rx) = broadcast::channel(16);
            admit_command(&child, "pulse-command:c1");
            dispatch_value(
                &events,
                &child,
                &json!({"type":"response","id":"pulse-command:c1","success":true,"data":{}}),
            );
            let id = maintenance_request(&child).await;
            let response = match data {
                Some(data) => json!({"type":"response","id":id,"success":true,"data":data}),
                None => json!({"type":"response","id":id,"success":false,"error":"unavailable"}),
            };
            dispatch_value(&events, &child, &response);
            for _ in 0..4 {
                tokio::task::yield_now().await;
            }
            assert!(child_busy(&child, now_ms()));
            assert!(!lock_poisoned(&child.gate).maintenance_probe_running);
            tokio::time::advance(Duration::from_secs(3600)).await;
            assert!(lock_poisoned(&child.gate).pending.is_empty());
            let (reply, _rx) = oneshot::channel();
            lock_poisoned(&child.gate)
                .admit_rpc(
                    "recover",
                    "get_state",
                    1,
                    reply,
                    RpcAccess::Bound("/fixture", 1),
                )
                .unwrap();
            dispatch_value(
                &events,
                &child,
                &json!({"type":"response","id":"recover","success":true,
                    "data":{"isStreaming":false,"isCompacting":false}}),
            );
            assert!(!child_busy(&child, now_ms()));
            finish_test_child(&events, &child);
        }
    }

    #[tokio::test]
    async fn state_from_a_previous_binding_cannot_settle_maintenance_work() {
        let child = stand_in_child();
        let (events, _rx) = broadcast::channel(16);
        admit_command(&child, "pulse-command:c1");
        {
            let mut gate = lock_poisoned(&child.gate);
            gate.complete_rpc("pulse-command:c1").unwrap();
            let (reply, _rx) = oneshot::channel();
            gate.admit_rpc(
                "old-state",
                "get_state",
                1,
                reply,
                RpcAccess::Bound("/fixture", 1),
            )
            .unwrap();
        }
        child.compacting.store(true, Ordering::SeqCst);
        child.binding_epoch.store(2, Ordering::SeqCst);
        dispatch_value(
            &events,
            &child,
            &json!({"type":"response","id":"old-state","success":true,
                "data":{"isStreaming":false,"isCompacting":false}}),
        );
        assert!(child.compacting.load(Ordering::SeqCst));
        assert!(lock_poisoned(&child.gate).maintenance_pending);
        assert!(child_busy(&child, now_ms()));
        finish_test_child(&events, &child);
    }

    #[tokio::test(start_paused = true)]
    async fn maintenance_probe_transfers_to_a_retargeted_session() {
        let child = stand_in_child();
        let (events, _rx) = broadcast::channel(16);
        admit_command(&child, "pulse-command:old");
        dispatch_value(
            &events,
            &child,
            &json!({"type":"response","id":"pulse-command:old","success":true,"data":{}}),
        );
        let old_probe = maintenance_request(&child).await;
        dispatch_value(
            &events,
            &child,
            &json!({"type":"response","id":old_probe,"success":true,
                "data":{"isStreaming":false,"isCompacting":true}}),
        );
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }

        let (reply, _rx) = oneshot::channel();
        lock_poisoned(&child.gate)
            .admit_rpc(
                "foreground",
                "get_state",
                1,
                reply,
                RpcAccess::Bound("/synthetic/turn.jsonl", 1),
            )
            .unwrap();
        dispatch_value(
            &events,
            &child,
            &json!({"type":"response","id":"foreground","success":true,
                "data":{"isStreaming":false,"isCompacting":false}}),
        );
        assert!(!child_busy(&child, now_ms()));

        {
            let mut gate = lock_poisoned(&child.gate);
            *lock_poisoned(&child.session) = "/synthetic/next.jsonl".into();
            child.binding_epoch.store(2, Ordering::SeqCst);
            let (reply, _rx) = oneshot::channel();
            gate.admit_rpc(
                "pulse-command:new",
                "prompt",
                2,
                reply,
                RpcAccess::Bound("/synthetic/next.jsonl", 2),
            )
            .unwrap();
        }
        dispatch_value(
            &events,
            &child,
            &json!({"type":"response","id":"pulse-command:new","success":true,"data":{}}),
        );
        tokio::time::advance(Duration::from_secs(5)).await;
        let new_probe = maintenance_request(&child).await;
        assert_ne!(old_probe, new_probe);
        dispatch_value(
            &events,
            &child,
            &json!({"type":"response","id":new_probe,"success":true,
                "data":{"isStreaming":false,"isCompacting":false}}),
        );
        assert!(
            !child_busy(&child, now_ms()),
            "new owner must eventually become idle"
        );
        finish_test_child(&events, &child);
    }

    #[tokio::test]
    async fn owner_thinking_receipts_keep_auto_distinct_in_state_readback() {
        let child = stand_in_child();
        let (tx, mut events) = broadcast::channel(16);
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type": "extension_ui_request", "method": "setStatus",
                "statusKey": "omp-pulse-thinking",
                "statusText": "{\"configuredThinkingLevel\":\"auto\"}"
            }),
        );
        assert!(events.try_recv().is_err(), "the owner snapshot is private");
        for (event, selected, effective) in [
            (
                json!({"type":"thinking_level_changed","configured":"auto","thinkingLevel":"high"}),
                "auto",
                "high",
            ),
            (
                json!({"type":"thinking_level_changed","thinkingLevel":"high"}),
                "high",
                "high",
            ),
            (
                json!({"type":"extension_ui_request","method":"setStatus","statusKey":"omp-pulse-thinking","statusText":"{\"configuredThinkingLevel\":\"auto\"}"}),
                "auto",
                "low",
            ),
        ] {
            dispatch_value(&tx, &child, &event);
            let (reply, mut answer) = oneshot::channel();
            lock_poisoned(&child.gate)
                .admit_rpc("state", "get_state", 1, reply, RpcAccess::Boot)
                .unwrap();
            handle_response(
                &child,
                &json!({
                    "type":"response", "id":"state", "success":true,
                    "data":{"thinkingLevel":effective,"isStreaming":false}
                }),
            );
            let state = answer.try_recv().unwrap().unwrap();
            assert_eq!(state["configuredThinkingLevel"], selected);
            assert_eq!(state["thinkingLevel"], effective);
        }
    }

    #[tokio::test]
    async fn question_handoff_waits_for_write_and_fences_duplicate_dispatch() {
        let child = stand_in_child();
        let (tx, mut rx) = broadcast::channel(16);
        dispatch_value(
            &tx,
            &child,
            &json!({"type":"extension_ui_request","method":"ask","id":"answer-write","questions":[{"id":"q","question":"Extras?","multi":true,"options":[]}]}),
        );
        let frame =
            json!({"type":"extension_ui_response","id":"answer-write","value":"exact answer"});
        let write =
            start_ui_response_to_child(&tx, Arc::clone(&child), "/synthetic/turn.jsonl", &frame)
                .unwrap();
        assert!(
            start_ui_response_to_child(&tx, Arc::clone(&child), "/synthetic/turn.jsonl", &frame)
                .is_err()
        );
        assert!(write.await.unwrap().is_ok());
        assert_eq!(lock_poisoned(&child.gate).raw_writes, 0);
        assert_eq!(
            lock_poisoned(&child.pending_ui)["answer-write"]["pulseDelivery"],
            json!("handoff")
        );
        assert_eq!(
            lock_poisoned(&child.pending_ui).len(),
            1,
            "pipe handoff is not callback acceptance"
        );
        dispatch_value(
            &tx,
            &child,
            &json!({"type":"tool_execution_end","toolName":"bash","toolCallId":"unrelated"}),
        );
        assert_eq!(
            lock_poisoned(&child.pending_ui).len(),
            1,
            "an unrelated callback cannot settle the ask"
        );
        dispatch_value(
            &tx,
            &child,
            &json!({"type":"tool_execution_end","toolName":"ask","toolCallId":"ask-call","result":{}}),
        );
        assert!(
            lock_poisoned(&child.pending_ui).is_empty(),
            "the actual ask result retires its question"
        );
        let mut sequences = Vec::new();
        while let Ok(ChildEvent::Event {
            source: Some(source),
            ..
        }) = rx.try_recv()
        {
            sequences.push(source.sequence);
        }
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(
            child.gate.try_lock().is_ok(),
            "settlement releases the gate"
        );
        assert!(
            child.session.try_lock().is_ok(),
            "settlement releases the binding"
        );
        dispatch_value(
            &tx,
            &child,
            &json!({"type":"extension_ui_request","method":"input","id":"next-dialog"}),
        );
        let next = json!({"type":"extension_ui_response","id":"next-dialog","value":"next"});
        assert!(
            start_ui_response_to_child(&tx, Arc::clone(&child), "/synthetic/turn.jsonl", &next)
                .unwrap()
                .await
                .unwrap()
                .is_ok(),
            "a later generic dialog remains answerable after ask settlement"
        );
    }

    // Linux only: the fixture relies on a write to a shut-down socketpair peer
    // failing at once. On macOS that write never completes and the test hung CI.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn broken_question_pipe_reports_uncertainty_instead_of_success() {
        let child = stand_in_child();
        let (tx, _rx) = broadcast::channel(16);
        dispatch_value(
            &tx,
            &child,
            &json!({"type":"extension_ui_request","method":"input","id":"broken-write"}),
        );
        // Shut down a socket peer rather than killing a subprocess: concurrent
        // forks can briefly retain a pipe reader and make a broken write succeed.
        let (reader, writer) = std::os::unix::net::UnixStream::pair().unwrap();
        reader.shutdown(std::net::Shutdown::Both).unwrap();
        let stdin = std::process::ChildStdin::from(std::os::fd::OwnedFd::from(writer));
        *child.stdin.lock().await = tokio::process::ChildStdin::from_std(stdin).unwrap();
        let frame =
            json!({"type":"extension_ui_response","id":"broken-write","value":"keep draft"});
        let result =
            start_ui_response_to_child(&tx, Arc::clone(&child), "/synthetic/turn.jsonl", &frame)
                .unwrap()
                .await
                .unwrap();
        assert!(result.unwrap_err().contains("delivery is unknown"));
        assert!(
            start_ui_response_to_child(&tx, Arc::clone(&child), "/synthetic/turn.jsonl", &frame,)
                .is_err(),
            "an uncertain pipe cannot accept a retry"
        );
        assert!(
            lock_poisoned(&child.pending_ui).contains_key("broken-write"),
            "an uncertain handoff preserves the question"
        );
    }

    /// Background work omp reports after the turn (`prompt_result` with
    /// `sessionSettled: false`) keeps the child busy, so the reaper and
    /// eviction leave it alone until `session_settled`.
    #[cfg(unix)]
    #[tokio::test]
    async fn background_work_after_the_turn_keeps_the_child_busy() {
        let child = stand_in_child();
        let (tx, _rx) = broadcast::channel(16);
        dispatch_value(&tx, &child, &json!({"type": "agent_start"}));
        dispatch_value(&tx, &child, &json!({"type": "agent_end"}));
        assert!(!child_busy(&child, now_ms()));
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "prompt_result", "id": "pulse-prompt:c1", "status": "completed", "sessionSettled": false}),
        );
        assert!(!child.streaming.load(Ordering::SeqCst));
        assert!(child_busy(&child, now_ms()));
        // Bounded: a child that never reports settling is not pinned forever.
        assert!(!child_busy(&child, now_ms() + BACKGROUND_WORK_MAX_MS));
        dispatch_value(&tx, &child, &json!({"type": "session_settled"}));
        assert!(!child_busy(&child, now_ms()));
        // A settled prompt_result never marks background work.
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "prompt_result", "id": "pulse-prompt:c2", "status": "completed", "sessionSettled": true}),
        );
        assert!(!child_busy(&child, now_ms()));
        // A dialog awaiting an answer is busy too.
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "extension_ui_request", "method": "confirm", "id": "q1"}),
        );
        assert!(child_busy(&child, now_ms()));
    }

    #[tokio::test]
    async fn generic_select_closes_only_on_its_exact_callback_scope() {
        let child = stand_in_child();
        let (tx, mut rx) = broadcast::channel(32);
        let marker = |phase: &str, scope: &str| {
            json!({
                "type":"extension_ui_request", "method":"setStatus",
                "statusKey":"omp-pulse-dialog-scope",
                "statusText":json!({"phase":phase,"scope":scope}).to_string()
            })
        };
        dispatch_value(&tx, &child, &marker("begin", "approval"));
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type":"extension_ui_request","method":"select","id":"approve","options":["yes"]
            }),
        );
        let frame = json!({"type":"extension_ui_response","id":"approve","value":"yes"});
        start_ui_response_to_child(&tx, Arc::clone(&child), "/synthetic/turn.jsonl", &frame)
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        dispatch_value(&tx, &child, &marker("end", "unrelated"));
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type":"prompt_result","id":"pulse-command:unrelated","agentInvoked":false
            }),
        );
        assert!(lock_poisoned(&child.pending_ui).contains_key("approve"));
        dispatch_value(&tx, &child, &marker("end", "approval"));
        assert!(lock_poisoned(&child.pending_ui).is_empty());
        let mut closures = Vec::new();
        while let Ok(ChildEvent::Event { event, .. }) = rx.try_recv() {
            if event["method"] == "cancel" {
                closures.push(event["targetId"].clone());
            }
        }
        assert_eq!(closures, vec![json!("approve")]);
        dispatch_value(&tx, &child, &marker("begin", "model"));
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type":"extension_ui_request","method":"select","id":"model","options":["fast"]
            }),
        );
        let frame = json!({"type":"extension_ui_response","id":"model","value":"fast"});
        assert!(
            start_ui_response_to_child(&tx, Arc::clone(&child), "/synthetic/turn.jsonl", &frame)
                .unwrap()
                .await
                .unwrap()
                .is_ok()
        );
        dispatch_value(&tx, &child, &marker("end", "model"));
        assert!(lock_poisoned(&child.pending_ui).is_empty());
    }

    /// Answering a dialog tells every client it closed, once, in omp's own
    /// cancel shape; a repeated or unknown answer announces nothing.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_answered_dialog_is_closed_for_every_client() {
        let child = stand_in_child();
        let (tx, mut rx) = broadcast::channel(16);
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "extension_ui_request", "method": "confirm", "id": "q1"}),
        );
        let asked = match rx.try_recv().unwrap() {
            ChildEvent::Event { source, .. } => source.unwrap().sequence,
            other => panic!("expected the dialog event, got {other:?}"),
        };
        let _gate = lock_poisoned(&child.gate);
        let binding = lock_poisoned(&child.session);
        assert!(close_settled_dialog(&tx, &child, &binding, "q1"));
        assert!(lock_poisoned(&child.pending_ui).is_empty());
        match rx.try_recv().unwrap() {
            ChildEvent::Event {
                session,
                event,
                source,
            } => {
                assert_eq!(session, "/synthetic/turn.jsonl");
                assert_eq!(event["type"], "extension_ui_request");
                assert_eq!(event["method"], "cancel");
                assert_eq!(event["targetId"], "q1");
                assert_ne!(event["id"], "q1", "a cancel carries its own id");
                // Ordered after the dialog it closes, so the authority keeps it.
                assert!(source.unwrap().sequence > asked);
            }
            other => panic!("expected the closing cancel, got {other:?}"),
        }
        assert!(!close_settled_dialog(&tx, &child, &binding, "q1"));
        assert!(!close_settled_dialog(&tx, &child, &binding, "never-asked"));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn tree_stop_channel_never_becomes_a_user_dialog_and_honors_an_early_stop() {
        let child = stand_in_child();
        let (tx, mut rx) = broadcast::channel(16);
        lock_poisoned(&child.tree_cancel).stop_requested = true;
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type":"extension_ui_request", "method":"confirm", "id":"tree-stop",
                "title":"omp-pulse-tree-cancel", "message":"",
            }),
        );
        assert!(lock_poisoned(&child.pending_ui).is_empty());
        assert!(
            rx.try_recv().is_err(),
            "internal cancellation must not ask the user a second question"
        );
        assert_eq!(
            lock_poisoned(&child.gate).raw_writes,
            1,
            "Stop must send an out-of-band UI response, not a queued command prompt"
        );
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type":"extension_ui_request", "method":"select", "id":"real-question",
                "title":"Which database?", "options":["SQLite","Postgres"],
            }),
        );
        assert!(lock_poisoned(&child.pending_ui).contains_key("real-question"));
        assert!(
            rx.try_recv().is_ok(),
            "the actual native question remains visible"
        );
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type":"extension_ui_request", "method":"cancel", "id":"closed",
                "targetId":"tree-stop",
            }),
        );
        assert!(rx.try_recv().is_err());
        assert!(lock_poisoned(&child.tree_cancel).request_id.is_none());
    }

    /// A phone control's reply settles its waiter, frees the child and never
    /// reaches the phone; its prompt_result is not a conversation turn.
    #[cfg(unix)]
    #[tokio::test]
    async fn extension_replies_settle_their_request_and_stay_private() {
        let child = stand_in_child();
        let (tx, mut rx) = broadcast::channel(16);
        let (waiter, reply) = oneshot::channel();
        lock_poisoned(&child.extension_replies).insert("x1".to_string(), waiter);
        assert!(
            child_busy(&child, now_ms()),
            "a running control keeps the child busy"
        );
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "extension_ui_request", "id": "u1", "method": "setStatus",
                    "statusKey": "omp-pulse:x1", "statusText": "{\"ok\":true,\"enabled\":true}"}),
        );
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "prompt_result", "id": "pulse-ext:x1", "status": "completed", "sessionSettled": false}),
        );
        assert_eq!(reply.await.unwrap(), json!({"ok": true, "enabled": true}));
        assert!(!child_busy(&child, now_ms()), "neither frame marks work");
        assert!(rx.try_recv().is_err(), "nothing was forwarded to the phone");
        // Any other status key is an ordinary UI frame and is forwarded.
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "extension_ui_request", "id": "u2", "method": "setStatus", "statusKey": "git", "statusText": "main"}),
        );
        assert!(rx.try_recv().is_ok());
    }

    #[tokio::test]
    async fn native_extension_failure_and_post_ack_command_output_remain_nonterminal() {
        let child = stand_in_child();
        let (tx, mut events) = broadcast::channel(16);
        dispatch_value(&tx, &child, &json!({"type":"agent_start"}));
        let _ = events.try_recv().unwrap();
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type":"response", "id":"pulse-command:r8", "command":"prompt",
                "success":true, "data":{"agentInvoked":false}
            }),
        );
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type":"extension_error","extensionPath":"/extensions/review.ts",
                "event":"tool_call","error":"hook failed"
            }),
        );
        dispatch_value(
            &tx,
            &child,
            &json!({
                "type":"command_output","text":"\u{1b}[31mHandoff failed: provider unavailable\u{1b}[0m"
            }),
        );
        let mut notice_ids = Vec::new();
        for _ in 0..2 {
            let ChildEvent::Event {
                session,
                event,
                source,
            } = events.try_recv().unwrap()
            else {
                panic!("expected native event");
            };
            assert_eq!(session, "/synthetic/turn.jsonl");
            let source = source.unwrap();
            assert_eq!(
                event["feedbackId"],
                format!(
                    "native:{}:{}:{}",
                    child.source_id, source.identity.binding_epoch, source.sequence
                )
            );
            if event["type"] == "command_output" {
                assert_eq!(event["text"], "Handoff failed: provider unavailable");
            }
            notice_ids.push(event["feedbackId"].clone());
        }
        assert!(child.streaming.load(Ordering::SeqCst));
        let snapshot = lock_poisoned(&child.feedback).snapshot(now_ms());
        let notices = snapshot["requests"].as_array().unwrap();
        assert_eq!(
            notices
                .iter()
                .map(|notice| notice["id"].clone())
                .collect::<Vec<_>>(),
            notice_ids
        );
        assert_eq!(
            notices[0]["message"],
            "Extension /extensions/review.ts (tool_call): hook failed"
        );
        assert_eq!(
            notices[1]["message"],
            "Handoff failed: provider unavailable"
        );
        assert!(events.try_recv().is_err());
    }

    /// Live `/pulse-bash` output leaves as a BashOutput event, never as a
    /// status frame, and leaves the command's reply waiter open.
    #[cfg(unix)]
    #[tokio::test]
    async fn bash_output_frames_become_bash_output_events() {
        let child = stand_in_child();
        let (tx, mut rx) = broadcast::channel(16);
        let (waiter, _reply) = oneshot::channel();
        lock_poisoned(&child.extension_replies).insert("x2".to_string(), waiter);
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "extension_ui_request", "id": "u3", "method": "setStatus",
                    "statusKey": "omp-pulse-out:run-7", "statusText": "compiling\n"}),
        );
        match rx.try_recv().unwrap() {
            ChildEvent::BashOutput {
                session,
                id,
                text,
                source,
            } => {
                assert_eq!(session, lock_poisoned(&child.session).clone());
                assert_eq!(id, "run-7");
                assert_eq!(text, "compiling\n");
                assert!(source.is_some());
            }
            other => panic!("expected BashOutput, got {other:?}"),
        }
        assert!(
            rx.try_recv().is_err(),
            "the status frame itself stays private"
        );
        assert!(
            lock_poisoned(&child.extension_replies).contains_key("x2"),
            "output does not settle the command"
        );
    }

    /// A side question being answered keeps an otherwise idle child busy, a
    /// follow-up's own status decides, and any end state frees it.
    #[cfg(unix)]
    #[tokio::test]
    async fn running_side_question_keeps_the_child_busy() {
        let child = stand_in_child();
        let (tx, _rx) = broadcast::channel(16);
        let record = |status: &str, follow_up: Option<&str>| {
            let mut record = json!({"id": "b1", "question": "q", "answer": "", "status": status, "leafId": null});
            if let Some(follow_up) = follow_up {
                record["followUps"] = json!([{"question": "f", "answer": "", "status": follow_up}]);
            }
            json!({"type": "btw_record", "record": record})
        };
        dispatch_value(&tx, &child, &record("running", None));
        assert!(child_busy(&child, now_ms()));
        dispatch_value(&tx, &child, &record("complete", None));
        assert!(!child_busy(&child, now_ms()));
        dispatch_value(&tx, &child, &record("complete", Some("running")));
        assert!(child_busy(&child, now_ms()));
        dispatch_value(&tx, &child, &record("complete", Some("cancelled")));
        assert!(!child_busy(&child, now_ms()));
    }

    /// omp answers `prompt` at admission, before `agent_start`; in that gap
    /// no RPC is in flight and the turn is not streaming, yet stopping the
    /// child loses the accepted prompt. The reservation keeps it busy until
    /// the turn ends or the prompt is refused.
    #[cfg(unix)]
    #[tokio::test]
    async fn accepted_prompt_keeps_the_child_busy_until_its_turn_ends() {
        let child = stand_in_child();
        let (tx, _rx) = broadcast::channel(16);
        let now = now_ms();
        lock_poisoned(&child.active_prompt).reserve("c1", now);
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "response", "id": "pulse-prompt:c1", "command": "prompt", "success": true}),
        );
        assert!(!child.streaming.load(Ordering::SeqCst));
        assert!(child_busy(&child, now_ms()));
        dispatch_value(&tx, &child, &json!({"type": "agent_start"}));
        dispatch_value(&tx, &child, &json!({"type": "agent_end"}));
        assert!(!child_busy(&child, now_ms()));

        // A prompt omp handled without a turn frees the child at once.
        lock_poisoned(&child.active_prompt).reserve("c2", now_ms());
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "response", "id": "pulse-prompt:c2", "command": "prompt", "success": true, "data": {"agentInvoked": false}}),
        );
        assert!(!child_busy(&child, now_ms()));

        // Overlapping prompts that never start a turn are bounded, not pinned.
        lock_poisoned(&child.active_prompt).reserve("c3", now);
        lock_poisoned(&child.active_prompt).reserve("c4", now);
        assert!(child_busy(&child, now));
        assert!(!child_busy(&child, now + PROMPT_RESERVATION_MAX_MS));
    }

    /// An omp that refuses to start says why only on stderr; the exit notice
    /// (and so the failed request) must carry it, not a bare "exited".
    #[cfg(unix)]
    #[tokio::test]
    async fn unexpected_exit_carries_the_stderr_tail() {
        let children: Arc<Mutex<HashMap<String, Arc<Child>>>> = Arc::default();
        let (tx, mut rx) = broadcast::channel(16);
        let mut proc = tokio::process::Command::new("sh")
            .env("PATH", env!("PATH"))
            .args(["-c", "echo 'No default model selected.' >&2; echo >&2; echo 'Set an API key' >&2; exit 1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");
        let stdout = proc.stdout.take().expect("piped stdout");
        let stderr = proc.stderr.take().expect("piped stderr");
        let child = stand_in_child();
        *lock_poisoned(&child.proc) = Some(proc);
        monitor_loop(tx, children, child, stdout, stderr, None).await;
        let mut last = None;
        while let Ok(event) = rx.try_recv() {
            if let ChildEvent::Notice { message, .. } = event {
                last = Some(message);
            }
        }
        assert_eq!(
            last.as_deref(),
            Some("agent process exited: No default model selected. Set an API key")
        );
    }

    /// A long turn must not leave the child looking idle the moment it ends:
    /// `agent_start` and the terminal `agent_end` refresh `last_active`; frames
    /// inside the turn do not (they arrive per token).
    #[cfg(unix)]
    #[tokio::test]
    async fn turn_boundaries_refresh_last_active() {
        let child = stand_in_child();
        let (tx, _rx) = broadcast::channel(16);

        dispatch_value(&tx, &child, &json!({"type": "agent_start"}));
        assert!(child.streaming.load(Ordering::SeqCst));
        assert!(child.last_active.load(Ordering::SeqCst) > 1);

        child.last_active.store(1, Ordering::SeqCst);
        dispatch_value(&tx, &child, &json!({"type": "message_end"}));
        assert_eq!(child.last_active.load(Ordering::SeqCst), 1);
        // A non-terminal agent_end (subagent hop) is not the turn's end.
        dispatch_value(
            &tx,
            &child,
            &json!({"type": "agent_end", "isTerminal": false}),
        );
        assert_eq!(child.last_active.load(Ordering::SeqCst), 1);
        assert!(child.streaming.load(Ordering::SeqCst));

        dispatch_value(&tx, &child, &json!({"type": "agent_end"}));
        assert!(!child.streaming.load(Ordering::SeqCst));
        assert!(child.last_active.load(Ordering::SeqCst) > 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nonblocking_feedback_replays_current_values_without_requesting_input() {
        let child = stand_in_child();
        let other = stand_in_child();
        let (tx, mut rx) = broadcast::channel(16);
        let draft = json!({"type":"extension_ui_request","method":"set_editor_text","id":"draft","text":"review"});
        for frame in [
            json!({"type":"extension_ui_request","method":"setStatus","id":"s1","statusKey":"git","statusText":"old"}),
            json!({"type":"extension_ui_request","method":"setStatus","id":"s2","statusKey":"git","statusText":"main"}),
            draft.clone(),
        ] {
            dispatch_value(&tx, &child, &frame);
            match rx.try_recv().unwrap() {
                ChildEvent::Event { event, .. } => assert_eq!(event, frame),
                other => panic!("expected original live feedback, got {other:?}"),
            }
        }
        assert!(!child_busy(&child, now_ms()));
        assert!(lock_poisoned(&child.pending_ui).is_empty());
        dispatch_value(&tx, &child, &json!({"type":"agent_end"}));
        let snapshot = lock_poisoned(&child.feedback).snapshot(now_ms());
        assert_eq!(snapshot["requests"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["requests"][1], draft);
        assert_eq!(
            lock_poisoned(&other.feedback).snapshot(now_ms())["requests"],
            json!([])
        );
        dispatch_value(
            &tx,
            &child,
            &json!({"type":"extension_ui_request","method":"setStatus","statusKey":"git"}),
        );
        assert_eq!(
            lock_poisoned(&child.feedback).snapshot(now_ms())["requests"],
            json!([draft])
        );
        while rx.try_recv().is_ok() {}
        for frame in [
            json!({"type":"extension_ui_request","method":"setStatus","statusKey":"omp-pulse-out:empty"}),
            json!({"type":"extension_ui_request","method":"setWidget","widgetKey":"omp-pulse:secret","widgetLines":["encoded reply"]}),
            json!({"type":"extension_ui_request","method":"notify","id":"secret","message":"omp-pulse:encoded"}),
        ] {
            dispatch_value(&tx, &child, &frame);
        }
        assert!(rx.try_recv().is_err());
        assert_eq!(
            lock_poisoned(&child.feedback).snapshot(now_ms())["requests"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
