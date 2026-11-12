//! ChildManager — lazy-spawned `omp --mode rpc-ui` child processes.
//!
//! Each session has at most one live RPC child, spawned on demand by the first
//! write-path call (open/rpc/prompt/bash/abort/new_session). Children speak
//! line-delimited JSON on stdin/stdout (plan §Wire protocols):
//!
//! - requests are `{id, type, ...params}` on stdin;
//! - responses are correlated strictly by `id` — bash is background-dispatched
//!   child-side, so responses may arrive out of order and FIFO ordering must
//!   never be assumed;
//! - every non-response stdout frame is a session event, fanned out verbatim on
//!   a broadcast channel (`ChildEvent::Event`);
//! - oversized frames (>1MiB) arrive as `rpc_chunk` trains and are reassembled
//!   here before re-dispatch.
//!
//! Admission: reservations and successfully spawned children consume one slot
//! until successful owned wait. Logical routing/EOF never refunds a slot. At
//! the cap, admission may request one eligible idle retirement, but refuses
//! while that physical charge remains. In-flight boots share this count, and a
//! 10 s maintenance ticker reaps children idle past `child_idle_secs`, reaps
//! sooner (`child_unwatched_secs`) when no visible `/ws` viewer has the
//! session open, reaps idle unwatched children at once (oldest first) when
//! host `MemAvailable` drops below 800 MiB, and recycles non-streaming
//! children whose resident + swapped memory reaches `child_rss_mb` —
//! children cost ~281-430 MiB and used to live until LRU eviction or shutdown.
//! A reaped session respawns lazily on its next open/prompt.

use crate::{
    metrics,
    types::{BashResult, ChildEvent, SharedConfig},
};
mod admission;
mod agents;
mod busy;
mod catalogue;
mod ephemeral;
mod extension;
mod gate;
mod monitor;
mod plan_transition;
mod reap;
mod registered;
mod retarget;
mod rpc;
mod spawn;
mod teardown;

use admission::*;
use gate::*;
use monitor::*;
use reap::*;
use rpc::*;
use teardown::*;

pub use busy::{BusyState, BusyWork, wait_busy_change};
use ephemeral::Reservation;

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::process::{Child as TokioChild, ChildStdin};
use tokio::sync::{Mutex as AsyncMutex, Notify, broadcast, oneshot, watch};
use tracing::{debug, info, warn};

// --- Timeouts & caps (plan §Wire protocols) --------------------------------
/// Bounds on the stderr tail attached to an unexpected child exit.
const STDERR_TAIL_LINES: usize = 4;
const STDERR_TAIL_CHARS: usize = 200;
const NEGOTIATE_TIMEOUT: Duration = Duration::from_secs(10);
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(5); // non-fatal on failure
const SWITCH_SESSION_TIMEOUT: Duration = Duration::from_secs(30);
const GET_STATE_TIMEOUT: Duration = Duration::from_secs(30);
/// Best-effort state refresh on re-open of an already-live child (server.ts parity).
const REFRESH_STATE_TIMEOUT: Duration = Duration::from_secs(10);
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
/// Compaction is an LLM summarisation turn, minutes on a long session. Under
/// RPC_TIMEOUT the phone reported "took too long" at 30 s while omp went on
/// to compact anyway. Matches desktop_control's COMPACT_TIMEOUT.
const COMPACT_TIMEOUT: Duration = Duration::from_secs(300);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(30);
/// A user `!cmd` has no deadline, exactly as in the TUI (omp's BashRunner
/// sets none): `!cargo test` may run for many minutes. A deadline here only
/// abandoned the RPC while the command kept running, which also fenced off
/// the `abort_bash` that Stop sends. Stop and the child's exit end it.
/// `Duration::MAX` is safe: tokio's `timeout` maps an overflowing deadline
/// to "never".
const USER_BASH_TIMEOUT: Duration = Duration::MAX;
/// Labels and plan toggles are short controls. Tree navigation can await a
/// human ask dialog and native LLM summarization; like user Bash it has no
/// daemon deadline. Stop/UI responses remain independently routable.
const EXTENSION_TIMEOUT: Duration = Duration::from_secs(30);
const TREE_MOVE_TIMEOUT: Duration = Duration::MAX;
const ABORT_TIMEOUT: Duration = Duration::from_secs(10);
/// /api/bash output cap (bytes).
const MAX_BASH_OUTPUT: usize = 256 * 1024;
/// maxReassembledFrameBytes from the ready frame.
const MAX_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;

/// Code carried by every answer that could not get an agent because each
/// slot in the pool holds a working one (`max_children`). A prompt that hits
/// it is held and sent when a slot frees; everything else is refused.
pub const AGENTS_BUSY: &str = "agents_busy";

/// The refusal a person reads when every agent slot is working.
pub fn agents_busy_sentence(cap: usize) -> String {
    if cap == 1 {
        "1 agent is working. Send again when it finishes, or stop it.".to_string()
    } else {
        format!("{cap} agents are working. Send again when one finishes, or stop one.")
    }
}

/// What a held prompt's receipt says while it waits for a free slot.
pub fn agents_busy_waiting_sentence(cap: usize) -> String {
    if cap == 1 {
        "Waiting for a free agent. 1 agent is working; this sends when it finishes.".to_string()
    } else {
        format!("Waiting for a free agent. {cap} agents are working; this sends when one finishes.")
    }
}

/// `Some(sentence)` when `error` is the pool-full refusal from this module.
/// The error string is `agents_busy: <sentence>`, so a caller that only
/// shows it still reads as a sentence once the code is stripped.
pub fn agents_busy_message(error: &str) -> Option<&str> {
    error
        .strip_prefix(AGENTS_BUSY)
        .and_then(|rest| rest.strip_prefix(": "))
}

/// How long a `prompt_result` with `sessionSettled: false` keeps the child
/// busy without the `session_settled` that should follow. omp emits that
/// frame once background jobs drain; the bound only protects the pool from a
/// child that never says so.
const BACKGROUND_WORK_MAX_MS: u64 = 2 * 60 * 60 * 1000;

/// Whether background work omp reported (a job or subagent still running
/// after the turn's `agent_end`) still counts. `since` is 0 when settled.
fn background_pending(since: u64, now: u64) -> bool {
    since != 0 && now.saturating_sub(since) < BACKGROUND_WORK_MAX_MS
}

/// How a phone prompt joins a turn that is already running. omp's TUI steers
/// on Enter while the agent works and queues as the alternative; pulse used
/// to hard-code follow-up, so a phone could never redirect a turn in flight.
/// An idle session ignores the mode: every delivery simply starts a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptDelivery {
    Steer,
    Queue,
    Interrupt,
}

impl PromptDelivery {
    /// `delivery` from `/api/prompt`. Absent means steer, matching the TUI;
    /// an unknown word is refused rather than guessed, because guessing
    /// wrong either aborts work the user wanted or ignores a redirect.
    pub fn from_wire(raw: Option<&str>) -> Result<Self, String> {
        match raw {
            None | Some("steer") => Ok(Self::Steer),
            Some("queue") => Ok(Self::Queue),
            Some("interrupt") => Ok(Self::Interrupt),
            Some(_) => Err("delivery must be steer, queue or interrupt".to_string()),
        }
    }

