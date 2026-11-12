//! Automatic adoption of an ALREADY-RUNNING desktop omp TUI.
//!
//! Active native Collab hosts are discovered first by exact session through
//! the supported CLI, without touching the terminal. A native Tern pane's
//! exact file and owner pid scope that discovery to the owner's omp runtime.
//! An unshared Tern owner is refused without input: its published editor
//! snapshot can lag a draft, and native `ask` would replace that draft.
//! Other terminal backends can make an already-running TUI share via `/collab`:
//!
//! * **herdr** — resolves the owning omp agent from the owner's
//!   `HERDR_PANE_ID` when available, otherwise enumerates every agent and
//!   matches each pane's own output. It addresses agents directly and reads
//!   output (visible or not) via `herdr agent read`, then submits via
//!   `herdr agent prompt`.
//! * **kitty** — the window comes from the owning process's environment
//!   (`/proc/<pid>/environ` carries `KITTY_WINDOW_ID` and `KITTY_LISTEN_ON`),
//!   the screen is read with `kitty @ get-text`, and text is injected with
//!   `kitty @ send-text` (ESC first, so a half-typed composer line cannot be
//!   corrupted). It is the next authority if herdr cannot adopt.
//! * **tmux** — every pane on the server is a candidate; a pane maps to a
//!   session when its process tree contains the session owner pid, identity is
//!   then PROVEN by the conversation's own text on screen (`capture-pane`),
//!   and `/collab` is submitted with `send-keys` (Escape first, then the
//!   literal command). tmux is the common case on a stranger's machine, and
//!   its CLI works identically on Linux and macOS.
//!
//! `TIOCSTI`, the only other way to inject input into a foreign terminal, is
//! disabled by default on current kernels (`dev.tty.legacy_tiocsti = 0`), so
//! terminal remote control is the sole viable route for that fallback.
//!
//! Which backend is used is decided at RUNTIME — the author's machine has
//! herdr, a stranger's may have only tmux, and a machine with none must be
//! told the manual path instead of failing with backend jargon:
//! `detect_for` picks herdr, kitty and tmux when their owner identities apply;
//! `available_backends` reports those input-capable backends machine-wide
//! for `doctor` and the CLI,
//! and when nothing can serve the session the error says to run `/collab`
//! once by hand.
//!
//! The ADOPTION ALGORITHM is written exactly once — `adopt_with_budget`, driven
//! through the `TerminalBackend` enum — and every backend shares it (plus a
//! scripted fake in the tests). Everything here is best-effort and
//! side-effect-bounded: we refuse to type unless the pane is PROVEN to display
//! this conversation and its newest messages (identity first, always), a pane
//! is never asked to share more than once per 60 s, and a link is only reported
//! after the secret validates.

// The terminal backends below are unreachable on Windows. `adopt_session`
// tries native registry discovery there, then returns the manual `/collab`
// instruction. The terminal code is still COMPILED for Windows on purpose,
// so `cargo check --target x86_64-pc-windows-*` type-checks it: that same
// cross-target checking is what caught a real macOS FFI break in this crate.
// The consequence is 58 dead-code warnings on a platform where the code is
// correct but unused, so they are silenced for Windows only.
#![cfg_attr(windows, allow(dead_code))]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tracing::{debug, info, warn};

mod herdr;
mod kitty;
mod tern;
mod tmux;

use herdr::*;
use kitty::*;
use tern::*;
use tmux::*;

pub(crate) use herdr::{herdr_bin, herdr_pane_of, herdr_within};

