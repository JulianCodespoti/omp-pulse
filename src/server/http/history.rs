//! Read-side session endpoints: the listing, the command catalogue, history
//! pages, turns, subagents, transcripts and the conversation tree.

use super::*;
use crate::{sessions::index, sessions::jsonl};
use axum::{
    Json,
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::sync::Arc;

const HISTORY_FORWARD_LIMIT: usize = 200;
const TURNS_DEFAULT_LIMIT: usize = 25;
const TURNS_MAX_LIMIT: usize = 100;
const TREE_DEFAULT_LIMIT: usize = 40;
const TREE_MAX_LIMIT: usize = 200;

pub(super) async fn sessions(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionsQuery>,
    Query(pairs): Query<Vec<(String, String)>>,
    headers: HeaderMap,
) -> Response {
    // Validator precedence: the standard If-None-Match header wins; `?since=`
    // is the fallback for clients that cannot set headers. Both carry the
    // same value the server returned in the ETag header (quotes included).
    let validator = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| q.since.clone());
    let request = index::ListingRequest {
        q: q.q.unwrap_or_default(),
        project: q.project,
        limit: q.limit.unwrap_or(index::DEFAULT_PAGE_SIZE),
        cursor: q.cursor,
        // Scalar serde_urlencoded fields reject repeated values; preserve
        // repeated pinned paths through its supported pair-list representation.
        pinned: pairs
            .into_iter()
            .filter_map(|(key, value)| (key == "pinned").then_some(value))
            .collect(),
        include_live: q.live.unwrap_or(true),
    };
    let listing = match index::listing(&state, request, validator.as_deref()).await {
        Ok(listing) => listing,
        Err(index::ListingError::InvalidCursor) => {
            return err_status(StatusCode::BAD_REQUEST, "invalid session cursor");
        }
        Err(index::ListingError::Worker(error)) => {
            tracing::error!(error = ?error, "session listing worker failed");
            return err_status(
                StatusCode::SERVICE_UNAVAILABLE,
                "session listing unavailable",
            );
        }
    };
    match listing {
        // 304: the client's copy is current — empty body, so the steady-state
        // poll goes from 1.87 MB to ~0 bytes (measured).
        index::Listing::NotModified { etag } => Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .body(Body::empty())
            .unwrap_or_else(|_| not_found()),
        index::Listing::Payload { body, etag } => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ETAG, etag)
            .body(Body::from(body))
            .unwrap_or_else(|_| not_found()),
    }
}

/// The command catalogue is NOT session state. Asking for it through the
/// session's exclusive child meant the phone got nothing whenever the desktop
/// held that session open, which is the normal case for a phone driving a
/// desktop conversation: the ownership guard refused with
/// `session_owned_by_terminal` and the palette fell back to a two-command stub.
/// Measured against the real binary: a child answers with no session bound at
/// all, 130 commands in about a second.
///
/// Use the project catalogue path for both live and ephemeral children so
/// project prompt templates are included alongside native commands. Never
/// substitute HOME when the saved project directory is unavailable.
pub(super) async fn commands(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionQuery>,
) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err("invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    let cwd = match files::project_cwd(&path) {
        Ok(cwd) => cwd,
        Err(response) => return *response,
    };

    match state
        .children
        .catalogue_rpc(&cwd.to_string_lossy(), "get_available_commands")
        .await
    {
        Ok(data) => {
            let cmds = data.get("commands").cloned().unwrap_or_else(|| json!([]));
            ok(json!({ "ok": true, "commands": cmds }))
        }
        Err(e) => child_error(&e),
    }
}

/// Keep the replay tied to the authority captured before the history read.
/// A binding change during capture must not label another owner's feedback
/// with the old revision. Live updates after capture remain socket-ordered.
fn history_feedback(state: &Arc<AppState>, session: &str, turn: &TurnState) -> Option<Value> {
    let feedback = match turn.authority.owner.kind.as_str() {
        "bridge" => crate::omp::bridge::feedback_snapshot(session)?,
        "child" => state.children.feedback_snapshot(session),
        _ => json!({"type": "extension_ui_snapshot", "requests": []}),
    };
    let current = session_authority(state, session);
    (current.daemon_instance_id == turn.authority.daemon_instance_id
        && current.binding_epoch == turn.authority.binding_epoch
        && current.revision == turn.authority.revision)
        .then_some(feedback)
}

