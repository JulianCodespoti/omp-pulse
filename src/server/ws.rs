//! WS client registry / fan-out hub.
//!
//! Clients attach per session and receive frames pushed by the router task,
//! the watcher, child RPC events and collab relays. Two measured pathologies
//! shape this design (evidence in docs/internals/performance.md):
//!
//! * **Unbounded per-client memory** (F2): a stalled phone used to pin RSS at
//!   2.55x the appended bytes because every client's queue was an
//!   `mpsc::unbounded_channel()`. Queues here are bounded LAST-VALUE CACHES:
//!   a newer supersedable frame REPLACES a pending one instead of queueing
//!   behind it, so memory has a hard ceiling (`ws_queue_cap` frames) and a
//!   slow link automatically receives fewer, larger-step updates — the drain
//!   rate is the adaptation signal, no timers, no RTT estimation.
//! * **Streaming amplification** (F5): full-message snapshots cost 39–76x the
//!   reply size on the wire because every `message_update` re-sends the whole
//!   accumulating message. Frames here carry an optional DELTA tagged with the
//!   `base_seq` it continues from; the hub delivers the delta only to a client
//!   whose last delivered seq equals `base_seq`, and the canonical full text
//!   to everyone else. Correctness is structural, not conditional: full text
//!   is always valid, so every fallback is safe by construction.
//! * **Hidden audiences** (battery): the web app keeps its socket open while
//!   the phone is locked or the app is backgrounded, so the watcher's tail
//!   and 250 ms stat loop stayed hot for a pocketed phone. [`WsHub::has_audience`]
//!   counts only VISIBLE clients with headroom; a hidden client whose tail
//!   was skipped is owed one resync order, delivered when it reports visible,
//!   and the hub wakes the parked watcher whenever an audience can appear.
//!
//! All hub methods are synchronous and lock-scoped; the only `.await` in the
//! module is [`ClientRx::recv`], which touches nothing but the client's own
//! queue. No lock is held across an `.await`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

use crate::metrics;
use crate::types::SharedConfig;

/// Opaque identifier for one attached WS client.
pub type ClientId = u64;

/// Called whenever a session may have just gained an audience (see
/// [`WsHub::set_audience_wake`]). Must be cheap and non-blocking: it runs on
/// socket tasks and on the receive path.
pub type AudienceWake = Box<dyn Fn() + Send + Sync>;

/// Shared between the hub and every [`ClientRx`], so a receiver can fire the
/// wake without reaching back into the hub. Empty until main.rs wires it.
type WakeHook = Arc<OnceLock<AudienceWake>>;

fn fire(hook: &WakeHook) {
    if let Some(wake) = hook.get() {
        wake();
    }
}

/// Which frames are idempotent SNAPSHOTS and may therefore be conflated
/// (a newer frame fully contains an older one with the same key).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Collapse {
    /// lifecycle, entries, bash_result, error — never collapsed.
    None,
    /// supersedable per assistant message id.
    Update(Arc<str>),
    /// supersedable per session (full state snapshots).
    State,
    /// Full agent roster: supersedable only by another roster. Never silently
    /// evict its latest snapshot; a delivery gap must be signaled with resync.
    Agents,
    /// Watcher partial line, keyed by its anchor byte offset: a newer partial
    /// at the same anchor is the same unterminated line grown further, and the
    /// client keeps only the latest text per offset. Never a delta chain.
    Partial(u64),
}

/// One broadcast frame. `text` is canonical and valid for EVERY client,
/// always; `delta` is a smaller increment that is valid ONLY for a client
/// whose last delivered seq equals `base_seq`.
pub struct OutFrame {
    /// from [`WsHub::next_seq`], monotone per session.
    pub seq: u64,
    /// canonical; valid for every client always.
    pub text: Arc<str>,
    /// `(base_seq, smaller frame)` — valid iff this client's position in THIS
    /// frame's collapse chain is exactly `base_seq`.
    pub delta: Option<(u64, Arc<str>)>,
    pub collapse: Collapse,
}

/// Capabilities a client advertises on attach (`?caps=delta,defl,bundle`;
/// unknown tokens are ignored upstream). The default is a legacy client that
/// gets byte-identical frames to yesterday's protocol.
#[derive(Clone, Copy, Default, Debug)]
pub struct ClientCaps {
    /// accepts `{"type":"md",...}` delta frames.
    pub delta: bool,
    /// accepts raw-deflate BINARY frames for large frames.
    pub deflate: bool,
    /// accepts the first-screen `bundle` frame.
    pub bundle: bool,
}

/// One pending frame plus whether a newer frame ever superseded it. `collapsed`
/// entries MUST be delivered as full text — the delta's base frame was
/// replaced before it was ever delivered (see [`resolve`]).
struct Queued {
    frame: Arc<OutFrame>,
    collapsed: bool,
}

/// What one push did, for hub-level accounting (all cheap atomics; nothing
/// here is on a per-frame hot path except the `len`).
#[derive(Default, Debug, PartialEq, Eq)]
struct PushOutcome {
    /// frames removed as superseded (in-place replace or overflow drop).
    superseded: u64,
    /// queue was cleared to a single resync order.
    resynced: bool,
    /// queue length after the push (high-water mark input).
    len: usize,
}

/// The entries and their EXACT canonical-byte total, owned by ONE mutex.
///
/// The total IS the queue's memory bound (`budget`) and every frame can be
/// megabytes, so it is consulted on every push and every back-pressure check.
/// Keeping it beside the entries under the same lock makes it impossible to
/// change one without the other, and every mutation adjusts it in O(1) instead
/// of re-summing every queued frame's text (an O(frames) walk on the per-frame
/// hot path, repeated once per eviction iteration).
///
/// Bytes are counted on the CANONICAL `text` — the largest form a client can
/// be sent — so a client is never charged less than it can be made to hold.
struct QueueState {
    entries: VecDeque<Queued>,
    /// Sum of `entries[i].frame.text.len()`. Invariant: always exactly that
    /// sum, maintained only through the mutators below.
    bytes: usize,
}

impl QueueState {
    fn len(&self) -> usize {
        self.entries.len()
    }

    /// Position of the first pending frame in `key`'s chain, or `None`.
    fn find(&self, key: &Collapse) -> Option<usize> {
        self.entries
            .iter()
            .position(|entry| entry.frame.collapse == *key)
    }

    /// Append a new pending frame.
    fn push_back(&mut self, frame: Arc<OutFrame>) {
        self.bytes += frame.text.len();
        self.entries.push_back(Queued {
            frame,
            collapsed: false,
        });
    }

    /// Replace the pending frame at `pos` IN PLACE, marking it `collapsed`
    /// (its delta base is gone, so it must go out as full text). The newer
    /// frame takes the older one's slot, so delivery order is unchanged.
    fn replace_at(&mut self, pos: usize, frame: Arc<OutFrame>) {
        let entry = &mut self.entries[pos];
        self.bytes -= entry.frame.text.len();
        self.bytes += frame.text.len();
        entry.frame = frame;
        entry.collapsed = true;
    }

    /// Drop the entry at `pos` and return it.
    fn remove_at(&mut self, pos: usize) -> Queued {
        let entry = self.entries.remove(pos).expect("pos is in range");
        self.bytes -= entry.frame.text.len();
        entry
    }

    fn pop_front(&mut self) -> Option<Queued> {
        let entry = self.entries.pop_front()?;
        self.bytes -= entry.frame.text.len();
        Some(entry)
    }

    /// Discard every pending frame and leave exactly one (tiny) resync order.
    fn reset_to(&mut self, frame: Arc<OutFrame>) {
        self.entries.clear();
        self.bytes = frame.text.len();
        self.entries.push_back(Queued {
            frame,
            collapsed: false,
        });
    }

    /// Sum of the queued canonical texts, recomputed from the entries. Test
    /// oracle for the incrementally maintained `bytes`; never used to make a
    /// decision.
    #[cfg(test)]
    fn sum_entry_bytes(&self) -> usize {
        self.entries.iter().map(|e| e.frame.text.len()).sum()
    }
}

/// One client's bounded frame queue. Frames are idempotent SNAPSHOTS except
/// for deltas, so this is a LAST-VALUE CACHE: a newer supersedable frame
/// replaces a pending one instead of queueing behind it (docs/internals/performance.md F2 — a
/// stalled phone used to pin RSS at 2.55x the appended bytes). The drain rate
/// is the adaptation signal: a slow link naturally receives fewer, larger
/// updates, with no timers and no RTT estimation.
struct ClientQueue {
    /// Entries plus their exact canonical-byte total, under ONE lock: the
    /// total is the memory bound, so it must never be able to drift from the
    /// entries it accounts for.
    q: Mutex<QueueState>,
    notify: Notify,
    closed: AtomicBool,
    cap: usize,
    /// Set when this client is handed a resync order and cleared when it next
    /// DRAINS a frame. Without it, back-pressure oscillates: overflow clears the
    /// queue to one resync order, which restores headroom, so the producer
    /// resumes immediately and overflows again — measured 123 resyncs and the
    /// full +321 MiB during a 150 MiB append. A client holding an undelivered
    /// resync order is by definition not consuming.
    stalled: AtomicBool,
    /// Byte budget across all pending frames, compared against
    /// [`QueueState::bytes`]. The frame COUNT is not a memory bound on its own:
    /// a watcher `entries`/`partial` frame can be megabytes, so a 64-frame
    /// queue is hundreds of MiB. Measured with a count-only cap, a non-reading
    /// client still grew daemon RSS 182 MiB while 150 MiB was appended — better
    /// than the 383 MiB before conflation, but still not a bound. This is the
    /// bound.
    budget: usize,
}

impl ClientQueue {
    fn new(cap: usize, budget: usize) -> Self {
        Self {
            q: Mutex::new(QueueState {
                entries: VecDeque::with_capacity(cap.min(16)),
                bytes: 0,
            }),
            notify: Notify::new(),
            closed: AtomicBool::new(false),
            stalled: AtomicBool::new(false),
            cap,
            budget,
        }
    }

