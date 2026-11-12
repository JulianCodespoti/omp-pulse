//! Per-peer relay output reservations survive dequeue and the socket send await.
use super::RouteFrame;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub(super) const MAX_FRAMES: usize = 256;
pub(super) const MAX_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone)]
pub(super) struct Sender {
    tx: mpsc::UnboundedSender<QueuedFrame>,
    budget: Arc<Mutex<Budget>>,
}

pub(super) struct Receiver {
    rx: mpsc::UnboundedReceiver<QueuedFrame>,
    budget: Arc<Mutex<Budget>>,
}

struct Budget {
    frames: usize,
    bytes: usize,
    max_frames: usize,
    max_bytes: usize,
    closed: bool,
}

pub(super) struct QueuedFrame {
    pub(super) frame: RouteFrame,
    // The frame owns its charge until the writer finishes or is cancelled.
    _reservation: Reservation,
}

struct Reservation {
    budget: Arc<Mutex<Budget>>,
    bytes: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum SendError {
    Closed,
    Overloaded,
}

pub(super) fn channel() -> (Sender, Receiver) {
    channel_with_limits(MAX_FRAMES, MAX_BYTES)
}

pub(super) fn channel_with_limits(max_frames: usize, max_bytes: usize) -> (Sender, Receiver) {
    let (tx, rx) = mpsc::unbounded_channel();
    let budget = Arc::new(Mutex::new(Budget {
        frames: 0,
        bytes: 0,
        max_frames,
        max_bytes,
        closed: false,
    }));
    (
        Sender {
            tx,
            budget: budget.clone(),
        },
        Receiver { rx, budget },
    )
}

impl Sender {
    #[cfg(test)]
    pub(super) fn usage(&self) -> (usize, usize) {
        let budget = self.budget.lock().unwrap_or_else(|p| p.into_inner());
        (budget.frames, budget.bytes)
    }

    pub(super) fn send(&self, frame: RouteFrame) -> Result<(), SendError> {
        let bytes = match &frame {
            RouteFrame::Binary(bytes) => bytes.len(),
            RouteFrame::Text(text) => text.len(),
            RouteFrame::Close(_) => 2,
        };
        let mut budget = self.budget.lock().unwrap_or_else(|p| p.into_inner());
        if budget.closed || self.tx.is_closed() {
            return Err(SendError::Closed);
        }
        let total = budget.bytes.checked_add(bytes);
        if budget.frames >= budget.max_frames || total.is_none_or(|total| total > budget.max_bytes)
        {
            // Linearize retirement before any captured sender can admit more.
            budget.closed = true;
            return Err(SendError::Overloaded);
        }
        budget.frames += 1;
        budget.bytes = total.expect("checked output byte reservation");
        let result = self.tx.send(QueuedFrame {
            frame,
            _reservation: Reservation {
                budget: self.budget.clone(),
                bytes,
            },
        });
        if result.is_err() {
            budget.closed = true;
        }
        // A failed send owns its reservation. Dropping that error with this
        // mutex held would deadlock when Reservation::drop re-enters it.
        drop(budget);
        result.map_err(|_| SendError::Closed)
    }

    pub(super) fn close(&self) {
        self.budget.lock().unwrap_or_else(|p| p.into_inner()).closed = true;
    }

    pub(super) fn is_closed(&self) -> bool {
        self.budget.lock().unwrap_or_else(|p| p.into_inner()).closed || self.tx.is_closed()
    }
}

impl Receiver {
    pub(super) async fn recv(&mut self) -> Option<QueuedFrame> {
        self.rx.recv().await
    }

    #[cfg(test)]
    pub(super) fn try_recv(&mut self) -> Result<QueuedFrame, mpsc::error::TryRecvError> {
        self.rx.try_recv()
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.budget.lock().unwrap_or_else(|p| p.into_inner()).closed = true;
        // The guard is gone before rx drops all queued reservations.
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut budget = self.budget.lock().unwrap_or_else(|p| p.into_inner());
        budget.frames -= 1;
        budget.bytes -= self.bytes;
    }
}

#[cfg(test)]
mod tests;
