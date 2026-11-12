//! Cross-platform session-file tailer.
//!
//! Primary trigger: ONE `notify` watcher instance watching each session file
//! with `RecursiveMode::NonRecursive` — `notify::RecommendedWatcher` (inotify
//! on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows), or
//! `notify::PollWatcher` when forced via `OMP_PULSE_WATCH_POLL=1` (network
//! filesystems and some containers never deliver native events). notify calls
//! its handler on its own thread, so the handler only forwards the event
//! paths over the command channel; a tokio task maps them onto watched paths
//! and forward-reads the newly appended bytes, broadcasting `WatchEvent`s on
//! the shared channel (the router task in main.rs serializes them once to WS
//! frames). A fallback tick task stat-compares every watched path every
//! `watch_interval_ms` (250 ms) and re-arms the native watch where that is
//! idempotent, covering files replaced via rename (the inotify watch on the
//! old inode goes stale), events the native layer coalesces or drops
//! (FSEvents latency, inotify queue overflow, Windows directory-level
//! reporting, network filesystems), and a path whose watch was never added
//! (e.g. the file did not exist yet). The tick is the correctness net; the
//! native layer only improves latency. With no audience (no visible client
//! with queue headroom) the tick parks until the hub reports one, then
//! catches up at once. Both drainers go through per-path
//! state locked independently, so a given byte delta is never broadcast twice
//! and one slow session file never serializes every other watched session
//! behind it (docs/internals/performance.md F12: a single global mutex held across metadata +
//! reads + parse + broadcast). No lock is held across `.await`.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use notify::{RecursiveMode, Watcher as NotifyWatcher};
use tokio::sync::{broadcast, mpsc};
use tracing::{error, info, warn};

use crate::sessions::jsonl;
use crate::types::*;

/// Entries per forward-read batch (mirrors the REST `/api/history` limit).
const BATCH_LIMIT: usize = 200;
/// Largest undelivered growth still tailed incrementally. Beyond it the client
/// is told to repaint instead. Sized well above any real turn (a big tool output
/// is a few hundred KiB) and far below the point where parsing costs real
/// memory.
const MAX_TAIL_CATCHUP: u64 = 8 * 1024 * 1024;
/// Fixed scratch space for the attachment-only backward boundary probe.
const ATTACH_PROBE_CHUNK: usize = 4096;
/// Keep ordinary partials reusable, but do not pin a large completed tail
/// for the lifetime of a watched conversation.
const MAX_IDLE_PARTIAL_CAPACITY: usize = 256 * 1024;

/// Keep a record that was already mid-write when the watch attached reachable.
/// Initial history cannot parse torn JSON; starting at raw EOF would discard
/// the record's prefix and silently consume its eventual suffix as malformed.
/// If a bounded probe cannot establish a boundary, start at sampled EOF and
/// request history when that unfinished record completes.
fn attachment_offset(path: &Path, metadata: &std::fs::Metadata) -> (u64, bool) {
    let size = metadata.len();
    // Do not introduce an open of a known non-regular target (for example a
    // FIFO) just to establish a baseline. This is admission, not a race-free
    // guarantee against a path being replaced after metadata was sampled.
    if size == 0 || !metadata.is_file() {
        return (size, false);
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return (size, true);
    };
    match probe_attachment_boundary(&mut file, size) {
        Ok(Some(offset)) => (offset, false),
        Ok(None) | Err(_) => (size, true),
    }
}

#[cfg(test)]
fn probe_attachment_offset(
    reader: &mut (impl std::io::Read + std::io::Seek),
    size: u64,
) -> std::io::Result<u64> {
    Ok(probe_attachment_boundary(reader, size)?.unwrap_or(size))
}

fn probe_attachment_boundary(
    reader: &mut (impl std::io::Read + std::io::Seek),
    size: u64,
) -> std::io::Result<Option<u64>> {
    let lower = size.saturating_sub(MAX_TAIL_CATCHUP);
    let mut end = size;
    let mut chunk = [0u8; ATTACH_PROBE_CHUNK];
    while end > lower {
        let take = (end - lower).min(chunk.len() as u64) as usize;
        let start = end - take as u64;
        reader.seek(std::io::SeekFrom::Start(start))?;
        reader.read_exact(&mut chunk[..take])?;
        if let Some(newline) = chunk[..take].iter().rposition(|&byte| byte == b'\n') {
            return Ok(Some(start + newline as u64 + 1));
        }
        end = start;
    }
    // The cap includes the delimiter byte. Without it, only reaching the
    // actual file start proves a boundary; never guess at the probe's edge.
    Ok((lower == 0).then_some(0))
}

