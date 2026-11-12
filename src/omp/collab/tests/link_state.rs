//! Link-state machine.

use super::*;
use std::time::Duration;

#[tokio::test]
async fn agent_snapshots_preserve_populated_welcome_roster_then_empty_replacement() {
    for delta_capable in [false, true] {
        let cfg = Arc::new(test_config());
        let hub = WsHub::new(cfg);
        let delta = DeltaEncoder::new();
        let session = "/synthetic/agent-snapshot-delivery.jsonl";
        let (_id, mut rx) = hub.attach(
            session.to_owned(),
            ClientCaps {
                delta: delta_capable,
                ..ClientCaps::default()
            },
        );
        forward_welcome_meta(
            &delta,
            &hub,
            session,
            &json!({
                "state": {"model": "first"},
                "agents": [{"id": "a", "status": "running"}]
            }),
        );
        forward_welcome_meta(
            &delta,
            &hub,
            session,
            &json!({"state": {"model": "latest"}}),
        );
        let state: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .expect("state frame is queued")
                .expect("state frame"),
        )
        .unwrap();
        let agents: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .expect("agent frame is queued")
                .expect("agent frame"),
        )
        .unwrap();
        assert_eq!(
            state["event"],
            json!({"type": "collab_state", "state": {"model": "latest"}})
        );
        assert_eq!(
            agents["event"],
            json!({"type": "collab_agents", "agents": [{"id": "a", "status": "running"}]})
        );
        // Assert the populated welcome first: a later empty push must not
        // mask a missing or wrongly conflated welcome roster.
        broadcast_agents(&delta, &hub, session, &json!([]));
        let empty: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .expect("empty roster is queued")
                .expect("empty roster"),
        )
        .unwrap();
        assert_eq!(
            empty["event"],
            json!({"type": "collab_agents", "agents": []})
        );
    }
}

