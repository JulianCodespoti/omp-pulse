//! Debounced needs-input and alert notifications, gated per session and kind.

use super::*;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::sessions::jsonl;

/// Debounce window for `needs_input` pushes: agents can emit several
/// `extension_ui_request` / collab `ui-request` frames in a burst, so at most
/// one push per session per window while those dialogs stay open. Resolving
/// a dialog or ending the turn re-arms the gate ([`rearm_needs_input`]): the
/// next question after an answer is new, and a muted one leaves the agent
/// waiting with the phone in a pocket.
const NEEDS_INPUT_DEBOUNCE: Duration = Duration::from_secs(30);

/// Debounce window for the alert kinds ([`KIND_PROMPT_FAILED`],
/// [`KIND_LINK_LOST`], [`KIND_CHILD_DIED`]): a burst of failures
/// (auto-retry), a flapping collab link or a crash-looping child must each
/// buzz the phone once, not once per event.
const ALERT_DEBOUNCE: Duration = Duration::from_secs(30);

/// Push-kind names. The set is a contract with the phone: the service worker
pub const KIND_AGENT_END: &str = "agent_end";
pub const KIND_NEEDS_INPUT: &str = "needs_input";
pub const KIND_PROMPT_FAILED: &str = "prompt_failed";
pub const KIND_LINK_LOST: &str = "link_lost";
pub const KIND_CHILD_DIED: &str = "child_died";
/// Per-(kind, session) timestamp of the last admitted push, enforcing the
/// debounce windows above. One map for every kind keeps the discipline
/// identical across paths: a `needs_input` from the child forward path, a
/// `needs_input` from the collab forward path and a `prompt_failed` from the
/// router all gate against the SAME per-kind per-session window, so nothing
/// can invent a second, looser mechanism.
static LAST_PUSHED: LazyLock<Mutex<HashMap<(&'static str, String), Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Admit a push of `kind` for `session` iff the previous push of the same
/// kind for the same session is outside `window`; records the admission time
/// on success. A poisoned lock admits nothing: missing one buzz is safer than
/// spamming the device.
fn debounce_admit(kind: &'static str, session: &str, window: Duration) -> bool {
    let now = Instant::now();
    let mut gates = match LAST_PUSHED.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let key = (kind, session.to_string());
    if let Some(prev) = gates.get(&key)
        && now.duration_since(*prev) < window
    {
        return false;
    }
    gates.insert(key, now);
    true
}

/// Re-arm the `needs_input` gate for `session`: a dialog was answered or
/// cancelled, or the turn ended. Called from the child and collab forward
/// paths when they observe the resolution.
pub fn rearm_needs_input(session: &str) {
    if let Ok(mut gates) = LAST_PUSHED.lock() {
        gates.remove(&(KIND_NEEDS_INPUT, session.to_string()));
    }
}

/// Human-readable title for a push: the session's title (the one it was
/// given, else its first prompt, as the list shows it), else the file name,
/// else the raw path.
pub fn session_title(session: &str) -> String {
    let path = Path::new(session);
    jsonl::display_title(path)
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| {
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| session.to_string())
        })
}

/// Best-effort `needs_input` push for a blocking dialog — a child
/// `extension_ui_request` OR a collab `ui-request` — debounced to one push
/// per session per [`NEEDS_INPUT_DEBOUNCE`]. The caller decides the dialog is
/// blocking and extracts the body; this function owns ONLY the debounce gate,
/// the 120-char body cap, and the notify, so both forward paths (main.rs
/// child events, collab.rs forwarded frames) reuse one mechanism. Spawned
/// fire-and-forget like the `agent_end` push; failures are logged by `notify`
/// itself.
pub fn maybe_push_needs_input(push: &Arc<Push>, session: &str, body: &str) {
    maybe_push_needs_input_with_req_id(push, session, body, None);
}

/// Like [`maybe_push_needs_input`], but carries the dialog's `reqId` in the
/// payload (contract: an OPTIONAL JSON number, absent when unknown) so a
/// notification tap can land on the exact question instead of just the
/// session. The caller extracts the reqId: a collab `ui-request` already
/// carries a numeric `reqId`; a child `extension_ui_request` carries a
/// snowflake STRING id that main.rs parses into one.
pub fn maybe_push_needs_input_with_req_id(
    push: &Arc<Push>,
    session: &str,
    body: &str,
    req_id: Option<u64>,
) {
    if !debounce_admit(KIND_NEEDS_INPUT, session, NEEDS_INPUT_DEBOUNCE) {
        return;
    }

    // Cap the preview so a long question cannot bloat a notification.
    let body: String = if body.chars().count() <= 120 {
        body.to_string()
    } else {
        body.chars().take(120).collect()
    };
    let push = Arc::clone(push);
    let title = session_title(session);
    let session = session.to_string();
    tokio::spawn(async move {
        push.notify_with_req_id(&session, &title, &body, KIND_NEEDS_INPUT, req_id)
            .await;
    });
}

