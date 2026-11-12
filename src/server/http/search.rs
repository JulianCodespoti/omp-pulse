//! `/api/search`: bounded full-text search over the newest session files.

use super::*;
use crate::sessions::jsonl;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Response,
};
use serde_json::{Value, json};
use std::io::Read as _;
use std::{collections::HashMap, io::Seek, sync::Arc};

/// Search caps (contract 9): the work is bounded so one phone query never
/// walks the whole store (~3365 session files, 3.2 GB on this machine).
/// Files scanned: the newest `SEARCH_MAX_FILES` sessions only. Bytes per
/// file: only the newest `SEARCH_TAIL_BYTES` of each file (the whole file
/// when smaller) — old content in a >1 MiB session is deliberately outside
/// the window; newest-first iteration makes that the least-relevant content.
/// `limit` defaults to 50 and caps at 200.
const SEARCH_DEFAULT_LIMIT: usize = 50;
const SEARCH_MAX_LIMIT: usize = 200;
const SEARCH_MAX_FILES: usize = 200;
/// 512 KiB per file ≈ the last ~10k words of a session. Measured on this
/// machine (874 listed sessions, 3.2 GB store): worst-case zero-hit search
/// over 200 files costs ~1 s (see the `bench_search_real_store` numbers in
/// the report); a typical hit in the newest sessions costs tens of ms.
const SEARCH_TAIL_BYTES: u64 = 512 * 1024;
/// Matching text is truncated to at most this many chars (the contract's
/// `<=200`); an ellipsis signals truncation, so a real truncation yields
/// 198 chars and an untouched short message stays verbatim.
const SEARCH_LINE_MAX: usize = 200;

/// Full-text search across session JSONL files: case-insensitive substring
/// match on user/assistant message text only (tool entries and non-text
/// content blocks are skipped as noise), newest sessions and newest lines
/// first, stopping as soon as `limit` hits are found. A hit is
/// `{path, title, line, role, offset}` with `line` ≤ 200 chars and `offset`
/// the byte offset of the matching message's line in the file. The reply
/// also carries `scannedFiles` and `truncated` ([`search_truncated`]).
pub(super) async fn search(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Some(needle) = q
        .get("q")
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
    else {
        return err_status(StatusCode::BAD_REQUEST, "q required");
    };
    let limit = q
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
        .clamp(1, SEARCH_MAX_LIMIT);

    // The scan reads up to SEARCH_MAX_FILES transcript tails (~1 s worst case
    // measured on the desktop, slower under proot). On a runtime worker — the
    // phone has two — it stalled every socket and request scheduled there for
    // the whole scan, once per keystroke-debounced query. Same blocking-pool
    // rule as history reads (`off_runtime`).
    let sessions_root = state.cfg.sessions_root.clone();
    let project = q.get("project").filter(|value| !value.is_empty()).cloned();
    let Some((hits, scanned, truncated)) = off_runtime(move || {
        let mut hits: Vec<Value> = Vec::new();
        let mut sessions = jsonl::list_sessions(&sessions_root);
        if let Some(cwd) = project {
            sessions.retain(|session| session.cwd == cwd);
        }
        let total = sessions.len();
        let mut scanned = 0usize;
        let mut window_cut = false;
        // The file bound belongs on the iterator, not on a hand-rolled counter: this is
        // a scan over every session on disk (~3365 here), so it must stop early on both
        // axes — enough hits, or enough files looked at.
        for session in sessions.into_iter().take(SEARCH_MAX_FILES) {
            if hits.len() >= limit {
                break;
            }
            let remaining = limit - hits.len();
            let (_, cut) =
                search_file(&session.path, &session.title, &needle, &mut hits, remaining);
            window_cut |= cut;
            scanned += 1;
        }
        let truncated = search_truncated(hits.len() >= limit, total, scanned, window_cut);
        (hits, scanned, truncated)
    })
    .await
    else {
        return err_status(StatusCode::INTERNAL_SERVER_ERROR, "search failed");
    };
    ok(json!({ "ok": true, "hits": hits, "scannedFiles": scanned, "truncated": truncated }))
}

