//! Connection-local liveness for the ordinary Collab guest, including pending writes.

use super::{End, UiResponseSink};
use futures_util::{Stream, StreamExt};
use std::future::Future;
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::{Instant, MissedTickBehavior};

pub(super) const PING_INTERVAL: Duration = Duration::from_secs(15);
const SILENCE_LIMIT: Duration = Duration::from_secs(40);

pub(super) fn ticks(start: Instant) -> impl Stream<Item = Instant> {
    let mut interval = tokio::time::interval_at(start + PING_INTERVAL, PING_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    futures_util::stream::unfold(interval, |mut interval| async move {
        interval.tick().await;
        // A delayed executor wake must measure now, not the tick's scheduled time.
        Some((Instant::now(), interval))
    })
}

/// Every successfully received WebSocket frame proves this transport is alive;
/// application-level peer/codec validation still runs in the guest afterward.
pub(super) fn received<M, E>(
    message: &Option<Result<M, E>>,
    heard: &watch::Sender<Instant>,
    now: Instant,
) {
    if matches!(message, Some(Ok(_))) {
        heard.send_replace(now);
    }
}

pub(super) enum Guarded<T> {
    Finished(T),
    Shutdown,
    Silent,
}

/// The operation is polled before expiry: a ready fatal outcome stays fatal.
/// Keep this guard OUTSIDE the live loop, since its send/flush awaits can stall.
/// Dropping the guarded operation never retries it or waits for a close handshake.
pub(super) async fn guard<F, T>(
    operation: F,
    shutdown: &mut watch::Receiver<bool>,
    heard: &watch::Receiver<Instant>,
    ticks: &mut T,
) -> Guarded<F::Output>
where
    F: Future,
    T: Stream<Item = Instant> + Unpin,
{
    if *shutdown.borrow() {
        return Guarded::Shutdown;
    }
    tokio::pin!(operation);
    loop {
        tokio::select! {
            biased;
            result = &mut operation => return Guarded::Finished(result),
            _ = shutdown.changed() => return Guarded::Shutdown,
            tick = ticks.next() => {
                let Some(now) = tick else { return Guarded::Shutdown };
                if now.saturating_duration_since(*heard.borrow()) > SILENCE_LIMIT {
                    return Guarded::Silent;
                }
            }
        }
    }
}

pub(super) fn ending(result: Guarded<End>) -> End {
    match result {
        Guarded::Finished(end) => end,
        Guarded::Shutdown => End::Shutdown,
        Guarded::Silent => End::Transient("relay stopped responding".to_string()),
    }
}

/// The shared flush drains its queue before awaiting writes. Cancelling the whole
/// flush would lose the not-yet-visited answers. Instead fail each remaining send
/// after the first interruption, so that unchanged flush requeues every answer.
/// This adapter is deliberately used only by the ordinary guest, never the tap.
pub(super) struct GuardedAnswers<'a, S, T, C, R> {
    pub inner: S,
    pub shutdown: &'a mut watch::Receiver<bool>,
    pub heard: &'a watch::Receiver<Instant>,
    pub ticks: &'a mut T,
    pub end: Option<End>,
    pub is_current: C,
    pub requeue: R,
}