/// Blocking questions are an exact set, not feedback and not history entries.
/// Use the existing child replay payloads (including remaining timeout and
/// pipe-handoff evidence), fenced to the same owner as this page.
fn history_dialogs(state: &Arc<AppState>, session: &str, turn: &TurnState) -> Option<Value> {
    if turn.authority.owner.kind != "child" {
        return None;
    }
    let requests = state.children.pending_ui_requests(session);
    let current = session_authority(state, session);
    (current.daemon_instance_id == turn.authority.daemon_instance_id
        && current.binding_epoch == turn.authority.binding_epoch
        && current.revision == turn.authority.revision)
        .then(|| json!({"type": "extension_dialog_snapshot", "requests": requests}))
}

pub(super) async fn history(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HistoryQuery>,
) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err("invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    // Reference returns ok:false at HTTP 200 here (server.ts passes no
    // status); only /api/open uses the 404 shape. Fresh /api/new sessions
    // have no file yet — serve an empty page so the app opens cleanly.
    if !path.is_file() {
        let Ok(session) = session_str(&path) else {
            return err("invalid session path");
        };
        if is_recent_new(&session) {
            let mut page = json!({ "entries": [], "endOffset": 0, "nextBefore": null });
            let turn = turn_state(&state, &session);
            if q.feedback == Some(true)
                && let Some(feedback) = history_feedback(&state, &session, &turn)
            {
                page["extensionFeedback"] = feedback;
            }
            if q.feedback == Some(true)
                && let Some(dialogs) = history_dialogs(&state, &session, &turn)
            {
                page["extensionDialogs"] = dialogs;
            }
            merge_turn(&mut page, turn);
            return ok(page);
        }
        return err("session file not found");
    }
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    // Every page carries the daemon's word on the turn, because a page is how
    // the phone recovers after its socket skipped frames. A `resync` clears the
    // client's queue INCLUDING the turn's `agent_end` and the idle `activity`
    // frame, and the phone then refetched only history: the chat kept "Writing…"
    // with a clock counting from the long-finished turn, and Stop stayed up
    // until the conversation was reopened. Measured 2026-09-25: 1,896 resyncs
    // on the live daemon in two hours.
    let turn = turn_state(&state, &session);
    let feedback = if q.feedback == Some(true) {
        history_feedback(&state, &session, &turn)
    } else {
        None
    };
    let dialogs = if q.feedback == Some(true) {
        history_dialogs(&state, &session, &turn)
    } else {
        None
    };
    if let Some(after_raw) = q.after.as_deref().filter(|s| !s.is_empty()) {
        let after: u64 = match after_raw.parse() {
            Ok(n) => n,
            Err(_) => return err_status(StatusCode::BAD_REQUEST, "invalid after"),
        };
        let Some((fr, configuration)) = off_runtime(move || {
            let configuration = index::session_configuration(&path.to_string_lossy());
            (
                jsonl::read_forward(&path, after, HISTORY_FORWARD_LIMIT),
                configuration,
            )
        })
        .await
        else {
            return err_status(StatusCode::INTERNAL_SERVER_ERROR, "history read failed");
        };
        let mut page = json!({ "entries": fr.entries, "endOffset": fr.end_offset });
        page["sessionModelPending"] = json!(configuration.is_none());
        if let Some(configuration) = configuration {
            page["sessionModel"] = json!(configuration);
        }
        merge_turn(&mut page, turn);
        if let Some(feedback) = feedback {
            page["extensionFeedback"] = feedback;
        }
        if let Some(dialogs) = dialogs {
            page["extensionDialogs"] = dialogs;
        }
        return ok(page);
    }
    let before = match q.before.as_deref().filter(|s| !s.is_empty()) {
        Some(b) => match b.parse::<u64>() {
            Ok(n) => Some(n),
            Err(_) => return err_status(StatusCode::BAD_REQUEST, "invalid before"),
        },
        None => None,
    };
    let limit = backward_limit(q.limit.as_deref());
    // `endOffset` comes from the read itself, never a later stat: see
    // `BackwardRead::end_offset`.
    let Some((br, configuration)) = off_runtime(move || {
        let configuration = index::session_configuration(&path.to_string_lossy());
        (jsonl::read_backward(&path, before, limit), configuration)
    })
    .await
    else {
        return err_status(StatusCode::INTERNAL_SERVER_ERROR, "history read failed");
    };
    let mut page = json!({
        "entries": br.entries,
        "nextBefore": br.next_before,
        "endOffset": br.end_offset,
    });
    page["sessionModelPending"] = json!(configuration.is_none());
    if let Some(configuration) = configuration {
        page["sessionModel"] = json!(configuration);
    }
    merge_turn(&mut page, turn);
    if let Some(feedback) = feedback {
        page["extensionFeedback"] = feedback;
    }
    if let Some(dialogs) = dialogs {
        page["extensionDialogs"] = dialogs;
    }
    ok(page)
}

