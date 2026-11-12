//! Native Tern owners: read-only discovery of the owner's ACTIVE native Collab
//! host, proven by BOTH the exact session file and the owner pid.
//!
//! Tern runs omp natively (a TSP surface, not terminal cells), so the other
//! backends' tools do not work: a capture keeps every old `/collab` hint in
//! the transcript forever, and nothing that types into a native composer is
//! safe. Native `tern send` replaces or appends to the user's unsent draft,
//! and the SDK state that could be read first lags the composer by seconds
//! with no atomic guard, so a draft typed in that gap was lost in a real test.
//! A last-published native property (screen text, a join hint, the last state
//! the SDK mirrored) can therefore never authorize command input.
//!
//! This module only reads and never types, prompts, focuses, opens or creates
//! a window. It asks the OWNER's omp (`omp collab list/link`, run with the
//! owner's HOME/profile/PATH, not the daemon's) for the exact session's active
//! host through `native_collab::discover`, so the link carries the registry's
//! own session/generation/access checks. The host must already be running:
//! started manually with `/collab` in the Tern pane, or by Collab autostart.
//! The composer, and any draft in it, is never read or modified.
//!
//! The owner's Tern pane is found with scoped, bounded `tern inspect` and
//! `tern process` calls: the exact canonical session file plus the owner pid
//! (directly the pane's root/foreground process, or descended from it). That
//! proof is repeated after discovery, so a link or refusal is handed back only
//! for the pane that still shows this file behind this owner.
//!
//! Identity contract:
//! * `Ok(None)` — the exact file+pid proof shows no Tern pane belongs to this
//!   owner (or Tern is not reachable for an owner that was never in a Tern
//!   pane / whose daemon is gone). The caller may use the legacy backends.
//! * `Ok(Some(link))` — the owner's active exact host, as a validated native
//!   Collab link.
//! * `Err` — an authoritative refusal once a Tern owner matched (or Tern
//!   evidence exists but cannot be resolved), including an owner that has no
//!   active host: the caller MUST NOT fall back to raw keyboard injection,
//!   because nested/inherited terminal identities make that unsafe.

use super::{RPC_TIMEOUT, find_on_path, owner_ancestors, validated_native_link};
use crate::omp::native_collab::{Discovery, OwnerCli, discover};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;

/// Cap on any single CLI output (an `inspect` of many panes is the large case).
const MAX_CLI_OUTPUT: usize = 4 * 1024 * 1024;

const UNREADABLE: &str = "Tern returned state omp-pulse cannot read";

// --- scope ------------------------------------------------------------------

/// The Tern daemon/window/pane an owner process lives in, from its own
/// environment (Tern sets these for everything it spawns).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TernScope {
    /// Read from the owner's environment. Without that (non-Linux) the CLI
    /// keeps this process's own Tern variables and its default window.
    from_owner: bool,
    pane: Option<String>,
    window_key: Option<String>,
    socket: Option<String>,
    pane_socket: Option<String>,
    window_socket: Option<String>,
    config_dir: Option<String>,
    exe: Option<String>,
}

/// A Unix socket path that no longer answers: absent, or a stale leftover file
/// whose listener is gone (connection refused). Other errors prove nothing.
/// Connecting creates no socket and starts nothing.
fn socket_dead(path: &str) -> bool {
    #[cfg(unix)]
    {
        use std::io::ErrorKind;
        match std::os::unix::net::UnixStream::connect(path) {
            Ok(_) => false,
            Err(e) => matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused),
        }
    }
    #[cfg(not(unix))]
    {
        !Path::new(path).exists()
    }
}

impl TernScope {
    /// The owner was launched inside a Tern pane.
    fn in_pane(&self) -> bool {
        self.pane
            .as_deref()
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    }

    /// The daemon or pane socket the owner was told about no longer answers:
    /// its Tern ended, so the inherited identity names nothing live.
    fn gone(&self) -> bool {
        [&self.socket, &self.pane_socket]
            .into_iter()
            .any(|s| s.as_deref().is_some_and(socket_dead))
    }
}

/// Parse a NUL-separated process environment block into a scope. The first
/// occurrence of a variable wins, as `getenv` does.
fn scope_from_environ(block: &[u8]) -> TernScope {
    let mut scope = TernScope {
        from_owner: true,
        ..TernScope::default()
    };
    for entry in block.split(|b| *b == 0) {
        let Ok(text) = std::str::from_utf8(entry) else {
            continue;
        };
        let Some((name, value)) = text.split_once('=') else {
            continue;
        };
        let slot = match name {
            "TERN_PANE" => &mut scope.pane,
            "TERN_WINDOW_KEY" => &mut scope.window_key,
            "TERN_DAEMON_SOCKET" => &mut scope.socket,
            "TERN_PANE_SOCKET" => &mut scope.pane_socket,
            "TERN_WINDOW_SOCKET" => &mut scope.window_socket,
            "TERN_CONFIG_DIR" => &mut scope.config_dir,
            "TERN_EXE" => &mut scope.exe,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(value.to_string());
        }
    }
    scope
}