/// Whether the search caps, not the absence of matches, ended the scan: some
/// sessions were never opened, or a scanned one had older text outside its
/// tail window. "No messages match" alone then claimed older discussions do
/// not exist. A full result (`limit` hits) is complete as asked, so it is
/// never reported truncated.
fn search_truncated(full: bool, total: usize, scanned: usize, window_cut: bool) -> bool {
    !full && (scanned < total || window_cut)
}

/// Scan one session file's newest `SEARCH_TAIL_BYTES` (the whole file when
/// smaller) newest line first — the same windowed-tail reader pattern as
/// `jsonl::last_snippet`, not a new file reader. Pushes up to `budget` hits;
/// returns how many bytes were actually read from the file (bounded by the
/// cap, never more) and whether older content lay outside that window.
fn search_file(
    path: &str,
    title: &str,
    needle: &str,
    hits: &mut Vec<Value>,
    budget: usize,
) -> (u64, bool) {
    if budget == 0 {
        return (0, false);
    }
    let Ok(mut f) = std::fs::File::open(path) else {
        return (0, false);
    };
    let Ok(size) = f.metadata().map(|m| m.len()) else {
        return (0, false);
    };
    let start = size.saturating_sub(SEARCH_TAIL_BYTES);
    if f.seek(std::io::SeekFrom::Start(start)).is_err() {
        return (0, false);
    }
    let mut buf: Vec<u8> = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return (0, false);
    }
    let mut found = 0usize;
    // Byte offsets are ABSOLUTE file offsets, so `offset` is an anchor the
    // client can hand back to the paging endpoints. The first segment is a
    // torn line when the window starts mid-file; skip it, exactly like
    // `jsonl::last_snippet`'s `lo` handling.
    let segments: Vec<&[u8]> = buf.split(|&b| b == b'\n').collect();
    // The first segment is a torn line when the window starts mid-file and is
    // excluded from matching (mirrors `jsonl::last_snippet`'s `lo` handling);
    // its bytes still count toward `start` offsets.
    let lo = if start > 0 { 1 } else { 0 };
    let mut starts: Vec<u64> = Vec::with_capacity(segments.len());
    let mut offset: u64 = start;
    for (i, seg) in segments.iter().enumerate() {
        starts.push(offset);
        // Every segment but a possible final newline-less one is followed by
        // its newline byte; account for it so offsets stay exact.
        offset += seg.len() as u64 + u64::from(i + 1 < segments.len());
    }
    // Newest line first within the file (the bottom of the file is the newest
    // content), so combined with the outer newest-session-first iteration the
    // hits arrive in global newest-first order.
    for i in (lo..segments.len()).rev() {
        let line = segments[i];
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(obj) = v.as_object() else { continue };
        if obj.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let Some(msg) = obj.get("message").and_then(|m| m.as_object()) else {
            continue;
        };
        let Some(role) = msg.get("role").and_then(|r| r.as_str()) else {
            continue;
        };
        // Tool entries and tool-call/thinking-only messages are noise: search
        // only what a human actually read or wrote.
        if role != "user" && role != "assistant" {
            continue;
        }
        let Some(text) = message_text(msg.get("content")) else {
            continue;
        };
        if !text.to_lowercase().contains(needle) {
            continue;
        }
        let mut hit = json!({
            "path": path,
            "title": title,
            "line": truncate_search_line(&text),
            "role": role,
            "offset": starts[i],
        });
        // The entry's own id lets the phone open the chat AT this message.
        if let Some(id) = obj.get("id").and_then(Value::as_str) {
            hit["entryId"] = json!(id);
        }
        hits.push(hit);
        found += 1;
        if found >= budget {
            break;
        }
    }
    (buf.len() as u64, start > 0)
}

