//! Bounded, cancellable transcript reads on a verified live collab connection.
//! This is independent of event/write ownership: a desktop extension bridge can
//! own writes while the view-only collab connection serves its agent transcripts.
//! No session files, child processes, transcript cache, or reconnect replay.

use super::OutboundFrame;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};

pub const MAX_SAFE_CURSOR: u64 = 9_007_199_254_740_991;
const MAX_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PENDING: usize = 32;
static CONNECTION_PREFIX: LazyLock<String> =
    LazyLock::new(|| format!("{:032x}", rand::random::<u128>()));
const MAX_PENDING_PER_SESSION: usize = 4;
const TIMEOUT: Duration = Duration::from_secs(20);
// Upstream reqId is a JavaScript number. All Pulse connections share this
// monotonic safe-integer space; a fresh daemon starts at a random high offset.
// UI request IDs are host-owned and live in a different message-type domain.
static NEXT_REQUEST: LazyLock<AtomicU64> =
    LazyLock::new(|| AtomicU64::new((1 << 51) + (rand::random::<u64>() & ((1 << 51) - 1))));

fn next_request_id() -> Result<u64, Error> {
    let mut current = NEXT_REQUEST.load(Ordering::Relaxed);
    loop {
        if current >= MAX_SAFE_CURSOR {
            return Err(Error::Busy);
        }
        match NEXT_REQUEST.compare_exchange_weak(
            current,
            current + 1,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return Ok(current),
            Err(observed) => current = observed,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidRequest,
    HostUnavailable,
    Unavailable,
    Timeout,
    InvalidResponse,
    Host,
    Busy,
    AgentChanged,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::HostUnavailable => "host_unavailable",
            Self::Unavailable => "transcript_unavailable",
            Self::Timeout => "transcript_timeout",
            Self::InvalidResponse => "invalid_host_response",
            Self::Host => "host_error",
            Self::Busy => "too_many_requests",
            Self::AgentChanged => "agent_changed",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid agent ID or byte cursor",
            Self::HostUnavailable => "a verified live desktop transcript connection is unavailable",
            Self::Unavailable => "no transcript available for this agent",
            Self::Timeout => "the desktop did not return the agent transcript in time",
            Self::InvalidResponse => "the desktop returned an invalid transcript chunk",
            Self::Host => "the desktop could not read this agent transcript",
            Self::Busy => "too many transcript reads are pending; try again after they finish",
            Self::AgentChanged => "this agent changed; reopen it from the current agent list",
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub ok: bool,
    pub agent_id: String,
    pub connection_id: String,
    pub from_byte: u64,
    pub next_byte: u64,
    pub text: String,
    pub reset: bool,
}

pub fn valid_request(agent: &str, cursor: u64) -> bool {
    !agent.trim().is_empty()
        && agent.len() <= 256
        && !agent.chars().any(char::is_control)
        && cursor <= MAX_SAFE_CURSOR
}

struct Active {
    source: u64,
    connection_id: String,
    parent_id: String,
    root_agent: Option<String>,
    room_closed: watch::Receiver<bool>,
    agents: HashMap<String, f64>,
    rows: Vec<Value>,
    roster_known: bool,
    running_count: Option<usize>,
    sender: mpsc::UnboundedSender<OutboundFrame>,
    queued: HashSet<u64>,
}

struct Pending {
    session: String,
    connection_id: String,
    source: u64,
    agent: String,
    cursor: u64,
    created_at: f64,
    dispatched: bool,
    result: oneshot::Sender<Result<Chunk, Error>>,
}

#[derive(Default)]
struct State {
    active: HashMap<String, Active>,
    pending: HashMap<u64, Pending>,
}

#[derive(Default)]
pub(super) struct Reads(Mutex<State>);

/// Dropped with the exact socket lifetime, including task abort and reconnect.
/// Retiring an old connection cannot remove the replacement's pending reads.
pub(super) struct ReadConnection {
    reads: Arc<Reads>,
    session: String,
    source: u64,
    room_monitor: tokio::task::JoinHandle<()>,
}

/// HTTP future cancellation drops this guard synchronously. Queued requests
/// cannot outlive the waiter or execute on a replacement connection.
struct Request {
    reads: Arc<Reads>,
    id: u64,
    receiver: oneshot::Receiver<Result<Chunk, Error>>,
}

impl Reads {
    pub(super) fn connect(
        self: &Arc<Self>,
        session: &str,
        source: u64,
        parent_id: &str,
        mut room_closed: watch::Receiver<bool>,
        agents: &Value,
        sender: mpsc::UnboundedSender<OutboundFrame>,
    ) -> ReadConnection {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        retire(&mut state, session, None);
        state.active.insert(
            session.to_owned(),
            Active {
                source,
                connection_id: format!("{}:{}", *CONNECTION_PREFIX, source),
                parent_id: parent_id.to_owned(),
                root_agent: root_agent(agents),
                room_closed: room_closed.clone(),
                agents: roster(agents),
                rows: roster_rows(agents),
                roster_known: agents.as_array().is_some_and(|rows| rows.len() <= 4096),
                running_count: running_count(agents),
                sender,
                queued: HashSet::new(),
            },
        );
        drop(state);
        let reads = Arc::downgrade(self);
        let session_owned = session.to_owned();
        let room_monitor = tokio::spawn(async move {
            if !*room_closed.borrow() {
                let _ = room_closed.changed().await;
            }
            if let Some(reads) = reads.upgrade() {
                retire(
                    &mut reads.0.lock().unwrap_or_else(|p| p.into_inner()),
                    &session_owned,
                    Some(source),
                );
            }
        });
        ReadConnection {
            reads: self.clone(),
            session: session.to_owned(),
            source,
            room_monitor,
        }
    }

    pub(super) fn snapshot(&self, session: &str, parent_id: &str) -> Result<Value, Error> {
        let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let active = state
            .active
            .get(session)
            .filter(|active| active.parent_id == parent_id && room_live(active))
            .ok_or(Error::HostUnavailable)?;
        if !active.roster_known {
            return Err(Error::InvalidResponse);
        }
        Ok(
            json!({"ok":true, "agents":active.rows, "connectionId":active.connection_id, "runningCount":active.running_count}),
        )
    }

    pub(super) fn follow_up(
        &self,
        session: &str,
        parent_id: &str,
        agent: &str,
        created_at: f64,
        connection_id: &str,
        text: Option<&str>,
    ) -> Result<Option<oneshot::Receiver<bool>>, Error> {
        let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let active = state.active.get(session).ok_or(Error::HostUnavailable)?;
        if active.parent_id != parent_id
            || active.connection_id != connection_id
            || !room_live(active)
        {
            return Err(Error::HostUnavailable);
        }
        if !follow_up_eligible(active, agent, created_at) {
            return Err(Error::AgentChanged);
        }
        let Some(text) = text else { return Ok(None) };
        let (forwarded, received) = oneshot::channel();
        // This is a daemon-local envelope, stripped before native serialization.
        // Its exact source and roster identity are checked again at socket drain.
        let payload = json!({
            "t":"pulse-agent-follow-up", "agentId":agent, "text":text,
            "connectionId":connection_id, "createdAt":created_at, "parentId":parent_id
        });
        active
            .sender
            .send(OutboundFrame {
                payload,
                forwarded: Some(forwarded),
            })
            .map_err(|_| Error::HostUnavailable)?;
        Ok(Some(received))
    }

    pub(super) fn disconnect(&self, session: &str) {
        retire(
            &mut self.0.lock().unwrap_or_else(|p| p.into_inner()),
            session,
            None,
        );
    }

    #[cfg(test)]
    fn start(
        self: &Arc<Self>,
        session: &str,
        parent_id: &str,
        agent: &str,
        cursor: u64,
        expected_created_at: Option<f64>,
    ) -> Result<Request, Error> {
        self.start_bound(session, parent_id, agent, cursor, expected_created_at, None)
    }

    fn start_bound(
        self: &Arc<Self>,
        session: &str,
        parent_id: &str,
        agent: &str,
        cursor: u64,
        expected_created_at: Option<f64>,
        expected_connection_id: Option<&str>,
    ) -> Result<Request, Error> {
        if !valid_request(agent, cursor)
            || expected_created_at.is_some_and(|at| !valid_created_at(at))
            || expected_connection_id.is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err(Error::InvalidRequest);
        }
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let active = state
            .active
            .get(session)
            .filter(|a| a.parent_id == parent_id)
            .ok_or(Error::HostUnavailable)?;
        if expected_connection_id.is_some_and(|expected| expected != active.connection_id) {
            return Err(Error::HostUnavailable);
        }
        if !room_live(active) {
            return Err(Error::HostUnavailable);
        }
        if !active.roster_known {
            return Err(Error::InvalidResponse);
        }
        if let Some(row) = active
            .rows
            .iter()
            .find(|row| row["id"].as_str() == Some(agent))
        {
            if expected_created_at
                .is_some_and(|expected| row["createdAt"].as_f64() != Some(expected))
            {
                return Err(Error::AgentChanged);
            }
            if row["hasSessionFile"].as_bool() != Some(true) {
                return Err(Error::Unavailable);
            }
        }
        let created_at =
            active
                .agents
                .get(agent)
                .copied()
                .ok_or(if expected_created_at.is_some() {
                    Error::AgentChanged
                } else {
                    Error::Unavailable
                })?;
        if expected_created_at.is_some_and(|expected| expected != created_at) {
            return Err(Error::AgentChanged);
        }
        let source = active.source;
        let connection_id = active.connection_id.clone();
        let sender = active.sender.clone();
        if state.pending.len() >= MAX_PENDING
            || state.active.values().map(|a| a.queued.len()).sum::<usize>() >= MAX_PENDING
            || active.queued.len() >= MAX_PENDING_PER_SESSION
            || state
                .pending
                .values()
                .filter(|p| p.session == session)
                .count()
                >= MAX_PENDING_PER_SESSION
        {
            return Err(Error::Busy);
        }
        let id = next_request_id()?;
        let (result, receiver) = oneshot::channel();
        if let Some(active) = state.active.get_mut(session) {
            active.queued.insert(id);
        }
        state.pending.insert(
            id,
            Pending {
                session: session.to_owned(),
                connection_id,
                source,
                agent: agent.to_owned(),
                cursor,
                created_at,
                dispatched: false,
                result,
            },
        );
        let payload =
            json!({"t":"fetch-transcript", "reqId":id, "agentId":agent, "fromByte":cursor});
        if sender.send(payload.into()).is_err() {
            retire(&mut state, session, Some(source));
            return Err(Error::HostUnavailable);
        }
        Ok(Request {
            reads: self.clone(),
            id,
            receiver,
        })
    }

    pub(super) async fn fetch(
        self: &Arc<Self>,
        session: &str,
        parent_id: &str,
        agent: &str,
        cursor: u64,
        expected_created_at: Option<f64>,
        expected_connection_id: Option<&str>,
    ) -> Result<Chunk, Error> {
        self.start_bound(
            session,
            parent_id,
            agent,
            cursor,
            expected_created_at,
            expected_connection_id,
        )?
        .wait(TIMEOUT)
        .await
    }
}

pub fn valid_created_at(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_SAFE_CURSOR as f64).contains(&value)
}

