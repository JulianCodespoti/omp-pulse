//! Bounded agent conversation discovery for one native child binding.
//! Native running rosters drop terminal agents before their transcript refs expire.

use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

const RETAINED_LIMIT: usize = 256;
const FIELD_BYTES: usize = 4096;

const ROW_FIELDS: &[&str] = &[
    "id",
    "status",
    "agent",
    "index",
    "description",
    "sessionFile",
    "parentToolCallId",
    "task",
];
const PROGRESS_FIELDS: &[&str] = &[
    "lastIntent",
    "durationMs",
    "tokens",
    "resolvedModelIdentity",
    "resolvedModel",
    "contextTokens",
    "contextWindow",
    "currentTool",
    "task",
];

fn retain_fields(source: &Value, keys: &[&str]) -> serde_json::Map<String, Value> {
    let mut fields = serde_json::Map::new();
    for key in keys {
        if let Some(value) = source.get(*key) {
            match value {
                Value::String(text) if text.len() <= FIELD_BYTES => {
                    fields.insert((*key).to_string(), value.clone());
                }
                Value::Number(_) => {
                    fields.insert((*key).to_string(), value.clone());
                }
                _ => {}
            }
        }
    }
    fields
}

/// Discovery retains summaries, never a transcript or an unbounded progress
/// blob. Native rows themselves still pass through unchanged to the caller.
fn retain_row(source: &Value) -> Value {
    let mut fields = retain_fields(source, ROW_FIELDS);
    if let Some(progress) = source.get("progress") {
        fields.insert(
            "progress".to_string(),
            Value::Object(retain_fields(progress, PROGRESS_FIELDS)),
        );
    }
    Value::Object(fields)
}

#[derive(Default)]
pub(super) struct RetainedAgents {
    epoch: u64,
    rows: VecDeque<Value>,
    event_sequences: HashMap<String, u64>,
}

impl RetainedAgents {
    pub(super) fn new(epoch: u64) -> Self {
        Self {
            epoch,
            ..Self::default()
        }
    }

    pub(super) fn reset(&mut self, epoch: u64) {
        self.epoch = epoch;
        self.rows.clear();
        self.event_sequences.clear();
    }