    /// RPC command and `streamingBehavior` for a daemon-hosted child.
    /// `abort_and_prompt` aborts and then prompts under the same request id,
    /// so the receipt correlation (`pulse-prompt:<commandId>`) is unchanged.
    ///
    /// A `prompt` always carries `streamingBehavior`. omp reads it only while
    /// its own turn is streaming (omp 18.8.6: `if (this.isStreaming) { const _
    /// = t?.streamingBehavior; if (!_) throw … }`) and an idle omp ignores it.
    /// Our `streaming` flag lags omp's (it flips on agent_start), so always
    /// sending it closes the "Agent is already processing" race. For the same
    /// reason an interrupt we see as idle steers: aborting is only chosen when
    /// we know a turn runs, and steering is the closest non-destructive mode.
    fn child_rpc(self, streaming: bool) -> (&'static str, Option<&'static str>) {
        match self {
            Self::Interrupt if streaming => ("abort_and_prompt", None),
            Self::Steer | Self::Interrupt => ("prompt", Some("steer")),
            Self::Queue => ("prompt", Some("followUp")),
        }
    }

    /// `deliverAs` for the desktop extension (extensions/omp-pulse-control.ts),
    /// which can steer or queue but has no abort-and-prompt. Interrupt falls
    /// back to queue there: the message is kept and the running work is not
    /// touched. Session capabilities report `interrupt: false` for that owner,
    /// so the phone does not offer it in the first place.
    pub fn bridge_deliver_as(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::Queue | Self::Interrupt => "followUp",
        }
    }
}

/// Which phone control `ChildManager::phone_control` runs in the child
/// extension (src/omp/child/extension.rs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhoneControl {
    /// Enter/leave plan mode: `{enabled: bool}` → `{enabled, planFilePath?}`.
    Plan,
    /// Move the conversation back in place: `{entryId}` → `{cancelled, editorText?}`.
    TreeMove,
    /// Set or clear an entry label: `{entryId, label}` → `{label}`.
    Label,
    /// Read the live owner's effective keyword settings and enabled tools.
    PromptConfig,
    /// Read only models valid in this session's model-mention scope.
    ModelMentionChoices,
}

/// Out-of-band tree cancellation uses native UI responses, which bypass OMP's
/// serialized prompt queue. The latch covers Stop arriving before its frame.
#[derive(Default)]
struct TreeCancellation {
    request_id: Option<String>,
    stop_requested: bool,
}

/// One live `omp --mode rpc-ui` child.
struct Child {
    /// Lock order: registry -> gate -> binding/UI/cache. Never held across await.
    gate: Mutex<ChildGate>,
    /// Session path this child is bound to; empty while a `new_session` child
    /// has not yet produced its sessionFile.
    session: Mutex<String>,
    /// OS pid, captured at spawn (used for SIGTERM).
    pid: i32,
    source_id: u64,
    binding_epoch: AtomicU64,
    source_sequence: AtomicU64,
    process_start: u64,
    /// The `--cwd` it was spawned in (its project). Command catalogues are
    /// per project, so any live child here can answer one for a session it
    /// is not bound to.
    cwd: String,
    /// Ephemeral lane only: preserves its existing monitor-owned wait.
    proc: Mutex<Option<TokioChild>>,
    /// Registered handle and charge also retained by the manager registry.
    physical: Option<Arc<registered::Owner<TokioChild>>>,
    /// Serializes all stdin writes so frames never interleave mid-line.
    stdin: AsyncMutex<ChildStdin>,
    alive: AtomicBool,
    /// Boots and one-shot RPC scopes are work even between protocol frames.
    unrouted_work: AtomicBool,
    streaming: AtomicBool,
    /// Native get_state.isCompacting includes manual /handoff work, which
    /// acknowledges before finishing and need not start an agent turn.
    compacting: AtomicBool,
    /// Unix ms of a `prompt_result` with `sessionSettled: false` (a job or
    /// subagent still running after the turn ended), 0 once omp sends
    /// `session_settled`. Such a child is busy: stopping it loses the job.
    background_since: AtomicU64,
    /// Unix ms of the latest `btw_record` whose latest turn is `running` (a
    /// side question being answered), 0 once one ends. A side question runs
    /// beside the turn, so an otherwise idle child is still busy: reaping or
    /// evicting it would cut the answer off mid-stream.
    btw_since: AtomicU64,
    /// Only an idle child's sole pending prompt can be correlated with an
    /// unlabelled agent lifecycle. Overlapping pre-start prompts invalidate
    /// that inference; queued follow-ups retain their RPC receipt only.
    active_prompt: Mutex<PromptLifecycle>,
    /// Monotonic-ish "last used" stamp (unix ms) for LRU eviction.
    last_active: AtomicU64,
    /// When this child was registered (unix ms). Admission control refuses to
    /// evict a child younger than `MIN_CHILD_LIFETIME_MS`: without that floor a
    /// burst of opens at the cap evicts children the other requests have just
    /// booted, and the pool thrashes instead of settling. Measured: twelve
    /// simultaneous opens at cap 3 against large sessions never converged
    /// (killed at 900 s) because every arrival evicted a 2.5 s boot.
    spawned_at: AtomicU64,
    /// Last maintenance pass (unix ms) that saw a `/ws` viewer on this
    /// child's session. The unwatched-reap clock runs from the later of this
    /// and `last_active`.
    last_viewed: AtomicU64,
    // get_state cache (ordered response application) — surfaced via cached_state()/is_streaming()
    // and, for the session listing, live_rows().
    session_name: Mutex<String>,
    model: Mutex<String>,
    /// Configured selector from native change receipts or the owner extension's
    /// lifecycle snapshot; get_state itself reports only the effective effort.
    configured_thinking: Mutex<Option<String>>,
    model_fallback: Mutex<Option<Value>>,
    retained_agents: Mutex<agents::RetainedAgents>,
    message_count: Mutex<u64>,
    /// `contextUsage.percent` from get_state (0-100, rounded; None until the
    /// child reports one — models without a context window never do). The
    /// listing's `ctxPercent` row field comes from here so the phone can warn
    /// "at 95%, about to compact" without opening the session.
    context_percent: Mutex<Option<u32>>,
    /// Open `extension_ui_request` frames awaiting a client response, keyed
    /// by request id with the FULL payload retained so a reloading phone can
    /// re-render a still-pending dialog (the payload is all the UI needs —
    /// the old set of bare ids could never). The phone answers through
    /// `/api/panes/answer` or a WS `extension_ui_response`, both shaped by
    /// `ui_dialog` and sent via forward_ui_response; the child cancels
    /// one via an `extension_ui_request` with `method:"cancel"` +
    /// `targetId`; `agent_end` clears the whole map. Replay order follows
    /// the map's iteration order, stable within a daemon run — which is all
    /// that matters, since a restart kills the child and empties this map.
    pending_ui: Mutex<HashMap<String, Value>>,
    /// Private extension marker consumed by its immediately following dialog.
    dialog_scope: Mutex<Option<String>>,
    tree_cancel: Mutex<TreeCancellation>,
    feedback: Mutex<crate::omp::ui_feedback::Feedback>,
    /// Phone-control commands sent to the child extension, awaiting its
    /// `setStatus` reply (src/omp/child/extension.rs), keyed by request id.
    extension_replies: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    /// The extension's commands were seen in this child's catalogue. Checked
    /// once per child: an unloaded extension would turn a control prompt
    /// into a message to the model.
    extension_ready: AtomicBool,
    /// Partial rpc_chunk trains, keyed by chunkId.
    chunks: Mutex<HashMap<String, ChunkAcc>>,
    /// The manager's busy-watcher wake (src/omp/child/busy.rs), poked after
    /// every write that can flip [`child_busy_locked`].
    busy_wake: Arc<Notify>,
}

