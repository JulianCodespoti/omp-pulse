//! Session export: omp writes an HTML export into a daemon-named file that is
//! served once and unlinked, and a sweeper removes leftovers.

use super::*;
use crate::sessions::jsonl;
use axum::{
    Json,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::Response,
};
use serde_json::{Value, json};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::Duration,
};

/// Exports land here and are deleted as soon as the handler ends, however it
/// ends ([`ExportTarget`]). Anything older than [`EXPORT_MAX_AGE`] is a
/// leftover from a crash or from omp finishing an export after the daemon
/// gave up on it; [`spawn_export_sweeper`] removes those.
const EXPORT_DIR: &str = "exports";
const EXPORT_MAX_AGE: Duration = Duration::from_secs(10 * 60);
/// omp's HTML export embeds the transcript; measured 608 KB for a short
/// session. The cap only stops a pathological file from being held in RAM.
const EXPORT_MAX_BYTES: u64 = 64 * 1024 * 1024;

fn sweep_exports(dir: &FsPath) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > EXPORT_MAX_AGE);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Sweep the export dir at startup and every [`EXPORT_MAX_AGE`] after. An
/// export omp finishes after its RPC timed out lands after the handler's
/// unlink, and sweeping only on the next export left that transcript copy on
/// disk for as long as nobody exported again.
pub fn spawn_export_sweeper(state_dir: &FsPath) {
    let dir = state_dir.join(EXPORT_DIR);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(EXPORT_MAX_AGE);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            // The first tick completes immediately: the startup sweep.
            tick.tick().await;
            let dir = dir.clone();
            let _ = tokio::task::spawn_blocking(move || sweep_exports(&dir)).await;
        }
    });
}

/// The export file, unlinked when dropped. A client disconnect drops the
/// handler future mid-RPC, which skipped the old trailing `remove_file` and
/// left a full HTML copy of the transcript in the state dir.
struct ExportTarget(PathBuf);

impl Drop for ExportTarget {
    fn drop(&mut self) {
        let path = std::mem::take(&mut self.0);
        // Drop cannot await; keep the blocking unlink off the runtime worker.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(move || {
                    let _ = std::fs::remove_file(path);
                });
            }
            Err(_) => {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// A download name from the conversation title: ASCII letters, digits,
/// spaces, `-` and `_` only, so it is safe inside a quoted
/// Content-Disposition.
fn export_file_name(title: Option<&str>) -> String {
    let safe: String = title
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let words: Vec<&str> = safe.split_whitespace().collect();
    let name: String = words.join(" ").chars().take(60).collect();
    let name = name.trim();
    format!(
        "{}.html",
        if name.is_empty() {
            "conversation"
        } else {
            name
        }
    )
}

/// `/export` for the phone: omp writes its HTML export to a file the DAEMON
/// names under its own state dir (a phone-chosen path would be an arbitrary
/// file write on the omp host), the bytes are returned as an attachment, and
/// the file is unlinked when the handler ends (served, failed or cancelled).
/// The TUI's `/export` text command only prints a path on the omp host,
/// which a phone cannot open.
pub(super) async fn export_session(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let body = body_value(body);
    let Some(raw) = session_path_from_body(&body) else {
        return err_status(StatusCode::BAD_REQUEST, "sessionPath required");
    };
    let Some(path) = resolve_session_path(&state.cfg, raw) else {
        return err("invalid session path");
    };
    let Ok(session) = session_str(&path) else {
        return err("invalid session path");
    };
    if let Some(refusal) = daemon_child_refusal(&state, &session, "export it there") {
        return refusal;
    }
    let dir = state.cfg.state_dir.join(EXPORT_DIR);
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return err_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot prepare the export",
        );
    }
    let target = ExportTarget(dir.join(format!(
        "{}-{}.html",
        crate::authority::session_state::now_ms(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )));
    let output_path = target.0.to_string_lossy().into_owned();
    let written = state
        .children
        .rpc(
            &session,
            "export_html",
            json!({ "outputPath": output_path }),
        )
        .await;
    let read = match written {
        Ok(_) => match tokio::fs::metadata(&target.0).await {
            Ok(meta) if meta.len() > EXPORT_MAX_BYTES => {
                Err("the export is too large to download".to_owned())
            }
            Ok(_) => tokio::fs::read(&target.0).await.map_err(|e| e.to_string()),
            Err(e) => Err(format!("omp did not write the export: {e}")),
        },
        Err(e) => {
            return if owned_by_terminal(&e) {
                refusal_body(&e)
            } else {
                child_error(&e)
            };
        }
    };
    drop(target);
    let bytes = match read {
        Ok(bytes) => bytes,
        Err(e) => return err_status(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let name = export_file_name(jsonl::parse_header(&path).title.as_deref());
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\""),
        )
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| err_status(StatusCode::INTERNAL_SERVER_ERROR, "export failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_download_name_is_header_safe() {
        assert_eq!(
            export_file_name(Some("Fix the build")),
            "Fix the build.html"
        );
        assert_eq!(
            export_file_name(Some("a\"b\\c\r\nSet-Cookie: x=1; é")),
            "a b c Set-Cookie x 1.html"
        );
        assert_eq!(export_file_name(Some("日本語")), "conversation.html");
        assert_eq!(export_file_name(None), "conversation.html");
        let long = "x".repeat(200);
        assert_eq!(export_file_name(Some(&long)).len(), 60 + ".html".len());
    }

    #[test]
    fn export_sweep_removes_only_stale_leftovers() {
        let dir = std::env::temp_dir().join(format!("pulse-export-sweep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fresh = dir.join("fresh.html");
        let stale = dir.join("stale.html");
        std::fs::write(&fresh, "a").unwrap();
        std::fs::write(&stale, "b").unwrap();
        let old = std::time::SystemTime::now() - EXPORT_MAX_AGE - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
        sweep_exports(&dir);
        assert!(fresh.exists());
        assert!(!stale.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A cancelled export handler (client gone mid-RPC) still unlinks its
    /// target: the guard owns the deletion, not the code after the await.
    #[tokio::test]
    async fn an_export_target_is_unlinked_when_its_handler_is_dropped() {
        let dir = std::env::temp_dir().join(format!("pulse-export-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cancelled.html");
        std::fs::write(&path, "transcript").unwrap();
        let target = ExportTarget(path.clone());
        let handler = tokio::spawn(async move {
            let _target = target;
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        handler.abort();
        let _ = handler.await;
        for _ in 0..100 {
            if !path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
