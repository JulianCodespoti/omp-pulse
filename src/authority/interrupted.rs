//! Turns the daemon's own agents never finished. A tiny journal in the state
//! dir records a session when its child starts a turn and drops it when the
//! turn settles, so the turns still in it when the daemon starts are exactly
//! the ones a kill cut off. Those, and turns whose child died mid-flight, are
//! projected as `interrupted` on the session list and the chat until a new
//! turn starts or the user dismisses it. Nothing is ever resent on its own.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tracing::warn;

const FILE_NAME: &str = "turns-in-flight.json";
/// Transcript entries examined when deciding whether a journaled turn really
/// was cut off (its closing reply may have reached the file just before the
/// daemon died).
const TAIL_ENTRIES: usize = 64;

/// Why a turn was cut off. The phone words the banner from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cause {
    /// The daemon stopped (app killed, crash, restart) while it ran.
    Restart,
    /// The agent process exited while the daemon kept running.
    Exited,
}

/// One cut-off turn, as the wire carries it (`interrupted` on list rows,
/// history pages and the socket bundle).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interruption {
    /// When the turn started (epoch ms).
    pub started_at: u64,
    /// When the daemon found it cut off (epoch ms).
    pub detected_at: u64,
    pub cause: Cause,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    /// Session path → when its running turn started (epoch ms).
    #[serde(default)]
    in_flight: HashMap<String, u64>,
    #[serde(default)]
    interrupted: HashMap<String, Interruption>,
}

pub struct TurnJournal {
    /// None for an in-memory journal (tests).
    path: Option<PathBuf>,
    journal: Mutex<Journal>,
}

