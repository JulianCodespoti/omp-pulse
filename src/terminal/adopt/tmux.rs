//! The tmux backend: every pane on the server is a candidate, its screen read
//! with `capture-pane` and `/collab` typed with `send-keys`.
//!
//! tmux is the most common multiplexer, works identically on Linux and macOS,
//! and exposes the same two primitives adoption needs: read the pane's visible
//! screen (`capture-pane -p`) and inject keys (`send-keys`). Enumerate every
//! pane on the server with:
//!
//!   tmux list-panes -a -F '#{pane_id} #{pane_pid} #{pane_current_command} #{pane_title}'
//!
//! A pane maps to a session when its foreground pid is the session owner or an
//! ancestor of it (omp launched directly, or inside a shell in the pane); the
//! content fingerprint then proves identity before anything is typed. The CLI
//! round-trips over the default server socket ($TMUX when we are inside tmux,
//! else /tmp/tmux-<uid>/default), which is why it needs no server-side setup.

use super::*;
use std::time::Duration;

/// CLI (`capture-pane` to read the screen, `send-keys` to type). Identity is
/// proven by content fingerprint inside the shared algorithm before anything
/// is typed, exactly like the other backends.
pub(super) struct TmuxHost {
    owner_pid: i32,
}

impl TmuxHost {
    /// Panes whose process tree contains the owner: the pane's foreground pid
    /// is omp itself (launched directly) or the shell that launched it, which
    /// then appears on the owner's ancestor chain.
    pub(super) async fn panes(&self) -> Vec<PaneRef> {
        let ancestors = owner_ancestors(self.owner_pid);
        tmux_panes()
            .await
            .into_iter()
            .filter(|p| ancestors.contains(&p.pid))
            .map(|p| PaneRef {
                id: p.id,
                cwd: String::new(), // not requested from tmux; the cwd filter skips empty hints
                owner_resolved: false,
            })
            .collect()
    }

    pub(super) async fn read(&self, pane: &str) -> Result<String, String> {
        // capture-pane -p prints the pane's visible screen to stdout — the
        // same "prove the pane displays THIS conversation" check every backend
        // runs through the shared fingerprint matcher.
        tmux(&["capture-pane", "-p", "-t", pane]).await
    }

    pub(super) async fn submit(&self, pane: &str, text: &str) -> Result<(), String> {
        // Escape first (empties a half-typed composer line so the submitted
        // text cannot corrupt it), then the literal command and Enter. `-l`
        // disables key-name lookup so the text goes out verbatim.
        tmux(&["send-keys", "-t", pane, "Escape"]).await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        tmux(&["send-keys", "-t", pane, "-l", text]).await?;
        tmux(&["send-keys", "-t", pane, "Enter"]).await.map(|_| ())
    }
}

/// One pane as `tmux list-panes -a -F …` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TmuxPane {
    id: String,
    pid: i32,
    command: String,
    title: String,
}

/// Parse the `list-panes` format output. The pane id and pid are single
/// space-free tokens and `pane_current_command` is a process name (no
/// spaces); everything after that is the title, which may contain spaces or
/// be absent. Malformed lines (a race during a pane close, an unexpected
/// format change) are skipped.
fn parse_tmux_panes(raw: &str) -> Vec<TmuxPane> {
    raw.lines()
        .filter_map(|line| {
            let mut tokens = line.split_whitespace();
            let id = tokens.next()?.to_string();
            let pid: i32 = tokens.next()?.parse().ok()?;
            let command = tokens.next()?.to_string();
            let title = tokens.collect::<Vec<_>>().join(" ");
            Some(TmuxPane {
                id,
                pid,
                command,
                title,
            })
        })
        .collect()
}

