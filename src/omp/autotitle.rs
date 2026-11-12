//! Titles for conversations the daemon's own RPC children run.
//!
//! omp generates a session title after the first message, but never in RPC
//! mode: it sets `PI_NO_TITLE` for `--mode rpc` regardless of flags. Every
//! conversation started from the phone therefore stayed untitled, and the
//! daemon used to paper over that by naming it after its cwd basename through
//! `set_session_name`, which omp records as a USER title and so also blocks
//! any later auto-title. Phone conversations all read like folder names
//! ("omp-pulse", "my-app") while laptop ones read like summaries of what
//! was asked.
//!
//! This module asks omp itself for the title in a one-shot, session-less
//! print run, so the same model and credentials produce it. Applying it is the
//! caller's job: only the session's single writer may set the name.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::Stdio,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use crate::sessions::jsonl;

const SYSTEM_PROMPT: &str = "You name coding-agent conversations. Reply with ONLY a title of 3 to 7 words in sentence case that names the concrete task, with no quotes, emoji or trailing punctuation. If the message has no identifiable task, reply NONE.";
/// The opening of a long first message carries its topic; the rest only costs tokens.
const MAX_INPUT_CHARS: usize = 2000;
const MAX_TITLE_CHARS: usize = 80;
/// A cold omp start plus one short completion measured ~8 s on the phone.
const GENERATE_TIMEOUT: Duration = Duration::from_secs(90);

/// Title generators running at once, across all sessions. Each is a cold
/// ~270 MB `omp -p` outside `ChildManager`, so `max_children`, the occupancy
/// count and the memory-pressure reaper never see it; uncapped, a few
/// untitled chats answered "hi"/"ok" at once pushed idle children out on the
/// phone. A prompt that finds the slot taken skips titling; a later message
/// retries.
const MAX_GENERATORS: usize = 1;
/// Wait after a miss (NONE, failure or timeout) before that session tries
/// again, doubling per consecutive miss up to [`MISS_BACKOFF_MAX`]. The model
/// answers NONE for "hi"/"continue", and without a wait every such message
/// started another generator.
const MISS_BACKOFF: Duration = Duration::from_secs(2 * 60);
const MISS_BACKOFF_MAX: Duration = Duration::from_secs(30 * 60);

static TITLING: LazyLock<Mutex<Titling>> = LazyLock::new(|| Mutex::new(Titling::default()));

/// Admission state for title generators.
#[derive(Default)]
struct Titling {
    /// Sessions with a generator running: a quick second prompt must not
    /// start another for the same conversation, and its size is the global
    /// count [`MAX_GENERATORS`] bounds.
    in_flight: HashSet<String>,
    /// Session → (consecutive misses, no retry before).
    backoff: HashMap<String, (u32, Instant)>,
}

impl Titling {
    fn admit(&mut self, session: &str, now: Instant) -> bool {
        if self.in_flight.len() >= MAX_GENERATORS || self.in_flight.contains(session) {
            return false;
        }
        if self
            .backoff
            .get(session)
            .is_some_and(|&(_, retry_at)| now < retry_at)
        {
            return false;
        }
        self.in_flight.insert(session.to_owned())
    }

    fn finish(&mut self, session: &str, titled: bool, now: Instant) {
        self.in_flight.remove(session);
        if titled {
            self.backoff.remove(session);
            return;
        }
        // Forget sessions whose last miss is long past, so the map stays
        // bounded by recently missed sessions.
        self.backoff
            .retain(|_, &mut (_, retry_at)| now < retry_at + MISS_BACKOFF_MAX);
        let misses = self.backoff.get(session).map_or(0, |&(m, _)| m) + 1;
        self.backoff
            .insert(session.to_owned(), (misses, now + miss_backoff(misses)));
    }
}

/// Wait after the `misses`-th consecutive miss (1-based).
fn miss_backoff(misses: u32) -> Duration {
    MISS_BACKOFF
        .saturating_mul(1 << misses.saturating_sub(1).min(8))
        .min(MISS_BACKOFF_MAX)
}

/// Exclusive right to title one session and one global generator slot;
/// released on drop. Dropped without [`Claim::titled`] counts as a miss.
pub struct Claim {
    session: String,
    titled: bool,
}

impl Claim {
    /// The session has a title now (applied, or named by hand meanwhile).
    pub fn titled(&mut self) {
        self.titled = true;
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        TITLING.lock().unwrap_or_else(|p| p.into_inner()).finish(
            &self.session,
            self.titled,
            Instant::now(),
        );
    }
}

/// `None` when the session has a generator running, the global slot is
/// taken, or the session missed recently: skip titling this prompt.
pub fn claim(session: &str) -> Option<Claim> {
    TITLING
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .admit(session, Instant::now())
        .then(|| Claim {
            session: session.to_owned(),
            titled: false,
        })
}

