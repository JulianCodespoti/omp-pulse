//! Per-child admission state: the prompt lifecycle, the phase gate that
//! linearises RPCs against retirement, and the RAII leases and waiters around it.

use super::*;

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::oneshot;

/// How long an accepted prompt with no `agent_start` yet keeps the child
/// busy. omp acknowledges a prompt at admission, BEFORE its usage preflight,
/// pending-message flush and pre-prompt compaction (18.8.6
/// `#promptWithMessage` calls `onPromptAdmitted` first), so a pre-start window
/// of seconds to minutes is normal. The bound only frees a child whose
/// reservation leaked (overlapping prompts that all failed stay `Ambiguous`
/// until the next turn ends).
pub(super) const PROMPT_RESERVATION_MAX_MS: u64 = 15 * 60 * 1000;

/// `since` is the unix ms of the latest reservation.
#[derive(Default)]
pub(super) enum PromptLifecycle {
    #[default]
    Idle,
    Claimed {
        id: String,
        since: u64,
    },
    Ambiguous {
        since: u64,
    },
}

impl PromptLifecycle {
    pub(super) fn reserve(&mut self, command_id: &str, now: u64) {
        *self = match self {
            Self::Idle => Self::Claimed {
                id: command_id.to_owned(),
                since: now,
            },
            Self::Claimed { .. } | Self::Ambiguous { .. } => Self::Ambiguous { since: now },
        };
    }

    pub(super) fn command_id(&self) -> Option<&str> {
        match self {
            Self::Claimed { id, .. } => Some(id),
            Self::Idle | Self::Ambiguous { .. } => None,
        }
    }

    /// An accepted prompt has not finished, so its turn may not have started
    /// yet: the window between omp's `response` and `agent_start`.
    pub(super) fn outstanding(&self, now: u64) -> bool {
        match self {
            Self::Idle => false,
            Self::Claimed { since, .. } | Self::Ambiguous { since } => {
                now.saturating_sub(*since) < PROMPT_RESERVATION_MAX_MS
            }
        }
    }

    pub(super) fn clear_if(&mut self, command_id: &str) {
        if self.command_id() == Some(command_id) {
            *self = Self::Idle;
        }
    }

    pub(super) fn finish(&mut self) -> Option<String> {
        match std::mem::take(self) {
            Self::Claimed { id, .. } => Some(id),
            Self::Idle | Self::Ambiguous { .. } => None,
        }
    }
}

// One mutex linearizes observed work with the synchronous retirement request.
// The pending map owns registered work: cancellation marks, never erases it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum ChildPhase {
    #[default]
    Active,
    Retargeting(u64),
    Switching(u64),
    PlanTransition,
    Terminating,
    Finished,
}

pub(super) struct PendingRpc {
    pub(super) token: u64,
    pub(super) command: String,
    pub(super) binding_epoch: u64,
    pub(super) stream_generation: u64,
    pub(super) maintenance_generation: u64,
    pub(super) maintenance_after_commands: bool,
    abandoned: bool,
    operator: bool,
    pub(super) tx: oneshot::Sender<Result<Value, String>>,
}

#[derive(Default)]
pub(super) struct ChildGate {
    pub(super) phase: ChildPhase,
    next_token: u64,
    pub(super) stream_generation: u64,
    /// A command acknowledgement is not completion of native maintenance.
    pub(super) maintenance_pending: bool,
    pub(super) maintenance_generation: u64,
    pub(super) maintenance_probe_running: bool,
    pub(super) pending: HashMap<String, PendingRpc>,
    pub(super) raw_writes: usize,
    unknown_write: bool,
    pub(super) unknown_binding: bool,
    /// Latched before a submitted stop so monitor EOF preserves its meaning.
    pub(super) intended_exit: Option<Exit>,
}

impl ChildGate {
    pub(super) fn ordinary_ready(&self) -> bool {
        self.phase == ChildPhase::Active
            && !self.unknown_write
            && !self.unknown_binding
            && !self.pending.values().any(|rpc| rpc.abandoned)
    }

