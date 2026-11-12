//! Adapter for the optional omp desktop-control extension.
//!
//! The extension runs inside the user's real omp process.  It publishes a
//! short-lived, pid-addressed descriptor in the daemon state directory and
//! accepts only authenticated, loopback requests.  This module deliberately
//! does not inspect or modify session files: ownership is established by the
//! existing process guard and all model/reasoning state comes back from omp's
//! extension API.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::types::Config;

/// The source is embedded in the daemon so setup/install is reproducible and
/// cannot accidentally pick up a different user's extension file.
pub const EXTENSION_SOURCE: &str = include_str!("../../extensions/omp-pulse-control.ts");
pub const QUEUE_HELPER_SOURCE: &str = include_str!("../../extensions/pulse-queue.ts");

/// Marker used to establish ownership before replacing an existing extension.
/// Keep this distinctive: an unrelated extension must never be clobbered.
pub const MANAGED_MARKER: &str = "omp-pulse managed extension";

const EXTENSION_FILE_NAME: &str = "omp-pulse-control.ts";
const DESCRIPTOR_DIR: &str = "desktop-controls";
const MAX_DESCRIPTOR_BYTES: u64 = 16 * 1024;
const MAX_RPC_REQUEST_BYTES: usize = 64 * 1024;
/// A phone prompt may carry up to eight 5 MiB base64 images; the extension
/// enforces the same ceiling on its side.
const MAX_PROMPT_REQUEST_BYTES: usize = 48 * 1024 * 1024;
const MAX_RPC_RESPONSE_BYTES: u64 = 512 * 1024;
/// Queue recovery can carry the same 64 MiB frame as native child RPC.
const MAX_QUEUE_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
const RPC_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const RPC_TIMEOUT: Duration = Duration::from_secs(6);
/// Compaction runs a summarization turn inside the host, so it takes orders
/// of magnitude longer than a settings write; the bridge timeout follows it.
const COMPACT_TIMEOUT: Duration = Duration::from_secs(300);
/// A prompt is an in-memory enqueue inside omp, but its body can be tens of
/// megabytes of images over loopback.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(30);

/// Descriptor published by the extension for one omp process.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Descriptor {
    pub version: u8,
    pub pid: i32,
    #[serde(rename = "sessionPath")]
    pub session_path: String,
    pub port: u16,
    pub token: String,
    /// Registry id of the desktop agent that published this descriptor
    /// (upstream `ExtensionContext.agent.id`, 18.3.2+); absent on older
    /// extensions. Diagnostic only: routing stays pid-keyed.
    #[serde(rename = "agentId", default)]
    pub agent_id: Option<String>,
    /// Absent on extensions older than the live bridge, which serve only the
    /// four settings methods: `events`/`prompt`/`abort` must be advertised.
    #[serde(default)]
    pub capabilities: Vec<String>,
}

impl Descriptor {
    pub fn has(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }

    /// Structural validity, independent of which pid asked: the checks every
    /// caller must make before trusting a port and token from disk.
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err(format!(
                "desktop control bridge descriptor version {} is unsupported; restart omp and reload the desktop-control extension",
                self.version
            ));
        }
        if self.pid <= 0 {
            return Err("desktop control bridge published an invalid pid; restart omp and reload the extension".to_string());
        }
        if self.port == 0 {
            return Err("desktop control bridge published an invalid port; restart omp and reload the extension".to_string());
        }
        if self.token.is_empty() || self.token.len() > 512 {
            return Err("desktop control bridge published an invalid token; restart omp and reload the extension".to_string());
        }
        Ok(())
    }
}

/// Every structurally valid descriptor in the state directory, with the path
/// it was read from. Liveness is the caller's concern: a crashed omp leaves
/// its descriptor behind, so a pid here may be dead or reused.
pub fn read_descriptors(state_dir: &Path) -> Vec<(PathBuf, Descriptor)> {
    let Ok(entries) = fs::read_dir(state_dir.join(DESCRIPTOR_DIR)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|path| {
            let bytes = read_file_bounded(&path, MAX_DESCRIPTOR_BYTES).ok()?;
            let descriptor: Descriptor = serde_json::from_slice(&bytes).ok()?;
            descriptor.validate().ok()?;
            Some((path, descriptor))
        })
        .collect()
}