/// Concatenate textual content from a message `content` value: the `text`
/// field of each `type:"text"` block, or the whole string when content is a
/// plain string. None when there is no textual content (image-only,
/// tool-only, thinking-only messages), mirroring `jsonl`'s snippet extractor.
fn message_text(content: Option<&Value>) -> Option<String> {
    let mut out = String::new();
    match content {
        Some(Value::Array(blocks)) => {
            for b in blocks {
                let Some(o) = b.as_object() else { continue };
                if o.get("type").and_then(|t| t.as_str()) != Some("text") {
                    continue;
                }
                if let Some(t) = o.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                    out.push(' ');
                }
            }
        }
        Some(Value::String(s)) => out.push_str(s),
        _ => return None,
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Render a matching message as one searchable line: whitespace collapsed,
/// then truncated to `SEARCH_LINE_MAX` chars on a UTF-8 boundary, with an
/// ellipsis appended only when truncation actually happened (≤ 200 chars).
/// A separator space is deferred until the next non-space char, so runs of
/// whitespace AND leading/trailing whitespace collapse away. Chars are
/// counted as we push (never re-counted), so this is O(n).
fn truncate_search_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len().min(SEARCH_LINE_MAX * 4));
    let mut pending_space = false;
    let mut chars = 0usize;
    for ch in text.chars() {
        if ch.is_whitespace() {
            // A separator belongs between words; a pending one is dropped if
            // the text ends here (or the next char is more whitespace).
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            if chars >= SEARCH_LINE_MAX - 3 {
                out.push('…');
                return out;
            }
            out.push(' ');
            chars += 1;
            pending_space = false;
        }
        if chars >= SEARCH_LINE_MAX - 3 {
            out.push('…');
            return out;
        }
        out.push(ch);
        chars += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_skips_tool_noise_and_matches_case_insensitively() {
        // A scratch session file mixing noise (tool entries, tool-role
        // messages, unparseable lines) with real user/assistant text: only the
        // human messages match, case-insensitively, newest line first, with
        // absolute byte offsets.
        let dir = crate::paths::testenv::scratch("search-noise");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("search-session.jsonl");
        let lines = [
            r#"{"type":"session","session":{"id":"s1","title":"demo","cwd":"/tmp"}}"#,
            r#"{"type":"tool","tool":"bash","input":{"command":"grep FOO"}}"#,
            r#"{"type":"message","message":{"role":"tool","content":"tool result FOO"}}"#,
            r#"{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"Where is foo?"}]}}"#,
            r#"{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"Foo lives in bar."},{"type":"toolCall","id":"t1","name":"read"}]}}"#,
            r#"{"type":"message","message":{"role":"assistant","content":"plain FOO tail"}}"#,
        ];
        let joined = lines.join("\n") + "\n";
        std::fs::write(&path, &joined).unwrap();
        let mut hits = Vec::new();
        let (bytes, cut) = search_file(&path.to_string_lossy(), "demo", "foo", &mut hits, 10);
        assert_eq!(bytes as usize, joined.len(), "whole file read");
        assert!(!cut, "a file inside the window is searched whole");
        assert_eq!(
            hits.len(),
            3,
            "tool entries and tool-role messages are noise"
        );
        // Newest first within the file (the bottom of the file is newest).
        assert_eq!(hits[0]["role"], "assistant");
        assert!(hits[0]["line"].as_str().unwrap().contains("plain FOO tail"));
        assert_eq!(hits[1]["role"], "assistant");
        assert_eq!(hits[2]["role"], "user");
        // Offsets point at the matching message LINE's first byte (not the
        // substring's position inside it).
        let line_offsets: Vec<u64> = {
            let mut v = Vec::new();
            let mut o = 0u64;
            for l in joined.split_inclusive('\n') {
                v.push(o);
                o += l.len() as u64;
            }
            v
        };
        assert_eq!(hits[0]["offset"].as_u64(), Some(line_offsets[5])); // plain FOO tail
        assert_eq!(hits[1]["offset"].as_u64(), Some(line_offsets[4])); // Foo lives in bar
        assert_eq!(hits[2]["offset"].as_u64(), Some(line_offsets[3])); // Where is foo
        // The needle's case in the file does not matter.
        assert!(hits[2]["line"].as_str().unwrap().contains("Where is foo?"));
        // Each hit names its entry, so the chat can open at that message; an
        // entry without an id simply has none.
        assert_eq!(hits[2]["entryId"], "u1");
        assert_eq!(hits[1]["entryId"], "a1");
        assert!(hits[0].get("entryId").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_honors_budget_and_no_match() {
        let dir = crate::paths::testenv::scratch("search-budget");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("search-budget.jsonl");
        let lines = [
            r#"{"type":"message","message":{"role":"user","content":"alpha needle one"}}"#,
            r#"{"type":"message","message":{"role":"user","content":"alpha needle two"}}"#,
            r#"{"type":"message","message":{"role":"user","content":"alpha needle three"}}"#,
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let mut hits = Vec::new();
        search_file(&path.to_string_lossy(), "b", "needle", &mut hits, 2);
        assert_eq!(hits.len(), 2, "budget caps hits");
        assert!(hits[0]["line"].as_str().unwrap().contains("three"));
        assert!(hits[1]["line"].as_str().unwrap().contains("two"));
        let mut none = Vec::new();
        search_file(&path.to_string_lossy(), "b", "absent", &mut none, 10);
        assert!(none.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_reports_text_outside_the_tail_window() {
        let dir = crate::paths::testenv::scratch("search-window");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("search-window.jsonl");
        let old = r#"{"type":"message","message":{"role":"user","content":"ancient needle"}}"#;
        let filler = format!(
            r#"{{"type":"message","message":{{"role":"user","content":"{}"}}}}"#,
            "x".repeat(SEARCH_TAIL_BYTES as usize)
        );
        let recent = r#"{"type":"message","message":{"role":"user","content":"recent needle"}}"#;
        std::fs::write(&path, format!("{old}\n{filler}\n{recent}\n")).unwrap();
        let mut hits = Vec::new();
        let (bytes, cut) = search_file(&path.to_string_lossy(), "w", "needle", &mut hits, 10);
        assert_eq!(bytes, SEARCH_TAIL_BYTES);
        assert!(cut, "the oldest text lay outside the window");
        assert_eq!(
            hits.len(),
            1,
            "only the recent message is inside the window"
        );
        assert!(hits[0]["line"].as_str().unwrap().contains("recent"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_is_truncated_only_when_a_cap_hid_sessions_or_text() {
        // Every session scanned whole: an empty result is the truth.
        assert!(!search_truncated(false, 12, 12, false));
        // The file cap left older sessions unopened.
        assert!(search_truncated(false, 3365, SEARCH_MAX_FILES, false));
        // A scanned session had older text outside its tail window.
        assert!(search_truncated(false, 12, 12, true));
        // A full page of hits is complete as asked, whatever was left.
        assert!(!search_truncated(true, 3365, 40, true));
    }

    #[test]
    fn search_line_truncates_at_200_chars_with_ellipsis() {
        let long = "word ".repeat(80); // 400 chars
        let line = truncate_search_line(&long);
        assert!(line.chars().count() <= SEARCH_LINE_MAX);
        assert!(line.ends_with('…'), "truncation is signalled");
        // Short text stays verbatim (no ellipsis).
        assert_eq!(truncate_search_line("short"), "short");
    }

    #[test]
    fn search_line_collapses_whitespace() {
        assert_eq!(truncate_search_line("a\n\tb   c"), "a b c");
        assert_eq!(
            truncate_search_line("  leading and trailing  "),
            "leading and trailing"
        );
    }

    #[test]
    fn message_text_takes_text_blocks_only() {
        let v: Value = serde_json::from_str(
            r#"{"content":[{"type":"text","text":"hello"},{"type":"toolCall","id":"x"},{"type":"text","text":"world"}]}"#,
        )
        .unwrap();
        assert_eq!(message_text(v.get("content")).unwrap(), "hello world ");
        let s: Value = serde_json::from_str(r#"{"content":"plain"}"#).unwrap();
        assert_eq!(message_text(s.get("content")).unwrap(), "plain");
        let none: Value =
            serde_json::from_str(r#"{"content":[{"type":"toolCall","id":"x"}]}"#).unwrap();
        assert!(message_text(none.get("content")).is_none());
    }
}
