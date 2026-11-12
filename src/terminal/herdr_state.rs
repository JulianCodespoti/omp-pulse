//! Live agent-state oracle for laptop-driven sessions.
//!
//! WHY: the listing's `Running` flag for foreign (laptop TUI) sessions used to
//! be pure inference — file legs (partial line, recent mtime, user-last tail)
//! plus young-process heuristics. That misses a model thinking with no side
//! effects yet, and over-reads browsers holding files. herdr already tracks
//! every agent pane it manages as `idle | working | blocked | done | unknown`,
//! reported hook-by-hook from omp's own event bus once the official
//! `herdr-omp-agent-state` extension is installed (`herdr integration install
//! omp`; loads at omp startup, so pre-existing TUIs keep screen detection
//! until restarted). Without the extension herdr still reports screen-detected
//! state, which is weaker but strictly more signal than no oracle.
//!
//! Design: ONE background task polls `herdr agent list` (measured 40 ms) every
//! second and keeps a pane→status map; any change pokes `index` for a refresh,
//! which re-renders the listing and nudges clients. The scan path itself never
//! spawns a subprocess — it reads the map plus one `/proc/<owner>/environ`
//! lookup per owner (adopt.rs already does the same for cmdlines). Polling
//! rather than the socket `pane_agent_status_changed` subscription is
//! deliberate: no wire-format dependency on herdr's evolving API, and 40 ms/s
//! is noise. If herdr is absent the task idles — heuristics carry on as before.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing::{info, warn};
/// herdr's agent states (socket API `AgentStatus` enum). Anything unrecognized
/// maps to `Unknown`, which — like `Idle`/`Done` — contributes nothing: an
/// oracle we cannot parse must never mark a session running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HerdrStatus {
    Working,
    Blocked,
    Idle,
    Done,
    Unknown,
}

impl HerdrStatus {
    fn parse(s: &str) -> Self {
        match s {
            "working" => Self::Working,
            "blocked" => Self::Blocked,
            "idle" => Self::Idle,
            "done" => Self::Done,
            _ => Self::Unknown,
        }
    }
}
/// A herdr reading for one pane: the status plus when it was taken and whether
/// it is still inside the freshness window. A stale reading is still returned
/// (callers decide how to present it) but never counts as current.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HerdrObservation {
    pub status: HerdrStatus,
    pub observed_at_ms: u64,
    pub stale: bool,
}

#[derive(Debug, Default)]
struct PollHealth {
    last_success: Option<std::time::Instant>,
    observed_at_ms: Option<u64>,
    stale: bool,
}

/// One pane's oracle view: what the agent is doing and which session file it
/// is doing it in. `session` comes from the extension's self-report
/// (`agent_session.value`, `kind:"path"`); `None` for panes whose agent never
/// reported (screen-detected only, or no conversation loaded — e.g. a fresh
/// welcome screen, which correctly maps to nothing). `seq` is herdr's
/// per-pane `state_change_seq`: episode identity for blocked buzzes — a
/// re-block bumps it, so question 2 of a chain buzzes even inside one poll
/// tick (0 when herdr omits it; then episodes collapse to question-identity,
/// no worse than before).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneState {
    pub status: HerdrStatus,
    pub session: Option<String>,
    pub seq: u64,
}

#[derive(Debug, Default)]
pub struct HerdrState {
    inner: Mutex<HashMap<String, PaneState>>,
    overlay: Mutex<HashMap<String, String>>,
    health: Mutex<PollHealth>,
}

impl HerdrState {
    /// Current status for one pane, if herdr has ever reported it and the
    /// observation is still within the bounded freshness window.
    pub fn status(&self, pane: &str) -> Option<HerdrStatus> {
        self.observation(pane)
            .filter(|o| !o.stale)
            .map(|o| o.status)
    }

    pub fn observation(&self, pane: &str) -> Option<HerdrObservation> {
        let (observed_at_ms, stale) = {
            let health = self.health.lock().unwrap_or_else(|p| p.into_inner());
            (
                health.observed_at_ms?,
                health.stale
                    || health
                        .last_success
                        .is_some_and(|at| at.elapsed() >= HERDR_STALE_AFTER),
            )
        };
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(pane)
            .map(|p| p.status)?;
        Some(HerdrObservation {
            status: state,
            observed_at_ms,
            stale,
        })
    }

