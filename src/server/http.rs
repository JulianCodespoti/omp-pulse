//! Axum HTTP router: REST API (wire-identical to omp-remote/server.ts),
//! static UI serving, and the /ws endpoint.
//!
//! Auth: every `/api/*` route requires `Authorization: Bearer <token>`; the
//! provided token is sha256'd and compared constant-time against
//! `cfg.token_hash`. `/ws` takes `?token=` instead. Static routes are open.
//! Session paths are canonicalized and must resolve under `cfg.sessions_root`.

use crate::{
    authority::command_ledger::CommandLedger,
    omp::child::ChildManager,
    omp::collab::{CollabManager, RelayManager},
    server::assets,
    server::push::Push,
    server::ws::WsHub,
    sessions::jsonl,
    sessions::watcher::Watcher,
    types::{Config, SharedConfig},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path},
    http::{HeaderMap, StatusCode, header},
    middleware,
    response::{IntoResponse, Redirect, Response},
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tower_http::compression::CompressionLayer;

mod auth;
mod control;
mod desktop;
mod dialog;
mod export;
mod files;
mod history;
mod local_direct;
mod media;
mod notify;
mod ownership;
mod plugins;
mod prompt;
mod providers;
mod queue_recovery;
mod receipts;
mod rpc;
mod search;
mod socket;
mod status;

use auth::*;
use control::*;
use desktop::*;
use dialog::*;
use export::*;
use files::*;
use history::*;
use local_direct::*;
use media::*;
use notify::*;
use ownership::*;
use plugins::*;
use prompt::*;
use receipts::*;
use rpc::*;
use search::*;
use socket::*;
use status::*;

pub use export::spawn_export_sweeper;

const MAX_PROMPT_IMAGES: usize = 8;
const MAX_IMAGE_BASE64_CHARS: usize = 5 * 1024 * 1024;
/// Body cap for the base64 JSON routes (/api/prompt, /api/transcribe): every
/// image at its own cap plus room for text and JSON framing. axum's 2 MiB
/// default rejected a few camera photos before the handler saw them.
const MAX_BASE64_JSON_BODY: usize = MAX_PROMPT_IMAGES * MAX_IMAGE_BASE64_CHARS + 1024 * 1024;
const PAYLOAD_TOO_LARGE_COPY: &str = "This message is too large to send. Try fewer photos.";

fn payload_too_large() -> Response {
    json_response(
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({ "ok": false, "code": "payload_too_large", "error": PAYLOAD_TOO_LARGE_COPY }),
    )
}

/// Answers an over-limit body with a JSON 413 (the native outbox parses the
/// body before the status; axum's text/plain 413 read as a lost connection and
/// was re-posted forever).
async fn json_payload_limit(request: axum::extract::Request, next: middleware::Next) -> Response {
    let declared = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|len| len > MAX_BASE64_JSON_BODY) {
        return payload_too_large();
    }
    let response = next.run(request).await;
    let is_json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if response.status() == StatusCode::PAYLOAD_TOO_LARGE && !is_json {
        return payload_too_large();
    }
    response
}

