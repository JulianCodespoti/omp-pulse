//! Dialogs raised by the daemon's own omp children (`extension_ui_request`)
//! and the one reply shape each of them accepts.
//!
//! WHY: omp resolves a dialog only from the field its method reads
//! (rpc-mode.ts `RpcExtensionUIContext`): `confirm` reads `confirmed`,
//! `select`/`input`/`editor` read `value`, `ask` reads `answers`, and any other
//! shape silently resolves as "no answer". The phone used to reply
//! `{value: text}` to everything, so every confirm and every tool approval came
//! back as a denial (a select must even match an option label exactly). This
//! module is the single place that knows each method's reply, and it checks a
//! phone answer against the request that is still pending before anything
//! reaches the child: omp throws on a malformed `ask` answer, which would fail
//! the agent's tool call instead of answering it.
//!
//! Two answer paths share it:
//! - structured (`reply_frame`): the chat's dialog sheet sends exactly what the
//!   method needs, keyed by the request id;
//! - plain text (`text_reply`): the answer sheet and quick-reply chips type one
//!   answer per question, as they do for a laptop pane. A structured `ask`
//!   takes every answer in ONE reply, so per-question text answers are held
//!   here until the last one arrives.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Map, Value, json};

/// Methods that block the agent until the phone answers. Every other method
/// (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`,
/// `open_url`) is fire-and-forget, and `cancel` closes an earlier request.
pub const BLOCKING_METHODS: [&str; 5] = ["select", "confirm", "input", "editor", "ask"];

/// True for a request the agent is blocked on until a reply arrives.
pub fn is_blocking(method: Option<&str>) -> bool {
    method.is_some_and(|m| BLOCKING_METHODS.contains(&m))
}

/// Reservations remain replayable until real closure, but cannot consume the
/// next typed answer. Never remove them merely to route another question.
pub fn text_answer_target(pending: &[Value]) -> Option<&Value> {
    pending
        .iter()
        .find(|request| request.get("pulseDelivery").is_none())
}

/// Private key holding the daemon's receipt time on a STORED request; stripped
/// before the payload leaves the daemon (see `replay_payload`).
const RECEIVED_KEY: &str = "pulseReceivedAtMs";

/// Upper bound on one typed value. An editor reply carries a whole document,
/// so this is generous; it only stops a runaway client from wedging the pipe.
const MAX_VALUE_BYTES: usize = 256 * 1024;

/// Copy of a request as the daemon keeps it while it is pending: the receipt
/// time lets a later replay shorten `timeout` by the time already spent.
pub fn stored_request(request: &Value, now_ms: u64) -> Value {
    let mut stored = request.clone();
    if let Some(obj) = stored.as_object_mut() {
        obj.insert(RECEIVED_KEY.to_string(), json!(now_ms));
    }
    stored
}

/// The payload a newly attached client receives for a still-pending request.
/// `timeout` counts from when omp sent the request, so a dialog replayed after
/// a reload gets only the time it has left (0 when omp is about to cancel it):
/// otherwise a phone would show a question omp has already given up on.
pub fn replay_payload(stored: &Value, now_ms: u64) -> Value {
    let mut payload = stored.clone();
    let Some(obj) = payload.as_object_mut() else {
        return payload;
    };
    let received = obj.remove(RECEIVED_KEY).and_then(|v| v.as_u64());
    if let (Some(received), Some(timeout)) = (received, obj.get("timeout").and_then(Value::as_u64))
    {
        let left = timeout.saturating_sub(now_ms.saturating_sub(received));
        obj.insert("timeout".to_string(), json!(left));
    }
    payload
}

