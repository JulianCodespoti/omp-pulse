//! Phone → laptop handoff: open a conversation in a new herdr tab on the laptop.
//!
//! WHY: a conversation driven from the phone runs in the daemon's own
//! `omp --mode rpc` child, which has no screen, and an old conversation runs
//! nowhere. Following either at the laptop meant finding the session there and
//! `omp --resume`-ing it by hand. `POST /api/desktop/open` does it from the
//! phone: it starts the user's own omp TUI on the session inside herdr, where
//! the omp-pulse extension bridges it straight back, so the phone keeps
//! streaming and sending while the laptop shows the same conversation.
//!
//! Layout: one conversation per tab, in workspaces labelled `Pulse mobile`,
//! `Pulse mobile 2`, … of at most [`TABS_PER_WORKSPACE`] tabs each; when all
//! are full the next one is created. The layout is read back from herdr's
//! `workspace list` on every call rather than remembered, so closing a tab on
//! the laptop frees its slot, a renamed workspace simply stops being ours, and
//! nothing here survives a restart that could disagree with herdr. Nothing is
//! focused: whoever is at the laptop keeps what they are looking at.
//!
//! INVARIANT: one writer. The TUI is launched only when no other process owns
//! the file and our own RPC child for it has EXITED, not merely been signalled
//! (omp flushes the session on SIGTERM). While a handoff is in flight,
//! `ChildManager::do_open` refuses to spawn a child for the path
//! ([`in_progress`]), so a retried phone send cannot slip a second writer into
//! the gap between our child exiting and the TUI taking the file.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tracing::{info, warn};

use crate::server::http::AppState;

/// Label of the first handoff workspace; the next ones append ` 2`, ` 3`, ….
pub const WORKSPACE_LABEL: &str = "Pulse mobile";
/// Tabs a handoff workspace holds before the next workspace is opened.
pub const TABS_PER_WORKSPACE: u64 = 4;
/// Longest tab label. herdr's tab strip truncates on its own, but one
/// 200-character title would still push every sibling tab out of view.
const TAB_LABEL_MAX: usize = 32;
/// Bound on the quick herdr calls (list, create, rename, get, close).
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// herdr's own wait for the TUI to become interactive (`agent start
/// --timeout`, ms). omp with a large MCP server set measured ~3 s.
const AGENT_READY_MS: &str = "30000";
/// Our bound around `agent start`: herdr's wait plus headroom, so herdr
/// reports its own verdict instead of us killing the CLI mid-answer.
const AGENT_START_TIMEOUT: Duration = Duration::from_secs(40);
/// How long our RPC child gets to flush and exit after SIGTERM.
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Grace period for an idle laptop omp TUI to honor its owner's shutdown request.
const OWNER_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long to wait for the new TUI's extension to bridge back. The TUI
/// works without it (the listing still sees the owner through argv/fds), so
/// this only decides what the response reports.
const BRIDGE_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(100);

/// Serialize handoffs: opens mutate the layout and closes must not race a
/// new phone child while the laptop owner is exiting.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Sessions mid-handoff. See the module INVARIANT; idle-close holds this until
/// the original desktop owner has exited.
static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// True while a session is changing owners; no daemon child may spawn until
/// the handoff releases its claim.
pub fn in_progress(session: &str) -> bool {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(session)
}

/// Holds a session in [`IN_FLIGHT`] for the lifetime of one handoff, so every
/// exit path (success, refusal, panic) releases it exactly once.
struct Claim(String);

impl Claim {
    fn new(session: &str) -> Self {
        IN_FLIGHT
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session.to_string());
        Claim(session.to_string())
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        IN_FLIGHT
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.0);
    }
}

/// Why a handoff did not happen: a stable `code` for clients and a sentence
/// the phone can show as it is.
#[derive(Debug)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

fn refusal(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        message: message.into(),
    }
}

/// Where the conversation landed.
#[derive(Debug)]
pub struct Opened {
    pub workspace_id: String,
    pub workspace_label: String,
    pub created_workspace: bool,
    pub tab_id: String,
    pub tab_label: String,
    pub tab_number: Option<u64>,
    pub pane_id: String,
    /// herdr saw omp reach its interactive prompt. False when omp started but
    /// is still booting or is waiting on a dialog at the laptop.
    pub ready: bool,
    /// The TUI's omp-pulse extension connected back, so the phone drives it
    /// through the bridge from the next send on.
    pub bridged: bool,
}

