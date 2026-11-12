//! Sending RPC requests to a child: request ids, framing, timeouts, and waiting
//! for the correlated response.

use super::*;

use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

/// Preserve failed-prompt correlation, with failure ownership decided by the
/// private access mode. A rejected duplicate never owns this reservation.
fn record_rpc_failure(child: &Child, id: &str, token: u64, access: RpcAccess<'_>) {
    let mut gate = lock_poisoned(&child.gate);
    if gate.pending.get(id).is_some_and(|rpc| rpc.token == token) {
        gate.fail_rpc(id, token, access);
        if let Some(command_id) = id.strip_prefix("pulse-prompt:") {
            lock_poisoned(&child.active_prompt).clear_if(command_id);
        }
    }
    child.busy_may_have_changed();
}

/// Keep dispatch and response correlation authoritative over command parameters.
fn rpc_frame(id: &str, command: &str, params: Value) -> Value {
    let mut frame = match params {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    // INVARIANT: params cannot replace the command selected by routing or the
    // id reserved in the child gate, including caller-chosen bash/prompt IDs.
    frame.insert("id".to_string(), Value::String(id.to_string()));
    frame.insert("type".to_string(), Value::String(command.to_string()));
    // omp's streaming flag may advance before our agent_start arrives. An
    // idle omp ignores this; every prompt must include it before that race.
    // A mode the caller chose (`PromptDelivery::child_rpc`: steer is the
    // phone's mid-turn default) wins; forcing followUp turned Steer into Queue.
    if command == "prompt" {
        frame
            .entry("streamingBehavior".to_string())
            .or_insert_with(|| json!("followUp"));
    }
    Value::Object(frame)
}

/// How long a routed `/api/rpc` command may take before the daemon stops
/// waiting. Most are settings writes; `compact` answers only when the
/// summarization turn is done.
pub(super) fn rpc_timeout(command: &str) -> Duration {
    match command {
        "compact" => COMPACT_TIMEOUT,
        _ => RPC_TIMEOUT,
    }
}

impl ChildManager {
    pub(super) fn next_rpc_id(&self) -> String {
        format!("r{}", self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    /// Only never-registered boot or ephemeral work uses this unbound path.
    pub(super) async fn rpc_on(
        &self,
        child: &Arc<Child>,
        command: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        Self::rpc_with_id(
            child,
            &self.next_rpc_id(),
            command,
            params,
            timeout,
            RpcAccess::Boot,
        )
        .await
    }

    pub(super) async fn rpc_on_bound(
        &self,
        child: &Arc<Child>,
        session_path: &str,
        command: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let access = RpcAccess::Bound(session_path, child.binding_epoch.load(Ordering::SeqCst));
        Self::rpc_with_id(child, &self.next_rpc_id(), command, params, timeout, access).await
    }

    /// Own a registered request before awaiting stdin. Dropping its caller is
    /// not remote completion, even if no bytes completed locally. Unregistered
    /// boot retains its earlier failure policy; neither path replays a request.
    pub(super) async fn rpc_with_id(
        child: &Arc<Child>,
        id: &str,
        command: &str,
        params: Value,
        timeout: Duration,
        access: RpcAccess<'_>,
    ) -> Result<Value, String> {
        let frame = rpc_frame(id, command, params);
        let (tx, rx) = oneshot::channel();
        let (token, line) = {
            let mut gate = lock_poisoned(&child.gate);
            if !child.alive.load(Ordering::SeqCst) {
                return Err("agent process not running".to_string());
            }
            if let RpcAccess::Bound(path, epoch) = access
                && (child.binding_epoch.load(Ordering::SeqCst) != epoch
                    || lock_poisoned(&child.session).as_str() != path)
            {
                return Err("agent process session binding changed".to_string());
            }
            let prompt_id = (command == "prompt")
                .then(|| id.strip_prefix("pulse-prompt:"))
                .flatten();
            // Serialization failure must not create phantom remote ownership.
            let mut line =
                serde_json::to_string(&frame).map_err(|e| format!("serialize rpc frame: {e}"))?;
            line.push('\n');
            let token = gate.admit_rpc(
                id,
                command,
                child.binding_epoch.load(Ordering::SeqCst),
                tx,
                access,
            )?;
            if let Some(command_id) = prompt_id
                && !child.streaming.load(Ordering::SeqCst)
            {
                lock_poisoned(&child.active_prompt).reserve(command_id, now_ms());
            }
            touch_locked(child);
            child.busy_may_have_changed();
            (token, line)
        };
        // Boot cancellation deliberately keeps its old pending entry and
        // lifecycle behavior. Ephemeral cancellation cleanup is a separate
        // policy from this registered-child fence.
        let _waiter = (!matches!(access, RpcAccess::Boot)).then(|| RpcWaiter {
            child: Arc::clone(child),
            id: id.to_string(),
            token,
        });
        let write_result = {
            let mut stdin = child.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await
        };
        if let Err(e) = write_result {
            record_rpc_failure(child, id, token, access);
            return Err(format!("stdin write failed: {e}"));
        }
        touch(child);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => Err("rpc channel closed (agent process terminated)".to_string()),
            Err(_) => {
                record_rpc_failure(child, id, token, access);
                Err(format!(
                    "rpc {command} timed out after {}ms",
                    timeout.as_millis()
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn switch_fixture_manager() -> ChildManager {
        // Construct without startup maintenance/materialisation: these tests
        // need only admission and routing, and must never launch real omp.
        let root = std::env::temp_dir().join(format!("pulse-raw-switch-{}", std::process::id()));
        let config = crate::types::Config {
            host: "127.0.0.1".into(),
            port: 0,
            sessions_root: root.join("sessions"),
            omp_bin: root.join("no-transport-executable"),
            public_dir: None,
            token_hash: None,
            max_children: 2,
            push_store_path: root.join("push.json"),
            vapid_path: root.join("vapid.json"),
            state_dir: root.join("state"),
            home: root.clone(),
            watch_interval_ms: 250,
            ws_queue_cap: 4,
            ws_queue_bytes: 1 << 20,
            child_idle_secs: 900,
            child_unwatched_secs: 300,
            child_rss_mb: 0,
            child_lean_js: false,
            prewarm_on_attach: false,
            owner_cache_ms: 3000,
            ws_deflate_min: 4096,
            paths: Arc::new(crate::paths::Paths::default()),
            asr_python: None,
            asr_model_dir: None,
            asr_threads: 1,
        };
        ChildManager {
            config: Arc::new(config),
            tx: tokio::sync::broadcast::channel(8).0,
            children: Arc::new(Mutex::new(HashMap::new())),
            opening: Arc::new(Mutex::new(HashMap::new())),
            occupied: Arc::new(AtomicUsize::new(0)),
            physical: Arc::new(registered::Registry::new()),
            admission: Mutex::new(()),
            retarget_lock: AsyncMutex::new(()),
            next_id: AtomicU64::new(0),
            next_source_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            viewers: std::sync::OnceLock::new(),
            work_children: Arc::new(Mutex::new(Vec::new())),
            extra_work: Arc::new(AtomicUsize::new(0)),
            busy_wake: Arc::new(Notify::new()),
            busy_rx: tokio::sync::watch::channel(BusyState::default()).1,
            child_added: Notify::new(),
        }
    }

    #[tokio::test]
    async fn raw_switch_is_refused_before_open_for_every_destination_shape() {
        let manager = switch_fixture_manager();
        for params in [
            Value::Null,
            json!({}),
            json!({"sessionPath": null}),
            json!({"sessionPath": ""}),
            json!({"sessionPath": "/outside/session.jsonl"}),
            json!({"sessionPath": manager.config.sessions_root.join("missing.jsonl")}),
        ] {
            assert_eq!(
                manager
                    .rpc("/synthetic/source.jsonl", "switch_session", params)
                    .await
                    .unwrap_err(),
                "command not allowed"
            );
            assert_eq!(manager.live_count(), 0);
            assert_eq!(manager.occupied.load(Ordering::SeqCst), 0);
            assert!(lock_poisoned(&manager.opening).is_empty());
            assert_eq!(manager.next_id.load(Ordering::SeqCst), 0);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn raw_switch_cannot_steal_another_child_or_change_source_binding() {
        let manager = switch_fixture_manager();
        let source = super::super::tests::stand_in_child();
        let target = super::super::tests::stand_in_child();
        let source_path = lock_poisoned(&source.session).clone();
        let target_path = "/synthetic/other.jsonl";
        *lock_poisoned(&target.session) = target_path.to_string();
        {
            let mut map = lock_poisoned(&manager.children);
            map.insert(source_path.clone(), Arc::clone(&source));
            map.insert(target_path.to_string(), Arc::clone(&target));
        }
        assert_eq!(
            manager
                .rpc(
                    &source_path,
                    "switch_session",
                    json!({"sessionPath": target_path})
                )
                .await
                .unwrap_err(),
            "command not allowed"
        );
        // Exercise the lower-level dispatch gate too: routing cannot bypass
        // the restriction with a previously acquired source child.
        assert_eq!(
            manager
                .rpc_on_bound(
                    &source,
                    &source_path,
                    "switch_session",
                    json!({"sessionPath": target_path}),
                    Duration::from_millis(1),
                )
                .await
                .unwrap_err(),
            "command not allowed"
        );
        assert!(Arc::ptr_eq(&manager.child(&source_path).unwrap(), &source));
        assert!(Arc::ptr_eq(&manager.child(target_path).unwrap(), &target));
        assert_eq!(*lock_poisoned(&source.session), source_path);
        assert_eq!(lock_poisoned(&target.session).as_str(), target_path);
        assert_eq!(source.binding_epoch.load(Ordering::SeqCst), 1);
        assert_eq!(target.binding_epoch.load(Ordering::SeqCst), 1);
        assert!(lock_poisoned(&source.gate).quiescent());
        assert!(lock_poisoned(&target.gate).quiescent());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_cancels_interactive_tree_input_while_control_prompt_is_still_pending() {
        let manager = switch_fixture_manager();
        let child = super::super::tests::stand_in_child();
        let session = lock_poisoned(&child.session).clone();
        lock_poisoned(&manager.children).insert(session.clone(), Arc::clone(&child));
        let (control_tx, _control_rx) = oneshot::channel();
        lock_poisoned(&child.gate)
            .admit_rpc(
                "tree-control",
                "prompt",
                1,
                control_tx,
                RpcAccess::Bound(&session, 1),
            )
            .unwrap();
        lock_poisoned(&child.pending_ui).insert(
            "historical-question".into(),
            json!({
                "type":"extension_ui_request", "id":"historical-question", "method":"ask",
            }),
        );
        let mut events = manager.tx.subscribe();
        let stopping = manager.abort(&session, false);
        tokio::pin!(stopping);
        let event = tokio::select! {
            event = events.recv() => event.unwrap(),
            result = &mut stopping => panic!("Stop finished before dispatch: {result:?}"),
        };
        match event {
            ChildEvent::Event { event, .. } => {
                assert_eq!(event["type"], "extension_ui_response_ack");
                assert_eq!(event["id"], "historical-question");
                assert_eq!(event["phase"], "handoff");
            }
            other => panic!("expected cancellation handoff: {other:?}"),
        }
        // Stop is admitted immediately, but only native settlement closes the
        // question: a successful pipe write is not proof that it was cancelled.
        assert!(lock_poisoned(&child.pending_ui).contains_key("historical-question"));
        let pending_abort = {
            let mut gate = lock_poisoned(&child.gate);
            assert!(gate.pending.contains_key("tree-control"));
            let id = gate
                .pending
                .iter()
                .find(|(_, rpc)| rpc.command == "abort")
                .map(|(id, _)| id.clone())
                .expect("Stop must be admitted during the dialog");
            gate.complete_rpc(&id).unwrap()
        };
        pending_abort.tx.send(Ok(json!({}))).unwrap();
        assert_eq!(stopping.await.unwrap(), Some(json!({})));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopped_tree_prompt_cancelled_before_handler_returns_without_waiting_for_a_dialog() {
        let manager = switch_fixture_manager();
        let child = super::super::tests::stand_in_child();
        child.extension_ready.store(true, Ordering::SeqCst);
        let session = lock_poisoned(&child.session).clone();
        let control = manager.extension_call(
            &child,
            &session,
            "pulse-goto",
            json!({"entryId":"historical-answer","summarize":true}),
            TREE_MOVE_TIMEOUT,
        );
        tokio::pin!(control);
        tokio::select! {
            biased;
            result = &mut control => panic!("control completed before a native response: {result:?}"),
            _ = tokio::task::yield_now() => {},
        }
        lock_poisoned(&child.tree_cancel).stop_requested = true;
        let rpc = {
            let mut gate = lock_poisoned(&child.gate);
            let id = gate.pending.keys().next().unwrap().clone();
            gate.complete_rpc(&id).unwrap()
        };
        // This is OMP's actual cancelled-before-admission response: no data,
        // unlike a completed extension handler's {agentInvoked:false}.
        rpc.tx.send(Ok(Value::Null)).unwrap();
        assert_eq!(control.await.unwrap(), json!({"cancelled":true}));
        assert!(lock_poisoned(&child.extension_replies).is_empty());
    }

    #[test]
    fn prompt_frame_defaults_to_follow_up_but_keeps_the_callers_mode() {
        // A prompt with no mode still carries one before stream observation;
        // a caller's steer (the phone's default mid-turn) must survive.
        assert_eq!(
            rpc_frame("p1", "prompt", Value::Null)["streamingBehavior"],
            "followUp"
        );
        assert_eq!(
            rpc_frame("p2", "prompt", json!({"streamingBehavior": "steer"}))["streamingBehavior"],
            "steer"
        );
        assert!(
            rpc_frame("r1", "get_state", Value::Null)
                .get("streamingBehavior")
                .is_none()
        );
    }

    #[test]
    fn rpc_frame_preserves_get_messages_command_and_correlation() {
        let frame = rpc_frame(
            "r42",
            "get_messages",
            json!({"type": "switch_session", "id": "other-request", "sessionPath": "/fixture/session.jsonl"}),
        );
        // Round-trip the same frame that rpc_with_id serializes to stdin.
        let wire: Value = serde_json::from_str(&serde_json::to_string(&frame).unwrap()).unwrap();
        assert_eq!(
            wire,
            json!({
                "type": "get_messages", "id": "r42", "sessionPath": "/fixture/session.jsonl"
            })
        );
    }

    #[test]
    fn rpc_frame_reserves_envelope_fields_for_every_parameter_value_type() {
        for reserved in [
            Value::Null,
            json!(false),
            json!(7),
            json!([]),
            json!({}),
            json!("override"),
        ] {
            let frame = rpc_frame(
                "bash-42",
                "bash",
                json!({"id": reserved, "type": reserved, "command": "echo fixture"}),
            );
            assert_eq!(frame["id"], "bash-42");
            assert_eq!(frame["type"], "bash");
            assert_eq!(frame["command"], "echo fixture");
        }
    }

    #[test]
    fn rpc_frame_preserves_all_ordinary_and_nested_parameters() {
        let params = json!({
            "unknownFutureField": {"id": "nested-id", "type": "nested-type"},
            "command": "ordinary-command-param", "message": "hello", "enabled": false,
            "limit": 0, "nullable": null, "images": [{"type": "image", "data": "fixture"}]
        });
        let mut expected = params.clone();
        expected["id"] = json!("r7");
        expected["type"] = json!("prompt");
        expected["streamingBehavior"] = json!("followUp");
        assert_eq!(rpc_frame("r7", "prompt", params), expected);
    }

    #[test]
    fn rpc_frame_ignores_non_object_parameters_as_before() {
        for params in [
            Value::Null,
            json!(false),
            json!(7),
            json!([]),
            json!("text"),
            json!({}),
        ] {
            assert_eq!(
                rpc_frame("r8", "get_state", params),
                json!({"id": "r8", "type": "get_state"})
            );
        }
    }

    #[test]
    fn compact_waits_for_the_summarization_turn_other_rpcs_do_not() {
        assert_eq!(rpc_timeout("compact"), Duration::from_secs(300));
        assert_eq!(rpc_timeout("compact"), COMPACT_TIMEOUT);
        for command in ["get_state", "set_model", "set_session_name", "abort_bash"] {
            assert_eq!(rpc_timeout(command), RPC_TIMEOUT, "{command}");
        }
    }
}
