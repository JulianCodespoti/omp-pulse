//! Live "a turn is running" events for the native notification stream.
//!
//! The phone shows one silent, updating notification per running turn. These
//! events are NOT notifications in the `notify` sense and deliberately bypass
//! it: they are never retained in the replay ring (twenty status ticks would
//! evict the one `agent_end` a dozing phone must still receive), carry no SSE
//! id (a replay cursor that advanced on a status tick could out-run the ring),
//! and never reach Web Push. A phone that connects mid-turn is told by
//! [`snapshot`]; one that missed the end clears its stale notification when
//! it reconnects.
//!
//! The source is `authority::activity::emit`, the one place every turn start,
//! tool change, bridge turn and turn end already passes through, for daemon
//! children and bridged desktop sessions alike.

use super::*;
use std::collections::HashMap;
use std::sync::{LazyLock, MutexGuard};
use std::time::Instant;
use tokio::sync::broadcast;

use crate::authority::activity;

pub const KIND_PROGRESS: &str = "progress";
pub const KIND_PROGRESS_END: &str = "progress_end";

/// Floor between two updates of one session's notification: a ticking
/// chronometer needs no updates, and Android rate-limits a chattier app.
const MIN_INTERVAL: Duration = Duration::from_millis(2500);

static CHANNEL: LazyLock<broadcast::Sender<Value>> = LazyLock::new(|| broadcast::channel(64).0);
/// Sessions that currently have a progress notification on the phone.
static SLOTS: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct Slot {
    last_sent: Instant,
    line: String,
    /// A change was swallowed by the throttle and a flush task owes the latest
    /// state, so further changes need not schedule another.
    deferred: bool,
}

#[derive(Debug, PartialEq)]
enum Admit {
    Send(Value),
    /// Too soon: re-read the session's state after this long.
    Later(Duration),
    Drop,
}

/// Live receiver for progress events, for one SSE connection.
pub fn subscribe() -> broadcast::Receiver<Value> {
    CHANNEL.subscribe()
}

/// One progress event per currently running session, for a stream that just
/// connected and must not wait for the next change to show a running turn.
pub fn snapshot() -> Vec<Value> {
    activity::snapshot()
        .iter()
        .map(|(session, now)| progress_payload(session, now))
        .collect()
}

/// Fold the activity of `session` (`Value::Null` = idle) into the stream.
pub fn on_activity(session: &str, now: &Value) {
    let admit = gate(&mut slots(), session, now, Instant::now());
    match admit {
        Admit::Send(payload) => {
            let _ = CHANNEL.send(payload);
        }
        Admit::Later(wait) => {
            let owned = session.to_string();
            let spawned = tokio::runtime::Handle::try_current().map(|rt| {
                rt.spawn(async move {
                    tokio::time::sleep(wait).await;
                    if let Some(slot) = slots().get_mut(&owned) {
                        slot.deferred = false;
                    }
                    on_activity(&owned, &activity::current(&owned));
                })
            });
            if spawned.is_err() {
                // No runtime to flush from: forget the deferral so the next
                // change can still go out.
                if let Some(slot) = slots().get_mut(session) {
                    slot.deferred = false;
                }
            }
        }
        Admit::Drop => {}
    }
}

fn slots() -> MutexGuard<'static, HashMap<String, Slot>> {
    SLOTS.lock().unwrap_or_else(|p| p.into_inner())
}

/// The throttle, free of clocks and channels. A turn's first state goes out
/// at once; later ones only when the line changed, at most once per
/// [`MIN_INTERVAL`] (a swallowed change comes back as [`Admit::Later`] once);
/// the end goes out at once and only if a start did.
fn gate(slots: &mut HashMap<String, Slot>, session: &str, now: &Value, at: Instant) -> Admit {
    if now.is_null() {
        return match slots.remove(session) {
            Some(_) => Admit::Send(end_payload(session)),
            None => Admit::Drop,
        };
    }
    let payload = progress_payload(session, now);
    let line = payload["body"].as_str().unwrap_or_default().to_string();
    let Some(slot) = slots.get_mut(session) else {
        slots.insert(
            session.to_string(),
            Slot {
                last_sent: at,
                line,
                deferred: false,
            },
        );
        return Admit::Send(payload);
    };
    if line == slot.line && !slot.deferred {
        return Admit::Drop;
    }
    let wait = MIN_INTERVAL.saturating_sub(at.saturating_duration_since(slot.last_sent));
    if wait.is_zero() {
        *slot = Slot {
            last_sent: at,
            line,
            deferred: false,
        };
        Admit::Send(payload)
    } else if slot.deferred {
        Admit::Drop
    } else {
        slot.deferred = true;
        Admit::Later(wait)
    }
}