/// Whether this prompt should title the session: it has no title yet and the
/// text is a message, not a slash command or `!` shell line (omp skips those
/// for titles too). An untitled session retries on a later message, once
/// [`claim`] admits it. The
/// folder-name placeholder older daemons wrote counts as untitled
/// (`SessionHeader::chosen_title`), so those sessions get a real title too.
pub fn wants_title(session_file: &Path, text: &str) -> bool {
    let text = text.trim();
    !text.is_empty()
        && !text.starts_with('/')
        && !text.starts_with('!')
        && jsonl::parse_header(session_file).chosen_title().is_none()
}

/// Ask omp for a title for `text`. `model` is the session's `provider/id`
/// (empty = omp's default). `None` on any failure or a topic-less message.
pub async fn generate(omp_bin: &Path, model: &str, text: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(omp_bin);
    cmd.args([
        "-p",
        "--no-session",
        "--no-tools",
        "--no-lsp",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-title",
        "--thinking",
        "off",
        "--system-prompt",
        SYSTEM_PROMPT,
    ]);
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    // The positional message is prefixed so user text can never be read as a
    // flag or an `@file` include.
    let input: String = text.trim().chars().take(MAX_INPUT_CHARS).collect();
    cmd.arg(format!("First message of the conversation:\n{input}"))
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let out = match tokio::time::timeout(GENERATE_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => out,
        Ok(Ok(out)) => {
            tracing::warn!(status = %out.status, "autotitle: omp print run failed");
            return None;
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "autotitle: cannot spawn omp");
            return None;
        }
        Err(_) => {
            tracing::warn!("autotitle: omp print run timed out");
            return None;
        }
    };
    clean(&String::from_utf8_lossy(&out.stdout))
}

/// The model's reply as a one-line title, or `None` for NONE/empty.
fn clean(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    let line = line
        .trim_start_matches('#')
        .trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '`' | '*' | '“' | '”'))
        .trim()
        .trim_end_matches(['.', '!', ':'])
        .trim();
    if line.is_empty() || line.eq_ignore_ascii_case("none") {
        return None;
    }
    let flat = line.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(flat.chars().take(MAX_TITLE_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_takes_first_line_and_strips_decoration() {
        assert_eq!(
            clean("\n  \"Fix dictation on mobile.\"\nextra").as_deref(),
            Some("Fix dictation on mobile")
        );
        assert_eq!(
            clean("## **Review PR stack**").as_deref(),
            Some("Review PR stack")
        );
    }

    #[test]
    fn clean_rejects_none_and_empty() {
        assert_eq!(clean("NONE\n"), None);
        assert_eq!(clean("none."), None);
        assert_eq!(clean("  \n\n"), None);
        assert_eq!(clean("\"\""), None);
    }

    #[test]
    fn clean_bounds_length_on_char_boundaries() {
        let long = "é".repeat(200);
        assert_eq!(clean(&long).unwrap().chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn claim_is_exclusive_until_dropped() {
        let session = "/autotitle-claim-test.jsonl";
        let mut first = claim(session).expect("first claim");
        assert!(claim(session).is_none());
        first.titled();
        drop(first);
        let mut again = claim(session).expect("a titled session is not backed off");
        again.titled();
    }

    #[test]
    fn one_generator_runs_at_a_time_across_sessions() {
        let mut t = Titling::default();
        let now = Instant::now();
        assert!(t.admit("/a.jsonl", now));
        assert!(!t.admit("/a.jsonl", now), "same session: already running");
        assert!(!t.admit("/b.jsonl", now), "global slot taken: skip");
        t.finish("/a.jsonl", true, now);
        assert!(t.admit("/b.jsonl", now), "slot freed");
    }

    #[test]
    fn a_miss_backs_the_session_off_and_doubles_per_miss() {
        let mut t = Titling::default();
        let t0 = Instant::now();
        assert!(t.admit("/a.jsonl", t0));
        t.finish("/a.jsonl", false, t0);
        // "hi", "ok", "continue" right after a NONE start no generator.
        assert!(!t.admit("/a.jsonl", t0 + Duration::from_secs(5)));
        assert!(!t.admit("/a.jsonl", t0 + MISS_BACKOFF - Duration::from_secs(1)));
        // Other sessions are unaffected.
        assert!(t.admit("/b.jsonl", t0));
        t.finish("/b.jsonl", true, t0);
        let t1 = t0 + MISS_BACKOFF;
        assert!(t.admit("/a.jsonl", t1), "retries once the wait is over");
        t.finish("/a.jsonl", false, t1);
        assert!(
            !t.admit("/a.jsonl", t1 + MISS_BACKOFF),
            "second miss waits twice as long"
        );
        let t2 = t1 + 2 * MISS_BACKOFF;
        assert!(t.admit("/a.jsonl", t2));
        // A title clears the record.
        t.finish("/a.jsonl", true, t2);
        assert!(t.backoff.is_empty());
    }

    #[test]
    fn miss_backoff_is_capped() {
        assert_eq!(miss_backoff(1), MISS_BACKOFF);
        assert_eq!(miss_backoff(2), 2 * MISS_BACKOFF);
        assert_eq!(miss_backoff(30), MISS_BACKOFF_MAX);
        assert_eq!(miss_backoff(u32::MAX), MISS_BACKOFF_MAX);
    }
}