/// Busy = stopping or retargeting this child abandons someone's work: a live
/// turn, an accepted prompt whose turn has not started yet, background work
/// omp said is still running after the turn, a side question being answered,
/// a dialog awaiting a phone answer, an RPC in flight (a user `bash` has no
/// deadline), or a phone control the extension is still running (`!!` runs
/// as long as a `bash`; its RPC is acknowledged before the command starts).
/// Eviction, reaping, recycling and retargeting all skip a busy child.
fn child_busy(c: &Child, now: u64) -> bool {
    let gate = lock_poisoned(&c.gate);
    child_busy_locked(c, &gate, now)
}

/// Called only while the shared gate is held: observations and admissions
/// cannot race the final eligibility decision or signal submission.
fn child_busy_locked(c: &Child, gate: &ChildGate, now: u64) -> bool {
    !gate.quiescent()
        || c.streaming.load(Ordering::SeqCst)
        || c.compacting.load(Ordering::SeqCst)
        || lock_poisoned(&c.active_prompt).outstanding(now)
        || background_pending(c.background_since.load(Ordering::SeqCst), now)
        || background_pending(c.btw_since.load(Ordering::SeqCst), now)
        || !lock_poisoned(&c.pending_ui).is_empty()
        || !lock_poisoned(&c.extension_replies).is_empty()
}

fn child_identity(child: &Child) -> crate::authority::session_state::SourceIdentity {
    crate::authority::session_state::SourceIdentity {
        kind: crate::authority::session_state::SourceKind::Child,
        source_id: child.source_id,
        binding_epoch: child.binding_epoch.load(Ordering::SeqCst),
        pid: Some(child.pid),
        process_start: Some(child.process_start),
        peer_id: None,
        room_id: None,
        can_write: Some(true),
    }
}

fn child_source_stamp(child: &Child) -> crate::authority::session_state::SourceStamp {
    crate::authority::session_state::SourceStamp {
        identity: child_identity(child),
        sequence: child.source_sequence.fetch_add(1, Ordering::SeqCst) + 1,
    }
}

fn child_projection_stamp(child: &Child) -> crate::authority::session_state::SourceStamp {
    crate::authority::session_state::SourceStamp {
        identity: child_identity(child),
        // Reads observe, but never consume, the adapter event sequence.
        sequence: child.source_sequence.load(Ordering::SeqCst),
    }
}

fn child_bound_stamp(child: &Child) -> (String, crate::authority::session_state::SourceStamp) {
    let binding = lock_poisoned(&child.session);
    let session = binding.clone();
    let stamp = child_source_stamp(child);
    (session, stamp)
}

/// Accumulator for one `rpc_chunk` frame train.
struct ChunkAcc {
    count: usize,
    parts: Vec<Option<Vec<u8>>>,
    received: usize,
    /// Sum of decoded part lengths (cap guard).
    bytes: usize,
}

/// Lazy child process manager. All methods are safe to call concurrently;
/// internal locks are held only for brief critical sections.
pub struct ChildManager {
    config: SharedConfig,
    tx: broadcast::Sender<ChildEvent>,
    /// session_path -> live child (Arc'd so the monitor can outlive callers).
    children: Arc<Mutex<HashMap<String, Arc<Child>>>>,
    /// Coalescing gate per session path: one in-flight spawn per path
    /// (server.ts `opening` map).
    opening: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    /// One scalar for reservations and retained physical charges, including
    /// booting, routed, ephemeral and logically finished unreaped children.
    occupied: Arc<AtomicUsize>,
    physical: Arc<registered::Registry<TokioChild>>,
    /// Serialize the full-pool decision and one victim stop submission.
    admission: Mutex<()>,
    /// Serializes idle-child retargeting (`switch_session` re-use): two
    /// concurrent at-cap opens must not both pick the same child.
    retarget_lock: AsyncMutex<()>,
    /// Process-wide rpc id counter (r1, r2, …).
    next_id: AtomicU64,
    next_source_id: AtomicU64,
    shutting_down: AtomicBool,
    /// "Does any client have this session open?" — wired from the WS hub by
    /// main.rs. Unset means unknown, and every child counts as watched, so
    /// only the idle TTL applies.
    viewers: std::sync::OnceLock<crate::sessions::watcher::Audience>,
    /// Weak inventory of every spawned child, including boots and one-shot
    /// RPC children which never enter the session routing map.
    work_children: Arc<Mutex<Vec<std::sync::Weak<Child>>>>,
    /// Active non-OMP CPU work, currently ASR warm-up and transcription.
    extra_work: Arc<AtomicUsize>,
    /// Shared with every child: pokes the busy watcher.
    busy_wake: Arc<Notify>,
    busy_rx: watch::Receiver<BusyState>,
    /// Fired by the single route registration path to unpark maintenance.
    child_added: Notify,
}

/// Initial slash-command acknowledgement: text printed so far and whether the
/// command invoked the agent. Background handlers may print more afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRun {
    pub output: String,
    pub agent_invoked: bool,
}

