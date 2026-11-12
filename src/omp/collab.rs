//! Collab: the encrypted guest attach to a relay room (forward live frames
//! into the WsHub) PLUS the SELF-HOSTED relay that replaces the my.omp.sh
//! dependency. The omp relay client connects to `/r/<roomId>` — a 22-char
//! base64url room id and NOTHING else; the room key lives only in the
//! in-process client object (relay-client.ts: `new WebSocket(url +
//! "?role=" + role)`). A relay can never decrypt frames, so this daemon's
//! relay is a PURE FRAME ROUTER between peers, and the tap that feeds the
//! phone hub is an INTERNAL GUEST: a real tokio-tungstenite client to our
//! own relay that carries the key from a stored link and reuses the proven
//! guest join/decrypt machinery.
//!
//! Wire behavior mirrors the omp coding-agent collab sources
//! (`packages/coding-agent/src/collab/{protocol,crypto,relay-client,guest}.ts`):
//! a share link packs a base64url room key (32 bytes) plus an optional write
//! token (16 bytes) into `<roomId>.<secret>`; every session frame travels
//! inside an AES-256-GCM seal with a 4-byte big-endian routing prefix.
//! A host's prefix selects all guests (0) or one guest; guest frames go only
//! to the host. Our relay then stamps the actual socket sender's assigned
//! id (host = 1, guests = 2,3,…) for the internal guest; plaintext TEXT
//! frames are relay control (`peer-joined`,
//! `peer-left`). The guest side (CollabManager + the internal tap): parse
//! the link, join the room, DISCARD the snapshot (history arrives over
//! REST), and mirror live frames to the phone WS hub. Reconnects use the
//! relay-client backoff policy; decryption failures, fatal relay close
//! codes, and `room-closed` are terminal (never reconnect).
mod fanout;
mod guest;
mod guest_liveness;
mod manager;
mod pending;
mod registry;
mod relay;
mod relay_output;
mod relay_tap;
mod transcript;

use fanout::*;
use guest::*;
use pending::*;
use registry::*;
use relay::*;
use relay_tap::*;

pub use pending::{collab_ui_snapshot, pending_collab_ui_request, sessions_awaiting_ui};
pub use transcript::{
    Chunk as TranscriptChunk, Error as TranscriptError, MAX_SAFE_CURSOR, valid_request,
};

use crate::authority::session_state::{
    Confidence, Connection, Seed, SessionStateRegistry, SourceIdentity, SourceKind, SourceStamp,
    Turn,
};
use crate::server::delta::DeltaEncoder;
use crate::server::push::Push;
use crate::server::ws::WsHub;
use crate::types::SharedConfig;

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, KeyInit, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::{Rng, rng};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

static SESSION_AUTHORITY: OnceLock<Arc<SessionStateRegistry>> = OnceLock::new();
static NEXT_COLLAB_SOURCE_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_COLLAB_SOURCES: std::sync::LazyLock<Mutex<HashMap<String, SourceStamp>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Install the daemon's canonical session authority before collab transports
/// start. Repeated initialization is harmless; the first daemon registry wins.
pub fn init_authority(authority: Arc<SessionStateRegistry>) {
    let _ = SESSION_AUTHORITY.set(authority);
}
pub fn authority_snapshot(session_path: &str) -> Option<(SourceStamp, bool)> {
    CollabManager::current()?.authority_snapshot(session_path)
}
struct CollabEventSource {
    session: String,
    identity: SourceIdentity,
    sequence: u64,
    authority: Option<Arc<SessionStateRegistry>>,
    registered: bool,
    transcript: Option<transcript::ReadConnection>,
}