    pub(super) fn quiescent(&self) -> bool {
        self.ordinary_ready()
            && self.pending.is_empty()
            && self.raw_writes == 0
            && !self.maintenance_pending
    }

    pub(super) fn token(&mut self) -> Result<u64, String> {
        self.next_token = self
            .next_token
            .checked_add(1)
            .ok_or_else(|| "child operation token exhausted".to_string())?;
        Ok(self.next_token)
    }

    pub(super) fn admit_rpc(
        &mut self,
        id: &str,
        command: &str,
        binding_epoch: u64,
        tx: oneshot::Sender<Result<Value, String>>,
        access: RpcAccess<'_>,
    ) -> Result<u64, String> {
        // A bound request cannot change the file behind its registry key.
        // Switching is internal to boot or an exclusive retarget lease,
        // which also owns destination admission and the eventual rekey.
        if command == "switch_session"
            && !matches!(access, RpcAccess::Boot | RpcAccess::Retarget(_))
        {
            return Err("command not allowed".to_string());
        }
        if self.pending.contains_key(id) {
            return Err("duplicate in-flight rpc id".to_string());
        }
        let allowed = match access {
            RpcAccess::Boot | RpcAccess::Bound(_, _) => self.ordinary_ready(),
            RpcAccess::Retarget(token) => {
                self.phase == ChildPhase::Retargeting(token)
                    && !self.unknown_binding
                    && !self.unknown_write
                    && !self.pending.values().any(|rpc| rpc.abandoned)
            }
            RpcAccess::Operator => {
                !matches!(
                    self.phase,
                    ChildPhase::PlanTransition | ChildPhase::Terminating | ChildPhase::Finished
                ) && !self.pending.values().any(|rpc| rpc.operator)
            }
        };
        if !allowed {
            return Err(
                "agent process unavailable: retiring, retargeting, or uncertain work".to_string(),
            );
        }
        let direct_switch =
            command == "switch_session" && !matches!(access, RpcAccess::Retarget(_));
        if direct_switch && (!self.pending.is_empty() || self.raw_writes != 0) {
            return Err("agent process has in-flight work".to_string());
        }
        let token = self.token()?;
        if tracks_maintenance(id, command) {
            self.maintenance_pending = true;
            self.maintenance_generation = self.maintenance_generation.wrapping_add(1);
        }
        if direct_switch {
            self.phase = ChildPhase::Switching(token);
        }
        let maintenance_after_commands =
            command == "get_state" && !self.maintenance_commands_pending();
        self.pending.insert(
            id.to_string(),
            PendingRpc {
                token,
                command: command.to_string(),
                binding_epoch,
                stream_generation: self.stream_generation,
                maintenance_generation: self.maintenance_generation,
                maintenance_after_commands,
                abandoned: false,
                operator: matches!(access, RpcAccess::Operator),
                tx,
            },
        );
        Ok(token)
    }

    pub(super) fn complete_rpc(&mut self, id: &str) -> Option<PendingRpc> {
        let rpc = self.pending.remove(id)?;
        if self.phase == ChildPhase::Switching(rpc.token) {
            self.phase = ChildPhase::Active;
        }
        Some(rpc)
    }

    /// A state read admitted before another command or maintenance event
    /// cannot settle that newer work. A positive sample invalidates older
    /// concurrent false samples just like the streaming snapshot fence.
    /// `after_commands` is captured at admission, not response time: a state
    /// read that overtook the command cannot later settle it after its ack.
    pub(super) fn accept_maintenance_snapshot(
        &mut self,
        generation: u64,
        compacting: bool,
        after_commands: bool,
    ) -> bool {
        if generation != self.maintenance_generation || !after_commands {
            return false;
        }
        if compacting {
            self.maintenance_generation = self.maintenance_generation.wrapping_add(1);
        }
        self.maintenance_pending = self.maintenance_commands_pending();
        true
    }

    pub(super) fn maintenance_commands_pending(&self) -> bool {
        self.pending
            .iter()
            .any(|(id, rpc)| tracks_maintenance(id, &rpc.command))
    }

