//! Web-push notifications with a persisted device-scoped subscription store.
//!
//! VAPID keys are loaded from `~/.omp/omp-remote.vapid.json` (`{publicKey,
//! privateKey}`, base64url raw P-256 scalars — the same keypair the old
//! Bun daemon used, so existing browser subscriptions keep working). The
//! subscription store is a versioned JSON object containing one device-wide
//! list of subscriptions. Every persisted entry also carries a server-injected
//! binding (`deviceId` for a paired device or `ownerHash` for the current
//! desktop-owner credential). Legacy entries without a binding are discarded
//! during migration and are never eligible for private delivery.
//!
//! Signing and message encryption are implemented in-house — RFC 8292 VAPID
//! plus the RFC 8291/8188 `aes128gcm` content coding — because `web-push`
//! depended on `ece`, which pulls in `openssl` and cannot build for Windows
//! or musl. Everything here is pure-Rust crypto (`p256`, `hkdf`, `sha2`,
//! `aes-gcm`, `base64`, with `hmac` re-exported by `hkdf`) and the HTTP POST
//! goes through `ureq` (rustls), so `openssl-sys` stays out of the tree.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tracing::{debug, info, warn};

use crate::server::device_auth::DeviceRegistry;
use crate::types::SharedConfig;

mod alerts;
pub mod progress;
mod turns;
mod webpush;

use webpush::*;

pub use alerts::{
    KIND_AGENT_END, KIND_CHILD_DIED, KIND_LINK_LOST, KIND_NEEDS_INPUT, KIND_PROMPT_FAILED,
    maybe_push_alert, maybe_push_link_lost, maybe_push_needs_input,
    maybe_push_needs_input_with_req_id, rearm_needs_input, session_title,
};
pub use turns::{
    LAST_ASSISTANT_TEXT, LAST_TURN_FAILED, TURN_FAILED_STALENESS, clear_turn_aborted,
    clear_turn_failed, note_assistant_text, note_turn_aborted, note_turn_failed,
    strip_notify_markup, summarise_assistant, take_assistant_text, take_turn_aborted,
    take_turn_failed, turn_was_aborted,
};

/// Push message lifetime on the push service, in seconds (the old web-push
/// client used the same TTL).
const PUSH_TTL: &str = "60";
/// Broadcast channel capacity for the SSE notify fan-out. 32 is enough to
/// absorb a burst of notifications (debounce already limits to ~1 per 30s
/// per kind per session) while keeping memory bounded; a lagged receiver
/// simply gets a `Lagged` error and resyncs from the ring buffer.
const NOTIFY_CHANNEL_CAPACITY: usize = 32;
/// Bounded ring of recent notifications kept for replay when a phone
/// reconnects after Doze/sleep. 20 entries covers the case that matters
/// most — the single notification that fired while the phone was
/// locked — plus headroom for a burst (e.g. several sessions finishing close
/// together). Each payload is <1 KB JSON, so 20 entries is <20 KB total and
/// retains minutes to hours of history at the observed rate (a few buzzes
/// per hour). Bounded to prevent unbounded growth if the phone stays
/// disconnected for days.
const NOTIFY_RING_CAPACITY: usize = 20;

/// Current on-disk format. The previous versions had no authenticated
/// subscription owner, so they are treated as legacy and rewritten empty.
const PUSH_STORE_VERSION: u64 = 3;
/// Internal map key used while the store is in memory. It is never written
/// directly: [`persist`] serializes the versioned `{version, devices}` shape.
const DEVICE_SCOPE: &str = "__device__";
/// Server-owned metadata fields. They are stripped from browser JSON before
/// the current authenticated principal is injected.
const SUBSCRIPTION_DEVICE_ID: &str = "deviceId";
const SUBSCRIPTION_OWNER_HASH: &str = "ownerHash";
/// Stable client-facing marker for an endpoint conflict with another active
/// principal. The HTTP layer maps this to a conflict response.
pub const SUBSCRIPTION_OWNERSHIP_CONFLICT: &str =
    "subscription endpoint is bound to another active principal";

/// The HTTP layer constructs this only from its authenticated request context;
/// no client-supplied JSON participates in the binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PushPrincipal {
    Device(String),
    Owner,
}