/// How long to wait for the link to appear after typing `/collab`.
const LINK_TIMEOUT: Duration = Duration::from_secs(10);
/// Adaptive poll schedule: 120 ms for the first second of waiting (a screen
/// read costs ~50–90 ms, and the link typically becomes readable within
/// ~715 ms of submitting, so early polls are cheap and catch it fast), then
/// 400 ms until the third second, then 800 ms to the 10 s ceiling. The total
/// bound is still `LINK_TIMEOUT`.
const POLL_FAST: Duration = Duration::from_millis(120);
const POLL_MEDIUM: Duration = Duration::from_millis(400);
const POLL_SLOW: Duration = Duration::from_millis(800);
const POLL_FAST_UNTIL: Duration = Duration::from_secs(1);
const POLL_MEDIUM_UNTIL: Duration = Duration::from_secs(3);
/// How long a pane must wait between `/collab` submits: an omp output change
/// (e.g. the pane's screen flipping between views) must never cause repeated
/// typing into a user's terminal.
const SUBMIT_COOLDOWN_AFTER: Duration = Duration::from_secs(60);
/// Cap on any terminal backend invocation (`kitty @`, `herdr`, `tmux`), so a
/// wedged terminal cannot hang a request.
const RPC_TIMEOUT: Duration = Duration::from_secs(5);
/// Cap on the sync detection probes (`herdr agent list`, `tmux list-panes`):
/// a wedged backend must never hang a report or an adoption attempt.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Per-pane last `/collab` submit time. Keyed by pane id; entries are pruned
/// lazily (a pane is only looked up right before a potential submit).
static SUBMIT_COOLDOWN: std::sync::LazyLock<Mutex<HashMap<String, std::time::Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Poll delay for the given elapsed wait: 120 ms for the first second,
/// 400 ms until the third, then 800 ms to the ceiling.
fn poll_delay(elapsed: Duration) -> Duration {
    if elapsed < POLL_FAST_UNTIL {
        POLL_FAST
    } else if elapsed < POLL_MEDIUM_UNTIL {
        POLL_MEDIUM
    } else {
        POLL_SLOW
    }
}

/// True when this pane was asked to share within the cooldown window.
fn cooldown_active(pane: &str) -> bool {
    match SUBMIT_COOLDOWN.lock() {
        Ok(g) => g
            .get(pane)
            .is_some_and(|t| t.elapsed() < SUBMIT_COOLDOWN_AFTER),
        Err(p) => p
            .into_inner()
            .get(pane)
            .is_some_and(|t| t.elapsed() < SUBMIT_COOLDOWN_AFTER),
    }
}

/// Record a successful `/collab` submit to this pane.
fn mark_submitted(pane: &str) {
    match SUBMIT_COOLDOWN.lock() {
        Ok(mut g) => {
            g.insert(pane.to_string(), std::time::Instant::now());
        }
        Err(p) => {
            p.into_inner()
                .insert(pane.to_string(), std::time::Instant::now());
        }
    }
}

// --- terminal backends ------------------------------------------------------
//
// The adoption algorithm is written ONCE against `TerminalBackend`; the real
// backends (herdr, Tern, kitty, tmux) and the tests' scripted fake are just
// instances of it. Rust has no stable async fn in a trait without a
// dependency (async-trait), and the project adds none, so instead of
// `trait TerminalHost { async fn … }` this is an enum with inherent async
// methods dispatching to one concrete host per backend — same single-algorithm
// effect, no new deps.

/// One terminal pane as the adoption algorithm sees it.
#[derive(Clone)]
struct PaneRef {
    id: String,
    cwd: String,
    /// True only when the pane was resolved from the pid that the guard proved
    /// holds this session file open. Enumerated panes must pass the content
    /// fingerprint gate below.
    owner_resolved: bool,
}

/// A terminal backend the adoption algorithm can drive.
enum TerminalBackend {
    Herdr(HerdrHost),
    Kitty(KittyHost),
    Tmux(TmuxHost),
    #[cfg(test)]
    Fake(FakeHost),
}

impl TerminalBackend {
    fn name(&self) -> &'static str {
        match self {
            TerminalBackend::Herdr(_) => "herdr",
            TerminalBackend::Kitty(_) => "kitty",
            TerminalBackend::Tmux(_) => "tmux",
            #[cfg(test)]
            TerminalBackend::Fake(_) => "fake",
        }
    }

    /// Every pane the backend knows about, with its cwd when known.
    async fn panes(&self) -> Vec<PaneRef> {
        match self {
            TerminalBackend::Herdr(h) => h.panes().await,
            TerminalBackend::Kitty(k) => k.panes().await,
            TerminalBackend::Tmux(t) => t.panes().await,
            #[cfg(test)]
            TerminalBackend::Fake(f) => f.panes().await,
        }
    }

    /// The pane's current terminal output.
    async fn read(&self, pane: &str) -> Result<String, String> {
        match self {
            TerminalBackend::Herdr(h) => h.read(pane).await,
            TerminalBackend::Kitty(k) => k.read(pane).await,
            TerminalBackend::Tmux(t) => t.read(pane).await,
            #[cfg(test)]
            TerminalBackend::Fake(f) => f.read(pane).await,
        }
    }

    /// Submit literal text to the pane's input.
    async fn submit(&self, pane: &str, text: &str) -> Result<(), String> {
        match self {
            TerminalBackend::Herdr(h) => h.submit(pane, text).await,
            TerminalBackend::Kitty(k) => k.submit(pane, text).await,
            TerminalBackend::Tmux(t) => t.submit(pane, text).await,
            #[cfg(test)]
            TerminalBackend::Fake(f) => f.submit(pane, text).await,
        }
    }
}

