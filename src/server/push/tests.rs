use super::*;
use p256::ecdsa::SigningKey;

/// The SSE fan-out is fed from the single `notify_with_req_id` site, so
/// the debounce gate covers both Web Push and SSE. If the gate admits,
/// both transports see the payload; if it rejects, neither does.
#[tokio::test]
async fn sse_and_web_push_share_one_gate() {
    let push = Push::for_test();
    // No Web Push subscriptions — the channel has no subscriber yet.
    // notify_with_req_id must still publish to the SSE ring (the gate
    // is outside notify; empty subs must not suppress SSE).
    let session = format!("/tmp/sse-gate-{}.jsonl", rand::random::<u32>());
    push.notify(&session, "T", "B", KIND_AGENT_END).await;
    // Even with no Web Push subs, the SSE ring should have one entry.
    let history = push.notify_history(None);
    assert_eq!(
        history.len(),
        1,
        "SSE must receive even when Web Push has no subs"
    );
    assert_eq!(history[0].payload["kind"], KIND_AGENT_END);
    assert_eq!(history[0].payload["sessionPath"], session);
    // A subscription opened before the publish receives it live. The
    // subscription owns replay + live, so the ring alone is not the
    // whole delivery path any more.
    let push2 = Push::for_test();
    let mut sub = push2.subscribe_notifications(None);
    let session2 = format!("/tmp/sse-gate2-{}.jsonl", rand::random::<u32>());
    push2.notify(&session2, "T", "B", KIND_AGENT_END).await;
    // notify publishes synchronously inside the call, so the event is
    // already on the live receiver before this await starts.
    let env = tokio::time::timeout(Duration::from_millis(200), sub.next())
        .await
        .expect("should receive the live notification")
        .expect("subscription still open");
    assert_eq!(env.payload["kind"], KIND_AGENT_END);
    assert_eq!(env.payload["sessionPath"], session2);
}

/// A publication landing between a subscription's live subscribe and its
/// history snapshot is the notification this stream used to lose: reading
/// the ring first meant the event was published after the read and before
/// the subscribe, so it was in neither source and the phone simply never
/// buzzed. Subscribe-before-snapshot puts it in both, and the id — not the
/// payload — is what stops the client seeing it twice.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publication_racing_the_subscribe_is_delivered_exactly_once() {
    let push = Push::for_test();
    push.test_publish(json!({"n": 0}));

    // Arm the seam: this publisher runs once the subscription has
    // subscribed and before it snapshots the ring.
    let rendezvous = push.arm_publish_race();
    let publisher = {
        let push = Arc::clone(&push);
        std::thread::spawn(move || {
            rendezvous.wait();
            let id = push.test_publish(json!({"n": 1}));
            rendezvous.wait();
            id
        })
    };
    let mut sub = push.subscribe_notifications(None);
    let raced = publisher.join().expect("publisher thread");

    let delivered = tokio::time::timeout(Duration::from_millis(500), async {
        let mut ids = Vec::new();
        for _ in 0..2 {
            ids.push(sub.next().await.expect("stream open").id);
        }
        ids
    })
    .await
    .expect("both notifications delivered");
    assert_eq!(
        delivered,
        vec![raced - 1, raced],
        "the racing notification arrives once, and the phone's cursor moves once"
    );

    // The live copy of the raced id must not become a second buzz: the
    // next event after the replay window is the one published now.
    let live = push.test_publish(json!({"n": 2}));
    let next = tokio::time::timeout(Duration::from_millis(500), sub.next())
        .await
        .expect("live delivery resumes")
        .expect("stream open");
    assert_eq!(next.id, live, "replay did not duplicate the raced id");
}

