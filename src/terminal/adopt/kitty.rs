//! The kitty backend: the owner's window from its `/proc` environment, the
//! screen read with `kitty @ get-text` and text injected with `kitty @ send-text`.

use super::*;
use std::time::Duration;

/// Where a TUI lives, as reported by the TUI itself.
pub(super) struct WindowRef {
    socket: String,
    window_id: String,
}

/// True when a process environment block (NUL-separated `K=V`) carries both
/// kitty remote-control vars. Shared by `window_of` (one pid's `/proc`
/// environ) and the machine-wide kitty scan, and exercised in the tests with
/// a synthetic block.
fn env_block_has_kitty(block: &[u8]) -> bool {
    let mut listen = false;
    let mut window = false;
    for entry in block.split(|b| *b == 0) {
        let Ok(text) = std::str::from_utf8(entry) else {
            continue;
        };
        if text.starts_with("KITTY_LISTEN_ON=") {
            listen = true;
        } else if text.starts_with("KITTY_WINDOW_ID=") {
            window = true;
        }
    }
    listen && window
}

/// Read `KITTY_LISTEN_ON` / `KITTY_WINDOW_ID` out of a process's environment.
///
/// Both are set by kitty for every process it spawns, and inherited, so the omp
/// TUI carries them even when a shell or multiplexer sits in between. The read
/// is a plain `/proc` file read, so on platforms without /proc (macOS,
/// Windows) it simply fails and reports no window — kitty adoption then needs
/// the daemon's own environment, which is exactly what the machine report
/// reflects.
pub(super) fn window_of(pid: i32) -> Option<WindowRef> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    if !env_block_has_kitty(&raw) {
        return None;
    }
    let mut socket = None;
    let mut window_id = None;
    for entry in raw.split(|b| *b == 0) {
        let Ok(text) = std::str::from_utf8(entry) else {
            continue;
        };
        if let Some(v) = text.strip_prefix("KITTY_LISTEN_ON=") {
            socket = Some(v.to_string());
        } else if let Some(v) = text.strip_prefix("KITTY_WINDOW_ID=") {
            window_id = Some(v.to_string());
        }
    }
    Some(WindowRef {
        socket: socket?,
        window_id: window_id?,
    })
}

/// Run `kitty @ --to <socket> <args…>`, returning stdout on success.
async fn kitty(win: &WindowRef, args: &[&str]) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("kitty");
    cmd.arg("@")
        .arg("--to")
        .arg(&win.socket)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| format!("kitty not runnable: {e}"))?;
    let out = tokio::time::timeout(RPC_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "kitty remote control timed out".to_string())?
        .map_err(|e| format!("kitty failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "kitty remote control refused".to_string()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The window's visible text.
async fn screen(win: &WindowRef) -> Result<String, String> {
    kitty(
        win,
        &[
            "get-text",
            "--match",
            &format!("id:{}", win.window_id),
            "--extent",
            "screen",
        ],
    )
    .await
}

/// Send literal text to the window's input.
async fn send_text(win: &WindowRef, text: &str) -> Result<(), String> {
    kitty(
        win,
        &[
            "send-text",
            "--match",
            &format!("id:{}", win.window_id),
            text,
        ],
    )
    .await
    .map(|_| ())
}

/// kitty backend: the single window the owning process lives in (identity
/// comes from the owner pid via `window_of`, not from a pane enumeration).
/// Typing sends ESC first so a half-typed composer line cannot be turned into
/// a corrupted command, exactly as the pty host does it.
pub(super) struct KittyHost {
    win: WindowRef,
}

impl KittyHost {
    pub(super) async fn panes(&self) -> Vec<PaneRef> {
        // kitty exposes exactly one candidate pane: the owner's window.
        vec![PaneRef {
            id: self.win.window_id.clone(),
            cwd: String::new(), // cwd unknown; the cwd filter skips empty hints
            owner_resolved: true,
        }]
    }

    pub(super) async fn read(&self, _pane: &str) -> Result<String, String> {
        screen(&self.win).await
    }

    pub(super) async fn submit(&self, _pane: &str, text: &str) -> Result<(), String> {
        send_text(&self.win, "\x1b").await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        send_text(&self.win, &format!("{text}\r")).await
    }
}

/// Machine-level kitty availability: the binary exists AND some process
/// carries the kitty env vars. The daemon usually does NOT run inside kitty
/// while the TUI does, so our own environment alone would under-report a
/// machine that clearly supports kitty adoption.
pub(super) fn kitty_available() -> bool {
    if find_on_path("kitty").is_none() {
        return false;
    }
    if std::env::var("KITTY_LISTEN_ON").is_ok() && std::env::var("KITTY_WINDOW_ID").is_ok() {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        any_process_has_kitty_env()
    }
    #[cfg(not(target_os = "linux"))]
    {
        // No portable way to read another process's environment off Linux
        // (/proc/<pid>/environ is a Linux facility), so the self-environ check
        // above is the whole report there.
        false
    }
}

/// Scan /proc for any process whose environment carries the kitty vars.
/// Reads stop at the first hit; unreadable entries (permissions, a pid that
/// exited mid-scan) are skipped — this is a report, not an audit.
#[cfg(target_os = "linux")]
fn any_process_has_kitty_env() -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.parse::<i32>().is_err() {
            continue;
        }
        if let Ok(block) = std::fs::read(format!("/proc/{name}/environ"))
            && env_block_has_kitty(&block)
        {
            return true;
        }
    }
    false
}

/// kitty backend: window discovered from the owning process's environment.
pub(super) async fn adopt_via_kitty(session_path: &str, owner_pid: i32) -> Result<String, String> {
    let Some(win) = window_of(owner_pid) else {
        // Normally unreachable through adopt_session (detect_for only offers
        // kitty when window_of succeeds); the caller appends the manual
        // `/collab` hint to whatever this returns.
        return Err(
            "the terminal running this conversation does not expose kitty remote control"
                .to_string(),
        );
    };
    let backend = TerminalBackend::Kitty(KittyHost { win });
    let prints = fingerprints(session_path);
    adopt_with(&backend, session_path, None, &prints).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_lookup_fails_cleanly_for_a_dead_pid() {
        // pid 0 never has a readable environ.
        assert!(window_of(0).is_none());
    }

    #[test]
    fn kitty_env_detection_needs_both_remote_control_vars() {
        // A synthetic environment block: kitty is only usable when both
        // KITTY_LISTEN_ON and KITTY_WINDOW_ID are present — the window id is
        // what `get-text`/`send-text` address.
        let full = b"PATH=/usr/bin\0KITTY_LISTEN_ON=unix:/tmp/kitty.sock\0KITTY_WINDOW_ID=1\0";
        assert!(env_block_has_kitty(full));
        assert!(!env_block_has_kitty(
            b"KITTY_LISTEN_ON=unix:/tmp/kitty.sock\0"
        ));
        assert!(!env_block_has_kitty(b"KITTY_WINDOW_ID=1\0"));
        assert!(!env_block_has_kitty(b""));
    }
}