    /// Can this queue accept another frame without tripping a ceiling? Used as
    /// back-pressure: a full queue means the client is not draining, so there is
    /// no point producing more for it. Reads the maintained total, so this is
    /// O(1) on the watcher's per-append path.
    fn has_headroom(&self) -> bool {
        if self.stalled.load(Ordering::Relaxed) {
            return false;
        }
        let state = match self.q.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        state.len() < self.cap && state.bytes < self.budget
    }

    /// Turn a queue sitting AT a ceiling into a stalled one holding a resync
    /// order. `true` when it did.
    ///
    /// The watcher's audience gate skips the tail (jumping its offset to EOF,
    /// sending nothing) once no client has headroom, on the premise that every
    /// such client holds a resync order and will refetch over HTTP. A queue
    /// can reach exactly `cap` frames without overflowing — `push` only acts
    /// past a ceiling, and evicting a supersedable frame leaves it at `cap` —
    /// so a slow but draining phone lost the skipped entries with nothing
    /// ever telling it to refetch. This makes the premise true whenever the
    /// gate closes.
    fn resync_if_full(&self) -> bool {
        if self.stalled.load(Ordering::Relaxed) {
            return false;
        }
        let mut state = match self.q.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if self.closed.load(Ordering::Relaxed)
            || (state.len() < self.cap && state.bytes < self.budget)
        {
            return false;
        }
        state.reset_to(resync_frame("queue full"));
        self.stalled.store(true, Ordering::Relaxed);
        self.notify.notify_one();
        true
    }

    /// Push one frame. Conflates supersedable frames; never exceeds `cap`.
    fn push(&self, frame: Arc<OutFrame>) -> PushOutcome {
        let mut state = match self.q.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if self.closed.load(Ordering::Relaxed) {
            return PushOutcome::default();
        }
        // Replacements can grow just as much as newly queued frames. Both paths
        // must enforce the byte ceiling; an early return here let a slow phone
        // retain arbitrarily large streaming snapshots.
        let newest_seq = frame.seq;
        let replacement = if matches!(frame.collapse, Collapse::None) {
            None
        } else {
            state.find(&frame.collapse)
        };
        let mut superseded = 0;
        if let Some(pos) = replacement {
            state.replace_at(pos, frame);
            superseded = 1;
        } else {
            state.push_back(frame);
        }
        while state.len() > self.cap || state.bytes > self.budget {
            // Keep lifecycle frames, the newest frame and the latest agent roster.
            // An agent completion may have no later update: silently dropping
            // that snapshot can leave a client showing a finished agent forever.
            // Recheck both ceilings after every removal using the cached total.
            let drop_pos = state.entries.iter().position(|entry| {
                entry.frame.seq != newest_seq
                    && !matches!(entry.frame.collapse, Collapse::None | Collapse::Agents)
            });
            if let Some(pos) = drop_pos {
                state.remove_at(pos);
                superseded += 1;
                continue;
            }
            // No safe eviction remains. Signal the gap rather than silently losing
            // lifecycle/agent state or retaining an oversized snapshot. An agent
            // observer must invalidate certainty on resync before recovering.
            state.reset_to(resync_frame("queue overflow"));
            self.stalled.store(true, Ordering::Relaxed);
            self.notify.notify_one();
            return PushOutcome {
                superseded,
                resynced: true,
                len: 1,
            };
        }
        self.notify.notify_one();
        PushOutcome {
            superseded,
            resynced: false,
            len: state.len(),
        }
    }

    /// Mark the queue closed and wake any blocked receiver; pushes after this
    /// are dropped. Called by `detach` once the client is out of the maps.
    fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.notify.notify_waiters();
    }

    /// Recover a skipped tail without throwing away live-only frames that
    /// were already queued. A pending recovery marker covers the same gap.
    /// Only a real capacity overflow falls back to the single-marker queue.
    fn request_resync(&self, reason: &'static str) -> Option<usize> {
        let mut state = self.q.lock().unwrap_or_else(|p| p.into_inner());
        if self.closed.load(Ordering::Relaxed)
            || state.entries.iter().any(|entry| entry.frame.seq == 0)
        {
            return None;
        }
        let frame = resync_frame(reason);
        if state.len() >= self.cap || state.bytes.saturating_add(frame.text.len()) > self.budget {
            state.reset_to(frame);
        } else {
            state.push_back(frame);
        }
        self.stalled.store(true, Ordering::Relaxed);
        self.notify.notify_one();
        Some(state.len())
    }

    /// Force the queue to a single `resync` order, discarding any stale
    /// pending frames. Used when the router lost broadcast events to
    /// `Lagged` — those events are gone forever, so every client must
    /// refetch history over HTTP (seq 0 clears per-chain delta positions
    /// in `ClientRx::try_recv`). The frame is tiny so it always fits.
    fn force_resync(&self, reason: &'static str) {
        let mut state = match self.q.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if self.closed.load(Ordering::Relaxed) {
            return;
        }
        state.reset_to(resync_frame(reason));
        self.stalled.store(true, Ordering::Relaxed);
        self.notify.notify_one();
    }
}

