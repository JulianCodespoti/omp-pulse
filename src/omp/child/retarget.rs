//! Re-keying a live idle child to another session file: retargeting it at the
//! cap instead of evicting it, and following omp's fork to the copy.

use super::*;
use crate::{metrics, types::ChildEvent};

use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tracing::{debug, info};

fn retarget_ready(child: &Child, gate: &ChildGate) -> bool {
    child.alive.load(Ordering::SeqCst)
        && !child_busy_locked(child, gate, now_ms())
        && lock_poisoned(&child.active_prompt).command_id().is_none()
}

impl ChildManager {
    /// Re-target the least-recently-active IDLE child to `session_path` when
    /// the pool is at the cap, instead of evicting it: switch_session on a
    /// warm child (59-444 ms measured) beats kill+spawn (1.3-2.7 s boot +
    /// 281 MiB) and adds zero memory. switch_session REPLACES the in-memory
    /// entry list and message array wholesale — no merge, no cross-session
    /// bleed — but retained RSS does NOT come back on switch, so the RSS
    /// recycler (`child_rss_mb`) remains the generational bound on a
    /// long-lived multiplexed child. Serialized by `retarget_lock` so two
    /// concurrent at-cap opens cannot both pick the same child; re-checks the
    /// pool and re-picks under the lock. Never touches a streaming child or
    /// one awaiting a phone answer (a switch would abort an in-flight turn).
    /// Any error falls back to evict+spawn — correctness beats the 444 ms.
    /// Only boot and this exclusive capability can switch; the generic RPC
    /// surface cannot move a child behind its registry key.
    pub(super) async fn retarget_idle(&self, session_path: &str) -> bool {
        let _guard = self.retarget_lock.lock().await;
        if self.live_count() > self.config.max_children {
            return false;
        }
        // Selection and acquisition share registry -> gate ordering. Selection
        // is only a hint; recheck the winner before retaining its capability.
        let candidate = {
            let map = lock_poisoned(&self.children);
            let oldest = map
                .iter()
                .filter_map(|(path, child)| {
                    let gate = lock_poisoned(&child.gate);
                    retarget_ready(child, &gate).then(|| (path.clone(), Arc::clone(child)))
                })
                .min_by_key(|(_, child)| child.last_active.load(Ordering::SeqCst));
            oldest.and_then(|(path, child)| {
                let lease = {
                    let mut gate = lock_poisoned(&child.gate);
                    if !retarget_ready(&child, &gate)
                        || lock_poisoned(&child.session).as_str() != path
                    {
                        return None;
                    }
                    let token = gate.token().ok()?;
                    gate.phase = ChildPhase::Retargeting(token);
                    child.busy_may_have_changed();
                    RetargetLease {
                        child: Arc::clone(&child),
                        token,
                    }
                };
                let epoch = child.binding_epoch.load(Ordering::SeqCst);
                Some((path, child, epoch, lease))
            })
        };
        let Some((old_path, child, epoch, lease)) = candidate else {
            return false;
        };
        let sw = match Self::rpc_with_id(
            &child,
            &self.next_rpc_id(),
            "switch_session",
            json!({ "sessionPath": session_path }),
            SWITCH_SESSION_TIMEOUT,
            RpcAccess::Retarget(lease.token),
        )
        .await
        {
            Ok(sw) => sw,
            Err(e) => {
                debug!("retarget switch_session failed ({e}); falling back to spawn");
                return false; // lease quarantines an uncertain binding
            }
        };
        if sw.get("cancelled").and_then(Value::as_bool) == Some(true) {
            lock_poisoned(&child.gate).end_retarget(lease.token, true);
            return false;
        }
        // Hold exclusive ownership through refresh, even after switch ACK.
        if let Err(e) = Self::rpc_with_id(
            &child,
            &self.next_rpc_id(),
            "get_state",
            Value::Null,
            GET_STATE_TIMEOUT,
            RpcAccess::Retarget(lease.token),
        )
        .await
        {
            debug!("retarget get_state refresh failed (non-fatal): {e}");
        }
        let retired_source = {
            let mut map = lock_poisoned(&self.children);
            let mut gate = lock_poisoned(&child.gate);
            if !child.alive.load(Ordering::SeqCst)
                || gate.phase != ChildPhase::Retargeting(lease.token)
                || child.binding_epoch.load(Ordering::SeqCst) != epoch
                || !map
                    .get(&old_path)
                    .is_some_and(|current| Arc::ptr_eq(current, &child))
                || map
                    .get(session_path)
                    .is_some_and(|current| !Arc::ptr_eq(current, &child))
            {
                return false;
            }
            let mut binding = lock_poisoned(&child.session);
            if binding.as_str() != old_path {
                return false;
            }
            let _ = self.tx.send(ChildEvent::Event {
                session: old_path.clone(),
                event: json!({"type":"extension_ui_snapshot","requests":[]}),
                source: Some(child_source_stamp(&child)),
            });
            let retired_source = child_source_stamp(&child);
            map.remove(&old_path);
            if binding.as_str() != session_path {
                child.binding_epoch.fetch_add(1, Ordering::SeqCst);
                lock_poisoned(&child.retained_agents)
                    .reset(child.binding_epoch.load(Ordering::SeqCst));
                lock_poisoned(&child.feedback).clear();
                *binding = session_path.to_string();
            }
            map.insert(session_path.to_string(), Arc::clone(&child));
            touch_locked(&child);
            gate.end_retarget(lease.token, true);
            retired_source
        };
        let _ = self.tx.send(ChildEvent::Event {
            session: old_path.clone(),
            event: json!({"type":"session_binding_retired"}),
            source: Some(retired_source),
        });
        crate::authority::owner::release(&old_path, child.pid);
        let _ = crate::authority::owner::declare(session_path, child.pid, "rpc");
        metrics::inc("child_retarget");
        info!("retargeted idle child ({old_path}) -> {session_path}");
        true
    }