    pub(super) fn accept_stream_snapshot(&mut self, generation: u64, streaming: bool) -> bool {
        if generation != self.stream_generation {
            return false;
        }
        if streaming {
            // A positive snapshot is observed work too. Older concurrent
            // false snapshots must not erase it; a new query can still refresh.
            self.stream_generation = self.stream_generation.wrapping_add(1);
        }
        true
    }

    fn abandon_rpc(&mut self, id: &str, token: u64) {
        if let Some(rpc) = self.pending.get_mut(id).filter(|rpc| rpc.token == token) {
            rpc.abandoned = true;
            // Both move the child to another session file when they land.
            if matches!(rpc.command.as_str(), "switch_session" | "fork") {
                self.unknown_binding = true;
            }
        }
    }

    pub(super) fn fail_rpc(&mut self, id: &str, token: u64, access: RpcAccess<'_>) {
        if self.pending.get(id).is_none_or(|rpc| rpc.token != token) {
            return;
        }
        if matches!(access, RpcAccess::Boot) {
            // Preserve unregistered boot's non-fatal timeout/write cleanup.
            // Registered ownership is stronger; this private access is never
            // used by a request routed to a registered session.
            self.complete_rpc(id);
        } else {
            self.abandon_rpc(id, token);
        }
    }

    /// Release the unknown-binding latch a failed `switch_session` set on a
    /// child that was never registered. Only its opener talks to such a child,
    /// and the opener registers it only after a later switch_session succeeds
    /// and binds it to the requested file; a second failure latches again.
    pub(super) fn release_boot_switch_failure(&mut self) {
        self.unknown_binding = false;
    }

    pub(super) fn end_retarget(&mut self, token: u64, known_binding: bool) {
        if self.phase == ChildPhase::Retargeting(token) {
            self.unknown_binding |= !known_binding;
            self.phase = ChildPhase::Active;
        }
    }
}

/// Internal request lanes, not slash-command content. These may acknowledge
/// before native maintenance finishes; extension controls have their own
/// completion guard and are deliberately not included.
fn tracks_maintenance(id: &str, command: &str) -> bool {
    matches!(command, "prompt" | "abort_and_prompt")
        && (id.starts_with("pulse-command:") || id.starts_with("pulse-prompt:"))
}

/// Boot is used only before registration. Operator is restricted to the
/// pre-existing explicit/forced graceful abort; it cannot reopen admission.
#[derive(Clone, Copy)]
pub(super) enum RpcAccess<'a> {
    Boot,
    Bound(&'a str, u64),
    Retarget(u64),
    Operator,
}

pub(super) struct RpcWaiter {
    pub(super) child: Arc<Child>,
    pub(super) id: String,
    pub(super) token: u64,
}

impl Drop for RpcWaiter {
    fn drop(&mut self) {
        // A response may already have removed this record, and even allowed
        // reuse of the string ID. Never abandon a replacement waiter.
        lock_poisoned(&self.child.gate).abandon_rpc(&self.id, self.token);
        self.child.busy_may_have_changed();
    }
}

/// Owns one `extension_replies` slot for the lifetime of its request, so a
/// timed-out or cancelled caller never leaves a waiter that keeps the child
/// busy forever.
pub(super) struct ExtensionReplyGuard {
    pub(super) child: Arc<Child>,
    pub(super) req_id: String,
}

impl Drop for ExtensionReplyGuard {
    fn drop(&mut self) {
        lock_poisoned(&self.child.extension_replies).remove(&self.req_id);
        self.child.busy_may_have_changed();
    }
}

/// An extension reply is `{ok:true, ...data}` or `{ok:false, error}`; the
/// error is already a sentence for the phone.
pub(super) fn extension_reply_result(mut reply: Value) -> Result<Value, String> {
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        if let Some(object) = reply.as_object_mut() {
            object.remove("ok");
        }
        return Ok(reply);
    }
    Err(reply
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("The agent couldn't do that.")
        .to_string())
}

pub(super) struct RetargetLease {
    pub(super) child: Arc<Child>,
    pub(super) token: u64,
}

impl Drop for RetargetLease {
    fn drop(&mut self) {
        // Cancellation cannot establish which session the remote now owns.
        lock_poisoned(&self.child.gate).end_retarget(self.token, false);
        self.child.busy_may_have_changed();
    }
}

