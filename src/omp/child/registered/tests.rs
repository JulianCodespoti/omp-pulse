//! Inert ownership tests: no process, signal, Tokio runtime, filesystem or socket.
use super::*;
use crate::omp::child::ephemeral::Reservation;
use crate::omp::child::{slots_free, try_reserve_slot};
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::Waker;

#[derive(Clone, Copy)]
enum Outcome {
    Pending,
    Error,
    Success,
    Panic,
}
struct Process {
    outcome: Outcome,
    polls: usize,
    stops: usize,
}
impl Process {
    fn poll(&mut self, _: &mut Context<'_>) -> Poll<Result<(), &'static str>> {
        self.polls += 1;
        match self.outcome {
            Outcome::Pending => Poll::Pending,
            Outcome::Error => Poll::Ready(Err("inert wait error")),
            Outcome::Success => Poll::Ready(Ok(())),
            Outcome::Panic => panic!("inert wait panic"),
        }
    }
}
fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}
fn owner(registry: &Registry<Process>, slots: &Arc<AtomicUsize>) -> Arc<Owner<Process>> {
    assert!(try_reserve_slot(slots, 8));
    registry.insert(
        Process {
            outcome: Outcome::Pending,
            polls: 0,
            stops: 0,
        },
        Reservation::new(Arc::clone(slots)).retain(),
    )
}
fn reap(owner: &Owner<Process>) -> Poll<Result<Option<()>, &'static str>> {
    poll_once(std::pin::pin!(poll_fn(
        |cx| owner.poll_reap(cx, Process::poll)
    )))
}

#[test]
fn reservation_refunds_only_before_transfer() {
    let slots = Arc::new(AtomicUsize::new(0));
    assert!(try_reserve_slot(&slots, 1));
    drop(Reservation::new(Arc::clone(&slots)));
    assert_eq!(slots.load(Ordering::SeqCst), 0);
    assert!(try_reserve_slot(&slots, 1));
    let charge = Reservation::new(Arc::clone(&slots)).retain();
    drop(charge);
    assert_eq!(slots.load(Ordering::SeqCst), 1);
    assert!(!try_reserve_slot(&slots, 1));
}

#[test]
fn registry_keeps_handle_and_charge_after_boot_caller_drop() {
    let slots = Arc::new(AtomicUsize::new(0));
    let registry = Registry::new();
    let owner = owner(&registry, &slots);
    let weak = Arc::downgrade(&owner);
    drop(owner);
    let retained = weak.upgrade().expect("manager owns the successful spawn");
    assert_eq!(slots.load(Ordering::SeqCst), 1);
    assert_eq!(retained.lock().process.stops, 0);
    assert!(retained.publish(|| ()).is_some());
}

#[test]
fn setup_failure_retains_before_fallible_setup() {
    let slots = Arc::new(AtomicUsize::new(0));
    let registry = Registry::new();
    let owner = owner(&registry, &slots);
    let result: Result<(), &str> = owner.setup(|_| Err("inert missing pipe"));
    assert!(result.is_err());
    owner.finish();
    assert!(!owner.request_stop(|_| false));
    assert!(registry.pending_retirement());
    drop(owner);
    assert_eq!(slots.load(Ordering::SeqCst), 1);
    assert_eq!(registry.0.lock().unwrap().len(), 1);
}

#[test]
fn publication_is_zero_accounting_and_rejects_ended_owner() {
    let slots = Arc::new(AtomicUsize::new(0));
    let registry = Registry::new();
    let owner = owner(&registry, &slots);
    assert_eq!(owner.publish(|| 7), Some(7));
    assert_eq!(slots.load(Ordering::SeqCst), 1);
    owner.finish();
    assert!(
        owner
            .publish(|| panic!("must not publish ended owner"))
            .is_none()
    );
    assert_eq!(slots.load(Ordering::SeqCst), 1);
}