/// Shared application state handed to every handler.
pub struct AppState {
    pub cfg: SharedConfig,
    pub children: Arc<ChildManager>,
    pub session_states: Arc<crate::authority::session_state::SessionStateRegistry>,
    /// Durable command-ID ledger. Every prompt is inserted here before
    /// touching either the collab transport or an RPC child.
    pub commands: Arc<CommandLedger>,
    /// Device authorization registry (initialized by the security owner).
    pub devices: Arc<crate::server::device_auth::DeviceRegistry>,
    pub hub: Arc<WsHub>,
    pub watcher: Arc<Watcher>,
    pub push: Arc<Push>,
    pub collab: Arc<CollabManager>,
    /// Self-hosted collab relay: replaces the my.omp.sh dependency. The room
    /// key is derived client-side from the link secret (the client connects
    /// to the bare `/r/{roomId}`); the relay taps the host's stream and
    /// forwards guest-path frames.
    pub relay: Arc<RelayManager>,
    /// Speech-to-text for the composer's dictation button. Always present; it
    /// reports its own availability so a machine without the model answers with
    /// a reason instead of a 404.
    pub asr: Arc<crate::server::asr::Asr>,
    /// The HTTPS origin a phone should use, when a tailscale serve front door
    /// proxies this daemon. Resolved ONCE at startup, not per request: detection
    /// shells out to `tailscale serve status --json` (~50ms) and `/api/status` is
    /// polled on every session open. A plain-HTTP origin is not a secure context,
    /// so dictation, the service worker and Web Push are all dead there — the phone
    /// needs the real address to offer, and the app used to carry a HARDCODED
    /// tailnet URL that was wrong on every other machine.
    pub https_origin: Option<String>,
}

// Snippets and the listing payload now live in `crate::sessions::index`:
// the index holds the enriched rows AND the serialized payload per query,
// serves stale-while-revalidate, and answers If-None-Match / ?since= with
// 304 — see `index.rs` for the design and the measured numbers behind it.

/// Sessions just created by `/api/new`. A brand-new session's `.jsonl` is
/// materialized lazily by omp on first write, so `/api/open` and `/ws` would
/// 404 a fresh session — these paths are tolerated as empty sessions until the
/// file appears (bounded; pruned after 15 minutes).
static RECENT_NEW: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

// Content fingerprint of the served app: the embedded app's digest from
// `assets::build_id()` — the single source of truth for the stale-client
// heartbeat, shared with `/api/version` (see `assets.rs`).
//
// WHY: the phone runs the app as a PWA, and a PWA page never re-executes until
// it is closed and reopened — so a client can stay on hours-old JavaScript
// while the daemon serves the new file. That happened in practice: three UI
// fixes (resync-on-wake, the three-state badge, the turn timer) were live on
// disk and invisible on the phone, which produced exactly the symptoms the
// fixes were meant to remove. The fingerprint rides the WS heartbeat so a
// stale client can notice and offer a reload.

fn is_recent_new(path: &str) -> bool {
    let mut g = match RECENT_NEW.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let now = Instant::now();
    g.retain(|_, t| now.duration_since(*t) < Duration::from_secs(900));
    g.contains_key(path)
}

// --- Query/body extractor shapes -------------------------------------------

#[derive(Deserialize)]
struct SessionsQuery {
    q: Option<String>,
    /// ETag from a previous listing (`?since=<etag>`), for clients that
    /// cannot set `If-None-Match` headers. Same value the server returned
    /// in the ETag header — quotes included (URL-encoded).
    since: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
    live: Option<bool>,
    project: Option<String>,
}

#[derive(Deserialize)]
struct SessionQuery {
    session: Option<String>,
}

#[derive(Deserialize)]
struct ChangesQuery {
    session: Option<String>,
    summary: Option<String>,
}

#[derive(Deserialize)]
struct HistoryQuery {
    session: Option<String>,
    after: Option<String>,
    before: Option<String>,
    limit: Option<String>,
    feedback: Option<bool>,
}

#[derive(Deserialize)]
struct TurnsQuery {
    session: Option<String>,
    limit: Option<String>,
}

#[derive(Deserialize)]
struct TreeQuery {
    session: Option<String>,
    limit: Option<String>,
    before: Option<String>,
}

#[derive(Deserialize)]
struct FilesQuery {
    session: Option<String>,
    path: Option<String>,
    search: Option<String>,
}

#[derive(Deserialize)]
struct RawQuery {
    session: Option<String>,
    path: Option<String>,
    token: Option<String>,
}

