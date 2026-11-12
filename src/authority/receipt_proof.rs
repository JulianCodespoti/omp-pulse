//! Settle `uncertain` command receipts from the session transcript.
//!
//! A receipt goes uncertain when the handoff to omp became ambiguous: the
//! daemon restarted (the phone app was killed) or the child stopped answering.
//! The Android outbox never replays uncertain work and counts it against its
//! 50-command cap, so every such send stayed a "Check status / Remove" row
//! until removed by hand, even though most had reached the agent.
//!
//! omp writes each prompt it accepts into the session JSONL as a user message.
//! Finding the command there proves delivery, so the receipt settles as
//! `forwarded` (`ACCEPTED_OUTCOME_UNTRACKED`): delivered, outcome unrecorded.
//! Nothing is resent, and an entry proves at most one command.
//!
//! Matching, per session, in order of command creation:
//! 1. The full fingerprint (session, text, images) equals the entry's. Text
//!    prompts match this way; photos do not, because omp stores them
//!    re-encoded behind `blob:` references.
//! 2. The transcript witness (session, text, image count) equals the entry's.
//!    Recorded for every prompt since this module exists.
//! 3. Older photo prompts have neither: the first unclaimed user entry with
//!    images written within `LEGACY_PHOTO_WINDOW_MS` of the command, provided
//!    no other command in that session was created in between.
//!
//! An entry must not predate its command by more than `CLOCK_SLACK_MS`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::authority::command_ledger::{CommandLedger, ProofRow};

const CLOCK_SLACK_MS: u64 = 5_000;
const LEGACY_PHOTO_WINDOW_MS: u64 = 60_000;
/// Recheck interval while an uncertain receipt remains: its prompt can land
/// in the transcript any time after the handoff went ambiguous.
const RESCAN: Duration = Duration::from_secs(60);

/// Settle uncertain receipts for the daemon's lifetime: one pass at startup
/// (a restart is what sweeps in-flight work to uncertain), then a pass every
/// `RESCAN` while any receipt is still uncertain, and otherwise none until a
/// receipt goes uncertain.
///
/// It used to pass every 60 s forever, cloning every ledger row each time,
/// so an idle phone woke once a minute with nothing that could be settled.
pub async fn run(ledger: Arc<CommandLedger>) {
    let mut seen = HashMap::new();
    loop {
        let pass = Arc::clone(&ledger);
        // A panicked pass loses its cache; the next one rereads every file.
        seen = tokio::task::spawn_blocking(move || {
            reconcile(&pass, &mut seen);
            seen
        })
        .await
        .unwrap_or_default();
        if ledger.has_uncertain() {
            tokio::select! {
                _ = tokio::time::sleep(RESCAN) => continue,
                _ = ledger.uncertain_added() => {}
            }
        } else {
            ledger.uncertain_added().await;
        }
        // A receipt just went uncertain. Its prompt may already sit in a
        // transcript whose length `seen` recorded for an earlier pass, which
        // would skip the file as "nothing new to prove"; forget the lengths.
        seen.clear();
    }
}

struct UserEntry {
    at: u64,
    fingerprints: Vec<String>,
    witnesses: Vec<String>,
    images: usize,
}

/// One pass over every session that has uncertain receipts. `seen` maps a
/// session path to the file length last examined: an unchanged file cannot
/// prove anything new, so it is skipped. Returns the number settled.
pub fn reconcile(ledger: &CommandLedger, seen: &mut HashMap<String, u64>) -> usize {
    let rows = ledger.proof_rows();
    let mut by_session: HashMap<&str, Vec<&ProofRow>> = HashMap::new();
    for row in &rows {
        by_session
            .entry(row.session_path.as_str())
            .or_default()
            .push(row);
    }
    let mut settle = Vec::new();
    for (session, mut rows) in by_session {
        if !rows.iter().any(|r| r.uncertain) {
            continue;
        }
        let Ok(len) = std::fs::metadata(session).map(|m| m.len()) else {
            continue;
        };
        if seen.get(session) == Some(&len) {
            continue;
        }
        let entries = user_entries(Path::new(session));
        rows.sort_by_key(|r| r.created_at);
        settle.extend(matches(&rows, &entries));
        seen.insert(session.to_owned(), len);
    }
    if settle.is_empty() {
        return 0;
    }
    match ledger.settle_delivered(&settle) {
        Ok(n) => {
            tracing::info!(
                settled = n,
                "uncertain receipts found delivered in transcripts"
            );
            n
        }
        Err(error) => {
            tracing::warn!(%error, "could not settle delivered receipts");
            // Look again next pass.
            seen.clear();
            0
        }
    }
}

