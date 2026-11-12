//! Private extension handshake around native fresh-plan session creation.
//! Ordinary RPC admission stays closed until the actual writer is re-keyed.

use super::*;
use std::path::Path;
use tokio::io::AsyncWriteExt;

const TITLE: &str = "omp-pulse-plan-transition";

pub(super) fn consume(
    tx: &broadcast::Sender<ChildEvent>,
    children: &Arc<Mutex<HashMap<String, Arc<Child>>>>,
    child: &Arc<Child>,
    frame: &Value,
) -> bool {
    if frame.get("type").and_then(Value::as_str) != Some("extension_ui_request")
        || frame.get("method").and_then(Value::as_str) != Some("confirm")
        || frame.get("title").and_then(Value::as_str) != Some(TITLE)
    {
        return false;
    }
    let Some(id) = frame.get("id").and_then(Value::as_str) else {
        return true;
    };
    let request = frame
        .get("message")
        .and_then(Value::as_str)
        .and_then(|message| message.strip_prefix("omp-pulse:"))
        .and_then(|message| serde_json::from_str::<Value>(message).ok());
    let confirmed = request
        .as_ref()
        .is_some_and(|request| apply_transition(tx, children, child, request));
    let mut line =
        json!({"type":"extension_ui_response", "id":id, "confirmed":confirmed}).to_string();
    line.push('\n');
    // This response alone may cross the exclusive transition fence. Retain
    // the ordinary raw-write lease's uncertainty latch on a failed pipe write.
    let mut lease = {
        let mut gate = lock_poisoned(&child.gate);
        gate.raw_writes += 1;
        RawWriteLease {
            child: Arc::clone(child),
            complete: false,
        }
    };
    let child = Arc::clone(child);
    tokio::spawn(async move {
        let mut stdin = child.stdin.lock().await;
        match stdin.write_all(line.as_bytes()).await {
            Ok(()) => lease.complete(),
            Err(error) => warn!("fresh-plan handshake write failed: {error}"),
        }
    });
    true
}