fn root_agent(agents: &Value) -> Option<String> {
    let rows = agents.as_array()?;
    let mut roots = rows.iter().filter(|row| row["kind"] == "main");
    let root = roots.next()?.get("id")?.as_str()?;
    (roots.next().is_none()
        && valid_request(root, 0)
        && rows
            .iter()
            .filter(|row| row["id"].as_str() == Some(root))
            .count()
            == 1)
        .then(|| root.to_owned())
}

fn follow_up_eligible(active: &Active, id: &str, created_at: f64) -> bool {
    if !active.roster_known || !valid_created_at(created_at) {
        return false;
    }
    let Some(row) = active
        .rows
        .iter()
        .find(|row| row["id"].as_str() == Some(id))
    else {
        return false;
    };
    if row["createdAt"].as_f64() != Some(created_at)
        || row["hasSessionFile"] != true
        || !matches!(row["status"].as_str(), Some("running" | "idle" | "parked"))
    {
        return false;
    }
    let Some(root) = active.root_agent.as_deref() else {
        return false;
    };
    let mut parent = row["parentId"].as_str();
    for _ in 0..active.rows.len() {
        match parent {
            Some(id) if id == root => return true,
            Some(id) => {
                parent = active
                    .rows
                    .iter()
                    .find(|row| row["id"].as_str() == Some(id))
                    .and_then(|row| row["parentId"].as_str())
            }
            None => return false,
        }
    }
    false
}

