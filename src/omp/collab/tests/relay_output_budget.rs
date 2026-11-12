//! Output budget and retirement tests use no sockets or running application.
use super::*;
use axum::body::Bytes;
use axum::extract::ws::Message as WsMessage;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::task::{AbortHandle, JoinHandle};
use tokio_tungstenite::tungstenite::protocol::Message;

struct PendingSink {
    started: Option<oneshot::Sender<()>>,
}
impl futures_util::Sink<WsMessage> for PendingSink {
    type Error = ();
    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Ok(()))
    }
    fn start_send(mut self: Pin<&mut Self>, _: WsMessage) -> Result<(), ()> {
        if let Some(started) = self.started.take() {
            let _ = started.send(());
        }
        Ok(())
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Pending
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Pending
    }
}
struct ErrorSink;
impl futures_util::Sink<WsMessage> for ErrorSink {
    type Error = ();
    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Err(()))
    }
    fn start_send(self: Pin<&mut Self>, _: WsMessage) -> Result<(), ()> {
        unreachable!()
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Err(()))
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Err(()))
    }
}

#[tokio::test]
async fn blocked_writer_holds_in_flight_charge_until_cancellation() {
    let (tx, rx) = relay_output::channel_with_limits(2, 6);
    tx.send(RouteFrame::Binary(Bytes::from_static(b"abc")))
        .unwrap();
    let (started, ready) = oneshot::channel();
    let task = tokio::spawn(peer_writer(
        PendingSink {
            started: Some(started),
        },
        rx,
    ));
    ready.await.unwrap();
    assert_eq!(tx.usage(), (1, 3));
    tx.send(RouteFrame::Text("def".into())).unwrap();
    assert_eq!(tx.usage(), (2, 6));
    assert_eq!(
        tx.send(RouteFrame::Text("".into())),
        Err(relay_output::SendError::Overloaded)
    );
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(tx.usage(), (0, 0));
    assert!(tx.is_closed());
}

#[tokio::test]
async fn writer_error_releases_current_and_queued_reservations() {
    let (tx, rx) = relay_output::channel();
    for _ in 0..4 {
        tx.send(RouteFrame::Text("payload".into())).unwrap();
    }
    peer_writer(ErrorSink, rx).await;
    assert_eq!(tx.usage(), (0, 0));
    assert!(tx.is_closed());
}

