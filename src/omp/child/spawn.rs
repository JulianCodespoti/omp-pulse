//! Spawning and opening children: the boot handshake, registration, the
//! command line and settings overlay, and the monitor task's start.

use super::*;
use crate::{metrics, types::ChildEvent};

use futures_util::FutureExt as _;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::{Future, poll_fn};
use std::io::Read;
use std::path::Path;
use std::pin::pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::process::{Child as TokioChild, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tracing::{error, info, warn};

/// The saved model named by omp's `Could not restore model <provider/id>`
/// switch_session error, or None for every other failure (which must keep
/// failing the open unchanged).
fn unrestorable_model(error: &str) -> Option<&str> {
    let rest = &error[error.find("Could not restore model")? + "Could not restore model".len()..];
    let model = rest
        .trim_start_matches([' ', ':'])
        .split_whitespace()
        .next()?;
    Some(model.trim_end_matches(['.', ',', ';']))
}

/// `(provider, modelId)` from a get_state `model` object.
fn current_model(state: &Value) -> Option<(&str, &str)> {
    let model = state.get("model")?;
    Some((model.get("provider")?.as_str()?, model.get("id")?.as_str()?))
}

/// Fallible pipe setup is identical for the two ownership lanes.
fn take_child_pipes(
    proc: &mut TokioChild,
) -> Result<(ChildStdin, ChildStdout, ChildStderr), String> {
    let stdin = proc
        .stdin
        .take()
        .ok_or_else(|| "child stdin not available".to_string())?;
    let stdout = proc
        .stdout
        .take()
        .ok_or_else(|| "child stdout not available".to_string())?;
    let stderr = proc
        .stderr
        .take()
        .ok_or_else(|| "child stderr not available".to_string())?;
    Ok((stdin, stdout, stderr))
}

/// Tokio 1.53.1 wait is cancel-safe and caches completed status on Child.
/// Each temporary wait future and mutex guard die before returning Pending.
async fn wait_registered(
    registry: &registered::Registry<TokioChild>,
    owner: &Arc<registered::Owner<TokioChild>>,
) {
    let result =
        poll_fn(|cx| owner.poll_reap(cx, |process, cx| pin!(process.wait()).poll(cx))).await;
    match result {
        Ok(_) => registry.remove_reaped(owner),
        Err(error) => warn!("registered child wait() failed; capacity retained: {error}"),
    }
}

/// First `session` entry's `cwd` from the session file header (first 4096
/// bytes). Independent of jsonl.rs (written concurrently). Torn lines are
/// skipped.
fn header_cwd(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 4096];
    let n = f.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("session")
            && let Some(cwd) = v.get("cwd").and_then(|c| c.as_str())
        {
            return Some(cwd.to_string());
        }
    }
    None
}

/// JavaScriptCore options (read by Bun from `BUN_JSC_<name>`) for a headless
/// omp child: drop the bytecode of functions that have not run for a while at
/// GC and regenerate it from source on the next call. omp evaluates ~60k
/// functions at boot, most of them once. Measured on the phone (omp 18.8.6,
/// Bun 1.4.2, idle child after a forced full GC): JS heap 99 -> 78 MiB,
/// out-of-heap code 45 -> 28 MiB; after 6 mock turns anon RSS 283 -> 260 MiB
/// (mean of 3), ~50 ms more CPU per turn, same time to `ready`. Without the
/// eager clock the saving halves (273 MiB).
const LEAN_JS_ENV: [(&str, &str); 2] = [
    ("BUN_JSC_useUnlinkedCodeBlockJettisoning", "1"),
    ("BUN_JSC_useEagerCodeBlockJettisonTiming", "1"),
];

/// Set [`LEAN_JS_ENV`] on a child command, except keys the daemon's own
/// environment already defines (`inherited`): an operator's explicit value,
/// including `0`, wins and is passed through unchanged.
fn apply_lean_js_env(cmd: &mut std::process::Command, inherited: impl Fn(&str) -> bool) {
    for (key, value) in LEAN_JS_ENV {
        if !inherited(key) {
            cmd.env(key, value);
        }
    }
}

