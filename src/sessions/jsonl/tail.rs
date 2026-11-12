//! Tail reads: the last snippet, metadata, model, turn outcome and pending `ask`,
//! found by paging backward from the end of a session file.

use super::*;
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Tail bytes examined by `last_snippet` for the newest chat message.
const SNIPPET_WINDOW: u64 = 64 * 1024;
/// Max snippet text length before the ellipsis is appended.
const SNIPPET_MAX: usize = 160;
/// Newest entry satisfying `accept`, paging backward through `read_backward`
/// instead of a fixed byte window. A fixed 64 KiB tail read goes blind
/// whenever giant single lines (tool dumps, compaction records — tens of KB
/// each, routine in coding sessions) fill the window: real conversations
/// then reported no snippet/model and the phone rendered them as "No message
/// yet". Paging by entries bounds the scan (16 pages of 32 = 512 newest
/// entries) while capturing arbitrarily large lines whole; tool-heavy tails
/// measured 386 deep in the wild.
fn newest_matching(
    path: &Path,
    mut accept: impl FnMut(&serde_json::Map<String, Value>) -> bool,
) -> Option<Value> {
    const PAGE: usize = 32;
    const MAX_PAGES: usize = 16;
    let mut before: Option<u64> = None;
    for _ in 0..MAX_PAGES {
        let page = read_backward(path, before, PAGE);
        if page.entries.is_empty() {
            return None;
        }
        for entry in page.entries.into_iter().rev() {
            if let Some(obj) = entry.as_object()
                && accept(obj)
            {
                return Some(entry);
            }
        }
        before = Some(page.next_before?);
    }
    None
}
/// Newest chat-message snippet for the session-list inbox: scans entries
/// newest→oldest for the first entry with `type:"message"` whose
/// `message.role` is "user" or "assistant", and returns the concatenated
/// `type:"text"` content as a trimmed, whitespace-collapsed string capped at
/// 160 chars (ellipsis appended on truncation). Messages whose extracted text
/// is empty (image-only, tool-only, thinking-only) are skipped in favour of
/// older ones. Missing or unreadable files, and sessions with no matching
/// message in the bounded scan, yield None — never an error or panic.
pub fn last_snippet(path: &Path) -> Option<Snippet> {
    let hit = newest_matching(path, |obj| {
        if obj.get("type").and_then(|t| t.as_str()) != Some("message") {
            return false;
        }
        let Some(msg) = obj.get("message").and_then(|m| m.as_object()) else {
            return false;
        };
        let Some(role) = msg.get("role").and_then(|r| r.as_str()) else {
            return false;
        };
        if role != "user" && role != "assistant" {
            return false;
        }
        let Some(raw) = extract_message_text(msg.get("content")) else {
            return false;
        };
        !collapse_ws(&raw).is_empty()
    })?;
    let msg = hit.get("message")?.as_object()?;
    let role = msg.get("role")?.as_str()?;
    let raw = extract_message_text(msg.get("content"))?;
    Some(Snippet {
        role: role.to_string(),
        text: truncate_snippet(&collapse_ws(&raw)),
        at: entry_time_ms(&hit),
    })
}
/// Return identity metadata from one bounded tail read. The scan stops once
/// both the newest visible entry and the latest terminal outcome are known.
/// This is intentionally independent of file length: a rewrite can shrink or
/// replace a transcript without making an old read marker appear current.
pub fn session_metadata(path: &Path) -> SessionMetadata {
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return SessionMetadata::default(),
    };
    let size = match f.metadata() {
        Ok(m) => m.len(),
        Err(_) => return SessionMetadata::default(),
    };
    let start = size.saturating_sub(SNIPPET_WINDOW);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return SessionMetadata::default();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return SessionMetadata::default();
    }
    let segments: Vec<&[u8]> = buf.split(|&b| b == b'\n').collect();
    let lo = if start > 0 { 1 } else { 0 };
    let mut out = SessionMetadata::default();
    for line in segments[lo..].iter().rev() {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if out.revision.is_none() && is_visible_entry(&v) {
            out.revision = Some(stable_revision(line));
            out.latest_entry_id = visible_entry_id(&v);
            out.active_at = entry_time_ms(&v);
        }
        if out.last_turn_outcome.is_none() {
            out.last_turn_outcome = turn_outcome(&v);
        }
        if out.revision.is_some() && out.last_turn_outcome.is_some() {
            break;
        }
    }
    out
}