/// Command ids among `rows` (one session, sorted by `created_at`) that are
/// uncertain and proven delivered by `entries`.
fn matches(rows: &[&ProofRow], entries: &[UserEntry]) -> Vec<String> {
    let mut claimed = vec![false; entries.len()];
    let mut matched = vec![false; rows.len()];
    let mut out = Vec::new();
    let after = |row: &ProofRow, e: &UserEntry| e.at + CLOCK_SLACK_MS >= row.created_at;
    for (i, row) in rows.iter().enumerate() {
        let hit = entries.iter().enumerate().position(|(j, e)| {
            !claimed[j]
                && after(row, e)
                && (e.fingerprints.contains(&row.fingerprint)
                    || row
                        .witness
                        .as_ref()
                        .is_some_and(|w| e.witnesses.contains(w)))
        });
        if let Some(j) = hit {
            claimed[j] = true;
            matched[i] = true;
            if row.uncertain {
                out.push(row.command_id.clone());
            }
        }
    }
    for (i, row) in rows.iter().enumerate() {
        if matched[i] || row.witness.is_some() {
            continue;
        }
        let hit = entries.iter().enumerate().position(|(j, e)| {
            !claimed[j]
                && e.images > 0
                && after(row, e)
                && e.at <= row.created_at + LEGACY_PHOTO_WINDOW_MS
        });
        let Some(j) = hit else { continue };
        let at = entries[j].at;
        let crowded = rows
            .iter()
            .any(|other| other.created_at > row.created_at && other.created_at <= at);
        if crowded {
            continue;
        }
        claimed[j] = true;
        if row.uncertain {
            out.push(row.command_id.clone());
        }
    }
    out
}

fn user_entries(path: &Path) -> Vec<UserEntry> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let session = path.to_string_lossy();
    let mut out = Vec::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        // Cheap prefilter: most lines are assistant output and tool results.
        if !line.contains("\"user\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(entry) = user_entry(&session, &v) {
            out.push(entry);
        }
    }
    out
}

