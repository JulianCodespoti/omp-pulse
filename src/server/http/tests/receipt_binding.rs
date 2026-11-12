use super::*;
use crate::authority::command_ledger::ReceiptState;
use axum::extract::Query;
use std::{
    fs,
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pulse-bound-receipts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(root.join("sessions")).unwrap();
        Self { root }
    }

    fn config(&self) -> Config {
        Config {
            host: "127.0.0.1".into(),
            port: 0,
            sessions_root: self.root.join("sessions"),
            omp_bin: self.root.join("no-transport-executable"),
            public_dir: None,
            token_hash: None,
            max_children: 0,
            push_store_path: self.root.join("push.json"),
            vapid_path: self.root.join("vapid.json"),
            state_dir: self.root.join("state"),
            home: self.root.clone(),
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
        }
    }

    fn path(&self, name: &str) -> String {
        self.root
            .join("sessions")
            .join(format!("{name}.jsonl"))
            .to_str()
            .unwrap()
            .to_owned()
    }

    fn canonical(&self, raw: &str) -> String {
        resolve_session_path(&self.config(), raw)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned()
    }

    fn ledger(&self) -> CommandLedger {
        CommandLedger::open(&self.root.join("state")).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap()
}

fn assert_binding(value: &Value, raw: &str, canonical: &str) {
    assert_eq!(value["ok"], true);
    assert_eq!(value["receipt"]["sessionPath"], canonical);
    assert_eq!(
        value["receiptBinding"],
        json!({
            "version": 1,
            "requestedSessionPath": raw,
            "canonicalSessionPath": canonical,
        }),
    );
}

// Count the actual production admission gate, replacing only the transport
// beyond it with a counter. This proves dispatch eligibility, not execution.
#[derive(Default)]
struct AdmissionProbe {
    attempts: usize,
    dispatches: usize,
}

impl AdmissionProbe {
    fn submit(
        &mut self,
        fixture: &Fixture,
        ledger: &CommandLedger,
        raw: &str,
        text: &str,
        images: &[Value],
    ) -> Response {
        self.attempts += 1;
        let canonical = fixture.canonical(raw);
        let fingerprint = CommandLedger::fingerprint(&canonical, text, images);
        if let Some(response) = prompt_admission_response(
            ledger.submit("exact-id", &canonical, &fingerprint),
            raw,
            &canonical,
        ) {
            return response;
        }
        self.dispatches += 1;
        let receipt = ledger
            .update("exact-id", ReceiptState::Dispatching, None, None)
            .unwrap();
        bound_receipt_response(raw, &canonical, receipt)
    }
}

#[tokio::test]
async fn bound_prompt_and_scoped_get_preserve_all_eight_states() {
    let fixture = Fixture::new();
    let raw = fixture.path("./space + percent% question? é");
    let canonical = fixture.canonical(&raw);
    assert_ne!(raw, canonical);
    let ledger = fixture.ledger();
    ledger.submit("exact-id", &canonical, "payload").unwrap();
    for state in [
        ReceiptState::Accepted,
        ReceiptState::Dispatching,
        ReceiptState::Received,
        ReceiptState::Running,
        ReceiptState::Forwarded,
        ReceiptState::Completed,
        ReceiptState::Failed,
        ReceiptState::Uncertain,
    ] {
        let expected_state = state.as_str();
        let receipt = ledger
            .update(
                "exact-id",
                state,
                Some("original_code"),
                Some("original reason"),
            )
            .unwrap();
        let expected_receipt = serde_json::to_value(&receipt).unwrap();
        for response in [
            bound_receipt_response(&raw, &canonical, receipt),
            receipt_response(&fixture.config(), &ledger, "exact-id", Some(&raw)),
            prompt_admission_response(
                ledger.submit("exact-id", &canonical, "payload"),
                &raw,
                &canonical,
            )
            .expect("existing admission must return before dispatch"),
        ] {
            assert_eq!(response.status(), StatusCode::OK);
            let value = body(response).await;
            assert_binding(&value, &raw, &canonical);
            assert_eq!(value["receipt"], expected_receipt);
            assert_eq!(value["receipt"]["state"], expected_state);
        }
    }
}

