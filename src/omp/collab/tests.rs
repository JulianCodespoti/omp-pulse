use super::*;
use crate::types::Config;

/// Older lifecycle-order assertions compare semantic frames; the revision and
/// question token are independently exercised by pending snapshot tests.
fn lifecycle_frame_body(frame: &str) -> Value {
    let mut frame: Value = serde_json::from_str(frame).unwrap();
    if let Some(event) = frame.get_mut("event").and_then(Value::as_object_mut) {
        event.remove("lifecycle");
        event.remove("pulseQuestionToken");
    }
    frame
}

#[test]
fn collab_source_rejects_guests_and_retired_transport_effects() {
    let registry = Arc::new(SessionStateRegistry::default());
    let session = "/tmp/collab-source-fence.jsonl";
    let mut old = CollabEventSource::begin(session, "room", 1, true, Some(registry.clone()));
    let start = json!({"t":"event","event":{"type":"agent_start"}});
    assert!(!old.accept_frame(2, &start));
    assert_eq!(registry.current(session).unwrap().turn, Turn::Unknown);
    assert!(old.accept_frame(HOST_PEER_ID, &start));
    assert!(old.accept_frame(
        HOST_PEER_ID,
        &json!({"t":"event","event":{"type":"agent_end","isTerminal":false}})
    ));
    assert_eq!(registry.current(session).unwrap().turn, Turn::Running);
    let mut current = CollabEventSource::begin(session, "room", 2, false, Some(registry.clone()));
    assert!(!old.accept_frame(
        HOST_PEER_ID,
        &json!({"t":"event","event":{"type":"agent_end"}})
    ));
    assert!(!old.accept_frame(
        HOST_PEER_ID,
        &json!({"t":"ui-request","request":{"reqId":1}})
    ));
    drop(old);
    let live = registry.current(session).unwrap();
    assert_eq!(live.turn, Turn::Running);
    assert_eq!(live.connection, Connection::Connected);
    assert!(!live.capabilities.send);
    assert!(current.accept_frame(
        HOST_PEER_ID,
        &json!({"t":"ui-request","request":{"reqId":2,"kind":"select"}})
    ));
    assert_eq!(
        registry.current(session).unwrap().pending_input.unwrap()["reqId"],
        2
    );
    assert!(current.accept_frame(HOST_PEER_ID, &json!({"t":"ui-request-end","reqId":2})));
    assert!(registry.current(session).unwrap().pending_input.is_none());
    drop(current);
    let lost = registry.current(session).unwrap();
    assert_eq!(lost.turn, Turn::Running);
    assert_eq!(lost.connection, Connection::Reconnecting);
}