#[derive(Deserialize)]
struct WsQuery {
    session: Option<String>,
    token: Option<String>,
    /// Client capability advertisement: comma-separated `delta`,`defl`,
    /// `bundle`. Unknown tokens are ignored (forward-compatible). A client
    /// that sends no `caps` gets every legacy frame byte-identical.
    caps: Option<String>,
    /// Entries in the bundle's first history page (`/ws` only); same default
    /// and cap as `/api/history`. The phone asks for a short first page so the
    /// first rows render sooner, then pages earlier history in when idle.
    limit: Option<String>,
}

#[derive(Deserialize)]
struct ReceiptsQuery {
    session: Option<String>,
}

#[derive(Deserialize)]
struct BrowseQuery {
    path: Option<String>,
}

// --- Response helpers -------------------------------------------------------

fn json_response(status: StatusCode, v: Value) -> Response {
    (status, Json(v)).into_response()
}

fn ok(v: Value) -> Response {
    json_response(StatusCode::OK, v)
}

/// Error bodies default to HTTP 200 with `ok:false` (mirrors server.ts,
/// which only uses non-200 statuses for auth/validation failures).
fn err(message: &str) -> Response {
    ok(json!({ "ok": false, "error": message }))
}

fn err_status(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "ok": false, "error": message }))
}

/// A child-manager error as a response. The pool-full refusal is a 503 with
/// the `agents_busy` code and a sentence a person can act on; anything else
/// keeps the `err` convention.
fn child_error(error: &str) -> Response {
    match crate::omp::child::agents_busy_message(error) {
        Some(sentence) => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "ok": false, "code": crate::omp::child::AGENTS_BUSY, "error": sentence }),
        ),
        None => err(error),
    }
}

/// True when a child-manager error is a session-file guard refusal: the file
/// is held open by a foreign omp terminal process, so spawning a writer was
/// refused. Surfaced to clients with a stable `code` alongside the error text.
fn owned_by_terminal(err: &str) -> bool {
    err.starts_with("session_owned_by_terminal")
}

/// Where a write for a session must be routed.
enum WritePath {
    /// The desktop omp that owns the session is connected over the extension
    /// bridge: hand the write to that process, which runs it through omp's
    /// own API (exactly one writer, no relay). Carries the owner pid.
    Bridge(i32),
    /// The desktop omp TUI is collab-sharing the session: route the write
    /// through the host (the laptop runs the turn; exactly one writer).
    Host,
    /// No host path is available: write through our own RPC child.
    Child,
    /// A foreign omp process owns the session file and adoption failed: the
    /// write is refused. Carries the refusal TEXT rather than a finished
    /// response, because `/api/prompt` records it in the command receipt — the
    /// receipt is the only place the phone learns WHY a send could not be
    /// delivered, and discarding the text here made every refused send read as
    /// the bare "session is owned by a desktop terminal" while the desktop's
    /// collab box was open on screen (reported 2026-09-14).
    Refused(String),
}

/// The owned-by-terminal refusal body, built from the text `WritePath::Refused`
/// carries. One builder so the endpoints that hand the response straight back
/// (`/api/bash`, mutating `/api/rpc`) cannot drift from the receipt path.
fn refusal_body(reason: &str) -> Response {
    ok(json!({
        "ok": false,
        "error": reason,
        "code": "session_owned_by_terminal",
    }))
}

/// The bare collab-state badge poke: tells clients to re-read their collab
/// attachment state. Without it the badge keeps showing a stale value until
/// the host happens to broadcast state on change or while streaming.
fn collab_state_frame() -> String {
    json!({ "type": "event", "event": { "type": "collab_state" } }).to_string()
}

fn not_found() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("not found"))
        .unwrap_or_else(|_| Response::new(Body::from("not found")))
}

// --- Session path resolution ------------------------------------------------

