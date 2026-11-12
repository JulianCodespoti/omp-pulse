//! Confined project-file and read-only session-resource endpoints: listing,
//! search, changes, browsing, previews, raw downloads and project-file saves.

use super::*;
use crate::{sessions::index, sessions::jsonl};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::Response,
};
use serde_json::{Value, json};
use std::io::Read as _;
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

mod file_io;
mod file_search;
mod file_write;
mod internal_resource;

const MAX_FILE_READ: u64 = 1024 * 1024;
// A conditional save carries two 1 MiB strings. JSON can escape each input
// byte as six characters; the default 2 MiB extractor cap rejected valid edits.
pub(super) const MAX_FILE_SAVE_BODY: usize = 12 * MAX_FILE_READ as usize + 64 * 1024;

/// Resolve `rel` under `cwd` with a traversal guard: the canonicalized target
/// must start with the canonicalized cwd (mirrors server.ts `resolveUnderCwd`).
fn resolve_under_cwd(cwd: &FsPath, rel: &str) -> Option<PathBuf> {
    let real_cwd = cwd.canonicalize().ok()?;
    let candidate = cwd.join(rel);
    if let Ok(real) = candidate.canonicalize() {
        return (real == real_cwd || real.starts_with(&real_cwd)).then_some(real);
    }
    let mut probe = candidate;
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = probe.canonicalize() {
            let mut joined = real;
            for comp in tail.iter().rev() {
                joined.push(comp);
            }
            return (joined == real_cwd || joined.starts_with(&real_cwd)).then_some(joined);
        }
        let name = probe.file_name()?;
        // Only genuinely absent components may enter the missing tail. A
        // dangling symlink is an existing entry even though canonicalize fails;
        // treating it as missing could let a later write follow it outside cwd.
        // Rebuild the leaf to strip trailing '/' or '/.', which otherwise make
        // symlink_metadata follow a dangling directory link and report NotFound.
        match std::fs::symlink_metadata(probe.with_file_name(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return None,
        }
        tail.push(name.to_os_string());
        if !probe.pop() {
            return None;
        }
    }
}

/// Project file routes must never reinterpret a missing cwd as the user's HOME.
pub(super) fn project_cwd(session_path: &FsPath) -> Result<PathBuf, Box<Response>> {
    let cwd = jsonl::parse_header(session_path)
        .cwd
        .filter(|cwd| !cwd.is_empty());
    if let Some(path) = cwd.as_deref().map(FsPath::new).filter(|path| path.is_dir()) {
        return Ok(path.to_path_buf());
    }
    let error = match &cwd {
        Some(path) => format!("Project folder is unavailable: {path}"),
        None => "This conversation has no saved project folder.".to_string(),
    };
    Err(Box::new(json_response(
        StatusCode::NOT_FOUND,
        json!({ "ok": false, "code": "project_folder_unavailable", "error": error, "cwd": cwd }),
    )))
}

/// A failed download must carry an error status: the web client saves the body
/// of any 200, so an error JSON would otherwise be written out as the file.
fn download_error(error: &std::io::Error) -> Response {
    let status = match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    err_status(status, &format!("file is unavailable: {error}"))
}

pub(super) async fn files(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FilesQuery>,
) -> Response {
    file_io_response(file_io::run(move || files_sync(&state, q)).await)
}

