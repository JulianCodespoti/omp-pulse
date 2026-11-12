//! Web-push subscription endpoints and the SSE notify stream.

use super::*;
use axum::{
    Json,
    body::Body,
    extract::{Extension, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub(super) async fn vapid_public_key(State(state): State<Arc<AppState>>) -> Response {
    ok(json!({ "ok": true, "publicKey": state.push.vapid_public_key() }))
}

pub(super) async fn push_status(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<AuthContext>,
) -> Response {
    let principal = context.push_principal();
    ok(json!({
        "ok": true,
        "scope": "device",
        "subscribed": state.push.has_subscription(&principal),
    }))
}

pub(super) async fn push_subscribe(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<AuthContext>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    // Web Push is a device-level capability. The old route required the
    // currently open session path, which meant a phone could never hear about
    // a conversation it had not already opened. Ignore the legacy field while
    // retaining it in the accepted request shape for older clients.
    let Some(sub) = body.get("subscription") else {
        return err_status(StatusCode::BAD_REQUEST, "invalid subscription");
    };
    if !sub.is_object() {
        return err_status(StatusCode::BAD_REQUEST, "invalid subscription");
    }
    let endpoint = sub.get("endpoint").and_then(|v| v.as_str()).unwrap_or("");
    if endpoint.is_empty() {
        return err_status(StatusCode::BAD_REQUEST, "invalid subscription");
    }
    let keys = match sub.get("keys") {
        Some(v) if v.is_object() => v,
        _ => return err_status(StatusCode::BAD_REQUEST, "invalid subscription keys"),
    };
    if keys.get("p256dh").and_then(|v| v.as_str()).is_none()
        || keys.get("auth").and_then(|v| v.as_str()).is_none()
    {
        return err_status(StatusCode::BAD_REQUEST, "invalid subscription keys");
    }
    let principal = context.push_principal();
    match state.push.subscribe(sub, &principal) {
        Ok(()) => ok(json!({ "ok": true, "scope": "device" })),
        Err(e) if e == crate::server::push::SUBSCRIPTION_OWNERSHIP_CONFLICT => {
            err_status(StatusCode::CONFLICT, &e)
        }
        Err(e) => err(&e),
    }
}

pub(super) async fn push_unsubscribe(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<AuthContext>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let endpoint = body.get("endpoint").and_then(|v| v.as_str()).unwrap_or("");
    if endpoint.is_empty() {
        return err_status(StatusCode::BAD_REQUEST, "endpoint required");
    }
    let principal = context.push_principal();
    match state.push.unsubscribe(endpoint, &principal) {
        Ok(()) => ok(json!({ "ok": true, "scope": "device" })),
        Err(e) => err(&e),
    }
}

#[derive(Deserialize)]
pub(super) struct NotifyQuery {
    token: Option<String>,
}

fn progress_sse(payload: &Value) -> String {
    format!("event: progress\ndata: {payload}\n\n")
}

/// `GET /api/notify/stream` — Server-Sent Events for native Android.
/// notification (id: <monotonic>) and `event: ping` every 25s. The stream is a
/// [`push::NotifySubscription`]: retained history first, then live, with the
/// gap between the two closed and duplicates dropped (see `push`). Bounded by
/// the retention ring — nothing outside it is promised. Compression is
/// disabled for this response — a buffered SSE stream would silently hang.
pub(super) async fn notify_stream(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<NotifyQuery>,
) -> Response {
    // INVARIANT: accept both header and query token for SSE, mirroring
    // how `/ws` accepts `?token=` (native EventSource often cannot set
    // headers). Either is sufficient.
    let header_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer_token);
    let token = header_token.or(q.token.as_deref()).unwrap_or("");
    let Some(context) = authenticate_token(&state, token) else {
        return err_status(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let device_id = context.device_id().map(str::to_string);
    let devices = Arc::clone(&state.devices);
    // Last-Event-ID is case-insensitive per HTTP; HeaderMap handles that.
    let last_id = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());

    let mut notifications = state.push.subscribe_notifications(last_id);
    // Live status ticks ride the same stream as their own event name, with no
    // SSE id (see `push::progress`): a client that predates them ignores the
    // unknown event instead of buzzing, and `Last-Event-ID` stays a pure
    // replay cursor. Subscribed BEFORE the snapshot so no change falls between.
    let mut progress = crate::server::push::progress::subscribe();
    let running = crate::server::push::progress::snapshot();

    // Use an mpsc channel as the bridge between the broadcast + timer task
    // and the HTTP body stream. The task drops cleanly when the client
    // disconnects (body_rx closed → send fails → task exits), so no
    // subscriber task is leaked.
    let (body_tx, body_rx) =
        tokio::sync::mpsc::channel::<Result<String, std::convert::Infallible>>(32);

    let stream_devices = Arc::clone(&devices);
    let stream_device_id = device_id.clone();
    tokio::spawn(async move {
        // Retained history first (the phone was in Doze), then live. The
        // subscription owns that boundary — which of the two a notification
        // arrived on is its business, not this loop's.
        let mut interval = tokio::time::interval(Duration::from_secs(25));
        // The first tick completes immediately; skip it so the first ping
        // is 25s after connect, not at connect.
        interval.tick().await;
        for payload in running {
            if body_tx.send(Ok(progress_sse(&payload))).await.is_err() {
                return;
            }
        }
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if device_id
                        .as_deref()
                        .is_some_and(|id| devices.is_revoked(id))
                    {
                        break;
                    }
                    let sse = "event: ping\ndata: {}\n\n".to_string();
                    if body_tx.send(Ok(sse)).await.is_err() {
                        break;
                    }
                }
                result = notifications.next() => {
                    let Some(env) = result else {
                        break;
                    };
                    let data = serde_json::to_string(&env.payload).unwrap_or_else(|_| "{}".to_string());
                    let sse = format!("id: {}\nevent: notify\ndata: {}\n\n", env.id, data);
                    if body_tx.send(Ok(sse)).await.is_err() {
                        break;
                    }
                }
                // A lagged receiver just misses ticks; the next one repairs it.
                Ok(payload) = progress.recv() => {
                    if body_tx.send(Ok(progress_sse(&payload))).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Convert the mpsc Receiver into a Stream without requiring the
    // `tokio-stream` crate: `unfold` polls the receiver.
    let stream = futures_util::stream::unfold(
        (body_rx, stream_devices, stream_device_id),
        |(mut rx, devices, device_id)| async move {
            let item = rx.recv().await?;
            // Check at the body boundary, not when enqueuing: buffered
            // notifications must not escape after the device is revoked.
            if device_id
                .as_deref()
                .is_some_and(|id| devices.is_revoked(id))
            {
                return None;
            }
            Some((item, (rx, devices, device_id)))
        },
    );
    // `Body::from_stream` requires `O: Into<Bytes>`; `String` converts via
    // `Bytes::from` (bytes crate, pulled by axum). Map explicitly to Bytes
    // to make the impl visible without adding a direct `bytes` dep in
    // Cargo.toml — axum already depends on it, so `bytes::Bytes` resolves.
    let byte_stream = stream.map(|res| {
        res.map(|s| {
            // Use `axum::body::Bytes` if available, falling back to Vec<u8>.
            // `String` into `Bytes` is the same allocation.
            let bytes: Vec<u8> = s.into_bytes();
            bytes
        })
    });
    let body = Body::from_stream(byte_stream);

    // Build the SSE response with anti-buffering headers.
    // Compression is disabled by NOT nesting this route under the
    // `CompressionLayer` used for `/api/*` — see `router()` below.
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Accel-Buffering", "no")
        .body(body)
        .unwrap()
        .into_response()
}

pub(super) async fn debug_notify(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer_token)
        .unwrap_or("");
    let Some(context) = authenticate_token(&state, token) else {
        return err_status(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    if !context.can_control() {
        return err_status(StatusCode::FORBIDDEN, "forbidden");
    }
    let session = body
        .get("session")
        .and_then(|v| v.as_str())
        .unwrap_or("/tmp/debug.jsonl")
        .to_string();
    let title = body
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Test notification")
        .to_string();
    let text = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("This is a test from the daemon")
        .to_string();
    let push = Arc::clone(&state.push);
    tokio::spawn(async move {
        push.notify(&session, &title, &text, crate::server::push::KIND_AGENT_END)
            .await;
    });
    ok(json!({ "ok": true }))
}
