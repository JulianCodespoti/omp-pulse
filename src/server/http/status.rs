//! Daemon status endpoints: version, health, model usage, status, the busy
//! long-poll and diagnostics.

use super::*;
use crate::{metrics, server::assets, sessions::index};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Response,
};
use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Compare the loaded client with the same release identity served on both
/// socket heartbeats. Git labels alone cannot distinguish dirty builds.
pub(super) async fn version() -> Response {
    ok(json!({
        "ok": true,
        "version": assets::build_id(),
        "releaseId": assets::build_id(),
        "build": assets::build_id(),
        "protocolVersion": assets::PROTOCOL_VERSION,
        "minClientProtocolVersion": assets::MIN_CLIENT_PROTOCOL_VERSION,
        "capabilities": assets::CAPABILITIES,
    }))
}

/// On-demand phone diagnostics must not run the doctor's live probe or spawn a
/// child. Project paths, transcripts, raw errors and credentials never enter
/// this export-safe payload.
pub(super) async fn health(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionQuery>,
) -> Response {
    let session = if let Some(raw) = query.session.as_deref() {
        let Some(path) = resolve_session_path(&state.cfg, raw) else {
            return err_status(StatusCode::BAD_REQUEST, "invalid session path");
        };
        let Ok(session) = session_str(&path) else {
            return err_status(StatusCode::BAD_REQUEST, "invalid session path");
        };
        let route = if state.collab.can_write(&session) {
            "desktop-relay"
        } else if state.children.has_child(&session) {
            "daemon-child"
        } else {
            "unestablished"
        };
        let receipts = state.commands.for_session(&session);
        let recent: Vec<Value> = receipts.iter().rev().take(20).rev().map(|receipt| {
            json!({
                "commandIdHash": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(receipt.command_id.as_bytes())),
                "state": receipt.state.as_str(),
                "updatedAt": receipt.updated_at,
                "code": receipt.code,
            })
        }).collect();
        Some(json!({
            "controlRoute": route,
            "childRunning": state.children.is_streaming(&session),
            "receipts": recent,
        }))
    } else {
        None
    };
    let mut environment_keys: Vec<String> = std::env::vars_os()
        .filter_map(|(key, value)| {
            let key = key.to_str()?;
            if value.is_empty()
                || key.len() > 80
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            {
                return None;
            }
            (key.ends_with("_API_KEY")
                || matches!(key, "ANTHROPIC_AUTH_TOKEN" | "OPENAI_ACCESS_TOKEN"))
            .then(|| key.to_owned())
        })
        .collect();
    environment_keys.sort_unstable();
    ok(json!({
        "ok": true,
        "observedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0),
        "releaseId": assets::build_id(),
        "protocolVersion": assets::PROTOCOL_VERSION,
        "minClientProtocolVersion": assets::MIN_CLIENT_PROTOCOL_VERSION,
        "credentials": {
            "environmentKeys": environment_keys,
            "brokerEnvironmentConfigured": std::env::var_os("OMP_AUTH_BROKER_URL").is_some(),
            // OMP resolves broker/config/login/environment precedence internally.
            // Presence of an environment override is evidence, not proof it won.
            "effectiveSource": null,
        },
        "session": session,
    }))
}

/// Most-recently-used model keys from omp's read-only agent database. An
/// unreadable or schema-drifted database is intentionally indistinguishable
/// from an empty history so opening the picker can never break the daemon.
pub(super) async fn model_usage(State(state): State<Arc<AppState>>) -> Response {
    let models = crate::sessions::model_usage::recent_model_keys(&state.cfg.sessions_root);
    ok(json!({ "ok": true, "models": models }))
}

pub(super) async fn status(State(state): State<Arc<AppState>>) -> Response {
    ok(status_json(&state))
}

/// Longest `/api/busy` hold. The Android shell reads with a 300 s+ timeout
/// and asks for less, so a held poll always answers before the client gives up.
const BUSY_WAIT_MAX_SECS: u64 = 300;

#[derive(serde::Deserialize)]
pub(super) struct BusyQuery {
    /// The last version the client saw; absent answers at once.
    after: Option<u64>,
    /// Seconds to hold an unchanged answer, capped at [`BUSY_WAIT_MAX_SECS`].
    wait: Option<u64>,
}

/// `GET /api/busy?after=<version>&wait=<s>`: `{busy, version}` at once when
/// the version differs from `after`, else on the next flip, else unchanged
/// once `wait` runs out. The phone's wake lock follows this
/// (`LocalPulseService`): it used to be held for the service's whole life,
/// so the phone never slept. A long-poll rather than a timer, so a sleeping
/// phone is never woken just to ask.
pub(super) async fn busy(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BusyQuery>,
) -> Response {
    let wait = std::time::Duration::from_secs(query.wait.unwrap_or(0).min(BUSY_WAIT_MAX_SECS));
    let state =
        crate::omp::child::wait_busy_change(state.children.busy_state(), query.after, wait).await;
    ok(json!({ "busy": state.busy, "version": state.version }))
}