#[tokio::test]
async fn agent_snapshot_live_forwarding_preserves_host_and_source_guards() {
    use futures_util::FutureExt;

    let dir = std::env::temp_dir().join(format!(
        "omp-pulse-agent-forwarding-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let mut cfg = test_config();
    cfg.state_dir = dir.clone();
    cfg.home = dir.clone();
    cfg.sessions_root = dir.clone();
    cfg.vapid_path = dir.join("vapid.json");
    cfg.push_store_path = dir.join("push.json");
    let cfg = Arc::new(cfg);
    let push = test_push(&cfg);
    let hub = WsHub::new(cfg);
    let delta = DeltaEncoder::new();
    let session = dir.join("session.jsonl").to_string_lossy().into_owned();
    let registry = Arc::new(SessionStateRegistry::default());
    let mut source = CollabEventSource::begin(&session, "room", 1, false, Some(registry.clone()));
    let (_id, mut rx) = hub.attach(session.clone(), ClientCaps::default());
    let mut assistant_synced = false;
    for (peer, frame) in [
        (
            HOST_PEER_ID,
            json!({"t": "agents", "agents": [{"id": "a", "status": "running"}]}),
        ),
        (2, json!({"t": "agents", "agents": [{"id": "guest"}]})),
        (HOST_PEER_ID, json!({"t": "agents"})),
    ] {
        assert!(
            forward_collab_frame(
                &mut source,
                peer,
                &delta,
                &hub,
                &push,
                &session,
                &frame,
                &mut assistant_synced
            )
            .is_none()
        );
    }
    let agents: Value = serde_json::from_str(
        &rx.recv()
            .now_or_never()
            .expect("host roster is queued")
            .expect("host roster"),
    )
    .unwrap();
    assert_eq!(
        agents["event"]["agents"],
        json!([{"id": "a", "status": "running"}])
    );
    assert!(
        rx.recv().now_or_never().is_none(),
        "guest/missing payloads emit nothing"
    );

    forward_collab_frame(
        &mut source,
        HOST_PEER_ID,
        &delta,
        &hub,
        &push,
        &session,
        &json!({"t": "agents", "agents": []}),
        &mut assistant_synced,
    );
    let empty: Value = serde_json::from_str(
        &rx.recv()
            .now_or_never()
            .expect("empty roster is queued")
            .expect("empty roster"),
    )
    .unwrap();
    assert_eq!(empty["event"]["agents"], json!([]));

    registry.retire_source(&session, &source.identity);
    forward_collab_frame(
        &mut source,
        HOST_PEER_ID,
        &delta,
        &hub,
        &push,
        &session,
        &json!({"t": "agents", "agents": [{"id": "retired"}]}),
        &mut assistant_synced,
    );
    assert!(
        rx.recv().now_or_never().is_none(),
        "retired source cannot publish"
    );
    drop(source);
    drop(push);
    std::fs::remove_dir_all(dir).expect("remove isolated push fixture");
}

#[tokio::test]
async fn agent_snapshot_interleaving_preserves_message_deltas_and_resync_full_fallback() {
    use futures_util::FutureExt;

    let mut cfg = test_config();
    cfg.ws_queue_cap = 2;
    let hub = WsHub::new(Arc::new(cfg));
    let delta = DeltaEncoder::new();
    let session = "/synthetic/agent-snapshot-delta-resync.jsonl";
    let (_id, mut rx) = hub.attach(
        session.to_owned(),
        ClientCaps {
            delta: true,
            ..ClientCaps::default()
        },
    );
    let message = |text| {
        json!({"type": "message_update", "message": {
            "id": "m1", "role": "assistant", "content": text
        }})
    };
    let pop = |rx: &mut crate::server::ws::ClientRx| -> Value {
        serde_json::from_str(
            &rx.recv()
                .now_or_never()
                .expect("frame is queued")
                .expect("frame"),
        )
        .unwrap()
    };
    broadcast_event(&delta, &hub, session, &message("hello"));
    assert_eq!(pop(&mut rx)["type"], "event");
    broadcast_agents(&delta, &hub, session, &json!([]));
    broadcast_event(
        &delta,
        &hub,
        session,
        &json!({"type": "collab_state", "state": {}}),
    );
    assert_eq!(pop(&mut rx)["event"]["type"], "collab_agents");
    assert_eq!(pop(&mut rx)["event"]["type"], "collab_state");
    broadcast_event(&delta, &hub, session, &message("hello there"));
    let next = pop(&mut rx);
    assert_eq!(
        next["type"], "md",
        "snapshot keys must not replace the message delta base"
    );
    assert_eq!(next["a"], " there");

    broadcast_agents(&delta, &hub, session, &json!([{"id": "a"}]));
    for text in ["one", "two"] {
        broadcast_event(
            &delta,
            &hub,
            session,
            &json!({"type": "notice", "message": text}),
        );
    }
    assert_eq!(
        pop(&mut rx)["type"],
        "resync",
        "roster loss must be signaled"
    );
    broadcast_event(&delta, &hub, session, &message("hello there again"));
    let recovered = pop(&mut rx);
    assert_eq!(
        recovered["type"], "event",
        "resync invalidates the old delta base"
    );
    assert_eq!(
        recovered["event"]["message"]["content"],
        "hello there again"
    );
}

#[tokio::test]
async fn agent_snapshots_event_encoder_does_not_replace_collab_state() {
    let cfg = Arc::new(test_config());
    let hub = WsHub::new(cfg);
    let delta = DeltaEncoder::new();
    let session = "/synthetic/agent-snapshot-event-encoder.jsonl";
    let (_id, mut rx) = hub.attach(session.to_owned(), ClientCaps::default());
    for event in [
        json!({"type": "collab_agents", "agents": [{"id": "old"}]}),
        json!({"type": "collab_state", "state": {"model": "latest"}}),
        json!({"type": "collab_agents", "agents": []}),
    ] {
        broadcast_event(&delta, &hub, session, &event);
    }
    let agents: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("agent frame is queued")
            .expect("agent frame"),
    )
    .unwrap();
    let state: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("state frame is queued")
            .expect("state frame"),
    )
    .unwrap();
    assert_eq!(
        agents["event"],
        json!({"type": "collab_agents", "agents": []})
    );
    assert_eq!(
        state["event"],
        json!({"type": "collab_state", "state": {"model": "latest"}})
    );
}

