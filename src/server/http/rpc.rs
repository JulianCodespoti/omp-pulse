//! The `/api/rpc` endpoint: the allowlist of phone-callable omp RPC commands,
//! their ownership gate, and branch/fork.

use super::*;
use crate::{omp::child::PhoneControl, omp::desktop_control, sessions::jsonl};
use axum::{Json, extract::State, http::StatusCode, response::Response};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

/// Longest entry label the Timeline may set; omp's own `/tree` labels are
/// a word or two, and a row has room for little more.
const TREE_LABEL_MAX: usize = 64;

/// The phone's RPC surface. Native command strings are verified verbatim
/// against `packages/coding-agent/src/modes/rpc/rpc-types.ts`; phone controls
/// and live prompt metadata below are served by the managed owner extensions.
/// Commands that exist in rpc-types.ts but
/// are NOT listed here are deliberate exclusions (see the report): they are
/// handshake-only (`negotiate_protocol`), have dedicated HTTP endpoints
/// (`prompt`/`steer`/`follow_up`/`abort`/`abort_and_prompt`/`new_session`/
/// `bash`, and `export_html` behind `/api/export`, which picks the output
/// path itself: a phone-chosen path would be an arbitrary file write on the
/// omp host), are manager-only binding operations (`switch_session`: open and
/// pool retargeting own destination admission and registry rekeying), belong
/// to the desktop's host bridge (`set_host_tools`/
/// `set_host_uri_schemes`), are side-effecting beyond a phone's remit
/// (`handoff`, `cycle_thinking_level`, `login`, `get_login_providers`), or
/// have no useful phone form: `cycle_model` walks the `--models`/
/// `enabledModels` scope, which daemon children never get (no `--models`)
/// and get_state does not report, so without one it steps through EVERY
/// available model; the picker covers it. `host_tool_cancel` is not a stdin
/// command at all: it is an OUTPUT frame (`RpcHostToolCancelRequest` in
/// rpc-types.ts) emitted BY the RPC server to the host when a pending
/// host-tool call should be aborted; there is no client→server
/// `host_tool_cancel` to allowlist.
const ALLOWED_RPC_COMMANDS: &[&str] = &[
    // Read-only session state.
    "get_state",
    "get_queue_recovery",
    "acknowledge_queue_recovery",
    "get_available_models",
    "get_prompt_config",
    "get_model_mention_choices",
    // Pulse controls over the native desktop collab agent-chat path.
    "get_desktop_agent_follow_up",
    "desktop_agent_follow_up",
    "set_model",
    "set_thinking_level",
    "set_fast_mode",
    // `/slow`: flex tier (OpenAI/Google) or low priority (Claude
    // subscriptions). get_state's `slowModeSupported` gates the switch.
    "set_slow_mode",
    "get_available_commands",
    "get_session_stats",
    "get_subagents",
    "get_subagent_messages",
    "get_messages",
    "get_messages_page",
    "get_branch_messages",
    "get_last_assistant_text",
    // The live model's selectable thinking levels, `off` included; the
    // session settings picker offers only these.
    "get_available_thinking_levels",
    // Subagent event subscription. The client already sends this at boot
    // (index.html:8055) and was silently rejected before this was allowlisted.
    "set_subagent_subscription",
    // Cancels a USER-run shell command (`/api/bash`, i.e. `!cmd`) only: omp's
    // `abort_bash` takes no params and aborts its BashRunner, which never runs
    // the agent's bash tool. An agent tool call stops with the turn
    // (`/api/abort`); there is no per-tool-call cancel over RPC.
    "abort_bash",
    // `branch` creates a NEW session and never writes the source, so it is
    // served from the file (`branch_rpc`) and bypasses the ownership gate.
    "branch",
    // Mutating commands below; the ownership gate in MUTATING_RPC_COMMANDS
    // applies, so a session the desktop omp hosts refuses these with the
    // stable session_owned_by_terminal shape instead of a silent second
    // writer.
    // `/fork`: omp's whole-session fork. A child the daemon writes runs the
    // real RPC (`fork_rpc`); any other session is copied from its file, so
    // the gate's refusal becomes the copy instead of an error.
    "fork",
    "set_session_name",
    "compact",
    "set_todos",
    "set_auto_compaction",
    "set_auto_retry",
    "set_steering_mode",
    "set_follow_up_mode",
    "set_interrupt_mode",
    // Session-only cache warming override (`off`/`streaming`/`idle`); omp
    // never writes config.yml for it.
    "set_cache_warming",
    // omp's pending-message queue (steering / follow-up chips). Both act on
    // the first matching entry; neither re-sends anything.
    "remove_queued_message",
    "promote_queued_message",
    // Affect only one running subagent, never the parent turn.
    "steer_subagent",
    "cancel_subagent",
    // Cancels omp's auto-retry backoff (the phone's "Retrying in 8s · Cancel").
    // Ends the pending retry only; the turn then fails with the provider error.
    "abort_retry",
    // Goal mode (`op`: get/create/resume/pause/drop). Mutating even for
    // `get`: the goal lives in the writer's process, so a session the desktop
    // owns gets the typed refusal instead of a second writer.
    "goal",
    // Side questions (`/btw`): one ephemeral answer over the session's
    // context, never added to the transcript. omp runs them beside the main
    // turn (they neither wait for nor block a running prompt), and this route
    // has no turn gate, so one may be asked mid-turn. `btw`/`btw_cancel`
    // write omp's BTW history sidecar, hence the ownership gate below;
    // `get_btw_history` only reads it.
    "btw",
    "btw_cancel",
    "get_btw_history",
    // Phone controls the daemon serves through its child extension, not omp
    // RPC commands (omp's RPC has none of them; see `phone_control_rpc`).
    // Mutating: plan mode, a tree move and a label all write the journal.
    "plan_mode",
    "tree_goto",
    "tree_label",
];