/// Epoch ms of the newest user message within the last `window` entries: the
/// moment the current turn began, as the transcript recorded it. Used when
/// the daemon first learns of a turn mid-flight (it restarted, or the first
/// event it saw was a tool call) so the turn timer counts from the real start
/// instead of from whenever the daemon happened to notice.
pub fn last_user_message_ms(path: &Path, window: usize) -> Option<u64> {
    read_backward(path, None, window)
        .entries
        .iter()
        .rev()
        .find(|v| {
            v.get("type").and_then(Value::as_str) == Some("message")
                && v.pointer("/message/role").and_then(Value::as_str) == Some("user")
        })
        .and_then(entry_time_ms)
        .map(|ms| ms as u64)
}

/// Whether the transcript leaves the turn that started at `started_ms` open:
/// its newest conversation message (user, assistant or tool result, within
/// the last `window` entries) is not an assistant message that ended the turn
/// at or after that start. A turn whose closing reply reached the file did
/// finish, even if the daemon died before it saw `agent_end`; one cut off
/// mid-tool, mid-reply or before omp wrote anything did not.
pub fn turn_left_open(path: &Path, started_ms: u64, window: usize) -> bool {
    let page = read_backward(path, None, window);
    let newest = page.entries.iter().rev().find(|v| {
        v.get("type").and_then(Value::as_str) == Some("message")
            && matches!(
                v.pointer("/message/role").and_then(Value::as_str),
                Some("user" | "assistant" | "toolResult")
            )
    });
    let Some(newest) = newest else {
        // Nothing readable (missing file, or no message yet): the turn's
        // prompt never landed, so there is nothing to continue.
        return false;
    };
    let ended = newest.pointer("/message/role").and_then(Value::as_str) == Some("assistant")
        && turn_outcome(newest).is_some();
    // A closing reply from an EARLIER turn does not close this one. One
    // second of slack: the journal's start is the daemon's clock, the entry's
    // is omp's, and both run on this machine.
    let ended_this_turn =
        ended && entry_time_ms(newest).is_none_or(|at| at + 1000.0 >= started_ms as f64);
    !ended_this_turn
}

fn is_visible_entry(v: &Value) -> bool {
    // Match entries the phone can actually render; bookkeeping events must
    // not make a conversation unread when its visible transcript is unchanged.
    v.get("type").and_then(Value::as_str) == Some("custom_message")
        && v.get("customType").and_then(Value::as_str) == Some("collab-prompt")
        || matches!(
            v.pointer("/message/role").and_then(Value::as_str),
            Some("user" | "assistant" | "bashExecution" | "pythonExecution")
        )
}

