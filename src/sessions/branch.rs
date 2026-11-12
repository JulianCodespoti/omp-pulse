//! Branching a conversation from its session file alone.
//!
//! "Rewind to here and send something else" is a new session holding the
//! path from the root to just before the chosen user message. omp builds it
//! with `SessionManager.createBranchedSession`, but reaching that needs an RPC
//! child on the SOURCE session, and the daemon refuses a child whenever the
//! desktop omp owns the file (a second writer would corrupt it). So rewinding
//! any conversation open on the laptop, which is most of them, failed with
//! "open in the desktop app". Branching never writes to the source, so it
//! needs no writer at all: this module reads the source and writes the new
//! file, in the same layout omp's `createBranchedSession` produces.
//!
//! `/fork` of a session the phone does not write (`fork_whole`) is the same
//! idea for omp's whole-session `SessionManager.fork`: a copy of every entry
//! under a new identity, the source untouched.
//!
//! Serving BOTH halves (`get_branch_messages` and `branch`) from the file also
//! keeps one id space. omp re-mints entry ids when it loads a session, so ids
//! read from a child could not be matched against the file and vice versa.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::{RngExt, rng};
use serde_json::{Map, Value, json};

/// A user message on the current branch: what the phone offers to rewind to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchMessage {
    pub entry_id: String,
    pub text: String,
}

/// The session a rewind created, and the text of the message rewound to (the
/// editor restores it for amending, exactly like omp's `selectedText`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fork {
    pub path: PathBuf,
    pub text: String,
}

struct Entry<'a> {
    id: String,
    parent: Option<String>,
    value: Value,
    raw: &'a str,
}

struct Parsed<'a> {
    title_slot: Option<&'a str>,
    header: Option<Value>,
    entries: Vec<Entry<'a>>,
    by_id: HashMap<String, usize>,
}

fn parse(content: &str) -> Parsed<'_> {
    let mut out = Parsed {
        title_slot: None,
        header: None,
        entries: Vec::new(),
        by_id: HashMap::new(),
    };
    for raw in content.split('\n') {
        if raw.trim().is_empty() {
            continue;
        }
        // A torn trailing line (the owner is mid-write) is simply not part
        // of the tree yet.
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("title") if out.header.is_none() && out.entries.is_empty() => {
                out.title_slot = Some(raw);
            }
            Some("session") if out.header.is_none() => out.header = Some(value),
            _ => {
                // A pre-v2 session (header `version` below 2 or absent) has
                // no tree: omp's `migrateV1ToV2` makes every entry the child
                // of the previous one and mints fresh ids, so the file's own
                // ids (if any) are only labels here. The branch is written
                // with the source's version, so omp migrates it the same way.
                let legacy = out
                    .header
                    .as_ref()
                    .and_then(|h| h.get("version"))
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    < 2;
                let index = out.entries.len();
                let id = match value.get("id").and_then(Value::as_str) {
                    Some(id) if !out.by_id.contains_key(id) => id.to_string(),
                    Some(_) | None if legacy => format!("#{index}"),
                    _ => continue,
                };
                let parent = if legacy {
                    out.entries.last().map(|e| e.id.clone())
                } else {
                    value
                        .get("parentId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                };
                out.by_id.insert(id.clone(), index);
                out.entries.push(Entry {
                    id,
                    parent,
                    value,
                    raw,
                });
            }
        }
    }
    out
}

/// Root-to-`leaf` path as indices into `entries`, following `parentId`.
/// A dangling parent ends the walk; a cycle cannot loop forever.
fn path_to(parsed: &Parsed<'_>, leaf: Option<&str>) -> Vec<usize> {
    let mut path = Vec::new();
    let mut cursor = leaf.and_then(|id| parsed.by_id.get(id).copied());
    while let Some(i) = cursor {
        if path.len() > parsed.entries.len() {
            break;
        }
        path.push(i);
        cursor = parsed.entries[i]
            .parent
            .as_deref()
            .and_then(|p| parsed.by_id.get(p).copied());
    }
    path.reverse();
    path
}

/// The visible text of a user message entry, or None when it is not one.
fn user_text(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = value.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let content = message.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    Some(text)
}