#[tokio::test]
async fn bound_success_rejects_a_receipt_that_cannot_certify_its_request() {
    let fixture = Fixture::new();
    let ledger = fixture.ledger();
    let a = fixture.path("a");
    let b = fixture.path("b");
    ledger.submit("exact-id", &a, "payload").unwrap();
    let receipt = ledger.get("exact-id").unwrap().unwrap();
    let response = bound_receipt_response(&b, &b, receipt);
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let value = body(response).await;
    assert_eq!(value["ok"], false);
    assert_eq!(value["code"], "receipt_session_mismatch");
    assert!(value.get("receiptBinding").is_none());
}

#[tokio::test]
async fn scoped_status_distinguishes_invalid_mismatch_absence_and_legacy_reads() {
    let fixture = Fixture::new();
    let cfg = fixture.config();
    let ledger = fixture.ledger();
    let a = fixture.path("a");
    let b = fixture.path("b");
    ledger.submit("exact-id", &a, "payload").unwrap();
    let before = fs::read(cfg.state_dir.join("commands.json")).unwrap();
    let outside = fixture
        .root
        .join("outside.jsonl")
        .to_str()
        .unwrap()
        .to_owned();
    for raw in ["", "not-a-session", outside.as_str()] {
        for id in ["exact-id", "absent"] {
            let response = receipt_response(&cfg, &ledger, id, Some(raw));
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let value = body(response).await;
            assert_eq!(value["ok"], false);
            assert_eq!(value["code"], "receipt_session_invalid");
            assert!(value.get("receiptBinding").is_none());
        }
    }
    let mismatch = receipt_response(&cfg, &ledger, "exact-id", Some(&b));
    assert_eq!(mismatch.status(), StatusCode::CONFLICT);
    assert_eq!(body(mismatch).await["code"], "receipt_session_mismatch");
    for scope in [None, Some(a.as_str())] {
        // GET must preserve exact ID identity, including whitespace.
        for id in ["absent", " exact-id "] {
            let response = receipt_response(&cfg, &ledger, id, scope);
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                body(response).await,
                json!({"ok":false,"error":"receipt not found"})
            );
        }
    }
    let legacy = receipt_response(&cfg, &ledger, "exact-id", None);
    assert_eq!(legacy.status(), StatusCode::OK);
    assert_eq!(
        body(legacy).await,
        json!({"ok":true,"receipt":ledger.get("exact-id").unwrap().unwrap()}),
    );
    assert_eq!(
        fs::read(cfg.state_dir.join("commands.json")).unwrap(),
        before
    );
}

#[test]
fn scoped_query_decodes_and_preserves_the_exact_request_spelling() {
    let raw = "/synthetic/./space + percent% question? é.jsonl";
    let encoded: String = raw.bytes().map(|byte| format!("%{byte:02X}")).collect();
    let uri = format!("/api/receipts/exact-id?session={encoded}")
        .parse()
        .unwrap();
    let Query(query) = Query::<ReceiptsQuery>::try_from_uri(&uri).unwrap();
    assert_eq!(query.session.as_deref(), Some(raw));
    let Query(query) =
        Query::<ReceiptsQuery>::try_from_uri(&"/api/receipts/id?session=".parse().unwrap())
            .unwrap();
    assert_eq!(query.session.as_deref(), Some(""));
    let Query(query) =
        Query::<ReceiptsQuery>::try_from_uri(&"/api/receipts/id".parse().unwrap()).unwrap();
    assert!(query.session.is_none());
}