impl Opened {
    pub fn to_json(&self) -> Value {
        json!({
            "ok": true,
            "workspace": {
                "id": self.workspace_id,
                "label": self.workspace_label,
                "created": self.created_workspace,
            },
            "tab": { "id": self.tab_id, "label": self.tab_label, "number": self.tab_number },
            "pane": self.pane_id,
            "ready": self.ready,
            "bridged": self.bridged,
        })
    }
}

/// A laptop omp TUI whose owner accepted graceful shutdown and exited. The
/// Herdr shell pane and workspace intentionally remain open.
#[derive(Debug)]
pub struct Closed {
    pub pane_id: String,
}

impl Closed {
    pub fn to_json(&self) -> Value {
        json!({
            "ok": true,
            "closed": true,
            "processExited": true,
            "historyPreserved": true,
            "herdrPane": { "id": self.pane_id, "leftOpen": true },
        })
    }
}

// --- Slot planning (pure) ----------------------------------------------------

/// One workspace as `herdr workspace list` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub id: String,
    pub label: String,
    pub tabs: u64,
}

/// Where the next tab goes.
#[derive(Debug, PartialEq, Eq)]
pub enum Slot {
    Existing { id: String, label: String },
    New { label: String },
}

/// Position of a label in the handoff series: `Pulse mobile` is 1,
/// `Pulse mobile 7` is 7, anything else (including the owner's own
/// `omp-pulse` workspace) is not ours.
fn series_index(label: &str) -> Option<u64> {
    if label == WORKSPACE_LABEL {
        return Some(1);
    }
    let digits = label.strip_prefix(WORKSPACE_LABEL)?.strip_prefix(' ')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|n| *n >= 2)
}

fn series_label(n: u64) -> String {
    if n == 1 {
        WORKSPACE_LABEL.to_string()
    } else {
        format!("{WORKSPACE_LABEL} {n}")
    }
}

/// The earliest handoff workspace with room, else the lowest free label in
/// the series. Earliest-first means tabs closed in `Pulse mobile` are
/// refilled before `Pulse mobile 2` grows, so the set stays compact.
pub fn plan_slot(workspaces: &[Workspace]) -> Slot {
    let mut ours: Vec<(u64, &Workspace)> = workspaces
        .iter()
        .filter_map(|w| series_index(&w.label).map(|n| (n, w)))
        .collect();
    ours.sort_by_key(|(n, _)| *n);
    if let Some((_, w)) = ours.iter().find(|(_, w)| w.tabs < TABS_PER_WORKSPACE) {
        return Slot::Existing {
            id: w.id.clone(),
            label: w.label.clone(),
        };
    }
    let taken: HashSet<u64> = ours.iter().map(|(n, _)| *n).collect();
    let n = (1..).find(|n| !taken.contains(n)).unwrap_or(1);
    Slot::New {
        label: series_label(n),
    }
}

