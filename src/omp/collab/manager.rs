//! `CollabManager`'s methods: stored links, attach/detach, liveness and the
//! write paths (prompt, abort, dialog answers) into an attached room.

use super::*;
pub use transcript::{Chunk as TranscriptChunk, Error as TranscriptError};

use crate::authority::session_state::{Connection, SourceStamp, Turn};
use crate::server::delta::DeltaEncoder;
use crate::server::push::Push;
use crate::server::ws::WsHub;
use crate::sessions::jsonl;
use crate::types::SharedConfig;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{mpsc, oneshot, watch};
use tracing::info;

impl CollabManager {
    pub fn new(
        config: SharedConfig,
        hub: Arc<WsHub>,
        delta: Arc<DeltaEncoder>,
        push: Arc<Push>,
    ) -> Arc<Self> {
        let links = LinkRegistry::load(&config);
        let manager = Arc::new(CollabManager {
            hub,
            delta,
            push,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_gen: AtomicU64::new(1),
            links,
            transcript_reads: Arc::new(transcript::Reads::default()),
        });
        if let Ok(mut g) = COLLAB_MANAGER.lock() {
            *g = Some(Arc::downgrade(&manager));
        }
        // Expiry sweep. A queued answer is only noticed at an attach, and the case
        // that produces expiries is a desktop that never attaches again - so without
        // a timer the phone would keep a card saying the answer is held forever.
        // Parked while nothing is queued (see `run_answer_sweep`). Weak, so this
        // task cannot keep a dead manager alive.
        let weak = Arc::downgrade(&manager);
        tokio::spawn(async move {
            run_answer_sweep(&ANSWER_QUEUED, || {
                let Some(mgr) = weak.upgrade() else {
                    return std::ops::ControlFlow::Break(());
                };
                sweep_expired_answers(&mgr.delta, &mgr.hub);
                std::ops::ControlFlow::Continue(
                    next_answer_expiry().map(tokio::time::Instant::from_std),
                )
            })
            .await;
        });
        manager
    }

    /// Weak handle to the live collab manager, for the relay tap's write
    /// path (the tap needs the same `sessions` registry + `next_gen` the
    /// guest attach uses, so generations and write gates stay one space).
    pub(super) fn current() -> Option<Arc<CollabManager>> {
        match COLLAB_MANAGER.lock() {
            Ok(g) => g.as_ref().and_then(Weak::upgrade),
            Err(p) => p.into_inner().as_ref().and_then(Weak::upgrade),
        }
    }

    /// The collab link last persisted for a session, if any.
    pub fn stored_link(&self, session_path: &str) -> Option<String> {
        self.links.stored_link(session_path)
    }

    /// Announce a host link for an omp session id (zero-link introduction;
    /// see registry docs). Returns the room id. Durable like a remembered
    /// link, pruned like one when its room dies.
    pub fn announce_session_link(&self, session_id: &str, link: &str) -> Result<String, String> {
        self.links.announce_session_link(session_id, link)
    }

    /// The link to auto-attach with for a session: explicitly remembered
    /// first, announced by session id second. Every automatic path shares
    /// this order.
    pub fn auto_attach_link(&self, session_path: &str, session_id: Option<&str>) -> Option<String> {
        self.links.auto_attach_link(session_path, session_id)
    }

    /// Upsert the session's collab link and persist it atomically.
    pub fn remember_link(&self, session_path: &str, link: &str) {
        self.links.remember_link(session_path, link);
    }

    /// Drop the stored link for a session (dead-room hygiene) and persist.
    pub fn forget_link(&self, session_path: &str) {
        self.links.forget_link(session_path);
    }

    /// Drop room-keyed registry entries whose room no longer has a live host
    /// (the self-hosted relay's room table has no entry for it). Session-keyed
    /// entries stay — they are how auto-attach re-joins after the desktop TUI
    /// restarts. Returns how many entries were removed.
    pub fn prune_dead_rooms(&self) -> usize {
        prune_dead_rooms_impl(&self.links)
    }

    /// Register a collab link keyed by room id (no session path needed) —
    /// the `omp_pulse term` host path. Durable.
    pub fn register_room_link(&self, link: &str) -> Result<(), String> {
        self.links.register_room_link(link)
    }

    /// Register the link and, if the host room is ALREADY live (the host
    /// connected before the term's register POST landed), tap it immediately —
    /// otherwise the stream waits for the next host reconnect.
    pub fn register_and_tap(&self, link: &str) -> Result<(), String> {
        let parsed = parse_collab_link(link)?;
        self.links.register_room_link(link)?;
        if let Some(relay) = RelayManager::current() {
            relay.tap_room_if_live(&parsed.room_id);
        }
        Ok(())
    }

