//! The herdr backend: adoption through herdr's own agent commands instead of
//! the terminal window.
//!
//! `herdr` is a terminal workspace manager for AI coding agents: it multiplexes
//! several omp sessions as "agents" inside ONE terminal window. That breaks the
//! kitty path in two ways — `get-text` only returns the visible space, and
//! typing into the window lands in whichever space has focus, which could be a
//! different conversation. herdr addresses each agent directly, so when it is
//! present it is both safer and strictly more capable:
//!
//!   herdr agent list                      -> panes, cwd, titles
//!   herdr agent read <pane> --source …    -> THAT agent's output, visible or not
//!   herdr agent prompt <pane> <text>      -> submit into THAT agent
//!
//! Crucially this closes the blind spot that made adoption fail in practice: a
//! TUI that has a session open but has NEVER WRITTEN to it holds no file handle
//! and names no session in argv, so ownership detection cannot see it. Its
//! terminal content still shows the conversation, so we match on that instead.

use super::*;
use std::collections::HashSet;
use std::time::Duration;

/// Extract the herdr pane id from one NUL-separated process environment.
fn herdr_pane_from_env(block: &[u8]) -> Option<String> {
    block.split(|b| *b == 0).find_map(|entry| {
        let text = std::str::from_utf8(entry).ok()?;
        let value = text.strip_prefix("HERDR_PANE_ID=")?;
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Read the herdr pane belonging to the process that owns a session file.
///
/// Herdr exports this id into every omp process it launches. As with
/// `window_of`, `/proc` is authoritative on Linux and unavailable elsewhere.
pub(crate) fn herdr_pane_of(
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))] pid: i32,
) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
        herdr_pane_from_env(&raw)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// herdr backend: every omp agent is a pane, addressed directly (visible or
/// not), so identity is provable even for a TUI that never wrote to the
/// session file.
pub(super) struct HerdrHost {
    bin: std::path::PathBuf,
    owner_pid: Option<i32>,
}

impl HerdrHost {
    pub(super) async fn panes(&self) -> Vec<PaneRef> {
        if let Some(pane) = self.owner_pid.and_then(herdr_pane_of) {
            // The guard's owner pid is authoritative for this session; unlike
            // herdr's machine-wide agent list, this cannot cross-wire another
            // omp conversation.
            return vec![PaneRef {
                id: pane,
                cwd: String::new(),
                owner_resolved: true,
            }];
        }
        herdr_agents(&self.bin).await
    }

    pub(super) async fn read(&self, pane: &str) -> Result<String, String> {
        herdr_read(&self.bin, pane).await
    }

    pub(super) async fn submit(&self, pane: &str, text: &str) -> Result<(), String> {
        herdr(&self.bin, &["agent", "prompt", pane, text])
            .await
            .map(|_| ())
    }
}

/// The `herdr` executable to talk to the running herdr server with.
///
/// Several installs coexist in practice: the distro package in /usr/bin and
/// a `herdr update`-managed one in ~/.local/bin. The daemon runs under
/// systemd with a PATH that has no ~/.local/bin, so "first on PATH" picked
/// /usr/bin/herdr 0.8.2 after the user upgraded to 0.9.1, and every call
/// failed with `protocol_mismatch` against the newer server: the oracle went
/// blind, laptop questions stopped showing as waiting and could not be
/// answered from the phone. The server is always started from the newest
/// client the user runs, so the newest install is the one that speaks its
/// protocol. Versions are probed once per (path, mtime).
pub(crate) fn herdr_bin() -> Option<std::path::PathBuf> {
    use std::sync::{LazyLock, Mutex};
    type Key = Vec<(std::path::PathBuf, Option<std::time::SystemTime>)>;
    static CHOICE: LazyLock<Mutex<Option<(Key, std::path::PathBuf)>>> =
        LazyLock::new(|| Mutex::new(None));

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        let home = std::path::PathBuf::from(home);
        candidates.push(home.join(".local/bin/herdr"));
        candidates.push(home.join(".cargo/bin/herdr"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|d| d.join("herdr")));
    }
    let mut seen = HashSet::new();
    candidates.retain(|p| {
        p.is_file() && seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone()))
    });
    match candidates.len() {
        0 => return None,
        1 => return candidates.pop(),
        _ => {}
    }
    let key: Key = candidates
        .iter()
        .map(|p| {
            (
                p.clone(),
                std::fs::metadata(p).and_then(|m| m.modified()).ok(),
            )
        })
        .collect();
    let mut choice = CHOICE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((k, bin)) = choice.as_ref()
        && *k == key
    {
        return Some(bin.clone());
    }
    let best = candidates
        .iter()
        .max_by_key(|p| herdr_version(p))
        .cloned()?;
    *choice = Some((key, best.clone()));
    Some(best)
}

/// `(major, minor, patch)` from `herdr --version` ("herdr 0.9.1"); zeros when
/// unreadable, so an unprobeable install never beats a working one.
fn herdr_version(bin: &std::path::Path) -> (u64, u64, u64) {
    let Ok(out) = std::process::Command::new(bin)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
    else {
        return (0, 0, 0);
    };
    parse_herdr_version(&String::from_utf8_lossy(&out.stdout))
}