/// A link scraped off a pane's screen — but only when the daemon could
/// actually register it.
///
/// The screen is the only evidence of what `/collab` was last run with, and
/// that can name any relay: omp accepts an explicit one (`/collab <relayUrl>`)
/// and reads `collab.relayUrl` otherwise. `parse_collab_link` refuses a
/// plaintext relay on anything but loopback — the room key (32 bytes, 48 with
/// the write token) rides in the link's own path, so a `ws://` link puts it on
/// the wire in the clear — which means a pane sharing over one prints a link
/// this daemon will never register.
///
/// Taking it anyway is what dead-ended the phone. Measured 2026-09-14: a pane
/// sharing over `ws://<tailnet>:7682` produced six refusals over fifty
/// minutes, each with the desktop VISIBLY showing its collab box — the user
/// watched the share appear and was still told "this conversation is held on
/// your desktop". The registration failure was logged but never reached the
/// refusal the phone rendered, so the message read as a lie.
///
/// Filtering here instead makes the verdict fall through to `EnableSharing`:
/// a plain `/collab` re-shares on the CONFIGURED relay, which is the daemon's
/// own loopback listener by design, and prints a link that registers.
fn registrable_link(text: &str) -> Option<crate::terminal::linkscrape::ScrapedLink> {
    let found = crate::terminal::linkscrape::scrape_text(text)?;
    match crate::omp::collab::parse_collab_link(&found.link) {
        Ok(_) => Some(found),
        Err(reason) => {
            // Room id only: the link carries the key.
            debug!(room = %found.room, relay = %crate::omp::collab::link_authority(&found.link),
                reason = %reason,
                "adopt: ignoring a printed link this daemon will not register");
            None
        }
    }
}

/// Native discovery already proves session, owner, access and generation.
/// Apply the relay policy without interpreting its URL as rendered text.
fn validated_native_link(link: String) -> Result<String, String> {
    crate::omp::collab::parse_collab_link(&link).map_err(|_| {
        "the owner's native Collab link cannot be used by omp-pulse; use a secure or loopback relay"
            .to_string()
    })?;
    Ok(link)
}

/// What to do with a candidate pane, decided from the evidence alone.
///
/// Split out so the ordering is testable: identity BEFORE anything else. The
/// bug this prevents was real — an "is it already sharing?" check that ran first
/// handed a test fixture the link of an unrelated conversation in the same
/// directory, and that conversation received the fixture's prompts.
#[derive(Debug, PartialEq, Eq)]
enum PaneVerdict {
    /// None of this session's recent messages are on that screen.
    NotThisSession,
    /// It shows this session, but not the newest message: stale view.
    Behind,
    /// It shows this session AND is already sharing: reuse that link.
    TakeExistingLink,
    /// It shows this session and is not sharing: enable it.
    EnableSharing,
}

fn pane_verdict(matched: &[usize], has_link: bool) -> PaneVerdict {
    if matched.is_empty() {
        return PaneVerdict::NotThisSession;
    }
    if !matched.contains(&0) {
        return PaneVerdict::Behind;
    }
    if has_link {
        PaneVerdict::TakeExistingLink
    } else {
        PaneVerdict::EnableSharing
    }
}
/// Apply the content verdict only to enumerated panes. A pane resolved from
/// the guard's owner pid has stronger identity proof than screen text.
fn pane_verdict_for(pane: &PaneRef, matched: &[usize], has_link: bool) -> PaneVerdict {
    if pane.owner_resolved {
        if has_link {
            PaneVerdict::TakeExistingLink
        } else {
            PaneVerdict::EnableSharing
        }
    } else {
        pane_verdict(matched, has_link)
    }
}

/// First `name` (plus the platform executable suffix) on PATH.
fn find_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::split_paths(&path)
        .map(|dir| dir.join(&exe))
        .find(|p| p.is_file())
}

