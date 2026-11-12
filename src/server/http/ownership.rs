//! Per-write ownership routing: the cached terminal-owner verdict, `write_path`,
//! and the display adoption of a desktop TUI that routing may trigger.

use super::*;
use crate::{metrics, sessions::jsonl};
use axum::{http::StatusCode, response::Response};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Session path → (when the sweep ran, what it found), the cache payload.
type OwnerVerdicts = HashMap<String, (Instant, Option<crate::authority::guard::ForeignOwner>)>;

/// Per-session terminal-ownership verdict, cached for `cfg.owner_cache_ms`.
///
/// WHY (measured, docs/internals/performance.md F11): `guard::foreign_session_owner` walks all
/// of /proc (~7.5 ms, 815 pids) and runs on every prompt/bash/mutating-rpc
/// write-path decision. The verdict only changes when a process starts or
/// exits, so caching it by time alone is sound. Tradeoff, stated: a TUI that
/// appears mid-window is invisible here for at most owner_cache_ms — a
/// refusal is deferred by one prompt, and `ChildManager::do_open` re-checks
/// at spawn time anyway (the authoritative gate), so no file can be damaged.
static OWNER_VERDICT: std::sync::LazyLock<Mutex<OwnerVerdicts>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// `guard::foreign_session_owner` behind the verdict cache: same semantics,
/// same return value. A miss runs the real sweep and stores the verdict; the
/// lock is held across the sweep so concurrent write paths share one /proc
/// walk instead of each paying 7.5 ms.
pub(super) fn session_owner(
    state: &Arc<AppState>,
    session: &str,
) -> Option<crate::authority::guard::ForeignOwner> {
    let ttl = Duration::from_millis(state.cfg.owner_cache_ms);
    let mut g = OWNER_VERDICT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((ts, v)) = g.get(session)
        && ts.elapsed() < ttl
    {
        return v.clone();
    }
    let verdict =
        crate::authority::guard::foreign_session_owner(session, &state.children.live_pids());
    g.insert(session.to_string(), (Instant::now(), verdict.clone()));
    verdict
}