/// The directory descriptors live in, for watchers.
pub fn descriptor_dir(state_dir: &Path) -> PathBuf {
    state_dir.join(DESCRIPTOR_DIR)
}

/// Install the embedded desktop-control extension into omp's configured agent
/// directory. Existing files are replaced only when they carry our marker;
/// an unmarked file is treated as user-owned and causes an explicit error.
///
/// This function writes only the extension source. It never creates, rotates,
/// or reads an omp credential and never touches a session file.
pub fn install_extension(cfg: &Config) -> Result<PathBuf, String> {
    let agent_dir = crate::paths::omp_agent_dir(&cfg.home)?;
    let extension_dir = agent_dir.join("extensions");
    fs::create_dir_all(&extension_dir).map_err(|e| {
        format!(
            "cannot create omp extension directory {}: {e}",
            extension_dir.display()
        )
    })?;
    let extension_path = extension_dir.join(EXTENSION_FILE_NAME);

    let state_literal = serde_json::to_string(&cfg.state_dir.to_string_lossy().into_owned())
        .map_err(|e| format!("cannot encode desktop-control state directory: {e}"))?;
    let helper_hash = {
        use sha2::{Digest, Sha256};
        use std::fmt::Write as _;
        let mut hex = String::with_capacity(64);
        for byte in Sha256::digest(QUEUE_HELPER_SOURCE.as_bytes()) {
            let _ = write!(hex, "{byte:02x}");
        }
        hex
    };
    // Outside extensions/: OMP must not auto-load this support module as an
    // extension entrypoint. Content-addressed files are never overwritten.
    let helper_dir = agent_dir.join("pulse-support").join(&helper_hash);
    let helper_path = helper_dir.join("pulse-queue.ts");
    let source = replace_state_dir_placeholder(state_literal.as_str())?.replace(
        "\"./pulse-queue.ts\"",
        &format!("\"../pulse-support/{helper_hash}/pulse-queue.ts\""),
    );
    let source_bytes = source.as_bytes();
    let mut unchanged = false;

    if extension_path.exists() {
        let existing = read_file_bounded(&extension_path, MAX_RPC_RESPONSE_BYTES).map_err(|e| {
            format!(
                "cannot inspect existing omp extension {}: {e}",
                extension_path.display()
            )
        })?;
        unchanged = existing == source_bytes;
        if !unchanged && !has_managed_marker(&existing) {
            return Err(format!(
                "refusing to replace unrelated omp extension {}; remove it manually or choose the configured agent directory",
                extension_path.display()
            ));
        }
    }

    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory
        .create(&helper_dir)
        .map_err(|e| format!("cannot create extension support directory: {e}"))?;
    if helper_path.exists() {
        let existing = read_file_bounded(&helper_path, MAX_RPC_RESPONSE_BYTES)
            .map_err(|e| format!("cannot inspect queue helper {}: {e}", helper_path.display()))?;
        if existing != QUEUE_HELPER_SOURCE.as_bytes() {
            return Err(format!(
                "refusing to replace unrelated queue helper {}",
                helper_path.display()
            ));
        }
    } else {
        write_managed_atomic(&helper_path, QUEUE_HELPER_SOURCE.as_bytes())
            .map_err(|e| format!("cannot install queue helper {}: {e}", helper_path.display()))?;
    }
    if unchanged {
        return Ok(extension_path);
    }

    write_managed_atomic(&extension_path, source_bytes).map_err(|e| {
        format!(
            "cannot install omp desktop-control extension {}: {e}",
            extension_path.display()
        )
    })?;
    Ok(extension_path)
}