#[test]
fn pending_wait_cancellation_keeps_handle_for_later_poll() {
    let slots = Arc::new(AtomicUsize::new(0));
    let registry = Registry::new();
    let owner = owner(&registry, &slots);
    {
        let mut wait = Box::pin(poll_fn(|cx| owner.poll_reap(cx, Process::poll)));
        assert!(
            wait.as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
    }
    assert_eq!(owner.lock().process.polls, 1);
    assert_eq!(slots.load(Ordering::SeqCst), 1);
    owner.lock().process.outcome = Outcome::Success;
    assert_eq!(reap(&owner), Poll::Ready(Ok(Some(()))));
    assert_eq!(slots.load(Ordering::SeqCst), 0);
    registry.remove_reaped(&owner);
    assert!(registry.0.lock().unwrap().is_empty());
}

#[test]
fn wait_error_and_panic_retain_owned_handle_and_charge() {
    let slots = Arc::new(AtomicUsize::new(0));
    let registry = Registry::new();
    let owner = owner(&registry, &slots);
    owner.lock().process.outcome = Outcome::Error;
    assert_eq!(reap(&owner), Poll::Ready(Err("inert wait error")));
    assert_eq!(slots.load(Ordering::SeqCst), 1);
    registry.remove_reaped(&owner);
    assert_eq!(registry.0.lock().unwrap().len(), 1);
    owner.lock().process.outcome = Outcome::Panic;
    assert!(std::panic::catch_unwind(|| reap(&owner)).is_err());
    assert_eq!(slots.load(Ordering::SeqCst), 1);
    owner.lock().process.outcome = Outcome::Success;
    assert_eq!(reap(&owner), Poll::Ready(Ok(Some(()))));
    assert_eq!(slots.load(Ordering::SeqCst), 0);
}

#[test]
fn old_reap_cannot_refund_successor_or_remove_its_registry_entry() {
    let slots = Arc::new(AtomicUsize::new(0));
    let registry = Registry::new();
    let old = owner(&registry, &slots);
    old.lock().process.outcome = Outcome::Success;
    assert_eq!(reap(&old), Poll::Ready(Ok(Some(()))));
    let successor = owner(&registry, &slots);
    assert_eq!(reap(&old), Poll::Ready(Ok(None)));
    registry.remove_reaped(&old);
    registry.remove_reaped(&old);
    assert_eq!(slots.load(Ordering::SeqCst), 1);
    let entries = registry.0.lock().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(Arc::ptr_eq(&entries[0], &successor));
}

#[test]
fn repeated_stop_preserves_submission_but_reap_fences_saved_pid() {
    let slots = Arc::new(AtomicUsize::new(0));
    let registry = Registry::new();
    let owner = owner(&registry, &slots);
    assert!(!owner.request_stop(|_| false));
    assert!(!registry.pending_retirement());
    for expected in 1..=2 {
        assert!(owner.request_stop(|process| {
            process.stops += 1;
            true
        }));
        assert_eq!(owner.lock().process.stops, expected);
    }
    assert!(registry.pending_retirement());
    assert!(owner.publish(|| ()).is_none());
    owner.lock().process.outcome = Outcome::Success;
    assert_eq!(reap(&owner), Poll::Ready(Ok(Some(()))));
    assert!(!owner.request_stop(|_| panic!("stale PID submission")));
    assert!(!registry.pending_retirement());
    assert_eq!(slots_free(slots.load(Ordering::SeqCst), 1), 1);
}

#[test]
fn logical_eof_without_signal_marks_pending_retirement() {
    let slots = Arc::new(AtomicUsize::new(0));
    let registry = Registry::new();
    let owner = owner(&registry, &slots);
    owner.finish();
    assert!(registry.pending_retirement());
    assert_eq!(owner.lock().process.stops, 0);
    assert!(reap(&owner).is_pending());
    assert!(!try_reserve_slot(&slots, 1));
}