/// A transition sequence emits exactly the contract's frames: `attached`
/// when a join becomes usable (first join AND reconnect), `reconnecting`
/// on a transient drop with a short reason, `lost` on a terminal end.
#[tokio::test]
// Held across awaits ON PURPOSE: this guard serialises tests against the
// process-wide link-state map, so releasing it at an await point would let a
// sibling test interleave and read another test's transitions.
#[allow(clippy::await_holding_lock)]
async fn link_state_frames_follow_transitions() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/link-state-seq.jsonl";
    remove_link_state(session);
    let cfg = Arc::new(test_config());
    let hub = WsHub::new(Arc::clone(&cfg));
    let delta = DeltaEncoder::new();
    let (_id, mut rx) = hub.attach(session.to_string(), ClientCaps::default());

    // First join -> transient drop -> reconnect -> terminal end.
    set_link_state(session, LinkState::Attached);
    broadcast_link_state(&delta, &hub, session, LinkState::Attached, "connected");
    set_link_state(session, LinkState::Reconnecting);
    broadcast_link_state(
        &delta,
        &hub,
        session,
        LinkState::Reconnecting,
        "connection closed",
    );
    set_link_state(session, LinkState::Attached);
    broadcast_link_state(&delta, &hub, session, LinkState::Attached, "connected");
    set_link_state(session, LinkState::Lost);
    broadcast_link_state(&delta, &hub, session, LinkState::Lost, "room closed");

    let mut frames = Vec::new();
    for _ in 0..4 {
        frames.push(rx.recv().await.expect("link-state frame").to_string());
    }
    assert_eq!(
        frames,
        vec![
            r#"{"type":"event","event":{"type":"collab_link_state","state":"attached","detail":"connected"}}"#,
            r#"{"type":"event","event":{"type":"collab_link_state","state":"reconnecting","detail":"connection closed"}}"#,
            r#"{"type":"event","event":{"type":"collab_link_state","state":"attached","detail":"connected"}}"#,
            r#"{"type":"event","event":{"type":"collab_link_state","state":"lost","detail":"room closed"}}"#,
        ]
    );
    remove_link_state(session);
}

/// link_state_summary aggregates across sessions with a fixed priority:
/// any live session wins, then reconnecting, then lost; connecting alone
/// reads as none (the four-value contract has no slot for it).
#[test]
fn link_state_summary_aggregates_across_sessions() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let a = "/tmp/link-summary-a.jsonl";
    let b = "/tmp/link-summary-b.jsonl";
    let c = "/tmp/link-summary-c.jsonl";
    remove_link_state(a);
    remove_link_state(b);
    remove_link_state(c);
    assert_eq!(link_state_summary(), "none");

    set_link_state(a, LinkState::Connecting);
    assert_eq!(
        link_state_summary(),
        "none",
        "a join in flight is not a link yet"
    );

    set_link_state(b, LinkState::Lost);
    assert_eq!(link_state_summary(), "lost");

    set_link_state(c, LinkState::Reconnecting);
    assert_eq!(
        link_state_summary(),
        "reconnecting",
        "reconnecting outranks lost"
    );

    set_link_state(a, LinkState::Attached);
    assert_eq!(
        link_state_summary(),
        "attached",
        "one live session dominates"
    );

    remove_link_state(a);
    assert_eq!(link_state_summary(), "reconnecting");

    remove_link_state(c);
    assert_eq!(link_state_summary(), "lost");

    remove_link_state(b);
    assert_eq!(link_state_summary(), "none");
}

