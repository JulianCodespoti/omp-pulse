//! Durable withdrawn drafts, replayed until the phone explicitly acknowledges them.
//!
//! Withdrawing a queued message (or Stop's whole-queue withdrawal) removes it
//! from omp for good, so the text and photos exist in exactly one place for
//! the moment between omp's reply and the phone saving them. That place is a
//! per-session journal under `<state_dir>/queue-recovery/<sha256(session)>/`,
//! the same directory the desktop-control extension writes when the desktop
//! owns the queue. A record leaves only when the phone acknowledges it after
//! its own durable draft save, so a dropped connection, a phone that died
//! mid-reply or a daemon restart replays it instead of losing it.
//!
//! A single-message withdrawal is keyed by the owner-issued `itemId` the phone
//! chose, so a repeated delivery of one withdrawal is one record, not two.
//! Message text is never logged; errors name only the I/O failure.

use super::*;
use sha2::{Digest, Sha256};
use std::io::Write;

/// Unacknowledged records kept per session. Past it the oldest is dropped, so
/// a phone that never reconnects cannot grow the state directory without
/// bound; a person withdrawing 64 messages without a single phone sync is not
/// a case worth unbounded disk.
const MAX_RECORDS_PER_SESSION: usize = 64;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn directory(state_dir: &FsPath, session: &str) -> PathBuf {
    let digest = Sha256::digest(session.as_bytes());
    state_dir.join("queue-recovery").join(hex(&digest))
}

/// A withdrawal of one owner-issued item always maps to the same record id.
fn item_recovery_id(item_id: &str) -> String {
    let digest = Sha256::digest(format!("queue-item\0{item_id}").as_bytes());
    hex(&digest[..16])
}

/// Once withdrawal starts, its response and journal write outlive the HTTP
/// waiter. This task owns the only copy until persistence finishes.
pub(super) async fn capture(
    state_dir: PathBuf,
    session: String,
    kind: &'static str,
    item_id: Option<String>,
    withdrawal: impl Future<Output = Result<Option<Value>, String>> + Send + 'static,
) -> Result<Option<Value>, String> {
    tokio::spawn(async move {
        let Some(data) = withdrawal.await? else {
            return Ok(None);
        };
        tokio::task::spawn_blocking(move || {
            retain(&state_dir, &session, kind, item_id.as_deref(), data).map(Some)
        })
        .await
        .map_err(|_| "withdrawn draft persistence failed".to_string())?
    })
    .await
    .map_err(|_| "queue withdrawal failed".to_string())?
}

/// Journal records oldest first (modified time, then name for a stable tie).
fn records(dir: &FsPath) -> std::io::Result<Vec<(std::time::SystemTime, PathBuf)>> {
    let mut found: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, entry.path())
        })
        .collect();
    found.sort();
    Ok(found)
}

pub(super) fn retain(
    state_dir: &FsPath,
    session: &str,
    kind: &str,
    item_id: Option<&str>,
    mut data: Value,
) -> Result<Value, String> {
    if data.get("recoveryId").and_then(Value::as_str).is_some() {
        return Ok(data); // The desktop owner persisted it before replying.
    }
    let empty = if kind == "message" {
        data.get("removed").and_then(Value::as_bool) != Some(true)
    } else {
        ["steering", "followUp"].iter().all(|key| {
            data.get(key)
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
        })
    };
    if empty {
        return Ok(data);
    }
    let dir = directory(state_dir, session);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot prepare draft recovery: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let id = match item_id {
        Some(item) => item_recovery_id(item),
        None => format!("{:032x}", rand::random::<u128>()),
    };
    let path = dir.join(format!("{id}.json"));
    data["recoveryId"] = json!(id);
    if item_id.is_some() && path.is_file() {
        return Ok(data); // This item's withdrawal is already journalled.
    }
    if let Ok(existing) = records(&dir)
        && existing.len() >= MAX_RECORDS_PER_SESSION
    {
        for (_, stale) in &existing[..existing.len() + 1 - MAX_RECORDS_PER_SESSION] {
            let _ = std::fs::remove_file(stale);
        }
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Recovery<'a> {
        id: &'a str,
        kind: &'a str,
        session_path: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        item_id: Option<&'a str>,
        data: &'a Value,
    }
    let record = Recovery {
        id: &id,
        kind,
        session_path: session,
        item_id,
        data: &data,
    };
    let tmp = dir.join(format!("{id}.tmp"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> std::io::Result<()> {
        let file = options.open(&tmp)?;
        let mut output = std::io::BufWriter::new(file);
        serde_json::to_writer(&mut output, &record).map_err(std::io::Error::other)?;
        output.flush()?;
        output.get_ref().sync_all()?;
        drop(output);
        std::fs::rename(&tmp, path)
    })();
    result.map_err(|e| format!("cannot persist withdrawn draft: {e}"))?;
    Ok(data)
}

pub(super) fn replay(state_dir: &FsPath, session: &str) -> Result<Value, String> {
    let dir = directory(state_dir, session);
    let paths = match records(&dir) {
        Ok(paths) => paths,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"recoveries": []})),
        Err(e) => return Err(format!("cannot read withdrawn drafts: {e}")),
    };
    // One full record per replay avoids dropping photos to fit a combined frame.
    // An unreadable record is skipped so it cannot hide the ones behind it.
    for (index, (_, path)) in paths.iter().enumerate() {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if record["sessionPath"].as_str() != Some(session) {
            return Err("withdrawn draft belongs to another session".into());
        }
        return Ok(Value::Object(serde_json::Map::from_iter([
            ("recoveries".into(), Value::Array(vec![record])),
            ("hasMore".into(), Value::Bool(index + 1 < paths.len())),
        ])));
    }
    Ok(json!({"recoveries": []}))
}

