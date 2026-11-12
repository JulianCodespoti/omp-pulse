//! The full scan behind a refresh: the directory walk, ONE `/proc` ownership
//! sweep, the enrichment of every row and the total-order sort.

use super::*;

use crate::{
    omp::child::ChildManager,
    omp::collab::CollabManager,
    sessions::jsonl,
    types::{Config, SessionInfo},
};
use std::collections::{HashMap, HashSet};
use std::path::{Path as FsPath, PathBuf};

/// Full scan: directory walk + header parse + ONE `/proc` owner sweep +
/// enrichment + total-order sort. This is the 134 ms part (measured) — it
/// runs once per refresh in the background, never on a poll path.
pub(super) fn scan(
    children: &ChildManager,
    collab: &CollabManager,
    cfg: &Config,
) -> Vec<SessionInfo> {
    let mut out = jsonl::list_sessions(&cfg.sessions_root);
    // Enrich the snapshot BEFORE caching: ownership, live-path and running
    // state are part of the listing (at most TTL stale), exactly like mtime.
    let our_pids = children.live_pids();
    let (owners, procs) = foreign_ownership(&out, &our_pids);
    // Oracle ownership: a pane's self-reported session resolves holders no
    // fd or cmdline layer can see (a fresh TUI holding nothing yet, or one
    // whose file the owner never keeps open). Display-only like every owner
    // here — write-gating stays with the guard's fd proof. Sessions the fd
    // walk already claimed keep their pid (direct proof beats self-report).
    let mut owners = owners;
    // No panes in the oracle snapshot means no herdr owners to find — skip
    // the `/proc` environ sweep entirely (it costs a full process sweep).
    if crate::terminal::herdr_state::pane_count_global() > 0 {
        let pane_pids = crate::terminal::herdr_state::pane_pids();
        if !pane_pids.is_empty() {
            let me = std::process::id() as i32;
            for s in &out {
                let key = FsPath::new(&s.path);
                if owners.contains_key(key) {
                    continue;
                }
                let Some(pane) = crate::terminal::herdr_state::pane_for_session_global(&s.path)
                else {
                    continue;
                };
                let pid = pane_pids.get(&pane).into_iter().flatten().find(|pid| {
                    if **pid == me || our_pids.contains(pid) {
                        return false;
                    }
                    let Some(c) = read_cmdline(**pid) else {
                        return false;
                    };
                    // The pane's own infrastructure (worker broker, LSP mux)
                    // shares the pane environ but holds no session: owning to
                    // it would pin running state to broker lifetime.
                    looks_like_omp(&c) && !OWN_INFRA_MARKERS.iter().any(|m| c.contains(m))
                });
                if let Some(pid) = pid {
                    owners.insert(key.to_path_buf(), *pid);
                }
            }
        }
    }
    // Feed the oracle overlay back: every owner pid holding a session file
    // while carrying a pane id proves that pane holds that session — direct
    // fd evidence that overrides a stale self-report (and supplies sessions
    // herdr never reported at all). Rebuilt per scan, so a closed pane
    // cannot linger; empty when herdr is absent.
    if let Some(herdr) = crate::terminal::herdr_state::global() {
        let mut overlay = std::collections::HashMap::new();
        if crate::terminal::herdr_state::pane_count_global() > 0 {
            for (path, pid) in &owners {
                if let (Some(pane), Some(s)) = (
                    crate::terminal::adopt::herdr_pane_of(*pid),
                    path.to_str().map(str::to_string),
                ) {
                    overlay.insert(pane, s);
                }
            }
        }
        herdr.set_session_overlay(overlay);
    }
    // Fresh worker activity, once per scan: which owners grew a young,
    // non-infrastructure descendant (a tool run, subagent, or runner that
    // started minutes ago — as opposed to session-lifetime servers).
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let owner_pids: std::collections::HashSet<i32> = owners.values().copied().collect();
    let busy_owners = young_worker_owners(&procs, &owner_pids, &read_cmdline, *BOOT_MS, now_ms);
    // Bridged desktops report their own session and turn state exactly;
    // that beats every inferred leg below for the sessions it covers.
    let bridged = crate::omp::bridge::live_sessions();
    for s in &mut out {
        // Real activity, not file mtime: omp appends `session_exit` when a
        // process holding a session is terminated, which put conversations
        // three weeks old at the top of the list the moment their panes were
        // closed. Both lookups are memoized by (mtime, length).
        // One stat per row for every memo below (see `stamp`).
        let file_stamp = stamp(&s.path);
        s.active_at = metadata_at(&s.path, file_stamp)
            .active_at
            .or_else(|| snippet_at(&s.path, file_stamp).and_then(|sn| sn.at))
            .unwrap_or(s.mtime);
        s.owner_pid = owners
            .get(FsPath::new(&s.path))
            .copied()
            .or_else(|| bridged.get(&s.path).map(|(pid, _)| *pid));
        // Live = session has a writer: daemon child, collab share, OR foreign
        // desktop `omp` holding the file (ownerPid). This makes `Live`/`Open`
        // chips work when collab is off, without streaming every session.
        s.live =
            children.is_streaming(&s.path) || collab.is_attached(&s.path) || s.owner_pid.is_some();
        // Writable host path, per scan: attached AND writable (a view-only
        // link is not a write path). Drives share-affordance visibility.
        s.shared = collab.is_attached(&s.path) && collab.can_write(&s.path);
        if let Some((_, streaming)) = bridged.get(&s.path) {
            s.running = *streaming || children.is_streaming(&s.path);
            continue;
        }
        // Running = agent actively working, not just open. Daemon child
        // streaming is precise; for foreign-owned sessions the file tail
        // often goes quiet mid-turn (long tool run, thinking), so three
        // signals combine: a partial (currently appending), recent mtime,
        // a still-unanswered user prompt at the tail (the reply hasn't
        // committed; closing the TUI clears the owner, so an abandoned turn
        // cannot read running forever), or fresh worker activity (a tool,
        // subagent, or runner spawned minutes ago — as opposed to
        // session-lifetime servers, which the age gate excludes). A finished
        // `assistant` with a quiet file stays `Live`/`Open`, not `Running`;
        // an open editor under an open TUI reads running too — cosmetic,
        // documented, and preferable to hiding real turns.
        let is_recent = {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as f64)
                .unwrap_or(s.mtime);
            now_ms - s.mtime < 45_000.0
        };
        // Partial-line read, owner-gated like every other leg: `partial` is
        // only ever consumed under `owned`, so reading all ~700 tails per
        // scan just to mask the result out is ~2800 wasted syscalls plus a
        // tail page per file through the cache the snippet memo avoids.
        let has_partial = s.owner_pid.is_some()
            && std::fs::File::open(&s.path)
                .and_then(|mut f| {
                    use std::io::{Read, Seek, SeekFrom};
                    let len = f.metadata()?.len();
                    if len == 0 {
                        Ok(false)
                    } else {
                        f.seek(SeekFrom::End(-1))?;
                        let mut buf = [0u8; 1];
                        f.read_exact(&mut buf)?;
                        Ok(buf[0] != b'\n')
                    }
                })
                .unwrap_or(false);
        // Snippet tail is mtime-memoized: the row's stamp + a hash lookup per
        // owner row once steady, never a file read per scan per session.
        let user_last = s.owner_pid.is_some()
            && snippet_at(&s.path, file_stamp).is_some_and(|sn| sn.role == "user");
        // Worker evidence counts only under an omp-like owner: any process
        // can hold a session file (browsers do), and only an omp tree means
        // agent turns. One cmdline read per owner per scan.
        let owner_is_omp = s
            .owner_pid
            .is_some_and(|pid| read_cmdline(pid).is_some_and(|c| looks_like_omp(&c)));
        let young_workers = s.owner_pid.is_some_and(|pid| busy_owners.contains(&pid));
        // Oracle leg: herdr reports the owner's pane state hook-by-hook from
        // omp's own event bus (exact once the extension is loaded; screen
        // detection until then). One environ read per owner per scan — the
        // same price the cmdline check above already pays.
        let herdr_working = crate::terminal::herdr_state::status_for_owner(s.owner_pid)
            == Some(crate::terminal::herdr_state::HerdrStatus::Working);
        s.running = foreign_running(RunningSignals {
            child_streaming: children.is_streaming(&s.path),
            owned: s.owner_pid.is_some(),
            partial: has_partial,
            recent: is_recent,
            user_last,
            owner_is_omp,
            young_workers,
            herdr_working,
        });
    }
    // TOTAL order: most recent real activity first, ties broken by session
    // path ascending, so two consecutive scans with no filesystem change
    // always produce byte-identical payloads (the previous mtime-only sort
    // shuffled equal-mtime ties between refreshes — which churned the ETag).
    // Named because cursor paging binary-searches this exact order.
    out.sort_by(catalogue_order);
    out
}