fn room_live(active: &Active) -> bool {
    !*active.room_closed.borrow() && active.room_closed.has_changed().is_ok()
}

// Count the complete source roster, never the filtered display rows. An
// unknown status or ambiguous identity cannot establish an exact zero.
fn running_count(value: &Value) -> Option<usize> {
    let rows = value.as_array().filter(|rows| rows.len() <= 4096)?;
    let mut seen = HashSet::new();
    let mut count = 0;
    let mut subagents = 0;
    for row in rows {
        let id = row.get("id")?.as_str().filter(|id| valid_request(id, 0))?;
        if !seen.insert(id) {
            return None;
        }
        match row.get("kind")?.as_str()? {
            "main" | "advisor" => continue,
            "sub" => subagents += 1,
            _ => return None,
        }
        match row.get("status")?.as_str()? {
            "running" => count += 1,
            "idle" | "parked" | "aborted" => {}
            _ => return None,
        }
    }
    (roster_rows(value).len() == subagents).then_some(count)
}

fn roster_rows(value: &Value) -> Vec<Value> {
    let Some(rows) = value.as_array().filter(|rows| rows.len() <= 4096) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();
    let mut valid = Vec::new();
    for row in rows {
        let Some(id) = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_request(id, 0))
        else {
            continue;
        };
        if !seen.insert(id) {
            duplicates.insert(id);
            continue;
        }
        if row.get("kind").and_then(Value::as_str) != Some("sub") {
            continue;
        }
        let Some(has_file) = row.get("hasSessionFile").and_then(Value::as_bool) else {
            continue;
        };
        let Some(created) = row
            .get("createdAt")
            .and_then(Value::as_f64)
            .filter(|at| valid_created_at(*at))
        else {
            continue;
        };
        let Some(last) = row
            .get("lastActivity")
            .and_then(Value::as_f64)
            .filter(|at| valid_created_at(*at))
        else {
            continue;
        };
        let Some(name) = row
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|name| name.len() <= 4096)
        else {
            continue;
        };
        let Some(status) = row
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| matches!(*status, "running" | "idle" | "parked" | "aborted"))
        else {
            continue;
        };
        let mut snapshot = json!({"id":id, "displayName":name, "kind":"sub", "status":status,
            "hasSessionFile":has_file, "createdAt":created, "lastActivity":last});
        if let Some(parent) = row.get("parentId") {
            let Some(parent) = parent.as_str().filter(|id| valid_request(id, 0)) else {
                continue;
            };
            snapshot["parentId"] = json!(parent);
        }
        valid.push(snapshot);
    }
    valid.retain(|row| !duplicates.contains(row["id"].as_str().unwrap_or_default()));
    valid
}

fn roster(value: &Value) -> HashMap<String, f64> {
    roster_rows(value)
        .into_iter()
        .filter(|row| row.get("hasSessionFile").and_then(Value::as_bool) == Some(true))
        .filter_map(|row| {
            Some((
                row.get("id")?.as_str()?.to_owned(),
                row.get("createdAt")?.as_f64()?,
            ))
        })
        .collect()
}

fn retire(state: &mut State, session: &str, source: Option<u64>) {
    if state
        .active
        .get(session)
        .is_some_and(|a| source.is_none_or(|s| s == a.source))
    {
        state.active.remove(session);
    }
    let retired: Vec<u64> = state
        .pending
        .iter()
        .filter(|(_, p)| p.session == session && source.is_none_or(|s| s == p.source))
        .map(|(id, _)| *id)
        .collect();
    for id in retired {
        if let Some(pending) = state.pending.remove(&id) {
            let _ = pending.result.send(Err(Error::HostUnavailable));
        }
    }
}

impl ReadConnection {
    pub(super) fn is_current(&self) -> bool {
        self.reads
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .active
            .get(&self.session)
            .is_some_and(|active| active.source == self.source && room_live(active))
    }

    pub(super) fn can_send(&self, frame: &Value) -> bool {
        if frame["t"] == "pulse-agent-follow-up" {
            let state = self.reads.0.lock().unwrap_or_else(|p| p.into_inner());
            return state.active.get(&self.session).is_some_and(|active| {
                active.source == self.source
                    && room_live(active)
                    && frame["connectionId"].as_str() == Some(active.connection_id.as_str())
                    && frame["parentId"].as_str() == Some(active.parent_id.as_str())
                    && frame["agentId"]
                        .as_str()
                        .zip(frame["createdAt"].as_f64())
                        .is_some_and(|(id, at)| follow_up_eligible(active, id, at))
            });
        }
        let Some(id) = frame.get("reqId").and_then(Value::as_u64) else {
            return false;
        };
        let mut state = self.reads.0.lock().unwrap_or_else(|p| p.into_inner());
        if !state
            .active
            .get_mut(&self.session)
            .is_some_and(|a| a.source == self.source && room_live(a) && a.queued.remove(&id))
        {
            return false;
        }
        let Some(pending) = state.pending.get_mut(&id) else {
            return false;
        };
        let valid = pending.session == self.session
            && pending.source == self.source
            && !pending.result.is_closed()
            && frame.get("agentId").and_then(Value::as_str) == Some(pending.agent.as_str())
            && frame.get("fromByte").and_then(Value::as_u64) == Some(pending.cursor);
        if valid {
            pending.dispatched = true;
        }
        valid
    }

