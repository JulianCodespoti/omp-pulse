//! Media endpoints: image blobs from omp's blob store and speech-to-text for the
//! dictation button.

use super::*;
use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::Response,
};
use base64::Engine as _;
use serde_json::{Value, json};
use std::sync::Arc;

/// Dictation: the phone posts the recording its MediaRecorder produced and gets
/// text back. Audio arrives base64 inside JSON rather than as a raw body because
/// that is already how the composer uploads images, so there is one upload shape
/// in the client and one decode path here.
///
/// This route NEVER writes to the session. Transcribing is not sending: the text
/// lands in the composer so it can be read and edited before the user commits to
/// it, which matters when the transcript is about to instruct a coding agent.
pub(super) async fn transcribe(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let Some(b64) = body.get("audio").and_then(|v| v.as_str()) else {
        return err_status(StatusCode::BAD_REQUEST, "audio (base64) required");
    };
    let mime = body
        .get("mime")
        .and_then(|v| v.as_str())
        .unwrap_or("audio/webm");
    let audio = match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(bytes) => bytes,
        Err(e) => return err_status(StatusCode::BAD_REQUEST, &format!("bad base64 audio: {e}")),
    };
    match state.asr.transcribe(&audio, mime).await {
        Ok(t) => ok(json!({
            "ok": true,
            "text": t.text,
            "ms": t.decode_ms,
            "audioMs": t.audio_ms,
            "model": t.model,
        })),
        // A missing model or a decode failure is expected on some machines, so it
        // is a structured answer the phone can explain, not a 500.
        Err(e) => ok(json!({ "ok": false, "error": e })),
    }
}

/// Dictation warm-up: the phone calls this as recording starts so the model
/// load (seconds, cold) overlaps the speech instead of trailing it. The sidecar
/// is otherwise absent, and reaped soon after dictation stops, because it holds
/// ~1.3 GiB. Fire-and-forget: `ready:false` only means the feature is off.
pub(super) async fn transcribe_warm(State(state): State<Arc<AppState>>) -> Response {
    ok(json!({ "ok": true, "ready": state.asr.warm() }))
}

pub(super) async fn blob(State(state): State<Arc<AppState>>, Path(hash): Path<String>) -> Response {
    // `blob:sha256:<hex>` or `blob:<hex>` or plain `<hex>` — all map to
    // `<omp blob dir>/<hex>[.<ext>]` (see `paths::omp_blob_dirs`). The bytes
    // stay on the desktop; the phone can only render inline base64. This
    // endpoint bridges the gap without inlining every image into the history
    // payload.
    let mut h = hash.trim();
    if let Some(s) = h.strip_prefix("blob:") {
        h = s;
    }
    if let Some(s) = h.strip_prefix("sha256:") {
        h = s;
    }
    if h.len() < 8 || h.len() > 128 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return err_status(StatusCode::BAD_REQUEST, "invalid hash");
    }
    // omp writes prompt images to its data dir (on a default install the
    // agent dir, `~/.omp/agent/blobs`); agent-made images and older omp
    // releases use `~/.local/share/omp/blobs`. Reading only the latter made
    // every photo the user sent show "Image could not be loaded".
    let blob_dirs = crate::paths::omp_blob_dirs(&state.cfg.home);
    // Candidate files per directory: exact hash, hash with common image
    // extensions, and any file that starts with the hash (`<hash>.<ext>`).
    let mut candidates = Vec::with_capacity(18);
    for blobs_dir in &blob_dirs {
        candidates.push(blobs_dir.join(h));
        for ext in ["png", "webp", "jpg", "jpeg", "gif", "svg", "avif"] {
            candidates.push(blobs_dir.join(format!("{h}.{ext}")));
        }
    }
    if !candidates.iter().any(|path| path.is_file()) {
        for blobs_dir in &blob_dirs {
            let Ok(entries) = std::fs::read_dir(blobs_dir) else {
                continue;
            };
            if let Some(path) = entries.flatten().find_map(|entry| {
                let name = entry.file_name();
                let name = name.to_str()?;
                (name.starts_with(h) && name[h.len()..].starts_with('.')).then(|| entry.path())
            }) {
                candidates.push(path);
                break;
            }
        }
    }
    for path in candidates {
        if path.is_file() {
            match std::fs::read(&path) {
                Ok(bytes) => {
                    let ext = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let mime = match ext.as_str() {
                        "png" => "image/png",
                        "webp" => "image/webp",
                        "jpg" | "jpeg" => "image/jpeg",
                        "gif" => "image/gif",
                        "svg" => "image/svg+xml",
                        "avif" => "image/avif",
                        _ => {
                            // No extension — sniff a few magic bytes so the
                            // phone's `<img>` gets a real image MIME, not
                            // `application/octet-stream` (which still renders
                            // in most browsers but is technically wrong).
                            if bytes.len() >= 8 && &bytes[0..4] == b"\x89PNG" {
                                "image/png"
                            } else if bytes.len() >= 3 && &bytes[0..3] == b"\xFF\xD8\xFF" {
                                "image/jpeg"
                            } else if bytes.len() >= 12
                                && &bytes[0..4] == b"RIFF"
                                && &bytes[8..12] == b"WEBP"
                            {
                                "image/webp"
                            } else if bytes.len() >= 4 && &bytes[0..4] == b"GIF8" {
                                "image/gif"
                            } else if bytes.len() >= 4 && &bytes[0..4] == b"\x00\x00\x01\x00" {
                                "image/x-icon"
                            } else {
                                "application/octet-stream"
                            }
                        }
                    };
                    let mut resp = Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, mime)
                        .header(header::CONTENT_LENGTH, bytes.len());
                    if let Some(cache) = blob_cache_control(h) {
                        resp = resp.header(header::CACHE_CONTROL, cache);
                    }
                    // Borrowed pattern from the static-asset path: a builder
                    // failure falls back to an empty 200 rather than panicking.
                    return resp
                        .body(Body::from(bytes))
                        .unwrap_or_else(|_| Response::new(Body::empty()));
                }
                Err(_) => continue,
            }
        }
    }
    err_status(StatusCode::NOT_FOUND, "blob not found")
}

/// A full sha256 names its bytes forever, so the WebView may keep them: a
/// screenshot scrolled back into view (or a chat reopened) no longer
/// re-downloads and re-decodes every image. A short prefix could come to match
/// a different file, so it is never marked immutable.
fn blob_cache_control(hash: &str) -> Option<&'static str> {
    (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .then_some("private, max-age=31536000, immutable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_full_sha256_blob_is_cached_as_immutable() {
        let full = "6a9af0e6790d91a45d23f57e13f63a83cd5f2de8caa838b1ebcdcfd9f44ee185";
        assert_eq!(
            blob_cache_control(full),
            Some("private, max-age=31536000, immutable")
        );
        assert_eq!(blob_cache_control(&full[..8]), None);
        assert_eq!(blob_cache_control(&format!("{}zz", &full[..62])), None);
    }
}