fn files_sync(state: &AppState, q: FilesQuery) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err("invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    let cwd = match project_cwd(&path) {
        Ok(cwd) => cwd,
        Err(response) => return *response,
    };
    if let Some(query) = q.search.as_deref() {
        return match file_search::search(&cwd, query) {
            Ok(result) => ok(json!({
                "ok": true,
                "entries": result.entries,
                "truncated": result.truncated,
            })),
            Err(error) => err(&error),
        };
    }
    let rel = q.path.unwrap_or_default();
    let Some(target) = resolve_under_cwd(&cwd, &rel) else {
        return err("path escapes session cwd");
    };
    let meta = match std::fs::metadata(&target) {
        Ok(m) => m,
        Err(e) => return err(&e.to_string()),
    };
    if !meta.is_dir() {
        return err("not a directory");
    }
    let rd = match std::fs::read_dir(&target) {
        Ok(r) => r,
        Err(e) => return err(&e.to_string()),
    };
    let mut entries: Vec<Value> = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let full = ent.path();
        let (etype, size, mtime) = match std::fs::metadata(&full) {
            Ok(m) => (
                if m.is_dir() { "dir" } else { "file" },
                if m.is_file() { m.len() } else { 0 },
                index::mtime_ms(&m),
            ),
            Err(_) => continue, // vanished mid-scan
        };
        let entry_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        entries.push(
            json!({ "name": name, "path": entry_rel, "type": etype, "size": size, "mtime": mtime }),
        );
    }
    // dirs first, then name ascending
    entries.sort_by(|a, b| {
        let ta = a["type"].as_str().unwrap_or("");
        let tb = b["type"].as_str().unwrap_or("");
        if ta == tb {
            a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or(""))
        } else if ta == "dir" {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    ok(json!({ "ok": true, "cwd": target.to_string_lossy(), "entries": entries }))
}

/// Workspace → Changes: the git working-tree changes of the session's cwd
/// against HEAD, untracked files included (src/server/git_changes.rs). It exposes
/// file contents like `/api/file`, so it is a control-role read.
///
/// The cwd is the session header's, with no `$HOME` fallback (unlike
/// `/api/files`): `$HOME` is often a dotfiles repository, and its changes
/// presented as this session's would be wrong. A fresh `/api/new` session has
/// no header until its first write, so it has no cwd to report yet.
///
/// `summary=1` drops the patches (paths, status and line counts only): the
/// chat's `+a −r` pill reads this on every open and turn end, and the full
/// collection can be megabytes of diff.
pub(super) async fn changes(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ChangesQuery>,
) -> Response {
    let mode = if matches!(q.summary.as_deref(), Some("1" | "true")) {
        crate::server::git_changes::Mode::Summary
    } else {
        crate::server::git_changes::Mode::Full
    };
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
        return err("session has not started yet");
    }
    let collected = tokio::task::spawn_blocking(move || {
        let Some(cwd) = jsonl::parse_header(&path).cwd else {
            return Err("session has no working directory".to_string());
        };
        let cwd = PathBuf::from(cwd);
        if !cwd.is_dir() {
            return Err("working directory no longer exists".to_string());
        }
        crate::server::git_changes::collect(&cwd, mode)
    })
    .await;
    match collected {
        Ok(Ok(changes)) => match serde_json::to_value(changes) {
            Ok(Value::Object(mut body)) => {
                body.insert("ok".into(), Value::Bool(true));
                ok(Value::Object(body))
            }
            _ => err_status(StatusCode::INTERNAL_SERVER_ERROR, "couldn't encode changes"),
        },
        Ok(Err(e)) => err(&e),
        Err(_) => err_status(StatusCode::INTERNAL_SERVER_ERROR, "changes task failed"),
    }
}

/// Directory picker for New Session: browse `$HOME` (or a path below it)
/// for directories only. Hidden (dot-prefixed) entries are excluded and the
/// result is sorted case-insensitively by name. The requested path must
/// canonicalize to `$HOME` or below — anything else is "path outside home".
pub(super) async fn browse(
    State(state): State<Arc<AppState>>,
    Query(q): Query<BrowseQuery>,
) -> Response {
    let home = state
        .cfg
        .home
        .canonicalize()
        .unwrap_or_else(|_| state.cfg.home.clone());
    let raw = q
        .path
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.cfg.home.to_str().unwrap_or("/"));
    let dir = match FsPath::new(raw).canonicalize() {
        Ok(d) if d == home || d.starts_with(&home) => d,
        _ => return err("path outside home"),
    };
    if !dir.is_dir() {
        return err("not a directory");
    }
    let rd = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) => return err(&e.to_string()),
    };
    let mut dirs: Vec<Value> = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // file_type errs on broken symlinks / vanished entries — skip.
        let Ok(ft) = ent.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        dirs.push(json!({ "name": name, "path": ent.path().to_string_lossy() }));
    }
    dirs.sort_by(|a, b| {
        let na = a["name"].as_str().unwrap_or("");
        let nb = b["name"].as_str().unwrap_or("");
        na.to_lowercase()
            .cmp(&nb.to_lowercase())
            .then_with(|| na.cmp(nb))
    });
    let parent = if dir == home {
        Value::Null
    } else {
        match dir.parent() {
            Some(p) => json!(p.to_string_lossy()),
            None => Value::Null,
        }
    };
    ok(json!({ "ok": true, "path": dir.to_string_lossy(), "parent": parent, "dirs": dirs }))
}

fn read_file_preview(reader: impl std::io::Read) -> std::io::Result<(Vec<u8>, bool)> {
    // A successful read may be short, and metadata length can change before
    // reading. Read through EOF or one probe byte beyond the payload limit.
    let mut buf = Vec::new();
    reader.take(MAX_FILE_READ + 1).read_to_end(&mut buf)?;
    let truncated = buf.len() as u64 > MAX_FILE_READ;
    buf.truncate(MAX_FILE_READ as usize);
    Ok((buf, truncated))
}

