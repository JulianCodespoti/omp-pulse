//! Independent device credentials and one-time enrollment codes.
//!
//! The owner token remains a desktop-only administration credential. Phones
//! receive only credentials minted by redeeming a short-lived, single-use
//! enrollment code. Only SHA-256 digests are persisted; the clear token and
//! enrollment code exist in memory long enough to return them to the caller.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use rand::{RngExt, rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const FORMAT_VERSION: u32 = 1;
const REGISTRY_FILE: &str = "devices.json";
/// Enrollment codes are intentionally short-lived. This is also the upper
/// bound a caller can rely on when displaying the expiry to an operator.
pub const PAIRING_CODE_TTL_MS: u64 = 5 * 60 * 1000;
const MAX_NAME_LEN: usize = 120;

/// Authorization role attached to an independently revocable device.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceRole {
    Admin,
    Control,
    Read,
}

impl DeviceRole {
    pub fn can_read(self) -> bool {
        true
    }

    pub fn can_stream(self) -> bool {
        true
    }

    pub fn can_control(self) -> bool {
        matches!(self, Self::Admin | Self::Control)
    }

    pub fn is_admin(self) -> bool {
        matches!(self, Self::Admin)
    }

    pub fn capabilities(self) -> DeviceCapabilities {
        DeviceCapabilities {
            read: self.can_read(),
            stream: self.can_stream(),
            control: self.can_control(),
        }
    }
}

impl std::str::FromStr for DeviceRole {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "admin" => Ok(Self::Admin),
            "control" => Ok(Self::Control),
            "read" => Ok(Self::Read),
            _ => Err("role must be admin, control, or read".to_string()),
        }
    }
}

impl std::fmt::Display for DeviceRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Admin => "admin",
            Self::Control => "control",
            Self::Read => "read",
        };
        f.write_str(value)
    }
}

/// Capabilities are explicit on the wire so clients do not infer control
/// access from the role string.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct DeviceCapabilities {
    pub read: bool,
    pub stream: bool,
    pub control: bool,
}

/// Redacted device representation used by API responses and diagnostics.
/// There is deliberately no token, token hash, or pairing material here.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub role: DeviceRole,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "revokedAt", skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<u64>,
    #[serde(rename = "lastSeenAt", skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<u64>,
    pub capabilities: DeviceCapabilities,
}

impl DeviceView {
    fn from_stored(device: &StoredDevice) -> Self {
        Self {
            id: device.id.clone(),
            name: device.name.clone(),
            role: device.role,
            created_at: device.created_at,
            revoked_at: device.revoked_at,
            last_seen_at: device.last_seen_at,
            capabilities: device.role.capabilities(),
        }
    }
}

/// An enrollment code returned to the owner. Only the clear code is returned
/// here; persistence keeps its digest so a state-file disclosure cannot pair a
/// new device.
#[derive(Debug, Clone, Serialize)]
pub struct PairingCode {
    pub code: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
    pub role: DeviceRole,
}

/// Result of redeeming a code. The token is returned exactly once to the
/// unauthenticated pairing route and is never included in a [`DeviceView`].
#[derive(Debug, Clone, Serialize)]
pub struct PairingResult {
    pub token: String,
    pub device: DeviceView,
}

/// Identity attached to an authenticated request. The owner token is handled
/// separately by the HTTP layer and is represented there as `None` for the
/// device id; this type is for phone credentials only.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AuthenticatedDevice {
    pub id: String,
    pub role: DeviceRole,
}

impl AuthenticatedDevice {
    pub fn can_read(&self) -> bool {
        self.role.can_read()
    }

    pub fn can_stream(&self) -> bool {
        self.role.can_stream()
    }

    pub fn can_control(&self) -> bool {
        self.role.can_control()
    }