/// The one frame that must never be conflated or dropped: it orders the phone
/// to refetch history (the UI already does that on reconnect), so a client
/// that overflowed a bounded queue can always recover.
///
/// `seq` is 0, which `next_seq` never hands out (it increments first), so the
/// only frames that can carry 0 are resyncs — [`ClientRx::try_recv`] uses that
/// to reset the client's stream position after a resync.
fn resync_frame(reason: &'static str) -> Arc<OutFrame> {
    Arc::new(OutFrame {
        seq: 0,
        // Fixed ASCII reasons only — never interpolate untrusted text here.
        text: Arc::from(format!(r#"{{"type":"resync","reason":"{reason}"}}"#)),
        delta: None,
        collapse: Collapse::None,
    })
}

/// Resolved payload for one client: the frame text to put on the wire.
struct Resolved {
    text: Arc<str>,
    was_delta: bool,
}

/// THE correctness hinge of the conflation design (docs/internals/performance.md F2/F5). A delta is
/// an INCREMENT over the text of the frame at `base_seq`, so it is only valid
/// when this client's last delivered frame IS that base. An entry marked
/// `collapsed` lost its base frame to a superseding frame — the increment's
/// base is gone — so it must go out as the canonical full text EVEN when the
/// client's last_seq happens to equal the delta's base (the base frame was
/// replaced before it was ever delivered to this queue). Rule:
/// `delta iff !collapsed && caps.delta && chain_pos(collapse) == Some(base_seq)`, and the
/// canonical full text otherwise.
///
/// Full text is ALWAYS correct (frames are idempotent snapshots), so every
/// fallback below is safe by construction.
fn resolve(entry: &Queued, caps: ClientCaps, chains: &ChainPos) -> Resolved {
    if let Some((_, d)) = entry.frame.delta.as_ref().filter(|(base, _)| {
        !entry.collapsed && caps.delta && chains.get(&entry.frame.collapse) == Some(*base)
    }) {
        Resolved {
            text: Arc::clone(d),
            was_delta: true,
        }
    } else {
        Resolved {
            text: Arc::clone(&entry.frame.text),
            was_delta: false,
        }
    }
}

/// Where a client stands in each independent delta CHAIN.
///
/// WHY NOT ONE COUNTER: a delta continues one specific chain — an assistant
/// message, or the session's state snapshot — but a session's frames interleave
/// (watcher partials, heartbeats, a second message, tool events). With a single
/// global position, any frame landing between two updates desynchronised the
/// client and forced a full snapshot: measured ZERO delta frames across a live
/// turn, the whole saving lost to interleaving. Position is therefore per key.
///
/// Bounded by construction: a session has one live assistant message plus its
/// state in practice, and past `CHAIN_SLOTS` the oldest entry is evicted, so a
/// long session cannot grow this.
#[derive(Default)]
struct ChainPos {
    slots: Vec<(Collapse, u64)>,
}

/// Live chains per client. One streaming message + state is the real case; 4
/// leaves room for a tool-call chain and a second message without unbounded
/// growth.
const CHAIN_SLOTS: usize = 4;

impl ChainPos {
    fn get(&self, key: &Collapse) -> Option<u64> {
        self.slots.iter().find(|(k, _)| k == key).map(|(_, s)| *s)
    }

    /// Record the client's position in `key`'s chain. `Collapse::None` and
    /// `Collapse::Partial` frames never form a chain (nothing can be a delta
    /// against them), so they are not stored — that keeps the slots for
    /// chains that matter.
    fn set(&mut self, key: &Collapse, seq: u64) {
        if matches!(key, Collapse::None | Collapse::Partial(_)) {
            return;
        }
        if let Some(slot) = self.slots.iter_mut().find(|(k, _)| k == key) {
            slot.1 = seq;
            return;
        }
        if self.slots.len() == CHAIN_SLOTS {
            self.slots.remove(0);
        }
        self.slots.push((key.clone(), seq));
    }

    fn clear(&mut self) {
        self.slots.clear();
    }
}

/// A client's view of its queue: the per-client resolution state (which
/// frames it has seen) plus the capability bits it advertised on attach.
pub struct ClientRx {
    queue: Arc<ClientQueue>,
    caps: ClientCaps,
    /// Per-chain stream position. Empty = fresh attach: the first delivery of
    /// any chain is ALWAYS full text, so a client can never receive an
    /// increment for a message whose base it never saw.
    chains: ChainPos,
    counters: Arc<HubCounters>,
    audience_wake: WakeHook,
}

impl ClientRx {
    /// Next frame for THIS client, already resolved: delta when in step, full
    /// text otherwise. Returns `None` once the client is detached (the hub
    /// closes the queue and wakes any blocked receiver).
    pub async fn recv(&mut self) -> Option<Arc<str>> {
        loop {
            if let Some(text) = self.try_recv() {
                return Some(text);
            }
            if self.queue.closed.load(Ordering::Relaxed) {
                return None;
            }
            self.queue.notify.notified().await;
        }
    }

    /// Sync, non-blocking pop: resolve the front entry if one is pending. The
    /// pop also gives the frame's bytes back to the queue's budget, so a
    /// draining client regains headroom exactly as fast as it consumes.
    fn try_recv(&mut self) -> Option<Arc<str>> {
        let (entry, audience_restored) = {
            let mut state = match self.queue.q.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let was_full = state.len() >= self.queue.cap || state.bytes >= self.queue.budget;
            let entry = state.pop_front()?;
            let has_headroom = state.len() < self.queue.cap && state.bytes < self.queue.budget;
            // Serialize clearing with resync insertion: a later recovery
            // order must not have its stall erased by this earlier pop.
            let unstalled = self.queue.stalled.load(Ordering::Relaxed)
                && self.queue.stalled.swap(false, Ordering::Relaxed);
            (entry, unstalled || (was_full && has_headroom))
        };
        // A full queue can drain between the watcher's headroom check and its
        // resync insertion. Wake on that transition even without a stall marker,
        // or the watcher can park after the only available wake has passed.
        if audience_restored {
            fire(&self.audience_wake);
        }
        let resolved = resolve(&entry, self.caps, &self.chains);
        // A resync (the only frame that can carry seq 0) resets every stream
        // position: the client is refetching history, so nothing it "has" from
        // before is a valid delta base anymore. Next delivery per chain is full.
        if entry.frame.seq == 0 {
            self.chains.clear();
        } else {
            self.chains.set(&entry.frame.collapse, entry.frame.seq);
        }
        if resolved.was_delta {
            self.counters.delta_sent.fetch_add(1, Ordering::Relaxed);
        } else {
            self.counters.full_sent.fetch_add(1, Ordering::Relaxed);
        }
        Some(resolved.text)
    }

    /// The capability bits this client advertised on attach — the socket
    /// writer needs `deflate`/`bundle` to pick encodings.
    pub fn caps(&self) -> ClientCaps {
        self.caps
    }
}

/// Per-client registry entry: session path + bounded queue + caps.
///
/// There used to be a fourth `watching` flag here, flipped by the client's
/// visibilitychange and read by an `agent_end` suppression gate that had been
/// constant-false for some time: users wanted to be notified whether or not
/// they were looking at the app, so the gate never suppressed anything and the
/// flag was write-only. Nothing here decides buzzes now.
type ClientEntry = (String, Arc<ClientQueue>, ClientCaps);

/// State guarded by a single mutex; every method holds it only for the
/// duration of its own synchronous work.
struct Inner {
    /// client id -> (session path, queue, caps). `detach` must remove from
    /// BOTH maps to keep them consistent.
    clients: HashMap<ClientId, ClientEntry>,
    /// session path -> ids of clients attached to that session.
    by_session: HashMap<String, HashSet<ClientId>>,
    /// Monotone per-session frame sequence. Every frame that enters a
    /// client's queue carries a seq, so a client's `last_seq` can only match a
    /// delta's `base_seq` when it actually received that frame (see
    /// [`resolve`]). Pruned when a session's last client leaves, so
    /// never-revisited sessions cannot leak counters forever.
    seqs: HashMap<String, u64>,
    /// Clients whose page reported itself hidden (backgrounded app, locked
    /// phone). The child reaper reads this, so a pocketed phone with a chat
    /// open stops pinning a ~380 MB omp child for the full idle TTL, and so
    /// does the watcher's audience ([`WsHub::has_audience`]), so the same
    /// phone stops keeping the tail and its 250 ms stat loop awake. Hidden
    /// clients still receive every frame that IS produced (a visible laptop
    /// on the same session keeps the tail running). Never consulted for
    /// notifications: those come from the child/bridge/collab event stream.
    hidden: HashSet<ClientId>,
    /// Hidden clients that missed a tail the watcher skipped because nobody
    /// visible could receive it. Each is owed ONE resync order, delivered
    /// when it reports visible again ([`WsHub::set_visible`]); until then a
    /// resync would only make a backgrounded page refetch history nobody is
    /// looking at.
    needs_resync: HashSet<ClientId>,
}

/// Hub-wide delivery counters shared between the hub (push side) and every
/// `ClientRx` (recv side) so [`WsHub::stats`] reports both sides with atomics
/// only — no extra lock beyond the map lookups.
#[derive(Default)]
struct HubCounters {
    /// frames superseded by a newer one (in-place collapse or overflow drop).
    collapsed: AtomicU64,
    /// queues cleared to a single resync order.
    resyncs: AtomicU64,
    /// deepest any queue has ever been (per-push `len` high-water mark).
    queue_peak: AtomicU64,
    delta_sent: AtomicU64,
    full_sent: AtomicU64,
}

/// Registry of attached WS clients plus per-session fan-out.
pub struct WsHub {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
    counters: Arc<HubCounters>,
    audience_wake: WakeHook,
    queue_cap: usize,
    queue_bytes: usize,
}

impl WsHub {
    /// Create an empty hub. Client ids start at 1 (0 is never a valid id).
    pub fn new(config: SharedConfig) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                clients: HashMap::new(),
                by_session: HashMap::new(),
                seqs: HashMap::new(),
                hidden: HashSet::new(),
                needs_resync: HashSet::new(),
            }),
            next_id: AtomicU64::new(1),
            counters: Arc::new(HubCounters::default()),
            audience_wake: Arc::new(OnceLock::new()),
            // A 0 cap would turn every push into a resync; treat it as a
            // misconfiguration and floor it at 1.
            queue_cap: config.ws_queue_cap.max(1),
            queue_bytes: config.ws_queue_bytes.max(4096),
        })
    }

    /// Install the watcher's audience wake (main.rs, once at boot; a second
    /// call is ignored). Fired on every event that can turn "no audience"
    /// into "audience": a client attaching, a client reporting visible, and
    /// a stalled client draining. With no audience the watcher's tick parks
    /// instead of stat-ing every watched file 4×/s for nobody.
    pub fn set_audience_wake(&self, wake: AudienceWake) {
        let _ = self.audience_wake.set(wake);
    }

    /// Register a new client for `session_path` and hand back its frame
    /// receiver. The caller owns the receiver and pumps it to the socket.
    pub fn attach(&self, session_path: String, caps: ClientCaps) -> (ClientId, ClientRx) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let queue = Arc::new(ClientQueue::new(self.queue_cap, self.queue_bytes));
        let rx = ClientRx {
            queue: Arc::clone(&queue),
            caps,
            chains: ChainPos::default(),
            counters: Arc::clone(&self.counters),
            audience_wake: Arc::clone(&self.audience_wake),
        };
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner
                .clients
                .insert(id, (session_path.clone(), queue, caps));
            inner.by_session.entry(session_path).or_default().insert(id);
        }
        // A new client is visible until it says otherwise: wake a parked
        // watcher (outside the hub lock, like every other wake).
        fire(&self.audience_wake);
        (id, rx)
    }

    /// Remove a client from the registry and the per-session index. No-op for
    /// unknown ids; the session key (and its seq counter) is dropped once its
    /// last client leaves.
    pub fn detach(&self, id: ClientId) {
        // Collect the queue to close OUTSIDE the lock: closing wakes the
        // client's blocked recv, and waking must never happen under the hub
        // mutex (it would serialize teardown behind every broadcast).
        let mut to_close: Vec<Arc<ClientQueue>> = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.hidden.remove(&id);
            inner.needs_resync.remove(&id);
            if let Some((session, queue, _)) = inner.clients.remove(&id) {
                if let Some(set) = inner.by_session.get_mut(&session) {
                    set.remove(&id);
                    if set.is_empty() {
                        inner.by_session.remove(&session);
                        // Last client gone: drop the session's sequence
                        // counter so never-revisited sessions cannot leak it
                        // forever. A reattach starts at last_seq = None, so
                        // the reset is invisible (first frame is always full).
                        inner.seqs.remove(&session);
                    }
                }
                to_close.push(queue);
            }
        }
        for queue in to_close {
            queue.close();
        }
    }

    /// Fan a frame out to every client of `session_path`. Fan-out is Arc
    /// clones only — never a per-client byte copy (the old code did
    /// `tx.send(msg.to_string())` per client under the hub mutex, docs/internals/performance.md F7).
    /// Queue handles are collected under the lock; the per-client queue work
    /// (and its notify) happens OUTSIDE it.
    pub fn broadcast_frame(&self, session_path: &str, frame: OutFrame) {
        let frame = Arc::new(frame);
        let targets: Vec<Arc<ClientQueue>> = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let Some(ids) = inner.by_session.get(session_path) else {
                // No clients: drop the per-session counter too — a session
                // that never has a phone attached must not grow `seqs`
                // forever. Safe: with no clients, no client has seen any seq
                // we hand out next, so a restart at 1 cannot collide.
                inner.seqs.remove(session_path);
                return;
            };
            ids.iter()
                .filter_map(|id| inner.clients.get(id).map(|(_, q, _)| Arc::clone(q)))
                .collect()
        };
        for queue in targets {
            let out = queue.push(Arc::clone(&frame));
            self.counters
                .collapsed
                .fetch_add(out.superseded, Ordering::Relaxed);
            if out.resynced {
                self.counters.resyncs.fetch_add(1, Ordering::Relaxed);
                metrics::inc("ws_resync");
            }
            self.counters
                .queue_peak
                .fetch_max(out.len as u64, Ordering::Relaxed);
        }
    }

    /// Shim for call sites that only have a pre-serialized frame string
    /// (collab relays, watcher events, the router task). Delivered as a
    /// non-collapsible full frame — and it CONSUMES a sequence number, so a
    /// client whose last delivery was a lifecycle frame can never match a
    /// delta base it didn't actually see (producers only base deltas on the
    /// seqs next_seq returned to THEM; see [`resolve`]).
    pub fn broadcast(&self, session_path: &str, msg: &str) {
        self.broadcast_frame(
            session_path,
            OutFrame {
                seq: self.next_seq(session_path),
                text: Arc::from(msg),
                delta: None,
                collapse: Collapse::None,
            },
        );
    }

    /// Force every attached client to resynchronise.
    ///
    /// INVARIANT: `broadcast::Lagged` means `n` events are gone forever.
    /// Continuing from the hole would wedge the transcript (the phone would
    /// show a truncated conversation). The only safe recovery is a `resync`
    /// (seq 0) which `ClientRx::try_recv` uses to clear per-chain delta
    /// positions — the next delivery per chain is then a full snapshot
    /// (`delta.rs` suffix-replacement keyed by `base_seq` always falls back
    /// to full text when the base is missing, so correctness is structural).
    /// The frame is tiny, so it always fits the bounded byte budget.
    pub fn resync_all(&self, reason: &'static str) {
        // Collect every live queue OUTSIDE any per-queue lock; the hub mutex
        // is held only for the snapshot of ids.
        let targets: Vec<Arc<ClientQueue>> = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner
                .clients
                .values()
                .map(|(_, q, _)| Arc::clone(q))
                .collect()
        };
        for q in targets {
            q.force_resync(reason);
            self.counters.resyncs.fetch_add(1, Ordering::Relaxed);
            metrics::inc("ws_resync");
            self.counters.queue_peak.fetch_max(1, Ordering::Relaxed);
        }
    }

    /// Number of clients currently attached to `session_path`.
    pub fn client_count(&self, session_path: &str) -> usize {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner
            .by_session
            .get(session_path)
            .map_or(0, |ids| ids.len())
    }

    /// Record a client's page visibility. Unknown ids are ignored, so a frame
    /// racing its own socket's detach cannot leave a stale entry behind.
    ///
    /// Becoming visible is an audience event: a hidden client that missed a
    /// skipped tail ([`Self::tail_skipped`]) gets its one owed resync order
    /// now — the same seq-0 frame `resync_if_full` and the router's `Lagged`
    /// INVARIANT use, so the page refetches history over HTTP — and the
    /// parked watcher is woken to tail for it again.
    pub fn set_visible(&self, id: ClientId, visible: bool) {
        let (owed, shown) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if !visible {
                if inner.clients.contains_key(&id) {
                    inner.hidden.insert(id);
                }
                return;
            }
            let shown = inner.hidden.remove(&id);
            let owed = if inner.needs_resync.remove(&id) {
                inner
                    .clients
                    .get(&id)
                    .map(|(_, queue, _)| Arc::clone(queue))
            } else {
                None
            };
            (owed, shown)
        };
        // Outside the hub lock, like every other wake.
        if let Some(len) = owed.and_then(|queue| queue.request_resync("hidden")) {
            self.counters.resyncs.fetch_add(1, Ordering::Relaxed);
            metrics::inc("ws_resync");
            self.counters
                .queue_peak
                .fetch_max(len as u64, Ordering::Relaxed);
        }
        if shown {
            fire(&self.audience_wake);
        }
    }

    /// Clients attached to `session_path` whose page is visible: the child
    /// reaper's notion of "someone is looking". Tailing uses
    /// [`Self::has_audience`]; streaming and notifications ignore visibility.
    pub fn visible_count(&self, session_path: &str) -> usize {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.by_session.get(session_path).map_or(0, |ids| {
            ids.iter().filter(|id| !inner.hidden.contains(id)).count()
        })
    }

    /// Hand out the next monotone-per-session sequence number. Producers call
    /// this once per frame they build and stamp the result into `OutFrame.seq`
    /// (and use it as the next frame's `delta.base_seq` when the delta extends
    /// the text that frame carried).
    pub fn next_seq(&self, session_path: &str) -> u64 {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        // Reuse the borrowed key on live frames; entry() would allocate it each time.
        if let Some(n) = inner.seqs.get_mut(session_path) {
            *n += 1;
            return *n;
        }
        inner.seqs.insert(session_path.to_owned(), 1);
        1
    }

    /// Is anyone able to use a tail of `session_path` right now? The
    /// watcher's audience policy: true when at least one attached client is
    /// VISIBLE and its queue has headroom. Reading and parsing an appended
    /// tail is O(appended) work whose only consumer is a client queue, so:
    ///
    /// * every queue full (the client is not draining): stop tailing rather
    ///   than buffer on its behalf. Measured: appending 150 MiB with one
    ///   non-reading client attached cost +320 MiB of daemon RSS parsing
    ///   frames nobody could accept; with this gate it costs 0.
    /// * only hidden clients (locked phone, backgrounded app; the web app
    ///   keeps its socket open there): nobody can see the frames, yet the
    ///   tail and the watcher's 250 ms stat loop kept a pocketed phone awake.
    ///   They are marked by [`Self::tail_skipped`] and resynced once on
    ///   [`Self::set_visible`] instead.
    ///
    /// A visible laptop next to a hidden phone keeps the tail running, and
    /// the hidden phone still receives those frames (bounded by its caps).
    pub fn has_audience(&self, session_path: &str) -> bool {
        let full: Vec<Arc<ClientQueue>> = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let Some(ids) = inner.by_session.get(session_path) else {
                return false;
            };
            let visible = ids
                .iter()
                .filter(|id| !inner.hidden.contains(id))
                .filter_map(|id| inner.clients.get(id).map(|(_, queue, _)| queue));
            if visible.clone().any(|queue| queue.has_headroom()) {
                return true;
            }
            visible.map(Arc::clone).collect()
        };
        // The caller is about to skip a tail no visible client received: each
        // must hold a resync order for it (see `resync_if_full`). That also
        // makes the drain that clears the stall wake the parked watcher.
        // Outside the hub lock, like every other wake.
        for queue in full {
            if queue.resync_if_full() {
                self.counters.resyncs.fetch_add(1, Ordering::Relaxed);
                metrics::inc("ws_resync");
            }
        }
        false
    }

    /// The watcher advanced past an undelivered tail. Hidden clients owe one
    /// recovery on restore; clients now visible need it immediately. Visibility
    /// may have changed since the audience check, so checking hidden clients
    /// alone loses a tail when restore races the skip.
    pub fn tail_skipped(&self, session_path: &str) {
        let visible: Vec<Arc<ClientQueue>> = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let Inner {
                clients,
                by_session,
                hidden,
                needs_resync,
                ..
            } = &mut *inner;
            let Some(ids) = by_session.get(session_path) else {
                return;
            };
            ids.iter()
                .filter_map(|id| {
                    if hidden.contains(id) {
                        needs_resync.insert(*id);
                        None
                    } else {
                        clients.get(id).map(|(_, queue, _)| Arc::clone(queue))
                    }
                })
                .collect()
        };
        for queue in visible {
            if let Some(len) = queue.request_resync("hidden") {
                self.counters.resyncs.fetch_add(1, Ordering::Relaxed);
                metrics::inc("ws_resync");
                self.counters
                    .queue_peak
                    .fetch_max(len as u64, Ordering::Relaxed);
            }
        }
    }

    /// True when at least one attached client advertises delta support — lets
    /// producers skip delta computation entirely when nobody can use it.
    pub fn any_delta_client(&self, session_path: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.by_session.get(session_path).is_some_and(|ids| {
            ids.iter()
                .any(|id| inner.clients.get(id).is_some_and(|(_, _, caps)| caps.delta))
        })
    }

    /// Observability for the whole conflation design (`/api/status` surfaces
    /// this): how many clients/sessions are live, how the delivery paths have
    /// behaved (frames superseded, queues resynced, deepest queue), and the
    /// delta/full split per delivered frame.
    pub fn stats(&self) -> serde_json::Value {
        let counters = (
            self.counters.collapsed.load(Ordering::Relaxed),
            self.counters.resyncs.load(Ordering::Relaxed),
            self.counters.queue_peak.load(Ordering::Relaxed),
            self.counters.delta_sent.load(Ordering::Relaxed),
            self.counters.full_sent.load(Ordering::Relaxed),
        );
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        serde_json::json!({
            "clients": inner.clients.len(),
            "sessions": inner.by_session.len(),
            "collapsed": counters.0,
            "resyncs": counters.1,
            "queue_peak": counters.2,
            "delta_sent": counters.3,
            "full_sent": counters.4,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Config;

    fn frame(
        seq: u64,
        text: &str,
        delta: Option<(u64, &str)>,
        collapse: Collapse,
    ) -> Arc<OutFrame> {
        Arc::new(OutFrame {
            seq,
            text: Arc::from(text),
            delta: delta.map(|(base, d)| (base, Arc::from(d))),
            collapse,
        })
    }

    fn update(id: &str, seq: u64, full: &str, delta: Option<(u64, &str)>) -> Arc<OutFrame> {
        frame(seq, full, delta, Collapse::Update(Arc::from(id)))
    }

    fn queue(cap: usize) -> (Arc<ClientQueue>, Arc<HubCounters>) {
        (
            Arc::new(ClientQueue::new(cap, 1 << 20)),
            Arc::new(HubCounters::default()),
        )
    }

    /// (seq, collapsed) per pending entry, in queue order — the queue's shape,
    /// read independently of its cached byte total.
    fn pending(q: &ClientQueue) -> Vec<(u64, bool)> {
        let guard = q.q.lock().unwrap();
        guard
            .entries
            .iter()
            .map(|e| (e.frame.seq, e.collapsed))
            .collect()
    }

    /// The queue's maintained byte total, and the same total recomputed from
    /// the entries. They must always agree — the maintained one is what the
    /// byte budget is enforced against, so a drift would silently move the
    /// memory bound.
    fn accounted_bytes(q: &ClientQueue) -> (usize, usize) {
        let guard = q.q.lock().unwrap();
        (guard.bytes, guard.sum_entry_bytes())
    }

    /// A receiver whose `m1` chain already sits at `at`. Tests seed the chain
    /// the frames under test belong to, since positions are per chain now.
    fn rx(q: Arc<ClientQueue>, caps: ClientCaps, at: Option<u64>) -> ClientRx {
        rx_on(q, caps, Collapse::Update(Arc::from("m1")), at)
    }

    fn rx_on(q: Arc<ClientQueue>, caps: ClientCaps, key: Collapse, at: Option<u64>) -> ClientRx {
        let mut chains = ChainPos::default();
        if let Some(seq) = at {
            chains.set(&key, seq);
        }
        ClientRx {
            queue: q,
            caps,
            chains,
            counters: Arc::new(HubCounters::default()),
            audience_wake: Arc::new(OnceLock::new()),
        }
    }

    /// The client's position in a message's chain, for assertions.
    fn pos(r: &ClientRx, id: &str) -> Option<u64> {
        r.chains.get(&Collapse::Update(Arc::from(id)))
    }

    #[test]
    fn update_collapses_in_place_preserving_position() {
        let (q, _) = queue(8);
        q.push(update("m1", 1, "one", None));
        q.push(update("m2", 2, "two", None));
        // A newer m1 frame supersedes the pending m1 at position 0 — it must
        // replace it IN PLACE (not jump the queue past m2), depth stays 2.
        let out = q.push(update("m1", 3, "three", None));
        assert_eq!(out.superseded, 1);
        assert_eq!(pending(&q), vec![(3, true), (2, false)]);
    }

    #[test]
    fn different_message_ids_do_not_collapse() {
        let (q, _) = queue(8);
        q.push(update("m1", 1, "a", None));
        q.push(update("m2", 2, "b", None));
        assert_eq!(pending(&q), vec![(1, false), (2, false)]);
    }

    #[test]
    fn state_frames_collapse_only_with_state() {
        let (q, _) = queue(8);
        q.push(frame(1, "s1", None, Collapse::State));
        q.push(update("m1", 2, "u", None));
        let out = q.push(frame(3, "s2", None, Collapse::State));
        assert_eq!(out.superseded, 1);
        assert_eq!(pending(&q), vec![(3, true), (2, false)]);
    }

    #[test]
    fn partials_collapse_per_anchor_and_never_take_a_chain_slot() {
        let (q, _) = queue(8);
        q.push(frame(1, "par", None, Collapse::Partial(10)));
        q.push(update("m1", 2, "u", None));
        let out = q.push(frame(3, "partial", None, Collapse::Partial(10)));
        assert_eq!(out.superseded, 1);
        // A new anchor is a different line: it queues behind, never replaces.
        q.push(frame(4, "next", None, Collapse::Partial(40)));
        assert_eq!(pending(&q), vec![(3, true), (2, false), (4, false)]);

        let mut r = rx(Arc::clone(&q), ClientCaps::default(), None);
        for _ in 0..3 {
            r.try_recv().unwrap();
        }
        assert_eq!(r.chains.slots.len(), 1, "only the message chain is tracked");
        assert_eq!(pos(&r, "m1"), Some(2));
    }

    #[test]
    fn agent_snapshots_conflate_independently_from_state_and_other_frames() {
        let (q, _) = queue(8);
        q.push(frame(1, "state-one", None, Collapse::State));
        q.push(frame(2, "agents-one", None, Collapse::Agents));
        q.push(frame(3, "lifecycle", None, Collapse::None));
        q.push(update("m1", 4, "message", None));
        let state = q.push(frame(5, "state-two", None, Collapse::State));
        let agents = q.push(frame(6, "agents-empty", None, Collapse::Agents));
        assert_eq!(state.superseded, 1);
        assert_eq!(agents.superseded, 1);
        assert!(!state.resynced && !agents.resynced);
        assert_eq!(
            pending(&q),
            vec![(5, true), (6, true), (3, false), (4, false)]
        );
        let guard = q.q.lock().unwrap();
        let texts: Vec<_> = guard
            .entries
            .iter()
            .map(|entry| &*entry.frame.text)
            .collect();
        assert_eq!(texts, ["state-two", "agents-empty", "lifecycle", "message"]);
        assert_eq!(guard.bytes, guard.sum_entry_bytes());
    }

    #[test]
    fn agent_snapshot_survives_pressure_by_evicting_an_unrelated_update() {
        let (q, _) = queue(2);
        q.push(frame(1, "agents", None, Collapse::Agents));
        q.push(update("m1", 2, "message", None));
        let out = q.push(frame(3, "lifecycle", None, Collapse::None));
        assert_eq!(out.superseded, 1);
        assert!(!out.resynced);
        assert_eq!(pending(&q), vec![(1, false), (3, false)]);
        assert_eq!(accounted_bytes(&q), (15, 15));
    }

    #[test]
    fn agent_snapshot_count_pressure_signals_resync_instead_of_silent_eviction() {
        let (q, _) = queue(2);
        q.push(frame(1, "agents", None, Collapse::Agents));
        q.push(frame(2, "lifecycle", None, Collapse::None));
        let out = q.push(frame(3, "lifecycle-two", None, Collapse::None));
        assert!(out.resynced);
        assert_eq!(out.superseded, 0);
        assert_eq!(pending(&q), vec![(0, false)]);
        let guard = q.q.lock().unwrap();
        assert_eq!(
            &*guard.entries[0].frame.text,
            r#"{"type":"resync","reason":"queue overflow"}"#
        );
        assert_eq!(guard.bytes, guard.sum_entry_bytes());
    }

    #[test]
    fn agent_snapshot_byte_pressure_signals_resync_instead_of_silent_eviction() {
        let q = ClientQueue::new(8, 128);
        q.push(frame(1, &"a".repeat(80), None, Collapse::Agents));
        let out = q.push(frame(2, &"b".repeat(80), None, Collapse::None));
        assert!(out.resynced);
        assert_eq!(out.superseded, 0);
        assert_eq!(pending(&q), vec![(0, false)]);
        let (accounted, summed) = accounted_bytes(&q);
        assert_eq!(accounted, summed);
        assert!(accounted <= 128);
    }

    #[test]
    fn agent_snapshot_after_undelivered_resync_cannot_remove_the_loss_signal() {
        for cap in [1, 2] {
            let (q, _) = queue(cap);
            q.force_resync("test gap");
            q.push(frame(1, "agents-one", None, Collapse::Agents));
            q.push(frame(2, "agents-two", None, Collapse::Agents));
            let mut r = rx(Arc::clone(&q), ClientCaps::default(), None);
            let signal: serde_json::Value = serde_json::from_str(&r.try_recv().unwrap()).unwrap();
            assert_eq!(signal["type"], "resync");
            if cap == 2 {
                assert_eq!(r.try_recv().as_deref(), Some("agents-two"));
            }
            assert!(r.try_recv().is_none());
            assert_eq!(accounted_bytes(&q), (0, 0));
        }
    }

    #[test]
    fn growing_agent_snapshot_fits_after_evicting_unrelated_update_by_bytes() {
        let q = ClientQueue::new(8, 128);
        q.push(frame(1, &"a".repeat(40), None, Collapse::Agents));
        q.push(update("m1", 2, &"b".repeat(60), None));
        q.push(frame(3, "lifecycle", None, Collapse::None));
        let out = q.push(frame(4, &"a".repeat(100), None, Collapse::Agents));
        assert!(!out.resynced);
        assert_eq!(
            out.superseded, 2,
            "old roster replaced and unrelated update evicted"
        );
        assert_eq!(pending(&q), vec![(4, true), (3, false)]);
        assert_eq!(accounted_bytes(&q), (109, 109));
    }

    #[test]
    fn growing_agent_snapshot_replacement_resyncs_with_exact_byte_accounting() {
        let q = ClientQueue::new(8, 128);
        q.push(frame(1, "old agents", None, Collapse::Agents));
        q.push(frame(2, "lifecycle", None, Collapse::None));
        let out = q.push(frame(3, &"a".repeat(129), None, Collapse::Agents));
        assert!(out.resynced);
        assert_eq!(out.superseded, 1);
        assert_eq!(pending(&q), vec![(0, false)]);
        let guard = q.q.lock().unwrap();
        assert_eq!(
            &*guard.entries[0].frame.text,
            r#"{"type":"resync","reason":"queue overflow"}"#
        );
        assert_eq!(guard.bytes, guard.sum_entry_bytes());
        assert!(guard.bytes <= 128);
    }

    #[test]
    fn none_frames_never_collapse_or_drop_while_collapsible_exists() {
        let (q, _) = queue(2);
        q.push(frame(1, "lifecycle", None, Collapse::None));
        q.push(update("m1", 2, "update", None));
        // Over cap (3 > 2): the OLDEST collapsible (the update) is dropped as
        // superseded-in-spirit; BOTH lifecycle frames must survive.
        let out = q.push(frame(3, "lifecycle2", None, Collapse::None));
        assert_eq!(out.superseded, 1);
        assert!(!out.resynced);
        assert_eq!(pending(&q), vec![(1, false), (3, false)]);
    }

    #[test]
    fn overflow_with_nothing_collapsible_leaves_one_resync() {
        let (q, _) = queue(2);
        q.push(frame(1, "a", None, Collapse::None));
        q.push(frame(2, "b", None, Collapse::None));
        // Nothing older is collapsible (both pending frames are lifecycle), so
        // the client is hopelessly behind: CLEAR everything and leave exactly
        // one resync order — even the just-pushed update is discarded, but a
        // resync means the phone refetches history and lives.
        let out = q.push(update("m1", 3, "c", None));
        assert!(out.resynced);
        assert_eq!(out.superseded, 0);
        let entries = pending(&q);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0], (0, false));
        let (accounted, summed) = accounted_bytes(&q);
        assert_eq!(accounted, summed, "the byte total drifted from the entries");
        let guard = q.q.lock().unwrap();
        assert_eq!(
            &*guard.entries[0].frame.text,
            r#"{"type":"resync","reason":"queue overflow"}"#
        );
        // The cleared queue is charged for the resync order alone — a stale
        // total would keep charging for frames the client no longer holds.
        assert_eq!(accounted, guard.entries[0].frame.text.len());
    }

    #[test]
    fn collapse_replaces_never_drops_lifecycle_in_front() {
        let (q, _) = queue(2);
        q.push(update("m1", 1, "u1", None));
        q.push(frame(2, "lifecycle", None, Collapse::None));
        // Over cap: the OLDEST collapsible (m1, position 0) goes; the
        // lifecycle frame in front must not be dropped instead.
        let out = q.push(update("m2", 3, "u2", None));
        assert_eq!(out.superseded, 1);
        assert_eq!(pending(&q), vec![(2, false), (3, false)]);
    }

    #[test]
    fn overflow_never_drops_the_just_pushed_frame() {
        let (q, _) = queue(2);
        q.push(frame(1, "a", None, Collapse::None));
        q.push(frame(2, "b", None, Collapse::None));
        // With nothing older collapsible, the fresh update must NOT be dropped
        // to make room — the only safe outcome is clear + resync.
        let out = q.push(update("m1", 3, "c", None));
        assert!(out.resynced);
        assert_eq!(pending(&q), vec![(0, false)]);
    }

    #[test]
    fn collapsed_entry_resolves_to_full_text_even_when_in_step() {
        let (q, _) = queue(8);
        // seq 6 supersedes seq 5 in the queue; its delta extends seq 5's text.
        q.push(update("m1", 5, "FULL-5", Some((4, "D5"))));
        q.push(update("m1", 6, "FULL-6", Some((5, "D6"))));
        let mut r = rx(
            Arc::clone(&q),
            ClientCaps {
                delta: true,
                ..Default::default()
            },
            // Matches the delta's base — yet the base frame was replaced
            // before delivery, so the increment MUST NOT go out.
            Some(5),
        );
        assert_eq!(&*r.try_recv().unwrap(), "FULL-6");
        assert_eq!(pos(&r, "m1"), Some(6));
    }

    #[test]
    fn in_step_delta_client_gets_delta() {
        let (q, _) = queue(8);
        q.push(update("m1", 5, "FULL-5", Some((4, "D5"))));
        let mut r = rx(
            Arc::clone(&q),
            ClientCaps {
                delta: true,
                ..Default::default()
            },
            Some(4),
        );
        assert_eq!(&*r.try_recv().unwrap(), "D5");
        assert_eq!(pos(&r, "m1"), Some(5));
    }

    #[test]
    fn out_of_step_client_gets_full_text() {
        let (q, _) = queue(8);
        q.push(update("m1", 5, "FULL-5", Some((4, "D5"))));
        let mut r = rx(
            Arc::clone(&q),
            ClientCaps {
                delta: true,
                ..Default::default()
            },
            Some(3),
        );
        assert_eq!(&*r.try_recv().unwrap(), "FULL-5");
        assert_eq!(pos(&r, "m1"), Some(5));
    }

    #[test]
    fn fresh_client_first_frame_is_full_text() {
        let (q, _) = queue(8);
        q.push(update("m1", 5, "FULL-5", Some((4, "D5"))));
        let mut r = rx(
            Arc::clone(&q),
            ClientCaps {
                delta: true,
                ..Default::default()
            },
            None,
        );
        assert_eq!(&*r.try_recv().unwrap(), "FULL-5");
        assert_eq!(pos(&r, "m1"), Some(5));
    }

    #[test]
    fn a_queue_exactly_at_cap_gets_a_resync_before_the_gate_closes() {
        // `push` only acts PAST a ceiling, so a draining phone can sit at exactly
        // `cap` with no resync order while the watcher's gate skips the tail.
        let q = Arc::new(ClientQueue::new(2, 1 << 20));
        q.push(frame(1, "lifecycle-1", None, Collapse::None));
        assert!(!q.resync_if_full(), "below the ceiling nothing changes");
        q.push(frame(2, "lifecycle-2", None, Collapse::None));
        assert!(!q.has_headroom());
        assert!(q.resync_if_full());
        assert!(
            !q.resync_if_full(),
            "a pending resync order is not re-issued"
        );
        let mut r = rx(Arc::clone(&q), ClientCaps::default(), None);
        assert_eq!(
            &*r.try_recv().unwrap(),
            r#"{"type":"resync","reason":"queue full"}"#
        );
        assert!(r.try_recv().is_none());
        assert!(q.has_headroom());
    }

    #[test]
    fn non_delta_client_gets_full_text_and_advances_seq() {
        let (q, _) = queue(8);
        q.push(update("m1", 5, "FULL-5", Some((4, "D5"))));
        let mut r = rx(Arc::clone(&q), ClientCaps::default(), Some(4));
        assert_eq!(&*r.try_recv().unwrap(), "FULL-5");
        assert_eq!(pos(&r, "m1"), Some(5));
    }

    #[test]
    fn a_stalled_client_stops_advertising_headroom() {
        // Back-pressure must LATCH. Clearing an overflowed queue to one resync
        // order restores depth and bytes, so without the stall flag the producer
        // resumes instantly and overflows again — 123 resyncs and the full
        // +321 MiB were measured that way during a 150 MiB append.
        let q = Arc::new(ClientQueue::new(2, 1 << 20));
        assert!(q.has_headroom());
        for seq in 1..=4 {
            q.push(frame(seq, "lifecycle", None, Collapse::None));
        }
        assert!(
            !q.has_headroom(),
            "an overflowed client must not look ready"
        );
        let mut r = rx(Arc::clone(&q), ClientCaps::default(), None);
        assert_eq!(
            &*r.try_recv().unwrap(),
            r#"{"type":"resync","reason":"queue overflow"}"#
        );
        assert!(
            q.has_headroom(),
            "draining proves the client is consuming again"
        );
    }

    #[test]
    fn growing_collapsed_frame_resyncs_before_exceeding_budget() {
        let q = Arc::new(ClientQueue::new(64, 4096));
        q.push(update("m1", 1, "small", None));
        q.push(update("m1", 2, &"x".repeat(8192), None));
        let mut r = rx(Arc::clone(&q), ClientCaps::default(), None);
        assert_eq!(
            r.try_recv().as_deref(),
            Some(r#"{"type":"resync","reason":"queue overflow"}"#)
        );
        q.push(update("m1", 3, "recovered", Some((2, "delta"))));
        assert_eq!(r.try_recv().as_deref(), Some("recovered"));
    }

    #[test]
    fn oversized_frame_after_collapsible_update_still_resyncs() {
        let q = Arc::new(ClientQueue::new(64, 4096));
        q.push(update("m1", 1, "small", None));
        q.push(frame(2, &"x".repeat(8192), None, Collapse::None));
        let mut r = rx(q, ClientCaps::default(), None);
        assert_eq!(
            r.try_recv().as_deref(),
            Some(r#"{"type":"resync","reason":"queue overflow"}"#)
        );
    }

    #[test]
    fn one_oversized_frame_cannot_outgrow_the_byte_budget() {
        // A watcher `entries`/`partial` frame can be megabytes, so a count-only
        // ceiling is not a memory bound. Budget 4 KiB here: a 16 KiB frame must
        // become a resync order, not a queued 16 KiB.
        let q = Arc::new(ClientQueue::new(64, 4096));
        let big: String = "x".repeat(16 * 1024);
        let out = q.push(frame(1, &big, None, Collapse::None));
        assert!(out.resynced, "an oversized frame must trigger resync");
        assert_eq!(out.len, 1);
        let mut r = rx(Arc::clone(&q), ClientCaps::default(), None);
        assert_eq!(
            &*r.try_recv().unwrap(),
            r#"{"type":"resync","reason":"queue overflow"}"#
        );
    }

    #[test]
    fn many_medium_frames_stay_inside_the_byte_budget() {
        // Under the count cap but over the byte budget: the queue must still
        // collapse to a resync rather than hold megabytes for one slow phone.
        let q = Arc::new(ClientQueue::new(64, 8192));
        let chunk: String = "y".repeat(2048);
        for seq in 1..=8 {
            q.push(frame(seq, &chunk, None, Collapse::None));
        }
        let (accounted, summed) = accounted_bytes(&q);
        assert_eq!(accounted, summed, "the byte total drifted from the entries");
        assert!(accounted <= 8192, "queued {accounted} B exceeds the budget");
    }

    #[test]
    fn byte_total_tracks_entries_across_every_mutation_path() {
        // The queue keeps an incrementally maintained byte total instead of
        // re-summing the queued frames. Every mutation must move it by exactly
        // the bytes that entered or left: insert, in-place replacement (which
        // can grow or shrink the frame), safe eviction, overflow resync,
        // forced resync, and the receiver pop. Any drift is invisible until a
        // stalled client is charged the wrong amount and either outgrows its
        // memory bound or is resynced while nearly empty, so it is checked
        // after each step of a mixed operation sequence.
        let q = Arc::new(ClientQueue::new(4, 512));
        let mut r = rx(Arc::clone(&q), ClientCaps::default(), None);
        // Deterministic xorshift: a failing step is reproducible.
        fn xorshift(seed: &mut u64) -> u64 {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            *seed
        }
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        for step in 0..2_000u64 {
            let roll = xorshift(&mut seed);
            let size = (roll >> 8) as usize % 300;
            match roll % 5 {
                // Insert a lifecycle frame, then an update that can land on
                // an existing slot for the same chain (replacement, growing or
                // shrinking) or open a new one.
                0 => {
                    let text = "z".repeat(size);
                    q.push(frame(step + 1, &text, None, Collapse::None));
                }
                1 => {
                    let id = format!("m{}", roll % 3);
                    let text = "z".repeat(size);
                    q.push(update(&id, step + 1, &text, None));
                }
                // Receiver pop, forced resync, back-pressure probe.
                2 => {
                    let _ = r.try_recv();
                }
                3 if roll % 20 == 3 => q.force_resync("router lagged"),
                _ => {
                    let _ = q.has_headroom();
                }
            }
            let (accounted, summed) = accounted_bytes(&q);
            assert_eq!(
                accounted, summed,
                "byte total drifted from the queued entries at step {step}"
            );
        }
        // The mixed sequence above need not reach the oversize path, so drive
        // it directly: a frame past the budget must leave exactly the resync
        // order charged, not the frame that was discarded.
        let mut resynced = 0;
        for step in 0..64u64 {
            let big = "y".repeat(4096);
            let out = q.push(frame(step + 1, &big, None, Collapse::None));
            resynced += usize::from(out.resynced);
            let _ = r.try_recv();
            let (accounted, summed) = accounted_bytes(&q);
            assert_eq!(
                accounted, summed,
                "byte total drifted from the entries at oversize step {step}"
            );
        }
        assert!(resynced > 0, "an oversize push must have resynced");
    }

    #[test]
    fn interleaved_frames_do_not_break_a_delta_chain() {
        // THE REGRESSION THIS DESIGN EXISTS TO PREVENT: a session's frames
        // interleave (watcher partials, heartbeats, other messages). With one
        // global stream position, the unrelated frame at seq 6 desynchronised
        // the client and every following update fell back to a full snapshot —
        // measured as ZERO delta frames across a live turn. Positions are per
        // chain, so m1's chain is untouched by anything that is not m1.
        // Drain as each frame arrives: a client that has NOT drained gets its
        // pending m1 frames conflated instead (`same_key_frames_collapse...`),
        // which is the other half of the design.
        let (q, _) = queue(8);
        let mut r = rx(
            Arc::clone(&q),
            ClientCaps {
                delta: true,
                ..Default::default()
            },
            Some(4),
        );
        q.push(update("m1", 5, "FULL-5", Some((4, "D5"))));
        assert_eq!(&*r.try_recv().unwrap(), "D5");
        assert_eq!(pos(&r, "m1"), Some(5));
        q.push(frame(6, "PARTIAL", None, Collapse::None));
        assert_eq!(&*r.try_recv().unwrap(), "PARTIAL");
        assert_eq!(
            pos(&r, "m1"),
            Some(5),
            "an unrelated frame must not move m1"
        );
        q.push(update("m1", 7, "FULL-7", Some((5, "D7"))));
        assert_eq!(&*r.try_recv().unwrap(), "D7");
        assert_eq!(pos(&r, "m1"), Some(7));
    }

    #[test]
    fn a_delta_never_crosses_message_chains() {
        // m2's delta claims base 5, and the client's m1 chain IS at 5 — but the
        // bases belong to different chains, so m2 must arrive as full text.
        let (q, _) = queue(8);
        q.push(update("m1", 5, "FULL-5", None));
        q.push(update("m2", 6, "FULL-6", Some((5, "D6"))));
        let mut r = rx(
            Arc::clone(&q),
            ClientCaps {
                delta: true,
                ..Default::default()
            },
            Some(4),
        );
        assert_eq!(&*r.try_recv().unwrap(), "FULL-5");
        assert_eq!(&*r.try_recv().unwrap(), "FULL-6");
        assert_eq!(pos(&r, "m2"), Some(6));
    }

    #[test]
    fn same_key_frames_collapse_to_newest_full() {
        // The mechanism this file exists for: a client that has not drained
        // receives ONE frame carrying the newest snapshot instead of every
        // intermediate one, and it must be the FULL form because the collapsed
        // entry's delta base was replaced before delivery.
        let (q, _) = queue(8);
        q.push(update("m1", 5, "FULL-5", Some((4, "D5"))));
        q.push(update("m1", 6, "FULL-6", Some((5, "D6"))));
        let mut r = rx(
            Arc::clone(&q),
            ClientCaps {
                delta: true,
                ..Default::default()
            },
            Some(5),
        );
        assert_eq!(&*r.try_recv().unwrap(), "FULL-6");
        assert_eq!(pos(&r, "m1"), Some(6));
        assert!(r.try_recv().is_none(), "the superseded frame must be gone");
    }

    #[test]
    fn resync_resets_stream_position_and_breaks_delta_chain() {
        let (q, _) = queue(1);
        q.push(frame(1, "a", None, Collapse::None));
        q.push(frame(2, "b", None, Collapse::None)); // over cap -> clear + resync
        let mut r = rx(
            Arc::clone(&q),
            ClientCaps {
                delta: true,
                ..Default::default()
            },
            None,
        );
        assert_eq!(
            &*r.try_recv().unwrap(),
            r#"{"type":"resync","reason":"queue overflow"}"#
        );
        // The client's stream position is gone: nothing it "has" can be a
        // delta base. Even a producer "no prior frame" base-0 delta must not
        // be sent; the next delivery is full text.
        assert_eq!(pos(&r, "m1"), None);
        q.push(update("m1", 1, "FULL-1", Some((0, "D0"))));
        assert_eq!(&*r.try_recv().unwrap(), "FULL-1");
        assert_eq!(pos(&r, "m1"), Some(1));
    }

    #[test]
    fn closed_queue_drops_pushes_and_drains() {
        let (q, _) = queue(2);
        q.push(update("m1", 1, "a", None));
        q.close();
        let out = q.push(update("m1", 2, "b", None));
        assert_eq!(out, PushOutcome::default());
        // The entry queued before close still drains; after that, None.
        let mut r = rx(q, ClientCaps::default(), None);
        assert_eq!(&*r.try_recv().unwrap(), "a");
        assert!(r.try_recv().is_none());
    }

    #[test]
    fn push_outcome_counts_superseded_only_on_collapse() {
        let (q, _) = queue(8);
        assert_eq!(q.push(update("m1", 1, "a", None)).superseded, 0);
        assert_eq!(q.push(update("m1", 2, "b", None)).superseded, 1);
        assert_eq!(q.push(update("m2", 3, "c", None)).superseded, 0);
    }

    #[cfg(test)]
    fn test_config() -> Config {
        let tmp = std::env::temp_dir();
        Config {
            // Speech-to-text is off in tests: no interpreter, no model.
            asr_python: None,
            asr_model_dir: None,
            asr_threads: 6,
            host: "127.0.0.1".into(),
            port: 0,
            sessions_root: tmp.clone(),
            omp_bin: tmp.clone(),
            // Embedded assets in tests; the fixture never serves the app.
            public_dir: None,
            token_hash: None,
            max_children: 1,
            push_store_path: tmp.clone(),
            vapid_path: tmp.clone(),
            state_dir: tmp.clone(),
            home: tmp,
            watch_interval_ms: 250,
            ws_queue_cap: 4,
            ws_queue_bytes: 1 << 20,
            child_idle_secs: 900,
            child_unwatched_secs: 300,
            child_rss_mb: 0,
            child_lean_js: false,
            prewarm_on_attach: false,
            owner_cache_ms: 3000,
            ws_deflate_min: 4096,
            // Test-only Default: temp-dir based, never touches the real state.
            paths: Arc::new(crate::paths::Paths::default()),
        }
    }

    #[test]
    fn hub_next_seq_is_monotone_and_prunes_with_last_client() {
        let hub = WsHub::new(Arc::new(test_config()));
        assert_eq!(hub.next_seq("s1"), 1);
        assert_eq!(hub.next_seq("s1"), 2);
        assert_eq!(hub.next_seq("s2"), 1);
        let (id, _rx) = hub.attach("s1".into(), ClientCaps::default());
        assert_eq!(hub.client_count("s1"), 1);
        assert_eq!(hub.next_seq("s1"), 3);
        drop(_rx);
        hub.detach(id);
        assert_eq!(hub.client_count("s1"), 0);
        // Last client gone: the counter is pruned, so it restarts at 1. No
        // client exists to have seen the old seqs, so nothing can collide.
        assert_eq!(hub.next_seq("s1"), 1);
    }

    #[test]
    fn a_hidden_page_still_receives_but_does_not_count_as_visible() {
        let hub = WsHub::new(Arc::new(test_config()));
        let (a, mut ra) = hub.attach("s1".into(), ClientCaps::default());
        let (b, _rb) = hub.attach("s1".into(), ClientCaps::default());
        assert_eq!(hub.visible_count("s1"), 2);
        hub.set_visible(a, false);
        hub.set_visible(b, false);
        assert_eq!(hub.visible_count("s1"), 0);
        // Delivery is untouched by visibility: a frame that IS produced
        // reaches a hidden page too.
        assert_eq!(hub.client_count("s1"), 2);
        hub.broadcast("s1", r#"{"type":"event"}"#);
        assert_eq!(ra.try_recv().as_deref(), Some(r#"{"type":"event"}"#));
        hub.set_visible(b, true);
        assert_eq!(hub.visible_count("s1"), 1);
        // A detached hidden client leaves no stale entry for a reused id.
        hub.detach(a);
        hub.set_visible(a, false);
        let inner = hub.inner.lock().unwrap_or_else(|p| p.into_inner());
        assert!(inner.hidden.is_empty());
    }

    /// Counts audience wakes, so tests can see exactly when the hub would
    /// restart a parked watcher.
    fn counted_wakes(hub: &WsHub) -> Arc<AtomicU64> {
        let wakes = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&wakes);
        hub.set_audience_wake(Box::new(move || {
            counter.fetch_add(1, Ordering::Relaxed);
        }));
        wakes
    }

    #[test]
    fn only_a_visible_client_with_headroom_is_an_audience() {
        // The bug: the web app keeps its socket open while the phone is
        // locked, so counting every client kept the watcher's tail and 250 ms
        // stat loop awake in a pocket.
        let hub = WsHub::new(Arc::new(test_config()));
        assert!(!hub.has_audience("s1"), "no clients, no audience");
        let (phone, _rp) = hub.attach("s1".into(), ClientCaps::default());
        assert!(hub.has_audience("s1"));
        hub.set_visible(phone, false);
        assert!(!hub.has_audience("s1"), "a hidden-only audience is none");
        // A visible laptop beside the hidden phone keeps the tail running.
        let (laptop, mut rl) = hub.attach("s1".into(), ClientCaps::default());
        assert!(hub.has_audience("s1"));
        // ...unless the laptop is not draining: its full queue is no audience,
        // and it is handed a resync order before the tail is skipped.
        for _ in 0..test_config().ws_queue_cap {
            hub.broadcast("s1", r#"{"type":"event"}"#);
        }
        assert!(!hub.has_audience("s1"));
        assert_eq!(
            rl.try_recv().as_deref(),
            Some(r#"{"type":"resync","reason":"queue full"}"#)
        );
        assert!(hub.has_audience("s1"), "draining restores the audience");
        hub.detach(laptop);
        hub.detach(phone);
    }

    #[test]
    fn set_visible_after_a_skipped_tail_enqueues_exactly_one_resync() {
        let hub = WsHub::new(Arc::new(test_config()));
        let wakes = counted_wakes(&hub);
        let (id, mut r) = hub.attach("s1".into(), ClientCaps::default());
        assert_eq!(wakes.load(Ordering::Relaxed), 1, "attach wakes the watcher");
        hub.set_visible(id, false);
        // Asking alone owes nothing: the tick asks without skipping.
        assert!(!hub.has_audience("s1"));
        hub.set_visible(id, true);
        assert!(r.try_recv().is_none(), "no skip, no resync");
        assert_eq!(
            wakes.load(Ordering::Relaxed),
            2,
            "visible wakes the watcher"
        );
        // A skipped tail while hidden owes exactly one resync, however many
        // tails were skipped, delivered only once the page is visible.
        hub.set_visible(id, false);
        assert!(!hub.has_audience("s1"));
        hub.tail_skipped("s1");
        hub.tail_skipped("s1");
        assert!(r.try_recv().is_none(), "a hidden page is not resynced");
        hub.set_visible(id, true);
        assert_eq!(wakes.load(Ordering::Relaxed), 3);
        assert_eq!(
            r.try_recv().as_deref(),
            Some(r#"{"type":"resync","reason":"hidden"}"#)
        );
        assert!(r.try_recv().is_none());
        // Draining the resync clears its stall, which wakes once more.
        assert_eq!(wakes.load(Ordering::Relaxed), 4);
        // Repeated visible reports neither resync again nor wake again.
        hub.set_visible(id, true);
        assert!(r.try_recv().is_none());
        assert_eq!(wakes.load(Ordering::Relaxed), 4);
        assert_eq!(hub.stats()["resyncs"].as_u64(), Some(1));
    }

    #[test]
    fn visibility_restored_between_audience_check_and_skip_still_recovers() {
        let hub = WsHub::new(Arc::new(test_config()));
        let (id, mut r) = hub.attach("s1".into(), ClientCaps::default());
        hub.set_visible(id, false);
        assert!(!hub.has_audience("s1"));
        // The exact race: restore observes no debt, then the drainer skips.
        hub.set_visible(id, true);
        assert!(r.try_recv().is_none());
        hub.tail_skipped("s1");
        hub.tail_skipped("s1");
        assert_eq!(
            r.try_recv().as_deref(),
            Some(r#"{"type":"resync","reason":"hidden"}"#)
        );
        assert!(r.try_recv().is_none(), "one recovery covers both skips");
    }

    #[test]
    fn hidden_catchup_preserves_queued_live_only_frames() {
        let hub = WsHub::new(Arc::new(test_config()));
        let (id, mut r) = hub.attach("s1".into(), ClientCaps::default());
        hub.set_visible(id, false);
        hub.broadcast(
            "s1",
            r#"{"type":"event","event":{"type":"command_output","text":"late output"}}"#,
        );
        hub.broadcast("s1", r#"{"type":"event","event":{"type":"extension_ui_response_ack","id":"q","phase":"handoff"}}"#);
        hub.tail_skipped("s1");
        hub.set_visible(id, true);
        assert!(
            r.try_recv()
                .expect("command output retained")
                .contains("late output")
        );
        assert!(
            r.try_recv()
                .expect("dialog acknowledgement retained")
                .contains("handoff")
        );
        assert_eq!(
            r.try_recv().as_deref(),
            Some(r#"{"type":"resync","reason":"hidden"}"#)
        );
        assert!(r.try_recv().is_none());
        let stats = hub.stats();
        assert_eq!(stats["resyncs"].as_u64(), Some(1));
    }

    #[test]
    fn catchup_marker_obeys_queue_caps_and_byte_budget() {
        let q = Arc::new(ClientQueue::new(1, 64));
        q.push(frame(1, "live", None, Collapse::None));
        assert_eq!(q.request_resync("hidden"), Some(1));
        assert_eq!(
            q.request_resync("hidden"),
            None,
            "pending markers deduplicate"
        );
        let state = q.q.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(state.len(), 1);
        assert!(state.bytes <= 64);
        assert_eq!(state.entries.front().expect("recovery").frame.seq, 0);
    }

    #[test]
    fn a_stalled_client_draining_wakes_the_watcher_once() {
        let hub = WsHub::new(Arc::new(test_config()));
        let wakes = counted_wakes(&hub);
        let (_id, mut r) = hub.attach("s1".into(), ClientCaps::default());
        hub.broadcast("s1", r#"{"type":"event"}"#);
        // An ordinary pop is the hot path: no wake.
        assert!(r.try_recv().is_some());
        assert_eq!(wakes.load(Ordering::Relaxed), 1);
        hub.resync_all("lagged");
        assert!(!hub.has_audience("s1"), "a stalled client is no audience");
        assert!(r.try_recv().is_some());
        assert_eq!(wakes.load(Ordering::Relaxed), 2, "the stall clearing wakes");
        hub.broadcast("s1", r#"{"type":"event"}"#);
        assert!(r.try_recv().is_some());
        assert_eq!(wakes.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn full_queue_draining_wakes_a_parked_watcher_without_a_stall_marker() {
        let mut config = test_config();
        config.ws_queue_cap = 1;
        let hub = WsHub::new(Arc::new(config));
        let wakes = counted_wakes(&hub);
        let (_id, mut rx) = hub.attach("s1".into(), ClientCaps::default());
        hub.broadcast("s1", r#"{"type":"event"}"#);

        // The audience check sees a full queue, then a receiver drains it
        // before resync_if_full acquires the queue lock.
        assert!(!rx.queue.has_headroom());
        assert!(rx.try_recv().is_some());
        assert!(!rx.queue.resync_if_full());
        assert!(hub.has_audience("s1"));
        assert_eq!(
            wakes.load(Ordering::Relaxed),
            2,
            "headroom must wake the parked watcher"
        );
    }
    #[test]
    fn hub_stats_reports_live_state_and_behavior() {
        let hub = WsHub::new(Arc::new(test_config()));
        let (id, _rx) = hub.attach("s1".into(), ClientCaps::default());
        hub.broadcast("s1", r#"{"type":"event"}"#);
        let stats = hub.stats();
        assert_eq!(stats["clients"].as_u64(), Some(1));
        assert_eq!(stats["sessions"].as_u64(), Some(1));
        assert_eq!(stats["full_sent"].as_u64(), Some(0)); // queued, not yet delivered
        assert_eq!(stats["queue_peak"].as_u64(), Some(1));
        drop(_rx);
        hub.detach(id);
        let stats = hub.stats();
        assert_eq!(stats["clients"].as_u64(), Some(0));
        assert_eq!(stats["sessions"].as_u64(), Some(0));
    }

    #[tokio::test]
    async fn hub_delivers_frames_and_closes_on_detach() {
        let hub = WsHub::new(Arc::new(test_config()));
        let (id, mut r) = hub.attach("s1".into(), ClientCaps::default());
        hub.broadcast_frame(
            "s1",
            OutFrame {
                seq: hub.next_seq("s1"),
                text: Arc::from("hello"),
                delta: None,
                collapse: Collapse::None,
            },
        );
        assert_eq!(r.recv().await.as_deref(), Some("hello"));
        hub.detach(id);
        assert_eq!(r.recv().await, None);
    }

    #[tokio::test]
    async fn hub_sends_delta_only_to_in_step_capable_client() {
        let hub = WsHub::new(Arc::new(test_config()));
        let (id1, mut r_delta) = hub.attach(
            "s1".into(),
            ClientCaps {
                delta: true,
                ..Default::default()
            },
        );
        let (id2, mut r_plain) = hub.attach("s1".into(), ClientCaps::default());
        // First frame: no delta yet — both clients get the canonical full text.
        hub.broadcast_frame(
            "s1",
            OutFrame {
                seq: 1,
                text: Arc::from("F1"),
                delta: None,
                collapse: Collapse::Update(Arc::from("m1")),
            },
        );
        assert_eq!(r_delta.recv().await.as_deref(), Some("F1"));
        assert_eq!(r_plain.recv().await.as_deref(), Some("F1"));
        // In-step delta client gets the increment; the legacy client gets the
        // full snapshot — byte-identical to yesterday's protocol.
        hub.broadcast_frame(
            "s1",
            OutFrame {
                seq: 2,
                text: Arc::from("F1F2"),
                delta: Some((1, Arc::from("F2"))),
                collapse: Collapse::Update(Arc::from("m1")),
            },
        );
        assert_eq!(r_delta.recv().await.as_deref(), Some("F2"));
        assert_eq!(r_plain.recv().await.as_deref(), Some("F1F2"));
        let stats = hub.stats();
        assert_eq!(stats["delta_sent"].as_u64(), Some(1));
        assert_eq!(stats["full_sent"].as_u64(), Some(3));
        hub.detach(id1);
        hub.detach(id2);
    }
}
