//! Stored-link registry (`<state_dir>/collab.json`): the persisted session and
//! room → link map that the attach path and the self-hosted relay share.

use super::*;

use crate::types::Config;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use tracing::warn;

/// Persisted `sessionPath → collab link` / `roomId → collab link` map plus a
/// derived in-memory `roomId → lookup key` index. The desktop TUI never
/// writes its collab link to disk, so the first attach is scan-or-paste; once
/// the daemon has seen a link it remembers it here and auto-attaches on
/// future WS connects. The room index lets the self-hosted relay look a live
/// room up by id (the host connects with a bare roomId — no secret on the
/// wire) and spawn its internal tap with the stored link's key. Room-keyed
/// entries are registered by the `omp_pulse term` host (`register_room_link`)
/// BEFORE any session file exists, so the tap can start as soon as the host
/// connects. Writes are atomic (tmp + rename) so a crash mid-write never
/// corrupts the last good map; a missing or corrupt file loads empty (the
/// user just pastes the link again).
pub(super) struct LinkRegistry {
    pub(super) path: PathBuf,
    /// `sessionPath → collab link` AND `roomId → collab link` AND
    /// `id:<sessionId> → collab link` (persisted). The key spaces never
    /// collide: session paths always contain `/`, room ids are bare
    /// base64url, and announced session ids carry the `id:` prefix. (`id:`
    /// keys are how a host announces a session without any link touching
    /// the phone; a downgraded binary misclassifies them as room keys and
    /// may prune them — re-announce recreates, no data loss.)
    pub(super) map: Mutex<HashMap<String, String>>,
    /// `roomId → lookup key` (a session path, or the bare room id for a
    /// host-registered link) — in-memory only, rebuilt from `map` on load.
    pub(super) by_room: Mutex<HashMap<String, String>>,
}

/// Live registries by registry file, kept weakly: `CollabManager` and
/// `RelayManager` are constructed separately in main.rs but must agree on
/// ONE registry, otherwise a link the attach path stores at runtime would
/// never reach the relay's room index. Weak refs let a registry die with
/// its last owner (tests, reconfiguration); the next load rebuilds from the
/// file.
static LINK_REGISTRIES: std::sync::LazyLock<Mutex<HashMap<PathBuf, Weak<LinkRegistry>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