impl TurnJournal {
    /// Load the journal and settle what the previous daemon left running:
    /// every turn still in flight whose transcript does not show it finished
    /// becomes interrupted. Returns those sessions (for the one notification).
    /// A missing or unreadable file starts empty; this state is a courtesy,
    /// never a reason to refuse to start.
    pub fn open(state_dir: &Path, now: u64) -> (Self, Vec<String>) {
        let path = state_dir.join(FILE_NAME);
        let journal = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                warn!(error = %e, path = %path.display(), "unreadable turn journal; starting empty");
                Journal::default()
            }),
            Err(_) => Journal::default(),
        };
        let journal = Self {
            path: Some(path),
            journal: Mutex::new(journal),
        };
        let cut = journal.recover(now, |session, started| {
            crate::sessions::jsonl::turn_left_open(Path::new(session), started, TAIL_ENTRIES)
        });
        (journal, cut)
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        Self {
            path: None,
            journal: Mutex::new(Journal::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Journal> {
        self.journal.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Move every in-flight turn to `interrupted` when `left_open` says its
    /// transcript never closed it; drop the rest.
    fn recover(&self, now: u64, left_open: impl Fn(&str, u64) -> bool) -> Vec<String> {
        let mut journal = self.lock();
        if journal.in_flight.is_empty() {
            return Vec::new();
        }
        let mut cut = Vec::new();
        for (session, started_at) in std::mem::take(&mut journal.in_flight) {
            if left_open(session.as_str(), started_at) {
                journal.interrupted.insert(
                    session.clone(),
                    Interruption {
                        started_at,
                        detected_at: now,
                        cause: Cause::Restart,
                    },
                );
                cut.push(session);
            }
        }
        self.persist(&journal);
        cut
    }

    /// A turn started. Any earlier interruption is over: the user (or the
    /// agent) moved on. Only the daemon's own children are `tracked`: a
    /// desktop-owned turn keeps running on the desktop when the daemon dies.
    pub fn started(&self, session: &str, now: u64, tracked: bool) {
        let mut journal = self.lock();
        let mut changed = journal.interrupted.remove(session).is_some();
        if tracked && !journal.in_flight.contains_key(session) {
            journal.in_flight.insert(session.to_owned(), now);
            changed = true;
        }
        if changed {
            self.persist(&journal);
        }
    }

    /// The turn settled (finished, failed, stopped): nothing to recover.
    pub fn settled(&self, session: &str) {
        let mut journal = self.lock();
        if journal.in_flight.remove(session).is_some() {
            self.persist(&journal);
        }
    }

    /// The session's agent process exited. True when a turn was still in
    /// flight and its transcript leaves it open, which is now interrupted.
    pub fn agent_exited(&self, session: &str, now: u64) -> bool {
        self.exited(session, now, |session, started| {
            crate::sessions::jsonl::turn_left_open(Path::new(session), started, TAIL_ENTRIES)
        })
    }

    fn exited(&self, session: &str, now: u64, left_open: impl Fn(&str, u64) -> bool) -> bool {
        let started_at = {
            let mut journal = self.lock();
            let started_at = journal.in_flight.remove(session);
            if started_at.is_some() {
                self.persist(&journal);
            }
            started_at
        };
        let Some(started_at) = started_at else {
            return false;
        };
        // A turn whose `agent_end` the router never accepted still sits in
        // flight after it finished; the transcript has the last word, exactly
        // as at startup. Read outside the lock.
        if !left_open(session, started_at) {
            return false;
        }
        let mut journal = self.lock();
        journal.interrupted.insert(
            session.to_owned(),
            Interruption {
                started_at,
                detected_at: now,
                cause: Cause::Exited,
            },
        );
        self.persist(&journal);
        true
    }

    /// The user dismissed the notice. True when there was one.
    pub fn dismiss(&self, session: &str) -> bool {
        let mut journal = self.lock();
        let removed = journal.interrupted.remove(session).is_some();
        if removed {
            self.persist(&journal);
        }
        removed
    }

    pub fn get(&self, session: &str) -> Option<Interruption> {
        self.lock().interrupted.get(session).copied()
    }

    /// Write-then-rename, so a kill mid-write leaves the previous journal.
    /// A failed write is logged and the in-memory state stands.
    fn persist(&self, journal: &Journal) {
        let Some(path) = self.path.as_deref() else {
            return;
        };
        let result = (|| -> std::io::Result<()> {
            let bytes = serde_json::to_vec(journal).map_err(std::io::Error::other)?;
            let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
            let mut file = std::fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            drop(file);
            std::fs::rename(&temporary, path)
        })();
        if let Err(e) = result {
            warn!(error = %e, path = %path.display(), "turn journal write failed");
        }
    }
}

static JOURNAL: OnceLock<TurnJournal> = OnceLock::new();

/// Open the daemon's journal once at startup; returns the sessions a previous
/// daemon left mid-turn.
pub fn init(state_dir: &Path) -> Vec<String> {
    let (journal, cut) = TurnJournal::open(state_dir, crate::authority::activity::now_ms());
    let _ = JOURNAL.set(journal);
    cut
}

/// The daemon's journal; None before `init` (and in unit tests).
pub fn journal() -> Option<&'static TurnJournal> {
    JOURNAL.get()
}

/// The session's cut-off turn as the wire shows it: hidden while a live owner
/// is running a turn on it (an agent orphaned by the old daemon that is still
/// finishing, say), whatever the journal says.
pub fn visible(
    session: &str,
    authority: &crate::authority::session_state::SessionState,
) -> Option<Interruption> {
    use crate::authority::session_state::{Connection, Turn};
    if authority.turn == Turn::Running && authority.connection == Connection::Connected {
        return None;
    }
    get(session)
}

/// The session's cut-off turn, if one is showing.
pub fn get(session: &str) -> Option<Interruption> {
    journal()?.get(session)
}

/// What a notification and the banner say.
pub fn notice(cause: Cause) -> &'static str {
    match cause {
        Cause::Restart => "The app closed while the agent was working.",
        Cause::Exited => "The agent stopped while it was working.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_that_never_settled_is_interrupted_at_startup() {
        let journal = TurnJournal::in_memory();
        journal.started("/s/a.jsonl", 100, true);
        journal.started("/s/b.jsonl", 200, true);
        journal.started("/s/done.jsonl", 300, true);
        journal.settled("/s/done.jsonl");
        // b's closing reply reached the transcript before the kill.
        let cut = journal.recover(900, |session, _| session != "/s/b.jsonl");
        assert_eq!(cut, vec!["/s/a.jsonl".to_string()]);
        assert_eq!(
            journal.get("/s/a.jsonl"),
            Some(Interruption {
                started_at: 100,
                detected_at: 900,
                cause: Cause::Restart
            })
        );
        assert_eq!(journal.get("/s/b.jsonl"), None);
        assert_eq!(journal.get("/s/done.jsonl"), None);
        // Recovery runs once: nothing is left in flight to cut again.
        assert!(journal.recover(1000, |_, _| true).is_empty());
    }

    const OPEN: fn(&str, u64) -> bool = |_, _| true;

    #[test]
    fn a_new_turn_or_a_dismissal_clears_it() {
        let journal = TurnJournal::in_memory();
        journal.started("/s/a.jsonl", 100, true);
        assert!(journal.exited("/s/a.jsonl", 150, OPEN));
        assert_eq!(
            journal.get("/s/a.jsonl").map(|i| i.cause),
            Some(Cause::Exited)
        );
        // A desktop turn is not tracked, but it still moves the chat on.
        journal.started("/s/a.jsonl", 200, false);
        assert_eq!(journal.get("/s/a.jsonl"), None);
        assert!(
            !journal.exited("/s/a.jsonl", 250, OPEN),
            "untracked turns never interrupt"
        );

        journal.started("/s/b.jsonl", 300, true);
        assert!(journal.exited("/s/b.jsonl", 350, OPEN));
        assert!(journal.dismiss("/s/b.jsonl"));
        assert!(!journal.dismiss("/s/b.jsonl"));
        assert_eq!(journal.get("/s/b.jsonl"), None);
    }

    #[test]
    fn a_settled_turn_does_not_interrupt_when_its_process_exits() {
        let journal = TurnJournal::in_memory();
        journal.started("/s/a.jsonl", 100, true);
        journal.settled("/s/a.jsonl");
        assert!(!journal.exited("/s/a.jsonl", 200, OPEN));
        assert_eq!(journal.get("/s/a.jsonl"), None);
        // A finished turn whose end the router missed: the transcript closes it.
        journal.started("/s/b.jsonl", 300, true);
        assert!(!journal.exited("/s/b.jsonl", 400, |_, _| false));
        assert_eq!(journal.get("/s/b.jsonl"), None);
        assert!(
            !journal.exited("/s/b.jsonl", 500, OPEN),
            "no longer in flight"
        );
    }

    #[test]
    fn the_journal_survives_a_restart_on_disk() {
        let dir =
            std::env::temp_dir().join(format!("omp-pulse-turn-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A transcript cut off mid-tool: its newest message is a tool call.
        let session = dir.join("s.jsonl");
        std::fs::write(
            &session,
            "{\"type\":\"session\",\"id\":\"s\"}\n\
             {\"type\":\"message\",\"timestamp\":\"2026-10-14T10:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n\
             {\"type\":\"message\",\"timestamp\":\"2026-10-14T10:00:05.000Z\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"toolUse\",\"content\":[]}}\n",
        )
        .unwrap();
        let session = session.to_string_lossy().into_owned();
        let started = 1_791_972_000_000; // 2026-10-14T10:00:00Z
        {
            let (journal, cut) = TurnJournal::open(&dir, 1);
            assert!(cut.is_empty());
            journal.started(&session, started, true);
        }
        let (journal, cut) = TurnJournal::open(&dir, 2);
        assert_eq!(cut, vec![session.clone()]);
        assert_eq!(journal.get(&session).map(|i| i.started_at), Some(started));
        // Still showing after another restart, until dismissed.
        drop(journal);
        let (journal, cut) = TurnJournal::open(&dir, 3);
        assert!(cut.is_empty(), "one notification per interruption");
        assert!(journal.get(&session).is_some());
        assert!(journal.dismiss(&session));
        let (journal, _) = TurnJournal::open(&dir, 4);
        assert_eq!(journal.get(&session), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