    /// Reverse lookup: which pane holds a session file. The fd-derived
    /// overlay wins over self-report (direct proof beats a possibly stale
    /// report) AND suppresses it: a pane the overlay maps elsewhere cannot
    /// also resolve through its old self-report, or answers would land on a
    /// session the pane no longer holds. Panes without overlay entries
    /// resolve through self-report normally; both scans are over a handful
    /// of panes.
    pub fn pane_for_session(&self, session_path: &str) -> Option<String> {
        let overlay = self.overlay.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(pane) = overlay
            .iter()
            .find(|(_, s)| s.as_str() == session_path)
            .map(|(pane, _)| pane.clone())
        {
            return Some(pane);
        }
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(pane, _)| !overlay.contains_key(*pane))
            .find(|(_, p)| p.session.as_deref() == Some(session_path))
            .map(|(pane, _)| pane.clone())
    }

    /// Replace the fd-derived overlay wholesale (the scan rebuilds it per
    /// refresh from owner pid → held file → pane; empty when herdr is
    /// absent). Rebuilt, never patched: a closed pane's mapping cannot
    /// linger past one scan.
    pub fn set_session_overlay(&self, overlay: HashMap<String, String>) {
        *self.overlay.lock().unwrap_or_else(|p| p.into_inner()) = overlay;
    }

    /// How many panes the snapshot holds (the scan's gate for the `/proc`
    /// environ sweep: no panes means no herdr owners to find).
    fn len(&self) -> usize {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).len()
    }
    /// Swap in a fresh snapshot and refresh its freshness deadline. The
    /// boolean only reflects state/staleness changes; an unchanged successful
    /// poll therefore refreshes freshness without waking the index or
    /// changing the serialized observed timestamp.
    fn replace(&self, next: HashMap<String, PaneState>) -> bool {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let changed = *guard != next;
        *guard = next;
        drop(guard);
        let mut health = self.health.lock().unwrap_or_else(|p| p.into_inner());
        let stale_changed = health.stale;
        health.last_success = Some(std::time::Instant::now());
        if changed || stale_changed || health.observed_at_ms.is_none() {
            health.observed_at_ms = Some(now_epoch_ms());
        }
        health.stale = false;
        if changed || stale_changed {
            BLOCKED_MAY_CHANGE.notify_one();
        }
        changed || stale_changed
    }

    /// Mark a failed poll. Once the bounded freshness window expires, the
    /// transition wakes the index so stale oracle evidence cannot pin
    /// authoritative `running` forever.
    fn mark_failed(&self) -> bool {
        let mut health = self.health.lock().unwrap_or_else(|p| p.into_inner());
        if health
            .last_success
            .is_some_and(|t| t.elapsed() >= HERDR_STALE_AFTER)
            && !health.stale
        {
            health.stale = true;
            return true;
        }
        false
    }

    fn counts(&self) -> (usize, usize, usize) {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut working = 0;
        let mut blocked = 0;
        for p in guard.values() {
            match p.status {
                HerdrStatus::Working => working += 1,
                HerdrStatus::Blocked => blocked += 1,
                _ => {}
            }
        }
        (guard.len(), working, blocked)
    }
    /// Panes currently `Blocked`: (pane, session, seq). `session` is None for
    /// screen-detected panes whose agent never self-reported — the watcher
    /// logs those loudly (answer delivery and push deep-link both need a
    /// file, so they cannot buzz, but silence must be visible).
    fn blocked_snapshot(&self) -> Vec<(String, Option<String>, u64)> {
        if self.health.lock().unwrap_or_else(|p| p.into_inner()).stale {
            return Vec::new();
        }
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(_, p)| p.status == HerdrStatus::Blocked)
            .map(|(pane, p)| (pane.clone(), p.session.clone(), p.seq))
            .collect()
    }
}
static GLOBAL: OnceLock<Arc<HerdrState>> = OnceLock::new();
/// Wakes the blocked watcher while nothing is blocked: a pane can only become
/// blocked through a changed `replace`. `notify_one` keeps the permit when the
/// watcher is between its snapshot and its wait.
static BLOCKED_MAY_CHANGE: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub fn global() -> Option<Arc<HerdrState>> {
    GLOBAL.get().cloned()
}

pub fn set_global(state: Arc<HerdrState>) {
    let _ = GLOBAL.set(state);
}

/// Maximum age of a successful herdr observation. Beyond this, old `working`
/// evidence is explicitly stale/unknown rather than authoritative.
const HERDR_STALE_AFTER: Duration = Duration::from_secs(5);

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Herdr status for a session owner, including provenance/freshness.
pub fn observation_for_owner(owner_pid: Option<i32>) -> Option<HerdrObservation> {
    let state = GLOBAL.get()?;
    let pid = owner_pid?;
    let pane = crate::terminal::adopt::herdr_pane_of(pid)?;
    state.observation(&pane)
}

