//! The helper extension every phone-driven omp child loads with `-e`.
//!
//! omp's RPC has no plan mode, in-place tree moves, entry labels or `!!` bash.
//! `extensions/omp-pulse-child.ts` adds them as slash commands the daemon
//! sends as RPC prompts, and answers through `setStatus` UI frames keyed
//! [`REPLY_KEY_PREFIX`]. This module owns the embedded source, its on-disk
//! copy and the command/reply wire format; `child.rs` owns delivery.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tracing::warn;

const SOURCE: &str = include_str!("../../../extensions/omp-pulse-child.ts");
const QUEUE_SOURCE: &str = crate::omp::desktop_control::QUEUE_HELPER_SOURCE;

/// `setStatus` keys the extension answers on; never shown to the phone.
const REPLY_KEY_PREFIX: &str = "omp-pulse:";

/// `setStatus` keys carrying a running `/pulse-bash`'s live output, suffixed
/// with the stream id the daemon passed in the command's payload. Not a
/// reply: the request stays open until its `omp-pulse:` frame arrives.
const OUTPUT_KEY_PREFIX: &str = "omp-pulse-out:";

/// RPC ids of extension prompts. Distinct from `pulse-prompt:` so the prompt
/// lifecycle (receipts, running-turn tracking) never mistakes a control
/// command for a conversation turn.
pub(super) const RPC_ID_PREFIX: &str = "pulse-ext:";

const DIR_NAME: &str = "child-extension";
const FILE_PREFIX: &str = "omp-pulse-child-";
const QUEUE_FILE_PREFIX: &str = "omp-pulse-queue-";
static QUEUE_FILE_NAME: LazyLock<String> = LazyLock::new(|| {
    use std::fmt::Write as _;
    let mut name = String::with_capacity(QUEUE_FILE_PREFIX.len() + 16 + 3);
    name.push_str(QUEUE_FILE_PREFIX);
    for byte in Sha256::digest(QUEUE_SOURCE.as_bytes()).iter().take(8) {
        let _ = write!(name, "{byte:02x}");
    }
    name.push_str(".ts");
    name
});
static RENDERED_SOURCE: LazyLock<String> = LazyLock::new(|| {
    SOURCE.replace(
        "./pulse-queue.ts",
        &format!("./{}", QUEUE_FILE_NAME.as_str()),
    )
});