/// What a `needs_input` push should say: the question itself, never the
/// method name. `ask` carries its text per question; the first one leads.
pub fn question_text(request: &Value) -> Option<String> {
    let text = if request.get("method").and_then(Value::as_str) == Some("ask") {
        request
            .pointer("/questions/0/question")
            .and_then(Value::as_str)
    } else {
        ["title", "message", "prompt"]
            .iter()
            .filter_map(|k| request.get(*k).and_then(Value::as_str))
            .find(|s| !s.trim().is_empty())
    };
    text.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn request_id(request: &Value) -> Result<&str, String> {
    request
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "dialog has no answerable id".to_string())
}

fn frame(id: &str, fields: Value) -> Value {
    let mut out = Map::new();
    out.insert("type".into(), json!("extension_ui_response"));
    out.insert("id".into(), json!(id));
    if let Value::Object(fields) = fields {
        out.extend(fields);
    }
    Value::Object(out)
}

fn select_options(request: &Value) -> Vec<&str> {
    request
        .get("options")
        .and_then(Value::as_array)
        .map(|opts| opts.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn checked_value(value: Option<&Value>) -> Result<&str, String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| "answer text required".to_string())?;
    checked_len(value)
}

fn checked_len(value: &str) -> Result<&str, String> {
    if value.len() > MAX_VALUE_BYTES {
        return Err("answer is too long".into());
    }
    Ok(value)
}

/// One question of an `ask` request: its id and option labels.
struct AskQuestion<'a> {
    id: &'a str,
    labels: Vec<&'a str>,
    multi: bool,
}

fn ask_questions(request: &Value) -> Result<Vec<AskQuestion<'_>>, String> {
    let questions = request
        .get("questions")
        .and_then(Value::as_array)
        .filter(|q| !q.is_empty())
        .ok_or_else(|| "question has no parts to answer".to_string())?;
    questions
        .iter()
        .map(|q| {
            let id = q
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "question has no id".to_string())?;
            let labels = q
                .get("options")
                .and_then(Value::as_array)
                .map(|opts| {
                    opts.iter()
                        .filter_map(|o| o.get("label").and_then(Value::as_str))
                        .collect()
                })
                .unwrap_or_default();
            let multi = q.get("multi").and_then(Value::as_bool).unwrap_or(false);
            Ok(AskQuestion { id, labels, multi })
        })
        .collect()
}

/// One validated answer in omp's shape: labels that exist on the question,
/// no duplicates, free text trimmed (blank → absent), and a single-select
/// question carrying at most one of the two (omp rejects anything else).
fn ask_answer(
    question: &AskQuestion<'_>,
    selected: &[&str],
    custom: Option<&str>,
) -> Result<Value, String> {
    let mut picked: Vec<&str> = Vec::with_capacity(selected.len());
    for label in selected {
        if !question.labels.contains(label) {
            return Err(format!("\"{label}\" is not one of the options"));
        }
        if picked.contains(label) {
            return Err(format!("\"{label}\" was picked twice"));
        }
        picked.push(label);
    }
    let custom = custom.map(str::trim).filter(|s| !s.is_empty());
    if let Some(custom) = custom
        && custom.len() > MAX_VALUE_BYTES
    {
        return Err("answer is too long".into());
    }
    if !question.multi && picked.len() + usize::from(custom.is_some()) > 1 {
        return Err("this question takes one answer".into());
    }
    if !question.multi && picked.is_empty() && custom.is_none() {
        return Err("this question needs an answer".into());
    }
    let mut answer = json!({ "id": question.id, "selectedOptions": picked });
    if let Some(custom) = custom {
        answer["customInput"] = json!(custom);
    }
    Ok(answer)
}