/// The owner's environment block. Linux reads `/proc`; elsewhere there is no
/// way to read another process's environment (detection then falls back to a
/// reachable daemon and the default scope).
fn owner_environ(owner_pid: i32) -> Option<Vec<u8>> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read(format!("/proc/{owner_pid}/environ")).ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = owner_pid;
        None
    }
}

/// The Tern binary for this scope: the owner's own `TERN_EXE` when it is an
/// existing absolute file (matching the daemon version), else PATH.
fn tern_bin(scope: &TernScope) -> Option<PathBuf> {
    if let Some(exe) = scope.exe.as_deref() {
        let path = Path::new(exe);
        if path.is_absolute() && path.is_file() {
            return Some(path.to_path_buf());
        }
    }
    find_on_path("tern").and_then(|path| std::path::absolute(path).ok())
}

/// The variables omp resolves its home, profile, Collab registry and runtime
/// from. Only these are carried from the owner to `omp collab`; a variable the
/// owner lacks is removed, so the daemon's own profile cannot leak in.
const OMP_ENV: [&str; 11] = [
    "HOME",
    "PATH",
    "PI_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
];

/// The owner's omp executable and environment: what `omp collab list/link`
/// must run with to see the registry the owner's omp publishes to.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnerOmp {
    bin: PathBuf,
    /// Values for [`OMP_ENV`], in order; `None` removes the variable.
    env: [Option<String>; OMP_ENV.len()],
}

/// The first value of `name` in a NUL-separated environment block.
fn environ_value(block: &[u8], name: &str) -> Option<String> {
    block.split(|b| *b == 0).find_map(|entry| {
        let text = std::str::from_utf8(entry).ok()?;
        let (key, value) = text.split_once('=')?;
        (key == name).then(|| value.to_string())
    })
}

/// The omp executable of the owner: its own binary when that is `omp` (a
/// native build), else `omp` on the owner's PATH. A script runtime such as
/// Bun is never `omp`.
fn resolve_omp_bin(exe: Option<PathBuf>, owner_path: Option<&str>) -> Option<PathBuf> {
    if let Some(exe) = exe
        && exe.file_name().is_some_and(|n| n == "omp")
        && exe.is_file()
    {
        return Some(exe);
    }
    std::env::split_paths(owner_path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("omp"))
        .find(|candidate| candidate.is_file())
}

fn owner_omp(owner_pid: i32, block: &[u8]) -> Option<OwnerOmp> {
    let exe = std::fs::read_link(format!("/proc/{owner_pid}/exe")).ok();
    let path = environ_value(block, "PATH");
    let bin = resolve_omp_bin(exe, path.as_deref())?;
    Some(OwnerOmp {
        bin,
        env: std::array::from_fn(|i| environ_value(block, OMP_ENV[i])),
    })
}

// --- CLI --------------------------------------------------------------------

fn tern_command(scope: &TernScope, bin: &Path, args: &[&str]) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if scope.from_owner {
        // Exactly the owner's routing: a variable it lacks must not leak in
        // from the daemon's own environment.
        for (name, value) in [
            ("TERN_PANE", &scope.pane),
            ("TERN_WINDOW_KEY", &scope.window_key),
            ("TERN_DAEMON_SOCKET", &scope.socket),
            ("TERN_PANE_SOCKET", &scope.pane_socket),
            ("TERN_WINDOW_SOCKET", &scope.window_socket),
            ("TERN_CONFIG_DIR", &scope.config_dir),
            ("TERN_EXE", &scope.exe),
        ] {
            match value {
                Some(v) => cmd.env(name, v),
                None => cmd.env_remove(name),
            };
        }
    }
    cmd
}