/// The phone's read-only turn timeline. Every RPC on a session the desktop
/// omp holds open is refused (`session_owned_by_terminal`), so this is the
/// one path that still shows the conversation's user turns on a
/// desktop-driven session — and the client cannot read them itself: measured
/// live, the session file is 43 MB with user turns ~93 entries apart and ~20
/// entries per 256 KiB page, so a bounded client scan found zero turns in
/// 60 s. The daemon's bounded backward scan (`jsonl::read_user_turns`)
/// returns a few KB.
///
/// Path validation mirrors `/api/history` exactly — same `invalid session
/// path` errors, and a fresh `/api/new` session (whose file materializes on
/// first write) is tolerated as an empty timeline. A genuinely missing file
/// is the codebase's JSON 404 shape (`err_status(NOT_FOUND, …)`, as
/// `/api/open` uses), per the contract.
pub(super) async fn turns(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TurnsQuery>,
) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err("invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    if !path.is_file() {
        let Ok(session) = session_str(&path) else {
            return err("invalid session path");
        };
        if !is_recent_new(&session) {
            return err_status(StatusCode::NOT_FOUND, "session file not found");
        }
    }
    let limit = match q.limit.as_deref().filter(|s| !s.is_empty()) {
        Some(l) => l
            .parse::<usize>()
            .ok()
            .filter(|n| *n >= 1)
            .unwrap_or(TURNS_DEFAULT_LIMIT)
            .min(TURNS_MAX_LIMIT),
        None => TURNS_DEFAULT_LIMIT,
    };
    let Some(ut) = off_runtime(move || jsonl::read_user_turns(&path, limit)).await else {
        return err_status(StatusCode::INTERNAL_SERVER_ERROR, "turns read failed");
    };
    // Contract shape: each turn is `{"text": "…"}` — the jsonl layer returns
    // bare strings, the wire wraps them.
    let turns: Vec<Value> = ut.turns.into_iter().map(|t| json!({ "text": t })).collect();
    ok(json!({ "ok": true, "turns": turns, "more": ut.more }))
}

/// Every subagent the session spawned, read from the transcript.
///
/// `get_subagents` is an RPC, and an RPC is exactly what a desktop-owned
/// session refuses — so the agents sheet has always fallen back to deriving
/// them from the messages it happened to have loaded. That is the last page,
/// and measured on a live session the `task` calls sat 7,600 to 10,700 entries
/// from the end: the sheet reported "no subagents" for a session that had
/// spawned dozens. Reading the file is the daemon's job for the same reason
/// `/turns` is.
pub(super) async fn agents(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TurnsQuery>,
) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err("invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    if !path.is_file() {
        return err_status(StatusCode::NOT_FOUND, "session file not found");
    }
    let limit = match q.limit.as_deref().filter(|s| !s.is_empty()) {
        Some(l) => l.parse::<usize>().ok().filter(|n| *n >= 1).unwrap_or(200),
        None => 200,
    }
    .min(500);
    let Some(found) = off_runtime(move || jsonl::read_subagents(&path, limit)).await else {
        return err_status(StatusCode::INTERNAL_SERVER_ERROR, "agents read failed");
    };
    let agents: Vec<Value> = found
        .into_iter()
        .map(|a| {
            json!({
                "callId": a.call_id,
                "name": a.name,
                "agent": a.agent,
                "intent": a.intent,
                "entryId": a.entry_id,
                "at": a.at,
            })
        })
        .collect();
    ok(json!({ "ok": true, "agents": agents }))
}