/// User messages on the session's current branch, oldest first. Late usage
/// can preserve a different active leaf while retaining its initiating parent.
pub fn user_messages(path: &Path) -> Result<Vec<BranchMessage>, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("cannot read session: {e}"))?;
    let parsed = parse(&content);
    let legacy = parsed
        .header
        .as_ref()
        .and_then(|h| h.get("version"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
        < 2;
    let leaf = if legacy {
        // Pre-v2 entries are migrated as one linear chain; keep those synthetic
        // IDs and do not interpret a modern marker against pre-migration IDs.
        parsed.entries.last().map(|e| e.id.clone())
    } else {
        let mut leaf = crate::sessions::jsonl::ActiveLeafSelection::default();
        for entry in &parsed.entries {
            leaf.observe(&entry.id, &entry.value);
        }
        leaf.resolve(|id| {
            parsed.by_id.get(id).is_some_and(|&i| {
                !matches!(
                    parsed.entries[i].value.get("type").and_then(Value::as_str),
                    Some("session" | "title")
                )
            })
        })
    };
    Ok(path_to(&parsed, leaf.as_deref())
        .into_iter()
        .filter_map(|i| {
            let entry = &parsed.entries[i];
            user_text(&entry.value).map(|text| BranchMessage {
                entry_id: entry.id.clone(),
                text,
            })
        })
        .collect())
}

/// Write a new session holding everything before user message `entry_id`, in
/// the source's directory, and return its path. The source is only read.
pub fn fork_before(path: &Path, entry_id: &str) -> Result<Fork, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("cannot read session: {e}"))?;
    let parsed = parse(&content);
    let Some(&index) = parsed.by_id.get(entry_id) else {
        return Err("Invalid entry ID for branching".into());
    };
    let selected = &parsed.entries[index];
    let Some(text) = user_text(&selected.value) else {
        return Err("Invalid entry ID for branching".into());
    };
    let source_header = parsed.header.as_ref().ok_or("session has no header")?;
    let dir = path.parent().ok_or("session has no directory")?;
    let (timestamp, id) = new_identity();

    // The header omp's createBranchedSession writes: identity is new, the
    // working context is inherited, and `parentSession` records lineage.
    let mut header = inherited_header(source_header, &timestamp, &id);
    header.insert("parentSession".into(), json!(path.to_string_lossy()));

    let mut body = String::new();
    // The fixed-width title slot is already valid for the same title; copied
    // verbatim it keeps the listing's title until omp rewrites the slot.
    if let Some(slot) = parsed.title_slot {
        body.push_str(slot);
        body.push('\n');
    }
    body.push_str(&Value::Object(header).to_string());
    body.push('\n');
    append_branch_path(&mut body, &parsed, selected.parent.as_deref());

    let file = create_session_file(dir, &timestamp, &id, &body, "branch")?;
    Ok(Fork { path: file, text })
}

/// omp's whole-session `/fork` (`SessionManager.fork`) for a session the
/// daemon must not write: a new session in the source's directory holding
/// EVERY entry of the source (all branches, labels and the active-leaf
/// markers, so the copy resumes exactly where the source is), plus a copy of
/// the source's artifact directory, as `copySessionArtifacts` does, because
/// kept tool results may cite `artifact://N`. Returns the new file. The source
/// is only read; a torn trailing line (the owner mid-write) is left out.
pub fn fork_whole(path: &Path) -> Result<PathBuf, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("cannot read session: {e}"))?;
    let parsed = parse(&content);
    let source_header = parsed.header.as_ref().ok_or("session has no header")?;
    let dir = path.parent().ok_or("session has no directory")?;
    let (timestamp, id) = new_identity();

    // `SessionManager.fork`'s header: lineage is the parent's session id and
    // the provider prompt-cache key carries over, so the copy keeps hitting
    // the parent's cache.
    let mut header = inherited_header(source_header, &timestamp, &id);
    let source_id = source_header.get("id").and_then(Value::as_str);
    let parent = source_id.map_or_else(|| path.to_string_lossy().into_owned(), str::to_string);
    header.insert("parentSession".into(), json!(parent));
    if let Some(key) = source_header
        .get("providerPromptCacheKey")
        .filter(|v| !v.is_null())
        .cloned()
        .or_else(|| source_id.map(|id| json!(id)))
    {
        header.insert("providerPromptCacheKey".into(), key);
    }
    let header = Value::Object(header).to_string();

    let mut body = String::with_capacity(content.len() + header.len());
    let mut header_written = false;
    for raw in content.split('\n') {
        if raw.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        if !header_written && value.get("type").and_then(Value::as_str) == Some("session") {
            body.push_str(&header);
            header_written = true;
        } else {
            body.push_str(raw);
        }
        body.push('\n');
    }

    let file = create_session_file(dir, &timestamp, &id, &body, "fork")?;
    copy_artifacts(path, &file);
    Ok(file)
}

