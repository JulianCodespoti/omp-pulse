//! Pure synchronous session-file scanning: header parsing, forward/backward
//! history reads, session listing. Std + serde_json only, no tokio.
//!
//! Wire semantics mirror the Bun daemon's helpers in `server.ts` exactly:
//! consumed-bytes forward reads (the >limit data-loss fix), byte-offset
//! backward paging via `next_before`, header fields from the first 4 KiB, and
//! one-level-deep session listing. Missing/vanished/racing files yield empty
//! results — never an error or panic.

pub mod usage;

mod listing;
mod page;
mod refile;
mod tail;
mod tree;
mod turns;

use listing::*;
use page::*;
use tail::*;

pub use listing::{line_count, list_sessions};
pub use page::{read_backward, read_forward};
pub use refile::{
    RefileReport, RefileSkip, project_session_dir, refile_root_sessions, stranded_root_sessions,
};
pub use tail::{
    AskQuestion, PendingAsk, last_model, last_snippet, last_user_message_ms, pending_ask,
    session_metadata, turn_left_open,
};
pub(crate) use tree::ActiveLeafSelection;
pub use tree::{TreeRow, TurnStats, read_tree};
pub use turns::{Subagent, UserTurns, read_subagents, read_user_turns};

use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::Path;

/// Header region fields parsed from the first 4 KiB of a session file.
#[derive(Debug, Clone, Default)]
pub struct SessionHeader {
    pub id: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    /// The `session` entry's timestamp (epoch ms): when the file was created.
    pub created_ms: Option<f64>,
    /// When the current title was written (epoch ms): the `title` entry's
    /// `updatedAt`, else the newest `title_change` in the header region.
    pub title_written_ms: Option<f64>,
}

/// How close to creation a cwd-basename title must be written to count as
/// the old automatic folder name rather than a name the user chose.
const PLACEHOLDER_TITLE_WINDOW_MS: f64 = 1500.0;
/// Bytes scanned from the start of an untitled session for its first prompt.
/// A first prompt carrying a pasted photo can be a long line; past this the
/// row keeps its fallback title rather than reading the whole transcript.
const FIRST_PROMPT_BYTES: u64 = 256 * 1024;
/// Longest title derived from a first prompt, in characters.
const PROMPT_TITLE_MAX: usize = 48;

impl SessionHeader {
    /// The title the user (or omp) actually gave this session. Until
    /// 2026-10-14 the daemon named every phone-created session after its
    /// folder via `set_session_name`, which omp records as a user title and
    /// which therefore blocked any real one. A title equal to the cwd
    /// basename and written within ~1 s of creation is that placeholder, so
    /// it reads as untitled here; a later rename (even to the same name)
    /// carries a later write time and stands.
    pub fn chosen_title(&self) -> Option<&str> {
        let title = self.title.as_deref()?;
        let basename = self
            .cwd
            .as_deref()
            .and_then(|c| Path::new(c).file_name())
            .and_then(|n| n.to_str());
        let placeholder = basename == Some(title)
            && match (self.created_ms, self.title_written_ms) {
                (Some(created), Some(written)) => {
                    (written - created).abs() <= PLACEHOLDER_TITLE_WINDOW_MS
                }
                _ => false,
            };
        (!placeholder).then_some(title)
    }
}

/// Result of a forward history read: parsed entries (oldest→newest) plus the
/// byte offset just past the last consumed line.
#[derive(Debug, Clone)]
pub struct ForwardRead {
    pub entries: Vec<Value>,
    pub end_offset: u64,
}

/// Result of a backward history read: parsed entries in file order plus the
/// byte offset of the oldest returned entry (None when at the file start).
#[derive(Debug, Clone)]
pub struct BackwardRead {
    pub entries: Vec<Value>,
    pub next_before: Option<u64>,
    /// Bytes this read accounted for: the file size it read against, minus a
    /// torn unterminated last line (omp mid-write) that it could not parse.
    /// History pages advertise this as `endOffset`, the client's `?after=`
    /// cursor. A second `metadata()` after the read counted lines appended in
    /// between, and a torn tail's bytes, as delivered although neither was in
    /// the page; the next catch-up then started past them and the phone never
    /// showed those entries.
    pub end_offset: u64,
}

/// Newest chat-message snippet for the session-list inbox (`/api/sessions`
/// rows gain `snippet`). Wire shape: `{"role","text"}`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Snippet {
    pub role: String,
    pub text: String,
    /// When that message was written (epoch ms). Internal: it orders the
    /// list when the metadata window held no message; not part of the wire.
    #[serde(skip)]
    pub at: Option<f64>,
}