/// The argument list of every `omp` child this module spawns.
///
/// `rpc-ui`, not `rpc`: only rpc-ui gives the agent a UI (omp main.ts
/// `hasUI = isInteractive || mode === "rpc-ui"`), and without one omp drops
/// the `ask` tool entirely (tools/ask.ts `createIf`), so a phone-driven agent
/// could only ask in prose. Same JSON protocol. The settings overlay (see
/// CHILD_SETTINGS_OVERLAY) and the phone-control extension
/// (src/omp/child/extension.rs) are per-process additions, never the user's own
/// omp config; `-e` adds to the extensions omp discovers, it replaces none.
/// Either is omitted when it could not be written (omp refuses to boot on a
/// missing `--config` file).
fn child_args(
    cwd: &str,
    session_dir: &Path,
    overlay: Option<&Path>,
    extension: Option<&Path>,
) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = [
        "--mode",
        "rpc-ui",
        "--cwd",
        cwd,
        "--no-title",
        "--session-dir",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    args.push(session_dir.into());
    if let Some(overlay) = overlay {
        args.push("--config".into());
        args.push(overlay.into());
    }
    if let Some(extension) = extension {
        args.push("-e".into());
        args.push(extension.into());
    }
    args
}

/// omp settings overlay passed to every child with `--config`. omp layers an
/// overlay above the user's config for that one process (settings.ts
/// `--config` / `PI_CONFIG_FILES`), so the user's omp config is never edited.
///
/// `goal.continuationModes` defaults to `["interactive"]`, and an RPC child
/// continues a goal only when the list holds `"rpc"` (rpc-goal.ts
/// `#continuationWanted`): a goal started from the phone ran one turn and
/// then waited for the next message. Same in omp 18.8.6 and 18.11.0.
const CHILD_SETTINGS_OVERLAY: &str =
    "{\"goal\":{\"continuationModes\":[\"interactive\",\"rpc\"]}}\n";