#[tokio::test]
async fn exact_replay_conflicts_and_lost_ack_status_never_redispatch() {
    let fixture = Fixture::new();
    let ledger = fixture.ledger();
    let raw = fixture.path("./a");
    let canonical = fixture.canonical(&raw);
    let other = fixture.path("b");
    let images = [json!({"mimeType":"image/png","data":"exact-image"})];
    let mut probe = AdmissionProbe::default();
    // Simulate losing the acknowledgement after the admission seam fired.
    drop(probe.submit(&fixture, &ledger, &raw, " exact text\n", &images));
    assert_eq!((probe.attempts, probe.dispatches), (1, 1));
    let saved = serde_json::to_value(ledger.get("exact-id").unwrap().unwrap()).unwrap();
    for alias in [&raw, &canonical] {
        let replay = probe.submit(&fixture, &ledger, alias, " exact text\n", &images);
        assert_eq!(replay.status(), StatusCode::OK);
        assert_binding(&body(replay).await, alias, &canonical);
    }
    for (path, text, changed_images) in [
        (&other, " exact text\n", images.to_vec()),
        (&raw, "changed text", images.to_vec()),
        (
            &raw,
            " exact text\n",
            vec![json!({"mimeType":"image/png","data":"changed-image"})],
        ),
        (
            &raw,
            " exact text\n",
            vec![json!({"mimeType":"image/jpeg","data":"exact-image"})],
        ),
    ] {
        let response = probe.submit(&fixture, &ledger, path, text, &changed_images);
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let value = body(response).await;
        assert_eq!(value["receipt"], saved);
        assert!(value.get("receiptBinding").is_none());
    }
    for _ in 0..3 {
        let value = body(receipt_response(
            &fixture.config(),
            &ledger,
            "exact-id",
            Some(&raw),
        ))
        .await;
        assert_binding(&value, &raw, &canonical);
        assert_eq!(value["receipt"], saved);
    }
    assert_eq!((probe.attempts, probe.dispatches), (7, 1));
    assert_eq!(
        serde_json::to_value(ledger.get("exact-id").unwrap().unwrap()).unwrap(),
        saved
    );
}

#[cfg(unix)]
#[tokio::test]
async fn real_symlink_alias_replay_and_retarget_or_deletion_fail_closed() {
    let fixture = Fixture::new();
    let ledger = fixture.ledger();
    let a = fixture.path("a");
    let b = fixture.path("b");
    let alias = fixture.path("alias");
    fs::write(&a, "").unwrap();
    fs::write(&b, "").unwrap();
    std::os::unix::fs::symlink(&a, &alias).unwrap();
    let canonical = fixture.canonical(&alias);
    let mut probe = AdmissionProbe::default();
    let first = probe.submit(&fixture, &ledger, &alias, "text", &[]);
    assert_binding(&body(first).await, &alias, &canonical);
    let replay = probe.submit(&fixture, &ledger, &a, "text", &[]);
    assert_binding(&body(replay).await, &a, &canonical);
    let saved = serde_json::to_value(ledger.get("exact-id").unwrap().unwrap()).unwrap();
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&b, &alias).unwrap();
    for deleted in [false, true] {
        if deleted {
            fs::remove_file(&alias).unwrap();
        }
        let response = receipt_response(&fixture.config(), &ledger, "exact-id", Some(&alias));
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(body(response).await["code"], "receipt_session_mismatch");
        assert_eq!(
            probe
                .submit(&fixture, &ledger, &alias, "text", &[])
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            serde_json::to_value(ledger.get("exact-id").unwrap().unwrap()).unwrap(),
            saved
        );
    }
    assert_eq!((probe.attempts, probe.dispatches), (4, 1));
}

