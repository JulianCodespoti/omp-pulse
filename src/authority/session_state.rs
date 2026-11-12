//! Canonical session owner, turn and activity state with revisioned projections.
//! Source bindings fence retired events before lifecycle effects; snapshot reads
//! do not consume event sequence numbers or infer completion from disconnects.
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Child,
    Bridge,
    Collab,
}

impl SourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Child => "child",
            Self::Bridge => "bridge",
            Self::Collab => "collab",
        }
    }
}

/// Daemon-observed source identity. `source_id` identifies one transport
/// instance; `binding_epoch` identifies its session binding. Neither field
/// establishes upstream event order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceIdentity {
    pub kind: SourceKind,
    pub source_id: u64,
    pub binding_epoch: u64,
    pub pid: Option<i32>,
    pub process_start: Option<u64>,
    pub peer_id: Option<String>,
    pub room_id: Option<String>,
    pub can_write: Option<bool>,
}

impl SourceIdentity {
    fn same_owner(&self, other: &Self) -> bool {
        let same_process = self.pid.is_some()
            && self.pid == other.pid
            && self.process_start.is_some()
            && self.process_start == other.process_start;
        let same_collab_peer = self.kind == SourceKind::Collab
            && other.kind == SourceKind::Collab
            && self.peer_id.is_some()
            && self.peer_id == other.peer_id
            && self.room_id.is_some()
            && self.room_id == other.room_id;
        same_process || same_collab_peer
    }