/// Collect only output already observed from this exact process/session
/// binding. OMP 18.10.4's command_output has no request id or completion flag:
/// this response is never evidence that a background command finished. The
/// monitor retains later output in bounded feedback for this conversation.
/// The monitor has already removed terminal escapes for live and retained output.
fn command_run(
    events: &mut broadcast::Receiver<ChildEvent>,
    identity: &crate::authority::session_state::SourceIdentity,
    response_data: &Value,
) -> CommandRun {
    let mut output = String::new();
    loop {
        match events.try_recv() {
            Ok(ChildEvent::Event {
                event,
                source: Some(source),
                ..
            }) if &source.identity == identity
                && event.get("type").and_then(Value::as_str) == Some("command_output") =>
            {
                if let Some(text) = event.get("text").and_then(Value::as_str) {
                    if !output.is_empty() {
                        output.push('\n');
                    }
                    output.push_str(text);
                }
            }
            Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => {}
            Err(_) => break,
        }
    }
    CommandRun {
        output,
        agent_invoked: response_data
            .get("agentInvoked")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// Live-child enrichment for one `/api/sessions` row: the three optional
/// fields (model, messageCount, ctxPercent) sourced from the child's cached
/// get_state (see [`ChildManager::live_rows`]).
#[derive(Debug, Clone)]
pub struct LiveRow {
    /// Provider-qualified model id ("" until the child reports one).
    pub model: String,
    /// Cached `messageCount` (0 until the child reports one).
    pub message_count: u64,
    /// Cached `contextUsage.percent`, rounded and clamped to 0-100; None
    /// until the child reports it (models without a context window never
    /// do), in which case the row's `ctxPercent` stays omitted.
    pub ctx_percent: Option<u32>,
}

impl ChildManager {
    pub fn new(config: SharedConfig) -> Arc<Self> {
        // Startup refile of sessions stranded at the sessions ROOT by the old
        // `--session-dir <root>` spawn override (measured: 87 real sessions,
        // largest 8.5 MB, invisible to the phone AND to `omp resume` — both
        // list one level deep). Runs synchronously here so the first
        // /api/sessions scan starts clean; a file held open by a live writer
        // is deliberately left in place and refiled on the next restart.
        let refile =
            crate::sessions::jsonl::refile_root_sessions(&config.sessions_root, &config.home);
        info!(
            moved = refile.moved,
            skipped = refile.skipped,
            "refiled root-level session files into per-project directories"
        );
        // Written now so a stale copy from an older daemon is replaced (and
        // pruned) before the first child boots; every spawn re-checks it.
        if let Some(path) = extension::materialize(&config.paths.state_dir) {
            info!(path = %path.display(), "phone-control extension ready for omp children");
        }
        let children = Arc::new(Mutex::new(HashMap::new()));
        let work_children = Arc::new(Mutex::new(Vec::new()));
        let extra_work = Arc::new(AtomicUsize::new(0));
        let busy_wake = Arc::new(Notify::new());
        let (busy_tx, busy_rx) = watch::channel(BusyState::default());
        let mgr = Arc::new(Self {
            config,
            tx: broadcast::channel(1024).0,
            children: Arc::clone(&children),
            opening: Arc::new(Mutex::new(HashMap::new())),
            occupied: Arc::new(AtomicUsize::new(0)),
            physical: Arc::new(registered::Registry::new()),
            admission: Mutex::new(()),
            retarget_lock: AsyncMutex::new(()),
            next_id: AtomicU64::new(0),
            next_source_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            viewers: std::sync::OnceLock::new(),
            work_children: Arc::clone(&work_children),
            extra_work: Arc::clone(&extra_work),
            busy_wake: Arc::clone(&busy_wake),
            busy_rx,
            child_added: Notify::new(),
        });
        // Self-contained maintenance ticker (cap trim / idle reap / RSS
        // recycle). main.rs is another slice's file and must not change for
        // this to run; `new` is only ever called from `main` inside the tokio
        // runtime, so spawn cannot panic here.
        tokio::spawn(maintenance_ticker(Arc::clone(&mgr)));
        tokio::spawn(busy::busy_watcher(
            work_children,
            extra_work,
            busy_wake,
            busy_tx,
        ));
        mgr
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ChildEvent> {
        self.tx.subscribe()
    }

    /// A sender into the same event stream the router consumes. The desktop
    /// bridge publishes the desktop omp's own events here, so a desktop turn
    /// reaches the phone through exactly the pipeline a child turn does
    /// (delta encoding, listing refresh, completion push).
    pub fn event_sender(&self) -> broadcast::Sender<ChildEvent> {
        self.tx.clone()
    }

    /// Install the viewer predicate the unwatched reaper consults. Called once
    /// at boot; a second call is ignored (the hub never changes).
    pub fn set_viewers(&self, viewers: crate::sessions::watcher::Audience) {
        let _ = self.viewers.set(viewers);
    }

    pub fn is_streaming(&self, session_path: &str) -> bool {
        self.child(session_path)
            .map(|c| c.streaming.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    /// Sessions whose daemon child is mid-turn. These are exactly the turns a
    /// daemon restart destroys (desktop-bridged and terminal turns run in
    /// their own processes and survive it), so the deploy script waits on
    /// this list rather than on every "streaming" row in the listing.
    pub fn streaming_sessions(&self) -> Vec<String> {
        lock_poisoned(&self.children)
            .iter()
            .filter(|(_, c)| c.alive.load(Ordering::SeqCst) && c.streaming.load(Ordering::SeqCst))
            .map(|(path, _)| path.clone())
            .collect()
    }

    pub fn has_child(&self, session_path: &str) -> bool {
        self.child(session_path).is_some()
    }

    /// OS pid of the live child bound to this session. The laptop handoff
    /// (`handoff.rs`) needs it to wait for the child to EXIT, not merely be
    /// told to: omp flushes the session on SIGTERM, so a TUI started before
    /// the pid is gone would be a second writer.
    pub fn pid_for(&self, session_path: &str) -> Option<i32> {
        self.child(session_path)
            .map(|c| c.pid)
            .filter(|pid| *pid > 0)
    }

    /// Number of currently alive children (feeds the `/api/status` snapshot).
    pub fn live_count(&self) -> usize {
        lock_poisoned(&self.children)
            .values()
            .filter(|c| c.alive.load(Ordering::SeqCst))
            .count()
    }

    /// OS pids of currently alive children (0/unset pids skipped). Feeds the
    /// session-file guard so it never mistakes our own writers for foreign
    /// owners.
    pub fn live_pids(&self) -> Vec<i32> {
        lock_poisoned(&self.children)
            .values()
            .filter(|c| c.alive.load(Ordering::SeqCst))
            .map(|c| c.pid)
            .filter(|pid| *pid > 0)
            .collect()
    }

    /// The configured child cap (feeds /api/status).
    pub fn cap(&self) -> usize {
        self.config.max_children
    }

    /// The pool-full refusal, worded for a person, behind the `agents_busy`
    /// code (see [`agents_busy_message`]).
    pub fn busy_error(&self) -> String {
        format!(
            "{AGENTS_BUSY}: {}",
            agents_busy_sentence(self.config.max_children)
        )
    }

    /// Whether an open for this session could get a child right now: it has
    /// one, a slot is free, or some child is idle (retargeted or evicted for
    /// it). Retained stopping/EOF charges can also make the pool unavailable.
    /// Racy by nature; callers use it to skip doomed work,
    /// never as a guarantee.
    pub fn can_admit(&self, session_path: &str) -> bool {
        if self.has_child(session_path) {
            return true;
        }
        let map = lock_poisoned(&self.children);
        let alive: Vec<&Arc<Child>> = map
            .values()
            .filter(|c| c.alive.load(Ordering::SeqCst))
            .collect();
        if slots_free(
            self.occupied.load(Ordering::SeqCst),
            self.config.max_children,
        ) > 0
        {
            return true;
        }
        let now = now_ms();
        alive.iter().any(|c| !child_busy(c, now))
    }

    /// Sum of live children's (VmRSS, VmSwap) in MiB. Children dominate
    /// daemon memory (~260-430 MiB each), so this is what an operator wants on
    /// /api/status; on the phone zram holds a share of it as swap.
    pub fn total_mem_mb(&self) -> (u64, u64) {
        self.live_pids()
            .iter()
            .filter_map(|pid| mem_mb(*pid))
            .fold((0, 0), |(rss, swap), (r, s)| (rss + r, swap + s))
    }

    /// Pool snapshot for /api/status: occupancy, RSS, and the lifetime
    /// counters behind the reap/recycle/evict decisions.
    pub fn stats(&self) -> serde_json::Value {
        let counter = |name: &'static str| -> u64 {
            metrics::snapshot()["counters"][name].as_u64().unwrap_or(0)
        };
        let (rss_mb, swap_mb) = self.total_mem_mb();
        let alive = self.live_count();
        let occupied = self.occupied.load(Ordering::SeqCst);
        json!({
            "alive": alive,
            "occupied": occupied,
            // Legacy projection: charged slots outside live routes, now also
            // including stopped/EOF owners waiting for reap. Snapshots race.
            "in_flight": occupied.saturating_sub(alive),
            "cap": self.config.max_children,
            "rss_mb": rss_mb,
            "swap_mb": swap_mb,
            "reaped_idle": counter("child_reaped_idle"),
            "reaped_unwatched": counter("child_reaped_unwatched"),
            "reaped_pressure": counter("child_reaped_pressure"),
            "recycled_rss": counter("child_recycled_rss"),
            "cap_blocked": counter("child_cap_blocked"),
            "cap_refused": counter("child_cap_refused"),
            "evicted": counter("child_evict"),
            "retargeted": counter("child_retarget"),
        })
    }

    /// True while the child has at least one open `extension_ui_request`
    /// awaiting a phone response (feeds "needs input" push decisions). False
    /// when no child is alive for the path.
    pub fn pending_ui_request(&self, session_path: &str) -> bool {
        self.child(session_path)
            .map(|c| !lock_poisoned(&c.pending_ui).is_empty())
            .unwrap_or(false)
    }

    /// Every session whose child is blocked on a phone answer. The inbox shows a
    /// waiting marker from this, so a question does not stay invisible until the
    /// user happens to open that conversation.
    pub fn sessions_awaiting_ui(&self) -> Vec<String> {
        let children = lock_poisoned(&self.children);
        children
            .iter()
            .filter(|(_, c)| !lock_poisoned(&c.pending_ui).is_empty())
            .map(|(path, _)| path.clone())
            .collect()
    }

    /// Clone the full payloads of every still-open `extension_ui_request`
    /// dialog for the session's child, so a newly attached client can
    /// re-render dialogs that predate its connection (a phone reload must
    /// not strand a pending prompt). Empty when the child or session is
    /// unknown.
    pub fn pending_ui_requests(&self, session_path: &str) -> Vec<Value> {
        let Some(child) = self.child(session_path) else {
            return Vec::new();
        };
        let now = now_ms();
        lock_poisoned(&child.pending_ui)
            .values()
            .map(|stored| crate::omp::ui_dialog::replay_payload(stored, now))
            .collect()
    }

    /// Authoritative nonblocking feedback for this process/session binding.
    pub fn feedback_snapshot(&self, session_path: &str) -> Value {
        self.child(session_path)
            .map(|child| lock_poisoned(&child.feedback).snapshot(now_ms()))
            .unwrap_or_else(|| json!({"type": "extension_ui_snapshot", "requests": []}))
    }

    /// Cached get_state fields for /api/open enrichment:
    /// `(sessionName, model, messageCount, isStreaming)`.
    /// The session listing uses [`Self::live_rows`], which adds the context
    /// percent the phone needs for its "about to compact" warning.
    pub fn cached_state(&self, session_path: &str) -> Option<(String, String, u64, bool)> {
        let c = self.child(session_path)?;
        let name = lock_poisoned(&c.session_name).clone();
        let model = lock_poisoned(&c.model).clone();
        let message_count = *lock_poisoned(&c.message_count);
        let streaming = c.streaming.load(Ordering::SeqCst);
        Some((name, model, message_count, streaming))
    }
    pub fn source_snapshot(
        &self,
        session_path: &str,
    ) -> Option<crate::authority::session_state::SourceStamp> {
        let child = self.child(session_path)?;
        Some(child_projection_stamp(&child))
    }
    pub fn authority_snapshot(
        &self,
        session_path: &str,
    ) -> Option<(crate::authority::session_state::SourceStamp, bool)> {
        let child = self.child(session_path)?;
        let binding = lock_poisoned(&child.session);
        if binding.as_str() != session_path {
            return None;
        }
        let stamp = child_projection_stamp(&child);
        let streaming = child.streaming.load(Ordering::SeqCst);
        Some((stamp, streaming))
    }

    /// Enrichment map for the session listing: session path -> [`LiveRow`] for
    /// every live child, built with ONE registry lock (O(live children)) so a
    /// listing serialization pays O(live children) total — never O(sessions)
    /// registry work. Sessions without a live child are absent from the map,
    /// and their rows omit the fields entirely.
    pub fn live_rows(&self) -> HashMap<String, LiveRow> {
        let children = lock_poisoned(&self.children);
        children
            .iter()
            .filter(|(_, c)| c.alive.load(Ordering::SeqCst))
            .map(|(path, c)| {
                (
                    path.clone(),
                    LiveRow {
                        model: lock_poisoned(&c.model).clone(),
                        message_count: *lock_poisoned(&c.message_count),
                        ctx_percent: *lock_poisoned(&c.context_percent),
                    },
                )
            })
            .collect()
    }

    /// Lazy spawn/reuse. Coalesces concurrent opens for the same path so only
    /// one child is ever spawned for it (server.ts `opening` map). Sequence:
    /// spawn → negotiate_protocol{protocolVersion:2} (10s) →
    /// set_subagent_subscription{level:"progress"} (5s, non-fatal) →
    /// switch_session{sessionPath} (30s) → get_state (30s).
    pub async fn open(&self, session_path: &str) -> Result<(), String> {
        if let Some(child) = self.child(session_path) {
            // Reuse: refresh cached state best-effort (server.ts openChild); a
            // stale cache is preferable to a failed open.
            match self
                .rpc_on_bound(
                    &child,
                    session_path,
                    "get_state",
                    Value::Null,
                    REFRESH_STATE_TIMEOUT,
                )
                .await
            {
                Ok(_) => touch(&child),
                Err(e) => debug!("get_state refresh on re-open failed: {e}"),
            }
            return Ok(());
        }
        // Single in-flight spawn per path: the first caller inserts the gate
        // and spawns; concurrent callers await the same gate, then re-check.
        let gate = {
            let mut opening = lock_poisoned(&self.opening);
            Arc::clone(
                opening
                    .entry(session_path.to_string())
                    .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
            )
        };
        let _guard = gate.lock().await;
        if self.has_child(session_path) {
            return Ok(());
        }
        let res = self.do_open(session_path).await;
        let mut opening = lock_poisoned(&self.opening);
        if opening
            .get(session_path)
            .map(|g| Arc::ptr_eq(g, &gate))
            .unwrap_or(false)
        {
            opening.remove(session_path);
        }
        res
    }

    /// Wait out an open already in flight for this session (a boot measured
    /// 1.3-2.7 s). The laptop handoff needs a settled answer: mid-boot the
    /// child's owner sidecar already names its pid while `live_pids` does not
    /// yet, so the guard reads our own booting child as a foreign owner.
    pub async fn settle_open(&self, session_path: &str) {
        let gate = lock_poisoned(&self.opening).get(session_path).cloned();
        if let Some(gate) = gate {
            drop(gate.lock().await);
        }
    }

    /// Auto-opens. Returns response `data`. Timeout per [`rpc_timeout`].
    pub async fn rpc(
        &self,
        session_path: &str,
        command: &str,
        params: Value,
    ) -> Result<Value, String> {
        // Only open/retarget may switch a child: they admit the destination
        // and own its registry binding. Reject before auto-open, so even an
        // unbound source cannot spawn a writer for an unsupported raw switch.
        if command == "switch_session" {
            return Err("command not allowed".to_string());
        }
        if matches!(command, "remove_queued_message" | "promote_queued_message") {
            let child = self
                .child(session_path)
                .ok_or_else(|| "agent process not running".to_string())?;
            let name = if command == "remove_queued_message" {
                "pulse-queue-remove"
            } else {
                "pulse-queue-promote"
            };
            return self
                .extension_call(&child, session_path, name, params, EXTENSION_TIMEOUT)
                .await;
        }
        // A transcript reference belongs to the existing native owner; a new
        // child cannot recover it and must not be started merely for this read.
        if !matches!(command, "get_subagents" | "get_subagent_messages") {
            self.open(session_path).await?;
        }
        let child = self
            .child(session_path)
            .ok_or_else(|| "agent process not running".to_string())?;
        let epoch = child.binding_epoch.load(Ordering::SeqCst);
        let request_sequence = child.source_sequence.load(Ordering::SeqCst);
        let context_measured_after = (command == "get_state").then(now_ms);
        let mut data = self
            .rpc_on_bound(&child, session_path, command, params, rpc_timeout(command))
            .await?;
        if let Some(at) = context_measured_after
            && data.is_object()
        {
            data["contextMeasuredAfter"] = json!(at);
        }
        if command == "get_state"
            && let Ok(queue) = self
                .extension_call(
                    &child,
                    session_path,
                    "pulse-queue-state",
                    json!({}),
                    EXTENSION_TIMEOUT,
                )
                .await
            && data.is_object()
        {
            data["queuedMessages"] = queue;
        }
        // Native get_state has only a boolean fast flag, which cannot tell the
        // priority tier from ultrafast; the extension reads both accessors.
        if command == "get_state"
            && let Ok(config) = self
                .extension_call(
                    &child,
                    session_path,
                    "pulse-prompt-config",
                    json!({}),
                    EXTENSION_TIMEOUT,
                )
                .await
            && data.is_object()
            && let Some(tier) = config.get("fastModeTier")
        {
            data["fastModeTier"] = tier.clone();
        }
        if command == "get_subagent_messages"
            && let Some(file) = data.get("sessionFile").and_then(Value::as_str)
            && !std::path::Path::new(file).is_file()
        {
            return Err(
                "Agent transcript is unavailable; its retained file no longer exists.".to_string(),
            );
        }
        if matches!(
            command,
            "get_state" | "get_subagents" | "get_subagent_messages"
        ) {
            let _gate = lock_poisoned(&child.gate);
            if !child.alive.load(Ordering::SeqCst)
                || child.binding_epoch.load(Ordering::SeqCst) != epoch
                || lock_poisoned(&child.session).as_str() != session_path
            {
                return Err("agent process session binding changed".to_string());
            }
            if command == "get_subagents" {
                lock_poisoned(&child.retained_agents).merge(epoch, request_sequence, &mut data);
            }
        }
        Ok(data)
    }

    /// Send a prompt and await the RPC response. A successful response is the
    /// child transport's receipt that it accepted the prompt; it is not a
    /// completion signal. Correlated prompt responses and generation lifecycle
    /// evidence are broadcast with commandId; message_end is never turn end.
    /// `delivery` decides how the prompt joins a turn already streaming.
    pub async fn prompt(
        &self,
        session_path: &str,
        command_id: &str,
        text: &str,
        images: &[Value],
        delivery: PromptDelivery,
    ) -> Result<crate::authority::session_state::SourceIdentity, String> {
        self.open(session_path).await?;
        let child = self
            .child(session_path)
            .ok_or_else(|| "agent process not running".to_string())?;
        let source = {
            let _gate = lock_poisoned(&child.gate);
            let binding = lock_poisoned(&child.session);
            if binding.as_str() != session_path {
                return Err("agent process session binding changed".to_string());
            }
            child_identity(&child)
        };
        let mut params = serde_json::Map::<String, Value>::with_capacity(3);
        params.insert("message".to_string(), Value::String(text.to_string()));
        if !images.is_empty() {
            let converted: Vec<Value> = images
                .iter()
                .map(|img| {
                    json!({
                        "type": "image",
                        "data": img.get("data").cloned().unwrap_or(Value::Null),
                        "mimeType": img.get("mimeType").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            params.insert("images".to_string(), Value::Array(converted));
        }
        let (command, streaming_behavior) =
            delivery.child_rpc(child.streaming.load(Ordering::SeqCst));
        if let Some(behavior) = streaming_behavior {
            params.insert(
                "streamingBehavior".to_string(),
                Value::String(behavior.to_string()),
            );
        }
        let result = Self::rpc_with_id(
            &child,
            &format!("pulse-prompt:{command_id}"),
            command,
            Value::Object(params),
            PROMPT_TIMEOUT,
            RpcAccess::Bound(session_path, source.binding_epoch),
        )
        .await;
        result.map(|_| source)
    }

    /// Blocking with no deadline (see [`USER_BASH_TIMEOUT`]); Stop sends
    /// `abort_bash`. Output capped at 256*1024 bytes with
    /// truncated=true. Also broadcasts ChildEvent::BashResult on completion.
    /// `exclude_from_context` is the TUI's `!!`: the output is recorded in the
    /// transcript but never sent to the model. RPC `bash` has no such option
    /// and no output stream (rpc-mode calls `executeBash` with the command
    /// alone), so both variants run through the child extension, which
    /// streams the output as ChildEvent::BashOutput keyed `stream` (the RPC
    /// id when the caller names none). Without this extension, refuse instead
    /// of silently falling back to the agent tool's different shell environment.
    pub async fn bash(
        &self,
        session_path: &str,
        command: &str,
        exclude_from_context: bool,
        stream: Option<&str>,
    ) -> Result<BashResult, String> {
        self.open(session_path).await?;
        let child = self
            .child(session_path)
            .ok_or_else(|| "agent process not running".to_string())?;
        let id = self.next_rpc_id();
        let reply = self
            .extension_call(
                &child,
                session_path,
                "pulse-bash",
                json!({
                    "command": command,
                    "excludeFromContext": exclude_from_context,
                    "stream": stream.unwrap_or(&id),
                }),
                USER_BASH_TIMEOUT,
            )
            .await?;
        let data = reply.get("result").cloned().unwrap_or(Value::Null);
        let result = bash_result_from_data(&data);
        let _ = self.tx.send(ChildEvent::BashResult {
            session: session_path.to_string(),
            id,
            command: command.to_string(),
            result: serde_json::to_value(&result).unwrap_or(Value::Null),
            source: Some(child_source_stamp(&child)),
        });
        touch(&child);
        Ok(result)
    }

    /// Run one phone control (plan mode, a tree move, a label) in the
    /// session's child and return the extension's reply data.
    pub async fn phone_control(
        &self,
        session_path: &str,
        control: PhoneControl,
        payload: Value,
    ) -> Result<Value, String> {
        self.open(session_path).await?;
        let child = self
            .child(session_path)
            .ok_or_else(|| "agent process not running".to_string())?;
        let (name, timeout) = match control {
            PhoneControl::Plan => ("pulse-plan", EXTENSION_TIMEOUT),
            PhoneControl::TreeMove => ("pulse-goto", TREE_MOVE_TIMEOUT),
            PhoneControl::Label => ("pulse-label", EXTENSION_TIMEOUT),
            PhoneControl::PromptConfig => ("pulse-prompt-config", EXTENSION_TIMEOUT),
            PhoneControl::ModelMentionChoices => ("pulse-model-mention-choices", EXTENSION_TIMEOUT),
        };
        self.extension_call(&child, session_path, name, payload, timeout)
            .await
    }

    /// Send extension command `name` as an RPC prompt and await its
    /// `setStatus` reply (src/omp/child/extension.rs). The prompt's RPC response
    /// only says omp routed the command; the reply says what it did.
    async fn extension_call(
        &self,
        child: &Arc<Child>,
        session_path: &str,
        name: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        // INVARIANT: never send a control prompt to a child whose catalogue
        // lacks the extension: omp would hand the text to the model as an
        // ordinary message.
        if !self.extension_available(child, session_path, name).await? {
            return Err(
                "Phone controls didn't load in this agent, so this isn't available here."
                    .to_string(),
            );
        }
        // Stop can identify a tree wait even after its prompt acknowledges.
        let req_id = format!(
            "{}x{}",
            if name == "pulse-goto" { "tree-" } else { "" },
            self.next_id.fetch_add(1, Ordering::SeqCst)
        );
        let (tx, rx) = oneshot::channel();
        {
            let mut replies = lock_poisoned(&child.extension_replies);
            if replies.keys().any(|id| id.starts_with("tree-"))
                && !matches!(
                    name,
                    "pulse-prompt-config"
                        | "pulse-model-mention-choices"
                        | "pulse-command-templates"
                        | "pulse-queue-state"
                )
            {
                return Err("Finish or cancel the current tree move first.".to_string());
            }
            if name == "pulse-goto" {
                *lock_poisoned(&child.tree_cancel) = TreeCancellation::default();
            }
            replies.insert(req_id.clone(), tx);
        }
        child.busy_may_have_changed();
        let _pending = ExtensionReplyGuard {
            child: Arc::clone(child),
            req_id: req_id.clone(),
        };
        let admission = Self::rpc_with_id(
            child,
            &format!("{}{req_id}", extension::RPC_ID_PREFIX),
            "prompt",
            json!({ "message": extension::command_text(name, &req_id, &payload) }),
            if name == "pulse-goto" {
                TREE_MOVE_TIMEOUT
            } else {
                PROMPT_TIMEOUT
            },
            RpcAccess::Bound(session_path, child.binding_epoch.load(Ordering::SeqCst)),
        )
        .await?;
        // Native RPC can cancel a queued prompt before its command handler
        // runs. That response has no agentInvoked field and no status reply
        // will follow; do not leave Stop waiting on an uncreated UI channel.
        if name == "pulse-goto"
            && admission.get("agentInvoked").is_none()
            && lock_poisoned(&child.tree_cancel).stop_requested
        {
            return Ok(json!({ "cancelled": true }));
        }
        let reply = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => return Err("rpc channel closed (agent process terminated)".to_string()),
            Err(_) => return Err("The agent didn't answer in time.".to_string()),
        };
        touch(child);
        extension_reply_result(reply)
    }

    /// Older controls retain the per-child extension probe cache. Metadata
    /// always proves its exact command, since older extensions lack those reads.
    async fn extension_available(
        &self,
        child: &Arc<Child>,
        session_path: &str,
        name: &str,
    ) -> Result<bool, String> {
        let metadata = matches!(
            name,
            "pulse-prompt-config"
                | "pulse-model-mention-choices"
                | "pulse-command-templates"
                | "pulse-queue-state"
                | "pulse-queue-remove"
                | "pulse-queue-promote"
        );
        if !metadata && child.extension_ready.load(Ordering::SeqCst) {
            return Ok(true);
        }
        let catalogue = self
            .rpc_on_bound(
                child,
                session_path,
                "get_available_commands",
                json!({}),
                RPC_TIMEOUT,
            )
            .await?;
        let loaded = extension::catalogue_has_command(&catalogue, name);
        if loaded && !metadata {
            child.extension_ready.store(true, Ordering::SeqCst);
        }
        Ok(loaded)
    }

    /// Abort the session's running turn. Without a live child nothing of ours
    /// is running, so this is a no-op rather than a ~300-430 MiB boot that
    /// would only abort an idle session (a reaped child was idle by
    /// definition). An open already in flight is waited out first, so a Stop
    /// pressed during a cold boot still reaches the child it was meant for.
    ///
    /// `Ok(None)` means no agent of ours was there to stop: no child, or the
    /// child died before answering. The caller settles a turn that still
    /// looks running, since nothing will ever end it otherwise.
    ///
    /// With `restore_queue`, the child runs `abort_and_restore_queue` and
    /// `Ok(Some(data))` is its `{steering[], followUp[]}` of `{text, images?}`:
    /// the queued messages withdrawn before the abort. A plain `abort`
    /// requeues stranded input and drains it into a fresh turn once the
    /// session settles, so Stop with a queued follow-up started the agent
    /// again (omp rpc.md "abort"). Only a caller that hands the withdrawn text
    /// back to the user may ask for it: the notification Stop action ignores
    /// the reply, and withdrawing there would lose the messages.
    pub async fn abort(
        &self,
        session_path: &str,
        restore_queue: bool,
    ) -> Result<Option<Value>, String> {
        self.settle_open(session_path).await;
        let Some(child) = self.child(session_path) else {
            return Ok(None);
        };
        let tree_pending = lock_poisoned(&child.extension_replies)
            .keys()
            .any(|id| id.starts_with("tree-"));
        let cancel_id = {
            let mut cancel = lock_poisoned(&child.tree_cancel);
            if tree_pending || cancel.request_id.is_some() {
                cancel.stop_requested = true;
            }
            cancel.request_id.clone()
        };
        if let Some(id) = cancel_id {
            self.forward_ui_response(
                session_path,
                &json!({
                    "type":"extension_ui_response", "id":id, "cancelled":true,
                }),
            );
        }
        // Historical AskTool.execute runs outside an agent turn, so native
        // abort has no tool-call signal to close its UI. Cancel pending input
        // explicitly through the normal response path; this never holds the
        // gate while a human is answering.
        let dialog_ids: Vec<String> = lock_poisoned(&child.pending_ui).keys().cloned().collect();
        for id in dialog_ids {
            self.forward_ui_response(
                session_path,
                &json!({
                    "type": "extension_ui_response", "id": id, "cancelled": true,
                }),
            );
        }
        let command = if restore_queue {
            "abort_and_restore_queue"
        } else {
            "abort"
        };
        match Self::rpc_with_id(
            &child,
            &self.next_rpc_id(),
            command,
            Value::Null,
            ABORT_TIMEOUT,
            RpcAccess::Bound(session_path, child.binding_epoch.load(Ordering::SeqCst)),
        )
        .await
        {
            Ok(data) => Ok(Some(data)),
            Err(_) if !child.alive.load(Ordering::SeqCst) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Spawn a fresh session: spawn in cwd → negotiate → subscribe →
    /// new_session (30s) → get_state; returns `data.sessionFile`.
    pub async fn new_session(&self, cwd: &str) -> Result<String, String> {
        // A brand-new session has no existing child to retarget, so a refusal
        // here is terminal: report it instead of booting past the cap.
        let reserved = self.try_reserve().await.ok_or_else(|| self.busy_error())?;
        let boot_started = Instant::now();
        let child = self.spawn(cwd, String::new(), reserved)?;
        let outcome = async {
            self.rpc_on(
                &child,
                "negotiate_protocol",
                json!({ "protocolVersion": 2 }),
                NEGOTIATE_TIMEOUT,
            )
            .await?;
            self.enable_ask_dialog(&child).await;
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
            let ns = self
                .rpc_on(&child, "new_session", Value::Null, SWITCH_SESSION_TIMEOUT)
                .await?;
            if ns.get("cancelled").and_then(|c| c.as_bool()) == Some(true) {
                return Err("new_session was cancelled".to_string());
            }
            let st = self
                .rpc_on(&child, "get_state", Value::Null, GET_STATE_TIMEOUT)
                .await?;
            let session_file = st
                .get("sessionFile")
                .and_then(|s| s.as_str())
                .ok_or_else(|| "new_session: no sessionFile in get_state".to_string())?
                .to_string();
            Ok(session_file)
        }
        .await;
        match outcome {
            Ok(session_file) => {
                metrics::inc("child_spawn");
                metrics::observe_ms("child_boot_ms", boot_started.elapsed().as_millis() as u64);
                if let Err(error) = self.register_child(&child, &session_file) {
                    self.kill(&child, "new_session registration failure", Exit::Unexpected);
                    return Err(error);
                }
                touch(&child);
                // The session file only exists after the new_session RPC, so
                // the ownership claim is declared here (see do_open for why
                // the sidecar matters); best-effort, non-fatal.
                let _ = crate::authority::owner::declare(&session_file, child.pid, "rpc");
                // Registration publishes routing only; the physical charge stays.
                self.trim_to_cap().await;
                info!("new session created: {session_file}");
                Ok(session_file)
            }
            Err(e) => {
                self.kill(&child, "new_session failure", Exit::Unexpected);
                Err(e)
            }
        }
    }

    /// Run ONE slash command on a short-lived, never-registered child and return
    /// what it printed. For commands whose answer belongs to the account or the
    /// build, not to a conversation (`/usage` reports provider quota): no
    /// session is bound, nothing is written, and it works while the desktop owns
    /// every session file. The phone gets a sheet, never a chat message.
    pub async fn run_command_detached(&self, cwd: &str, text: &str) -> Result<CommandRun, String> {
        let reserved = self.try_reserve().await.ok_or_else(|| self.busy_error())?;
        let (child, scope) = self.spawn_ephemeral(cwd, reserved)?;
        let mut events = self.tx.subscribe();
        let identity = child_identity(&child);
        let outcome = async {
            self.rpc_on(
                &child,
                "negotiate_protocol",
                json!({ "protocolVersion": 2 }),
                NEGOTIATE_TIMEOUT,
            )
            .await?;
            self.rpc_on(&child, "prompt", json!({ "message": text }), PROMPT_TIMEOUT)
                .await
        }
        .await;
        let run = outcome.map(|data| command_run(&mut events, &identity, &data));
        drop(scope);
        run
    }

    /// Run a slash command on the session's own child and return what it
    /// printed. The command goes straight to omp's prompt handler, which runs
    /// builtins locally: nothing is queued, no user message is written, and the
    /// phone shows the output in a sheet. `agent_invoked` is true when the
    /// command went on to start a model turn (some do), which then streams like
    /// any other.
    pub async fn run_command(&self, session_path: &str, text: &str) -> Result<CommandRun, String> {
        self.open(session_path).await?;
        let child = self
            .child(session_path)
            .ok_or_else(|| "agent process not running".to_string())?;
        let mut events = self.tx.subscribe();
        let id = format!("pulse-command:{}", self.next_rpc_id());
        let identity = child_identity(&child);
        let data = Self::rpc_with_id(
            &child,
            &id,
            "prompt",
            json!({ "message": text }),
            PROMPT_TIMEOUT,
            RpcAccess::Bound(session_path, identity.binding_epoch),
        )
        .await?;
        touch(&child);
        Ok(command_run(&mut events, &identity, &data))
    }

    /// Best-effort write of a raw client frame (extension_ui_response) to the
    /// child's stdin, serialized through the same stdin mutex as rpc writes.
    /// A pipe write only reserves the matching request. OMP cancellation,
    /// its ask tool result or turn termination provides closure evidence.
    pub fn forward_ui_response(&self, session_path: &str, frame: &Value) {
        let Some(child) = self.child(session_path) else {
            return;
        };
        forward_ui_response_to_child(&self.tx, child, session_path, frame);
    }

    /// Report pipe handoff to an HTTP answer caller; never claim callback acceptance.
    pub async fn answer_ui_response(
        &self,
        session_path: &str,
        frame: &Value,
    ) -> Result<(), String> {
        let child = self
            .child(session_path)
            .ok_or_else(|| "the session is no longer running".to_string())?;
        start_ui_response_to_child(&self.tx, child, session_path, frame)?
            .await
            .map_err(|_| "answer delivery is unknown; the session connection ended".to_string())?
    }

    /// Stop all live children (abort-first so no session is left with an
    /// unfinished turn) and tear down their registries.
    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        // Maintenance may be parked on an empty route map.
        self.child_added.notify_one();
        let children: Vec<Arc<Child>> = lock_poisoned(&self.children).values().cloned().collect();
        info!("shutdown: terminating {} child process(es)", children.len());
        for c in children {
            self.graceful_terminate(&c, "shutdown", Exit::Planned).await;
        }
    }

    /// Stop the child for ONE session and drop it from the registry.
    ///
    /// Used when a desktop TUI adopts a session file we were writing: from that
    /// moment our child is a second writer to a file whose owner rewrites it
    /// wholesale from memory, so it must stop immediately. Abort-first, so a
    /// streaming turn ends on a clean boundary instead of mid-message. No-op
    /// when no live child exists.
    pub async fn close(&self, session_path: &str) {
        let Some(child) = self.child(session_path) else {
            return;
        };
        // Unexpected on purpose: the phone's laptop-handoff notice keys on
        // this exit's error frame.
        self.graceful_terminate(&child, "session adopted by a terminal", Exit::Unexpected)
            .await;
    }

    /// Stop the child whose session omp just deleted (`/session delete`).
    /// omp closes its writer before deleting, but the session manager still
    /// names the deleted path, so the next prompt would resurrect the file
    /// (builtin-session.ts). A planned stop: the end is known, nothing is lost.
    ///
    /// Returns once the process is reaped (SIGKILL after
    /// [`DELETED_EXIT_GRACE`]), so the caller can unlink without the exiting
    /// writer flushing the file back. `has_child` is no exit signal:
    /// `finish_child` deregisters at SIGTERM, before the process is gone.
    /// `false` when no exit was observed within the deadlines.
    pub async fn stop_deleted(&self, session_path: &str) -> bool {
        let Some(child) = self.child(session_path) else {
            return true;
        };
        self.graceful_terminate(&child, "session deleted", Exit::Planned)
            .await;
        if await_reaped(&child, DELETED_EXIT_GRACE).await {
            return true;
        }
        warn!(
            "deleted session's child pid={} ignored SIGTERM; killing it",
            child.pid
        );
        if let Some(owner) = &child.physical {
            owner.request_stop(|process| submit_kill(child.pid, process));
        }
        let reaped = await_reaped(&child, DELETED_KILL_GRACE).await;
        if !reaped {
            warn!(
                "deleted session's child pid={} still not reaped after SIGKILL",
                child.pid
            );
        }
        reaped
    }

    // --- internal -----------------------------------------------------------

    /// The live (alive) child for a session, if any.
    fn child(&self, session_path: &str) -> Option<Arc<Child>> {
        let map = lock_poisoned(&self.children);
        let c = map.get(session_path)?;
        if c.alive.load(Ordering::SeqCst) {
            Some(Arc::clone(c))
        } else {
            None
        }
    }
}

// --- state mapping -----------------------------------------------------------

/// Map the child's bash response to the phone wire shape. The real bash data
/// has output/exitCode/cancelled/truncated (and totalLines/…/artifactId) but
/// NO workingDir — populate it with "" to keep the wire shape. Output is
/// capped at MAX_BASH_OUTPUT with truncated=true.
fn bash_result_from_data(data: &Value) -> BashResult {
    let raw = data
        .get("output")
        .and_then(|o| o.as_str())
        .unwrap_or("")
        .to_string();
    let child_truncated = data
        .get("truncated")
        .and_then(|t| t.as_bool())
        .unwrap_or(false);
    let truncated = child_truncated || raw.len() > MAX_BASH_OUTPUT;
    let output = if raw.len() > MAX_BASH_OUTPUT {
        // Never split a UTF-8 char at the cap.
        let mut end = MAX_BASH_OUTPUT;
        while end > 0 && !raw.is_char_boundary(end) {
            end -= 1;
        }
        raw[..end].to_string()
    } else {
        raw
    };
    BashResult {
        exit_code: data
            .get("exitCode")
            .and_then(|c| c.as_i64())
            .map(|c| c as i32),
        output,
        working_dir: String::new(),
        cancelled: data
            .get("cancelled")
            .and_then(|c| c.as_bool())
            .unwrap_or(false),
        truncated,
    }
}

// --- small helpers -----------------------------------------------------------

fn touch(child: &Child) {
    let _gate = lock_poisoned(&child.gate);
    touch_locked(child);
}

/// Caller holds the child gate.
fn touch_locked(child: &Child) {
    child.last_active.store(now_ms(), Ordering::SeqCst);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lock a std Mutex, recovering from poisoning so one panicked task can never
/// cascade into the rest of the daemon.
fn lock_poisoned<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests;
