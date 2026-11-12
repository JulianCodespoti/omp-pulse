//! Hermetic socket and HTTP transcript contract tests. No OMP process is used.

use super::*;
use futures_util::SinkExt;
use futures_util::StreamExt;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::protocol::Message;

fn fixture_agents() -> Value {
    json!([{"id":"agent-a", "displayName":"Agent A", "kind":"sub", "status":"running", "hasSessionFile":true, "createdAt":1234, "lastActivity":1234}])
}

/// A fresh fixture directory, canonical because the code under test
/// canonicalizes session paths: macOS temp sits behind the `/var` →
/// `/private/var` symlink and Windows temp is an 8.3 short name, so a raw
/// temp path never compares equal to what `resolve_session_path` returns.
/// Join below it by component: a canonical Windows path is verbatim
/// (`\\?\C:\…`), where `/` is not a separator.
fn fixture_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pulse-transcript-{label}-{}-{:x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(&dir).unwrap()
}

#[test]
fn transcript_listener_proof_rejects_external_and_unregistered_destinations() {
    let local = "127.0.0.1:50000".parse().unwrap();
    let bound = "127.0.0.1:12345".parse().unwrap();
    assert!(listener_is_destination(bound, bound, local));
    assert!(!listener_is_destination(
        bound,
        "127.0.0.1:12346".parse().unwrap(),
        local
    ));
    let any = "0.0.0.0:12345".parse().unwrap();
    assert!(listener_is_destination(any, bound, local));
    assert!(!listener_is_destination(
        any,
        "203.0.113.20:12345".parse().unwrap(),
        local
    ));
    assert!(!listener_is_destination(
        any,
        "[::1]:12345".parse().unwrap(),
        local
    ));
}

#[test]
fn transcript_parent_binding_requires_exact_header_and_unique_local_mapping() {
    let root = fixture_dir("parent");
    std::fs::create_dir_all(root.join("sessions").join("project")).unwrap();
    let path = root.join("sessions").join("project").join("one.jsonl");
    std::fs::write(&path, "{\"type\":\"session\",\"id\":\"parent-id\"}\n").unwrap();
    let mut cfg = super::tests::test_config();
    cfg.sessions_root = root.join("sessions");
    let welcome = json!({"header":{"id":"parent-id"}});
    assert!(welcome_matches_parent(
        &cfg,
        path.to_str().unwrap(),
        &welcome
    ));
    assert!(!welcome_matches_parent(
        &cfg,
        path.to_str().unwrap(),
        &json!({"header":{"id":"other"}})
    ));
    assert!(!welcome_matches_parent(
        &cfg,
        path.to_str().unwrap(),
        &json!({"header":{}})
    ));
    assert_eq!(
        resolve_session_path(&cfg, "parent-id"),
        Some(path.to_str().unwrap().to_owned())
    );
    std::fs::write(
        root.join("sessions")
            .join("project")
            .join("duplicate.jsonl"),
        "{\"type\":\"session\",\"id\":\"parent-id\"}\n",
    )
    .unwrap();
    assert!(resolve_session_path(&cfg, "parent-id").is_none());
    assert!(
        !welcome_matches_parent(&cfg, path.to_str().unwrap(), &welcome),
        "an explicit attach cannot select one of two identical header IDs"
    );
    std::fs::remove_dir_all(root).unwrap();
}

async fn http_request(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
) -> (u16, String, Value) {
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let authorization = token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\n{authorization}Connection: close\r\nContent-Length: 0\r\n\r\n").as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let raw = String::from_utf8(raw).unwrap();
    let (headers, body) = raw.split_once("\r\n\r\n").unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (
        status,
        headers.to_lowercase(),
        serde_json::from_str(body).unwrap(),
    )
}