    pub fn is_admin(&self) -> bool {
        self.role.is_admin()
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredDevice {
    id: String,
    name: String,
    role: DeviceRole,
    #[serde(rename = "tokenHash")]
    token_hash: String,
    #[serde(rename = "createdAt")]
    created_at: u64,
    #[serde(rename = "revokedAt", default)]
    revoked_at: Option<u64>,
    #[serde(rename = "lastSeenAt", default)]
    last_seen_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredPairingCode {
    #[serde(rename = "codeHash")]
    code_hash: String,
    role: DeviceRole,
    name: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedRegistry {
    version: u32,
    revision: u64,
    devices: Vec<StoredDevice>,
    #[serde(rename = "pairingCodes")]
    pairing_codes: Vec<StoredPairingCode>,
}

#[derive(Serialize)]
struct RegistrySnapshot<'a> {
    version: u32,
    revision: u64,
    devices: &'a [StoredDevice],
    #[serde(rename = "pairingCodes")]
    pairing_codes: &'a [StoredPairingCode],
}

struct RegistryData {
    revision: u64,
    devices: Vec<StoredDevice>,
    pairing_codes: Vec<StoredPairingCode>,
}

/// Durable registry of hashed device credentials and pending enrollment codes.
/// The mutex is process-local; every mutation is persisted before it is
/// reported as successful.
pub struct DeviceRegistry {
    path: PathBuf,
    inner: Arc<Mutex<RegistryData>>,
}

impl DeviceRegistry {
    /// Open the registry in `state_dir`. Missing state starts empty. Any
    /// existing malformed or unsupported file is an error: silently replacing
    /// it would turn a persistence failure into an authentication bypass.
    pub fn open(state_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(state_dir).map_err(|e| {
            format!(
                "cannot create device state directory {}: {e}",
                state_dir.display()
            )
        })?;
        let path = state_dir.join(REGISTRY_FILE);
        let data = match fs::read_to_string(&path) {
            Ok(raw) => parse_registry(&raw)
                .map_err(|e| format!("cannot read device registry {}: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => RegistryData {
                revision: 0,
                devices: Vec::new(),
                pairing_codes: Vec::new(),
            },
            Err(e) => {
                return Err(format!(
                    "cannot read device registry {}: {e}",
                    path.display()
                ));
            }
        };
        Ok(Self {
            path,
            inner: Arc::new(Mutex::new(data)),
        })
    }

    /// Issue a five-minute, single-use code. The caller must enforce that the
    /// request was authorized by the desktop owner or an admin device.
    pub fn issue_pairing_code(
        &self,
        role: DeviceRole,
        name: Option<&str>,
    ) -> Result<PairingCode, String> {
        let mut guard = self.lock();
        let now = now_ms();
        guard.pairing_codes.retain(|code| code.expires_at > now);
        let code = random_hex(32);
        let expires_at = now.saturating_add(PAIRING_CODE_TTL_MS);
        let entry = StoredPairingCode {
            code_hash: hash_hex(&code),
            role,
            name: clean_name(name),
            expires_at,
        };
        guard.pairing_codes.push(entry);
        if let Err(error) = self.commit(&guard) {
            guard.pairing_codes.pop();
            return Err(error);
        }
        Ok(PairingCode {
            code,
            expires_at,
            role,
        })
    }

    /// Redeem an enrollment code once, minting one independently revocable
    /// credential. Expired and unknown codes have the same error deliberately.
    pub fn redeem_pairing_code(
        &self,
        code: &str,
        name: Option<&str>,
    ) -> Result<PairingResult, String> {
        let mut guard = self.lock();
        let now = now_ms();
        let digest = hash_hex(code);
        let Some(index) = guard
            .pairing_codes
            .iter()
            .position(|entry| entry.expires_at > now && constant_hex_eq(&entry.code_hash, &digest))
        else {
            // Expired entries are safe to remove, but do not distinguish expiry
            // from a typo to an unauthenticated caller.
            let before = guard.pairing_codes.len();
            guard.pairing_codes.retain(|entry| entry.expires_at > now);
            if guard.pairing_codes.len() != before {
                self.commit(&guard)?;
            }
            return Err("invalid pairing code".to_string());
        };

        let pending = guard.pairing_codes.remove(index);
        let token = random_hex(32);
        let device = StoredDevice {
            id: format!("device-{}", random_hex(12)),
            name: match name.map(str::trim).filter(|s| !s.is_empty()) {
                Some(name) => clean_name(Some(name)),
                None => pending.name.clone(),
            },
            role: pending.role,
            token_hash: hash_hex(&token),
            created_at: now,
            revoked_at: None,
            last_seen_at: None,
        };
        let view = DeviceView::from_stored(&device);
        guard.devices.push(device);
        if let Err(e) = self.commit(&guard) {
            // Do not consume the code when persistence failed. A caller can
            // retry after repairing the state directory without minting a
            // credential the registry cannot later revoke.
            guard.devices.pop();
            guard.pairing_codes.push(pending);
            return Err(e);
        }
        Ok(PairingResult {
            token,
            device: view,
        })
    }

    /// Authenticate a bearer token against persisted hashes. Revoked entries
    /// are never returned, even if their token hash remains on disk for audit.
    pub fn authenticate(&self, token: &str) -> Option<AuthenticatedDevice> {
        let digest = hash_hex(token);
        let guard = self.lock();
        guard.devices.iter().find_map(|device| {
            if device.revoked_at.is_none() && constant_hex_eq(&device.token_hash, &digest) {
                Some(AuthenticatedDevice {
                    id: device.id.clone(),
                    role: device.role,
                })
            } else {
                None
            }
        })
    }

    /// Return whether an identity is revoked or absent. Unknown identities
    /// fail closed so open transports cannot remain alive after persistence
    /// corruption or an out-of-band registry replacement.
    pub fn is_revoked(&self, device_id: &str) -> bool {
        let guard = self.lock();
        guard
            .devices
            .iter()
            .find(|device| device.id == device_id)
            .map(|device| device.revoked_at.is_some())
            .unwrap_or(true)
    }

    /// Update last-seen evidence without exposing a credential. This is a
    /// best-effort observation and intentionally does not make authentication
    /// depend on a write to the state filesystem. Persist at most once per
    /// minute so polling clients do not turn every request into a rewrite.
    pub fn observe(&self, device_id: &str) {
        let mut guard = self.lock();
        let now = now_ms();
        let Some(device) = guard
            .devices
            .iter_mut()
            .find(|device| device.id == device_id && device.revoked_at.is_none())
        else {
            return;
        };
        if device
            .last_seen_at
            .is_some_and(|last_seen| now.saturating_sub(last_seen) < 60_000)
        {
            return;
        }
        device.last_seen_at = Some(now);
        if let Err(error) = self.commit(&guard) {
            tracing::warn!(device_id = %device_id, error = %error, "could not persist device observation");
        }
    }

    /// Revoke one device. Existing tokens stop authenticating immediately;
    /// transports poll the revision/identity and close within their interval.
    pub fn revoke(&self, device_id: &str) -> Result<bool, String> {
        let mut guard = self.lock();
        let Some(device) = guard.devices.iter_mut().find(|d| d.id == device_id) else {
            return Ok(false);
        };
        if device.revoked_at.is_none() {
            device.revoked_at = Some(now_ms());
            guard.revision = guard.revision.saturating_add(1);
        }
        // A failed write still blocks this device in memory. Retrying must
        // persist that revocation, not report "not found" and leave the old
        // credential able to authenticate after a restart.
        self.commit(&guard)?;
        Ok(true)
    }

    pub fn device(&self, device_id: &str) -> Option<DeviceView> {
        let guard = self.lock();
        guard
            .devices
            .iter()
            .find(|device| device.id == device_id)
            .map(DeviceView::from_stored)
    }

    /// Return all devices, including revoked entries, without token material.
    pub fn list(&self) -> Vec<DeviceView> {
        let guard = self.lock();
        guard.devices.iter().map(DeviceView::from_stored).collect()
    }

    /// Monotonic value for open transports to notice revocation without
    /// holding the registry lock for the lifetime of a stream.
    pub fn revision(&self) -> u64 {
        self.lock().revision
    }

    pub fn active_count(&self) -> usize {
        self.lock()
            .devices
            .iter()
            .filter(|device| device.revoked_at.is_none())
            .count()
    }

    pub fn revoked_count(&self) -> usize {
        self.lock()
            .devices
            .iter()
            .filter(|device| device.revoked_at.is_some())
            .count()
    }

    fn lock(&self) -> MutexGuard<'_, RegistryData> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn commit(&self, guard: &RegistryData) -> Result<(), String> {
        let persisted = RegistrySnapshot {
            version: FORMAT_VERSION,
            revision: guard.revision,
            devices: &guard.devices,
            pairing_codes: &guard.pairing_codes,
        };
        let body = serde_json::to_vec_pretty(&persisted)
            .map_err(|e| format!("cannot encode device registry: {e}"))?;
        atomic_write(&self.path, &body)
    }
}

fn parse_registry(raw: &str) -> Result<RegistryData, String> {
    let persisted: PersistedRegistry =
        serde_json::from_str(raw).map_err(|e| format!("invalid JSON: {e}"))?;
    if persisted.version != FORMAT_VERSION {
        return Err(format!("unsupported version {}", persisted.version));
    }
    for device in &persisted.devices {
        if !valid_hash(&device.token_hash) || device.id.trim().is_empty() {
            return Err("credential entry is malformed".to_string());
        }
    }
    for code in &persisted.pairing_codes {
        if !valid_hash(&code.code_hash) || code.expires_at == 0 {
            return Err("pairing-code entry is malformed".to_string());
        }
    }
    Ok(RegistryData {
        revision: persisted.revision,
        devices: persisted.devices,
        pairing_codes: persisted.pairing_codes,
    })
}

fn atomic_write(path: &Path, body: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("device registry has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let tmp = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
    file.write_all(body)
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("cannot persist {}: {e}", tmp.display()))?;
    drop(file);
    // std::fs::rename replaces files on Windows too. Never remove the old
    // registry first: a failed replacement must not erase revocation state.
    fs::rename(&tmp, path).map_err(|e| format!("cannot commit {}: {e}", path.display()))?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| format!("cannot sync {}: {e}", parent.display()))?;
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn random_hex(bytes: usize) -> String {
    let mut data = vec![0u8; bytes];
    rng().fill(&mut data[..]);
    let mut out = String::with_capacity(bytes * 2);
    for byte in data {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn hash_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn constant_hex_eq(left: &str, right: &str) -> bool {
    if !valid_hash(left) || !valid_hash(right) {
        return false;
    }
    bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

fn clean_name(name: Option<&str>) -> String {
    let name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Phone");
    name.chars().take(MAX_NAME_LEN).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(label: &str) -> (tempfile_like::TempDir, Arc<DeviceRegistry>) {
        let dir = tempfile_like::TempDir::new(label);
        let registry = Arc::new(DeviceRegistry::open(dir.path()).unwrap());
        (dir, registry)
    }

    // Tiny local temp helper keeps these tests dependency-free and isolated.
    mod tempfile_like {
        use std::{
            path::{Path, PathBuf},
            time::{SystemTime, UNIX_EPOCH},
        };
        pub struct TempDir(PathBuf);
        impl TempDir {
            pub fn new(label: &str) -> Self {
                let nonce = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let path = std::env::temp_dir().join(format!("omp-pulse-device-{label}-{nonce}"));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn pairing_code_is_single_use_and_token_is_independently_revocable() {
        let (_dir, registry) = registry("single-use");
        let issued = registry
            .issue_pairing_code(DeviceRole::Read, Some("travel phone"))
            .unwrap();
        let paired = registry.redeem_pairing_code(&issued.code, None).unwrap();
        assert_eq!(paired.device.role, DeviceRole::Read);
        assert!(registry.redeem_pairing_code(&issued.code, None).is_err());
        assert!(registry.authenticate(&paired.token).is_some());
        assert!(!registry.is_revoked(&paired.device.id));
        assert!(registry.revoke(&paired.device.id).unwrap());
        assert!(registry.is_revoked(&paired.device.id));
        assert!(registry.is_revoked("missing-device"));
        assert!(registry.authenticate(&paired.token).is_none());
    }

    #[test]
    fn failed_registry_writes_preserve_enrollment_and_allow_revocation_retry() {
        let (dir, registry) = registry("write-failure");
        let issued = registry
            .issue_pairing_code(DeviceRole::Control, None)
            .unwrap();
        let temporary = dir.path().join(REGISTRY_FILE).with_extension("json.tmp");
        fs::create_dir(&temporary).unwrap();
        assert!(registry.redeem_pairing_code(&issued.code, None).is_err());
        assert_eq!(registry.active_count(), 0);
        fs::remove_dir(&temporary).unwrap();
        let paired = registry.redeem_pairing_code(&issued.code, None).unwrap();
        fs::create_dir(&temporary).unwrap();
        assert!(registry.revoke(&paired.device.id).is_err());
        assert!(registry.authenticate(&paired.token).is_none());
        fs::remove_dir(&temporary).unwrap();
        assert!(registry.revoke(&paired.device.id).unwrap());
        let reopened = DeviceRegistry::open(dir.path()).unwrap();
        assert!(reopened.authenticate(&paired.token).is_none());
        assert!(reopened.redeem_pairing_code(&issued.code, None).is_err());
    }
    #[test]
    fn corrupt_registry_fails_closed() {
        let dir = tempfile_like::TempDir::new("corrupt");
        std::fs::write(dir.path().join(REGISTRY_FILE), b"not-json").unwrap();
        let result = DeviceRegistry::open(dir.path());
        assert!(result.is_err());
        assert!(result.err().unwrap().contains("invalid JSON"));
    }

    #[test]
    fn read_role_has_no_control_capability() {
        assert!(DeviceRole::Read.can_read());
        assert!(DeviceRole::Read.can_stream());
        assert!(!DeviceRole::Read.can_control());
        assert!(DeviceRole::Control.can_control());
    }
}
