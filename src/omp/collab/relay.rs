//! The self-hosted relay (replaces the my.omp.sh dependency): rooms, peers and the
//! pure frame router between them.

use super::*;

use crate::server::delta::DeltaEncoder;
use crate::server::push::Push;
use crate::server::ws::WsHub;
use crate::sessions::jsonl;
use crate::types::{Config, SharedConfig};

use axum::body::Bytes;
use axum::extract::ws::Message as WsMessage;
use axum::extract::ws::{CloseFrame, Utf8Bytes, WebSocket};
use futures_util::stream::SplitStream;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::MaybeTlsStream;
use tracing::{info, warn};

/// One live relay room: the host's routing task plus every live peer (host
/// + guests) and the internal tap. `session_path` is filled in by the tap
///   once the host's `welcome` maps the room to a local session; `generation`
///   guards stale-task cleanup (a newer host must never be torn down by the
///   previous room's teardown); `tap_gen` guards the same for duplicate taps;
///   `notify` wakes the room task when the room is replaced; `events` feeds
///   every peer's socket into the routing task; `task` lets the manager abort
///   a replaced room's routing loop immediately.
pub(super) struct RelayRoom {
    pub(super) generation: u64,
    pub(super) session_path: Option<String>,
    pub(super) notify: watch::Sender<bool>,
    pub(super) task: tokio::task::JoinHandle<()>,
    pub(super) events: mpsc::UnboundedSender<PeerEvent>,
    pub(super) peers: HashMap<u32, RelayPeer>,
    pub(super) tap_gen: u64,
}

impl RelayRoom {
    pub(super) fn close_outputs(&self) {
        for peer in self.peers.values() {
            peer.tx.close();
        }
    }

    pub(super) fn has_live_host(&self) -> bool {
        self.peers
            .get(&HOST_PEER_ID)
            .is_some_and(|peer| !peer.tx.is_closed())
    }

    /// Cancel tasks owned by a room removed during host replacement. Dropping
    /// peer JoinHandles alone would detach silent readers or blocked writers.
    pub(super) fn abort_tasks(self) {
        self.close_outputs();
        self.task.abort();
        for peer in self.peers.into_values() {
            peer.writer.abort();
            peer.reader.abort();
        }
    }
}

/// One live peer socket: a writer task drains `tx` into the socket, a reader
/// task feeds the room task's event channel, and the room task routes by
/// sending into `tx`. Peers are the host (id 1) or guests (ids 2,3,…).
pub(super) struct RelayPeer {
    pub(super) id: u32,
    pub(super) name: String,
    pub(super) tx: relay_output::Sender,
    pub(super) writer: tokio::task::JoinHandle<()>,
    pub(super) reader: tokio::task::JoinHandle<()>,
}

/// One routed frame (normalized off the socket). `Close` is outbound only —
/// readers report socket close via `PeerEvent::Gone`.
#[derive(Clone)]
pub(super) enum RouteFrame {
    Binary(Bytes),
    Text(Utf8Bytes),
    Close(u16),
}

/// What a peer's reader task reports to the room task.
pub(super) enum PeerEvent {
    Frame { peer_id: u32, frame: RouteFrame },
    Gone { peer_id: u32 },
}

impl RelayManager {
    pub fn new(
        config: SharedConfig,
        hub: Arc<WsHub>,
        delta: Arc<DeltaEncoder>,
        push: Arc<Push>,
    ) -> Arc<Self> {
        let links = LinkRegistry::load(&config);
        let manager = Arc::new(RelayManager {
            listeners: Mutex::new(HashSet::new()),
            config,
            hub,
            delta,
            push,
            rooms: Arc::new(Mutex::new(HashMap::new())),
            next_gen: AtomicU64::new(1),
            next_peer: AtomicU32::new(2),
            links,
        });
        if let Ok(mut g) = RELAY_MANAGER.lock() {
            *g = Some(Arc::downgrade(&manager));
        }
        manager
    }

    /// Called only after a daemon listener actually binds. A configured port
    /// or a numeric prefix from an external relay is not socket provenance.
    pub fn register_listener(&self, address: std::net::SocketAddr) {
        self.listeners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(address);
    }

    pub(super) fn capture_read_route(self: &Arc<Self>, room_id: &str) -> Option<LocalReadRoute> {
        self.rooms
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(room_id)
            .filter(|room| room.has_live_host())
            .map(|room| LocalReadRoute {
                relay: self.clone(),
                room_id: room_id.to_owned(),
                generation: room.generation,
                closed: room.notify.subscribe(),
            })
    }

    /// Weak handle to the live manager, for the collab attach path.
    pub(super) fn current() -> Option<Arc<RelayManager>> {
        match RELAY_MANAGER.lock() {
            Ok(g) => g.as_ref().and_then(Weak::upgrade),
            Err(p) => p.into_inner().as_ref().and_then(Weak::upgrade),
        }
    }

    /// Entry for the axum WS route (`GET /r/{roomId}` and the assignment-spec
    /// `GET /r/{room}/{secret}`).
    ///
    /// The token is the room id ONLY — the omp relay client connects to
    /// `/r/<roomId>` with no secret (the room key lives solely in the
    /// in-process client object), so the router never sees, and never tries
    /// to decrypt, a key; the `secret` path segment, when present, is
    /// ignored. The daemon's own tap is an INTERNAL GUEST that carries the
    /// key from the stored link instead.
    ///
    /// Role comes from the client's `?role=` query, NOT room state: a `host`
    /// creates a room only when it has no live host, and a `guest` joins an
    /// EXISTING room with a host. The "first peer becomes host" heuristic
    /// would let a guest hitting a dead room strand the auto-tap on a phantom
    /// room. A host reconnect may replace only a stale room, never a live host.
    ///
    /// On admission refusal the socket is closed with 4004 ("no such room")
    /// or 4009 ("host conflict"); the caller only logs the error (room id,
    /// never the secret).
    pub async fn handle_ws(
        &self,
        mut socket: WebSocket,
        room_id: &str,
        _secret: &str,
        role: Option<&str>,
    ) -> Result<(), String> {
        match role {
            Some("host") => self.join_as_host(socket, room_id).await,
            // Guests (or a missing/unknown role): only join a live room.
            _ => {
                let has_host = match self.rooms.lock() {
                    Ok(g) => g.get(room_id).map(|r| r.has_live_host()).unwrap_or(false),
                    Err(_) => false,
                };
                if has_host {
                    self.join_as_guest(socket, room_id).await
                } else {
                    relay_close(&mut socket, 4004, "no such room").await;
                    Err(format!("collab relay: room {room_id} has no host"))
                }
            }
        }
    }