/// Run a command and report whether it exited 0 within [`PROBE_TIMEOUT`] —
/// the sync probe pattern from `term::omp_version`: spawn, poll `try_wait`,
/// kill on deadline. A wedged backend must never hang a report or an adoption
/// attempt.
fn run_ok(bin: &std::path::Path, args: &[&str]) -> bool {
    let mut child = match std::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return false,
        }
    }
}

/// Strip the Markdown a terminal RENDERS AWAY, so a fingerprint can match the
/// pane that is provably showing this conversation. The pane text comes from
/// a screen read (kitty get-text, herdr agent read, tmux capture-pane), which
/// shows the RENDERED conversation: inline-code backticks, emphasis markers
/// and `[label](url)` labels are gone. A fingerprint still carrying them can
/// never match — measured live: a reply containing `` `AccessBlocked` `` and
/// `` `IsFrozen` `` refused to match the pane displaying it, and adoption
/// wrongly reported "no terminal pane is displaying this conversation".
///
/// Deliberately conservative: underscores are NOT stripped (`snake_case`
/// renders literally, and a rendered code block keeps them), and only the
/// bracketed form of links is rewritten — a bare URL renders as itself.
fn strip_markdown(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '`' => i += 1,
            '[' => {
                // [label](url) -> label (the terminal shows the label only).
                let rest = &chars[i + 1..];
                match rest.iter().position(|&c| c == ']') {
                    Some(close)
                        if i + 1 + close + 1 < chars.len() && chars[i + 1 + close + 1] == '(' =>
                    {
                        let label_end = i + 1 + close;
                        let after = &chars[label_end + 1..];
                        match after.iter().position(|&c| c == ')') {
                            Some(paren) => {
                                out.extend(chars[i + 1..label_end].iter());
                                i = label_end + 1 + paren + 1;
                            }
                            None => {
                                out.push(chars[i]);
                                i += 1;
                            }
                        }
                    }
                    _ => {
                        out.push(chars[i]);
                        i += 1;
                    }
                }
            }
            '*' | '~' => {
                // Emphasis / strikethrough runs render as nothing.
                while i < chars.len() && matches!(chars[i], '*' | '~') {
                    i += 1;
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// Distinctive strings from a session's recent messages, used to recognise the
/// pane that is DISPLAYING that conversation. Markdown is stripped first and
/// whitespace is collapsed, so the terminal's own rendering and wrapping
/// cannot defeat the comparison.
fn fingerprints(session_path: &str) -> Vec<String> {
    let Ok(bytes) = std::fs::read(session_path) else {
        return Vec::new();
    };
    // Only the tail matters, and sessions reach tens of megabytes.
    let start = bytes.len().saturating_sub(256 * 1024);
    let tail = String::from_utf8_lossy(&bytes[start..]);
    let mut out = Vec::new();
    for line in tail.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let text = match v.pointer("/message/content") {
            Some(serde_json::Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" "),
            Some(serde_json::Value::String(s)) => s.clone(),
            _ => continue,
        };
        // Strip BEFORE collapsing: removing "```" from "...seconds ```" would
        // otherwise leave a stray trailing space that breaks the contains
        // match against the pane's "…seconds ⏱ 2.3s".
        let stripped = strip_markdown(&text);
        let flat = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
        if flat.chars().count() < 40 {
            continue;
        }
        // The END of a message is what remains on screen after a long reply.
        let tail_slice: String = flat
            .chars()
            .rev()
            .take(48)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        out.push(tail_slice);
        if out.len() >= 6 {
            break;
        }
    }
    out
}

/// The shared adoption algorithm with the production wait budget
/// (`LINK_TIMEOUT`). Tests drive the same algorithm through
/// `adopt_with_budget` with a millisecond budget.
async fn adopt_with(
    backend: &TerminalBackend,
    session_path: &str,
    cwd: Option<&str>,
    prints: &[String],
) -> Result<String, String> {
    adopt_with_budget(backend, session_path, cwd, prints, LINK_TIMEOUT).await
}

/// The adoption algorithm, written once for every backend: enumerate the
/// panes, prove which one DISPLAYS this conversation (identity first, always),
/// take an existing link or make it share, and poll adaptively for the link
/// until `budget` runs out.
///
/// Side-effect bounds, in order:
/// * dead room-keyed registry entries are pruned BEFORE deciding to type, so a
///   stale registry cannot make adoption look unnecessary;
/// * a pane is never asked to share more than once per 60 s (`SUBMIT_COOLDOWN`)
///   — on a cooled-down pane only read-only detection applies, so a link that
///   appears later is still taken;
/// * typing only ever happens into a pane proven to display the session's
///   NEWEST message (a stale view is refused, never refreshed by force).
async fn adopt_with_budget(
    backend: &TerminalBackend,
    session_path: &str,
    cwd: Option<&str>,
    prints: &[String],
    budget: Duration,
) -> Result<String, String> {
    // An owner-resolved pane has identity from the guard's open session file,
    // so it can be adopted even when the session has no qualifying message
    // fingerprint (for example an untitled or brand-new conversation). For
    // enumerated panes, the per-pane verdict below still requires a newest
    // fingerprint before anything is typed.
    // Dead-room healing: a stored link whose room no longer has a host makes
    // the registry look authoritative when it is not (a failed attach with no
    // cleanup). Drop those entries first — same action as
    // `CollabManager::prune_dead_rooms` — so adoption is decided on live state.
    crate::omp::collab::prune_dead_rooms_now();

    let panes = backend.panes().await;
    if panes.is_empty() {
        return Err(format!("{} reports no omp panes", backend.name()));
    }

    for pane in panes {
        if let Some(cwd) = cwd
            && !pane.cwd.is_empty()
            && pane.cwd != cwd
        {
            continue; // a different project entirely
        }
        let text = match backend.read(&pane.id).await {
            Ok(text) => text,
            Err(_) => continue,
        };
        let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");

        // IDENTITY FIRST, ALWAYS. Which of this conversation's recent messages
        // are on that pane's screen? `prints` is newest-first, so index 0 is
        // the latest committed message. Owner-resolved panes deliberately
        // bypass this text check; the guard already proved that their process
        // owns this session file.
        let matched: Vec<usize> = prints
            .iter()
            .enumerate()
            .filter(|(_, p)| flat.contains(p.as_str()))
            .map(|(i, _)| i)
            .collect();
        // Only a link this daemon would actually register counts as "the pane
        // is sharing": see `registrable_link` for the refusal that prevents.
        let link_on_screen = registrable_link(&text);
        let has_link = link_on_screen.is_some();
        // An owner-resolved pane bypasses the text verdict: the guard proved
        // this pid holds THIS session file open, so its pane cannot be another
        // conversation; while that TUI holds the file, the guard excludes every
        // other writer, so its in-memory view cannot be behind the file. The
        // `Behind` verdict exists only for enumerated panes whose screen text
        // is the identity proof. Keep the printed-link preference either way.
        match pane_verdict_for(&pane, &matched, has_link) {
            PaneVerdict::NotThisSession => continue,
            PaneVerdict::Behind => {
                // Enumerated panes have only their screen text as identity
                // proof, so a stale match must still be refused.
                warn!(session = %session_path, pane = %pane.id,
                    "adopt: pane is showing an older view; refusing to make it the host");
                return Err(format!(
                    "the terminal showing this conversation ({}) is behind — it has not \
                     seen the newest messages. Press /resume there to reload it, then \
                     send again and it will go live.",
                    pane.id
                ));
            }
            PaneVerdict::TakeExistingLink => {
                if let Some(found) = link_on_screen {
                    info!(session = %session_path, pane = %pane.id, room = %found.room,
                        "adopt({}): pane already sharing this conversation; took the printed link",
                        backend.name());
                    return Ok(found.link);
                }
            }
            PaneVerdict::EnableSharing => {}
        }

        info!(session = %session_path, pane = %pane.id,
            "adopt({}): matched the pane displaying this conversation; enabling sharing",
            backend.name());
        let typed = if cooldown_active(&pane.id) {
            warn!(session = %session_path, pane = %pane.id,
                "adopt({}): /collab was submitted to this pane recently; not typing again, watching read-only",
                backend.name());
            false
        } else {
            backend.submit(&pane.id, "/collab").await?;
            mark_submitted(&pane.id);
            true
        };

        let start = tokio::time::Instant::now();
        // The relay of the last link the pane printed and we refused, so a
        // failure can name what omp was actually sharing over instead of
        // leaving the operator with nothing.
        let mut refused_relay: Option<String> = None;
        let mut refusal_logged = false;
        loop {
            let elapsed = start.elapsed();
            if elapsed >= budget {
                break;
            }
            tokio::time::sleep(poll_delay(elapsed)).await;
            let after = match backend.read(&pane.id).await {
                Ok(text) => text,
                Err(_) => continue,
            };
            let Some(found) = crate::terminal::linkscrape::scrape_text(&after) else {
                continue;
            };
            match crate::omp::collab::parse_collab_link(&found.link) {
                Ok(_) => {
                    info!(session = %session_path, pane = %pane.id, room = %found.room,
                        "adopt({}): link captured", backend.name());
                    return Ok(found.link);
                }
                Err(reason) => {
                    // Unusable for the same policy reason `TakeExistingLink`
                    // filters on: keep watching rather than handing back a
                    // link the registration step will refuse. Logged once per
                    // attempt — this polls up to ~40 times — and only the
                    // authority, never the link (the room key rides in it).
                    let relay = crate::omp::collab::link_authority(&found.link);
                    if !refusal_logged {
                        refusal_logged = true;
                        warn!(session = %session_path, pane = %pane.id, room = %found.room,
                            relay = %relay, reason = %reason,
                            "adopt({}): pane printed a link this daemon will not register; \
                             watching for a usable one",
                            backend.name());
                    }
                    refused_relay = Some(relay);
                }
            }
        }
        if let Some(relay) = refused_relay {
            return Err(format!(
                "{} is sharing this conversation over {relay}, which omp-pulse will not join: \
                 a plain ws:// relay is accepted only on loopback, because the room key rides \
                 in the link's own path. Point omp's collab.relayUrl at this daemon's loopback \
                 relay (ws://127.0.0.1:<daemon port>) and share again.",
                pane.id
            ));
        }
        return Err(if typed {
            format!(
                "submitted /collab to {} but no link appeared within {}s",
                pane.id,
                budget.as_secs()
            )
        } else {
            format!(
                "{} is cooling down from a recent /collab; watched for a link but none appeared within {}s",
                pane.id,
                budget.as_secs()
            )
        });
    }
    Err("no terminal pane is displaying this conversation".to_string())
}

// --- backend detection -----------------------------------------------------
//
// Which backends can serve a session is decided BEFORE typing anything: the
// author's machine has herdr, a stranger's may have only tmux, and a machine
// with none must be told the manual path instead of failing with backend
// jargon. Detection is honest per platform:
//
//   herdr  — binary on PATH or ~/.local/bin AND `herdr agent list` exits 0
//            (present and responding — the same command adoption runs).
//   Tern   — the owner's native pane environment (Linux), or a reachable
//            daemon elsewhere. Adoption still proves the exact file and pid
//            before it can invoke the native composer.
//   kitty  — binary on PATH AND a process carries KITTY_LISTEN_ON plus
//            KITTY_WINDOW_ID (what kitty sets for everything it spawns).
//            Per session this is the owner's /proc environ; the machine
//            report scans /proc for ANY such process on Linux (the daemon is
//            usually not itself inside kitty while the TUI is) and on macOS
//            only our own environment (no portable way to read another
//            process's environ).
//   tmux   — binary on PATH AND (per session, Linux) the owner's environ
//            carries TMUX=; (macOS) `tmux list-panes -a` succeeds, a
//            reachable server. The machine report uses the list-panes probe.
//
// Windows: adoption is unsupported. Nothing here is unix-only at the COMPILE
// level (the /proc reads are plain fs reads that fail there), but
// `available_backends` and `adopt_session` are gated to return nothing /
// the manual instruction, so a Windows build never reaches the probes.

/// A terminal backend that can be probed and driven.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackendKind {
    Herdr,
    Kitty,
    Tmux,
}

impl BackendKind {
    /// Stable public name, as reported by [`available_backends`].
    fn name(self) -> &'static str {
        match self {
            BackendKind::Herdr => "herdr",
            BackendKind::Kitty => "kitty",
            BackendKind::Tmux => "tmux",
        }
    }
}

