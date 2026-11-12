//! Serving a listing query: catalogue order, cursors, filters, authority
//! projection, page selection and the serialized payload with project summaries.

use super::*;

use crate::{omp::child::LiveRow, server::http::AppState, types::SessionInfo};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path as FsPath;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The catalogue's TOTAL order: most recent real activity first, ties broken
/// by session path ascending. The single definition of that order — `scan`
/// sorts with it, and `cursor_resume_index` searches it.
pub(super) fn catalogue_order(a: &SessionInfo, b: &SessionInfo) -> std::cmp::Ordering {
    b.active_at
        .total_cmp(&a.active_at)
        .then_with(|| a.path.cmp(&b.path))
}

/// Serialize one query's listing — the exact wire shape the old handler
/// produced (`{"sessions":[...]}`, per-row `status` + `snippet`), so a client
/// change is contract 7: rows for sessions with a LIVE child gain the
/// optional `model` / `messageCount` / `ctxPercent` fields — plus `pendingAsk`
/// (`{question, options}`, answer-sheet fuel) on rows in `waiting` with an
/// unanswered ask at the tail. Both are absent-not-null when inapplicable.
fn encode_cursor(cursor: &PageCursor) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).expect("cursor serializes"))
}

pub(super) fn decode_cursor(token: &str) -> Option<PageCursor> {
    if token.len() > 8192 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(token).ok()?;
    let cursor: PageCursor = serde_json::from_slice(&bytes).ok()?;
    (!cursor.path.is_empty() && cursor.path.len() <= 4096).then_some(cursor)
}

fn comes_after_cursor(session: &SessionInfo, cursor: &PageCursor) -> bool {
    match session
        .active_at
        .total_cmp(&f64::from_bits(cursor.active_at))
    {
        std::cmp::Ordering::Less => true,
        std::cmp::Ordering::Equal => session.path > cursor.path,
        std::cmp::Ordering::Greater => false,
    }
}

/// Where an archived page resumes in the sorted catalogue. `rows` must be in
/// `catalogue_order` — the order `scan` establishes and the order
/// `comes_after_cursor` compares against, so the predicate is false for a
/// prefix of the slice and true for the rest, which is exactly what
/// `partition_point` searches. One binary search replaces testing every row
/// the cursor already covered. A cursor naming no live row (deleted or aged
/// out between pages) lands on its insertion point, and a cursor past the
/// oldest row yields `rows.len()` — an empty page, as the walk always did.
fn cursor_resume_index(rows: &[SessionInfo], cursor: &PageCursor) -> usize {
    rows.partition_point(|session| !comes_after_cursor(session, cursor))
}

fn row_matches_query(session: &SessionInfo, q: &str) -> bool {
    q.is_empty()
        || session.title.to_lowercase().contains(q)
        || session.cwd.to_lowercase().contains(q)
        || session.id.to_lowercase().contains(q)
        || snippet_for(&session.path).is_some_and(|snippet| snippet.text.to_lowercase().contains(q))
}

pub(crate) fn project_cached_authority(state: &AppState, path: &str) {
    let rows = INDEX
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .and_then(|index| index.rows.clone());
    if let Some(row) = rows
        .as_ref()
        .and_then(|rows| rows.iter().find(|row| row.path == path))
    {
        project_inferred_authority(state, row);
    }
}

fn project_inferred_authority(state: &AppState, session: &SessionInfo) {
    use crate::authority::session_state::{
        Capabilities, Confidence, Connection, Owner, Seed, Turn,
    };
    let observation = crate::terminal::herdr_state::observation_for_owner(session.owner_pid);
    let stale = observation
        .as_ref()
        .is_some_and(|observation| observation.stale);
    let turn = if stale {
        Turn::Unknown
    } else if session.running {
        Turn::Running
    } else {
        Turn::Idle
    };
    let activity = (turn == Turn::Running).then(|| {
        json!({
            "source": if observation.is_some() { "herdr" } else { "daemon" },
            "kind": "working",
            "observedAt": observation.as_ref().map_or_else(
                || daemon_activity_observation(&session.path, session.running),
                |observation| observation.observed_at_ms),
            "stale": stale,
        })
    });
    state.session_states.project(
        &session.path,
        Seed {
            owner: Owner {
                kind: if session.owner_pid.is_some() {
                    "foreign"
                } else {
                    "none"
                }
                .to_owned(),
                pid: session.owner_pid,
                process_start: session
                    .owner_pid
                    .and_then(crate::authority::session_state::process_start_time),
                peer_id: None,
                room_id: None,
                can_write: None,
            },
            turn,
            confidence: Confidence::Inferred,
            connection: if stale {
                Connection::Unavailable
            } else {
                Connection::Connected
            },
            activity,
            capabilities: Capabilities::default(),
            source: None,
            sequence: 0,
        },
    );
}