/// Write [`CHILD_SETTINGS_OVERLAY`] under `state_dir` and return its path.
/// omp treats a missing or unparsable `--config` file as a hard boot error,
/// so a failed write returns `None` and the child boots without the overlay
/// (goals then advance one turn per message) rather than not at all. The file
/// is replaced by rename: a child booting beside a concurrent spawn must
/// never read a half-written overlay.
fn child_settings_overlay(state_dir: &Path) -> Option<std::path::PathBuf> {
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let path = state_dir.join("omp-child-settings.yml");
    if std::fs::read_to_string(&path).is_ok_and(|current| current == CHILD_SETTINGS_OVERLAY) {
        return Some(path);
    }
    let tmp = state_dir.join(format!(
        ".omp-child-settings.{}.{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let written = std::fs::create_dir_all(state_dir)
        .and_then(|()| std::fs::write(&tmp, CHILD_SETTINGS_OVERLAY))
        .and_then(|()| std::fs::rename(&tmp, &path));
    match written {
        Ok(()) => Some(path),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            warn!(path = %path.display(), error = %e, "could not write the omp settings overlay; children boot without it");
            None
        }
    }
}

impl ChildManager {
    pub(super) async fn do_open(&self, session_path: &str) -> Result<(), String> {
        // Guard: refuse to spawn a NEW writer for a session file another omp
        // process (typically the desktop TUI) has open — its whole-file
        // rewrite would silently destroy entries we append. Our own live
        // children are excluded by the guard (we already own the writer), and
        // this path is only reached when no live child exists for the session.
        if let Some(owner) =
            crate::authority::guard::foreign_session_owner(session_path, &self.live_pids())
        {
            return Err(crate::authority::guard::refusal_message(&owner));
        }
        // The bridge layer: a desktop omp that published this exact session
        // through its extension owns it even when no guard layer can see it
        // (a TUI that /resume'd holds no fd and carries no path in argv).
        // Every write path (prompt, prewarm, open) funnels through here.
        if let Some(pid) = crate::omp::bridge::live_pid(session_path) {
            return Err(format!(
                "session_owned_by_terminal: session is open in omp on the desktop (pid {pid}); the phone drives it through that process"
            ));
        }
        // The laptop handoff is between stopping our child and the TUI taking
        // the file: a child spawned now would be the second writer it waits
        // out (a durable phone outbox retries sends on its own).
        if crate::terminal::handoff::in_progress(session_path) {
            return Err("session_owned_by_terminal: This conversation is opening on the computer. Send again once it is open there.".to_string());
        }
        // Reuse before spawn: when the pool is at the cap and an idle child
        // exists, retarget it to this session instead of evicting + booting —
        // switch_session on a warm child costs 59-444 ms vs a 1.3-2.7 s boot
        // and adds zero memory. A retarget is morally a spawn for the TARGET
        // session, so it stays behind the ownership guard above. On any
        // failure we fall back to reserve+spawn (see retarget_idle).
        let alive = self.live_count();
        if alive <= self.config.max_children
            && slots_free(
                self.occupied.load(Ordering::SeqCst),
                self.config.max_children,
            ) == 0
            && self.retarget_idle(session_path).await
        {
            return Ok(());
        }
        // Reservation taken here, after the ownership refusal (a refused open
        // must not consume a slot): counts this spawn against the cap while it
        // is still invisible to `children`; at most one retirement is attempted.
        //
        // Refusal is not failure. The at-cap path above already tried to
        // retarget a warm child; if that failed too, every child is busy or
        // freshly booted, and the honest answer is to say so rather than add a
        // 281 MiB process the operator did not budget for. /api/prompt holds
        // a send that gets this answer until a slot frees.
        let Some(reserved) = self.try_reserve().await else {
            return Err(self.busy_error());
        };
        let cwd = self.session_cwd(session_path);
        let boot_started = Instant::now();
        let child = self.spawn(&cwd, session_path.to_string(), reserved)?;
        // Declare ownership in the sidecar the moment the pid exists: a
        // second omp-pulse instance recognises our children ONLY through the
        // sidecar — their argv is `omp --mode rpc-ui`, which the guard's argv
        // layer deliberately skips — so declaring at spawn (not at boot
        // completion) closes the window where another writer could grab the
        // session mid-boot. Best-effort: the guard's other layers still
        // protect the file if the write fails, and finish_child withdraws the
        // claim if boot fails.
        let _ = crate::authority::owner::declare(session_path, child.pid, "rpc");
        let mut model_notice: Option<String> = None;
        let notice = &mut model_notice;
        let outcome = async {
            self.rpc_on(
                &child,
                "negotiate_protocol",
                json!({ "protocolVersion": 2 }),
                NEGOTIATE_TIMEOUT,
            )
            .await?;
            self.enable_ask_dialog(&child).await;
            // Gate subagent frames so the Agent Hub gets live lifecycle data.
            // Best-effort: a failure just means no hub events; never block open.
            // "progress", not "events": "events" also relays every subagent
            // `message_update` snapshot through the pipe, the parser and the WS
            // fan-out, and nothing reads `subagent_event` (the Agents sheet
            // polls get_subagents/get_subagent_messages instead).
            match self
                .rpc_on(
                    &child,
                    "set_subagent_subscription",
                    json!({ "level": "progress" }),
                    SUBSCRIBE_TIMEOUT,
                )
                .await
            {
                Ok(_) => {}
                Err(e) => warn!("set_subagent_subscription failed (non-fatal): {e}"),
            }
            let switch = |extra: Value| {
                let mut params = json!({ "sessionPath": session_path });
                if let (Some(p), Value::Object(e)) = (params.as_object_mut(), extra) {
                    p.extend(e);
                }
                self.rpc_on(&child, "switch_session", params, SWITCH_SESSION_TIMEOUT)
            };
            let sw = match switch(Value::Null).await {
                Ok(sw) => sw,
                Err(e) => {
                    // WHY: rpc-ui disables omp's model fallback, so a session
                    // saved with a model this machine cannot restore (another
                    // host's provider) fails outright where the TUI would warn
                    // and keep the current model. Retry once, explicitly asking
                    // for the child's current model, and tell the phone.
                    let Some(saved) = unrestorable_model(&e) else {
                        return Err(e);
                    };
                    // The failed switch latched the gate's unknown binding
                    // (handle_response), which refuses every later RPC, so
                    // without this the retry below could never run.
                    lock_poisoned(&child.gate).release_boot_switch_failure();
                    let state = self
                        .rpc_on(&child, "get_state", Value::Null, GET_STATE_TIMEOUT)
                        .await?;
                    let Some((provider, model_id)) = current_model(&state) else {
                        return Err(e);
                    };
                    let sw = switch(json!({ "provider": provider, "modelId": model_id })).await?;
                    *notice = Some(format!(
                        "{saved} isn't available here — using {provider}/{model_id}"
                    ));
                    sw
                }
            };
            if sw.get("cancelled").and_then(|c| c.as_bool()) == Some(true) {
                return Err("switch_session was cancelled".to_string());
            }
            self.rpc_on(&child, "get_state", Value::Null, GET_STATE_TIMEOUT)
                .await?;
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) => {
                metrics::inc("child_spawn");
                metrics::observe_ms("child_boot_ms", boot_started.elapsed().as_millis() as u64);
                if let Err(error) = self.register_child(&child, session_path) {
                    self.kill(&child, "open registration failure", Exit::Unexpected);
                    return Err(error);
                }
                touch(&child);
                if let Some(message) = model_notice {
                    let (session, source) = child_bound_stamp(&child);
                    let _ = self.tx.send(ChildEvent::Event {
                        session,
                        event: json!({ "type": "notice", "message": message }),
                        source: Some(source),
                    });
                }
                // Routing does not refund or reacquire the physical charge.
                self.trim_to_cap().await;
                info!("child ready: {session_path}");
                Ok(())
            }
            Err(e) => {
                self.kill(&child, "open failure", Exit::Unexpected);
                Err(e)
            }
        }
    }

    /// Opt in to omp's structured `ask` dialog (all questions in one
    /// `extension_ui_request` with `method:"ask"`, answered by one `answers`
    /// reply). Without it an `--mode rpc-ui` child still asks, but as one
    /// select per question with a "Done" pick for multi-select. Best-effort:
    /// an omp that refuses keeps that fallback, which the phone also answers.
    pub(super) async fn enable_ask_dialog(&self, child: &Arc<Child>) {
        if let Err(e) = self
            .rpc_on(
                child,
                "set_ask_dialog",
                json!({ "enabled": true }),
                SUBSCRIBE_TIMEOUT,
            )
            .await
        {
            warn!("set_ask_dialog failed (non-fatal): {e}");
        }
    }

    /// Publish only the still-running exact owner, never an ended boot or a
    /// replacement route. Lock order: routes -> gate -> owner -> binding.
    pub(super) fn register_child(&self, child: &Arc<Child>, session: &str) -> Result<(), String> {
        let mut map = lock_poisoned(&self.children);
        let gate = lock_poisoned(&child.gate);
        if !child.alive.load(Ordering::SeqCst)
            || gate.phase != ChildPhase::Active
            || map
                .get(session)
                .is_some_and(|current| !Arc::ptr_eq(current, child))
        {
            return Err("agent process ended or session route changed during boot".to_string());
        }
        let Some(owner) = &child.physical else {
            return Err("unregistered child cannot publish a session route".to_string());
        };
        owner
            .publish(|| {
                let mut binding = lock_poisoned(&child.session);
                if binding.as_str() != session {
                    child.binding_epoch.fetch_add(1, Ordering::SeqCst);
                    lock_poisoned(&child.retained_agents)
                        .reset(child.binding_epoch.load(Ordering::SeqCst));
                    if !binding.is_empty() {
                        lock_poisoned(&child.feedback).clear();
                    }
                    *binding = session.to_string();
                }
                map.insert(session.to_string(), Arc::clone(child));
                child.unrouted_work.store(false, Ordering::SeqCst);
            })
            .ok_or_else(|| "agent process ended during boot".to_string())?;
        // The only path that grows the map from empty: wake a parked
        // maintenance ticker, and count the new child's work toward busy.
        self.child_added.notify_one();
        child.busy_may_have_changed();
        Ok(())
    }

    pub(super) fn spawn_ephemeral(
        &self,
        cwd: &str,
        reserved: Reservation,
    ) -> Result<(Arc<Child>, ephemeral::RequestScope), String> {
        let (scope, ended) = ephemeral::request_scope();
        let child = self.spawn_inner(cwd, String::new(), reserved, Some(ended))?;
        Ok((child, scope))
    }

    pub(super) fn spawn(
        &self,
        cwd: &str,
        session: String,
        reserved: Reservation,
    ) -> Result<Arc<Child>, String> {
        self.spawn_inner(cwd, session, reserved, None)
    }

    fn spawn_inner(
        &self,
        cwd: &str,
        session: String,
        reserved: Reservation,
        ephemeral: Option<oneshot::Receiver<()>>,
    ) -> Result<Arc<Child>, String> {
        // omp's per-project session directory (session-paths.ts
        // getDefaultSessionDirName). The old code passed the sessions ROOT
        // itself as --session-dir, which overrode omp's per-project
        // directory: every phone-created session landed DIRECTLY at the root,
        // where scan_sessions hides root-level files and omp's own listing
        // globs `*/*.jsonl` — invisible on BOTH surfaces (measured: 87 real
        // sessions stranded there, largest 8.5 MB). Passing the encoded
        // per-project directory files new sessions where every lister looks.
        let session_dir = crate::sessions::jsonl::project_session_dir(
            &self.config.sessions_root,
            cwd,
            &self.config.home,
        );
        // Best-effort creation: an uncreatable directory must not fail the
        // spawn (a session the phone can reach is better than none) — fall
        // back to the root exactly like the old behaviour, and say so. The
        // startup refile will pick up anything that lands at the root again.
        let session_dir = match std::fs::create_dir_all(&session_dir) {
            Ok(()) => session_dir,
            Err(e) => {
                warn!(
                    path = %session_dir.display(),
                    error = %e,
                    "could not create per-project session dir; falling back to the sessions root"
                );
                self.config.sessions_root.clone()
            }
        };
        let mut cmd = tokio::process::Command::new(&self.config.omp_bin);
        // A headless RPC child must never present as a terminal pane occupant:
        // it inherits our environ, and under a herdr/kitty/tmux shell that
        // includes pane identity (HERDR_PANE_ID et al). The herdr-omp
        // extension activates on exactly those vars and reports the child's
        // session AS THE PANE'S session — poisoning the agent list (and our
        // oracle map) for the real TUI, and attributing the pane's omp pid as
        // owner of a file it never touched. Observed live: a test-daemon rpc
        // child inherited HERDR_PANE_ID and the smoke suite watched pid
        // 1927739 become "owner" of a /tmp fixture. kitty/tmux vars go too:
        // adoption resolves windows/panes from the same environ authority.
        for var in [
            "HERDR_ENV",
            "HERDR_PANE_ID",
            "HERDR_SOCKET_PATH",
            "HERDR_TAB_ID",
            "HERDR_WORKSPACE_ID",
            "HERDR_STARTUP_CWD",
            "HERDR_BIN_PATH",
            "KITTY_WINDOW_ID",
            "KITTY_LISTEN_ON",
            "TMUX",
            "TMUX_PANE",
            // Tern: per-pane/window routing and session-scoped hooks. Tern
            // picks its target from inherited TERN_PANE / TERN_WINDOW_KEY, so
            // keeping them lets a headless child impersonate the parent pane.
            // TERN_EXE, TERN_CONFIG_DIR and TERN_DAEMON_SOCKET stay: they are
            // binary/state choices, not identity, and a test harness relies on
            // them to point children at throwaway state.
            "TERN_PANE",
            "TERN_PANE_SOCKET",
            "TERN_WINDOW_KEY",
            "TERN_WINDOW_SOCKET",
            "TERN_IDENTITY",
            "TERN_ACP",
            "TERN_COMPLETE",
            "TERN_PROMPT_ENV",
            "TERN_PROMPT_FILE",
            "TERN_BLOB_DIR",
            "TERN_LENSES",
        ] {
            cmd.env_remove(var);
        }
        // Our children are driven over this stdio. The omp-pulse extension
        // loads in them too, and without this marker it would ALSO stream
        // their events over the desktop bridge — every token twice.
        cmd.env("OMP_PULSE_CHILD", "1");
        if self.config.child_lean_js {
            apply_lean_js_env(cmd.as_std_mut(), |key| std::env::var_os(key).is_some());
        }
        let state_dir = &self.config.paths.state_dir;
        cmd.args(child_args(
            cwd,
            &session_dir,
            child_settings_overlay(state_dir).as_deref(),
            extension::materialize(state_dir).as_deref(),
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
        // Own process group, so teardown reaches the MCP servers omp starts.
        // Signalling only omp's pid left them behind: an `azmcp` from a child
        // reaped 40 minutes earlier was still running under init, holding
        // ~150 MB, and every idle reap added another set.
        #[cfg(unix)]
        cmd.process_group(0);
        let mut proc = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn omp rpc child: {e}"))?;
        // Transfer before any fallible setup. Registered ownership is durable
        // even if pipe extraction or a later boot/caller/monitor fails.
        let charge = reserved.retain();
        let pid = proc.id().map(|p| p as i32).unwrap_or(0);
        let (proc, physical, ephemeral, pipes) = if let Some(ended) = ephemeral {
            let pipes = take_child_pipes(&mut proc);
            (Some(proc), None, Some((charge, ended)), pipes)
        } else {
            let owner = self.physical.insert(proc, charge);
            let pipes = owner.setup(take_child_pipes);
            (None, Some(owner), None, pipes)
        };
        let (stdin, stdout, stderr) = match pipes {
            Ok(pipes) => pipes,
            Err(error) => {
                if let Some(owner) = physical {
                    // Existing setup-error immediate-kill policy; only a
                    // successful owned wait can return this slot afterward.
                    owner.finish();
                    owner.request_stop(|process| process.start_kill().is_ok());
                    let registry = Arc::clone(&self.physical);
                    tokio::spawn(async move {
                        wait_registered(&registry, &owner).await;
                    });
                } else if let (Some((charge, _)), Some(mut proc)) = (ephemeral, proc) {
                    let _ = proc.start_kill();
                    tokio::spawn(async move {
                        if let Err(error) = ephemeral::release_on_reap(charge, proc.wait()).await {
                            warn!("ephemeral setup-failure wait() failed: {error}");
                        }
                    });
                }
                return Err(error);
            }
        };
        let child = Arc::new(Child {
            session: Mutex::new(session.clone()),
            pid,
            source_id: self.next_source_id.fetch_add(1, Ordering::SeqCst),
            binding_epoch: AtomicU64::new(1),
            source_sequence: AtomicU64::new(0),
            process_start: crate::authority::session_state::process_start_time(pid)
                .unwrap_or_else(crate::authority::session_state::now_ms),
            cwd: cwd.to_string(),
            proc: Mutex::new(proc),
            physical,
            stdin: AsyncMutex::new(stdin),
            alive: AtomicBool::new(true),
            unrouted_work: AtomicBool::new(true),
            streaming: AtomicBool::new(false),
            compacting: AtomicBool::new(false),
            background_since: AtomicU64::new(0),
            btw_since: AtomicU64::new(0),
            active_prompt: Mutex::new(PromptLifecycle::Idle),
            last_active: AtomicU64::new(now_ms()),
            spawned_at: AtomicU64::new(now_ms()),
            last_viewed: AtomicU64::new(now_ms()),
            session_name: Mutex::new(String::new()),
            model: Mutex::new(String::new()),
            configured_thinking: Mutex::new(None),
            model_fallback: Mutex::new(None),
            retained_agents: Mutex::new(agents::RetainedAgents::new(1)),
            message_count: Mutex::new(0),
            context_percent: Mutex::new(None),
            gate: Mutex::new(ChildGate::default()),
            pending_ui: Mutex::new(HashMap::new()),
            dialog_scope: Mutex::new(None),
            tree_cancel: Mutex::new(TreeCancellation::default()),
            feedback: Mutex::new(crate::omp::ui_feedback::Feedback::default()),
            extension_replies: Mutex::new(HashMap::new()),
            extension_ready: AtomicBool::new(false),
            chunks: Mutex::new(HashMap::new()),
            busy_wake: Arc::clone(&self.busy_wake),
        });
        {
            let mut work = lock_poisoned(&self.work_children);
            work.retain(|weak| {
                weak.upgrade()
                    .is_some_and(|child| child.alive.load(Ordering::SeqCst))
            });
            work.push(Arc::downgrade(&child));
        }
        child.busy_may_have_changed();
        self.spawn_monitor(Arc::clone(&child), stdout, stderr, ephemeral);
        info!("spawned child pid={pid} session={session} cwd={cwd}");
        Ok(child)
    }

    fn spawn_monitor(
        &self,
        child: Arc<Child>,
        stdout: ChildStdout,
        stderr: ChildStderr,
        ephemeral: Option<(ephemeral::RetainedCharge, oneshot::Receiver<()>)>,
    ) {
        let tx = self.tx.clone();
        let children = Arc::clone(&self.children);
        if let Some((charge, ended)) = ephemeral {
            tokio::spawn(async move {
                let owner = ephemeral::Owner::new(charge, |reason: &str| {
                    let exit = if reason == "monitor panic" {
                        Exit::Unexpected
                    } else {
                        Exit::Planned
                    };
                    {
                        let mut gate = lock_poisoned(&child.gate);
                        gate.phase = ChildPhase::Terminating;
                        gate.intended_exit = Some(exit);
                        let _ = term_proc(&child);
                    }
                    finish_child(&tx, &children, &child, reason, exit);
                });
                let monitor = monitor_loop(
                    tx.clone(),
                    children.clone(),
                    child.clone(),
                    stdout,
                    stderr,
                    Some(&owner),
                );
                if let Err(payload) = ephemeral::supervise(&owner, ended, monitor).await {
                    error!("ephemeral child monitor task panicked: {payload:?}");
                }
            });
            return;
        }
        let physical = Arc::clone(&self.physical);
        tokio::spawn(async move {
            // Panic guard: a monitor panic must never leak a live child.
            let fut = std::panic::AssertUnwindSafe(
                monitor_loop(
                    tx.clone(),
                    children.clone(),
                    child.clone(),
                    stdout,
                    stderr,
                    None,
                )
                .boxed(),
            );
            match fut.catch_unwind().await {
                Ok(()) => {}
                Err(payload) => {
                    error!("child monitor task panicked: {payload:?}");
                    {
                        let mut gate = lock_poisoned(&child.gate);
                        gate.phase = ChildPhase::Terminating;
                        let _ = term_proc(&child);
                    }
                    finish_child(&tx, &children, &child, "monitor panic", Exit::Unexpected);
                }
            }
            if let Some(owner) = &child.physical {
                wait_registered(&physical, owner).await;
            }
        });
    }

    /// cwd for a child: the session header's `cwd` if that directory still
    /// exists, else $HOME.
    fn session_cwd(&self, session_path: &str) -> String {
        header_cwd(Path::new(session_path))
            .filter(|c| Path::new(c).exists())
            .unwrap_or_else(|| self.config.home.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_unrestorable_model_retries_with_the_current_model() {
        assert_eq!(
            unrestorable_model("Could not restore model anthropic/fixture"),
            Some("anthropic/fixture")
        );
        assert_eq!(
            unrestorable_model("rpc error: Could not restore model: openai/gpt-x."),
            Some("openai/gpt-x")
        );
        assert_eq!(unrestorable_model("Session file not found"), None);
        assert_eq!(unrestorable_model("Could not restore model"), None);
        let state = json!({"model": {"provider": "google", "id": "gemini"}});
        assert_eq!(current_model(&state), Some(("google", "gemini")));
        assert_eq!(current_model(&json!({"model": null})), None);
    }

    #[test]
    fn child_args_add_overlay_and_extension_only_when_written() {
        let dir = Path::new("/sessions/--p--");
        let base: Vec<String> = [
            "--mode",
            "rpc-ui",
            "--cwd",
            "/p",
            "--no-title",
            "--session-dir",
            "/sessions/--p--",
        ]
        .map(String::from)
        .to_vec();
        let strings = |args: Vec<std::ffi::OsString>| -> Vec<String> {
            args.into_iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(strings(child_args("/p", dir, None, None)), base);
        let mut full = base.clone();
        full.extend(["--config", "/s/o.yml", "-e", "/s/ext.ts"].map(String::from));
        assert_eq!(
            strings(child_args(
                "/p",
                dir,
                Some(Path::new("/s/o.yml")),
                Some(Path::new("/s/ext.ts"))
            )),
            full
        );
        let mut ext_only = base;
        ext_only.extend(["-e", "/s/ext.ts"].map(String::from));
        assert_eq!(
            strings(child_args("/p", dir, None, Some(Path::new("/s/ext.ts")))),
            ext_only
        );
    }

    #[test]
    fn lean_js_env_sets_jsc_options_unless_the_daemon_env_has_them() {
        let explicit = |cmd: &std::process::Command| -> Vec<(String, String)> {
            cmd.get_envs()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.map(|v| v.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                    )
                })
                .collect()
        };
        let mut cmd = std::process::Command::new("omp");
        apply_lean_js_env(&mut cmd, |_| false);
        let set = explicit(&cmd);
        for (key, value) in LEAN_JS_ENV {
            assert!(
                set.contains(&(key.to_string(), value.to_string())),
                "{key} not set: {set:?}"
            );
        }
        // An inherited value (e.g. an operator's `=0`) is left to pass through.
        let mut cmd = std::process::Command::new("omp");
        apply_lean_js_env(&mut cmd, |key| {
            key == "BUN_JSC_useEagerCodeBlockJettisonTiming"
        });
        let set = explicit(&cmd);
        assert!(
            set.iter()
                .any(|(k, _)| k == "BUN_JSC_useUnlinkedCodeBlockJettisoning")
        );
        assert!(
            !set.iter()
                .any(|(k, _)| k == "BUN_JSC_useEagerCodeBlockJettisonTiming")
        );
    }
}
