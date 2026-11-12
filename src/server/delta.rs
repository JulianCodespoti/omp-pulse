//! Prefix-delta encoding for the assistant message stream.
//!
//! Measured F5 (docs/internals/performance.md): every `message_update` frame carries the FULL
//! accumulating message, so a 4032 B reply costs 305.7 KB on the wire — a
//! 75.8× amplification (39.5× for an 821 B reply; 97.5–98.7% of the bytes
//! avoidable). The stream is a monotone prefix (`delta_sum == final_len`
//! exactly across turns), so each update's appended suffix is derivable from
//! one integer of state — the seq — plus the last forwarded text.
//!
//! This module keeps that per-(session, message) LAST-VALUE state and, for
//! every assistant `message_update`, emits an `OutFrame` carrying BOTH the
//! canonical full frame and an optional `{"type":"md",…}` delta tagged with
//! the `base_seq` it continues from. The hub sends the delta ONLY to clients
//! whose last delivered seq equals `base_seq`; everyone else — a client that
//! fell behind, just attached, or had frames conflated — gets the full text,
//! which is exactly what it needs to catch up. Correctness is structural: a
//! full frame is always valid, so a client can never observe a delta against
//! text it does not hold. The one case that must be impossible to get wrong —
//! a REWRITE (the new text is not a prefix extension of the stored text) —
//! simply emits no delta.
//!
//! State is pruned on `message_end` / `turn_end` / `agent_end` and bounded
//! per session AND globally, so a session whose agent never ends cannot grow
//! the map forever; eviction costs only future delta compression, never
//! correctness. When no attached client advertises the `delta` capability the
//! encoder does no work at all — nobody consumes deltas.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::server::ws::{Collapse, OutFrame, WsHub};

/// Per-message state: the last full text forwarded to this session's clients
/// (at `last_seq`) for one assistant message id.
struct MessageState {
    text: Arc<str>,
    last_seq: u64,
}

/// Per-session delta state. `last_seq` is the session's LRU clock for global
/// eviction — the seq of its most recent delta-tracked update.
#[derive(Default)]
struct SessionState {
    messages: HashMap<String, MessageState>,
    last_seq: u64,
}

/// Everything the encoder tracks, behind one mutex. Every method is
/// synchronous and lock-scoped — no lock is ever held across an `.await`.
struct Inner {
    sessions: HashMap<String, SessionState>,
    /// Total tracked (session, message) entries; kept so the global cap check
    /// is O(1) instead of a per-insert sum over sessions.
    total: usize,
}

/// Per-session cap on tracked in-flight messages. A session whose agent never
/// emits `message_end` (crashed mid-turn) would otherwise grow without limit;
/// evicting the oldest only costs future deltas.
const MAX_MESSAGES_PER_SESSION: usize = 16;

/// Global cap on tracked (session, message) entries across every session: the
/// daemon has no upper bound on session count, so per-session caps alone
/// would still grow forever under many concurrent streams.
const MAX_TOTAL_MESSAGES: usize = 4096;

/// Prefix-delta encoder. ONE instance is shared by both event producers (the
/// router task for child events and the collab guest/relay forwarders), so a
/// session's seq space and message state stay coherent across sources.
pub struct DeltaEncoder {
    inner: Mutex<Inner>,
}

