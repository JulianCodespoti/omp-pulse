use super::*;
use axum::body::Bytes;

fn binary(bytes: usize) -> RouteFrame {
    RouteFrame::Binary(Bytes::from(vec![7; bytes]))
}

#[test]
fn exact_count_and_byte_boundaries_include_dequeued_frames() {
    let (tx, mut rx) = channel_with_limits(2, 5);
    tx.send(binary(3)).unwrap();
    tx.send(RouteFrame::Text("ab".into())).unwrap();
    assert_eq!(tx.usage(), (2, 5));
    let in_flight = rx.try_recv().unwrap();
    assert_eq!(
        tx.usage(),
        (2, 5),
        "dequeue must not release the reservation"
    );
    assert_eq!(tx.send(binary(0)), Err(SendError::Overloaded));
    assert!(tx.is_closed());
    drop(in_flight);
    assert_eq!(tx.usage(), (1, 2));
    drop(rx);
    assert_eq!(tx.usage(), (0, 0));
}

#[test]
fn count_and_byte_limits_fail_independently_and_never_reopen() {
    for (count, bytes, first, next) in [(1, 100, 0, 0), (9, 5, 5, 1)] {
        let (tx, mut rx) = channel_with_limits(count, bytes);
        let clone = tx.clone();
        tx.send(binary(first)).unwrap();
        assert_eq!(tx.send(binary(next)), Err(SendError::Overloaded));
        drop(rx.try_recv().unwrap());
        assert_eq!(clone.send(binary(0)), Err(SendError::Closed));
        assert_eq!(tx.usage(), (0, 0));
    }
}

#[test]
fn oversize_closed_receiver_and_explicit_close_reject_without_reservations() {
    let (tx, rx) = channel_with_limits(8, 2);
    assert_eq!(tx.send(binary(3)), Err(SendError::Overloaded));
    assert_eq!(tx.usage(), (0, 0));
    drop(rx);
    let (tx, mut rx) = channel();
    rx.rx.close();
    assert_eq!(tx.send(binary(1)), Err(SendError::Closed));
    assert_eq!(tx.usage(), (0, 0));
    let (tx, rx) = channel();
    tx.close();
    assert_eq!(tx.send(binary(1)), Err(SendError::Closed));
    drop(rx);
    assert_eq!(tx.usage(), (0, 0));
}

#[test]
fn receiver_drop_releases_queued_but_not_in_flight_reservations() {
    let (tx, mut rx) = channel();
    tx.send(binary(3)).unwrap();
    tx.send(binary(5)).unwrap();
    let in_flight = rx.try_recv().unwrap();
    drop(rx);
    assert!(tx.is_closed());
    assert_eq!(tx.usage(), (1, 3));
    assert_eq!(tx.send(binary(0)), Err(SendError::Closed));
    drop(in_flight);
    assert_eq!(tx.usage(), (0, 0));
}

#[test]
fn text_and_close_charge_wire_payload_and_release_on_completion() {
    let (tx, mut rx) = channel_with_limits(3, 6);
    tx.send(RouteFrame::Text("é".into())).unwrap();
    tx.send(RouteFrame::Close(4001)).unwrap();
    tx.send(binary(2)).unwrap();
    assert_eq!(tx.usage(), (3, 6));
    for expected in [(2, 4), (1, 2), (0, 0)] {
        drop(rx.try_recv().unwrap());
        assert_eq!(tx.usage(), expected);
    }
    tx.send(binary(6)).unwrap();
    assert_eq!(tx.usage(), (1, 6));
}

#[test]
fn byte_sum_overflow_fails_closed_without_wrapping() {
    let (tx, rx) = channel_with_limits(8, usize::MAX);
    // Synthetic accounting edge; do not allocate near-usize::MAX memory.
    tx.budget.lock().unwrap().bytes = usize::MAX;
    assert_eq!(tx.send(binary(1)), Err(SendError::Overloaded));
    assert_eq!(tx.usage(), (0, usize::MAX));
    tx.budget.lock().unwrap().bytes = 0;
    drop(rx);
}

#[test]
fn production_limits_accept_a_64_mib_message_and_bound_tiny_frames() {
    assert_eq!(MAX_FRAMES, 256);
    assert_eq!(MAX_BYTES, 128 * 1024 * 1024);
    let (tx, mut rx) = channel();
    tx.send(binary(64 * 1024 * 1024)).unwrap();
    assert_eq!(tx.usage(), (1, 64 * 1024 * 1024));
    drop(rx.try_recv().unwrap());
    for _ in 0..MAX_FRAMES {
        tx.send(binary(0)).unwrap();
    }
    assert_eq!(tx.send(binary(0)), Err(SendError::Overloaded));
    drop(rx);
    assert_eq!(tx.usage(), (0, 0));
}

#[test]
fn concurrent_producers_and_close_serialize_admission() {
    let (tx, rx) = channel_with_limits(32, 32);
    let admitted = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let tx = tx.clone();
            let admitted = &admitted;
            scope.spawn(move || {
                for _ in 0..32 {
                    if tx.send(binary(1)).is_ok() {
                        admitted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            });
        }
    });
    assert_eq!(admitted.load(std::sync::atomic::Ordering::Relaxed), 32);
    assert_eq!(tx.usage(), (32, 32));
    assert!(tx.is_closed());
    drop(rx);
    assert_eq!(tx.usage(), (0, 0));
}