    pub(super) fn update_agents(&self, agents: &Value) {
        let mut state = self.reads.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(active) = state
            .active
            .get_mut(&self.session)
            .filter(|a| a.source == self.source && room_live(a))
        else {
            return;
        };
        active.roster_known = agents.as_array().is_some_and(|rows| rows.len() <= 4096);
        active.root_agent = root_agent(agents);
        active.rows = roster_rows(agents);
        active.running_count = running_count(agents);
        let agents = roster(agents);
        active.agents = agents.clone();
        let stale: Vec<u64> = state
            .pending
            .iter()
            .filter(|(_, p)| {
                p.session == self.session
                    && p.source == self.source
                    && agents.get(&p.agent) != Some(&p.created_at)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            if let Some(pending) = state.pending.remove(&id) {
                let _ = pending.result.send(Err(Error::AgentChanged));
            }
        }
    }

    pub(super) fn receive(&self, peer: u32, frame: &Value) {
        if peer != super::HOST_PEER_ID
            || frame.get("t").and_then(Value::as_str) != Some("transcript")
        {
            return;
        }
        let Some(id) = frame.get("reqId").and_then(Value::as_u64) else {
            return;
        };
        let mut state = self.reads.0.lock().unwrap_or_else(|p| p.into_inner());
        if !state
            .active
            .get(&self.session)
            .is_some_and(|a| a.source == self.source && room_live(a) && !a.queued.contains(&id))
            || !state.pending.get(&id).is_some_and(|p| {
                p.session == self.session && p.source == self.source && p.dispatched
            })
        {
            return;
        }
        if let Some(pending) = state.pending.remove(&id) {
            let result = parse_response(&pending, frame);
            let _ = pending.result.send(result);
        }
    }
}

impl Drop for ReadConnection {
    fn drop(&mut self) {
        self.room_monitor.abort();
        retire(
            &mut self.reads.0.lock().unwrap_or_else(|p| p.into_inner()),
            &self.session,
            Some(self.source),
        );
    }
}

impl Request {
    async fn wait(mut self, timeout: Duration) -> Result<Chunk, Error> {
        match tokio::time::timeout(timeout, &mut self.receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Error::HostUnavailable),
            Err(_) => Err(Error::Timeout),
        }
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        self.reads
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pending
            .remove(&self.id);
    }
}