impl CollabEventSource {
    fn begin(
        session: &str,
        room_id: &str,
        binding_epoch: u64,
        can_write: bool,
        authority: Option<Arc<SessionStateRegistry>>,
    ) -> Self {
        let identity = SourceIdentity {
            kind: SourceKind::Collab,
            source_id: NEXT_COLLAB_SOURCE_ID.fetch_add(1, Ordering::Relaxed),
            binding_epoch,
            pid: None,
            process_start: None,
            peer_id: Some(HOST_PEER_ID.to_string()),
            room_id: Some(room_id.to_owned()),
            can_write: Some(can_write),
        };
        let mut registered = false;
        if let Some(registry) = &authority
            && !verified_live_bridge_mirror(registry, session)
        {
            let previous = registry.current(session).filter(|state| {
                state.owner.kind == "collab"
                    && state.owner.room_id.as_deref() == Some(room_id)
                    && state.owner.peer_id.as_deref() == Some("1")
            });
            registry.project(
                session,
                Seed {
                    owner: identity.wire_owner(),
                    turn: previous.as_ref().map_or(Turn::Unknown, |state| state.turn),
                    confidence: previous
                        .as_ref()
                        .map_or(Confidence::Inferred, |state| state.confidence),
                    connection: Connection::Connected,
                    activity: previous.and_then(|state| state.activity),
                    capabilities: SessionStateRegistry::capabilities_for(&identity),
                    source: Some(identity.clone()),
                    sequence: 0,
                },
            );
            registered = registry
                .source_snapshot(session)
                .is_some_and(|stamp| stamp.identity == identity);
            if registered {
                let mut sources = ACTIVE_COLLAB_SOURCES
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                sources.insert(
                    session.to_owned(),
                    SourceStamp {
                        identity: identity.clone(),
                        sequence: 0,
                    },
                );
            }
        }
        Self {
            session: session.to_owned(),
            identity,
            sequence: 0,
            authority,
            registered,
            transcript: None,
        }
    }

    fn is_current(&self) -> bool {
        self.authority.as_ref().is_none_or(|registry| {
            let source_matches = registry
                .source_snapshot(&self.session)
                .is_some_and(|stamp| stamp.identity == self.identity);
            source_matches
                && registry.current(&self.session).is_some_and(|state| {
                    state.connection == Connection::Connected
                        && state.owner == self.identity.wire_owner()
                })
        })
    }

    fn accept_frame(&mut self, peer_id: u32, frame: &Value) -> bool {
        if !self.is_current() || peer_id != HOST_PEER_ID {
            return false;
        }
        match frame.get("t").and_then(Value::as_str) {
            Some("event") => frame
                .get("event")
                .is_some_and(|event| self.accept_event(event)),
            Some("ui-request") => self.accept_event(&json!({
                "type": "collab_ui_request", "request": frame.get("request"),
            })),
            Some("ui-request-end") => self.accept_event(&json!({
                "type": "collab_ui_request_end", "reqId": frame.get("reqId"),
            })),
            _ => true,
        }
    }

    fn accept_event(&mut self, event: &Value) -> bool {
        if !self.is_current() {
            return false;
        }
        self.sequence = self.sequence.saturating_add(1);
        let stamp = SourceStamp {
            identity: self.identity.clone(),
            sequence: self.sequence,
        };
        let accepted = self
            .authority
            .as_ref()
            .is_none_or(|registry| registry.observe_event(&self.session, &stamp, event));
        if accepted {
            self.registered = true;
            if self.authority.is_some() {
                let mut sources = ACTIVE_COLLAB_SOURCES
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if sources
                    .get(&self.session)
                    .is_none_or(|current| current.identity == self.identity)
                {
                    sources.insert(self.session.clone(), stamp);
                }
            }
        }
        accepted
    }
}

impl Drop for CollabEventSource {
    fn drop(&mut self) {
        if self.registered
            && self.is_current()
            && let Some(registry) = &self.authority
        {
            registry.retire_source(&self.session, &self.identity);
        }
        let mut sources = ACTIVE_COLLAB_SOURCES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if sources
            .get(&self.session)
            .is_some_and(|stamp| stamp.identity == self.identity)
        {
            sources.remove(&self.session);
        }
    }
}