/// Binding decoded from a persisted subscription.
enum StoredBinding<'a> {
    Device(&'a str),
    OwnerHash(&'a str),
}

/// Longest notification body worth showing. Android truncates a collapsed
/// notification to roughly this much anyway, and the point is to say whether
/// the reply needs you, not to reproduce it.
pub const NOTIFY_BODY_MAX: usize = 140;

fn owner_binding_from_hash(hash: &[u8; 32]) -> String {
    let mut out = String::with_capacity(hash.len() * 2);
    for byte in hash {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// A notification with a monotonic id for SSE `Last-Event-ID` replay.
/// The payload is the exact JSON `push_payload` builds.
#[derive(Clone, Debug)]
pub struct NotifyEnvelope {
    pub id: u64,
    pub payload: Value,
}

/// VAPID signing keypair, both halves base64url (raw P-256).
struct VapidKeys {
    public_key: String,
    private_key: String,
}

/// Decode the server-owned subscription binding. A record must contain
/// exactly one binding field; browser JSON is untrusted and records with
/// neither (or both) are ineligible.
fn stored_binding(subscription: &Value) -> Option<StoredBinding<'_>> {
    let object = subscription.as_object()?;
    let device_id = object
        .get(SUBSCRIPTION_DEVICE_ID)
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty());
    let owner_hash = object
        .get(SUBSCRIPTION_OWNER_HASH)
        .and_then(Value::as_str)
        .filter(|hash| !hash.trim().is_empty());
    match (device_id, owner_hash) {
        (Some(id), None) => Some(StoredBinding::Device(id)),
        (None, Some(hash)) => Some(StoredBinding::OwnerHash(hash)),
        _ => None,
    }
}

/// Read the current `{version: 3, devices: [...]}` shape. Previous formats
/// had no authenticated identity and are intentionally discarded rather than
/// copied into the new store. A current record without a server binding is
/// discarded too, so a hand-edited or partially migrated file cannot bypass
/// the eligibility check.
fn parse_store(raw: &str) -> Result<(HashMap<String, Vec<Value>>, bool), String> {
    let value: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let Some(object) = value.as_object() else {
        return Err("push store must be a JSON object".to_string());
    };
    if object.get("version").and_then(Value::as_u64) != Some(PUSH_STORE_VERSION) {
        // Legacy `sessionPath -> [PushSubscription]` maps and the previous
        // device-scoped v2 list are unbound by definition. Rewriting them to
        // an empty v3 store is the clean migration and prevents old endpoints
        // from receiving private payloads after restart.
        return Ok((HashMap::new(), true));
    }
    let list = object
        .get("devices")
        .ok_or_else(|| "versioned push store missing devices".to_string())?
        .as_array()
        .ok_or_else(|| "versioned push store devices must be an array".to_string())?;
    let mut devices = Vec::with_capacity(list.len());
    let mut migrated = false;
    for subscription in list {
        let endpoint = subscription.get("endpoint").and_then(Value::as_str);
        if endpoint.is_none_or(|endpoint| endpoint.is_empty())
            || stored_binding(subscription).is_none()
        {
            migrated = true;
            continue;
        }
        // Endpoint ownership is unique. If a crash or manual edit left
        // duplicate entries, keep the last one, matching subscribe's
        // deliberate re-enrollment replacement semantics.
        if let Some(index) = devices.iter().position(|existing: &Value| {
            existing.get("endpoint").and_then(Value::as_str) == endpoint
        }) {
            devices.remove(index);
            migrated = true;
        }
        devices.push(subscription.clone());
    }
    let mut store = HashMap::new();
    if !devices.is_empty() {
        store.insert(DEVICE_SCOPE.to_string(), devices);
    }
    Ok((store, migrated))
}

fn serialise_store(store: &HashMap<String, Vec<Value>>) -> Value {
    json!({
        "version": PUSH_STORE_VERSION,
        "devices": store.get(DEVICE_SCOPE).map(Vec::as_slice).unwrap_or_default(),
    })
}

pub struct Push {
    vapid: VapidKeys,
    store: Mutex<HashMap<String, Vec<Value>>>,
    store_path: PathBuf,
    /// Live registry shared with HTTP authorization and stream revocation.
    /// Delivery consults it for every subscription rather than trusting a
    /// startup snapshot.
    devices: Arc<DeviceRegistry>,
    /// SHA-256 digest of the currently configured desktop-owner token,
    /// encoded as lowercase hex. Owner subscriptions bind to this value so a
    /// token rotation invalidates old owner destinations after restart.
    owner_binding: Option<String>,
    /// Reused across sends (clone is cheap; shares the connection pool).
    agent: ureq::Agent,
    notify_tx: tokio::sync::broadcast::Sender<NotifyEnvelope>,
    /// Retained log + id counter behind one lock. See [`NotifyLog`].
    notify_log: Arc<Mutex<NotifyLog>>,
    /// Test-only rendezvous that lets a publisher run at exactly the point a
    /// subscription sits between its live subscribe and its history
    /// snapshot. Compiled out of releases, where the field does not exist.
    #[cfg(test)]
    publish_race_hook: Mutex<Option<Arc<std::sync::Barrier>>>,
}

impl Push {
    /// Compatibility view for `omp-pulse push-test`. There is one device
    /// scope now, not one row per session; returning the sentinel keeps the
    /// existing CLI's "send to all subscriptions" path working.
    pub fn subscribed_sessions(&self) -> Vec<String> {
        if self.has_device_subscription() {
            vec![DEVICE_SCOPE.to_string()]
        } else {
            Vec::new()
        }
    }

    /// Number of currently eligible subscriptions. The argument remains for
    /// source compatibility with the CLI, but subscriptions are device-scoped
    /// and therefore the count is identical for every session path.
    pub fn device_count(&self, _session_path: &str) -> usize {
        let guard = match self.store.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard
            .get(DEVICE_SCOPE)
            .map(|subscriptions| {
                subscriptions
                    .iter()
                    .filter(|subscription| self.subscription_eligible(subscription))
                    .count()
            })
            .unwrap_or(0)
    }

    /// Whether at least one currently eligible endpoint is registered.
    pub fn has_device_subscription(&self) -> bool {
        self.device_count("") > 0
    }

    /// Whether this authenticated principal owns an eligible endpoint. The
    /// HTTP status handler uses this instead of exposing another device's
    /// subscription state.
    pub fn has_subscription(&self, principal: &PushPrincipal) -> bool {
        let Ok(binding) = self.principal_binding(principal) else {
            return false;
        };
        let guard = match self.store.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.get(DEVICE_SCOPE).is_some_and(|subscriptions| {
            subscriptions.iter().any(|subscription| {
                self.subscription_eligible(subscription)
                    && Self::binding_matches(subscription, &binding)
            })
        })
    }

    /// Resolve a request principal to the server-owned binding written to
    /// disk. Device ids are checked against the live registry here so callers
    /// cannot register a made-up or revoked identity.
    fn principal_binding(&self, principal: &PushPrincipal) -> Result<String, String> {
        match principal {
            PushPrincipal::Device(id) if !id.trim().is_empty() => {
                if self.devices.is_revoked(id) {
                    return Err("device is unknown or revoked".to_string());
                }
                Ok(id.clone())
            }
            PushPrincipal::Device(_) => Err("device identity is empty".to_string()),
            PushPrincipal::Owner => self
                .owner_binding
                .clone()
                .ok_or_else(|| "desktop owner credential is unavailable".to_string()),
        }
    }

    fn binding_matches(subscription: &Value, binding: &str) -> bool {
        match stored_binding(subscription) {
            Some(StoredBinding::Device(id)) | Some(StoredBinding::OwnerHash(id)) => id == binding,
            None => false,
        }
    }
    /// Delivery is fail-closed: only a live device identity or the exact
    /// owner-token digest captured at startup is eligible. Legacy/unbound,
    /// unknown and revoked records never reach encryption or the provider.
    fn subscription_eligible(&self, subscription: &Value) -> bool {
        match stored_binding(subscription) {
            Some(StoredBinding::Device(id)) => !self.devices.is_revoked(id),
            Some(StoredBinding::OwnerHash(hash)) => self.owner_binding.as_deref() == Some(hash),
            None => false,
        }
    }

    /// A persisted endpoint can be replaced only by its current owner or
    /// during a deliberate re-enrollment after the previous device identity
    /// has become revoked/unknown. Active-device conflicts are rejected.
    fn can_replace(
        devices: &DeviceRegistry,
        existing: &Value,
        principal: &PushPrincipal,
        binding: &str,
    ) -> bool {
        match (stored_binding(existing), principal) {
            (Some(StoredBinding::Device(existing_id)), PushPrincipal::Device(_)) => {
                existing_id == binding || devices.is_revoked(existing_id)
            }
            (Some(StoredBinding::Device(existing_id)), PushPrincipal::Owner) => {
                existing_id == binding || devices.is_revoked(existing_id)
            }
            (Some(StoredBinding::OwnerHash(_)), PushPrincipal::Owner) => true,
            // A phone must never take over an owner-bound endpoint, even when
            // the owner token has rotated and the old hash is now unknown.
            (Some(StoredBinding::OwnerHash(_)), PushPrincipal::Device(_)) => false,
            // Runtime-corrupt records are never eligible for delivery, but a
            // fresh authenticated request may safely replace one.
            (None, _) => true,
        }
    }

    /// Missing store file ⇒ empty map. Missing/invalid VAPID file ⇒ `Err`
    /// (without keys no notification can ever be signed). An unparseable
    /// store file is logged and treated as empty — the store is recoverable,
    /// unlike the keys.
    pub fn load(config: SharedConfig, devices: Arc<DeviceRegistry>) -> Result<Arc<Self>, String> {
        let owner_binding = config.token_hash.as_ref().map(owner_binding_from_hash);
        // A missing key file is a FIRST RUN, not a fault: aborting startup here
        // meant a fresh state directory could not boot at all (hit immediately by
        // the isolated test daemon, and it would hit any new install). An
        // existing file is always reused as-is — phone subscriptions are bound to
        // the public key, so regenerating over one would silently break every
        // registered device.
        if !config.vapid_path.is_file() {
            let generated = generate_vapid_file()?;
            if let Some(parent) = config.vapid_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::write(&config.vapid_path, generated).map_err(|e| {
                format!(
                    "cannot create vapid file {}: {e}",
                    config.vapid_path.display()
                )
            })?;
            tracing::info!(path = %config.vapid_path.display(),
                "generated a VAPID keypair (first run)");
        }
        let vapid_raw = fs::read_to_string(&config.vapid_path).map_err(|e| {
            format!(
                "cannot read vapid file {}: {e}",
                config.vapid_path.display()
            )
        })?;
        let vapid_json: Value = serde_json::from_str(&vapid_raw)
            .map_err(|e| format!("invalid vapid file {}: {e}", config.vapid_path.display()))?;
        let public_key = vapid_json
            .get("publicKey")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                format!(
                    "vapid file {} missing publicKey",
                    config.vapid_path.display()
                )
            })?
            .to_string();
        let private_key = vapid_json
            .get("privateKey")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                format!(
                    "vapid file {} missing privateKey",
                    config.vapid_path.display()
                )
            })?
            .to_string();

        let (store, migrated) = match fs::read_to_string(&config.push_store_path) {
            Ok(raw) => match parse_store(&raw) {
                Ok(parsed) => parsed,
                Err(e) => {
                    warn!(
                        path = %config.push_store_path.display(),
                        error = %e,
                        "push store unparseable, starting empty"
                    );
                    (HashMap::new(), false)
                }
            },
            Err(_) => (HashMap::new(), false), // missing store file = empty map
        };

        // Bound the send so a dead push service cannot pin a blocking thread
        // forever; the old hyper client had no explicit timeout.
        let agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(20)))
            .build()
            .new_agent();

        // INVARIANT: the notify broadcast is the SSE fan-out for native
        // Android. It must never block the sender (Web Push) and must
        // tolerate zero subscribers — the phone is usually disconnected.
        // tokio::sync::broadcast is the same primitive the daemon already
        // uses for ChildEvent/WatchEvent and gives exactly those semantics:
        // send() is non-blocking, returns Err only when there are no
        // receivers (ignored), and a lagged receiver gets Lagged rather
        // than wedging the sender.
        let (notify_tx, _) = tokio::sync::broadcast::channel(NOTIFY_CHANNEL_CAPACITY);
        let push = Arc::new(Self {
            vapid: VapidKeys {
                public_key,
                private_key,
            },
            store: Mutex::new(store),
            store_path: config.push_store_path.clone(),
            devices,
            owner_binding,
            agent,
            notify_tx,
            notify_log: Arc::new(Mutex::new(NotifyLog {
                ring: VecDeque::with_capacity(NOTIFY_RING_CAPACITY),
                // SSE ids MUST survive restarts monotonically: the phone persists
                // Last-Event-ID forever and replay filters `id > after_id`, so a
                // counter restarting at 1 suppresses the whole replay AND drops
                // every new notification numbered below the stale value — exactly
                // the Doze-plus-restart case the ring exists for. Wall-clock
                // millis always grows across restarts, and the id is handed out
                // under the ring lock so it also orders the retained window.
                // Observed live via the invariant, fixed before it bit.
                next_id: now_millis(),
            })),
            #[cfg(test)]
            publish_race_hook: Mutex::new(None),
        });
        if migrated {
            let guard = push
                .store
                .lock()
                .map_err(|_| "push store lock poisoned during migration".to_string())?;
            if let Err(e) = push.persist(&guard) {
                warn!(
                    path = %push.store_path.display(),
                    error = %e,
                    "failed to persist migrated push store"
                );
            } else {
                info!(
                    path = %push.store_path.display(),
                    "migrated push subscriptions to authenticated bindings"
                );
            }
        }
        Ok(push)
    }

    /// The stored VAPID public key, served verbatim to the PWA so its
    /// `PushManager.subscribe` calls produce subscriptions we can sign for.
    pub fn vapid_public_key(&self) -> String {
        self.vapid.public_key.clone()
    }

    /// Upsert a browser `PushSubscription` into the device-wide store,
    /// keyed by its endpoint. The binding is injected from the authenticated
    /// principal; any browser-supplied `deviceId`/`ownerHash` is discarded.
    /// A conflicting active device is rejected. A revoked/unknown previous
    /// device may be deliberately replaced for same-browser re-enrollment.
    pub fn subscribe(&self, subscription: &Value, principal: &PushPrincipal) -> Result<(), String> {
        let binding = self.principal_binding(principal)?;
        let endpoint = subscription
            .get("endpoint")
            .and_then(Value::as_str)
            .filter(|endpoint| !endpoint.is_empty())
            .ok_or_else(|| "invalid subscription: missing endpoint".to_string())?;
        if subscription_keys(subscription).is_none() {
            return Err("invalid subscription keys".to_string());
        }

        let mut object = subscription
            .as_object()
            .cloned()
            .ok_or_else(|| "invalid subscription".to_string())?;
        object.remove(SUBSCRIPTION_DEVICE_ID);
        object.remove(SUBSCRIPTION_OWNER_HASH);
        match principal {
            PushPrincipal::Device(_) => {
                object.insert(
                    SUBSCRIPTION_DEVICE_ID.to_string(),
                    Value::String(binding.clone()),
                );
            }
            PushPrincipal::Owner => {
                object.insert(
                    SUBSCRIPTION_OWNER_HASH.to_string(),
                    Value::String(binding.clone()),
                );
            }
        }
        let bound = Value::Object(object);

        let mut store = self
            .store
            .lock()
            .map_err(|_| "push store lock poisoned".to_string())?;
        let subs = store.entry(DEVICE_SCOPE.to_string()).or_default();
        if let Some(index) = subs
            .iter()
            .position(|existing| existing.get("endpoint").and_then(Value::as_str) == Some(endpoint))
        {
            if !Self::can_replace(&self.devices, &subs[index], principal, &binding) {
                return Err(SUBSCRIPTION_OWNERSHIP_CONFLICT.to_string());
            }
            subs.remove(index);
        }
        subs.push(bound);
        self.persist(&store)
    }

    /// Remove an endpoint only when the authenticated principal owns it.
    /// The desktop owner may remove any endpoint as an explicitly privileged
    /// cleanup operation; device callers get an idempotent no-op for another
    /// device's endpoint rather than an ownership oracle.
    pub fn unsubscribe(&self, endpoint: &str, principal: &PushPrincipal) -> Result<(), String> {
        if endpoint.is_empty() {
            return Err("endpoint required".to_string());
        }
        let binding = self.principal_binding(principal)?;
        let owner = matches!(principal, PushPrincipal::Owner);
        let mut store = self
            .store
            .lock()
            .map_err(|_| "push store lock poisoned".to_string())?;
        let changed = if let Some(subs) = store.get_mut(DEVICE_SCOPE) {
            let before = subs.len();
            subs.retain(|subscription| {
                if subscription.get("endpoint").and_then(Value::as_str) != Some(endpoint) {
                    return true;
                }
                !owner && !Self::binding_matches(subscription, &binding)
            });
            before != subs.len()
        } else {
            false
        };
        if store
            .get(DEVICE_SCOPE)
            .is_some_and(|subscriptions| subscriptions.is_empty())
        {
            store.remove(DEVICE_SCOPE);
        }
        if changed {
            self.persist(&store)?;
        }
        Ok(())
    }

    /// Send `{title, body, sessionPath, kind, tag}` (AES-128-GCM, TTL 60) to
    /// every currently eligible bound subscription. `kind` is one of the
    /// [`KIND_*`](self) constants and the payload `tag` is
    /// `omp-<kind>-<hash(session_path)>`, so the service worker replaces only
    /// notifications of the same kind for the same session. Never errors:
    /// per-subscription failures are logged; 404/410 responses prune the dead
    /// subscription.
    pub async fn notify(&self, session_path: &str, title: &str, body: &str, kind: &str) {
        self.notify_with_req_id(session_path, title, body, kind, None)
            .await;
    }

    /// Like [`notify`], with an OPTIONAL `reqId` (a blocking dialog's id)
    /// carried in the payload so a notification tap can land on the exact
    /// question. The field is omitted entirely when `None`, per the contract.
    pub async fn notify_with_req_id(
        &self,
        session_path: &str,
        title: &str,
        body: &str,
        kind: &str,
        req_id: Option<u64>,
    ) {
        // INVARIANT: the SSE fan-out is fed from this ONE place — the payload
        // built by `push_payload`. Every kind (`agent_end`, `needs_input`,
        // `prompt_failed`, `link_lost`, `child_died`) eventually calls this
        // function (or `notify` which delegates here), so the debounce the
        // callers apply automatically covers both Web Push and SSE without
        // duplication. Adding a future kind requires no new fan-out call.
        let payload_value = push_payload(title, body, session_path, kind, req_id);
        // Publish to the in-process SSE hub BEFORE any Web-Push-specific
        // early return (empty subs, bad VAPID, etc.) — SSE delivery must not
        // depend on having a Web Push subscription. The debounce already
        // happened in the caller, so both transports share exactly one gate.
        self.publish_notify(payload_value.clone());
        let payload = match serde_json::to_vec(&payload_value) {
            Ok(p) => p,
            Err(e) => {
                warn!(session_path, error = %e, "failed to serialize push payload");
                return;
            }
        };

        let subs: Vec<Value> = match self.store.lock() {
            Ok(guard) => guard.get(DEVICE_SCOPE).cloned().unwrap_or_default(),
            Err(_) => {
                warn!(session_path, "push store lock poisoned, skipping notify");
                return;
            }
        };
        if subs.is_empty() {
            return;
        }
        let vapid_key = match parse_vapid_signing_key(&self.vapid.private_key) {
            Ok(k) => k,
            Err(e) => {
                warn!(session_path, error = %e, "skipping push: bad VAPID private key");
                return;
            }
        };

        for sub in subs {
            if !self.subscription_eligible(&sub) {
                debug!(
                    session_path,
                    "skipping push for inactive subscription binding"
                );
                continue;
            }
            // Browser `PushSubscription.toJSON()` yields {endpoint, keys:
            // {p256dh, auth}}; extra fields such as `expirationTime` are
            // ignored, exactly as the old serde `SubscriptionInfo` did.
            let (endpoint, p256dh, auth) = match subscription_keys(&sub) {
                Some(v) => v,
                None => {
                    warn!(session_path, "skipping push: invalid subscription object");
                    continue;
                }
            };
            let Some(origin) = origin_of_endpoint(&endpoint) else {
                warn!(session_path, "skipping push: invalid subscription object");
                continue;
            };
            let auth_header = match vapid_authorization(&vapid_key, &origin) {
                Ok(h) => h,
                Err(e) => {
                    warn!(session_path, error = %e, "skipping push: VAPID signing failed");
                    continue;
                }
            };
            let encrypted = match encrypt_payload(&p256dh, &auth, &payload) {
                Ok(b) => b,
                Err(e) => {
                    warn!(session_path, error = %e, "skipping push: message build failed");
                    continue;
                }
            };
            // Revocation can happen while encryption is running. Re-check
            // immediately before the blocking provider call to avoid sending
            // after a registry change whenever the race is observable.
            if !self.subscription_eligible(&sub) {
                debug!(session_path, "subscription revoked before push send");
                continue;
            }

            // ureq is blocking, so the HTTP POST runs on a blocking thread;
            // the rest of notify stays async and never blocks the runtime.
            // No locks are held across the await.
            let agent = self.agent.clone();
            let send_endpoint = endpoint.clone();
            let send_result = tokio::task::spawn_blocking(move || {
                agent
                    .post(send_endpoint.as_str())
                    .header("TTL", PUSH_TTL)
                    .header("Content-Encoding", "aes128gcm")
                    .header("Content-Type", "application/octet-stream")
                    .header("Authorization", auth_header.as_str())
                    .send(encrypted.as_slice())
            })
            .await;

            match send_result {
                Ok(Ok(response)) => {
                    // Record the provider's status. "No error logged" is not
                    // evidence of delivery, and after replacing the push crate
                    // with an in-house RFC 8291 implementation the only way to
                    // know the crypto is accepted is to see the provider's own
                    // 201. Counters land in /api/status.
                    let status = response.status().as_u16();
                    crate::metrics::inc("push_sent");
                    debug!(session_path, status, "push accepted by provider");
                }
                // 410 Gone / 404 Not Found: the endpoint is dead. Prune it
                // (ureq surfaces both as StatusCode errors).
                Ok(Err(e)) => {
                    if !self.prune_if_dead(session_path, &endpoint, &e) {
                        crate::metrics::inc("push_failed");
                        warn!(session_path, error = %e, "push send failed");
                    }
                }
                Err(e) => {
                    crate::metrics::inc("push_failed");
                    warn!(session_path, error = %e, "push send failed");
                }
            }
        }
    }
    /// Return true and prune when a provider says an endpoint is gone. Kept
    /// separate from the HTTP loop so the exact 404/410 contract can be
    /// regression-tested without contacting FCM.
    fn prune_if_dead(&self, _session_path: &str, endpoint: &str, error: &ureq::Error) -> bool {
        if matches!(error, ureq::Error::StatusCode(404 | 410)) {
            info!(endpoint, "pruning dead push subscription");
            self.prune(endpoint);
            true
        } else {
            false
        }
    }

    fn prune(&self, endpoint: &str) {
        let mut store = match self.store.lock() {
            Ok(g) => g,
            Err(_) => {
                warn!("push store lock poisoned, cannot prune subscription");
                return;
            }
        };
        let changed = if let Some(subs) = store.get_mut(DEVICE_SCOPE) {
            let before = subs.len();
            subs.retain(|s| s.get("endpoint").and_then(|e| e.as_str()) != Some(endpoint));
            let after = subs.len();
            if subs.is_empty() {
                store.remove(DEVICE_SCOPE);
            }
            before != after
        } else {
            false
        };
        if changed && let Err(e) = self.persist(&store) {
            warn!(error = %e, "failed to persist push store after prune");
        }
    }
    /// Atomically write the versioned device store: serialize to a tmp file in
    /// the same directory, fsync, then rename over the real path. Callers hold
    /// the store lock, so a fixed tmp name cannot collide.
    fn persist(&self, store: &HashMap<String, Vec<Value>>) -> Result<(), String> {
        let tmp_path = tmp_path_for(&self.store_path);
        if let Some(parent) = self.store_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(&serialise_store(store))
            .map_err(|e| format!("cannot serialize push store: {e}"))?;
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("cannot create {}: {e}", tmp_path.display()))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", tmp_path.display()))?;
        f.sync_all()
            .map_err(|e| format!("cannot sync {}: {e}", tmp_path.display()))?;
        fs::rename(&tmp_path, &self.store_path).map_err(|e| {
            format!(
                "cannot rename {} -> {}: {e}",
                tmp_path.display(),
                self.store_path.display()
            )
        })?;
        Ok(())
    }

    /// The retained notifications newer than `after_id`, oldest first. Only
    /// what the bounded ring still holds: a phone that was away longer than
    /// [`NOTIFY_RING_CAPACITY`] notifications is told about the window it
    /// can have, never promised the ones it cannot.
    fn notify_history(&self, after_id: Option<u64>) -> Vec<NotifyEnvelope> {
        let log = match self.notify_log.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        log.retained_after(after_id)
    }

    /// Number a notification, retain it and hand it to the live fan-out —
    /// one indivisible step. Called from exactly ONE place
    /// (`notify_with_req_id`) so the debounce the callers apply covers both
    /// transports. Returns the id assigned.
    fn publish_notify(&self, payload: Value) -> u64 {
        // Bounded ring: keep only the last NOTIFY_RING_CAPACITY entries.
        // Each entry is <1 KB, so 20 entries is ~20 KB — trivial memory
        // cost for recovery after Doze.
        //
        // The broadcast happens under the same lock as the id assignment and
        // the retention, which is what makes replay and live agree: a
        // subscriber reads the ring either strictly before this block (and
        // receives the broadcast) or strictly after it (and already has the
        // entry). Send never blocks or errors visibly, so holding the lock
        // across it costs nothing.
        let mut log = match self.notify_log.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let id = log.next_id;
        log.next_id += 1;
        let envelope = NotifyEnvelope { id, payload };
        log.ring.push_back(envelope.clone());
        while log.ring.len() > NOTIFY_RING_CAPACITY {
            log.ring.pop_front();
        }
        let _ = self.notify_tx.send(envelope);
        id
    }

    /// Open a notification subscription that owns the replay/live boundary:
    /// `after_id` is the reconnecting client's `Last-Event-ID`.
    pub fn subscribe_notifications(&self, after_id: Option<u64>) -> NotifySubscription {
        // Subscribe BEFORE snapshotting the ring. A publication racing this
        // pair therefore reaches the client either way: one before the
        // snapshot is already retained, one after it is on the live receiver.
        // Reading first (the order this replaced) dropped exactly the
        // publications landing in the gap — a lost buzz, with no error
        // anywhere to show for it.
        let live = self.notify_tx.subscribe();
        #[cfg(test)]
        if let Some(rendezvous) = self.take_publish_race() {
            // Run a real publication through the seam this ordering protects:
            // both sides rendezvous, so the publish lands strictly between the
            // subscribe above and the snapshot below, every run.
            rendezvous.wait();
            rendezvous.wait();
        }
        NotifySubscription {
            log: Arc::clone(&self.notify_log),
            live,
            replay: self.notify_history(after_id).into(),
            delivered_through: None,
        }
    }

    #[cfg(test)]
    /// Test helper: inject a payload directly into the notify hub without
    /// touching Web Push state. Returns the monotonic id assigned.
    pub fn test_publish(&self, payload: Value) -> u64 {
        // The production publish path, so ids, retention and fan-out in a
        // test are the ones a phone actually sees.
        self.publish_notify(payload)
    }

    #[cfg(test)]
    /// Test helper: arm a two-party rendezvous. The next
    /// `subscribe_notifications` call releases a publisher thread between its
    /// live subscribe and its history snapshot — the exact seam that used to
    /// lose a notification — and waits for that publication to land.
    pub fn arm_publish_race(&self) -> Arc<std::sync::Barrier> {
        let rendezvous = Arc::new(std::sync::Barrier::new(2));
        *self
            .publish_race_hook
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Arc::clone(&rendezvous));
        rendezvous
    }

    #[cfg(test)]
    fn take_publish_race(&self) -> Option<Arc<std::sync::Barrier>> {
        self.publish_race_hook
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }

    #[cfg(test)]
    /// Test helper: construct a Push with a temp dir and no VAPID file I/O
    /// beyond the temp dir. Used by unit tests that need a live broadcast
    /// without touching the real store.
    pub fn for_test() -> Arc<Self> {
        let dir = std::env::temp_dir().join(format!("omp-pulse-test-{}", rand::random::<u64>()));
        let _ = fs::create_dir_all(&dir);
        let vapid_path = dir.join("vapid.json");
        let push_store_path = dir.join("push.json");
        // Generate a valid VAPID keypair so notify doesn't fail on VAPID parse,
        // but tests that hit the SSE path don't need Web Push anyway.
        let vapid_json = generate_vapid_file().expect("vapid gen");
        let _ = fs::write(&vapid_path, vapid_json);
        let vapid_raw = fs::read_to_string(&vapid_path).unwrap();
        let vapid_json: Value = serde_json::from_str(&vapid_raw).unwrap();
        let public_key = vapid_json["publicKey"].as_str().unwrap().to_string();
        let private_key = vapid_json["privateKey"].as_str().unwrap().to_string();
        let agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(20)))
            .build()
            .new_agent();
        let (notify_tx, _) = tokio::sync::broadcast::channel(NOTIFY_CHANNEL_CAPACITY);
        Arc::new(Self {
            vapid: VapidKeys {
                public_key,
                private_key,
            },
            store: Mutex::new(HashMap::new()),
            store_path: push_store_path,
            devices: Arc::new(
                DeviceRegistry::open(&dir.join("devices")).expect("test device registry"),
            ),
            owner_binding: Some("test-owner".to_string()),
            agent,
            notify_tx,
            notify_log: Arc::new(Mutex::new(NotifyLog {
                ring: VecDeque::with_capacity(NOTIFY_RING_CAPACITY),
                next_id: 1,
            })),
            #[cfg(test)]
            publish_race_hook: Mutex::new(None),
        })
    }
}

