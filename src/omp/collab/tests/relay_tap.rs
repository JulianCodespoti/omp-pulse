//! Relay tap write path.
//!
//! These exercise the tap's registration/teardown seams
//! (`register_tap_session` / `tap_exit_cleanup` — the exact functions
//! `relay_tap_task` calls once its join succeeds) against the same
//! manager-level write APIs the phone uses, so a tap-attached session
//! must be indistinguishable from a guest-attached one.

use super::*;

/// A session registered by the tap accepts a dialog answer and the
/// frame reaches the tap's outbound channel — the receiver the tap's
/// select loop drains into the (sealed) sink. This is the reported bug:
/// a tap-attached session's answers were refused with "not attached to
/// a collab session".
#[tokio::test]
// Held across awaits ON PURPOSE: this guard serialises tests against the
// process-wide link-state map, so releasing it at an await point would let a
// sibling test interleave and read another test's transitions.
#[allow(clippy::await_holding_lock)]
async fn tap_registered_session_accepts_ui_response_and_frame_reaches_sink() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/tap-write-ui-response.jsonl";
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

    // Register exactly as the tap does once its join succeeds and the
    // room maps to a session: fresh generation from the manager's counter.
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let generation = register_tap_session(
        &mgr,
        session,
        Some("token".to_string()),
        frame_tx,
        shutdown_tx,
    );
    assert_eq!(
        mgr.sessions
            .lock()
            .unwrap()
            .get(session)
            .unwrap()
            .generation,
        generation,
        "the tap owns the registry entry"
    );
    assert!(
        mgr.is_live(session),
        "a tapped session with a full link is live"
    );
    assert!(mgr.can_write(session), "the tap opens the write gate");

    // The phone first sees the Attached badge, like a guest attach.
    let badge: Value = serde_json::from_str(&rx.recv().await.expect("badge")).unwrap();
    assert_eq!(badge["event"]["type"].as_str(), Some("collab_link_state"));
    assert_eq!(badge["event"]["state"].as_str(), Some("attached"));

    remember_collab_ui(session, 42, &serde_json::json!({ "reqId": 42 }));
    let original_token = collab_question_token(session, 42).unwrap();
    mgr.send_ui_response(session, 42, &original_token, Some("B"))
        .expect("the tap write path accepts the answer");
    let sent = frame_rx
        .recv()
        .await
        .expect("ui-response frame reaches the tap sink")
        .payload;
    assert_eq!(sent.get("t").and_then(Value::as_str), Some("ui-response"));
    assert_eq!(sent.get("reqId").and_then(Value::as_u64), Some(42));
    assert_eq!(sent.get("value").and_then(Value::as_str), Some("B"));
    // The phone is acked ok:true — the answer was handed to a live link.
    let ack: Value = serde_json::from_str(&rx.recv().await.expect("ack")).unwrap();
    assert_eq!(ack["event"]["type"].as_str(), Some("ui_response_ack"));
    assert_eq!(ack["event"]["reqId"].as_u64(), Some(42));
    assert_eq!(ack["event"]["ok"].as_bool(), Some(true));
    assert_eq!(ack["event"]["pulseQuestionToken"], original_token);
    assert!(ack["event"].get("error").is_none());
    assert_eq!(
        pending_collab_ui_requests(session).len(),
        1,
        "transport handoff is not callback acceptance"
    );
    mgr.send_ui_response(session, 42, &original_token, Some("B"))
        .unwrap();
    assert!(
        frame_rx.try_recv().is_err(),
        "a handoff is never sent twice"
    );
    let _: Value = serde_json::from_str(&rx.recv().await.expect("duplicate ack")).unwrap();
    assert!(
        mgr.send_ui_response(session, 42, &original_token, Some("different"))
            .is_err()
    );
    assert!(
        frame_rx.try_recv().is_err(),
        "a conflicting second value is never handed off"
    );
    let refused: Value = serde_json::from_str(&rx.recv().await.expect("conflict ack")).unwrap();
    assert_eq!(refused["event"]["ok"], json!(false));
    assert_eq!(refused["event"]["actionable"], json!(false));
    forget_collab_ui(session, 42);
    assert!(
        mgr.send_ui_response(session, 42, &original_token, Some("stale"))
            .is_err()
    );
    assert!(
        frame_rx.try_recv().is_err(),
        "a closed question is never retried"
    );
    let closed: Value = serde_json::from_str(&rx.recv().await.expect("closed ack")).unwrap();
    assert_eq!(closed["event"]["pulseQuestionToken"], original_token);
    remember_collab_ui(session, 42, &json!({"reqId":42,"pulseRoomId":"new-room"}));
    let replacement_token = collab_question_token(session, 42).unwrap();
    assert_ne!(replacement_token, original_token);
    assert!(
        mgr.send_ui_response(session, 42, &original_token, Some("old held answer"))
            .is_err()
    );
    assert!(
        frame_rx.try_recv().is_err(),
        "old token cannot dispatch into a reused reqId"
    );
    let stale: Value = serde_json::from_str(&rx.recv().await.expect("stale token ack")).unwrap();
    assert_eq!(stale["event"]["pulseQuestionToken"], original_token);
    assert_eq!(stale["event"]["actionable"], false);
    mgr.send_ui_response(session, 42, &replacement_token, Some("distinct answer"))
        .unwrap();
    assert_eq!(
        frame_rx.recv().await.unwrap().payload["value"],
        "distinct answer"
    );
    let fresh: Value = serde_json::from_str(&rx.recv().await.expect("new token ack")).unwrap();
    assert_eq!(fresh["event"]["pulseQuestionToken"], replacement_token);

    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
}