/// What the notification says: the running tool call's intent (else its
/// argument, as `activity::tool_label` picked it), else the tool's name, else
/// what the model is doing.
fn live_line(now: &Value) -> String {
    let text = |key: &str| now[key].as_str().filter(|s| !s.is_empty());
    text("label")
        .or_else(|| text("tool"))
        .unwrap_or(if text("state") == Some("writing") {
            "Writing"
        } else {
            "Thinking"
        })
        .to_string()
}

fn progress_payload(session: &str, now: &Value) -> Value {
    let title = now["title"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map_or_else(|| session_title(session), str::to_string);
    let mut payload = push_payload(&title, &live_line(now), session, KIND_PROGRESS, None);
    payload["startedAt"] = now["turnStartedAt"].clone();
    // The daemon's clock now: the phone's differs, so it rebases `startedAt`
    // by the difference to place the chronometer.
    payload["at"] = json!(activity::now_ms());
    payload
}

fn end_payload(session: &str) -> Value {
    push_payload("", "", session, KIND_PROGRESS_END, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn working(label: Option<&str>) -> Value {
        let mut now = json!({"state": "tool", "tool": "bash", "title": "Fix build",
            "turnStartedAt": 1_000u64, "since": 1_000u64, "tools": 0});
        if let Some(label) = label {
            now["label"] = json!(label);
        }
        now
    }

    #[test]
    fn payload_leads_with_intent_then_tool_then_thinking() {
        let p = progress_payload("/s.jsonl", &working(Some("Running the tests")));
        assert_eq!(p["kind"], KIND_PROGRESS);
        assert_eq!(p["title"], "Fix build");
        assert_eq!(p["body"], "Running the tests");
        assert_eq!(p["startedAt"], 1_000);
        assert!(p["at"].as_u64().is_some());
        assert_eq!(progress_payload("/s.jsonl", &working(None))["body"], "bash");
        let idle = json!({"state": "thinking", "title": "t", "turnStartedAt": 1});
        assert_eq!(progress_payload("/s.jsonl", &idle)["body"], "Thinking");
    }

    #[test]
    fn throttle_sends_start_once_per_window_and_ends_only_after_a_start() {
        let mut slots = HashMap::new();
        let t0 = Instant::now();
        let s = "/gate.jsonl";
        assert_eq!(
            gate(&mut slots, s, &Value::Null, t0),
            Admit::Drop,
            "no start, no end"
        );

        assert!(matches!(
            gate(&mut slots, s, &working(Some("a")), t0),
            Admit::Send(_)
        ));
        let soon = t0 + Duration::from_millis(500);
        assert_eq!(
            gate(&mut slots, s, &working(Some("a")), soon),
            Admit::Drop,
            "same line"
        );
        assert_eq!(
            gate(&mut slots, s, &working(Some("b")), soon),
            Admit::Later(MIN_INTERVAL - Duration::from_millis(500)),
            "a change inside the window is deferred, not lost"
        );
        assert_eq!(
            gate(&mut slots, s, &working(Some("c")), soon),
            Admit::Drop,
            "one flush is already owed"
        );
        // The flush re-reads the latest state once the window has passed.
        slots.get_mut(s).unwrap().deferred = false;
        let later = t0 + MIN_INTERVAL;
        assert!(matches!(
            gate(&mut slots, s, &working(Some("c")), later),
            Admit::Send(_)
        ));

        match gate(&mut slots, s, &Value::Null, later) {
            Admit::Send(end) => assert_eq!(end["kind"], KIND_PROGRESS_END),
            other => panic!("end must go out at once, got {other:?}"),
        }
        assert_eq!(
            gate(&mut slots, s, &Value::Null, later),
            Admit::Drop,
            "ended once"
        );
    }
}