/// A fresh session identity: omp's ISO timestamp and UUIDv7 id, both from
/// the same instant.
fn new_identity() -> (String, String) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (iso_utc(now_ms), uuid_v7(now_ms))
}

/// The header fields every derived session shares: a new identity, the
/// source's version (entries are copied in its format, so omp migrates them
/// on load), and the inherited working context.
fn inherited_header(source_header: &Value, timestamp: &str, id: &str) -> Map<String, Value> {
    let mut header = Map::new();
    header.insert("type".into(), json!("session"));
    header.insert(
        "version".into(),
        source_header.get("version").cloned().unwrap_or(json!(3)),
    );
    header.insert("id".into(), json!(id));
    header.insert("timestamp".into(), json!(timestamp));
    for key in ["cwd", "title", "titleSource", "additionalDirectories"] {
        if let Some(v) = source_header.get(key).filter(|v| !v.is_null()) {
            header.insert(key.into(), v.clone());
        }
    }
    header
}

/// Write `body` as a brand-new session file named the way omp names its own
/// (`<file-safe timestamp>_<id>.jsonl`). Never replaces an existing file; a
/// failed write removes the partial file. `what` names it in errors.
fn create_session_file(
    dir: &Path,
    timestamp: &str,
    id: &str,
    body: &str,
    what: &str,
) -> Result<PathBuf, String> {
    let file = dir.join(format!("{}_{id}.jsonl", timestamp.replace([':', '.'], "-")));
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map_err(|e| format!("cannot create {what}: {e}"))?;
    out.write_all(body.as_bytes())
        .and_then(|()| out.sync_all())
        .map_err(|e| {
            let _ = fs::remove_file(&file);
            format!("cannot write {what}: {e}")
        })?;
    Ok(file)
}

/// omp keeps a session's artifacts in the directory named after the file
/// without `.jsonl` (`artifactsDirectoryFor`), beside the journal's REAL
/// path. Best-effort like omp's `copySessionArtifacts`: the fork stands
/// without them, so a failure is logged, never returned. Never overwrites.
fn copy_artifacts(source: &Path, destination: &Path) {
    let real = fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    let (Some(from), Some(to)) = (artifacts_dir(&real), artifacts_dir(destination)) else {
        return;
    };
    if !from.is_dir() || from == to {
        return;
    }
    if let Err(e) = copy_tree(&from, &to) {
        tracing::warn!(from = %from.display(), to = %to.display(), "fork: artifact copy failed: {e}");
    }
}

fn artifacts_dir(session_file: &Path) -> Option<PathBuf> {
    let name = session_file.file_name()?.to_str()?;
    let stem = name.strip_suffix(".jsonl")?;
    Some(session_file.with_file_name(stem))
}