impl DeltaEncoder {
    /// Create an empty encoder.
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                total: 0,
            }),
        })
    }

    /// Encode one `event` frame (the payload inside
    /// `{"type":"event","event":…}`) into an [`OutFrame`]. Assistant
    /// `message_update`s get a prefix delta; `message_end`/`turn_end`/
    /// `agent_end` retire tracked state; the collapse key is assigned by
    /// event type.
    pub fn encode_event(
        &self,
        hub: &WsHub,
        session: &str,
        frame: Arc<str>,
        event: &Value,
    ) -> OutFrame {
        let etype = event.get("type").and_then(Value::as_str).unwrap_or("");

        // Retire streaming state the moment a message/turn/agent finishes: a
        // finished message can never legally delta again, and a session that
        // never ends must not grow the map forever.
        match etype {
            "message_end" => {
                if let Some(id) = update_msg_id(event) {
                    self.prune_message(session, &id);
                }
            }
            "turn_end" | "agent_end" => self.prune_session(session),
            _ => {}
        }

        let seq = hub.next_seq(session);

        if etype == "message_update" {
            let parts = assistant_update_parts(event);
            // Delta work costs a content copy + state insert per update; when
            // no attached client advertises `delta`, skip it entirely (a
            // client attaching later starts from a full frame — the hub's
            // base_seq gate makes that correct, just uncompressed).
            //
            // The counters exist because this decision failed SILENTLY twice
            // during bring-up (first the chain key, then the audience check),
            // and a wire measurement could only show the absence of deltas,
            // never the reason. /api/status now names the reason.
            let delta = match &parts {
                Some((id, text, generated)) => {
                    if hub.any_delta_client(session) {
                        // Economics live HERE, where both sizes are known: a
                        // delta is worth sending only if it is smaller than the
                        // canonical frame it replaces. The envelope (usage,
                        // contextSnapshot, thinkingSignature, provider, model)
                        // is ~2 KB, so in practice every delta pays — but an
                        // early rewrite of a one-word message would not, and
                        // sending it anyway would cost bytes AND a chain step.
                        let out = self.core_delta(session, id, text, Some(*generated), seq);
                        // `None` here means the chain had no tracked base, so
                        // the full frame is the chain's opening snapshot. Read
                        // it BEFORE the size filter, which can also yield None.
                        let first = out.is_none();
                        let d = out.filter(|(_, d)| d.len() < frame.len());
                        crate::metrics::inc(if d.is_some() {
                            "delta_built"
                        } else if first {
                            // The chain's opening frame: a full snapshot is
                            // REQUIRED, there is nothing to extend yet.
                            "delta_first_frame"
                        } else {
                            // The text stopped prefix-extending: omp rewrote
                            // the message. Correct, and rare.
                            "delta_skip_rewrite"
                        });
                        d
                    } else {
                        crate::metrics::inc("delta_skip_no_audience");
                        None
                    }
                }
                None => {
                    crate::metrics::inc("delta_skip_unparsed");
                    None
                }
            };
            return OutFrame {
                seq,
                text: frame,
                delta,
                collapse: update_collapse(event),
            };
        }

        OutFrame {
            seq,
            text: frame,
            delta: None,
            collapse: if etype == "tool_execution_update" {
                tool_update_collapse(event)
            } else {
                collapse_for(etype)
            },
        }
    }

    /// Encode a non-event frame (entries, partial, poll, bash_result, notice,
    /// collab_state, …) with an explicit collapse key. No delta is possible —
    /// only assistant `message_update`s are prefix-diffable.
    pub fn encode_plain(
        &self,
        hub: &WsHub,
        session: &str,
        frame: Arc<str>,
        collapse: Collapse,
    ) -> OutFrame {
        OutFrame {
            seq: hub.next_seq(session),
            text: frame,
            delta: None,
            collapse,
        }
    }

    /// Core: given the full text now shipping for (session, id) at `seq`,
    /// return the delta frame against the previously forwarded text, and
    /// record the new text+seq as the base for the next update. `None` when
    /// nothing is tracked for (session, id) — the caller then ships the full
    /// frame, which is always correct. `generated` rides along as the frame's
    /// `g` (see [`generated_len`]); it is not part of the diff base.
    ///
    /// `None` is ALSO how the caller learns the chain opened, so an
    /// unsuppressed full frame is attributed to `delta_first_frame` instead of
    /// `delta_skip_rewrite`. That fact is read out of THIS pass, never from a
    /// second lock: the router task and the collab forwarders share one
    /// encoder, so a `message_end` or a cap eviction landing between two locks
    /// could make the counter describe a state the diff never saw.
    fn core_delta(
        &self,
        session: &str,
        id: &str,
        text: &str,
        generated: Option<usize>,
        seq: u64,
    ) -> Option<(u64, Arc<str>)> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let prev = inner.sessions.get(session).and_then(|s| s.messages.get(id));
        let base_seq = prev.map(|p| p.last_seq);
        // A delta is a SUFFIX REPLACEMENT, not merely an append.
        //
        // WHY: the append-only form skipped 5 of 33 updates on a 600-word turn
        // (~12 KB of full snapshots) because omp does not only extend text — it
        // also normalises the tail when a block finalises, so the new text is
        // not a prefix-extension of the old. Diffing on the common prefix turns
        // every one of those into "keep N units, append the rest", and the only
        // case left for a full frame is a change so early that the delta would
        // not be smaller.
        let delta = match (base_seq, prev) {
            (Some(base), Some(p)) => {
                let cut = common_prefix_bytes(&p.text, text);
                let appended = &text[cut..];
                if cut == p.text.len() {
                    Some((base, Arc::from(delta_frame(id, appended, None, generated))))
                } else {
                    let keep = p.text[..cut].encode_utf16().count();
                    Some((
                        base,
                        Arc::from(delta_frame(id, appended, Some(keep), generated)),
                    ))
                }
            }
            _ => None,
        };

        // Record the FULL text we just shipped at `seq` — including after a
        // rewrite, so the next update diffs against the new truth.
        let entry = MessageState {
            text: Arc::from(text),
            last_seq: seq,
        };
        if prev.is_none() {
            if inner.total >= MAX_TOTAL_MESSAGES {
                // Global cap: evict the stalest session wholesale. The key is
                // cloned before the remove so the entry borrow below stays
                // valid even when this very session is the victim.
                if let Some(stale) = inner
                    .sessions
                    .iter()
                    .min_by_key(|(_, s)| s.last_seq)
                    .map(|(k, _)| k.clone())
                    && let Some(removed) = inner.sessions.remove(&stale)
                {
                    inner.total = inner.total.saturating_sub(removed.messages.len());
                }
            }
            let sess = inner.sessions.entry(session.to_string()).or_default();
            let mut pruned = 0usize;
            if sess.messages.len() >= MAX_MESSAGES_PER_SESSION {
                // Per-session cap: evict the oldest tracked message.
                if let Some(stale) = sess
                    .messages
                    .iter()
                    .min_by_key(|(_, m)| m.last_seq)
                    .map(|(k, _)| k.clone())
                {
                    sess.messages.remove(&stale);
                    pruned = 1;
                }
            }
            sess.last_seq = seq;
            sess.messages.insert(id.to_string(), entry);
            // `total` is touched only after the &mut borrow of `sess` ends.
            inner.total = inner.total.saturating_sub(pruned).saturating_add(1);
        } else if let Some(sess) = inner.sessions.get_mut(session) {
            sess.last_seq = seq;
            sess.messages.insert(id.to_string(), entry);
        }
        delta
    }

    /// Drop the tracked state for one finished message id. Also drops the
    /// session entry when its last message is removed, keeping the outer map
    /// at the size of live streaming sessions.
    fn prune_message(&self, session: &str, id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(sess) = inner.sessions.get_mut(session) {
            let dropped = sess.messages.remove(id).is_some();
            let empty = sess.messages.is_empty();
            if dropped {
                inner.total = inner.total.saturating_sub(1);
            }
            if empty {
                inner.sessions.remove(session);
            }
        }
    }

    /// Drop every tracked message for a session (`turn_end` / `agent_end`).
    fn prune_session(&self, session: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(sess) = inner.sessions.remove(session) {
            inner.total = inner.total.saturating_sub(sess.messages.len());
        }
    }
}

