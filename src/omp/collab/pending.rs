//! Collab dialogs awaiting an answer, and answers queued while the desktop link
//! is down, kept process-wide so whichever phone attaches next sees them.

use serde_json::Value;
use std::collections::HashMap;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Collab dialogs still awaiting an answer, per session, keyed by `reqId`.
///
/// WHY THIS EXISTS: the desktop broadcasts a `ui-request` ONCE. If no phone has a
/// socket open at that instant — the tab was asleep, the network dropped, or the
/// daemon had just restarted — the frame fans out to zero clients and is gone, so
/// the phone shows nothing and the desktop agent blocks forever on an answer that
/// can no longer be requested. Measured exactly that: `clients: 0` at the moment
/// an `ask` was raised, and the phone never saw it.
///
/// It is NOT enough that the collab host replays pending requests to joining
/// PEERS: the phone is not a collab peer, it is a WS client of this daemon, and
/// the daemon's relay tap does not re-trigger the host's replay. So the daemon
/// keeps its own copy and replays it on WS attach, exactly as it does for a
/// child's `extension_ui_request`.
///
/// Process-wide because the answer does not belong to any one client: whichever
/// phone attaches next must see the question.
/// Session path -> the dialogs it is waiting on, oldest first, each with its reqId.
type PendingUiBySession = HashMap<String, Vec<(u64, Value)>>;

pub(super) static PENDING_COLLAB_UI: std::sync::LazyLock<Mutex<PendingUiBySession>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Keep live lifecycle mutation+send ordered even when terminal retirement
/// races a host reader. Snapshot capture needs only PENDING_COLLAB_UI.
pub(super) static COLLAB_UI_DELIVERY: Mutex<()> = Mutex::new(());

// A snapshot stores only outstanding requests, never an unbounded end-ID log.
// Revisions are consumed under PENDING_COLLAB_UI, which is also the snapshot
// barrier. A process generation prevents an empty post-restart cache from
// pretending it observed closures in a previous daemon.
static UI_GENERATION: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| format!("{:032x}", rand::random::<u128>()));
static UI_REVISION: AtomicU64 = AtomicU64::new(0);

fn lifecycle(session: &str, revision: u64) -> Value {
    serde_json::json!({
        "sessionPath": session, "generation": *UI_GENERATION, "revision": revision
    })
}

/// Complete, atomic pending set, captured before the attaching socket's first
/// await. Clients ignore queued lifecycle frames at/below this revision.
pub fn collab_ui_snapshot(session: &str) -> Value {
    let map = PENDING_COLLAB_UI.lock().unwrap_or_else(|p| p.into_inner());
    let requests: Vec<&Value> = map
        .get(session)
        .map(|list| list.iter().map(|(_, request)| request).collect())
        .unwrap_or_default();
    serde_json::json!({
        "type": "collab_ui_snapshot", "complete": true,
        "lifecycle": lifecycle(session, UI_REVISION.load(Ordering::Relaxed)),
        "requests": requests
    })
}

// Reserved answers stay fenced until the host ends the request. A channel
// handoff cannot prove callback acceptance, nor authorize another phone to send.
type DispatchedUi = HashMap<(String, u64), (bool, Option<String>)>;
static DISPATCHED_UI: std::sync::LazyLock<Mutex<DispatchedUi>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) enum AnswerClaim {
    New,
    Existing { queued: bool },
    Conflict,
}

pub(super) fn claim_collab_answer(
    session: &str,
    req_id: u64,
    value: Option<&str>,
    queued: bool,
) -> AnswerClaim {
    let mut sent = DISPATCHED_UI.lock().unwrap_or_else(|p| p.into_inner());
    match sent.entry((session.to_string(), req_id)) {
        std::collections::hash_map::Entry::Vacant(entry) => {
            entry.insert((queued, value.map(str::to_string)));
            AnswerClaim::New
        }
        std::collections::hash_map::Entry::Occupied(entry) => {
            let (queued, previous) = entry.get();
            if previous.as_deref() == value {
                AnswerClaim::Existing { queued: *queued }
            } else {
                AnswerClaim::Conflict
            }
        }
    }
}

pub(super) fn collab_answer_in_flight(session: &str, req_id: u64) -> bool {
    DISPATCHED_UI
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains_key(&(session.to_string(), req_id))
}