/// Stable identity and outcome metadata for the newest visible entry.
///
/// `revision` is a content fingerprint, not a byte count: compaction,
/// truncation, and in-place replacement therefore cannot make an old marker
/// appear current merely by becoming smaller. It changes when the newest
/// visible entry changes, while preserving identity when compaction retains
/// that entry unchanged.
#[derive(Debug, Clone, Default)]
pub struct SessionMetadata {
    pub revision: Option<u64>,
    pub latest_entry_id: Option<String>,
    pub last_turn_outcome: Option<String>,
    /// Epoch ms of the newest visible entry: real conversational activity,
    /// unlike the file mtime that exit bookkeeping bumps.
    pub active_at: Option<f64>,
}
/// Bytes of header region examined by `parse_header` (matches server.ts:4096).
const HEADER_BYTES: u64 = 4096;
/// Max bytes read per backward-window growth step (matches server.ts HISTORY_CHUNK).
const BACKWARD_CHUNK: u64 = 256 * 1024;

fn count_newlines(s: &[u8]) -> usize {
    s.iter().filter(|&&b| b == b'\n').count()
}

/// Parse the header region of a session JSONL file: reads the first 4096
/// bytes, scans its lines, takes the FIRST `type:"title"` entry's `title`
/// (falling back to the first `type:"session"` entry's title) and the FIRST
/// `type:"session"` entry's `id`/`cwd`. Blank, torn, or non-object lines are
/// skipped. Any read failure yields the default header.
pub fn parse_header(path: &Path) -> SessionHeader {
    let f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return SessionHeader::default(),
    };
    let mut buf = Vec::with_capacity(HEADER_BYTES as usize);
    if f.take(HEADER_BYTES).read_to_end(&mut buf).is_err() {
        return SessionHeader::default();
    }
    let mut out = SessionHeader::default();
    let mut first_title: Option<String> = None;
    let mut first_title_at: Option<f64> = None;
    let mut first_session_title: Option<String> = None;
    let mut title_change_at: Option<f64> = None;
    for line in buf.split(|&b| b == b'\n') {
        let text = String::from_utf8_lossy(line);
        if text.trim().is_empty() {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(obj) = o.as_object() else { continue };
        let Some(typ) = obj.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        if typ == "title" && first_title.is_none() {
            // An empty title entry (`"title":""`, which omp writes for
            // untitled sessions) must NOT claim the slot: Some("") would
            // block the session-entry fallback below and the row renders a
            // raw file path instead of a title.
            if let Some(t) = obj.get("title").and_then(|v| v.as_str()) {
                let t = t.trim();
                if !t.is_empty() {
                    first_title = Some(t.to_string());
                    first_title_at = obj
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .and_then(iso_utc_ms);
                }
            }
        } else if typ == "title_change" {
            if let Some(at) = obj
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(iso_utc_ms)
            {
                title_change_at = Some(at);
            }
        } else if typ == "session" {
            if out.id.is_none()
                && let Some(i) = obj.get("id").and_then(|v| v.as_str())
            {
                out.id = Some(i.to_string());
            }
            if out.cwd.is_none()
                && let Some(c) = obj.get("cwd").and_then(|v| v.as_str())
            {
                out.cwd = Some(c.to_string());
            }
            if out.created_ms.is_none() {
                out.created_ms = obj
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(iso_utc_ms);
            }
            if first_session_title.is_none()
                && let Some(t) = obj.get("title").and_then(|v| v.as_str())
            {
                let t = t.trim();
                if !t.is_empty() {
                    first_session_title = Some(t.to_string());
                }
            }
        }
    }
    out.title_written_ms = first_title_at.or(title_change_at);
    out.title = first_title.or(first_session_title);
    out
}