/// Recursive copy that keeps files already present at the destination. A
/// symlink is followed only when it points at a file: a linked directory
/// could loop.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if (kind.is_file() || entry.path().is_file()) && !target.exists() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Copy the selected path, resolving current labels across the whole journal.
/// Label receipts on the old path are discarded; fresh receipts refer only to
/// retained points, just like native createBranchedSession. The source is read-only.
fn append_branch_path(body: &mut String, parsed: &Parsed<'_>, leaf: Option<&str>) {
    let path = path_to(parsed, leaf);
    let kept: HashSet<&str> = path
        .iter()
        .filter(|&&i| parsed.entries[i].value.get("type").and_then(Value::as_str) != Some("label"))
        .map(|&i| parsed.entries[i].id.as_str())
        .collect();
    let mut labels: HashMap<&str, &str> = HashMap::new();
    for entry in &parsed.entries {
        if entry.value.get("type").and_then(Value::as_str) != Some("label") {
            continue;
        }
        let Some(target) = entry
            .value
            .get("targetId")
            .and_then(Value::as_str)
            .filter(|id| kept.contains(id))
        else {
            continue;
        };
        match entry
            .value
            .get("label")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            Some(label) => {
                labels.insert(target, label);
            }
            None => {
                labels.remove(target);
            }
        }
    }
    let mut parent: Option<&str> = None;
    for &i in &path {
        let entry = &parsed.entries[i];
        if !kept.contains(entry.id.as_str()) {
            continue;
        }
        let strip_marker = entry.value.get("type").and_then(Value::as_str) == Some("model_usage")
            && entry.value.get("activeLeafId").is_some();
        // A skipped label may have been an intermediate parent. Never leave
        // dangling links that would make retained messages disappear on resume.
        let reparent = entry.value.get("parentId").is_some() && entry.parent.as_deref() != parent;
        if strip_marker || reparent {
            let mut copied = entry.value.clone();
            if let Some(object) = copied.as_object_mut() {
                if strip_marker {
                    object.remove("activeLeafId");
                }
                if reparent {
                    object.insert("parentId".into(), json!(parent));
                }
            }
            body.push_str(&copied.to_string());
        } else {
            body.push_str(entry.raw);
        }
        body.push('\n');
        parent = Some(&entry.id);
    }
    let mut label_parent = parent.map(str::to_owned);
    for &i in &path {
        let target = parsed.entries[i].id.as_str();
        let Some(label) = labels.get(target) else {
            continue;
        };
        let (timestamp, mut id) = new_identity();
        while parsed.by_id.contains_key(&id) {
            id = uuid_v7(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            );
        }
        body.push_str(
            &json!({
                "type": "label", "id": id, "parentId": label_parent,
                "timestamp": timestamp, "targetId": target, "label": label,
            })
            .to_string(),
        );
        body.push('\n');
        label_parent = Some(id);
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, the only timestamp shape omp writes.
fn iso_utc(ms: u64) -> String {
    let secs = ms / 1000;
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{:03}Z",
        ms % 1000
    )
}

