//! Socket-free regressions for task ownership when a stale relay room is replaced.
use super::*;
use std::time::Duration;
use tokio::task::{AbortHandle, JoinHandle};

struct TaskProbe {
    name: String,
    released: oneshot::Receiver<()>,
    abort: AbortHandle,
}

fn pending_task(name: String) -> (JoinHandle<()>, TaskProbe) {
    let (held, released) = oneshot::channel();
    let task = tokio::spawn(async move {
        let _held = held;
        std::future::pending::<()>().await;
    });
    let abort = task.abort_handle();
    (
        task,
        TaskProbe {
            name,
            released,
            abort,
        },
    )
}

fn pending_room(generation: u64) -> (RelayRoom, Vec<TaskProbe>) {
    let (task, routing) = pending_task(format!("room {generation} routing"));
    let mut probes = vec![routing];
    let mut peers = HashMap::new();
    // Host and two guests: internal taps are guest peers with the same ownership.
    for id in [HOST_PEER_ID, 2, 3] {
        let (tx, _) = relay_output::channel();
        let (writer, writer_probe) = pending_task(format!("room {generation} peer {id} writer"));
        let (reader, reader_probe) = pending_task(format!("room {generation} peer {id} reader"));
        probes.extend([writer_probe, reader_probe]);
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
    (
        RelayRoom {
            generation,
            session_path: None,
            notify,
            task,
            events,
            peers,
            tap_gen: 0,
        },
        probes,
    )
}

async fn assert_released(probes: Vec<TaskProbe>) {
    for probe in probes {
        tokio::time::timeout(Duration::from_secs(1), probe.released)
            .await
            .unwrap_or_else(|_| panic!("{} retained its captured resource", probe.name))
            .expect_err("the pending task must release its sender through cancellation");
        assert!(probe.abort.is_finished(), "{} still runs", probe.name);
    }
}

#[tokio::test]
async fn stale_room_cancels_all_owned_tasks_and_preserves_new_generation() {
    let (old, old_probes) = pending_room(7);
    let mut old_closed = old.notify.subscribe();
    let (new, mut new_probes) = pending_room(8);
    let mut rooms = HashMap::from([("room".to_string(), old)]);

    // Only a stale room may cross join_as_host's replacement seam. These
    // isolated output receivers have already gone away, so no host is live.
    assert!(!rooms["room"].has_live_host());
    // Publish the new generation, notify the removed room, then cancel that
    // removed value rather than peers belonging to the new generation.
    let removed = rooms.insert("room".to_string(), new).unwrap();
    removed.notify.send(true).unwrap();
    removed.abort_tasks();

    old_closed.changed().await.unwrap();
    assert!(*old_closed.borrow());
    assert_released(old_probes).await;

    let current = rooms.get("room").unwrap();
    assert_eq!(current.generation, 8);
    assert_eq!(current.peers.len(), 3);
    for probe in &mut new_probes {
        assert!(
            !probe.abort.is_finished(),
            "replacement {} was cancelled",
            probe.name
        );
        assert!(matches!(
            probe.released.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
    }
    rooms.remove("room").unwrap().abort_tasks();
    assert_released(new_probes).await;
}

#[tokio::test]
async fn stale_room_cleanup_accepts_completed_tasks_and_no_peers() {
    let (mut room, probes) = pending_room(7);
    for probe in &probes {
        probe.abort.abort();
    }
    assert_released(probes).await;
    // Aborting an already completed/cancelled task is harmless.
    room.abort_tasks();

    let (task, probe) = pending_task("empty room routing".to_string());
    let (notify, _) = watch::channel(false);
    let (events, _) = mpsc::unbounded_channel();
    room = RelayRoom {
        generation: 8,
        session_path: None,
        notify,
        task,
        events,
        peers: HashMap::new(),
        tap_gen: 0,
    };
    room.abort_tasks();
    assert_released(vec![probe]).await;
}