/// The usable backends in authority order for a synthetic availability result.
/// Split from the probing so tests can drive the ordering with a synthetic
/// environment. herdr's agent addressing is preferred, then kitty's owner
/// window and tmux's multiplexer pane.
fn ordered_backends(herdr: bool, kitty: bool, tmux: bool) -> Vec<BackendKind> {
    let mut out = Vec::with_capacity(3);
    if herdr {
        out.push(BackendKind::Herdr);
    }
    if kitty {
        out.push(BackendKind::Kitty);
    }
    if tmux {
        out.push(BackendKind::Tmux);
    }
    out
}

/// Which backends can adopt THIS session, in authority order. `owner_pid` is
/// the foreign omp TUI from `guard::foreign_session_owner`; None means no
/// owner was found (herdr-only sessions: a TUI that never wrote to the file),
/// which rules out the pid-addressed backends.
///
/// herdr is only offered when it can actually serve this session: the owner
/// is a herdr pane (or unknown). Without that gate, a machine where herdr
/// merely EXISTS (and answers `agent list`) would try herdr first for every
/// session, fail on any non-herdr window, and — because herdr is
/// authoritative — `adopt_with_detected` breaks before kitty ever runs.
/// Measured live: a plain kitty window whose conversation herdr cannot see
/// was refused with "run /collab once" while kitty adoption would have worked
/// (its newest message was on the visible screen).
fn detect_for(owner_pid: Option<i32>) -> Vec<BackendKind> {
    ordered_backends(
        herdr_responding() && owner_is_herdr_pane(owner_pid),
        owner_pid.is_some_and(|pid| window_of(pid).is_some()),
        owner_pid.is_some_and(tmux_detect_for),
    )
}