/// RFC 9562 UUIDv7, the id shape omp mints for sessions (`Bun.randomUUIDv7`):
/// 48-bit millisecond timestamp, version 7, variant 0b10, random remainder.
fn uuid_v7(ms: u64) -> String {
    let mut b = [0u8; 16];
    rng().fill(&mut b[6..]);
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = concat!(
        r#"{"type":"title","v":1,"title":"T","source":"auto","updatedAt":"2026-09-24T06:40:29.161Z","pad":" "}"#,
        "\n",
        r#"{"type":"session","version":3,"id":"orig","timestamp":"2026-09-24T06:40:03.874Z","cwd":"/tmp/p"}"#,
        "\n",
        r#"{"type":"thinking_level_change","id":"t0","parentId":null,"thinkingLevel":"medium"}"#,
        "\n",
        r#"{"type":"message","id":"u1","parentId":"t0","message":{"role":"user","content":[{"type":"text","text":"first"}]}}"#,
        "\n",
        r#"{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"one"}]}}"#,
        "\n",
        r#"{"type":"label","id":"l1","parentId":"a1","targetId":"a1","label":"x"}"#,
        "\n",
        r#"{"type":"message","id":"u2","parentId":"l1","message":{"role":"user","content":"second"}}"#,
        "\n",
        r#"{"type":"message","id":"a2","parentId":"u2","message":{"role":"assistant","content":[]}}"#,
        "\n",
        // An abandoned branch off a1. The current branch is the one ending at
        // the newest entry (a3), so "old path" must not be offered.
        r#"{"type":"message","id":"u9","parentId":"a1","message":{"role":"user","content":"old path"}}"#,
        "\n",
        r#"{"type":"message","id":"a3","parentId":"a2","message":{"role":"assistant","content":[]}}"#,
        "\n",
        r#"{"type":"message","id":"torn""#,
    );

    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("omp-branch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("src.jsonl");
        fs::write(&file, SESSION).unwrap();
        (dir, file)
    }

    #[test]
    fn active_leaf_fork_prefix_strips_only_usage_markers_without_writing_a_fork() {
        for marker in [
            json!("a1"),
            Value::Null,
            json!("foreign"),
            json!({"bad": true}),
        ] {
            let ordinary = r#"{ "type": "message", "id": "u1", "parentId": null, "message": { "role": "user", "content": "one" }, "unknown": [1,2] }"#;
            let usage = json!({"type":"model_usage","id":"m1","parentId":"a1",
                "activeLeafId":marker,"usage":{"cost":{"total":0.3}},"futureField":{"nested":true}});
            let content = format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"s\"}}\n{ordinary}\n{{\"type\":\"message\",\"id\":\"a1\",\"parentId\":\"u1\",\"message\":{{\"role\":\"assistant\",\"content\":\"answer\"}}}}\n{usage}\n{{\"type\":\"message\",\"id\":\"selected\",\"parentId\":\"m1\",\"message\":{{\"role\":\"user\",\"content\":\"amend\"}}}}\n"
            );
            let parsed = parse(&content);
            let selected = &parsed.entries[parsed.by_id["selected"]];
            let mut output = String::new();
            append_branch_path(&mut output, &parsed, selected.parent.as_deref());
            assert_eq!(output.lines().next(), Some(ordinary));
            let values: Vec<Value> = output
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(
                values
                    .iter()
                    .map(|v| v["id"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["u1", "a1", "m1"]
            );
            let mut expected = usage.clone();
            expected.as_object_mut().unwrap().remove("activeLeafId");
            assert_eq!(values[2], expected);
            assert_eq!(
                parsed.entries[parsed.by_id["m1"]].value, usage,
                "source metadata is unchanged"
            );
            assert_eq!(selected.parent.as_deref(), Some("m1"));
        }
    }

    #[test]
    fn active_leaf_fork_prefix_preserves_ordinary_bytes_and_non_usage_marker() {
        let content = concat!(
            "{\"type\":\"session\",\"version\":3,\"id\":\"s\"}\n",
            "{ \"type\": \"model_usage\", \"id\": \"m\", \"parentId\": null, \"future\": 7 }\n",
            "{ \"type\": \"custom\", \"id\": \"c\", \"parentId\": \"m\", \"activeLeafId\": null }\n",
            "{\"type\":\"label\",\"id\":\"label\",\"parentId\":\"c\"}\n"
        );
        let parsed = parse(content);
        let mut output = String::new();
        append_branch_path(&mut output, &parsed, Some("label"));
        assert_eq!(
            output,
            content
                .lines()
                .skip(1)
                .take(2)
                .map(|line| format!("{line}\n"))
                .collect::<String>()
        );
        let mut empty = String::new();
        append_branch_path(&mut empty, &parsed, None);
        assert!(empty.is_empty());
    }

    #[test]
    fn lists_user_messages_on_the_current_branch_only() {
        let (dir, file) = scratch("list");
        let msgs = user_messages(&file).unwrap();
        let texts: Vec<_> = msgs.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(
            texts,
            ["first", "second"],
            "the abandoned branch is not offered"
        );
        assert_eq!(msgs[1].entry_id, "u2");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn fork_holds_the_path_before_the_message_and_never_touches_the_source() {
        let (dir, file) = scratch("fork");
        let fork = fork_before(&file, "u2").unwrap();
        assert_eq!(fork.text, "second");
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            SESSION,
            "source is read-only"
        );
        assert_eq!(fork.path.parent(), file.parent());

        let written = fs::read_to_string(&fork.path).unwrap();
        let lines: Vec<Value> = written
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["type"], "title");
        assert_eq!(lines[1]["type"], "session");
        assert_eq!(lines[1]["cwd"], "/tmp/p");
        assert_eq!(lines[1]["parentSession"], file.to_string_lossy().as_ref());
        assert_ne!(lines[1]["id"], "orig");
        let ids: Vec<_> = lines[2..]
            .iter()
            .filter(|entry| entry["type"] != "label")
            .map(|l| l["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["t0", "u1", "a1"], "only retained conversation points");
        let labels: Vec<_> = lines
            .iter()
            .filter(|entry| entry["type"] == "label")
            .collect();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0]["targetId"], "a1");
        assert_eq!(labels[0]["label"], "x");
        assert_ne!(labels[0]["id"], "l1");
        assert_eq!(labels[0]["parentId"], "a1");
        // omp names the file after the header's own timestamp and id.
        let name = fork
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let id = lines[1]["id"].as_str().unwrap();
        assert!(name.ends_with(&format!("_{id}.jsonl")), "{name}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn timeline_row_ids_select_repeated_text_and_inactive_turns_exactly() {
        let (dir, file) = scratch("timeline-entry-id");
        let source = SESSION
            .replace("\"first\"", "\"continue\"")
            .replace("\"second\"", "\"continue\"")
            .replace("\"old path\"", "\"continue\"");
        fs::write(&file, &source).unwrap();
        let rows = crate::sessions::jsonl::read_tree(&file);
        for target in ["u2", "u9"] {
            let row = rows.iter().find(|row| row.id == target).unwrap();
            assert_eq!(row.text, "continue");
            let fork = fork_before(&file, &row.id).unwrap();
            assert_eq!(fork.text, "continue");
            let written = fs::read_to_string(&fork.path).unwrap();
            let lines: Vec<Value> = written
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            let ids: Vec<_> = lines[2..]
                .iter()
                .filter(|entry| entry["type"] != "label")
                .map(|line| line["id"].as_str().unwrap())
                .collect();
            assert_eq!(ids, ["t0", "u1", "a1"]);
            assert_eq!(fs::read_to_string(&file).unwrap(), source);
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rewind_carries_only_current_retained_labels_and_repairs_skipped_label_parents() {
        let (dir, file) = scratch("labels");
        let source = [
            SESSION,
            "\n",
            "{\"type\":\"label\",\"id\":\"late1\",\"parentId\":\"a3\",\"targetId\":\"u1\",\"label\":\"renamed on another branch\"}\n",
            "{\"type\":\"label\",\"id\":\"late2\",\"parentId\":\"late1\",\"targetId\":\"a1\",\"label\":\"changed\"}\n",
            "{\"type\":\"label\",\"id\":\"late3\",\"parentId\":\"late2\",\"targetId\":\"a1\"}\n",
            "{\"type\":\"label\",\"id\":\"late4\",\"parentId\":\"late3\",\"targetId\":\"u9\",\"label\":\"discard me\"}\n",
            "{\"type\":\"label\",\"id\":\"late5\",\"parentId\":\"late4\",\"targetId\":\"u2\",\"label\":\"retain intermediate point\"}\n",
            "{\"type\":\"message\",\"id\":\"u4\",\"parentId\":\"a2\",\"message\":{\"role\":\"user\",\"content\":\"rewind here\"}}\n",
        ].concat();
        fs::write(&file, &source).unwrap();
        let fork = fork_before(&file, "u4").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), source);
        let written = fs::read_to_string(&fork.path).unwrap();
        let parsed = parse(&written);
        let labels: Vec<_> = parsed
            .entries
            .iter()
            .filter(|entry| entry.value["type"] == "label")
            .collect();
        assert_eq!(labels.len(), 2);
        assert!(labels.iter().any(|entry| entry.value["targetId"] == "u1"
            && entry.value["label"] == "renamed on another branch"));
        assert!(labels.iter().any(|entry| entry.value["targetId"] == "u2"
            && entry.value["label"] == "retain intermediate point"));
        assert_eq!(
            parsed.entries[parsed.by_id["u2"]].parent.as_deref(),
            Some("a1")
        );
        assert!(parsed.entries.iter().all(|entry| {
            entry
                .parent
                .as_ref()
                .is_none_or(|parent| parsed.by_id.contains_key(parent))
        }));
        assert_eq!(
            user_messages(&fork.path)
                .unwrap()
                .iter()
                .map(|row| row.entry_id.as_str())
                .collect::<Vec<_>>(),
            ["u1", "u2"]
        );
        assert!(
            parsed
                .entries
                .iter()
                .all(|entry| entry.id != "l1" && entry.id != "u9" && entry.id != "u4")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_sessions_without_parent_ids_branch_as_a_linear_chain() {
        // The pre-v2 shape: no header version, no parentId anywhere.
        let dir = std::env::temp_dir().join(format!("omp-branch-legacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("old.jsonl");
        fs::write(
            &file,
            concat!(
                r#"{"id":"s","type":"session","cwd":"/tmp"}"#, "\n",
                r#"{"id":"u1","type":"message","message":{"role":"user","content":[{"type":"text","text":"one"}]}}"#, "\n",
                r#"{"id":"a1","type":"message","message":{"role":"assistant","content":[]}}"#, "\n",
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"two"}]}}"#, "\n",
                r#"{"id":"a2","type":"message","message":{"role":"assistant","content":[]}}"#, "\n",
            ),
        )
        .unwrap();
        let msgs = user_messages(&file).unwrap();
        let texts: Vec<_> = msgs.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["one", "two"]);
        let fork = fork_before(&file, &msgs[1].entry_id).unwrap();
        assert_eq!(fork.text, "two");
        let written = fs::read_to_string(&fork.path).unwrap();
        assert_eq!(
            written.lines().count(),
            3,
            "header + one + its answer:\n{written}"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rewinding_the_first_message_leaves_only_the_header_chain_before_it() {
        let (dir, file) = scratch("first");
        let fork = fork_before(&file, "u1").unwrap();
        let written = fs::read_to_string(&fork.path).unwrap();
        let ids: Vec<String> = written
            .lines()
            .skip(2)
            .map(|l| {
                serde_json::from_str::<Value>(l).unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(ids, ["t0"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_ids_that_are_not_user_messages() {
        let (dir, file) = scratch("refuse");
        assert!(fork_before(&file, "a1").is_err());
        assert!(fork_before(&file, "nope").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn whole_fork_copies_every_entry_and_artifact_and_never_touches_the_source() {
        let (dir, file) = scratch("whole");
        let artifacts = dir.join("src");
        fs::create_dir_all(artifacts.join("sub")).unwrap();
        fs::write(artifacts.join("1.log"), "one").unwrap();
        fs::write(artifacts.join("sub").join("2.log"), "two").unwrap();

        let fork = fork_whole(&file).unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            SESSION,
            "source is read-only"
        );
        assert_eq!(fork.parent(), file.parent());

        let written = fs::read_to_string(&fork).unwrap();
        let lines: Vec<Value> = written
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        // The title slot rides along byte for byte.
        assert_eq!(written.lines().next(), SESSION.lines().next());
        let header = &lines[1];
        assert_eq!(header["type"], "session");
        assert_eq!(header["version"], 3);
        assert_eq!(header["cwd"], "/tmp/p");
        assert_ne!(header["id"], "orig");
        // SessionManager.fork: lineage by id, prompt-cache key inherited.
        assert_eq!(header["parentSession"], "orig");
        assert_eq!(header["providerPromptCacheKey"], "orig");
        let id = header["id"].as_str().unwrap();
        let name = fork.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.ends_with(&format!("_{id}.jsonl")), "{name}");

        // Every entry, every branch and the label, verbatim; the torn line
        // is not part of the session yet.
        let source_entries: Vec<&str> = SESSION.lines().skip(2).collect();
        let copied_entries: Vec<&str> = written.lines().skip(2).collect();
        assert_eq!(copied_entries, source_entries[..source_entries.len() - 1]);
        assert_eq!(
            user_messages(&fork).unwrap(),
            user_messages(&file).unwrap(),
            "the copy resumes on the source's active branch"
        );

        let copied = dir.join(name.strip_suffix(".jsonl").unwrap());
        assert_eq!(fs::read_to_string(copied.join("1.log")).unwrap(), "one");
        assert_eq!(
            fs::read_to_string(copied.join("sub").join("2.log")).unwrap(),
            "two"
        );
        assert_eq!(fs::read_to_string(artifacts.join("1.log")).unwrap(), "one");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn whole_fork_keeps_an_existing_cache_key_and_refuses_a_headerless_file() {
        let (dir, file) = scratch("whole-key");
        fs::write(
            &file,
            SESSION.replace(
                "\"cwd\":\"/tmp/p\"",
                "\"cwd\":\"/tmp/p\",\"providerPromptCacheKey\":\"k\"",
            ),
        )
        .unwrap();
        let fork = fork_whole(&file).unwrap();
        let header: Value =
            serde_json::from_str(fs::read_to_string(&fork).unwrap().lines().nth(1).unwrap())
                .unwrap();
        assert_eq!(header["providerPromptCacheKey"], "k");
        assert_eq!(header["parentSession"], "orig");

        let bare = dir.join("bare.jsonl");
        fs::write(&bare, "{\"type\":\"message\",\"id\":\"x\"}\n").unwrap();
        assert!(fork_whole(&bare).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_and_timestamps_have_omps_shapes() {
        assert_eq!(iso_utc(1_790_211_600_123), "2026-09-24T01:00:00.123Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
        let id = uuid_v7(1_790_211_600_123);
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "7");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert!(
            id.starts_with("01a0"),
            "timestamp-ordered like omp's ids: {id}"
        );
    }
}