/// The retained notification window and its id counter, behind ONE lock.
///
/// Both halves belong together: a subscriber snapshots `ring` while a
/// publisher numbers an entry and sends it on the live fan-out, and the only
/// thing that makes replay and live agree is that those steps cannot
/// interleave. Ids ascend in ring order, so the ring doubles as the delivery
/// order and `retained_after` is a contiguous suffix.
struct NotifyLog {
    ring: VecDeque<NotifyEnvelope>,
    next_id: u64,
}

impl NotifyLog {
    /// Retained entries newer than `after_id`, oldest first.
    fn retained_after(&self, after_id: Option<u64>) -> Vec<NotifyEnvelope> {
        match after_id {
            // Stale epoch: the phone persisted an id from before a restart
            // whose seed landed below it (clock stepped back across the
            // restart — NTP correction, RTC drift on resume). Filtering
            // `id > last` would suppress the replay AND every new id below
            // the stale value, forever. A last-id above the ring's max means
            // the phone is from the future: replay everything, not nothing.
            Some(last) => match self.ring.iter().map(|e| e.id).max() {
                Some(max) if last > max => self.ring.iter().cloned().collect(),
                _ => self.ring.iter().filter(|e| e.id > last).cloned().collect(),
            },
            None => self.ring.iter().cloned().collect(),
        }
    }
}