/// `herdr workspace list` → workspaces. Entries missing an id or label are
/// skipped; a missing tab count reads as full, so an entry herdr describes
/// incompletely is never handed more tabs than it can hold.
pub fn parse_workspaces(raw: &Value) -> Vec<Workspace> {
    raw.pointer("/result/workspaces")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|w| {
                    Some(Workspace {
                        id: w.get("workspace_id")?.as_str()?.to_string(),
                        label: w.get("label")?.as_str()?.to_string(),
                        tabs: w
                            .get("tab_count")
                            .and_then(Value::as_u64)
                            .unwrap_or(TABS_PER_WORKSPACE),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A tab label from a session title: one line, bounded, never empty.
pub fn tab_label(title: Option<&str>) -> String {
    let flat: String = title
        .unwrap_or_default()
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if flat.is_empty() {
        return "Untitled session".to_string();
    }
    if flat.chars().count() <= TAB_LABEL_MAX {
        return flat;
    }
    let cut: String = flat.chars().take(TAB_LABEL_MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

/// A fresh herdr agent name (`[a-z][a-z0-9_-]{0,31}`). Names must be unique
/// among LIVE agents and nothing here addresses the agent by name afterwards
/// (pane ids are used throughout), so each launch gets its own: a reused name
/// would fail `agent_name_taken` whenever an older TUI still carried it.
fn agent_name(session: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::hash::DefaultHasher::new();
    session.hash(&mut h);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
        .hash(&mut h);
    format!("pulse-{:012x}", h.finish() & 0xffff_ffff_ffff)
}

// --- herdr calls -----------------------------------------------------------

/// A failed herdr call: herdr's own error code when it gave one
/// (`{"error":{"code","message"}}`), and the message to log or show.
#[derive(Debug)]
struct HerdrError {
    code: Option<String>,
    message: String,
}

fn herdr_error(raw: String) -> HerdrError {
    let parsed = serde_json::from_str::<Value>(&raw).ok();
    let err = parsed.as_ref().and_then(|v| v.get("error"));
    let code = err
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let message = err
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or(raw);
    HerdrError {
        code,
        message: if message.is_empty() {
            "herdr failed".to_string()
        } else {
            message
        },
    }
}

async fn herdr(bin: &Path, args: &[&str], timeout: Duration) -> Result<Value, HerdrError> {
    let out = crate::terminal::adopt::herdr_within(bin, args, timeout)
        .await
        .map_err(herdr_error)?;
    serde_json::from_str(&out).map_err(|e| HerdrError {
        code: None,
        message: format!("unreadable herdr reply: {e}"),
    })
}

/// Start only a confirmed stopped server. A protocol error or an unresponsive
/// live server is not permission to launch a replacement beside it.
async fn workspaces_or_start(bin: &Path) -> Result<Value, Refusal> {
    match herdr(bin, &["workspace", "list"], CALL_TIMEOUT).await {
        Ok(listed) => return Ok(listed),
        Err(e) if e.code.as_deref() == Some("server_not_running") => {}
        Err(e) => {
            return Err(refusal(
                "herdr_unreachable",
                format!("herdr on the computer did not answer: {}", e.message),
            ));
        }
    }

    let failed = |message: String| {
        refusal(
            "herdr_start_failed",
            format!(
                "Could not start herdr on the computer: {message}. The phone conversation was left running."
            ),
        )
    };
    let mut server = crate::terminal::herdr_startup::start(bin)
        .await
        .map_err(failed)?;
    let deadline = Instant::now() + CALL_TIMEOUT;
    let result = async {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(failed("its API did not become ready in time".to_string()));
            }
            match herdr(bin, &["workspace", "list"], remaining).await {
                Ok(listed) => return Ok(listed),
                Err(e) if e.code.as_deref() == Some("server_not_running") => {}
                Err(e) => return Err(failed(e.message)),
            }
            if let Some(status) = server.try_wait().map_err(|e| failed(e.to_string()))? {
                return Err(failed(format!("the server launcher exited ({status})")));
            }
            tokio::time::sleep(POLL.min(remaining)).await;
        }
    }
    .await;
    // Herdr owns the transferred TUI, not Pulse. Never kill it on an HTTP
    // timeout or daemon shutdown; the detached process is reaped while we live.
    tokio::spawn(async move {
        let _ = server.wait().await;
    });
    result
}

fn str_at(v: &Value, pointer: &str) -> Option<String> {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// A tab created for this handoff: what to report, and what to remove if omp
/// never starts in it.
struct Placed {
    workspace_id: String,
    workspace_label: String,
    created_workspace: bool,
    tab_id: String,
    tab_number: Option<u64>,
    pane_id: String,
}

async fn place(bin: &Path, slot: &Slot, cwd: &str, label: &str) -> Result<Placed, Refusal> {
    let failed = |what: &str, e: HerdrError| {
        refusal(
            "herdr_failed",
            format!("herdr could not {what} on the computer: {}", e.message),
        )
    };
    match slot {
        Slot::Existing {
            id,
            label: ws_label,
        } => {
            let v = herdr(
                bin,
                &[
                    "tab",
                    "create",
                    "--workspace",
                    id,
                    "--cwd",
                    cwd,
                    "--label",
                    label,
                    "--no-focus",
                ],
                CALL_TIMEOUT,
            )
            .await
            .map_err(|e| failed("open a tab", e))?;
            let (Some(tab_id), Some(pane_id)) = (
                str_at(&v, "/result/tab/tab_id"),
                str_at(&v, "/result/root_pane/pane_id"),
            ) else {
                return Err(refusal(
                    "herdr_failed",
                    "herdr opened a tab but did not say which one.",
                ));
            };
            Ok(Placed {
                workspace_id: id.clone(),
                workspace_label: ws_label.clone(),
                created_workspace: false,
                tab_id,
                tab_number: v.pointer("/result/tab/number").and_then(Value::as_u64),
                pane_id,
            })
        }
        Slot::New { label: ws_label } => {
            let v = herdr(
                bin,
                &[
                    "workspace",
                    "create",
                    "--cwd",
                    cwd,
                    "--label",
                    ws_label,
                    "--no-focus",
                ],
                CALL_TIMEOUT,
            )
            .await
            .map_err(|e| failed("create a workspace", e))?;
            let (Some(workspace_id), Some(tab_id), Some(pane_id)) = (
                str_at(&v, "/result/workspace/workspace_id"),
                str_at(&v, "/result/tab/tab_id"),
                str_at(&v, "/result/root_pane/pane_id"),
            ) else {
                return Err(refusal(
                    "herdr_failed",
                    "herdr created a workspace but did not say which one.",
                ));
            };
            // A new workspace's root tab is labelled "1"; name it for its
            // conversation like every tab after it. Cosmetic, so a failure is
            // logged, not fatal.
            if let Err(e) = herdr(bin, &["tab", "rename", &tab_id, label], CALL_TIMEOUT).await {
                warn!(tab = %tab_id, error = %e.message, "handoff: tab rename failed");
            }
            Ok(Placed {
                workspace_id,
                workspace_label: ws_label.clone(),
                created_workspace: true,
                tab_id,
                tab_number: v.pointer("/result/tab/number").and_then(Value::as_u64),
                pane_id,
            })
        }
    }
}

/// Remove what [`place`] made, when omp never started in it: an empty shell
/// tab named after a conversation would read as the conversation.
async fn unplace(bin: &Path, placed: &Placed) {
    let args: [&str; 3] = if placed.created_workspace {
        ["workspace", "close", placed.workspace_id.as_str()]
    } else {
        ["tab", "close", placed.tab_id.as_str()]
    };
    if let Err(e) = herdr(bin, &args, CALL_TIMEOUT).await {
        warn!(tab = %placed.tab_id, error = %e.message, "handoff: cleanup failed");
    }
}

/// True when herdr sees an omp agent in the pane. Distinguishes "omp is up
/// but not ready yet" (keep the tab) from "omp never started" (remove it)
/// after `agent start` fails.
async fn pane_runs_omp(bin: &Path, pane: &str) -> bool {
    herdr(bin, &["pane", "get", pane], CALL_TIMEOUT)
        .await
        .ok()
        .and_then(|v| str_at(&v, "/result/pane/agent"))
        .is_some_and(|a| a == "omp")
}

/// Resolve the one Herdr pane reporting this exact session and require an
/// authoritative idle/done state. The owner performs a second atomic idle
/// check before shutdown, so a turn starting after this snapshot is refused.
fn close_pane_for_session(agents: &Value, session: &str) -> Result<String, Refusal> {
    let entries = agents
        .pointer("/result/agents")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            refusal(
                "owner_unverified",
                "Herdr did not return a verifiable agent list. Nothing was closed.",
            )
        })?;
    let matches: Vec<_> = entries
        .iter()
        .filter(|agent| {
            agent.pointer("/agent_session/kind").and_then(Value::as_str) == Some("path")
                && agent
                    .pointer("/agent_session/value")
                    .and_then(Value::as_str)
                    == Some(session)
        })
        .collect();
    let [agent] = matches.as_slice() else {
        return Err(if matches.is_empty() {
            refusal(
                "not_on_laptop",
                "This conversation is not verified in a Herdr pane on the computer. Nothing was closed.",
            )
        } else {
            refusal(
                "owner_ambiguous",
                "More than one Herdr pane reports this conversation. Nothing was closed.",
            )
        });
    };
    if agent.get("agent").and_then(Value::as_str) != Some("omp") {
        return Err(refusal(
            "owner_unverified",
            "Herdr did not verify an omp owner for this conversation. Nothing was closed.",
        ));
    }
    let pane_id = agent
        .get("pane_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            refusal(
                "owner_unverified",
                "Herdr did not identify the owning pane. Nothing was closed.",
            )
        })?;
    let states = crate::terminal::herdr_state::agent_states(agents);
    let Some(pane_state) = states.get(pane_id) else {
        return Err(refusal(
            "agent_state_unknown",
            "Herdr cannot verify this session's current state. Nothing was closed.",
        ));
    };
    match pane_state.status {
        crate::terminal::herdr_state::HerdrStatus::Idle
        | crate::terminal::herdr_state::HerdrStatus::Done => Ok(pane_id.to_owned()),
        crate::terminal::herdr_state::HerdrStatus::Working
        | crate::terminal::herdr_state::HerdrStatus::Blocked => Err(refusal(
            "turn_running",
            "A reply is running or waiting for input. Let it finish before closing this computer session.",
        )),
        crate::terminal::herdr_state::HerdrStatus::Unknown => Err(refusal(
            "agent_state_unknown",
            "Herdr cannot confirm this session is idle. Nothing was closed.",
        )),
    }
}

// --- Ownership -------------------------------------------------------------

/// Anything other than our own child that holds or shows the conversation:
/// the bridge (an extension-carrying TUI, including one that `/resume`d and
/// so holds no fd), a collab room we joined, a herdr pane reporting it, or a
/// process the guard sees through the sidecar, argv or open fds.
fn held_elsewhere(state: &Arc<AppState>, session: &str) -> bool {
    crate::omp::bridge::live_pid(session).is_some()
        || state.collab.is_attached(session)
        || crate::terminal::herdr_state::pane_for_session_global(session).is_some()
        || crate::authority::guard::foreign_session_owner(session, &state.children.live_pids())
            .is_some()
}

/// True once `pid` is gone or a zombie (a zombie has closed its files; only
/// the reap by the child monitor remains).
fn process_exited(pid: i32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};
    let pid = Pid::from_u32(pid as u32);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    sys.process(pid)
        .is_none_or(|p| p.status() == ProcessStatus::Zombie)
}