/// The liveness gate: while the link is reconnecting, every outbound
/// sender refuses with a distinguishable error and `can_write` is
/// false — but a dialog answer is QUEUED, not refused: the question is
/// still live, so the phone gets an `ok:true queued:true` ack and the
/// answer is parked for the next successful attach while the dialog
/// stays pending. Once the link is live again a direct answer goes
/// through, settles the dialog, and acks `ok:true` with no error field.
#[tokio::test]
// Held across awaits ON PURPOSE: this guard serialises tests against the
// process-wide link-state map, so releasing it at an await point would let a
// sibling test interleave and read another test's transitions.
#[allow(clippy::await_holding_lock)]
async fn writes_refused_while_reconnecting() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/link-write-refused.jsonl";
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
    remember_collab_ui(
        session,
        9,
        &serde_json::json!({ "reqId": 9, "kind": "select", "options": ["A", "B"] }),
    );

    let cfg = Arc::new(test_config());
    let hub = WsHub::new(Arc::clone(&cfg));
    let delta = DeltaEncoder::new();
    let push = test_push(&cfg);
    let mgr = CollabManager::new(
        Arc::clone(&cfg),
        Arc::clone(&hub),
        Arc::clone(&delta),
        Arc::clone(&push),
    );
    let (_id, mut rx) = hub.attach(session.to_string(), ClientCaps::default());

    // A session that HAS a write token but whose connection is in backoff.
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(async {});
    mgr.sessions.lock().unwrap().insert(
        session.to_string(),
        CollabSession {
            generation: 1,
            frame_tx,
            shutdown_tx,
            write_token: Some("token".to_string()),
            task: Some(task),
        },
    );
    set_link_state(session, LinkState::Reconnecting);

    assert!(!mgr.can_write(session), "no writes during backoff");
    for (send, expect) in [
        (
            mgr.send_prompt(session, "hi", vec![]).map(|_| ()),
            "desktop link is reconnecting",
        ),
        (mgr.send_abort(session), "desktop link is reconnecting"),
        (
            mgr.send_agent_cmd(session, "chat", "a1", None),
            "desktop link is reconnecting",
        ),
        (
            mgr.desktop_agent_follow_up(session, "a1", 1.0, "captured", Some("follow-up"))
                .map(|_| ()),
            "desktop link is reconnecting",
        ),
    ] {
        assert_eq!(send.unwrap_err(), expect);
    }

    // A dialog answer during backoff is QUEUED, not refused: the call
    // succeeds, the dialog stays pending (delivery is just delayed), and
    // the phone is acked `ok:true queued:true` so it keeps the card
    // collapsed instead of showing "try again".
    mgr.send_ui_response(
        session,
        9,
        &collab_question_token(session, 9).expect("pending response identity"),
        Some("A"),
    )
    .expect("answer is accepted while reconnecting");
    assert_eq!(
        pending_collab_ui_requests(session).len(),
        1,
        "a queued answer leaves the dialog pending until delivery"
    );
    {
        let map = PENDING_ANSWERS.lock().unwrap_or_else(|p| p.into_inner());
        let list = map.get(session).expect("the answer is parked");
        assert_eq!(list.len(), 1, "one queued entry");
        assert_eq!(list[0].0, 9);
        assert_eq!(list[0].1.as_deref(), Some("A"));
    }
    let ack: Value = serde_json::from_str(&rx.recv().await.expect("ack")).unwrap();
    assert_eq!(ack["event"]["type"].as_str(), Some("ui_response_ack"));
    assert_eq!(ack["event"]["reqId"].as_u64(), Some(9));
    assert_eq!(ack["event"]["ok"].as_bool(), Some(true));
    assert_eq!(ack["event"]["queued"].as_bool(), Some(true));
    assert!(
        ack["event"].get("error").is_none(),
        "no error on a queued ack"
    );

    // Repeated taps while the queue owns the answer only re-report its state.
    // The reconnect flush, not another phone send, owns delivery.
    set_link_state(session, LinkState::Attached);
    mgr.send_ui_response(
        session,
        9,
        &collab_question_token(session, 9).expect("pending response identity"),
        Some("A"),
    )
    .expect("duplicate reports queued state");
    assert!(frame_rx.try_recv().is_err(), "nothing is sent twice");
    let ack: Value = serde_json::from_str(&rx.recv().await.expect("ack")).unwrap();
    assert_eq!(ack["event"]["queued"], json!(true));
    let (answers, _) = take_pending_answers(session);
    assert_eq!(
        answers
            .into_iter()
            .map(|(id, value, _)| (id, value))
            .collect::<Vec<_>>(),
        vec![(9, Some("A".to_string()))]
    );
    assert_eq!(pending_collab_ui_requests(session).len(), 1);

    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
}