    /// Parse the link and start the encrypted guest. The FIRST join is
    /// synchronous: a bogus/unreachable link or a host rejection returns
    /// `Err` (and tears the task down). Once joined, the task reconnects with
    /// backoff until `detach` or a terminal close.
    pub async fn attach(&self, session_path: &str, link: &str) -> Result<(), String> {
        let parsed = parse_collab_link(link)?;
        let codec = Codec::new(&parsed.key)?;
        let write_token = parsed
            .write_token
            .as_deref()
            .map(|t| URL_SAFE_NO_PAD.encode(t));
        let ws_url = format!("{}?role=guest", parsed.ws_url);
        let session_path = session_path.to_string();

        // Re-attach replaces any existing attachment for this path.
        self.detach(&session_path);
        info!(room = %parsed.room_id, "collab guest joining relay room");

        let generation = self.next_gen.fetch_add(1, Ordering::Relaxed);
        let (join_tx, join_rx) = oneshot::channel();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (frame_tx, frame_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(guest_task(
            ws_url,
            parsed.room_id.clone(),
            codec,
            write_token.clone(),
            session_path.clone(),
            self.hub.clone(),
            self.delta.clone(),
            Arc::clone(&self.push),
            Arc::clone(&self.links),
            shutdown_rx,
            frame_rx,
            join_tx,
            Arc::clone(&self.sessions),
            Arc::clone(&self.transcript_reads),
            generation,
        ));

        // Register before the join so a concurrent detach can cancel it.
        if let Ok(mut g) = self.sessions.lock() {
            g.insert(
                session_path.clone(),
                CollabSession {
                    generation,
                    frame_tx,
                    shutdown_tx,
                    write_token,
                    task: Some(task),
                },
            );
        }
        // The session exists but the join is not done yet: writes must wait.
        set_link_state(&session_path, LinkState::Connecting);

        match join_rx.await {
            Ok(Ok(())) => {
                info!(session = %session_path, "collab attached");
                // The caller remembers the link right after this returns; if
                // the room is already live on the self-hosted relay, spawn
                // the internal tap immediately so the phone stream starts
                // without waiting for the next host connect.
                if let Some(relay) = RelayManager::current() {
                    relay.tap_room_if_live(&parsed.room_id);
                }
                Ok(())
            }
            Ok(Err(e)) => {
                self.remove_if_generation(&session_path, generation);
                Err(e)
            }
            Err(_) => {
                self.remove_if_generation(&session_path, generation);
                Err("collab join aborted".to_string())
            }
        }
    }

    /// Close the guest connection and stop its reconnect loop.
    pub fn detach(&self, session_path: &str) {
        let removed = match self.sessions.lock() {
            Ok(mut g) => {
                self.transcript_reads.disconnect(session_path);
                g.remove(session_path)
            }
            Err(_) => return,
        };
        if let Some(sess) = removed {
            let _ = sess.shutdown_tx.send(true);
            // A tap session has no task to abort (None) — its shutdown watch
            // stops it; the guest task is aborted so a join still in flight
            // (outside the select loop) dies too.
            if let Some(t) = sess.task {
                t.abort();
            }
            info!(session = session_path, "collab detached");
        }
        // The link is intentionally gone: drop its state so /api/status no
        // longer reports this session (other sessions still count).
        remove_link_state(session_path);
        // The user chose to end the collab session: no remembered dialog can
        // ever be answered, so retire each with a `collab_ui_request_end`
        // frame plus one notice. detach() ABORTS the guest task, so the
        // terminal-loss branch does NOT run for this path — the retirement
        // has to happen here or a reopened conversation replays a card whose
        // asker no longer exists (the "answer not received … try again"
        // bug).
        retire_collab_questions(&self.delta, &self.hub, session_path, "detached");
    }

    pub fn is_attached(&self, session_path: &str) -> bool {
        match self.sessions.lock() {
            Ok(g) => g.contains_key(session_path),
            Err(_) => false,
        }
    }

    /// Whether the session's collab write path is live RIGHT NOW: the
    /// registry entry exists AND its link state is [`LinkState::Attached`].
    ///
    /// Deliberately different from [`CollabManager::is_attached`], which
    /// checks entry existence only. Measured case that forced the
    /// distinction: a session attached through the self-hosted relay's TAP
    /// (no `CollabManager` guest task) reported `is_attached() == true`
    /// (the entry existed — `/api/open` ORs `relay.is_attached`, and the
    /// tapped room mapped the session) while `link_state_summary()` said
    /// "none": the tap never set a link state. The entry said "attached",
    /// the link was not live, and every write was refused with "not
    /// attached to a collab session". `is_live` is the truth: the entry AND
    /// an Attached link.
    pub fn is_live(&self, session_path: &str) -> bool {
        let Ok(guard) = self.sessions.lock() else {
            return false;
        };
        guard.contains_key(session_path) && link_state(session_path) == LinkState::Attached
    }

    /// Return the connected collab source and its known turn for HTTP state
    /// projection. Read-only links remain valid sources; the boolean is turn
    /// state, not write capability.
    pub fn authority_snapshot(&self, session_path: &str) -> Option<(SourceStamp, bool)> {
        if !self.is_live(session_path) {
            return None;
        }
        let registry = SESSION_AUTHORITY.get()?;
        let transport_stamp = ACTIVE_COLLAB_SOURCES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_path)
            .cloned()?;
        let stamp = registry.source_snapshot(session_path)?;
        if stamp.identity != transport_stamp.identity {
            return None;
        }
        let current = registry.current(session_path)?;
        if current.connection != Connection::Connected
            || current.owner != stamp.identity.wire_owner()
        {
            return None;
        }
        let running = match current.turn {
            Turn::Running => true,
            Turn::Idle => false,
            Turn::Unknown => return None,
        };
        Some((stamp, running))
    }

