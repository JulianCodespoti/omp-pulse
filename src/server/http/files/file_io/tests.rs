//! Inert admission tests: controlled closures only, no filesystem or sockets.

use super::*;
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(5);

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
}

fn gate() -> &'static Semaphore {
    Box::leak(Box::new(Semaphore::new(1)))
}

#[derive(Default)]
struct Latch {
    released: Mutex<bool>,
    wake: Condvar,
}

impl Latch {
    fn wait(&self) {
        let (released, _) = self
            .wake
            .wait_timeout_while(self.released.lock().unwrap(), DEADLINE, |done| !*done)
            .unwrap();
        assert!(*released, "test latch timed out");
    }

    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}

struct ReleaseOnDrop(Arc<Latch>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[test]
fn busy_refuses_dispatch_and_normal_completion_releases_slot() {
    let runtime = runtime();
    let gate = gate();
    let latch = Arc::new(Latch::default());
    let _cleanup = ReleaseOnDrop(latch.clone());
    let (entered_tx, entered_rx) = mpsc::channel();
    let held = latch.clone();
    let task = runtime.spawn(run_with_gate(gate, Duration::ZERO, move || {
        entered_tx.send(()).unwrap();
        held.wait();
        17
    }));
    runtime.block_on(async {
        tokio::task::yield_now().await;
        entered_rx.recv_timeout(DEADLINE).unwrap();
        assert_eq!(
            run_with_gate(gate, Duration::ZERO, || panic!("rejected job ran")).await,
            Err(Error::Busy)
        );
        latch.release();
        assert_eq!(task.await.unwrap(), Ok(17));
        assert_eq!(run_with_gate(gate, Duration::ZERO, || 23).await, Ok(23));
    });
}

#[test]
fn aborted_request_keeps_admission_until_blocking_job_finishes() {
    let runtime = runtime();
    let gate = gate();
    let latch = Arc::new(Latch::default());
    let _cleanup = ReleaseOnDrop(latch.clone());
    let (entered_tx, entered_rx) = mpsc::channel();
    let held = latch.clone();
    let task = runtime.spawn(run_with_gate(gate, Duration::ZERO, move || {
        entered_tx.send(()).unwrap();
        held.wait();
    }));
    runtime.block_on(async {
        tokio::task::yield_now().await;
        entered_rx.recv_timeout(DEADLINE).unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            run_with_gate(gate, Duration::ZERO, || panic!("cancel freed slot")).await,
            Err(Error::Busy)
        );
        latch.release();
        // Acquiring proves the actual closure-owned permit has dropped; an
        // earlier signal inside the closure would not establish that ordering.
        drop(
            tokio::time::timeout(DEADLINE, gate.acquire())
                .await
                .unwrap()
                .unwrap(),
        );
        assert_eq!(run_with_gate(gate, Duration::ZERO, || 31).await, Ok(31));
    });
}

#[test]
fn blocking_job_allows_unrelated_async_progress() {
    let runtime = runtime();
    let gate = gate();
    let latch = Arc::new(Latch::default());
    let _cleanup = ReleaseOnDrop(latch.clone());
    let (entered_tx, entered_rx) = mpsc::channel();
    let held = latch.clone();
    let task = runtime.spawn(run_with_gate(gate, Duration::ZERO, move || {
        entered_tx.send(()).unwrap();
        held.wait();
    }));
    runtime.block_on(async {
        tokio::task::yield_now().await;
        entered_rx.recv_timeout(DEADLINE).unwrap();
        let marker = tokio::spawn(async { 41 });
        assert_eq!(
            tokio::time::timeout(DEADLINE, marker)
                .await
                .unwrap()
                .unwrap(),
            41
        );
        assert_eq!(gate.available_permits(), 0);
        latch.release();
        assert_eq!(task.await.unwrap(), Ok(()));
    });
}

#[test]
fn operation_error_is_preserved_and_releases_capacity() {
    runtime().block_on(async {
        let gate = gate();
        assert_eq!(
            run_with_gate(gate, Duration::ZERO, || Err::<(), _>("unchanged error")).await,
            Ok(Err("unchanged error"))
        );
        assert_eq!(
            run_with_gate(gate, Duration::ZERO, || "next").await,
            Ok("next")
        );
    });
}

#[test]
fn panic_is_join_failure_and_releases_capacity() {
    runtime().block_on(async {
        let gate = gate();
        assert_eq!(
            run_with_gate::<()>(gate, Duration::ZERO, || panic!("inert panic")).await,
            Err(Error::Join)
        );
        assert_eq!(run_with_gate(gate, Duration::ZERO, || 53).await, Ok(53));
    });
}

#[test]
fn a_waiting_request_runs_once_the_slot_frees() {
    let runtime = runtime();
    let gate = gate();
    let latch = Arc::new(Latch::default());
    let _cleanup = ReleaseOnDrop(latch.clone());
    let (entered_tx, entered_rx) = mpsc::channel();
    let held = latch.clone();
    let first = runtime.spawn(run_with_gate(gate, Duration::ZERO, move || {
        entered_tx.send(()).unwrap();
        held.wait();
        1
    }));
    runtime.block_on(async {
        tokio::task::yield_now().await;
        entered_rx.recv_timeout(DEADLINE).unwrap();
        let second = tokio::spawn(run_with_gate(gate, DEADLINE, || 2));
        tokio::task::yield_now().await;
        latch.release();
        assert_eq!(first.await.unwrap(), Ok(1));
        assert_eq!(second.await.unwrap(), Ok(2));
    });
}