/// The chain identity of a streaming assistant message.
///
/// MEASURED SHAPE, and it is not the obvious one: a LIVE `message_update`
/// carries no `id` at all. Its message object is
/// `{api, content, model, provider, responseId, role, stopReason, timestamp, usage}` —
/// the `id` only appears on the COMMITTED entry once the turn lands. Keying on
/// `id` therefore produced zero deltas across a whole turn, which is exactly
/// what the first A/B run showed. `responseId` is the provider's stable
/// identifier for the response being streamed, so it is the real chain key.
///
/// The `LIVE_CHAIN` fallback is safe because a session streams exactly one
/// assistant message at a time, and the chain is pruned on
/// `message_end`/`turn_end`/`agent_end`.
fn chain_id(message: &Value) -> Option<String> {
    for key in ["responseId", "id"] {
        if let Some(v) = message.get(key).and_then(Value::as_str)
            && !v.is_empty()
        {
            return Some(v.to_string());
        }
    }
    Some(LIVE_CHAIN.to_string())
}

/// Chain key for a live assistant message that identifies itself with neither
/// `responseId` nor `id`.
const LIVE_CHAIN: &str = "live";

/// The chain id of a `message_update` / `message_end` frame, if any.
fn update_msg_id(event: &Value) -> Option<String> {
    event.get("message").and_then(chain_id)
}