    /// Atomically claim a room without a live host, then auto-tap it if a
    /// room-keyed stored link exists. A room id is not host authentication:
    /// a contender must never evict the current host, its guests, or its tap.
    /// Only stale entries can be replaced; cleanup consumes the removed room
    /// so it cannot cancel peers belonging to the newly published generation.
    async fn join_as_host(&self, socket: WebSocket, room_id: &str) -> Result<(), String> {
        let admission = {
            // Keep the live-host check, claim, and reader membership atomic.
            // A buffered first frame may arrive as soon as its reader spawns.
            let mut rooms = self
                .rooms
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if rooms.get(room_id).is_some_and(RelayRoom::has_live_host) {
                // Do not split the socket or spawn any peer tasks on refusal.
                Err(socket)
            } else {
                let (sink, stream) = socket.split();
                let (events_tx, events_rx) = mpsc::unbounded_channel();
                let (tx, rx) = relay_output::channel();
                let writer = tokio::spawn(peer_writer(sink, rx));
                let reader = tokio::spawn(peer_reader(stream, HOST_PEER_ID, events_tx.clone()));
                let generation = self.next_gen.fetch_add(1, Ordering::Relaxed);
                let (notify_tx, notify_rx) = watch::channel(false);
                let mut peers = HashMap::new();
                peers.insert(
                    HOST_PEER_ID,
                    RelayPeer {
                        id: HOST_PEER_ID,
                        name: "host".to_string(),
                        tx,
                        writer,
                        reader,
                    },
                );
                let task = tokio::spawn(relay_room_task(
                    room_id.to_string(),
                    self.hub.clone(),
                    self.delta.clone(),
                    Arc::clone(&self.rooms),
                    generation,
                    notify_rx,
                    events_rx,
                ));
                let replaced = rooms.insert(
                    room_id.to_string(),
                    RelayRoom {
                        generation,
                        session_path: None,
                        notify: notify_tx,
                        task,
                        events: events_tx,
                        peers,
                        tap_gen: 0,
                    },
                );
                if let Some(old) = &replaced {
                    old.close_outputs();
                    let _ = old.notify.send(true);
                }
                Ok((generation, replaced))
            }
        };
        let (generation, replaced) = match admission {
            Ok(admitted) => admitted,
            Err(mut socket) => {
                // The registry mutex is released before awaiting the close.
                relay_close(&mut socket, 4009, "host conflict").await;
                return Err(format!("collab relay: room {room_id} already has a host"));
            }
        };
        if let Some(old) = replaced {
            old.abort_tasks();
            info!(room = %room_id, "collab relay stale room replaced (host reconnect)");
        } else {
            info!(room = %room_id, "collab relay room registered (host peer 1)");
        }
        // Auto-tap: the daemon remembers collab links by room, so a host
        // connecting for a room we have a link for means the phone's session
        // should light up without an explicit attach — spawn the internal
        // guest. The entry is already live (inserted above), and the
        // generation guard makes a stale spawn a no-op.
        if let Some(link) = self.links.stored_link_for_room(room_id) {
            spawn_tap(
                &self.rooms,
                room_id,
                link,
                self.hub.clone(),
                self.delta.clone(),
                self.push.clone(),
                self.links.clone(),
                self.config.clone(),
                generation,
            );
        }
        Ok(())
    }

    /// Register a LATER peer of a live room as a guest: give it the next
    /// peer id, wire its socket into the room's routing task, and announce
    /// `peer-joined` to everyone already in the room. A guest connecting for
    /// a room with no host yet gets 4004 ("no such room") — it has nothing
    /// to join until a host registers (the internal tap is only ever spawned
    /// after a host, so this is a race/defense, logged).
    async fn join_as_guest(&self, mut socket: WebSocket, room_id: &str) -> Result<(), String> {
        let binding = {
            let g = match self.rooms.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            match g.get(room_id) {
                Some(room) if room.has_live_host() => Some((room.generation, room.events.clone())),
                _ => None,
            }
        };
        let Some((generation, events_tx)) = binding else {
            relay_close(&mut socket, 4004, "no such room").await;
            return Err(format!("collab relay: room {room_id} has no host yet"));
        };

        let peer_id = self.next_peer.fetch_add(1, Ordering::Relaxed);
        let (sink, stream) = socket.split();
        let (tx, rx) = relay_output::channel();

        // The room may have died or been replaced between the two locks. Never
        // register in a new room while the reader still has the old event pipe.
        let others: Vec<(u32, relay_output::Sender)> = {
            let mut g = match self.rooms.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let Some(room) = g
                .get_mut(room_id)
                .filter(|room| room.generation == generation && room.has_live_host())
            else {
                return Err(format!(
                    "collab relay: room {room_id} changed while joining"
                ));
            };
            // Publish membership under this lock before the router can inspect
            // the reader's first hello, even on the multithread runtime.
            let writer = tokio::spawn(peer_writer(sink, rx));
            let reader = tokio::spawn(peer_reader(stream, peer_id, events_tx));
            room.peers.insert(
                peer_id,
                RelayPeer {
                    id: peer_id,
                    name: GUEST_NAME.to_string(),
                    tx: tx.clone(),
                    writer,
                    reader,
                },
            );
            room.peers
                .values()
                .filter(|p| p.id != peer_id)
                .map(|p| (p.id, p.tx.clone()))
                .collect()
        };
        let joined: Utf8Bytes =
            json!({ "t": "peer-joined", "peer": { "id": peer_id, "name": GUEST_NAME } })
                .to_string()
                .into();
        let failed = send_peer_frames(others, RouteFrame::Text(joined));
        if retire_failed_outputs(&self.rooms, room_id, generation, failed) {
            teardown_room(
                &self.rooms,
                room_id,
                generation,
                &self.delta,
                &self.hub,
                "host output unavailable",
            );
        }
        info!(room = %room_id, peer = peer_id, "collab relay guest joined");
        Ok(())
    }

    /// Spawn the internal tap for `room_id` if the room is already live
    /// (host connected) and a room-keyed link is stored. Called from the
    /// collab attach path after a link is remembered, so attaching to an
    /// already-connecting room taps instantly instead of waiting for the
    /// next host connect.
    pub fn tap_room_if_live(&self, room_id: &str) {
        let Some(link) = self.links.stored_link_for_room(room_id) else {
            info!(room = room_id, "collab relay tap skipped (no stored link)");
            return;
        };
        let generation = match self.rooms.lock() {
            Ok(g) => g.get(room_id).map(|r| r.generation),
            Err(p) => p.into_inner().get(room_id).map(|r| r.generation),
        };
        let Some(generation) = generation else {
            info!(room = room_id, "collab relay tap skipped (room not live)");
            return;
        };
        spawn_tap(
            &self.rooms,
            room_id,
            link,
            self.hub.clone(),
            self.delta.clone(),
            self.push.clone(),
            self.links.clone(),
            self.config.clone(),
            generation,
        );
    }

    /// Whether any live relay room has mapped to `session_path`.
    pub fn is_attached(&self, session_path: &str) -> bool {
        match self.rooms.lock() {
            Ok(g) => g
                .values()
                .any(|r| r.session_path.as_deref() == Some(session_path)),
            Err(_) => false,
        }
    }
}