/// RPC commands that MUTATE session state (rename, navigate, compact,
/// todos, mode toggles). These go through the per-write ownership gate; the
/// read-only commands stay available for a session a terminal owns, so the
/// phone can still inspect it.
const MUTATING_RPC_COMMANDS: &[&str] = &[
    "set_model",
    "set_thinking_level",
    "set_fast_mode",
    "set_slow_mode",
    "set_session_name",
    "fork",
    "compact",
    "set_todos",
    "set_auto_compaction",
    "set_auto_retry",
    "set_steering_mode",
    "set_follow_up_mode",
    "set_interrupt_mode",
    "set_cache_warming",
    "remove_queued_message",
    "promote_queued_message",
    "steer_subagent",
    "cancel_subagent",
    "desktop_agent_follow_up",
    "abort_retry",
    "goal",
    "btw",
    "btw_cancel",
    "plan_mode",
    "tree_goto",
    "tree_label",
];

/// RPC commands that read a catalogue rather than session state, and can
/// therefore be answered by a session-less child (see `catalogue_rpc`). Adding
/// to this list is a claim that the answer does not depend on WHICH session
/// asks; verify that before extending it.
const CATALOGUE_RPC_COMMANDS: &[&str] = &["get_available_commands", "get_available_models"];

fn rpc_ownership_refusal(command: &str, path: WritePath) -> Option<Response> {
    if !MUTATING_RPC_COMMANDS.contains(&command) {
        return None;
    }
    match path {
        // A side question is not a setting: the shared refusal's "change
        // this setting there" would send the reader looking for one.
        WritePath::Host | WritePath::Bridge(_) if command.starts_with("btw") => Some(refusal_body(
            "this conversation is open in omp on the desktop — ask side questions there",
        )),
        // Moving or labelling turns is not a setting either, and the phone
        // still has the fork that works without the writer.
        WritePath::Host | WritePath::Bridge(_) if command.starts_with("tree_") => {
            Some(refusal_body(
                "this conversation is open in omp on the desktop — do this there, or rewind into a new chat from here",
            ))
        }
        path => ownership_refusal(path),
    }
}

/// The `/api/rpc` commands served by the child extension rather than omp.
fn phone_control_for(command: &str) -> Option<PhoneControl> {
    match command {
        "get_prompt_config" => Some(PhoneControl::PromptConfig),
        "get_model_mention_choices" => Some(PhoneControl::ModelMentionChoices),
        "plan_mode" => Some(PhoneControl::Plan),
        "tree_goto" => Some(PhoneControl::TreeMove),
        "tree_label" => Some(PhoneControl::Label),
        _ => None,
    }
}

fn tree_move_payload(params: &Value) -> Result<Value, &'static str> {
    let entry_id = params
        .get("entryId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or("entryId required")?;
    let summarize = match params.get("summarize") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("summarize must be true or false"),
    };
    let mut payload = json!({ "entryId": entry_id, "summarize": summarize });
    if let Some(instructions) = params.get("customInstructions") {
        let Some(instructions) = instructions.as_str() else {
            return Err("customInstructions must be a string");
        };
        payload["customInstructions"] = json!(instructions);
    }
    Ok(payload)
}