/// `(chain id, text, generated)` of an assistant `message_update`, if the
/// frame carries text. Only assistant messages stream — user text arrives as
/// committed entries, not updates.
fn assistant_update_parts(event: &Value) -> Option<(String, String, usize)> {
    let message = event.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let id = chain_id(message)?;
    let content = message.get("content")?;
    let text = content_text(content)?;
    Some((id, text, generated_len(content)))
}

/// Bytes the model has generated so far across ALL blocks: text, thinking,
/// and the raw JSON of tool-call arguments still streaming (`partialJson`).
///
/// WHY: the delta base is visible text only, so while a model THINKS, or
/// streams a large tool call, text does not move and every update ships as
/// `{"a":""}`. The phone then saw nothing grow for 10+ seconds of a turn that
/// was generating at 90 tok/s, and its live tokens-per-second read ~0 until
/// the reply text started. This one integer is the numerator it needs, at a
/// few bytes per frame instead of the full snapshot the delta exists to avoid.
/// Byte lengths are O(1); the client only uses the count as a rate estimate.
fn generated_len(content: &Value) -> usize {
    match content {
        Value::String(s) => s.len(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                let field = match item.get("type").and_then(Value::as_str) {
                    Some("text") => "text",
                    Some("thinking") => "thinking",
                    Some("toolCall") => "partialJson",
                    _ => return 0,
                };
                item.get(field).and_then(Value::as_str).map_or(0, str::len)
            })
            .sum(),
        _ => 0,
    }
}

/// The plain-text view of a message content: either a string or the
/// concatenation of `{type:"text",text}` blocks (bench/wire.py's
/// `extract_text` — omp providers send both shapes). Used ONLY as the delta
/// base; the canonical full frame always carries the raw content verbatim.
fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(t) = item.get("text").and_then(Value::as_str)
                {
                    out.push_str(t);
                }
            }
            Some(out)
        }
        _ => None,
    }
}