#[tokio::test]
async fn transcript_authenticated_read_only_socket_roundtrip_preserves_bridge_writer() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let root = fixture_dir("roundtrip");
        std::fs::create_dir_all(root.join("sessions").join("project")).unwrap();
        let path = root.join("sessions").join("project").join("parent.jsonl");
        let parent_bytes = "{\"type\":\"session\",\"id\":\"parent-id\"}\n";
        std::fs::write(&path, parent_bytes).unwrap();
        let session = path.to_str().unwrap().to_owned();
        let mut cfg = super::tests::test_config();
        cfg.sessions_root = root.join("sessions");
        cfg.state_dir = root.join("state");
        cfg.home = root.clone();
        cfg.push_store_path = root.join("push.json");
        cfg.vapid_path = root.join("vapid.json");
        cfg.omp_bin = root.join("must-never-launch-omp");
        let cfg = Arc::new(cfg);
        let devices = Arc::new(crate::server::device_auth::DeviceRegistry::open(&cfg.state_dir).unwrap());
        let pairing = devices.issue_pairing_code(crate::server::device_auth::DeviceRole::Read, None).unwrap();
        let token = devices.redeem_pairing_code(&pairing.code, None).unwrap().token;
        let hub = WsHub::new(cfg.clone());
        let delta = DeltaEncoder::new();
        let push = Push::load(cfg.clone(), devices.clone()).unwrap();
        let links = LinkRegistry::load(&cfg);
        // No process-wide manager registration: parallel tests cannot redirect
        // this fixture to another test's relay or accidentally use a live daemon.
        let collab = Arc::new(CollabManager {
            hub: hub.clone(), delta: delta.clone(), push: push.clone(),
            sessions: Arc::new(Mutex::new(HashMap::new())), next_gen: AtomicU64::new(1),
            links: links.clone(), transcript_reads: Arc::new(transcript::Reads::default()),
        });
        let relay = Arc::new(RelayManager {
            listeners: Mutex::new(HashSet::new()), config: cfg.clone(),
            hub: hub.clone(), delta: delta.clone(), push: push.clone(),
            rooms: Arc::new(Mutex::new(HashMap::new())), next_gen: AtomicU64::new(1),
            next_peer: AtomicU32::new(2), links,
        });
        let authority = Arc::new(SessionStateRegistry::default());
        let bridge = SourceIdentity { kind: SourceKind::Bridge, source_id: 100, binding_epoch: 1,
            pid: Some(123), process_start: Some(1), peer_id: None, room_id: None, can_write: Some(true) };
        authority.project(&session, Seed {
            owner: bridge.wire_owner(), turn: Turn::Running, confidence: Confidence::Confirmed,
            connection: Connection::Connected, activity: None,
            capabilities: SessionStateRegistry::capabilities_for(&bridge), source: Some(bridge.clone()), sequence: 1,
        });
        let children = crate::omp::child::ChildManager::new(cfg.clone());
        let (watch_tx, _) = tokio::sync::broadcast::channel(4);
        let watcher = crate::sessions::watcher::Watcher::new(cfg.clone(), watch_tx, Arc::new(|_| false));
        let state = Arc::new(crate::server::http::AppState {
            cfg: cfg.clone(), children: children.clone(), session_states: authority.clone(),
            commands: Arc::new(crate::authority::command_ledger::CommandLedger::open(&cfg.state_dir).unwrap()),
            devices, hub: hub.clone(), watcher, push: push.clone(), collab: collab.clone(), relay: relay.clone(),
            asr: crate::server::asr::Asr::new(cfg.clone(), Some(children.clone())), https_origin: None,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        relay.register_listener(address);
        let router = crate::server::http::router(state);
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let room_id = "transcriptfixture";
        let (mut host, _) = connect_async(format!("ws://{address}/r/{room_id}?role=host")).await.unwrap();
        while !relay.rooms.lock().unwrap().contains_key(room_id) { tokio::task::yield_now().await; }
        let host_task = tokio::spawn(async move {
            let codec = Codec::new(&[7; 32]).unwrap();
            let mut requests = 0;
            while let Some(message) = host.next().await {
                let Message::Binary(bytes) = message.unwrap() else { continue };
                let (peer, payload) = unpack_envelope(&bytes).unwrap();
                let frame = codec.open(payload).unwrap();
                let reply = match frame["t"].as_str().unwrap() {
                    "hello" => {
                        assert!(frame.get("writeToken").is_none());
                        json!({"t":"welcome", "header":{"id":"parent-id"}, "agents":fixture_agents(), "entryCount":0})
                    }
                    "fetch-transcript" => {
                        requests += 1;
                        assert_eq!(frame["agentId"], "agent-a");
                        assert_eq!(frame["fromByte"], 0);
                        let text = "{\"type\":\"message\",\"text\":\"actual agent output 🦀\"}\n{\"partial\":";
                        json!({"t":"transcript", "reqId":frame["reqId"], "text":text, "newSize":text.len()})
                    }
                    other => panic!("unexpected write frame: {other}"),
                };
                host.send(Message::binary(pack_envelope(peer, codec.seal(&reply).unwrap()))).await.unwrap();
                if requests == 1 { break; }
            }
            // Keep the host alive until test cleanup, without model calls.
            std::future::pending::<()>().await;
        });
        let route = relay.capture_read_route(room_id).expect("capture before admission");
        let (guest, _) = connect_async(format!("ws://{address}/r/{room_id}?role=guest")).await.unwrap();
        assert!(route.verifies(&guest), "actual bound local relay route");
        let codec = Codec::new(&[7; 32]).unwrap();
        let (mut sink, mut stream) = guest.split();
        let (welcome, verified_host) = join_session(&mut sink, &mut stream, &codec, None).await.unwrap_or_else(|e| panic!("{}", e.message));
        assert!(verified_host && welcome_matches_parent(&cfg, &session, &welcome));
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
        let (shutdown, _) = watch::channel(false);
        register_tap_session(&collab, &session, None, frame_tx.clone(), shutdown);
        let mut source = CollabEventSource::begin(&session, room_id, 1, false, None);
        // This is the exact state of a collab mirror when the independently
        // verified bridge owns the writer: no collab event/write authority.
        source.authority = Some(authority.clone());
        assert!(!source.is_current());
        assert!(!source.accept_frame(HOST_PEER_ID, &json!({"t":"event", "event":{"type":"agent_end"}})));
        source.transcript = Some(collab.transcript_reads.connect(&session, source.identity.source_id,
            "parent-id", route.closed, &welcome["agents"], frame_tx));
        // The phone has not seen welcome or a live agents frame. Its first
        // authenticated visit can still recover the existing desktop roster.
        let roster_endpoint = format!("/api/agents/roster?session={session}");
        assert_eq!(http_request(address, "GET", &roster_endpoint, None).await.0, 401);
        let (status, headers, snapshot) = http_request(address, "GET", &roster_endpoint, Some(&token)).await;
        assert_eq!(status, 200); assert!(headers.contains("cache-control: no-store"));
        assert_eq!(snapshot["agents"][0]["id"], "agent-a");
        assert_eq!(snapshot["agents"][0]["createdAt"], 1234.0);
        assert!(snapshot["connectionId"].as_str().is_some());
        let (_viewer, mut roster_frames) = hub.attach(session.clone(), crate::server::ws::ClientCaps::default());
        let mut synced = false;
        forward_collab_frame(&mut source, HOST_PEER_ID, &delta, &hub, &push, &session,
            &json!({"t":"agents", "agents":fixture_agents()}), &mut synced);
        let roster: Value = serde_json::from_str(roster_frames.recv().await.unwrap().as_ref()).unwrap();
        assert_eq!(roster["event"]["type"], "collab_agents");
        assert_eq!(roster["event"]["agents"][0]["id"], "agent-a");
        forward_collab_frame(&mut source, HOST_PEER_ID, &delta, &hub, &push, &session,
            &json!({"t":"event", "event":{"type":"agent_end"}}), &mut synced);
        assert!(tokio::time::timeout(Duration::from_millis(10), roster_frames.recv()).await.is_err(), "bridge-owned turn events stay suppressed");
        assert!(!collab.can_write(&session));
        assert!(collab.send_prompt(&session, "must never send", vec![]).is_err());
        let guest_session = session.clone();
        let guest_task = tokio::spawn(async move {
            let mut synced = false;
            loop {
                tokio::select! {
                    Some(frame) = frame_rx.recv() => {
                        if transcript_dispatch_allowed(&source, &frame.payload) {
                            assert!(forward_outbound_frame(&mut sink, &codec, &guest_session, frame).await);
                        }
                    }
                    Some(message) = stream.next() => {
                        let Message::Binary(bytes) = message.unwrap() else { continue };
                        let (peer, payload) = unpack_envelope(&bytes).unwrap();
                        let frame = codec.open(payload).unwrap();
                        forward_collab_frame(&mut source, peer, &delta, &hub, &push, &guest_session, &frame, &mut synced);
                    }
                }
            }
        });
        let connection_id = snapshot["connectionId"].as_str().unwrap();
        let endpoint = format!("/api/agents/transcript?session={session}&agentId=agent-a&fromByte=0&expectedCreatedAt=1234&expectedConnectionId={connection_id}");
        let wrong_connection = format!("/api/agents/transcript?session={session}&agentId=agent-a&expectedConnectionId=old-connection");
        let (status, _, body) = http_request(address, "GET", &wrong_connection, Some(&token)).await;
        assert_eq!(status, 503); assert_eq!(body["code"], "host_unavailable");
        assert_eq!(http_request(address, "GET", &endpoint, None).await.0, 401);
        assert_eq!(http_request(address, "POST", "/api/prompt", Some(&token)).await.0, 403);
        for (query, status, code) in [
            ("fromByte=-1", 400, "invalid_request"),
            ("fromByte=1.5", 400, "invalid_request"),
            ("fromByte=9007199254740992", 400, "invalid_request"),
            ("fromByte=%2B1", 400, "invalid_request"),
            ("fromByte=1e3", 400, "invalid_request"),
            ("file=/tmp/guessed-child.jsonl", 400, "invalid_request"),
            ("expectedCreatedAt=NaN", 400, "invalid_request"),
        ] {
            let invalid = format!("/api/agents/transcript?session={session}&agentId=agent-a&{query}");
            let (got, _, body) = http_request(address, "GET", &invalid, Some(&token)).await;
            assert_eq!(got, status); assert_eq!(body["code"], code);
        }
        let missing = format!("/api/agents/transcript?session={session}&agentId=unknown");
        let (status, _, body) = http_request(address, "GET", &missing, Some(&token)).await;
        assert_eq!(status, 404); assert_eq!(body["code"], "transcript_unavailable");
        let changed = format!("/api/agents/transcript?session={session}&agentId=agent-a&expectedCreatedAt=999");
        let (status, _, body) = http_request(address, "GET", &changed, Some(&token)).await;
        assert_eq!(status, 409); assert_eq!(body["code"], "agent_changed");
        let (status, headers, body) = http_request(address, "GET", &endpoint, Some(&token)).await;
        assert_eq!(status, 200); assert!(headers.contains("cache-control: no-store"));
        assert_eq!(body["agentId"], "agent-a"); assert_eq!(body["fromByte"], 0);
        assert!(body["text"].as_str().unwrap().contains("actual agent output 🦀"));
        assert_eq!(body["nextByte"].as_u64().unwrap(), body["text"].as_str().unwrap().len() as u64);
        assert_eq!(body["reset"], false);
        assert_eq!(body["connectionId"], connection_id);
        assert_eq!(children.live_count(), 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), parent_bytes);
        assert_eq!(authority.current(&session).unwrap().owner, bridge.wire_owner());
        assert_eq!(authority.current(&session).unwrap().turn, Turn::Running);
        // Admission race: this socket joins the old host, which then genuinely
        // departs before a new host claims the room. Never bless the old socket
        // with the new room's lease even though the parent ID is unchanged.
        let old_route = relay.capture_read_route(room_id).unwrap();
        let (probe, _) = connect_async(format!("ws://{address}/r/{room_id}?role=guest")).await.unwrap();
        assert!(old_route.verifies(&probe));
        host_task.abort(); let _ = host_task.await;
        while relay.rooms.lock().unwrap_or_else(|p| p.into_inner()).contains_key(room_id) { tokio::task::yield_now().await; }
        let (replacement_host, _) = connect_async(format!("ws://{address}/r/{room_id}?role=host")).await.unwrap();
        while relay.rooms.lock().unwrap_or_else(|p| p.into_inner()).get(room_id).map(|room| room.generation == 1).unwrap_or(true) { tokio::task::yield_now().await; }
        assert!(!old_route.verifies(&probe));
        let (status, _, body) = http_request(address, "GET", &endpoint, Some(&token)).await;
        assert_eq!(status, 503); assert_eq!(body["code"], "host_unavailable");
        let (status, _, body) = http_request(address, "GET", &roster_endpoint, Some(&token)).await;
        assert_eq!(status, 503); assert_eq!(body["code"], "host_unavailable");
        drop(probe); drop(replacement_host);
        guest_task.abort(); let _ = guest_task.await;
        collab.detach(&session);
        teardown_room(&relay.rooms, room_id, 2, &collab.delta, &collab.hub, "test cleanup");
        server.abort(); let _ = server.await;
        std::fs::remove_dir_all(root).unwrap();
    }).await.expect("isolated transcript socket/API fixture must finish");
}