/// Terminal link loss retires the questions: one `collab_ui_request_end`
/// per pending reqId (in store order), then the pending store AND any
/// queued answers are emptied, then ONE notice explains the cards
/// vanished. This is exactly the call the `End::Fatal` branch of the
/// guest task makes.
#[tokio::test]
async fn terminal_loss_retires_pending_dialogs() {
    let session = "/tmp/link-terminal-retire.jsonl";
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remember_collab_ui(session, 1, &serde_json::json!({ "reqId": 1 }));
    remember_collab_ui(session, 2, &serde_json::json!({ "reqId": 2 }));
    // An answer parked during a transient gap dies with the room too —
    // it must never flush into a future room whose reqIds restart.
    queue_collab_answer(
        session,
        1,
        Some("A"),
        &collab_question_token(session, 1).expect("queued question identity"),
    );

    let cfg = Arc::new(test_config());
    let hub = WsHub::new(Arc::clone(&cfg));
    let delta = DeltaEncoder::new();
    let (_id, mut rx) = hub.attach(session.to_string(), ClientCaps::default());

    retire_collab_questions(&delta, &hub, session, "room closed");

    let mut frames = Vec::new();
    for _ in 0..3 {
        frames.push(rx.recv().await.expect("frame").to_string());
    }
    assert_eq!(
        frames.iter().map(|frame| lifecycle_frame_body(frame)).collect::<Vec<_>>(),
        vec![
            r#"{"type":"event","event":{"type":"collab_ui_request_end","reqId":1}}"#,
            r#"{"type":"event","event":{"type":"collab_ui_request_end","reqId":2}}"#,
            r#"{"type":"event","event":{"type":"notice","message":"collab questions ended: room closed"}}"#,
        ].into_iter().map(lifecycle_frame_body).collect::<Vec<_>>(),
        "one request_end per pending dialog, then ONE notice"
    );
    assert!(
        pending_collab_ui_requests(session).is_empty(),
        "the pending store is emptied"
    );
    assert!(
        take_pending_answers(session).0.is_empty(),
        "queued answers are dropped, not flushed into a future room"
    );
    forget_collab_ui_session(session);
    forget_pending_answers(session);
}