    /// Read one bounded chunk through the existing verified connection. No
    /// write token, writer-ownership projection, auto-attach, or RPC fallback.
    pub async fn fetch_agent_transcript(
        &self,
        session_path: &str,
        agent_id: &str,
        from_byte: u64,
        expected_created_at: Option<f64>,
        expected_connection_id: Option<&str>,
    ) -> Result<TranscriptChunk, TranscriptError> {
        if !transcript::valid_request(agent_id, from_byte) {
            return Err(TranscriptError::InvalidRequest);
        }
        let parent_id = jsonl::parse_header(std::path::Path::new(session_path))
            .id
            .filter(|id| !id.is_empty())
            .ok_or(TranscriptError::HostUnavailable)?;
        self.transcript_reads
            .fetch(
                session_path,
                &parent_id,
                agent_id,
                from_byte,
                expected_created_at,
                expected_connection_id,
            )
            .await
    }

    /// A passive snapshot for a phone that opened after the host's welcome.
    /// An absent/lost lease is unavailable, never an inferred empty roster.
    pub fn agent_roster(&self, session_path: &str) -> Result<Value, TranscriptError> {
        let parent_id = jsonl::parse_header(std::path::Path::new(session_path))
            .id
            .filter(|id| !id.is_empty())
            .ok_or(TranscriptError::HostUnavailable)?;
        self.transcript_reads.snapshot(session_path, &parent_id)
    }