impl LinkRegistry {
    pub(super) fn load(config: &Config) -> Arc<LinkRegistry> {
        // The canonical location is Paths.collab_file (<state_dir>/collab.json); the
        // legacy ~/.omp/omp-pulse.collab.json is copied there by the startup
        // migration, so reading anywhere else would make a migrated user's rooms
        // silently invisible.
        let path = config.paths.collab_file.clone();
        // Reuse the live shared registry for this path, if one exists.
        if let Ok(regs) = LINK_REGISTRIES.lock()
            && let Some(weak) = regs.get(&path)
            && let Some(arc) = weak.upgrade()
        {
            return arc;
        }
        let map = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<HashMap<String, String>>(&text) {
                Ok(m) => m,
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "collab link registry corrupt, starting empty");
                    HashMap::new()
                }
            },
            Err(_) => HashMap::new(),
        };
        // Rebuild the room index from the persisted links (best effort: a
        // link that fails to parse has no room mapping). The map holds
        // session-path keys, bare room-id keys (host-registered links) and
        // `id:<sid>` keys (announced sessions); HashMap iteration order is
        // unspecified, so same-room pairs must not race: session keys fill
        // gaps, announced keys fill remaining gaps (explicit mappings always
        // win), room keys insert (authoritative).
        let mut by_room = HashMap::new();
        for (key, link) in &map {
            let Ok(parsed) = parse_collab_link(link) else {
                continue;
            };
            if key.contains('/') || key.ends_with(".jsonl") {
                by_room.entry(parsed.room_id).or_insert_with(|| key.clone());
            } else if let Some(sid) = key.strip_prefix("id:") {
                if !sid.is_empty() {
                    by_room.entry(parsed.room_id).or_insert_with(|| key.clone());
                }
            } else {
                by_room.insert(parsed.room_id, key.clone());
            }
        }
        let registry = Arc::new(LinkRegistry {
            path: path.clone(),
            map: Mutex::new(map),
            by_room: Mutex::new(by_room),
        });
        if let Ok(mut regs) = LINK_REGISTRIES.lock() {
            regs.insert(path, Arc::downgrade(&registry));
        }
        registry
    }

    pub(super) fn stored_link(&self, session_path: &str) -> Option<String> {
        match self.map.lock() {
            Ok(g) => g.get(session_path).cloned(),
            Err(p) => p.into_inner().get(session_path).cloned(),
        }
    }

    /// The stored collab link for a live room id, if any — the relay uses it
    /// to auto-tap a room whose link was remembered by an earlier attach or
    /// registered by the terminal host.
    pub(super) fn stored_link_for_room(&self, room_id: &str) -> Option<String> {
        let key = match self.by_room.lock() {
            Ok(g) => g.get(room_id).cloned(),
            Err(p) => p.into_inner().get(room_id).cloned(),
        }?;
        self.stored_link(&key)
    }

    pub(super) fn remember_link(&self, session_path: &str, link: &str) {
        {
            let mut g = match self.map.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.insert(session_path.to_string(), link.to_string());
        }
        // Keep the room index consistent: a session re-attaching to a new
        // room drops its old mapping. Two sessions sharing one room is never
        // intended (one prompt/abort then drives both phone conversations, and
        // identical titles hide which is which) — log it loudly for diagnosis.
        // INVARIANT (session-ownership): this changes nothing about write
        // routing; it only observes.
        if let Ok(parsed) = parse_collab_link(link) {
            let mut rooms = match self.by_room.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if let Some(other) = rooms.get(&parsed.room_id)
                && other != session_path
            {
                warn!(room = %parsed.room_id, first = %other, second = %session_path,
                        "collab room shared by two sessions; prompts/aborts in either drive the same desktop session");
            }
            rooms.retain(|_, session| session != session_path);
            rooms.insert(parsed.room_id, session_path.to_string());
        }
        self.persist();
    }

    /// Announce a host link for an omp SESSION ID (the `id` in the session
    /// file header): the zero-link introduction path. A host that can reach
    /// the daemon (today: a future auto-sharing TUI over loopback+token; the
    /// phone never sees links) declares which room carries a session, and
    /// opening that session auto-attaches. Stored durably under an `id:<sid>`
    /// key beside the session-path and room-id keys, so it survives daemon
    /// restarts exactly like a remembered link. Returns the room id.
    /// Precedence is explicit-first: the room index keeps an existing
    /// (explicitly attached) lookup key via or_insert, and `remember_link`
    /// overwrites with the session path on explicit attach.
    pub(super) fn announce_session_link(
        &self,
        session_id: &str,
        link: &str,
    ) -> Result<String, String> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Err("sessionId required".to_string());
        }
        let parsed = parse_collab_link(link)?;
        let room_id = parsed.room_id.clone();
        let key = format!("id:{sid}");
        {
            let mut g = match self.map.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.insert(key.clone(), link.to_string());
        }
        {
            let mut rooms = match self.by_room.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            rooms.entry(room_id.clone()).or_insert(key);
        }
        self.persist();
        Ok(room_id)
    }

    /// The announced link for an omp session id, if any.
    fn link_for_session_id(&self, session_id: &str) -> Option<String> {
        let key = format!("id:{}", session_id.trim());
        match self.map.lock() {
            Ok(g) => g.get(&key).cloned(),
            Err(p) => p.into_inner().get(&key).cloned(),
        }
    }

    /// The link to auto-attach with, in preference order: an explicitly
    /// remembered session link first, then an announced session-id mapping.
    /// Every automatic path (socket attach, write path, explicit attach
    /// without a link) shares this order, so behavior never depends on which
    /// door the user came through.
    pub(super) fn auto_attach_link(
        &self,
        session_path: &str,
        session_id: Option<&str>,
    ) -> Option<String> {
        if let Some(link) = self.stored_link(session_path) {
            return Some(link);
        }
        session_id
            .filter(|s| !s.trim().is_empty())
            .and_then(|s| self.link_for_session_id(s))
    }

    pub(super) fn forget_link(&self, session_path: &str) {
        let mut removed = {
            let mut g = match self.map.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.remove(session_path).is_some()
        };
        // Detaching must also drop an announced mapping for this session, or
        // the next open would silently re-attach what the user just detached.
        // (Two files sharing one header id share the mapping: detaching one
        // detaches the lineage. Session ids are unique per conversation
        // outside forks, where sharing the host is the honest behavior.)
        if let Some(id) =
            crate::sessions::jsonl::parse_header(std::path::Path::new(session_path)).id
        {
            removed |= self.forget_session_id(&id);
        }
        {
            let mut rooms = match self.by_room.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let before = rooms.len();
            rooms.retain(|_, session| session != session_path);
            removed |= rooms.len() != before;
        }
        if removed {
            self.persist();
        }
    }

    /// Drop the announced mapping for a session id (plus room-index refs at
    /// it), e.g. when its announcement file is deleted. Shared with
    /// `forget_link`, which resolves the id from the session header.
    fn forget_session_id(&self, session_id: &str) -> bool {
        let id_key = format!("id:{}", session_id.trim());
        let mut removed = {
            let mut g = match self.map.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.remove(&id_key).is_some()
        };
        {
            let mut rooms = match self.by_room.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let before = rooms.len();
            rooms.retain(|_, v| v != &id_key);
            removed |= rooms.len() != before;
        }
        if removed {
            self.persist();
        }
        removed
    }

    /// Register a collab link keyed by ROOM id only — no session path known
    /// yet. The `omp_pulse term` host path: the daemon scrapes the link the
    /// TUI prints and posts it here before any session file exists. The link
    /// is stored durably (same atomic persist) and `stored_link_for_room`
    /// sees it immediately, so a host connecting for the room is tapped;
    /// when the tap later resolves the session it calls `remember_link` so
    /// session-keyed auto-attach works too.
    pub fn register_room_link(&self, link: &str) -> Result<(), String> {
        let parsed = parse_collab_link(link)?;
        let room_id = parsed.room_id;
        {
            let mut g = match self.map.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.insert(room_id.clone(), link.to_string());
        }
        // Room-keyed entries are authoritative for room lookups: point the
        // room at its own key (a later `remember_link` overwrites this with
        // the session path once one exists).
        {
            let mut rooms = match self.by_room.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            rooms.insert(room_id.clone(), room_id.clone());
        }
        self.persist();
        Ok(())
    }

    /// The keys of the ROOM-keyed entries (bare room ids). Session keys
    /// always contain `/` (and end in `.jsonl`), announced session ids carry
    /// the `id:` prefix — both are excluded, so the same classification
    /// `load` uses identifies the host-registered links. Session-keyed and
    /// announced entries are pruned by room (see `prune_rooms`), never as
    /// rooms themselves.
    pub(super) fn room_keys(&self) -> Vec<String> {
        match self.map.lock() {
            Ok(g) => g
                .keys()
                .filter(|k| !k.contains('/') && !k.ends_with(".jsonl") && !k.starts_with("id:"))
                .cloned()
                .collect(),
            Err(p) => p
                .into_inner()
                .keys()
                .filter(|k| !k.contains('/') && !k.ends_with(".jsonl") && !k.starts_with("id:"))
                .cloned()
                .collect(),
        }
    }

    /// The rooms named by announced (`id:`) mappings. Used by dead-room
    /// pruning: an announcement is only as live as its room.
    pub(super) fn announced_rooms(&self) -> Vec<String> {
        let g = match self.map.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.iter()
            .filter(|(k, _)| k.starts_with("id:"))
            .filter_map(|(_, link)| parse_collab_link(link).ok().map(|p| p.room_id))
            .collect()
    }

    /// Drop the given room-keyed entries from the map and the room index,
    /// persisting atomically when anything was removed.
    /// Announced (`id:`) entries whose link points at a dead room go too —
    /// otherwise a dead announcement would trigger a doomed attach attempt
    /// on every open — plus any room-index refs at the removed keys.
    /// Returns how many entries were removed.
    pub(super) fn prune_rooms(&self, dead: &[String]) -> usize {
        if dead.is_empty() {
            return 0;
        }
        let mut removed = 0;
        let dropped_keys: Vec<String>;
        {
            let mut g = match self.map.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            for room in dead {
                if g.remove(room).is_some() {
                    removed += 1;
                }
            }
            // Announced mappings name their room inside the link: drop the
            // ones pointing at dead rooms (a link that fails to parse is
            // left alone — conservative, same as `load`).
            let stale: Vec<String> = g
                .iter()
                .filter(|(k, _)| k.starts_with("id:"))
                .filter(|(_, link)| {
                    parse_collab_link(link)
                        .map(|p| dead.contains(&p.room_id))
                        .unwrap_or(false)
                })
                .map(|(k, _)| k.clone())
                .collect();
            for key in &stale {
                if g.remove(key).is_some() {
                    removed += 1;
                }
            }
            dropped_keys = stale;
        }
        {
            let mut rooms = match self.by_room.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            for room in dead {
                rooms.remove(room);
            }
            for key in &dropped_keys {
                rooms.retain(|_, v| v != key);
            }
        }
        if removed > 0 {
            self.persist();
        }
        removed
    }

    /// Atomic write: serialize the whole map to a sibling tmp file, then
    /// rename over the target (same filesystem ⇒ atomic replace).
    fn persist(&self) {
        let map = match self.map.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let body = match serde_json::to_string_pretty(&*map) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "collab link registry serialize failed");
                return;
            }
        };
        if let Some(parent) = self.path.parent()
            && let Err(e) = std::fs::create_dir_all(parent)
        {
            warn!(path = %self.path.display(), error = %e, "collab link registry dir create failed");
            return;
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, &body) {
            warn!(error = %e, "collab link registry tmp write failed");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &self.path) {
            warn!(error = %e, "collab link registry rename failed");
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_registry_room_index_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-collab-registry-test-{}",
            std::process::id()
        ));
        let key = [7u8; 32];
        let secret = URL_SAFE_NO_PAD.encode(key);
        let room_a = "abcdefghijklmnop".to_string();
        let room_b = "qrstuvwxyz012345".to_string();
        let link_a = format!("ws://127.0.0.1:7682/r/{room_a}.{secret}");
        let link_b = format!("ws://127.0.0.1:7682/r/{room_b}.{secret}");

        let registry = LinkRegistry {
            path: dir.join("omp-pulse.collab.json"),
            map: Mutex::new(HashMap::new()),
            by_room: Mutex::new(HashMap::new()),
        };
        let session = "/sessions/host-a.json";

        assert!(registry.stored_link_for_room(&room_a).is_none());
        registry.remember_link(session, &link_a);
        assert_eq!(
            registry.stored_link_for_room(&room_a).as_deref(),
            Some(link_a.as_str())
        );
        // Re-attaching the same session to a new room drops the old index.
        registry.remember_link(session, &link_b);
        assert!(registry.stored_link_for_room(&room_a).is_none());
        assert_eq!(
            registry.stored_link_for_room(&room_b).as_deref(),
            Some(link_b.as_str())
        );
        registry.forget_link(session);
        assert!(registry.stored_link_for_room(&room_b).is_none());
        assert!(registry.stored_link(session).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn test_registry(dir: std::path::PathBuf) -> LinkRegistry {
        let _ = std::fs::create_dir_all(&dir);
        LinkRegistry {
            path: dir.join("omp-pulse.collab.json"),
            map: Mutex::new(HashMap::new()),
            by_room: Mutex::new(HashMap::new()),
        }
    }

    fn test_link(room: &str) -> String {
        let key = [7u8; 32];
        let secret = URL_SAFE_NO_PAD.encode(key);
        format!("ws://127.0.0.1:7682/r/{room}.{secret}")
    }

    #[test]
    fn announce_stores_by_session_id_with_stored_first_preference() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-collab-announce-test-{}",
            std::process::id()
        ));
        let registry = test_registry(dir.clone());
        let room = "aaaaaaaaaaaaaaaaaaaaaa";
        let link = test_link(room);
        // Junk is rejected before anything is stored.
        assert!(registry.announce_session_link("", &link).is_err());
        assert!(
            registry
                .announce_session_link("sid-1", "not-a-link")
                .is_err()
        );
        assert!(registry.link_for_session_id("sid-1").is_none());
        // Announce stores under the id: key and resolves for auto-attach.
        assert_eq!(
            registry.announce_session_link("sid-1", &link).as_deref(),
            Ok(room)
        );
        assert_eq!(
            registry.link_for_session_id("sid-1").as_deref(),
            Some(link.as_str())
        );
        assert_eq!(
            registry
                .auto_attach_link("/sessions/other.jsonl", Some("sid-1"))
                .as_deref(),
            Some(link.as_str())
        );
        assert!(
            registry
                .auto_attach_link("/sessions/other.jsonl", None)
                .is_none()
        );
        // An explicitly remembered link always wins over an announcement.
        let link2 = test_link("bbbbbbbbbbbbbbbbbbbbbb");
        registry.remember_link("/sessions/other.jsonl", &link2);
        assert_eq!(
            registry
                .auto_attach_link("/sessions/other.jsonl", Some("sid-1"))
                .as_deref(),
            Some(link2.as_str())
        );
        // The room index serves taps for announced rooms without stealing
        // explicit mappings: announce first, then explicit attach.
        let registry2 = test_registry(dir.join("two"));
        registry2.announce_session_link("sid-9", &link).unwrap();
        assert_eq!(
            registry2.stored_link_for_room(room).as_deref(),
            Some(link.as_str())
        );
        registry2.remember_link("/sessions/explicit.jsonl", &link);
        assert_eq!(
            registry2.stored_link_for_room(room).as_deref(),
            Some(link.as_str())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forget_link_drops_announced_mapping() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-collab-forget-test-{}",
            std::process::id()
        ));
        let registry = test_registry(dir.clone());
        let session = dir.join("proj").join("s.jsonl");
        std::fs::create_dir_all(session.parent().unwrap()).unwrap();
        std::fs::write(
            &session,
            "{\"type\":\"session\",\"id\":\"sid-forget\",\"cwd\":\"/tmp\"}\n",
        )
        .unwrap();
        let path = session.to_string_lossy().into_owned();
        let link = test_link("cccccccccccccccccccccc");
        registry.announce_session_link("sid-forget", &link).unwrap();
        assert!(registry.link_for_session_id("sid-forget").is_some());
        registry.forget_link(&path);
        assert!(registry.link_for_session_id("sid-forget").is_none());
        assert!(
            registry
                .auto_attach_link(&path, Some("sid-forget"))
                .is_none()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_rooms_drops_dead_announced_mappings() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-collab-prune-test-{}",
            std::process::id()
        ));
        let registry = test_registry(dir.clone());
        let live = "dddddddddddddddddddddd";
        let dead = "eeeeeeeeeeeeeeeeeeeeee";
        registry
            .announce_session_link("sid-live", &test_link(live))
            .unwrap();
        registry
            .announce_session_link("sid-dead", &test_link(dead))
            .unwrap();
        // Announced keys are not rooms themselves.
        assert!(!registry.room_keys().iter().any(|k| k.starts_with("id:")));
        assert_eq!(registry.prune_rooms(&[dead.to_string()]), 1);
        assert!(registry.link_for_session_id("sid-dead").is_none());
        assert!(registry.link_for_session_id("sid-live").is_some());
        assert!(registry.stored_link_for_room(live).is_some());
        assert!(registry.stored_link_for_room(dead).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_room_link_stores_by_room_and_persists() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-collab-register-test-{}",
            std::process::id()
        ));
        let key = [7u8; 32];
        let secret = URL_SAFE_NO_PAD.encode(key);
        let room = "abcdefghijklmnop".to_string();
        let link = format!("ws://127.0.0.1:7682/r/{room}.{secret}");

        let registry = LinkRegistry {
            path: dir.join("omp-pulse.collab.json"),
            map: Mutex::new(HashMap::new()),
            by_room: Mutex::new(HashMap::new()),
        };
        assert!(registry.stored_link_for_room(&room).is_none());
        // Invalid links are rejected before anything is stored.
        assert!(registry.register_room_link("not-a-link").is_err());
        assert!(registry.stored_link_for_room(&room).is_none());
        // Valid registration works with no session path involved.
        assert!(registry.register_room_link(&link).is_ok());
        assert_eq!(
            registry.stored_link_for_room(&room).as_deref(),
            Some(link.as_str())
        );
        // Session-keyed lookups are unaffected (no session was recorded).
        assert!(registry.stored_link("/sessions/never.jsonl").is_none());
        // A later session mapping for the same room keeps room lookups working.
        registry.remember_link("/sessions/host-a.jsonl", &link);
        assert_eq!(
            registry.stored_link_for_room(&room).as_deref(),
            Some(link.as_str())
        );
        assert_eq!(
            registry.stored_link("/sessions/host-a.jsonl").as_deref(),
            Some(link.as_str())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
