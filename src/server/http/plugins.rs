//! Plugin endpoints for paired devices: the catalogue, a plugin's client script,
//! the on/off decision, option values, the latest reading of a declared host
//! source and the run of a declared host action.
//!
//! `crate::plugins` owns every rule (hashing, approval, "only an enabled plugin
//! is served or run"); these handlers resolve the folders, move the blocking
//! file work off the async workers and map `PluginError` to a status code.

use super::*;
use crate::plugins::{self as store, PluginDirs, PluginError};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

/// Body of `POST /api/plugins/{id}/state`. `hash` is the hash the person
/// reviewed; the store refuses to enable a plugin whose current hash differs.
#[derive(Deserialize)]
struct StateBody {
    enabled: bool,
    hash: Option<String>,
}

/// Body of `POST /api/plugins/{id}/options`. `values` must be a JSON object; a
/// missing or differently typed field fails the parse and becomes a 400.
#[derive(Deserialize)]
struct OptionsBody {
    values: serde_json::Map<String, Value>,
}

/// Body of `POST /api/plugins/{id}/actions/{action}`. `hash` is the hash the
/// person approved; the store refuses to run an action of a changed plugin.
#[derive(Deserialize)]
struct ActionBody {
    hash: String,
    arg: Option<String>,
}

/// The plugin folders plus the omp binary the daemon resolved for its own
/// children, so a command written as `omp` runs the same omp even when a
/// service's PATH lacks it. `Config` falls back to the bare name `omp` when it
/// found nothing; that is a PATH lookup the store already does, so it is passed
/// as "none" rather than as if the daemon had resolved a binary.
fn plugin_dirs(state: &AppState) -> PluginDirs {
    let omp_bin = &state.cfg.omp_bin;
    let resolved = omp_bin
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty());
    PluginDirs::from_paths(&state.cfg.paths).with_omp_bin(resolved.then(|| omp_bin.clone()))
}

/// The failure body every plugin route shares. `code` is stable for clients to
/// branch on; `error` is the sentence to show.
fn plugin_error(error: &PluginError) -> Response {
    let status = match error {
        PluginError::NotFound | PluginError::SourceNotFound | PluginError::ActionNotFound => {
            StatusCode::NOT_FOUND
        }
        PluginError::NotEnabled | PluginError::HashMismatch | PluginError::ActionBusy => {
            StatusCode::CONFLICT
        }
        PluginError::Invalid(_) => StatusCode::BAD_REQUEST,
        PluginError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    json_response(
        status,
        json!({ "ok": false, "code": error.code(), "error": error.to_string() }),
    )
}

/// A blocking-pool task that panicked has no `PluginError` of its own.
fn plugin_task_failed() -> Response {
    plugin_error(&PluginError::Io("the plugin task failed".to_owned()))
}

pub(super) async fn plugin_list(State(state): State<Arc<AppState>>) -> Response {
    let dirs = plugin_dirs(&state);
    match tokio::task::spawn_blocking(move || store::list(&dirs)).await {
        Ok(plugins) => ok(json!({ "ok": true, "plugins": plugins })),
        Err(_) => plugin_task_failed(),
    }
}

pub(super) async fn plugin_client_script(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let dirs = plugin_dirs(&state);
    match tokio::task::spawn_blocking(move || store::client_script(&dirs, &id)).await {
        // `no-store`: the script is gated by the approval hash, so a cached copy
        // must never outlive a revoked or edited plugin.
        Ok(Ok(script)) => (
            [
                (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            script,
        )
            .into_response(),
        Ok(Err(error)) => plugin_error(&error),
        Err(_) => plugin_task_failed(),
    }
}

pub(super) async fn plugin_set_state(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    // Parsed by hand: axum's `Json` rejection answers with plain text and a
    // different status, and clients branch on the `code` field.
    let body: StateBody = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(_) => {
            return plugin_error(&PluginError::Invalid(
                "the request body must be {\"enabled\": bool, \"hash\"?: string}".to_owned(),
            ));
        }
    };
    let dirs = plugin_dirs(&state);
    let result = tokio::task::spawn_blocking(move || {
        store::set_enabled(&dirs, &id, body.enabled, body.hash.as_deref())
    })
    .await;
    match result {
        Ok(Ok(plugin)) => ok(json!({ "ok": true, "plugin": plugin })),
        Ok(Err(error)) => plugin_error(&error),
        Err(_) => plugin_task_failed(),
    }
}

pub(super) async fn plugin_source(
    State(state): State<Arc<AppState>>,
    Path((id, source)): Path<(String, String)>,
) -> Response {
    let dirs = plugin_dirs(&state);
    match store::read_source(&dirs, &id, &source).await {
        Ok(reading) => ok(json!({ "ok": true, "reading": reading })),
        Err(error) => plugin_error(&error),
    }
}

pub(super) async fn plugin_set_options(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let body: OptionsBody = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(_) => {
            return plugin_error(&PluginError::Invalid(
                "the request body must be {\"values\": {…}}".to_owned(),
            ));
        }
    };
    let dirs = plugin_dirs(&state);
    let result =
        tokio::task::spawn_blocking(move || store::set_options(&dirs, &id, &body.values)).await;
    match result {
        Ok(Ok(plugin)) => ok(json!({ "ok": true, "plugin": plugin })),
        Ok(Err(error)) => plugin_error(&error),
        Err(_) => plugin_task_failed(),
    }
}

pub(super) async fn plugin_run_action(
    State(state): State<Arc<AppState>>,
    Path((id, action)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let body: ActionBody = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(_) => {
            return plugin_error(&PluginError::Invalid(
                "the request body must be {\"hash\": string, \"arg\"?: string}".to_owned(),
            ));
        }
    };
    let dirs = plugin_dirs(&state);
    match store::run_action(&dirs, &id, &action, &body.hash, body.arg.as_deref()).await {
        Ok(result) => ok(json!({ "ok": true, "result": result })),
        Err(error) => plugin_error(&error),
    }
}