/// Run a Tern CLI command scoped to the owner, returning bounded stdout.
async fn tern(scope: &TernScope, bin: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = tern_command(scope, bin, args)
        .spawn()
        .map_err(|_| "Tern is not runnable".to_string())?;
    let Some(stdout) = child.stdout.take() else {
        return Err("Tern gave no output".to_string());
    };
    let run = async {
        let mut buf = Vec::new();
        stdout
            .take(MAX_CLI_OUTPUT as u64 + 1)
            .read_to_end(&mut buf)
            .await
            .map_err(|_| "Tern output could not be read".to_string())?;
        if buf.len() > MAX_CLI_OUTPUT {
            return Err("Tern output was larger than omp-pulse will read".to_string());
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "Tern did not finish".to_string())?;
        Ok((status, buf))
    };
    let (status, buf) = tokio::time::timeout(RPC_TIMEOUT, run)
        .await
        .map_err(|_| "Tern did not answer in time".to_string())??;
    if !status.success() {
        return Err("Tern refused the request".to_string());
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// --- identity ---------------------------------------------------------------

/// `tern inspect --json`, narrowed to what identity needs; everything else
/// (transcripts, argv, geometry, clients) is skipped without allocating.
#[derive(Deserialize)]
struct RawInspection {
    panes: Vec<RawPane>,
}

#[derive(Deserialize)]
struct RawPane {
    pane: u64,
    omp_session_file: Option<String>,
    /// `null` while running, an exit status after.
    exited: Option<serde::de::IgnoredAny>,
}

struct InspectPane {
    pane: u64,
    session_file: Option<String>,
    exited: bool,
}

/// Parse `tern inspect --json`. Strict about every pane it reads: a pane that
/// cannot be understood might be the owner's, so it fails the whole read.
fn parse_inspection(raw: &str) -> Result<Vec<InspectPane>, String> {
    let parsed: RawInspection = serde_json::from_str(raw).map_err(|_| UNREADABLE.to_string())?;
    Ok(parsed
        .panes
        .into_iter()
        .map(|p| InspectPane {
            pane: p.pane,
            session_file: p.omp_session_file.filter(|f| !f.is_empty()),
            exited: p.exited.is_some(),
        })
        .collect())
}

/// `tern process PANE --json`: the pane it reports on, its root process and its
/// foreground process.
#[derive(Deserialize)]
struct RawProcess {
    pane: u64,
    child: Option<RawPid>,
    foreground: Option<RawPid>,
}

#[derive(Deserialize)]
struct RawPid {
    pid: i64,
}

/// The pane's root and foreground processes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PaneProcess {
    child: Option<i32>,
    foreground: Option<i32>,
}

/// Parse `tern process PANE --json`, requiring it to report the pane asked.
fn parse_process(raw: &str, pane: u64) -> Result<PaneProcess, String> {
    let parsed: RawProcess = serde_json::from_str(raw).map_err(|_| UNREADABLE.to_string())?;
    let pid = |p: Option<RawPid>| -> Result<Option<i32>, String> {
        p.map(|p| {
            i32::try_from(p.pid)
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| UNREADABLE.to_string())
        })
        .transpose()
    };
    let process = PaneProcess {
        child: pid(parsed.child)?,
        foreground: pid(parsed.foreground)?,
    };
    if parsed.pane != pane || (process.child.is_none() && process.foreground.is_none()) {
        return Err(UNREADABLE.to_string());
    }
    Ok(process)
}

/// The owner IS the pane's root or foreground process.
fn direct_owner(owner_pid: i32, process: &PaneProcess) -> bool {
    process.child == Some(owner_pid) || process.foreground == Some(owner_pid)
}

/// The owner descends from the pane's root or foreground process (omp
/// launched through a wrapper). `chain` is the owner's ancestor chain.
fn descends_from_pane(chain: &HashSet<i32>, process: &PaneProcess) -> bool {
    [process.child, process.foreground]
        .into_iter()
        .flatten()
        .any(|root| chain.contains(&root))
}

async fn owner_in_pane(owner_pid: i32, process: PaneProcess) -> bool {
    if direct_owner(owner_pid, &process) {
        return true;
    }
    match tokio::task::spawn_blocking(move || owner_ancestors(owner_pid)).await {
        Ok(chain) => descends_from_pane(&chain, &process),
        Err(_) => false,
    }
}

/// True when both paths resolve, canonically, to the same file.
fn same_session_file(a: &str, b: &str) -> bool {
    matches!(
        (std::fs::canonicalize(a), std::fs::canonicalize(b)),
        (Ok(a), Ok(b)) if a == b
    )
}

/// Decide the owner's pane from `(pane, owner proven)` for every pane that
/// shows this session file. No pane showing the file: it is not Tern's. A
/// pane showing the file without the owner behind it, or several panes with
/// the owner behind them, is ambiguous and refused rather than guessed.
fn decide_owner(candidates: &[(u64, bool)]) -> Result<Option<u64>, String> {
    if candidates.is_empty() {
        return Ok(None);
    }
    let mut proven = candidates
        .iter()
        .filter(|(_, owned)| *owned)
        .map(|(pane, _)| *pane);
    match (proven.next(), proven.next()) {
        (Some(pane), None) => Ok(Some(pane)),
        (None, _) => Err(
            "a Tern pane shows this conversation but its process is not the one that owns it, so omp-pulse will not send into it"
                .to_string(),
        ),
        (Some(_), Some(_)) => Err(
            "more than one Tern pane claims this conversation, so omp-pulse will not choose between them"
                .to_string(),
        ),
    }
}