fn verified_live_bridge_mirror(registry: &SessionStateRegistry, session: &str) -> bool {
    let Some((bridge_stamp, _)) = crate::omp::bridge::authority_snapshot(session) else {
        return false;
    };
    if bridge_stamp.identity.kind != SourceKind::Bridge {
        return false;
    }
    let Some(current_stamp) = registry.source_snapshot(session) else {
        return false;
    };
    let Some(current) = registry.current(session) else {
        return false;
    };
    current_stamp.identity == bridge_stamp.identity
        && current.connection == Connection::Connected
        && current.owner == bridge_stamp.identity.wire_owner()
}
/// Wire protocol version carried in `hello`; the host rejects mismatches.
/// The shipping omp binary (17.2.12) speaks v3 — verified from the embedded
/// wire source (`Yd = 3`); the frame vocabulary we consume is unchanged.
const COLLAB_PROTO: u64 = 3;
/// Default public relay; bare `<roomId>.<key>` links resolve against it.
const DEFAULT_RELAY_URL: &str = "wss://my.omp.sh";
/// Plaintext envelope prefix: `[4B uint32 BE peerId][sealed payload]`.
const ENVELOPE_HEADER_LENGTH: usize = 4;
const ROOM_KEY_BYTES: usize = 32;
const WRITE_TOKEN_BYTES: usize = 16;
/// Sealed frame layout: `[12B random IV][AES-GCM ciphertext+tag]` (no AAD).
const IV_LENGTH: usize = 12;
/// How long the guest waits for the host's `welcome` (armed around connect).
const WELCOME_TIMEOUT_MS: u64 = 30_000;
/// Per-chunk budget while the snapshot chunk train streams in.
const SNAPSHOT_PROGRESS_TIMEOUT_MS: u64 = 30_000;
const BACKOFF_BASE_MS: u64 = 1_000;
const BACKOFF_MAX_MS: u64 = 30_000;
/// Guest display name sent in `hello`.
const GUEST_NAME: &str = "omp-pulse";
/// Host peer id: the first peer to register a room is the host; guests get
/// ids 2,3,… from the manager counter (mirrors relay-client.ts, which
/// assigns peer 1 to the room owner).
const HOST_PEER_ID: u32 = 1;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// One connection-lifetime outcome for the guest task.
enum End {
    /// Detach requested (or the manager dropped the frame sender).
    Shutdown,
    /// Terminal: no reconnect (bye, room-closed, fatal close code, decrypt
    /// failure, or a failed FIRST join).
    Fatal(String),
    /// Transient drop: reconnect with backoff while still attached.
    Transient(String),
}

/// A join-phase failure; `terminal` distinguishes hard rejections (room
/// gone, host conflict, bad key) from transient network drops.
struct JoinError {
    message: String,
    terminal: bool,
}

// ═══════════════════════════════════════════════════════════════════════════
// Link parsing (mirrors `parseCollabLink` from protocol.ts)
// ═══════════════════════════════════════════════════════════════════════════

pub(crate) struct ParsedLink {
    /// `ws://` or `wss://` host[:port]/r/<roomId> — no query, no fragment.
    ws_url: String,
    room_id: String,
    /// 32-byte raw AES-256-GCM room key.
    key: Vec<u8>,
    /// 16-byte write token from a full link; absent on view links.
    write_token: Option<Vec<u8>>,
}

/// base64url charset: `[A-Za-z0-9_-]`.
fn is_b64url_charset(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// Bare `<roomId>.<secret>` / legacy `<roomId>#<secret>` (whole string, no
/// `/`): both parts must be base64url charset, roomId 10..=64 chars.
fn split_bare(text: &str) -> Option<(&str, &str)> {
    if text.contains('/') {
        return None;
    }
    let sep = text.find(['#', '.'])?;
    let room = &text[..sep];
    let secret = &text[sep + 1..];
    if !is_b64url_charset(room) || room.len() < 10 || room.len() > 64 || !is_b64url_charset(secret)
    {
        return None;
    }
    Some((room, secret))
}

/// `/r/<roomId>` or `/r/<roomId>.<key>` — mirrors ROOM_PATH_RE.
fn parse_room_path(path: &str) -> Option<(&str, Option<&str>)> {
    let rest = path.strip_prefix("/r/")?;
    if rest.is_empty() {
        return None;
    }
    let (room, key) = match rest.find('.') {
        Some(p) => (&rest[..p], Some(&rest[p + 1..])),
        None => (rest, None),
    };
    if !is_b64url_charset(room) || room.len() < 10 || room.len() > 64 {
        return None;
    }
    if let Some(k) = key
        && !is_b64url_charset(k)
    {
        return None;
    }
    Some((room, key))
}

/// Split `scheme://rest`; `rest` is everything after the `://`.
fn split_scheme(text: &str) -> Result<(&str, &str), String> {
    let Some(pos) = text.find("://") else {
        return Err(format!("Invalid collab link: {text}"));
    };
    let scheme = &text[..pos];
    let valid = !scheme.is_empty()
        && scheme
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphabetic())
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.');
    if !valid {
        return Err(format!("Invalid collab link: {text}"));
    }
    Ok((scheme, &text[pos + 3..]))
}

/// Split the authority (`host[:port]`, IPv6 bracketed) from path/query/fragment.
fn split_authority(rest: &str) -> (&str, &str) {
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    (&rest[..end], &rest[end..])
}