/// Serialize one page, overlays included. Row selection is `select_page`.
pub(super) fn serialize_listing(
    state: &AppState,
    rows: &[SessionInfo],
    key: &ListingKey,
) -> Arc<str> {
    let live = state.children.live_rows();
    let mut waiting: HashSet<String> = state.children.sessions_awaiting_ui().into_iter().collect();
    for session in rows {
        project_inferred_authority(state, session);
        if crate::terminal::herdr_state::status_for_owner(session.owner_pid)
            == Some(crate::terminal::herdr_state::HerdrStatus::Blocked)
        {
            waiting.insert(session.path.clone());
        }
    }

    let page = select_page(rows, key);
    let next_cursor = page.has_more.then(|| {
        let session = &rows[page.rows[key.limit - 1]];
        encode_cursor(&PageCursor {
            active_at: session.active_at.to_bits(),
            path: session.path.clone(),
            project: key.project.clone(),
        })
    });
    let mut selected = page.rows;
    let mut selected_paths: HashSet<&str> = selected
        .iter()
        .map(|&index| rows[index].path.as_str())
        .collect();
    for index in page.pinned.into_iter().chain(page.live) {
        if selected_paths.insert(rows[index].path.as_str()) {
            selected.push(index);
        }
    }
    serialize_selected_rows_with_live(
        rows,
        Some(&selected[..]),
        &live,
        &waiting,
        Some(state),
        next_cursor.as_deref(),
    )
}

/// One page's worth of row indices into the catalogue, plus the first-page
/// overlay rows.
struct PageSelection {
    /// The page itself, in listing order, never longer than `key.limit`.
    rows: Vec<usize>,
    /// A further page exists past `rows`.
    has_more: bool,
    /// Every matching live row, first page only — gathered from the whole
    /// catalogue, not just the page, so a live conversation buried in the
    /// archive still shows its chip on page one.
    live: Vec<usize>,
    /// Every matching pinned row, first page only, for the same reason.
    pinned: Vec<usize>,
}

/// Select one page: the rows it serves and the overlays the first page adds.
/// Pure over the catalogue and the key — no state, no serialization.
///
/// `rows` is the scan catalogue in `catalogue_order` (every caller hands it
/// `scan` output). An archived page therefore resumes at the first row its
/// cursor admits — one binary search over an order whose already-served rows
/// are a prefix — and stops after `limit + 1` eligible rows. The first page
/// has no cursor, so it still walks the entire catalogue: its live and pinned
/// rows come from every match, not just the page.
fn select_page(rows: &[SessionInfo], key: &ListingKey) -> PageSelection {
    let pin_paths: HashSet<&str> = key.pinned.iter().map(String::as_str).collect();
    let resume = key
        .cursor
        .as_ref()
        .map_or(0, |cursor| cursor_resume_index(rows, cursor));
    let mut page = Vec::with_capacity(key.limit + 1);
    let mut live_rows = Vec::with_capacity(MAX_PAGE_SIZE);
    let mut pinned_rows = Vec::with_capacity(MAX_PINNED_PATHS);
    // Sliced rather than `skip`ped: an archived page must not touch the rows
    // the cursor already covered.
    for (offset, session) in rows[resume..].iter().enumerate() {
        let index = resume + offset;
        if !row_matches_listing(session, key) {
            continue;
        }
        if page.len() <= key.limit {
            page.push(index);
        }
        if key.cursor.is_none() {
            if key.include_live && session.live && live_rows.len() < MAX_PAGE_SIZE {
                live_rows.push(index);
            }
            if pin_paths.contains(session.path.as_str()) && pinned_rows.len() < MAX_PINNED_PATHS {
                pinned_rows.push(index);
            }
        } else if page.len() > key.limit {
            break;
        }
    }
    let has_more = page.len() > key.limit;
    page.truncate(key.limit);
    PageSelection {
        rows: page,
        has_more,
        live: live_rows,
        pinned: pinned_rows,
    }
}

#[cfg(test)]
fn serialize_rows_for_tests(
    rows: &[SessionInfo],
    q: &str,
    live: &HashMap<String, LiveRow>,
    waiting: &HashSet<String>,
) -> Arc<str> {
    let needle = q.trim().to_lowercase();
    let filtered: Vec<SessionInfo> = rows
        .iter()
        .filter(|session| row_matches_query(session, &needle))
        .cloned()
        .collect();
    serialize_selected_rows_with_live(&filtered, None, live, waiting, None, None)
}