#[test]
fn parse_all_link_grammar_forms() {
    // Canonical full wss link with write token (48-byte secret).
    let key = [7u8; 32];
    let token = [9u8; 16];
    let mut secret = key.to_vec();
    secret.extend_from_slice(&token);
    let room = "abcdefghijklmnop".to_string(); // 16 chars
    let secret_b64 = URL_SAFE_NO_PAD.encode(&secret);
    let key_b64 = URL_SAFE_NO_PAD.encode(key);

    // 1. Canonical: wss://host/r/<roomId>.<secret>
    let p = parse_collab_link(&format!("wss://my.omp.sh/r/{room}.{secret_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("wss://my.omp.sh/r/{room}"));
    assert_eq!(p.key, key);
    assert_eq!(p.write_token.as_deref(), Some(token.as_slice()));

    // 2. Bare `<roomId>.<secret>` → default relay.
    let p = parse_collab_link(&format!("{room}.{secret_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("wss://my.omp.sh/r/{room}"));
    assert!(p.write_token.is_some());

    // 3. Bare view link (32-byte secret) → no write token.
    let p = parse_collab_link(&format!("{room}.{key_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("wss://my.omp.sh/r/{room}"));
    assert_eq!(p.key, key);
    assert!(p.write_token.is_none());

    // 4. Legacy `<roomId>#<secret>`.
    let p = parse_collab_link(&format!("{room}#{key_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("wss://my.omp.sh/r/{room}"));

    // 5. `%23`-mangled legacy form.
    let p = parse_collab_link(&format!("{room}%23{key_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("wss://my.omp.sh/r/{room}"));

    // 6. Scheme-less `host[:port]/r/...` → implied wss.
    let p = parse_collab_link(&format!("relay.example.com/r/{room}.{key_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("wss://relay.example.com/r/{room}"));

    // 7. Scheme-less with port.
    let p = parse_collab_link(&format!("relay.example.com:8443/r/{room}.{key_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("wss://relay.example.com:8443/r/{room}"));

    // 8. Localhost ws:// full URL stays ws://.
    let p = parse_collab_link(&format!("ws://localhost:7681/r/{room}.{key_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("ws://localhost:7681/r/{room}"));

    // 9. Legacy fragment on a full path: /r/<roomId>#<key>.
    let p = parse_collab_link(&format!("wss://my.omp.sh/r/{room}#{key_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("wss://my.omp.sh/r/{room}"));

    // 10. Web deep link: http(s)://<relay>/#<collab-link> (recursion).
    let p = parse_collab_link(&format!("https://my.omp.sh/#{room}.{key_b64}")).unwrap();
    assert_eq!(p.ws_url, format!("wss://my.omp.sh/r/{room}"));

    // 11. Web deep link wrapping a scheme-less full path.
    let p = parse_collab_link(&format!(
        "https://my.omp.sh/#relay.example.com/r/{room}.{key_b64}"
    ))
    .unwrap();
    assert_eq!(p.ws_url, format!("wss://relay.example.com/r/{room}"));
}

#[test]
fn parse_rejects_invalid_links() {
    // Non-local plain ws.
    assert!(parse_collab_link("ws://my.omp.sh/r/abcdefghijklmnop.aaaa").is_err());
    // Key of wrong decoded length.
    assert!(parse_collab_link("wss://my.omp.sh/r/abcdefghijklmnop.YWJj").is_err());
    // No /r/ path, no fragment.
    assert!(parse_collab_link("wss://my.omp.sh/other").is_err());
    // Missing key part.
    assert!(parse_collab_link("wss://my.omp.sh/r/abcdefghijklmnop").is_err());
    // Garbage.
    assert!(parse_collab_link("not a link at all").is_err());
    // Unsupported scheme.
    assert!(parse_collab_link("ftp://my.omp.sh/r/abcdefghijklmnop.aaaa").is_err());
}

#[test]
fn link_authority_names_the_relay_without_the_key() {
    // Operator messages and logs carry the authority only: the room key
    // rides in the link's path, so echoing the link would leak it.
    assert_eq!(
        link_authority("ws://laptop.tail1234.ts.net:7682/r/room.KEYKEYKEY"),
        "ws://laptop.tail1234.ts.net:7682"
    );
    assert_eq!(
        link_authority("wss://my.omp.sh/r/room.KEY"),
        "wss://my.omp.sh"
    );
    // Web deep link: the OUTER relay is what the operator needs named.
    assert_eq!(
        link_authority("https://my.omp.sh/#ws://127.0.0.1:7682/r/room.KEY"),
        "https://my.omp.sh"
    );
    assert_eq!(link_authority("not a link at all"), "an unrecognised relay");
}

#[test]
fn envelope_round_trip() {
    let packed = pack_envelope(0, vec![1, 2, 3, 4]);
    assert_eq!(packed.len(), 8);
    assert_eq!(&packed[..4], &[0, 0, 0, 0]);
    let (peer, payload) = unpack_envelope(&packed).unwrap();
    assert_eq!(peer, 0);
    assert_eq!(payload, &[1, 2, 3, 4]);
    assert!(unpack_envelope(&[0, 0, 0]).is_none());

    // Sender id is echoed back by the relay as a non-zero peerId.
    let packed = pack_envelope(7, vec![9]);
    let (peer, payload) = unpack_envelope(&packed).unwrap();
    assert_eq!(peer, 7);
    assert_eq!(payload, &[9]);
}

#[test]
fn codec_seal_open_round_trip() {
    let mut key = [0u8; 32];
    rng().fill_bytes(&mut key);
    let codec = Codec::new(&key).unwrap();
    let frame = json!({"t": "agent-cmd", "cmd": "chat", "agentId": "a1", "text": "hi"});
    let sealed = codec.seal(&frame).unwrap();
    assert!(sealed.len() > IV_LENGTH);
    let opened = codec.open(&sealed).unwrap();
    assert_eq!(opened, frame);

    // Wrong key fails auth.
    let mut other = [0u8; 32];
    rng().fill_bytes(&mut other);
    let other_codec = Codec::new(&other).unwrap();
    assert!(other_codec.open(&sealed).is_err());

    // Tampering fails auth.
    let mut tampered = sealed.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01;
    assert!(codec.open(&tampered).is_err());

    // Envelope + codec end to end.
    let envelope = pack_envelope(0, sealed);
    let (peer, payload) = unpack_envelope(&envelope).unwrap();
    assert_eq!(peer, 0);
    assert_eq!(codec.open(payload).unwrap(), frame);
}

use crate::server::ws::ClientCaps;

/// Serializes every test that mutates the process-wide LINK_STATES: the
/// aggregation test asserts absolute summaries, which would race with
/// another test's transitions if they ran concurrently. Nothing else in
/// the test binary touches LINK_STATES (it is private to this module and
/// no guest task runs under tests), so the lock makes the assertions
/// deterministic.
static LINK_STATE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Test double for [`UiResponseSink`]: records every delivered answer
/// and reports success/failure per `ok`. Used by both flush tests (the
/// guest-attach flush and the tap-attach flush).
struct RecordingAnswerSink {
    delivered: Vec<(u64, Option<String>)>,
    ok: bool,
}
impl UiResponseSink for RecordingAnswerSink {
    async fn send_answer(&mut self, req_id: u64, value: Option<&str>) -> bool {
        self.delivered.push((req_id, value.map(str::to_string)));
        self.ok
    }
}

#[cfg(test)]
pub(super) fn test_config() -> Config {
    let tmp = std::env::temp_dir();
    Config {
        asr_python: None,
        asr_model_dir: None,
        asr_threads: 6,
        host: "127.0.0.1".into(),
        port: 0,
        sessions_root: tmp.clone(),
        omp_bin: tmp.clone(),
        public_dir: None,
        token_hash: None,
        max_children: 1,
        push_store_path: tmp.clone(),
        // Per-process VAPID file: Push::load generates a throwaway
        // keypair on first run; a pid-suffixed name avoids cross-test
        // races within one process.
        vapid_path: tmp.join(format!("omp-pulse-vapid-test-{}.json", std::process::id())),
        state_dir: tmp.clone(),
        home: tmp.clone(),
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
    }
}
pub(super) fn test_push(cfg: &SharedConfig) -> Arc<Push> {
    let devices = Arc::new(
        crate::server::device_auth::DeviceRegistry::open(&cfg.state_dir)
            .expect("throwaway device registry"),
    );
    Push::load(Arc::clone(cfg), devices).expect("throwaway vapid keys generate")
}

mod link_state;
mod relay_cleanup;
mod relay_output_budget;
mod relay_tap;
mod transcript_contract;
