use super::*;
#[cfg(unix)]
use std::process::Stdio;

// These lifecycle regressions use only in-memory records and oneshot
// channels. No process, runtime, socket, session file or signal is created.

/// Initial command output belongs to the exact child/session binding. The
/// monitor normalizes terminal escapes before broadcasting these events.
#[test]
fn command_output_is_gathered_from_exact_binding() {
    let (tx, mut rx) = broadcast::channel(8);
    let stamp = |pid: i32| crate::authority::session_state::SourceStamp {
        identity: crate::authority::session_state::SourceIdentity {
            kind: crate::authority::session_state::SourceKind::Child,
            source_id: 1,
            binding_epoch: 1,
            pid: Some(pid),
            process_start: None,
            peer_id: None,
            room_id: None,
            can_write: None,
        },
        sequence: 1,
    };
    let frame = |pid: i32, text: &str| ChildEvent::Event {
        session: "/s.jsonl".to_owned(),
        event: json!({"type": "command_output", "text": text}),
        source: Some(stamp(pid)),
    };
    tx.send(frame(7, "Context window: 200000 tokens (7% used)"))
        .unwrap();
    tx.send(frame(8, "another child's output")).unwrap();
    let mut retired = frame(7, "same pid, retired binding");
    if let ChildEvent::Event {
        source: Some(source),
        ..
    } = &mut retired
    {
        source.identity.binding_epoch = 0;
    }
    tx.send(retired).unwrap();
    tx.send(frame(7, "  Free [███░] 78%")).unwrap();
    let run = command_run(&mut rx, &stamp(7).identity, &json!({"agentInvoked": false}));
    assert_eq!(
        run.output,
        "Context window: 200000 tokens (7% used)\n  Free [███░] 78%"
    );
    assert!(!run.agent_invoked);
}

#[test]
fn delivery_defaults_to_steer_and_refuses_unknown_words() {
    assert_eq!(PromptDelivery::from_wire(None), Ok(PromptDelivery::Steer));
    assert_eq!(
        PromptDelivery::from_wire(Some("steer")),
        Ok(PromptDelivery::Steer)
    );
    assert_eq!(
        PromptDelivery::from_wire(Some("queue")),
        Ok(PromptDelivery::Queue)
    );
    assert_eq!(
        PromptDelivery::from_wire(Some("interrupt")),
        Ok(PromptDelivery::Interrupt)
    );
    for bad in ["", "followUp", "Steer", "abort"] {
        assert!(PromptDelivery::from_wire(Some(bad)).is_err(), "{bad:?}");
    }
}

#[test]
fn delivery_maps_to_child_rpc_and_aborts_only_a_known_turn() {
    use PromptDelivery::*;
    assert_eq!(Steer.child_rpc(true), ("prompt", Some("steer")));
    assert_eq!(Queue.child_rpc(true), ("prompt", Some("followUp")));
    assert_eq!(Interrupt.child_rpc(true), ("abort_and_prompt", None));
    // Our idle flag can lag omp's, so the mode still travels (an idle omp
    // ignores it), but nothing is aborted on a turn we have not seen.
    assert_eq!(Steer.child_rpc(false), ("prompt", Some("steer")));
    assert_eq!(Queue.child_rpc(false), ("prompt", Some("followUp")));
    assert_eq!(Interrupt.child_rpc(false), ("prompt", Some("steer")));
}

#[test]
fn bridge_delivery_never_aborts_and_keeps_the_message() {
    assert_eq!(PromptDelivery::Steer.bridge_deliver_as(), "steer");
    assert_eq!(PromptDelivery::Queue.bridge_deliver_as(), "followUp");
    assert_eq!(PromptDelivery::Interrupt.bridge_deliver_as(), "followUp");
}