/// A room generation captured before guest admission. Capturing the current
/// room after connect could accidentally bless an old queued welcome with a
/// replacement host's live lease, even when the parent and agent IDs match.
pub(super) struct LocalReadRoute {
    pub(super) relay: Arc<RelayManager>,
    room_id: String,
    generation: u64,
    pub(super) closed: watch::Receiver<bool>,
}

impl LocalReadRoute {
    pub(super) fn verifies(&self, ws: &WsStream) -> bool {
        let MaybeTlsStream::Plain(socket) = ws.get_ref() else {
            return false;
        };
        let (Ok(peer), Ok(local)) = (socket.peer_addr(), socket.local_addr()) else {
            return false;
        };
        let ours = self
            .relay
            .listeners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|bound| listener_is_destination(*bound, peer, local));
        // End the watch borrow before locking rooms: replacement holds rooms
        // while notifying this watch, so reversing that order can deadlock.
        let room_live = !*self.closed.borrow() && self.closed.has_changed().is_ok();
        ours && room_live
            && self
                .relay
                .rooms
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&self.room_id)
                .is_some_and(|room| room.generation == self.generation && room.has_live_host())
    }
}

pub(super) fn listener_is_destination(
    bound: std::net::SocketAddr,
    peer: std::net::SocketAddr,
    local: std::net::SocketAddr,
) -> bool {
    bound.port() == peer.port()
        && (bound.ip() == peer.ip()
            || (bound.ip().is_unspecified()
                && bound.is_ipv4() == peer.is_ipv4()
                && (peer.ip().is_loopback() || peer.ip() == local.ip())))
}

/// Send an admission refusal before any peer tasks own the socket.
async fn relay_close(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(WsMessage::Close(Some(CloseFrame {
            code,
            reason: Utf8Bytes::from(reason),
        })))
        .await;
}

/// Resolve a collab session id (from the host's welcome `header.id`) to a
/// local session path by scanning the sessions root: the JSONL session
/// header embeds the id, so match on that rather than the file name.
pub(super) fn resolve_session_path(config: &Config, session_id: &str) -> Option<String> {
    let mut matches = jsonl::list_sessions(&config.sessions_root)
        .into_iter()
        .filter(|s| s.id == session_id);
    let candidate = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let path = std::path::Path::new(&candidate.path).canonicalize().ok()?;
    let root = config.sessions_root.canonicalize().ok()?;
    path.starts_with(root)
        .then(|| path.to_str().map(str::to_owned))
        .flatten()
}

/// Drains routed frames into one peer's socket (axum). Ends when the channel
/// is dropped (peer removed / room torn down) or the socket errors.
pub(super) async fn peer_writer<S>(mut sink: S, mut rx: relay_output::Receiver)
where
    S: futures_util::Sink<WsMessage> + Unpin,
{
    while let Some(queued) = rx.recv().await {
        let msg = match &queued.frame {
            RouteFrame::Binary(bytes) => WsMessage::Binary(bytes.clone()),
            RouteFrame::Text(text) => WsMessage::Text(text.clone()),
            RouteFrame::Close(code) => WsMessage::Close(Some(CloseFrame {
                code: *code,
                reason: Utf8Bytes::from(""),
            })),
        };
        let sent = sink.send(msg).await;
        // Dequeue is not completion: keep the charge through the sink await.
        drop(queued);
        if sent.is_err() {
            break;
        }
    }
}

/// Feeds one peer's socket messages into the room task's event channel;
/// reports `Gone` when the connection ends.
async fn peer_reader(
    mut stream: SplitStream<WebSocket>,
    peer_id: u32,
    events: mpsc::UnboundedSender<PeerEvent>,
) {
    loop {
        match stream.next().await {
            None => break,
            Some(Err(_)) => break,
            Some(Ok(WsMessage::Binary(bytes))) => {
                if events
                    .send(PeerEvent::Frame {
                        peer_id,
                        frame: RouteFrame::Binary(bytes),
                    })
                    .is_err()
                {
                    break;
                }
            }
            Some(Ok(WsMessage::Text(text))) => {
                if events
                    .send(PeerEvent::Frame {
                        peer_id,
                        frame: RouteFrame::Text(text),
                    })
                    .is_err()
                {
                    break;
                }
            }
            Some(Ok(WsMessage::Close(_))) => break,
            // axum auto-responds to pings; nothing to do.
            Some(Ok(WsMessage::Ping(_))) | Some(Ok(WsMessage::Pong(_))) => {}
        }
    }
    let _ = events.send(PeerEvent::Gone { peer_id });
}

/// Normalize to the actual socket sender, never a claimed prefix. The host's
/// destination must be resolved BEFORE calling this; the prefix is outside the
/// AES-GCM sealed payload (no AAD), so ciphertext stays byte-identical.
fn stamp_sender(bytes: Bytes, sender_id: u32) -> Bytes {
    if bytes.len() < ENVELOPE_HEADER_LENGTH
        || bytes[..ENVELOPE_HEADER_LENGTH] == sender_id.to_be_bytes()
    {
        return bytes;
    }
    // Reuse the socket buffer when uniquely owned; fan-out then shares the stamped payload.
    let mut stamped = bytes
        .try_into_mut()
        .unwrap_or_else(|bytes| bytes.as_ref().into());
    stamped[..ENVELOPE_HEADER_LENGTH].copy_from_slice(&sender_id.to_be_bytes());
    stamped.freeze()
}

/// Route local binary traffic by the socket's identity and room generation.
/// Host prefixes are destinations, not sender claims: 0 broadcasts, N targets
/// guest N. Guests can reach only the host, regardless of their claimed prefix.
/// Pulse's internal guest expects host=1, so normalize AFTER target selection.
/// This proves only this local router's socket provenance, not session ownership
/// or the behavior of any external relay used by the separate attach path.
pub(super) fn route_binary_frame(
    rooms: &Arc<Mutex<HashMap<String, RelayRoom>>>,
    room_id: &str,
    generation: u64,
    sender: u32,
    bytes: Bytes,
) -> Vec<u32> {
    let Some((target, _)) = unpack_envelope(&bytes) else {
        return Vec::new();
    };
    let txs: Vec<_> = {
        let rooms = rooms.lock().unwrap_or_else(|p| p.into_inner());
        let Some(room) = rooms
            .get(room_id)
            .filter(|room| room.generation == generation && room.peers.contains_key(&sender))
        else {
            return Vec::new();
        };
        if !room.has_live_host() {
            return vec![HOST_PEER_ID];
        }
        if room
            .peers
            .get(&sender)
            .is_some_and(|peer| peer.tx.is_closed())
        {
            return vec![sender];
        }
        room.peers
            .values()
            .filter(|peer| {
                if sender == HOST_PEER_ID {
                    peer.id != HOST_PEER_ID && (target == 0 || target == peer.id)
                } else {
                    peer.id == HOST_PEER_ID
                }
            })
            .map(|peer| (peer.id, peer.tx.clone()))
            .collect()
    };
    send_peer_frames(txs, RouteFrame::Binary(stamp_sender(bytes, sender)))
}