/// Call the extension for a session whose authoritative foreign owner is
/// `owner_pid`. `None` is intentionally not returned here: the HTTP layer
/// performs ownership detection first, then calls this function so a missing
/// bridge is an actionable error rather than an implicit collab/child fallback.
pub async fn rpc_for_owner(
    cfg: &Config,
    session_path: &str,
    owner_pid: i32,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let state_dir = cfg.state_dir.clone();
    let session_path = session_path.to_owned();
    let method = method.to_owned();
    tokio::task::spawn_blocking(move || {
        call_descriptor(&state_dir, &session_path, owner_pid, &method, params)
    })
    .await
    .map_err(|e| format!("desktop control request task failed: {e}"))?
}

fn replace_state_dir_placeholder(state_literal: &str) -> Result<String, String> {
    const PLACEHOLDER: &str = "__OMP_PULSE_STATE_DIR_JSON__";
    let count = EXTENSION_SOURCE.matches(PLACEHOLDER).count();
    if count != 1 {
        return Err(format!(
            "embedded desktop-control extension has {count} state directory placeholders; expected exactly one"
        ));
    }
    Ok(EXTENSION_SOURCE.replace(PLACEHOLDER, state_literal))
}

fn has_managed_marker(bytes: &[u8]) -> bool {
    bytes.split(|byte| *byte == b'\n').take(4).any(|line| {
        let Ok(line) = std::str::from_utf8(line) else {
            return false;
        };
        let Some(comment) = line.trim_start().strip_prefix("//") else {
            return false;
        };
        comment.trim_start().starts_with(MANAGED_MARKER)
    })
}