fn parse_herdr_version(text: &str) -> (u64, u64, u64) {
    let Some(v) = text
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
    else {
        return (0, 0, 0);
    };
    let mut parts = v
        .split(['.', '-', '+'])
        .map(|p| p.parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// True when the herdr binary is present AND its backend answers
/// `agent list`: presence alone is not enough — a stale install with a dead
/// daemon would make every attempt fail pointlessly.
pub(super) fn herdr_responding() -> bool {
    herdr_bin().is_some_and(|bin| run_ok(&bin, &["agent", "list"]))
}

async fn herdr(bin: &std::path::Path, args: &[&str]) -> Result<String, String> {
    herdr_within(bin, args, RPC_TIMEOUT).await
}

/// One herdr CLI call bounded by `timeout`: stdout on success, herdr's own
/// error text on failure (its `{"error":{"code","message"}}` JSON, on stderr,
/// or stdout when stderr is empty). Shared with `handoff.rs`, whose
/// `agent start` legitimately waits far longer than [`RPC_TIMEOUT`].
pub(crate) async fn herdr_within(
    bin: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let child = tokio::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("herdr not runnable: {e}"))?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "herdr timed out".to_string())?
        .map_err(|e| format!("herdr failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Every omp agent herdr knows about.
async fn herdr_agents(bin: &std::path::Path) -> Vec<PaneRef> {
    let Ok(raw) = herdr(bin, &["agent", "list"]).await else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let Some(list) = v.pointer("/result/agents").and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter(|a| a.get("agent").and_then(|x| x.as_str()) == Some("omp"))
        .filter_map(|a| {
            Some(PaneRef {
                id: a.get("pane_id")?.as_str()?.to_string(),
                cwd: a
                    .get("cwd")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                owner_resolved: false,
            })
        })
        .collect()
}

/// Read one agent's terminal output. `recent-unwrapped` is what we want: herdr
/// undoes the hard line wraps, so a wrapped collab link arrives whole.
async fn herdr_read(bin: &std::path::Path, pane: &str) -> Result<String, String> {
    herdr(
        bin,
        &[
            "agent",
            "read",
            pane,
            "--source",
            "recent-unwrapped",
            "--lines",
            "600",
        ],
    )
    .await
}

/// Adopt through herdr: resolve the owning agent when possible, otherwise
/// enumerate herdr's agents and prove identity from their output.
pub(super) async fn adopt_via_herdr(
    session_path: &str,
    session_cwd: Option<&str>,
    owner_pid: Option<i32>,
) -> Result<String, String> {
    let Some(bin) = herdr_bin() else {
        return Err("herdr is not installed".to_string());
    };
    let backend = TerminalBackend::Herdr(HerdrHost { bin, owner_pid });
    let prints = fingerprints(session_path);
    adopt_with(&backend, session_path, session_cwd, &prints).await
}

/// True when a process environment block (NUL-separated `K=V`) carries the
/// herdr vars herdr sets for everything it spawns. Mirrors
/// [`env_block_has_kitty`]: the owner's /proc environ is the authoritative
/// "is this pane herdr-managed?" answer.
fn env_block_has_herdr(block: &[u8]) -> bool {
    block
        .split(|b| *b == 0)
        .any(|e| e.starts_with(b"HERDR_PANE_ID="))
}

/// Whether herdr can be authoritative for THIS session. herdr multiplexes
/// several omp agents inside one kitty window and addresses them directly, so
/// for a herdr-managed owner it is the only safe backend (window-level output
/// could show a different agent's space). But an owner whose environ carries
/// NO herdr vars is a plain window herdr's agent list cannot contain — herdr
/// can never serve it, and being "authoritative" must not block the
/// window-level backend that can. `None` (no owner found) is the herdr-only
/// blind-spot case: a TUI that never wrote to the file, which herdr detects
/// by content — keep offering herdr there.
pub(super) fn owner_is_herdr_pane(owner_pid: Option<i32>) -> bool {
    match owner_pid {
        Some(pid) => {
            let raw = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default();
            env_block_has_herdr(&raw)
        }
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn herdr_versions_compare_numerically() {
        assert_eq!(parse_herdr_version("herdr 0.9.1\n"), (0, 9, 1));
        assert!(parse_herdr_version("herdr 0.10.0") > parse_herdr_version("herdr 0.9.1"));
        assert_eq!(parse_herdr_version("garbage"), (0, 0, 0));
    }

    #[test]
    fn herdr_env_detection_needs_the_pane_id_var() {
        // A herdr-managed pane carries HERDR_PANE_ID (plus the socket/tab
        // vars); a plain kitty window carries none of them. This distinction
        // gates whether herdr may be authoritative for a session.
        let herdr_pane =
            b"PATH=/usr/bin\0HERDR_PANE_ID=w1:p1X\0HERDR_SOCKET_PATH=/tmp/h\0KITTY_WINDOW_ID=2\0";
        assert!(env_block_has_herdr(herdr_pane));
        assert!(!env_block_has_herdr(b"HERDR_SOCKET_PATH=/tmp/h\0"));
        assert!(!env_block_has_herdr(b"KITTY_WINDOW_ID=2\0"));
        assert!(!env_block_has_herdr(b""));
    }

    #[test]
    fn herdr_pane_of_parses_synthetic_environ_and_absence() {
        let block = b"PATH=/usr/bin\0HERDR_PANE_ID=workspace:pane-7\0HERDR_TAB_ID=tab\0";
        assert_eq!(
            herdr_pane_from_env(block).as_deref(),
            Some("workspace:pane-7")
        );
        assert_eq!(herdr_pane_from_env(b"HERDR_SOCKET_PATH=/tmp/h\0"), None);
    }

    #[test]
    fn owner_is_herdr_pane_keeps_herdr_for_unknown_owners() {
        // None (no owner pid) is the herdr-only blind-spot case — a TUI that
        // never wrote to the file, which herdr detects by content. herdr must
        // stay on the table there.
        assert!(owner_is_herdr_pane(None));
        // A pid whose environ cannot be read counts as NOT herdr-managed:
        // gating herdr off is safe (it would fail to serve anyway) while
        // gating it on would risk blocking the window-level backends.
        assert!(!owner_is_herdr_pane(Some(i32::MAX)));
    }
}