/// Find the end of a skipped, oversized record without buffering its suffix.
fn next_line_boundary(
    reader: &mut (impl std::io::Read + std::io::Seek),
    start: u64,
    end: u64,
) -> std::io::Result<Option<u64>> {
    reader.seek(std::io::SeekFrom::Start(start))?;
    let mut position = start;
    let mut chunk = [0u8; ATTACH_PROBE_CHUNK];
    while position < end {
        let take = (end - position).min(chunk.len() as u64) as usize;
        reader.read_exact(&mut chunk[..take])?;
        if let Some(newline) = chunk[..take].iter().position(|&byte| byte == b'\n') {
            return Ok(Some(position + newline as u64 + 1));
        }
        position += take as u64;
    }
    Ok(None)
}

/// notify's inotify backend watches IN_OPEN, reported as `Access(Open)`.
/// An open never changes a file, and the daemon's own reads produce them, so
/// waking on one turns every read into another scan (bridge.rs, `start`).
pub(crate) fn is_open_event(event: &notify::Event) -> bool {
    matches!(
        event.kind,
        notify::EventKind::Access(notify::event::AccessKind::Open(_))
    )
}

/// Per-path tail state, owned by exactly one `Arc<Mutex<PathState>>` in the
/// watcher's map. The map lock is held only to look up the handle; all
/// metadata/read/parse/broadcast work happens under the per-path lock, so
/// concurrent drains of DIFFERENT sessions never contend (docs/internals/performance.md F12).
///
/// `offset` is the number of bytes already delivered as complete entries;
/// `size` is the file size at the last drain (change detection for the
/// fallback tick); `tail` mirrors the still-growing unterminated line beyond
/// `offset` incrementally; `broadcast` remembers the last broadcast tail
struct PathState {
    offset: u64,
    // EOF last skipped without an audience. Resolve its preceding record
    // boundary only once a client can receive, never while hidden.
    skipped_eof: Option<u64>,
    // No delimiter was found inside the bounded probe. Skip the remaining
    // fragment, then request history once its newline arrives.
    skipped_fragment: bool,
    size: u64,
    // mtime alongside size: a same-length rewrite preserves size but
    // changes mtime, and size-only comparison would miss it (the session
    // would silently stop updating until something else nudged it). This
    // runs every 250ms per watched session, so we keep it cheap — a single
    // stat's mtime, no hashing of file contents.
    mtime: Option<SystemTime>,
    tail: PartialTail,
    broadcast: Option<(u64, u64, u64)>, // (anchor, extent, hash) last broadcast
}
impl PathState {
    fn new() -> Self {
        PathState {
            offset: 0,
            skipped_eof: None,
            skipped_fragment: false,
            size: 0,
            mtime: None,
            tail: PartialTail::new(),
            broadcast: None,
        }
    }
}