pub(crate) fn write_managed_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "extension path has no parent")
    })?;
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = PathBuf::from(tmp);

    let result = (|| {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
        set_private_file_mode(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn call_descriptor(
    state_dir: &Path,
    session_path: &str,
    owner_pid: i32,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    if owner_pid <= 0 {
        return Err(
            "desktop control bridge owner pid is invalid; restart omp and reload the extension"
                .to_string(),
        );
    }
    if !matches!(
        method,
        "get_state"
            | "get_prompt_config"
            | "get_model_mention_choices"
            | "set_model"
            | "set_thinking_level"
            | "set_session_name"
            | "compact"
            | "prompt"
            | "abort"
            | "abort_and_restore_queue"
            | "remove_queued_message"
            | "close_if_idle"
    ) {
        return Err(format!("desktop control method {method:?} is not allowed"));
    }
    if !params.is_object() {
        return Err("desktop control params must be a JSON object".to_string());
    }

    let descriptor_path = state_dir
        .join(DESCRIPTOR_DIR)
        .join(format!("{owner_pid}.json"));
    let descriptor_bytes = read_file_bounded(&descriptor_path, MAX_DESCRIPTOR_BYTES).map_err(|e| {
        format!(
            "desktop control bridge is unavailable for this session (descriptor {}: {e}); restart omp and reload the desktop-control extension",
            descriptor_path.display()
        )
    })?;
    let descriptor: Descriptor = serde_json::from_slice(&descriptor_bytes).map_err(|e| {
        format!(
            "desktop control bridge descriptor {} is invalid: {e}; restart omp and reload the desktop-control extension",
            descriptor_path.display()
        )
    })?;
    descriptor.validate()?;
    if descriptor.pid != owner_pid {
        return Err("desktop control bridge descriptor owner pid changed; restart omp and reload the extension".to_string());
    }
    if descriptor.session_path != session_path {
        return Err("desktop control bridge is attached to a different session; switch back to the active omp session or reload the extension".to_string());
    }
    if method == "close_if_idle" && !descriptor.has(method) {
        return Err("the desktop's omp-pulse extension lacks idle-only close; after confirming no work is running, restart omp with the updated extension".to_string());
    }
    if matches!(method, "prompt" | "abort") && !descriptor.has(method) {
        return Err("the desktop's omp-pulse extension predates live control; run `omp-pulse desktop-control install`, then restart that omp".to_string());
    }
    if matches!(method, "abort_and_restore_queue" | "remove_queued_message")
        && !descriptor.has(method)
    {
        return Err("the desktop's omp-pulse extension cannot recover queued photos; run `omp-pulse desktop-control install`, then restart that omp".to_string());
    }
    if method == "set_session_name" && !descriptor.has("rename") {
        return Err("the desktop's omp-pulse extension predates rename; run `omp-pulse desktop-control install`, then restart that omp".to_string());
    }

    let request = json!({
        "sessionPath": session_path,
        "method": method,
        "params": params,
    });
    let request_bytes = serde_json::to_vec(&request)
        .map_err(|e| format!("cannot serialize desktop control request: {e}"))?;
    let limit = if method == "prompt" {
        MAX_PROMPT_REQUEST_BYTES
    } else {
        MAX_RPC_REQUEST_BYTES
    };
    if request_bytes.len() > limit {
        return Err("desktop control request is too large".to_string());
    }

    // Compaction is an LLM summarization turn, not a settings write: give the
    // host up to COMPACT_TIMEOUT instead of the settings RPC_TIMEOUT.
    let timeout = match method {
        "compact" => COMPACT_TIMEOUT,
        "prompt" => PROMPT_TIMEOUT,
        "abort_and_restore_queue" => PROMPT_TIMEOUT,
        _ => RPC_TIMEOUT,
    };

    let agent = ureq::Agent::config_builder()
        .timeout_connect(Some(RPC_CONNECT_TIMEOUT))
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(0)
        .proxy(None)
        .build()
        .new_agent();
    let url = format!("http://127.0.0.1:{}/control", descriptor.port);
    let mut response = agent
        .post(url)
        .header("Authorization", format!("Bearer {}", descriptor.token))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .send(request_bytes.as_slice())
        .map_err(|e| {
            format!(
                "desktop control bridge request failed: {e}; restart omp and reload the desktop-control extension"
            )
        })?;
    let response_limit = if matches!(method, "abort_and_restore_queue" | "remove_queued_message") {
        MAX_QUEUE_RESPONSE_BYTES
    } else {
        MAX_RPC_RESPONSE_BYTES
    };
    if let Some(length) = response.body().content_length()
        && length > response_limit
    {
        return Err("desktop control bridge response is too large".to_string());
    }
    let text = response
        .body_mut()
        .with_config()
        .limit(response_limit)
        .read_to_string()
        .map_err(|e| format!("cannot read desktop control bridge response: {e}"))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("desktop control bridge returned invalid JSON: {e}"))?;
    if !value.is_object() || value.get("ok").and_then(Value::as_bool).is_none() {
        return Err("desktop control bridge returned an invalid response envelope; restart omp and reload the extension".to_string());
    }
    Ok(value)
}

pub(crate) fn read_file_bounded(path: &Path, max_bytes: u64) -> io::Result<Vec<u8>> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("file is larger than {max_bytes} bytes"),
        ));
    }
    let file = File::open(path)?;
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("file grew beyond {max_bytes} bytes while reading"),
        ));
    }
    Ok(bytes)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(unix)]