/// Targeted read of an agent's persisted JSONL through its verified desktop
/// parent connection. Reading must never enter write_path or spawn an RPC child.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AgentTranscriptQuery {
    session: String,
    agent_id: String,
    from_byte: Option<String>,
    expected_created_at: Option<String>,
    expected_connection_id: Option<String>,
}

fn transcript_cursor(raw: Option<&str>) -> Option<u64> {
    match raw {
        None => Some(0),
        Some(raw) if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) => raw
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= crate::omp::collab::MAX_SAFE_CURSOR),
        _ => None,
    }
}

fn transcript_response(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

fn transcript_error(error: crate::omp::collab::TranscriptError) -> Response {
    use crate::omp::collab::TranscriptError as E;
    let status = match error {
        E::InvalidRequest => StatusCode::BAD_REQUEST,
        E::HostUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        E::Unavailable => StatusCode::NOT_FOUND,
        E::Timeout => StatusCode::GATEWAY_TIMEOUT,
        E::InvalidResponse | E::Host => StatusCode::BAD_GATEWAY,
        E::Busy => StatusCode::TOO_MANY_REQUESTS,
        E::AgentChanged => StatusCode::CONFLICT,
    };
    transcript_response(
        status,
        json!({"ok":false, "code":error.code(), "error":error.message()}),
    )
}

pub(super) async fn agent_transcript(
    State(state): State<Arc<AppState>>,
    query: Result<Query<AgentTranscriptQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    use crate::omp::collab::TranscriptError as E;
    let Ok(Query(query)) = query else {
        return transcript_error(E::InvalidRequest);
    };
    let Some(cursor) = transcript_cursor(query.from_byte.as_deref()) else {
        return transcript_error(E::InvalidRequest);
    };
    let expected_created_at = match query.expected_created_at.as_deref() {
        None => None,
        Some(raw) => match raw.parse::<f64>().ok().filter(|at| {
            at.is_finite() && *at >= 0.0 && *at <= crate::omp::collab::MAX_SAFE_CURSOR as f64
        }) {
            Some(at) => Some(at),
            None => return transcript_error(E::InvalidRequest),
        },
    };
    let Some(path) = resolve_session_path(&state.cfg, &query.session) else {
        return transcript_error(E::InvalidRequest);
    };
    if !path.is_file() {
        return transcript_response(
            StatusCode::NOT_FOUND,
            json!({"ok":false, "code":"session_not_found", "error":"parent session file not found"}),
        );
    }
    let Some(session) = path.to_str() else {
        return transcript_error(E::InvalidRequest);
    };
    match state
        .collab
        .fetch_agent_transcript(
            session,
            &query.agent_id,
            cursor,
            expected_created_at,
            query.expected_connection_id.as_deref(),
        )
        .await
    {
        Ok(chunk) => transcript_response(StatusCode::OK, json!(chunk)),
        Err(error) => transcript_error(error),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AgentFileQuery {
    session: String,
    agent_id: String,
    from_byte: Option<String>,
}

/// A finished subagent has no live host to ask, but omp keeps its transcript
/// at `<session stem>/<agent id>.jsonl` beside the parent; a running one is
/// appended there as it works. Reading it lets the Agents tab open any agent
/// the chat started, not only the ones a live child or desktop still reports.
/// Same chunk contract as `/agents/transcript`, minus the connection fence.
pub(super) async fn agent_file(
    State(state): State<Arc<AppState>>,
    query: Result<Query<AgentFileQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    use crate::omp::collab::TranscriptError as E;
    let Ok(Query(query)) = query else {
        return transcript_error(E::InvalidRequest);
    };
    let Some(cursor) = transcript_cursor(query.from_byte.as_deref()) else {
        return transcript_error(E::InvalidRequest);
    };
    let Some(file) = agent_file_path(&query.agent_id).and_then(|name| {
        let session = resolve_session_path(&state.cfg, &query.session)?;
        let stem = session
            .file_name()?
            .to_str()?
            .strip_suffix(".jsonl")?
            .to_owned();
        Some(session.with_file_name(stem).join(name))
    }) else {
        return transcript_error(E::InvalidRequest);
    };
    let agent_id = query.agent_id;
    match off_runtime(move || read_agent_chunk(&file, cursor)).await {
        Some(Ok((text, next, reset))) => transcript_response(
            StatusCode::OK,
            json!({"ok":true, "agentId":agent_id, "fromByte":cursor, "nextByte":next, "text":text, "reset":reset}),
        ),
        Some(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            transcript_error(E::Unavailable)
        }
        _ => transcript_error(E::Host),
    }
}

/// The agent id names a file in the session's own directory: never a path.
fn agent_file_path(agent_id: &str) -> Option<String> {
    (crate::omp::collab::valid_request(agent_id, 0)
        && !agent_id.starts_with('.')
        && !agent_id.contains(['/', '\\']))
    .then(|| format!("{agent_id}.jsonl"))
}

/// Whole records from `from`, at most 4 MiB. A file shorter than the cursor
/// was rewritten: report a reset at 0 with no text, as the desktop read does.
fn read_agent_chunk(file: &std::path::Path, from: u64) -> std::io::Result<(String, u64, bool)> {
    use std::io::{Read, Seek, SeekFrom};
    const MAX_CHUNK: u64 = 4 * 1024 * 1024;
    let mut handle = std::fs::File::open(file)?;
    let len = handle.metadata()?.len();
    if len < from {
        return Ok((String::new(), 0, true));
    }
    handle.seek(SeekFrom::Start(from))?;
    let mut bytes = Vec::new();
    handle
        .take(MAX_CHUNK.min(len - from))
        .read_to_end(&mut bytes)?;
    // An unfinished record (omp mid-append) waits for the next read.
    bytes.truncate(
        bytes
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(0, |at| at + 1),
    );
    if bytes.is_empty() && len - from >= MAX_CHUNK {
        return Err(std::io::Error::other("agent transcript record too large"));
    }
    let next = from + bytes.len() as u64;
    let text = String::from_utf8(bytes).map_err(std::io::Error::other)?;
    Ok((text, next, false))
}

#[cfg(test)]
mod agent_file_tests {
    use super::*;

    #[test]
    fn agent_ids_never_leave_the_session_directory() {
        assert_eq!(
            agent_file_path("FixDomain").as_deref(),
            Some("FixDomain.jsonl")
        );
        for bad in ["", "../x", "a/b", "a\\b", ".hidden", "x\ny"] {
            assert_eq!(agent_file_path(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn chunks_stop_at_whole_records_and_reset_when_the_file_shrinks() {
        let dir = std::env::temp_dir().join(format!("pulse-agent-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("A.jsonl");
        std::fs::write(&file, "{\"a\":1}\n{\"b\":").unwrap();
        let (text, next, reset) = read_agent_chunk(&file, 0).unwrap();
        assert_eq!((text.as_str(), next, reset), ("{\"a\":1}\n", 8, false));
        let (text, again, _) = read_agent_chunk(&file, next).unwrap();
        assert_eq!((text.as_str(), again), ("", 8));
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            read_agent_chunk(&file, 8).unwrap(),
            (String::new(), 0, true)
        );
        assert_eq!(
            read_agent_chunk(&dir.join("none.jsonl"), 0)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AgentRosterQuery {
    session: String,
}

/// Recover the already-received desktop roster for late-opening/reconnecting
/// viewers. A snapshot never attaches a link or boots a child.
pub(super) async fn agent_roster(
    State(state): State<Arc<AppState>>,
    query: Result<Query<AgentRosterQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    use crate::omp::collab::TranscriptError as E;
    let Ok(Query(query)) = query else {
        return transcript_error(E::InvalidRequest);
    };
    let Some(path) = resolve_session_path(&state.cfg, &query.session) else {
        return transcript_error(E::InvalidRequest);
    };
    if !path.is_file() {
        return transcript_response(
            StatusCode::NOT_FOUND,
            json!({"ok":false, "code":"session_not_found", "error":"parent session file not found"}),
        );
    }
    let Some(session) = path.to_str() else {
        return transcript_error(E::InvalidRequest);
    };
    match state.collab.agent_roster(session) {
        Ok(snapshot) => transcript_response(StatusCode::OK, snapshot),
        Err(error) => transcript_error(error),
    }
}

/// The phone's branch tree: every user turn as a row carrying omp `/tree`
/// indentation/connector/gutter shape (`jsonl::read_tree`), paginated
/// OLDER-WARDS in display order. `before=<row id>` returns the `limit` rows
/// ending just before that row; `nextBefore` is the id of the window's
/// OLDEST row (the same boundary convention as `/api/history` byte offsets:
/// the next page ends before it, so paging is without overlap or loss) and
/// null once the window reaches the display-list start. The window is
/// sliced over the cached full tree, so every page after the first costs
/// one stat + a hash lookup, never a re-parse of the (44 MB) session file.
///
/// Path validation mirrors `/api/turns` exactly — a fresh `/api/new` session
/// (whose file materializes on first write) is an empty tree, and a
/// genuinely missing file is the codebase's JSON 404 shape. An unknown
/// `before` id (the file changed between pages) acts like no cursor and
/// serves the newest window — the same clamp idiom as `read_backward`.
pub(super) async fn tree(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TreeQuery>,
) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err("invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    if !path.is_file() {
        let Ok(session) = session_str(&path) else {
            return err("invalid session path");
        };
        if !is_recent_new(&session) {
            return err_status(StatusCode::NOT_FOUND, "session file not found");
        }
        return ok(json!({ "ok": true, "rows": [], "nextBefore": null, "total": 0 }));
    }
    let limit = match q.limit.as_deref().filter(|s| !s.is_empty()) {
        Some(l) => l
            .parse::<usize>()
            .ok()
            .filter(|n| *n >= 1)
            .unwrap_or(TREE_DEFAULT_LIMIT)
            .min(TREE_MAX_LIMIT),
        None => TREE_DEFAULT_LIMIT,
    };
    let Some(rows) = off_runtime(move || jsonl::read_tree(&path)).await else {
        return err_status(StatusCode::INTERNAL_SERVER_ERROR, "tree read failed");
    };
    let total = rows.len();
    let end = match q.before.as_deref().filter(|s| !s.is_empty()) {
        Some(b) => rows.iter().rposition(|r| r.id == b).unwrap_or(total),
        None => total,
    };
    let start = end.saturating_sub(limit);
    // Lossless cursor, mirroring read_backward's byte idiom: nextBefore is
    // the id of the OLDEST row of this window (rows[start]), and the next
    // request ends its window immediately before that id — so the boundary
    // row was already delivered here and is never dropped. (A "row just
    // older than the window" cursor — rows[start-1] — measured to silently
    // skip one display row at every page boundary: 95 of 97 rows on the
    // live session.) Null when the window reaches the display-list start.
    let next_before = if start > 0 {
        Some(rows[start].id.clone())
    } else {
        None
    };
    let out: Vec<Value> = rows[start..end]
        .iter()
        .map(|r| {
            let s = &r.stats;
            let mut row = json!({
                "id": r.id,
                "text": truncate_tree_text(&r.text),
                "kind": r.kind,
                "answer": r.answer,
                "resumeTargets": r.resume_targets,
                "indent": r.indent,
                "connector": r.connector,
                "gutters": r.gutters,
                "active": r.active,
                "current": r.current,
                "at": s.at,
                "lastAt": s.last_at,
                "replies": s.replies,
                "tools": s.tools,
                "outputTokens": s.output_tokens,
                "tps": s.tokens_per_second().map(|t| (t * 10.0).round() / 10.0),
                "cost": (s.cost * 10_000.0).round() / 10_000.0,
                "model": s.model,
                "stop": s.stop,
            });
            // Absent rather than null when unlabelled: most rows carry none.
            if let Some(label) = &r.label {
                row["label"] = json!(label);
            }
            row
        })
        .collect();
    ok(json!({ "ok": true, "rows": out, "nextBefore": next_before, "total": total }))
}

/// Cap a tree row's text at 160 chars TOTAL (the contract's `≤160`),
/// appending "…" when truncated — the same ellipsis-signals-truncation
/// convention as search lines, but with the ellipsis INSIDE the budget
/// (159 chars + "…" = 160), so the wire never exceeds the limit.
fn truncate_tree_text(text: &str) -> String {
    const TREE_TEXT_MAX: usize = 160;
    if text.chars().count() <= TREE_TEXT_MAX {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(TREE_TEXT_MAX - 1).collect();
    cut.push('…');
    cut
}