/// Run a phone control after owner routing and, for writes, ownership admission.
/// Metadata reads take no payload. Other parameters are validated here:
/// `plan_mode {enabled: bool}`, `tree_goto {entryId, summarize?, customInstructions?}`, `tree_label
/// {entryId, label: string|null}` (null or empty clears).
async fn phone_control_rpc(
    state: &Arc<AppState>,
    session: &str,
    control: PhoneControl,
    params: &Value,
) -> Response {
    let entry_id = params
        .get("entryId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let payload = match control {
        PhoneControl::PromptConfig | PhoneControl::ModelMentionChoices => json!({}),
        PhoneControl::Plan => match params.get("enabled").and_then(Value::as_bool) {
            Some(enabled) => json!({ "enabled": enabled }),
            None => return err_status(StatusCode::BAD_REQUEST, "enabled must be true or false"),
        },
        PhoneControl::TreeMove => match tree_move_payload(params) {
            Ok(payload) => payload,
            Err(message) => return err_status(StatusCode::BAD_REQUEST, message),
        },
        PhoneControl::Label => {
            let label = match params.get("label") {
                None | Some(Value::Null) => Value::Null,
                Some(Value::String(label)) if label.chars().count() <= TREE_LABEL_MAX => {
                    json!(label.trim())
                }
                Some(_) => {
                    return err_status(
                        StatusCode::BAD_REQUEST,
                        "label must be a short string or null",
                    );
                }
            };
            match entry_id {
                Some(id) => json!({ "entryId": id, "label": label }),
                None => return err_status(StatusCode::BAD_REQUEST, "entryId required"),
            }
        }
    };
    match state
        .children
        .phone_control(session, control, payload)
        .await
    {
        Ok(data) => ok(json!({ "ok": true, "data": data })),
        Err(e) if owned_by_terminal(&e) => {
            ok(json!({ "ok": false, "error": e, "code": "session_owned_by_terminal" }))
        }
        Err(e) => child_error(&e),
    }
}

async fn desktop_agent_follow_up_rpc(
    state: &Arc<AppState>,
    session: &str,
    command: &str,
    params: &Value,
) -> Response {
    let authority = session_authority(state, session);
    let binding_matches = params["daemonInstanceId"].as_str()
        == Some(authority.daemon_instance_id.as_str())
        && params["bindingEpoch"].as_u64() == Some(authority.binding_epoch);
    if !binding_matches
        || !matches!(authority.owner.kind.as_str(), "bridge" | "collab")
        || authority.confidence != crate::authority::session_state::Confidence::Confirmed
        || authority.connection != crate::authority::session_state::Connection::Connected
    {
        return err_status(
            StatusCode::CONFLICT,
            "the desktop session binding changed; reopen this agent",
        );
    }
    let Some(agent_id) = params["agentId"]
        .as_str()
        .filter(|id| !id.trim().is_empty())
    else {
        return err_status(StatusCode::BAD_REQUEST, "agentId required");
    };
    let Some(created_at) = params["expectedCreatedAt"]
        .as_f64()
        .filter(|at| at.is_finite() && *at >= 0.0)
    else {
        return err_status(StatusCode::BAD_REQUEST, "expectedCreatedAt required");
    };
    let Some(connection_id) = params["expectedConnectionId"]
        .as_str()
        .filter(|id| !id.is_empty())
    else {
        return err_status(StatusCode::BAD_REQUEST, "expectedConnectionId required");
    };
    let text = if command == "desktop_agent_follow_up" {
        match params["text"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty() && text.len() <= 64 * 1024)
        {
            Some(text) => Some(text),
            None => {
                return err_status(
                    StatusCode::BAD_REQUEST,
                    "follow-up text required (at most 64 KiB)",
                );
            }
        }
    } else {
        None
    };
    let receiver = match state.collab.desktop_agent_follow_up(
        session,
        agent_id,
        created_at,
        connection_id,
        text,
    ) {
        Ok(receiver) => receiver,
        Err(error) if text.is_none() => {
            return ok(json!({"ok":true, "data":{"available":false, "reason":error}}));
        }
        Err(error) => return err_status(StatusCode::CONFLICT, &error),
    };
    let Some(receiver) = receiver else {
        return ok(json!({"ok":true, "data":{"available":true}}));
    };
    match tokio::time::timeout(std::time::Duration::from_secs(10), receiver).await {
        Ok(Ok(true)) => ok(json!({"ok":true, "data":{"delivery":"handoff"}})),
        _ => err_status(
            StatusCode::GATEWAY_TIMEOUT,
            "follow-up delivery is unconfirmed; check the desktop before sending again",
        ),
    }
}