/// FNV-1a offset basis (64-bit).
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
/// FNV-1a prime (64-bit).
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Incremental tracker for the unterminated tail beyond `offset` (the bytes
/// omp is mid-write). `bytes` mirrors the file region [`anchor`, `extent`)
/// as RAW bytes with byte-exact extents; the lossy decode happens only at
/// broadcast time, so the text a client receives is byte-identical to the
/// old per-drain `read_tail` re-read, while a drain now folds only the delta
/// bytes read since the last drain — O(delta) instead of re-reading
/// [`offset`, EOF) every time (docs/internals/performance.md F7/F12; an 8 MiB partial line used to
/// be re-read in full on every 250 ms tick).
///
/// `hash` is FNV-1a over `bytes`, folded incrementally, so the dedup compare
/// is O(1) after an O(delta) fold. (Anchor+extent monotonicity already make
/// the region-vs-last-broadcast comparison exact; the hash is kept as a
/// cheap defence against any future in-place rewrite path.)
struct PartialTail {
    anchor: u64, // file offset the tail region starts at; == offset when seeded
    extent: u64, // file offset just past the last byte folded in
    bytes: Vec<u8>,
    hash: u64,
}

impl PartialTail {
    fn new() -> Self {
        PartialTail {
            anchor: 0,
            extent: 0,
            bytes: Vec::new(),
            hash: FNV_OFFSET,
        }
    }

    fn clear(&mut self) {
        self.anchor = 0;
        self.extent = 0;
        if self.bytes.capacity() > MAX_IDLE_PARTIAL_CAPACITY {
            self.bytes = Vec::new();
        } else {
            self.bytes.clear();
        }
        self.hash = FNV_OFFSET;
    }

    fn state(&self) -> (u64, u64, u64) {
        (self.anchor, self.extent, self.hash)
    }

    /// Replace the tracked region wholesale (anchor moved, or the file
    /// shrank back into the partial so the folded bytes no longer mirror it).
    fn seed(&mut self, anchor: u64, bytes: &[u8]) {
        self.anchor = anchor;
        self.extent = anchor + bytes.len() as u64;
        self.bytes.clear();
        self.bytes.extend_from_slice(bytes);
        self.hash = fnv1a(bytes);
    }

    /// Fold newly appended bytes into the tracked region (same anchor).
    fn append(&mut self, bytes: &[u8]) {
        self.extent += bytes.len() as u64;
        for &b in bytes {
            self.hash = (self.hash ^ b as u64).wrapping_mul(FNV_PRIME);
        }
        self.bytes.extend_from_slice(bytes);
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for &b in bytes {
        h = (h ^ b as u64).wrapping_mul(FNV_PRIME);
    }
    h
}

/// Commands for the native watcher task. `watch()`/`unwatch()` are sync and
/// are called from the HTTP layer, so they never touch the watcher handle
/// directly — they mutate the shared state map and push a command that the
/// owning task applies to the `notify` watcher. `Events` carries the paths of
/// native events, forwarded by notify's callback thread over this same
/// channel (so the task applies them in order, on the daemon's own task,
/// never inline on notify's thread).
enum Cmd {
    Add(String),
    Remove(String),
    Events(Vec<String>),
}

/// Predicate: should this session's appended entries be read and parsed?
pub type Audience = std::sync::Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Told which session's tail was just skipped for lack of an audience, so the
/// hub can owe its hidden clients a resync (`WsHub::tail_skipped`).
pub type SkipHook = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

/// True when the native backend can be re-watched idempotently: inotify uses
/// `IN_MASK_ADD` (the re-arm re-points the watch to a new inode after a
/// rename-replace), and the poll watcher is a HashMap insert. FSEvents
/// restarts the entire stream and ReadDirectoryChangesW opens a second
/// handle per duplicate watch, so on those backends re-watching a live path
/// is neither cheap nor needed — their watches are path- or
/// parent-directory-based and survive file replacement, and the tick's
/// stat-compare drain is the net.
#[cfg(any(target_os = "linux", target_os = "android"))]
const NATIVE_REARMS: bool = true;
#[cfg(not(any(target_os = "linux", target_os = "android")))]
const NATIVE_REARMS: bool = false;

/// Which notify backend the native task builds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Backend {
    /// `notify::PollWatcher`: mtime/size polling at `watch_interval_ms`.
    Poll,
    /// The platform-native backend (`notify::RecommendedWatcher`).
    Native,
}

impl Backend {
    /// Can `watch()` be safely re-issued for an already-watched path? Poll
    /// mode re-watches on every platform (HashMap insert); the native backend
    /// only where the platform's kernel makes it idempotent.
    fn rearms(&self) -> bool {
        matches!(self, Backend::Poll) || NATIVE_REARMS
    }

    fn label(&self) -> &'static str {
        match self {
            Backend::Poll => "poll",
            Backend::Native => "native",
        }
    }
}

/// Pick the backend. `OMP_PULSE_WATCH_POLL=1` forces the poll watcher:
/// network filesystems (NFS, WSL2 crossings) and some containers never
/// deliver native events. Correctness does not depend on this choice — the
/// tick's stat-compare covers every watched path regardless — so poll mode
/// only trades event latency for portability.
fn select_backend() -> Backend {
    select_backend_for(std::env::var("OMP_PULSE_WATCH_POLL").ok().as_deref())
}

/// Pure backend-selection core; only the exact value `"1"` opts in. Split
/// from [`select_backend`] so the choice is testable without touching
/// process-global env.
fn select_backend_for(poll_env: Option<&str>) -> Backend {
    match poll_env {
        Some("1") => Backend::Poll,
        _ => Backend::Native,
    }
}

/// The native task's bookkeeping: which paths notify is (believed to be)
/// watching, plus the re-arm policy. Owned by `native_task`; kept as a plain
/// struct so the event-mapping rule and the Add/Remove bookkeeping are
/// unit-testable without constructing an OS watcher.
struct NativeWatches {
    /// Paths we asked notify to watch (and that it accepted).
    watched: HashSet<String>,
    /// `Backend::rearms()`: may `watch()` be re-issued for a live path?
    rearms: bool,
    /// Paths whose watch failed recently; rate-limits the warn logs (the
    /// tick retries every `watch_interval_ms`, and a path can legitimately
    /// be unwatchable for a long stretch, e.g. its file was deleted while a
    /// WS client is connected).
    warned: HashSet<String>,
}

impl NativeWatches {
    fn new(rearms: bool) -> Self {
        NativeWatches {
            watched: HashSet::new(),
            rearms,
            warned: HashSet::new(),
        }
    }

    /// Decide whether a `Cmd::Add` should reach notify. Re-issuing `watch()`
    /// for an already-watched path is only safe where it is idempotent:
    /// inotify (`IN_MASK_ADD` re-points the watch to a new inode, which is
    /// how a rename-replaced file gets native events again) and poll (a
    /// HashMap insert that also picks up paths that did not exist when first
    /// watched). FSEvents restarts the entire stream and ReadDirectoryChangesW
    /// opens a second handle per duplicate, and neither needs the re-arm —
    /// their watches are path- or parent-directory-based and keep delivering
    /// events across file replacement — so there the tick's stat-compare
    /// drain is the re-arm.
    fn on_add(&self, path: &str) -> bool {
        !self.watched.contains(path) || self.rearms
    }