fn serialize_selected_rows_with_live(
    rows: &[SessionInfo],
    selected_indices: Option<&[usize]>,
    live: &HashMap<String, LiveRow>,
    waiting: &HashSet<String>,
    state: Option<&AppState>,
    next_cursor: Option<&str>,
) -> Arc<str> {
    // One lock for the whole listing, not one per row. Live activity (`now`)
    // is deliberately NOT part of the row: this payload is cached and ETagged,
    // so a baked-in `now` outlived its turn (a chat header kept showing the
    // last tool after the turn ended). The listing socket delivers activity
    // instead, with a snapshot of every working session on connect.
    let bridged = crate::omp::bridge::live_sessions();
    let row_count = selected_indices.map_or(rows.len(), |indices| indices.len());
    let mut out: Vec<Value> = Vec::with_capacity(row_count);
    // Shared by every row of this payload, page rows first, so a cold page
    // of large sessions spreads its folding over refreshes.
    let mut usage_budget = USAGE_FOLD_BUDGET;
    for position in 0..row_count {
        let index = selected_indices.map_or(position, |indices| indices[position]);
        let s = &rows[index];
        let file_stamp = stamp(&s.path);
        let snippet = snippet_at(&s.path, file_stamp);
        let status = if waiting.contains(&s.path) {
            "waiting"
        } else if s.running {
            "streaming"
        } else {
            "idle"
        };
        let mut row = serde_json::to_value(s).unwrap_or_else(|_| json!({}));
        row["status"] = json!(status);
        let metadata = metadata_at(&s.path, file_stamp);
        if let Some(revision) = metadata.revision {
            // A string: the value is a u64 content hash (e.g.
            // 4059089593305379123), and a JSON number above 2^53 reaches JS
            // rounded, so two distinct revisions could compare equal and a
            // new reply read as already seen.
            row["revision"] = json!(revision.to_string());
        }
        if let Some(id) = metadata.latest_entry_id {
            row["latestEntryId"] = json!(id);
        }
        if let Some(outcome) = metadata.last_turn_outcome {
            row["lastTurnOutcome"] = json!(outcome);
        }
        if status == "waiting"
            && let Some(ask) = crate::sessions::jsonl::pending_ask(FsPath::new(&s.path))
        {
            // The question the laptop is on NOW: omp records nothing until
            // the last answer, so the phone's delivered-answer count is the
            // position. Past the end (answered from the phone, file not yet
            // written) stays on the last question rather than vanishing.
            let total = ask.questions.len();
            let index = crate::terminal::herdr_state::ask_answers_delivered(&s.path, &ask.call_id)
                .min(total.saturating_sub(1));
            let q = &ask.questions[index];
            row["pendingAsk"] = json!({
                "id": ask.call_id,
                "index": index,
                "total": total,
                "question": q.question,
                "options": q.options,
                "recommended": q.recommended,
            });
        }
        if let Some(st) = live.get(&s.path) {
            row["model"] = json!(st.model);
            row["messageCount"] = json!(st.message_count);
            if let Some(pct) = st.ctx_percent {
                row["ctxPercent"] = json!(pct);
            }
        } else if let Some(m) = model_at(&s.path, file_stamp) {
            row["model"] = json!(m);
        }
        // Whole-session spend and context for the phone's meters. Omitted,
        // never null, until the file is folded to its end.
        if let Some(usage) = usage_at(&s.path, file_stamp, &mut usage_budget) {
            // Micro-dollar precision keeps float noise out of the payload.
            row["costTotal"] = json!((usage.cost_total * 1e6).round() / 1e6);
            row["sessionModel"] = json!(usage.configuration);
            if let Some(tokens) = usage.ctx_tokens {
                row["ctxTokens"] = json!(tokens);
            }
            if let Some(id) = usage.last_assistant_id {
                row["usageThrough"] = json!(id);
            }
        }
        row["snippet"] = match snippet {
            Some(sn) => serde_json::to_value(sn).unwrap_or(Value::Null),
            None => Value::Null,
        };

        let daemon_observed_at = daemon_activity_observation(&s.path, s.running);

        // Ownership evidence and generation/activity evidence are separate:
        // an open laptop proves ownership/live visibility, not that a turn is
        // running. Capabilities are not derived here: the source-fenced
        // authority record below is the only advertised source, and the
        // bridge membership below stays for activity attribution.
        let bridged_row = bridged.contains_key(&s.path);
        if bridged_row {
            // Exact: the owner reports its own turn state over the bridge.
            row["bridge"] = json!(true);
            row["activitySource"] = json!("omp");
            row["activityObservedAt"] = json!(daemon_observed_at);
            row["activityStale"] = json!(false);
        } else if let Some(observation) =
            crate::terminal::herdr_state::observation_for_owner(s.owner_pid)
        {
            row["activitySource"] = json!("herdr");
            row["activityObservedAt"] = json!(observation.observed_at_ms);
            row["activityStale"] = json!(observation.stale);
        } else if s.running {
            row["activitySource"] = json!("daemon");
            row["activityObservedAt"] = json!(daemon_observed_at);
            row["activityStale"] = json!(false);
        }
        if let Some(state) = state {
            let authority = crate::server::http::session_authority(state, &s.path);
            row["running"] = match authority.turn {
                crate::authority::session_state::Turn::Running => json!(true),
                crate::authority::session_state::Turn::Idle => json!(false),
                crate::authority::session_state::Turn::Unknown => Value::Null,
            };
            row["streaming"] = row["running"].clone();
            if status != "waiting" {
                row["status"] = json!(match authority.turn {
                    crate::authority::session_state::Turn::Running => "streaming",
                    crate::authority::session_state::Turn::Idle => "idle",
                    crate::authority::session_state::Turn::Unknown => "unknown",
                });
            }
            row["now"] = authority.legacy_now();
            row["capabilities"] =
                serde_json::to_value(&authority.capabilities).unwrap_or(Value::Null);
            if let Some(cut) = crate::authority::interrupted::visible(&s.path, &authority) {
                row["interrupted"] = json!(cut);
            }
            row["sessionState"] = serde_json::to_value(authority).unwrap_or(Value::Null);
        }
        out.push(row);
    }
    json!({ "sessions": out, "nextCursor": next_cursor, "projects": project_summaries(rows, now_epoch_ms()) })
        .to_string()
        .into()
}

