//! Durable physical ownership for registered child admission, separate from routing.
//!
//! Unknown exit retains both handle and charge. Dropping a poll future never
//! takes the handle; only a successful owned wait releases the charge once.

use super::ephemeral::RetainedCharge;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};

struct State<P> {
    process: P,
    charge: Option<RetainedCharge>,
    stopped: bool,
    finished: bool,
    reaped: bool,
}

pub(super) struct Owner<P> {
    state: Mutex<State<P>>,
}

impl<P> Owner<P> {
    fn lock(&self) -> MutexGuard<'_, State<P>> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Setup is synchronous, before any caller can observe this owner.
    pub(super) fn setup<T>(&self, setup: impl FnOnce(&mut P) -> T) -> T {
        setup(&mut self.lock().process)
    }

    /// The caller already holds route registry -> child gate. `publish` must
    /// not acquire either again, signal, await or perform external effects.
    pub(super) fn publish<T>(&self, publish: impl FnOnce() -> T) -> Option<T> {
        let state = self.lock();
        if state.stopped || state.finished || state.reaped {
            return None;
        }
        Some(publish())
    }

    /// Mark before logical liveness/routing is withdrawn. EOF without a stop
    /// is also pending retirement, so another admission cannot evict siblings.
    pub(super) fn finish(&self) {
        self.lock().finished = true;
    }

    /// Stop submission and successful wait share the handle lock. Never send
    /// a saved PID after observed reap; rejected automatic stop leaves no mark.
    pub(super) fn request_stop(&self, stop: impl FnOnce(&mut P) -> bool) -> bool {
        let mut state = self.lock();
        if state.reaped {
            return false;
        }
        if !stop(&mut state.process) {
            return false;
        }
        state.stopped = true;
        true
    }

    /// Whether the owned wait has observed the exit. Read-only: callers that
    /// need the exit poll this rather than wait on the handle themselves.
    pub(super) fn reaped(&self) -> bool {
        self.lock().reaped
    }

    /// Poll exactly once with the durable handle borrowed in place. The
    /// adapter's wait future must be dropped before its closure returns.
    pub(super) fn poll_reap<T, E>(
        &self,
        cx: &mut Context<'_>,
        poll: impl FnOnce(&mut P, &mut Context<'_>) -> Poll<Result<T, E>>,
    ) -> Poll<Result<Option<T>, E>> {
        let mut state = self.lock();
        if state.reaped {
            return Poll::Ready(Ok(None));
        }
        match poll(&mut state.process, cx) {
            Poll::Ready(Ok(status)) => {
                state.reaped = true;
                if let Some(charge) = state.charge.take() {
                    charge.reaped();
                }
                Poll::Ready(Ok(Some(status)))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Manager lifetime, independent of the route, caller and monitor tasks.
/// Owners never point back here, so cancellation cannot create an Arc cycle.
pub(super) struct Registry<P>(Mutex<Vec<Arc<Owner<P>>>>);

impl<P> Registry<P> {
    pub(super) fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }

    pub(super) fn insert(&self, process: P, charge: RetainedCharge) -> Arc<Owner<P>> {
        let owner = Arc::new(Owner {
            state: Mutex::new(State {
                process,
                charge: Some(charge),
                stopped: false,
                finished: false,
                reaped: false,
            }),
        });
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(Arc::clone(&owner));
        owner
    }

    /// Only registered owners are visible here; ephemeral scope policy stays
    /// unchanged. No route/gate locks may be acquired inside this traversal.
    pub(super) fn pending_retirement(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .any(|owner| {
                let state = owner.lock();
                !state.reaped && (state.stopped || state.finished)
            })
    }

    pub(super) fn remove_reaped(&self, owner: &Arc<Owner<P>>) {
        // Drop owner guard before acquiring the registry, never reverse the
        // registry -> owner order used by pending_retirement.
        if !owner.lock().reaped {
            return;
        }
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|current| !Arc::ptr_eq(current, owner));
    }
}

#[cfg(test)]
mod tests;