/// The reply frame for a structured answer to `request`. `response` holds
/// exactly the method's field: `{confirmed}` (confirm), `{value}` (select,
/// input, editor), `{answers: [{id, selectedOptions, customInput?}]}` (ask,
/// every question in order), or `{cancelled: true}` for any method.
pub fn reply_frame(request: &Value, response: &Value) -> Result<Value, String> {
    let id = request_id(request)?;
    if response.get("cancelled").and_then(Value::as_bool) == Some(true) {
        return Ok(frame(id, json!({ "cancelled": true })));
    }
    match request.get("method").and_then(Value::as_str) {
        Some("confirm") => {
            let confirmed = response
                .get("confirmed")
                .and_then(Value::as_bool)
                .ok_or_else(|| "answer Yes or No".to_string())?;
            Ok(frame(id, json!({ "confirmed": confirmed })))
        }
        Some("select") => {
            let value = checked_value(response.get("value"))?;
            if !select_options(request).contains(&value) {
                return Err("pick one of the offered options".into());
            }
            Ok(frame(id, json!({ "value": value })))
        }
        Some("input" | "editor") => {
            let value = checked_value(response.get("value"))?;
            Ok(frame(id, json!({ "value": value })))
        }
        Some("ask") => {
            let questions = ask_questions(request)?;
            let answers = response
                .get("answers")
                .and_then(Value::as_array)
                .filter(|a| a.len() == questions.len())
                .ok_or_else(|| "every question needs an answer".to_string())?;
            let answers = questions
                .iter()
                .zip(answers)
                .map(|(question, answer)| {
                    if answer.get("id").and_then(Value::as_str) != Some(question.id) {
                        return Err("answers do not match the questions".to_string());
                    }
                    let selected: Vec<&str> = match answer.get("selectedOptions") {
                        None | Some(Value::Null) => Vec::new(),
                        Some(Value::Array(labels)) => labels
                            .iter()
                            .map(|l| l.as_str().ok_or_else(|| "option must be text".to_string()))
                            .collect::<Result<_, _>>()?,
                        Some(_) => return Err("selected options must be a list".into()),
                    };
                    let custom = match answer.get("customInput") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(s)) => Some(s.as_str()),
                        Some(_) => return Err("written answer must be text".into()),
                    };
                    ask_answer(question, &selected, custom)
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(frame(id, json!({ "answers": answers })))
        }
        _ => Err("this dialog does not take an answer".into()),
    }
}

/// Outcome of one plain-text answer.
#[derive(Debug, PartialEq)]
pub enum TextReply {
    /// Send this frame to the child now.
    Send(Value),
    /// One question of a multi-question `ask` was recorded; the reply goes
    /// out with the last one.
    Held { answered: usize, total: usize },
}

/// Per-question answers to a structured `ask` collected from the text path,
/// keyed by request id (omp snowflakes never repeat). Bounded: an entry only
/// outlives its dialog when the dialog was cancelled mid-way, and a full map
/// drops those leftovers.
static ASK_PARTIAL: Mutex<Option<HashMap<String, Vec<Value>>>> = Mutex::new(None);
const ASK_PARTIAL_CAP: usize = 16;

/// Drop any held per-question answers for `id` (a structured answer or a
/// dismissal supersedes them).
pub fn forget_partial(id: &str) {
    let mut guard = ASK_PARTIAL.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(id);
    }
}

const YES: [&str; 8] = [
    "yes", "y", "approve", "allow", "ok", "confirm", "true", "accept",
];
const NO: [&str; 6] = ["no", "n", "deny", "reject", "false", "decline"];