/// A tap-registered session accepts a phone prompt through the same
/// write gate as a guest attach.
#[tokio::test]
// Held across awaits ON PURPOSE: this guard serialises tests against the
// process-wide link-state map, so releasing it at an await point would let a
// sibling test interleave and read another test's transitions.
#[allow(clippy::await_holding_lock)]
async fn tap_registered_session_accepts_prompt() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/tap-write-prompt.jsonl";
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

    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let _generation = register_tap_session(
        &mgr,
        session,
        Some("token".to_string()),
        frame_tx,
        shutdown_tx,
    );

    let mut receipt = mgr
        .send_prompt(session, "what's the ETA?", vec![])
        .expect("the tap write path accepts the prompt");
    let outbound = frame_rx
        .recv()
        .await
        .expect("prompt frame reaches the tap sink");
    assert!(
        matches!(receipt.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
        "enqueueing alone must not confirm forwarding"
    );
    let sent = outbound.payload;
    assert_eq!(sent.get("t").and_then(Value::as_str), Some("prompt"));
    assert_eq!(
        sent.get("text").and_then(Value::as_str),
        Some("what's the ETA?")
    );

    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
}

/// A VIEW-ONLY tapped link (no write token) keeps `check_writable`'s
/// "view-only link" answer: the phone can watch but never answer.
#[tokio::test]
// Held across awaits ON PURPOSE: this guard serialises tests against the
// process-wide link-state map, so releasing it at an await point would let a
// sibling test interleave and read another test's transitions.
#[allow(clippy::await_holding_lock)]
async fn tap_view_only_link_refuses_writes() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/tap-view-only.jsonl";
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

    // A view-only link: write_token None, exactly as register_tap_session
    // receives it for a 32-byte-secret link.
    let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let _generation = register_tap_session(&mgr, session, None, frame_tx, shutdown_tx);
    // Drain the Attached badge before reading the ack below (the phone
    // would see it too, and the bounded test queue must not overflow).
    let badge: Value = serde_json::from_str(&rx.recv().await.expect("badge")).unwrap();
    assert_eq!(badge["event"]["state"].as_str(), Some("attached"));
    assert!(
        !mgr.can_write(session),
        "a view-only tap never opens the write gate"
    );
    assert_eq!(
        mgr.send_prompt(session, "hi", vec![]).unwrap_err(),
        "view-only link"
    );
    assert_eq!(
        mgr.desktop_agent_follow_up(session, "agent-a", 1234.0, "captured", Some("follow-up"))
            .unwrap_err(),
        "view-only link"
    );
    let err = mgr
        .send_ui_response(session, 1, "view-only-question", Some("A"))
        .unwrap_err();
    assert_eq!(err, "view-only link");
    let ack: Value = serde_json::from_str(&rx.recv().await.expect("ack")).unwrap();
    assert_eq!(ack["event"]["type"].as_str(), Some("ui_response_ack"));
    assert_eq!(ack["event"]["reqId"].as_u64(), Some(1));
    assert_eq!(ack["event"]["ok"].as_bool(), Some(false));
    assert_eq!(ack["event"]["error"].as_str(), Some("view-only link"));

    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
}