/// THE per-write path decision — the ONE function used by every endpoint that
/// appends to a session file (`/api/prompt`, `/api/bash`, mutating
/// `/api/rpc`). Checking only at child-spawn time is not enough, because a
/// terminal can adopt a file we are already writing (observed live: a child
/// pre-warmed at 19:13:15 kept writing to a session a TUI had opened at
/// 19:12:56). Resolution order, each step short-circuiting:
///
/// First, the owning desktop omp connected over the extension bridge wins
/// outright -> `Bridge(pid)`: the owner executes the write itself.
///
/// a. already attached + writable -> `Host` (the CHEAP path; no terminal work);
/// b. a stored or announced link exists for the session -> attach with it; on
///    success -> `Host`. This is the CHEAP host path (~700ms attach, does NOT
///    touch the user's terminal) and is what should happen after a daemon
///    restart — preferred over adoption, which types `/collab` into a window;
/// c. a foreign omp process owns the file -> shut our writer down, then try
///    adoption; on success -> `Host`, on failure -> `Refused(...)` with the
///    existing `{ok:false, error, code:"session_owned_by_terminal"}` body;
/// d. no owner -> try the rate-limited display adoption (a terminal may be
///    merely SHOWING the conversation, invisible to the guard); -> `Host`;
/// e. otherwise -> `Child`.
pub(super) async fn write_path(state: &Arc<AppState>, session: &str) -> WritePath {
    let authority = session_authority(state, session);
    if authority.owner.kind == "ambiguous" {
        return WritePath::Refused(
            "conflicting live session owners; no command was dispatched".to_owned(),
        );
    }
    // The accepted bridge owns this session; do not terminate a competing writer
    // to manufacture agreement between incompatible ownership claims.
    if let Some(pid) = crate::omp::bridge::live_pid(session) {
        metrics::inc("prompt_via_bridge");
        return WritePath::Bridge(pid);
    }
    // a. Already attached and writable: the host is live. No adoption, no
    //    terminal interaction.
    if state.collab.is_attached(session) && state.collab.can_write(session) {
        return host_path(state, session).await;
    }
    // b. Stored or announced link: the CHEAP host paths. Attach with the
    //    persisted link — this never touches the user's terminal, so it is
    //    preferred over adoption and is what happens after a daemon restart.
    //    Stored (explicitly shared) wins over announced (host-published).
    let session_id = jsonl::parse_header(std::path::Path::new(session)).id;
    if let Some(link) = state
        .collab
        .auto_attach_link(session, session_id.as_deref())
    {
        let t0 = Instant::now();
        let attached = match state.collab.attach(session, &link).await {
            Ok(()) => {
                metrics::observe_ms("attach_ms", t0.elapsed().as_millis() as u64);
                let ok = state.collab.is_attached(session) && state.collab.can_write(session);
                metrics::inc(if ok {
                    "attach_success"
                } else {
                    "attach_failure"
                });
                ok
            }
            Err(e) => {
                metrics::observe_ms("attach_ms", t0.elapsed().as_millis() as u64);
                metrics::inc("attach_failure");
                tracing::warn!(%session, error = %e, "write path: stored-link attach failed");
                false
            }
        };
        if attached {
            return host_path(state, session).await;
        }
        // Fall through: the host behind the stored link is gone.
    }
    // c. A foreign omp process (typically the desktop TUI) holds the file:
    //    shut our writer down, then try to make that terminal SHARE the
    //    session, which turns a dead end into a working write path: the
    //    desktop runs the turn, so there is exactly one writer and the laptop
    //    shows it natively. Adoption types `/collab` into the owning window
    //    over kitty remote control and reads the printed link back off the
    //    screen — the ceremony the user should never have to perform. One
    //    attempt per session at a time; failures fall through to the refusal,
    //    which the phone renders with a manual fallback.
    if let Some(owner) = session_owner(state, session) {
        if state.children.has_child(session) {
            tracing::warn!(%session, owner_pid = owner.pid,
                "session adopted by a terminal — shutting our writer down");
            state.children.close(session).await;
        }
        // Why the automatic share failed, when it did. Surfaced in the
        // refusal body so the phone can say something specific ("the pane is
        // showing an older view — press /resume") instead of the bare
        // "owned by a terminal" boilerplate that reads as "go run /collab".
        let mut adopt_error: Option<String> = None;
        if adopt_start(session) {
            metrics::inc("adopt_attempt");
            let cwd = session_cwd(&state.cfg, std::path::Path::new(session));
            let outcome =
                crate::terminal::adopt::adopt_session(session, cwd.to_str(), Some(owner.pid)).await;
            adopt_finish(session);
            match outcome {
                Ok(link) => {
                    metrics::inc("adopt_success");
                    match state.collab.register_and_tap(&link) {
                        Ok(()) => {
                            // The write path is the guest attach, not the read-only
                            // tap: attach explicitly and wait briefly for it.
                            if let Err(e) = state.collab.attach(session, &link).await {
                                tracing::warn!(%session, error = %e, "adopt: guest attach failed");
                            }
                            for _ in 0..20 {
                                if state.collab.is_attached(session)
                                    && state.collab.can_write(session)
                                {
                                    tracing::info!(%session, "adopt: session is now shared; write path live");
                                    return host_path(state, session).await;
                                }
                                tokio::time::sleep(Duration::from_millis(150)).await;
                            }
                            tracing::warn!(%session, "adopt: registered but no write path appeared");
                            adopt_error = Some(
                                "the desktop shared this conversation but its link never \
                                 became writable (the room was replaced or the host left)"
                                    .to_string(),
                            );
                        }
                        Err(e) => {
                            tracing::warn!(%session, error = %e, "adopt: link registration failed");
                            adopt_error =
                                Some(format!("the desktop's share link was rejected ({e})"));
                        }
                    }
                }
                Err(e) => {
                    tracing::info!(%session, error = %e, "adopt: could not share automatically");
                    adopt_error = Some(e);
                }
            }
        }
        metrics::inc("prompt_refused_owned");
        let error = match adopt_error {
            // The adoption error already ends with the manual path hint; keep
            // the stable `session_owned_by_terminal` prefix the client keys
            // on, then say what actually went wrong.
            Some(e) => format!(
                "{} — auto-sharing failed: {e}",
                crate::authority::guard::refusal_message(&owner)
            ),
            None => crate::authority::guard::refusal_message(&owner),
        };
        return WritePath::Refused(error);
    }
    // d. No owner, but a terminal may still be SHOWING this conversation (a
    //    TUI that resumed it and never typed — invisible to the guard).
    //    Rate-limited display adoption, unchanged.
    if try_display_adoption(state, session).await {
        return host_path(state, session).await;
    }
    // e. No host path at all: our own RPC child.
    metrics::inc("prompt_via_child");
    WritePath::Child
}