/// A user tap on Detach ends the collab session too — and because
/// detach() ABORTS the guest task, the terminal-loss branch never runs
/// for this path. Retirement must happen inside detach, or a reopened
/// conversation replays a card whose asker no longer exists.
#[tokio::test]
// Held across awaits ON PURPOSE: the guard serialises tests against the
// process-wide link-state map (detach removes a state entry).
#[allow(clippy::await_holding_lock)]
async fn detach_retires_pending_dialogs() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/link-detach-retire.jsonl";
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
    remember_collab_ui(session, 5, &serde_json::json!({ "reqId": 5 }));

    let cfg = Arc::new(test_config());
    let hub = WsHub::new(Arc::clone(&cfg));
    let delta = DeltaEncoder::new();
    let push = test_push(&cfg);
    let mgr = CollabManager::new(
        Arc::clone(&cfg),
        Arc::clone(&hub),
        Arc::clone(&delta),
        Arc::clone(&push),
    );
    let (_id, mut rx) = hub.attach(session.to_string(), ClientCaps::default());
    let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(async {});
    mgr.sessions.lock().unwrap().insert(
        session.to_string(),
        CollabSession {
            generation: 1,
            frame_tx,
            shutdown_tx,
            write_token: Some("token".to_string()),
            task: Some(task),
        },
    );
    set_link_state(session, LinkState::Attached);

    mgr.detach(session);

    let mut frames = Vec::new();
    for _ in 0..2 {
        frames.push(rx.recv().await.expect("frame").to_string());
    }
    assert_eq!(
        frames.iter().map(|frame| lifecycle_frame_body(frame)).collect::<Vec<_>>(),
        vec![
            r#"{"type":"event","event":{"type":"collab_ui_request_end","reqId":5}}"#,
            r#"{"type":"event","event":{"type":"notice","message":"collab questions ended: detached"}}"#,
        ].into_iter().map(lifecycle_frame_body).collect::<Vec<_>>()
    );
    assert!(
        pending_collab_ui_requests(session).is_empty(),
        "detach empties the pending store"
    );
    assert_eq!(
        link_state(session),
        LinkState::Connecting,
        "detach removes the link state"
    );
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
}

/// Flush reports transport handoff, keeps questions pending until the host's
/// request-end, and retains failed writes for reconnect.
#[tokio::test]
async fn queued_answers_flush_on_attach_in_order() {
    let session = "/tmp/link-answer-flush.jsonl";
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remember_collab_ui(session, 1, &serde_json::json!({ "reqId": 1 }));
    remember_collab_ui(session, 2, &serde_json::json!({ "reqId": 2 }));
    remember_collab_ui(session, 3, &serde_json::json!({ "reqId": 3 }));
    queue_collab_answer(
        session,
        1,
        Some("A"),
        &collab_question_token(session, 1).expect("queued question identity"),
    );
    queue_collab_answer(
        session,
        2,
        None,
        &collab_question_token(session, 2).expect("queued question identity"),
    ); // a cancel is queued like any answer
    queue_collab_answer(
        session,
        3,
        Some("C"),
        &collab_question_token(session, 3).expect("queued question identity"),
    );

    let cfg = Arc::new(test_config());
    let hub = WsHub::new(Arc::clone(&cfg));
    let delta = DeltaEncoder::new();
    let (_id, mut rx) = hub.attach(session.to_string(), ClientCaps::default());

    let mut sender = RecordingAnswerSink {
        delivered: Vec::new(),
        ok: true,
    };
    flush_pending_answers(&mut sender, &delta, &hub, session).await;

    assert_eq!(
        sender.delivered,
        vec![
            (1, Some("A".to_string())),
            (2, None),
            (3, Some("C".to_string())),
        ],
        "oldest first, in queue order"
    );
    assert!(
        take_pending_answers(session).0.is_empty(),
        "the queue is empty after a successful flush"
    );
    assert_eq!(
        pending_collab_ui_requests(session).len(),
        3,
        "handoff does not prove callback acceptance"
    );
    let mut acks = Vec::new();
    for _ in 0..3 {
        acks.push(serde_json::from_str::<Value>(&rx.recv().await.expect("re-ack")).unwrap());
    }
    for (i, ack) in acks.iter().enumerate() {
        assert_eq!(ack["event"]["type"].as_str(), Some("ui_response_ack"));
        assert_eq!(ack["event"]["reqId"].as_u64(), Some(i as u64 + 1));
        assert_eq!(ack["event"]["ok"].as_bool(), Some(true));
        assert!(
            ack["event"].get("queued").is_none(),
            "a flushed answer is delivered, never re-marked queued"
        );
        assert!(ack["event"].get("error").is_none());
    }

    // A send failure keeps the answer queued for the next attach.
    remember_collab_ui(session, 7, &serde_json::json!({ "reqId": 7 }));
    queue_collab_answer(
        session,
        7,
        Some("retry-me"),
        &collab_question_token(session, 7).expect("queued question identity"),
    );
    let mut failing = RecordingAnswerSink {
        delivered: Vec::new(),
        ok: false,
    };
    flush_pending_answers(&mut failing, &delta, &hub, session).await;
    assert_eq!(
        take_pending_answers(session)
            .0
            .into_iter()
            .map(|(id, value, _)| (id, value))
            .collect::<Vec<_>>(),
        vec![(7, Some("retry-me".to_string()))],
        "an undelivered answer stays queued"
    );

    forget_collab_ui_session(session);
    forget_pending_answers(session);
}