/// `host[:port]` → `(host, Option<port>)`; IPv6 hosts keep their brackets.
fn split_host_port(authority: &str) -> (&str, Option<&str>) {
    if let Some(rest) = authority.strip_prefix('[')
        && let Some(close) = rest.find(']')
    {
        let host = &authority[..=close];
        let tail = &authority[close + 1..];
        let port = tail.strip_prefix(':').filter(|p| !p.is_empty());
        return (host, port);
    }
    match authority.rfind(':') {
        Some(p) if p > 0 && !authority[p + 1..].contains(':') => {
            (&authority[..p], Some(&authority[p + 1..]))
        }
        _ => (authority, None),
    }
}

/// The `scheme://host[:port]` of a collab link, for logs and operator
/// messages. NEVER the path: the room key rides there, so the path is the one
/// part of a link that must not be printed.
pub(crate) fn link_authority(link: &str) -> String {
    let text = link.trim();
    let Ok((scheme, rest)) = split_scheme(text) else {
        return "an unrecognised relay".to_string();
    };
    let (authority, _) = split_authority(rest);
    if authority.is_empty() {
        scheme.to_string()
    } else {
        format!("{scheme}://{authority}")
    }
}

/// Full parse, mirroring `parseCollabLink` byte-for-byte in behavior.
pub(crate) fn parse_collab_link(link: &str) -> Result<ParsedLink, String> {
    // Lenient input: strict URL stacks percent-encode the legacy second `#`.
    let text = link.trim().replace("%23", "#");

    // Bare `<roomId>.<key>` (legacy `<roomId>#<key>`) → default relay.
    let text = if let Some((room, secret)) = split_bare(&text) {
        format!("{DEFAULT_RELAY_URL}/r/{room}.{secret}")
    } else if text.contains("://") {
        text
    } else {
        // Scheme-less `host[:port]/r/...` → wss.
        format!("wss://{text}")
    };

    let (scheme, rest) = split_scheme(&text)?;
    let is_tls = matches!(scheme, "wss" | "https");
    if !matches!(scheme, "ws" | "wss" | "http" | "https") {
        return Err(format!("Unsupported relay URL scheme: {scheme}"));
    }

    let (authority, path_and_frag) = split_authority(rest);
    if authority.is_empty() {
        return Err(format!("Invalid collab link: {link}"));
    }
    let (host, port) = split_host_port(authority);
    if port.is_some_and(|p| !p.bytes().all(|b| b.is_ascii_digit())) {
        return Err(format!("Invalid collab link: {link}"));
    }
    if !is_tls && !is_local_host(host) {
        return Err(
            "relay link must be wss:// (plain ws:// is only allowed for localhost)".to_string(),
        );
    }

    // path = up to `?` or `#`; fragment = everything after the first `#`.
    let path_and_frag = path_and_frag.strip_prefix('/').unwrap_or(path_and_frag);
    let (path, fragment) = match path_and_frag.find('#') {
        Some(p) => (&path_and_frag[..p], Some(&path_and_frag[p + 1..])),
        None => (path_and_frag, None),
    };
    let path = path.split('?').next().unwrap_or(path);
    let path = format!("/{path}");

    let (room_id, secret) = match parse_room_path(&path) {
        Some(x) => x,
        None => {
            // Web deep link: `http(s)://<relay>/#<collab-link>` — the whole
            // link rides in the fragment; recursion terminates because the
            // inner text is a strict suffix of the input.
            if let Some(inner) = fragment.filter(|f| !f.is_empty()) {
                return parse_collab_link(inner);
            }
            return Err("Collab link must contain a /r/<roomId> path".to_string());
        }
    };
    // Key rides dot-joined in the path; legacy links carry it in the fragment.
    let secret_text = match (secret, fragment) {
        (Some(s), _) => s,
        (None, Some(f)) if !f.is_empty() => f,
        (None, _) => return Err("Collab link is missing the <key> part".to_string()),
    };
    let decoded = URL_SAFE_NO_PAD
        .decode(secret_text.as_bytes())
        .map_err(|_| {
            "Collab link key must be 32 (view) or 48 (full) base64url bytes".to_string()
        })?;
    if decoded.len() != ROOM_KEY_BYTES && decoded.len() != ROOM_KEY_BYTES + WRITE_TOKEN_BYTES {
        return Err("Collab link key must be 32 (view) or 48 (full) base64url bytes".to_string());
    }
    let key = decoded[..ROOM_KEY_BYTES].to_vec();
    let write_token = (decoded.len() > ROOM_KEY_BYTES).then(|| decoded[ROOM_KEY_BYTES..].to_vec());

    let ws_scheme = if is_tls { "wss" } else { "ws" };
    let default_port = if is_tls { "443" } else { "80" };
    let port_part = match port {
        Some(p) if p != default_port => format!(":{p}"),
        _ => String::new(),
    };
    Ok(ParsedLink {
        ws_url: format!("{ws_scheme}://{host}{port_part}/r/{room_id}"),
        room_id: room_id.to_string(),
        key,
        write_token,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// Envelope + AES-256-GCM codec (mirrors protocol.ts / crypto.ts)
// ═══════════════════════════════════════════════════════════════════════════

/// `[4B u32 BE peerId][sealed]`. Guests always send peerId 0; the relay
/// rewrites it to the sender's id, so incoming frames carry the sender.
fn pack_envelope(peer_id: u32, sealed: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(ENVELOPE_HEADER_LENGTH + sealed.len());
    out.extend_from_slice(&peer_id.to_be_bytes());
    out.extend_from_slice(&sealed);
    out
}

fn unpack_envelope(data: &[u8]) -> Option<(u32, &[u8])> {
    if data.len() < ENVELOPE_HEADER_LENGTH {
        return None;
    }
    let peer_id = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    Some((peer_id, &data[ENVELOPE_HEADER_LENGTH..]))
}

/// Raw-key AES-256-GCM codec; no KDF, no AAD — direct import like
/// `importRoomKey`/`seal`/`open` in crypto.ts.
struct Codec {
    cipher: Aes256Gcm,
}

impl Codec {
    fn new(key: &[u8]) -> Result<Codec, String> {
        if key.len() != ROOM_KEY_BYTES {
            return Err(format!(
                "Room key must be {ROOM_KEY_BYTES} bytes, got {}",
                key.len()
            ));
        }
        let cipher =
            Aes256Gcm::new_from_slice(key).map_err(|e| format!("invalid room key: {e}"))?;
        Ok(Codec { cipher })
    }

    /// `[12B random IV][ciphertext+tag]` over the JSON frame, no AAD.
    fn seal(&self, frame: &Value) -> Result<Vec<u8>, String> {
        let mut iv = [0u8; IV_LENGTH];
        rng().fill_bytes(&mut iv);
        let plaintext =
            serde_json::to_vec(frame).map_err(|e| format!("frame serialize failed: {e}"))?;
        let nonce =
            Nonce::<Aes256Gcm>::try_from(&iv[..]).map_err(|_| "nonce length".to_string())?;
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_ref())
            .map_err(|e| format!("encrypt failed: {e}"))?;
        let mut out = Vec::with_capacity(IV_LENGTH + ciphertext.len());
        out.extend_from_slice(&iv);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// Inverse of `seal`; auth failure or malformed input is a hard error
    /// (wrong key ⇒ the caller treats it as fatal, never reconnects).
    fn open(&self, sealed: &[u8]) -> Result<Value, String> {
        if sealed.len() <= IV_LENGTH {
            return Err("sealed frame too short".to_string());
        }
        let (iv, ciphertext) = sealed.split_at(IV_LENGTH);
        let nonce = Nonce::<Aes256Gcm>::try_from(iv).map_err(|_| "nonce length".to_string())?;
        let plaintext = self
            .cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|_| "bad key or corrupted frame".to_string())?;
        serde_json::from_slice(&plaintext).map_err(|e| format!("frame JSON parse failed: {e}"))
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Dead-room pruning
// ═══════════════════════════════════════════════════════════════════════════

/// Drop room-keyed registry entries whose room no longer has a live host in
/// the self-hosted relay (its room table has no entry — a room only exists
/// there while a host is connected). Session-keyed entries always stay: they
/// are how auto-attach re-joins after the desktop TUI restarts.
///
/// With no live relay to judge against, nothing is removed (conservative: a
/// term-host link registered moments before the relay starts must survive).
/// Returns how many entries were removed.
fn prune_dead_rooms_impl(links: &LinkRegistry) -> usize {
    let live: HashSet<String> = match RelayManager::current() {
        Some(relay) => match relay.rooms.lock() {
            Ok(g) => g.keys().cloned().collect(),
            Err(p) => p.into_inner().keys().cloned().collect(),
        },
        None => return 0,
    };
    // Bare room keys plus announced rooms: an announcement whose room died
    // must not trigger a doomed attach attempt on every open.
    let mut dead: HashSet<String> = links
        .room_keys()
        .into_iter()
        .filter(|id| !live.contains(id))
        .collect();
    dead.extend(
        links
            .announced_rooms()
            .into_iter()
            .filter(|id| !live.contains(id)),
    );
    links.prune_rooms(&dead.into_iter().collect::<Vec<_>>())
}

/// Crate-internal entry for the adoption path: prune dead room-keyed entries
/// from the current shared registry (same action as
/// `CollabManager::prune_dead_rooms`, but reachable without a manager
/// handle). `adopt.rs` calls this before deciding to type `/collab`, so a
/// stale registry cannot make adoption look unnecessary. Returns how many
/// entries were removed.
// Called only from the adoption path, which cannot run on Windows.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn prune_dead_rooms_now() -> usize {
    match RelayManager::current() {
        Some(relay) => prune_dead_rooms_impl(&relay.links),
        None => 0,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CollabManager
// ═══════════════════════════════════════════════════════════════════════════

/// A queue handoff is not a socket write. Prompts carry a completion channel
/// so receipts describe the transport we actually observed, not agent execution.
struct OutboundFrame {
    payload: Value,
    forwarded: Option<oneshot::Sender<bool>>,
}

impl From<Value> for OutboundFrame {
    fn from(payload: Value) -> Self {
        Self {
            payload,
            forwarded: None,
        }
    }
}

/// One attached session: the guest task (or the relay tap) plus everything
/// needed to signal it (shutdown), feed it (outbound frames), and gate
/// writes (write token). `task` is the guest task for
/// [`CollabManager::attach`]; the relay tap stores `None` — once registered
/// it is always parked in its `select!` loop, so detach stops it through
/// the shutdown watch and there is nothing to abort.
struct CollabSession {
    generation: u64,
    frame_tx: mpsc::UnboundedSender<OutboundFrame>,
    shutdown_tx: watch::Sender<bool>,
    write_token: Option<String>,
    task: Option<tokio::task::JoinHandle<()>>,
}

// ───────────────────────────────────────────────────────────────────────────
// Process-wide link state (liveness gate + /api/status aggregation)
// ───────────────────────────────────────────────────────────────────────────

/// One collab session's desktop-link state, keyed by session path in
/// [`LINK_STATES`]. This is the SINGLE source of truth for connection
/// liveness: the outbound senders refuse to accept frames unless the state
/// is [`LinkState::Attached`], and [`link_state_summary`] aggregates it for
/// `/api/status`. The state lives here rather than on `CollabSession` so it
/// survives the session's registry removal — a FATAL end removes the session
/// (nothing can be sent to it any more) but leaves `Lost` behind, so the
/// polled status keeps saying the link is gone instead of forgetting it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LinkState {
    /// Session registered, first join still in flight — not usable yet.
    Connecting,
    /// A live guest connection: outbound frames are handed to the desktop.
    Attached,
    /// Connection dropped; the guest task is in reconnect backoff.
    Reconnecting,
    /// Terminal end (room closed, bye, bad key): no reconnect.
    Lost,
}

impl LinkState {
    fn name(self) -> &'static str {
        match self {
            LinkState::Connecting => "connecting",
            LinkState::Attached => "attached",
            LinkState::Reconnecting => "reconnecting",
            LinkState::Lost => "lost",
        }
    }
}

static LINK_STATES: std::sync::LazyLock<Mutex<HashMap<String, LinkState>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn set_link_state(session: &str, state: LinkState) {
    let mut m = match LINK_STATES.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    m.insert(session.to_string(), state);
}

fn remove_link_state(session: &str) {
    let mut m = match LINK_STATES.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    m.remove(session);
}

/// The session's current link state; an absent entry means the join has not
/// finished registering yet (treated as [`LinkState::Connecting`] — refused).
fn link_state(session: &str) -> LinkState {
    let m = match LINK_STATES.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    m.get(session).copied().unwrap_or(LinkState::Connecting)
}

/// Distinguishable reason a write is refused while the link is not live, so
/// the HTTP layer can tell the phone "reconnecting" from "view-only" from
/// "not attached" instead of one generic failure.
fn write_gate_error(state: LinkState) -> &'static str {
    match state {
        LinkState::Reconnecting => "desktop link is reconnecting",
        LinkState::Connecting => "desktop link is connecting",
        LinkState::Lost => "desktop link is lost",
        // Only reachable if a caller forgets the `!= Attached` guard; keep a
        // truthful message rather than panicking.
        LinkState::Attached => "collab link not writable",
    }
}

/// Aggregate link state across every session, for `/api/status`
/// `desktopLink`. One live session means the desktop IS reachable, so
/// `attached` dominates; a `reconnecting` session outranks a `lost` one (it
/// may still come back); `connecting` contributes nothing (the four-value
/// contract has no slot for it). Lock-safe and allocation-free — this runs
/// on a polled endpoint.
pub fn link_state_summary() -> &'static str {
    let m = match LINK_STATES.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let mut reconnecting = false;
    let mut lost = false;
    for state in m.values() {
        match state {
            LinkState::Attached => return "attached",
            LinkState::Reconnecting => reconnecting = true,
            LinkState::Lost => lost = true,
            LinkState::Connecting => {}
        }
    }
    if reconnecting {
        "reconnecting"
    } else if lost {
        "lost"
    } else {
        "none"
    }
}

/// The shared write gate for every outbound collab sender: the session must
/// exist, carry a write token, AND its guest connection must be live
/// ([`LinkState::Attached`]). Without the liveness check a
/// prompt/abort/answer would be accepted into an unbounded channel nobody is
/// draining during reconnect backoff, and the phone would believe the
/// desktop got it — the exact bug this wave fixes.
fn check_writable<'a>(
    sessions: &'a HashMap<String, CollabSession>,
    session_path: &str,
) -> Result<&'a CollabSession, String> {
    let sess = sessions
        .get(session_path)
        .ok_or_else(|| "not attached to a collab session".to_string())?;
    if sess.write_token.is_none() {
        return Err("view-only link".to_string());
    }
    let state = link_state(session_path);
    if state != LinkState::Attached {
        return Err(write_gate_error(state).to_string());
    }
    Ok(sess)
}