/// Versioned by content: a new daemon writes a new file instead of editing
/// the one a running child loaded, and a stale copy is never mistaken for
/// the current one.
static FILE_NAME: LazyLock<String> = LazyLock::new(|| {
    let mut hasher = Sha256::new();
    hasher.update(SOURCE.as_bytes());
    hasher.update(QUEUE_SOURCE.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("{FILE_PREFIX}{hex}.ts")
});

/// How long another version's copy must sit untouched before it is pruned.
/// Every `materialize` refreshes its own file's mtime, so a copy this old
/// belongs to no daemon that spawned a child within the margin.
const PRUNE_AFTER: Duration = Duration::from_secs(60 * 60);

/// Write the extension under `state_dir` (idempotent) and return its path.
///
/// `None` when it cannot be written: the child then boots without it (every
/// phone control fails with a sentence via the probe) rather than not at all.
/// Written by rename so a child booting beside a concurrent spawn never loads
/// a half-written file.
///
/// Other versions are pruned only once stale ([`PRUNE_AFTER`]). Two daemon
/// builds can share a state dir (a pulse-swap or rollback overlap, a second
/// instance), and a child between exec and extension load still needs its
/// `-e` path on disk: deleting every other version on each spawn removed a
/// sibling daemon's copy under its booting child, which then came up without
/// phone controls ("Phone controls didn't load") until recycled.
pub(super) fn materialize(state_dir: &Path) -> Option<PathBuf> {
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = state_dir.join(DIR_NAME);
    // Publish the dependency first; either entrypoint version always imports
    // its own immutable helper, including during a daemon rollback overlap.
    for (name, source) in [
        (QUEUE_FILE_NAME.as_str(), QUEUE_SOURCE),
        (FILE_NAME.as_str(), RENDERED_SOURCE.as_str()),
    ] {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).is_ok_and(|current| current == source) {
            let _ = std::fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|file| file.set_modified(SystemTime::now()));
        } else {
            let tmp = dir.join(format!(
                ".{name}.{}.{}.tmp",
                std::process::id(),
                TMP_SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let written = std::fs::create_dir_all(&dir)
                .and_then(|()| std::fs::write(&tmp, source))
                .and_then(|()| std::fs::rename(&tmp, &path));
            if let Err(error) = written {
                let _ = std::fs::remove_file(&tmp);
                warn!(path = %path.display(), error = %error, "could not write the omp child extension; phone controls are unavailable");
                return None;
            }
        }
    }
    prune_stale(&dir, SystemTime::now());
    Some(dir.join(FILE_NAME.as_str()))
}

/// Remove other versions' copies untouched for [`PRUNE_AFTER`] at `now`.
fn prune_stale(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (!name.starts_with(FILE_PREFIX) && !name.starts_with(QUEUE_FILE_PREFIX))
            || !name.ends_with(".ts")
            || *name == *FILE_NAME
            || *name == *QUEUE_FILE_NAME
        {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|modified| {
                now.duration_since(modified)
                    .is_ok_and(|age| age >= PRUNE_AFTER)
            });
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The prompt text that runs extension command `name` for request `req_id`.
/// The payload is one compact JSON object after the id (see the extension's
/// argument parser).
pub(super) fn command_text(name: &str, req_id: &str, payload: &Value) -> String {
    format!("/{name} {req_id} {payload}")
}

/// A reply frame from the extension: `extension_ui_request` / `setStatus`
/// with key `omp-pulse:<reqId>` and the JSON reply as its text. `None` for
/// every other frame. An unreadable reply still settles its request (as a
/// failure) so the caller is not left waiting out its timeout.
pub(super) fn parse_reply(frame: &Value) -> Option<(String, Value)> {
    if frame.get("method").and_then(Value::as_str) != Some("setStatus") {
        return None;
    }
    let req_id = frame
        .get("statusKey")
        .and_then(Value::as_str)?
        .strip_prefix(REPLY_KEY_PREFIX)?;
    let reply = frame
        .get("statusText")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "ok": false, "error": "The agent sent an unreadable answer." }));
    Some((req_id.to_string(), reply))
}

/// A live-output frame from a running `/pulse-bash`: `setStatus` with key
/// `omp-pulse-out:<stream>` and the new output as its text. `None` for every
/// other frame and for an empty chunk.
pub(super) fn parse_output(frame: &Value) -> Option<(String, String)> {
    if frame.get("method").and_then(Value::as_str) != Some("setStatus") {
        return None;
    }
    let stream = frame
        .get("statusKey")
        .and_then(Value::as_str)?
        .strip_prefix(OUTPUT_KEY_PREFIX)
        .filter(|stream| !stream.is_empty())?;
    let text = frame
        .get("statusText")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())?;
    Some((stream.to_string(), text.to_string()))
}