    /// Caller proves the source identity before locking this catalogue. No child
    /// locks are acquired here; stale epochs never reset a newer binding.
    pub(super) fn observe(&mut self, epoch: u64, sequence: u64, event: &Value) {
        if epoch != self.epoch {
            return;
        }
        let Some(payload) = event.get("payload").filter(|value| value.is_object()) else {
            return;
        };
        let kind = event.get("type").and_then(Value::as_str);
        let progress = payload.get("progress").filter(|value| value.is_object());
        let (id, status) = match kind {
            Some("subagent_lifecycle") => (payload.get("id"), payload.get("status")),
            Some("subagent_progress") => (
                progress.and_then(|value| value.get("id")),
                progress.and_then(|value| value.get("status")),
            ),
            _ => return,
        };
        let Some(id) = id
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= FIELD_BYTES)
        else {
            return;
        };
        let Some(status) = status
            .and_then(Value::as_str)
            .filter(|status| status.len() <= FIELD_BYTES)
        else {
            return;
        };
        if self
            .event_sequences
            .get(id)
            .is_some_and(|current| *current >= sequence)
        {
            return;
        }
        let started = status == "started";
        let previous = self.rows.iter().position(|row| row["id"] == id);
        if let Some(index) = previous
            && !started
            && ["parentToolCallId", "sessionFile"].iter().any(|key| {
                payload.get(*key).is_some_and(|incoming| {
                    self.rows[index]
                        .get(*key)
                        .is_some_and(|existing| incoming != existing)
                })
            })
        {
            return;
        }
        let mut row = previous
            .and_then(|index| self.rows.remove(index))
            .unwrap_or_else(|| json!({"id": id}));
        if started {
            row = json!({"id": id});
        }
        let Some(fields) = row.as_object_mut() else {
            return;
        };
        fields.extend(retain_fields(payload, ROW_FIELDS));
        if let Some(progress) = progress {
            fields.insert(
                "progress".to_string(),
                Value::Object(retain_fields(progress, PROGRESS_FIELDS)),
            );
        }
        fields.insert(
            "status".to_string(),
            Value::String(if started { "running" } else { status }.to_string()),
        );
        self.event_sequences.insert(id.to_string(), sequence);
        self.rows.push_back(row);
        while self.rows.len() > RETAINED_LIMIT {
            if let Some(oldest) = self.rows.pop_front()
                && let Some(id) = oldest.get("id").and_then(Value::as_str)
            {
                self.event_sequences.remove(id);
            }
        }
    }

    /// Native snapshots are authoritative unless a newer lifecycle/progress
    /// event arrived during the request. Absence does not prove completion.
    pub(super) fn merge(&mut self, epoch: u64, request_sequence: u64, data: &mut Value) {
        if epoch != self.epoch {
            return;
        }
        let Some(current) = data.get_mut("subagents").and_then(Value::as_array_mut) else {
            return;
        };
        for row in current.iter_mut() {
            let Some(id) = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= FIELD_BYTES)
            else {
                continue;
            };
            let previous = self.rows.iter().position(|old| old["id"] == id);
            if self
                .event_sequences
                .get(id)
                .is_some_and(|sequence| *sequence > request_sequence)
                && let Some(index) = previous
            {
                let newer = &self.rows[index];
                let same_identity = ["sessionFile", "parentToolCallId"].iter().all(|key| {
                    row.get(*key)
                        .zip(newer.get(*key))
                        .is_none_or(|(old, new)| old == new)
                });
                if same_identity {
                    if let (Some(native), Some(newer)) = (row.as_object_mut(), newer.as_object()) {
                        for (key, value) in newer {
                            if key == "progress"
                                && let (Some(native_progress), Some(newer_progress)) = (
                                    native.get_mut(key).and_then(Value::as_object_mut),
                                    value.as_object(),
                                )
                            {
                                native_progress.extend(
                                    newer_progress
                                        .iter()
                                        .map(|(key, value)| (key.clone(), value.clone())),
                                );
                            } else {
                                native.insert(key.clone(), value.clone());
                            }
                        }
                    }
                } else {
                    *row = newer.clone();
                }
                self.rows[index] = retain_row(row);
                continue;
            }
            if let Some(index) = previous {
                self.rows.remove(index);
            }
            self.rows.push_back(retain_row(row));
        }
        while self.rows.len() > RETAINED_LIMIT {
            if let Some(oldest) = self.rows.pop_front()
                && let Some(id) = oldest.get("id").and_then(Value::as_str)
            {
                self.event_sequences.remove(id);
            }
        }
        for retained in &mut self.rows {
            if current.iter().any(|row| row["id"] == retained["id"]) {
                continue;
            }
            let newer_event = retained
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| self.event_sequences.get(id))
                .is_some_and(|sequence| *sequence > request_sequence);
            if retained["status"].as_str() == Some("running") && !newer_event {
                retained["status"] = Value::String("unknown".to_string());
            }
            current.push(retained.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lifecycle(id: &str, status: &str) -> Value {
        json!({"type":"subagent_lifecycle","payload":{"id":id,"status":status,"agent":"worker","sessionFile":format!("/fixture/{id}.jsonl"),"parentToolCallId":"task"}})
    }
    #[test]
    fn finished_agent_remains_reopenable_without_being_running() {
        let mut roster = RetainedAgents::default();
        roster.reset(7);
        roster.observe(7, 1, &lifecycle("a", "started"));
        roster.observe(7, 2, &lifecycle("a", "completed"));
        let mut data = json!({"subagents":[]});
        roster.merge(7, 2, &mut data);
        assert_eq!(data["subagents"][0]["id"], "a");
        assert_eq!(data["subagents"][0]["status"], "completed");
        assert_eq!(data["subagents"][0]["sessionFile"], "/fixture/a.jsonl");
    }
    #[test]
    fn reset_and_source_fences_do_not_leak_previous_owner_rows() {
        let mut roster = RetainedAgents::default();
        roster.reset(7);
        roster.observe(7, 1, &lifecycle("a", "started"));
        roster.reset(8);
        roster.observe(7, 2, &lifecycle("a", "completed"));
        let mut data = json!({"subagents":[]});
        roster.merge(8, 2, &mut data);
        assert_eq!(data["subagents"].as_array().unwrap().len(), 0);
    }
    #[test]
    fn native_rows_win_and_absence_is_not_invented_completion() {
        let mut roster = RetainedAgents::default();
        roster.reset(7);
        roster.observe(7, 1, &lifecycle("a", "started"));
        let mut data = json!({"subagents":[]});
        roster.merge(7, 1, &mut data);
        assert_eq!(data["subagents"][0]["status"], "unknown");
        let mut data = json!({"subagents":[{"id":"a","status":"running","agent":"native"}]});
        roster.merge(7, 1, &mut data);
        assert_eq!(data["subagents"].as_array().unwrap().len(), 1);
        assert_eq!(data["subagents"][0]["status"], "running");
        assert_eq!(data["subagents"][0]["agent"], "native");
    }
    #[test]
    fn completed_discovery_has_native_transcript_reference_bound() {
        let mut roster = RetainedAgents::default();
        roster.reset(7);
        for index in 0..300 {
            roster.observe(7, index + 1, &lifecycle(&index.to_string(), "completed"));
        }
        let mut data = json!({"subagents":[]});
        roster.merge(7, 300, &mut data);
        assert_eq!(data["subagents"].as_array().unwrap().len(), RETAINED_LIMIT);
        assert_eq!(data["subagents"][0]["id"], "44");
    }
    #[test]
    fn retained_discovery_does_not_keep_unbounded_progress_or_accept_other_agent_owners() {
        let mut roster = RetainedAgents::new(7);
        roster.observe(7, 1, &lifecycle("a", "started"));
        let mut wrong = lifecycle("a", "completed");
        wrong["payload"]["parentToolCallId"] = json!("other-task");
        roster.observe(7, 2, &wrong);
        let mut missing = json!({"subagents":[]});
        roster.merge(7, 2, &mut missing);
        assert_eq!(missing["subagents"][0]["status"], "unknown");
        let mut native = json!({"subagents":[{"id":"a","status":"completed","progress":{"lastIntent":"x".repeat(FIELD_BYTES + 1),"tokens":12,"recentOutput":["never retain full output"]}}]});
        roster.merge(7, 2, &mut native);
        let mut data = json!({"subagents":[]});
        roster.merge(7, 2, &mut data);
        assert_eq!(data["subagents"][0]["status"], "completed");
        assert_eq!(data["subagents"][0]["progress"]["tokens"], 12);
        assert!(data["subagents"][0]["progress"].get("lastIntent").is_none());
        assert!(
            data["subagents"][0]["progress"]
                .get("recentOutput")
                .is_none()
        );
    }
    #[test]
    fn terminal_event_during_roster_request_wins_over_its_older_running_snapshot() {
        let mut roster = RetainedAgents::new(7);
        roster.observe(7, 1, &lifecycle("a", "started"));
        let request_sequence = 1;
        roster.observe(7, 2, &lifecycle("a", "completed"));
        let mut old = json!({"subagents":[{"id":"a","status":"running","task":"Native-only task","progress":{"tokens":99}}]});
        roster.merge(7, request_sequence, &mut old);
        assert_eq!(old["subagents"][0]["status"], "completed");
        assert_eq!(old["subagents"].as_array().unwrap().len(), 1);
        assert_eq!(old["subagents"][0]["task"], "Native-only task");
        assert_eq!(old["subagents"][0]["progress"]["tokens"], 99);
    }
    #[test]
    fn started_event_during_empty_roster_request_is_not_downgraded_to_unknown() {
        let mut roster = RetainedAgents::new(7);
        let request_sequence = 0;
        roster.observe(7, 1, &lifecycle("a", "started"));
        let mut old = json!({"subagents":[]});
        roster.merge(7, request_sequence, &mut old);
        assert_eq!(old["subagents"][0]["status"], "running");
    }
}