/// Locate the owner's pane: the exact canonical session file AND the owner
/// pid, both proven now. `None`: no pane shows this session file.
async fn locate(
    scope: &TernScope,
    bin: &Path,
    session_path: &str,
    owner_pid: i32,
) -> Result<Option<u64>, String> {
    let mut verdicts = Vec::new();
    for pane in parse_inspection(&tern(scope, bin, &["inspect", "--json"]).await?)? {
        let Some(file) = pane.session_file else {
            continue;
        };
        if pane.exited || !same_session_file(&file, session_path) {
            continue;
        }
        let id = pane.pane.to_string();
        let raw = tern(scope, bin, &["process", &id, "--json"]).await?;
        let process = parse_process(&raw, pane.pane)?;
        verdicts.push((pane.pane, owner_in_pane(owner_pid, process).await));
    }
    decide_owner(&verdicts)
}

// --- discovery --------------------------------------------------------------

/// Everything environment-dependent about one Tern installation, so tests can
/// aim the same code at a fixture.
#[derive(Debug, Clone)]
struct TernTarget {
    bin: PathBuf,
    scope: TernScope,
    /// The owner's omp executable and environment, which `omp collab` runs with
    /// (never the daemon's). `None`: unresolved on Linux, which refuses; off
    /// Linux the owner's environment is unreadable and the daemon's own
    /// discovery is used.
    owner_omp: Option<OwnerOmp>,
}

const NO_OWNER_OMP: &str = "omp-pulse could not find the omp executable of this Tern pane, so it cannot read the conversation's Collab state";
const NO_HOST: &str = "this Tern conversation has no active native Collab host (Collab autostart in omp would start one with the conversation)";
const PANE_CHANGED: &str =
    "the Tern pane that showed this conversation changed while its Collab host was being read";

/// The owner's active native Collab host for this exact session, and its
/// control link. Reads the owner's own omp registry only.
async fn discover_host(
    target: &TernTarget,
    session_id: &str,
    owner_pid: i32,
) -> Result<String, String> {
    let env: [(&'static str, Option<&str>); OMP_ENV.len()];
    let cli = match &target.owner_omp {
        Some(omp) => {
            env = std::array::from_fn(|i| (OMP_ENV[i], omp.env[i].as_deref()));
            Some(OwnerCli {
                bin: &omp.bin,
                env: &env,
            })
        }
        // The owner's environment is unreadable off Linux: the daemon's own discovery.
        None if !cfg!(target_os = "linux") => None,
        None => return Err(NO_OWNER_OMP.to_string()),
    };
    match discover(session_id, Some(owner_pid), cli).await {
        Discovery::Link(link) => validated_native_link(link),
        Discovery::NoHost => Err(NO_HOST.to_string()),
        Discovery::Refused(reason) => Err(reason.to_string()),
    }
}

/// Adopt through a resolved Tern target. See the module docs for the
/// `Ok(None)` / `Err` contract.
async fn adopt_with_target(
    target: TernTarget,
    session_path: &str,
    owner_pid: i32,
) -> Result<Option<String>, String> {
    let pane = match locate(&target.scope, &target.bin, session_path, owner_pid).await {
        Ok(Some(pane)) => pane,
        Ok(None) => return Ok(None),
        // Tern ended, or this owner was never in a Tern pane: nothing here
        // can be the owner's pane.
        Err(_) if !target.scope.in_pane() || target.scope.gone() => return Ok(None),
        Err(e) => return Err(e),
    };
    // A Tern owner matched: from here every failure is a refusal. The host is
    // read from the owner's own omp registry, so both its session id and its
    // executable must be known first.
    if cfg!(target_os = "linux") && target.owner_omp.is_none() {
        return Err(NO_OWNER_OMP.to_string());
    }
    let Some(session_id) = crate::sessions::jsonl::parse_header(Path::new(session_path)).id else {
        return Err(
            "this conversation's file has no session id, so its Collab host cannot be identified"
                .to_string(),
        );
    };
    let found = discover_host(&target, &session_id, owner_pid).await;
    // Whatever discovery said (a link or a refusal), it only counts for the
    // pane that still shows this file behind this owner.
    match locate(&target.scope, &target.bin, session_path, owner_pid).await? {
        Some(now) if now == pane => found.map(Some),
        _ => Err(PANE_CHANGED.to_string()),
    }
}

/// Native Tern discovery for the session's owner. `Ok(None)`: no Tern pane
/// belongs to this owner, the legacy backends may try. `Ok(Some(link))`: the
/// owner's active native host. `Err`: Tern owns the pane and the host is
/// missing, unshared or refused — the caller must surface it, never type raw
/// keys instead.
pub(super) async fn adopt_via_tern(
    session_path: &str,
    owner_pid: Option<i32>,
) -> Result<Option<String>, String> {
    let Some(owner_pid) = owner_pid else {
        return Ok(None);
    };
    let (scope, owner_omp) = match owner_environ(owner_pid) {
        Some(block) => (scope_from_environ(&block), owner_omp(owner_pid, &block)),
        None if cfg!(target_os = "linux") => return Ok(None),
        None => (TernScope::default(), None),
    };
    if cfg!(target_os = "linux") && !scope.in_pane() {
        return Ok(None);
    }
    let Some(bin) = tern_bin(&scope) else {
        return Ok(None);
    };
    adopt_with_target(
        TernTarget {
            bin,
            scope,
            owner_omp,
        },
        session_path,
        owner_pid,
    )
    .await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    const SESSION_ID: &str = "session-under-test";
    const HOST_ID: &str = "host-aaaa";

    /// A scripted `tern` binary over fixture files.
    const FAKE_TERN: &str = r#"#!/bin/sh
d=$(dirname "$0")
case "$1" in
  inspect) [ -f "$d/inspect.fail" ] && exit 1; cat "$d/inspect.json" ;;
  process) cat "$d/process.json" ;;
  *) exit 1 ;;