/// Prove the exact command exists before sending slash text: an older
/// extension may provide plan mode without the newer metadata controls.
pub(super) fn catalogue_has_command(data: &Value, name: &str) -> bool {
    data.get("commands")
        .and_then(Value::as_array)
        .is_some_and(|commands| {
            commands.iter().any(|command| {
                command
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|command| command.trim_start_matches('/'))
                    == Some(name)
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "omp-pulse-child-ext-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn materialize_prunes_only_stale_managed_versions_and_refreshes_current() {
        let state = scratch("mat");
        let dir = state.join(DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let two_hours_ago = SystemTime::now() - 2 * PRUNE_AFTER;
        let age = |path: &Path, at: SystemTime| {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(at)
                .unwrap();
        };
        let stale = dir.join(format!("{FILE_PREFIX}0000000000000000.ts"));
        std::fs::write(&stale, "old").unwrap();
        age(&stale, two_hours_ago);
        // Another daemon build sharing the state dir, its child still booting.
        let sibling = dir.join(format!("{FILE_PREFIX}1111111111111111.ts"));
        std::fs::write(&sibling, "sibling").unwrap();
        let unrelated = dir.join("notes.txt");
        std::fs::write(&unrelated, "keep").unwrap();
        age(&unrelated, two_hours_ago);

        let first = materialize(&state).expect("written");
        assert!(!stale.exists(), "a long-untouched version is removed");
        assert!(sibling.exists(), "a recently used version stays");
        assert!(unrelated.exists(), "files that are not ours stay");

        // Our own copy is refreshed in place, never rewritten, so a sibling
        // daemon's prune never sees it as stale while we spawn children.
        age(&first, two_hours_ago);
        let second = materialize(&state).expect("still there");
        assert!(
            std::fs::metadata(&second).unwrap().modified().unwrap() > two_hours_ago,
            "touched"
        );

        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn materialize_failure_lets_the_child_boot_without_it() {
        let state = scratch("blocked");
        std::fs::create_dir_all(state.parent().unwrap()).unwrap();
        // A FILE where the directory should be: create_dir_all fails.
        std::fs::write(&state, "not a directory").unwrap();
        assert_eq!(materialize(&state), None);
        let _ = std::fs::remove_file(&state);
    }

    #[test]
    fn replies_are_recognised_only_on_our_status_keys() {
        let frame = json!({
            "type": "extension_ui_request", "id": "1", "method": "setStatus",
            "statusKey": "omp-pulse:x7", "statusText": "{\"ok\":true,\"enabled\":true}",
        });
        assert_eq!(
            parse_reply(&frame),
            Some(("x7".to_string(), json!({"ok": true, "enabled": true})))
        );
        let other = json!({"method": "setStatus", "statusKey": "git", "statusText": "main"});
        assert_eq!(parse_reply(&other), None);
        let notify = json!({"method": "notify", "statusKey": "omp-pulse:x7"});
        assert_eq!(parse_reply(&notify), None);
        let garbled =
            json!({"method": "setStatus", "statusKey": "omp-pulse:x8", "statusText": "nope"});
        let (id, reply) = parse_reply(&garbled).unwrap();
        assert_eq!(id, "x8");
        assert_eq!(reply["ok"], false);
    }

    #[test]
    fn live_output_is_recognised_only_on_its_own_keys() {
        let frame = json!({
            "type": "extension_ui_request", "id": "2", "method": "setStatus",
            "statusKey": "omp-pulse-out:run-1", "statusText": "line 1\nline 2\n",
        });
        assert_eq!(
            parse_output(&frame),
            Some(("run-1".to_string(), "line 1\nline 2\n".to_string()))
        );
        // Output never settles the request, and a reply is never output.
        assert_eq!(parse_reply(&frame), None);
        let reply = json!({"method": "setStatus", "statusKey": "omp-pulse:x7", "statusText": "{}"});
        assert_eq!(parse_output(&reply), None);
        let empty =
            json!({"method": "setStatus", "statusKey": "omp-pulse-out:run-1", "statusText": ""});
        assert_eq!(parse_output(&empty), None);
        let cleared = json!({"method": "setStatus", "statusKey": "omp-pulse-out:run-1"});
        assert_eq!(parse_output(&cleared), None);
        let unnamed =
            json!({"method": "setStatus", "statusKey": "omp-pulse-out:", "statusText": "x"});
        assert_eq!(parse_output(&unnamed), None);
        let notify =
            json!({"method": "notify", "statusKey": "omp-pulse-out:run-1", "statusText": "x"});
        assert_eq!(parse_output(&notify), None);
    }

    #[test]
    fn command_text_and_probe_round_trip() {
        assert_eq!(
            command_text("pulse-goto", "x3", &json!({"entryId": "ab"})),
            "/pulse-goto x3 {\"entryId\":\"ab\"}"
        );
        assert!(catalogue_has_command(
            &json!({"commands": [{"name": "compact"}, {"name": "pulse-plan"}]}),
            "pulse-plan"
        ));
        assert!(catalogue_has_command(
            &json!({"commands": [{"name": "/pulse-prompt-config"}]}),
            "pulse-prompt-config"
        ));
        for command in ["pulse-prompt-config", "pulse-model-mention-choices"] {
            assert!(
                !catalogue_has_command(&json!({"commands": [{"name": "pulse-plan"}]}), command),
                "an older extension must not send {command} to the model"
            );
            assert!(!catalogue_has_command(&json!({}), command));
        }
    }
}
