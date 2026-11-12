//! Diagnostic tests: filesystem-only cache freshness checks on synthetic files.
use super::*;
use std::fs::{File, FileTimes};
use std::path::PathBuf;

struct SyntheticSession(PathBuf);

impl SyntheticSession {
    fn new(tag: &str, content: &str, nanos: u32) -> Self {
        let path = std::env::temp_dir().join(format!(
            "omp-pulse-index-resilience-{}-{tag}.jsonl",
            std::process::id()
        ));
        let session = Self(path);
        session.write(content, nanos);
        session
    }

    fn write(&self, content: &str, nanos: u32) {
        std::fs::write(&self.0, content).unwrap();
        let at = UNIX_EPOCH + Duration::new(1_800_000_000, nanos);
        File::options()
            .write(true)
            .open(&self.0)
            .unwrap()
            .set_times(FileTimes::new().set_modified(at))
            .unwrap();
        assert_eq!(
            self.modified(),
            at,
            "fixture requires preserved nanosecond timestamps"
        );
    }

    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
    fn modified(&self) -> SystemTime {
        std::fs::metadata(&self.0).unwrap().modified().unwrap()
    }
}

impl Drop for SyntheticSession {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn message(id: &str, text: &str, model: &str) -> String {
    json!({"type":"message", "id":id, "message":{
        "role":"assistant", "timestamp":1000, "content":text,
        "model":model, "stopReason":"stop"
    }})
    .to_string()
        + "\n"
}

fn cached(file: &SyntheticSession) -> (Option<String>, Option<String>, Option<String>) {
    (
        metadata_for(file.path()).latest_entry_id,
        snippet_for(file.path()).map(|snippet| snippet.text),
        model_for(file.path()),
    )
}

fn fresh(file: &SyntheticSession) -> (Option<String>, Option<String>, Option<String>) {
    (
        jsonl::session_metadata(&file.0).latest_entry_id,
        jsonl::last_snippet(&file.0).map(|snippet| snippet.text),
        jsonl::last_model(&file.0),
    )
}

fn expected(id: &str, text: &str, model: &str) -> (Option<String>, Option<String>, Option<String>) {
    (Some(id.into()), Some(text.into()), Some(model.into()))
}

#[test]
fn same_size_torn_record_repair_refreshes_all_memos() {
    let older = message("older", "older text", "old-model");
    let newest = message("newer", "newer text", "new-model");
    let complete = older + &newest;
    let mut torn = complete.as_bytes().to_vec();
    let final_brace = torn.len() - 2;
    torn[final_brace] = b' ';
    let torn = String::from_utf8(torn).unwrap();
    let file = SyntheticSession::new("repair", &torn, 1_200_000);
    assert_eq!(cached(&file), expected("older", "older text", "old-model"));
    let before = file.modified();
    file.write(&complete, 1_900_000);
    assert_ne!(before, file.modified());
    assert_eq!(torn.len(), complete.len());
    let want = expected("newer", "newer text", "new-model");
    assert_eq!(fresh(&file), want);
    let actual = cached(&file);
    eprintln!("same-size repair: fresh={want:?}, cached={actual:?}");
    assert_eq!(actual, want, "completed repair must invalidate each cache");
}

#[test]
fn same_size_valid_edit_refreshes_all_memos() {
    let before = message("older", "older text", "old-model");
    let after = message("newer", "newer text", "new-model");
    assert_eq!(before.len(), after.len());
    let file = SyntheticSession::new("edit", &before, 2_200_000);
    assert_eq!(cached(&file), expected("older", "older text", "old-model"));
    let old_mtime = file.modified();
    file.write(&after, 2_900_000);
    assert_ne!(old_mtime, file.modified());
    let want = expected("newer", "newer text", "new-model");
    assert_eq!(fresh(&file), want);
    let actual = cached(&file);
    eprintln!("same-size valid edit: fresh={want:?}, cached={actual:?}");
    assert_eq!(actual, want, "valid rewrite must invalidate each cache");
}

#[test]
fn size_change_within_one_millisecond_refreshes_all_memos() {
    let before = message("older", "older text", "old-model");
    let after = before.clone() + &message("newer", "newer text", "new-model");
    let file = SyntheticSession::new("size", &before, 3_200_000);
    assert_eq!(cached(&file), expected("older", "older text", "old-model"));
    file.write(&after, 3_900_000);
    let want = expected("newer", "newer text", "new-model");
    assert_eq!(fresh(&file), want);
    assert_eq!(cached(&file), want);
}

#[test]
fn whole_millisecond_change_refreshes_all_memos() {
    let before = message("older", "older text", "old-model");
    let after = message("newer", "newer text", "new-model");
    assert_eq!(before.len(), after.len());
    let file = SyntheticSession::new("millisecond", &before, 4_200_000);
    assert_eq!(cached(&file), expected("older", "older text", "old-model"));
    file.write(&after, 5_200_000);
    let want = expected("newer", "newer text", "new-model");
    assert_eq!(fresh(&file), want);
    assert_eq!(cached(&file), want);
}

#[test]
fn unchanged_stamp_and_length_reuse_existing_memos() {
    let content = message("older", "older text", "old-model");
    let file = SyntheticSession::new("unchanged", &content, 6_200_000);
    let want = expected("older", "older text", "old-model");
    assert_eq!(cached(&file), want);
    assert_eq!(cached(&file), want);
    assert_eq!(fresh(&file), want);
    let stamp = Some(file.modified());
    let size = content.len() as u64;
    assert_eq!(
        SNIPPET_CACHE
            .lock()
            .unwrap()
            .get(file.path())
            .map(|entry| (entry.0, entry.1)),
        Some((stamp, size))
    );
    assert_eq!(
        METADATA_CACHE
            .lock()
            .unwrap()
            .get(file.path())
            .map(|entry| (entry.0, entry.1)),
        Some((stamp, size))
    );
    assert_eq!(
        MODEL_CACHE
            .lock()
            .unwrap()
            .get(file.path())
            .map(|entry| (entry.0, entry.1)),
        Some((stamp, size))
    );
}

#[test]
fn length_change_with_exactly_preserved_stamp_refreshes_all_memos() {
    let before = message("older", "older text", "old-model");
    let after = before.clone() + &message("newer", "newer text", "new-model");
    let file = SyntheticSession::new("exact-stamp-size", &before, 7_200_000);
    assert_eq!(cached(&file), expected("older", "older text", "old-model"));
    let stamp = file.modified();
    file.write(&after, 7_200_000);
    assert_eq!(file.modified(), stamp);
    let want = expected("newer", "newer text", "new-model");
    assert_eq!(fresh(&file), want);
    assert_eq!(cached(&file), want);
}

#[test]
fn same_stamp_and_length_remain_a_documented_detection_limit() {
    let before = message("older", "older text", "old-model");
    let after = message("newer", "newer text", "new-model");
    assert_eq!(before.len(), after.len());
    let file = SyntheticSession::new("same-stamp-edit", &before, 8_200_000);
    let old = expected("older", "older text", "old-model");
    assert_eq!(cached(&file), old);
    let stamp = file.modified();
    file.write(&after, 8_200_000);
    assert_eq!(file.modified(), stamp);
    assert_eq!(fresh(&file), expected("newer", "newer text", "new-model"));
    assert_eq!(
        cached(&file),
        old,
        "same precise stamp and size must retain memo-hit semantics"
    );
}

#[test]
fn wire_milliseconds_remain_unchanged() {
    let content = message("older", "older text", "old-model");
    let file = SyntheticSession::new("wire", &content, 9_200_000);
    assert_eq!(
        mtime_ms(&std::fs::metadata(&file.0).unwrap()),
        1_800_000_000_009.0
    );
    file.write(&content, 9_900_000);
    assert_eq!(
        mtime_ms(&std::fs::metadata(&file.0).unwrap()),
        1_800_000_000_009.0
    );
}

#[test]
fn vanished_file_does_not_serve_populated_memos() {
    let content = message("older", "older text", "old-model");
    let file = SyntheticSession::new("vanished", &content, 10_200_000);
    assert_eq!(cached(&file), expected("older", "older text", "old-model"));
    std::fs::remove_file(&file.0).unwrap();
    assert_eq!(cached(&file), (None, None, None));
    assert_eq!(fresh(&file), (None, None, None));
    let metadata = metadata_for(file.path());
    assert_eq!(metadata.revision, None);
    assert_eq!(metadata.active_at, None);
    assert_eq!(metadata.last_turn_outcome, None);
}