/// Ids are handed out, retained and broadcast as one step, so concurrent
/// publishers cannot number out of order or retain a window whose order
/// disagrees with the ids a client deduplicates on.
#[test]
fn concurrent_publishes_number_and_retain_in_one_order() {
    let push = Push::for_test();
    let publishers: Vec<_> = (0..4)
        .map(|thread| {
            let push = Arc::clone(&push);
            std::thread::spawn(move || {
                (0..250)
                    .map(|n| push.test_publish(json!({"t": thread, "n": n})))
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let mut assigned: Vec<u64> = publishers
        .into_iter()
        .flat_map(|p| p.join().expect("publisher thread"))
        .collect();
    assigned.sort_unstable();
    assert_eq!(assigned.len(), 4 * 250, "every publish was numbered");
    assert!(
        assigned.windows(2).all(|w| w[1] > w[0]),
        "no id is handed out twice and none is skipped"
    );
    let ring = push.notify_history(None);
    assert_eq!(ring.len(), NOTIFY_RING_CAPACITY, "ring stays bounded");
    assert!(
        ring.windows(2).all(|w| w[1].id > w[0].id),
        "retained ids ascend: {:?}",
        ring.iter().map(|e| e.id).collect::<Vec<_>>()
    );
    assert_eq!(
        *assigned.last().expect("published"),
        ring[ring.len() - 1].id,
        "the newest id is the last one retained"
    );
}

/// A subscriber that falls behind the broadcast used to `continue` past
/// the `Lagged` error and silently lose everything the channel had
/// dropped. The retained window still holds those notifications, so the
/// subscription replays them — bounded by the ring, never more.
#[tokio::test]
async fn lagged_subscriber_replays_the_retained_window_instead_of_skipping() {
    let push = Push::for_test();
    let first_id = push.test_publish(json!({"n": "first"}));
    // Subscribing after that publish: the subscriber is served the retained
    // entry by replay, and its live receiver starts at the next id.
    let mut sub = push.subscribe_notifications(None);
    let first = tokio::time::timeout(Duration::from_millis(500), sub.next())
        .await
        .expect("replay does not block")
        .expect("retained entry");
    assert_eq!(first.id, first_id);

    // Overflow the broadcast without reading: the receiver is now behind
    // by more than NOTIFY_CHANNEL_CAPACITY.
    for n in 0..(NOTIFY_CHANNEL_CAPACITY + 5) {
        push.test_publish(json!({"n": n}));
    }
    let retained: Vec<u64> = push.notify_history(None).iter().map(|e| e.id).collect();
    assert_eq!(retained.len(), NOTIFY_RING_CAPACITY, "ring is bounded");
    let last_retained = *retained.last().expect("retained window");

    let recovered = tokio::time::timeout(Duration::from_millis(500), async {
        let mut ids = vec![first.id];
        for _ in 0..retained.len() {
            ids.push(sub.next().await.expect("stream open").id);
        }
        ids
    })
    .await
    .expect("the dropped window is replayed rather than skipped");
    assert_eq!(
        recovered,
        [vec![first.id], retained].concat(),
        "lag recovers exactly the retained window, each id once"
    );

    // The stream is still live afterwards, and the replayed ids are not
    // repeated as live traffic arrives. This goes through the real Web
    // Push entry point, which is also the claim that a lagging
    // subscriber never blocks the sender.
    let session = format!("/tmp/notify-after-lag-{}.jsonl", rand::random::<u32>());
    push.notify(&session, "T", "B", KIND_AGENT_END).await;
    let live = tokio::time::timeout(Duration::from_millis(500), sub.next())
        .await
        .expect("live delivery resumes")
        .expect("stream open");
    assert_eq!(live.payload["sessionPath"], session);
    assert!(
        live.id > last_retained,
        "the replayed window is not replayed again as live traffic"
    );
}

/// Replay promises the retained window and nothing wider. A phone that
/// was away for more notifications than the ring holds gets the newest
/// ones, not a fabricated complete history.
#[tokio::test]
async fn subscription_offers_nothing_beyond_retention() {
    let push = Push::for_test();
    let mut last = 0;
    for n in 0..40 {
        last = push.test_publish(json!({"n": n}));
    }
    let mut sub = push.subscribe_notifications(Some(1));
    let mut replayed = Vec::new();
    for _ in 0..NOTIFY_RING_CAPACITY {
        replayed.push(sub.next().await.expect("stream open").id);
    }
    assert_eq!(
        replayed.first().copied(),
        Some(last - NOTIFY_RING_CAPACITY as u64 + 1),
        "replay starts at the oldest retained id"
    );
    assert_eq!(replayed.last().copied(), Some(last));
    let beyond = tokio::time::timeout(Duration::from_millis(100), sub.next()).await;
    assert!(
        beyond.is_err(),
        "an id older than retention is never invented, and the stream simply waits for live traffic"
    );
}

/// Replay returns only notifications newer than `Last-Event-ID` and the
/// ring is bounded to NOTIFY_RING_CAPACITY.
#[test]
fn replay_filters_by_last_event_id_and_is_bounded() {
    let push = Push::for_test();
    let mut ids = Vec::new();
    for i in 0..30 {
        let id = push.test_publish(json!({"n": i}));
        ids.push(id);
    }
    // Ring is bounded to 20 — only the last 20 retained.
    let all = push.notify_history(None);
    assert_eq!(all.len(), NOTIFY_RING_CAPACITY, "ring must be bounded");
    assert_eq!(all[0].id, ids[ids.len() - NOTIFY_RING_CAPACITY]);
    assert_eq!(all[all.len() - 1].id, ids[ids.len() - 1]);
    // Filter by Last-Event-ID: only id > last.
    let after = ids[ids.len() - 10];
    let filtered = push.notify_history(Some(after));
    assert_eq!(filtered.len(), 9, "should return only > after");
    for e in &filtered {
        assert!(e.id > after);
    }
    // After the latest id, nothing.
    let empty = push.notify_history(Some(ids[ids.len() - 1]));
    assert!(empty.is_empty());
    // After 0 (before any id) returns all (ids start at 1).
    let all_from_zero = push.notify_history(Some(0));
    assert_eq!(all_from_zero.len(), NOTIFY_RING_CAPACITY);
    // None returns all retained.
    let none = push.notify_history(None);
    assert_eq!(none.len(), NOTIFY_RING_CAPACITY);
}
fn test_subscription(endpoint: &str) -> Value {
    json!({
        "endpoint": endpoint,
        "keys": {
            "p256dh": b64url_encode(
                SigningKey::from_slice(&[11u8; 32])
                    .unwrap()
                    .verifying_key()
                    .to_encoded_point(false)
                    .as_bytes()
            ),
            "auth": b64url_encode(b"authsecret123456"),
        }
    })
}

/// Legacy session buckets contain no authenticated binding and are
/// discarded rather than copied into the current store.
#[test]
fn legacy_store_discards_unbound_endpoints() {
    let first = test_subscription("https://fcm.example/one");
    let second = test_subscription("https://fcm.example/two");
    let duplicate = test_subscription("https://fcm.example/one");
    let legacy = json!({
        "/sessions/one.jsonl": [first],
        "/sessions/two.jsonl": [second, duplicate],
    });
    let (store, migrated) = parse_store(&legacy.to_string()).expect("legacy store parses");
    assert!(migrated);
    assert!(
        store
            .get(DEVICE_SCOPE)
            .is_none_or(|devices| devices.is_empty()),
        "unbound legacy endpoints must not survive migration"
    );

    let current = serialise_store(&store);
    assert_eq!(current["version"], PUSH_STORE_VERSION);
    assert!(current["devices"].as_array().unwrap().is_empty());
    assert!(current.get("/sessions/one.jsonl").is_none());
}

/// A subscription added while one session is open is sent from the
/// device bucket for a never-opened session, and a simulated provider 410
/// removes it durably rather than retrying it forever.
#[test]
fn device_scope_encrypts_and_prunes_gone_endpoint() {
    let push = Push::for_test();
    let endpoint = "https://fcm.example/device";
    let subscription = test_subscription(endpoint);
    push.subscribe(&subscription, &PushPrincipal::Owner)
        .expect("device subscription persists");

    let payload = push_payload(
        "Never opened",
        "Reply summary",
        "/sessions/never-opened.jsonl",
        KIND_AGENT_END,
        None,
    );
    let payload_bytes = serde_json::to_vec(&payload).unwrap();
    let (_, p256dh, auth) = subscription_keys(&subscription).unwrap();
    let encrypted = encrypt_payload(&p256dh, &auth, &payload_bytes).expect("payload encrypts");
    assert!(encrypted.len() > payload_bytes.len());
    assert_eq!(payload["sessionPath"], "/sessions/never-opened.jsonl");

    let gone = ureq::Error::StatusCode(410);
    assert!(push.prune_if_dead("/sessions/never-opened.jsonl", endpoint, &gone));
    assert!(!push.has_device_subscription());
    let persisted: Value =
        serde_json::from_str(&fs::read_to_string(&push.store_path).unwrap()).unwrap();
    assert_eq!(persisted["version"], PUSH_STORE_VERSION);
    assert!(persisted["devices"].as_array().unwrap().is_empty());
}
/// Browser metadata cannot choose its owner. Active endpoint conflicts are
/// rejected, while a revoked previous device permits deliberate
/// same-browser re-enrollment; revoked devices become ineligible without
/// any provider call.
#[test]
fn subscription_identity_is_authenticated_and_revocation_gates_delivery() {
    let registry_dir =
        std::env::temp_dir().join(format!("omp-pulse-push-registry-{}", rand::random::<u64>()));
    let registry = Arc::new(DeviceRegistry::open(&registry_dir).unwrap());
    let code_a = registry
        .issue_pairing_code(crate::server::device_auth::DeviceRole::Control, Some("A"))
        .unwrap();
    let device_a = registry.redeem_pairing_code(&code_a.code, None).unwrap();
    let code_b = registry
        .issue_pairing_code(crate::server::device_auth::DeviceRole::Control, Some("B"))
        .unwrap();
    let device_b = registry.redeem_pairing_code(&code_b.code, None).unwrap();

    let mut push = Push::for_test();
    Arc::get_mut(&mut push)
        .expect("test Push has one owner")
        .devices = Arc::clone(&registry);
    let endpoint = "https://fcm.example/re-enroll";
    let mut subscription = test_subscription(endpoint);
    subscription[SUBSCRIPTION_DEVICE_ID] = json!(device_b.device.id.clone());
    subscription[SUBSCRIPTION_OWNER_HASH] = json!("attacker-controlled");
    let principal_a = PushPrincipal::Device(device_a.device.id.clone());
    let principal_b = PushPrincipal::Device(device_b.device.id.clone());

    push.subscribe(&subscription, &principal_a).unwrap();
    let saved = {
        let guard = push.store.lock().unwrap_or_else(|p| p.into_inner());
        guard[DEVICE_SCOPE][0].clone()
    };
    assert_eq!(saved["deviceId"], device_a.device.id);
    assert!(saved.get(SUBSCRIPTION_OWNER_HASH).is_none());

    assert_eq!(
        push.subscribe(&subscription, &principal_b).unwrap_err(),
        SUBSCRIPTION_OWNERSHIP_CONFLICT
    );
    assert!(push.has_subscription(&principal_a));
    assert!(registry.revoke(&device_a.device.id).unwrap());
    assert!(!push.has_subscription(&principal_a));
    push.subscribe(&subscription, &principal_b)
        .expect("revoked endpoint may be re-enrolled");
    assert!(push.has_subscription(&principal_b));

    let _ = std::fs::remove_dir_all(registry_dir);
}