/// Debounced best-effort push for an alert kind ([`KIND_PROMPT_FAILED`],
/// [`KIND_LINK_LOST`], [`KIND_CHILD_DIED`]) — the events that strand a phone
/// user. Each kind is gated to one push per session per [`ALERT_DEBOUNCE`],
/// so a burst of failures (auto-retry), a flapping link or a crash-looping
/// child buzzes once, not once per event; the per-kind payload `tag` further
/// makes the service worker replace an older notification of the same kind
/// for the same session. Spawned fire-and-forget like the other pushes;
/// failures are logged by `notify`.
pub fn maybe_push_alert(push: &Arc<Push>, session: &str, body: &str, kind: &'static str) {
    if !debounce_admit(kind, session, ALERT_DEBOUNCE) {
        return;
    }
    // Cap the detail so a long error message cannot bloat a notification.
    let body: String = if body.chars().count() <= 120 {
        body.to_string()
    } else {
        body.chars().take(120).collect()
    };
    let push = Arc::clone(push);
    let title = session_title(session);
    let session = session.to_string();
    tokio::spawn(async move {
        push.notify(&session, &title, &body, kind).await;
    });
}

/// Debounced `link_lost` push. The desktop-link-loss signal lives in
/// collab.rs (the collab guest task / relay teardown), which never passes
/// through main.rs's router — this is the hook collab.rs calls when its link
/// state turns "lost", so the phone learns a session it shared has gone dark.
pub fn maybe_push_link_lost(push: &Arc<Push>, session: &str, detail: &str) {
    maybe_push_alert(push, session, detail, KIND_LINK_LOST);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The debounce admits one push per (kind, session) per window; kinds are
    /// independent, so a failure right after a dialog is a new fact, not a
    /// swallowed duplicate.
    #[test]
    fn debounce_is_per_kind_per_session() {
        assert!(debounce_admit(KIND_NEEDS_INPUT, "s1", NEEDS_INPUT_DEBOUNCE));
        assert!(
            !debounce_admit(KIND_NEEDS_INPUT, "s1", NEEDS_INPUT_DEBOUNCE),
            "same kind + same session inside the window is dropped"
        );
        assert!(
            debounce_admit(KIND_PROMPT_FAILED, "s1", ALERT_DEBOUNCE),
            "a different kind is a new fact"
        );
        assert!(
            debounce_admit(KIND_NEEDS_INPUT, "s2", NEEDS_INPUT_DEBOUNCE),
            "a different session is a new fact"
        );

        // Once the window has elapsed, the same kind + session admits again.
        std::thread::sleep(Duration::from_millis(5));
        assert!(debounce_admit(
            KIND_NEEDS_INPUT,
            "s1",
            Duration::from_millis(1)
        ));
    }

    /// A burst of open dialogs buzzes once, but the question that follows an
    /// answer (or a finished turn) is new and buzzes inside the window.
    #[test]
    fn a_resolved_dialog_rearms_the_needs_input_gate() {
        let s = "rearm-session";
        assert!(debounce_admit(KIND_NEEDS_INPUT, s, NEEDS_INPUT_DEBOUNCE));
        assert!(!debounce_admit(KIND_NEEDS_INPUT, s, NEEDS_INPUT_DEBOUNCE));
        assert!(debounce_admit(KIND_PROMPT_FAILED, s, ALERT_DEBOUNCE));
        rearm_needs_input(s);
        assert!(
            debounce_admit(KIND_NEEDS_INPUT, s, NEEDS_INPUT_DEBOUNCE),
            "the next dialog after an answer is not debounced away"
        );
        assert!(!debounce_admit(KIND_NEEDS_INPUT, s, NEEDS_INPUT_DEBOUNCE));
        assert!(
            !debounce_admit(KIND_PROMPT_FAILED, s, ALERT_DEBOUNCE),
            "re-arming needs_input leaves the alert kinds alone"
        );
    }
}