/// herdr status for a session owner, via its `HERDR_PANE_ID` environment.
pub fn status_for_owner(owner_pid: Option<i32>) -> Option<HerdrStatus> {
    observation_for_owner(owner_pid)
        .filter(|o| !o.stale)
        .map(|o| o.status)
}
/// Blocked-pane snapshot against the process-global oracle; empty when unset.
/// Each entry is (pane, session, seq). The push watcher keys episodes on
/// (pane, session, seq, question-hash): a re-block bumps seq, a new question
/// changes the hash — either buzzes, steady state never does.
pub fn blocked_snapshot_global() -> Vec<(String, Option<String>, u64)> {
    GLOBAL
        .get()
        .map(|s| s.blocked_snapshot())
        .unwrap_or_default()
}

/// Watch blocked episodes and buzz once each. Episode identity is
/// (pane, session, seq-at-entry, question-hash): answering clears the pane
/// from the snapshot, and any re-block carries a new seq, so question 2 of a
/// chain buzzes even inside one tick; a new question under a stale seq still
/// buzzes via the hash. Steady state repeats identically and stays silent.
/// Dedup lives HERE (question-identity), not in the push layer's 30 s
/// session window — which exists for bursty re-emitters and would swallow
/// genuine chains — so this path calls `notify_with_req_id` directly.
/// Panes blocked with no reported session cannot buzz (no deep-link target,
/// no answer target) and are logged loudly instead: an extension-less TUI is
/// a setup gap doctor should surface, not silence to swallow.
pub fn spawn_blocked_watcher(push: Arc<crate::server::push::Push>) {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    fn question_hash(question: &str) -> u64 {
        let mut h = DefaultHasher::new();
        question.hash(&mut h);
        h.finish()
    }
    tokio::spawn(async move {
        // (pane, session) -> (seq, question-hash) at last buzz.
        let mut known: std::collections::HashMap<(String, String), (u64, u64)> =
            std::collections::HashMap::new();
        // Panes already warned as sessionless-blocked (cleared when they
        // leave the state, so a later episode warns again).
        let mut warned: std::collections::HashSet<String> = std::collections::HashSet::new();
        loop {
            // Sample FIRST: a restart during a block must buzz on this tick,
            // not after a sleep.
            let current = blocked_snapshot_global();
            let mut next_known = std::collections::HashMap::new();
            let mut next_warned = std::collections::HashSet::new();
            for (pane, session, seq) in &current {
                let Some(session) = session else {
                    if !warned.contains(pane) {
                        warn!(
                            pane,
                            "pane blocked with no reported session: install the herdr-omp extension (`herdr integration install omp`) and restart the TUI"
                        );
                    }
                    next_warned.insert(pane.clone());
                    continue;
                };
                let ask = crate::sessions::jsonl::pending_ask(std::path::Path::new(session));
                let question = ask.as_ref().map(|a| a.question.clone()).unwrap_or_default();
                let key = (pane.clone(), session.clone());
                let id = (*seq, question_hash(&question));
                next_known.insert(key.clone(), id);
                if known.get(&key) == Some(&id) {
                    continue;
                }
                known.insert(key, id);
                let body = match &ask {
                    Some(a) if !a.options.is_empty() => {
                        format!("{} ({})", a.question, a.options.join(" / "))
                    }
                    Some(a) => a.question.clone(),
                    None => "needs your answer".to_string(),
                };
                let body: String = if body.chars().count() <= 120 {
                    body
                } else {
                    body.chars().take(120).collect()
                };
                info!(pane, %session, "pane blocked, pushing needs-input");
                let push = Arc::clone(&push);
                let title = crate::server::push::session_title(session);
                let session = session.clone();
                tokio::spawn(async move {
                    push.notify_with_req_id(
                        &session,
                        &title,
                        &body,
                        crate::server::push::KIND_NEEDS_INPUT,
                        None,
                    )
                    .await;
                });
            }
            known.retain(|k, _| next_known.contains_key(k));
            warned = next_warned;
            // While a pane is blocked its question is re-read every second
            // (a new ask keeps the same seq); with none blocked, or no herdr
            // at all, nothing can change until the poller's next `replace`.
            if current.is_empty() {
                BLOCKED_MAY_CHANGE.notified().await;
            } else {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    });
}

/// Pane count against the process-global snapshot; 0 when the oracle is
/// unset (tests) or herdr reports nothing.
pub fn pane_count_global() -> usize {
    GLOBAL.get().map(|s| s.len()).unwrap_or(0)
}

/// Pane status against the process-global snapshot (the answer endpoint's
/// still-blocked guard re-checks this at send time).
pub fn status_for_pane_global(pane: &str) -> Option<HerdrStatus> {
    GLOBAL.get()?.status(pane)
}

/// How many answers the phone has typed into each session's current `ask`
/// (session -> (tool call id, count)). omp's `ask` walks its questions in one
/// call and records nothing until the last is answered, so this ledger is the
/// only record of which question the laptop is on now. A new call id resets
/// it. Answers typed on the laptop itself are not seen here; the phone's
/// index guard (`answer_pane`) keeps a stale sheet from misapplying one.
static ASK_ANSWERS: std::sync::LazyLock<Mutex<HashMap<String, (String, usize)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Answers delivered so far to `call_id` in `session`.
pub fn ask_answers_delivered(session: &str, call_id: &str) -> usize {
    let ledger = ASK_ANSWERS.lock().unwrap_or_else(|p| p.into_inner());
    match ledger.get(session) {
        Some((id, n)) if id == call_id => *n,
        _ => 0,
    }
}

/// Record one delivered answer to `call_id` in `session`.
pub fn record_ask_answer(session: &str, call_id: &str) {
    let mut ledger = ASK_ANSWERS.lock().unwrap_or_else(|p| p.into_inner());
    let entry = ledger
        .entry(session.to_string())
        .or_insert_with(|| (call_id.to_string(), 0));
    if entry.0 != call_id {
        *entry = (call_id.to_string(), 0);
    }
    entry.1 += 1;
}
/// Cap on `herdr agent send-keys` (a wedged herdr must never hang an answer).
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
/// Answers are typed key-by-key, not pasted — bounding length bounds risk.
const MAX_ANSWER_CHARS: usize = 500;

/// Answer-text rules, shared by the endpoint so both are unit-tested in one
/// place: non-empty, bounded, no control characters (a stray ESC or newline
/// inside the text would act on the pane, not answer the question).
pub fn validate_answer_text(text: &str) -> Result<(), &'static str> {
    let n = text.chars().count();
    if n == 0 {
        return Err("answer text required");
    }
    if n > MAX_ANSWER_CHARS {
        return Err("answer too long (500 characters)");
    }
    if text.chars().any(|c| c.is_control()) {
        return Err("answer must be plain text");
    }
    Ok(())
}

/// Type an answer into a pane's blocked dialog, verbatim: `pane send-text`
/// writes the bytes with no key-name lookup (spaces, punctuation and paths
/// go out exactly as typed — the per-character `send-keys` form rejects
/// anything but bare alphanumerics atomically), then a separate `send-keys
/// enter` submits, mirroring what a laptop user presses. Pane-level commands
/// throughout (`pane_id`, never an agent name): agent targets also resolve
/// by name, and a name collision would submit into the wrong pane silently
/// instead of erroring. Fire-and-forget at the herdr layer (delivery, not
/// dialog acceptance — the pane leaving `blocked` is the real confirmation,
/// visible on the next poll).
pub async fn send_answer(pane: &str, text: &str) -> Result<(), String> {
    let Some(bin) = crate::terminal::adopt::herdr_bin() else {
        return Err("herdr is not installed".to_string());
    };
    run_herdr(&bin, &["pane", "send-text", pane, text], "send-text").await?;
    // The dialog may have cleared between the guard at the endpoint and the
    // text landing: typing Enter into whatever the pane is doing now is the
    // exact hazard the still-blocked guard exists for, so re-check before
    // submitting. Typed-but-unsubmitted text is left for the owner — visible
    // and harmless, unlike a blind submit.
    if status_for_pane_global(pane) != Some(HerdrStatus::Blocked) {
        return Err(
            "pane left blocked state before submit; text was typed but not submitted".to_string(),
        );
    }
    run_herdr(&bin, &["pane", "send-keys", pane, "enter"], "send-keys").await?;
    Ok(())
}
/// Select in omp's rich Ask picker. Pasting a digit does not select an option:
/// it used to accept the highlighted default, then strand the final review tab.
pub async fn send_ask_answer(
    pane: &str,
    ask: &crate::sessions::jsonl::PendingAsk,
    index: usize,
    option: Option<usize>,
    text: &str,
) -> Result<(), String> {
    let question = ask
        .questions
        .get(index)
        .ok_or("ask has already been answered")?;
    let target = option.unwrap_or(question.options.len());
    if option.is_some_and(|i| i >= question.options.len()) {
        return Err("answer option is out of range".into());
    }
    let bin = crate::terminal::adopt::herdr_bin().ok_or("herdr is not installed")?;
    let screen = read_pane(&bin, pane).await?;
    if !ask_header_matches(&screen, &question.question)
        || screen.contains("Finish or clear the current prompt to answer")
    {
        return Err("the computer’s dialog changed; no answer was sent".into());
    }
    // Up clamps at the first option, independent of recommendation or cursor.
    let mut keys = Vec::with_capacity(4 + question.options.len() + target);
    keys.extend(["pane", "send-keys", pane]);
    keys.extend(std::iter::repeat_n("up", question.options.len()));
    keys.extend(std::iter::repeat_n("down", target));
    // Space toggles in both installed and newer omp pickers; Enter differs.
    keys.push(if question.multi && option.is_some() {
        "space"
    } else {
        "enter"
    });
    run_herdr(&bin, &keys, "select Ask option").await?;
    if option.is_none() {
        wait_for_pane(&bin, pane, |screen| {
            screen
                .rsplit_once("╭─ Custom answer: ")
                .is_some_and(|(_, editor)| {
                    editor.contains("submit") && editor.contains("external editor")
                })
        })
        .await?;
        send_answer(pane, text).await?;
    }
    if question.multi {
        // Tab advances without depending on version-specific Enter behavior.
        wait_for_pane(&bin, pane, |s| ask_header_matches(s, &question.question)).await?;
        run_herdr(
            &bin,
            &["pane", "send-keys", pane, "tab"],
            "advance Ask question",
        )
        .await?;
    }
    if let Some(next) = ask.questions.get(index + 1) {
        wait_for_pane(&bin, pane, |s| ask_header_matches(s, &next.question)).await?;
    } else if ask.questions.len() > 1 || question.multi {
        wait_for_pane(&bin, pane, |s| ask_header_matches(s, "Review answers")).await?;
        // Do not send this Enter to a resumed prompt: verify the review surface.
        run_herdr(
            &bin,
            &["pane", "send-keys", pane, "enter"],
            "submit Ask answers",
        )
        .await?;
    }
    Ok(())
}

fn ask_header_matches(screen: &str, expected: &str) -> bool {
    let Some((_, dialog)) = screen.rsplit_once("╭─ Ask ") else {
        return false;
    };
    let header = dialog.split("\n├").next().unwrap_or_default();
    let normalize = |text: &str| {
        text.chars()
            .filter(|c| !c.is_whitespace() && !(('─'..='╿').contains(c)))
            .collect::<String>()
    };
    normalize(header).contains(&normalize(expected))
}

async fn read_pane(bin: &std::path::Path, pane: &str) -> Result<String, String> {
    let out = run_herdr_output(
        bin,
        &[
            "pane", "read", pane, "--source", "visible", "--format", "text",
        ],
        "read Ask dialog",
    )
    .await?;
    String::from_utf8(out.stdout).map_err(|_| "computer’s dialog is not UTF-8".into())
}

async fn wait_for_pane(
    bin: &std::path::Path,
    pane: &str,
    matches: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + SEND_TIMEOUT;
    loop {
        if status_for_pane_global(pane) != Some(HerdrStatus::Blocked) {
            return Err("computer stopped waiting for this answer".into());
        }
        if matches(&read_pane(bin, pane).await?) {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(
                "computer did not advance the Ask dialog; check its current question before retrying"
                    .into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn run_herdr(bin: &std::path::Path, args: &[&str], what: &str) -> Result<(), String> {
    run_herdr_output(bin, args, what).await.map(|_| ())
}

async fn run_herdr_output(
    bin: &std::path::Path,
    args: &[&str],
    what: &str,
) -> Result<std::process::Output, String> {
    let out = tokio::time::timeout(
        SEND_TIMEOUT,
        tokio::process::Command::new(bin)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| format!("herdr {what} timed out"))?
    .map_err(|e| format!("herdr not runnable: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("herdr {what} failed")
        } else {
            err
        });
    }
    Ok(out)
}
/// Parse `herdr agent list` output into a pane→state map. Each agent carries
/// `pane_id`, `agent_status`, and (when the omp extension reported it)
/// `agent_session: {kind, value}` with the session file path. Lenient by
/// design: herdr owns this schema; entries missing pane or status are
/// skipped, unrecognized states become `Unknown` (never running), and a
/// non-path or absent session maps to `None` (the pane may hold no
/// conversation — e.g. a fresh welcome screen).
pub fn parse_agent_list(raw: &str) -> HashMap<String, PaneState> {
    serde_json::from_str(raw)
        .map(|value| agent_states(&value))
        .unwrap_or_default()
}

/// Decode an already-parsed reply without serializing it back through JSON.
pub(crate) fn agent_states(v: &serde_json::Value) -> HashMap<String, PaneState> {
    let mut out = HashMap::new();
    let agents = v
        .get("result")
        .and_then(|r| r.get("agents"))
        .and_then(|a| a.as_array());
    let Some(agents) = agents else {
        return out;
    };
    for a in agents {
        let (Some(pane), Some(status)) = (
            a.get("pane_id").and_then(|p| p.as_str()),
            a.get("agent_status").and_then(|s| s.as_str()),
        ) else {
            continue;
        };
        let session = a
            .get("agent_session")
            .and_then(|s| {
                (s.get("kind").and_then(|k| k.as_str()) == Some("path"))
                    .then(|| s.get("value"))
                    .flatten()
            })
            .and_then(|v| v.as_str())
            .filter(|v| v.ends_with(".jsonl"))
            .map(str::to_string);
        let seq = a
            .get("state_change_seq")
            .and_then(|s| s.as_u64())
            .unwrap_or(0);
        out.insert(
            pane.to_string(),
            PaneState {
                status: HerdrStatus::parse(status),
                session,
                seq,
            },
        );
    }
    out
}
/// Reverse lookup against the process-global snapshot (the scan path's view).
/// None when the oracle is unset or no pane reports the session.
pub fn pane_for_session_global(session_path: &str) -> Option<String> {
    GLOBAL.get()?.pane_for_session(session_path)
}
/// Pids per herdr pane, resolved by sweeping `/proc` environments for
/// `HERDR_PANE_ID` (which herdr exports into everything it spawns — the same
/// authority adopt.rs uses per-pid). Linux-only like the rest of the
/// ownership machinery; elsewhere there are no herdr panes to find.
/// Excludes nothing: callers filter to live omp-like processes themselves.
pub fn pane_pids() -> HashMap<String, Vec<i32>> {
    #[cfg(target_os = "linux")]
    {
        sweep_pane_pids()
    }
    #[cfg(not(target_os = "linux"))]
    {
        HashMap::new()
    }
}

/// The Linux sweep behind [`pane_pids`]: every numeric `/proc` pid whose
/// environ carries `HERDR_PANE_ID`, grouped by pane. Unreadable entries
/// (exited mid-sweep, permissions) are skipped — this is a snapshot, not an
/// audit.
#[cfg(target_os = "linux")]
fn sweep_pane_pids() -> HashMap<String, Vec<i32>> {
    let mut out: HashMap<String, Vec<i32>> = HashMap::new();
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in procs.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|n| n.parse::<i32>().ok()) else {
            continue;
        };
        let Ok(raw) = std::fs::read(format!("/proc/{pid}/environ")) else {
            continue;
        };
        for var in raw.split(|b| *b == 0) {
            let Some(pane) = var
                .strip_prefix(b"HERDR_PANE_ID=")
                .and_then(|v| std::str::from_utf8(v).ok())
            else {
                continue;
            };
            // A pane id never contains '=' or NUL; a corrupt environ
            // block must not mint a junk key.
            if !pane.is_empty() && pane.bytes().all(|b| b != b'=') {
                out.entry(pane.to_string()).or_default().push(pid);
            }
            break;
        }
    }
    out
}

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const ABSENT_RETRY: Duration = Duration::from_secs(30);
const LIST_TIMEOUT: Duration = Duration::from_secs(5);

/// Poll `herdr agent list` forever, refreshing the listing on every state
/// change. Detached task: started once from `cmd_serve`, never awaited.
pub fn spawn_poller(herdr: Arc<HerdrState>, app: Arc<crate::server::http::AppState>) {
    tokio::spawn(async move {
        let mut announced = false;
        let mut last_error: Option<String> = None;
        loop {
            let Some(bin) = crate::terminal::adopt::herdr_bin() else {
                // If herdr disappears after a successful observation, its
                // previous working state must still expire rather than pin
                // running forever.
                if herdr.mark_failed() {
                    crate::sessions::index::trigger_refresh(&app);
                }
                let fresh = herdr
                    .health
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .last_success
                    .is_some_and(|at| at.elapsed() < HERDR_STALE_AFTER);
                // Keep ticking until the last observation expires. Sleeping
                // for the absent-binary retry interval first would leave
                // yesterday's running status authoritative for another 30s.
                tokio::time::sleep(if fresh { POLL_INTERVAL } else { ABSENT_RETRY }).await;
                continue;
            };
            match run_agent_list(&bin).await {
                Ok(map) => {
                    if !announced {
                        announced = true;
                        info!(panes = map.len(), bin = %bin.display(), "herdr oracle live");
                    }
                    last_error = None;
                    if herdr.replace(map) {
                        let (panes, working, blocked) = herdr.counts();
                        info!(panes, working, blocked, "herdr agent states changed");
                        crate::sessions::index::trigger_refresh(&app);
                    }
                }
                Err(why) => {
                    // Once per distinct reason, with the reason: the old
                    // bare line repeated every second for hours and never
                    // said the client was too old for the server.
                    if last_error.as_deref() != Some(why.as_str()) {
                        warn!(bin = %bin.display(), reason = %why, "herdr agent list failed; oracle blind until it recovers");
                        last_error = Some(why);
                    }
                    if herdr.mark_failed() {
                        crate::sessions::index::trigger_refresh(&app);
                    }
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}
async fn run_agent_list(bin: &std::path::Path) -> Result<HashMap<String, PaneState>, String> {
    let out = tokio::time::timeout(
        LIST_TIMEOUT,
        tokio::process::Command::new(bin)
            .args(["agent", "list"])
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "timed out".to_string())?
    .map_err(|e| format!("spawn: {e}"))?;
    if !out.status.success() {
        // herdr reports errors as JSON on stdout or stderr; keep a bounded
        // excerpt so the log names the problem (e.g. protocol_mismatch).
        let text = if out.stdout.is_empty() {
            &out.stderr
        } else {
            &out.stdout
        };
        let excerpt: String = String::from_utf8_lossy(text)
            .trim()
            .chars()
            .take(240)
            .collect();
        return Err(format!(
            "exit {}: {excerpt}",
            out.status.code().unwrap_or(-1)
        ));
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    Ok(parse_agent_list(&raw))
}
#[cfg(test)]
mod tests {
    use super::*;

    // Captured live `herdr agent list`, trimmed to the fields the parser
    // reads plus decoys. w1:p2W's agent never reported a session (None).
    const LIST_IDLE: &str = r#"{"id":"cli:agent:list","result":{"agents":[
        {"pane_id":"w1:p2X","agent_status":"idle","state_change_seq":47,"cwd":"/home/u/App","agent_session":{"agent":"omp","kind":"path","source":"herdr:omp","value":"/home/u/.local/share/omp/sessions/-Coding-App/a.jsonl"}},
        {"pane_id":"w1:p2W","agent_status":"idle","cwd":"/home/u/Else","agent_session":null},
        {"pane_id":"w1:p2Y","agent_status":"idle","cwd":"/home/u/Coding"}]}}"#;

    #[test]
    fn parses_live_agent_list() {
        let map = parse_agent_list(LIST_IDLE);
        assert_eq!(map.len(), 3);
        let x = &map["w1:p2X"];
        assert_eq!(x.status, HerdrStatus::Idle);
        assert_eq!(
            x.session.as_deref(),
            Some("/home/u/.local/share/omp/sessions/-Coding-App/a.jsonl")
        );
        assert_eq!(map["w1:p2X"].seq, 47);
        assert_eq!(map["w1:p2W"].session, None);
        assert_eq!(map["w1:p2Y"].session, None);
    }

    #[test]
    fn parses_all_states_and_skips_broken_entries() {
        let map = parse_agent_list(
            r#"{"result":{"agents":[
                {"pane_id":"a","agent_status":"working","agent_session":{"kind":"path","value":"/s/a.jsonl"}},
                {"pane_id":"b","agent_status":"blocked"},
                {"pane_id":"c","agent_status":"done"},
                {"pane_id":"d","agent_status":"unknown"},
                {"pane_id":"e","agent_status":"paused"},
                {"pane_id":"f","agent_status":"working","agent_session":{"kind":"id","value":"abc"}},
                {"pane_id":"g","agent_status":"working","agent_session":{"kind":"path","value":"/s/not-a-session.txt"}},
                {"pane_id":"h"},
                {"agent_status":"working"},
                "junk",
                {"pane_id":"i","agent_status":42}]}}"#,
        );
        assert_eq!(map["a"].status, HerdrStatus::Working);
        assert_eq!(map["a"].session.as_deref(), Some("/s/a.jsonl"));
        assert_eq!(map["b"].status, HerdrStatus::Blocked);
        assert_eq!(map["c"].status, HerdrStatus::Done);
        assert_eq!(map["d"].status, HerdrStatus::Unknown);
        // A future state we do not know is Unknown — never running.
        assert_eq!(map["e"].status, HerdrStatus::Unknown);
        // Non-path session kinds and non-session values map to None.
        assert_eq!(map["f"].session, None);
        assert_eq!(map["g"].session, None);
        assert!(!map.contains_key("h"));
        assert!(!map.contains_key("i"));
        assert_eq!(map.len(), 7);
    }

    #[test]
    fn malformed_output_yields_empty_map() {
        assert!(parse_agent_list("").is_empty());
        assert!(parse_agent_list("not json").is_empty());
        assert!(parse_agent_list(r#"{"result":{}}"#).is_empty());
        assert!(parse_agent_list(r#"{"result":{"agents":{}}}"#).is_empty());
    }

    #[test]
    fn replace_reports_change_only() {
        let state = HerdrState::default();
        let mut first = HashMap::new();
        first.insert(
            "w1:p1".to_string(),
            PaneState {
                status: HerdrStatus::Idle,
                session: None,
                seq: 7,
            },
        );
        assert!(state.replace(first.clone()));
        // Identical snapshot: no change, so the poller must not refresh.
        assert!(!state.replace(first));
        // A session mapping change alone is a change (ownership moved).
        let mut second = HashMap::new();
        second.insert(
            "w1:p1".to_string(),
            PaneState {
                status: HerdrStatus::Idle,
                session: Some("/s/a.jsonl".to_string()),
                seq: 7,
            },
        );
        assert!(state.replace(second));
        assert_eq!(state.status("w1:p1"), Some(HerdrStatus::Idle));
        assert_eq!(
            state.pane_for_session("/s/a.jsonl").as_deref(),
            Some("w1:p1")
        );
        assert_eq!(state.pane_for_session("/s/other.jsonl"), None);
        assert_eq!(state.status("w1:gone"), None);
    }
    #[test]
    fn overlay_beats_stale_self_report() {
        let state = HerdrState::default();
        let mut m = HashMap::new();
        m.insert(
            "w1:p1".to_string(),
            PaneState {
                status: HerdrStatus::Idle,
                session: Some("/s/stale.jsonl".to_string()),
                seq: 3,
            },
        );
        assert!(state.replace(m));
        // Self-report alone resolves.
        assert_eq!(
            state.pane_for_session("/s/stale.jsonl").as_deref(),
            Some("w1:p1")
        );
        // Fd proof of a different session for the same pane wins.
        let mut overlay = HashMap::new();
        overlay.insert("w1:p1".to_string(), "/s/real.jsonl".to_string());
        state.set_session_overlay(overlay);
        assert_eq!(
            state.pane_for_session("/s/real.jsonl").as_deref(),
            Some("w1:p1")
        );
        assert_eq!(state.pane_for_session("/s/stale.jsonl"), None);
        // Rebuilt per scan: an empty rebuild clears closed panes.
        state.set_session_overlay(HashMap::new());
        assert_eq!(state.pane_for_session("/s/real.jsonl"), None);
        assert_eq!(
            state.pane_for_session("/s/stale.jsonl").as_deref(),
            Some("w1:p1")
        );
    }
    #[test]
    fn answer_text_rules() {
        assert!(validate_answer_text("1").is_ok());
        assert!(validate_answer_text("use the mock, then re-run").is_ok());
        assert!(validate_answer_text("").is_err());
        assert!(validate_answer_text("   ").is_ok());
        assert!(validate_answer_text(&"x".repeat(500)).is_ok());
        assert!(validate_answer_text(&"x".repeat(501)).is_err());
        // Control characters would act on the pane instead of answering.
        assert!(validate_answer_text("1\n").is_err());
        assert!(validate_answer_text("\u{1b}").is_err());
    }

    #[test]
    fn answer_text_allows_sentences() {
        // Delivery is verbatim `pane send-text` (no key-name lookup), so
        // everything without control characters must validate: spaces,
        // punctuation and paths all failed under the old per-key form.
        assert!(validate_answer_text("yes please").is_ok());
        assert!(validate_answer_text("don't").is_ok());
        assert!(validate_answer_text("src/foo.rs").is_ok());
    }
}
