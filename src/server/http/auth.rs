//! Bearer-token authentication and per-route roles, plus the device pairing,
//! listing and revocation endpoints.

use super::*;
use crate::{
    server::device_auth::{AuthenticatedDevice, DeviceRole},
    server::push::PushPrincipal,
    types::Config,
};
use axum::{
    Json,
    extract::{Extension, Path, State},
    http::{StatusCode, header},
    middleware,
    response::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;

/// The authenticated principal for a request. The desktop owner is an
/// out-of-band administrator, while phone requests carry an independent
/// device identity that can be revoked without changing other devices.
#[derive(Clone)]
pub(super) struct AuthContext {
    owner: bool,
    device: Option<AuthenticatedDevice>,
}

impl AuthContext {
    fn owner() -> Self {
        Self {
            owner: true,
            device: None,
        }
    }

    fn device(device: AuthenticatedDevice) -> Self {
        Self {
            owner: false,
            device: Some(device),
        }
    }

    pub(super) fn role(&self) -> DeviceRole {
        self.device
            .as_ref()
            .map(|device| device.role)
            .unwrap_or(DeviceRole::Admin)
    }

    pub(super) fn can_control(&self) -> bool {
        self.owner || self.role().can_control()
    }

    fn is_admin(&self) -> bool {
        self.owner || self.role().is_admin()
    }

    pub(super) fn device_id(&self) -> Option<&str> {
        self.device.as_ref().map(|device| device.id.as_str())
    }
    pub(super) fn push_principal(&self) -> PushPrincipal {
        match self.device_id() {
            Some(id) => PushPrincipal::Device(id.to_string()),
            None => PushPrincipal::Owner,
        }
    }
}

fn hash_token(token: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

fn token_matches(cfg: &Config, token: &str) -> bool {
    match &cfg.token_hash {
        Some(expected) => {
            let actual = hash_token(token);
            bool::from(expected[..].ct_eq(&actual[..]))
        }
        // No owner token configured: device authentication may still work,
        // but an unconfigured installation cannot use desktop administration.
        None => false,
    }
}

/// Extract the token from an `Authorization` header: `/^Bearer\\s+(.+)$/i`.
pub(super) fn bearer_token(header: &str) -> Option<&str> {
    let h = header.trim();
    let (scheme, rest) = h.split_once(char::is_whitespace)?;
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() { None } else { Some(token) }
}

pub(super) fn authenticate_token(state: &AppState, token: &str) -> Option<AuthContext> {
    if token_matches(&state.cfg, token) {
        return Some(AuthContext::owner());
    }
    let device = state.devices.authenticate(token)?;
    state.devices.observe(&device.id);
    Some(AuthContext::device(device))
}

#[derive(Clone, Copy)]
enum RequiredRole {
    Read,
    Control,
    Admin,
}

fn required_role(path: &str, method: &axum::http::Method) -> RequiredRole {
    let read_method = *method == axum::http::Method::GET || *method == axum::http::Method::HEAD;
    // Diagnostics executes the live doctor chain (including scratch writes and
    // a bounded external probe), while these endpoints expose arbitrary files
    // under a session's cwd. Keep both classes away from read-only devices even
    // for GET requests.
    if path == "/api/diagnostics"
        || path == "/api/commands"
        || path == "/api/file"
        || path == "/api/files"
        || path == "/api/changes"
        || path == "/api/browse"
        || path == "/api/raw"
    {
        return RequiredRole::Control;
    }
    if path == "/api/devices/pairing-codes" || (path == "/api/devices" && read_method) {
        return RequiredRole::Admin;
    }
    // Sign-in carries pasted API keys and switches the computer's omp account,
    // so even the read-only GETs (the provider list, the live transcript) are
    // Admin: a transcript holds authorization URLs and codes.
    if path == "/api/providers" || path.starts_with("/api/providers/") {
        return RequiredRole::Admin;
    }
    // Plugins: reading the catalogue or a script is Read, and every mutation
    // (switching a plugin on or off) is Control. Reading a source is Control
    // too, even for GET: it runs the source's command on this computer when the
    // cache is stale, which is what keeps `/api/diagnostics` away from read-only
    // devices above (a read-only device once made the daemon run commands by
    // polling a source). This arm is explicit so no earlier arm or the default
    // can change that, and it is Control rather than Admin because a control
    // device can already run commands on this computer through `/api/bash`:
    // approving a plugin's fixed, displayed commands grants it nothing new.
    if path == "/api/plugins" || path.starts_with("/api/plugins/") {
        return if read_method && !is_plugin_source(path) {
            RequiredRole::Read
        } else {
            RequiredRole::Control
        };
    }
    // Revocation is checked against the principal in the handler so a device
    // can revoke itself while an administrator can revoke another device.
    if path == "/api/devices" || path.starts_with("/api/devices/") {
        return RequiredRole::Read;
    }
    if path == "/api/open" {
        // Opening a timeline is read-only. In particular, a read device must
        // not trigger the optional child pre-warm in the handler.
        return RequiredRole::Read;
    }
    if path == "/api/prompt"
        || path == "/api/bash"
        || path == "/api/command"
        || path == "/api/export"
        || path == "/api/session/delete"
        || path == "/api/rpc"
        || path == "/api/abort"
        || path == "/api/new"
        || path == "/api/prewarm"
        || path == "/api/transcribe"
        || path == "/api/transcribe/warm"
        || path == "/api/panes/answer"
        || path == "/api/desktop/open"
        || path == "/api/desktop/close"
        || path.starts_with("/api/collab/")
        || path == "/api/push/subscribe"
        || path == "/api/push/unsubscribe"
    {
        return RequiredRole::Control;
    }
    if read_method {
        RequiredRole::Read
    } else {
        // Unknown future mutation routes fail closed for read-only devices.
        RequiredRole::Control
    }
}

/// `/api/plugins/{id}/sources/{source}`. A plugin id never holds a `/`.
fn is_plugin_source(path: &str) -> bool {
    path.strip_prefix("/api/plugins/")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(_, tail)| tail.starts_with("sources/"))
}

fn allows(ctx: &AuthContext, required: RequiredRole) -> bool {
    match required {
        RequiredRole::Read => true,
        RequiredRole::Control => ctx.can_control(),
        RequiredRole::Admin => ctx.is_admin(),
    }
}

pub(super) async fn require_auth(
    State(state): State<Arc<AppState>>,
    original_uri: axum::extract::OriginalUri,
    mut req: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    let Some(token) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer_token)
    else {
        return err_status(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let Some(context) = authenticate_token(&state, token) else {
        return err_status(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    // The nested router strips /api from Request::uri(); authorization uses
    // the original public route, or every privileged GET falls through as read.
    if !allows(&context, required_role(original_uri.path(), req.method())) {
        return err_status(StatusCode::FORBIDDEN, "forbidden");
    }
    req.extensions_mut().insert(context);
    next.run(req).await
}

#[derive(Deserialize)]
struct PairingCodeRequest {
    role: Option<DeviceRole>,
    name: Option<String>,
}

/// Unauthenticated enrollment endpoint. The code is the only credential
/// accepted here; owner/device bearer tokens are never returned by this path.
pub(super) async fn pair_device(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let code = body
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let name = body.get("name").and_then(Value::as_str);
    if code.is_empty() {
        return err_status(StatusCode::UNAUTHORIZED, "invalid pairing code");
    }
    match state.devices.redeem_pairing_code(code, name) {
        Ok(result) => ok(json!({ "ok": true, "token": result.token, "device": result.device })),
        Err(_) => err_status(StatusCode::UNAUTHORIZED, "invalid pairing code"),
    }
}

/// Mint an enrollment code. `require_auth` has already enforced administrator
/// access, including the desktop owner credential.
pub(super) async fn issue_pairing_code(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let request: PairingCodeRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(_) => return err_status(StatusCode::BAD_REQUEST, "invalid pairing-code request"),
    };
    let role = request.role.unwrap_or(DeviceRole::Control);
    match state
        .devices
        .issue_pairing_code(role, request.name.as_deref())
    {
        Ok(code) => ok(json!({
            "ok": true,
            "code": code.code,
            "expiresAt": code.expires_at,
        })),
        Err(e) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

pub(super) async fn device_me(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<AuthContext>,
) -> Response {
    if let Some(id) = context.device_id() {
        return match state.devices.device(id) {
            Some(device) => ok(json!({ "ok": true, "device": device })),
            None => err_status(StatusCode::UNAUTHORIZED, "unauthorized"),
        };
    }
    // Owner credentials are trusted desktop administration, not a paired
    // phone. Return a redacted synthetic view for settings/health consumers.
    ok(json!({
        "ok": true,
        "device": {
            "id": "owner",
            "name": "Owner",
            "role": "admin",
            "capabilities": DeviceRole::Admin.capabilities(),
        }
    }))
}

pub(super) async fn list_devices(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<AuthContext>,
) -> Response {
    let current = context.device_id().unwrap_or("owner");
    ok(json!({
        "ok": true,
        "devices": state.devices.list(),
        "currentDeviceId": current,
    }))
}

pub(super) async fn revoke_device(
    State(state): State<Arc<AppState>>,
    Extension(context): Extension<AuthContext>,
    Path(device_id): Path<String>,
) -> Response {
    // Any device may invalidate itself. Only an administrator may invalidate
    // another device. The owner synthetic id is never a revocable device.
    if context.device_id() != Some(device_id.as_str()) && !context.is_admin() {
        return err_status(StatusCode::FORBIDDEN, "forbidden");
    }
    match state.devices.revoke(&device_id) {
        Ok(true) => ok(json!({ "ok": true })),
        Ok(false) => err_status(StatusCode::NOT_FOUND, "device not found"),
        Err(e) => err_status(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_and_delete_need_a_control_device() {
        let post = axum::http::Method::POST;
        for path in ["/api/export", "/api/session/delete"] {
            assert!(matches!(required_role(path, &post), RequiredRole::Control));
        }
    }

    #[test]
    fn provider_sign_in_is_admin_even_for_reads() {
        for method in [axum::http::Method::GET, axum::http::Method::POST] {
            for path in [
                "/api/providers",
                "/api/providers/login",
                "/api/providers/login/input",
                "/api/providers/login/cancel",
            ] {
                assert!(matches!(required_role(path, &method), RequiredRole::Admin));
            }
        }
    }

    #[test]
    fn plugins_read_with_get_and_switch_or_run_with_control() {
        let get = axum::http::Method::GET;
        let post = axum::http::Method::POST;
        for path in ["/api/plugins", "/api/plugins/host-usage/client.js"] {
            assert!(matches!(required_role(path, &get), RequiredRole::Read));
        }
        let state = "/api/plugins/host-usage/state";
        assert!(matches!(required_role(state, &post), RequiredRole::Control));
        // A source read runs a command on a stale cache: never for a read-only device.
        let source = "/api/plugins/host-usage/sources/load";
        assert!(matches!(required_role(source, &get), RequiredRole::Control));

        let read_only = AuthContext::device(AuthenticatedDevice {
            id: "d1".to_owned(),
            role: DeviceRole::Read,
        });
        let control = AuthContext::device(AuthenticatedDevice {
            id: "d2".to_owned(),
            role: DeviceRole::Control,
        });
        assert!(allows(&read_only, required_role("/api/plugins", &get)));
        assert!(!allows(&read_only, required_role(source, &get)));
        assert!(allows(&control, required_role(source, &get)));
        assert!(!allows(&read_only, required_role(state, &post)));
        assert!(allows(&control, required_role(state, &post)));
        for mutation in [
            "/api/plugins/host-usage/options",
            "/api/plugins/host-usage/actions/start",
        ] {
            assert!(matches!(
                required_role(mutation, &post),
                RequiredRole::Control
            ));
            assert!(!allows(&read_only, required_role(mutation, &post)));
            assert!(allows(&control, required_role(mutation, &post)));
        }
    }
}