/// Poll `done` every `POLL` until it holds or `within` elapses. Returns
/// whether the predicate became true; each call site keeps its own timeout
/// so the differing budgets (child exit vs owner exit vs bridge attach) are
/// unchanged.
async fn wait_until(within: Duration, done: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + within;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL).await;
    }
}

// --- The handoff -------------------------------------------------------------

/// Open the owner's omp TUI in herdr, starting a stopped server safely first.
/// Refuse busy/foreign-owned conversations before startup and never release
/// our phone child until herdr answers (module INVARIANT).
pub async fn open_in_herdr(
    state: &Arc<AppState>,
    session: &str,
    cwd: &Path,
) -> Result<Opened, Refusal> {
    let Some(bin) = crate::terminal::adopt::herdr_bin() else {
        return Err(refusal(
            "herdr_missing",
            "herdr is not installed on the computer, so there is nowhere to open this conversation.",
        ));
    };
    let _serial = SERIAL.lock().await;
    let _claim = Claim::new(session);
    // An open already in flight (a prewarm the phone fired when the composer
    // gained focus) must finish first: mid-boot our own child reads as a
    // foreign owner, and the claim above stops any new one from starting.
    state.children.settle_open(session).await;

    let already = || {
        refusal(
            "already_on_laptop",
            "This conversation is already open on the computer.",
        )
    };
    let movable = || {
        if held_elsewhere(state, session) {
            return Err(already());
        }
        if state.children.is_streaming(session) {
            return Err(refusal(
                "turn_running",
                "A reply is still being written. Let it finish, or stop it, then open it on the computer.",
            ));
        }
        Ok(())
    };
    movable()?;
    // A phone owner is never shut down for a laptop that cannot take it.
    let listed = workspaces_or_start(&bin).await?;
    movable()?;
    if let Some(pid) = state.children.pid_for(session) {
        state.children.close(session).await;
        if !wait_until(CHILD_EXIT_TIMEOUT, || process_exited(pid)).await {
            return Err(refusal(
                "child_busy",
                "The phone's copy of this conversation did not shut down in time. Try again in a moment.",
            ));
        }
    }
    // Our child is gone, so anything holding the file now is someone else.
    if held_elsewhere(state, session) {
        return Err(already());
    }

    let header = crate::sessions::jsonl::parse_header(Path::new(session));
    let label = tab_label(header.title.as_deref());
    let slot = plan_slot(&parse_workspaces(&listed));
    let cwd = cwd.to_string_lossy();
    let placed = place(&bin, &slot, &cwd, &label).await?;

    let name = agent_name(session);
    let started = herdr(
        &bin,
        &[
            "agent",
            "start",
            &name,
            "--kind",
            "omp",
            "--pane",
            &placed.pane_id,
            "--timeout",
            AGENT_READY_MS,
            "--",
            "--resume",
            session,
        ],
        AGENT_START_TIMEOUT,
    )
    .await;
    let ready = match started {
        Ok(_) => true,
        // `agent_not_ready` (a startup dialog) and timeouts can leave a
        // perfectly good TUI behind; only an empty pane means it failed.
        Err(e) if pane_runs_omp(&bin, &placed.pane_id).await => {
            warn!(%session, pane = %placed.pane_id, code = ?e.code, error = %e.message,
                "handoff: omp started but is not ready yet");
            false
        }
        Err(e) => {
            // What the pane printed is the only record of why omp did not
            // start (a shell error, a crash on launch): keep it in the log.
            let screen = crate::terminal::adopt::herdr_within(
                &bin,
                &[
                    "pane",
                    "read",
                    &placed.pane_id,
                    "--source",
                    "recent-unwrapped",
                    "--lines",
                    "12",
                ],
                CALL_TIMEOUT,
            )
            .await
            .unwrap_or_default();
            warn!(%session, pane = %placed.pane_id, code = ?e.code, error = %e.message,
                screen = %screen.trim(), "handoff: omp did not start; removing the tab");
            unplace(&bin, &placed).await;
            return Err(refusal(
                "launch_failed",
                format!("herdr could not start omp on the computer: {}", e.message),
            ));
        }
    };
    let bridged = wait_until(BRIDGE_WAIT, || {
        crate::omp::bridge::live_pid(session).is_some()
    })
    .await;
    crate::sessions::index::trigger_refresh(state);
    info!(%session, workspace = %placed.workspace_label, tab = %placed.tab_id,
        pane = %placed.pane_id, ready, bridged, "handoff: conversation opened on the computer");
    Ok(Opened {
        workspace_id: placed.workspace_id,
        workspace_label: placed.workspace_label,
        created_workspace: placed.created_workspace,
        tab_id: placed.tab_id,
        tab_label: label,
        tab_number: placed.tab_number,
        pane_id: placed.pane_id,
        ready,
        bridged,
    })
}