pub(super) fn acknowledge(state_dir: &FsPath, session: &str, id: &str) -> Result<Value, String> {
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid recovery ID".into());
    }
    match std::fs::remove_file(directory(state_dir, session).join(format!("{id}.json"))) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot acknowledge withdrawn draft: {e}")),
    }
    Ok(json!({"acknowledged": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("pulse-recovery-{:032x}", rand::random::<u128>()))
    }

    #[tokio::test]
    async fn cancelled_http_waiter_does_not_cancel_withdrawal_capture() {
        let root = root();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let data = json!({"removed":true,"text":"desktop photo","images":[{"data":"photo","mimeType":"image/png"}]});
        let expected = data.clone();
        let task = tokio::spawn(capture(
            root.clone(),
            "session".into(),
            "message",
            Some("item-1".into()),
            async move {
                started.send(()).unwrap();
                released.await.unwrap();
                Ok(Some(data))
            },
        ));
        entered.await.unwrap();
        task.abort();
        release.send(()).unwrap();
        // A barrier on the blocking pool isn't ordered with the journal task;
        // observe its file with a bounded yield loop, never elapsed-time sleeps.
        let recovery = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let value = replay(&root, "session").unwrap();
                if !value["recoveries"].as_array().unwrap().is_empty() {
                    break value;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let stored = &recovery["recoveries"][0]["data"];
        assert_eq!(stored["text"], expected["text"]);
        assert_eq!(stored["images"], expected["images"]);
        assert_eq!(recovery["recoveries"][0]["itemId"], "item-1");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn withdrawal_survives_reopen_until_explicit_ack_without_replay_to_owner() {
        let root = root();
        let original = json!({"steering":[{"text":"look [Photo 1]","images":[{"data":"photo-bytes","mimeType":"image/png"}]}],"followUp":[{"text":"","images":[{"data":"second","mimeType":"image/jpeg"}]}]});
        let stored = retain(&root, "session-a", "queue", None, original.clone()).unwrap();
        let id = stored["recoveryId"].as_str().unwrap();
        let first = replay(&root, "session-a").unwrap();
        assert_eq!(first["recoveries"][0]["data"], stored);
        assert_eq!(
            replay(&root, "session-a").unwrap(),
            first,
            "reads never consume recovery"
        );
        assert_eq!(replay(&root, "session-b").unwrap()["recoveries"], json!([]));
        acknowledge(&root, "session-b", id).unwrap();
        assert_eq!(
            replay(&root, "session-a").unwrap(),
            first,
            "ack is session scoped"
        );
        assert!(acknowledge(&root, "session-a", "../other").is_err());
        acknowledge(&root, "session-a", id).unwrap();
        acknowledge(&root, "session-a", id).unwrap();
        assert_eq!(replay(&root, "session-a").unwrap()["recoveries"], json!([]));
        let message = json!({"removed":true,"text":"","images":[{"data":"only-photo","mimeType":"image/webp"}]});
        let saved = retain(&root, "session-a", "message", Some("item-7"), message).unwrap();
        assert_eq!(
            replay(&root, "session-a").unwrap()["recoveries"][0]["data"],
            saved
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn one_item_is_one_record_and_an_unremoved_item_journals_nothing() {
        let root = root();
        let removed = json!({"removed":true,"text":"hello"});
        let first = retain(&root, "s", "message", Some("item-1"), removed.clone()).unwrap();
        let again = retain(&root, "s", "message", Some("item-1"), removed.clone()).unwrap();
        assert_eq!(first["recoveryId"], again["recoveryId"]);
        retain(&root, "s", "message", Some("item-2"), removed).unwrap();
        let ids: std::collections::HashSet<_> = records(&directory(&root, "s"))
            .unwrap()
            .into_iter()
            .map(|(_, path)| path)
            .collect();
        assert_eq!(ids.len(), 2);
        let missed = retain(
            &root,
            "s",
            "message",
            Some("item-3"),
            json!({"removed":false}),
        )
        .unwrap();
        assert!(missed.get("recoveryId").is_none());
        assert_eq!(records(&directory(&root, "s")).unwrap().len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn journal_is_bounded_per_session_and_skips_unreadable_records() {
        let root = root();
        for index in 0..MAX_RECORDS_PER_SESSION + 5 {
            let data = json!({"removed":true,"text":"x"});
            retain(&root, "s", "message", Some(&format!("item-{index}")), data).unwrap();
        }
        let dir = directory(&root, "s");
        assert_eq!(records(&dir).unwrap().len(), MAX_RECORDS_PER_SESSION);
        // Garbage that sorts first must not hide the readable records.
        let junk = dir.join(format!("{:032x}.json", 0));
        std::fs::write(&junk, b"not json").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&junk)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH)
            .unwrap();
        let replayed = replay(&root, "s").unwrap();
        assert_eq!(replayed["recoveries"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