fn pending() -> JoinHandle<()> {
    tokio::spawn(std::future::pending())
}
struct Fixture {
    rooms: Arc<Mutex<HashMap<String, RelayRoom>>>,
    receivers: HashMap<u32, relay_output::Receiver>,
    senders: HashMap<u32, relay_output::Sender>,
    tasks: HashMap<u32, (AbortHandle, AbortHandle)>,
}
impl Fixture {
    fn new(generation: u64, limits: &[(u32, usize, usize)]) -> Self {
        let mut peers = HashMap::new();
        let mut receivers = HashMap::new();
        let mut senders = HashMap::new();
        let mut tasks = HashMap::new();
        for &(id, count, bytes) in limits {
            let (tx, rx) = relay_output::channel_with_limits(count, bytes);
            let writer = pending();
            let reader = pending();
            tasks.insert(id, (writer.abort_handle(), reader.abort_handle()));
            receivers.insert(id, rx);
            senders.insert(id, tx.clone());
            peers.insert(
                id,
                RelayPeer {
                    id,
                    name: id.to_string(),
                    tx,
                    writer,
                    reader,
                },
            );
        }
        let (notify, _) = watch::channel(false);
        let (events, _) = mpsc::unbounded_channel();
        let room = RelayRoom {
            generation,
            session_path: None,
            notify,
            task: pending(),
            events,
            peers,
            tap_gen: 0,
        };
        Self {
            rooms: Arc::new(Mutex::new(HashMap::from([("room".into(), room)]))),
            receivers,
            senders,
            tasks,
        }
    }
    fn route(&self, generation: u64, sender: u32, target: u32, payload: &[u8]) -> bool {
        let failed = route_binary_frame(
            &self.rooms,
            "room",
            generation,
            sender,
            pack_envelope(target, payload.to_vec()).into(),
        );
        retire_failed_outputs(&self.rooms, "room", generation, failed)
    }
    fn frame(&mut self, id: u32) -> RouteFrame {
        self.receivers
            .get_mut(&id)
            .unwrap()
            .try_recv()
            .unwrap()
            .frame
    }
    fn ids(&self) -> Vec<u32> {
        let mut ids: Vec<_> = self.rooms.lock().unwrap()["room"]
            .peers
            .keys()
            .copied()
            .collect();
        ids.sort_unstable();
        ids
    }
    async fn cancelled(&self, id: u32) {
        let (writer, reader) = &self.tasks[&id];
        tokio::time::timeout(Duration::from_secs(1), async {
            while !writer.is_finished() || !reader.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("removed peer tasks must terminate");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for (_, room) in self.rooms.lock().unwrap().drain() {
            room.abort_tasks();
        }
    }
}

#[tokio::test]
async fn overflowing_guest_isolated_while_healthy_broadcast_remains_intact() {
    let mut f = Fixture::new(7, &[(1, 16, 1024), (2, 1, 8), (3, 16, 1024)]);
    assert!(!f.route(7, 1, 0, b"abcd"));
    let _ = f.frame(3);
    assert!(!f.route(7, 1, 0, b"efgh"));
    assert_eq!(f.ids(), vec![1, 3]);
    assert!(f.senders[&2].is_closed());
    assert_eq!(
        f.senders[&2].send(RouteFrame::Text("late".into())),
        Err(relay_output::SendError::Closed)
    );
    let RouteFrame::Binary(frame) = f.frame(3) else {
        panic!("healthy binary")
    };
    assert_eq!(unpack_envelope(&frame), Some((1, &b"efgh"[..])));
    for id in [1, 3] {
        let RouteFrame::Text(frame) = f.frame(id) else {
            panic!("peer-left")
        };
        let value: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(value["t"], "peer-left");
        assert_eq!(value["peer"]["id"], 2);
        assert!(!f.tasks[&id].0.is_finished());
    }
    f.cancelled(2).await;
}

#[tokio::test]
async fn peer_left_cascades_remove_each_slow_guest_without_recursion() {
    let mut f = Fixture::new(7, &[(1, 16, 4096), (2, 1, 8), (3, 1, 8), (4, 16, 4096)]);
    assert!(!f.route(7, 1, 2, b"abcd"));
    assert!(!f.route(7, 1, 3, b"abcd"));
    assert!(!f.route(7, 1, 2, b"abcd"));
    assert_eq!(f.ids(), vec![1, 4]);
    let mut removed = Vec::new();
    for _ in 0..2 {
        let RouteFrame::Text(frame) = f.frame(1) else {
            panic!("peer-left")
        };
        removed.push(
            serde_json::from_str::<Value>(&frame).unwrap()["peer"]["id"]
                .as_u64()
                .unwrap(),
        );
    }
    removed.sort_unstable();
    assert_eq!(removed, vec![2, 3]);
    f.cancelled(2).await;
    f.cancelled(3).await;
}

#[tokio::test]
async fn host_overflow_closes_all_admission_then_tears_down_only_current_generation() {
    let f = Fixture::new(7, &[(1, 1, 8), (2, 16, 1024), (3, 16, 1024)]);
    assert!(!f.route(7, 2, 0, b"abcd"));
    assert!(f.route(7, 2, 0, b"efgh"));
    assert!(
        !f.rooms.lock().unwrap()["room"].has_live_host(),
        "guest admission must reject the failed host"
    );
    for tx in f.senders.values() {
        assert!(tx.is_closed());
    }
    let hub = WsHub::new(Arc::new(tests::test_config()));
    let delta = DeltaEncoder::new();
    teardown_room(&f.rooms, "room", 7, &delta, &hub, "host output unavailable");
    assert!(f.rooms.lock().unwrap().is_empty());
    for id in [1, 2, 3] {
        f.cancelled(id).await;
    }
}

#[tokio::test]
async fn stale_binary_control_disconnect_and_overload_leave_replacement_untouched() {
    let f = Fixture::new(8, &[(1, 16, 1024), (2, 16, 1024)]);
    assert!(!f.route(7, 1, 0, b"stale"));
    assert!(route_frame(&f.rooms, "room", 7, 1, RouteFrame::Text("stale".into())).is_empty());
    assert!(remove_relay_guest(&f.rooms, "room", 7, 2).is_none());
    assert!(!retire_failed_outputs(&f.rooms, "room", 7, vec![1, 2]));
    let hub = WsHub::new(Arc::new(tests::test_config()));
    teardown_room(&f.rooms, "room", 7, &DeltaEncoder::new(), &hub, "stale");
    assert_eq!(f.ids(), vec![1, 2]);
    for tx in f.senders.values() {
        assert!(!tx.is_closed());
        assert_eq!(tx.usage(), (0, 0));
    }
}

#[tokio::test]
async fn join_control_uses_same_budget_and_can_fail_host() {
    let f = Fixture::new(7, &[(1, 16, 1), (2, 16, 1024)]);
    let captured = vec![(1, f.senders[&1].clone())];
    let failed = send_peer_frames(captured, RouteFrame::Text("peer-joined".into()));
    assert_eq!(failed, vec![1]);
    assert!(retire_failed_outputs(&f.rooms, "room", 7, failed));
    assert!(!f.rooms.lock().unwrap()["room"].has_live_host());
    assert!(f.senders[&2].is_closed());
}

#[tokio::test]
async fn room_retirement_closes_sender_clones_before_task_cancellation_runs() {
    let f = Fixture::new(7, &[(1, 16, 1024), (2, 16, 1024)]);
    let removed = {
        let mut rooms = f.rooms.lock().unwrap();
        let room = rooms.remove("room").unwrap();
        room.close_outputs();
        room
    };
    for tx in f.senders.values() {
        assert_eq!(
            tx.send(RouteFrame::Text("captured".into())),
            Err(relay_output::SendError::Closed)
        );
    }
    removed.abort_tasks();
    for id in [1, 2] {
        f.cancelled(id).await;
    }
}

struct RecordingSink<M> {
    frames: Arc<Mutex<Vec<M>>>,
    pending: bool,
    fail: bool,
    started: Option<oneshot::Sender<()>>,
}
impl<M: Unpin> futures_util::Sink<M> for RecordingSink<M> {
    type Error = ();
    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(if self.fail { Err(()) } else { Ok(()) })
    }
    fn start_send(mut self: Pin<&mut Self>, frame: M) -> Result<(), ()> {
        self.frames.lock().unwrap().push(frame);
        if let Some(started) = self.started.take() {
            let _ = started.send(());
        }
        Ok(())
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        if self.pending {
            Poll::Pending
        } else {
            Poll::Ready(Ok(()))
        }
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn successful_writer_preserves_fifo_and_releases_every_reservation() {
    let frames = Arc::new(Mutex::new(Vec::new()));
    let sink = RecordingSink {
        frames: frames.clone(),
        pending: false,
        fail: false,
        started: None,
    };
    let (tx, rx) = relay_output::channel();
    tx.send(RouteFrame::Binary(Bytes::from_static(b"first")))
        .unwrap();
    tx.send(RouteFrame::Text("second".into())).unwrap();
    tx.send(RouteFrame::Close(4001)).unwrap();
    let task = tokio::spawn(peer_writer(sink, rx));
    tokio::time::timeout(Duration::from_secs(1), async {
        while tx.usage() != (0, 0) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("successful writes release all charges");
    {
        let sent = frames.lock().unwrap();
        assert!(matches!(&sent[0], WsMessage::Binary(b) if &b[..] == b"first"));
        assert!(matches!(&sent[1], WsMessage::Text(t) if t.as_str() == "second"));
        assert!(matches!(&sent[2], WsMessage::Close(Some(f)) if f.code == 4001));
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn overflow_cleanup_cancels_actual_blocked_writer_and_releases_its_backlog() {
    let mut f = Fixture::new(7, &[(1, 16, 1024), (2, 2, 16), (3, 16, 1024)]);
    let rx = f.receivers.remove(&2).unwrap();
    let (started, ready) = oneshot::channel();
    let writer = tokio::spawn(peer_writer(
        PendingSink {
            started: Some(started),
        },
        rx,
    ));
    f.tasks.get_mut(&2).unwrap().0 = writer.abort_handle();
    let old = {
        let mut rooms = f.rooms.lock().unwrap();
        std::mem::replace(
            &mut rooms
                .get_mut("room")
                .unwrap()
                .peers
                .get_mut(&2)
                .unwrap()
                .writer,
            writer,
        )
    };
    old.abort();
    assert!(!f.route(7, 1, 2, b"abcd"));
    ready.await.unwrap();
    assert_eq!(f.senders[&2].usage(), (1, 8));
    assert!(!f.route(7, 1, 2, b"efgh"));
    assert_eq!(f.senders[&2].usage(), (2, 16));
    assert!(!f.route(7, 1, 2, b"ijkl"));
    f.cancelled(2).await;
    assert_eq!(f.senders[&2].usage(), (0, 0));
    assert_eq!(f.ids(), vec![1, 3]);
}

#[tokio::test]
async fn join_triggered_host_teardown_cancels_router_and_releases_event_receiver() {
    let f = Fixture::new(7, &[(1, 16, 1), (2, 16, 1024)]);
    let (events, receiver) = mpsc::unbounded_channel::<PeerEvent>();
    let (held, released) = oneshot::channel::<()>();
    let router = tokio::spawn(async move {
        let _events = receiver;
        let _held = held;
        std::future::pending::<()>().await;
    });
    let router_abort = router.abort_handle();
    {
        let mut rooms = f.rooms.lock().unwrap();
        let room = rooms.get_mut("room").unwrap();
        room.task.abort();
        room.task = router;
        room.events = events.clone();
    }
    let failed = send_peer_frames(
        vec![(1, f.senders[&1].clone())],
        RouteFrame::Text("peer-joined".into()),
    );
    assert!(retire_failed_outputs(&f.rooms, "room", 7, failed));
    let hub = WsHub::new(Arc::new(tests::test_config()));
    teardown_room(
        &f.rooms,
        "room",
        7,
        &DeltaEncoder::new(),
        &hub,
        "host output unavailable",
    );
    tokio::time::timeout(Duration::from_secs(1), released)
        .await
        .unwrap()
        .expect_err("router released resource");
    assert!(router_abort.is_finished());
    assert!(events.is_closed());
    assert!(f.rooms.lock().unwrap().is_empty());
}

#[tokio::test]
async fn closed_host_writer_is_retired_instead_of_silently_ignoring_guest_input() {
    let mut f = Fixture::new(7, &[(1, 16, 1024), (2, 16, 1024)]);
    drop(f.receivers.remove(&1).unwrap());
    assert!(f.route(7, 2, 0, b"command"));
    assert!(f.senders[&2].is_closed());
}

#[tokio::test]
async fn opaque_transport_failure_preserves_prompt_ack_uncertainty_and_no_replay() {
    let codec = Codec::new(&[7; 32]).unwrap();
    let frames = Arc::new(Mutex::new(Vec::<Message>::new()));
    let mut sink = RecordingSink {
        frames: frames.clone(),
        pending: false,
        fail: false,
        started: None,
    };
    let (cancelled, receiver) = oneshot::channel();
    drop(receiver);
    assert!(
        forward_outbound_frame(
            &mut sink,
            &codec,
            "/synthetic",
            OutboundFrame {
                payload: json!({"t":"prompt","text":"already timed out"}),
                forwarded: Some(cancelled),
            }
        )
        .await
    );
    assert!(frames.lock().unwrap().is_empty());
    let (ack, receipt) = oneshot::channel();
    assert!(
        forward_outbound_frame(
            &mut sink,
            &codec,
            "/synthetic",
            OutboundFrame {
                payload: json!({"t":"prompt","text":"once"}),
                forwarded: Some(ack),
            }
        )
        .await
    );
    assert!(
        receipt.await.unwrap(),
        "only the observed sink write is acknowledged"
    );
    assert_eq!(frames.lock().unwrap().len(), 1);
    let (started, ready) = oneshot::channel();
    let mut pending = RecordingSink {
        frames: frames.clone(),
        pending: true,
        fail: false,
        started: Some(started),
    };
    let (ack, receipt) = oneshot::channel();
    let task = tokio::spawn(async move {
        forward_outbound_frame(
            &mut pending,
            &codec,
            "/synthetic",
            OutboundFrame {
                payload: json!({"t":"prompt","text":"ambiguous"}),
                forwarded: Some(ack),
            },
        )
        .await;
    });
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(
        receipt.await.is_err(),
        "cancellation must not claim success or non-execution"
    );
    assert_eq!(frames.lock().unwrap().len(), 2, "nothing was replayed");
}

#[test]
fn observed_source_loss_keeps_turn_uncertain_and_existing_write_gate_closed() {
    let registry = Arc::new(SessionStateRegistry::default());
    let session = "/synthetic/relay-output-loss.jsonl";
    let mut source = CollabEventSource::begin(session, "room", 7, true, Some(registry.clone()));
    assert!(source.accept_event(&json!({"type":"agent_start"})));
    drop(source);
    let state = registry.current(session).unwrap();
    assert_eq!(state.turn, crate::authority::session_state::Turn::Running);
    assert_eq!(state.connection, Connection::Reconnecting);
    assert_eq!(state.activity.as_ref().unwrap()["stale"], true);
    let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let sessions = HashMap::from([(
        session.to_owned(),
        CollabSession {
            generation: 7,
            frame_tx,
            shutdown_tx,
            write_token: Some("synthetic-noncredential".into()),
            task: None,
        },
    )]);
    set_link_state(session, LinkState::Reconnecting);
    assert_eq!(
        check_writable(&sessions, session).err().as_deref(),
        Some("desktop link is reconnecting")
    );
    remove_link_state(session);
}