#[tokio::test]
async fn queued_old_token_never_answers_a_reused_request_id() {
    let session = "/synthetic/collab-queued-token-reuse.jsonl";
    remember_collab_ui(session, 7, &json!({"reqId":7,"pulseRoomId":"old-room"}));
    let old = collab_question_token(session, 7).unwrap();
    queue_collab_answer(session, 7, Some("old value"), &old);
    remember_collab_ui(session, 7, &json!({"reqId":7,"pulseRoomId":"new-room"}));
    let new = collab_question_token(session, 7).unwrap();
    assert_ne!(old, new);
    let hub = WsHub::new(Arc::new(test_config()));
    let delta = DeltaEncoder::new();
    let (_, mut rx) = hub.attach(session.to_owned(), ClientCaps::default());
    let mut sender = RecordingAnswerSink {
        delivered: Vec::new(),
        ok: true,
    };
    flush_pending_answers(&mut sender, &delta, &hub, session).await;
    assert!(sender.delivered.is_empty());
    let ack: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(ack["event"]["pulseQuestionToken"], old);
    assert_eq!(ack["event"]["ok"], false);
    assert_eq!(ack["event"]["actionable"], false);
    assert_eq!(
        collab_question_token(session, 7).as_deref(),
        Some(new.as_str())
    );
    forget_collab_ui_session(session);
    forget_pending_answers(session);
}

/// A genuinely absent session (no session object, no stored link) keeps
/// `ok:false` but the error never hints a retry can help — the desktop
/// that asked is gone — and the answer is never queued.
#[tokio::test]
// Held across awaits ON PURPOSE: this guard serialises the tests that
// build a CollabManager — Push::load races on the shared pid-suffixed
// VAPID file when two of them run concurrently (one reads the other's
// half-written key file). This test also mutates LINK_STATES via
// remove_link_state, so the link-state lock is the right one.
#[allow(clippy::await_holding_lock)]
async fn absent_session_acks_ok_false_with_gone_text() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/link-answer-absent.jsonl";
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);

    let cfg = Arc::new(test_config());
    let hub = WsHub::new(Arc::clone(&cfg));
    let delta = DeltaEncoder::new();
    let push = test_push(&cfg);
    let mgr = CollabManager::new(
        Arc::clone(&cfg),
        Arc::clone(&hub),
        Arc::clone(&delta),
        Arc::clone(&push),
    );
    let (_id, mut rx) = hub.attach(session.to_string(), ClientCaps::default());

    let err = mgr
        .send_ui_response(session, 1, "closed-question", Some("A"))
        .unwrap_err();
    assert_eq!(err, "not attached to a collab session");
    let ack: Value = serde_json::from_str(&rx.recv().await.expect("ack")).unwrap();
    assert_eq!(ack["event"]["type"].as_str(), Some("ui_response_ack"));
    assert_eq!(ack["event"]["reqId"].as_u64(), Some(1));
    assert_eq!(ack["event"]["ok"].as_bool(), Some(false));
    assert_eq!(
        ack["event"]["error"].as_str(),
        Some("the desktop that asked is gone")
    );
    assert!(ack["event"].get("queued").is_none());
    assert!(
        take_pending_answers(session).0.is_empty(),
        "an absent session is never queued"
    );
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
}