/// Build a map of session file -> owning foreign omp pid with ONE pass over
/// `/proc`, instead of calling `guard::foreign_session_owner` per session —
/// that helper walks `/proc` once per call, so a ~850-session listing over
/// hundreds of pids each would be unusable. The filtering mirrors `guard.rs`
/// exactly: skip our own pid, every pid in `our_pids` (the daemon's live RPC
/// children), any `--mode rpc`/`--mode rpc-ui` process, and any process whose cmdline does
/// not look like omp; a session is owned when one of the process's fds
/// resolves to the session file (or its canonical form). First matching pid
/// wins per session, like the guard's first-match scan.
/// One `/proc` row kept for the ownership pass: identity for the parent map,
/// plus enough to judge turn activity without a second sweep.
struct ProcRow {
    pid: i32,
    ppid: i32,
    /// `starttime` from `/proc/<pid>/stat`, in clock ticks since boot.
    start_ticks: u64,
}

/// The ownership pass plus the process table it already walked: session file
/// -> owning foreign omp pid, and every observed pid for descendant checks.
/// Split so the worker rule stays unit-testable without `/proc`.
fn foreign_ownership(
    sessions: &[SessionInfo],
    our_pids: &[i32],
) -> (HashMap<PathBuf, i32>, Vec<ProcRow>) {
    let me = std::process::id() as i32;
    let paths: HashSet<PathBuf> = sessions.iter().map(|s| PathBuf::from(&s.path)).collect();
    let canon = canonical_session_paths(sessions);
    let mut owners: HashMap<PathBuf, i32> = HashMap::new();
    let mut table: Vec<ProcRow> = Vec::new();
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return (owners, table);
    };
    for entry in procs.flatten() {
        let Some(pid) = numeric_pid(&entry.file_name()) else {
            continue;
        };
        if pid == me || our_pids.contains(&pid) {
            continue;
        }
        // Recorded for every process (not just omp-like ones): the worker
        // rule walks descendants of owners, which are shells, python, node.
        if let Some((ppid, start_ticks)) = read_stat(pid) {
            table.push(ProcRow {
                pid,
                ppid,
                start_ticks,
            });
        }
        let Some(cmdline) = read_cmdline(pid) else {
            continue; // raced exit or EPERM — skip silently
        };
        if cmdline.contains("--mode rpc") || !looks_like_omp(&cmdline) {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(link) = std::fs::read_link(fd.path()) else {
                continue; // fds close and files move mid-scan
            };
            let owned = if paths.contains(&link) {
                Some(link)
            } else {
                canon.get(&link).cloned()
            };
            if let Some(session_path) = owned {
                owners.entry(session_path).or_insert(pid);
            }
        }
    }
    (owners, table)
}