/// Close only the uniquely verified laptop omp owner for session. Herdr's
/// status and session-path report are authoritative preflight; the owner then
/// atomically rechecks idle before graceful shutdown. No Herdr pane/tab or
/// workspace is closed.
pub async fn close_in_herdr(state: &Arc<AppState>, session: &str) -> Result<Closed, Refusal> {
    let Some(bin) = crate::terminal::adopt::herdr_bin() else {
        return Err(refusal(
            "herdr_missing",
            "herdr is not installed on the computer, so this conversation's owner cannot be verified.",
        ));
    };
    let _serial = SERIAL.lock().await;
    let _claim = Claim::new(session);
    state.children.settle_open(session).await;

    if state.children.pid_for(session).is_some() {
        return Err(refusal(
            "owner_ambiguous",
            "The phone still has an omp process for this conversation. Nothing was closed.",
        ));
    }
    if state.collab.is_attached(session) {
        return Err(refusal(
            "owner_ambiguous",
            "This conversation is attached through collaboration, so its owner on the computer cannot be closed safely.",
        ));
    }

    let listed = herdr(&bin, &["agent", "list"], CALL_TIMEOUT)
        .await
        .map_err(|e| {
            if e.code.as_deref() == Some("server_not_running") {
                refusal(
                    "herdr_not_running",
                    "herdr is not running on the computer. Start it there, then try again.",
                )
            } else {
                refusal(
                    "herdr_unreachable",
                    format!("herdr on the computer did not answer: {}", e.message),
                )
            }
        })?;
    let pane_id = close_pane_for_session(&listed, session)?;

    let mut owners: Vec<_> = crate::omp::desktop_control::read_descriptors(&state.cfg.state_dir)
        .into_iter()
        .map(|(_, descriptor)| descriptor)
        .filter(|descriptor| descriptor.session_path == session && !process_exited(descriptor.pid))
        .collect();
    if owners.is_empty() {
        return Err(refusal(
            "owner_unverified",
            "This conversation has no live omp-pulse desktop owner. Nothing was closed.",
        ));
    }
    if owners.len() != 1 {
        return Err(refusal(
            "owner_ambiguous",
            "More than one live omp process reports this conversation. Nothing was closed.",
        ));
    }
    let owner = owners.pop().expect("one owner checked above");
    if !owner.has("close_if_idle") {
        return Err(refusal(
            "extension_unsupported",
            "This computer's omp-pulse extension does not support safe idle-only closing. After confirming no work is running, restart omp with the updated extension and try again.",
        ));
    }

    if let Some(foreign) = crate::authority::guard::foreign_session_owner(session, &[])
        && foreign.pid != owner.pid
    {
        return Err(refusal(
            "owner_ambiguous",
            format!(
                "Another omp process (pid {}) also owns this conversation. Nothing was closed.",
                foreign.pid
            ),
        ));
    }

    // Linux exposes Herdr's pane id in the owner process environment, giving
    // a direct pid-to-pane proof in addition to the exact session-path join.
    #[cfg(target_os = "linux")]
    if !crate::terminal::herdr_state::pane_pids()
        .get(&pane_id)
        .is_some_and(|pids| pids.contains(&owner.pid))
    {
        return Err(refusal(
            "owner_unverified",
            "The omp owner could not be matched to its Herdr pane. Nothing was closed.",
        ));
    }

    let response = crate::omp::desktop_control::rpc_for_owner(
        &state.cfg,
        session,
        owner.pid,
        "close_if_idle",
        json!({}),
    )
    .await
    .map_err(|e| {
        refusal(
            "close_unconfirmed",
            format!(
                "The computer did not confirm a safe idle close; no process was forced closed: {e}"
            ),
        )
    })?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        if response.get("code").and_then(Value::as_str) == Some("turn_running") {
            return Err(refusal(
                "turn_running",
                "A reply started before the computer could close. Let it finish before trying again.",
            ));
        }
        return Err(refusal(
            "close_unconfirmed",
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("The computer did not confirm a safe idle close.")
                .to_string(),
        ));
    }
    if !wait_until(OWNER_EXIT_TIMEOUT, || process_exited(owner.pid)).await {
        return Err(refusal(
            "shutdown_timeout",
            "The computer accepted a graceful close request, but its original omp process is still running. It was not killed; wait for it to finish, then try again.",
        ));
    }
    if !Path::new(session).is_file() {
        return Err(refusal(
            "history_unavailable",
            "The omp process exited, but the conversation file is no longer available. Check the session history before continuing.",
        ));
    }

    crate::sessions::index::trigger_refresh(state);
    info!(%session, pane = %pane_id, owner_pid = owner.pid,
        "handoff: idle computer session closed; Herdr pane left open");
    Ok(Closed { pane_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(id: &str, label: &str, tabs: u64) -> Workspace {
        Workspace {
            id: id.into(),
            label: label.into(),
            tabs,
        }
    }

    #[test]
    fn first_handoff_creates_the_series() {
        let list = [ws("w1", "notes", 1), ws("w4", "omp-pulse", 3)];
        assert_eq!(
            plan_slot(&list),
            Slot::New {
                label: "Pulse mobile".into()
            }
        );
    }

    #[test]
    fn fills_to_four_then_rolls_over() {
        let three = [ws("w7", "Pulse mobile", 3)];
        assert_eq!(
            plan_slot(&three),
            Slot::Existing {
                id: "w7".into(),
                label: "Pulse mobile".into()
            }
        );
        let full = [ws("w7", "Pulse mobile", 4)];
        assert_eq!(
            plan_slot(&full),
            Slot::New {
                label: "Pulse mobile 2".into()
            }
        );
    }

    #[test]
    fn refills_the_earliest_workspace_before_growing_later_ones() {
        // Listed out of order on purpose: herdr's numbering follows the
        // sidebar, which the owner can rearrange.
        let list = [ws("w9", "Pulse mobile 2", 1), ws("w7", "Pulse mobile", 2)];
        assert_eq!(
            plan_slot(&list),
            Slot::Existing {
                id: "w7".into(),
                label: "Pulse mobile".into()
            }
        );
    }

    #[test]
    fn a_closed_workspace_leaves_a_gap_that_is_reused() {
        let list = [ws("w7", "Pulse mobile", 4), ws("w9", "Pulse mobile 3", 4)];
        assert_eq!(
            plan_slot(&list),
            Slot::New {
                label: "Pulse mobile 2".into()
            }
        );
    }

    #[test]
    fn only_exact_series_labels_are_ours() {
        for label in [
            "Pulse mobile x",
            "Pulse mobile 1",
            "Pulse mobile 0",
            "pulse mobile",
            "Pulse mobile  2",
            "Pulse mobile +2",
        ] {
            assert_eq!(series_index(label), None, "{label}");
        }
        assert_eq!(series_index("Pulse mobile 12"), Some(12));
        // A foreign workspace that merely looks close is never filled.
        let list = [ws("w2", "Pulse mobile x", 0)];
        assert_eq!(
            plan_slot(&list),
            Slot::New {
                label: "Pulse mobile".into()
            }
        );
    }

    #[test]
    fn an_unreported_tab_count_is_treated_as_full() {
        let raw = json!({"result": {"workspaces": [
            {"workspace_id": "w7", "label": "Pulse mobile"},
            {"workspace_id": "w8", "label": "Pulse mobile 2", "tab_count": 1},
            {"label": "no id", "tab_count": 0}
        ]}});
        let parsed = parse_workspaces(&raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(
            plan_slot(&parsed),
            Slot::Existing {
                id: "w8".into(),
                label: "Pulse mobile 2".into()
            }
        );
    }

    #[test]
    fn tab_labels_are_one_bounded_line() {
        assert_eq!(tab_label(None), "Untitled session");
        assert_eq!(tab_label(Some("  \n\t ")), "Untitled session");
        assert_eq!(tab_label(Some("Fix\nthe   build")), "Fix the build");
        let long = tab_label(Some(&"word ".repeat(20)));
        assert!(long.starts_with("word word "), "{long}");
        assert!(
            long.chars().count() <= TAB_LABEL_MAX && long.ends_with('…'),
            "{long}"
        );
    }

    #[test]
    fn herdr_error_codes_survive_parsing() {
        let e = herdr_error(
            r#"{"error":{"code":"server_not_running","message":"no herdr server"},"id":"x"}"#
                .into(),
        );
        assert_eq!(e.code.as_deref(), Some("server_not_running"));
        assert_eq!(e.message, "no herdr server");
        let plain = herdr_error("herdr timed out".into());
        assert_eq!(plain.code, None);
        assert_eq!(plain.message, "herdr timed out");
    }

    #[test]
    fn agent_names_are_valid_herdr_names() {
        let n = agent_name("/s/a.jsonl");
        assert!(n.len() <= 32 && n.starts_with("pulse-"));
        assert!(
            n.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        );
    }

    #[test]
    fn close_requires_unique_exact_idle_owner() {
        let entry = |status: &str| {
            json!({
                "agent": "omp", "pane_id": "p1", "agent_status": status,
                "agent_session": { "kind": "path", "value": "/s/a.jsonl" }
            })
        };
        for status in ["idle", "done"] {
            assert_eq!(
                close_pane_for_session(&json!({"result":{"agents":[entry(status)]}}), "/s/a.jsonl")
                    .unwrap(),
                "p1"
            );
        }
        for (status, code) in [
            ("working", "turn_running"),
            ("blocked", "turn_running"),
            ("unknown", "agent_state_unknown"),
            ("future", "agent_state_unknown"),
        ] {
            assert_eq!(
                close_pane_for_session(&json!({"result":{"agents":[entry(status)]}}), "/s/a.jsonl")
                    .unwrap_err()
                    .code,
                code
            );
        }
        assert_eq!(
            close_pane_for_session(&json!({"result":{"agents":[entry("idle")]}}), "/s/b.jsonl")
                .unwrap_err()
                .code,
            "not_on_laptop"
        );
        assert_eq!(
            close_pane_for_session(
                &json!({"result":{"agents":[entry("idle"), entry("idle")]}}),
                "/s/a.jsonl"
            )
            .unwrap_err()
            .code,
            "owner_ambiguous"
        );
        assert_eq!(
            close_pane_for_session(&json!({}), "/s/a.jsonl")
                .unwrap_err()
                .code,
            "owner_unverified"
        );
    }
}