fn set_private_file_mode(file: &File) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_mode(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_passes_the_method_allowlist() {
        // A bogus method is rejected before any filesystem access; compact
        // must pass the allowlist and fail later on the missing descriptor.
        let dir = std::env::temp_dir();
        let err =
            call_descriptor(&dir, "/sessions/a.jsonl", 424242, "bogus", json!({})).unwrap_err();
        assert!(err.contains("is not allowed"), "unexpected: {err}");
        let err =
            call_descriptor(&dir, "/sessions/a.jsonl", 424242, "compact", json!({})).unwrap_err();
        assert!(!err.contains("is not allowed"), "compact rejected: {err}");
        assert!(err.contains("unavailable"), "unexpected: {err}");
    }

    fn queue_descriptor(method: &str, port: u16, capabilities: &[&str]) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pulse-queue-{method}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(root.join(DESCRIPTOR_DIR)).unwrap();
        fs::write(
            root.join(DESCRIPTOR_DIR).join("424242.json"),
            serde_json::to_vec(&json!({
                "version": 1, "pid": 424242, "sessionPath": "/sessions/a.jsonl",
                "port": port, "token": "queue-fixture-secret", "capabilities": capabilities,
            }))
            .unwrap(),
        )
        .unwrap();
        root
    }

    #[test]
    fn old_desktop_queue_capabilities_refuse_before_dispatch() {
        for method in ["abort_and_restore_queue", "remove_queued_message"] {
            // No listener: this must fail on capability admission, not connect
            // to an old extension that might only stop without restoring.
            let root = queue_descriptor(method, 1, &["control", "abort"]);
            let error =
                call_descriptor(&root, "/sessions/a.jsonl", 424242, method, json!({})).unwrap_err();
            fs::remove_dir_all(root).unwrap();
            assert!(error.contains("cannot recover queued photos"), "{error}");
        }
    }

    #[test]
    fn authenticated_desktop_queue_replies_preserve_photos_larger_than_settings_limit() {
        // Other tests spawn/exit child processes concurrently. Under proot,
        // their SIGCHLD can interrupt ureq's socket IO instead of restarting
        // the syscall. Execute this destructive request fixture once in its
        // own test process; never retry a queue-recovery HTTP request.
        const ISOLATED: &str = "OMP_PULSE_QUEUE_TRANSPORT_TEST_PROCESS";
        const COMPLETED: &str = "queue transport fixture completed";
        if std::env::var_os(ISOLATED).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "omp::desktop_control::tests::authenticated_desktop_queue_replies_preserve_photos_larger_than_settings_limit",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(ISOLATED, "1")
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                output.status.success(),
                "isolated queue transport failed:\n{stdout}\n{stderr}"
            );
            assert!(
                stdout.contains(COMPLETED),
                "isolated queue transport fixture did not execute:\n{stdout}\n{stderr}"
            );
            return;
        }
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        for method in ["abort_and_restore_queue", "remove_queued_message"] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let root = queue_descriptor(method, listener.local_addr().unwrap().port(), &[method]);
            let image = json!({ "type": "image", "data": "original".repeat(80_000), "mimeType": "image/png" });
            let data = if method == "remove_queued_message" {
                json!({ "removed": true, "images": [image] })
            } else {
                json!({ "steering": [{ "text": "", "images": [image] }], "followUp": [] })
            };
            let expected = json!({ "ok": true, "data": data });
            let response = serde_json::to_vec(&expected).unwrap();
            let server = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream);
                let mut request = Vec::new();
                loop {
                    let before = request.len();
                    let remaining = (MAX_RPC_REQUEST_BYTES + 1 - before) as u64;
                    let read = reader
                        .by_ref()
                        .take(remaining)
                        .read_until(b'\n', &mut request)
                        .unwrap();
                    assert_ne!(read, 0, "request ended before its headers");
                    assert!(request.len() <= MAX_RPC_REQUEST_BYTES);
                    if &request[before..] == b"\r\n" {
                        break;
                    }
                }
                let headers = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(headers.starts_with("post /control "));
                assert!(headers.contains("authorization: bearer queue-fixture-secret\r\n"));
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length: ")
                            .map(|value| value.parse().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let request: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(request["method"], method);
                assert_eq!(request["sessionPath"], "/sessions/a.jsonl");
                let stream = reader.get_mut();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
                stream.write_all(&response).unwrap();
            });
            let actual =
                call_descriptor(&root, "/sessions/a.jsonl", 424242, method, json!({})).unwrap();
            server.join().unwrap();
            fs::remove_dir_all(root).unwrap();
            assert_eq!(actual, expected);
        }
        println!("{COMPLETED}");
    }
}