/// Canonical form of each session path -> the listed path, for matching
/// `/proc/<pid>/fd` links (which the kernel reports fully resolved).
///
/// `jsonl::list_sessions` admits only regular files inside real directories
/// (`DirEntry::file_type` does not follow symlinks), so a session's real path
/// is its directory's real path joined with its own name. One `canonicalize`
/// per project directory therefore replaces one per file — each a realpath
/// walk of ~7 components, every one a syscall proot intercepts: 38 per-file
/// realpaths measured 53 ms in a phone's proot guest against 2 ms for the 4 project
/// directories (2026-10-14).
fn canonical_session_paths(sessions: &[SessionInfo]) -> HashMap<PathBuf, PathBuf> {
    let mut dirs: HashMap<&FsPath, Option<PathBuf>> = HashMap::new();
    let mut canon = HashMap::with_capacity(sessions.len());
    for s in sessions {
        let path = FsPath::new(&s.path);
        let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
            continue;
        };
        let real_dir = dirs.entry(dir).or_insert_with(|| dir.canonicalize().ok());
        if let Some(real_dir) = real_dir {
            canon
                .entry(real_dir.join(name))
                .or_insert_with(|| path.to_path_buf());
        }
    }
    canon
}

/// `Some(pid)` only for purely-numeric `/proc` entries (e.g. "1234"), which
/// are processes; everything else in /proc is skipped. Mirrors guard.rs.
fn numeric_pid(name: &std::ffi::OsStr) -> Option<i32> {
    let name = name.to_str()?;
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    name.parse::<i32>().ok()
}