pub(super) async fn file(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FilesQuery>,
) -> Response {
    file_io_response(file_io::run(move || file_sync(&state, q)).await)
}

fn file_io_response(result: Result<Response, file_io::Error>) -> Response {
    match result {
        Ok(response) => response,
        Err(file_io::Error::Busy) => {
            err_status(StatusCode::SERVICE_UNAVAILABLE, "file operation busy")
        }
        Err(file_io::Error::Join) => {
            err_status(StatusCode::INTERNAL_SERVER_ERROR, "file operation failed")
        }
    }
}

fn file_sync(state: &AppState, q: FilesQuery) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err("invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    let rel = q.path.unwrap_or_default();
    let resource = if internal_resource::is_internal(&rel) {
        match internal_resource::resolve(&path, &rel) {
            Ok(resource) => Some(resource),
            Err(error) => return err(&error),
        }
    } else {
        None
    };
    let target = if let Some(resource) = &resource {
        resource.path.clone()
    } else {
        let cwd = match project_cwd(&path) {
            Ok(cwd) => cwd,
            Err(response) => return *response,
        };
        let Some(target) = resolve_under_cwd(&cwd, &rel) else {
            return err("path escapes session cwd");
        };
        target
    };
    let meta = match std::fs::metadata(&target) {
        Ok(m) => m,
        Err(e) => return err(&e.to_string()),
    };
    if !meta.is_file() {
        return err("not a file");
    }
    let f = match std::fs::File::open(&target) {
        Ok(f) => f,
        Err(e) => return err(&e.to_string()),
    };
    let preview = match &resource {
        Some(resource) => resource.read_preview(f),
        None => read_file_preview(f),
    };
    let (buf, truncated) = match preview {
        Ok(preview) => preview,
        Err(e) => return err(&e.to_string()),
    };
    let binary = buf[..buf.len().min(8192)].contains(&0);
    let mut out = json!({
        "ok": true,
        "name": target.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        "path": rel,
        "size": meta.len(),
        "mtime": index::mtime_ms(&meta),
        "binary": binary,
        "truncated": truncated,
        "readOnly": resource.is_some(),
    });
    if !binary {
        out["content"] = json!(String::from_utf8_lossy(&buf));
    }
    ok(out)
}

pub(super) async fn raw(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FilesQuery>,
) -> Response {
    file_io_response(file_io::run(move || raw_sync(&state, q)).await)
}

fn raw_sync(state: &AppState, q: FilesQuery) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err_status(StatusCode::BAD_REQUEST, "invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err_status(StatusCode::BAD_REQUEST, "invalid session path");
    };
    if let Some(rel) = q
        .path
        .as_deref()
        .filter(|rel| internal_resource::is_internal(rel))
    {
        return raw_resource(&path, rel);
    }
    let cwd = match project_cwd(&path) {
        Ok(cwd) => cwd,
        Err(response) => return *response,
    };
    let rel = q.path.unwrap_or_default();
    let Some(target) = resolve_under_cwd(&cwd, &rel) else {
        return err_status(StatusCode::FORBIDDEN, "path escapes session cwd");
    };
    let meta = match std::fs::metadata(&target) {
        Ok(meta) => meta,
        Err(error) => return download_error(&error),
    };
    if !meta.is_file() {
        return err_status(StatusCode::BAD_REQUEST, "not a file");
    }
    let data = match std::fs::read(&target) {
        Ok(d) => d,
        Err(error) => return download_error(&error),
    };
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    let mut res = axum::response::Response::new(axum::body::Body::from(data));
    if let Ok(v) = mime.parse() {
        res.headers_mut()
            .insert(axum::http::header::CONTENT_TYPE, v);
    }
    res.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "private, no-store".parse().unwrap(),
    );
    res
}
/// An image the agent embedded by its absolute path on this computer, e.g.
/// `![After](/tmp/omp-image-15c0.webp)`. The phone cannot fetch a computer
/// path, and `/raw` is confined to the project folder, so such replies showed
/// "Couldn't load image" for every picture.
///
/// INVARIANT: this is not a file reader. It serves only an image file whose
/// exact path the session's own transcript embeds as a Markdown image.
pub(super) async fn session_image(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FilesQuery>,
) -> Response {
    file_io_response(file_io::run(move || session_image_sync(&state, q)).await)
}