/// Transition into the host write path. Closes our child for the session if
/// one exists — it is idle ~270MB and a latent second writer (the TUI
/// rewrites the file wholesale from memory on exit/compaction, destroying
/// our entries — see guard.rs) — and pokes the collab_state badge so clients
/// render the host state immediately instead of on the next host broadcast.
async fn host_path(state: &Arc<AppState>, session: &str) -> WritePath {
    if state.children.has_child(session) {
        tracing::info!(%session, "host path live — closing our child writer");
        state.children.close(session).await;
    }
    state.hub.broadcast(session, &collab_state_frame());
    metrics::inc("prompt_via_host");
    WritePath::Host
}

/// One adoption at a time per session: a burst of sends must not type `/collab`
/// repeatedly into the same terminal. Returns false when one is already running.
static ADOPTING: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

fn adopt_start(session: &str) -> bool {
    match ADOPTING.lock() {
        Ok(mut g) => g.insert(session.to_string()),
        Err(_) => false,
    }
}

fn adopt_finish(session: &str) {
    if let Ok(mut g) = ADOPTING.lock() {
        g.remove(session);
    }
}

/// Cooldown for display-based adoption attempts, per session. Expired entries
/// are pruned on every attempt, so the map holds only sessions tried within
/// the last `ADOPT_RETRY_AFTER` instead of every session ever sent to.
static ADOPT_TRIED: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
const ADOPT_RETRY_AFTER: Duration = Duration::from_secs(120);

/// Record an adoption attempt for `session` now. With `respect_cooldown`,
/// refuses (returns false, records nothing) while the previous attempt is
/// younger than `ADOPT_RETRY_AFTER`.
fn adopt_mark_tried(session: &str, respect_cooldown: bool) -> bool {
    let mut g = ADOPT_TRIED.lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    g.retain(|_, t| now.duration_since(*t) < ADOPT_RETRY_AFTER);
    if respect_cooldown && g.contains_key(session) {
        return false;
    }
    g.insert(session.to_string(), now);
    true
}

/// Try to make a terminal that is merely DISPLAYING this conversation share it.
///
/// Ownership detection cannot see such a terminal: omp opens its append handle
/// lazily, so a TUI that resumed a conversation and never typed into it holds no
/// file handle and names no session in argv. Observed exactly that — a pane had
/// this conversation on screen for two minutes, invisible to the guard, while
/// the phone's messages went to the file and the laptop showed nothing.
///
/// herdr can read each agent's own output, so the pane is found by matching
/// recent conversation text. Returns true when a write-capable collab path now
/// exists, meaning the caller should route the write through the host.
async fn try_display_adoption(state: &Arc<AppState>, session: &str) -> bool {
    matches!(
        display_adoption_link(state, session, true).await,
        Adoption::Live(_)
    )
}