    /// A `watch()` call succeeded.
    fn added(&mut self, path: &str) {
        self.watched.insert(path.to_string());
        self.warned.remove(path);
    }

    /// A `watch()` call failed; returns true when this failure should be
    /// logged (first failure for this path since its last success).
    fn add_failed(&mut self, path: &str) -> bool {
        self.warned.insert(path.to_string())
    }

    /// A `Cmd::Remove` was applied: drop the path from the native set so
    /// stale events for it are ignored from here on.
    fn on_remove(&mut self, path: &str) {
        self.watched.remove(path);
    }

    /// Map native event paths onto watched paths. The rule: an event is
    /// acted on only when its path is EXACTLY a watched path. notify's
    /// backends reconstruct the full file path (inotify watches the file
    /// itself; FSEvents reports the watched path; the Windows backend watches
    /// the parent directory but filters and reports the exact file path; poll
    /// reports what it was asked to watch), so a session file event arrives
    /// with the session file's path. Anything else — sibling files,
    /// parent-directory noise, non-UTF-8 lossy conversions — is ignored
    /// rather than guessed at; the tick's stat-compare covers whatever the
    /// native layer never reported.
    fn matched<'a>(&'a self, paths: &'a [String]) -> Vec<&'a str> {
        paths
            .iter()
            .filter(|p| self.watched.contains(*p))
            .map(|p| p.as_str())
            .collect()
    }
}

pub struct Watcher {
    cfg: SharedConfig,
    tx: broadcast::Sender<WatchEvent>,
    state: Mutex<HashMap<String, Arc<Mutex<PathState>>>>,
    cmd_tx: mpsc::UnboundedSender<Cmd>,
    cmd_rx: Mutex<Option<mpsc::UnboundedReceiver<Cmd>>>,
    /// Does anything consume `Entries` for this session right now? Reading and
    /// parsing appended JSON costs O(appended) work and transient memory.
    /// Measured: appending 150 MiB to a session nobody could receive grew
    /// daemon RSS 320 MiB parsing entries that were then thrown away, with
    /// the hub's queue never holding a single frame. In the daemon this is
    /// `WsHub::has_audience`: a VISIBLE client with queue headroom.
    /// When the answer is no, the tail is skipped and the offset jumps to EOF —
    /// a client that attaches later loads history over HTTP, which is exactly
    /// how the initial paint already works.
    audience: Audience,
    /// Reports each skipped tail (see [`SkipHook`]). Unset in tests that only
    /// exercise tailing.
    skipped: std::sync::OnceLock<SkipHook>,
    /// Wakes the fallback tick when a path is watched; with nothing watched
    /// (no conversation open) the tick parks instead of waking 4×/s.
    wake: tokio::sync::Notify,
    /// Wakes the fallback tick when a watched session may have regained an
    /// audience ([`Watcher::audience_changed`]). With paths watched but
    /// nobody able to receive a tail (phone locked, app backgrounded) the
    /// tick parks here instead of waking 4×/s for nothing.
    audience_wake: tokio::sync::Notify,
}