pub(super) fn release_collab_answer(session: &str, req_id: u64) {
    DISPATCHED_UI
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&(session.to_string(), req_id));
}

pub(super) fn mark_collab_answer_handoff(session: &str, req_id: u64) {
    if let Some((queued, _)) = DISPATCHED_UI
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(&(session.to_string(), req_id))
    {
        *queued = false;
    }
}

#[cfg(test)]
pub(super) fn collab_question_pending(session: &str, req_id: u64) -> bool {
    PENDING_COLLAB_UI
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(session)
        .is_some_and(|list| list.iter().any(|(id, _)| *id == req_id))
}

/// Test inspection; production guards compare borrowed tokens without cloning.
#[cfg(test)]
pub(super) fn collab_question_token(session: &str, req_id: u64) -> Option<String> {
    PENDING_COLLAB_UI
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(session)?
        .iter()
        .find(|(id, _)| *id == req_id)?
        .1
        .get("pulseQuestionToken")?
        .as_str()
        .map(str::to_owned)
}

pub(super) fn collab_question_matches(session: &str, req_id: u64, token: &str) -> bool {
    PENDING_COLLAB_UI
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(session)
        .is_some_and(|list| {
            list.iter().any(|(id, request)| {
                *id == req_id
                    && request.get("pulseQuestionToken").and_then(Value::as_str) == Some(token)
            })
        })
}

pub fn pending_collab_ui_request(session: &str) -> bool {
    PENDING_COLLAB_UI
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(session)
        .is_some_and(|list| !list.is_empty())
}

/// Remember a dialog the desktop is waiting on, newest last. A re-issued reqId
/// replaces its older payload.
pub(super) fn remember_collab_ui(session: &str, req_id: u64, request: &Value) -> Value {
    let mut map = PENDING_COLLAB_UI.lock().unwrap_or_else(|p| p.into_inner());
    let revision = UI_REVISION.fetch_add(1, Ordering::Relaxed) + 1;
    let list = map.entry(session.to_string()).or_default();
    let previous = list.iter().find(|(id, stored)| {
        *id == req_id && stored.get("pulseRoomId") == request.get("pulseRoomId")
    });
    let token = previous
        .and_then(|(_, stored)| stored.get("pulseQuestionToken"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!(format!("{}:{revision}", *UI_GENERATION)));
    let mut request = request.clone();
    request["pulseQuestionToken"] = token;
    list.retain(|(id, _)| *id != req_id);
    list.push((req_id, request.clone()));
    serde_json::json!({
        "type": "collab_ui_request", "request": request,
        "lifecycle": lifecycle(session, revision)
    })
}

/// Forget one dialog: the host settled it (answered here, elsewhere, or withdrawn).
pub(super) fn forget_collab_ui(session: &str, req_id: u64) -> Value {
    release_collab_answer(session, req_id);
    if let Ok(mut answers) = PENDING_ANSWERS.lock()
        && let Some(list) = answers.get_mut(session)
    {
        list.retain(|(id, _, _, _)| *id != req_id);
    }
    let mut map = PENDING_COLLAB_UI.lock().unwrap_or_else(|p| p.into_inner());
    let revision = UI_REVISION.fetch_add(1, Ordering::Relaxed) + 1;
    let mut token = Value::Null;
    if let Some(list) = map.get_mut(session) {
        if let Some((_, request)) = list.iter().find(|(id, _)| *id == req_id) {
            token = request
                .get("pulseQuestionToken")
                .cloned()
                .unwrap_or(Value::Null);
        }
        list.retain(|(id, _)| *id != req_id);
        if list.is_empty() {
            map.remove(session);
        }
    }
    serde_json::json!({
        "type": "collab_ui_request_end", "reqId": req_id,
        "pulseQuestionToken": token, "lifecycle": lifecycle(session, revision)
    })
}

/// Drop every remembered dialog for a session: the room ended, so nothing can be
/// answered any more and a replayed card would be a dead control.
pub(super) fn forget_collab_ui_session(session: &str) {
    DISPATCHED_UI
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|(path, _), _| path != session);
    if let Ok(mut map) = PENDING_COLLAB_UI.lock()
        && map.remove(session).is_some()
    {
        UI_REVISION.fetch_add(1, Ordering::Relaxed);
    }
}

