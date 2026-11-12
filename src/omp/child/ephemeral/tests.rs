//! Owned fake handles and pending futures only: no processes, sockets or app state.
use super::*;
use std::sync::atomic::AtomicUsize;
use tokio::task::JoinHandle;

#[derive(Clone)]
struct Probe {
    slots: Arc<AtomicUsize>,
    stops: Arc<Mutex<Vec<String>>>,
    handles_dropped: Arc<AtomicUsize>,
}

impl Probe {
    fn new() -> Self {
        Self {
            slots: Arc::new(AtomicUsize::new(1)),
            stops: Arc::new(Mutex::new(Vec::new())),
            handles_dropped: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn owner(&self) -> Owner<impl Fn(&str) + Sync + use<>> {
        let stops = self.stops.clone();
        Owner::new(
            Reservation::new(self.slots.clone()).retain(),
            move |why: &str| {
                stops.lock().unwrap().push(why.to_owned());
            },
        )
    }

    fn count(&self) -> usize {
        self.slots.load(Ordering::SeqCst)
    }

    fn stop_count(&self) -> usize {
        self.stops.lock().unwrap().len()
    }

    fn handle(&self) -> FakeOwnedHandle {
        FakeOwnedHandle(self.handles_dropped.clone())
    }
}

struct FakeOwnedHandle(Arc<AtomicUsize>);

impl Drop for FakeOwnedHandle {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

type Task = JoinHandle<Result<(), Box<dyn Any + Send>>>;

fn monitor_task(
    probe: &Probe,
    ended: oneshot::Receiver<()>,
    exit: oneshot::Receiver<Result<(), ()>>,
) -> Task {
    let owner = probe.owner();
    let handle = probe.handle();
    tokio::spawn(async move {
        let monitor = async {
            let _handle = handle;
            if exit.await == Ok(Ok(())) {
                owner.observed_reap();
            }
        };
        supervise(&owner, ended, monitor).await
    })
}

async fn tick() {
    // Current-thread runtime: let the ready ownership task poll once.
    tokio::task::yield_now().await;
}

#[test]
fn pre_spawn_error_returns_provisional_reservation() {
    let probe = Probe::new();
    drop(Reservation::new(probe.slots.clone()));
    assert_eq!(probe.count(), 0);
}

#[test]
fn retained_charge_drop_never_fabricates_exit() {
    let probe = Probe::new();
    drop(Reservation::new(probe.slots.clone()).retain());
    assert_eq!(probe.count(), 1);
}

#[test]
fn owner_drop_with_unknown_exit_keeps_capacity_charged() {
    let probe = Probe::new();
    drop(probe.owner());
    assert_eq!(probe.count(), 1);
}

#[test]
fn reaping_is_exactly_once_and_fences_late_cleanup() {
    let probe = Probe::new();
    let owner = probe.owner();
    owner.observed_reap();
    owner.observed_reap();
    owner.request_stop("late cancellation");
    drop(owner);
    assert_eq!(probe.count(), 0);
    assert_eq!(probe.stop_count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn caller_drop_before_monitor_first_poll_requests_cleanup() {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    let task = monitor_task(&probe, ended, waiting);
    drop(scope);
    tick().await;
    assert_eq!(probe.stop_count(), 1);
    assert_eq!(probe.count(), 1);
    assert_eq!(probe.handles_dropped.load(Ordering::SeqCst), 0);
    exit.send(Ok(())).unwrap();
    assert!(task.await.unwrap().is_ok());
    assert_eq!(probe.count(), 0);
    assert_eq!(probe.handles_dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn observed_exit_precedes_scope_drop_without_late_signal() {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    let task = monitor_task(&probe, ended, waiting);
    exit.send(Ok(())).unwrap();
    assert!(task.await.unwrap().is_ok());
    drop(scope);
    assert_eq!((probe.count(), probe.stop_count()), (0, 0));
}

#[tokio::test(flavor = "current_thread")]
async fn simultaneously_ready_exit_wins_over_caller_drop() {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    exit.send(Ok(())).unwrap();
    drop(scope);
    assert!(monitor_task(&probe, ended, waiting).await.unwrap().is_ok());
    assert_eq!((probe.count(), probe.stop_count()), (0, 0));
}

async fn caller_cancellation_at_stage(stage: usize) {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    let monitor = monitor_task(&probe, ended, waiting);
    let (first, first_wait) = oneshot::channel::<()>();
    let (second, second_wait) = oneshot::channel::<()>();
    let caller = tokio::spawn(async move {
        let _scope = scope;
        let _ = first_wait.await;
        let _ = second_wait.await;
    });
    if stage == 1 {
        first.send(()).unwrap();
    }
    tick().await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    tick().await;
    assert_eq!((probe.count(), probe.stop_count()), (1, 1));
    // The same counter used by admission still has no free slot at cap one.
    assert_eq!(1_usize.saturating_sub(probe.count()), 0);
    // A response arriving after cancellation cannot resurrect the caller.
    assert!(second.send(()).is_err());
    exit.send(Ok(())).unwrap();
    assert!(monitor.await.unwrap().is_ok());
    assert_eq!(probe.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_during_negotiation_wait() {
    caller_cancellation_at_stage(0).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_during_response_wait() {
    caller_cancellation_at_stage(1).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_during_held_stdin_work() {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    let monitor = monitor_task(&probe, ended, waiting);
    // Match rpc_with_id's async stdin-lock suspension without constructing IO.
    let stdin = Arc::new(tokio::sync::Mutex::new(()));
    let held = stdin.lock().await;
    let writer = stdin.clone();
    let caller = tokio::spawn(async move {
        let _scope = scope;
        let _write_lock = writer.lock().await;
        panic!("the fake stdin lock must remain held");
    });
    tick().await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    tick().await;
    assert_eq!((probe.count(), probe.stop_count()), (1, 1));
    drop(held);
    exit.send(Ok(())).unwrap();
    assert!(monitor.await.unwrap().is_ok());
    assert_eq!(probe.count(), 0);
}

async fn completed_caller(result: Result<usize, &'static str>) {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    let task = monitor_task(&probe, ended, waiting);
    let returned = async move {
        let _scope = scope;
        result
    }
    .await;
    assert_eq!(returned, result);
    tick().await;
    assert_eq!((probe.count(), probe.stop_count()), (1, 1));
    exit.send(Ok(())).unwrap();
    assert!(task.await.unwrap().is_ok());
    assert_eq!(probe.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn successful_caller_keeps_result_and_charge_until_reaping() {
    completed_caller(Ok(42)).await;
}

#[tokio::test(flavor = "current_thread")]
async fn failed_caller_keeps_error_and_charge_until_reaping() {
    completed_caller(Err("ordinary RPC error")).await;
}

#[tokio::test(flavor = "current_thread")]
async fn timed_out_caller_also_ends_cleanup_scope() {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    let task = monitor_task(&probe, ended, waiting);
    let returned = async move {
        let _scope = scope;
        tokio::time::timeout(std::time::Duration::ZERO, std::future::pending::<()>()).await
    }
    .await;
    assert!(returned.is_err());
    tick().await;
    assert_eq!((probe.count(), probe.stop_count()), (1, 1));
    exit.send(Ok(())).unwrap();
    assert!(task.await.unwrap().is_ok());
    assert_eq!(probe.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn caller_unwind_drops_cleanup_scope() {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    let task = monitor_task(&probe, ended, waiting);
    let caller = tokio::spawn(async move {
        let _scope = scope;
        panic!("fake caller panic");
    });
    assert!(caller.await.unwrap_err().is_panic());
    tick().await;
    assert_eq!((probe.count(), probe.stop_count()), (1, 1));
    exit.send(Ok(())).unwrap();
    assert!(task.await.unwrap().is_ok());
}

#[tokio::test(flavor = "current_thread")]
async fn protocol_failure_then_caller_drop_requests_cleanup_once() {
    let probe = Probe::new();
    let owner = probe.owner();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    let monitor = async {
        owner.request_stop("protocol error");
        waiting.await.unwrap();
        owner.observed_reap();
    };
    let supervised = supervise(&owner, ended, monitor);
    tokio::pin!(supervised);
    assert!(futures_util::poll!(&mut supervised).is_pending());
    drop(scope);
    assert!(futures_util::poll!(&mut supervised).is_pending());
    assert_eq!((probe.count(), probe.stop_count()), (1, 1));
    assert_eq!(probe.stops.lock().unwrap()[0], "protocol error");
    exit.send(()).unwrap();
    assert!(supervised.await.is_ok());
    assert_eq!(probe.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn caller_drop_then_protocol_failure_requests_cleanup_once() {
    let probe = Probe::new();
    let owner = probe.owner();
    let (scope, ended) = request_scope();
    let (protocol, protocol_wait) = oneshot::channel();
    let (exit, waiting) = oneshot::channel();
    let monitor = async {
        protocol_wait.await.unwrap();
        owner.request_stop("protocol error");
        waiting.await.unwrap();
        owner.observed_reap();
    };
    let supervised = supervise(&owner, ended, monitor);
    tokio::pin!(supervised);
    drop(scope);
    assert!(futures_util::poll!(&mut supervised).is_pending());
    protocol.send(()).unwrap();
    assert!(futures_util::poll!(&mut supervised).is_pending());
    assert_eq!((probe.count(), probe.stop_count()), (1, 1));
    assert_eq!(
        probe.stops.lock().unwrap()[0],
        "ephemeral request scope ended"
    );
    exit.send(()).unwrap();
    assert!(supervised.await.is_ok());
}

#[tokio::test(flavor = "current_thread")]
async fn monitor_panic_requests_cleanup_and_retains_unknown_charge() {
    let probe = Probe::new();
    let owner = probe.owner();
    let (_scope, ended) = request_scope();
    let handle = probe.handle();
    let result = supervise(&owner, ended, async move {
        let _handle = handle;
        panic!("fake monitor panic");
    })
    .await;
    assert!(result.is_err());
    drop(owner);
    assert_eq!((probe.count(), probe.stop_count()), (1, 1));
    assert_eq!(probe.handles_dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn protocol_cleanup_then_monitor_panic_is_idempotent() {
    let probe = Probe::new();
    let owner = probe.owner();
    let (_scope, ended) = request_scope();
    let result = supervise(&owner, ended, async {
        owner.request_stop("protocol error");
        panic!("panic after cleanup request");
    })
    .await;
    assert!(result.is_err());
    drop(owner);
    assert_eq!((probe.count(), probe.stop_count()), (1, 1));
}

#[tokio::test(flavor = "current_thread")]
async fn panic_after_reaping_does_not_signal_reused_identity() {
    let probe = Probe::new();
    let owner = probe.owner();
    let (_scope, ended) = request_scope();
    let result = supervise(&owner, ended, async {
        owner.observed_reap();
        panic!("fake post-reap logging panic");
    })
    .await;
    assert!(result.is_err());
    assert_eq!((probe.count(), probe.stop_count()), (0, 0));
}

#[tokio::test(flavor = "current_thread")]
async fn cleanup_panic_retains_charge_and_does_not_repeat_callback() {
    let probe = Probe::new();
    let attempts = AtomicUsize::new(0);
    let owner = Owner::new(Reservation::new(probe.slots.clone()).retain(), |_: &str| {
        attempts.fetch_add(1, Ordering::SeqCst);
        panic!("fake cleanup panic");
    });
    let (scope, ended) = request_scope();
    drop(scope);
    let result = supervise(&owner, ended, std::future::pending()).await;
    assert!(result.is_err());
    owner.request_stop("again after poison");
    drop(owner);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert_eq!(probe.count(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn wait_error_then_owner_drop_keeps_charge() {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (exit, waiting) = oneshot::channel();
    let task = monitor_task(&probe, ended, waiting);
    exit.send(Err(())).unwrap();
    assert!(task.await.unwrap().is_ok());
    drop(scope);
    assert_eq!((probe.count(), probe.stop_count()), (1, 0));
    assert_eq!(probe.handles_dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn monitor_abort_keeps_unknown_charge_after_handle_drop() {
    let probe = Probe::new();
    let (scope, ended) = request_scope();
    let (_exit, waiting) = oneshot::channel();
    let task = monitor_task(&probe, ended, waiting);
    tick().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    drop(scope);
    assert_eq!(probe.count(), 1);
    assert_eq!(probe.handles_dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn setup_error_wait_releases_only_on_confirmed_reap() {
    let probe = Probe::new();
    let charge = Reservation::new(probe.slots.clone()).retain();
    let (exit, wait) = oneshot::channel();
    let work = release_on_reap(charge, async { wait.await.unwrap() });
    tokio::pin!(work);
    assert!(futures_util::poll!(&mut work).is_pending());
    assert_eq!(probe.count(), 1);
    exit.send(Ok::<_, ()>(23)).unwrap();
    assert_eq!(work.await, Ok(23));
    assert_eq!(probe.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn setup_error_wait_failure_keeps_capacity() {
    let probe = Probe::new();
    let charge = Reservation::new(probe.slots.clone()).retain();
    assert_eq!(
        release_on_reap(charge, async { Err::<(), _>("wait failed") }).await,
        Err("wait failed")
    );
    assert_eq!(probe.count(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn setup_error_wait_cancellation_keeps_capacity() {
    let probe = Probe::new();
    let charge = Reservation::new(probe.slots.clone()).retain();
    let mut work = Box::pin(release_on_reap(
        charge,
        std::future::pending::<Result<(), ()>>(),
    ));
    assert!(futures_util::poll!(&mut work).is_pending());
    drop(work);
    assert_eq!(probe.count(), 1);
}

#[test]
fn independent_owners_release_only_their_own_charge() {
    let probe = Probe::new();
    probe.slots.store(2, Ordering::SeqCst);
    let first = probe.owner();
    let second = probe.owner();
    first.request_stop("first canceled");
    first.observed_reap();
    first.observed_reap();
    assert_eq!(probe.count(), 1);
    drop(second);
    assert_eq!(probe.count(), 1);
}