impl Watcher {
    /// Create the watcher. The native and tick tasks are spawned by
    /// [`Watcher::start`]; `watch`/`unwatch` may be used before then (the
    /// commands queue until the channel is consumed).
    pub fn new(
        config: SharedConfig,
        tx: tokio::sync::broadcast::Sender<WatchEvent>,
        audience: Audience,
    ) -> Arc<Self> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        Arc::new(Watcher {
            cfg: config,
            tx,
            state: Mutex::new(HashMap::new()),
            cmd_tx,
            cmd_rx: Mutex::new(Some(cmd_rx)),
            audience,
            skipped: std::sync::OnceLock::new(),
            wake: tokio::sync::Notify::new(),
            audience_wake: tokio::sync::Notify::new(),
        })
    }

    /// Install the skipped-tail report (main.rs, once at boot; a second call
    /// is ignored).
    pub fn on_tail_skipped(&self, hook: SkipHook) {
        let _ = self.skipped.set(hook);
    }

    /// A watched session may have just gained an audience (a client attached,
    /// a page became visible, a stalled client drained): restart a parked
    /// tick. Cheap and non-blocking; a wake with no parked tick is kept as
    /// one permit, so a wake racing the park is never lost.
    pub fn audience_changed(&self) {
        self.audience_wake.notify_one();
    }

    /// Delivered offset for a watched path (tests only: proves the no-audience
    /// path still advances past skipped bytes).
    #[cfg(test)]
    pub fn offset_for(&self, path: &str) -> Option<u64> {
        let state = self.state();
        let entry = state.get(path)?;
        let ps = entry.lock().unwrap_or_else(|p| p.into_inner());
        Some(ps.offset)
    }

    /// Commands queued for the native task (tests only: proves `unwatch`
    /// emits the native-watch removal). Drains and detaches the test's
    /// receiver; `start()` re-takes it in real use.
    #[cfg(test)]
    fn queued_commands(&self) -> Vec<Cmd> {
        let mut out = Vec::new();
        if let Some(mut rx) = self.cmd_rx().take() {
            while let Ok(cmd) = rx.try_recv() {
                out.push(cmd);
            }
        }
        out
    }

    /// Spawn the native event task and the fallback tick task.
    pub fn start(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let cmd_rx = this.cmd_rx().take();
            match cmd_rx {
                Some(rx) => native_task(this, rx).await,
                None => warn!("watcher.start() called twice; watcher task already running"),
            }
        });
        let this = Arc::clone(self);
        tokio::spawn(async move { tick_task(this).await });
    }

    /// Start tailing a session file. A new path probes a bounded suffix so
    /// an unfinished final record can complete; older history comes from REST.
    /// Re-watching an existing path preserves its undelivered tail: a second
    /// viewer must not advance past bytes the first viewer has not received.
    pub fn watch(&self, session_path: &str) {
        // Initialize before publishing the path. Another viewer or drainer
        // must never observe an uninitialized offset (and stream old history).
        if self.state().contains_key(session_path) {
            let _ = self.cmd_tx.send(Cmd::Add(session_path.to_string()));
            self.wake.notify_one();
            return;
        }
        let (size, mtime, offset, skipped_fragment) = std::fs::metadata(session_path)
            .map(|m| {
                let (offset, skipped_fragment) = attachment_offset(Path::new(session_path), &m);
                (m.len(), m.modified().ok(), offset, skipped_fragment)
            })
            .unwrap_or((0, None, 0, false));
        let mut ps = PathState::new();
        ps.offset = offset;
        ps.skipped_fragment = skipped_fragment;
        ps.size = size;
        ps.mtime = mtime;
        // Concurrent initial attaches keep whichever baseline was published
        // first; the other must not reset any progress it has already made.
        self.state()
            .entry(session_path.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(ps)));
        let _ = self.cmd_tx.send(Cmd::Add(session_path.to_string()));
        self.wake.notify_one();
    }

    /// Stop tailing a session file and drop its native watch. The HTTP
    /// layer calls this when the last WS client for the session detaches.
    pub fn unwatch(&self, session_path: &str) {
        self.state().remove(session_path);
        let _ = self.cmd_tx.send(Cmd::Remove(session_path.to_string()));
    }

    /// Number of session files currently being tailed.
    pub fn watched_count(&self) -> usize {
        self.state().len()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Mutex<PathState>>>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn cmd_rx(&self) -> std::sync::MutexGuard<'_, Option<mpsc::UnboundedReceiver<Cmd>>> {
        self.cmd_rx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Forward-read the newly appended bytes for one path and broadcast the
    /// deltas. The map lock is held only to clone the per-path handle; the
    /// metadata/read/parse/broadcast run under that path's own lock, so
    /// concurrent drainers (native events and the fallback tick) can never
    /// double-broadcast the same bytes — whoever drains first advances
    /// `offset`, and the other sees no progress — while different sessions
    /// never serialize behind each other (docs/internals/performance.md F12).
    fn drain(&self, path: &str) {
        let entry = {
            let state = self.state();
            match state.get(path) {
                Some(ps) => Arc::clone(ps),
                None => return,
            }
        };
        let mut ps = entry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            // Vanished mid-watch: keep the state so a reappearance resumes;
            // the fallback tick re-arms the watch.
            Err(_) => return,
        };
        let size = metadata.len();
        let mtime = metadata.modified().ok();

        // Shrink: the offset is past EOF (truncation or a rewrite to a
        // smaller file). Reset the offset and tell clients to refetch
        // history.
        if size < ps.offset {
            ps.offset = size;
            ps.skipped_eof = None;
            ps.skipped_fragment = false;
            ps.size = size;
            ps.mtime = mtime;
            ps.tail.clear();
            ps.broadcast = None;
            let _ = self.tx.send(WatchEvent::Poll {
                session: path.to_string(),
            });
            return;
        }

        // Nothing changed since the last drain — the common case on tick for
        // paths whose native watch is healthy. Cheap stat-compare on size
        // AND mtime: a same-length rewrite preserves size but changes mtime,
        // so size-only comparison would miss it and the session would
        // silently stop updating until something else nudged it.
        if size == ps.size && mtime == ps.mtime {
            return;
        }
        // Same-length rewrite: mtime changed but size did not — the file
        // was rewritten in place and history before `offset` may be stale.
        // The safest recovery is a Poll so the client refetches over HTTP
        // (paged/compressed); otherwise the phone would show a truncated
        // transcript forever.
        let old_size = ps.size;
        let old_mtime = ps.mtime;
        let same_length_rewrite = mtime != old_mtime && size == old_size;
        // Whether the file shrank but stayed at/above the delivered offset:
        // a rewrite back into the partial invalidates the folded tail bytes.
        let shrank = size < old_size;
        ps.size = size;
        ps.mtime = mtime;
        if same_length_rewrite {
            ps.tail.clear();
            ps.broadcast = None;
            let _ = self.tx.send(WatchEvent::Poll {
                session: path.to_string(),
            });
            return;
        }
        if let Some(skipped_eof) = ps.skipped_eof
            && (self.audience)(path)
        {
            // A skipped EOF can bisect a JSONL record. The visible
            // history refresh cannot see the record until it completes,
            // so resume from its preceding delimiter on the next append.
            let boundary = if metadata.is_file() {
                std::fs::File::open(path)
                    .and_then(|mut file| probe_attachment_boundary(&mut file, skipped_eof))
            } else {
                // Never open a known FIFO or other non-regular target.
                Ok(Some(skipped_eof))
            };
            match boundary {
                Ok(offset) => {
                    ps.offset = offset.unwrap_or(skipped_eof);
                    ps.skipped_fragment = offset.is_none();
                    ps.skipped_eof = None;
                }
                Err(_) => {
                    // Retry after a transient open/read failure rather
                    // than recording this file change as consumed.
                    ps.size = old_size;
                    ps.mtime = old_mtime;
                    return;
                }
            }
        }
        // CATCH-UP CAP: a client cannot usefully consume a huge tail frame by
        // frame, and the daemon must not parse one on its behalf. Past this much
        // undelivered growth the tail stops being a stream and becomes a
        // repaint: jump to EOF and send a Poll, which is exactly how the client
        // recovers from a reconnect (refetch history over HTTP — paged and
        // compressed).
        //
        // This is the unconditional bound. Client-driven back-pressure alone was
        // not enough: 150 MiB appended behind a TCP-stalled socket still cost
        // +322 MiB of RSS and 123 resyncs, because the resync order is tiny, so
        // it always fit the socket, cleared the stall, and reopened the gate.
        if size.saturating_sub(ps.offset) > MAX_TAIL_CATCHUP {
            crate::metrics::inc("watch_tail_too_far_behind");
            ps.offset = size;
            ps.skipped_eof = Some(size);
            ps.skipped_fragment = false;
            ps.tail.clear();
            ps.broadcast = None;
            let _ = self.tx.send(WatchEvent::Poll {
                session: path.to_string(),
            });
            return;
        }

        // Drain complete entries until the forward read makes no progress —
        // re-checking the audience EVERY batch, not once per drain.
        //
        // Per-drain was not enough: one drain consumes the whole appended region
        // in BATCH_LIMIT-sized rounds, so a single call parsed 150 MiB (+320 MiB
        // RSS) and overflowed the client's queue 123 times while the gate, tested
        // once at the top, still said yes. Per batch, a stalled client costs one
        // batch of parsing and then nothing.
        loop {
            if !(self.audience)(path) {
                crate::metrics::inc("watch_skip_no_audience");
                // Jump past what we will not deliver. A visible client that is
                // stalled holds a resync order; a hidden one is owed one when
                // it is shown again (the hook below). Either way it repaints
                // from HTTP history, which is paged and compressed, so nothing
                // is lost by not tailing here.
                ps.offset = size;
                ps.skipped_eof = Some(size);
                ps.skipped_fragment = false;
                ps.tail.clear();
                ps.broadcast = None;
                if let Some(skipped) = self.skipped.get() {
                    skipped(path);
                }
                return;
            }
            if ps.skipped_fragment {
                if !metadata.is_file() {
                    return;
                }
                let boundary = std::fs::File::open(path)
                    .and_then(|mut file| next_line_boundary(&mut file, ps.offset, size));
                match boundary {
                    Ok(Some(offset)) => {
                        ps.offset = offset;
                        ps.skipped_fragment = false;
                        let _ = self.tx.send(WatchEvent::Poll {
                            session: path.to_string(),
                        });
                        continue;
                    }
                    Ok(None) => {
                        ps.offset = size;
                        return;
                    }
                    Err(_) => {
                        ps.size = old_size;
                        ps.mtime = old_mtime;
                        return;
                    }
                }
            }
            crate::metrics::inc("watch_read_tail");
            let fr = jsonl::read_forward(Path::new(path), ps.offset, BATCH_LIMIT);
            let progressed = fr.end_offset != ps.offset;
            ps.offset = fr.end_offset;
            if fr.entries.is_empty() {
                break;
            }
            let _ = self.tx.send(WatchEvent::Entries {
                session: path.to_string(),
                entries: fr.entries,
            });
            if !progressed {
                // Defensive: end_offset did not move; never spin.
                break;
            }
        }

        // Partial-line streaming: an unterminated line beyond the consumed
        // offset (omp is mid-write). The anchor (offset) stays stable as the
        // line grows, so the UI can update one element in place. Re-stat:
        // a write may have landed while draining.
        let (size, mtime) = match std::fs::metadata(path) {
            Ok(m) => (m.len(), m.modified().ok()),
            Err(_) => return,
        };
        if size > ps.size {
            ps.size = size;
            ps.mtime = mtime;
        } else if mtime != ps.mtime {
            // Same-size growth in the tail still bumps mtime; keep it fresh so
            // the next 250ms tick's `size+mtime` compare does not spuriously
            // treat it as a rewrite.
            ps.mtime = mtime;
        }
        self.sync_partial(&mut ps, path, size, shrank);
    }

    /// Keep the streamed partial tail in sync with the file, incrementally:
    /// seed once per anchor (or after a shrink into the partial), then fold
    /// only the delta bytes per drain, re-broadcasting only when the folded
    /// state differs from the last broadcast. Bytes are stored RAW so
    /// `extent` stays byte-exact; the lossy decode happens only when
    /// broadcasting (the wire cost that is unavoidable anyway).
    fn sync_partial(&self, ps: &mut PathState, path: &str, size: u64, shrank: bool) {
        if ps.offset >= size {
            // No unterminated tail: consumed by the entry loop, or the file
            // ends exactly at a newline. Nothing to stream.
            ps.tail.clear();
            ps.broadcast = None;
            return;
        }
        if ps.tail.anchor != ps.offset || shrank || ps.tail.extent > size {
            // Anchor moved (a line completed and its bytes were consumed as
            // entries) or the file shrank back into the partial: the folded
            // bytes no longer mirror the file, so re-seed from the anchor.
            match read_region(path, ps.offset, size) {
                Some(bytes) => ps.tail.seed(ps.offset, &bytes),
                None => return, // racing file; retry on the next drain
            }
        } else if ps.tail.extent < size {
            // Same anchor, file grew: fold only the delta.
            match read_region(path, ps.tail.extent, size) {
                Some(bytes) => ps.tail.append(&bytes),
                None => return,
            }
        }
        if ps.tail.bytes.is_empty() || ps.tail.bytes.last() == Some(&b'\n') {
            // A write landed that completed the line after the entry loop
            // drained; the newline is consumed (as an entry or silently) on
            // the next drain.
            ps.tail.clear();
            ps.broadcast = None;
            return;
        }
        let state = ps.tail.state();
        if ps.broadcast != Some(state) {
            ps.broadcast = Some(state);
            let _ = self.tx.send(WatchEvent::Partial {
                session: path.to_string(),
                text: String::from_utf8_lossy(&ps.tail.bytes).into_owned(),
                offset: ps.tail.anchor,
            });
        }
    }

    /// One tick's work: re-arm and drain every path that has an audience.
    /// `false` when none did, so the tick may park.
    fn drain_audience(&self, paths: &[String]) -> bool {
        let mut any = false;
        for path in paths {
            if !(self.audience)(path.as_str()) {
                continue;
            }
            any = true;
            let _ = self.cmd_tx.send(Cmd::Add(path.clone()));
            self.drain(path);
        }
        any
    }
}