/// The most recently constructed collab manager, held weakly so the relay
/// tap can register a real write path without a main.rs wiring change —
/// `CollabManager` and `RelayManager` are constructed separately (main.rs)
/// and the tap is spawned from the relay's own tasks. Mirrors
/// [`RELAY_MANAGER`]: weak so the registry dies with its last owner.
static COLLAB_MANAGER: Mutex<Option<Weak<CollabManager>>> = Mutex::new(None);

pub struct CollabManager {
    hub: Arc<WsHub>,
    delta: Arc<DeltaEncoder>,
    /// Web-push handle for `needs_input` notifications: a collab dialog
    /// (`ui-request`) must buzz the phone exactly like a child
    /// `extension_ui_request`, through the SAME debounce.
    push: Arc<Push>,
    sessions: Arc<Mutex<HashMap<String, CollabSession>>>,
    next_gen: AtomicU64,
    links: Arc<LinkRegistry>,
    transcript_reads: Arc<transcript::Reads>,
}

// ═══════════════════════════════════════════════════════════════════════════
// Self-hosted relay (replaces the my.omp.sh dependency)
// ═══════════════════════════════════════════════════════════════════════════

/// The most recently constructed relay manager, held weakly so the collab
/// attach path can tap a live room without a main.rs wiring change. Weak:
/// never keeps the manager alive — the AppState Arc in main.rs is the owner.
static RELAY_MANAGER: Mutex<Option<Weak<RelayManager>>> = Mutex::new(None);

pub struct RelayManager {
    listeners: Mutex<HashSet<std::net::SocketAddr>>,
    config: SharedConfig,
    hub: Arc<WsHub>,
    delta: Arc<DeltaEncoder>,
    /// Web-push handle for `needs_input` notifications, shared with
    /// `CollabManager` — the internal tap's forwarded `ui-request` frames
    /// buzz the phone through the same debounced push.
    push: Arc<Push>,
    rooms: Arc<Mutex<HashMap<String, RelayRoom>>>,
    next_gen: AtomicU64,
    /// Peer ids for guests (the host is always `HOST_PEER_ID` = 1); the
    /// wire envelope prefix is 4-byte BE, so ids are u32.
    next_peer: AtomicU32,
    links: Arc<LinkRegistry>,
}

#[cfg(test)]
mod tests;