fn row_matches_listing(session: &SessionInfo, key: &ListingKey) -> bool {
    row_matches_query(session, &key.q)
        && project_matches(session, key.project.as_deref())
        && key
            .cursor
            .as_ref()
            .is_none_or(|cursor| comes_after_cursor(session, cursor))
}

fn project_matches(session: &SessionInfo, project: Option<&str>) -> bool {
    project.is_none_or(|cwd| session.cwd == cwd)
}

const PROJECT_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;

fn project_summaries(rows: &[SessionInfo], now_ms: u64) -> Value {
    let now = now_ms as f64;
    let cutoff = now_ms.saturating_sub(PROJECT_WINDOW_MS) as f64;
    let mut counts: HashMap<&str, (usize, f64)> = HashMap::new();
    for row in rows {
        if row.cwd.is_empty()
            || !row.active_at.is_finite()
            || row.active_at < cutoff
            || row.active_at > now
        {
            continue;
        }
        let entry = counts.entry(&row.cwd).or_insert((0, row.active_at));
        entry.0 += 1;
        entry.1 = entry.1.max(row.active_at);
    }
    let mut projects: Vec<_> = counts.into_iter().collect();
    projects.sort_by(
        |(cwd_a, (count_a, latest_a)), (cwd_b, (count_b, latest_b))| {
            count_b
                .cmp(count_a)
                .then_with(|| latest_b.total_cmp(latest_a))
                .then_with(|| cwd_a.cmp(cwd_b))
        },
    );
    Value::Array(
        projects
            .into_iter()
            .take(3)
            .map(|(cwd, (count, _))| {
                let label = cwd.rsplit('/').find(|part| !part.is_empty()).unwrap_or(cwd);
                json!({ "cwd": cwd, "label": label, "activeSessions": count })
            })
            .collect(),
    )
}