/// Every session with a dialog the desktop is still waiting on.
///
/// The inbox needs this: a question is only DELIVERABLE once the phone opens that
/// specific conversation, so without a hint in the list the user has to open each
/// one to discover which is blocked — measured as "I had to send a message to
/// connect". Deliberately NOT folded into `/api/sessions`, whose payload is
/// ETag-cached against file state (1.87 MB -> 0 bytes on a steady poll); a flag
/// that changes independently of the file would either break that validator or
/// force it to churn.
pub fn sessions_awaiting_ui() -> Vec<String> {
    PENDING_COLLAB_UI
        .lock()
        .ok()
        .map(|m| {
            m.iter()
                .filter(|(_, v)| !v.is_empty())
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Inspect the outstanding set in behavior tests.
#[cfg(test)]
pub(super) fn pending_collab_ui_requests(session: &str) -> Vec<Value> {
    PENDING_COLLAB_UI
        .lock()
        .ok()
        .and_then(|m| {
            m.get(session)
                .map(|l| l.iter().map(|(_, v)| v.clone()).collect())
        })
        .unwrap_or_default()
}

/// Collab dialog answers that arrived while the desktop link was
/// transiently down, per session, keyed by `reqId`, oldest first.
///
/// WHY THIS EXISTS: refusing an answer during reconnect backoff (measured
/// ~75s) told the phone "not attached … try again" even though the question
/// was STILL live and a retry later would work — the user saw the sticky
/// banner "answer not received … - try again" succeed only sometimes.
/// Queuing turns the outage into a delivery delay: the answer sits here
/// until the next successful attach flushes it into the live connection.
///
/// Bounded so a flapping desktop cannot grow it without end: one entry per
/// reqId (a re-answer replaces the older payload), 32 per session (oldest
/// evicted), 120s TTL. Process-wide like [`PENDING_COLLAB_UI`] — the answer
/// belongs to the session, not to whichever phone happened to hold the
/// socket when the link dropped.
type PendingAnswersBySession =
    HashMap<String, Vec<(u64, Option<String>, std::time::Instant, String)>>;

pub(super) static PENDING_ANSWERS: std::sync::LazyLock<Mutex<PendingAnswersBySession>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Per-session cap on queued answers; a full queue evicts the OLDEST entry.
const PENDING_ANSWERS_MAX_PER_SESSION: usize = 32;

/// How long a queued answer may wait for the link to return. Past this the
/// desktop is presumed gone (or the room restarted — new rooms renumber
/// reqIds from 1), so delivering it could answer a dialog nobody asked.
const PENDING_ANSWERS_TTL: Duration = Duration::from_secs(120);

/// Fired by [`queue_collab_answer`] so the expiry sweep, parked while no
/// answer is queued, wakes to track the new answer's TTL. `notify_one` keeps
/// a permit, so an answer queued mid-sweep is not missed.
pub(super) static ANSWER_QUEUED: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Queue an answer for delivery on the next successful attach, newest last.
/// A re-answer of the same reqId replaces the older payload (and restarts
/// its TTL), exactly like [`remember_collab_ui`].
pub(super) fn queue_collab_answer(
    session: &str,
    req_id: u64,
    value: Option<&str>,
    question_token: &str,
) {
    if let Ok(mut map) = PENDING_ANSWERS.lock() {
        let list = map.entry(session.to_string()).or_default();
        list.retain(|(id, _, _, _)| *id != req_id);
        list.push((
            req_id,
            value.map(str::to_string),
            Instant::now(),
            question_token.to_owned(),
        ));
        if list.len() > PENDING_ANSWERS_MAX_PER_SESSION {
            let over = list.len() - PENDING_ANSWERS_MAX_PER_SESSION;
            list.drain(..over);
        }
    }
    ANSWER_QUEUED.notify_one();
}

/// When the oldest queued answer expires, or `None` with nothing queued.
/// One millisecond past the TTL because expiry is strictly `> TTL`: waking
/// exactly at the boundary would find nothing expired and re-arm the same
/// deadline.
pub(super) fn next_answer_expiry() -> Option<Instant> {
    let map = PENDING_ANSWERS.lock().unwrap_or_else(|p| p.into_inner());
    map.values()
        .flatten()
        .map(|(_, _, at, _)| *at)
        .min()
        .map(|at| at + PENDING_ANSWERS_TTL + Duration::from_millis(1))
}

/// The expiry sweep's loop. `sweep` reports expired answers and returns the
/// next expiry (`None` when nothing is queued), or `Break` once the manager
/// is gone.
///
/// It used to tick every 30 s forever, waking a phone with no collab at all
/// and keeping it from sleeping. Now it parks on `wake` while nothing is
/// queued and otherwise sleeps exactly until the oldest answer expires,
/// which also surfaces an expiry on the phone at the TTL instead of up to
/// one tick later.
pub(super) async fn run_answer_sweep(
    wake: &Notify,
    mut sweep: impl FnMut() -> ControlFlow<(), Option<tokio::time::Instant>>,
) {
    loop {
        let ControlFlow::Continue(next) = sweep() else {
            return;
        };
        match next {
            None => wake.notified().await,
            // A newly queued answer expires after every one already queued,
            // but a re-answer restarts its TTL; re-evaluating on each queue
            // keeps the deadline right either way.
            Some(deadline) => tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {}
                _ = wake.notified() => {}
            },
        }
    }
}

type PendingAnswerBatch = (Vec<(u64, Option<String>, String)>, Vec<(u64, String)>);

/// Take a session's queued answers, oldest first, splitting them into the ones
/// still worth delivering and the ones whose TTL has passed.
///
/// Expired answers are RETURNED, not quietly discarded: the dialog they belong to
/// is still pending on the desktop, and the phone has been showing "answer held"
/// since the tap. Dropping them silently left that card claiming a delivery that
/// never happened - the caller must tell the phone so the question becomes
/// answerable again.
pub(super) fn take_pending_answers(session: &str) -> PendingAnswerBatch {
    let mut live = Vec::new();
    let mut expired = Vec::new();
    if let Ok(mut map) = PENDING_ANSWERS.lock()
        && let Some(list) = map.remove(session)
    {
        let now = std::time::Instant::now();
        for (req_id, value, at, token) in list {
            if now.duration_since(at) <= PENDING_ANSWERS_TTL {
                live.push((req_id, value, token));
            } else {
                if collab_question_matches(session, req_id, &token) {
                    release_collab_answer(session, req_id);
                }
                expired.push((req_id, token));
            }
        }
    }
    (live, expired)
}

/// Every session holding at least one expired answer, with those reqIds.
///
/// WHY A SWEEP EXISTS: expiry is only noticed where answers are drained, and that
/// happens on ATTACH. A desktop that never comes back therefore never triggers it,
/// so without this the phone would wait forever on a card that says the answer is
/// held. The sweep runs when the oldest answer's TTL passes.
pub(super) fn expired_pending_answers() -> Vec<(String, Vec<(u64, String)>)> {
    let mut out: Vec<(String, Vec<(u64, String)>)> = Vec::new();
    if let Ok(mut map) = PENDING_ANSWERS.lock() {
        let now = Instant::now();
        for (session, list) in map.iter_mut() {
            let mut gone = Vec::new();
            list.retain(|(req_id, _, at, token)| {
                if now.duration_since(*at) > PENDING_ANSWERS_TTL {
                    gone.push((*req_id, token.clone()));
                    if collab_question_matches(session, *req_id, token.as_str()) {
                        release_collab_answer(session, *req_id);
                    }
                    false
                } else {
                    true
                }
            });
            if !gone.is_empty() {
                out.push((session.clone(), gone));
            }
        }
        map.retain(|_, list| !list.is_empty());
    }
    out
}

/// The one wording for an answer that waited out its TTL. Says what happened and
/// what to do, and never suggests the daemon will retry - it will not.
pub(super) const ANSWER_EXPIRED: &str =
    "the desktop never came back for this answer - answer it again";

/// Drop every queued answer for a session: the room ended (terminal loss,
/// bye, or an explicit detach), so none can be delivered and flushing them
/// into a future room could hit a reqId that was never asked there.
pub(super) fn forget_pending_answers(session: &str) {
    if let Ok(mut map) = PENDING_ANSWERS.lock() {
        map.remove(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_snapshot_reconciles_missed_end_without_a_tombstone_log() {
        let session = "/synthetic/collab-missed-end-snapshot.jsonl";
        let other = "/synthetic/collab-other-snapshot.jsonl";
        forget_collab_ui_session(session);
        let first = remember_collab_ui(
            session,
            7,
            &serde_json::json!({
                "reqId":7, "kind":"select", "pulseRoomId":"room-a"
            }),
        );
        let token = first["request"]["pulseQuestionToken"].clone();
        let before = collab_ui_snapshot(session);
        assert_eq!(before["complete"], true);
        assert_eq!(before["requests"][0], first["request"]);
        assert_eq!(collab_ui_snapshot(other)["requests"], serde_json::json!([]));
        // A handoff/transport gap never edits the authoritative pending set.
        assert!(matches!(
            claim_collab_answer(session, 7, Some("yes"), false),
            AnswerClaim::New
        ));
        assert_eq!(
            collab_ui_snapshot(session)["requests"][0]["pulseQuestionToken"],
            token
        );
        let updated = remember_collab_ui(
            session,
            7,
            &serde_json::json!({
                "reqId":7, "kind":"select", "title":"updated", "pulseRoomId":"room-a"
            }),
        );
        assert_eq!(updated["request"]["pulseQuestionToken"], token);
        // The client misses this exact end; reconnect still gets its evidence.
        let end = forget_collab_ui(session, 7);
        assert_eq!(end["pulseQuestionToken"], token);
        let after = collab_ui_snapshot(session);
        assert_eq!(
            after["lifecycle"]["generation"],
            before["lifecycle"]["generation"]
        );
        assert_eq!(after["lifecycle"]["sessionPath"], session);
        assert!(
            after["lifecycle"]["revision"].as_u64().unwrap()
                > before["lifecycle"]["revision"].as_u64().unwrap()
        );
        assert_eq!(after["requests"], serde_json::json!([]));
        assert!(!collab_answer_in_flight(session, 7));
        let reused = remember_collab_ui(
            session,
            7,
            &serde_json::json!({"reqId":7,"pulseRoomId":"room-b"}),
        );
        assert_ne!(reused["request"]["pulseQuestionToken"], token);
        forget_collab_ui_session(session);
        assert!(
            PENDING_COLLAB_UI.lock().unwrap().get(session).is_none(),
            "no completed-session cache"
        );
    }

    #[test]
    fn host_end_discards_queued_answer_before_any_reconnect_flush() {
        let session = "/synthetic/ended-queued-question.jsonl";
        forget_collab_ui_session(session);
        forget_pending_answers(session);
        remember_collab_ui(session, 7, &serde_json::json!({"reqId":7}));
        assert!(matches!(
            claim_collab_answer(session, 7, Some("draft"), true),
            AnswerClaim::New
        ));
        queue_collab_answer(
            session,
            7,
            Some("draft"),
            &collab_question_token(session, 7).expect("queued question identity"),
        );
        forget_collab_ui(session, 7);
        assert!(!collab_question_pending(session, 7));
        assert!(!collab_answer_in_flight(session, 7));
        assert!(
            take_pending_answers(session).0.is_empty(),
            "a completed question cannot receive a queued answer"
        );
    }

    /// A dialog raised while no phone is attached must survive to be replayed. This
    /// is the bug that made an `ask` invisible: the host broadcasts once, the hub
    /// had zero clients, and the frame was gone — so the desktop blocked forever.
    #[test]
    fn pending_collab_ui_survives_until_settled() {
        let session = "/tmp/retention-a.jsonl";
        forget_collab_ui_session(session);
        let mk = |id: u64, title: &str| serde_json::json!({ "reqId": id, "kind": "select", "title": title, "options": ["A", "B"] });
        remember_collab_ui(session, 1, &mk(1, "first"));
        remember_collab_ui(session, 2, &mk(2, "second"));
        let replay = pending_collab_ui_requests(session);
        assert_eq!(replay.len(), 2, "both dialogs replay");
        // Oldest first: the phone renders them in the order the desktop asked.
        assert_eq!(
            replay[0].get("title").and_then(Value::as_str),
            Some("first")
        );
        assert_eq!(
            replay[1].get("title").and_then(Value::as_str),
            Some("second")
        );

        // A re-issued reqId replaces its payload rather than duplicating it: a
        // multi-select re-issues the same question as the answer set changes.
        remember_collab_ui(session, 1, &mk(1, "first-updated"));
        let replay = pending_collab_ui_requests(session);
        assert_eq!(replay.len(), 2, "no duplicate for a re-issued reqId");
        assert!(
            replay
                .iter()
                .any(|r| r.get("title").and_then(Value::as_str) == Some("first-updated")),
            "latest payload wins"
        );

        // Settled: stop replaying it, or a phone attaching later gets a card whose
        // answer nobody is waiting for.
        forget_collab_ui(session, 1);
        let replay = pending_collab_ui_requests(session);
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].get("reqId").and_then(Value::as_u64), Some(2));

        // Room gone: every remembered dialog is now a dead control.
        forget_collab_ui_session(session);
        assert!(pending_collab_ui_requests(session).is_empty());
    }

    /// Retention is per session, so one conversation's question can never be
    /// replayed into another's transcript.
    #[test]
    fn pending_collab_ui_does_not_leak_between_sessions() {
        let a = "/tmp/retention-b.jsonl";
        let b = "/tmp/retention-c.jsonl";
        forget_collab_ui_session(a);
        forget_collab_ui_session(b);
        remember_collab_ui(a, 7, &serde_json::json!({ "reqId": 7, "kind": "select" }));
        assert_eq!(pending_collab_ui_requests(a).len(), 1);
        assert!(pending_collab_ui_requests(b).is_empty());
        forget_collab_ui_session(a);
    }

    /// An entry older than the 120s TTL is never delivered - the desktop it was
    /// meant for is gone, and delivering it into a new room could answer a dialog
    /// that was never asked - but it MUST come back named, because the phone has
    /// been showing "answer held" for it and its dialog is still pending.
    #[test]
    fn pending_answer_ttl_reports_stale_entries_instead_of_dropping_them() {
        let session = "/tmp/link-answer-ttl.jsonl";
        forget_pending_answers(session);
        remember_collab_ui(session, 1, &serde_json::json!({"reqId":1}));
        remember_collab_ui(session, 2, &serde_json::json!({"reqId":2}));
        assert!(matches!(
            claim_collab_answer(session, 1, Some("A"), true),
            AnswerClaim::New
        ));
        queue_collab_answer(
            session,
            1,
            Some("A"),
            &collab_question_token(session, 1).expect("queued question identity"),
        );
        queue_collab_answer(
            session,
            2,
            Some("B"),
            &collab_question_token(session, 2).expect("queued question identity"),
        );
        // Age both past the TTL by rewriting their timestamps directly (no
        // 120s sleep).
        {
            let mut map = PENDING_ANSWERS.lock().unwrap_or_else(|p| p.into_inner());
            let list = map.get_mut(session).expect("two queued entries");
            for (_, _, at, _) in list.iter_mut() {
                *at = std::time::Instant::now() - PENDING_ANSWERS_TTL - Duration::from_secs(1);
            }
        }
        let (live, expired) = take_pending_answers(session);
        assert!(live.is_empty(), "expired answers never flush");
        assert!(
            !collab_answer_in_flight(session, 1),
            "expiry permits an explicit retry of the same still-pending question"
        );
        assert_eq!(
            expired.into_iter().map(|(id, _)| id).collect::<Vec<_>>(),
            vec![1, 2],
            "both come back as expired, in queue order"
        );
        forget_pending_answers(session);
        forget_collab_ui_session(session);
    }

    /// The sweep is what makes expiry visible when no attach ever happens - the
    /// exact case that produces expiries. Without it the phone keeps a card saying
    /// the answer is held for a desktop that is never coming back.
    #[test]
    fn expiry_sweep_reports_and_clears_stale_answers() {
        let a = "/tmp/link-sweep-a.jsonl";
        let b = "/tmp/link-sweep-b.jsonl";
        forget_pending_answers(a);
        forget_pending_answers(b);
        for (session, req_id) in [(a, 4), (a, 5), (b, 6)] {
            remember_collab_ui(session, req_id, &serde_json::json!({"reqId":req_id}));
        }
        queue_collab_answer(
            a,
            4,
            Some("old"),
            &collab_question_token(a, 4).expect("queued question identity"),
        );
        queue_collab_answer(
            a,
            5,
            Some("fresh"),
            &collab_question_token(a, 5).expect("queued question identity"),
        );
        queue_collab_answer(
            b,
            6,
            None,
            &collab_question_token(b, 6).expect("queued question identity"),
        );
        {
            let mut map = PENDING_ANSWERS.lock().unwrap_or_else(|p| p.into_inner());
            // Age only reqId 4 on session a, and b's single entry.
            for (session, req_id) in [(a, 4u64), (b, 6u64)] {
                let list = map.get_mut(session).expect("queued entries");
                for (id, _, at, _) in list.iter_mut() {
                    if *id == req_id {
                        *at = std::time::Instant::now()
                            - PENDING_ANSWERS_TTL
                            - Duration::from_secs(1);
                    }
                }
            }
        }
        let mut swept = expired_pending_answers();
        swept.sort();
        assert_eq!(
            swept
                .into_iter()
                .map(|(session, ids)| (
                    session,
                    ids.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
                ))
                .collect::<Vec<_>>(),
            vec![(a.to_string(), vec![4]), (b.to_string(), vec![6])],
            "every session's expired reqIds come back, and only those"
        );
        let (live_a, expired_a) = take_pending_answers(a);
        assert_eq!(
            live_a
                .into_iter()
                .map(|(id, value, _)| (id, value))
                .collect::<Vec<_>>(),
            vec![(5, Some("fresh".to_string()))],
            "the fresh answer survives the sweep"
        );
        assert!(expired_a.is_empty(), "the sweep already took the stale one");
        assert!(
            take_pending_answers(b).0.is_empty(),
            "a session left with nothing is dropped from the store"
        );
        forget_pending_answers(a);
        forget_pending_answers(b);
        forget_collab_ui_session(a);
        forget_collab_ui_session(b);
    }

    /// The sweep parks while nothing is queued (it used to tick every 30 s
    /// forever), wakes when an answer is queued, runs again exactly at the
    /// expiry it was given, and parks again once the queue is empty.
    #[tokio::test(start_paused = true)]
    async fn answer_sweep_parks_when_empty_and_wakes_on_queue_and_expiry() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let wake = Arc::new(Notify::new());
        let passes = Arc::new(AtomicUsize::new(0));
        let deadline = Arc::new(Mutex::new(None::<tokio::time::Instant>));
        let stop = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn({
            let (wake, passes, deadline, stop) = (
                Arc::clone(&wake),
                Arc::clone(&passes),
                Arc::clone(&deadline),
                Arc::clone(&stop),
            );
            async move {
                run_answer_sweep(&wake, || {
                    if stop.load(Ordering::SeqCst) {
                        return ControlFlow::Break(());
                    }
                    passes.fetch_add(1, Ordering::SeqCst);
                    let mut next = deadline.lock().unwrap_or_else(|p| p.into_inner());
                    // The deadline passed: the sweep reported it, the queue is empty.
                    if next.is_some_and(|d| d <= tokio::time::Instant::now()) {
                        *next = None;
                    }
                    ControlFlow::Continue(*next)
                })
                .await;
            }
        });
        let hour = Duration::from_secs(3600);
        tokio::time::sleep(hour).await;
        assert_eq!(
            passes.load(Ordering::SeqCst),
            1,
            "one startup pass, then parked"
        );

        let ttl = Duration::from_secs(120);
        *deadline.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(tokio::time::Instant::now() + ttl);
        wake.notify_one();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(passes.load(Ordering::SeqCst), 2, "a queued answer wakes it");

        tokio::time::sleep(ttl - Duration::from_secs(2)).await;
        assert_eq!(
            passes.load(Ordering::SeqCst),
            2,
            "no pass before the expiry"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(passes.load(Ordering::SeqCst), 3, "a pass at the expiry");

        tokio::time::sleep(hour).await;
        assert_eq!(passes.load(Ordering::SeqCst), 3, "parked again once empty");

        stop.store(true, Ordering::SeqCst);
        wake.notify_one();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("the sweep ends with its manager")
            .expect("no panic");
    }

    /// The 32-entry cap evicts the OLDEST answers, not the newest: a
    /// flapping desktop cannot grow the queue without end.
    #[test]
    fn pending_answer_cap_evicts_oldest() {
        let session = "/tmp/link-answer-cap.jsonl";
        forget_pending_answers(session);
        for i in 0..40 {
            remember_collab_ui(session, i, &serde_json::json!({"reqId":i}));
            queue_collab_answer(
                session,
                i,
                Some("x"),
                &collab_question_token(session, i).expect("queued question identity"),
            );
        }
        let (taken, _expired) = take_pending_answers(session);
        assert_eq!(taken.len(), PENDING_ANSWERS_MAX_PER_SESSION);
        assert_eq!(taken.first().unwrap().0, 8, "the 8 oldest were evicted");
        assert_eq!(taken.last().unwrap().0, 39);
        forget_pending_answers(session);
        forget_collab_ui_session(session);
    }
}
