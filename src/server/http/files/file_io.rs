//! Bounded blocking work for project-file previews and saves.

use std::time::Duration;

use tokio::sync::Semaphore;

// Shared across GET, POST and every listener/router in this daemon process.
// A hung filesystem operation keeps its slot: admitting more jobs after an
// HTTP cancellation would merely move exhaustion to the blocking pool. Two
// slots let a save overlap a preview.
static FILE_IO: Semaphore = Semaphore::const_new(2);

/// How long a request waits for a slot before answering 503. Waiting is the
/// point: with an immediate refusal, tapping a second file while the first
/// preview was still reading showed an error the file viewer never retried.
const ADMISSION_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Error {
    Busy,
    Join,
}

pub(super) async fn run<T: Send + 'static>(
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Error> {
    run_with_gate(&FILE_IO, ADMISSION_WAIT, operation).await
}

async fn run_with_gate<T: Send + 'static>(
    gate: &'static Semaphore,
    wait: Duration,
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Error> {
    // `timeout` polls the acquire once before its deadline, so a zero wait
    // still takes a free slot. A request dropped while waiting leaves the queue.
    let permit = match tokio::time::timeout(wait, gate.acquire()).await {
        Ok(Ok(permit)) => permit,
        Ok(Err(_)) | Err(_) => return Err(Error::Busy),
    };
    // No await between acquiring admission and transferring it to the job.
    // The blocking pool may queue this one admitted job. Dropping the caller
    // cannot release its slot while it remains queued or executing.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| Error::Join)
}

#[cfg(test)]
mod tests;
