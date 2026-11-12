//! The user-turn index (a backward window within a byte budget) and the subagent
//! list (a forward scan) read from a session file.

use super::*;
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Hard byte budget for the backward user-turn scan (`read_user_turns`):
/// beyond this, older turns are reported via `more` instead of being read.
/// Measured: a 43 MB live session carries user turns ~93 entries apart (~20
/// entries per 256 KiB page), so a phone timeline fills from the newest 8 MiB
/// in a few ms and the rest stays one `more` flag away.
const USER_TURNS_BUDGET: u64 = 8 * 1024 * 1024;

/// Result of the backward user-turn scan: extracted turn texts in file order
/// (oldest→newest) plus `more` = whether older turns may exist beyond the
/// scanned window (byte budget exhausted, or `limit` filled before the file
/// start was reached).
#[derive(Debug, Clone)]
pub struct UserTurns {
    pub turns: Vec<String>,
    pub more: bool,
}

/// A subagent spawned by a `task` tool call, recovered from the transcript.
#[derive(Debug, Clone)]
pub struct Subagent {
    pub call_id: String,
    pub name: String,
    pub agent: Option<String>,
    pub intent: Option<String>,
    pub entry_id: Option<String>,
    pub at: Option<String>,
}

/// Every subagent this session ever spawned, oldest first.
///
/// WHY THIS LIVES IN THE DAEMON: the same reason as [`read_user_turns`]. A
/// desktop-owned session refuses `get_subagents` like every other RPC, so the
/// agents sheet falls back to reading the transcript — and the client cannot
/// do that. Measured on a live session: 11,029 entries, with the `task` calls
/// sitting 7,600 to 10,700 entries from the end. Paging that from the phone at
/// 200 entries a request is 55 round trips, so a bounded client scan gave up
/// and reported "no subagents" for a session that had spawned dozens.
///
/// A forward scan is right here, unlike the backward window `read_user_turns`
/// uses, because subagents are spread through the whole file rather than
/// clustered at the end. Lines are pre-filtered on a substring before any JSON
/// parsing, so the common line costs a memchr rather than a parse.
/// Unparseable lines are skipped; a missing file yields an empty list.
pub fn read_subagents(path: &Path, limit: usize) -> Vec<Subagent> {
    use std::io::{BufRead, BufReader};

    let mut out: Vec<Subagent> = Vec::new();
    let Ok(file) = fs::File::open(path) else {
        return out;
    };
    if limit == 0 {
        return out;
    }
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        // Cheap gate: only lines mentioning the spawn tool are worth parsing.
        if !line.contains("\"task\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let entry_id = entry.get("id").and_then(|v| v.as_str()).map(str::to_string);
        let at = entry
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let Some(content) = entry
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for part in content {
            let kind = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if kind != "toolCall" && kind != "tool_use" {
                continue;
            }
            let tool = part.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if !tool.eq_ignore_ascii_case("task") {
                continue;
            }
            let call_id = part
                .get("id")
                .or_else(|| part.get("tool_use_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let intent = part
                .get("intent")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let args = part.get("arguments").or_else(|| part.get("input"));
            // The useful shape is `arguments.tasks[]`, one entry per subagent.
            let tasks = args.and_then(|a| a.get("tasks")).and_then(|t| t.as_array());
            match tasks {
                Some(list) if !list.is_empty() => {
                    for (index, task) in list.iter().enumerate() {
                        if out.len() >= limit {
                            return out;
                        }
                        let name = task
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("task {}", index + 1));
                        out.push(Subagent {
                            call_id: format!("{call_id}:{index}"),
                            name,
                            agent: task
                                .get("agent")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            intent: intent.clone(),
                            entry_id: entry_id.clone(),
                            at: at.clone(),
                        });
                    }
                }
                _ => {
                    if out.len() >= limit {
                        return out;
                    }
                    out.push(Subagent {
                        call_id: call_id.clone(),
                        name: intent.clone().unwrap_or_else(|| "task".to_string()),
                        agent: None,
                        intent: intent.clone(),
                        entry_id: entry_id.clone(),
                        at: at.clone(),
                    });
                }
            }
        }
    }
    out
}

/// Backward scan for the phone's read-only timeline: reads at most the newest
/// `USER_TURNS_BUDGET` bytes of the session file and returns up to `limit`
/// user turns (oldest→newest), or `more: true` when older turns may exist
/// unreached.
///
/// WHY THIS LIVES IN THE DAEMON: a desktop-owned session refuses every RPC
/// (`session_owned_by_terminal`), so the timeline must read the file — and
/// the client cannot: measured live, a 43 MB session holds user turns ~93
/// entries apart with ~20 entries per 256 KiB page, so a bounded client scan
/// found zero turns in 60 s. The daemon's scan costs one bounded tail read.
///
/// Walks backward from EOF in the same `BACKWARD_CHUNK` windows as
/// `read_backward` — torn first segment of each window skipped (the line
/// continues before the window; it is captured whole once the window grows
/// far enough, and grown windows are what made the 2 MiB-line test pass
/// there), unparseable lines skipped, never fatal. Missing/vanished files
/// yield an empty result — never an error or panic.
pub fn read_user_turns(path: &Path, limit: usize) -> UserTurns {
    let empty = || UserTurns {
        turns: Vec::new(),
        more: false,
    };
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        // Vanished between the caller's stat and here — empty result.
        Err(_) => return empty(),
    };
    let file_size = match f.metadata() {
        Ok(m) => m.len(),
        Err(_) => return empty(),
    };
    if file_size == 0 || limit == 0 {
        return empty();
    }

    // One PAST the limit on purpose: finding an extra turn is the only exact way to
    // answer "are there older points?" without claiming it from bytes alone. A file
    // that fits entirely in one window has acc_start == 0, so a byte test would call
    // a limit-truncated result complete and the sheet would stop offering earlier
    // points that exist. The extra turn is dropped before returning.
    let mut need = limit.saturating_add(1);
    let mut budget = USER_TURNS_BUDGET;
    // Newest → oldest extracted texts; reversed into file order at the end.
    let mut newest_first: Vec<String> = Vec::new();
    let mut end = file_size;
    let mut acc_start = file_size;
    let mut win = WinBuf::new();
    let mut nl_count = 0usize; // newlines inside `win`
    let mut chunk = vec![0u8; BACKWARD_CHUNK as usize];
    while need > 0 && end > 0 && budget > 0 {
        // Grow the window backward until it holds need+1 newlines (enough to
        // bound `need` complete lines), reaches the file start, or spends the
        // byte budget — whichever comes first. Each read is capped by the
        // remaining budget and takes the NEWEST bytes of its chunk, so the
        // scan never exceeds `budget` bytes total and the window is always
        // right-aligned at `end`.
        while acc_start > 0 && nl_count < need + 1 && budget > 0 {
            let take = BACKWARD_CHUNK.min(acc_start).min(budget);
            let ws = acc_start - take;
            // A file that shrank mid-read tears the window: hand back an
            // empty result rather than a half window (racing files yield
            // empty results — never an error or panic).
            if f.seek(SeekFrom::Start(ws)).is_err()
                || f.read_exact(&mut chunk[..take as usize]).is_err()
            {
                return empty();
            }
            nl_count += count_newlines(&chunk[..take as usize]);
            win.prepend(&chunk[..take as usize]);
            acc_start = ws;
            budget -= take;
        }
        let window = win.window();
        let mut parts: Vec<&[u8]> = Vec::new();
        for seg in window.split(|&b| b == b'\n') {
            parts.push(seg);
        }
        // First segment is a partial line when the window starts mid-file;
        // last segment is a partial line when the window ends mid-file (same
        // convention as read_backward). A budget-starved window can hold NO
        // newline at all (parts.len()==1, torn at both ends) — there is
        // nothing complete to parse then, so skip straight to older data
        // (which the budget usually forbids, leaving `more` true).
        let lo = if acc_start > 0 { 1 } else { 0 };
        let hi = if end < file_size {
            parts.len().saturating_sub(1)
        } else {
            parts.len()
        };
        // Take the NEWEST user turns first, stopping the whole scan once the
        // limit is filled — the remaining older lines are exactly the turns
        // that make `more` true.
        if hi > lo {
            for seg in parts[lo..hi].iter().rev() {
                if seg.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_slice::<Value>(seg) else {
                    continue;
                };
                let Some(text) = user_turn_text(&v) else {
                    continue;
                };
                newest_first.push(text);
                need -= 1;
                if need == 0 {
                    break;
                }
            }
        }
        if need > 0 {
            // Everything accumulated was consumed; move to older data.
            end = acc_start;
            win.clear();
            nl_count = 0;
            acc_start = end;
        }
    }
    let mut turns = newest_first;
    // `turns` is newest-first here: dropping the tail drops the probe turn, which is
    // the OLDEST of the batch - exactly the one that only existed to prove more.
    let more = turns.len() > limit || acc_start > 0;
    turns.truncate(limit);
    turns.reverse();
    UserTurns { turns, more }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::jsonl::tests::scratch;

    #[test]
    fn read_user_turns_both_entry_shapes_oldest_first() {
        // A `message`/user entry and a `collab-prompt` custom entry (what a
        // DESKTOP-driven session writes for a prompt) both count as user
        // turns; assistant messages do not. Multi-block text joins with NO
        // separator (the phone's concatText convention), so "third"+" part"
        // reads "third part" — not "third part" from a space-join.
        let path = scratch(
            "uturns-shapes",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first\"}]}}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"skip me\"}]}}\n\
             {\"type\":\"custom_message\",\"customType\":\"collab-prompt\",\"content\":[{\"type\":\"text\",\"text\":\"second\"}]}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"third\"},{\"type\":\"text\",\"text\":\" part\"}]}}\n",
        );
        let ut = read_user_turns(&path, 25);
        assert_eq!(ut.turns, vec!["first", "second", "third part"]);
        assert!(!ut.more);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_user_turns_skips_whitespace_only_text() {
        // Entries whose extracted text is empty or whitespace-only are not
        // turns — the timeline must not list "   " as a point.
        let path = scratch(
            "uturns-ws",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"   \"}]}}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"real\"}]}}\n\
             {\"type\":\"custom_message\",\"customType\":\"collab-prompt\",\"content\":[{\"type\":\"text\",\"text\":\"\\n\\t\"}]}\n\
             {\"type\":\"custom_message\",\"customType\":\"collab-prompt\",\"content\":[{\"type\":\"text\",\"text\":\"kept\"}]}\n",
        );
        let ut = read_user_turns(&path, 25);
        assert_eq!(ut.turns, vec!["real", "kept"]);
        assert!(!ut.more);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_user_turns_limit_keeps_newest_and_reports_more() {
        // limit=2 on five turns with a > 1-chunk non-user line BEFORE them:
        // the two NEWEST survive (oldest-first among them) and more is true,
        // because the limit filled while the window still started mid-file —
        // the scan never reached the older turns or the file start. (A file
        // small enough for one chunk would read the whole file, reach the
        // start, and legitimately report more=false.)
        let pad = "a".repeat(300_000);
        let path = scratch(
            "uturns-limit",
            &format!(
                "{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{pad}\"}}]}}}}\n\
                 {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"t0\"}}]}}}}\n\
                 {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"t1\"}}]}}}}\n\
                 {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"t2\"}}]}}}}\n\
                 {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"t3\"}}]}}}}\n\
                 {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"t4\"}}]}}}}\n"
            ),
        );
        let ut = read_user_turns(&path, 2);
        assert_eq!(ut.turns, vec!["t3", "t4"]);
        assert!(ut.more);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_user_turns_skips_unparseable_lines() {
        // "not json" lines are never fatal — they simply yield no turn.
        let path = scratch(
            "uturns-garbage",
            "not json\n\
             {\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"real\"}]}}\n\
             garbage line\n\
             {\"type\":\"custom_message\",\"customType\":\"collab-prompt\",\"content\":[{\"type\":\"text\",\"text\":\"second\"}]}\n",
        );
        let ut = read_user_turns(&path, 25);
        assert_eq!(ut.turns, vec!["real", "second"]);
        assert!(!ut.more);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_user_turns_budget_exhausted_reports_more() {
        // The only user turn sits at the top of a > 8 MiB file whose tail is
        // one giant assistant line: the backward scan spends the whole
        // budget inside that line and never reaches the turn — empty result,
        // more: true. (The torn line tail fails to parse as JSON and is
        // skipped, exactly as read_backward treats torn windows.)
        let pad = "a".repeat(9 * 1024 * 1024);
        let path = scratch(
            "uturns-budget",
            &format!(
                "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"first\"}}]}}}}\n\
                 {{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{pad}\"}}]}}}}\n"
            ),
        );
        let ut = read_user_turns(&path, 25);
        assert!(ut.turns.is_empty());
        assert!(ut.more);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_user_turns_starved_window_without_newlines_is_skipped() {
        // Round 1 consumes one chunk (30 small entries >= need+1 newlines);
        // round 2 then reads an 8 MiB single-line assistant block and
        // exhausts the budget inside it — the final window holds NO newline
        // and is torn at both ends. The parse must skip it (a parts[1..0]
        // slice used to panic here — the live 43 MB session hit exactly
        // this), keep the turns round 1 found, and report more: true.
        let giant = "a".repeat(8 * 1024 * 1024);
        let mut content = format!(
            "{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{giant}\"}}]}}}}\n"
        );
        for i in 0..30 {
            if i % 10 == 0 {
                content.push_str(&format!(
                    "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"u{i}\"}}]}}}}\n"
                ));
            } else {
                content.push_str("{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"a\"}]}}\n");
            }
        }
        let path = scratch("uturns-starved", &content);
        let ut = read_user_turns(&path, 25);
        assert_eq!(ut.turns, vec!["u0", "u10", "u20"]);
        assert!(ut.more);
        let _ = std::fs::remove_file(&path);
    }
}
