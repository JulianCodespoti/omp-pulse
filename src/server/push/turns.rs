//! Per-session turn bookkeeping for the agent-finished notification: the last
//! assistant text, and whether the turn was aborted or failed.

use super::*;

/// The last clean assistant reply per session, remembered at `message_end` and
/// consumed by the `agent_end` that follows.
pub static LAST_ASSISTANT_TEXT: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Flatten an assistant message's content to a single short line.
/// Strips markdown so the notification shade (plain BigTextStyle/MessagingStyle)
/// never shows literal `**`, `` ` ``, `#` etc.
pub fn summarise_assistant(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    let mut text = String::new();
    if let Some(s) = content.as_str() {
        text.push_str(s);
    } else if let Some(parts) = content.as_array() {
        for part in parts {
            if part.get("type").and_then(|t| t.as_str()) == Some("text")
                && let Some(s) = part.get("text").and_then(|t| t.as_str())
            {
                text.push_str(s);
            }
        }
    }
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = flat.trim();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = strip_notify_markup(trimmed);
    let trimmed2 = stripped.trim();
    if trimmed2.is_empty() {
        return None;
    }
    let mut out: String = trimmed2.chars().take(NOTIFY_BODY_MAX).collect();
    if trimmed2.chars().count() > NOTIFY_BODY_MAX {
        out.push('…');
    }
    Some(out)
}