/// Resolve a client-supplied session path and require it under
/// `cfg.sessions_root` (symlink-safe, mirrors server.ts `resolveSessionPath`).
/// A file that does not exist yet (fresh `/api/new` session) resolves via its
/// deepest existing ancestor so callers can distinguish "invalid path" from
/// "session file not found".
fn resolve_session_path(cfg: &Config, raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || !raw.ends_with(".jsonl") {
        return None;
    }
    let root = cfg
        .sessions_root
        .canonicalize()
        .unwrap_or_else(|_| cfg.sessions_root.clone());
    let abs = PathBuf::from(raw);
    if let Ok(real) = abs.canonicalize() {
        return (real == root || real.starts_with(&root)).then_some(real);
    }
    let mut probe = abs;
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = probe.canonicalize() {
            let mut joined = real;
            for comp in tail.iter().rev() {
                joined.push(comp);
            }
            return (joined == root || joined.starts_with(&root)).then_some(joined);
        }
        let name = probe.file_name()?;
        tail.push(name.to_os_string());
        if !probe.pop() {
            return None;
        }
    }
}

fn session_str(path: &FsPath) -> Result<String, Box<Response>> {
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| Box::new(err("invalid session path")))
}

/// Terminal adoption's cwd hint: a usable header directory, otherwise HOME.
fn session_cwd(cfg: &Config, session_path: &FsPath) -> PathBuf {
    let header = jsonl::parse_header(session_path);
    match header.cwd {
        Some(cwd) if FsPath::new(&cwd).is_dir() => PathBuf::from(cwd),
        _ => cfg.home.clone(),
    }
}

fn body_value(body: Option<Json<Value>>) -> Value {
    body.map(|b| b.0).unwrap_or_else(|| json!({}))
}

fn session_path_from_body(body: &Value) -> Option<&str> {
    body.get("sessionPath")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// Run a transcript read on the blocking pool. The runtime has two worker
/// threads, and a read of a large session file holds its worker for its whole
/// duration: measured in a phone's proot guest against a 28 MB transcript, a history
/// page took 20–60 ms, `/api/turns` ~100 ms and `/api/agents` ~115 ms, during
/// which every socket and request scheduled on that worker waited. `None`
/// only when the read panicked.
async fn off_runtime<T: Send + 'static>(read: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(read).await.ok()
}

// --- Session authority -------------------------------------------------------

/// The daemon's word on a session's turn, shared by the bundle and every
/// `/api/history` page so the phone can settle "working" on either path.
struct TurnState {
    /// Whether a turn is running, from every source that actually knows: the
    /// desktop bridge (no daemon child exists for it) and the daemon's own
    /// child. `None` for a session neither drives (a terminal omp without the
    /// extension): the daemon cannot say. The phone CLEARS "working" from this,
    /// not only sets it: a turn that ended while its socket was down (a daemon
    /// restart drops every socket) used to show Running forever, and Stop then
    /// aborted a turn that had already finished.
    running: Option<bool>,
    /// `activity::current`: what the turn is doing, `null` when idle.
    now: Value,
    /// The daemon's clock, which `now`'s times are on.
    at: u64,
    authority: crate::authority::session_state::SessionState,
    /// The turn a kill cut off, while it shows (`crate::authority::interrupted`).
    interrupted: Option<crate::authority::interrupted::Interruption>,
}

fn turn_state(state: &Arc<AppState>, session: &str) -> TurnState {
    let authority = session_authority(state, session);
    TurnState {
        running: match authority.turn {
            crate::authority::session_state::Turn::Running => Some(true),
            crate::authority::session_state::Turn::Idle => Some(false),
            crate::authority::session_state::Turn::Unknown => None,
        },
        now: authority.legacy_now(),
        at: crate::authority::activity::now_ms(),
        interrupted: crate::authority::interrupted::visible(session, &authority),
        authority,
    }
}