#[tokio::test]
async fn archived_scoped_receipt_survives_restart_and_replay_without_dispatch() {
    let fixture = Fixture::new();
    let cfg = fixture.config();
    fs::create_dir_all(&cfg.state_dir).unwrap();
    let raw = fixture.path("./a");
    let canonical = fixture.canonical(&raw);
    let mut receipts = serde_json::Map::new();
    // A full ledger: the next submit archives exactly the oldest receipt.
    for index in 0..crate::authority::command_ledger::MAX_RECEIPTS {
        let id = if index == 0 {
            "exact-id".into()
        } else {
            format!("seed-{index}")
        };
        receipts.insert(id.clone(), json!({
            "receipt": {"commandId":id,"sessionPath":canonical,"state":"completed","createdAt":index,"updatedAt":index},
            "fingerprint":CommandLedger::fingerprint(&canonical,"archived text",&[]),
        }));
    }
    fs::write(
        cfg.state_dir.join("commands.json"),
        serde_json::to_vec(&json!({"version":1,"receipts":receipts})).unwrap(),
    )
    .unwrap();
    let ledger = fixture.ledger();
    ledger.submit("new", &canonical, "new-payload").unwrap();
    assert!(
        !ledger
            .for_session(&canonical)
            .iter()
            .any(|receipt| receipt.command_id == "exact-id")
    );
    assert_eq!(
        fs::read_dir(cfg.state_dir.join("command-receipts"))
            .unwrap()
            .count(),
        1
    );
    drop(ledger);
    let ledger = fixture.ledger();
    let value = body(receipt_response(&cfg, &ledger, "exact-id", Some(&raw))).await;
    assert_binding(&value, &raw, &canonical);
    assert_eq!(value["receipt"]["state"], "completed");
    let mut probe = AdmissionProbe::default();
    let replay = probe.submit(&fixture, &ledger, &raw, "archived text", &[]);
    assert_binding(&body(replay).await, &raw, &canonical);
    assert_eq!(
        probe
            .submit(&fixture, &ledger, &raw, "different text", &[])
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!((probe.attempts, probe.dispatches), (2, 0));
    // Archive failures must remain 500, never false absence or bound success.
    let archive = fs::read_dir(cfg.state_dir.join("command-receipts"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(archive, b"malformed archive").unwrap();
    for scope in [None, Some(raw.as_str())] {
        let response = receipt_response(&cfg, &ledger, "exact-id", scope);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(body(response).await.get("receiptBinding").is_none());
    }
}

#[tokio::test]
async fn restarted_inflight_receipt_becomes_bound_uncertain_without_dispatch() {
    let fixture = Fixture::new();
    let raw = fixture.path("./a");
    let canonical = fixture.canonical(&raw);
    let ledger = fixture.ledger();
    let mut probe = AdmissionProbe::default();
    drop(probe.submit(&fixture, &ledger, &raw, "text", &[]));
    assert_eq!(probe.dispatches, 1);
    drop(ledger);
    let ledger = fixture.ledger();
    let recovered = body(receipt_response(
        &fixture.config(),
        &ledger,
        "exact-id",
        Some(&raw),
    ))
    .await;
    assert_binding(&recovered, &raw, &canonical);
    assert_eq!(recovered["receipt"]["state"], "uncertain");
    assert_eq!(recovered["receipt"]["code"], "interrupted_dispatch");
    let replay = probe.submit(&fixture, &ledger, &raw, "text", &[]);
    assert_eq!(body(replay).await["receipt"], recovered["receipt"]);
    assert_eq!((probe.attempts, probe.dispatches), (2, 1));
}

/// `max_children: 0` makes every open meet a full pool. The send is held
/// as `accepted`/`agents_busy` with a waiting sentence, not failed, and
/// the dispatcher keeps waiting for a slot instead of returning.
#[tokio::test]
async fn a_full_pool_holds_the_send_instead_of_failing_it() {
    let fixture = Fixture::new();
    let ledger = Arc::new(fixture.ledger());
    let children = ChildManager::new(Arc::new(fixture.config()));
    let session = fixture.path("held");
    ledger.submit("held-id", &session, "payload").unwrap();
    ledger
        .update("held-id", ReceiptState::Dispatching, None, None)
        .unwrap();
    let dispatch = tokio::spawn({
        let (children, ledger, session) =
            (Arc::clone(&children), Arc::clone(&ledger), session.clone());
        async move {
            let events = children.subscribe();
            dispatch_child_prompt(
                &children,
                &ledger,
                events,
                "held-id",
                &session,
                "hi",
                &[],
                crate::omp::child::PromptDelivery::Steer,
            )
            .await
            .0
        }
    });
    let mut held = None;
    for _ in 0..500 {
        let receipt = ledger.get("held-id").unwrap().unwrap();
        if matches!(receipt.state, ReceiptState::Accepted) {
            held = Some(receipt);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let held = held.expect("a full pool holds the send");
    assert_eq!(held.code.as_deref(), Some(crate::omp::child::AGENTS_BUSY));
    assert!(
        held.error
            .as_deref()
            .is_some_and(|e| e.starts_with("Waiting for a free agent."))
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!dispatch.is_finished(), "a held send waits for a slot");
    dispatch.abort();
}

#[tokio::test]
async fn a_full_pool_refusal_is_a_coded_sentence() {
    let response = child_error(&format!(
        "{}: {}",
        crate::omp::child::AGENTS_BUSY,
        crate::omp::child::agents_busy_sentence(6)
    ));
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body(response).await,
        json!({
            "ok": false,
            "code": "agents_busy",
            "error": "6 agents are working. Send again when one finishes, or stop one.",
        })
    );
    let other = child_error("agent process not running");
    assert_eq!(other.status(), StatusCode::OK);
    assert_eq!(body(other).await["error"], "agent process not running");
}