/// A terminal tap exit (room closed) removes the session, leaves the
/// link state Lost (not Attached), retires pending dialogs and drops
/// queued answers — a dead room cannot leave answerable cards.
#[tokio::test]
// Held across awaits ON PURPOSE: this guard serialises tests against the
// process-wide link-state map, so releasing it at an await point would let a
// sibling test interleave and read another test's transitions.
#[allow(clippy::await_holding_lock)]
async fn tap_terminal_exit_removes_session_retires_dialogs() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/tap-terminal-exit.jsonl";
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
    remember_collab_ui(session, 1, &serde_json::json!({ "reqId": 1 }));
    remember_collab_ui(session, 2, &serde_json::json!({ "reqId": 2 }));
    // An answer parked during a transient gap dies with the room too.
    queue_collab_answer(
        session,
        1,
        Some("A"),
        &collab_question_token(session, 1).expect("queued question identity"),
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

    let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let generation = register_tap_session(
        &mgr,
        session,
        Some("token".to_string()),
        frame_tx,
        shutdown_tx,
    );
    // Drain the Attached badge NOW: the four cleanup frames below must
    // not pile up past the test hub's bounded queue (cap 4).
    let badge: Value = serde_json::from_str(&rx.recv().await.expect("badge")).unwrap();
    assert_eq!(badge["event"]["type"].as_str(), Some("collab_link_state"));
    assert_eq!(badge["event"]["state"].as_str(), Some("attached"));

    // The tap's loop ended terminally: room closed.
    tap_exit_cleanup(
        &mgr,
        &delta,
        &hub,
        session,
        generation,
        "room closed",
        TapEnding::Terminal,
    );

    assert!(
        mgr.sessions.lock().unwrap().get(session).is_none(),
        "a terminal tap exit removes the session"
    );
    assert_ne!(
        link_state(session),
        LinkState::Attached,
        "the link is no longer live"
    );
    assert_eq!(
        link_state(session),
        LinkState::Lost,
        "lost persists, like the guest path"
    );
    assert!(
        pending_collab_ui_requests(session).is_empty(),
        "terminal exit retires every pending dialog"
    );
    assert!(
        take_pending_answers(session).0.is_empty(),
        "queued answers die with the room"
    );

    // Frames after the badge: Lost, then one request_end per pending
    // dialog, then one notice.
    let mut frames = Vec::new();
    for _ in 0..4 {
        frames.push(rx.recv().await.expect("frame").to_string());
    }
    assert_eq!(
        frames.iter().map(|frame| lifecycle_frame_body(frame)).collect::<Vec<_>>(),
        vec![
            r#"{"type":"event","event":{"type":"collab_link_state","state":"lost","detail":"room closed"}}"#,
            r#"{"type":"event","event":{"type":"collab_ui_request_end","reqId":1}}"#,
            r#"{"type":"event","event":{"type":"collab_ui_request_end","reqId":2}}"#,
            r#"{"type":"event","event":{"type":"notice","message":"collab questions ended: room closed"}}"#,
        ].into_iter().map(lifecycle_frame_body).collect::<Vec<_>>()
    );

    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
}