/// A short display title from an untitled session's first prompt: the first
/// user turn with text, its first nonblank line, cut at a word boundary to
/// about [`PROMPT_TITLE_MAX`] characters. No model call: it is read from the
/// first [`FIRST_PROMPT_BYTES`] of the file. None when no prompt is there yet.
pub fn first_prompt_title(path: &Path) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(f.take(FIRST_PROMPT_BYTES));
    let mut line = Vec::new();
    loop {
        line.clear();
        match std::io::BufRead::read_until(&mut reader, b'\n', &mut line) {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        // A cheap filter first: only a user turn can title the session, and
        // most header-region lines are bookkeeping.
        if !line.windows(6).any(|w| w == b"\"user\"")
            && !line.windows(13).any(|w| w == b"collab-prompt")
        {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if let Some(title) = user_turn_text(&v).and_then(|t| prompt_title(&t)) {
            return Some(title);
        }
    }
}

/// The title a session row shows: the title it was given, else one derived
/// from its first prompt.
pub fn display_title(path: &Path) -> Option<String> {
    let header = parse_header(path);
    match header.chosen_title() {
        Some(title) => Some(title.to_string()),
        None => first_prompt_title(path),
    }
}

/// First nonblank line of `text`, whitespace collapsed, cut to at most
/// [`PROMPT_TITLE_MAX`] characters at a word boundary with an ellipsis.
fn prompt_title(text: &str) -> Option<String> {
    let line = collapse_ws(text.lines().find(|l| !l.trim().is_empty())?);
    if line.chars().count() <= PROMPT_TITLE_MAX {
        return Some(line);
    }
    // Room for the ellipsis inside the limit.
    let budget = PROMPT_TITLE_MAX - 1;
    let end = line
        .char_indices()
        .nth(budget)
        .map_or(line.len(), |(i, _)| i);
    let head = &line[..end];
    // Prefer the last word boundary, unless it would leave a stub.
    let cut = match head.rfind(' ') {
        Some(space) if head[..space].chars().count() >= budget / 2 => &head[..space],
        _ => head,
    };
    let cut =
        cut.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | ':' | '-'));
    Some(format!("{cut}…"))
}
/// Epoch milliseconds of an entry: the message's own numeric `timestamp`
/// when present, else the entry's ISO-8601 UTC `timestamp`
/// (`2026-09-02T23:21:49.337Z`, the only shape omp writes).
pub(crate) fn entry_time_ms(v: &Value) -> Option<f64> {
    if let Some(ms) = v.pointer("/message/timestamp").and_then(Value::as_f64) {
        return (ms > 0.0).then_some(ms);
    }
    v.get("timestamp")
        .and_then(Value::as_str)
        .and_then(iso_utc_ms)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` → epoch ms. Anything else is `None`.
fn iso_utc_ms(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || !s.ends_with('Z') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let frac = match s.get(19..s.len() - 1) {
        Some(f) if f.starts_with('.') && f.len() > 1 => {
            // A malformed fraction may put the three-byte cut inside a
            // Unicode character. Invalid timestamps must not panic the index.
            let digits = f.get(1..f.len().min(4))?;
            digits.parse::<i64>().ok()? * 10_i64.pow(3 - digits.len() as u32)
        }
        _ => 0,
    };
    // Days from civil (Howard Hinnant), proleptic Gregorian.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + frac) as f64)
}

/// Concatenate text blocks the way the phone's `concatText` does — bare
/// join, no separator (the transcript's `_msgText` and the branch timeline's
/// `entryUserText` both use exactly this), so a turn text re-derived here
/// matches what the user saw typed. Unlike `extract_message_text` above,
/// which space-joins for snippets where `collapse_ws` makes the gap
/// invisible, the timeline must preserve the blocks' exact text.
fn concat_text_blocks(content: Option<&Value>) -> Option<String> {
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
                }
            }
        }
        Some(Value::String(s)) => out.push_str(s),
        _ => return None,
    }
    if out.is_empty() { None } else { Some(out) }
}

/// The text of a user turn, from either entry shape: a `type:"message"` entry
/// whose `message.role` is "user", or a `type:"custom_message"` entry with
/// `customType:"collab-prompt"` (what a DESKTOP-driven session writes for a
/// prompt). None for every other entry, and for turns whose text is empty or
/// whitespace-only — the scan skips those (the phone's `entryUserText` skips
/// the same way).
fn user_turn_text(v: &Value) -> Option<String> {
    let obj = v.as_object()?;
    let content = match obj.get("type").and_then(|t| t.as_str()) {
        Some("message") => {
            let m = obj.get("message")?.as_object()?;
            if m.get("role").and_then(|r| r.as_str()) != Some("user") {
                return None;
            }
            m.get("content")
        }
        Some("custom_message") => {
            if obj.get("customType").and_then(|t| t.as_str()) != Some("collab-prompt") {
                return None;
            }
            obj.get("content")
        }
        _ => return None,
    };
    let text = concat_text_blocks(content)?;
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Collapse any run of whitespace (newlines, tabs, runs of spaces) to a
/// single space, dropping leading/trailing whitespace.
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !in_ws && !out.is_empty() {
                out.push(' ');
            }
            in_ws = true;
        } else {
            in_ws = false;
            out.push(ch);
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests;
