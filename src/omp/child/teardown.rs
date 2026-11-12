//! Teardown helpers: killing and gracefully terminating children, submitting
//! signals, and recording how a child exited.

use super::*;
use crate::types::ChildEvent;

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::Child as TokioChild;
use tokio::sync::broadcast;
use tracing::{info, warn};

/// Called only with the registered owner's handle/reap mutex held.
fn submit_term(pid: i32, process: &mut TokioChild) -> bool {
    #[cfg(unix)]
    if pid > 0 {
        // SAFETY: kill(2) takes plain integers and touches no memory.
        if unsafe { libc::kill(-pid, libc::SIGTERM) } == 0 {
            return true;
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    process.start_kill().is_ok()
}

/// SIGKILL the group and the leader. Called only with the registered owner's
/// handle/reap mutex held, so a reaped pid is never signalled.
pub(super) fn submit_kill(pid: i32, process: &mut TokioChild) -> bool {
    #[cfg(unix)]
    if pid > 0 {
        // SAFETY: kill(2) takes plain integers and touches no memory.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    #[cfg(not(unix))]
    let _ = pid;
    process.start_kill().is_ok()
}

/// How long a deleted session's child gets to exit on SIGTERM (omp flushes on
/// exit; a ~300 MB child on a swapping phone is slow) before SIGKILL.
pub(super) const DELETED_EXIT_GRACE: Duration = Duration::from_secs(5);
/// How long the reap may take after that SIGKILL.
pub(super) const DELETED_KILL_GRACE: Duration = Duration::from_secs(2);

/// Wait up to `deadline` for the monitor's owned wait to reap `child`.
/// Polls the owner's reaped mark instead of waiting on the handle itself: a
/// second waiter would steal the monitor's wake-up and strand its
/// `remove_reaped`, leaving a retirement pending forever.
pub(super) async fn await_reaped(child: &Child, deadline: Duration) -> bool {
    // Only registered children are ever bound to a session; an ephemeral
    // query child has no session file to resurrect.
    let Some(owner) = &child.physical else {
        return true;
    };
    let start = std::time::Instant::now();
    loop {
        if owner.reaped() {
            return true;
        }
        if start.elapsed() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Whether the daemon meant a child to go. A planned stop (reap, idle
/// eviction, rss recycle, shutdown, a one-shot query child) is a clean end
/// the phone shows as nothing at all; an unexpected one (crash, failed boot,
/// a kill that cut a turn, a terminal taking the session) is an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Exit {
    Planned,
    Unexpected,
}

/// Mark dead, reject every pending rpc, deregister from the registry, and
/// broadcast the exit: `ChildEvent::Stopped` when planned, else a Notice.
/// Idempotent (the alive flag is the guard).
pub(super) fn finish_child(
    tx: &broadcast::Sender<ChildEvent>,
    children: &Arc<Mutex<HashMap<String, Arc<Child>>>>,
    child: &Arc<Child>,
    why: &str,
    exit: Exit,
) {
    let (session, pending, exit) = {
        let mut gate = lock_poisoned(&child.gate);
        if !child.alive.load(Ordering::SeqCst) {
            return;
        }
        if let Some(owner) = &child.physical {
            owner.finish();
        }
        child.alive.store(false, Ordering::SeqCst);
        gate.phase = ChildPhase::Finished;
        let session = lock_poisoned(&child.session).clone();
        lock_poisoned(&child.pending_ui).clear();
        lock_poisoned(&child.feedback).clear();
        // Dropping the senders wakes every waiting phone control at once
        // instead of each waiting out its timeout.
        lock_poisoned(&child.extension_replies).clear();
        let exit = gate.intended_exit.take().unwrap_or(exit);
        (session, std::mem::take(&mut gate.pending), exit)
    };
    // Ownership-file operations, waiter wakeups and registry removal happen
    // outside the gate, preserving the registry -> gate lock order.
    if !session.is_empty() {
        crate::authority::owner::release(&session, child.pid);
    }
    for (_, rpc) in pending {
        let _ = rpc.tx.send(Err(format!("agent process {why}")));
    }
    if !session.is_empty() {
        let mut map = lock_poisoned(children);
        if map
            .get(&session)
            .map(|c| Arc::ptr_eq(c, child))
            .unwrap_or(false)
        {
            map.remove(&session);
        }
    }
    // Dead and deregistered: its work no longer holds the phone awake.
    child.busy_may_have_changed();
    let _ = tx.send(ChildEvent::Event {
        session: session.clone(),
        event: json!({"type": "extension_ui_snapshot", "requests": []}),
        source: Some(child_source_stamp(child)),
    });
    let source = Some(child_source_stamp(child));
    let _ = tx.send(match exit {
        Exit::Planned => ChildEvent::Stopped {
            session: session.clone(),
            why: why.to_string(),
            source,
        },
        Exit::Unexpected => ChildEvent::Notice {
            session: session.clone(),
            message: format!("agent process {why}"),
            source,
        },
    });
    info!("child {why}: {session}");
}

/// SIGTERM the child's whole process group (graceful; omp flushes session
/// state on exit, and the MCP servers it spawned go with it), falling back to
/// tokio's start_kill (SIGKILL) when the group is gone or on non-Unix.
///
/// A direct kill(2), not the coreutils `kill` binary: each spawn was a
/// fork+exec (PATH search and execve, all trapped by proot on the phone), and
/// the dropped std `Child` was never waited, leaving one zombie per reap.
pub(super) fn term_proc(child: &Child) -> bool {
    if let Some(owner) = &child.physical {
        return owner.request_stop(|process| submit_term(child.pid, process));
    }
    #[cfg(unix)]
    if child.pid > 0 {
        // The child leads its own group (see `spawn`), so `-pid` is the group.
        // SAFETY: kill(2) takes plain integers and touches no memory.
        if unsafe { libc::kill(-child.pid, libc::SIGTERM) } == 0 {
            return true;
        }
    }
    let mut guard = lock_poisoned(&child.proc);
    guard.as_mut().is_some_and(|p| p.start_kill().is_ok())
}

impl ChildManager {
    /// SIGTERM (omp flushes session state on exit) with SIGKILL fallback.
    pub(super) fn kill(&self, child: &Arc<Child>, why: &str, exit: Exit) {
        {
            let mut gate = lock_poisoned(&child.gate);
            gate.phase = ChildPhase::Terminating;
            gate.intended_exit = Some(exit);
            let _ = term_proc(child);
        }
        finish_child(
            &self.tx,
            &self.children,
            child,
            &format!("terminated ({why})"),
            exit,
        );
    }

    /// Stop a child WITHOUT leaving an unfinished turn in its session file.
    /// A raw SIGTERM mid-stream leaves the turn open, and the next process
    /// that opens the session writes "Previous OMP process exited before
    /// completing the turn" into the transcript. If a turn is streaming,
    /// first ask the child to abort and wait briefly for the stream to close
    /// (omp then writes message_end/agent_end with stopReason:"aborted", a
    /// clean turn boundary), then SIGTERM.
    ///
    /// A child still streaming after that wait (a slow abort under swap
    /// pressure) is killed mid-turn. Nothing would ever end that turn, so a
    /// synthetic `session_settled` from the same source settles it first, and
    /// the exit counts as unexpected whatever the caller planned.
    pub(super) async fn graceful_terminate(&self, child: &Arc<Child>, why: &str, mut exit: Exit) {
        if child.streaming.load(Ordering::SeqCst) && child.alive.load(Ordering::SeqCst) {
            let _ = Self::rpc_with_id(
                child,
                &self.next_rpc_id(),
                "abort",
                Value::Null,
                Duration::from_secs(5),
                RpcAccess::Operator,
            )
            .await;
            for _ in 0..20 {
                if !child.streaming.load(Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            if child.streaming.swap(false, Ordering::SeqCst) && child.alive.load(Ordering::SeqCst) {
                warn!("child still streaming after abort; settling its turn before {why}");
                let (session, source) = child_bound_stamp(child);
                let _ = self.tx.send(ChildEvent::Event {
                    session,
                    event: json!({ "type": "session_settled", "synthetic": true }),
                    source: Some(source),
                });
                exit = Exit::Unexpected;
            }
        }
        self.kill(child, why, exit);
    }
}

// Every test here drives `stand_in_child`, a real `cat` process, so the module
// only exists where those tests compile: on Unix.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::omp::child::tests::stand_in_child;

    /// A planned stop says so on the event stream (no error), an unexpected
    /// one is the "agent process …" notice the router turns into an error.
    #[cfg(unix)]
    #[tokio::test]
    async fn planned_and_unexpected_exits_are_told_apart() {
        let children: Arc<Mutex<HashMap<String, Arc<Child>>>> = Arc::default();
        let (tx, mut rx) = broadcast::channel(16);
        let reaped = stand_in_child();
        lock_poisoned(&reaped.feedback).apply(
            &json!({"type":"extension_ui_request","method":"setStatus","statusKey":"git","statusText":"main"}),
            now_ms(),
        );
        lock_poisoned(&children).insert("/synthetic/turn.jsonl".to_string(), Arc::clone(&reaped));
        finish_child(
            &tx,
            &children,
            &reaped,
            "terminated (idle reap)",
            Exit::Planned,
        );
        match rx.try_recv().unwrap() {
            ChildEvent::Event { event, .. } => {
                assert_eq!(event, json!({"type":"extension_ui_snapshot","requests":[]}))
            }
            other => panic!("expected feedback reset, got {other:?}"),
        }
        match rx.try_recv().unwrap() {
            ChildEvent::Stopped {
                session,
                why,
                source,
            } => {
                assert_eq!(session, "/synthetic/turn.jsonl");
                assert_eq!(why, "terminated (idle reap)");
                assert!(source.is_some());
            }
            other => panic!("expected Stopped, got {other:?}"),
        }
        assert_eq!(
            lock_poisoned(&reaped.feedback).snapshot(now_ms())["requests"],
            json!([])
        );
        assert!(lock_poisoned(&children).is_empty());
        // Idempotent: the monitor's later EOF adds nothing.
        finish_child(&tx, &children, &reaped, "exited", Exit::Unexpected);
        assert!(rx.try_recv().is_err());

        let crashed = stand_in_child();
        finish_child(&tx, &children, &crashed, "exited", Exit::Unexpected);
        match rx.try_recv().unwrap() {
            ChildEvent::Event { event, .. } => {
                assert_eq!(event, json!({"type":"extension_ui_snapshot","requests":[]}))
            }
            other => panic!("expected feedback reset, got {other:?}"),
        }
        match rx.try_recv().unwrap() {
            ChildEvent::Notice { message, .. } => assert_eq!(message, "agent process exited"),
            other => panic!("expected Notice, got {other:?}"),
        }
    }
}
