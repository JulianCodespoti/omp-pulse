//! Pure timestamp regressions and synthetic temporary-session integration.

use super::*;
use std::path::PathBuf;

struct SyntheticSession(PathBuf);

impl SyntheticSession {
    fn new(tag: &str, message: &Value) -> Self {
        let path = std::env::temp_dir().join(format!(
            "omp-pulse-timestamp-{}-{tag}.jsonl",
            std::process::id()
        ));
        let content = format!(
            "{}\n{}\n{}\n{}\n{{\"type\":",
            serde_json::json!({"type": "session", "id": "synthetic", "cwd": "/synthetic"}),
            serde_json::json!({"type": "message", "id": "older", "timestamp": "2026-10-13T03:00:00.123Z", "message": {"role": "user", "content": "older"}}),
            message,
            serde_json::json!({"type": "turn_end", "outcome": "completed"}),
        );
        fs::write(&path, content).unwrap();
        Self(path)
    }
}

impl Drop for SyntheticSession {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn malformed_message() -> Value {
    serde_json::json!({
        "type": "message",
        "id": "newest",
        "timestamp": "2026-10-13T04:00:00.🦀Z",
        "message": {"role": "user", "content": "Keep this message"},
    })
}

#[test]
fn preserves_ascii_fractional_precision() {
    let second = 1_791_864_000_000.0;
    for (fraction, millis) in [
        ("", 0.0),
        (".0", 0.0),
        (".1", 100.0),
        (".12", 120.0),
        (".123", 123.0),
        (".123456789", 123.0),
        (".0009", 0.0),
        (".999999", 999.0),
    ] {
        let timestamp = format!("2026-10-13T04:00:00{fraction}Z");
        assert_eq!(iso_utc_ms(&timestamp), Some(second + millis), "{timestamp}");
    }
}

#[test]
fn rejects_non_ascii_fraction_without_panicking() {
    for character in ["é", "€", "🦀"] {
        for prefix in ["", "0", "00"] {
            let timestamp = format!("2026-10-13T04:00:00.{prefix}{character}Z");
            assert_eq!(iso_utc_ms(&timestamp), None, "{timestamp}");
        }
    }
}

#[test]
fn preserves_rejection_of_malformed_ascii_timestamps() {
    for timestamp in [
        "",
        "2026-10-13T04:00:00.12",
        "2026-10-13T04:00:00.abcZ",
        "2026-10-13T04:00:00.1xZ",
        "2026-10-13T04:00:00.12xZ",
        "2026-10-13T04:00:0",
        "🦀26-10-13T04:00:00.123Z",
    ] {
        assert_eq!(iso_utc_ms(timestamp), None, "{timestamp}");
    }
}

#[test]
fn metadata_preserves_identity_and_outcome_with_malformed_timestamp() {
    let message = malformed_message();
    let file = SyntheticSession::new("metadata", &message);
    let metadata = session_metadata(&file.0);
    assert_eq!(metadata.active_at, None);
    assert_eq!(metadata.latest_entry_id.as_deref(), Some("newest"));
    assert_eq!(metadata.last_turn_outcome.as_deref(), Some("completed"));
    assert_eq!(
        metadata.revision,
        Some(stable_revision(message.to_string().as_bytes()))
    );
}

#[test]
fn snippet_preserves_newest_message_with_malformed_timestamp() {
    let file = SyntheticSession::new("snippet", &malformed_message());
    let snippet = last_snippet(&file.0).expect("message content remains available");
    assert_eq!(snippet.role, "user");
    assert_eq!(snippet.text, "Keep this message");
    assert_eq!(snippet.at, None);
}

#[test]
fn newest_user_time_does_not_fall_back_to_an_older_turn() {
    let file = SyntheticSession::new("user-time", &malformed_message());
    assert_eq!(last_user_message_ms(&file.0, 10), None);
}

#[test]
fn numeric_message_timestamp_retains_precedence() {
    let mut message = malformed_message();
    let numeric = 1_791_864_000_456_u64;
    message["message"]["timestamp"] = serde_json::json!(numeric);
    let file = SyntheticSession::new("numeric", &message);
    assert_eq!(session_metadata(&file.0).active_at, Some(numeric as f64));
    assert_eq!(last_snippet(&file.0).unwrap().at, Some(numeric as f64));
    assert_eq!(last_user_message_ms(&file.0, 10), Some(numeric));
}
