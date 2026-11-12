//! Caller-scope cleanup and reap-owned admission for unregistered RPC children.
//!
//! Only the existing monitor owns cleanup callbacks. Caller drop closes a
//! channel; it never signals a saved PID. Unknown exit deliberately retains its
//! charge even if every owner is dropped, rather than admitting another child.

use futures_util::FutureExt as _;
use std::any::Any;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

/// A slot already counted by admission, returned unless a process takes it.
pub(super) struct Reservation(Option<Arc<AtomicUsize>>);

impl Reservation {
    pub(super) fn new(slots: Arc<AtomicUsize>) -> Self {
        Self(Some(slots))
    }

    /// Call immediately after process creation, before fallible stdio setup.
    pub(super) fn retain(mut self) -> RetainedCharge {
        RetainedCharge(self.0.take().expect("reservation transferred once"))
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(slots) = &self.0 {
            slots.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// Dropping this value does NOT refund capacity: exit is then unconfirmed.
pub(super) struct RetainedCharge(Arc<AtomicUsize>);

impl RetainedCharge {
    pub(super) fn reaped(self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Merely keeping this sender alive represents the caller's cleanup scope.
pub(super) struct RequestScope {
    _sender: oneshot::Sender<()>,
}

pub(super) fn request_scope() -> (RequestScope, oneshot::Receiver<()>) {
    let (sender, receiver) = oneshot::channel();
    (RequestScope { _sender: sender }, receiver)
}

struct State {
    stopped: bool,
    reaped: bool,
    charge: Option<RetainedCharge>,
}

/// Hooks used only by one monitor task, including its supervised cancellation.
pub(super) trait Lifecycle: Sync {
    fn request_stop(&self, reason: &str);
    fn observed_reap(&self);
}

pub(super) struct Owner<C> {
    state: Mutex<State>,
    cleanup: C,
}

impl<C> Owner<C> {
    pub(super) fn new(charge: RetainedCharge, cleanup: C) -> Self {
        Self {
            state: Mutex::new(State {
                stopped: false,
                reaped: false,
                charge: Some(charge),
            }),
            cleanup,
        }
    }
}

impl<C: Fn(&str) + Sync> Lifecycle for Owner<C> {
    fn request_stop(&self, reason: &str) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped || state.reaped {
            return;
        }
        // Mark before the callback, including if cleanup itself unwinds.
        // No lock is held across await; cleanup must not call these hooks.
        state.stopped = true;
        (self.cleanup)(reason);
    }

    fn observed_reap(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.reaped = true;
        if let Some(charge) = state.charge.take() {
            charge.reaped();
        }
    }
}

/// Continue the same monitor after caller drop. Prefer a ready monitor so
/// observed exit fences a simultaneously ready cancellation before signaling.
pub(super) async fn supervise(
    owner: &impl Lifecycle,
    scope_ended: oneshot::Receiver<()>,
    monitor: impl Future<Output = ()>,
) -> Result<(), Box<dyn Any + Send>> {
    std::panic::AssertUnwindSafe(async {
        let monitor = std::panic::AssertUnwindSafe(monitor).catch_unwind();
        tokio::pin!(monitor);
        let result = tokio::select! {
            biased;
            result = &mut monitor => result,
            _ = scope_ended => {
                owner.request_stop("ephemeral request scope ended");
                monitor.await
            }
        };
        if result.is_err() {
            owner.request_stop("monitor panic");
        }
        result
    })
    .catch_unwind()
    .await
    .unwrap_or_else(Err)
}

/// Post-spawn setup failure still owns the process until its wait succeeds.
/// A failed/canceled/panicking wait drops the charge without refunding it.
pub(super) async fn release_on_reap<T, E>(
    charge: RetainedCharge,
    wait: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let result = wait.await?;
    charge.reaped();
    Ok(result)
}

#[cfg(test)]
mod tests;