/// The native event task: owns the single `notify` watcher instance (inotify
/// on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows, or the poll
/// watcher when forced), applies watch/unwatch commands, and maps forwarded
/// events back onto watched paths, draining the matches on the daemon's own
/// task (never on notify's callback thread).
async fn native_task(this: Arc<Watcher>, mut cmd_rx: mpsc::UnboundedReceiver<Cmd>) {
    let backend = select_backend();
    // notify calls the handler on its own thread; forward only the paths over
    // the existing command channel (the same one watch/unwatch commands use,
    // so the task applies everything in order) and let the task drain.
    let handler_tx = this.cmd_tx.clone();
    let handler = move |res: notify::Result<notify::Event>| match res {
        Ok(event) => {
            // Rescan events (e.g. inotify IN_Q_OVERFLOW) carry no paths; the
            // tick's stat-compare is the net for lost events, exactly as it
            // was when the raw inotify stream ignored them. An open changes
            // nothing, and the drain's own open of the file would otherwise
            // come back as one more event and one more trapped stat per read.
            if !event.paths.is_empty() && !is_open_event(&event) {
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let _ = handler_tx.send(Cmd::Events(paths));
            }
        }
        Err(e) => warn!("native file watcher error: {e}"),
    };

    let mut native: Box<dyn NotifyWatcher + Send> = match backend {
        Backend::Poll => {
            let cfg = notify::Config::default()
                .with_poll_interval(Duration::from_millis(this.cfg.watch_interval_ms));
            match notify::PollWatcher::new(handler, cfg) {
                Ok(w) => Box::new(w),
                Err(e) => {
                    error!(
                        "poll watcher unavailable ({e}); file watching degraded to the {}ms fallback tick",
                        this.cfg.watch_interval_ms
                    );
                    return;
                }
            }
        }
        Backend::Native => {
            match notify::RecommendedWatcher::new(handler, notify::Config::default()) {
                Ok(w) => Box::new(w),
                Err(e) => {
                    error!(
                        "native watcher unavailable ({e}); file watching degraded to the {}ms fallback tick",
                        this.cfg.watch_interval_ms
                    );
                    return;
                }
            }
        }
    };
    info!("file watcher backend: {}", backend.label());
    let mut nw = NativeWatches::new(backend.rearms());

    loop {
        match cmd_rx.recv().await {
            Some(Cmd::Add(path)) => {
                if nw.on_add(&path) {
                    match native.watch(Path::new(&path), RecursiveMode::NonRecursive) {
                        Ok(()) => nw.added(&path),
                        Err(e) => {
                            // Rate-limit: the tick retries every 250ms, and a
                            // path can legitimately be unwatchable for a long
                            // stretch (e.g. its file was deleted while a WS
                            // client is connected).
                            if nw.add_failed(&path) {
                                warn!("native watch failed for {path}: {e}");
                            }
                        }
                    }
                }
            }
            Some(Cmd::Remove(path)) => {
                nw.on_remove(&path);
                if let Err(e) = native.unwatch(Path::new(&path)) {
                    // WatchNotFound is the expected outcome when notify's own
                    // backend already dropped the watch (e.g. inotify removes
                    // it on DELETE_SELF): not a failure worth logging.
                    if !matches!(e.kind, notify::ErrorKind::WatchNotFound) {
                        warn!("native unwatch failed for {path}: {e}");
                    }
                }
            }
            Some(Cmd::Events(paths)) => {
                for path in nw.matched(&paths) {
                    this.drain(path);
                }
            }
            None => break,
        }
    }
}