impl<S, T, C, R> UiResponseSink for GuardedAnswers<'_, S, T, C, R>
where
    S: UiResponseSink,
    T: Stream<Item = Instant> + Unpin,
    C: Fn() -> bool,
    R: Fn(u64, Option<&str>, &str),
{
    async fn send_answer(&mut self, req_id: u64, value: Option<&str>) -> bool {
        if !(self.is_current)() || *self.shutdown.borrow() {
            self.end = Some(End::Shutdown);
        }
        if self.end.is_some() {
            return false;
        }
        let result = guard(
            self.inner.send_answer(req_id, value),
            self.shutdown,
            self.heard,
            self.ticks,
        )
        .await;
        if !(self.is_current)() || *self.shutdown.borrow() {
            self.end = Some(End::Shutdown);
            return false;
        }
        match result {
            Guarded::Finished(true) => return true,
            Guarded::Finished(false) => {
                self.end = Some(End::Transient("send failed".to_string()));
            }
            Guarded::Shutdown => self.end = Some(End::Shutdown),
            Guarded::Silent => {
                self.end = Some(End::Transient("relay stopped responding".to_string()));
            }
        }
        false
    }

    fn requeue_failed_answer(&self, _session: &str, req_id: u64, value: Option<&str>, token: &str) {
        if !matches!(self.end, Some(End::Shutdown)) && !*self.shutdown.borrow() {
            // The production callback checks the attachment generation and
            // restores the answer under the same registry lock.
            (self.requeue)(req_id, value, token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::omp::collab::{Codec, OutboundFrame, collab_question_token, forward_outbound_frame};
    use futures_util::{Sink, SinkExt};
    use serde_json::json;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll};
    use tokio::sync::oneshot;
    use tokio_tungstenite::tungstenite::Message;

    struct FakeSink {
        sent: Arc<Mutex<Vec<Message>>>,
        block: bool,
        fail: bool,
    }
    impl Sink<Message> for FakeSink {
        type Error = ();
        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Ready(Ok(()))
        }
        fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), ()> {
            self.sent.lock().unwrap().push(item);
            Ok(())
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
            if self.fail {
                Poll::Ready(Err(()))
            } else if self.block {
                Poll::Pending
            } else {
                Poll::Ready(Ok(()))
            }
        }
        fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
            self.poll_flush(cx)
        }
    }

    #[tokio::test]
    async fn guest_silence_strict_boundary_and_receive_reset() {
        let start = Instant::now();
        let (_shutdown, mut shutdown) = watch::channel(false);
        let (heard_tx, heard) = watch::channel(start);
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_ticks = observed.clone();
        let mut ticks = futures_util::stream::iter([15, 30, 40, 45, 60, 70, 75]).map(|s| {
            observed_ticks.lock().unwrap().push(s);
            // Receiving at t=30 extends the deadline; exactly 40 seconds of
            // silence at t=70 is still allowed, and t=75 ends the connection.
            if s == 30 {
                heard_tx.send_replace(start + Duration::from_secs(s));
            }
            start + Duration::from_secs(s)
        });
        assert!(matches!(
            guard(
                std::future::pending::<()>(),
                &mut shutdown,
                &heard,
                &mut ticks
            )
            .await,
            Guarded::Silent
        ));
        assert_eq!(*observed.lock().unwrap(), [15, 30, 40, 45, 60, 70, 75]);
    }

    #[tokio::test]
    async fn guest_silence_completed_fatal_beats_ready_expiry() {
        for reason in [
            "room closed",
            "no such room",
            "host conflict",
            "room is full",
            "bye",
            "bad key",
        ] {
            let start = Instant::now();
            let (_shutdown, mut shutdown) = watch::channel(false);
            let (_heard_tx, heard) = watch::channel(start);
            let mut ticks = futures_util::stream::iter([start + Duration::from_secs(45)]);
            let result = guard(
                async { End::Fatal(reason.into()) },
                &mut shutdown,
                &heard,
                &mut ticks,
            )
            .await;
            assert!(matches!(ending(result), End::Fatal(value) if value == reason));
        }
    }

    #[tokio::test]
    async fn guest_silence_shutdown_interrupts_pending_write_before_expiry() {
        let start = Instant::now();
        let (shutdown_tx, mut shutdown) = watch::channel(false);
        let (_heard_tx, heard) = watch::channel(start);
        let mut ticks = futures_util::stream::iter([start + Duration::from_secs(45)]);
        let mut sink = FakeSink {
            sent: Arc::new(Mutex::new(Vec::new())),
            block: true,
            fail: false,
        };
        let operation = async {
            shutdown_tx.send(true).unwrap();
            sink.send(Message::Ping(Vec::new().into())).await
        };
        assert!(matches!(
            guard(operation, &mut shutdown, &heard, &mut ticks).await,
            Guarded::Shutdown
        ));
        assert_eq!(sink.sent.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn guest_silence_existing_shutdown_never_starts_write() {
        let start = Instant::now();
        let (_shutdown_tx, mut shutdown) = watch::channel(true);
        let (_heard_tx, heard) = watch::channel(start);
        let mut ticks = futures_util::stream::pending();
        let mut sink = FakeSink {
            sent: Arc::new(Mutex::new(Vec::new())),
            block: true,
            fail: false,
        };
        assert!(matches!(
            guard(
                sink.send(Message::Ping(Vec::new().into())),
                &mut shutdown,
                &heard,
                &mut ticks
            )
            .await,
            Guarded::Shutdown
        ));
        assert!(sink.sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn guest_silence_blocked_ping_pong_and_prompt_are_interrupted_without_replay() {
        let start = Instant::now();
        for frame in [
            Message::Ping(Vec::new().into()),
            Message::Pong(Vec::new().into()),
        ] {
            let (_shutdown_tx, mut shutdown) = watch::channel(false);
            let (_heard_tx, heard) = watch::channel(start);
            let mut ticks = futures_util::stream::iter([start + Duration::from_secs(45)]);
            let mut sink = FakeSink {
                sent: Arc::new(Mutex::new(Vec::new())),
                block: true,
                fail: false,
            };
            assert!(matches!(
                guard(sink.send(frame), &mut shutdown, &heard, &mut ticks).await,
                Guarded::Silent
            ));
            assert_eq!(sink.sent.lock().unwrap().len(), 1);
            assert_eq!(
                *heard.borrow(),
                start,
                "a write never refreshes inbound activity"
            );
        }
        let (_shutdown_tx, mut shutdown) = watch::channel(false);
        let (_heard_tx, heard) = watch::channel(start);
        let mut ticks = futures_util::stream::iter([start + Duration::from_secs(45)]);
        let mut sink = FakeSink {
            sent: Arc::new(Mutex::new(Vec::new())),
            block: true,
            fail: false,
        };
        let codec = Codec::new(&[7; 32]).unwrap();
        let (ack, receipt) = oneshot::channel();
        let send = forward_outbound_frame(
            &mut sink,
            &codec,
            "/isolated",
            OutboundFrame {
                payload: json!({"t":"prompt", "text":"once"}),
                forwarded: Some(ack),
            },
        );
        assert!(matches!(
            guard(send, &mut shutdown, &heard, &mut ticks).await,
            Guarded::Silent
        ));
        assert!(
            receipt.await.is_err(),
            "cancelled write cannot claim a successful receipt"
        );
        assert_eq!(
            sink.sent.lock().unwrap().len(),
            1,
            "guard never replays the consumed prompt"
        );
        let (ack, cancelled) = oneshot::channel();
        drop(cancelled);
        assert!(
            forward_outbound_frame(
                &mut sink,
                &codec,
                "/isolated",
                OutboundFrame {
                    payload: json!({"t":"prompt", "text":"expired"}),
                    forwarded: Some(ack),
                }
            )
            .await
        );
        assert_eq!(
            sink.sent.lock().unwrap().len(),
            1,
            "existing cancelled-receipt gate still skips queued prompts"
        );
    }

    #[tokio::test]
    async fn guest_silence_successful_and_failed_prompt_receipts_unchanged() {
        let codec = Codec::new(&[7; 32]).unwrap();
        for fail in [false, true] {
            let mut sink = FakeSink {
                sent: Arc::new(Mutex::new(Vec::new())),
                block: false,
                fail,
            };
            let (ack, receipt) = oneshot::channel();
            assert_eq!(
                forward_outbound_frame(
                    &mut sink,
                    &codec,
                    "/isolated",
                    OutboundFrame {
                        payload: json!({"t":"prompt", "text":"once"}),
                        forwarded: Some(ack),
                    }
                )
                .await,
                !fail
            );
            assert_eq!(receipt.await.unwrap(), !fail);
            assert_eq!(sink.sent.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn guest_silence_fresh_connection_does_not_inherit_old_activity() {
        let start = Instant::now();
        let (_old_sender, old) = watch::channel(start);
        let (_new_sender, new) = watch::channel(start + Duration::from_secs(45));
        let (_shutdown_tx, mut shutdown) = watch::channel(false);
        let mut old_ticks = futures_util::stream::iter([start + Duration::from_secs(45)]);
        assert!(matches!(
            guard(
                std::future::pending::<()>(),
                &mut shutdown,
                &old,
                &mut old_ticks
            )
            .await,
            Guarded::Silent
        ));
        let mut new_ticks = futures_util::stream::iter([start + Duration::from_secs(45)]);
        assert!(matches!(
            guard(async { 7 }, &mut shutdown, &new, &mut new_ticks).await,
            Guarded::Finished(7)
        ));
        assert_eq!(*new.borrow(), start + Duration::from_secs(45));
    }
    #[tokio::test]
    async fn guest_silence_flush_preserves_only_current_transient_answers() {
        use crate::omp::collab::{
            AnswerClaim, claim_collab_answer, collab_answer_in_flight, collab_question_pending,
            flush_pending_answers, forget_collab_ui, forget_collab_ui_session,
            forget_pending_answers, queue_collab_answer, remember_collab_ui, take_pending_answers,
        };
        use crate::{server::delta::DeltaEncoder, server::ws::WsHub};
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        struct Answers {
            attempts: Arc<AtomicUsize>,
            current: Arc<AtomicBool>,
            shutdown: watch::Sender<bool>,
            mode: u8,
        }
        impl UiResponseSink for Answers {
            async fn send_answer(&mut self, req_id: u64, _: Option<&str>) -> bool {
                self.attempts.fetch_add(1, Ordering::Relaxed);
                if req_id == 1 {
                    return true;
                }
                if self.mode == 1 {
                    self.shutdown.send(true).unwrap();
                }
                if self.mode == 2 {
                    self.current.store(false, Ordering::Relaxed);
                }
                std::future::pending().await
            }
        }
        for mode in 0..3 {
            let session = format!("/isolated/guest-silence-flush-{mode}");
            forget_collab_ui_session(&session);
            forget_pending_answers(&session);
            for req_id in 1..=3 {
                remember_collab_ui(&session, req_id, &json!({"reqId":req_id}));
                assert!(matches!(
                    claim_collab_answer(&session, req_id, Some("answer"), true),
                    AnswerClaim::New
                ));
                queue_collab_answer(
                    &session,
                    req_id,
                    Some("answer"),
                    &collab_question_token(&session, req_id).expect("queued question identity"),
                );
            }
            let config = Arc::new(crate::omp::collab::tests::test_config());
            let hub = WsHub::new(config);
            let delta = DeltaEncoder::new();
            let start = Instant::now();
            let (shutdown_tx, mut shutdown) = watch::channel(false);
            let (_heard_tx, heard) = watch::channel(start);
            let mut ticks = futures_util::stream::iter([start + Duration::from_secs(45)]);
            let attempts = Arc::new(AtomicUsize::new(0));
            let current = Arc::new(AtomicBool::new(true));
            let mut sink = GuardedAnswers {
                inner: Answers {
                    attempts: attempts.clone(),
                    current: current.clone(),
                    shutdown: shutdown_tx,
                    mode,
                },
                shutdown: &mut shutdown,
                heard: &heard,
                ticks: &mut ticks,
                end: None,
                is_current: || current.load(Ordering::Relaxed),
                requeue: |req_id, value: Option<&str>, token: &str| {
                    if current.load(Ordering::Relaxed) {
                        queue_collab_answer(&session, req_id, value, token);
                    }
                },
            };
            flush_pending_answers(&mut sink, &delta, &hub, &session).await;
            assert_eq!(
                attempts.load(Ordering::Relaxed),
                2,
                "remaining answers are not written after interruption"
            );
            if mode == 0 {
                assert!(matches!(sink.end, Some(End::Transient(_))));
                assert_eq!(
                    take_pending_answers(&session)
                        .0
                        .into_iter()
                        .map(|(id, value, _)| (id, value))
                        .collect::<Vec<_>>(),
                    vec![(2, Some("answer".into())), (3, Some("answer".into()))]
                );
            } else {
                assert!(matches!(sink.end, Some(End::Shutdown)));
                assert!(
                    take_pending_answers(&session).0.is_empty(),
                    "detach/replacement cannot restore an old queue"
                );
            }
            assert!(
                matches!(
                    claim_collab_answer(&session, 1, Some("answer"), true),
                    AnswerClaim::Existing { queued: false }
                ),
                "the completed write is a transport handoff, not callback acceptance"
            );
            for req_id in 1..=3 {
                assert!(
                    collab_question_pending(&session, req_id),
                    "only host settlement closes a question"
                );
                assert!(
                    collab_answer_in_flight(&session, req_id),
                    "interruption does not authorize duplicate dispatch"
                );
            }
            // Simulate the host's exact request-end, independently of whether
            // this attach was interrupted, shut down or replaced.
            forget_collab_ui(&session, 1);
            assert!(!collab_question_pending(&session, 1));
            assert!(!collab_answer_in_flight(&session, 1));
            assert!(collab_question_pending(&session, 2));
            assert!(collab_question_pending(&session, 3));
            forget_collab_ui_session(&session);
            forget_pending_answers(&session);
        }
    }
    #[test]
    fn guest_silence_pong_ping_and_data_refresh_activity_but_eof_errors_do_not() {
        let start = Instant::now();
        let (tx, rx) = watch::channel(start);
        let messages = [
            Message::Pong(Vec::new().into()),
            Message::Ping(Vec::new().into()),
            Message::Text("control".into()),
            Message::Binary(Vec::new().into()),
        ];
        for (index, message) in messages.into_iter().enumerate() {
            let now = start + Duration::from_secs(index as u64 + 1);
            received::<_, ()>(&Some(Ok(message)), &tx, now);
            assert_eq!(*rx.borrow(), now);
        }
        received::<Message, ()>(&None, &tx, start + Duration::from_secs(8));
        received::<Message, ()>(&Some(Err(())), &tx, start + Duration::from_secs(9));
        assert_eq!(*rx.borrow(), start + Duration::from_secs(4));
    }
}