fn apply_transition(
    tx: &broadcast::Sender<ChildEvent>,
    children: &Arc<Mutex<HashMap<String, Arc<Child>>>>,
    child: &Arc<Child>,
    request: &Value,
) -> bool {
    let Some(from) = request.get("from").and_then(Value::as_str) else {
        return false;
    };
    let Some(to) = request.get("to").and_then(Value::as_str) else {
        return false;
    };
    let mut map = lock_poisoned(children);
    let mut gate = lock_poisoned(&child.gate);
    if !child.alive.load(Ordering::SeqCst)
        || !map
            .get(from)
            .is_some_and(|current| Arc::ptr_eq(current, child))
        || lock_poisoned(&child.session).as_str() != from
    {
        return false;
    }
    match request.get("phase").and_then(Value::as_str) {
        Some("probe") => to == from && gate.ordinary_ready(),
        Some("begin") => {
            if to != from
                || !gate.quiescent()
                || child.streaming.load(Ordering::SeqCst)
                || child.compacting.load(Ordering::SeqCst)
                || lock_poisoned(&child.active_prompt).outstanding(now_ms())
                || background_pending(child.background_since.load(Ordering::SeqCst), now_ms())
                || background_pending(child.btw_since.load(Ordering::SeqCst), now_ms())
                || !lock_poisoned(&child.pending_ui).is_empty()
                || !lock_poisoned(&child.extension_replies).is_empty()
            {
                return false;
            }
            gate.phase = ChildPhase::PlanTransition;
            true
        }
        Some("finish") if gate.phase == ChildPhase::PlanTransition => {
            if from == to {
                gate.phase = ChildPhase::Active;
                return true;
            }
            let destination = Path::new(to);
            // Native newSession uses the same session directory and creates a
            // new file. Never overwrite a different child's routing or owner.
            if destination.parent() != Path::new(from).parent()
                || destination.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                || !destination.is_file()
                || map.contains_key(to)
                || crate::authority::owner::lookup(to).is_some_and(|owner| owner.pid != child.pid)
            {
                return false;
            }
            if crate::authority::owner::declare(to, child.pid, "rpc").is_err() {
                return false;
            }
            let mut binding = lock_poisoned(&child.session);
            lock_poisoned(&child.pending_ui).clear();
            lock_poisoned(&child.feedback).clear();
            lock_poisoned(&child.active_prompt).finish();
            if request.get("follow").and_then(Value::as_bool) == Some(true) {
                let _ = tx.send(ChildEvent::Event {
                    session: from.to_string(),
                    event: json!({"type":"session_follow", "sessionPath":to, "reason":"approved_plan"}),
                    source: Some(child_source_stamp(child)),
                });
            }
            let retired = child_source_stamp(child);
            map.remove(from);
            child.binding_epoch.fetch_add(1, Ordering::SeqCst);
            lock_poisoned(&child.retained_agents).reset(child.binding_epoch.load(Ordering::SeqCst));
            *binding = to.to_string();
            map.insert(to.to_string(), Arc::clone(child));
            *lock_poisoned(&child.session_name) = String::new();
            *lock_poisoned(&child.message_count) = 0;
            *lock_poisoned(&child.context_percent) = None;
            gate.phase = ChildPhase::Active;
            touch_locked(child);
            crate::authority::owner::release(from, child.pid);
            let _ = tx.send(ChildEvent::Event {
                session: from.to_string(),
                event: json!({"type":"session_binding_retired"}),
                source: Some(retired),
            });
            true
        }
        _ => false,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::omp::child::tests::stand_in_child;

    #[tokio::test]
    async fn fresh_plan_rekeys_one_writer_and_owner_before_following_without_touching_source() {
        let child = stand_in_child();
        let root =
            std::env::temp_dir().join(format!("pulse-fresh-plan-{}-{}", child.pid, now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let from = root.join("planning.jsonl").to_string_lossy().into_owned();
        let to = root.join("execution.jsonl").to_string_lossy().into_owned();
        std::fs::write(&from, "original discussion\n").unwrap();
        std::fs::write(&to, "new session\n").unwrap();
        *lock_poisoned(&child.session) = from.clone();
        let children = Arc::new(Mutex::new(HashMap::from([(
            from.clone(),
            Arc::clone(&child),
        )])));
        let (tx, mut rx) = broadcast::channel(16);
        crate::authority::owner::declare(&from, child.pid, "rpc").unwrap();
        assert!(apply_transition(
            &tx,
            &children,
            &child,
            &json!({"phase":"probe","from":from,"to":from})
        ));
        assert!(apply_transition(
            &tx,
            &children,
            &child,
            &json!({"phase":"begin","from":from,"to":from})
        ));
        let (reply, _) = oneshot::channel();
        assert!(
            lock_poisoned(&child.gate)
                .admit_rpc(
                    "late-prompt",
                    "prompt",
                    1,
                    reply,
                    RpcAccess::Bound(&from, 1)
                )
                .is_err(),
            "no prompt can reach the old binding during creation"
        );
        assert!(apply_transition(
            &tx,
            &children,
            &child,
            &json!({"phase":"finish","from":from,"to":to,"follow":true})
        ));
        assert!(!lock_poisoned(&children).contains_key(&from));
        assert!(Arc::ptr_eq(
            lock_poisoned(&children).get(&to).unwrap(),
            &child
        ));
        assert_eq!(lock_poisoned(&child.session).as_str(), to);
        assert_eq!(child.binding_epoch.load(Ordering::SeqCst), 2);
        assert!(crate::authority::owner::lookup(&from).is_none());
        assert_eq!(crate::authority::owner::lookup(&to).unwrap().pid, child.pid);
        assert!(lock_poisoned(&child.gate).ordinary_ready());
        assert_eq!(
            std::fs::read_to_string(&from).unwrap(),
            "original discussion\n"
        );
        match rx.try_recv().unwrap() {
            ChildEvent::Event {
                session,
                event,
                source,
            } => {
                assert_eq!(session, from);
                assert_eq!(event["type"], "session_follow");
                assert_eq!(event["sessionPath"], to);
                assert_eq!(source.unwrap().identity.binding_epoch, 1);
            }
            other => panic!("expected source-scoped follow event, got {other:?}"),
        }
        assert!(
            !apply_transition(
                &tx,
                &children,
                &child,
                &json!({"phase":"finish","from":from,"to":to,"follow":true})
            ),
            "duplicate completion cannot execute or follow twice"
        );
        crate::authority::owner::release(&to, child.pid);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn fresh_plan_refuses_busy_or_conflicting_bindings_and_can_cancel_without_rekeying() {
        let child = stand_in_child();
        let other = stand_in_child();
        let from = lock_poisoned(&child.session).clone();
        let to = "/synthetic/other.jsonl";
        let children = Arc::new(Mutex::new(HashMap::from([
            (from.clone(), Arc::clone(&child)),
            (to.to_string(), Arc::clone(&other)),
        ])));
        let (tx, mut rx) = broadcast::channel(16);
        child.streaming.store(true, Ordering::SeqCst);
        assert!(!apply_transition(
            &tx,
            &children,
            &child,
            &json!({"phase":"begin","from":from,"to":from})
        ));
        child.streaming.store(false, Ordering::SeqCst);
        assert!(apply_transition(
            &tx,
            &children,
            &child,
            &json!({"phase":"begin","from":from,"to":from})
        ));
        assert!(!apply_transition(
            &tx,
            &children,
            &child,
            &json!({"phase":"finish","from":from,"to":to,"follow":true})
        ));
        assert!(Arc::ptr_eq(
            lock_poisoned(&children).get(to).unwrap(),
            &other
        ));
        assert_eq!(lock_poisoned(&child.session).as_str(), from);
        assert!(apply_transition(
            &tx,
            &children,
            &child,
            &json!({"phase":"finish","from":from,"to":from})
        ));
        assert!(lock_poisoned(&child.gate).ordinary_ready());
        assert!(rx.try_recv().is_err());
    }
}