fn parse_response(pending: &Pending, frame: &Value) -> Result<Chunk, Error> {
    let text = frame
        .get("text")
        .and_then(Value::as_str)
        .ok_or(Error::InvalidResponse)?;
    let next = frame
        .get("newSize")
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_SAFE_CURSOR)
        .ok_or(Error::InvalidResponse)?;
    if let Some(error) = frame.get("error") {
        let error = error.as_str().ok_or(Error::InvalidResponse)?;
        if !text.is_empty() || next != pending.cursor {
            return Err(Error::InvalidResponse);
        }
        return Err(if error == "no transcript available" {
            Error::Unavailable
        } else {
            Error::Host
        });
    }
    // The host decodes bytes with replacement at EOF. In particular, a
    // 3-byte prefix of a 4-byte scalar becomes U+FFFD (also 3 bytes), so
    // string/byte-length equality alone cannot prove an EOF suffix lossless.
    // Commit only newline-terminated records and reread the unfinished suffix
    // from its original cursor once more bytes exist. Never publish that suffix.
    if next < pending.cursor {
        if !text.is_empty() {
            return Err(Error::InvalidResponse);
        }
        return Ok(Chunk {
            ok: true,
            agent_id: pending.agent.clone(),
            connection_id: pending.connection_id.clone(),
            from_byte: pending.cursor,
            next_byte: next,
            text: String::new(),
            reset: true,
        });
    }
    let bytes = next - pending.cursor;
    let text_bytes = text.len() as u64;
    let torn_utf8 = text.ends_with('\u{fffd}') && text_bytes > bytes && text_bytes - bytes <= 2;
    if bytes > MAX_CHUNK_BYTES
        || text.is_empty() != (bytes == 0)
        || (text_bytes != bytes && !torn_utf8)
    {
        return Err(Error::InvalidResponse);
    }
    let complete = text.rfind('\n').map_or(0, |newline| newline + 1);
    if complete as u64 > bytes {
        return Err(Error::InvalidResponse);
    }
    Ok(Chunk {
        ok: true,
        agent_id: pending.agent.clone(),
        connection_id: pending.connection_id.clone(),
        from_byte: pending.cursor,
        next_byte: pending.cursor + complete as u64,
        text: text[..complete].to_owned(),
        reset: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agents() -> Value {
        json!([{"id":"agent-a", "displayName":"Agent A", "kind":"sub", "status":"running", "hasSessionFile":true, "createdAt":1234, "lastActivity":1234}])
    }

    fn fixture() -> (
        Arc<Reads>,
        ReadConnection,
        mpsc::UnboundedReceiver<OutboundFrame>,
        watch::Sender<bool>,
    ) {
        let reads = Arc::new(Reads::default());
        let (sender, receiver) = mpsc::unbounded_channel();
        let (room, closed) = watch::channel(false);
        let connection = reads.connect("/parent", 1, "parent-id", closed, &agents(), sender);
        (reads, connection, receiver, room)
    }

    async fn dispatched(
        reads: &Arc<Reads>,
        connection: &ReadConnection,
        receiver: &mut mpsc::UnboundedReceiver<OutboundFrame>,
        cursor: u64,
    ) -> Request {
        let request = reads
            .start("/parent", "parent-id", "agent-a", cursor, Some(1234.0))
            .unwrap();
        let frame = receiver.recv().await.unwrap();
        assert_eq!(
            frame.payload,
            json!({"t":"fetch-transcript", "reqId":request.id, "agentId":"agent-a", "fromByte":cursor})
        );
        assert!(connection.can_send(&frame.payload));
        request
    }

    #[tokio::test]
    async fn desktop_follow_up_captures_native_eligible_identity_and_rechecks_at_drain() {
        let (reads, connection, mut receiver, _room) = fixture();
        let mut roster = agents();
        roster[0]["parentId"] = json!("Main");
        roster
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"Main", "kind":"main"}));
        connection.update_agents(&roster);
        let connection_id = reads.snapshot("/parent", "parent-id").unwrap()["connectionId"]
            .as_str()
            .unwrap()
            .to_owned();
        for status in ["running", "idle", "parked"] {
            roster[0]["status"] = json!(status);
            connection.update_agents(&roster);
            assert!(
                reads
                    .follow_up(
                        "/parent",
                        "parent-id",
                        "agent-a",
                        1234.0,
                        &connection_id,
                        None
                    )
                    .is_ok()
            );
        }
        for status in ["aborted", "unknown"] {
            roster[0]["status"] = json!(status);
            connection.update_agents(&roster);
            assert!(
                reads
                    .follow_up(
                        "/parent",
                        "parent-id",
                        "agent-a",
                        1234.0,
                        &connection_id,
                        Some("must not restart")
                    )
                    .is_err()
            );
        }
        roster[0]["status"] = json!("parked");
        connection.update_agents(&roster);
        assert!(
            reads
                .follow_up(
                    "/parent",
                    "other-parent",
                    "agent-a",
                    1234.0,
                    &connection_id,
                    None
                )
                .is_err()
        );
        assert!(
            reads
                .follow_up(
                    "/parent",
                    "parent-id",
                    "agent-a",
                    999.0,
                    &connection_id,
                    None
                )
                .is_err()
        );
        assert!(
            reads
                .follow_up(
                    "/parent",
                    "parent-id",
                    "agent-a",
                    1234.0,
                    "old-connection",
                    None
                )
                .is_err()
        );
        assert!(
            receiver.try_recv().is_err(),
            "preflight never sends or revives"
        );
        let _receipt = reads
            .follow_up(
                "/parent",
                "parent-id",
                "agent-a",
                1234.0,
                &connection_id,
                Some("Review the second patch"),
            )
            .unwrap()
            .unwrap();
        let frame = receiver.recv().await.unwrap();
        assert!(connection.can_send(&frame.payload));
        roster[0]["createdAt"] = json!(9999);
        connection.update_agents(&roster);
        assert!(
            !connection.can_send(&frame.payload),
            "same-id replacement cannot drain old actions"
        );
        assert!(
            reads
                .follow_up(
                    "/parent",
                    "parent-id",
                    "agent-a",
                    1234.0,
                    &connection_id,
                    None
                )
                .is_err()
        );
    }

    #[tokio::test]
    async fn desktop_follow_up_refuses_foreign_scope_advisors_cycles_and_missing_transcripts() {
        let (reads, connection, _receiver, _room) = fixture();
        let mut roster = agents();
        roster[0]["parentId"] = json!("Main");
        roster
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"Main", "kind":"main"}));
        connection.update_agents(&roster);
        let id = reads.snapshot("/parent", "parent-id").unwrap()["connectionId"]
            .as_str()
            .unwrap()
            .to_owned();
        for (field, value) in [
            ("parentId", json!("foreign-root")),
            ("parentId", json!("agent-a")),
            ("hasSessionFile", json!(false)),
            ("kind", json!("advisor")),
        ] {
            let mut invalid = roster.clone();
            invalid[0][field] = value;
            connection.update_agents(&invalid);
            assert!(
                reads
                    .follow_up("/parent", "parent-id", "agent-a", 1234.0, &id, None)
                    .is_err()
            );
        }
        let mut duplicate = roster.clone();
        duplicate.as_array_mut().unwrap().push(roster[0].clone());
        connection.update_agents(&duplicate);
        assert!(
            reads
                .follow_up("/parent", "parent-id", "agent-a", 1234.0, &id, None)
                .is_err()
        );
    }

    #[tokio::test]
    async fn desktop_follow_up_never_replays_on_a_replacement_connection() {
        let (reads, connection, mut receiver, _room) = fixture();
        let mut roster = agents();
        roster[0]["parentId"] = json!("Main");
        roster
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"Main", "kind":"main"}));
        connection.update_agents(&roster);
        let id = reads.snapshot("/parent", "parent-id").unwrap()["connectionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let _receipt = reads
            .follow_up("/parent", "parent-id", "agent-a", 1234.0, &id, Some("once"))
            .unwrap()
            .unwrap();
        let frame = receiver.recv().await.unwrap();
        let (sender, _receiver) = mpsc::unbounded_channel();
        let (_room, closed) = watch::channel(false);
        let replacement = reads.connect("/parent", 2, "parent-id", closed, &roster, sender);
        assert!(!connection.can_send(&frame.payload));
        assert!(!replacement.can_send(&frame.payload));
        assert!(
            reads
                .follow_up("/parent", "parent-id", "agent-a", 1234.0, &id, None)
                .is_err()
        );
    }

    #[tokio::test]
    async fn view_only_read_returns_complete_utf8_records_and_holds_partial_suffix() {
        let (reads, connection, mut receiver, _room) = fixture();
        let request = dispatched(&reads, &connection, &mut receiver, 5).await;
        // No write token or writer state exists in this read authorization.
        let text = "{\"text\":\"🦀\"}\n{\"partial\":";
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":request.id, "text":text, "newSize":5 + text.len()}),
        );
        let chunk = request.wait(Duration::from_secs(1)).await.unwrap();
        let prefix = "{\"text\":\"🦀\"}\n";
        assert_eq!(chunk.text, prefix);
        assert_eq!(chunk.from_byte, 5);
        assert_eq!(chunk.next_byte, 5 + prefix.len() as u64);
        assert_eq!(chunk.agent_id, "agent-a");
        assert!(!chunk.reset);
        assert!(reads.0.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn shrunk_file_resets_without_fabricating_history_or_eof() {
        let (reads, connection, mut receiver, _room) = fixture();
        let request = dispatched(&reads, &connection, &mut receiver, 900).await;
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":request.id, "text":"", "newSize":4}),
        );
        let chunk = request.wait(Duration::from_secs(1)).await.unwrap();
        assert!(chunk.reset);
        assert_eq!(chunk.next_byte, 4);
        assert!(chunk.text.is_empty());
        assert!(serde_json::to_value(chunk).unwrap().get("eof").is_none());
    }

    #[tokio::test]
    async fn unknown_agent_and_missing_or_closed_host_are_typed_failures() {
        let (reads, connection, _receiver, room) = fixture();
        assert!(matches!(
            reads.start("/missing", "parent-id", "agent-a", 0, None),
            Err(Error::HostUnavailable)
        ));
        assert!(matches!(
            reads.start("/parent", "other-parent", "agent-a", 0, None),
            Err(Error::HostUnavailable)
        ));
        assert!(matches!(
            reads.start("/parent", "parent-id", "unknown", 0, None),
            Err(Error::Unavailable)
        ));
        room.send(true).unwrap();
        assert!(matches!(
            reads.start("/parent", "parent-id", "agent-a", 0, None),
            Err(Error::HostUnavailable)
        ));
        drop(connection);
        assert!(reads.0.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn host_errors_are_typed_and_never_echo_private_error_details() {
        let (reads, connection, mut receiver, _room) = fixture();
        for (message, expected) in [
            ("no transcript available", Error::Unavailable),
            ("cannot read /private/agent-file", Error::Host),
        ] {
            let request = dispatched(&reads, &connection, &mut receiver, 77).await;
            connection.receive(1, &json!({"t":"transcript", "reqId":request.id, "text":"", "newSize":77, "error":message}));
            assert_eq!(request.wait(Duration::from_secs(1)).await, Err(expected));
            assert!(!expected.message().contains("/private"));
        }
    }

    #[tokio::test]
    async fn wrong_peer_type_id_source_or_session_cannot_complete_a_waiter() {
        let (reads, connection, mut receiver, _room) = fixture();
        let request = dispatched(&reads, &connection, &mut receiver, 0).await;
        let response = json!({"t":"transcript", "reqId":request.id, "text":"ok\n", "newSize":3});
        connection.receive(2, &response);
        connection.receive(0, &response);
        connection.receive(
            1,
            &json!({"t":"ui-request", "reqId":request.id, "text":"ok\n", "newSize":3}),
        );
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":request.id + 1000, "text":"ok\n", "newSize":3}),
        );
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":request.id.to_string(), "text":"ok\n", "newSize":3}),
        );
        let (sender, _receiver) = mpsc::unbounded_channel();
        let (_other_room, closed) = watch::channel(false);
        let other = reads.connect("/other", 2, "other-parent", closed, &agents(), sender);
        other.receive(1, &response);
        assert_eq!(reads.0.lock().unwrap().pending.len(), 1);
        connection.receive(1, &response);
        assert_eq!(
            request.wait(Duration::from_secs(1)).await.unwrap().text,
            "ok\n"
        );
    }

    #[tokio::test]
    async fn responses_before_dispatch_and_changed_outbound_identity_are_rejected() {
        let (reads, connection, mut receiver, _room) = fixture();
        let request = reads
            .start("/parent", "parent-id", "agent-a", 0, None)
            .unwrap();
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":request.id, "text":"x", "newSize":1}),
        );
        assert_eq!(reads.0.lock().unwrap().pending.len(), 1);
        let mut frame = receiver.recv().await.unwrap().payload;
        frame["agentId"] = json!("other");
        assert!(!connection.can_send(&frame));
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":request.id, "text":"x\n", "newSize":2}),
        );
        assert_eq!(reads.0.lock().unwrap().pending.len(), 1);
        drop(request);
        assert!(reads.0.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn timeout_and_future_cancellation_retire_waiters_and_skip_queued_reads() {
        let (reads, connection, mut receiver, _room) = fixture();
        let request = reads
            .start("/parent", "parent-id", "agent-a", 0, None)
            .unwrap();
        let queued = receiver.recv().await.unwrap().payload;
        assert_eq!(
            request.wait(Duration::from_millis(1)).await,
            Err(Error::Timeout)
        );
        assert!(!connection.can_send(&queued));
        let task = tokio::spawn({
            let reads = reads.clone();
            async move {
                reads
                    .fetch("/parent", "parent-id", "agent-a", 0, None, None)
                    .await
            }
        });
        let queued = receiver.recv().await.unwrap().payload;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(!connection.can_send(&queued));
        assert!(reads.0.lock().unwrap().pending.is_empty());
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":queued["reqId"], "text":"late", "newSize":4}),
        );
        assert!(reads.0.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn replacement_disconnect_and_old_drop_preserve_only_new_binding() {
        let (reads, old, mut receiver, _room) = fixture();
        let request = reads
            .start("/parent", "parent-id", "agent-a", 0, None)
            .unwrap();
        let queued = receiver.recv().await.unwrap().payload;
        let (sender, mut new_receiver) = mpsc::unbounded_channel();
        let (_new_room, closed) = watch::channel(false);
        let new = reads.connect("/parent", 2, "parent-id", closed, &agents(), sender);
        assert_eq!(
            request.wait(Duration::from_secs(1)).await,
            Err(Error::HostUnavailable)
        );
        assert!(!old.can_send(&queued));
        assert!(!new.can_send(&queued));
        let request = dispatched(&reads, &new, &mut new_receiver, 0).await;
        let response = json!({"t":"transcript", "reqId":request.id, "text":"new\n", "newSize":4});
        old.receive(1, &response);
        drop(old);
        assert_eq!(reads.0.lock().unwrap().pending.len(), 1);
        new.receive(1, &response);
        assert_eq!(
            request.wait(Duration::from_secs(1)).await.unwrap().text,
            "new\n"
        );
        let request = dispatched(&reads, &new, &mut new_receiver, 0).await;
        reads.disconnect("/parent");
        assert_eq!(
            request.wait(Duration::from_secs(1)).await,
            Err(Error::HostUnavailable)
        );
    }

    #[tokio::test]
    async fn room_replacement_retires_pending_even_before_socket_close() {
        let (reads, connection, mut receiver, room) = fixture();
        let request = dispatched(&reads, &connection, &mut receiver, 0).await;
        room.send(true).unwrap();
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":request.id, "text":"late", "newSize":4}),
        );
        assert_eq!(
            request.wait(Duration::from_secs(1)).await,
            Err(Error::HostUnavailable)
        );
        assert!(reads.0.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn queue_and_waiter_caps_include_cancelled_requests_not_yet_dequeued() {
        let (reads, connection, mut receiver, _room) = fixture();
        for _ in 0..MAX_PENDING_PER_SESSION {
            drop(
                reads
                    .start("/parent", "parent-id", "agent-a", 0, None)
                    .unwrap(),
            );
        }
        assert!(matches!(
            reads.start("/parent", "parent-id", "agent-a", 0, None),
            Err(Error::Busy)
        ));
        assert_eq!(reads.0.lock().unwrap().pending.len(), 0);
        for _ in 0..MAX_PENDING_PER_SESSION {
            assert!(!connection.can_send(&receiver.recv().await.unwrap().payload));
        }
        let mut pending = Vec::new();
        for _ in 0..MAX_PENDING_PER_SESSION {
            pending.push(dispatched(&reads, &connection, &mut receiver, 0).await);
        }
        assert!(matches!(
            reads.start("/parent", "parent-id", "agent-a", 0, None),
            Err(Error::Busy)
        ));
        drop(pending);
        assert!(reads.0.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn observed_roster_replacement_removal_and_expected_identity_are_fenced() {
        let (reads, connection, mut receiver, _room) = fixture();
        assert!(matches!(
            reads.start("/parent", "parent-id", "agent-a", 0, Some(5678.0)),
            Err(Error::AgentChanged)
        ));
        let request = dispatched(&reads, &connection, &mut receiver, 0).await;
        connection.update_agents(
            &json!([{"id":"agent-a", "displayName":"Agent A", "kind":"sub", "status":"running", "hasSessionFile":true, "createdAt":5678, "lastActivity":5678}]),
        );
        assert_eq!(
            request.wait(Duration::from_secs(1)).await,
            Err(Error::AgentChanged)
        );
        let request = reads
            .start("/parent", "parent-id", "agent-a", 0, Some(5678.0))
            .unwrap();
        connection.update_agents(&json!([]));
        assert_eq!(
            request.wait(Duration::from_secs(1)).await,
            Err(Error::AgentChanged)
        );
        assert!(matches!(
            reads.start("/parent", "parent-id", "agent-a", 0, Some(5678.0)),
            Err(Error::AgentChanged)
        ));
    }

    #[test]
    fn roster_rejects_ambiguous_missing_file_main_advisor_and_malformed_identities() {
        let rows = json!([
            {"id":"duplicate", "kind":"sub", "hasSessionFile":true, "createdAt":1},
            {"id":"duplicate", "kind":"sub", "hasSessionFile":true, "createdAt":1},
            {"id":"duplicate", "kind":"sub", "hasSessionFile":true, "createdAt":1},
            {"id":"main", "kind":"main", "hasSessionFile":true, "createdAt":1},
            {"id":"advisor", "kind":"advisor", "hasSessionFile":true, "createdAt":1},
            {"id":"missing", "kind":"sub", "hasSessionFile":false, "createdAt":1},
            {"id":"malformed", "kind":"sub", "hasSessionFile":true, "createdAt":"1"},
            {"id":"ok", "displayName":"OK", "kind":"sub", "status":"idle", "hasSessionFile":true, "createdAt":0, "lastActivity":0}
        ]);
        assert_eq!(roster(&rows), HashMap::from([("ok".into(), 0.0)]));
        assert!(roster(&Value::Null).is_empty());
    }

    #[tokio::test]
    async fn malformed_fields_cursors_or_oversized_chunks_fail_without_advancing() {
        let (reads, connection, mut receiver, _room) = fixture();
        for response in [
            json!({"text":"x", "newSize":-1}),
            json!({"text":"x", "newSize":1.5}),
            json!({"text":"x", "newSize":MAX_SAFE_CURSOR+1}),
            json!({"text":"x", "newSize":0}),
            json!({"text":"🦀", "newSize":1}),
            json!({"text":"", "newSize":1}),
            json!({"text":null, "newSize":0}),
            json!({"text":"", "newSize":"0"}),
            json!({"text":"", "newSize":0, "error":true}),
            json!({"text":"secret", "newSize":6, "error":"private failure"}),
            json!({"text":"x".repeat(MAX_CHUNK_BYTES as usize + 1), "newSize":MAX_CHUNK_BYTES+1}),
        ] {
            let request = dispatched(&reads, &connection, &mut receiver, 0).await;
            let mut response = response;
            response["t"] = json!("transcript");
            response["reqId"] = json!(request.id);
            connection.receive(1, &response);
            assert_eq!(
                request.wait(Duration::from_secs(1)).await,
                Err(Error::InvalidResponse)
            );
        }
    }

    #[tokio::test]
    async fn torn_eof_unicode_never_advances_past_an_incomplete_record() {
        let (reads, connection, mut receiver, _room) = fixture();
        let prefix = "{\"text\":\"before\"}\n";
        for bytes_of_emoji in [1, 2, 3] {
            let request = dispatched(&reads, &connection, &mut receiver, 0).await;
            let decoded = format!("{prefix}{{\"text\":\"�");
            let raw_size = prefix.len() + "{\"text\":\"".len() + bytes_of_emoji;
            connection.receive(
                1,
                &json!({"t":"transcript", "reqId":request.id, "text":decoded, "newSize":raw_size}),
            );
            let chunk = request.wait(Duration::from_secs(1)).await.unwrap();
            assert_eq!(chunk.text, prefix);
            assert_eq!(chunk.next_byte, prefix.len() as u64);
            let cursor = chunk.next_byte;
            let request = dispatched(&reads, &connection, &mut receiver, cursor).await;
            let completed = "{\"text\":\"🦀\"}\n";
            connection.receive(1, &json!({"t":"transcript", "reqId":request.id, "text":completed, "newSize":cursor + completed.len() as u64}));
            assert_eq!(
                request.wait(Duration::from_secs(1)).await.unwrap().text,
                completed
            );
        }
        let request = dispatched(&reads, &connection, &mut receiver, 0).await;
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":request.id, "text":"{\"partial\":", "newSize":11}),
        );
        let chunk = request.wait(Duration::from_secs(1)).await.unwrap();
        assert!(chunk.text.is_empty());
        assert_eq!(chunk.next_byte, 0);
    }

    #[test]
    fn exact_count_requires_complete_unambiguous_source_rows() {
        assert_eq!(running_count(&json!([])), Some(0));
        let mut rows = Vec::new();
        for (id, kind, status) in [
            ("parent", "main", "running"),
            ("advisor", "advisor", "running"),
            ("a", "sub", "running"),
            ("b", "sub", "idle"),
            ("c", "sub", "parked"),
            ("d", "sub", "aborted"),
        ] {
            rows.push(json!({"id":id,"kind":kind,"status":status,"displayName":id,
                "createdAt":1,"lastActivity":2,"hasSessionFile":false}));
        }
        assert_eq!(running_count(&json!(rows)), Some(1));
        for value in [
            Value::Null,
            json!({"agents":[]}),
            json!([null]),
            json!([{"id":"a", "kind":"sub", "status":"unknown"}]),
            json!([{"id":"a", "kind":"new-kind", "status":"running"}]),
            json!([{"id":"", "kind":"sub", "status":"idle"}]),
            json!([{"id":"a", "kind":"sub", "status":"idle"}, {"id":"a", "kind":"sub", "status":"running"}]),
        ] {
            assert_eq!(running_count(&value), None, "{value}");
        }
    }

    #[tokio::test]
    async fn filtered_display_rows_never_manufacture_a_zero_count() {
        let (reads, connection, _receiver, _room) = fixture();
        connection.update_agents(&json!([{"id":"a", "kind":"sub", "status":"running"}]));
        let snapshot = reads.snapshot("/parent", "parent-id").unwrap();
        assert_eq!(snapshot["agents"], json!([]));
        assert!(snapshot["runningCount"].is_null());
        connection.update_agents(&json!([{"id":"a", "kind":"sub", "status":"unknown"}]));
        assert!(reads.snapshot("/parent", "parent-id").unwrap()["runningCount"].is_null());
        connection.update_agents(&json!([]));
        assert_eq!(
            reads.snapshot("/parent", "parent-id").unwrap()["runningCount"],
            0
        );
    }

    #[tokio::test]
    async fn passive_roster_snapshot_is_current_connection_scoped_and_loss_is_not_empty() {
        let (reads, connection, _receiver, room) = fixture();
        let first = reads.snapshot("/parent", "parent-id").unwrap();
        assert_eq!(first["agents"][0]["id"], "agent-a");
        connection.update_agents(&json!([]));
        let empty = reads.snapshot("/parent", "parent-id").unwrap();
        assert_eq!(empty["agents"], json!([]));
        assert_eq!(first["connectionId"], empty["connectionId"]);
        assert_eq!(
            reads.snapshot("/parent", "other-parent"),
            Err(Error::HostUnavailable)
        );
        room.send(true).unwrap();
        assert_eq!(
            reads.snapshot("/parent", "parent-id"),
            Err(Error::HostUnavailable)
        );
        let (sender, _receiver) = mpsc::unbounded_channel();
        let (_room, closed) = watch::channel(false);
        let _replacement = reads.connect("/parent", 2, "parent-id", closed, &agents(), sender);
        let replacement = reads.snapshot("/parent", "parent-id").unwrap();
        assert_ne!(first["connectionId"], replacement["connectionId"]);
    }

    #[tokio::test]
    async fn global_caps_bound_requests_and_cancelled_queue_across_sessions() {
        let reads = Arc::new(Reads::default());
        let mut connections = Vec::new();
        let mut queues = Vec::new();
        let mut rooms = Vec::new();
        let mut requests = Vec::new();
        for index in 0..=MAX_PENDING / MAX_PENDING_PER_SESSION {
            let session = format!("/parent-{index}");
            let (sender, queue) = mpsc::unbounded_channel();
            let (room, closed) = watch::channel(false);
            connections.push(reads.connect(
                &session,
                index as u64,
                "parent-id",
                closed,
                &agents(),
                sender,
            ));
            queues.push(queue);
            rooms.push(room);
            if index < MAX_PENDING / MAX_PENDING_PER_SESSION {
                for _ in 0..MAX_PENDING_PER_SESSION {
                    requests.push(
                        reads
                            .start(&session, "parent-id", "agent-a", 0, None)
                            .unwrap(),
                    );
                }
            }
        }
        assert!(matches!(
            reads.start("/parent-8", "parent-id", "agent-a", 0, None),
            Err(Error::Busy)
        ));
        let first = requests.remove(0);
        let first_id = first.id;
        drop(first);
        assert!(matches!(
            reads.start("/parent-8", "parent-id", "agent-a", 0, None),
            Err(Error::Busy)
        ));
        assert!(!connections[0].can_send(&queues[0].recv().await.unwrap().payload));
        let next = reads
            .start("/parent-8", "parent-id", "agent-a", 0, None)
            .unwrap();
        assert!(next.id > first_id && next.id <= MAX_SAFE_CURSOR);
        assert_eq!(reads.0.lock().unwrap().pending.len(), MAX_PENDING);
    }

    #[tokio::test]
    async fn roster_keeps_no_file_rows_but_malformed_snapshot_is_not_empty_success() {
        let (reads, connection, _receiver, _room) = fixture();
        let mut rows = agents();
        rows[0]["hasSessionFile"] = json!(false);
        connection.update_agents(&rows);
        assert_eq!(
            reads.snapshot("/parent", "parent-id").unwrap()["agents"][0]["hasSessionFile"],
            false
        );
        assert!(matches!(
            reads.start("/parent", "parent-id", "agent-a", 0, Some(1234.0)),
            Err(Error::Unavailable)
        ));
        connection.update_agents(&Value::Null);
        assert_eq!(
            reads.snapshot("/parent", "parent-id"),
            Err(Error::InvalidResponse)
        );
    }

    #[tokio::test]
    async fn expected_connection_fences_selection_and_success_echoes_the_captured_lease() {
        let (reads, connection, mut receiver, _room) = fixture();
        let snapshot = reads.snapshot("/parent", "parent-id").unwrap();
        let id = snapshot["connectionId"].as_str().unwrap();
        assert!(matches!(
            reads.start_bound(
                "/parent",
                "parent-id",
                "agent-a",
                0,
                None,
                Some("wrong-connection")
            ),
            Err(Error::HostUnavailable)
        ));
        assert!(receiver.try_recv().is_err());
        let request = reads
            .start_bound("/parent", "parent-id", "agent-a", 0, None, Some(id))
            .unwrap();
        assert!(connection.can_send(&receiver.recv().await.unwrap().payload));
        connection.receive(
            1,
            &json!({"t":"transcript", "reqId":request.id, "text":"{}\n", "newSize":3}),
        );
        assert_eq!(
            request
                .wait(Duration::from_secs(1))
                .await
                .unwrap()
                .connection_id,
            id
        );
        let (sender, _receiver) = mpsc::unbounded_channel();
        let (_room, closed) = watch::channel(false);
        let _replacement = reads.connect("/parent", 2, "parent-id", closed, &agents(), sender);
        assert!(matches!(
            reads.start_bound("/parent", "parent-id", "agent-a", 0, None, Some(id)),
            Err(Error::HostUnavailable)
        ));
    }

    #[test]
    fn request_validation_rejects_unsafe_cursors_and_unbounded_ids() {
        assert!(valid_request("exact/id", MAX_SAFE_CURSOR));
        assert!(!valid_request("", 0));
        assert!(!valid_request("line\nbreak", 0));
        assert!(!valid_request(&"a".repeat(257), 0));
        assert!(!valid_request("agent", MAX_SAFE_CURSOR + 1));
        assert!(!valid_created_at(f64::NAN));
        assert!(!valid_created_at(f64::INFINITY));
    }
}