/// Outcome of a display-adoption attempt.
///
/// A three-state rather than `Option`: the explicit phone tap needs to know
/// WHY nothing happened. Reporting "couldn't find this conversation in any
/// terminal" while the laptop was visibly showing it (2026-09-14) is exactly
/// the kind of message this bug was made of.
pub(super) enum Adoption {
    /// A write-capable collab path now exists, reachable with this link.
    Live(String),
    /// Nothing was attempted; the message says why.
    Skipped(&'static str),
    /// Attempted and failed, with the reason to show the user.
    Failed(String),
}

/// Display-adoption core returning the adopted link: `respect_cooldown`
/// selects the write-path throttle (a phone can send repeatedly) versus an
/// explicit user tap, which asked NOW and runs the attempt regardless of when
/// the last one ran. Single-flight (`adopt_start`) applies either way.
pub(super) async fn display_adoption_link(
    state: &Arc<AppState>,
    session: &str,
    respect_cooldown: bool,
) -> Adoption {
    if state.collab.is_attached(session) && state.collab.can_write(session) {
        return Adoption::Skipped("this conversation is already connected");
    }
    // The automatic attempt runs ahead of every send window, so on a machine
    // where nothing could adopt an ownerless session (the phone: no herdr, no
    // Collab registry) it only delayed the send — by an `omp collab list`
    // start — before failing. An explicit tap still runs, to report why.
    if respect_cooldown && !crate::terminal::adopt::display_adoption_possible() {
        return Adoption::Skipped("no terminal on this machine can share it automatically");
    }
    // Rate limit: with no matching pane this costs a few terminal reads, and a
    // phone can send repeatedly.
    if !adopt_mark_tried(session, respect_cooldown) {
        return Adoption::Skipped("a recent attempt did not find a terminal");
    }
    if !adopt_start(session) {
        return Adoption::Skipped("already connecting to the desktop — try again in a moment");
    }
    metrics::inc("adopt_attempt");
    let cwd = session_cwd(&state.cfg, std::path::Path::new(session));
    let outcome = crate::terminal::adopt::adopt_session(session, cwd.to_str(), None).await;
    adopt_finish(session);
    let link = match outcome {
        Ok(link) => {
            metrics::inc("adopt_success");
            link
        }
        Err(e) => {
            tracing::debug!(%session, error = %e, "display adoption: not adopted");
            return Adoption::Failed(e);
        }
    };
    if let Err(e) = state.collab.register_and_tap(&link) {
        tracing::warn!(%session, error = %e, "display adoption: registration failed");
        return Adoption::Failed(format!("the desktop's share link was rejected ({e})"));
    }
    if let Err(e) = state.collab.attach(session, &link).await {
        tracing::warn!(%session, error = %e, "display adoption: guest attach failed");
        return Adoption::Failed(format!("could not join the desktop's link ({e})"));
    }
    for _ in 0..20 {
        if state.collab.is_attached(session) && state.collab.can_write(session) {
            tracing::info!(%session, "display adoption: desktop is now sharing; routing through the host");
            // Tell the phone immediately. Without this the badge keeps showing
            // "file only" until the host happens to broadcast state, which it
            // only does on change or while streaming — so a user who just
            // adopted sees a stale, wrong indicator (reported verbatim: "it says
            // file only").
            state.hub.broadcast(
                session,
                &json!({ "type": "event", "event": { "type": "collab_state" } }).to_string(),
            );
            return Adoption::Live(link);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Adoption::Failed(
        "the desktop shared this conversation but its link never became writable \
         (the room was replaced or the host left)"
            .to_string(),
    )
}

/// Refuse an action that must run in the daemon's own omp child unless no
/// other writer can hold the session. Deliberately stricter than
/// `write_path`: that one may type `/collab` into a desktop terminal to adopt
/// the session, which is the wrong side effect for an export or a delete,
/// and its owner verdict is cached. Here the guard runs fresh, and
/// `ChildManager::do_open` re-checks it before spawning anyway.
///
/// INVARIANT: when any layer sees another writer, or cannot tell, refuse.
pub(super) fn daemon_child_refusal(
    state: &Arc<AppState>,
    session: &str,
    there: &str,
) -> Option<Response> {
    let authority = session_authority(state, session);
    if authority.owner.kind == "ambiguous" {
        return Some(err_status(
            StatusCode::CONFLICT,
            "conflicting live session owners; nothing was changed",
        ));
    }
    let desktop = crate::omp::bridge::live_pid(session).is_some()
        || state.collab.is_attached(session)
        || !matches!(authority.owner.kind.as_str(), "none" | "child")
        || crate::authority::guard::foreign_session_owner(session, &state.children.live_pids())
            .is_some();
    desktop.then(|| {
        refusal_body(&format!(
            "this conversation is open in omp on the desktop — {there}"
        ))
    })
}

/// The typed refusal for a write when the desktop (or an ambiguity) owns the
/// session; `None` when the daemon's own child may write.
pub(super) fn ownership_refusal(path: WritePath) -> Option<Response> {
    match path {
        WritePath::Refused(reason) => Some(refusal_body(&reason)),
        WritePath::Host => Some(refusal_body(
            "session is collab-hosted by the desktop omp — change this setting in the desktop terminal, or connect via /collab to drive the session from the phone",
        )),
        WritePath::Bridge(_) => Some(refusal_body(
            "this conversation is open in omp on the desktop — change this setting there",
        )),
        WritePath::Child => None,
    }
}