/// All producers use the same admission operation, including relay controls.
/// Failures retire transport; opaque encrypted frames are never conflated.
pub(super) fn send_peer_frames(
    peers: Vec<(u32, relay_output::Sender)>,
    frame: RouteFrame,
) -> Vec<u32> {
    let mut failed = Vec::new();
    for (id, tx) in peers {
        if let Err(error) = tx.send(frame.clone()) {
            warn!(peer = id, ?error, "collab relay peer output unavailable");
            failed.push(id);
        }
    }
    failed
}

/// Forward a router-generated control to current-generation peers except sender.
pub(super) fn route_frame(
    rooms: &Arc<Mutex<HashMap<String, RelayRoom>>>,
    room_id: &str,
    generation: u64,
    sender: u32,
    frame: RouteFrame,
) -> Vec<u32> {
    let txs = {
        let rooms = rooms.lock().unwrap_or_else(|p| p.into_inner());
        let Some(room) = rooms
            .get(room_id)
            .filter(|room| room.generation == generation)
        else {
            return Vec::new();
        };
        if !room.has_live_host() {
            return vec![HOST_PEER_ID];
        }
        room.peers
            .values()
            .filter(|p| p.id != sender)
            .map(|p| (p.id, p.tx.clone()))
            .collect()
    };
    send_peer_frames(txs, frame)
}

/// Consume the exact current guest value: admission closes under registry
/// ownership, while task cancellation happens after the mutex is released.
pub(super) fn remove_relay_guest(
    rooms: &Arc<Mutex<HashMap<String, RelayRoom>>>,
    room_id: &str,
    generation: u64,
    peer_id: u32,
) -> Option<String> {
    if peer_id == HOST_PEER_ID {
        return None;
    }
    let peer = {
        let mut rooms = rooms.lock().unwrap_or_else(|p| p.into_inner());
        let room = rooms
            .get_mut(room_id)
            .filter(|room| room.generation == generation)?;
        let peer = room.peers.remove(&peer_id)?;
        peer.tx.close();
        peer
    };
    peer.writer.abort();
    peer.reader.abort();
    Some(peer.name)
}

/// Peer-left can overflow another queue. Iterate instead of recursively routing
/// failures; each current guest is removed at most once. A failed host closes
/// every admission before returning to its caller's generation-fenced teardown.
pub(super) fn retire_failed_outputs(
    rooms: &Arc<Mutex<HashMap<String, RelayRoom>>>,
    room_id: &str,
    generation: u64,
    mut failed: Vec<u32>,
) -> bool {
    let mut scheduled: HashSet<u32> = failed.iter().copied().collect();
    failed.sort_unstable();
    failed.dedup();
    while let Some(peer_id) = failed.pop() {
        if peer_id == HOST_PEER_ID {
            let rooms = rooms.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(room) = rooms
                .get(room_id)
                .filter(|room| room.generation == generation)
            {
                room.close_outputs();
                return true;
            }
            return false;
        }
        if let Some(name) = remove_relay_guest(rooms, room_id, generation, peer_id) {
            let left = json!({ "t": "peer-left", "peer": { "id": peer_id, "name": name } });
            for id in route_frame(
                rooms,
                room_id,
                generation,
                peer_id,
                RouteFrame::Text(left.to_string().into()),
            ) {
                if scheduled.insert(id) {
                    failed.push(id);
                }
            }
            info!(
                room = room_id,
                peer = peer_id,
                "collab relay guest output retired"
            );
        }
    }
    false
}

/// One room's routing lifetime: route binary envelopes host↔guests using the
/// socket sender and host destination, let the router emit
/// `peer-joined` / `peer-left` control frames, and tear the whole room down
/// when the host leaves or the room is replaced by a host reconnect. (The
/// host-connect auto-tap is spawned by `join_as_host`, which owns the room
/// entry's insertion.)
async fn relay_room_task(
    room_id: String,
    hub: Arc<WsHub>,
    delta: Arc<DeltaEncoder>,
    rooms: Arc<Mutex<HashMap<String, RelayRoom>>>,
    generation: u64,
    mut shutdown: watch::Receiver<bool>,
    mut events: mpsc::UnboundedReceiver<PeerEvent>,
) {
    let mut teardown: Option<String> = None;
    while teardown.is_none() {
        tokio::select! {
            _ = shutdown.changed() => teardown = Some("room replaced".to_string()),
            ev = events.recv() => match ev {
                None => teardown = Some("all peers disconnected".to_string()),
                Some(PeerEvent::Frame { peer_id, frame }) => match frame {
                    RouteFrame::Binary(bytes) => {
                        let failed = route_binary_frame(&rooms, &room_id, generation, peer_id, bytes);
                        if retire_failed_outputs(&rooms, &room_id, generation, failed) {
                            teardown = Some("host output unavailable".to_string());
                        }
                    }
                    RouteFrame::Text(text) => {
                        // Incoming text is relay control; the only one acted
                        // on is the host's room-closed (host-initiated
                        // teardown). Peer announcements are router-generated.
                        if peer_id == HOST_PEER_ID
                            && let Ok(v) = serde_json::from_str::<Value>(&text)
                                && v.get("t").and_then(Value::as_str) == Some("room-closed") {
                                    teardown = Some("room closed by host".to_string());
                                }
                    }
                    RouteFrame::Close(_) => {}
                },
                Some(PeerEvent::Gone { peer_id }) => {
                    if peer_id == HOST_PEER_ID {
                        // The room dies with its host: close every remaining
                        // peer (below) — a new host connect registers fresh.
                        teardown = Some("host left".to_string());
                        continue;
                    }
                    if let Some(name) = remove_relay_guest(&rooms, &room_id, generation, peer_id) {
                        let left = json!({ "t": "peer-left", "peer": { "id": peer_id, "name": name } }).to_string();
                        let failed = route_frame(&rooms, &room_id, generation, peer_id, RouteFrame::Text(left.into()));
                        if retire_failed_outputs(&rooms, &room_id, generation, failed) {
                            teardown = Some("host output unavailable".to_string());
                        }
                        info!(room = %room_id, peer = peer_id, "collab relay guest left");
                    }
                }
            }
        }
    }
    teardown_room(
        &rooms,
        &room_id,
        generation,
        &delta,
        &hub,
        teardown.as_deref().unwrap_or(""),
    );
}