/// A STALE tap's cleanup (its connection died after a newer attach
/// replaced its entry) must not touch the newer session: the entry, the
/// live Attached link state and the pending dialogs all survive,
/// because the cleanup is generation-guarded.
#[tokio::test]
// Held across awaits ON PURPOSE: this guard serialises tests against the
// process-wide link-state map, so releasing it at an await point would let a
// sibling test interleave and read another test's transitions.
#[allow(clippy::await_holding_lock)]
async fn stale_tap_cleanup_preserves_newer_session() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/tap-stale-cleanup.jsonl";
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

    // Tap A registers; a NEWER attach (tap B) replaces the entry.
    let (tx_a, _rx_a) = mpsc::unbounded_channel();
    let (sx_a, _sx_a) = watch::channel(false);
    let generation_a = register_tap_session(&mgr, session, Some("token".to_string()), tx_a, sx_a);
    let (tx_b, _rx_b) = mpsc::unbounded_channel();
    let (sx_b, _sx_b) = watch::channel(false);
    let generation_b = register_tap_session(&mgr, session, Some("token".to_string()), tx_b, sx_b);
    assert_ne!(
        generation_a, generation_b,
        "each registration takes a fresh generation"
    );
    assert_eq!(
        mgr.sessions
            .lock()
            .unwrap()
            .get(session)
            .unwrap()
            .generation,
        generation_b,
        "the newer attach owns the entry"
    );
    remember_collab_ui(session, 7, &serde_json::json!({ "reqId": 7 }));

    // Tap A's loop ends terminally AFTER being superseded: its cleanup
    // must be a no-op for the newer owner.
    tap_exit_cleanup(
        &mgr,
        &delta,
        &hub,
        session,
        generation_a,
        "room closed",
        TapEnding::Terminal,
    );

    assert_eq!(
        mgr.sessions
            .lock()
            .unwrap()
            .get(session)
            .unwrap()
            .generation,
        generation_b,
        "the newer session survives the stale tap's cleanup"
    );
    assert_eq!(
        link_state(session),
        LinkState::Attached,
        "stale cleanup leaves the live link state alone"
    );
    assert!(mgr.can_write(session), "the newer session still writes");
    assert_eq!(
        pending_collab_ui_requests(session).len(),
        1,
        "stale cleanup must not retire live dialogs"
    );

    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
}

/// Answers queued while the link was down flush when a TAP attaches —
/// the tap runs the same post-welcome flush as the guest attach, so an
/// outage before a tap comes up cannot strand the phone's answers.
#[tokio::test]
// Held across awaits ON PURPOSE: this guard serialises tests against the
// process-wide link-state map, so releasing it at an await point would let a
// sibling test interleave and read another test's transitions.
#[allow(clippy::await_holding_lock)]
async fn queued_answers_flush_when_tap_attaches() {
    let _guard = LINK_STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = "/tmp/tap-answer-flush.jsonl";
    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
    remember_collab_ui(session, 1, &serde_json::json!({ "reqId": 1 }));
    remember_collab_ui(session, 2, &serde_json::json!({ "reqId": 2 }));
    queue_collab_answer(
        session,
        1,
        Some("A"),
        &collab_question_token(session, 1).expect("queued question identity"),
    );
    queue_collab_answer(
        session,
        2,
        Some("B"),
        &collab_question_token(session, 2).expect("queued question identity"),
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

    // The tap attach point: registration (link flips Attached) followed
    // by the flush relay_tap_task runs right after — the exact sequence
    // conn_lifetime performs on a guest attach.
    let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let _generation = register_tap_session(
        &mgr,
        session,
        Some("token".to_string()),
        frame_tx,
        shutdown_tx,
    );
    assert_eq!(
        link_state(session),
        LinkState::Attached,
        "the tap registration is the attach point"
    );
    // Drain the Attached badge before the re-acks below.
    let badge: Value = serde_json::from_str(&rx.recv().await.expect("badge")).unwrap();
    assert_eq!(badge["event"]["type"].as_str(), Some("collab_link_state"));
    assert_eq!(badge["event"]["state"].as_str(), Some("attached"));
    let mut sender = RecordingAnswerSink {
        delivered: Vec::new(),
        ok: true,
    };
    flush_pending_answers(&mut sender, &delta, &hub, session).await;

    assert_eq!(
        sender.delivered,
        vec![(1, Some("A".to_string())), (2, Some("B".to_string())),],
        "oldest first, in queue order"
    );
    assert!(
        take_pending_answers(session).0.is_empty(),
        "the queue is empty after the tap-attach flush"
    );
    assert_eq!(
        pending_collab_ui_requests(session).len(),
        2,
        "handoff keeps questions pending until the host closes them"
    );
    let mut acks = Vec::new();
    for _ in 0..2 {
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

    forget_collab_ui_session(session);
    forget_pending_answers(session);
    remove_link_state(session);
}