/// `/proc/<pid>/cmdline` (NUL-separated argv) rendered space-separated and
/// trimmed. `None` when unreadable (process exited, permission) or empty.
/// Mirrors guard.rs.
fn read_cmdline(pid: i32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let rendered = String::from_utf8_lossy(&raw).replace('\0', " ");
    let rendered = rendered.trim().to_string();
    if rendered.is_empty() {
        None
    } else {
        Some(rendered)
    }
}
/// `(ppid, starttime-ticks)` from `/proc/<pid>/stat`. The comm field may
/// contain spaces and parens, so split after the LAST `)`; ppid and starttime
/// are fields 2 and 20 after it. `None` on any parse failure (raced exit,
/// EPERM, exotic kernels) — callers treat unknown as absent.
fn read_stat(pid: i32) -> Option<(i32, u64)> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_stat_line(&raw)
}

/// Pure half of `read_stat`, unit-tested below.
fn parse_stat_line(raw: &str) -> Option<(i32, u64)> {
    let after_comm = raw.rfind(')')?;
    let fields: Vec<&str> = raw[after_comm + 1..].split_whitespace().collect();
    if fields.len() < 20 {
        return None;
    }
    let ppid = fields[1].parse::<i32>().ok()?;
    let start_ticks = fields[19].parse::<u64>().ok()?;
    Some((ppid, start_ticks))
}

/// Boot time, unix millis, read once: `/proc/stat` btime never changes under
/// a running kernel. Zero when unreadable — worker ages then read unknown
/// and contribute nothing (conservative: missing data never marks running).
static BOOT_MS: std::sync::LazyLock<u64> = std::sync::LazyLock::new(|| {
    std::fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|l| l.strip_prefix("btime "))
                .and_then(|s| s.trim().parse::<u64>().ok())
        })
        .map(|s| s.saturating_mul(1000))
        .unwrap_or(0)
});

/// Clock ticks per second for `/proc` starttime. The kernel exposes this via
/// `getconf CLK_TCK` (100 on effectively all Linux); this whole scan is
/// `/proc`-gated anyway, and the threshold below tolerates wide error.
const CLK_TCK: u64 = 100;

/// A descendant counts as turn activity only when young: long-lived children
/// (MCP servers, python runners, js eval shims — measured at 3-8h on live
/// sessions) persist for the session lifetime and say nothing about NOW.
const WORKER_YOUNG_MS: u64 = 300_000;

/// Always-on omp infrastructure: never evidence of a turn, even when young.
/// Matched against the full cmdline (comm is just `omp` for all of these).
const OWN_INFRA_MARKERS: &[&str] = &["__omp_worker_daemon_broker", "__omp_worker_lsp_mux"];