/// Reply to `request` from one typed answer (`text`) or one tapped option
/// (`option`, an index into the offered options). Text matches an option label
/// case-insensitively, so "approve" picks omp's "Approve"; for a confirm, the
/// usual yes/no words answer it. An `ask` takes the answer for its next
/// unanswered question (see `TextReply::Held`).
pub fn text_reply(request: &Value, text: &str, option: Option<usize>) -> Result<TextReply, String> {
    let id = request_id(request)?;
    let typed = text.trim();
    let pick = |labels: &[&str]| -> Option<String> {
        if let Some(i) = option {
            return labels.get(i).map(|l| (*l).to_string());
        }
        labels
            .iter()
            .find(|l| **l == typed)
            .or_else(|| labels.iter().find(|l| l.trim().eq_ignore_ascii_case(typed)))
            .map(|l| (*l).to_string())
    };
    match request.get("method").and_then(Value::as_str) {
        Some("confirm") => {
            let word = typed.to_ascii_lowercase();
            let confirmed = match option {
                Some(0) => true,
                Some(1) => false,
                Some(_) => return Err("answer Yes or No".into()),
                None if YES.contains(&word.as_str()) => true,
                None if NO.contains(&word.as_str()) => false,
                None => return Err("answer Yes or No".into()),
            };
            Ok(TextReply::Send(frame(
                id,
                json!({ "confirmed": confirmed }),
            )))
        }
        Some("select") => {
            let value = pick(&select_options(request))
                .ok_or_else(|| "pick one of the offered options".to_string())?;
            Ok(TextReply::Send(frame(id, json!({ "value": value }))))
        }
        Some("input" | "editor") => {
            let value = checked_len(text)?;
            Ok(TextReply::Send(frame(id, json!({ "value": value }))))
        }
        Some("ask") => {
            let questions = ask_questions(request)?;
            let mut guard = ASK_PARTIAL.lock().unwrap_or_else(|p| p.into_inner());
            let map = guard.get_or_insert_with(HashMap::new);
            if !map.contains_key(id) && map.len() >= ASK_PARTIAL_CAP {
                map.clear();
            }
            let held = map.entry(id.to_string()).or_default();
            let question = questions
                .get(held.len())
                .ok_or_else(|| "every question is already answered".to_string())?;
            let answer = match pick(&question.labels) {
                Some(label) => ask_answer(question, &[label.as_str()], None)?,
                None if option.is_some() => return Err("pick one of the offered options".into()),
                None => ask_answer(question, &[], Some(text))?,
            };
            held.push(answer);
            if held.len() < questions.len() {
                return Ok(TextReply::Held {
                    answered: held.len(),
                    total: questions.len(),
                });
            }
            let answers = map.remove(id).unwrap_or_default();
            Ok(TextReply::Send(frame(id, json!({ "answers": answers }))))
        }
        _ => Err("this dialog does not take an answer".into()),
    }
}