/// Teardown for a relay room: remove the registry entry (only if it is still
/// `generation` — a newer host must never be removed by the old task's
/// cleanup), close every remaining peer socket (the tap is a guest here, so
/// its client connection ends with it), and broadcast the stream-lost notice
/// to the session's phone clients when a session was mapped. The tap's own
/// teardown stays silent because the entry is already gone.
pub(super) fn teardown_room(
    rooms: &Arc<Mutex<HashMap<String, RelayRoom>>>,
    room_id: &str,
    generation: u64,
    delta: &DeltaEncoder,
    hub: &WsHub,
    reason: &str,
) {
    let room = {
        let mut g = match rooms.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if g.get(room_id).is_some_and(|r| r.generation == generation) {
            match g.remove(room_id) {
                Some(room) => {
                    // Best effort only: cancellation below never waits for a
                    // blocked writer to deliver this queued close.
                    for peer in room.peers.values() {
                        let _ = peer.tx.send(RouteFrame::Close(4001));
                    }
                    room.close_outputs();
                    let _ = room.notify.send(true);
                    room
                }
                // Removed between the check and the remove — nothing left.
                None => return,
            }
        } else {
            // Replaced by a newer host — its task owns cleanup.
            return;
        }
    };
    let session = room.session_path.as_deref().map(str::to_string);
    if let Some(session) = &session {
        broadcast_notice(delta, hub, session, "collab relay: stream lost");
    }
    // Teardown can also originate in guest admission when peer-joined
    // overflows the host. Do not detach that removed room's router.
    room.task.abort();
    // Abort every peer without waiting for its best-effort queued close.
    for (_, peer) in room.peers {
        peer.writer.abort();
        peer.reader.abort();
    }
    info!(room = room_id, reason = reason, session = ?session, "collab relay room dropped");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::omp::collab::tests::{test_config, test_push};
    use std::time::Duration;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::protocol::Message;

    fn isolated_relay_manager() -> (Arc<RelayManager>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-relay-admission-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let mut config = test_config();
        config.state_dir = dir.clone();
        config.home = dir.clone();
        config.sessions_root = dir.clone();
        config.vapid_path = dir.join("vapid.json");
        config.push_store_path = dir.join("push.json");
        let config = Arc::new(config);
        // Never publish this fixture through the process-global manager.
        let manager = Arc::new(RelayManager {
            listeners: Mutex::new(HashSet::new()),
            hub: WsHub::new(config.clone()),
            delta: DeltaEncoder::new(),
            push: test_push(&config),
            config,
            rooms: Arc::new(Mutex::new(HashMap::new())),
            next_gen: AtomicU64::new(1),
            next_peer: AtomicU32::new(2),
            links: Arc::new(LinkRegistry {
                path: dir.join("collab.json"),
                map: Mutex::new(HashMap::new()),
                by_room: Mutex::new(HashMap::new()),
            }),
        });
        (manager, dir)
    }

    const SOCKET_ROOM: &str = "relayfixture0001";
    type RelayClient = tokio_tungstenite::WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

    struct RelaySocketFixture {
        manager: Arc<RelayManager>,
        dir: std::path::PathBuf,
        address: std::net::SocketAddr,
        server: tokio::task::JoinHandle<()>,
        admissions: mpsc::UnboundedReceiver<(Option<usize>, Result<(), String>)>,
    }

    impl RelaySocketFixture {
        async fn new() -> Self {
            use axum::extract::{Query, ws::WebSocketUpgrade};
            use axum::routing::get;

            let (manager, dir) = isolated_relay_manager();
            let route_manager = manager.clone();
            let (admitted, admissions) = mpsc::unbounded_channel();
            let router = axum::Router::new().route(
                "/r/relayfixture0001",
                get(
                    move |ws: WebSocketUpgrade, Query(params): Query<HashMap<String, String>>| {
                        let manager = route_manager.clone();
                        let admitted = admitted.clone();
                        async move {
                            ws.on_upgrade(move |socket| async move {
                                let claim = params.get("claim").map(|value| value.parse().unwrap());
                                let result = manager
                                    .handle_ws(
                                        socket,
                                        SOCKET_ROOM,
                                        "",
                                        params.get("role").map(String::as_str),
                                    )
                                    .await;
                                let _ = admitted.send((claim, result));
                            })
                        }
                    },
                ),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            manager.register_listener(address);
            let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            Self {
                manager,
                dir,
                address,
                server,
                admissions,
            }
        }

        async fn connect(&self, role: &str) -> RelayClient {
            connect_async(format!("ws://{}/r/{SOCKET_ROOM}?role={role}", self.address))
                .await
                .unwrap()
                .0
        }

        async fn admitted(&mut self) {
            let (claim, result) = self.admissions.recv().await.unwrap();
            assert!(claim.is_none());
            result.unwrap();
        }
    }

    impl Drop for RelaySocketFixture {
        fn drop(&mut self) {
            let generation = self
                .manager
                .rooms
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(SOCKET_ROOM)
                .map(|room| room.generation);
            if let Some(generation) = generation {
                teardown_room(
                    &self.manager.rooms,
                    SOCKET_ROOM,
                    generation,
                    &self.manager.delta,
                    &self.manager.hub,
                    "test cleanup",
                );
            }
            self.server.abort();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn socket_binary(socket: &mut RelayClient) -> Bytes {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Binary(bytes) => return bytes,
                Message::Text(_) => {}
                other => panic!("expected relay traffic, received {other:?}"),
            }
        }
    }

    async fn assert_host_conflict(socket: &mut RelayClient) {
        let Message::Close(Some(close)) = socket.next().await.unwrap().unwrap() else {
            panic!("contending host must receive an explicit close");
        };
        assert_eq!(u16::from(close.code), 4009);
        assert_eq!(close.reason.as_str(), "host conflict");
    }

    #[test]
    fn router_stamps_sender_peer_id() {
        // Guests send peer id 0; the relay rewrites it to the sender's id.
        let frame = stamp_sender(pack_envelope(0, vec![1, 2, 3]).into(), 7);
        let (peer, payload) = unpack_envelope(&frame).unwrap();
        assert_eq!(peer, 7);
        assert_eq!(payload, &[1, 2, 3]);

        // Claimed host or other guest identities never survive normalization.
        let frame = stamp_sender(pack_envelope(1, vec![9]).into(), 7);
        let (peer, _) = unpack_envelope(&frame).unwrap();
        assert_eq!(peer, 7);
        let frame = stamp_sender(pack_envelope(99, vec![9]).into(), 7);
        assert_eq!(unpack_envelope(&frame).unwrap().0, 7);

        // Shared buffers keep the original prefix; only the routed copy changes.
        let original: Bytes = pack_envelope(1, vec![9]).into();
        let stamped = stamp_sender(original.clone(), 7);
        assert_eq!(unpack_envelope(&original).unwrap().0, 1);
        assert_eq!(unpack_envelope(&stamped).unwrap().0, 7);

        // Too-short frames are left alone.
        let tiny = stamp_sender(Bytes::from_static(&[0, 0]), 7);
        assert_eq!(tiny, vec![0, 0]);
    }

    struct RelayRoutingFixture {
        rooms: Arc<Mutex<HashMap<String, RelayRoom>>>,
        receivers: HashMap<u32, relay_output::Receiver>,
    }

    impl RelayRoutingFixture {
        fn new(generation: u64) -> Self {
            let mut peers = HashMap::new();
            let mut receivers = HashMap::new();
            for id in [HOST_PEER_ID, 2, 3] {
                let (tx, rx) = relay_output::channel();
                receivers.insert(id, rx);
                peers.insert(
                    id,
                    RelayPeer {
                        id,
                        name: id.to_string(),
                        tx,
                        writer: tokio::spawn(async {}),
                        reader: tokio::spawn(async {}),
                    },
                );
            }
            let (notify, _) = watch::channel(false);
            let (events, _) = mpsc::unbounded_channel();
            let room = RelayRoom {
                generation,
                session_path: None,
                notify,
                task: tokio::spawn(async {}),
                events,
                peers,
                tap_gen: 0,
            };
            Self {
                rooms: Arc::new(Mutex::new(HashMap::from([("room".to_owned(), room)]))),
                receivers,
            }
        }

        fn binary(&mut self, peer: u32) -> Bytes {
            match self
                .receivers
                .get_mut(&peer)
                .unwrap()
                .try_recv()
                .unwrap()
                .frame
            {
                RouteFrame::Binary(bytes) => bytes,
                _ => panic!("expected binary envelope"),
            }
        }

        fn assert_empty(&mut self) {
            for receiver in self.receivers.values_mut() {
                assert!(receiver.try_recv().is_err(), "unexpected routed frame");
            }
        }
    }

    #[tokio::test]
    async fn router_host_broadcast_and_target_keep_ciphertext_and_pulse_identity() {
        let mut fixture = RelayRoutingFixture::new(7);
        let codec = Codec::new(&[7; 32]).unwrap();
        let agents = json!({"t":"agents", "agents":[]});
        let sealed = codec.seal(&agents).unwrap();
        route_binary_frame(
            &fixture.rooms,
            "room",
            7,
            HOST_PEER_ID,
            pack_envelope(0, sealed.clone()).into(),
        );
        for guest in [2, 3] {
            let bytes = fixture.binary(guest);
            let (sender, payload) = unpack_envelope(&bytes).unwrap();
            assert_eq!(sender, HOST_PEER_ID);
            assert_eq!(payload, sealed);
            assert_eq!(codec.open(payload).unwrap(), agents);
        }
        fixture.assert_empty();

        let welcome = json!({"t":"welcome", "header":{"id":"session"}, "agents":[]});
        let sealed = codec.seal(&welcome).unwrap();
        route_binary_frame(
            &fixture.rooms,
            "room",
            7,
            HOST_PEER_ID,
            pack_envelope(3, sealed.clone()).into(),
        );
        let bytes = fixture.binary(3);
        let (sender, payload) = unpack_envelope(&bytes).unwrap();
        assert_eq!(sender, HOST_PEER_ID);
        assert_eq!(payload, sealed);
        assert_eq!(codec.open(payload).unwrap(), welcome);
        fixture.assert_empty();

        // Pulse's existing receiver accepts normalized local host frames, and
        // still rejects them once its source has retired. Routing grants no
        // additional ownership or source lifetime.
        let registry = Arc::new(SessionStateRegistry::default());
        let session = "/synthetic/router-source-identity.jsonl";
        let mut source =
            CollabEventSource::begin(session, "room", 7, false, Some(registry.clone()));
        assert!(source.accept_frame(sender, &agents));
        registry.retire_source(session, &source.identity);
        assert!(!source.accept_frame(sender, &agents));
    }

    #[tokio::test]
    async fn router_guest_claims_reach_only_host_with_actual_sender() {
        let mut fixture = RelayRoutingFixture::new(7);
        let codec = Codec::new(&[7; 32]).unwrap();
        for claimed in [0, HOST_PEER_ID, 2, 3, u32::MAX] {
            // A room-key holder can seal these host-shaped frames. The socket
            // route must still keep them away from the tap and all other guests.
            for payload in [
                json!({"t":"welcome", "agents":[]}),
                json!({"t":"agents", "agents":[{"id":"forged"}]}),
                json!({"t":"hello", "proto":COLLAB_PROTO}),
            ] {
                let sealed = codec.seal(&payload).unwrap();
                route_binary_frame(
                    &fixture.rooms,
                    "room",
                    7,
                    2,
                    pack_envelope(claimed, sealed.clone()).into(),
                );
                let bytes = fixture.binary(HOST_PEER_ID);
                let (sender, received) = unpack_envelope(&bytes).unwrap();
                assert_eq!(sender, 2);
                assert_eq!(received, sealed);
                assert_eq!(codec.open(received).unwrap(), payload);
                fixture.assert_empty();
            }
        }
    }

    #[tokio::test]
    async fn router_rejects_unknown_senders_invalid_targets_and_truncated_envelopes() {
        let mut fixture = RelayRoutingFixture::new(7);
        for (room, generation, sender, target) in [
            ("room", 7, 99, 0),
            ("room", 7, HOST_PEER_ID, HOST_PEER_ID),
            ("room", 7, HOST_PEER_ID, 99),
            ("room", 6, HOST_PEER_ID, 0),
            ("room", 8, 2, 0),
            ("missing", 7, HOST_PEER_ID, 0),
        ] {
            route_binary_frame(
                &fixture.rooms,
                room,
                generation,
                sender,
                pack_envelope(target, vec![9]).into(),
            );
        }
        for sender in [HOST_PEER_ID, 2] {
            for length in 0..ENVELOPE_HEADER_LENGTH {
                route_binary_frame(
                    &fixture.rooms,
                    "room",
                    7,
                    sender,
                    Bytes::from(vec![0; length]),
                );
            }
        }
        fixture.assert_empty();
        fixture
            .rooms
            .lock()
            .unwrap()
            .get_mut("room")
            .unwrap()
            .peers
            .remove(&2);
        route_binary_frame(
            &fixture.rooms,
            "room",
            7,
            2,
            pack_envelope(0, vec![9]).into(),
        );
        fixture.assert_empty();
    }

    #[tokio::test]
    async fn router_old_room_handle_cannot_deliver_to_replacement_peers() {
        let mut old = RelayRoutingFixture::new(7);
        let mut replacement = RelayRoutingFixture::new(8);
        let old_handle = old.rooms.clone();
        let room = replacement.rooms.lock().unwrap().remove("room").unwrap();
        old.rooms.lock().unwrap().insert("room".into(), room);
        replacement.rooms = old.rooms.clone();
        // Both generations have host1 and guest2: peer membership alone cannot
        // distinguish an old queued event from this room's live connection.
        for sender in [HOST_PEER_ID, 2] {
            route_binary_frame(
                &old_handle,
                "room",
                7,
                sender,
                pack_envelope(0, vec![9]).into(),
            );
        }
        old.assert_empty();
        replacement.assert_empty();
        route_binary_frame(
            &replacement.rooms,
            "room",
            8,
            HOST_PEER_ID,
            pack_envelope(2, vec![8]).into(),
        );
        assert_eq!(unpack_envelope(&replacement.binary(2)).unwrap().1, &[8]);
        replacement.assert_empty();
    }

    #[tokio::test]
    async fn router_host_disconnect_retires_the_room_before_more_binary_delivery() {
        let mut fixture = RelayRoutingFixture::new(7);
        let hub = WsHub::new(Arc::new(test_config()));
        let delta = DeltaEncoder::new();
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        events_tx
            .send(PeerEvent::Gone {
                peer_id: HOST_PEER_ID,
            })
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            relay_room_task(
                "room".to_owned(),
                hub,
                delta,
                fixture.rooms.clone(),
                7,
                shutdown_rx,
                events_rx,
            ),
        )
        .await
        .expect("host disconnect retires the isolated room");
        assert!(fixture.rooms.lock().unwrap().is_empty());
        for receiver in fixture.receivers.values_mut() {
            assert!(matches!(
                receiver.try_recv().unwrap().frame,
                RouteFrame::Close(4001)
            ));
        }
        for sender in [HOST_PEER_ID, 2] {
            route_binary_frame(
                &fixture.rooms,
                "room",
                7,
                sender,
                pack_envelope(0, vec![9]).into(),
            );
        }
        fixture.assert_empty();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn router_immediate_guest_hello_is_admitted_before_routing() {
        use axum::extract::ws::WebSocketUpgrade;
        use axum::routing::get;

        tokio::time::timeout(Duration::from_secs(5), async {
            let (manager, dir) = isolated_relay_manager();
            let host_manager = manager.clone();
            let guest_manager = manager.clone();
            let (host_ready_tx, host_ready_rx) = oneshot::channel();
            let host_ready = Arc::new(Mutex::new(Some(host_ready_tx)));
            let router = axum::Router::new()
                .route(
                    "/host",
                    get(move |ws: WebSocketUpgrade| {
                        let manager = host_manager.clone();
                        let ready = host_ready.clone();
                        async move {
                            ws.on_upgrade(move |socket| async move {
                                manager.join_as_host(socket, "room").await.unwrap();
                                let _ = ready.lock().unwrap().take().unwrap().send(());
                            })
                        }
                    }),
                )
                .route(
                    "/guest",
                    get(move |ws: WebSocketUpgrade| {
                        let manager = guest_manager.clone();
                        async move {
                            ws.on_upgrade(move |socket| async move {
                                manager.join_as_guest(socket, "room").await.unwrap();
                            })
                        }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            let (mut host, _) = connect_async(format!("ws://{address}/host")).await.unwrap();
            host_ready_rx.await.unwrap();
            for expected_peer in 2..10 {
                let (mut guest, _) = connect_async(format!("ws://{address}/guest"))
                    .await
                    .unwrap();
                guest
                    .send(Message::binary(pack_envelope(0, vec![expected_peer as u8])))
                    .await
                    .unwrap();
                loop {
                    if let Message::Binary(bytes) = host.next().await.unwrap().unwrap() {
                        assert_eq!(
                            unpack_envelope(&bytes),
                            Some((expected_peer, &[expected_peer as u8][..]))
                        );
                        break;
                    }
                }
                guest.close(None).await.unwrap();
            }
            host.close(None).await.unwrap();
            // Deterministic cleanup even if the close is still queued in the
            // room task; no live daemon, real session, or OMP child is involved.
            teardown_room(
                &manager.rooms,
                "room",
                1,
                &manager.delta,
                &manager.hub,
                "test cleanup",
            );
            server.abort();
            let _ = server.await;
            drop(manager);
            std::fs::remove_dir_all(dir).unwrap();
        })
        .await
        .expect("immediate hello reaches the isolated host");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relay_host_conflict_preserves_host_guest_and_auto_tap() {
        use base64::Engine as _;

        tokio::time::timeout(Duration::from_secs(5), async {
            let mut fixture = RelaySocketFixture::new().await;
            let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
            fixture
                .manager
                .links
                .register_room_link(&format!("ws://{}/r/{SOCKET_ROOM}.{key}", fixture.address))
                .unwrap();
            let codec = Codec::new(&[7; 32]).unwrap();
            let mut host = fixture.connect("host").await;
            fixture.admitted().await;
            // Exercise a real auto-tap socket, waiting for its host welcome.
            // No real session or process-global collab manager is involved.
            let hello = socket_binary(&mut host).await;
            let (tap_id, payload) = unpack_envelope(&hello).unwrap();
            assert_eq!(codec.open(payload).unwrap()["t"], "hello");
            fixture.admitted().await;
            let mut guest = fixture.connect("guest").await;
            fixture.admitted().await;
            let route = fixture.manager.capture_read_route(SOCKET_ROOM).unwrap();
            assert!(route.verifies(&guest));
            let (generation, mut closed) = {
                let rooms = fixture
                    .manager
                    .rooms
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                let room = rooms.get(SOCKET_ROOM).unwrap();
                assert_eq!(room.tap_gen, 1);
                assert_eq!(room.peers.len(), 3);
                (room.generation, room.notify.subscribe())
            };

            // The attacker sends neither authentication nor application frames.
            let mut contender = fixture.connect("host").await;
            let (_, result) = fixture.admissions.recv().await.unwrap();
            assert!(result.unwrap_err().contains("already has a host"));
            assert_host_conflict(&mut contender).await;
            assert!(!*closed.borrow_and_update());
            assert!(!closed.has_changed().unwrap());
            assert!(route.verifies(&guest));
            {
                let rooms = fixture
                    .manager
                    .rooms
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                let room = rooms.get(SOCKET_ROOM).unwrap();
                assert_eq!(room.generation, generation);
                assert_eq!(room.tap_gen, 1);
                assert_eq!(room.peers.len(), 3);
                assert!(room.peers.contains_key(&tap_id));
                assert!(!room.task.is_finished());
                for peer in room.peers.values() {
                    assert!(!peer.tx.is_closed());
                    assert!(!peer.reader.is_finished());
                    assert!(!peer.writer.is_finished());
                }
            }
            // A refusal consumes neither a room generation nor a peer id.
            assert_eq!(fixture.manager.next_gen.load(Ordering::Relaxed), 2);
            assert_eq!(fixture.manager.next_peer.load(Ordering::Relaxed), 4);
            let ciphertext = codec.seal(&json!({"t":"probe","from":"guest"})).unwrap();
            guest
                .send(Message::binary(pack_envelope(0, ciphertext.clone())))
                .await
                .unwrap();
            let received = socket_binary(&mut host).await;
            let (guest_id, payload) = unpack_envelope(&received).unwrap();
            assert_ne!(guest_id, tap_id);
            assert_eq!(payload, ciphertext.as_slice());
            let ciphertext = codec.seal(&json!({"t":"probe","from":"host"})).unwrap();
            host.send(Message::binary(pack_envelope(guest_id, ciphertext.clone())))
                .await
                .unwrap();
            assert_eq!(
                unpack_envelope(&socket_binary(&mut guest).await),
                Some((HOST_PEER_ID, ciphertext.as_slice()))
            );
        })
        .await
        .expect("a bare duplicate host cannot disrupt the room or its traffic");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relay_host_reconnects_after_departure_and_ignores_stale_generation() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut fixture = RelaySocketFixture::new().await;
            let mut host = fixture.connect("host").await;
            fixture.admitted().await;
            let old_guest = fixture.connect("guest").await;
            fixture.admitted().await;
            let old_route = fixture.manager.capture_read_route(SOCKET_ROOM).unwrap();
            let old_generation = fixture
                .manager
                .rooms
                .lock()
                .unwrap_or_else(|p| p.into_inner())[SOCKET_ROOM]
                .generation;
            host.close(None).await.unwrap();
            while fixture
                .manager
                .rooms
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains_key(SOCKET_ROOM)
            {
                tokio::task::yield_now().await;
            }
            assert!(!old_route.verifies(&old_guest));

            let mut host = fixture.connect("host").await;
            fixture.admitted().await;
            let mut guest = fixture.connect("guest").await;
            fixture.admitted().await;
            let generation = fixture
                .manager
                .rooms
                .lock()
                .unwrap_or_else(|p| p.into_inner())[SOCKET_ROOM]
                .generation;
            assert!(generation > old_generation);
            // Delayed teardown and queued frames from the departed generation
            // must not remove or deliver into the newly admitted room.
            teardown_room(
                &fixture.manager.rooms,
                SOCKET_ROOM,
                old_generation,
                &fixture.manager.delta,
                &fixture.manager.hub,
                "delayed old host cleanup",
            );
            route_binary_frame(
                &fixture.manager.rooms,
                SOCKET_ROOM,
                old_generation,
                HOST_PEER_ID,
                pack_envelope(0, vec![99]).into(),
            );
            host.send(Message::binary(pack_envelope(0, vec![2])))
                .await
                .unwrap();
            assert_eq!(
                unpack_envelope(&socket_binary(&mut guest).await),
                Some((HOST_PEER_ID, &[2][..]))
            );
            guest
                .send(Message::binary(pack_envelope(0, vec![3])))
                .await
                .unwrap();
            assert_eq!(
                unpack_envelope(&socket_binary(&mut host).await).unwrap().1,
                &[3]
            );
            assert_eq!(
                fixture
                    .manager
                    .rooms
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())[SOCKET_ROOM]
                    .generation,
                generation
            );
        })
        .await
        .expect("a departed host can reconnect without stale-generation interference");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relay_stale_host_replacement_cancels_only_the_stale_room_tasks() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut fixture = RelaySocketFixture::new().await;
            let _old_host = fixture.connect("host").await;
            fixture.admitted().await;
            let _old_guest = fixture.connect("guest").await;
            fixture.admitted().await;
            let (old_generation, mut closed, old_tasks) = {
                let rooms = fixture
                    .manager
                    .rooms
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                let room = rooms.get(SOCKET_ROOM).unwrap();
                // Match an unavailable host output whose Gone event has not
                // reached the router yet: the stale registry entry remains.
                room.peers[&HOST_PEER_ID].tx.close();
                assert!(!room.has_live_host());
                let mut tasks = vec![room.task.abort_handle()];
                for peer in room.peers.values() {
                    tasks.extend([peer.reader.abort_handle(), peer.writer.abort_handle()]);
                }
                (room.generation, room.notify.subscribe(), tasks)
            };
            let mut host = fixture.connect("host").await;
            fixture.admitted().await;
            closed.changed().await.unwrap();
            assert!(*closed.borrow());
            while old_tasks.iter().any(|task| !task.is_finished()) {
                tokio::task::yield_now().await;
            }
            let generation = fixture
                .manager
                .rooms
                .lock()
                .unwrap_or_else(|p| p.into_inner())[SOCKET_ROOM]
                .generation;
            assert!(generation > old_generation);
            let mut guest = fixture.connect("guest").await;
            fixture.admitted().await;
            host.send(Message::binary(pack_envelope(0, vec![8])))
                .await
                .unwrap();
            assert_eq!(
                unpack_envelope(&socket_binary(&mut guest).await),
                Some((HOST_PEER_ID, &[8][..]))
            );
            assert!(
                fixture
                    .manager
                    .rooms
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())[SOCKET_ROOM]
                    .has_live_host()
            );
        })
        .await
        .expect("stale host cleanup cannot cancel the newly admitted room");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relay_concurrent_host_claims_admit_exactly_one_live_host() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut fixture = RelaySocketFixture::new().await;
            let connections = futures_util::future::join_all((0..8).map(|claim| {
                connect_async(format!(
                    "ws://{}/r/{SOCKET_ROOM}?role=host&claim={claim}",
                    fixture.address
                ))
            }))
            .await;
            let mut hosts: Vec<_> = connections
                .into_iter()
                .map(|connection| connection.unwrap().0)
                .collect();
            let mut winner = None;
            for _ in 0..hosts.len() {
                let (claim, result) = fixture.admissions.recv().await.unwrap();
                let claim = claim.unwrap();
                if result.is_ok() {
                    assert!(winner.replace(claim).is_none(), "two hosts were admitted");
                } else {
                    assert_host_conflict(&mut hosts[claim]).await;
                }
            }
            let winner = winner.expect("one concurrent claimant must be admitted");
            {
                let rooms = fixture
                    .manager
                    .rooms
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                let room = rooms.get(SOCKET_ROOM).unwrap();
                assert_eq!(room.generation, 1);
                assert_eq!(room.peers.len(), 1);
                assert!(room.has_live_host());
            }
            assert_eq!(fixture.manager.next_gen.load(Ordering::Relaxed), 2);
            let mut guest = fixture.connect("guest").await;
            fixture.admitted().await;
            hosts[winner]
                .send(Message::binary(pack_envelope(0, vec![7])))
                .await
                .unwrap();
            assert_eq!(
                unpack_envelope(&socket_binary(&mut guest).await),
                Some((HOST_PEER_ID, &[7][..]))
            );
            guest
                .send(Message::binary(pack_envelope(0, vec![6])))
                .await
                .unwrap();
            assert_eq!(
                unpack_envelope(&socket_binary(&mut hosts[winner]).await),
                Some((2, &[6][..]))
            );
        })
        .await
        .expect("concurrent room claims publish one host and explicitly refuse the rest");
    }
}