const MAX_SESSION_IMAGE: u64 = 32 * 1024 * 1024;

fn session_image_sync(state: &AppState, q: FilesQuery) -> Response {
    let Some(session) = q
        .session
        .as_deref()
        .and_then(|raw| resolve_session_path(&state.cfg, raw))
    else {
        return err_status(StatusCode::BAD_REQUEST, "invalid session path");
    };
    let Some(image) = q.path.as_deref().filter(|p| FsPath::new(p).is_absolute()) else {
        return err_status(StatusCode::BAD_REQUEST, "invalid image path");
    };
    let Some(mime) = image_mime(image) else {
        return err_status(StatusCode::BAD_REQUEST, "not an image");
    };
    // shortcut: rescans the transcript per image (~50 ms for a 40 MB file);
    // cache per (file, len) if replies with many images make that visible.
    let transcript = match std::fs::read(&session) {
        Ok(bytes) => bytes,
        Err(error) => return download_error(&error),
    };
    if !embeds_image(&transcript, image) {
        return err_status(
            StatusCode::FORBIDDEN,
            "image not embedded in this conversation",
        );
    }
    let meta = match std::fs::metadata(image) {
        Ok(meta) => meta,
        Err(error) => return download_error(&error),
    };
    if !meta.is_file() || meta.len() > MAX_SESSION_IMAGE {
        return err_status(StatusCode::BAD_REQUEST, "not a readable image file");
    }
    let data = match std::fs::read(image) {
        Ok(d) => d,
        Err(error) => return download_error(&error),
    };
    let mut res = axum::response::Response::new(axum::body::Body::from(data));
    res.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static(mime),
    );
    res.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    res
}

fn image_mime(path: &str) -> Option<&'static str> {
    let ext = FsPath::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// The transcript (JSONL, so the Markdown sits inside JSON strings) contains
/// `](<path>)`, `](<path> "title")` or the same behind `file://`.
fn embeds_image(transcript: &[u8], path: &str) -> bool {
    let escaped = serde_json::to_string(path).unwrap_or_default();
    let escaped = escaped.trim_matches('"');
    [format!("]({escaped}"), format!("](file://{escaped}")]
        .iter()
        .any(|needle| {
            let needle = needle.as_bytes();
            transcript
                .windows(needle.len() + 1)
                .any(|w| w.starts_with(needle) && matches!(w[needle.len()], b')' | b' '))
        })
}

#[cfg(test)]
mod session_image_tests {
    use super::*;

    #[test]
    fn only_paths_the_transcript_embeds_as_images_are_served() {
        let transcript = br#"{"text":"![After](/tmp/omp-image-15c0.webp)
![B](file:///tmp/before.png "t")"}"#;
        assert!(embeds_image(transcript, "/tmp/omp-image-15c0.webp"));
        assert!(embeds_image(transcript, "/tmp/before.png"));
        // A prefix of an embedded path, or a path that is only mentioned, is not embedded.
        assert!(!embeds_image(transcript, "/tmp/omp-image-15c"));
        assert!(!embeds_image(br#"{"text":"see /tmp/x.png"}"#, "/tmp/x.png"));
        assert!(image_mime("/tmp/a.WEBP").is_some() && image_mime("/etc/passwd").is_none());
    }
}

pub(super) async fn raw_public(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RawQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    let header_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer_token);
    let token = q.token.as_deref().or(header_token).unwrap_or("");
    let Some(context) = authenticate_token(&state, token) else {
        return err_status(axum::http::StatusCode::UNAUTHORIZED, "unauthorized");
    };
    if !context.can_control() {
        return err_status(axum::http::StatusCode::FORBIDDEN, "forbidden");
    }
    file_io_response(file_io::run(move || raw_public_sync(&state, q)).await)
}

fn raw_public_sync(state: &AppState, q: RawQuery) -> Response {
    let Some(raw) = q.session.as_deref() else {
        return err_status(StatusCode::BAD_REQUEST, "invalid session path");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err_status(StatusCode::BAD_REQUEST, "invalid session path");
    };
    if let Some(rel) = q
        .path
        .as_deref()
        .filter(|rel| internal_resource::is_internal(rel))
    {
        return raw_resource(&path, rel);
    }
    let cwd = match project_cwd(&path) {
        Ok(cwd) => cwd,
        Err(response) => return *response,
    };
    let rel = q.path.clone().unwrap_or_default();
    let Some(target) = resolve_under_cwd(&cwd, &rel) else {
        return err_status(StatusCode::FORBIDDEN, "path escapes session cwd");
    };
    let meta = match std::fs::metadata(&target) {
        Ok(meta) => meta,
        Err(error) => return download_error(&error),
    };
    if !meta.is_file() {
        return err_status(StatusCode::BAD_REQUEST, "not a file");
    }
    let data = match std::fs::read(&target) {
        Ok(d) => d,
        Err(error) => return download_error(&error),
    };
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    let mut res = axum::response::Response::new(axum::body::Body::from(data));
    if let Ok(v) = mime.parse() {
        res.headers_mut()
            .insert(axum::http::header::CONTENT_TYPE, v);
    }
    res.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "private, no-store".parse().unwrap(),
    );
    res
}

fn raw_resource(session: &FsPath, uri: &str) -> Response {
    let resource = match internal_resource::resolve(session, uri) {
        Ok(resource) => resource,
        Err(error) => return err_status(StatusCode::NOT_FOUND, &error),
    };
    let file = match std::fs::File::open(&resource.path) {
        Ok(file) => file,
        Err(_) => {
            return err_status(
                StatusCode::NOT_FOUND,
                "resource is unavailable in this conversation",
            );
        }
    };
    let bytes = match resource.read_preview(file) {
        Ok((_, true)) => {
            return err_status(
                StatusCode::PAYLOAD_TOO_LARGE,
                "resource exceeds 1MB download cap; use a line selector",
            );
        }
        Ok((bytes, false)) => bytes,
        Err(_) => {
            return err_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                "couldn't read session resource",
            );
        }
    };
    let mut response = Response::new(axum::body::Body::from(bytes));
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "private, no-store".parse().unwrap(),
    );
    response
}