    /// Exact captured desktop target, through the native authenticated chat
    /// command. Parked workers are revived by OMP, never by a daemon child.
    pub fn desktop_agent_follow_up(
        &self,
        session_path: &str,
        agent_id: &str,
        created_at: f64,
        connection_id: &str,
        text: Option<&str>,
    ) -> Result<Option<oneshot::Receiver<bool>>, String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "collab registry lock poisoned")?;
        check_writable(&guard, session_path)?;
        let parent_id = jsonl::parse_header(std::path::Path::new(session_path))
            .id
            .filter(|id| !id.is_empty())
            .ok_or("desktop parent identity is unavailable")?;
        self.transcript_reads
            .follow_up(
                session_path,
                &parent_id,
                agent_id,
                created_at,
                connection_id,
                text,
            )
            .map_err(|error| error.message().to_owned())
    }

    /// Write an agent-cmd frame to the live guest connection. Requires a
    /// full (write-capable) link: view links return a view-only error.
    pub fn send_agent_cmd(
        &self,
        session_path: &str,
        cmd: &str,
        agent_id: &str,
        text: Option<&str>,
    ) -> Result<(), String> {
        if !matches!(cmd, "chat" | "kill" | "revive") {
            return Err(format!("invalid agent-cmd: {cmd}"));
        }
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "collab registry lock poisoned".to_string())?;
        let sess = check_writable(&guard, session_path)?;
        let mut frame = serde_json::Map::new();
        frame.insert("t".to_string(), Value::String("agent-cmd".into()));
        frame.insert("cmd".to_string(), Value::String(cmd.to_string()));
        frame.insert("agentId".to_string(), Value::String(agent_id.to_string()));
        if let Some(t) = text {
            frame.insert("text".to_string(), Value::String(t.to_string()));
        }
        sess.frame_tx
            .send(Value::Object(frame).into())
            .map_err(|_| "collab session is closing".to_string())
    }
    /// a full link with a write token AND a live connection. `false` while
    /// the join is in flight or the link is in reconnect backoff — accepting
    /// a write into a channel nobody is draining would let the phone believe
    /// the desktop got it. View links are read-only.
    pub fn can_write(&self, session_path: &str) -> bool {
        let Ok(guard) = self.sessions.lock() else {
            return false;
        };
        guard.get(session_path).is_some_and(|s| {
            s.write_token.is_some() && link_state(session_path) == LinkState::Attached
        })
    }

    /// Route a phone prompt through the collab HOST instead of a separate
    /// daemon child: the host (the desktop TUI) runs the turn itself, so the
    /// laptop's UI streams it natively and the file has a single writer.
    /// Guest->host frame `{t:"prompt", text, images?}` (write-gated).
    pub fn send_prompt(
        &self,
        session_path: &str,
        text: &str,
        images: Vec<Value>,
    ) -> Result<oneshot::Receiver<bool>, String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "collab registry lock poisoned".to_string())?;
        let sess = check_writable(&guard, session_path)?;
        let mut frame = serde_json::Map::new();
        frame.insert("t".to_string(), Value::String("prompt".into()));
        frame.insert("text".to_string(), Value::String(text.to_string()));
        if !images.is_empty() {
            let converted: Vec<Value> = images
                .into_iter()
                .map(|img| {
                    let (data, mime_type) = match img {
                        Value::Object(mut obj) => (
                            obj.remove("data").unwrap_or(Value::Null),
                            obj.remove("mimeType").unwrap_or(Value::Null),
                        ),
                        _ => (Value::Null, Value::Null),
                    };
                    json!({ "type": "image", "data": data, "mimeType": mime_type })
                })
                .collect();
            frame.insert("images".to_string(), Value::Array(converted));
        }
        let (forwarded, receipt) = oneshot::channel();
        sess.frame_tx
            .send(OutboundFrame {
                payload: Value::Object(frame),
                forwarded: Some(forwarded),
            })
            .map_err(|_| "collab session is closing".to_string())?;
        Ok(receipt)
    }

    /// Route a phone abort through the collab host (guest->host `{t:"abort"}`).
    pub fn send_abort(&self, session_path: &str) -> Result<(), String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "collab registry lock poisoned".to_string())?;
        let sess = check_writable(&guard, session_path)?;
        let mut frame = serde_json::Map::new();
        frame.insert("t".to_string(), Value::String("abort".into()));
        sess.frame_tx
            .send(Value::Object(frame).into())
            .map_err(|_| "collab session is closing".to_string())
    }

    /// Route a phone dialog answer back through the collab host (guest→host
    /// `{t:"ui-response",reqId,value?}`). An ABSENT `value` is how the
    /// collab protocol expresses a cancelled dialog — pass `None` (a null or
    /// missing `value` from the client) to cancel; the `value` key is then
    /// omitted from the frame entirely. Write-gated like the other senders:
    /// a view link has no way to answer a dialog.
    ///
    /// Every call reports transport state, never callback acceptance. Only the
    /// host's ui-request-end retires a question; a handoff keeps it replayable
    /// and fences duplicate sends until that authoritative end.
    pub fn send_ui_response(
        &self,
        session_path: &str,
        req_id: u64,
        question_token: &str,
        value: Option<&str>,
    ) -> Result<(), String> {
        let _delivery = COLLAB_UI_DELIVERY.lock().unwrap_or_else(|p| p.into_inner());
        let guard = match self.sessions.lock() {
            Ok(g) => g,
            Err(_) => {
                let error = "collab registry lock poisoned";
                self.ack_ui_response(session_path, req_id, question_token, false, Some(error));
                return Err(error.to_string());
            }
        };
        let sess = match check_writable(&guard, session_path) {
            Ok(s) => s,
            Err(e) => {
                // Reconnect is a delay, not callback acceptance. Preserve the
                // question and fence another tap from queuing another send.
                if e == write_gate_error(LinkState::Reconnecting)
                    || e == write_gate_error(LinkState::Connecting)
                {
                    if !collab_question_matches(session_path, req_id, question_token) {
                        let error = "that question is no longer waiting";
                        self.ack_ui_response(
                            session_path,
                            req_id,
                            question_token,
                            false,
                            Some(error),
                        );
                        return Err(error.to_string());
                    }
                    match claim_collab_answer(session_path, req_id, value, true) {
                        AnswerClaim::New => {}
                        AnswerClaim::Existing { queued } => {
                            if queued {
                                self.ack_ui_response_queued(session_path, req_id, question_token);
                            } else {
                                self.ack_ui_response(
                                    session_path,
                                    req_id,
                                    question_token,
                                    true,
                                    None,
                                );
                            }
                            return Ok(());
                        }
                        AnswerClaim::Conflict => {
                            let error = "another answer is already waiting for this question";
                            self.ack_ui_response(
                                session_path,
                                req_id,
                                question_token,
                                false,
                                Some(error),
                            );
                            return Err(error.to_string());
                        }
                    }
                    queue_collab_answer(session_path, req_id, value, question_token);
                    self.ack_ui_response_queued(session_path, req_id, question_token);
                    return Ok(());
                }
                // An absent session is not coming back: the desktop that
                // asked is gone. Never word the refusal as a retry hint —
                // "not attached … try again" was the exact lie this bug
                // told (the sticky banner that never resolved).
                if e == "not attached to a collab session" {
                    self.ack_ui_response(
                        session_path,
                        req_id,
                        question_token,
                        false,
                        Some("the desktop that asked is gone"),
                    );
                    return Err(e);
                }
                // The answer did not reach the desktop (view-only link,
                // lost link, closing session): keep the dialog pending and
                // tell the phone the answer was not delivered instead of
                // letting it collapse the card.
                self.ack_ui_response(session_path, req_id, question_token, false, Some(&e));
                return Err(e);
            }
        };
        if !collab_question_matches(session_path, req_id, question_token) {
            let error = "that question is no longer waiting";
            self.ack_ui_response(session_path, req_id, question_token, false, Some(error));
            return Err(error.to_string());
        }
        match claim_collab_answer(session_path, req_id, value, false) {
            AnswerClaim::New => {}
            AnswerClaim::Existing { queued } => {
                if queued {
                    self.ack_ui_response_queued(session_path, req_id, question_token);
                } else {
                    self.ack_ui_response(session_path, req_id, question_token, true, None);
                }
                return Ok(());
            }
            AnswerClaim::Conflict => {
                let error = "another answer is already waiting for this question";
                self.ack_ui_response(session_path, req_id, question_token, false, Some(error));
                return Err(error.to_string());
            }
        }
        match sess
            .frame_tx
            .send(build_ui_response_frame(req_id, value).into())
        {
            Ok(()) => {
                // The channel owns this frame, not the host callback. Keep the
                // question pending until its ui-request-end arrives.
                self.ack_ui_response(session_path, req_id, question_token, true, None);
                Ok(())
            }
            Err(_) => {
                release_collab_answer(session_path, req_id);
                let error = "collab session is closing";
                self.ack_ui_response(session_path, req_id, question_token, false, Some(error));
                Err(error.to_string())
            }
        }
    }

    /// Broadcast a transport acknowledgement: ok:true is handoff only. The
    /// host's separate request-end is the only evidence the dialog has closed.
    fn ack_ui_response(
        &self,
        session_path: &str,
        req_id: u64,
        question_token: &str,
        ok: bool,
        error: Option<&str>,
    ) {
        if ok && error.is_none() {
            ack_ui_response_ok(&self.delta, &self.hub, session_path, req_id, question_token);
            return;
        }
        let actionable = collab_question_matches(session_path, req_id, question_token)
            && !collab_answer_in_flight(session_path, req_id);
        let event = json!({
            "type":"ui_response_ack", "reqId":req_id, "pulseQuestionToken":question_token,
            "ok":ok, "actionable":actionable, "error":error
        });
        broadcast_event(&self.delta, &self.hub, session_path, &event);
    }

    /// The daemon retained the answer while the desktop link reconnects. A
    /// later handoff acknowledgement still does not confirm callback acceptance.
    fn ack_ui_response_queued(&self, session_path: &str, req_id: u64, question_token: &str) {
        let event = json!({
            "type":"ui_response_ack", "reqId":req_id, "pulseQuestionToken":question_token,
            "ok":true, "queued":true
        });
        broadcast_event(&self.delta, &self.hub, session_path, &event);
    }

    /// Remove the registry entry only if it is still `generation` (a newer
    /// attach must never be torn down by a stale task's cleanup).
    fn remove_if_generation(&self, session_path: &str, generation: u64) {
        if let Ok(mut g) = self.sessions.lock()
            && g.get(session_path)
                .is_some_and(|e| e.generation == generation)
        {
            g.remove(session_path);
            // The join failed and never produced a usable link: drop the
            // Connecting entry so the status aggregate forgets it.
            remove_link_state(session_path);
        }
    }
}