/// The backends usable on this machine right now, in authority order.
fn detect_machine() -> Vec<BackendKind> {
    ordered_backends(herdr_responding(), kitty_available(), tmux_responding())
}

/// Which adoption backends this machine supports right now, in order of
/// authority: herdr, kitty, tmux, or a subset. Empty means adoption cannot
/// type into any terminal here (always the case on Windows), and the caller
/// should present the manual `/collab` path.
/// Native Collab discovery (including Tern) and desktop bridges bypass this
/// input-fallback list.
pub fn available_backends() -> Vec<&'static str> {
    #[cfg(windows)]
    {
        Vec::new()
    }
    #[cfg(not(windows))]
    {
        detect_machine().iter().map(|b| b.name()).collect()
    }
}

/// Whether adopting a session with NO known owner (a terminal merely showing
/// it) could succeed here, judged without spawning anything. Only two routes
/// serve that case: a native Collab host in omp's registry, and herdr, which
/// finds the pane by content. kitty and tmux both need the owner pid
/// ([`detect_for`]). The write path runs display adoption before every send
/// window, so on a machine with neither (the phone under proot) each attempt
/// was pure cost: an `omp collab list` start, then a guaranteed "not
/// supported" failure — `adopt_attempt` climbed with zero successes.
pub fn display_adoption_possible() -> bool {
    if crate::omp::native_collab::registry_may_have_hosts() {
        return true;
    }
    #[cfg(windows)]
    {
        false
    }
    #[cfg(not(windows))]
    {
        herdr_bin().is_some()
    }
}

