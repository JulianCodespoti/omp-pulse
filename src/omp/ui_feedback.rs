//! Nonblocking extension feedback, independent of pending dialogs and turn state.
//! The owning process/binding is the lifetime; an agent_end does not clear widgets.
use std::collections::VecDeque;
use std::io::{self, Write};

use serde_json::{Value, json};

const MAX_ENTRIES: usize = 64;
const MAX_NOTICES: usize = 32;
const MAX_BYTES: usize = 256 * 1024;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const NOTICE_TTL_MS: u64 = 5 * 60 * 1000;

#[derive(Clone)]
struct Entry {
    key: String,
    frame: Value,
    bytes: usize,
    received: u64,
    notice: bool,
}

#[derive(Clone, Default)]
pub struct Feedback {
    entries: VecDeque<Entry>,
    bytes: usize,
}

struct Size(usize);
impl Write for Size {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn internal_text(text: &str) -> bool {
    text.starts_with("omp-pulse:") || text.starts_with("omp-pulse-out:")
}

/// Covers even empty/malformed transport replies, which must never reach a UI.
pub fn is_internal(frame: &Value) -> bool {
    ["statusKey", "widgetKey", "message"].iter().any(|key| {
        frame
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(internal_text)
    })
}

impl Feedback {
    fn remove(&mut self, index: usize) {
        if let Some(entry) = self.entries.remove(index) {
            self.bytes -= entry.bytes;
        }
    }