/// Owners (by pid) with at least one young, non-infrastructure descendant.
/// Pure over an explicit table so tests never touch `/proc`: `procs` holds
/// every observed pid, `cmdline` resolves one for infra screening, `now_ms`
/// is scan time. Depth-capped with a visited set (pid reuse, malformed
/// ppids, and exits mid-scan must terminate, never loop).
fn young_worker_owners(
    procs: &[ProcRow],
    owners: &std::collections::HashSet<i32>,
    cmdline: &impl Fn(i32) -> Option<String>,
    boot_ms: u64,
    now_ms: u64,
) -> std::collections::HashSet<i32> {
    use std::collections::{HashMap, HashSet};
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for p in procs {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    let age_ms = |pid: i32| {
        procs.iter().find(|p| p.pid == pid).and_then(|p| {
            if boot_ms == 0 {
                return None;
            }
            Some(now_ms.saturating_sub(boot_ms + p.start_ticks.saturating_mul(1000) / CLK_TCK))
        })
    };
    let mut out = HashSet::new();
    for owner in owners {
        // (pid, depth): traverse through excluded infrastructure (a broker's
        // grandchildren are still turn activity) without ever counting it.
        let mut stack = vec![(*owner, 0u32)];
        let mut seen = HashSet::new();
        while let Some((pid, depth)) = stack.pop() {
            if !seen.insert(pid) || depth > 4 {
                continue;
            }
            let Some(kids) = children.get(&pid) else {
                continue;
            };
            for kid in kids {
                if seen.contains(kid) {
                    continue;
                }
                match age_ms(*kid) {
                    Some(age) if age < WORKER_YOUNG_MS => {
                        let infra = cmdline(*kid)
                            .is_some_and(|c| OWN_INFRA_MARKERS.iter().any(|m| c.contains(m)));
                        if infra {
                            stack.push((*kid, depth + 1));
                        } else {
                            out.insert(*owner);
                            break;
                        }
                    }
                    _ => {
                        stack.push((*kid, depth + 1));
                    }
                }
            }
            if out.contains(owner) {
                break;
            }
        }
    }
    out
}
/// Display-only running rule (never write-gating — that stays with the
/// guard). A held session reads running when the file shows motion (partial,
/// recent write) OR the transcript tail is still the user's prompt (the reply
/// hasn't committed; closing the holder clears the owner, so an abandoned
/// turn cannot read running forever) OR fresh worker activity under an
/// omp-like owner OR the herdr oracle reports the owner's pane `working`
/// (hook-driven from omp's own event bus — exact, including turns with no
/// file side effects yet). The owner gate on the worker leg matters: any
/// process can hold a session file open (a browser with a download dialog
/// counts!), and only an omp process tree means agent turns — desktop-app
/// children churn constantly and would pin `Running` for days. Assistant-last
/// with a quiet file stays idle: nothing observable distinguishes it from
/// done. An open editor under an open omp TUI reads running too — cosmetic,
/// documented, and preferable to hiding real turns.
#[derive(Debug, Clone, Copy, Default)]
struct RunningSignals {
    child_streaming: bool,
    owned: bool,
    partial: bool,
    recent: bool,
    user_last: bool,
    owner_is_omp: bool,
    young_workers: bool,
    herdr_working: bool,
}
fn foreign_running(s: RunningSignals) -> bool {
    s.child_streaming
        || (s.owned
            && (s.partial
                || s.recent
                || s.user_last
                || s.herdr_working
                || (s.owner_is_omp && s.young_workers)))
}

/// Omp-like process detection, shared by owner discovery (fd walk) and the
/// running worker gate. Keyed on argv[0]'s file stem: the agent binary
/// itself (`omp`, `omp_pulse`), or a JS runtime launching an omp path
/// (`bun /…/omp/index.js`). Deliberately NOT a `/omp` substring search: the
/// harness state dir `~/.local/share/omp/` appears in unrelated processes —
/// observed live with Chromium matching via its browser-relay extension
/// path, which made a browser both an "owner" and a "running" session.
/// Unknown launchers (sh wrappers, uvx) miss: conservative, reads idle.
fn looks_like_omp(rendered: &str) -> bool {
    let mut args = rendered.split_whitespace();
    let Some(argv0) = args.next() else {
        return false;
    };
    let stem = FsPath::new(argv0)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if stem == "omp" || stem == "omp_pulse" {
        return true;
    }
    if stem == "bun" || stem == "node" || stem == "deno" {
        return rendered.contains("/omp/");
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::sessions::index::tests::row;

    #[cfg(unix)]
    #[test]
    fn canonical_session_paths_match_per_file_realpath() {
        let base =
            std::env::temp_dir().join(format!("omp-pulse-index-{}-canon", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let real = base.join("real").join("-proj");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("a.jsonl"), "").unwrap();
        std::fs::write(real.join("b.jsonl"), "").unwrap();
        // A symlinked sessions root, as when ~/.local/share is relocated.
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).unwrap();
        let listed_a = base.join("link").join("-proj").join("a.jsonl");
        let listed_b = base.join("link").join("-proj").join("b.jsonl");
        let rows = vec![
            row(listed_a.to_str().unwrap(), "a", "a", "/w"),
            row(listed_b.to_str().unwrap(), "b", "b", "/w"),
            row("/omp-pulse-no-such-dir/c.jsonl", "c", "c", "/w"),
        ];
        let canon = canonical_session_paths(&rows);
        // Same keys a per-file canonicalize produces; a missing directory
        // contributes nothing.
        assert_eq!(canon.len(), 2);
        assert_eq!(
            canon.get(&listed_a.canonicalize().unwrap()),
            Some(&listed_a)
        );
        assert_eq!(
            canon.get(&listed_b.canonicalize().unwrap()),
            Some(&listed_b)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn foreign_running_matrix() {
        // Daemon child streaming always wins, owned or not.
        assert!(foreign_running(RunningSignals {
            child_streaming: true,
            ..Default::default()
        }));
        assert!(foreign_running(RunningSignals {
            child_streaming: true,
            owned: true,
            ..Default::default()
        }));
        // Unowned sessions never read running off file state.
        assert!(!foreign_running(RunningSignals {
            partial: true,
            recent: true,
            user_last: true,
            owner_is_omp: true,
            young_workers: true,
            herdr_working: true,
            ..Default::default()
        }));
        // Each foreign signal suffices with an owner present.
        assert!(foreign_running(RunningSignals {
            owned: true,
            partial: true,
            ..Default::default()
        }));
        assert!(foreign_running(RunningSignals {
            owned: true,
            recent: true,
            ..Default::default()
        }));
        assert!(foreign_running(RunningSignals {
            owned: true,
            user_last: true,
            ..Default::default()
        }));
        assert!(foreign_running(RunningSignals {
            owned: true,
            owner_is_omp: true,
            young_workers: true,
            ..Default::default()
        }));
        // Oracle alone suffices: a pane herdr reports working is running even
        // with a quiet file and no young workers (the thinking-no-side-effects
        // case the file legs cannot see).
        assert!(foreign_running(RunningSignals {
            owned: true,
            herdr_working: true,
            ..Default::default()
        }));
        // Young workers under a non-omp holder (browser, editor, tail) mean
        // nothing: observed live with Chromium holding a session file while
        // its renderer subtree churned.
        assert!(!foreign_running(RunningSignals {
            owned: true,
            young_workers: true,
            ..Default::default()
        }));
        // A held session with none of the signals is open, not working.
        assert!(!foreign_running(RunningSignals {
            owned: true,
            owner_is_omp: true,
            ..Default::default()
        }));
    }
    #[test]
    fn looks_like_omp_keys_on_argv0() {
        assert!(looks_like_omp("/usr/bin/omp"));
        assert!(looks_like_omp("omp --mode rpc"));
        assert!(looks_like_omp("bun /home/u/Coding/omp/index.js"));
        // Live false positive: Chromium carries the harness state dir in its
        // browser-relay extension path; a `/omp` substring matched it.
        assert!(!looks_like_omp(
            "/usr/lib/chromium/chromium --type=renderer --relay=/home/u/.local/share/omp/browser-relay/x"
        ));
        assert!(!looks_like_omp(""));
    }

    #[test]
    fn read_stat_parses_linux_format() {
        // ppid=1, starttime=987654 (fields 2 and 20 after the comm paren).
        let line = "12576 (omp) S 1 12576 12576 0 -1 4194304 100 0 0 0 50 10 0 0 20 0 1 0 987654 100000 100";
        assert_eq!(parse_stat_line(line), Some((1, 987654)));
        // Comm containing spaces and parens: split after the LAST close paren.
        let tricky = "99 (my prog (x)) S 7 99 99 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 42 100";
        assert_eq!(parse_stat_line(tricky), Some((7, 42)));
        assert!(parse_stat_line("garbage").is_none());
        assert!(parse_stat_line("1 (x) S").is_none());
    }

    #[test]
    fn young_workers_selects_fresh_non_infra() {
        // Boot is explicit here (1e12 ms) with `now` one hour later, so
        // synthetic start ticks behave identically on any host. Ticks are
        // centiseconds: young means started within the last 300_000 ms,
        // i.e. ticks > 330_000 against this clock.
        let boot = 1_000_000_000_000u64;
        let now = boot + 3_600_000;
        let row = |pid: i32, ppid: i32, ticks: u64| ProcRow {
            pid,
            ppid,
            start_ticks: ticks,
        };
        let owners: HashSet<i32> = [100].into_iter().collect();
        // Young bash child of the owner: working.
        let table = vec![row(100, 1, 1000), row(101, 100, 335_000)];
        let cmds: HashMap<i32, String> = [(100, "omp".to_string()), (101, "bash".to_string())]
            .into_iter()
            .collect();
        assert_eq!(
            young_worker_owners(&table, &owners, &|pid| cmds.get(&pid).cloned(), boot, now),
            owners
        );
        // Only an old child: lingering servers say nothing about now.
        let table = vec![row(100, 1, 1000), row(101, 100, 10_000)];
        assert!(
            young_worker_owners(&table, &owners, &|pid| cmds.get(&pid).cloned(), boot, now)
                .is_empty()
        );
        // Young broker child alone never counts, but its young grandchild
        // does (traverse through infra, never count it).
        let table = vec![
            row(100, 1, 1000),
            row(101, 100, 335_000),
            row(102, 101, 336_000),
        ];
        let cmds: HashMap<i32, String> = [
            (100, "omp".to_string()),
            (101, "omp __omp_worker_daemon_broker".to_string()),
            (102, "bash -c tool".to_string()),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            young_worker_owners(&table, &owners, &|pid| cmds.get(&pid).cloned(), boot, now),
            owners
        );
        let table = vec![row(100, 1, 1000), row(101, 100, 335_000)];
        assert!(
            young_worker_owners(&table, &owners, &|pid| cmds.get(&pid).cloned(), boot, now)
                .is_empty()
        );
        // Unknown boot reads every age unknown: never marks running.
        let table = vec![row(100, 1, 1000), row(101, 100, 335_000)];
        assert!(
            young_worker_owners(&table, &owners, &|pid| cmds.get(&pid).cloned(), 0, now).is_empty()
        );
        // ppid cycle terminates instead of looping.
        let table = vec![
            row(100, 1, 1000),
            row(101, 102, 335_000),
            row(102, 101, 335_000),
        ];
        let cmds: HashMap<i32, String> = [
            (100, "omp".to_string()),
            (101, "x".to_string()),
            (102, "y".to_string()),
        ]
        .into_iter()
        .collect();
        let _ = young_worker_owners(&table, &owners, &|pid| cmds.get(&pid).cloned(), boot, now);
    }
}