/// The user-facing remedy appended whenever adoption fails end to end: typing
/// `/collab` once in the terminal that shows the conversation is the manual
/// path that always works (the phone's QR flow then carries on).
const MANUAL_COLLAB_HINT: &str = "open the conversation in a terminal and run /collab once";

/// The degradation text when no backend can serve a session: tell the user
/// the manual path instead of failing with backend jargon. Also used on
/// Windows when native discovery found no usable host.
fn no_backend_message() -> String {
    format!("automatic adoption is not supported on this machine; {MANUAL_COLLAB_HINT}")
}

/// Make an already-running TUI share its session, and return its collab link.
///
/// Native registry first, then terminal backends (see [`detect_for`]): herdr resolves the
/// owner pane when possible and otherwise enumerates agents; kitty resolves the
/// owner window; tmux enumerates panes whose process tree contains the owner.
/// Each backend proves enumerated-pane identity from conversation fingerprints.
/// If an earlier backend cannot adopt, the remaining backends are tried and
/// the final error names the last backend attempted. Owner-resolved panes skip
/// those text verdicts because their fd-proven identity is stronger.
///
/// When nothing can serve the session the error tells the user the manual
/// path (`/collab` once) instead of failing confusingly. On Windows only native
/// discovery is available; terminal-control fallback is unsupported.
///
/// The returned link carries a write token, so the caller must treat it as a
/// capability: register it, never log it.
pub async fn adopt_session(
    session_path: &str,
    session_cwd: Option<&str>,
    owner_pid: Option<i32>,
) -> Result<String, String> {
    // Tern's native runtime can use a different profile from this daemon.
    // Once its exact owner is proven, a refusal must not become legacy input.
    match adopt_via_tern(session_path, owner_pid).await {
        Ok(Some(link)) => return Ok(link),
        Ok(None) => {}
        Err(error) => return Err(format!("tern: {error}; {MANUAL_COLLAB_HINT}")),
    }
    if let Some(session_id) =
        crate::sessions::jsonl::parse_header(std::path::Path::new(session_path)).id
    {
        match crate::omp::native_collab::discover(&session_id, owner_pid, None).await {
            crate::omp::native_collab::Discovery::Link(link) => return Ok(link),
            crate::omp::native_collab::Discovery::Refused(reason) => return Err(reason.to_string()),
            crate::omp::native_collab::Discovery::NoHost => {}
        }
    }
    #[cfg(windows)]
    {
        let _ = (session_path, session_cwd, owner_pid);
        Err(no_backend_message())
    }
    #[cfg(not(windows))]
    {
        let avail = detect_for(owner_pid);
        adopt_with_detected(session_path, session_cwd, owner_pid, &avail).await
    }
}