esac
exit 0
"#;

    /// A scripted owner `omp`: the Collab registry as the owner's omp reports
    /// it. Once a link is requested the pane can be made to show another
    /// session.
    const FAKE_OMP: &str = r#"#!/bin/sh
d=$(dirname "$0")
case "$1 $2" in
  "collab list") cat "$d/collab-list.json" ;;
  "collab link")
    cat "$d/collab-link.json"
    if [ -f "$d/swap-after-link" ]; then cp "$d/inspect.other.json" "$d/inspect.json"; fi
    ;;
  *) exit 1 ;;
esac
exit 0
"#;

    fn owner() -> i32 {
        std::process::id() as i32
    }

    fn link() -> String {
        format!(
            "wss://localhost:7682/r/ABCDEFGHIJKLMNOPQRSTUV.{}",
            "A".repeat(64)
        )
    }

    struct Fixture {
        dir: PathBuf,
        pane: u64,
        _daemon: UnixListener,
        _pane_listener: UnixListener,
    }

    impl Fixture {
        fn new() -> Self {
            // Darwin's long temp roots leave little of its 104-byte socket address limit.
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = crate::paths::testenv::scratch(&format!("tern-{id}"));
            let daemon = UnixListener::bind(dir.join("daemon.sock")).unwrap();
            let pane_listener = UnixListener::bind(dir.join("pane.sock")).unwrap();
            let fixture = Fixture {
                dir,
                pane: (1u64 << 32) + u64::from(rand::random::<u32>()),
                _daemon: daemon,
                _pane_listener: pane_listener,
            };
            for (name, script) in [("tern", FAKE_TERN), ("omp", FAKE_OMP)] {
                fixture.write(name, script);
                std::fs::set_permissions(
                    fixture.path(name),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap();
            }
            fixture.write(
                "session.jsonl",
                &format!("{{\"type\":\"session\",\"id\":\"{SESSION_ID}\",\"cwd\":\"/\"}}\n"),
            );
            fixture.write("other.jsonl", "{}\n");
            fixture.set_inspect("session.jsonl", false, "inspect.json");
            fixture.set_inspect("other.jsonl", false, "inspect.other.json");
            fixture.set_process(owner(), owner());
            fixture.set_hosts(&[]);
            fixture
        }

        fn path(&self, name: &str) -> PathBuf {
            self.dir.join(name)
        }

        fn write(&self, name: &str, content: &str) {
            std::fs::write(self.path(name), content).unwrap();
        }

        fn session(&self) -> String {
            self.path("session.jsonl").to_str().unwrap().to_string()
        }

        /// `tern inspect --json` showing `file` in the pane.
        fn set_inspect(&self, file: &str, exited: bool, into: &str) {
            let body = json!({
                "sessions": [], "detached": [],
                "clients": [{"conn": 1, "window": "", "kind": "window", "since": 1}],
                "panes": [{
                    "pane": self.pane,
                    "omp_session_file": self.path(file).to_str().unwrap(),
                    "exited": if exited { json!(1) } else { serde_json::Value::Null },
                }],
            });
            self.write(into, &body.to_string());
        }

        fn set_process(&self, child: i32, foreground: i32) {
            self.write(
                "process.json",
                &json!({
                    "pane": self.pane, "group": 1,
                    "child": {"pid": child, "name": "omp", "argv": [], "cwd": "/"},
                    "foreground": {"pid": foreground, "name": "omp", "argv": [], "cwd": "/"},
                })
                .to_string(),
            );
        }

        /// The owner omp's Collab registry: `(instance, session, access)` rows,
        /// each at generation 4, plus the link its capability request returns.
        fn set_hosts(&self, rows: &[(&str, &str, &str)]) {
            let hosts: Vec<_> = rows
                .iter()
                .map(|(id, session, access)| {
                    json!({"instanceId": id, "generation": 4, "pid": owner(),
                           "sessionId": session, "access": access})
                })
                .collect();
            self.write(
                "collab-list.json",
                &json!({"version": 1, "hosts": hosts}).to_string(),
            );
            self.set_link_generation(4);
        }

        fn set_link_generation(&self, generation: u64) {
            self.write(
                "collab-link.json",
                &json!({"version": 1, "instanceId": HOST_ID, "generation": generation,
                        "access": "control", "url": link()})
                .to_string(),
            );
        }

        fn target(&self) -> TernTarget {
            TernTarget {
                bin: self.path("tern"),
                scope: TernScope {
                    from_owner: true,
                    pane: Some(self.pane.to_string()),
                    window_key: Some(String::new()),
                    socket: Some(self.path("daemon.sock").to_str().unwrap().to_string()),
                    pane_socket: Some(self.path("pane.sock").to_str().unwrap().to_string()),
                    window_socket: None,
                    config_dir: Some("/tmp/tern-test-config".to_string()),
                    exe: None,
                },
                owner_omp: Some(OwnerOmp {
                    bin: self.path("omp"),
                    env: std::array::from_fn(|i| match OMP_ENV[i] {
                        "HOME" => Some("/tmp/owner-home".to_string()),
                        _ => None,
                    }),
                }),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    // --- environment, parsing and proofs -----------------------------------------

    #[test]
    fn environ_scope_keeps_the_first_value_and_needs_a_numeric_pane() {
        let scope = scope_from_environ(
            b"PATH=/bin\0TERN_PANE=4294967299\0TERN_PANE=7\0TERN_WINDOW_KEY=\0TERN_DAEMON_SOCKET=/run/d.sock\0TERN_PANE_SOCKET=/run/p.sock\0TERN_WINDOW_SOCKET=/run/w.sock\0TERN_CONFIG_DIR=/c\0TERN_EXE=/opt/tern\0",
        );
        assert!(scope.from_owner && scope.in_pane());
        assert_eq!(scope.pane.as_deref(), Some("4294967299"));
        assert_eq!(scope.window_key.as_deref(), Some(""));
        assert_eq!(scope.socket.as_deref(), Some("/run/d.sock"));
        assert_eq!(scope.pane_socket.as_deref(), Some("/run/p.sock"));
        assert_eq!(scope.window_socket.as_deref(), Some("/run/w.sock"));
        assert_eq!(scope.exe.as_deref(), Some("/opt/tern"));
        for bad in [
            &b"TERN_PANE=\0"[..],
            b"TERN_PANE=%3\0",
            b"TERN_PANE=1x\0",
            b"",
        ] {
            assert!(!scope_from_environ(bad).in_pane());
        }
    }

    #[test]
    fn unreachable_socket_addresses_mean_tern_is_gone_for_that_owner() {
        let f = Fixture::new();
        let mut scope = f.target().scope;
        assert!(!scope.gone());
        // Concurrent subprocess forks can retain a listener until exec after
        // our handle drops. Unlink its address to make reachability deterministic.
        std::fs::remove_file(f.path("pane.sock")).unwrap();
        assert!(scope.gone());
        scope.pane_socket = None;
        assert!(!scope.gone());
        std::fs::remove_file(f.path("daemon.sock")).unwrap();
        assert!(scope.gone());
    }

    #[test]
    fn the_owners_omp_comes_from_its_own_path_and_is_never_a_script_runtime() {
        let f = Fixture::new();
        let dir = f.dir.to_str().unwrap();
        let block = format!("PATH=/nowhere:relative/bin:{dir}\0");
        let Some(omp) = owner_omp(owner(), block.as_bytes()) else {
            panic!("the fixture omp is on the owner's PATH");
        };
        assert_eq!(omp.bin, f.path("omp"));
        // Nothing on its PATH: unresolved, never guessed from the daemon.
        assert_eq!(owner_omp(owner(), b"PATH=/nowhere\0"), None);

        // A native owner binary is itself; an interpreter is not omp.
        let exe = f.path("omp");
        assert_eq!(resolve_omp_bin(Some(exe.clone()), None), Some(exe));
        assert_eq!(resolve_omp_bin(Some(f.path("tern")), None), None);
        assert_eq!(
            resolve_omp_bin(Some(f.path("tern")), Some(dir)),
            Some(f.path("omp"))
        );
        assert_eq!(resolve_omp_bin(None, Some("relative")), None);
    }

    #[test]
    fn inspection_reads_panes_and_rejects_malformed_metadata() {
        let ok = parse_inspection(
            r#"{"clients":[{"kind":"window","window":""},{"kind":"cli"}],
                "panes":[{"pane":4294967299,"omp_session_file":"/s/a.jsonl","exited":null,"argv":["x"],"title":"t"},
                         {"pane":5,"omp_session_file":null,"exited":0},
                         {"pane":6,"omp_session_file":""}]}"#,
        )
        .unwrap();
        assert_eq!(ok[0].pane, 4294967299);
        assert_eq!(ok[0].session_file.as_deref(), Some("/s/a.jsonl"));
        assert!(!ok[0].exited && ok[1].exited);
        assert_eq!(ok[2].session_file, None);
        for malformed in [
            "",
            "[]",
            r#"{"panes":{}}"#,
            r#"{"panes":[{"omp_session_file":"/s"}]}"#,
            r#"{"panes":[{"pane":"7"}]}"#,
            r#"{"panes":[{"pane":7,"omp_session_file":5}]}"#,
        ] {
            assert!(parse_inspection(malformed).is_err(), "{malformed}");
        }
    }

    #[test]
    fn process_report_must_describe_the_asked_pane_and_carry_a_pid() {
        let p = parse_process(
            r#"{"pane":9,"child":{"pid":10,"argv":["omp"]},"foreground":{"pid":11}}"#,
            9,
        )
        .unwrap();
        assert_eq!((p.child, p.foreground), (Some(10), Some(11)));
        for bad in [
            r#"{"pane":8,"child":{"pid":10}}"#,
            r#"{"child":{"pid":10}}"#,
            r#"{"pane":9}"#,
            r#"{"pane":9,"child":{"pid":"10"}}"#,
            r#"{"pane":9,"child":{"pid":-4}}"#,
            "nope",
        ] {
            assert!(parse_process(bad, 9).is_err(), "{bad}");
        }
    }

    #[test]
    fn owner_is_proven_directly_or_by_descending_from_the_pane_process() {
        let process = PaneProcess {
            child: Some(100),
            foreground: Some(200),
        };
        assert!(direct_owner(100, &process) && direct_owner(200, &process));
        assert!(!direct_owner(300, &process));
        let chain: HashSet<i32> = [300, 250, 100, 1].into_iter().collect();
        assert!(descends_from_pane(&chain, &process));
        let stranger: HashSet<i32> = [300, 250, 7, 1].into_iter().collect();
        assert!(!descends_from_pane(&stranger, &process));
    }

    #[test]
    fn only_the_same_canonical_file_counts_as_the_session() {
        let f = Fixture::new();
        let real = f.session();
        std::os::unix::fs::symlink(&real, f.path("link.jsonl")).unwrap();
        let p = |name: &str| f.path(name).to_str().unwrap().to_string();
        assert!(same_session_file(&real, &p("link.jsonl")));
        assert!(!same_session_file(&real, &p("other.jsonl")));
        assert!(!same_session_file(&real, &p("missing.jsonl")));
        assert!(!same_session_file(&p("missing.jsonl"), &p("missing.jsonl")));
    }

    #[test]
    fn unproven_or_ambiguous_candidates_are_refused_not_guessed() {
        assert_eq!(decide_owner(&[]), Ok(None));
        assert_eq!(decide_owner(&[(7, true)]), Ok(Some(7)));
        assert_eq!(decide_owner(&[(7, false), (8, true)]), Ok(Some(8)));
        assert!(decide_owner(&[(7, false)]).is_err());
        assert!(decide_owner(&[(7, true), (8, true)]).is_err());
    }

    // --- discovery against a scripted tern and omp -------------------------------------

    #[tokio::test]
    async fn locating_proves_the_exact_file_and_the_owner_pid() {
        let f = Fixture::new();
        let t = f.target();
        let found = locate(&t.scope, &t.bin, &f.session(), owner())
            .await
            .unwrap();
        assert_eq!(found, Some(f.pane));

        // Another session file in that pane is not this owner's.
        let other = f.path("other.jsonl");
        let none = locate(&t.scope, &t.bin, other.to_str().unwrap(), owner())
            .await
            .unwrap();
        assert_eq!(none, None);

        // Right file, but the pane's processes are not the owner: refused, not skipped.
        f.set_process(i32::MAX - 7, i32::MAX - 7);
        assert!(
            locate(&t.scope, &t.bin, &f.session(), owner())
                .await
                .is_err()
        );

        // An exited pane never matches.
        f.set_process(owner(), owner());
        f.set_inspect("session.jsonl", true, "inspect.json");
        assert_eq!(
            locate(&t.scope, &t.bin, &f.session(), owner())
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn the_owner_may_descend_from_the_pane_process() {
        let f = Fixture::new();
        let t = f.target();
        // omp launched through a wrapper: the pane's root is an ancestor of the owner.
        let parent = owner_ancestors(owner())
            .into_iter()
            .find(|p| *p != owner() && *p > 1)
            .expect("test process has an ancestor");
        f.set_process(parent, parent);
        let found = locate(&t.scope, &t.bin, &f.session(), owner())
            .await
            .unwrap();
        assert_eq!(found, Some(f.pane));
    }

    #[tokio::test]
    async fn an_unrelated_session_is_none_and_nothing_is_discovered() {
        let f = Fixture::new();
        let other = f.path("other.jsonl");
        let got = adopt_with_target(f.target(), other.to_str().unwrap(), owner()).await;
        assert_eq!(got, Ok(None));
        // Without an owner pid there is nothing to prove, so nothing is Tern's.
        assert_eq!(adopt_via_tern(&f.session(), None).await, Ok(None));
    }

    #[tokio::test]
    async fn unreachable_tern_is_none_only_without_live_tern_evidence() {
        let f = Fixture::new();
        f.write("inspect.fail", "");
        // Owner in a Tern pane whose sockets answer: authoritative error.
        assert!(
            adopt_with_target(f.target(), &f.session(), owner())
                .await
                .is_err()
        );
        // Never in a Tern pane at all.
        let mut outside = f.target();
        outside.scope.pane = None;
        assert_eq!(
            adopt_with_target(outside, &f.session(), owner()).await,
            Ok(None)
        );
        // The pane socket disappeared: this inherited address names nothing live.
        std::fs::remove_file(f.path("pane.sock")).unwrap();
        assert_eq!(
            adopt_with_target(f.target(), &f.session(), owner()).await,
            Ok(None)
        );
        // So is a daemon socket that no longer exists.
        let mut gone = f.target();
        gone.scope.pane_socket = None;
        gone.scope.socket = Some(f.path("gone.sock").to_str().unwrap().to_string());
        assert_eq!(
            adopt_with_target(gone, &f.session(), owner()).await,
            Ok(None)
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn an_owner_whose_omp_cannot_be_found_is_refused_before_anything_is_discovered() {
        let f = Fixture::new();
        let mut target = f.target();
        target.owner_omp = None;
        assert!(
            adopt_with_target(target, &f.session(), owner())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn the_link_is_the_owners_registry_host_for_exactly_this_session() {
        let f = Fixture::new();

        // No active host for this session (another session's host does not
        // count): a refusal that tells the user how to start one, never `None`.
        f.set_hosts(&[("host-bbbb", "another-session", "control")]);
        let Err(error) = adopt_with_target(f.target(), &f.session(), owner()).await else {
            panic!("a Tern owner without a host must be refused");
        };
        assert!(error.contains("autostart"), "{error}");

        // The exact session's host: its link, read with the OWNER's environment.
        f.set_hosts(&[
            ("host-bbbb", "another-session", "control"),
            (HOST_ID, SESSION_ID, "control"),
        ]);
        assert_eq!(
            adopt_with_target(f.target(), &f.session(), owner()).await,
            Ok(Some(link()))
        );

        // The capability no longer matches the listed generation: refused, not taken.
        f.set_link_generation(5);
        assert!(
            adopt_with_target(f.target(), &f.session(), owner())
                .await
                .is_err()
        );

        // A view-only host is never upgraded.
        f.set_hosts(&[(HOST_ID, SESSION_ID, "view")]);
        assert!(
            adopt_with_target(f.target(), &f.session(), owner())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn the_link_is_proven_before_and_after_the_registry_is_asked() {
        let f = Fixture::new();
        f.set_hosts(&[(HOST_ID, SESSION_ID, "control")]);
        assert!(
            adopt_with_target(f.target(), &f.session(), owner())
                .await
                .is_ok()
        );
        // The pane switches to another session while the link is being requested.
        f.write("swap-after-link", "");
        assert!(
            adopt_with_target(f.target(), &f.session(), owner())
                .await
                .is_err()
        );
    }
}