/// All HTTP and listing projections enter the same source-fenced record.
pub(crate) fn session_authority(
    state: &AppState,
    session: &str,
) -> crate::authority::session_state::SessionState {
    use crate::authority::session_state::{
        Capabilities, Confidence, Connection, Owner, Seed, Turn,
    };
    if state.session_states.current(session).is_none() {
        crate::sessions::index::project_cached_authority(state, session);
    }
    let mut accepted = None;
    for snapshot in [
        state.children.authority_snapshot(session),
        crate::omp::bridge::authority_snapshot(session),
        state.collab.authority_snapshot(session),
    ]
    .into_iter()
    .flatten()
    {
        let (stamp, running) = snapshot;
        let owner = stamp.identity.wire_owner();
        let activity = state
            .session_states
            .current(session)
            .filter(|current| current.owner == owner)
            .and_then(|current| current.activity);
        accepted = Some(state.session_states.project(
            session,
            Seed {
                owner,
                turn: if running { Turn::Running } else { Turn::Idle },
                confidence: Confidence::Confirmed,
                connection: Connection::Connected,
                activity: if running { activity } else { None },
                capabilities:
                    crate::authority::session_state::SessionStateRegistry::capabilities_for(
                        &stamp.identity,
                    ),
                source: Some(stamp.identity),
                sequence: stamp.sequence,
            },
        ));
    }
    accepted
        .or_else(|| state.session_states.current(session))
        .unwrap_or_else(|| {
            state.session_states.project(
                session,
                Seed {
                    owner: Owner {
                        kind: "none".to_owned(),
                        pid: None,
                        process_start: None,
                        peer_id: None,
                        room_id: None,
                        can_write: None,
                    },
                    turn: Turn::Unknown,
                    confidence: Confidence::Inferred,
                    connection: Connection::Unavailable,
                    activity: None,
                    capabilities: Capabilities::default(),
                    source: None,
                    sequence: 0,
                },
            )
        })
}

/// Add a turn's fields to a history page (`running` only when known).
fn merge_turn(page: &mut Value, turn: TurnState) {
    page["now"] = turn.now;
    page["at"] = json!(turn.at);
    page["sessionState"] = serde_json::to_value(turn.authority).unwrap_or(Value::Null);
    page["interrupted"] = json!(turn.interrupted);
    if let Some(running) = turn.running {
        page["running"] = json!(running);
    }
}

// --- Static files ------------------------------------------------------------