/// Run adoption over an explicit backend list (authority order). Production
/// passes [`detect_for`]'s result; tests drive the no-backend degradation
/// with an empty list instead of probing the real machine.
async fn adopt_with_detected(
    session_path: &str,
    session_cwd: Option<&str>,
    owner_pid: Option<i32>,
    avail: &[BackendKind],
) -> Result<String, String> {
    if avail.is_empty() {
        return Err(no_backend_message());
    }
    let mut last_error = None;
    for &kind in avail {
        let result = match kind {
            BackendKind::Herdr => adopt_via_herdr(session_path, session_cwd, owner_pid).await,
            BackendKind::Kitty => match owner_pid {
                Some(pid) => adopt_via_kitty(session_path, pid).await,
                None => Err("kitty adoption needs the session owner pid".to_string()),
            },
            BackendKind::Tmux => match owner_pid {
                Some(pid) => adopt_via_tmux(session_path, pid).await,
                None => Err("tmux adoption needs the session owner pid".to_string()),
            },
        };
        match result {
            Ok(link) => return Ok(link),
            Err(error) => last_error = Some(format!("{}: {error}", kind.name())),
        }
    }
    let mut message = last_error.unwrap_or_else(|| "automatic adoption failed".to_string());
    message.push_str("; ");
    message.push_str(MANUAL_COLLAB_HINT);
    Err(message)
}

/// Scripted backend for driving the adoption algorithm without a terminal.
///
/// `panes` is what `panes()` reports. `reads` is a per-pane script of
/// terminal outputs: each `read()` pops the next entry, and an exhausted
/// script keeps returning its last entry (so a poll loop keeps seeing the
/// same content). `submits` counts every `/collab` typed.
#[cfg(test)]
struct FakeHost {
    panes: Vec<PaneRef>,
    reads: Mutex<HashMap<String, std::collections::VecDeque<String>>>,
    default_read: String,
    submits: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl FakeHost {
    fn new(panes: Vec<PaneRef>) -> Self {
        FakeHost {
            panes,
            reads: Mutex::new(HashMap::new()),
            default_read: String::new(),
            submits: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Script the reads for a pane, in order; later reads repeat the last one.
    fn script(&mut self, pane: &str, reads: Vec<String>) {
        self.reads
            .lock()
            .unwrap()
            .insert(pane.to_string(), std::collections::VecDeque::from(reads));
    }

    /// The read returned for any pane without a script.
    fn fallback(&mut self, text: &str) {
        self.default_read = text.to_string();
    }

    fn submit_count(&self) -> usize {
        self.submits.load(std::sync::atomic::Ordering::Relaxed)
    }

    async fn panes(&self) -> Vec<PaneRef> {
        self.panes.clone()
    }

    async fn read(&self, pane: &str) -> Result<String, String> {
        let mut reads = self.reads.lock().unwrap();
        let Some(queue) = reads.get_mut(pane) else {
            return Ok(self.default_read.clone());
        };
        match queue.pop_front() {
            Some(text) => {
                if queue.is_empty() {
                    queue.push_back(text.clone());
                }
                Ok(text)
            }
            None => Ok(self.default_read.clone()),
        }
    }

    async fn submit(&self, _pane: &str, _text: &str) -> Result<(), String> {
        self.submits
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