    pub(crate) fn wire_owner(&self) -> Owner {
        Owner {
            kind: self.kind.as_str().to_owned(),
            pid: self.pid,
            process_start: self.process_start,
            peer_id: self.peer_id.clone(),
            room_id: self.room_id.clone(),
            can_write: self.can_write,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SourceStamp {
    pub identity: SourceIdentity,
    /// Sequence assigned when the daemon adapter receives/emits the event.
    /// This fences queued work within that adapter; it is not an upstream
    /// sequence and cannot repair reordering that occurred before receipt.
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_start: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_write: Option<bool>,
}
impl Owner {
    pub(crate) fn matches_source(&self, source: &SourceIdentity) -> bool {
        if matches!(self.kind.as_str(), "unknown" | "none") {
            return true;
        }
        let same_process = self.pid.is_some()
            && self.pid == source.pid
            && self.process_start.is_some()
            && self.process_start == source.process_start;
        let same_collab_peer = source.kind == SourceKind::Collab
            && self.peer_id.is_some()
            && self.peer_id == source.peer_id
            && self.room_id.is_some()
            && self.room_id == source.room_id;
        same_process || same_collab_peer
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Turn {
    Running,
    Idle,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Confirmed,
    Inferred,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    Connected,
    Reconnecting,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub read: bool,
    pub stream: bool,
    pub control: bool,
    pub send: bool,
    pub stop: bool,
    pub answer: bool,
    pub settings: bool,
    pub bash: bool,
    /// The owner can hold a mid-turn prompt as a follow-up instead of
    /// steering it. The collab host always steers, so it reports false.
    pub queue: bool,
    /// The owner can abort the running turn and prompt in one step. Only
    /// a daemon-hosted child has `abort_and_prompt`.
    pub interrupt: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            read: true,
            stream: false,
            control: false,
            send: false,
            stop: false,
            answer: false,
            settings: false,
            bash: false,
            queue: false,
            interrupt: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub daemon_instance_id: String,
    pub revision: u64,
    pub owner: Owner,
    pub binding_epoch: u64,
    pub turn: Turn,
    pub confidence: Confidence,
    pub connection: Connection,
    pub observed_at: u64,
    pub activity: Option<Value>,
    pub pending_input: Option<Value>,
    /// omp reported work that outlives the turn (`prompt_result` with
    /// `sessionSettled: false`: a background job or subagent that can still
    /// wake the session) and has not yet sent `session_settled`. The phone
    /// shows a quiet "Background job running" line from this. Omitted when
    /// false so idle records stay byte-identical to before.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub background_work: bool,
    pub capabilities: Capabilities,
}

impl SessionState {
    /// Compatibility projection for the former per-session activity `now` object.
    pub fn legacy_now(&self) -> Value {
        if self.turn != Turn::Running {
            return Value::Null;
        }
        let Some(activity) = self.activity.as_ref() else {
            return Value::Null;
        };
        let at = activity
            .get("observedAt")
            .and_then(Value::as_u64)
            .unwrap_or(self.observed_at);
        let mut now = json!({
            "state": activity.get("kind").and_then(Value::as_str).unwrap_or("thinking"),
            "since": activity.get("since").and_then(Value::as_u64).unwrap_or(at),
            "turnStartedAt": activity.get("turnStartedAt").and_then(Value::as_u64).unwrap_or(at),
            "tools": activity.get("tools").and_then(Value::as_u64).unwrap_or(0),
            "title": activity.get("title").and_then(Value::as_str).unwrap_or(""),
        });
        if let Some(value) = activity.get("tool") {
            now["tool"] = value.clone();
        }
        if let Some(value) = activity.get("label") {
            now["label"] = value.clone();
        }
        now
    }
}

#[derive(Debug, Clone)]
pub struct Seed {
    pub owner: Owner,
    pub turn: Turn,
    pub confidence: Confidence,
    pub connection: Connection,
    pub activity: Option<Value>,
    pub capabilities: Capabilities,
    pub source: Option<SourceIdentity>,
    pub sequence: u64,
}

#[derive(Debug, Clone)]
struct Record {
    state: SessionState,
    source: Option<SourceIdentity>,
    source_active: bool,
    sequence: u64,
    // Snapshot reads may see a sequence before its queued event is routed.
    event_sequence: u64,
    retired_sources: HashSet<SourceKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct SourceKey {
    kind: SourceKind,
    source_id: u64,
    binding_epoch: u64,
}

impl From<&SourceIdentity> for SourceKey {
    fn from(source: &SourceIdentity) -> Self {
        Self {
            kind: source.kind,
            source_id: source.source_id,
            binding_epoch: source.binding_epoch,
        }
    }
}
/// In-memory per-daemon authority. Lock scope is limited to map/reducer work;
/// adapters do file, process, and network operations before calling it.
pub struct SessionStateRegistry {
    daemon_instance_id: String,
    sessions: Mutex<HashMap<String, Record>>,
}

impl Default for SessionStateRegistry {
    fn default() -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        Self {
            daemon_instance_id: format!("{}-{now:x}", std::process::id()),
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl SessionStateRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Record>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Project a single observation into the lifetime record. Repeated reads
    /// with unchanged evidence do not churn revisions or ETags.
    pub fn project(&self, session: &str, seed: Seed) -> SessionState {
        let mut sessions = self.lock();
        let Some(record) = sessions.get_mut(session) else {
            let source = seed.source.clone();
            let sequence = seed.sequence;
            let source_active = source.is_some();
            let state = self.initial(seed);
            sessions.insert(
                session.to_owned(),
                Record {
                    source,
                    source_active,
                    sequence,
                    event_sequence: 0,
                    retired_sources: HashSet::new(),
                    state: state.clone(),
                },
            );
            return state;
        };

        if let Some(incoming) = seed.source.as_ref() {
            if record.retired_sources.contains(&SourceKey::from(incoming)) {
                return record.state.clone();
            }
            if record.source.as_ref() == Some(incoming) {
                if seed.sequence < record.sequence {
                    return record.state.clone();
                }
                record.sequence = seed.sequence;
                record.source_active = true;
                self.apply_seed(&mut record.state, seed, false);
            } else if Self::can_rebind(record, incoming) {
                if let Some(current) = record.source.replace(incoming.clone()) {
                    record.retired_sources.insert(SourceKey::from(&current));
                }
                record.source_active = true;
                record.sequence = seed.sequence;
                record.event_sequence = 0;
                record.state.binding_epoch = record.state.binding_epoch.saturating_add(1);
                self.apply_seed(&mut record.state, seed, true);
            } else {
                self.mark_ambiguous(&mut record.state);
            }
        } else if record.source.is_none() {
            self.apply_seed(&mut record.state, seed, false);
        } else if !record.source_active
            && seed.owner.kind == "none"
            && seed.turn == Turn::Idle
            && seed.connection == Connection::Connected
        {
            // Retirement alone is not completion. A subsequent owner scan
            // must also find no writer before historical chats can stop
            // reconnecting to an exited process or a switched-away binding.
            // Keep the retired-source fence so delayed events stay rejected.
            record.source = None;
            record.sequence = 0;
            record.event_sequence = 0;
            record.state.binding_epoch = record.state.binding_epoch.saturating_add(1);
            self.apply_seed(&mut record.state, seed, true);
        }
        record.state.clone()
    }
    fn can_rebind(record: &Record, incoming: &SourceIdentity) -> bool {
        if record.source.as_ref() == Some(incoming) {
            return true;
        }
        if record.source.is_some()
            && (!record.source_active || record.state.connection != Connection::Connected)
        {
            return true;
        }
        if let Some(current) = record.source.as_ref() {
            if current.same_owner(incoming) {
                if incoming.kind == current.kind
                    && (incoming.source_id < current.source_id
                        || (incoming.source_id == current.source_id
                            && incoming.binding_epoch < current.binding_epoch))
                {
                    return false;
                }
                return true;
            }
            record.state.confidence == Confidence::Inferred
                && record.state.owner.kind == "foreign"
                && incoming.kind == SourceKind::Collab
        } else if record.state.confidence == Confidence::Inferred
            && record.state.owner.kind == "foreign"
            && incoming.kind == SourceKind::Collab
        {
            true
        } else {
            record.state.owner.matches_source(incoming)
        }
    }

    pub(crate) fn capabilities_for(source: &SourceIdentity) -> Capabilities {
        match source.kind {
            SourceKind::Child => Capabilities {
                read: true,
                stream: true,
                control: true,
                send: true,
                stop: true,
                answer: true,
                settings: true,
                bash: true,
                queue: true,
                interrupt: true,
            },
            SourceKind::Bridge => Capabilities {
                read: true,
                stream: true,
                control: true,
                send: true,
                stop: true,
                answer: true,
                settings: true,
                bash: false,
                queue: true,
                interrupt: false,
            },
            SourceKind::Collab => {
                let writable = source.can_write == Some(true);
                Capabilities {
                    read: true,
                    stream: true,
                    control: writable,
                    send: writable,
                    stop: writable,
                    answer: writable,
                    settings: false,
                    bash: false,
                    queue: false,
                    interrupt: false,
                }
            }
        }
    }

    /// Accept a source event only for the current source binding and in
    /// adapter-receive order. `false` means no broadcast, activity mutation,
    /// receipt completion, or notification may be caused by this event.
    pub fn observe_event(&self, session: &str, stamp: &SourceStamp, event: &Value) -> bool {
        let mut sessions = self.lock();
        let Some(record) = sessions.get_mut(session) else {
            let seed = Seed {
                owner: stamp.identity.wire_owner(),
                turn: Turn::Unknown,
                confidence: Confidence::Confirmed,
                connection: Connection::Connected,
                activity: None,
                capabilities: Self::capabilities_for(&stamp.identity),
                source: Some(stamp.identity.clone()),
                sequence: stamp.sequence,
            };
            let mut state = self.initial(seed);
            reduce_state(&mut state, &stamp.identity, event);
            sessions.insert(
                session.to_owned(),
                Record {
                    source: Some(stamp.identity.clone()),
                    source_active: true,
                    sequence: stamp.sequence,
                    event_sequence: stamp.sequence,
                    retired_sources: HashSet::new(),
                    state,
                },
            );
            return true;
        };

        if record
            .retired_sources
            .contains(&SourceKey::from(&stamp.identity))
        {
            return false;
        }
        if record.state.owner.kind == "ambiguous" && record.source_active {
            return false;
        }
        let previous = record.state.clone();
        if record.source.as_ref() == Some(&stamp.identity) {
            if !record.source_active
                || stamp.sequence < record.sequence
                || stamp.sequence <= record.event_sequence
            {
                return false;
            }
            record.sequence = stamp.sequence;
            record.event_sequence = stamp.sequence;
        } else if Self::can_rebind(record, &stamp.identity) {
            if let Some(current) = record.source.replace(stamp.identity.clone()) {
                record.retired_sources.insert(SourceKey::from(&current));
            }
            record.source_active = true;
            record.sequence = stamp.sequence;
            record.event_sequence = stamp.sequence;
            record.state.binding_epoch = record.state.binding_epoch.saturating_add(1);
            record.state.owner = stamp.identity.wire_owner();
            record.state.capabilities = Self::capabilities_for(&stamp.identity);
            record.state.confidence = Confidence::Confirmed;
        } else {
            self.mark_ambiguous(&mut record.state);
            return false;
        }

        record.state.connection = Connection::Connected;
        record.state.observed_at = now_ms();
        reduce_state(&mut record.state, &stamp.identity, event);
        if semantic_eq(&previous, &record.state) {
            record.state = previous;
        } else {
            record.state.revision = previous.revision.saturating_add(1);
        }
        true
    }

    /// Mark a transport generation retired without treating stream loss as a
    /// completed turn. Delayed events from it are rejected after replacement.
    pub fn retire_source(&self, session: &str, identity: &SourceIdentity) {
        let mut sessions = self.lock();
        let Some(record) = sessions.get_mut(session) else {
            return;
        };
        if record.source.as_ref() != Some(identity) || !record.source_active {
            return;
        }
        record.retired_sources.insert(SourceKey::from(identity));
        record.source_active = false;
        let previous = record.state.clone();
        record.state.connection = Connection::Reconnecting;
        // The job lived in the process that just went away.
        record.state.background_work = false;
        if let Some(activity) = &mut record.state.activity
            && let Some(object) = activity.as_object_mut()
        {
            object.insert("stale".to_owned(), Value::Bool(true));
        }
        record.state.observed_at = now_ms();
        if !semantic_eq(&previous, &record.state) {
            record.state.revision = previous.revision.saturating_add(1);
        }
    }

    /// A source the daemon stopped on purpose while idle (reap, eviction,
    /// recycle): unlike `retire_source`, the end is known, so the session is
    /// unowned, idle and connected at once instead of "reconnecting" to a
    /// process that is gone. Delayed events from it stay fenced. `true` when
    /// the record changed.
    pub fn release_source(&self, session: &str, identity: &SourceIdentity) -> bool {
        let mut sessions = self.lock();
        let Some(record) = sessions.get_mut(session) else {
            return false;
        };
        if record.source.as_ref() != Some(identity) {
            return false;
        }
        Self::release(record);
        true
    }

    /// Stop pressed while the record still shows a turn running for one of
    /// our children that has already exited (crash, or killed mid-turn): no
    /// event will ever end that turn, so it ends here. Only a retired child
    /// source qualifies; a live owner or a desktop/collab one is never
    /// overridden. `true` when the record changed.
    pub fn release_retired_child(&self, session: &str) -> bool {
        let mut sessions = self.lock();
        let Some(record) = sessions.get_mut(session) else {
            return false;
        };
        let retired_child = !record.source_active
            && record
                .source
                .as_ref()
                .is_some_and(|source| source.kind == SourceKind::Child);
        if !retired_child || record.state.turn == Turn::Idle {
            return false;
        }
        Self::release(record);
        true
    }

    fn release(record: &mut Record) {
        if let Some(source) = record.source.take() {
            record.retired_sources.insert(SourceKey::from(&source));
        }
        record.source_active = false;
        record.sequence = 0;
        record.event_sequence = 0;
        let state = &mut record.state;
        state.binding_epoch = state.binding_epoch.saturating_add(1);
        state.owner = Owner {
            kind: "none".to_owned(),
            pid: None,
            process_start: None,
            peer_id: None,
            room_id: None,
            can_write: None,
        };
        state.turn = Turn::Idle;
        state.confidence = Confidence::Confirmed;
        state.connection = Connection::Connected;
        state.activity = None;
        state.pending_input = None;
        state.background_work = false;
        state.capabilities = Capabilities::default();
        state.observed_at = now_ms();
        state.revision = state.revision.saturating_add(1);
    }

    pub fn current(&self, session: &str) -> Option<SessionState> {
        self.lock().get(session).map(|record| record.state.clone())
    }

    pub fn source_snapshot(&self, session: &str) -> Option<SourceStamp> {
        let sessions = self.lock();
        let record = sessions.get(session)?;
        if !record.source_active {
            return None;
        }
        Some(SourceStamp {
            identity: record.source.clone()?,
            sequence: record.sequence,
        })
    }

    pub fn daemon_instance_id(&self) -> &str {
        &self.daemon_instance_id
    }

    fn initial(&self, seed: Seed) -> SessionState {
        SessionState {
            daemon_instance_id: self.daemon_instance_id.clone(),
            revision: 1,
            owner: seed.owner,
            binding_epoch: u64::from(seed.source.is_some()),
            turn: seed.turn,
            confidence: seed.confidence,
            connection: seed.connection,
            observed_at: now_ms(),
            activity: seed.activity,
            pending_input: None,
            background_work: false,
            capabilities: seed.capabilities,
        }
    }

    fn apply_seed(&self, state: &mut SessionState, seed: Seed, rebind: bool) {
        let changed = state.owner != seed.owner
            || state.turn != seed.turn
            || state.confidence != seed.confidence
            || state.connection != seed.connection
            || state.activity != seed.activity
            || state.capabilities != seed.capabilities;
        if changed || rebind {
            state.owner = seed.owner;
            state.turn = seed.turn;
            state.confidence = seed.confidence;
            state.connection = seed.connection;
            state.activity = seed.activity;
            if rebind || seed.turn == Turn::Idle {
                state.pending_input = None;
            }
            // A new binding is a different process; its jobs are its own.
            if rebind {
                state.background_work = false;
            }
            state.capabilities = seed.capabilities;
            state.observed_at = now_ms();
            state.revision = state.revision.saturating_add(1);
        }
    }

    fn mark_ambiguous(&self, state: &mut SessionState) {
        if state.owner.kind == "ambiguous" {
            return;
        }
        state.owner = Owner {
            kind: "ambiguous".to_owned(),
            pid: None,
            process_start: None,
            peer_id: None,
            room_id: None,
            can_write: None,
        };
        state.turn = Turn::Unknown;
        state.confidence = Confidence::Inferred;
        state.connection = Connection::Connected;
        state.activity = None;
        state.pending_input = None;
        state.background_work = false;
        state.capabilities = Capabilities::default();
        state.observed_at = now_ms();
        state.revision = state.revision.saturating_add(1);
    }
}

fn semantic_eq(a: &SessionState, b: &SessionState) -> bool {
    a.owner == b.owner
        && a.binding_epoch == b.binding_epoch
        && a.turn == b.turn
        && a.confidence == b.confidence
        && a.connection == b.connection
        && a.activity == b.activity
        && a.pending_input == b.pending_input
        && a.background_work == b.background_work
        && a.capabilities == b.capabilities
}

fn reduce_state(state: &mut SessionState, source: &SourceIdentity, event: &Value) {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let at = now_ms();
    match event_type {
        "agent_start" => {
            state.turn = Turn::Running;
            state.confidence = Confidence::Confirmed;
            state.activity = Some(
                json!({"source": source.kind.as_str(), "kind": "thinking", "observedAt": at, "since":at, "turnStartedAt":at, "tools":0, "stale": false}),
            );
        }
        "agent_end"
            if event.get("isTerminal").and_then(Value::as_bool) != Some(false)
                && event.get("bridgeLost").and_then(Value::as_bool) != Some(true) =>
        {
            state.turn = Turn::Idle;
            state.confidence = Confidence::Confirmed;
            state.activity = None;
            state.pending_input = None;
        }
        "agent_end" if event.get("bridgeLost").and_then(Value::as_bool) == Some(true) => {
            state.connection = Connection::Reconnecting;
            if let Some(activity) = &mut state.activity
                && let Some(object) = activity.as_object_mut()
            {
                object.insert("stale".to_owned(), Value::Bool(true));
            }
        }
        "session_settled" => {
            state.turn = Turn::Idle;
            state.confidence = Confidence::Confirmed;
            state.activity = None;
            state.pending_input = None;
            state.background_work = false;
        }
        // omp's turn outcome: the prompt resolved, so the run it started is
        // over, as in the TUI, whose editor frees up while a background job
        // runs. `sessionSettled: false` means a job can still wake the
        // session; `session_settled` follows when it drains, and a woken run
        // announces itself with `agent_start`. A printing slash command
        // (`/api/command`, request id `pulse-command:*`, `agentInvoked:
        // false`) resolves without having run the agent: it must not end a
        // real turn that happens to be running beside it.
        "prompt_result" => {
            let printing = event.get("agentInvoked").and_then(Value::as_bool) == Some(false)
                || event
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.starts_with("pulse-command:"));
            if !printing {
                if let Some(settled) = event.get("sessionSettled").and_then(Value::as_bool) {
                    state.background_work = !settled;
                }
                state.turn = Turn::Idle;
                state.confidence = Confidence::Confirmed;
                state.activity = None;
            }
        }
        "tool_execution_start" => {
            let label = crate::authority::activity::tool_label(event);
            update_activity(state, source, "tool", label.as_deref(), at);
            if let Some(activity) = state.activity.as_mut() {
                activity["tool"] = event.get("toolName").cloned().unwrap_or(Value::Null);
            }
        }
        "tool_execution_end" => {
            update_activity(state, source, "thinking", None, at);
            if let Some(activity) = state.activity.as_mut() {
                activity["tools"] =
                    json!(activity.get("tools").and_then(Value::as_u64).unwrap_or(0) + 1);
            }
        }
        "message_update" => {
            if event.pointer("/message/role").and_then(Value::as_str) == Some("assistant") {
                match event
                    .pointer("/assistantMessageEvent/type")
                    .and_then(Value::as_str)
                {
                    Some("text_delta" | "text_start") => {
                        update_activity(state, source, "writing", None, at)
                    }
                    Some("thinking_delta" | "thinking_start") => {
                        update_activity(state, source, "thinking", None, at)
                    }
                    _ => {}
                }
            }
        }
        "collab_ui_request" => {
            if let Some(request) = event.get("request") {
                state.pending_input = Some(request.clone());
            }
        }
        "collab_ui_request_end" => {
            if state
                .pending_input
                .as_ref()
                .and_then(|pending| pending.get("reqId"))
                == event.get("reqId")
            {
                state.pending_input = None;
            }
        }
        "extension_ui_request" => match event.get("method").and_then(Value::as_str) {
            method if crate::omp::ui_dialog::is_blocking(method) => {
                state.pending_input = Some(event.clone())
            }
            Some("cancel")
                if state
                    .pending_input
                    .as_ref()
                    .and_then(|pending| pending.get("id"))
                    == event.get("targetId") =>
            {
                state.pending_input = None
            }
            _ => {}
        },
        _ => {}
    }
    state.observed_at = at;
}

fn update_activity(
    state: &mut SessionState,
    source: &SourceIdentity,
    kind: &str,
    label: Option<&str>,
    at: u64,
) {
    if state.turn != Turn::Running {
        return;
    }
    let previous = state.activity.as_ref();
    let same = previous.and_then(|v| v.get("kind")).and_then(Value::as_str) == Some(kind)
        && kind != "tool";
    let since = if same {
        previous
            .and_then(|v| v.get("since"))
            .and_then(Value::as_u64)
            .unwrap_or(at)
    } else {
        at
    };
    let started = previous
        .and_then(|v| v.get("turnStartedAt"))
        .and_then(Value::as_u64)
        .unwrap_or(at);
    let tools = previous
        .and_then(|v| v.get("tools"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let observed = if same {
        previous
            .and_then(|v| v.get("observedAt"))
            .and_then(Value::as_u64)
            .unwrap_or(at)
    } else {
        at
    };
    let mut activity = json!({"source":source.kind.as_str(), "kind":kind, "observedAt":observed, "since":since, "turnStartedAt":started, "tools":tools, "stale":false});
    if let Some(label) = label.filter(|label| !label.is_empty()) {
        activity["label"] = json!(label);
    }
    state.activity = Some(activity);
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Linux process start time as Unix epoch milliseconds. PID alone is reusable;
/// combining it with this value fences a later process that inherited the PID.
pub fn process_start_time(pid: i32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let close = stat.rfind(')')?;
        let start_ticks = stat[close + 1..]
            .split_whitespace()
            .nth(19)?
            .parse::<u64>()
            .ok()?;
        let boot_seconds = std::fs::read_to_string("/proc/stat")
            .ok()?
            .lines()
            .find_map(|line| line.strip_prefix("btime "))?
            .parse::<u64>()
            .ok()?;
        let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if ticks_per_second <= 0 {
            return None;
        }
        Some(
            boot_seconds
                .saturating_mul(1000)
                .saturating_add(start_ticks.saturating_mul(1000) / ticks_per_second as u64),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: u64, pid: i32) -> SourceIdentity {
        SourceIdentity {
            kind: SourceKind::Bridge,
            source_id: id,
            binding_epoch: 1,
            pid: Some(pid),
            process_start: Some(100 + pid as u64),
            peer_id: None,
            room_id: None,
            can_write: Some(true),
        }
    }

    /// The phone hides Queue / Stop and send from these flags, so each owner
    /// must report exactly what its prompt path can express: the bridge has
    /// `deliverAs` but no abort-and-prompt, the collab host always steers.
    #[test]
    fn send_mode_capabilities_follow_what_each_owner_can_express() {
        let with_kind = |kind| SourceIdentity {
            kind,
            ..source(1, 41)
        };
        let child = SessionStateRegistry::capabilities_for(&with_kind(SourceKind::Child));
        assert!(child.queue && child.interrupt);
        let bridge = SessionStateRegistry::capabilities_for(&with_kind(SourceKind::Bridge));
        assert!(bridge.queue && !bridge.interrupt);
        let collab = SessionStateRegistry::capabilities_for(&with_kind(SourceKind::Collab));
        assert!(collab.send && !collab.queue && !collab.interrupt);
        let unowned = Capabilities::default();
        assert!(!unowned.queue && !unowned.interrupt);
        let wire = serde_json::to_value(&child).unwrap();
        assert_eq!(wire["queue"], json!(true));
        assert_eq!(wire["interrupt"], json!(true));
    }

    #[test]
    fn retired_owner_releases_to_unowned_history_without_reviving_old_events() {
        let registry = SessionStateRegistry::default();
        let identity = source(1, 41);
        let stamp = SourceStamp {
            identity: identity.clone(),
            sequence: 1,
        };
        assert!(registry.observe_event("s", &stamp, &json!({"type":"agent_end"})));
        let unowned = || Seed {
            owner: Owner {
                kind: "none".to_owned(),
                pid: None,
                process_start: None,
                peer_id: None,
                room_id: None,
                can_write: None,
            },
            turn: Turn::Idle,
            confidence: Confidence::Inferred,
            connection: Connection::Connected,
            activity: None,
            capabilities: Capabilities::default(),
            source: None,
            sequence: 0,
        };
        // An inferred scan cannot displace a live source.
        assert_eq!(registry.project("s", unowned()).owner.kind, "bridge");
        registry.retire_source("s", &identity);
        let retired = registry.current("s").unwrap();
        let mut still_owned = unowned();
        still_owned.owner = retired.owner.clone();
        assert_eq!(
            registry.project("s", still_owned).connection,
            Connection::Reconnecting
        );
        let mut unknown = unowned();
        unknown.turn = Turn::Unknown;
        assert_eq!(
            registry.project("s", unknown).connection,
            Connection::Reconnecting
        );
        let mut unavailable = unowned();
        unavailable.connection = Connection::Unavailable;
        assert_eq!(
            registry.project("s", unavailable).connection,
            Connection::Reconnecting
        );
        let recovered = registry.project("s", unowned());
        assert_eq!(recovered.owner.kind, "none");
        assert_eq!(recovered.connection, Connection::Connected);
        assert_eq!(recovered.turn, Turn::Idle);
        assert!(recovered.revision > retired.revision);
        assert!(!recovered.capabilities.control);
        assert!(!registry.observe_event(
            "s",
            &SourceStamp {
                identity,
                sequence: 2
            },
            &json!({"type":"agent_start"})
        ));
        assert_eq!(registry.current("s").unwrap().turn, Turn::Idle);
        let replacement = source(2, 42);
        assert!(registry.observe_event(
            "s",
            &SourceStamp {
                identity: replacement,
                sequence: 1
            },
            &json!({"type":"agent_start"})
        ));
        assert_eq!(registry.current("s").unwrap().turn, Turn::Running);
    }

    #[test]
    fn run_status_events_pass_the_relay_gate_without_touching_the_turn() {
        // `observe_event` is the only gate between child/bridge/collab adapters
        // and the phone socket (main.rs handle_child_event). The phone's retry
        // countdown, compaction line and header model depend on these frames.
        let registry = SessionStateRegistry::default();
        let mut stamp = SourceStamp {
            identity: source(1, 41),
            sequence: 1,
        };
        assert!(registry.observe_event("s", &stamp, &json!({"type":"agent_start"})));
        let before = registry.current("s").unwrap();
        for event in [
            json!({"type":"auto_retry_start","attempt":2,"maxAttempts":5,"delayMs":8000,"errorMessage":"529 overloaded"}),
            json!({"type":"auto_retry_end","success":true,"attempt":2}),
            json!({"type":"auto_compaction_start","reason":"threshold","action":"context-full"}),
            json!({"type":"auto_compaction_end","action":"context-full","aborted":false,"willRetry":false}),
            json!({"type":"model_changed"}),
            json!({"type":"thinking_level_changed","thinkingLevel":"high"}),
        ] {
            stamp.sequence += 1;
            assert!(
                registry.observe_event("s", &stamp, &event),
                "{event} must be relayed"
            );
        }
        let after = registry.current("s").unwrap();
        assert_eq!(after.turn, Turn::Running);
        assert_eq!(
            after.activity.unwrap()["kind"],
            before.activity.unwrap()["kind"]
        );
    }

    #[test]
    fn tool_progress_and_pending_question_survive_snapshot_reads() {
        let registry = SessionStateRegistry::default();
        let identity = source(1, 41);
        let mut stamp = SourceStamp {
            identity: identity.clone(),
            sequence: 1,
        };
        assert!(registry.observe_event("s", &stamp, &json!({"type":"agent_start"})));
        let started = registry.current("s").unwrap().activity.unwrap()["turnStartedAt"].clone();
        stamp.sequence += 1;
        assert!(registry.observe_event("s", &stamp, &json!({"type":"tool_execution_start", "toolName":"bash", "args":{"command":"cargo check"}})));
        stamp.sequence += 1;
        assert!(registry.observe_event("s", &stamp, &json!({"type":"tool_execution_end"})));
        stamp.sequence += 1;
        assert!(registry.observe_event(
            "s",
            &stamp,
            &json!({"type":"extension_ui_request", "method":"input", "id":"question"})
        ));
        let current = registry.current("s").unwrap();
        let projected = registry.project(
            "s",
            Seed {
                owner: identity.wire_owner(),
                turn: Turn::Running,
                confidence: Confidence::Confirmed,
                connection: Connection::Connected,
                activity: current.activity.clone(),
                capabilities: current.capabilities,
                source: Some(identity),
                sequence: stamp.sequence,
            },
        );
        assert_eq!(projected.pending_input.unwrap()["id"], "question");
        let activity = projected.activity.unwrap();
        assert_eq!(activity["turnStartedAt"], started);
        assert_eq!(activity["tools"], 1);
        stamp.sequence += 1;
        assert!(registry.observe_event(
            "s",
            &stamp,
            &json!({"type":"agent_end", "isTerminal":true})
        ));
        let settled = registry.current("s").unwrap();
        assert_eq!(settled.turn, Turn::Idle);
        assert!(settled.pending_input.is_none());
        assert!(settled.activity.is_none());
    }

    #[test]
    fn snapshot_does_not_consume_the_matching_terminal_event() {
        let registry = SessionStateRegistry::default();
        let identity = source(1, 41);
        registry.project(
            "s",
            Seed {
                owner: identity.wire_owner(),
                turn: Turn::Idle,
                confidence: Confidence::Confirmed,
                connection: Connection::Connected,
                activity: None,
                capabilities: SessionStateRegistry::capabilities_for(&identity),
                source: Some(identity.clone()),
                sequence: 4,
            },
        );
        let stamp = SourceStamp {
            identity,
            sequence: 4,
        };
        assert!(registry.observe_event("s", &stamp, &json!({"type":"agent_end"})));
        assert!(!registry.observe_event("s", &stamp, &json!({"type":"agent_end"})));
    }

    /// A job outliving the turn shows from the turn's unsettled outcome until
    /// omp says the session settled, survives a new turn it wakes, and is
    /// dropped with the process that held it. The wire field appears only
    /// while true.
    #[test]
    fn background_work_tracks_prompt_result_until_session_settled() {
        let registry = SessionStateRegistry::default();
        let identity = source(1, 41);
        let mut sequence = 0;
        let mut observe = |event: Value| {
            sequence += 1;
            assert!(registry.observe_event(
                "s",
                &SourceStamp {
                    identity: identity.clone(),
                    sequence
                },
                &event
            ));
            registry.current("s").unwrap()
        };
        let running = observe(json!({"type":"agent_start"}));
        assert_eq!(running.turn, Turn::Running);
        assert!(!running.background_work);
        assert!(
            serde_json::to_value(&running)
                .unwrap()
                .get("backgroundWork")
                .is_none()
        );
        // A printing slash command resolving beside the run changes nothing.
        let printed = observe(
            json!({"type":"prompt_result","id":"pulse-command:r9","agentInvoked":false,"status":"completed","sessionSettled":false}),
        );
        assert_eq!(printed.turn, Turn::Running);
        assert!(!printed.background_work);
        // The prompt resolves with a job still running: the run is over.
        let pending =
            observe(json!({"type":"prompt_result","status":"completed","sessionSettled":false}));
        assert_eq!(pending.turn, Turn::Idle);
        assert!(pending.activity.is_none());
        assert!(pending.background_work);
        assert!(pending.revision > running.revision);
        assert_eq!(
            serde_json::to_value(&pending).unwrap()["backgroundWork"],
            true
        );
        // The job wakes the agent: a turn runs, the job is still pending.
        let woke = observe(json!({"type":"agent_start"}));
        assert_eq!(woke.turn, Turn::Running);
        assert!(woke.background_work);
        let settled = observe(json!({"type":"session_settled"}));
        assert!(!settled.background_work);
        assert_eq!(settled.turn, Turn::Idle);
        // A settled outcome never marks work.
        let clean =
            observe(json!({"type":"prompt_result","status":"completed","sessionSettled":true}));
        assert!(!clean.background_work);
        // The process holding the job goes away: so does the job.
        observe(json!({"type":"prompt_result","status":"completed","sessionSettled":false}));
        registry.retire_source("s", &identity);
        assert!(!registry.current("s").unwrap().background_work);
    }

    #[test]
    fn loss_without_terminal_flag_preserves_running() {
        let registry = SessionStateRegistry::default();
        let identity = source(1, 41);
        assert!(registry.observe_event(
            "s",
            &SourceStamp {
                identity: identity.clone(),
                sequence: 1
            },
            &json!({"type":"agent_start"})
        ));
        assert!(registry.observe_event(
            "s",
            &SourceStamp {
                identity,
                sequence: 2
            },
            &json!({"type":"agent_end","bridgeLost":true})
        ));
        let state = registry.current("s").unwrap();
        assert_eq!(state.turn, Turn::Running);
        assert_eq!(state.connection, Connection::Reconnecting);
    }

    #[test]
    fn retired_and_out_of_order_source_events_cannot_restore_running() {
        let registry = SessionStateRegistry::default();
        let path = "/tmp/session.jsonl";
        let first = source(1, 41);
        assert!(registry.observe_event(
            path,
            &SourceStamp {
                identity: first.clone(),
                sequence: 2
            },
            &json!({"type":"agent_end"})
        ));
        let idle = registry.current(path).unwrap();
        assert_eq!(idle.turn, Turn::Idle);
        assert!(!registry.observe_event(
            path,
            &SourceStamp {
                identity: first.clone(),
                sequence: 1
            },
            &json!({"type":"agent_start"})
        ));
        assert_eq!(registry.current(path).unwrap().turn, Turn::Idle);

        registry.retire_source(path, &first);
        let second = source(2, 42);
        assert!(registry.observe_event(
            path,
            &SourceStamp {
                identity: second.clone(),
                sequence: 1
            },
            &json!({"type":"agent_start"})
        ));
        let current = registry.current(path).unwrap();
        assert_eq!(current.turn, Turn::Running);
        assert!(current.binding_epoch > idle.binding_epoch);
        assert!(!registry.observe_event(
            path,
            &SourceStamp {
                identity: first,
                sequence: 3
            },
            &json!({"type":"agent_end"})
        ));
        assert_eq!(registry.current(path).unwrap().turn, Turn::Running);
    }

    #[test]
    fn nonterminal_agent_end_and_transport_loss_do_not_complete_turn() {
        let registry = SessionStateRegistry::default();
        let path = "/tmp/session.jsonl";
        let source = source(1, 41);
        let stamp = |sequence| SourceStamp {
            identity: source.clone(),
            sequence,
        };
        assert!(registry.observe_event(path, &stamp(1), &json!({"type":"agent_start"})));
        assert!(registry.observe_event(
            path,
            &stamp(2),
            &json!({"type":"agent_end","isTerminal":false})
        ));
        assert_eq!(registry.current(path).unwrap().turn, Turn::Running);
        registry.retire_source(path, &source);
        let state = registry.current(path).unwrap();
        assert_eq!(state.turn, Turn::Running);
        assert_eq!(state.connection, Connection::Reconnecting);
        assert!(state.activity.as_ref().unwrap()["stale"].as_bool().unwrap());
    }

    #[test]
    fn conflicting_live_processes_become_ambiguous() {
        let registry = SessionStateRegistry::default();
        let path = "/tmp/session.jsonl";
        let first = source(1, 41);
        let second = source(2, 42);
        assert!(registry.observe_event(
            path,
            &SourceStamp {
                identity: first,
                sequence: 1
            },
            &json!({"type":"agent_start"})
        ));
        assert!(!registry.observe_event(
            path,
            &SourceStamp {
                identity: second,
                sequence: 1
            },
            &json!({"type":"agent_start"})
        ));
        let state = registry.current(path).unwrap();
        assert_eq!(state.owner.kind, "ambiguous");
        assert_eq!(state.turn, Turn::Unknown);
    }

    fn child_source(id: u64, pid: i32) -> SourceIdentity {
        SourceIdentity {
            kind: SourceKind::Child,
            ..source(id, pid)
        }
    }

    #[test]
    fn planned_stop_leaves_an_unowned_idle_connected_session() {
        let registry = SessionStateRegistry::default();
        let path = "/tmp/session.jsonl";
        let child = child_source(1, 41);
        let stamp = |sequence| SourceStamp {
            identity: child.clone(),
            sequence,
        };
        assert!(registry.observe_event(path, &stamp(1), &json!({"type":"agent_start"})));
        assert!(registry.observe_event(path, &stamp(2), &json!({"type":"agent_end"})));
        let before = registry.current(path).unwrap();
        // Another source's stop changes nothing.
        assert!(!registry.release_source(path, &child_source(9, 49)));
        assert!(registry.release_source(path, &child));
        let released = registry.current(path).unwrap();
        assert_eq!(released.owner.kind, "none");
        assert_eq!(released.turn, Turn::Idle);
        assert_eq!(released.connection, Connection::Connected);
        assert!(released.activity.is_none());
        assert!(!released.capabilities.stop);
        // The phone accepts it: newer revision, binding epoch moved forward.
        assert!(released.revision > before.revision);
        assert!(released.binding_epoch > before.binding_epoch);
        // The stopped child's late frames stay fenced.
        assert!(!registry.observe_event(path, &stamp(3), &json!({"type":"agent_start"})));
        assert_eq!(registry.current(path).unwrap().turn, Turn::Idle);
        // A new child for the session binds normally.
        assert!(registry.observe_event(
            path,
            &SourceStamp {
                identity: child_source(2, 42),
                sequence: 1
            },
            &json!({"type":"agent_start"})
        ));
        let rebound = registry.current(path).unwrap();
        assert_eq!(rebound.owner.kind, "child");
        assert_eq!(rebound.turn, Turn::Running);
    }

    #[test]
    fn stop_settles_a_turn_whose_child_died_but_never_a_live_or_desktop_one() {
        let registry = SessionStateRegistry::default();
        let path = "/tmp/session.jsonl";
        let child = child_source(1, 41);
        assert!(registry.observe_event(
            path,
            &SourceStamp {
                identity: child.clone(),
                sequence: 1
            },
            &json!({"type":"agent_start"})
        ));
        // Still live: Stop must reach the child, not rewrite the record.
        assert!(!registry.release_retired_child(path));
        registry.retire_source(path, &child);
        let stuck = registry.current(path).unwrap();
        assert_eq!(stuck.turn, Turn::Running);
        assert_eq!(stuck.connection, Connection::Reconnecting);
        assert!(registry.release_retired_child(path));
        let settled = registry.current(path).unwrap();
        assert_eq!(settled.turn, Turn::Idle);
        assert_eq!(settled.connection, Connection::Connected);
        assert_eq!(settled.owner.kind, "none");
        assert!(settled.revision > stuck.revision);
        // Already idle: nothing to do.
        assert!(!registry.release_retired_child(path));

        // A retired desktop bridge is not ours to settle.
        let desktop = source(3, 43);
        let other = "/tmp/desktop.jsonl";
        assert!(registry.observe_event(
            other,
            &SourceStamp {
                identity: desktop.clone(),
                sequence: 1
            },
            &json!({"type":"agent_start"})
        ));
        registry.retire_source(other, &desktop);
        assert!(!registry.release_retired_child(other));
        assert_eq!(registry.current(other).unwrap().turn, Turn::Running);
    }
}