/// Build the wire delta frame: `{"type":"md","id":…,"k"?:…,"a":…,"g"?:…}`.
/// The appended text is JSON-escaped by serde_json's own serializer (never
/// hand-rolled).
fn delta_frame(id: &str, appended: &str, keep: Option<usize>, generated: Option<usize>) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(appended.len() + id.len() + 48);
    // INVARIANT: writing into a String cannot fail; the Results are unit.
    let _ = write!(
        out,
        r#"{{"type":"md","id":{}"#,
        Value::String(id.to_string())
    );
    // Suffix replace: truncate to `k` UTF-16 code units, then append. `k` is
    // in UTF-16 units because the consumer is a browser, where
    // `String.prototype.slice` counts exactly those — a byte offset or a
    // scalar count would split an emoji. Absent `k` is a pure append.
    if let Some(k) = keep {
        let _ = write!(out, r#","k":{k}"#);
    }
    let _ = write!(out, r#","a":{}"#, Value::String(appended.to_string()));
    if let Some(g) = generated {
        let _ = write!(out, r#","g":{g}"#);
    }
    out.push('}');
    out
}

/// Byte length of the longest common prefix of `a` and `b`, snapped DOWN to a
/// char boundary so slicing either string there is always valid.
fn common_prefix_bytes(a: &str, b: &str) -> usize {
    let raw = a
        .as_bytes()
        .iter()
        .zip(b.as_bytes())
        .take_while(|(x, y)| x == y)
        .count();
    let mut cut = raw;
    while cut > 0 && !a.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

/// Collapse key for a `message_update` frame: always supersedable per message
/// id — a newer update fully contains the older, delta or not — but only when
/// the frame actually carries an id to key on.
fn update_collapse(event: &Value) -> Collapse {
    if event.get("type").and_then(Value::as_str) != Some("message_update") {
        return Collapse::None;
    }
    // Only ASSISTANT updates form a chain. A user message_update carries no
    // stream to supersede, and giving it a chain key would let conflation drop
    // a frame that nothing else re-sends.
    let message = match event.get("message") {
        Some(m) if m.get("role").and_then(Value::as_str) == Some("assistant") => m,
        _ => return Collapse::None,
    };
    match chain_id(message) {
        Some(id) => Collapse::Update(Arc::from(id)),
        None => Collapse::None,
    }
}

/// Collapse key for a non-update event type. State and agent snapshots have
/// independent keys: only a newer snapshot of the SAME kind contains the older
/// one. Agent snapshots must also survive unrelated queue pressure. Everything else
/// (lifecycle, tool/thinking streams, notice, error, entries, …) is one-shot:
/// conflation would lose frames forever.
fn collapse_for(etype: &str) -> Collapse {
    match etype {
        "collab_state" => Collapse::State,
        "collab_agents" => Collapse::Agents,
        _ => Collapse::None,
    }
}

/// A `tool_execution_update` carries the tool's ACCUMULATED partial result, so
/// a newer one for the same call fully contains the older: supersedable per
/// call id. One-shot, they queued at ~20 Hz per phone socket and a slow link
/// replayed every intermediate snapshot. Keyed apart from message chains so a
/// call id can never collide with an assistant message id.
fn tool_update_collapse(event: &Value) -> Collapse {
    event
        .get("toolCallId")
        .and_then(Value::as_str)
        .map_or(Collapse::None, |id| {
            Collapse::Update(Arc::from(format!("tool:{id}")))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A streamed assistant message_update event.
    fn update(id: &str, content: &str) -> Value {
        json!({"type": "message_update", "message": {"role": "assistant", "id": id, "content": content}})
    }

    #[test]
    fn tool_updates_conflate_per_call_and_never_with_messages() {
        let tool = |id: &str| json!({"type": "tool_execution_update", "toolCallId": id});
        assert_eq!(
            tool_update_collapse(&tool("c1")),
            tool_update_collapse(&tool("c1"))
        );
        assert_ne!(
            tool_update_collapse(&tool("c1")),
            tool_update_collapse(&tool("c2"))
        );
        // A call id equal to a message id must not supersede that message's frames.
        assert_ne!(
            tool_update_collapse(&tool("m1")),
            update_collapse(&update("m1", "x"))
        );
        // No id, no key: an unkeyed snapshot must never replace another.
        assert_eq!(
            tool_update_collapse(&json!({"type": "tool_execution_update"})),
            Collapse::None
        );
    }

    #[test]
    fn monotone_prefix_yields_exact_appended_suffix() {
        let enc = DeltaEncoder::new();
        // First update for a message: no stored text -> no delta, but the
        // full text becomes the base for the next update.
        assert_eq!(enc.core_delta("s1", "m1", "Hello, wo", None, 1), None);
        let (base, delta) = enc
            .core_delta("s1", "m1", "Hello, world!", None, 2)
            .unwrap();
        assert_eq!(
            base, 1,
            "delta must continue from the seq that carried the base text"
        );
        assert_eq!(&*delta, r#"{"type":"md","id":"m1","a":"rld!"}"#);
        // Subsequent appends chain from the latest forwarded seq.
        let (base, delta) = enc
            .core_delta("s1", "m1", "Hello, world! How", None, 3)
            .unwrap();
        assert_eq!(base, 2);
        assert_eq!(&*delta, r#"{"type":"md","id":"m1","a":" How"}"#);
    }

    #[test]
    fn delta_escapes_quotes_newlines_and_unicode() {
        // serde_json escapes quotes and control chars; non-ASCII stays
        // literal UTF-8 (the phone's JSON.parse decodes identically).
        let frame = delta_frame("m1", "say \"hi\"\nnext → 😀", None, None);
        assert_eq!(
            frame,
            r#"{"type":"md","id":"m1","a":"say \"hi\"\nnext → 😀"}"#
        );
    }

    #[test]
    fn block_content_concatenates_for_delta_base() {
        // omp providers also send content as a list of blocks; the delta base
        // is the concatenated text (same rule as bench/wire.py extract_text).
        let e = json!({"type": "message_update", "message": {"role": "assistant", "id": "m1", "content": [{"type": "text", "text": "Hel"}, {"type": "tool", "tool": "x"}, {"type": "text", "text": "lo"}]}});
        let (id, text, _) = assistant_update_parts(&e).unwrap();
        assert_eq!(id, "m1");
        assert_eq!(text, "Hello");
        let enc = DeltaEncoder::new();
        assert_eq!(enc.core_delta("s1", &id, &text, None, 1), None);
        let (_, delta) = enc.core_delta("s1", &id, "Hello, world!", None, 2).unwrap();
        assert_eq!(&*delta, r#"{"type":"md","id":"m1","a":", world!"}"#);
    }

    #[test]
    fn thinking_and_tool_args_count_as_generated_while_text_stands_still() {
        // A model that is thinking, then streaming a tool call, leaves the
        // visible text unchanged: without `g` every one of these updates was
        // an empty `{"a":""}` and the phone saw zero output for the whole span.
        let update = |thinking: &str, args: &str| {
            json!({"type": "message_update", "message": {"role": "assistant", "responseId": "r1", "content": [
                {"type": "thinking", "thinking": thinking},
                {"type": "text", "text": "Hi"},
                {"type": "toolCall", "id": "t1", "name": "write", "arguments": {}, "partialJson": args},
            ]}})
        };
        let enc = DeltaEncoder::new();
        let (id, text, g) = assistant_update_parts(&update("Let me", "")).unwrap();
        assert_eq!(g, 8);
        assert_eq!(enc.core_delta("s1", &id, &text, Some(g), 1), None);
        let (id, text, g) = assistant_update_parts(&update("Let me think", r#"{"path":"#)).unwrap();
        assert_eq!(text, "Hi", "the diff base stays the visible text");
        let (_, delta) = enc.core_delta("s1", &id, &text, Some(g), 2).unwrap();
        assert_eq!(&*delta, r#"{"type":"md","id":"r1","a":"","g":22}"#);
    }

    #[test]
    fn message_end_prunes_that_message_only() {
        let enc = DeltaEncoder::new();
        assert_eq!(enc.core_delta("s1", "m1", "a", None, 1), None);
        assert_eq!(enc.core_delta("s1", "m2", "b", None, 2), None);
        enc.prune_message("s1", "m1");
        // m1's state is gone: its next update is a full frame again.
        assert_eq!(enc.core_delta("s1", "m1", "a fresh", None, 3), None);
        // m2 is untouched: still delta-eligible.
        let (base, _) = enc.core_delta("s1", "m2", "b more", None, 4).unwrap();
        assert_eq!(base, 2);
        // m1 was re-tracked above, so the session survives m2's pruning; only
        // when its LAST tracked message goes does the session entry disappear.
        enc.prune_message("s1", "m2");
        enc.prune_message("s1", "m1");
        assert!(
            enc.inner
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .sessions
                .is_empty()
        );
    }

    #[test]
    fn rewrite_becomes_a_suffix_replacement() {
        let enc = DeltaEncoder::new();
        assert_eq!(enc.core_delta("s1", "m1", "original draft", None, 1), None);
        // A full rewrite shares no prefix: keep 0, then append everything. The
        // frame is still emitted; `encode_event` drops it if it is not smaller
        // than the canonical frame it would replace.
        let (base, delta) = enc
            .core_delta("s1", "m1", "rewritten text", None, 2)
            .unwrap();
        assert_eq!(base, 1);
        assert_eq!(
            &*delta,
            r#"{"type":"md","id":"m1","k":0,"a":"rewritten text"}"#
        );
        // The rewritten text is the new base, so the next append is a plain one.
        let (base, delta) = enc
            .core_delta("s1", "m1", "rewritten text, extended", None, 3)
            .unwrap();
        assert_eq!(base, 2);
        assert_eq!(&*delta, r#"{"type":"md","id":"m1","a":", extended"}"#);
    }

    #[test]
    fn tail_normalisation_keeps_the_shared_prefix() {
        // THE CASE THAT MOTIVATED SUFFIX REPLACEMENT: omp normalises a block's
        // tail when it finalises, so the text stops prefix-extending near the
        // end. Append-only diffing gave up here and re-sent a full snapshot —
        // 5 of 33 updates on a 600-word turn, about 12 KB. Now only the
        // divergent tail travels.
        let enc = DeltaEncoder::new();
        assert_eq!(
            enc.core_delta("s1", "m1", "hello world  \n\n", None, 1),
            None
        );
        let (base, delta) = enc.core_delta("s1", "m1", "hello world", None, 2).unwrap();
        assert_eq!(base, 1);
        // 11 UTF-16 units of "hello world" survive; the trailing whitespace does not.
        assert_eq!(&*delta, r#"{"type":"md","id":"m1","k":11,"a":""}"#);
    }

    #[test]
    fn keep_index_counts_utf16_units_for_the_browser() {
        // `k` is consumed by JS `String.prototype.slice`, which counts UTF-16
        // code units. An emoji is TWO of them, so a byte offset or a scalar
        // count would cut it in half on the client.
        let enc = DeltaEncoder::new();
        assert_eq!(enc.core_delta("s1", "m1", "hi 😀 there", None, 1), None);
        let (_, delta) = enc.core_delta("s1", "m1", "hi 😀 THERE", None, 2).unwrap();
        // "hi " (3) + emoji (2) + " " (1) = 6 units kept.
        assert_eq!(&*delta, r#"{"type":"md","id":"m1","k":6,"a":"THERE"}"#);
    }

    #[test]
    fn turn_end_prunes_the_whole_session() {
        let enc = DeltaEncoder::new();
        assert_eq!(enc.core_delta("s1", "m1", "one", None, 1), None);
        assert_eq!(enc.core_delta("s2", "m9", "two", None, 2), None);
        enc.prune_session("s1");
        // s1 is fully reset...
        assert_eq!(enc.core_delta("s1", "m1", "one again", None, 3), None);
        // ...while s2 keeps its delta state.
        assert!(enc.core_delta("s2", "m9", "two more", None, 4).is_some());
    }

    #[test]
    fn per_session_state_is_bounded() {
        let enc = DeltaEncoder::new();
        // Beyond the cap, every new message evicts the oldest, so a session
        // that never ends cannot grow its map forever.
        for i in 0..(MAX_MESSAGES_PER_SESSION + 8) {
            let id = format!("m{i}");
            assert_eq!(enc.core_delta("s1", &id, "x", None, i as u64), None);
        }
        let inner = enc.inner.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(
            inner.sessions["s1"].messages.len(),
            MAX_MESSAGES_PER_SESSION
        );
        assert_eq!(inner.total, MAX_MESSAGES_PER_SESSION);
        // The oldest message was evicted: it no longer deltas.
        drop(inner);
        assert_eq!(enc.core_delta("s1", "m0", "x more", None, 99), None);
    }

    #[test]
    fn global_state_is_bounded() {
        let enc = DeltaEncoder::new();
        // More distinct sessions than the global cap: eviction is wholesale
        // per stalest session, so total tracked entries never exceed the cap.
        let n = MAX_TOTAL_MESSAGES + 512;
        for i in 0..n {
            let sess = format!("s{i}");
            assert_eq!(enc.core_delta(&sess, "m0", "x", None, i as u64), None);
        }
        let inner = enc.inner.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(inner.total, MAX_TOTAL_MESSAGES);
        assert!(inner.sessions.len() <= MAX_TOTAL_MESSAGES);
    }

    #[test]
    fn delta_only_applies_to_assistant_updates() {
        assert!(assistant_update_parts(&update("m1", "x")).is_some());
        let user = json!({"type": "message_update", "message": {"role": "user", "id": "m1", "content": "x"}});
        assert!(assistant_update_parts(&user).is_none());
        let no_content =
            json!({"type": "message_update", "message": {"role": "assistant", "id": "m1"}});
        assert!(assistant_update_parts(&no_content).is_none());
        // Non-string content shapes (object/absent) fall back to full frames.
        let obj_content = json!({"type": "message_update", "message": {"role": "assistant", "id": "m1", "content": {"type": "text", "text": "x"}}});
        assert!(assistant_update_parts(&obj_content).is_none());
    }

    #[test]
    fn collapse_keys_follow_event_type() {
        // Full-state snapshots are supersedable per session.
        assert_eq!(collapse_for("collab_state"), Collapse::State);
        assert_eq!(collapse_for("collab_agents"), Collapse::Agents);
        // One-shot frames must NEVER collapse (conflation would lose them).
        for t in [
            "message_start",
            "message_end",
            "agent_start",
            "agent_end",
            "turn_end",
            "thinking",
            "tool_use",
            "tool_result",
            "notice",
            "error",
            "entries",
            "bash_result",
            "partial",
            "poll",
            "",
        ] {
            assert_eq!(
                collapse_for(t),
                Collapse::None,
                "type {t:?} must not collapse"
            );
        }
        // message_update conflates per message id; anything without an id (or
        // a non-update) does not.
        assert_eq!(
            update_collapse(&update("m1", "x")),
            Collapse::Update(Arc::from("m1"))
        );
        assert_eq!(
            update_collapse(
                &json!({"type": "message_update", "message": {"role": "user", "content": "x"}})
            ),
            Collapse::None
        );
        assert_eq!(
            update_collapse(&json!({"type": "message_end", "message": {"id": "m1"}})),
            Collapse::None
        );
    }
}