    /// omp's `/fork` on a session this daemon's child writes: RPC `fork` with
    /// no `entryId` copies the WHOLE session (artifacts included) into a new
    /// file and the child carries on there, exactly as the TUI's
    /// `handleForkCommand`. The child is then re-keyed to the copy, so a later
    /// request for the source boots or retargets a writer for the untouched
    /// original instead of landing in the fork. Exclusive from the idle check
    /// through the re-key, like a retarget: no request can reach the child
    /// while its file changes under the old key, and an outcome that leaves
    /// the child's file unknown quarantines it (the lease's drop).
    ///
    /// Returns the new session file, or None when omp cancelled the fork.
    pub async fn fork_session(&self, session_path: &str) -> Result<Option<String>, String> {
        let child = self
            .child(session_path)
            .ok_or_else(|| "agent process not running".to_string())?;
        let (epoch, lease) = {
            let map = lock_poisoned(&self.children);
            let mut gate = lock_poisoned(&child.gate);
            if !map
                .get(session_path)
                .is_some_and(|current| Arc::ptr_eq(current, &child))
                || lock_poisoned(&child.session).as_str() != session_path
            {
                return Err("agent process session binding changed".to_string());
            }
            // omp refuses a fork while work could still write into the
            // transcript (`requireIdle`); say so before taking the child.
            if !retarget_ready(&child, &gate) {
                return Err(
                    "Wait for the current response to finish or abort it before forking."
                        .to_string(),
                );
            }
            let token = gate.token()?;
            gate.phase = ChildPhase::Retargeting(token);
            child.busy_may_have_changed();
            let lease = RetargetLease {
                child: Arc::clone(&child),
                token,
            };
            (child.binding_epoch.load(Ordering::SeqCst), lease)
        };
        let forked = Self::rpc_with_id(
            &child,
            &self.next_rpc_id(),
            "fork",
            json!({}),
            SWITCH_SESSION_TIMEOUT,
            RpcAccess::Retarget(lease.token),
        )
        .await;
        // Whatever the answer said, the file the child writes now decides the
        // key. A timed-out fork leaves an abandoned request, which refuses
        // this read and so quarantines the child.
        let current = Self::rpc_with_id(
            &child,
            &self.next_rpc_id(),
            "get_state",
            Value::Null,
            GET_STATE_TIMEOUT,
            RpcAccess::Retarget(lease.token),
        )
        .await
        .ok()
        .and_then(|state| {
            state
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        let stayed = current.as_deref() == Some(session_path);
        let new_path = match forked {
            Err(e) => {
                if stayed {
                    lock_poisoned(&child.gate).end_retarget(lease.token, true);
                }
                return Err(e);
            }
            Ok(data) if data.get("cancelled").and_then(Value::as_bool) == Some(true) => {
                if stayed {
                    lock_poisoned(&child.gate).end_retarget(lease.token, true);
                    return Ok(None);
                }
                return Err("fork was cancelled but the session file changed".to_string());
            }
            Ok(_) => match current {
                Some(path) if !stayed && !path.is_empty() => path,
                _ => return Err("fork: the agent did not report the new session".to_string()),
            },
        };
        let retired_source = {
            let mut map = lock_poisoned(&self.children);
            let mut gate = lock_poisoned(&child.gate);
            if !child.alive.load(Ordering::SeqCst)
                || gate.phase != ChildPhase::Retargeting(lease.token)
                || child.binding_epoch.load(Ordering::SeqCst) != epoch
                || !map
                    .get(session_path)
                    .is_some_and(|current| Arc::ptr_eq(current, &child))
                || map
                    .get(&new_path)
                    .is_some_and(|current| !Arc::ptr_eq(current, &child))
            {
                return Err("agent process changed during the fork".to_string());
            }
            let mut binding = lock_poisoned(&child.session);
            if binding.as_str() != session_path {
                return Err("agent process session binding changed".to_string());
            }
            lock_poisoned(&child.feedback).clear();
            let _ = self.tx.send(ChildEvent::Event {
                session: session_path.to_string(),
                event: json!({"type":"extension_ui_snapshot","requests":[]}),
                source: Some(child_source_stamp(&child)),
            });
            let retired_source = child_source_stamp(&child);
            map.remove(session_path);
            child.binding_epoch.fetch_add(1, Ordering::SeqCst);
            lock_poisoned(&child.retained_agents).reset(child.binding_epoch.load(Ordering::SeqCst));
            *binding = new_path.clone();
            map.insert(new_path.clone(), Arc::clone(&child));
            touch_locked(&child);
            gate.end_retarget(lease.token, true);
            retired_source
        };
        let _ = self.tx.send(ChildEvent::Event {
            session: session_path.to_string(),
            event: json!({"type":"session_binding_retired"}),
            source: Some(retired_source),
        });
        crate::authority::owner::release(session_path, child.pid);
        let _ = crate::authority::owner::declare(&new_path, child.pid, "rpc");
        metrics::inc("child_fork");
        info!("forked child session {session_path} -> {new_path}");
        Ok(Some(new_path))
    }
}