fn user_entry(session: &str, v: &Value) -> Option<UserEntry> {
    let message = v.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let at = crate::sessions::jsonl::entry_time_ms(v)? as u64;
    let (texts, images): (Vec<&str>, Vec<Value>) = match message.get("content")? {
        Value::String(text) => (vec![text.as_str()], Vec::new()),
        Value::Array(parts) => {
            let texts = parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect();
            let images = parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("image"))
                .cloned()
                .collect();
            (texts, images)
        }
        _ => return None,
    };
    // A prompt is one text part in practice; several are joined either way.
    let mut variants = vec![texts.concat()];
    if texts.len() > 1 {
        variants.push(texts.join("\n"));
    }
    Some(UserEntry {
        at,
        fingerprints: variants
            .iter()
            .map(|t| CommandLedger::fingerprint(session, t, &images))
            .collect(),
        witnesses: variants
            .iter()
            .map(|t| CommandLedger::transcript_witness(session, t, images.len()))
            .collect(),
        images: images.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::command_ledger::ReceiptState;
    use serde_json::json;

    fn line(text: &str, images: usize, at_ms: u64) -> String {
        let mut content = vec![json!({"type":"text","text":text})];
        for _ in 0..images {
            content.push(json!({"type":"image","mimeType":"image/webp","data":"blob:sha256:x"}));
        }
        json!({"type":"message","message":{"role":"user","content":content,"timestamp":at_ms}})
            .to_string()
    }

    /// The ledger stamps `created_at` itself; tests place transcript entries
    /// relative to it.
    fn created(ledger: &CommandLedger, id: &str) -> u64 {
        ledger.get(id).unwrap().unwrap().created_at
    }

    fn uncertain(ledger: &CommandLedger, id: &str) {
        ledger
            .update(
                id,
                ReceiptState::Uncertain,
                Some("interrupted_dispatch"),
                None,
            )
            .unwrap();
    }

    #[test]
    fn delivered_prompts_settle_and_undelivered_ones_stay_uncertain() {
        let dir = std::env::temp_dir().join(format!("omp-pulse-proof-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let session = dir.join("s.jsonl");
        let s = session.to_str().unwrap();
        let ledger = CommandLedger::open(&dir.join("state")).unwrap();
        let photo = [json!({"mimeType":"image/jpeg","data":"original-bytes"})];
        // text: proven by fingerprint. witnessed: a photo with a witness.
        // legacy: a photo without one. twice: the same text sent twice, one
        // entry only. lost: never reached the transcript.
        ledger
            .submit("text", s, &CommandLedger::fingerprint(s, "hello", &[]))
            .unwrap();
        ledger
            .submit_witnessed(
                "witnessed",
                s,
                &CommandLedger::fingerprint(s, "look", &photo),
                Some(&CommandLedger::transcript_witness(s, "look", 1)),
            )
            .unwrap();
        ledger
            .submit(
                "twice-a",
                s,
                &CommandLedger::fingerprint(s, "Continue", &[]),
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        ledger
            .submit(
                "twice-b",
                s,
                &CommandLedger::fingerprint(s, "Continue", &[]),
            )
            .unwrap();
        ledger
            .submit("lost", s, &CommandLedger::fingerprint(s, "gone", &[]))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        // Created last: no other command was made between it and its entry.
        ledger
            .submit("legacy", s, &CommandLedger::fingerprint(s, "old", &photo))
            .unwrap();
        for id in ["text", "witnessed", "legacy", "twice-a", "twice-b", "lost"] {
            uncertain(&ledger, id);
        }
        let t = created(&ledger, "legacy");
        let lines = [
            // Older than every command by far: proves nothing.
            line("gone", 0, t - 3_600_000),
            line("hello", 0, t + 100),
            line("look", 1, t + 200),
            line("old", 1, t + 300),
            line("Continue", 0, t + 400),
        ];
        std::fs::write(&session, lines.join("\n") + "\n").unwrap();

        let mut seen = HashMap::new();
        assert_eq!(reconcile(&ledger, &mut seen), 4);
        let state = |id: &str| ledger.get(id).unwrap().unwrap().state;
        for id in ["text", "witnessed", "legacy", "twice-a"] {
            assert!(matches!(state(id), ReceiptState::Forwarded), "{id}");
        }
        assert!(
            matches!(state("twice-b"), ReceiptState::Uncertain),
            "one entry, one command"
        );
        assert!(matches!(state("lost"), ReceiptState::Uncertain));
        // An unchanged file is not read again; a grown one is.
        assert_eq!(reconcile(&ledger, &mut seen), 0);
        let mut grown = std::fs::read_to_string(&session).unwrap();
        grown.push_str(&(line("Continue", 0, t + 500) + "\n"));
        std::fs::write(&session, grown).unwrap();
        assert_eq!(reconcile(&ledger, &mut seen), 1);
        assert!(matches!(state("twice-b"), ReceiptState::Forwarded));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_legacy_photo_never_borrows_a_later_commands_entry() {
        let dir =
            std::env::temp_dir().join(format!("omp-pulse-proof-crowd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let session = dir.join("s.jsonl");
        let s = session.to_str().unwrap();
        let ledger = CommandLedger::open(&dir.join("state")).unwrap();
        let photo = [json!({"mimeType":"image/jpeg","data":"a"})];
        ledger
            .submit("first", s, &CommandLedger::fingerprint(s, "one", &photo))
            .unwrap();
        uncertain(&ledger, "first");
        std::thread::sleep(std::time::Duration::from_millis(5));
        ledger
            .submit("second", s, &CommandLedger::fingerprint(s, "two", &photo))
            .unwrap();
        // Only the second photo reached the transcript, after both were made.
        let t = created(&ledger, "second");
        std::fs::write(&session, line("two", 1, t + 100) + "\n").unwrap();
        assert_eq!(reconcile(&ledger, &mut HashMap::new()), 0);
        assert!(matches!(
            ledger.get("first").unwrap().unwrap().state,
            ReceiptState::Uncertain
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Wait in real time for the reconciler's blocking pass to land, while
    /// letting the (paused-clock) runtime poll the reconciler task.
    async fn eventually(what: &str, done: impl Fn() -> bool) {
        for _ in 0..1_000 {
            if done() {
                return;
            }
            tokio::task::yield_now().await;
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        panic!("never happened: {what}");
    }

    /// The reconciler used to pass every minute forever. Now it sleeps while
    /// nothing is uncertain, runs as soon as a receipt goes uncertain, and
    /// keeps rechecking while one is left, so a prompt that reaches the
    /// transcript later still settles.
    #[tokio::test(start_paused = true)]
    async fn reconciler_wakes_on_uncertainty_and_rechecks_while_some_remains() {
        let dir = std::env::temp_dir().join(format!("omp-pulse-proof-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let session = dir.join("s.jsonl");
        let s = session.to_str().unwrap();
        let ledger = Arc::new(CommandLedger::open(&dir.join("state")).unwrap());
        ledger
            .submit("sent", s, &CommandLedger::fingerprint(s, "hello", &[]))
            .unwrap();
        ledger
            .submit("late", s, &CommandLedger::fingerprint(s, "later", &[]))
            .unwrap();
        let t = created(&ledger, "late");
        std::fs::write(&session, line("hello", 0, t + 100) + "\n").unwrap();
        let state = |id: &str| ledger.get(id).unwrap().unwrap().state;
        let task = tokio::spawn(run(Arc::clone(&ledger)));
        // Startup pass, then parked: nothing is uncertain.
        tokio::time::sleep(Duration::from_secs(3600)).await;

        // Going uncertain wakes it; the prompt is already in the transcript.
        uncertain(&ledger, "sent");
        eventually("the woken pass settles `sent`", || {
            matches!(state("sent"), ReceiptState::Forwarded)
        })
        .await;

        // Not in the transcript yet: it stays uncertain, and is found by a
        // recheck once its prompt lands, with no further wake.
        uncertain(&ledger, "late");
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(matches!(state("late"), ReceiptState::Uncertain));
        let mut grown = std::fs::read_to_string(&session).unwrap();
        grown.push_str(&(line("later", 0, t + 200) + "\n"));
        std::fs::write(&session, grown).unwrap();
        tokio::time::sleep(RESCAN + Duration::from_secs(1)).await;
        eventually("a recheck settles `late`", || {
            matches!(state("late"), ReceiptState::Forwarded)
        })
        .await;
        task.abort();
        let _ = std::fs::remove_dir_all(dir);
    }
}