pub(super) async fn post_file(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    file_io_response(file_io::run(move || post_file_sync(&state.cfg, body)).await)
}

fn post_file_sync(cfg: &Config, body: Option<Json<Value>>) -> Response {
    let body = body_value(body);
    let Some(raw) = session_path_from_body(&body) else {
        return err_status(StatusCode::BAD_REQUEST, "sessionPath required");
    };
    let Some(path) = resolve_session_path(cfg, raw) else {
        return err("invalid session path");
    };
    // Require a real session file (or a very recent /api/new session whose
    // file materializes on first write). Without this, any path under
    // sessions_root would resolve and fall back to `cfg.home` as cwd, letting
    // a fake session write arbitrary files under HOME.
    if !path.is_file() {
        let Ok(session) = session_str(&path) else {
            return err("invalid session path");
        };
        if !is_recent_new(&session) {
            return err_status(StatusCode::NOT_FOUND, "session file not found");
        }
    }
    let rel = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if rel.is_empty() {
        return err_status(StatusCode::BAD_REQUEST, "path required");
    }
    if internal_resource::is_internal(rel) {
        return err_status(
            StatusCode::FORBIDDEN,
            "session resources are read-only in Pulse",
        );
    }
    // Missing or malformed content is not an intentional empty-file save.
    // Reject before creating parents or opening the target for truncation.
    let Some(content) = body.get("content").and_then(|v| v.as_str()) else {
        return err_status(StatusCode::BAD_REQUEST, "content must be a string");
    };
    if content.len() as u64 > MAX_FILE_READ {
        return err_status(StatusCode::PAYLOAD_TOO_LARGE, "content exceeds 1MB cap");
    }
    let expected = match body.get("expectedContent") {
        Some(Value::String(expected)) if expected.len() as u64 <= MAX_FILE_READ => {
            Some(expected.as_str())
        }
        Some(Value::Null) => None,
        None => {
            return err_status(
                StatusCode::PRECONDITION_REQUIRED,
                "expectedContent required (string for existing file, null for new file)",
            );
        }
        _ => {
            return err_status(
                StatusCode::BAD_REQUEST,
                "expectedContent must be a string or null within 1MB",
            );
        }
    };
    file_write::serialise(|| {
        let cwd = match project_cwd(&path) {
            Ok(cwd) => cwd,
            Err(response) => return *response,
        };
        let Some(target) = resolve_under_cwd(&cwd, rel) else {
            return err("path escapes session cwd");
        };
        match file_write::save(&target, content, expected) {
            Ok(()) => ok(json!({ "ok": true })),
            Err(file_write::Error::Conflict) => json_response(
                StatusCode::CONFLICT,
                json!({
                    "ok": false,
                    "code": "file_conflict",
                    "error": "File changed on disk. Your draft has not been saved.",
                }),
            ),
            Err(file_write::Error::Io(error)) => err(&error.to_string()),
        }
    })
}

#[cfg(test)]
mod tests;
