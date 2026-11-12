use super::*;
use std::{fs, sync::Barrier};

struct Fixture {
    root: PathBuf,
    cfg: Config,
    session: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pulse-conditional-handler-{}-{:032x}",
            std::process::id(),
            rand::random::<u128>(),
        ));
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::create_dir(root.join("project")).unwrap();
        let session = root.join("sessions/synthetic.jsonl");
        fs::write(&session, format!("{}\n", json!({
            "type": "session", "version": 1, "id": "conditional-file-save", "cwd": root.join("project"),
        }))).unwrap();
        let cfg = Config {
            host: "127.0.0.1".into(),
            port: 0,
            sessions_root: root.join("sessions"),
            omp_bin: root.join("no-transport-executable"),
            public_dir: None,
            token_hash: None,
            max_children: 0,
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
        Self { root, cfg, session }
    }

    fn target(&self) -> PathBuf {
        self.root.join("project/file.txt")
    }

    fn request(&self, path: &str, content: Value, expected: Option<Value>) -> Response {
        let mut body = json!({ "sessionPath": self.session, "path": path, "content": content });
        if let Some(expected) = expected {
            body["expectedContent"] = expected;
        }
        post_file_sync(&self.cfg, Some(Json(body)))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

async fn decode(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn agent_write_after_the_client_read_is_a_conflict_not_an_overwrite() {
    let f = Fixture::new();
    fs::write(f.target(), "baseline").unwrap();
    let baseline = fs::read_to_string(f.target()).unwrap();
    fs::write(f.target(), "agent edit").unwrap();
    let (status, body) =
        decode(f.request("file.txt", json!("phone edit"), Some(json!(baseline)))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["ok"], false);
    assert_eq!(body["code"], "file_conflict");
    assert_eq!(fs::read_to_string(f.target()).unwrap(), "agent edit");
}

#[tokio::test]
async fn concurrent_handler_saves_authorise_only_one_snapshot() {
    let f = Fixture::new();
    fs::write(f.target(), "baseline").unwrap();
    let barrier = Barrier::new(3);
    let results = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            barrier.wait();
            f.request("file.txt", json!("first"), Some(json!("baseline")))
        });
        let second = scope.spawn(|| {
            barrier.wait();
            f.request("file.txt", json!("second"), Some(json!("baseline")))
        });
        barrier.wait();
        [first.join().unwrap(), second.join().unwrap()]
    });
    let [first, second] = results;
    let (a, _) = decode(first).await;
    let (b, _) = decode(second).await;
    assert!(matches!(
        (a, b),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
    assert_eq!(
        fs::read_to_string(f.target()).unwrap(),
        if a == StatusCode::OK {
            "first"
        } else {
            "second"
        }
    );
}

#[tokio::test]
async fn absent_or_malformed_preconditions_never_authorise_a_write() {
    let f = Fixture::new();
    fs::write(f.target(), "unchanged").unwrap();
    for (expected, status) in [
        (None, StatusCode::PRECONDITION_REQUIRED),
        (Some(json!(3)), StatusCode::BAD_REQUEST),
        (Some(json!(false)), StatusCode::BAD_REQUEST),
        (Some(json!({})), StatusCode::BAD_REQUEST),
        (Some(json!([])), StatusCode::BAD_REQUEST),
    ] {
        let (actual, body) = decode(f.request("file.txt", json!("draft"), expected.clone())).await;
        assert_eq!(actual, status);
        assert_eq!(body["ok"], false);
        assert_eq!(fs::read_to_string(f.target()).unwrap(), "unchanged");
        assert_eq!(
            f.request("missing/nested/new.txt", json!("draft"), expected)
                .status(),
            status
        );
        assert!(!f.root.join("project/missing").exists());
    }
}

#[tokio::test]
async fn successful_update_empty_save_and_explicit_creation_keep_the_contract() {
    let f = Fixture::new();
    fs::write(f.target(), "baseline").unwrap();
    for (content, expected) in [("  café 👋\n\t  ", "baseline"), ("", "  café 👋\n\t  ")] {
        assert_eq!(
            f.request("file.txt", json!(content), Some(json!(expected)))
                .status(),
            StatusCode::OK
        );
        assert_eq!(fs::read(f.target()).unwrap(), content.as_bytes());
    }
    assert_eq!(
        f.request("new/nested/file.txt", json!("new"), Some(Value::Null))
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        fs::read(f.root.join("project/new/nested/file.txt")).unwrap(),
        b"new"
    );
    assert_eq!(
        f.request("file.txt", json!("not new"), Some(Value::Null))
            .status(),
        StatusCode::CONFLICT
    );
    assert!(fs::read(f.target()).unwrap().is_empty());
}

#[tokio::test]
async fn validation_and_path_confinement_still_precede_file_mutation() {
    let f = Fixture::new();
    fs::write(f.target(), "baseline").unwrap();
    assert_eq!(
        f.request("file.txt", Value::Null, Some(json!("baseline")))
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.request("local://PLAN.md", json!("draft"), Some(Value::Null))
            .status(),
        StatusCode::FORBIDDEN
    );
    let (_, body) = decode(f.request("../outside.txt", json!("draft"), Some(Value::Null))).await;
    assert_eq!(body["ok"], false);
    assert!(!f.root.join("outside.txt").exists());
    assert_eq!(fs::read_to_string(f.target()).unwrap(), "baseline");
}

#[tokio::test]
async fn missing_project_never_redirects_a_save_into_home() {
    let f = Fixture::new();
    fs::remove_dir(f.root.join("project")).unwrap();
    let home_file = f.cfg.home.join("file.txt");
    fs::write(&home_file, "home untouched").unwrap();
    let (status, body) = decode(f.request(
        "file.txt",
        json!("project edit"),
        Some(json!("home untouched")),
    ))
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "project_folder_unavailable");
    assert_eq!(body["cwd"], json!(f.root.join("project")));
    assert_eq!(fs::read_to_string(&home_file).unwrap(), "home untouched");

    fs::create_dir(f.root.join("project")).unwrap();
    let (status, _) = decode(f.request("file.txt", json!("project edit"), Some(Value::Null))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fs::read_to_string(f.target()).unwrap(), "project edit");
    assert_eq!(fs::read_to_string(&home_file).unwrap(), "home untouched");
}

#[tokio::test]
async fn a_session_without_a_project_cannot_write_into_home() {
    let f = Fixture::new();
    fs::write(
        &f.session,
        "{\"type\":\"session\",\"version\":1,\"id\":\"missing-cwd\"}\n",
    )
    .unwrap();
    let (status, body) =
        decode(f.request("file.txt", json!("not a home file"), Some(Value::Null))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "project_folder_unavailable");
    assert!(body["cwd"].is_null());
    assert!(!f.cfg.home.join("file.txt").exists());
}