/// Strip markdown markup for notification payloads — notifications render as
/// plain text (BigTextStyle / MessagingStyle), so `**bold**`, `` `code` ``,
/// `# heading`, `> quote`, `[text](url)` etc. must be flattened. This is
/// intentionally small and dependency-free; it covers the tokens the agent
/// actually emits in summaries (bold, inline code, code fences, headings,
/// links) without pulling in a markdown parser.
pub fn strip_notify_markup(s: &str) -> String {
    // `_` is intentionally absent: underscores are never stripped, so a
    // string carrying only underscores skips the walk entirely.
    if !s
        .chars()
        .any(|c| matches!(c, '*' | '`' | '~' | '#' | '>' | '['))
    {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '`' => {
                while chars.peek() == Some(&'`') {
                    chars.next();
                }
            }
            // Bold/italic runs only: a lone `*` is arithmetic (`2 * 3`), not
            // markup. `*italic*` survives — conservative direction.
            '*' => {
                if chars.peek() == Some(&'*') {
                    while chars.peek() == Some(&'*') {
                        chars.next();
                    }
                } else {
                    out.push(c);
                }
            }
            // Underscores are NEVER stripped: snake_case (`omp_store.ts`),
            // dunder (`__init__`) and ~/paths render literally, and they
            // dwarf emphasis usage in agent summaries. Same for lone `~`.
            '_' => {
                out.push(c);
            }
            '~' => {
                if chars.peek() == Some(&'~') {
                    while chars.peek() == Some(&'~') {
                        chars.next();
                    }
                } else {
                    out.push(c);
                }
            }
            // Headings and quotes only at LINE starts: `#`/`>` after a space
            // mid-line is `fixed #42` / `count > 0`, not markup. (The old
            // check treated any space as line start, and the summariser
            // collapses whitespace first, so it fired almost everywhere.)
            '#' | '>' => {
                let at_line_start = out.is_empty() || out.ends_with('\n');
                if at_line_start {
                    if chars.peek() == Some(&' ') {
                        chars.next();
                    }
                } else {
                    out.push(c);
                }
            }
            '[' => {
                let mut link_text = String::new();
                let mut found_close = false;
                for nc in chars.by_ref() {
                    if nc == ']' {
                        found_close = true;
                        break;
                    }
                    link_text.push(nc);
                }
                if found_close {
                    if chars.peek() == Some(&'(') {
                        chars.next();
                        let mut depth = 1usize;
                        for nc in chars.by_ref() {
                            if nc == '(' {
                                depth += 1;
                            } else if nc == ')' {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                        }
                        out.push_str(&strip_notify_markup(&link_text));
                    } else {
                        out.push('[');
                        out.push_str(&link_text);
                        out.push(']');
                    }
                } else {
                    out.push('[');
                    out.push_str(&link_text);
                }
            }
            _ => out.push(c),
        }
    }
    let lines: Vec<String> = out
        .lines()
        .map(|line| {
            let t = line.trim_start();
            let stripped = if t.starts_with("- ") || t.starts_with("* ") {
                &t[2..]
            } else {
                t
            };
            stripped.to_string()
        })
        .collect();
    let joined = if lines.len() > 1 {
        lines
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        lines.join(" ")
    };
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn note_assistant_text(session: &str, text: String) {
    if let Ok(mut g) = LAST_ASSISTANT_TEXT.lock() {
        g.insert(session.to_string(), text);
    }
}

pub fn take_assistant_text(session: &str) -> Option<String> {
    LAST_ASSISTANT_TEXT.lock().ok()?.remove(session)
}

/// The owner and prompt command whose turn was explicitly aborted. The marker
/// is set by the owner's `message_end` disposition and consumed at its terminal
/// `agent_end`; it cannot suppress a later owner or prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
struct AbortedTurn {
    owner: Option<crate::authority::session_state::SourceIdentity>,
    command_id: Option<String>,
}

static ABORTED_TURNS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, AbortedTurn>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

pub fn note_turn_aborted(
    session: &str,
    owner: Option<&crate::authority::session_state::SourceIdentity>,
    command_id: Option<&str>,
) {
    if let Ok(mut turns) = ABORTED_TURNS.lock() {
        turns.insert(
            session.to_owned(),
            AbortedTurn {
                owner: owner.cloned(),
                command_id: command_id.map(str::to_owned),
            },
        );
    }
}

/// A fresh start supersedes any disposition whose terminal event was lost.
pub fn clear_turn_aborted(session: &str) {
    if let Ok(mut turns) = ABORTED_TURNS.lock() {
        turns.remove(session);
    }
}

pub fn take_turn_aborted(
    session: &str,
    owner: Option<&crate::authority::session_state::SourceIdentity>,
    command_id: Option<&str>,
) -> bool {
    let Ok(mut turns) = ABORTED_TURNS.lock() else {
        return false;
    };
    let Some(turn) = turns.get(session) else {
        return false;
    };
    if turn.owner.as_ref() != owner || turn.command_id.as_deref() != command_id {
        return false;
    }
    turns.remove(session);
    true
}
/// Whether a terminal agent event belongs to an explicitly aborted turn.
/// The marker is consumed only by its exact owner/command; `stopReason` is
/// authoritative when the terminal event itself carries the disposition.
pub fn turn_was_aborted(
    session: &str,
    owner: Option<&crate::authority::session_state::SourceIdentity>,
    command_id: Option<&str>,
    stop_reason: Option<&str>,
) -> bool {
    take_turn_aborted(session, owner, command_id) || stop_reason == Some("aborted")
}

pub const TURN_FAILED_STALENESS: std::time::Duration = std::time::Duration::from_secs(120);
pub static LAST_TURN_FAILED: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
pub fn note_turn_failed(session: &str) {
    if let Ok(mut g) = LAST_TURN_FAILED.lock() {
        g.insert(session.to_string(), std::time::Instant::now());
    }
}
pub fn clear_turn_failed(session: &str) {
    if let Ok(mut g) = LAST_TURN_FAILED.lock() {
        g.remove(session);
    }
}
pub fn take_turn_failed(session: &str) -> bool {
    let mut g = match LAST_TURN_FAILED.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    match g.remove(session) {
        Some(t) => t.elapsed() < TURN_FAILED_STALENESS,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::push;

    #[test]
    fn aborted_stop_reason_suppresses_but_normal_reason_does_not() {
        let session = "aborted-stop-reason-regression";
        assert!(turn_was_aborted(session, None, None, Some("aborted")));
        assert!(!turn_was_aborted(session, None, None, Some("end_turn")));
    }

    #[test]
    fn aborted_completion_is_scoped_to_owner_and_command_then_cleared() {
        let session = "aborted-policy-regression";
        let owner = crate::authority::session_state::SourceIdentity {
            kind: crate::authority::session_state::SourceKind::Child,
            source_id: 900_001,
            binding_epoch: 1,
            pid: None,
            process_start: None,
            peer_id: None,
            room_id: None,
            can_write: None,
        };
        let next_owner = crate::authority::session_state::SourceIdentity {
            source_id: 900_002,
            ..owner.clone()
        };

        note_turn_aborted(session, Some(&owner), Some("stopped-command"));
        assert!(!take_turn_aborted(
            session,
            Some(&next_owner),
            Some("stopped-command")
        ));
        assert!(!take_turn_aborted(
            session,
            Some(&owner),
            Some("next-command")
        ));
        assert!(take_turn_aborted(
            session,
            Some(&owner),
            Some("stopped-command")
        ));
        assert!(!take_turn_aborted(
            session,
            Some(&owner),
            Some("stopped-command")
        ));

        note_turn_aborted(session, Some(&owner), Some("lost-terminal"));
        clear_turn_aborted(session);
        assert!(!take_turn_aborted(
            session,
            Some(&owner),
            Some("lost-terminal")
        ));
    }

    #[test]
    fn strip_markup_preserves_filenames_and_comparisons() {
        // Filenames and comparisons are the most common notification
        // content: the shade must show text that is right, not merely
        // unstyled.
        assert_eq!(
            strip_notify_markup("updated src/omp_store.ts"),
            "updated src/omp_store.ts"
        );
        assert_eq!(
            strip_notify_markup("__init__.py created"),
            "__init__.py created"
        );
        assert_eq!(
            strip_notify_markup("in ~/Coding/omp-pulse"),
            "in ~/Coding/omp-pulse"
        );
        assert_eq!(
            strip_notify_markup("count > 0 after fix"),
            "count > 0 after fix"
        );
        assert_eq!(strip_notify_markup("fixed #42"), "fixed #42");
        assert_eq!(strip_notify_markup("2 * 3"), "2 * 3");
    }

    #[test]
    fn strip_markup_flattens_real_markup() {
        assert_eq!(strip_notify_markup("**done**"), "done");
        assert_eq!(strip_notify_markup("`code`"), "code");
        assert_eq!(strip_notify_markup("# Heading"), "Heading");
        assert_eq!(strip_notify_markup("[text](http://x)"), "text");
    }

    /// A failed `message_end` marks the run so its `agent_end` does not ALSO
    /// buzz "agent finished"; a healthy follow-up run clears the marker.
    #[test]
    fn failed_turn_marker_is_consumed_and_cleared() {
        push::note_turn_failed("s1");
        assert!(
            push::take_turn_failed("s1"),
            "a fresh failure suppresses the agent_end buzz"
        );
        assert!(
            !push::take_turn_failed("s1"),
            "the marker is consumed exactly once"
        );

        push::note_turn_failed("s2");
        push::clear_turn_failed("s2");
        assert!(
            !push::take_turn_failed("s2"),
            "a new run clears a stale marker"
        );
    }

    #[test]
    fn summarise_assistant_reads_text_parts_and_ignores_the_rest() {
        // Thinking and tool blocks must never reach a lock screen.
        let msg = serde_json::json!({
            "content": [
                { "type": "thinking", "thinking": "SECRET REASONING" },
                { "type": "text", "text": "Done." },
                { "type": "toolCall", "id": "c1", "name": "bash" },
                { "type": "text", "text": " Tests pass." },
            ]
        });
        assert_eq!(
            push::summarise_assistant(&msg).as_deref(),
            Some("Done. Tests pass.")
        );
    }

    #[test]
    fn summarise_assistant_accepts_bare_string_content() {
        let msg = serde_json::json!({ "content": "Just a string" });
        assert_eq!(
            push::summarise_assistant(&msg).as_deref(),
            Some("Just a string")
        );
    }

    #[test]
    fn summarise_assistant_collapses_whitespace_to_one_line() {
        let msg = serde_json::json!({ "content": "line one\n\n  line   two\t" });
        assert_eq!(
            push::summarise_assistant(&msg).as_deref(),
            Some("line one line two")
        );
    }

    #[test]
    fn summarise_assistant_truncates_and_marks_it() {
        let long = "x".repeat(push::NOTIFY_BODY_MAX + 50);
        let msg = serde_json::json!({ "content": long });
        let out = push::summarise_assistant(&msg).expect("some text");
        assert_eq!(
            out.chars().count(),
            push::NOTIFY_BODY_MAX + 1,
            "body plus the ellipsis"
        );
        assert!(out.ends_with('…'));
    }

    #[test]
    fn summarise_assistant_declines_when_there_is_nothing_to_say() {
        // A turn that produced only tool calls has no readable text, and the
        // caller must fall back rather than push an empty body.
        let msg = serde_json::json!({ "content": [{ "type": "toolCall", "id": "c1" }] });
        assert_eq!(push::summarise_assistant(&msg), None);
        let blank = serde_json::json!({ "content": "   \n  " });
        assert_eq!(push::summarise_assistant(&blank), None);
    }

    #[test]
    fn assistant_text_marker_is_consumed_once() {
        push::note_assistant_text("sum-s1", "hello".to_string());
        assert_eq!(
            push::take_assistant_text("sum-s1").as_deref(),
            Some("hello")
        );
        assert_eq!(
            push::take_assistant_text("sum-s1"),
            None,
            "a second agent_end must not reuse it"
        );
    }
}