/// One subscriber's view of the notify stream: the replay it has not
/// delivered yet, then the live broadcast behind it.
///
/// This is the whole replay/live boundary. Replay first, live second, and
/// every id handed out at most once — a publication racing the subscription
/// appears in both sources and is delivered from the earlier one, because
/// `delivered_through` is the deduplication key rather than a payload
/// comparison. A subscriber that fell behind the broadcast is not silently
/// truncated either: the ring still holds the missed window (bounded — see
/// [`NOTIFY_RING_CAPACITY`]) and it is replayed before the stream resumes.
pub struct NotifySubscription {
    log: Arc<Mutex<NotifyLog>>,
    live: tokio::sync::broadcast::Receiver<NotifyEnvelope>,
    /// Retained history this subscriber has not delivered yet, oldest first.
    replay: VecDeque<NotifyEnvelope>,
    /// Highest id delivered so far, across replay and live alike. `None`
    /// until the first one, so a subscriber that starts behind the ring is
    /// deduplicated the same way as one that catches up.
    delivered_through: Option<u64>,
}

impl NotifySubscription {
    /// The next notification for this subscriber, replay before live. `None`
    /// once the fan-out is gone (shutdown).
    pub async fn next(&mut self) -> Option<NotifyEnvelope> {
        loop {
            if let Some(envelope) = self.replay.pop_front() {
                self.deliver(envelope.id);
                return Some(envelope);
            }
            match self.live.recv().await {
                Ok(envelope) => {
                    // Already covered by the replay snapshot (or by an earlier
                    // lag replay): drop it rather than buzz twice.
                    if self.seen(&envelope) {
                        continue;
                    }
                    self.deliver(envelope.id);
                    return Some(envelope);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                    self.reconcile(missed);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    }

    /// Recover the window the broadcast dropped. Everything it hands back is
    /// newer than what this subscriber already delivered, so the client sees
    /// the missed buzzes instead of a silent hole.
    fn reconcile(&mut self, missed: u64) {
        let recovered = {
            let log = match self.log.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            log.retained_after(self.delivered_through)
        };
        if let (Some(first), Some(delivered)) = (recovered.first(), self.delivered_through)
            && first.id > delivered.saturating_add(1)
        {
            // Retention, not lag, ended the window: report it rather than
            // let a bounded ring masquerade as a complete history.
            warn!(
                missed,
                delivered,
                retained_from = first.id,
                "notification subscriber lagged past the retained window"
            );
        }
        self.replay = recovered.into();
    }

    fn seen(&self, envelope: &NotifyEnvelope) -> bool {
        self.delivered_through
            .is_some_and(|delivered| envelope.id <= delivered)
    }

    fn deliver(&mut self, id: u64) {
        self.delivered_through = Some(self.delivered_through.map_or(id, |d| d.max(id)));
    }
}

/// Wall-clock millis for SSE id seeding (see `notify_next_id`): 0 on clock
/// failure (falls back to the old from-1 behavior rather than refusing to
/// start the push subsystem over a clock quirk).
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
        .max(1)
}

/// `<store>.tmp` alongside the store, guaranteeing same-filesystem rename.
fn tmp_path_for(store_path: &Path) -> PathBuf {
    let mut os = store_path.as_os_str().to_os_string();
    os.push(".tmp");
    PathBuf::from(os)
}

#[cfg(test)]
mod tests;