/// Serve a web-app resource from the embedded assets (or the developer's
/// override directory when one is configured — see `assets::set_override_dir`).
///
/// `assets::read` owns the override-vs-embedded decision, the traversal guard,
/// and the content-type of whatever it resolved to. Content-type is
/// deliberately NOT decided here: only `assets` knows which file a request
/// actually landed on, because "/app/" has no extension yet serves
/// `app/index.html`. Deriving the type from the request path labelled that
/// `application/octet-stream`, which makes a browser download the page
/// instead of rendering it.
///
/// This function keeps the cache policy. Shell entries (`/`, `/index.html`,
/// `/sw.js`, `/manifest.webmanifest`) are `no-cache` — the PWA shell must
/// revalidate every load, and a cached service worker is exactly how stale
/// UIs stay stale. Vite's `name-HASH.ext` assets (structurally detected via
/// `assets::is_hashed_asset`) are `public, max-age=31536000, immutable`;
/// everything else is conservatively `no-cache` so an unrecognised path never
/// sticks.
///
/// Encoding: a request that still carries `Accept-Encoding` (remote; the
/// local-direct middleware strips it so the on-phone WebView gets identity)
/// is answered with the build's stored `.br`/`.gz` sidecar when one exists.
/// The route's `CompressionLayer` leaves a response that already has
/// `Content-Encoding` alone, so this replaces runtime gzip-6 (~85 ms of phone
/// CPU per cold remote load) instead of stacking on it.
fn serve_static(request_path: &str, accept_encoding: &str) -> Response {
    // A directory must be reached with its trailing slash, or the shell's
    // relative asset URLs resolve one level too high — see
    // `assets::needs_trailing_slash`. 308 keeps the method and is cacheable.
    if assets::needs_trailing_slash(request_path) {
        return Response::builder()
            .status(StatusCode::PERMANENT_REDIRECT)
            .header("location", format!("{request_path}/"))
            .body(Body::empty())
            .unwrap_or_else(|_| not_found());
    }
    if let Some((body, ctype, encoding)) = assets::read_precompressed(request_path, accept_encoding)
    {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", ctype)
            .header("content-encoding", encoding.token())
            .header("vary", "accept-encoding")
            .header("cache-control", assets::cache_control(request_path))
            .body(Body::from(body))
            .unwrap_or_else(|_| not_found());
    }
    let Some((body, ctype)) = assets::read(request_path) else {
        return not_found();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", ctype)
        .header("cache-control", assets::cache_control(request_path))
        .body(Body::from(body))
        .unwrap_or_else(|_| not_found())
}

/// The legacy root client is gone: `/` permanently redirects to the React
/// client at `/app/` (bookmarks and old shells keep working; the PWA scope
/// and the APK both live under `/app/`).
async fn static_index() -> Response {
    Redirect::permanent("/app/").into_response()
}
async fn static_file(headers: HeaderMap, Path(rel): Path<String>) -> Response {
    // axum 0.8 wildcard captures carry no leading slash ("/sw.js" -> "sw.js");
    // assets expects the web-path form with it. The no-cache decision for
    // sw.js lives in `assets::cache_control`, keyed on this web-path form.
    let accept_encoding = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    serve_static(&format!("/{rel}"), accept_encoding)
}

// --- Router ------------------------------------------------------------------

/// Build the full axum router. All state lives in `AppState`; the sessions
/// scan cache is module-level (the contract fixes AppState's field set).
/// The state is baked in at construction, so the returned router is
/// `Router` with state applied (serve it directly with `axum::serve`).
pub fn router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/sessions", get(sessions))
        .route("/awaiting", get(awaiting))
        .route("/version", get(version))
        .route("/status", get(status))
        .route("/busy", get(busy))
        .route("/health", get(health))
        .route("/model-usage", get(model_usage))
        .route("/diagnostics", get(diagnostics))
        .route("/search", get(search))
        .route("/commands", get(commands))
        .route("/receipts", get(receipts))
        .route("/receipts/{command_id}", get(receipt))
        .route("/device", get(device_me))
        .route("/devices", get(list_devices))
        .route("/devices/pairing-codes", post(issue_pairing_code))
        .route("/devices/{device_id}", delete(revoke_device))
        .route("/history", get(history))
        .route("/turns", get(turns))
        .route("/agents", get(agents))
        .route("/agents/transcript", get(agent_transcript))
        .route("/agents/roster", get(agent_roster))
        .route("/agents/file", get(agent_file))
        .route("/tree", get(tree))
        .route("/desktop/open", post(desktop_open))
        .route("/desktop/close", post(desktop_close))
        .route("/files", get(files))
        .route("/changes", get(changes))
        .route("/browse", get(browse))
        .route(
            "/file",
            get(file)
                .post(post_file)
                .layer(DefaultBodyLimit::max(files::MAX_FILE_SAVE_BODY)),
        )
        .route("/raw", get(raw))
        .route("/image", get(session_image))
        .route("/open", post(open))
        .route("/prewarm", post(prewarm))
        .route(
            "/transcribe",
            post(transcribe)
                .route_layer(middleware::from_fn(json_payload_limit))
                .layer(DefaultBodyLimit::max(MAX_BASE64_JSON_BODY)),
        )
        .route("/transcribe/warm", post(transcribe_warm))
        .route(
            "/prompt",
            post(prompt)
                .route_layer(middleware::from_fn(json_payload_limit))
                .layer(DefaultBodyLimit::max(MAX_BASE64_JSON_BODY)),
        )
        .route("/bash", post(bash))
        .route("/command", post(command))
        .route("/export", post(export_session))
        .route("/session/delete", post(delete_session))
        .route("/abort", post(abort))
        .route("/interrupted/dismiss", post(dismiss_interrupted))
        .route("/new", post(new_session))
        .route("/rpc", post(rpc))
        .route("/providers", get(providers::providers_list))
        .route(
            "/providers/login",
            get(providers::login_state).post(providers::login_start),
        )
        .route("/providers/login/input", post(providers::login_input))
        .route("/providers/login/cancel", post(providers::login_cancel))
        .route("/plugins", get(plugin_list))
        .route("/plugins/{id}/client.js", get(plugin_client_script))
        .route("/plugins/{id}/state", post(plugin_set_state))
        .route("/plugins/{id}/sources/{source}", get(plugin_source))
        .route("/plugins/{id}/options", post(plugin_set_options))
        .route("/plugins/{id}/actions/{action}", post(plugin_run_action))
        .route("/panes/answer", post(answer_pane))
        .route("/push/status", get(push_status))
        .route("/push/vapid-public-key", get(vapid_public_key))
        .route("/push/subscribe", post(push_subscribe))
        .route("/push/unsubscribe", post(push_unsubscribe))
        .route("/blob/{hash}", get(blob))
        .route("/collab/attach", post(collab_attach))
        .route("/collab/detach", post(collab_detach))
        .route("/collab/register", post(collab_register))
        .route("/collab/announce", post(collab_announce))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
        // Compress every /api/* response (measured: session listing 0.128x,
        // history page 0.0151x — docs/internals/performance.md F3). The layer sits on the api
        // router only, so the WS upgrade routes below never see it — a
        // compressed 101 Switching Protocols would be a protocol violation.
        .layer(CompressionLayer::new());

    Router::new()
        // Pairing is the sole unauthenticated API route. Its code is
        // short-lived and consumed atomically; it never accepts owner tokens.
        .route("/api/pair", post(pair_device))
        .nest("/api", api)
        // would buffer the stream (a buffered SSE is a silent hang that looks
        // like "notifications don't work"). The handler also sets
        // `X-Accel-Buffering: no` for nginx. Auth is checked inside the
        // handler (Bearer header OR ?token=) mirroring `/ws`, so it lives
        // outside the `require_auth` middleware.
        .route("/api/notify/stream", get(notify_stream))
        .route("/api/debug/notify", post(debug_notify))
        .route("/raw", get(raw_public))
        // Static routes compress too (index.html 0.242x); each route carries
        // its own layer so `/ws` and `/r/*` stay uncompressed. Existing
        // cache-control behaviour is untouched: / and /sw.js no-cache, other
        // static `public, max-age=86400` — compression adds `Vary:
        // accept-encoding`, never a cache directive.
        .route("/", get(static_index).layer(CompressionLayer::new()))
        // Collab relay endpoints — UNAUTHENTICATED (the room key is derived
        // client-side from the link secret). The real omp client connects to
        // the bare /r/{room} form (the link secret is stripped before
        // connecting — see T36 in the omp binary); /r/{room}/{secret} is kept
        // for link-shape compatibility. Registered BEFORE the static catch-all
        // so the /r/ match is explicit, not incidental.
        .route("/r/{token}", get(relay_ws_handler))
        .route("/r/{room}/{secret}", get(relay_ws_handler_with_secret))
        // Live sockets, before the static catch-all like the relay routes:
        // `/ws` is the per-conversation channel (frames, watching, prewarm),
        // `/ws/sessions` the listing nudge channel. Both were once dropped
        // by a router refactor with no test noticing — the app limps on HTTP
        // polling without them, merely laggy rather than broken.
        .route("/ws", get(ws_handler))
        .route("/ws/sessions", get(sessions_ws_handler))
        .route("/{*path}", get(static_file).layer(CompressionLayer::new()))
        // Outermost, so every route's CompressionLayer sees the request after
        // a local-direct client's Accept-Encoding is gone.
        .layer(middleware::from_fn(identity_for_local_direct))
        .with_state(state)
}

#[cfg(test)]
mod tests;