/// The full `/api/status` body. Shared verbatim by `GET /api/diagnostics`
/// (its `status` field must BE the status body, not a paraphrase), so the
/// two endpoints can never drift apart.
fn status_json(state: &Arc<AppState>) -> Value {
    let busy_children = state.children.streaming_sessions();
    json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "buildId": assets::build_id(),
        "releaseId": assets::build_id(),
        "protocolVersion": assets::PROTOCOL_VERSION,
        "minClientProtocolVersion": assets::MIN_CLIENT_PROTOCOL_VERSION,
        "platform": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
        "bind": format!("{}:{}", state.cfg.host, state.cfg.port),
        "bindLoopback": bind_is_loopback(&state.cfg.host),
        // The HTTPS origin a phone should be on. A plain-HTTP origin is not a
        // secure context, so the microphone, service worker and Web Push are all
        // unavailable there — and the app used to say so with a HARDCODED tailnet
        // URL, which is wrong on every other machine. Published here so the phone
        // can name the real address and offer it as a tap. Detected once per
        // process: it shells out to `tailscale serve status --json` (~50ms), which
        // must not run on every status poll.
        "httpsOrigin": state.https_origin.clone(),
        "sessionsRoot": state.cfg.sessions_root.to_string_lossy(),
        // WHICH omp this daemon actually spawns. `doctor` used to resolve the
        // binary itself, from a shell whose PATH differed from the service's, so
        // it reported a healthy 17.3.3 while the daemon was spawning a stale
        // 17.2.15 that died on negotiate. A daemon must publish what it uses, not
        // let a diagnostic guess.
        "ompBin": state.cfg.omp_bin.to_string_lossy(),
        // Dictation availability, so the phone can label its microphone button
        // honestly instead of offering a control that will fail.
        "asr": match state.asr.availability() {
            crate::server::asr::Availability::Ready { model } => json!({ "ready": true, "model": model }),
            crate::server::asr::Availability::Missing { reason } => json!({ "ready": false, "reason": reason }),
        },
        "metrics": metrics::snapshot(),
        "children": state.children.live_count(),
        "child_stats": state.children.stats(),
        // Process-wide agent truth. Status is NOT per-session, so these are
        // "any live child" / "any streaming child" across every daemon child,
        // not a per-session answer (per-session streaming lives in the
        // listing rows' `running`/`status`).
        "agent": {
            "alive": state.children.live_count() > 0,
            "streaming": !busy_children.is_empty(),
        },
        // The turns a restart of THIS process would kill: sessions whose daemon
        // child is mid-turn. `scripts/deploy/pulse-restart.sh` waits on this. The old
        // listing-based check also counted desktop-bridged turns, which run in
        // their own process and survive a restart, so a long laptop turn held
        // every deploy hostage until it timed out.
        "busyChildren": busy_children,
        // Any daemon child with work the CPU must stay awake for: a turn, an
        // accepted prompt, background jobs or subagents, a side question, a
        // dialog or an RPC in flight (the reaper's predicate). Diagnostics
        // for the phone wake lock, which follows `/api/busy`; `busyChildren`
        // above stays the restart gate.
        "busyWork": state.children.any_busy(),
        // The desktop collab link state: attached / reconnecting / lost when
        // a desktop omp shares a session, else "none".
        "desktopLink": desktop_link_state(),
        "hub": state.hub.stats(),
        "index": index::stats(),
        "sessions_cached": index::is_cached(),
    })
}

/// The desktop collab link state published by `/api/status`: the summary
/// accessor in collab.rs (attached wins, then reconnecting, then lost, else
/// none). It covers the guest-attach path — the self-hosted relay/tap path
/// reports its own stream-lost notices and never touches this.
fn desktop_link_state() -> &'static str {
    crate::omp::collab::link_state_summary()
}

/// Machine-readable doctor run for the phone (contract 4):
/// `{ok, checks:[{name,pass,detail}], metrics, status}`. `checks` IS what
/// `omp_pulse doctor` prints (both consume `doctor::run_checks` — one source
/// of truth), `metrics` is the live counter snapshot, and `status` is the
/// exact `/api/status` body. On-demand only: the live-probe check can take
/// up to ~40 s on a broken collab chain (same cost as the CLI doctor).
pub(super) async fn diagnostics(State(state): State<Arc<AppState>>) -> Response {
    let checks: Vec<Value> = crate::doctor::run_checks(&state.cfg)
        .await
        .iter()
        .map(|c| c.as_json())
        .collect();
    ok(json!({
        "ok": true,
        "checks": checks,
        "metrics": metrics::snapshot(),
        "status": status_json(&state),
    }))
}
