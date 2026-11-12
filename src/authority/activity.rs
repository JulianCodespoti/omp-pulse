//! Live per-session activity: what each agent is doing RIGHT NOW.
//!
//! The listing used to answer "is this session running?" by inference — file
//! mtime, a partial tail line, young worker processes, a pane oracle — and
//! could say nothing about *what* was running. Every agent event now reaches
//! the router (daemon children over stdio, desktop sessions over the
//! extension bridge), so the answer is exact and cheap: this module folds the
//! event stream into one small `now` object per working session and pushes
//! changes to the two sockets a phone looks without leaving the one it is
//! on: the `__sessions__` listing channel and the open conversation.
//!
//! Change frames are throttled per session (`MIN_EMIT`), because a
//! `message_update` arrives per token; a trailing flush makes sure the LAST
//! state of a burst is always delivered. Turn start and end are never
//! throttled: they are the transitions a person waits for.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::server::ws::WsHub;

/// Floor between two change frames for one session: fast enough to read as
/// live, slow enough that a token stream cannot flood a phone on cellular.
const MIN_EMIT: Duration = Duration::from_millis(700);
const FLUSH_TICK: Duration = Duration::from_millis(350);
/// Labels are a glance, not a transcript.
const MAX_LABEL_CHARS: usize = 80;
const SESSIONS_CHANNEL: &str = "__sessions__";

#[derive(Clone, PartialEq, Eq)]
struct Now {
    state: &'static str,
    tool: Option<String>,
    label: Option<String>,
    since: u64,
    turn_started_at: u64,
    tools: u32,
    title: String,
}

impl Now {
    fn to_json(&self) -> Value {
        let mut v = json!({
            "state": self.state,
            "since": self.since,
            "turnStartedAt": self.turn_started_at,
            "tools": self.tools,
            "title": self.title,
        });
        if let Some(tool) = &self.tool {
            v["tool"] = json!(tool);
        }
        if let Some(label) = &self.label {
            v["label"] = json!(label);
        }
        v
    }
}

struct Entry {
    now: Now,
    last_emit: Option<Instant>,
    /// A change was swallowed by the throttle and still owes a frame.
    dirty: bool,
}

static ENTRIES: LazyLock<Mutex<HashMap<String, Entry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static HUB: OnceLock<Arc<WsHub>> = OnceLock::new();
static AUTHORITY: OnceLock<Arc<crate::authority::session_state::SessionStateRegistry>> =
    OnceLock::new();
/// Wakes the flush ticker when the first working session appears; with no
/// working session it parks instead of waking every `FLUSH_TICK` for nothing.
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Wall clock in ms. Also the `at` stamp on every live activity frame: the
/// phone's clock is not the daemon's, and `since`/`turnStartedAt` are daemon
/// times, so the phone rebases them by `at` (see protocol.ts `onPhoneClock`).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Wire the tracker to the hub and start the trailing-flush ticker. Called
/// once at daemon start; observing before this only records state.
pub fn init(
    hub: Arc<WsHub>,
    authority: Arc<crate::authority::session_state::SessionStateRegistry>,
) {
    if HUB.set(hub).is_err() {
        return;
    }
    let _ = AUTHORITY.set(authority);
    tokio::spawn(async {
        let mut tick = tokio::time::interval(FLUSH_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if !flush_dirty() {
                WAKE.notified().await;
                tick.reset();
            }
        }
    });
}

/// Every working session's `(path, now)`, for a socket or stream that just
/// connected and must not wait for the next change to show a running turn.
pub fn snapshot() -> Vec<(String, Value)> {
    lock()
        .iter()
        .filter(|(path, _)| !crate::omp::bridge::is_idle(path))
        .map(|(path, e)| (path.clone(), e.now.to_json()))
        .collect()
}

/// This session's current activity, or `null` when idle. Rides the first
/// frame of a conversation socket so a chat opened mid-turn shows the
/// daemon's own turn clock and tool count instead of inventing them from the
/// moment the phone connected (the reported "random" turn timer).
pub fn current(session: &str) -> Value {
    if crate::omp::bridge::is_idle(session) {
        return Value::Null;
    }
    lock().get(session).map_or(Value::Null, |e| e.now.to_json())
}