pub(super) async fn rpc(State(state): State<Arc<AppState>>, body: Option<Json<Value>>) -> Response {
    let body = body_value(body);
    let Some(raw) = session_path_from_body(&body) else {
        return err("invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    let cmd = body.get("command").and_then(|v| v.as_str()).unwrap_or("");
    if cmd.is_empty() {
        return err("invalid command");
    }
    if !ALLOWED_RPC_COMMANDS.contains(&cmd) {
        return err("command not allowed");
    }
    let params = match body.get("params") {
        Some(Value::Object(_)) => body["params"].clone(),
        _ => json!({}),
    };
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    // The journal is per session and needs no live owner: it exists for the
    // moment after one withdrew a message, so ownership gates must not apply.
    if matches!(cmd, "get_queue_recovery" | "acknowledge_queue_recovery") {
        let state_dir = state.cfg.state_dir.clone();
        let acknowledge = cmd == "acknowledge_queue_recovery";
        return match tokio::task::spawn_blocking(move || {
            if acknowledge {
                let id = params.get("recoveryId").and_then(Value::as_str);
                queue_recovery::acknowledge(&state_dir, &session, id.unwrap_or(""))
            } else {
                queue_recovery::replay(&state_dir, &session)
            }
        })
        .await
        {
            Ok(Ok(data)) => ok(json!({ "ok": true, "data": data })),
            Ok(Err(error)) => err(&error),
            Err(_) => err("withdrawn draft recovery failed"),
        };
    }
    if matches!(
        cmd,
        "get_desktop_agent_follow_up" | "desktop_agent_follow_up"
    ) {
        return desktop_agent_follow_up_rpc(&state, &session, cmd, &params).await;
    }
    if MUTATING_RPC_COMMANDS.contains(&cmd)
        && session_authority(&state, &session).owner.kind == "ambiguous"
    {
        return err_status(
            StatusCode::CONFLICT,
            "conflicting live session owners; no command was dispatched",
        );
    }
    if matches!(cmd, "get_prompt_config" | "get_model_mention_choices")
        && session_authority(&state, &session).owner.kind == "ambiguous"
    {
        return err_status(
            StatusCode::CONFLICT,
            "conflicting live session owners; configuration is unavailable",
        );
    }
    // Rewind is served from the session FILE for every session (src/sessions/branch.rs):
    // it never writes the source, so it needs no writer, and the desktop
    // owning the file (the usual case) no longer refuses it. Both halves use
    // the file so their entry ids always agree.
    if cmd == "get_branch_messages" || cmd == "branch" {
        return branch_rpc(&state, path, cmd, &params).await;
    }
    if cmd == "fork" {
        return fork_rpc(&state, path, &session).await;
    }
    // `peek`: a passive read (the chat header polls this on every open and
    // every 30 s). It must never boot a ~400 MB child plus its MCP servers
    // just to show a model name: that is what made merely browsing
    // conversations from the phone cost a child each. A live child or owner
    // still answers with full state; otherwise the file answers.
    let peek = cmd == "get_state" && body.get("peek").and_then(Value::as_bool) == Some(true);
    // A foreign omp process owns the session: settings, rename and compaction
    // must use the desktop extension's real session API. Never fall through to
    // collab or a second RPC child: the collab protocol carries no channel
    // for these, and a child compact would be a second writer whose entries
    // the host's wholesale rewrite destroys. Rename used to be refused here
    // outright ("open in the desktop app") even with a live bridge.
    if matches!(
        cmd,
        "get_state"
            | "get_prompt_config"
            | "get_model_mention_choices"
            | "set_model"
            | "set_thinking_level"
            | "set_session_name"
            | "compact"
    ) {
        // The live bridge first, exactly as `write_path` orders it: omp does
        // not keep the session file open between writes, so the /proc guard
        // routinely misses a connected owner, and every one of these fell
        // through to "change this setting there" with the bridge up.
        let owner_pid = crate::omp::bridge::live_pid(&session)
            .or_else(|| session_owner(&state, &session).map(|owner| owner.pid));
        if let Some(owner_pid) = owner_pid {
            return match desktop_control::rpc_for_owner(
                &state.cfg,
                &session,
                owner_pid,
                cmd,
                params.clone(),
            )
            .await
            {
                Ok(response) => ok(response),
                Err(e) => err(&e),
            };
        }
        if peek && !state.children.has_child(&session) {
            let file = path.clone();
            let snapshot = tokio::task::spawn_blocking(move || {
                let header = jsonl::parse_header(&file);
                let mut snapshot = json!({
                    "sessionFile": file.to_string_lossy(),
                    "sessionName": header.title,
                    "model": jsonl::last_model(&file),
                    "isStreaming": false,
                    "source": "file",
                });
                let configuration =
                    crate::sessions::index::session_configuration(&file.to_string_lossy());
                snapshot["sessionModelPending"] = json!(configuration.is_none());
                if let Some(configuration) = configuration
                    && let Ok(Value::Object(configuration)) = serde_json::to_value(configuration)
                    && let Some(object) = snapshot.as_object_mut()
                {
                    object.extend(configuration);
                }
                snapshot
            })
            .await
            .unwrap_or_else(|_| json!({ "source": "file" }));
            return ok(json!({ "ok": true, "data": snapshot }));
        }
        // A collab attachment has no settings channel, and compaction without
        // a live owner has no bridge to run on. Refuse explicitly rather than
        // allowing the generic write path to route through the host or create
        // a second child. (Compact keeps the host-path refusal below, where
        // the message tells the user to compact in the desktop terminal.)
        if cmd != "compact" && state.collab.is_attached(&session) {
            return err(
                "desktop control bridge is unavailable for this session; restart omp and reload the desktop-control extension",
            );
        }
    }

    // Queue edits must reach the accepted live owner. A desktop queue is not
    // empty merely because the daemon has no child for the conversation.
    if matches!(cmd, "remove_queued_message" | "promote_queued_message") {
        let owner = write_path(&state, &session).await;
        if let WritePath::Bridge(pid) = owner
            && cmd == "remove_queued_message"
        {
            return match desktop_control::rpc_for_owner(&state.cfg, &session, pid, cmd, params)
                .await
            {
                Ok(response) => ok(response),
                Err(e) => err(&e),
            };
        }
        if let Some(response) = rpc_ownership_refusal(cmd, owner) {
            return response;
        }
        if !state.children.has_child(&session) {
            let data = if cmd == "remove_queued_message" {
                json!({ "removed": false })
            } else {
                json!({ "promoted": false })
            };
            return ok(json!({ "ok": true, "data": data }));
        }
        // The daemon's own child answers with the removed text; journal it
        // before replying, off the HTTP waiter's lifetime, keyed by the
        // owner-issued item so a repeat delivery is one record. A desktop
        // owner journals in its extension and the reply already carries the id.
        if cmd == "remove_queued_message"
            && let Some(item_id) = params
                .get("itemId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        {
            let children = Arc::clone(&state.children);
            let removal_session = session.clone();
            return match queue_recovery::capture(
                state.cfg.state_dir.clone(),
                session,
                "message",
                Some(item_id),
                async move {
                    children
                        .rpc(&removal_session, "remove_queued_message", params)
                        .await
                        .map(Some)
                },
            )
            .await
            {
                Ok(data) => ok(json!({ "ok": true, "data": data.unwrap_or(Value::Null) })),
                Err(error) => err(&error),
            };
        }
    }
    if MUTATING_RPC_COMMANDS.contains(&cmd)
        && let Some(response) = rpc_ownership_refusal(cmd, write_path(&state, &session).await)
    {
        return response;
    }
    if let Some(control) = phone_control_for(cmd) {
        return phone_control_rpc(&state, &session, control, &params).await;
    }
    // Subagents live only in the running parent. Check after ownership so
    // desktop-owned sessions still receive the typed refusal, without
    // resuming a second writer just to control an agent it cannot own.
    if matches!(cmd, "steer_subagent" | "cancel_subagent") && !state.children.has_child(&session) {
        return err("agent process not running");
    }
    // A retry backoff exists only inside a running child. After the ownership
    // gate (a desktop-owned session gets the typed refusal), no child means
    // nothing to cancel: answer success rather than boot one.
    if cmd == "abort_retry" && !state.children.has_child(&session) {
        return ok(json!({ "ok": true, "data": {} }));
    }
    // Read-only catalogues belong to the omp BUILD and the project, not to a
    // session: the command list and the model list are identical whichever
    // session asks. Routing them through the session's exclusive child left the
    // phone with an empty command palette AND an empty model picker whenever the
    // desktop held the session file open, which is the normal case. Worse, the
    // client's picker treated the failure as "fall back to sending the text", so
    // `/model` was written into the conversation as if the user had said it.
    if CATALOGUE_RPC_COMMANDS.contains(&cmd)
        && (cmd == "get_available_commands" || !state.children.has_child(&session))
    {
        let cwd = match files::project_cwd(&path) {
            Ok(cwd) => cwd,
            Err(response) => return *response,
        };
        return match state
            .children
            .catalogue_rpc(&cwd.to_string_lossy(), cmd)
            .await
        {
            Ok(data) => ok(json!({ "ok": true, "data": data })),
            Err(e) => child_error(&e),
        };
    }
    let requested_thinking = (cmd == "set_model")
        .then(|| {
            params
                .get("thinkingLevel")
                .filter(|value| !value.is_null())
                .cloned()
        })
        .flatten();
    let child_params = if requested_thinking.is_some() {
        let mut object = params.as_object().cloned().unwrap_or_default();
        object.remove("thinkingLevel");
        Value::Object(object)
    } else {
        params
    };
    match state.children.rpc(&session, cmd, child_params).await {
        Ok(data) => {
            let model_data = if data.is_null() { json!({}) } else { data };
            let Some(level) = requested_thinking else {
                return ok(json!({ "ok": true, "data": model_data }));
            };
            match state
                .children
                .rpc(&session, "set_thinking_level", json!({ "level": level }))
                .await
            {
                Ok(_) => match state.children.rpc(&session, "get_state", json!({})).await {
                    Ok(actual) => {
                        let actual = if actual.is_null() { json!({}) } else { actual };
                        if actual
                            .get("configuredThinkingLevel")
                            .or_else(|| actual.get("thinkingLevel"))
                            != Some(&level)
                            || actual.pointer("/model/provider") != model_data.get("provider")
                            || actual.pointer("/model/id") != model_data.get("id")
                        {
                            return ok(json!({
                                "ok": false,
                                "error": "The session did not apply the requested model and reasoning level.",
                                "code": "partial_settings",
                                "data": actual,
                            }));
                        }
                        ok(json!({ "ok": true, "data": actual }))
                    }
                    Err(e) => ok(json!({
                        "ok": false,
                        "error": format!(
                            "model and thinking level were applied, but the actual state could not be read: {e}"
                        ),
                        "code": "state_unavailable",
                        "data": model_data,
                    })),
                },
                Err(e) => {
                    let observed = state
                        .children
                        .rpc(&session, "get_state", json!({}))
                        .await
                        .ok()
                        .filter(|value| !value.is_null())
                        .unwrap_or(model_data);
                    ok(json!({
                        "ok": false,
                        "error": format!("model was applied, but thinking level failed: {e}"),
                        "code": "partial_settings",
                        "data": observed,
                    }))
                }
            }
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

/// `get_branch_messages` / `branch` over the session file. Shapes match omp's
/// RPC (`{messages:[{entryId,text}]}`, `{text, cancelled}`), and `branch` also
/// returns the new `sessionPath`, which omp's RPC never did: the client had to
/// ask the moved child where it went.
async fn branch_rpc(state: &Arc<AppState>, path: PathBuf, cmd: &str, params: &Value) -> Response {
    if cmd == "get_branch_messages" {
        return match tokio::task::spawn_blocking(move || {
            crate::sessions::branch::user_messages(&path)
        })
        .await
        {
            Ok(Ok(messages)) => {
                let messages: Vec<Value> = messages
                    .into_iter()
                    .map(|m| json!({ "entryId": m.entry_id, "text": m.text }))
                    .collect();
                ok(json!({ "ok": true, "data": { "messages": messages } }))
            }
            Ok(Err(e)) => err(&e),
            Err(e) => err(&format!("branch read failed: {e}")),
        };
    }
    let Some(entry_id) = params
        .get("entryId")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return err("entryId required");
    };
    match tokio::task::spawn_blocking(move || {
        crate::sessions::branch::fork_before(&path, &entry_id)
    })
    .await
    {
        Ok(Ok(fork)) => {
            crate::sessions::index::trigger_refresh(state);
            tracing::info!(branch = %fork.path.display(), "session branched from file");
            ok(json!({
                "ok": true,
                "data": {
                    "text": fork.text,
                    "cancelled": false,
                    "sessionPath": fork.path.to_string_lossy(),
                },
            }))
        }
        Ok(Err(e)) => err(&e),
        Err(e) => err(&format!("branch failed: {e}")),
    }
}

/// omp's `/fork`: a new session holding the WHOLE conversation, which the
/// phone then opens (the TUI continues in the copy). Unlike `branch` nothing
/// is rewound. A session this daemon's own child writes runs omp's RPC `fork`
/// (no `entryId`), so entries still in that child's memory are included and
/// the child carries on in the copy. Any other session — the desktop's, a
/// bridge's, or one nobody has open — is copied from its file
/// (`branch::fork_whole`), which never writes the source. Answers
/// `{cancelled, sessionPath}`, `sessionPath` being the new file.
async fn fork_rpc(state: &Arc<AppState>, path: PathBuf, session: &str) -> Response {
    if state.children.has_child(session)
        && matches!(write_path(state, session).await, WritePath::Child)
    {
        return match state.children.fork_session(session).await {
            Ok(Some(forked)) => {
                crate::sessions::index::trigger_refresh(state);
                tracing::info!(fork = %forked, "session forked by its child");
                ok(json!({
                    "ok": true,
                    "data": { "cancelled": false, "sessionPath": forked },
                }))
            }
            Ok(None) => ok(json!({ "ok": true, "data": { "cancelled": true } })),
            Err(e) => child_error(&e),
        };
    }
    match tokio::task::spawn_blocking(move || crate::sessions::branch::fork_whole(&path)).await {
        Ok(Ok(forked)) => {
            crate::sessions::index::trigger_refresh(state);
            tracing::info!(fork = %forked.display(), "session forked from file");
            ok(json!({
                "ok": true,
                "data": { "cancelled": false, "sessionPath": forked.to_string_lossy() },
            }))
        }
        Ok(Err(e)) => err(&e),
        Err(e) => err(&format!("fork failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_move_preserves_summary_instructions_and_rejects_invalid_requests() {
        let requested = json!({
            "entryId":"ask-result", "summarize":true,
            "customInstructions":"Keep the benchmark findings; omit abandoned edits."
        });
        assert_eq!(tree_move_payload(&requested).unwrap(), requested);
        for invalid in [
            json!({ "entryId":"ask-result", "summarize":"false" }),
            json!({ "entryId":"ask-result", "summarize":null }),
            json!({ "entryId":"ask-result", "customInstructions":42 }),
            json!({ "entryId":"ask-result", "customInstructions":null }),
            json!({ "entryId":"   ", "summarize":true }),
            json!({ "summarize":true }),
        ] {
            assert!(tree_move_payload(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn allowlist_gains_every_new_phone_command() {
        // Every command this wave adds must be allowlisted verbatim; a typo
        // against rpc-types.ts would fail here as a missing string.
        for cmd in [
            "get_messages_page",
            "get_branch_messages",
            "get_last_assistant_text",
            "get_messages",
            "set_subagent_subscription",
            "abort_bash",
            "set_session_name",
            "branch",
            "fork",
            "compact",
            "set_todos",
            "set_auto_compaction",
            "set_auto_retry",
            "set_steering_mode",
            "set_follow_up_mode",
            "set_interrupt_mode",
            "goal",
            "get_available_thinking_levels",
            "set_slow_mode",
            "set_cache_warming",
        ] {
            assert!(
                ALLOWED_RPC_COMMANDS.contains(&cmd),
                "{cmd} must be allowlisted"
            );
        }
    }

    #[test]
    fn fork_is_ownership_gated_while_rewind_stays_file_served() {
        // `/fork` may move the daemon's own writer into the copy, so the
        // ambiguous-owner refusal must cover it; rewind only ever reads.
        assert!(MUTATING_RPC_COMMANDS.contains(&"fork"));
        assert!(!MUTATING_RPC_COMMANDS.contains(&"branch"));
    }

    #[test]
    fn host_tool_cancel_is_not_allowlisted() {
        // `host_tool_cancel` is an OUTPUT frame (RpcHostToolCancelRequest in
        // rpc-types.ts, emitted BY the RPC server to the host) — there is no
        // client→server command of that name to allowlist.
        assert!(!ALLOWED_RPC_COMMANDS.contains(&"host_tool_cancel"));
    }

    #[test]
    fn mode_toggles_are_gated_and_path_choosing_commands_are_not_generic() {
        // Slow mode and cache warming change the writer's session, so a
        // desktop-owned session must get the typed refusal, never a child.
        for cmd in ["set_slow_mode", "set_cache_warming"] {
            assert!(ALLOWED_RPC_COMMANDS.contains(&cmd), "{cmd} allowlisted");
            assert!(MUTATING_RPC_COMMANDS.contains(&cmd), "{cmd} gated");
        }
        // export_html takes an output path: through the generic route a
        // phone could write any file on the omp host. /api/export owns it.
        assert!(!ALLOWED_RPC_COMMANDS.contains(&"export_html"));
        // Branch/fork return a destination for normal managed navigation.
        // A raw switch bypasses target admission and leaves the source key
        // bound to a child now writing another file.
        assert!(!ALLOWED_RPC_COMMANDS.contains(&"switch_session"));
        assert!(!MUTATING_RPC_COMMANDS.contains(&"switch_session"));
        assert!(!ALLOWED_RPC_COMMANDS.contains(&"cycle_model"));
    }

    #[test]
    fn every_mutating_command_is_also_allowlisted() {
        // The ownership gate can only protect commands the router reaches; a
        // mutating command that is not allowlisted is dead weight (or worse,
        // a shadow path that bypasses the gate).
        for cmd in MUTATING_RPC_COMMANDS {
            assert!(
                ALLOWED_RPC_COMMANDS.contains(cmd),
                "{cmd} is mutating but not allowlisted"
            );
        }
    }

    #[tokio::test]
    async fn subagent_control_refuses_desktop_owners_but_not_child_owners() {
        for command in ["steer_subagent", "cancel_subagent"] {
            for path in [
                WritePath::Host,
                WritePath::Bridge(42),
                WritePath::Refused("desktop owner unavailable".to_owned()),
            ] {
                let response = rpc_ownership_refusal(command, path).unwrap();
                let bytes = axum::body::to_bytes(response.into_body(), 4096)
                    .await
                    .unwrap();
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["ok"], false, "{command} must not dispatch to desktop");
                assert_eq!(body["code"], "session_owned_by_terminal");
            }
            assert!(rpc_ownership_refusal(command, WritePath::Child).is_none());
        }
        assert!(rpc_ownership_refusal("get_subagents", WritePath::Host).is_none());
    }

    #[tokio::test]
    async fn abort_retry_is_allowed_and_behind_the_ownership_gate() {
        // The phone's retry Cancel must reach a daemon child, and must never
        // become a second control path into a desktop-owned session.
        assert!(ALLOWED_RPC_COMMANDS.contains(&"abort_retry"));
        assert!(MUTATING_RPC_COMMANDS.contains(&"abort_retry"));
        for path in [
            WritePath::Host,
            WritePath::Bridge(42),
            WritePath::Refused("desktop owner unavailable".to_owned()),
        ] {
            let response = rpc_ownership_refusal("abort_retry", path).unwrap();
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["ok"], false);
            assert_eq!(body["code"], "session_owned_by_terminal");
        }
        assert!(rpc_ownership_refusal("abort_retry", WritePath::Child).is_none());
    }

    /// A side question writes omp's BTW history, so a desktop-owned session
    /// refuses it in words about side questions (not "change this setting"),
    /// the phone's own child runs it, and reading the history is never gated.
    #[tokio::test]
    async fn side_questions_refuse_desktop_owners_with_their_own_words() {
        for command in ["btw", "btw_cancel"] {
            assert!(ALLOWED_RPC_COMMANDS.contains(&command));
            for path in [WritePath::Host, WritePath::Bridge(42)] {
                let response = rpc_ownership_refusal(command, path).unwrap();
                let bytes = axum::body::to_bytes(response.into_body(), 4096)
                    .await
                    .unwrap();
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["code"], "session_owned_by_terminal");
                assert!(body["error"].as_str().unwrap().contains("side questions"));
            }
            assert!(rpc_ownership_refusal(command, WritePath::Child).is_none());
        }
        assert!(ALLOWED_RPC_COMMANDS.contains(&"get_btw_history"));
        assert!(rpc_ownership_refusal("get_btw_history", WritePath::Host).is_none());
    }
}