    fn expire(&mut self, now: u64) {
        let mut index = 0;
        while index < self.entries.len() {
            let entry = &self.entries[index];
            if entry.notice && now.saturating_sub(entry.received) >= NOTICE_TTL_MS {
                self.remove(index);
            } else {
                index += 1;
            }
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    /// Native hook failures and slash output have no UI request id. The child
    /// monitor supplies its binding/sequence identity so replay replaces the
    /// live notice rather than duplicating it. Neither event ends a turn.
    pub fn apply_native(&mut self, frame: &Value, id: &str, now: u64) -> Option<Value> {
        let (message, severity) = match frame.get("type").and_then(Value::as_str) {
            Some("extension_error") => {
                let path = frame.get("extensionPath")?.as_str()?;
                let reason = frame.get("error")?.as_str()?;
                let hook = frame.get("event").and_then(Value::as_str).unwrap_or("");
                let message = if hook.is_empty() {
                    format!("Extension {path}: {reason}")
                } else {
                    format!("Extension {path} ({hook}): {reason}")
                };
                (std::borrow::Cow::Owned(message), "error")
            }
            Some("command_output") => (
                crate::omp::ansi::strip(frame.get("text")?.as_str()?),
                "info",
            ),
            _ => return None,
        };
        let notice = json!({
            "type": "extension_ui_request", "method": "notify",
            "id": id, "message": message, "notifyType": severity,
        });
        self.apply(&notice, now);
        Some(notice)
    }
    /// Retain only the supported plain-text methods. Live frames are not rewritten.
    pub fn apply(&mut self, frame: &Value, now: u64) {
        self.expire(now);
        if frame.get("type").and_then(Value::as_str) != Some("extension_ui_request")
            || is_internal(frame)
        {
            return;
        }
        let (key, present, notice) = match frame.get("method").and_then(Value::as_str) {
            Some("setStatus") => {
                let Some(key) = frame.get("statusKey").and_then(Value::as_str) else {
                    return;
                };
                (
                    format!("status:{key}"),
                    frame.get("statusText").and_then(Value::as_str).is_some(),
                    false,
                )
            }
            Some("setWidget") => {
                let Some(key) = frame.get("widgetKey").and_then(Value::as_str) else {
                    return;
                };
                let lines = frame.get("widgetLines").and_then(Value::as_array);
                if lines.is_some_and(|lines| lines.iter().any(|line| !line.is_string())) {
                    return;
                }
                (format!("widget:{key}"), lines.is_some(), false)
            }
            Some("set_editor_text") if frame.get("text").and_then(Value::as_str).is_some() => {
                ("editor".to_owned(), true, false)
            }
            Some("notify") if frame.get("message").and_then(Value::as_str).is_some() => {
                let Some(id) = frame.get("id").and_then(Value::as_str) else {
                    return;
                };
                (format!("notice:{id}"), true, true)
            }
            _ => return,
        };
        // Remove the old value even when its replacement is too large to retain.
        if let Some(index) = self.entries.iter().position(|entry| entry.key == key) {
            self.remove(index);
        }
        if !present {
            return;
        }
        let mut size = Size(0);
        if serde_json::to_writer(&mut size, frame).is_err() || size.0 > MAX_FRAME_BYTES {
            return;
        }
        if notice
            && self.entries.iter().filter(|entry| entry.notice).count() >= MAX_NOTICES
            && let Some(index) = self.entries.iter().position(|entry| entry.notice)
        {
            self.remove(index);
        }
        while self.entries.len() >= MAX_ENTRIES || self.bytes + size.0 > MAX_BYTES {
            self.remove(0);
        }
        self.bytes += size.0;
        self.entries.push_back(Entry {
            key,
            frame: frame.clone(),
            bytes: size.0,
            received: now,
            notice,
        });
    }

    /// An upstream desktop snapshot is authoritative, not an append-only replay.
    pub fn replace(&mut self, requests: &Value, now: u64) {
        self.clear();
        if let Some(requests) = requests.as_array() {
            for frame in requests {
                self.apply(frame, now);
            }
        }
    }

    pub fn snapshot(&mut self, now: u64) -> Value {
        self.expire(now);
        json!({"type": "extension_ui_snapshot", "requests": Value::Array(self.entries.iter().map(|entry| entry.frame.clone()).collect())})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_failures_and_late_output_replay_as_bounded_binding_scoped_notices() {
        let mut feedback = Feedback::default();
        let failure = json!({
            "type":"extension_error", "extensionPath":"/extensions/review.ts",
            "event":"tool_call", "error":"hook rejected its input"
        });
        let notice = feedback.apply_native(&failure, "native:7:1:1", 0).unwrap();
        assert_eq!(
            notice["message"],
            "Extension /extensions/review.ts (tool_call): hook rejected its input"
        );
        assert_eq!(notice["notifyType"], "error");
        let output = json!({"type":"command_output","text":"\u{1b}[31mHandoff failed: provider unavailable\u{1b}[0m"});
        let result = feedback.apply_native(&output, "native:7:1:2", 1).unwrap();
        assert_eq!(result["message"], "Handoff failed: provider unavailable");
        assert_eq!(feedback.snapshot(2)["requests"], json!([notice, result]));
        for index in 0..100 {
            let _ = feedback.apply_native(&output, &format!("native:7:1:{}", index + 3), 3);
        }
        assert_eq!(
            feedback.snapshot(3)["requests"].as_array().unwrap().len(),
            MAX_NOTICES
        );
        feedback.clear();
        assert_eq!(feedback.snapshot(4)["requests"], json!([]));
    }

    #[test]
    fn replacements_clears_and_editor_identity_survive_replay() {
        let mut feedback = Feedback::default();
        feedback.apply(&json!({"type":"extension_ui_request","method":"setStatus","id":"s1","statusKey":"git","statusText":"old"}), 0);
        feedback.apply(&json!({"type":"extension_ui_request","method":"setStatus","id":"s2","statusKey":"git","statusText":"main"}), 1);
        feedback.apply(&json!({"type":"extension_ui_request","method":"setWidget","id":"w1","widgetKey":"build","widgetLines":["ready"]}), 2);
        let draft = json!({"type":"extension_ui_request","method":"set_editor_text","id":"draft-1","text":"review me"});
        feedback.apply(&draft, 3);
        assert_eq!(
            feedback.snapshot(4)["requests"].as_array().unwrap().len(),
            3
        );
        feedback.apply(
            &json!({"type":"extension_ui_request","method":"setStatus","statusKey":"git"}),
            5,
        );
        feedback.apply(
            &json!({"type":"extension_ui_request","method":"setWidget","widgetKey":"build"}),
            6,
        );
        assert_eq!(feedback.snapshot(7)["requests"], json!([draft]));
        assert_eq!(feedback.snapshot(8), feedback.snapshot(9));
        feedback.clear();
        assert_eq!(feedback.snapshot(10)["requests"], json!([]));
    }

    #[test]
    fn bounded_notices_expire_and_internal_frames_never_replay() {
        let mut feedback = Feedback::default();
        for id in 0..100 {
            feedback.apply(&json!({"type":"extension_ui_request","method":"notify","id":id.to_string(),"message":"hello"}), 0);
        }
        for (method, field) in [
            ("setStatus", "statusKey"),
            ("setWidget", "widgetKey"),
            ("notify", "message"),
        ] {
            let mut frame = json!({"type":"extension_ui_request","method":method,"id":"internal"});
            frame[field] = json!("omp-pulse-out:secret");
            assert!(is_internal(&frame));
            feedback.apply(&frame, 1);
        }
        assert_eq!(
            feedback.snapshot(2)["requests"].as_array().unwrap().len(),
            MAX_NOTICES
        );
        assert_eq!(feedback.snapshot(NOTICE_TTL_MS)["requests"], json!([]));
    }

    #[test]
    fn oversize_replacement_drops_old_value_and_snapshot_replaces_source() {
        let mut feedback = Feedback::default();
        let status = |text: &str| json!({"type":"extension_ui_request","method":"setStatus","statusKey":"x","statusText":text});
        feedback.apply(&status("old"), 0);
        feedback.apply(&status(&"x".repeat(MAX_FRAME_BYTES)), 1);
        assert_eq!(feedback.snapshot(1)["requests"], json!([]));
        for index in 0..100 {
            feedback.apply(&json!({"type":"extension_ui_request","method":"setStatus","statusKey":index.to_string(),"statusText":"small"}), 2);
        }
        assert_eq!(
            feedback.snapshot(2)["requests"].as_array().unwrap().len(),
            MAX_ENTRIES
        );
        feedback.clear();
        for index in 0..100 {
            feedback.apply(&json!({"type":"extension_ui_request","method":"setStatus","statusKey":index.to_string(),"statusText":"x".repeat(10_000)}), 2);
        }
        let snapshot = feedback.snapshot(2);
        assert!(snapshot["requests"].as_array().unwrap().len() <= MAX_ENTRIES);
        assert!(snapshot.to_string().len() < MAX_BYTES + 1024);
        let mut other = Feedback::default();
        other.replace(&snapshot["requests"], 2);
        feedback.replace(&json!([]), 3);
        assert!(!other.snapshot(3)["requests"].as_array().unwrap().is_empty());
        assert_eq!(feedback.snapshot(3)["requests"], json!([]));
    }
}