/// `{"type":"activity","path":…,"now":…,"at":…}` — the listing-socket frame.
/// Built at send time, so `at` is the daemon's clock at that moment.
pub fn sessions_frame(session: &str, now: &Value) -> String {
    let authority = AUTHORITY
        .get()
        .and_then(|registry| registry.current(session));
    let mut frame = json!({"type": "activity", "path": session, "now": now, "at": now_ms()});
    if let Some(authority) = authority {
        frame["now"] = authority.legacy_now();
        frame["sessionState"] = serde_json::to_value(authority).unwrap_or(Value::Null);
    }
    frame.to_string()
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Entry>> {
    ENTRIES.lock().unwrap_or_else(|p| p.into_inner())
}

/// Fold one agent event into the session's activity. Cheap for the events
/// that change nothing (the common `message_update` token): one map lookup.
pub fn observe(session: &str, event: &Value) {
    if session.is_empty() {
        return;
    }
    let Some(etype) = event.get("type").and_then(Value::as_str) else {
        return;
    };
    let bridge_lost = event.get("bridgeLost").and_then(Value::as_bool) == Some(true);
    if etype == "agent_end"
        && event.get("isTerminal").and_then(Value::as_bool) != Some(false)
        && !bridge_lost
    {
        // The idle bridge poll can evict the activity cache before the router
        // accepts this terminal event. Still publish the newly accepted idle
        // projection: the earlier eviction may have published running state.
        lock().remove(session);
        emit(session, &Value::Null);
        return;
    }
    // A delayed token cannot resurrect a finished bridge turn; disconnect
    // evidence, however, must preserve its last-known state.
    if crate::omp::bridge::is_idle(session) && !bridge_lost {
        end(session);
        return;
    }
    let t = now_ms();
    match etype {
        "agent_start" => {
            let title = crate::server::push::session_title(session);
            let now = Now {
                state: "thinking",
                tool: None,
                label: None,
                since: t,
                turn_started_at: t,
                tools: 0,
                title,
            };
            let json = now.to_json();
            lock().insert(
                session.to_string(),
                Entry {
                    now,
                    last_emit: Some(Instant::now()),
                    dirty: false,
                },
            );
            WAKE.notify_one();
            emit(session, &json);
        }
        "agent_end" => {}
        "tool_execution_start" => {
            let tool = event
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let label = tool_label(event);
            update(session, t, |now| {
                now.state = "tool";
                now.tool = Some(tool);
                now.label = label;
                // Every start is a new command, so a new clock. `update` only
                // resets `since` when the state or tool NAME changes, so two
                // bash calls in a row shared one clock and the second showed
                // the first one's runtime plus its own.
                now.since = t;
            });
        }
        "tool_execution_end" => {
            update(session, t, |now| {
                now.tools = now.tools.saturating_add(1);
                now.state = "thinking";
                now.tool = None;
                now.label = None;
            });
        }
        "message_update" => {
            let is_assistant = event
                .get("message")
                .and_then(|m| m.get("role"))
                .and_then(Value::as_str)
                == Some("assistant");
            if !is_assistant {
                return;
            }
            let delta = event
                .get("assistantMessageEvent")
                .and_then(|e| e.get("type"))
                .and_then(Value::as_str);
            let state = match delta {
                Some("text_delta" | "text_start") => "writing",
                Some("thinking_delta" | "thinking_start") => "thinking",
                _ => return,
            };
            update(session, t, |now| {
                if now.state != "tool" {
                    now.state = state;
                }
            });
        }
        _ => {}
    }
}

/// The producer died without an `agent_end` (a crashed child, a desktop omp
/// killed mid-turn): the turn is over whatever the stream last said.
pub fn end(session: &str) {
    if lock().remove(session).is_some() {
        emit(session, &Value::Null);
    }
}

/// The session's owner went away cleanly (a planned child stop, or Stop on a
/// turn whose agent already exited): drop any working entry and publish the
/// idle state with its authority to the list and the open chat, even when no
/// entry existed, since the authority itself changed.
pub fn publish_idle(session: &str) {
    lock().remove(session);
    emit(session, &Value::Null);
}

/// Apply a change; emit at once when the throttle allows, else mark dirty
/// for the trailing flush. A session with no entry (an event before any
/// agent_start this daemon saw — e.g. the daemon restarted mid-turn) is
/// opened on the spot so a running turn is never invisible.
fn update(session: &str, t: u64, apply: impl FnOnce(&mut Now)) {
    // The title and the turn start are file reads: never under the lock
    // every event takes. The turn start is the newest user message in the
    // transcript, so a turn first seen mid-flight still counts from when it
    // really began; `t` is only the fallback when the file says nothing.
    let opening = !lock().contains_key(session);
    let title = opening.then(|| crate::server::push::session_title(session));
    let started = opening
        .then(|| crate::sessions::jsonl::last_user_message_ms(std::path::Path::new(session), 64))
        .flatten()
        .filter(|&ms| ms <= t);
    let mut map = lock();
    let entry = map.entry(session.to_string()).or_insert_with(|| Entry {
        now: Now {
            state: "thinking",
            tool: None,
            label: None,
            since: t,
            turn_started_at: started.unwrap_or(t),
            tools: 0,
            title: title.unwrap_or_default(),
        },
        last_emit: None,
        dirty: true,
    });
    if opening {
        WAKE.notify_one();
    }
    let before = entry.now.clone();
    apply(&mut entry.now);
    if entry.now.state != before.state || entry.now.tool != before.tool {
        entry.now.since = t;
    }
    if entry.now == before && !entry.dirty {
        return;
    }
    let due = entry.last_emit.is_none_or(|at| at.elapsed() >= MIN_EMIT);
    if due {
        entry.last_emit = Some(Instant::now());
        entry.dirty = false;
        let json = entry.now.to_json();
        drop(map);
        emit(session, &json);
    } else {
        entry.dirty = true;
    }
}

/// Emit every owed trailing frame and drop sessions whose bridge went idle.
/// `true` while any working session remains, i.e. while the ticker is needed.
fn flush_dirty() -> bool {
    let (due, live): (Vec<(String, Value)>, bool) = {
        let mut map = lock();
        let mut due = Vec::new();
        map.retain(|path, entry| {
            // Also heal already-retained activity without waiting for another
            // token or reconnect. Unknown owners and long live tools stay put.
            if crate::omp::bridge::is_idle(path) {
                due.push((path.clone(), Value::Null));
                return false;
            }
            if entry.dirty && entry.last_emit.is_none_or(|at| at.elapsed() >= MIN_EMIT) {
                entry.dirty = false;
                entry.last_emit = Some(Instant::now());
                due.push((path.clone(), entry.now.to_json()));
            }
            true
        });
        (due, !map.is_empty())
    };
    for (path, now) in due {
        emit(&path, &now);
    }
    live
}

fn emit(session: &str, now: &Value) {
    let Some(hub) = HUB.get() else {
        return;
    };
    let frame = sessions_frame(session, now);
    hub.broadcast(SESSIONS_CHANNEL, &frame);
    // The open conversation gets the same truth on its own socket: the
    // listing socket closes when the phone leaves the list, and the chat
    // header used to freeze on the last row it had seen.
    hub.broadcast(session, &frame);
    // The phone's ongoing "turn running" notification follows the same truth.
    crate::server::push::progress::on_activity(session, now);
}

/// A glanceable label for a tool call: omp's own intent line when the model
/// wrote one, else the argument a person would recognise.
pub(crate) fn tool_label(event: &Value) -> Option<String> {
    let intent = event
        .get("intent")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty());
    let args = event.get("args");
    let from_args = || {
        [
            "i",
            "command",
            "path",
            "pattern",
            "query",
            "url",
            "file",
            "description",
        ]
        .iter()
        .find_map(|key| {
            args.and_then(|a| a.get(key))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
        })
    };
    let raw = intent.or_else(from_args)?;
    let line = raw.lines().next().unwrap_or(raw).trim();
    Some(truncate_chars(line, MAX_LABEL_CHARS))
}

fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => format!("{}…", &s[..idx]),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(session: &str) {
        lock().remove(session);
    }

    fn now_for(session: &str) -> Option<Value> {
        lock().get(session).map(|e| e.now.to_json())
    }

    #[test]
    fn turn_lifecycle_tracks_tool_and_clears_on_terminal_end() {
        let s = "/tmp/activity-test-lifecycle.jsonl";
        fresh(s);
        observe(s, &json!({"type": "agent_start"}));
        assert_eq!(now_for(s).unwrap()["state"], "thinking");

        observe(
            s,
            &json!({"type": "tool_execution_start", "toolName": "bash",
                    "args": {"command": "cargo test --release\nsecond line"}}),
        );
        let now = now_for(s).unwrap();
        assert_eq!(now["state"], "tool");
        assert_eq!(now["tool"], "bash");
        assert_eq!(now["label"], "cargo test --release");

        observe(
            s,
            &json!({"type": "tool_execution_end", "toolName": "bash"}),
        );
        let now = now_for(s).unwrap();
        assert_eq!(now["state"], "thinking");
        assert_eq!(now["tools"], 1);
        assert!(now.get("tool").is_none());

        // An intermediate loop boundary keeps the turn alive.
        observe(s, &json!({"type": "agent_end", "isTerminal": false}));
        assert!(now_for(s).is_some());
        observe(s, &json!({"type": "agent_end"}));
        assert!(now_for(s).is_none());
    }

    #[test]
    fn writing_does_not_mask_a_running_tool_and_bridge_loss_preserves_last_known_turn() {
        let s = "/tmp/activity-test-writing.jsonl";
        fresh(s);
        let token = json!({"type": "message_update", "message": {"role": "assistant"},
                           "assistantMessageEvent": {"type": "text_delta"}});
        // No agent_start seen (daemon restarted mid-turn): still visible.
        observe(s, &token);
        assert_eq!(now_for(s).unwrap()["state"], "writing");
        observe(
            s,
            &json!({"type": "tool_execution_start", "toolName": "read", "intent": "Reading the parser"}),
        );
        observe(s, &token);
        let now = now_for(s).unwrap();
        assert_eq!(now["state"], "tool");
        assert_eq!(now["label"], "Reading the parser");
        observe(
            s,
            &json!({"type": "agent_end", "isTerminal": false, "bridgeLost": true}),
        );
        let now = now_for(s).expect("transport loss must preserve last-known running activity");
        assert_eq!(now["state"], "tool");
        assert_eq!(now["label"], "Reading the parser");
        observe(s, &json!({"type": "agent_end", "isTerminal": false}));
        assert!(
            now_for(s).is_some(),
            "nonterminal boundary must not clear the turn"
        );
        observe(s, &json!({"type": "agent_end", "isTerminal": true}));
        assert!(
            now_for(s).is_none(),
            "a terminal end clears the preserved turn"
        );
    }

    #[test]
    fn back_to_back_calls_of_the_same_tool_each_get_their_own_clock() {
        let s = "/tmp/activity-test-back-to-back.jsonl";
        fresh(s);
        observe(s, &json!({"type": "agent_start"}));
        let bash = |cmd: &str| json!({"type": "tool_execution_start", "toolName": "bash", "args": {"command": cmd}});
        observe(s, &bash("npm run build"));
        // Backdate the first call so a shared clock would be visible.
        lock().get_mut(s).unwrap().now.since = 1;
        observe(s, &bash("npm test"));
        let now = now_for(s).unwrap();
        assert_eq!(now["label"], "npm test");
        assert!(
            now["since"].as_u64().unwrap() > 1,
            "second call inherited the first call's start"
        );
        fresh(s);
    }

    #[test]
    fn labels_are_truncated_on_char_boundaries() {
        let long = "é".repeat(200);
        let label = tool_label(&json!({"args": {"command": long}})).unwrap();
        assert_eq!(label.chars().count(), MAX_LABEL_CHARS + 1);
        assert!(label.ends_with('…'));
    }

    #[test]
    fn turn_first_seen_mid_flight_counts_from_the_transcripts_user_message() {
        let dir = std::env::temp_dir().join(format!("activity-seed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        std::fs::write(
            &file,
            concat!(
                r#"{"type":"session","id":"s"}"#,
                "\n",
                r#"{"type":"message","id":"u1","timestamp":"2026-09-24T01:00:00.000Z","message":{"role":"user","content":[]}}"#,
                "\n",
                r#"{"type":"message","id":"a1","timestamp":"2026-09-24T01:00:05.000Z","message":{"role":"assistant","content":[]}}"#,
                "\n",
            ),
        )
        .unwrap();
        let s = file.to_str().unwrap();
        fresh(s);
        // First event this daemon sees is a tool call, long after the turn began.
        observe(
            s,
            &json!({"type": "tool_execution_start", "toolName": "bash"}),
        );
        let started = now_for(s).unwrap()["turnStartedAt"].as_u64().unwrap();
        assert_eq!(started, 1_790_211_600_000);
        assert_eq!(current(s)["turnStartedAt"], started);
        fresh(s);
        assert!(current(s).is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