/// The user-bash "no deadline" relies on tokio clamping an overflowing
/// deadline instead of panicking on `Instant + Duration::MAX`.
#[tokio::test]
async fn user_bash_has_no_deadline_and_the_wait_does_not_overflow() {
    assert_eq!(USER_BASH_TIMEOUT, Duration::MAX);
    let (tx, rx) = oneshot::channel::<u8>();
    tx.send(7).unwrap();
    let got = tokio::time::timeout(USER_BASH_TIMEOUT, rx).await;
    assert_eq!(got.unwrap().unwrap(), 7);
}

/// A registered-looking child backed by `cat`, so dispatch and busy logic
/// run against real fields without an omp process. Needs a tokio runtime.
#[cfg(unix)]
pub(super) fn stand_in_child() -> Arc<Child> {
    let mut proc = tokio::process::Command::new("cat")
        // Configuration tests temporarily clear the process-wide PATH.
        .env("PATH", env!("PATH"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn cat as a stand-in child");
    let stdin = proc.stdin.take().expect("piped stdin");
    let pid = proc.id().map(|p| p as i32).unwrap_or(0);
    Arc::new(Child {
        session: Mutex::new("/synthetic/turn.jsonl".to_string()),
        pid,
        source_id: 1,
        binding_epoch: AtomicU64::new(1),
        source_sequence: AtomicU64::new(0),
        process_start: 0,
        cwd: "/synthetic".to_string(),
        proc: Mutex::new(Some(proc)),
        physical: None,
        stdin: AsyncMutex::new(stdin),
        alive: AtomicBool::new(true),
        unrouted_work: AtomicBool::new(false),
        streaming: AtomicBool::new(false),
        compacting: AtomicBool::new(false),
        background_since: AtomicU64::new(0),
        btw_since: AtomicU64::new(0),
        active_prompt: Mutex::new(PromptLifecycle::Idle),
        last_active: AtomicU64::new(1),
        spawned_at: AtomicU64::new(1),
        last_viewed: AtomicU64::new(1),
        session_name: Mutex::new(String::new()),
        model: Mutex::new(String::new()),
        configured_thinking: Mutex::new(None),
        model_fallback: Mutex::new(None),
        retained_agents: Mutex::new(agents::RetainedAgents::new(1)),
        message_count: Mutex::new(0),
        context_percent: Mutex::new(None),
        gate: Mutex::new(ChildGate::default()),
        pending_ui: Mutex::new(HashMap::new()),
        dialog_scope: Mutex::new(None),
        tree_cancel: Mutex::new(TreeCancellation::default()),
        feedback: Mutex::new(crate::omp::ui_feedback::Feedback::default()),
        extension_replies: Mutex::new(HashMap::new()),
        extension_ready: AtomicBool::new(false),
        chunks: Mutex::new(HashMap::new()),
        busy_wake: Arc::new(Notify::new()),
    })
}

#[test]
fn busy_refusal_is_coded_and_reads_as_a_sentence() {
    assert_eq!(
        agents_busy_sentence(6),
        "6 agents are working. Send again when one finishes, or stop one."
    );
    assert_eq!(
        agents_busy_sentence(1),
        "1 agent is working. Send again when it finishes, or stop it."
    );
    let error = format!("{AGENTS_BUSY}: {}", agents_busy_sentence(3));
    assert_eq!(
        agents_busy_message(&error),
        Some("3 agents are working. Send again when one finishes, or stop one.")
    );
    assert_eq!(agents_busy_message("agent process not running"), None);
    assert_eq!(agents_busy_message("agents_busy_other: x"), None);
    assert!(agents_busy_waiting_sentence(3).starts_with("Waiting for a free agent."));
}

#[test]
fn background_work_counts_until_settled_or_stale() {
    assert!(!background_pending(0, 5_000));
    assert!(background_pending(1_000, 1_000));
    assert!(background_pending(
        1_000,
        1_000 + BACKGROUND_WORK_MAX_MS - 1
    ));
    assert!(!background_pending(1_000, 1_000 + BACKGROUND_WORK_MAX_MS));
    // Clock skew never reads as stale.
    assert!(background_pending(9_000, 1_000));
}