/// Calculate the next instant at which an included row ages out of the project window.
pub(super) fn next_project_expiry(rows: &[SessionInfo], now_ms: u64) -> Option<Instant> {
    let cutoff = now_ms.saturating_sub(PROJECT_WINDOW_MS) as f64;
    let expires_at = rows
        .iter()
        .filter_map(|row| {
            if row.cwd.is_empty()
                || !row.active_at.is_finite()
                || row.active_at < cutoff
                || row.active_at > now_ms as f64
            {
                return None;
            }
            Some(
                (row.active_at as u64)
                    .saturating_add(PROJECT_WINDOW_MS)
                    .saturating_add(1),
            )
        })
        .filter(|expires_at| *expires_at > now_ms)
        .min()?;
    Some(Instant::now() + Duration::from_millis(expires_at - now_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::index::tests::row;
    use crate::sessions::index::tests::scratch_session;

    #[test]
    fn weekly_project_ranking_uses_full_rows_and_exact_rolling_boundary() {
        let now = 2_000_000_000_000u64;
        let cutoff = now - PROJECT_WINDOW_MS;
        let mut rows = vec![
            row("/s/a1", "a1", "a", "/work/a"),
            row("/s/a2", "a2", "a", "/work/a"),
            row("/s/a3", "a3", "a", "/work/a"),
            row("/s/b1", "b1", "b", "/work/b"),
            row("/s/b2", "b2", "b", "/work/b"),
            row("/s/c", "c", "c", "/left/shared"),
            row("/s/d", "d", "d", "/right/shared"),
            row("/s/old", "old", "old", "/work/a"),
            row("/s/future", "future", "future", "/work/a"),
            row("/s/blank", "blank", "blank", ""),
        ];
        for (item, active) in rows.iter_mut().zip([
            cutoff as f64,
            (now - 1) as f64,
            (now - 2) as f64,
            now as f64,
            (now - 10) as f64,
            (now - 20) as f64,
            (now - 30) as f64,
            (cutoff - 1) as f64,
            (now + 1) as f64,
            now as f64,
        ]) {
            item.active_at = active;
        }
        let projects = project_summaries(&rows, now);
        assert_eq!(projects.as_array().unwrap().len(), 3);
        assert_eq!(
            projects[0],
            json!({"cwd":"/work/a", "label":"a", "activeSessions":3})
        );
        assert_eq!(projects[1]["cwd"], "/work/b");
        assert_eq!(projects[1]["activeSessions"], 2);
        assert_eq!(projects[2]["cwd"], "/left/shared");
        assert_eq!(projects[2]["label"], "shared");
        assert_ne!(projects[2]["cwd"], "/right/shared");
    }

    #[test]
    fn exact_project_filter_applies_before_page_limit() {
        let mut rows = [
            row("/s/a1", "a1", "a", "/projects/repo"),
            row("/s/collision", "c", "c", "/another/repo"),
            row("/s/a2", "a2", "a", "/projects/repo"),
        ];
        for (index, item) in rows.iter_mut().enumerate() {
            item.active_at = (100 - index) as f64;
        }
        let key = ListingKey {
            q: String::new(),
            project: Some("/projects/repo".into()),
            limit: 1,
            cursor: None,
            pinned: Vec::new(),
            include_live: true,
        };
        let page: Vec<_> = rows
            .iter()
            .enumerate()
            .filter(|(_, item)| row_matches_listing(item, &key))
            .map(|(index, _)| index)
            .take(key.limit + 1)
            .collect();
        assert_eq!(page, vec![0, 2]);
        assert_eq!(rows[page[0]].path, "/s/a1");
        assert_eq!(rows[page[1]].path, "/s/a2");
    }

    #[test]
    fn query_matches_snippet_text_only() {
        // The needle appears ONLY in the newest message snippet — nowhere in
        // title, cwd or id — so this exercises the contract-8 filter path
        // specifically (the "single biggest 'I cannot find it' gap").
        let alpha = scratch_session(
            "snippet-only",
            "{\"type\":\"title\",\"title\":\"Alpha\",\"id\":\"alpha-id\",\"cwd\":\"/work/alpha\",\"time\":1,\"version\":\"2\"}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"the pineapple tax refund arrived\"}]},\"time\":2,\"version\":\"2\"}\n",
        );
        let rows = vec![
            row(alpha.to_str().unwrap(), "alpha-id", "Alpha", "/work/alpha"),
            row("/sessions/beta.jsonl", "beta-id", "Beta", "/work/beta"),
        ];
        let payload =
            serialize_rows_for_tests(&rows, "pineapple", &HashMap::new(), &HashSet::new());
        let v: Value = serde_json::from_str(&payload).unwrap();
        let sessions = v["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["id"], "alpha-id");
        // The snippet that matched is embedded, so the phone shows WHY.
        assert!(
            sessions[0]["snippet"]["text"]
                .as_str()
                .unwrap()
                .contains("pineapple")
        );
    }

    #[test]
    fn query_matches_header_fields_and_rejects_absent_needle() {
        let alpha = scratch_session(
            "snippet-header",
            "{\"type\":\"title\",\"title\":\"Alpha\",\"id\":\"alpha-id\",\"cwd\":\"/work/alpha\",\"time\":1,\"version\":\"2\"}\n\
             {\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"pineapple\"}]},\"time\":2,\"version\":\"2\"}\n",
        );
        let rows = vec![row(
            alpha.to_str().unwrap(),
            "alpha-id",
            "Alpha",
            "/work/alpha",
        )];
        // A title-only hit still matches (existing behaviour, not regressed).
        let by_title = serialize_rows_for_tests(&rows, "alpha", &HashMap::new(), &HashSet::new());
        let v: Value = serde_json::from_str(&by_title).unwrap();
        assert_eq!(v["sessions"].as_array().unwrap().len(), 1);
        // A needle nowhere in title/cwd/id/snippet matches nothing.
        let none = serialize_rows_for_tests(&rows, "zebra", &HashMap::new(), &HashSet::new());
        let v: Value = serde_json::from_str(&none).unwrap();
        assert_eq!(v["sessions"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn enrichment_present_for_live_child_only() {
        let rows = vec![
            row("/sessions/a.jsonl", "a", "A", "/work/a"),
            row("/sessions/b.jsonl", "b", "B", "/work/b"),
            row("/sessions/c.jsonl", "c", "C", "/work/c"),
        ];
        let mut live = HashMap::new();
        // Live child with full state: all three fields must appear.
        live.insert(
            "/sessions/a.jsonl".to_string(),
            LiveRow {
                model: "openai/gpt-5".to_string(),
                message_count: 42,
                ctx_percent: Some(95),
            },
        );
        // Live child that has not reported contextUsage (no context window):
        // model/messageCount appear, ctxPercent stays omitted.
        live.insert(
            "/sessions/b.jsonl".to_string(),
            LiveRow {
                model: "anthropic/claude-x".to_string(),
                message_count: 7,
                ctx_percent: None,
            },
        );
        let payload = serialize_rows_for_tests(&rows, "", &live, &HashSet::new());
        let v: Value = serde_json::from_str(&payload).unwrap();
        let sessions = v["sessions"].as_array().unwrap();
        assert_eq!(sessions[0]["model"], "openai/gpt-5");
        assert_eq!(sessions[0]["messageCount"], 42);
        assert_eq!(sessions[0]["ctxPercent"], 95);
        assert_eq!(sessions[1]["model"], "anthropic/claude-x");
        assert_eq!(sessions[1]["messageCount"], 7);
        assert!(sessions[1].get("ctxPercent").is_none());
        // No live child: the fields are absent entirely, not null.
        assert!(sessions[2].get("model").is_none());
        assert!(sessions[2].get("messageCount").is_none());
        assert!(sessions[2].get("ctxPercent").is_none());
    }

    #[test]
    fn rows_carry_whole_session_usage_for_desktop_sessions_and_omit_unknown() {
        // A laptop-owned session: no live child, usage only in its JSONL.
        let desk = scratch_session(
            "usage-row",
            "{\"type\":\"session\",\"id\":\"desk\",\"cwd\":\"/work/d\",\"version\":3}\n\
             {\"type\":\"message\",\"id\":\"a1\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"toolUse\",\"usage\":{\"input\":10,\"cacheRead\":20,\"cacheWrite\":30,\"cost\":{\"total\":0.1}}}}\n\
             {\"type\":\"message\",\"id\":\"a2\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\",\"contextSnapshot\":{\"promptTokens\":84000},\"usage\":{\"input\":1,\"cost\":{\"total\":0.2}}}}\n",
        );
        let empty = scratch_session(
            "usage-empty",
            "{\"type\":\"session\",\"id\":\"e\",\"cwd\":\"/w\"}\n",
        );
        let rows = vec![
            row(desk.to_str().unwrap(), "desk", "Desk", "/work/d"),
            row(empty.to_str().unwrap(), "e", "Empty", "/w"),
            row("/sessions/missing.jsonl", "m", "Missing", "/w"),
        ];
        let payload = serialize_rows_for_tests(&rows, "", &HashMap::new(), &HashSet::new());
        let v: Value = serde_json::from_str(&payload).unwrap();
        let sessions = v["sessions"].as_array().unwrap();
        // 0.1 + 0.2 is 0.30000000000000004 in f64; the row is rounded.
        assert_eq!(sessions[0]["costTotal"], 0.3);
        assert_eq!(sessions[0]["ctxTokens"], 84000);
        assert_eq!(sessions[0]["usageThrough"], "a2");
        // Folded to the end with no spend: a known zero, no context, no anchor.
        assert_eq!(sessions[1]["costTotal"], 0.0);
        assert!(sessions[1].get("ctxTokens").is_none());
        assert!(sessions[1].get("usageThrough").is_none());
        // Unreadable: unknown, so absent rather than null or zero.
        assert!(sessions[2].get("costTotal").is_none());
        assert!(sessions[2].get("ctxTokens").is_none());
    }

    #[test]
    fn cached_session_rows_refresh_context_after_compaction_without_changing_spend_or_live_percent()
    {
        for (name, receipt, expected) in [
            ("context-reduced", ",\"tokensAfter\":1200", Some(1200)),
            ("context-unknown", "", None),
        ] {
            let path = scratch_session(
                name,
                "{\"type\":\"session\",\"id\":\"s\",\"cwd\":\"/w\",\"version\":3}\n{\"type\":\"message\",\"id\":\"a\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\",\"contextSnapshot\":{\"promptTokens\":99000},\"usage\":{\"cost\":{\"total\":2.5}}}}\n",
            );
            let rows = vec![row(path.to_str().unwrap(), "s", name, "/w")];
            let initial: Value = serde_json::from_str(&serialize_rows_for_tests(
                &rows,
                "",
                &HashMap::new(),
                &HashSet::new(),
            ))
            .unwrap();
            assert_eq!(initial["sessions"][0]["ctxTokens"], 99000);
            use std::io::Write;
            let compact = format!(
                "{{\"type\":\"compaction\",\"id\":\"c\",\"parentId\":\"a\",\"tokensBefore\":99000{receipt}}}\n"
            );
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(compact.as_bytes())
                .unwrap();
            let updated: Value = serde_json::from_str(&serialize_rows_for_tests(
                &rows,
                "",
                &HashMap::new(),
                &HashSet::new(),
            ))
            .unwrap();
            assert_eq!(
                updated["sessions"][0]
                    .get("ctxTokens")
                    .and_then(Value::as_u64),
                expected
            );
            assert_eq!(updated["sessions"][0]["costTotal"], 2.5);
            let live = HashMap::from([(
                path.to_string_lossy().into_owned(),
                LiveRow {
                    model: "provider/model".into(),
                    message_count: 1,
                    ctx_percent: Some(17),
                },
            )]);
            let updated: Value =
                serde_json::from_str(&serialize_rows_for_tests(&rows, "", &live, &HashSet::new()))
                    .unwrap();
            assert_eq!(updated["sessions"][0]["ctxPercent"], 17);
            assert_eq!(updated["sessions"][0]["costTotal"], 2.5);
        }
    }

    /// The scan catalogue for the given (path, activity) pairs, in the order
    /// `scan` leaves it.
    fn sorted_catalogue(specs: &[(&str, f64)]) -> Vec<SessionInfo> {
        let mut rows: Vec<SessionInfo> = specs
            .iter()
            .map(|(path, active_at)| {
                let mut item = row(path, "id", "title", "/work");
                item.active_at = *active_at;
                item
            })
            .collect();
        rows.sort_by(catalogue_order);
        rows
    }

    fn page_key(limit: usize, cursor: Option<PageCursor>) -> ListingKey {
        ListingKey {
            q: String::new(),
            project: None,
            limit,
            cursor,
            pinned: Vec::new(),
            include_live: true,
        }
    }

    /// The token a client carries forward from a served row, taken through
    /// the real encode/decode pair.
    fn next_token(rows: &[SessionInfo], last_served: usize) -> PageCursor {
        let token = encode_cursor(&PageCursor {
            active_at: rows[last_served].active_at.to_bits(),
            path: rows[last_served].path.clone(),
            project: None,
        });
        decode_cursor(&token).expect("a served cursor round-trips")
    }

    /// Every path an archive walk serves, page by page, in order.
    fn walk_archive(rows: &[SessionInfo], limit: usize) -> Vec<String> {
        let mut cursor: Option<PageCursor> = None;
        let mut served: Vec<String> = Vec::new();
        for _ in 0..=rows.len() {
            let page = select_page(rows, &page_key(limit, cursor.clone()));
            served.extend(page.rows.iter().map(|&index| rows[index].path.clone()));
            match (page.has_more, page.rows.last()) {
                (true, Some(&last)) => cursor = Some(next_token(rows, last)),
                _ => return served,
            }
        }
        panic!("the archive walk never terminated");
    }

    #[test]
    fn cursor_pages_cover_the_catalogue_once_in_listing_order() {
        // The first three rows tie on activity: only the path tiebreak decides
        // which side of a page boundary a row falls on, so a resume that
        // ignored it would repeat or drop rows as the phone walks the archive.
        let rows = sorted_catalogue(&[
            ("/s/a", 10.0),
            ("/s/b", 10.0),
            ("/s/c", 10.0),
            ("/s/d", 9.0),
            ("/s/e", 9.0),
            ("/s/f", 0.0),
        ]);
        for limit in 1..=rows.len() {
            assert_eq!(
                walk_archive(&rows, limit),
                vec!["/s/a", "/s/b", "/s/c", "/s/d", "/s/e", "/s/f"],
                "limit {limit} must serve every row exactly once, in order"
            );
        }
    }

    #[test]
    fn a_page_stops_at_the_limit_and_its_last_row_becomes_the_next_cursor() {
        let rows = sorted_catalogue(&[("/s/a", 30.0), ("/s/b", 20.0), ("/s/c", 10.0)]);
        let first = select_page(&rows, &page_key(2, None));
        assert_eq!(first.rows, vec![0, 1]);
        assert!(first.has_more);
        // The last row of the served page — never the limit+1 row the scan
        // looked at — is what the client carries forward.
        let second = select_page(&rows, &page_key(2, Some(next_token(&rows, 1))));
        assert_eq!(second.rows, vec![2]);
        assert!(!second.has_more);
    }

    #[test]
    fn archive_paging_holds_for_zero_and_nonfinite_activity() {
        // total_cmp, not numeric order: -0.0 sorts below 0.0 and a NaN above
        // +inf. A numeric comparison would drop one of these rows on the
        // wrong side of a page boundary — served twice, or never.
        let rows = sorted_catalogue(&[
            ("/s/nan", f64::NAN),
            ("/s/inf", f64::INFINITY),
            ("/s/plain", 1.0),
            ("/s/poszero", 0.0),
            ("/s/negzero", -0.0),
            ("/s/neginf", f64::NEG_INFINITY),
        ]);
        let expected: Vec<String> = rows.iter().map(|item| item.path.clone()).collect();
        for limit in 1..=rows.len() {
            assert_eq!(walk_archive(&rows, limit), expected, "limit {limit}");
        }
    }

    #[test]
    fn a_cursor_whose_session_left_the_catalogue_serves_its_neighbours() {
        // The session the client was reading was deleted, or aged out of the
        // scan, between pages. Its cursor names no live row: the walk must
        // resume where that row stood — not from the top, not past the end.
        let rows = sorted_catalogue(&[("/s/b", 20.0), ("/s/d", 10.0)]);
        let cursor = |active_at: f64, path: &str| PageCursor {
            active_at: active_at.to_bits(),
            path: path.to_string(),
            project: None,
        };
        let page = select_page(&rows, &page_key(50, Some(cursor(15.0, "/s/c"))));
        assert_eq!(page.rows, vec![1]);
        assert!(!page.has_more);
        // Ahead of everything: the whole catalogue is still behind it.
        let ahead = select_page(&rows, &page_key(50, Some(cursor(30.0, "/s/z"))));
        assert_eq!(ahead.rows, vec![0, 1]);
        // Behind everything: the walk is over and says so, with no next cursor.
        let behind = select_page(&rows, &page_key(50, Some(cursor(0.0, "/s/a"))));
        assert!(behind.rows.is_empty() && !behind.has_more);
        assert!(select_page(&[], &page_key(50, None)).rows.is_empty());
    }

    #[test]
    fn the_first_page_still_includes_live_and_pinned_rows_from_the_whole_catalogue() {
        // Page one is the only page carrying overlays, and it gathers them
        // from every match, not just the page: a live conversation or a pinned
        // session buried in the archive still shows up on the first screen.
        let mut rows = sorted_catalogue(&[("/s/a", 30.0), ("/s/b", 20.0), ("/s/c", 10.0)]);
        rows[2].live = true;
        let mut key = page_key(1, None);
        key.pinned = vec!["/s/c".to_string()];
        let page = select_page(&rows, &key);
        assert_eq!(page.rows, vec![0]);
        assert!(page.has_more);
        assert_eq!(page.live, vec![2]);
        assert_eq!(page.pinned, vec![2]);
        // An archived page is the plain walk: overlays never ride along.
        let archived = select_page(&rows, &page_key(1, Some(next_token(&rows, 0))));
        assert_eq!(archived.rows, vec![1]);
        assert!(archived.live.is_empty() && archived.pinned.is_empty());
    }

    #[test]
    fn a_search_reaches_past_the_first_page_and_pages_its_own_matches() {
        // Server search is the only way to find a chat the phone never loaded:
        // the query filters the WHOLE catalogue before the limit, so an old
        // match leads page one, and its cursor walks only the remaining matches.
        let mut rows = sorted_catalogue(&[
            ("/s/new1", 90.0),
            ("/s/new2", 80.0),
            ("/s/old1", 20.0),
            ("/s/old2", 10.0),
            ("/s/old3", 5.0),
        ]);
        for item in &mut rows {
            item.title = if item.path.contains("old") {
                "migration".into()
            } else {
                "fresh".into()
            };
        }
        let key = ListingKey {
            q: "migration".into(),
            ..page_key(2, None)
        };
        let first = select_page(&rows, &key);
        assert_eq!(first.rows, vec![2, 3]);
        assert!(first.has_more);
        let next = ListingKey {
            cursor: Some(next_token(&rows, 3)),
            ..key
        };
        let second = select_page(&rows, &next);
        assert_eq!(second.rows, vec![4]);
        assert!(!second.has_more);
    }
}