/// Reply for a raw `extension_ui_response` a client sent over the socket: it
/// must name a request still pending for that session and carry the method's
/// field (see `reply_frame`); anything else is dropped by the caller.
pub fn socket_reply(pending: &[Value], frame: &Value) -> Result<Value, String> {
    let id = frame
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "response has no id".to_string())?;
    let request = pending
        .iter()
        .find(|r| r.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| "no such pending dialog".to_string())?;
    reply_frame(request, frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_answers_skip_all_reserved_phases_without_forgetting_them() {
        for phase in ["sending", "handoff", "uncertain"] {
            let pending = vec![
                json!({"id":"old","method":"select","options":["Approve"],"pulseDelivery":phase}),
                json!({"id":"new","method":"select","options":["Fast","Careful"]}),
            ];
            let target = text_answer_target(&pending).unwrap();
            assert_eq!(target["id"], "new");
            let TextReply::Send(frame) = text_reply(target, "Careful", Some(1)).unwrap() else {
                panic!("a generic select sends its response immediately");
            };
            assert_eq!(frame["id"], "new");
            assert_eq!(frame["value"], "Careful");
            assert_eq!(pending[0]["pulseDelivery"], phase);
            assert!(text_answer_target(&pending[..1]).is_none());
        }
    }

    fn ask_request(id: &str) -> Value {
        json!({
            "type": "extension_ui_request", "id": id, "method": "ask",
            "questions": [
                {"id": "db", "question": "Which database?", "options": [{"label": "Postgres"}, {"label": "SQLite"}], "recommended": 1},
                {"id": "extras", "question": "Extras?", "multi": true, "options": [{"label": "Auth"}, {"label": "Cache"}]}
            ]
        })
    }

    #[test]
    fn each_method_gets_the_field_omp_reads() {
        let confirm =
            json!({"id": "c1", "method": "confirm", "title": "Run it?", "message": "rm -rf build"});
        assert_eq!(
            reply_frame(&confirm, &json!({"confirmed": true})).unwrap(),
            json!({"type": "extension_ui_response", "id": "c1", "confirmed": true})
        );
        assert!(
            reply_frame(&confirm, &json!({"value": "Yes"})).is_err(),
            "a value is a denial to omp"
        );

        let select = json!({"id": "s1", "method": "select", "title": "Allow?", "options": ["Approve", "Deny"]});
        assert_eq!(
            reply_frame(&select, &json!({"value": "Approve"})).unwrap(),
            json!({"type": "extension_ui_response", "id": "s1", "value": "Approve"})
        );
        assert!(
            reply_frame(&select, &json!({"value": "approve"})).is_err(),
            "select needs the exact label"
        );

        for method in ["input", "editor"] {
            let req = json!({"id": "t1", "method": method, "title": "Name"});
            assert_eq!(
                reply_frame(&req, &json!({"value": "line 1\nline 2"})).unwrap(),
                json!({"type": "extension_ui_response", "id": "t1", "value": "line 1\nline 2"})
            );
        }

        for req in [confirm, select, ask_request("a0")] {
            let out = reply_frame(&req, &json!({"cancelled": true})).unwrap();
            assert_eq!(out["cancelled"], json!(true));
            assert_eq!(out["id"], req["id"]);
        }
        assert!(
            reply_frame(
                &json!({"id": "n", "method": "notify"}),
                &json!({"value": "x"})
            )
            .is_err()
        );
    }

    #[test]
    fn ask_answers_are_checked_against_the_questions() {
        let req = ask_request("a1");
        let ok = reply_frame(&req, &json!({"answers": [
            {"id": "db", "selectedOptions": ["SQLite"]},
            {"id": "extras", "selectedOptions": ["Auth", "Cache"], "customInput": "  rate limits "}
        ]}))
        .unwrap();
        assert_eq!(
            ok,
            json!({"type": "extension_ui_response", "id": "a1", "answers": [
                {"id": "db", "selectedOptions": ["SQLite"]},
                {"id": "extras", "selectedOptions": ["Auth", "Cache"], "customInput": "rate limits"}
            ]})
        );
        // Free text alone answers a single-select question; blank text is no answer.
        let typed = reply_frame(
            &req,
            &json!({"answers": [
                {"id": "db", "selectedOptions": [], "customInput": "MySQL"},
                {"id": "extras", "selectedOptions": [], "customInput": "   "}
            ]}),
        )
        .unwrap();
        assert_eq!(
            typed["answers"][1],
            json!({"id": "extras", "selectedOptions": []})
        );

        for bad in [
            json!({"answers": [{"id": "db", "selectedOptions": []}, {"id": "extras", "selectedOptions": []}]}),
            json!({"answers": [{"id": "db", "selectedOptions": ["SQLite"]}]}),
            json!({"answers": [{"id": "extras", "selectedOptions": []}, {"id": "db", "selectedOptions": []}]}),
            json!({"answers": [{"id": "db", "selectedOptions": ["MySQL"]}, {"id": "extras", "selectedOptions": []}]}),
            json!({"answers": [{"id": "db", "selectedOptions": ["SQLite", "Postgres"]}, {"id": "extras", "selectedOptions": []}]}),
            json!({"answers": [{"id": "db", "selectedOptions": ["SQLite"], "customInput": "both"}, {"id": "extras", "selectedOptions": []}]}),
            json!({"answers": [{"id": "db", "selectedOptions": []}, {"id": "extras", "selectedOptions": ["Auth", "Auth"]}]}),
        ] {
            assert!(reply_frame(&req, &bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn typed_answers_map_onto_the_method() {
        let confirm = json!({"id": "c2", "method": "confirm", "title": "Go?", "message": ""});
        assert_eq!(
            text_reply(&confirm, "Yes", None).unwrap(),
            TextReply::Send(
                json!({"type": "extension_ui_response", "id": "c2", "confirmed": true})
            )
        );
        assert_eq!(
            text_reply(&confirm, "deny", None).unwrap(),
            TextReply::Send(
                json!({"type": "extension_ui_response", "id": "c2", "confirmed": false})
            )
        );
        assert!(text_reply(&confirm, "maybe", None).is_err());

        let select = json!({"id": "s2", "method": "select", "title": "Allow?", "options": ["Approve", "Deny"]});
        assert_eq!(
            text_reply(&select, "approve", None).unwrap(),
            TextReply::Send(
                json!({"type": "extension_ui_response", "id": "s2", "value": "Approve"})
            )
        );
        assert_eq!(
            text_reply(&select, "", Some(1)).unwrap(),
            TextReply::Send(json!({"type": "extension_ui_response", "id": "s2", "value": "Deny"}))
        );
        assert!(text_reply(&select, "sure", None).is_err());
    }

    #[test]
    fn typed_ask_answers_are_held_until_the_last_question() {
        let req = ask_request("a3");
        assert_eq!(
            text_reply(&req, "", Some(1)).unwrap(),
            TextReply::Held {
                answered: 1,
                total: 2
            }
        );
        assert_eq!(
            text_reply(&req, "faster builds", None).unwrap(),
            TextReply::Send(
                json!({"type": "extension_ui_response", "id": "a3", "answers": [
                    {"id": "db", "selectedOptions": ["SQLite"]},
                    {"id": "extras", "selectedOptions": [], "customInput": "faster builds"}
                ]})
            )
        );
        // A structured answer or a dismissal discards held answers.
        let req = ask_request("a4");
        assert!(matches!(
            text_reply(&req, "Postgres", None).unwrap(),
            TextReply::Held { .. }
        ));
        forget_partial("a4");
        assert_eq!(
            text_reply(&req, "Postgres", None).unwrap(),
            TextReply::Held {
                answered: 1,
                total: 2
            }
        );
    }

    #[test]
    fn socket_replies_must_name_a_pending_dialog() {
        let pending = vec![json!({"id": "c5", "method": "confirm", "title": "Go?"})];
        assert!(
            socket_reply(
                &pending,
                &json!({"type": "extension_ui_response", "id": "c5", "confirmed": false})
            )
            .is_ok()
        );
        assert!(
            socket_reply(
                &pending,
                &json!({"type": "extension_ui_response", "id": "other", "confirmed": true})
            )
            .is_err()
        );
    }

    #[test]
    fn replay_spends_the_time_already_waited() {
        let stored = stored_request(
            &json!({"id": "s6", "method": "select", "options": [], "timeout": 30_000}),
            1_000,
        );
        let replay = replay_payload(&stored, 11_000);
        assert_eq!(replay["timeout"], json!(20_000));
        assert!(
            replay.get(RECEIVED_KEY).is_none(),
            "the daemon's stamp never leaves the daemon"
        );
        assert_eq!(replay_payload(&stored, 99_000)["timeout"], json!(0));
        let untimed = replay_payload(
            &stored_request(&json!({"id": "e", "method": "editor"}), 5),
            9,
        );
        assert_eq!(untimed, json!({"id": "e", "method": "editor"}));
    }

    #[test]
    fn push_text_is_the_question_not_the_method() {
        assert_eq!(
            question_text(&json!({"method": "confirm", "title": "Delete branch?", "message": "x"}))
                .as_deref(),
            Some("Delete branch?")
        );
        assert_eq!(
            question_text(&ask_request("p")).as_deref(),
            Some("Which database?")
        );
        assert_eq!(
            question_text(&json!({"method": "input", "title": "  "})),
            None
        );
    }
}