fn visible_entry_id(v: &Value) -> Option<String> {
    v.get("id")
        .and_then(Value::as_str)
        .or_else(|| {
            v.get("message")
                .and_then(Value::as_object)
                .and_then(|m| m.get("id").or_else(|| m.get("responseId")))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
        .filter(|id| !id.is_empty())
}

fn turn_outcome(v: &Value) -> Option<String> {
    let typ = v.get("type").and_then(Value::as_str);
    let obj = v.as_object()?;
    let raw = obj
        .get("outcome")
        .or_else(|| obj.get("status"))
        .or_else(|| obj.get("stopReason"))
        .and_then(Value::as_str)
        .or_else(|| {
            obj.get("message")
                .and_then(Value::as_object)
                .and_then(|m| m.get("stopReason"))
                .and_then(Value::as_str)
        })?;
    let raw = raw.trim().to_ascii_lowercase();
    if raw.is_empty() {
        return None;
    }
    let failed = raw.contains("error") || raw.contains("fail");
    let interrupted = !failed && (raw.contains("abort") || raw == "cancelled" || raw == "canceled");
    if !failed
        && !interrupted
        && !matches!(
            raw.as_str(),
            "stop" | "length" | "end_turn" | "completed" | "done" | "success" | "max_tokens"
        )
    {
        // A tool-use message ending is not a terminal turn outcome.
        return None;
    }
    if typ == Some("turn_end") || typ == Some("agent_end") || typ == Some("message") {
        Some(if failed {
            "failed".to_string()
        } else if interrupted {
            "interrupted".to_string()
        } else {
            "completed".to_string()
        })
    } else {
        None
    }
}
pub(super) fn stable_revision(bytes: &[u8]) -> u64 {
    // FNV-1a is deterministic, tiny, and sufficient as an identity
    // fingerprint; the full JSON line is included so same-id rewrites count.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
/// Most recent model for a session file: newest `type:"model_change"`
/// (`model` string) or `type:"message"` with `message.model` (assistant
/// messages). The file's last write wins, so the first hit newest-first is
/// the current model. Empty model strings are skipped; unreadable files
/// yield None.
pub fn last_model(path: &Path) -> Option<String> {
    let hit = newest_matching(path, |obj| {
        let typ = obj.get("type").and_then(|t| t.as_str());
        if typ == Some("model_change") {
            return obj
                .get("model")
                .and_then(|m| m.as_str())
                .is_some_and(|m| !m.trim().is_empty());
        }
        if typ == Some("message") {
            return obj
                .get("message")
                .and_then(|m| m.as_object())
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
                .is_some_and(|m| !m.trim().is_empty());
        }
        false
    })?;
    let obj = hit.as_object()?;
    let raw = if obj.get("type").and_then(|t| t.as_str()) == Some("model_change") {
        obj.get("model")?.as_str()?
    } else {
        obj.get("message")?.as_object()?.get("model")?.as_str()?
    };
    Some(raw.trim().to_string())
}
/// An unanswered `ask` tool call. `question`/`options`/`recommended` are the
/// FIRST question (what a notification names); `questions` is all of them,
/// in order. omp asks them one after another in a single call, and the file
/// records nothing until the last is answered, so the phone must know every
/// question up front: showing only the first made a second tap silently
/// answer question 2 with an option meant for question 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingAsk {
    pub call_id: String,
    pub question: String,
    pub options: Vec<String>,
    /// Index into `options` the agent marked as its recommendation.
    pub recommended: Option<usize>,
    pub questions: Vec<AskQuestion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskQuestion {
    pub question: String,
    pub options: Vec<String>,
    pub recommended: Option<usize>,
    pub multi: bool,
}

/// Newest unanswered `ask` tool call in a session file: reverse-scan the last
/// 64 KiB (the `last_model` window) for a `toolCall` named `ask`; a later
/// `toolResult` with the same call id means answered. The first (newest) ask
/// decides: its result always immediately follows it, so a missing result
/// inside the window means genuinely pending — a result can only fall outside
/// the window if megabytes were written after the answer, and callers only
/// consult this for sessions already in `waiting`, where the tail IS the
/// pending state. Torn/empty lines skipped; unreadable files yield None.
/// Mirrors the extension's own question choice: the FIRST question's text
/// (`askBlockedMessage` uses `questions[0]` too).
///
/// omp writes the call as a `toolCall` block INSIDE the assistant message's
/// `content[]`. This used to match only a top-level `{"type":"toolCall"}`
/// line, a shape omp never writes, so every real blocked session listed as
/// "Needs reply" with no question: the answer sheet read "Waiting for input"
/// and offered no options.
pub fn pending_ask(path: &Path) -> Option<PendingAsk> {
    let mut f = fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let start = size.saturating_sub(SNIPPET_WINDOW);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return None;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return None;
    }
    let segments: Vec<&[u8]> = buf.split(|&b| b == b'\n').collect();
    let mut answered: std::collections::HashSet<String> = std::collections::HashSet::new();
    let lo = if start > 0 { 1 } else { 0 };
    for line in segments[lo..].iter().rev() {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(obj) = v.as_object() else { continue };
        match obj.get("type").and_then(|t| t.as_str()) {
            // Legacy/flattened shape, kept for older transcripts.
            Some("toolCall") => {
                if let Some(found) = ask_from_call(obj, &answered) {
                    return found;
                }
            }
            Some("message") => {
                let Some(msg) = obj.get("message").and_then(|m| m.as_object()) else {
                    continue;
                };
                match msg.get("role").and_then(|r| r.as_str()) {
                    Some("toolResult") => {
                        if let Some(id) = msg.get("toolCallId").and_then(|i| i.as_str()) {
                            answered.insert(id.to_string());
                        }
                    }
                    Some("assistant") => {
                        let blocks = msg.get("content").and_then(|c| c.as_array());
                        for block in blocks.into_iter().flatten().rev() {
                            let Some(call) = block.as_object() else {
                                continue;
                            };
                            if call.get("type").and_then(|t| t.as_str()) != Some("toolCall") {
                                continue;
                            }
                            if let Some(found) = ask_from_call(call, &answered) {
                                return found;
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    None
}

/// `None` when `call` is not an `ask` (keep scanning); `Some(result)` when it
/// is the newest ask, which decides: answered or unreadable yields `Some(None)`.
fn ask_from_call(
    call: &serde_json::Map<String, Value>,
    answered: &std::collections::HashSet<String>,
) -> Option<Option<PendingAsk>> {
    const MAX_QUESTION: usize = 500;
    const MAX_OPTION: usize = 200;
    const MAX_OPTIONS: usize = 6;
    if call.get("name").and_then(|n| n.as_str()) != Some("ask") {
        return None;
    }
    let id = call.get("id").and_then(|i| i.as_str()).unwrap_or("");
    if answered.contains(id) {
        return Some(None);
    }
    let parse = |q: &Value| -> Option<AskQuestion> {
        let q = q.as_object()?;
        let question = q
            .get("question")
            .and_then(|q| q.as_str())
            .map(str::trim)
            .filter(|q| !q.is_empty())?;
        let options: Vec<String> = q
            .get("options")
            .and_then(|o| o.as_array())
            .map(|opts| {
                opts.iter()
                    .filter_map(|o| o.get("label").and_then(|l| l.as_str()))
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .take(MAX_OPTIONS)
                    .map(|l| truncate_chars(l, MAX_OPTION))
                    .collect()
            })
            .unwrap_or_default();
        let recommended = q
            .get("recommended")
            .and_then(Value::as_u64)
            .map(|i| i as usize)
            .filter(|&i| i < options.len());
        Some(AskQuestion {
            question: truncate_chars(question, MAX_QUESTION),
            options,
            recommended,
            multi: q.get("multi").and_then(Value::as_bool).unwrap_or(false),
        })
    };
    let questions: Vec<AskQuestion> = call
        .get("arguments")
        .and_then(|a| a.get("questions"))
        .and_then(|q| q.as_array())
        .map(|qs| qs.iter().filter_map(parse).collect())
        .unwrap_or_default();
    let Some(first) = questions.first().cloned() else {
        return Some(None);
    };
    Some(Some(PendingAsk {
        call_id: id.to_string(),
        question: first.question,
        options: first.options,
        recommended: first.recommended,
        questions,
    }))
}

/// Truncate to `max` chars (not bytes — notification bodies and sheet rows
/// must never split a boundary).
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// Concatenate text from a message `content` value: for each block take its
/// `text` field when the block has `type:"text"`, or take the whole string
/// when content is a plain string. None when no textual content is present
/// (missing/null/object content, or an array with no text blocks).
fn extract_message_text(content: Option<&Value>) -> Option<String> {
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

/// Cap the snippet at SNIPPET_MAX chars, appending "…" when truncated.
fn truncate_snippet(s: &str) -> String {
    if s.chars().count() <= SNIPPET_MAX {
        s.to_string()
    } else {
        let mut cut: String = s.chars().take(SNIPPET_MAX).collect();
        cut.push('…');
        cut
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::jsonl::tests::scratch;

    #[test]
    fn pending_ask_finds_unanswered_ask() {
        let content = concat!(
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n",
            "{\"type\":\"toolCall\",\"id\":\"call_1\",\"name\":\"ask\",\"arguments\":{\"i\":\"x\",\"questions\":[{\"id\":\"q\",\"question\":\"Mock or live?\",\"options\":[{\"label\":\"Mock\"},{\"label\":\"Live\"}]}]}}\n",
        );
        let p = scratch("ask-pending", content);
        let ask = pending_ask(&p).expect("pending ask");
        assert_eq!(ask.question, "Mock or live?");
        assert_eq!(ask.options, vec!["Mock", "Live"]);
    }

    #[test]
    fn pending_ask_empty_when_answered() {
        let content = concat!(
            "{\"type\":\"toolCall\",\"id\":\"call_1\",\"name\":\"ask\",\"arguments\":{\"questions\":[{\"id\":\"q\",\"question\":\"Mock or live?\"}]}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"call_1\",\"toolName\":\"ask\",\"content\":[]}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"proceeding\"}]}}\n",
        );
        let p = scratch("ask-answered", content);
        assert!(pending_ask(&p).is_none());
    }

    #[test]
    fn pending_ask_ignores_older_answered_and_non_ask_calls() {
        let content = concat!(
            "{\"type\":\"toolCall\",\"id\":\"old\",\"name\":\"ask\",\"arguments\":{\"questions\":[{\"id\":\"q\",\"question\":\"Old?\"}]}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"old\",\"toolName\":\"ask\",\"content\":[]}}\n",
            "{\"type\":\"toolCall\",\"id\":\"t1\",\"name\":\"read\",\"arguments\":{\"path\":\"x\"}}\n",
            "{\"type\":\"toolCall\",\"id\":\"new\",\"name\":\"ask\",\"arguments\":{\"questions\":[{\"id\":\"q2\",\"question\":\"Now?\",\"options\":[]}]}}\n",
        );
        let p = scratch("ask-newest", content);
        let ask = pending_ask(&p).expect("newest ask pending");
        assert_eq!(ask.question, "Now?");
        assert!(ask.options.is_empty());
    }

    #[test]
    fn pending_ask_empty_without_asks() {
        let p = scratch("ask-none", "{\"type\":\"message\"}\n");
        assert!(pending_ask(&p).is_none());
        assert!(pending_ask(std::path::Path::new("/nonexistent-omp-pulse-ask.jsonl")).is_none());
    }

    #[test]
    fn pending_ask_finds_ask_nested_in_assistant_message() {
        // The shape omp actually writes: the call is a content block of an
        // assistant message, and nothing answers it yet.
        let content = concat!(
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"\"},",
            "{\"type\":\"toolCall\",\"id\":\"toolu_1\",\"name\":\"ask\",\"arguments\":{\"questions\":[",
            "{\"id\":\"route\",\"question\":\"Where should it go?\",\"options\":[{\"label\":\"~/.local/bin\"},{\"label\":\"Wait\"}],\"recommended\":0},",
            "{\"id\":\"restart\",\"question\":\"Restart now?\"}]}}]}}\n",
            "{\"type\":\"custom\",\"customType\":\"tool_execution_start\"}\n",
        );
        let p = scratch("ask-nested", content);
        let ask = pending_ask(&p).expect("nested ask pending");
        assert_eq!(ask.question, "Where should it go?");
        assert_eq!(ask.options, vec!["~/.local/bin", "Wait"]);
        assert_eq!(ask.recommended, Some(0));
        assert_eq!(ask.call_id, "toolu_1");
        let texts: Vec<_> = ask.questions.iter().map(|q| q.question.as_str()).collect();
        assert_eq!(
            texts,
            ["Where should it go?", "Restart now?"],
            "every question, in order"
        );

        let answered = format!(
            "{content}{}",
            "{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"toolu_1\",\"toolName\":\"ask\",\"content\":[]}}\n"
        );
        let p = scratch("ask-nested-answered", &answered);
        assert!(pending_ask(&p).is_none());
    }

    #[test]
    fn exit_bookkeeping_does_not_make_an_old_session_active() {
        // Regression: omp appends `session_exit` to every session a SIGTERMed
        // process held; ranking by mtime then put three-week-old chats at the
        // top of the phone list. Activity must come from the last message.
        let p = scratch(
            "active-at",
            concat!(
                "{\"type\":\"message\",\"timestamp\":\"2026-09-02T23:21:49.337Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}\n",
                "{\"type\":\"custom\",\"customType\":\"session_exit\",\"timestamp\":\"2026-09-23T13:43:35.111Z\",\"data\":{\"reason\":\"sigterm\"}}\n",
            ),
        );
        assert_eq!(session_metadata(&p).active_at, Some(1_788_391_309_337.0));
        assert_eq!(
            last_snippet(&p).and_then(|s| s.at),
            Some(1_788_391_309_337.0)
        );
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn last_snippet_finds_plain_user_text() {
        let p = scratch(
            "snippet-basic",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello there\"}]}}\n",
        );
        let snippet = last_snippet(&p).expect("snippet");
        assert_eq!(snippet.role, "user");
        assert!(snippet.text.contains("hello there"), "{}", snippet.text);
    }

    #[test]
    fn last_snippet_finds_message_buried_by_giant_lines() {
        // Regression: the old fixed 64 KiB tail read went blind when giant
        // tool-dump lines filled the window, and the phone rendered real
        // conversations as "No message yet".
        let dump = "x".repeat(100_000);
        let content = format!(
            "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"buried hello\"}}]}}}}\n\
             {{\"type\":\"message\",\"message\":{{\"role\":\"toolResult\",\"content\":[{{\"type\":\"text\",\"text\":\"{dump}\"}}]}}}}\n\
             {{\"type\":\"message\",\"message\":{{\"role\":\"toolResult\",\"content\":[{{\"type\":\"text\",\"text\":\"{dump}\"}}]}}}}\n\
             {{\"type\":\"custom\",\"customType\":\"noise\"}}\n"
        );
        let p = scratch("snippet-buried", &content);
        let snippet = last_snippet(&p).expect("buried snippet");
        assert_eq!(snippet.role, "user");
        assert!(snippet.text.contains("buried hello"), "{}", snippet.text);
    }

    #[test]
    fn last_model_finds_change_buried_by_giant_lines() {
        let dump = "y".repeat(100_000);
        let content = format!(
            "{{\"type\":\"model_change\",\"model\":\"opencode-go/muse-spark\"}}\n\
             {{\"type\":\"message\",\"message\":{{\"role\":\"toolResult\",\"content\":[{{\"type\":\"text\",\"text\":\"{dump}\"}}]}}}}\n\
             {{\"type\":\"message\",\"message\":{{\"role\":\"toolResult\",\"content\":[{{\"type\":\"text\",\"text\":\"{dump}\"}}]}}}}\n"
        );
        let p = scratch("model-buried", &content);
        assert_eq!(last_model(&p).as_deref(), Some("opencode-go/muse-spark"));
    }

    #[test]
    fn turn_outcome_splits_abort_from_error() {
        let aborted = serde_json::json!({"type": "message", "message": {"stopReason": "aborted"}});
        assert_eq!(turn_outcome(&aborted).as_deref(), Some("interrupted"));
        let failed = serde_json::json!({"type": "message", "message": {"stopReason": "error: provider exploded"}});
        assert_eq!(turn_outcome(&failed).as_deref(), Some("failed"));
        let stopped = serde_json::json!({"type": "message", "message": {"stopReason": "stop"}});
        assert_eq!(turn_outcome(&stopped).as_deref(), Some("completed"));
    }

    #[test]
    fn last_snippet_finds_text_buried_by_tool_storm() {
        // Companion to the giant-line test: hundreds of small tool entries
        // (a busy agent turn) must not push the preview out of reach either.
        let mut content = String::from(
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"storm hello\"}]}}\n",
        );
        for i in 0..300 {
            content.push_str(&format!(
                "{{\"type\":\"message\",\"message\":{{\"role\":\"toolResult\",\"content\":[{{\"type\":\"text\",\"text\":\"dump {i}\"}}]}}}}\n"
            ));
        }
        let p = scratch("snippet-storm", &content);
        let snippet = last_snippet(&p).expect("storm snippet");
        assert_eq!(snippet.role, "user");
        assert!(snippet.text.contains("storm hello"), "{}", snippet.text);
    }

    #[test]
    fn turn_left_open_reads_the_transcript_tail() {
        // 2026-10-14T10:00:00Z: when the journaled turn started.
        let started = 1_791_972_000_000u64;
        let msg = |at: &str, role: &str, stop: &str| {
            format!(
                "{{\"type\":\"message\",\"timestamp\":\"2026-10-14T{at}Z\",\"message\":{{\"role\":\"{role}\",\"stopReason\":\"{stop}\",\"content\":[]}}}}\n"
            )
        };
        let case = |tag: &str, body: String| {
            let p = scratch(
                tag,
                &format!("{{\"type\":\"session\",\"id\":\"s\"}}\n{body}"),
            );
            let open = turn_left_open(&p, started, 64);
            let _ = std::fs::remove_file(&p);
            open
        };
        // Cut off before any reply, mid-tool, and while a tool ran.
        assert!(case("open-user", msg("10:00:00.100", "user", "")));
        assert!(case(
            "open-tool-call",
            msg("10:00:00.100", "user", "") + &msg("10:00:03.000", "assistant", "toolUse")
        ));
        assert!(case(
            "open-tool-result",
            msg("10:00:03.000", "assistant", "toolUse") + &msg("10:00:04.000", "toolResult", "")
        ));
        // Its closing reply reached the file, or the user stopped it.
        assert!(!case(
            "closed-stop",
            msg("10:00:00.100", "user", "") + &msg("10:00:09.000", "assistant", "stop")
        ));
        assert!(!case(
            "closed-aborted",
            msg("10:00:09.000", "assistant", "aborted")
        ));
        // A closing reply from an EARLIER turn does not close this one.
        assert!(case(
            "open-earlier-stop",
            msg("09:58:00.000", "assistant", "stop") + "{\"type\":\"session_exit\",\"id\":\"x\"}\n"
        ));
        // No prompt reached the file: nothing to continue.
        assert!(!case("open-nothing", String::new()));
        assert!(!turn_left_open(
            Path::new("/nonexistent/s.jsonl"),
            started,
            64
        ));
    }
}