pub(super) struct RawWriteLease {
    pub(super) child: Arc<Child>,
    pub(super) complete: bool,
}

impl RawWriteLease {
    pub(super) fn complete(&mut self) {
        let mut gate = lock_poisoned(&self.child.gate);
        gate.raw_writes -= 1;
        self.complete = true;
        self.child.busy_may_have_changed();
    }
}

impl Drop for RawWriteLease {
    fn drop(&mut self) {
        if !self.complete {
            let mut gate = lock_poisoned(&self.child.gate);
            gate.raw_writes -= 1;
            gate.unknown_write = true;
            self.child.busy_may_have_changed();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate_admit(gate: &mut ChildGate, id: &str, command: &str) -> u64 {
        let (tx, _rx) = oneshot::channel();
        gate.admit_rpc(id, command, 1, tx, RpcAccess::Bound("/fixture", 1))
            .expect("admit fixture RPC")
    }

    #[test]
    fn maintenance_cannot_settle_from_a_state_read_admitted_before_command_ack() {
        let mut gate = ChildGate::default();
        gate_admit(&mut gate, "pulse-command:c1", "prompt");
        assert!(gate.maintenance_pending);
        assert!(!gate.quiescent());
        gate_admit(&mut gate, "early", "get_state");
        let early = gate.complete_rpc("early").unwrap();
        gate.complete_rpc("pulse-command:c1").unwrap();
        assert!(!early.maintenance_after_commands);
        assert!(!gate.accept_maintenance_snapshot(
            early.maintenance_generation,
            false,
            early.maintenance_after_commands,
        ));
        assert!(gate.maintenance_pending);

        gate_admit(&mut gate, "fresh", "get_state");
        let fresh = gate.complete_rpc("fresh").unwrap();
        assert!(gate.accept_maintenance_snapshot(
            fresh.maintenance_generation,
            false,
            fresh.maintenance_after_commands,
        ));
        assert!(gate.quiescent());
    }

    #[test]
    fn newer_command_and_positive_maintenance_samples_fence_older_idle_samples() {
        let mut gate = ChildGate::default();
        gate_admit(&mut gate, "old", "get_state");
        let old = gate.complete_rpc("old").unwrap();
        gate_admit(&mut gate, "pulse-prompt:c1", "prompt");
        gate.complete_rpc("pulse-prompt:c1").unwrap();
        assert!(!gate.accept_maintenance_snapshot(
            old.maintenance_generation,
            false,
            old.maintenance_after_commands,
        ));
        assert!(gate.maintenance_pending);

        gate_admit(&mut gate, "positive", "get_state");
        gate_admit(&mut gate, "concurrent", "get_state");
        let positive = gate.complete_rpc("positive").unwrap();
        let concurrent = gate.complete_rpc("concurrent").unwrap();
        assert!(gate.accept_maintenance_snapshot(
            positive.maintenance_generation,
            true,
            positive.maintenance_after_commands,
        ));
        assert!(!gate.accept_maintenance_snapshot(
            concurrent.maintenance_generation,
            false,
            concurrent.maintenance_after_commands,
        ));
        gate_admit(&mut gate, "latest", "get_state");
        let latest = gate.complete_rpc("latest").unwrap();
        assert!(gate.accept_maintenance_snapshot(
            latest.maintenance_generation,
            false,
            latest.maintenance_after_commands,
        ));
    }

    #[test]
    fn fixes4_registered_catalogue_timeout_is_not_pool_full_or_boot_cleanup() {
        for command in ["get_available_commands", "get_available_models"] {
            let mut gate = ChildGate::default();
            let access = RpcAccess::Bound("/fixture", 1);
            let (tx, _rx) = oneshot::channel();
            let token = gate.admit_rpc("catalogue", command, 1, tx, access).unwrap();
            gate.fail_rpc("catalogue", token, access);
            assert!(gate.pending["catalogue"].abandoned);
            let (tx, _rx) = oneshot::channel();
            let error = gate
                .admit_rpc("prompt", "prompt", 1, tx, access)
                .unwrap_err();
            assert!(
                agents_busy_message(&error).is_none(),
                "uncertainty must not trigger held-send retries"
            );
            gate.complete_rpc("catalogue").unwrap();
            assert!(gate.quiescent());
        }
    }

    #[test]
    fn gate_boot_timeout_preserves_nonfatal_admission_but_bound_timeout_does_not() {
        for access in [RpcAccess::Boot, RpcAccess::Bound("/fixture", 1)] {
            let mut gate = ChildGate::default();
            let (tx, _rx) = oneshot::channel();
            let token = gate
                .admit_rpc("subscribe", "set_subagent_subscription", 1, tx, access)
                .unwrap();
            gate.fail_rpc("subscribe", token, access);
            let (tx, _rx) = oneshot::channel();
            let following = gate.admit_rpc("switch", "switch_session", 1, tx, access);
            if matches!(access, RpcAccess::Boot) {
                assert!(!gate.pending.contains_key("subscribe"));
                assert!(following.is_ok());
            } else {
                assert!(gate.pending["subscribe"].abandoned);
                assert!(following.is_err());
            }
        }
    }

    #[test]
    fn gate_timeout_retains_exact_rpc_until_late_response() {
        let mut gate = ChildGate::default();
        let token = gate_admit(&mut gate, "slow", "bash");
        gate.abandon_rpc("slow", token);
        assert!(!gate.ordinary_ready());
        assert!(!gate.quiescent());
        assert!(gate.complete_rpc("unrelated").is_none());
        assert_eq!(gate.pending.len(), 1);
        assert_eq!(gate.complete_rpc("slow").expect("late reply").token, token);
        assert!(gate.complete_rpc("slow").is_none());
        assert!(gate.ordinary_ready());
        assert!(gate.quiescent());
    }

    #[test]
    fn gate_all_abandoned_records_must_drain_before_reopening() {
        let mut gate = ChildGate::default();
        let first = gate_admit(&mut gate, "first", "get_state");
        let second = gate_admit(&mut gate, "second", "bash");
        gate_admit(&mut gate, "healthy", "get_messages");
        gate.abandon_rpc("first", first);
        gate.abandon_rpc("second", second);
        gate.complete_rpc("second");
        assert!(!gate.ordinary_ready());
        gate.complete_rpc("first");
        assert!(gate.ordinary_ready());
        assert!(!gate.quiescent()); // healthy RPC still owns the child
        gate.complete_rpc("healthy");
        assert!(gate.quiescent());
    }

    #[test]
    fn gate_duplicate_live_id_preserves_original_sender() {
        let mut gate = ChildGate::default();
        let (tx, mut rx) = oneshot::channel();
        let original = gate
            .admit_rpc("same", "bash", 1, tx, RpcAccess::Boot)
            .unwrap();
        let (replacement, _replacement_rx) = oneshot::channel();
        assert!(
            gate.admit_rpc("same", "bash", 1, replacement, RpcAccess::Boot)
                .is_err()
        );
        let rpc = gate.complete_rpc("same").expect("original record");
        assert_eq!(rpc.token, original);
        rpc.tx.send(Ok(json!({"original": true}))).unwrap();
        assert_eq!(rx.try_recv().unwrap().unwrap(), json!({"original": true}));
    }

    #[test]
    fn gate_old_waiter_token_cannot_abandon_reused_id() {
        let mut gate = ChildGate::default();
        let first = gate_admit(&mut gate, "same", "get_state");
        gate.complete_rpc("same");
        let replacement = gate_admit(&mut gate, "same", "get_state");
        gate.abandon_rpc("same", first);
        assert!(gate.ordinary_ready());
        assert_eq!(gate.pending["same"].token, replacement);
        gate.abandon_rpc("same", replacement);
        assert!(!gate.ordinary_ready());
    }

    #[test]
    fn gate_boot_switch_is_exclusive_until_its_response() {
        let mut gate = ChildGate::default();
        let (tx, _rx) = oneshot::channel();
        let token = gate
            .admit_rpc("switch", "switch_session", 1, tx, RpcAccess::Boot)
            .unwrap();
        assert_eq!(gate.phase, ChildPhase::Switching(token));
        let (tx, _rx) = oneshot::channel();
        assert!(
            gate.admit_rpc("other", "bash", 1, tx, RpcAccess::Boot)
                .is_err()
        );
        assert!(!gate.quiescent());
        gate.complete_rpc("switch");
        assert!(gate.quiescent());
        gate_admit(&mut gate, "read", "get_state");
        let (tx, _rx) = oneshot::channel();
        assert!(
            gate.admit_rpc("switch-again", "switch_session", 1, tx, RpcAccess::Boot)
                .is_err()
        );
    }

    #[test]
    fn gate_raw_switch_cannot_bypass_managed_retargeting() {
        for access in [RpcAccess::Bound("/fixture", 1), RpcAccess::Operator] {
            let mut gate = ChildGate::default();
            let (tx, rx) = oneshot::channel();
            assert_eq!(
                gate.admit_rpc("switch", "switch_session", 1, tx, access)
                    .unwrap_err(),
                "command not allowed"
            );
            assert!(
                rx.blocking_recv().is_err(),
                "no response owner was admitted"
            );
            assert!(gate.pending.is_empty());
            assert!(gate.quiescent());
            // Rejection must not quarantine the existing session writer.
            gate_admit(&mut gate, "state", "get_state");
        }
    }

    #[test]
    fn gate_failed_boot_switch_blocks_until_released_for_the_model_retry() {
        let mut gate = ChildGate::default();
        let (tx, _rx) = oneshot::channel();
        gate.admit_rpc("switch", "switch_session", 1, tx, RpcAccess::Boot)
            .unwrap();
        // handle_response's latch for a failed switch_session.
        gate.unknown_binding = true;
        gate.complete_rpc("switch");
        let (tx, _rx) = oneshot::channel();
        assert!(
            gate.admit_rpc("state", "get_state", 1, tx, RpcAccess::Boot)
                .is_err()
        );
        gate.release_boot_switch_failure();
        let (tx, _rx) = oneshot::channel();
        assert!(
            gate.admit_rpc("state", "get_state", 1, tx, RpcAccess::Boot)
                .is_ok()
        );
        gate.complete_rpc("state");
        let (tx, _rx) = oneshot::channel();
        assert!(
            gate.admit_rpc("retry", "switch_session", 1, tx, RpcAccess::Boot)
                .is_ok()
        );
    }

    #[test]
    fn gate_retarget_capability_outlives_switch_and_refresh_responses() {
        let mut gate = ChildGate::default();
        let owner = gate.token().unwrap();
        gate.phase = ChildPhase::Retargeting(owner);
        for access in [RpcAccess::Boot, RpcAccess::Retarget(owner + 1)] {
            let (tx, _rx) = oneshot::channel();
            assert!(gate.admit_rpc("other", "get_state", 1, tx, access).is_err());
        }
        for (id, command) in [("switch", "switch_session"), ("refresh", "get_state")] {
            let (tx, _rx) = oneshot::channel();
            gate.admit_rpc(id, command, 1, tx, RpcAccess::Retarget(owner))
                .unwrap();
            gate.complete_rpc(id);
            assert_eq!(gate.phase, ChildPhase::Retargeting(owner));
            assert!(!gate.ordinary_ready());
        }
        gate.end_retarget(owner, true);
        assert!(gate.quiescent());
    }

    #[test]
    fn gate_raw_write_and_binding_uncertainty_survive_unrelated_reply() {
        let mut gate = ChildGate::default();
        gate_admit(&mut gate, "read", "get_state");
        gate.unknown_write = true;
        let owner = gate.token().unwrap();
        gate.phase = ChildPhase::Retargeting(owner);
        gate.end_retarget(owner, false);
        gate.complete_rpc("read");
        assert!(gate.pending.is_empty());
        assert!(gate.unknown_write);
        assert!(gate.unknown_binding);
        assert!(!gate.ordinary_ready());
        assert!(!gate.quiescent());
    }

    #[test]
    fn gate_abandoned_fork_leaves_the_binding_unknown() {
        // A fork that lands after the daemon stopped waiting moves the child
        // to the copy under the source's key; nothing may be routed to it.
        let mut gate = ChildGate::default();
        let owner = gate.token().unwrap();
        gate.phase = ChildPhase::Retargeting(owner);
        let (tx, _rx) = oneshot::channel();
        let token = gate
            .admit_rpc("fork", "fork", 1, tx, RpcAccess::Retarget(owner))
            .unwrap();
        gate.fail_rpc("fork", token, RpcAccess::Retarget(owner));
        assert!(gate.unknown_binding);
        gate.end_retarget(owner, true);
        assert!(!gate.ordinary_ready());

        // An abandoned settings write says nothing about the binding.
        let mut gate = ChildGate::default();
        let token = gate_admit(&mut gate, "rename", "set_session_name");
        gate.fail_rpc("rename", token, RpcAccess::Bound("/fixture", 1));
        assert!(!gate.unknown_binding);
    }

    #[test]
    fn gate_operator_bypass_has_one_owned_slot_even_when_abandoned() {
        let mut gate = ChildGate {
            unknown_write: true,
            ..ChildGate::default()
        };
        let (tx, _rx) = oneshot::channel();
        let first = gate
            .admit_rpc("abort", "abort", 1, tx, RpcAccess::Operator)
            .unwrap();
        gate.abandon_rpc("abort", first);
        let (tx, _rx) = oneshot::channel();
        assert!(
            gate.admit_rpc("another-abort", "abort", 1, tx, RpcAccess::Operator)
                .is_err()
        );
        assert_eq!(gate.pending.len(), 1);
        gate.complete_rpc("abort");
        assert!(!gate.ordinary_ready());
        let (tx, _rx) = oneshot::channel();
        assert!(
            gate.admit_rpc("later-abort", "abort", 1, tx, RpcAccess::Operator)
                .is_ok()
        );
    }

    #[test]
    fn gate_positive_state_snapshot_fences_concurrent_false_snapshot() {
        let mut gate = ChildGate::default();
        let concurrent_generation = gate.stream_generation;
        assert!(gate.accept_stream_snapshot(concurrent_generation, true));
        assert!(!gate.accept_stream_snapshot(concurrent_generation, false));
        // A fresh query remains able to observe a now-idle child.
        assert!(gate.accept_stream_snapshot(gate.stream_generation, false));
    }

    #[test]
    fn gate_state_request_remembers_its_admission_generation() {
        let mut gate = ChildGate {
            stream_generation: 8,
            ..ChildGate::default()
        };
        gate_admit(&mut gate, "state", "get_state");
        gate.stream_generation += 1; // an observed lifecycle event
        assert_eq!(gate.pending["state"].stream_generation, 8);
        assert_ne!(
            gate.pending["state"].stream_generation,
            gate.stream_generation
        );
    }

    #[test]
    fn overlapping_prompts_cannot_claim_each_others_turn() {
        let mut lifecycle = PromptLifecycle::default();
        lifecycle.reserve("first", 1);
        assert_eq!(lifecycle.command_id(), Some("first"));
        lifecycle.reserve("second", 1);
        lifecycle.reserve("third", 1);
        assert_eq!(lifecycle.command_id(), None);
        lifecycle.clear_if("first");
        assert_eq!(lifecycle.finish(), None);
        lifecycle.reserve("next-turn", 1);
        assert_eq!(lifecycle.finish().as_deref(), Some("next-turn"));
        assert_eq!(lifecycle.command_id(), None);
    }

    #[test]
    fn extension_reply_result_unwraps_data_or_the_phone_sentence() {
        assert_eq!(
            extension_reply_result(json!({"ok": true, "enabled": false})),
            Ok(json!({"enabled": false}))
        );
        assert_eq!(
            extension_reply_result(json!({"ok": false, "error": "Stop the agent first."})),
            Err("Stop the agent first.".to_string())
        );
        assert_eq!(
            extension_reply_result(json!({"enabled": true})),
            Err("The agent couldn't do that.".to_string())
        );
    }
}