/// Run the tmux CLI, returning stdout on success. Bounded by `RPC_TIMEOUT` so
/// a wedged server cannot hang an adoption attempt.
async fn tmux(args: &[&str]) -> Result<String, String> {
    let Some(bin) = find_on_path("tmux") else {
        return Err("tmux is not installed".to_string());
    };
    let child = tokio::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("tmux not runnable: {e}"))?;
    let out = tokio::time::timeout(RPC_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "tmux remote control timed out".to_string())?
        .map_err(|e| format!("tmux failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Every pane on the tmux server (all sessions and windows).
async fn tmux_panes() -> Vec<TmuxPane> {
    let Ok(raw) = tmux(&[
        "list-panes",
        "-a",
        "-F",
        "#{pane_id} #{pane_pid} #{pane_current_command} #{pane_title}",
    ])
    .await
    else {
        return Vec::new();
    };
    parse_tmux_panes(&raw)
}

/// Pids on the ancestor chain of `pid`, including `pid` itself, from a single
/// sysinfo snapshot. Used to map a tmux pane to a session — macOS has no
/// /proc to walk, so the cross-platform crate earns its place. The walk is
/// bounded and stops at a pid that re-parents to itself (pid 1 on some
/// kernels), which would otherwise loop forever.
pub(super) fn owner_ancestors(owner_pid: i32) -> std::collections::HashSet<i32> {
    let sys = sysinfo::System::new_all();
    let mut out = std::collections::HashSet::new();
    let mut current = Some(sysinfo::Pid::from_u32(owner_pid as u32));
    for _ in 0..32 {
        let Some(pid) = current else {
            break;
        };
        let id = pid.as_u32() as i32;
        out.insert(id);
        current = sys.process(pid).and_then(|p| p.parent());
        if current.as_ref().is_some_and(|p| p.as_u32() as i32 == id) {
            break;
        }
    }
    out
}

/// Adopt through tmux: find the pane whose process tree contains the session
/// owner and whose screen PROVES it displays this conversation, make it
/// share, and return the link.
pub(super) async fn adopt_via_tmux(session_path: &str, owner_pid: i32) -> Result<String, String> {
    let backend = TerminalBackend::Tmux(TmuxHost { owner_pid });
    let prints = fingerprints(session_path);
    adopt_with(&backend, session_path, None, &prints).await
}

/// Machine-level tmux availability: the binary exists AND a server answers
/// `list-panes` (the same reachability signal adoption relies on; without a
/// running server tmux exits nonzero). Identical on Linux and macOS.
pub(super) fn tmux_responding() -> bool {
    find_on_path("tmux").is_some_and(|bin| run_ok(&bin, &["list-panes", "-a"]))
}

/// Per-session tmux availability for adopting `owner_pid`'s session. On Linux
/// the owner's environment is authoritative: tmux sets `TMUX=` for every
/// process it spawns, exactly like kitty's vars, and its absence proves the
/// owner is not in a pane. macOS has no /proc environ to read, so there we
/// fall back to the pane list: a reachable server is usable because the
/// backend still proves identity by process tree against the owner pid and
/// then by content fingerprint.
// `owner_pid` is only read on Linux (the /proc environ probe); the other
// platforms fall back to a server reachability check, so the parameter is
// deliberately unused there.
pub(super) fn tmux_detect_for(
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))] owner_pid: i32,
) -> bool {
    #[cfg(target_os = "linux")]
    {
        if find_on_path("tmux").is_none() {
            return false;
        }
        let raw = std::fs::read(format!("/proc/{owner_pid}/environ")).unwrap_or_default();
        raw.split(|b| *b == 0).any(|e| e.starts_with(b"TMUX="))
    }
    #[cfg(not(target_os = "linux"))]
    {
        match find_on_path("tmux") {
            Some(bin) => run_ok(&bin, &["list-panes", "-a"]),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A realistic `tmux list-panes -a -F '#{pane_id} #{pane_pid} #{pane_current_command} #{pane_title}'`
    /// capture: three panes across two windows — a shell, an omp TUI and an
    /// editor, with titles that contain spaces and one title absent.
    const TMUX_LIST_SAMPLE: &str = "\
%0 4123 omp   omp — /home/me/coding/project
%1 4567 bash   bash — 80x24
%2 8901 nvim
";

    #[test]
    fn tmux_pane_list_parses_realistic_output() {
        let panes = parse_tmux_panes(TMUX_LIST_SAMPLE);
        assert_eq!(panes.len(), 3);
        assert_eq!(panes[0].id, "%0");
        assert_eq!(panes[0].pid, 4123);
        assert_eq!(panes[0].command, "omp");
        assert_eq!(panes[0].title, "omp — /home/me/coding/project");
        assert_eq!(panes[1].id, "%1");
        assert_eq!(panes[1].command, "bash");
        assert_eq!(panes[1].title, "bash — 80x24");
        assert_eq!(panes[2].id, "%2");
        assert_eq!(panes[2].pid, 8901);
        assert_eq!(panes[2].command, "nvim");
        assert_eq!(panes[2].title, "");
    }

    #[test]
    fn tmux_pane_list_skips_malformed_lines() {
        // A title containing what looks like a format token, a non-numeric
        // pid and a truncated line must all be handled without panicking.
        let raw = "%0 1234 omp   pane #{pane_id} here\n%1 nope omp\n%2\n";
        let panes = parse_tmux_panes(raw);
        assert_eq!(panes.len(), 1);
        assert_eq!(panes[0].id, "%0");
        assert_eq!(panes[0].title, "pane #{pane_id} here");
    }

    #[test]
    fn pane_maps_to_owner_by_process_tree() {
        // Our own pid is deterministically on its own ancestor chain; a pid
        // that cannot exist is not.
        let me = std::process::id() as i32;
        let chain = owner_ancestors(me);
        assert!(chain.contains(&me), "the owner itself must map");
        assert!(!chain.contains(&i32::MAX), "a nonsense pid must not map");
    }
}