/// Fallback tick task: every `watch_interval_ms`, stat-compare + drain every
/// watched path and re-issue the native watch command. The stat-compare is
/// the correctness net — it works no matter what the native layer did or
/// failed to deliver (FSEvents latency/coalescing, ReadDirectoryChangesW
/// directory-level reporting, inotify queue overflow, network filesystems,
/// a path whose watch was never added because the file did not exist yet).
/// The re-arm re-points the native watch where the backend makes that
/// idempotent (inotify: the watch on the old inode goes stale after a
/// rename-replace; poll: re-picks-up a path that has since appeared).
async fn tick_task(this: Arc<Watcher>) {
    let mut ticker = tokio::time::interval(Duration::from_millis(this.cfg.watch_interval_ms));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick fires immediately; consume it to start the cadence.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        // Battery: the tick runs only while some watched session has an
        // audience, and otherwise parks until the hub says one may be back.
        //
        // WHY: The tick stat-compares every watched path (one `stat` per
        // session) 4×/sec and, when needed, re-arms the native watch. It is
        // the fallback correctness net — the native watcher already streams
        // low-latency events, so the tick's only job is to catch what the
        // native layer drops (FSEvents coalescing, inotify overflow, rename-
        // replace, network FS). When nobody can receive a tail — no client,
        // every client stalled on a full queue, or (the common case on a
        // phone) every client hidden because the screen is locked or the app
        // is backgrounded — that work is pure waste: measured 150 MiB append
        // with no audience cost 0 MiB when skipped vs 320 MiB when parsed
        // regardless, and the `watch_skip_no_audience` counter proves the
        // gate fires. Gating only the per-path work still woke the daemon
        // 4×/s for nothing, and under proot every wake and `stat` is a
        // trapped syscall, so the tick parks on `audience_wake` instead.
        //
        // No wake is lost: the hub fires `audience_changed` on attach, on a
        // page reporting visible and when a stalled client drains, and
        // `Notify` keeps a permit when it fires before the park. While parked
        // the native watch still drains (and skips) appends as they happen.
        let paths: Vec<String> = this.state().keys().cloned().collect();
        if paths.is_empty() {
            this.wake.notified().await;
            ticker.reset();
            continue;
        }
        if this.drain_audience(&paths) {
            continue;
        }
        // A new watch also ends the park: its first client may already be
        // the audience.
        tokio::select! {
            () = this.audience_wake.notified() => {}
            () = this.wake.notified() => {}
        }
        ticker.reset();
        // Catch up at once on whatever landed while parked, for every path
        // that now has an audience, rather than one interval later.
        let paths: Vec<String> = this.state().keys().cloned().collect();
        this.drain_audience(&paths);
    }
}

/// Raw bytes [`from`, `to`), or fewer when the file shrank between the stat
/// and the read. `take` bounds the read so a racing shrink just yields a
/// shorter tail (the extent tracks the bytes actually folded) instead of
/// failing the drain; `None` only when the file vanished or the seek failed.
fn read_region(path: &str, from: u64, to: u64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    if to <= from {
        return Some(Vec::new());
    }
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity((to - from) as usize);
    f.take(to - from).read_to_end(&mut buf).ok()?;
    Some(buf)
}

#[cfg(test)]
mod tests;
