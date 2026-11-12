//! Whole-session spend and context size, folded forward from a session file.
//!
//! WHY: the phone loads history in pages, so a sum over loaded messages
//! undercounts every long conversation. omp's own session cost is the sum of
//! `usage.cost.total` over assistant messages, `model_usage` records and
//! `task` tool results across EVERY entry (abandoned branches included: that
//! money was spent), so the daemon folds the same rule over the file.
//! Session files reach tens of megabytes and grow by appends, so the fold is
//! resumable: it stops at a line boundary, seals that boundary with a hash of
//! the bytes before it, and a later call reads only what was appended. A
//! rewrite (seal mismatch or shrink) restarts from zero.

use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

/// Older branch parents become explicitly unknown rather than retaining an
/// entry-id index proportional to an arbitrarily large journal. The live
/// owner supplies authoritative selectors for such historical navigation.
const MAX_CONFIGURATION_ENTRIES: usize = 4096;
/// Bytes before the resume offset hashed into the seal.
const SEAL_BYTES: u64 = 64;

/// Resumable whole-file usage totals.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsageTally {
    /// Byte offset just past the last complete line folded in.
    pub offset: u64,
    /// Hash of the up-to-64 bytes before `offset`.
    seal: u64,
    /// No complete line remained past `offset` within the length folded to.
    pub caught_up: bool,
    /// Sum of every finite, non-negative `usage.cost.total`, in USD.
    pub cost_total: f64,
    /// Current recorded context estimate; unknown after compaction without tokensAfter.
    pub ctx_tokens: Option<u64>,
    /// Entry id of the newest assistant message folded: the client adds
    /// only turns after it, so a live turn is never counted twice.
    pub last_assistant_id: Option<String>,
    /// Cold-open model controls and fallback explanation, folded with usage.
    pub configuration: SessionConfiguration,
    // Resolve receipts along the active parent chain, not physical append
    // order. Cached tally clones share the bounded index; only folding a new
    // entry copies its containers, and siblings share their control snapshots.
    branch_configurations: Arc<HashMap<Arc<str>, Arc<SessionConfiguration>>>,
    configuration_order: Arc<VecDeque<Arc<str>>>,
    active_configuration: Arc<SessionConfiguration>,
    metadata_bytes: usize,
}

/// Pulse metadata derived from OMP's actual thinking receipts and our owner
/// extension's non-prompt fallback journal entry. Never native RPC fields.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfiguration {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configured_thinking_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_fallback: Option<ModelFallback>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFallback {
    pub from: String,
    pub to: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<f64>,
}

impl UsageTally {
    pub(crate) fn metadata_retained_bytes(&self) -> usize {
        self.metadata_bytes
    }
}

impl SessionConfiguration {
    fn owned_bytes(&self) -> usize {
        self.thinking_level.as_ref().map_or(0, String::capacity)
            + self
                .configured_thinking_level
                .as_ref()
                .map_or(0, String::capacity)
            + self.thinking_entry_id.as_ref().map_or(0, String::capacity)
            + self.model_fallback.as_ref().map_or(0, |fallback| {
                fallback.from.capacity()
                    + fallback.to.capacity()
                    + fallback.role.capacity()
                    + fallback.reason.as_ref().map_or(0, String::capacity)
                    + fallback.entry_id.as_ref().map_or(0, String::capacity)
            })
    }
}

#[derive(Deserialize)]
struct BranchProbe<'a> {
    #[serde(rename = "type")]
    kind: Option<&'a str>,
    id: Option<&'a str>,
    #[serde(rename = "parentId", default, borrow, deserialize_with = "present_id")]
    parent_id: Option<Option<&'a str>>,
    #[serde(
        rename = "activeLeafId",
        default,
        borrow,
        deserialize_with = "present_id"
    )]
    active_leaf_id: Option<Option<&'a str>>,
}

fn present_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<&'de str>>, D::Error> {
    Option::<&'de str>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct LineProbe {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    /// `model_usage` records carry usage at the top level.
    usage: Option<Value>,
    message: Option<MessageProbe>,
}

/// Only the fields the tally reads; content and tool output are skipped by
/// the deserializer instead of being built into a `Value`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageProbe {
    role: Option<String>,
    tool_name: Option<String>,
    stop_reason: Option<String>,
    usage: Option<Value>,
    context_snapshot: Option<Value>,
}

#[derive(Deserialize)]
struct CompactionProbe {
    #[serde(rename = "tokensAfter")]
    tokens_after: Option<u64>,
}

/// Fold `path` forward from `prior` up to `limit` bytes (the length the
/// caller stat'ed), reading at most `budget` bytes of new lines and charging
/// what it read. `None` only when the file cannot be opened.
pub fn fold_usage(
    path: &Path,
    prior: &UsageTally,
    limit: u64,
    budget: &mut u64,
) -> Option<UsageTally> {
    let mut file = fs::File::open(path).ok()?;
    let mut tally = if prior.offset > 0
        && prior.offset <= limit
        && seal_at(&mut file, prior.offset) == Some(prior.seal)
    {
        UsageTally {
            caught_up: false,
            ..prior.clone()
        }
    } else {
        UsageTally::default()
    };
    file.seek(SeekFrom::Start(tally.offset)).ok()?;
    let mut reader = BufReader::new(file.take(limit - tally.offset));
    let mut line = Vec::new();
    let mut spent = 0u64;
    loop {
        if spent >= *budget {
            break;
        }
        line.clear();
        let Ok(read) = reader.read_until(b'\n', &mut line) else {
            break;
        };
        spent += read as u64;
        if read == 0 || line.last() != Some(&b'\n') {
            // EOF, or a line still being written: fold it once it ends.
            tally.caught_up = true;
            break;
        }
        tally.offset += read as u64;
        fold_line(&mut tally, &line);
    }
    *budget = budget.saturating_sub(spent);
    let mut file = reader.into_inner().into_inner();
    tally.seal = seal_at(&mut file, tally.offset).unwrap_or(0);
    Some(tally)
}

fn seal_at(file: &mut fs::File, offset: u64) -> Option<u64> {
    let start = offset.saturating_sub(SEAL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = [0u8; SEAL_BYTES as usize];
    let want = (offset - start) as usize;
    file.read_exact(&mut buf[..want]).ok()?;
    Some(super::stable_revision(&buf[..want]))
}

fn fold_line(tally: &mut UsageTally, line: &[u8]) {
    // Parse only the tree envelope first; content and tool output are skipped.
    let Ok(text) = std::str::from_utf8(line) else {
        return;
    };
    let Ok(branch) = serde_json::from_str::<BranchProbe<'_>>(text) else {
        return;
    };
    let mut configuration = match branch.parent_id {
        Some(Some(parent)) => tally
            .branch_configurations
            .get(parent)
            .cloned()
            .unwrap_or_default(),
        Some(None) => Arc::default(),
        None => Arc::clone(&tally.active_configuration),
    };
    let mut configuration_changed = false;
    // Reuse this resumable whole-file pass: a bounded transcript page or tail
    // cannot recover an Auto receipt or fallback that preceded a long run.
    if (text.contains("\"thinking_level_change\"") || text.contains("\"omp-pulse-model-fallback\""))
        && let Ok(entry) = serde_json::from_str::<Value>(text)
    {
        let kind = entry.get("type").and_then(Value::as_str);
        if kind == Some("thinking_level_change") {
            let configuration = Arc::make_mut(&mut configuration);
            configuration_changed = true;
            configuration.thinking_level = Some(
                entry
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .unwrap_or("off")
                    .to_owned(),
            );
            configuration.configured_thinking_level = Some(
                entry
                    .get("configured")
                    .and_then(Value::as_str)
                    .or_else(|| entry.get("thinkingLevel").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_owned(),
            );
            configuration.thinking_entry_id =
                entry.get("id").and_then(Value::as_str).map(str::to_owned);
            configuration.thinking_at = super::entry_time_ms(&entry);
        } else if kind == Some("custom")
            && entry.get("customType").and_then(Value::as_str) == Some("omp-pulse-model-fallback")
            && let Some(data) = entry.get("data")
            && let Ok(mut fallback) = ModelFallback::deserialize(data)
            && !fallback.from.trim().is_empty()
            && !fallback.to.trim().is_empty()
        {
            fallback.entry_id = entry.get("id").and_then(Value::as_str).map(str::to_owned);
            fallback.at = super::entry_time_ms(&entry);
            Arc::make_mut(&mut configuration).model_fallback = Some(fallback);
            configuration_changed = true;
        }
    }
    if configuration_changed {
        tally.metadata_bytes += configuration.owned_bytes();
    }
    if let Some(id) = branch.id {
        let configurations = Arc::make_mut(&mut tally.branch_configurations);
        if let Some(previous) = configurations.get_mut(id) {
            if !Arc::ptr_eq(previous, &configuration) && Arc::strong_count(previous) == 1 {
                tally.metadata_bytes = tally.metadata_bytes.saturating_sub(previous.owned_bytes());
            }
            *previous = Arc::clone(&configuration);
        } else {
            let id: Arc<str> = Arc::from(id);
            tally.metadata_bytes += id.len();
            Arc::make_mut(&mut tally.configuration_order).push_back(Arc::clone(&id));
            configurations.insert(id, Arc::clone(&configuration));
        }
        if tally.configuration_order.len() > MAX_CONFIGURATION_ENTRIES
            && let Some(expired) = Arc::make_mut(&mut tally.configuration_order).pop_front()
            && let Some(previous) = configurations.remove(&expired)
        {
            tally.metadata_bytes = tally.metadata_bytes.saturating_sub(expired.len());
            if Arc::strong_count(&previous) == 1 {
                tally.metadata_bytes = tally.metadata_bytes.saturating_sub(previous.owned_bytes());
            }
        }
    }
    // Native model_usage may arrive for an abandoned branch. Its explicit
    // activeLeafId restores the captured active leaf during replay.
    if branch.kind == Some("model_usage")
        && let Some(active_leaf) = branch.active_leaf_id
    {
        configuration = active_leaf
            .and_then(|id| tally.branch_configurations.get(id).cloned())
            .unwrap_or_default();
    }
    if !Arc::ptr_eq(&configuration, &tally.active_configuration) {
        if Arc::strong_count(&tally.active_configuration) == 1 {
            tally.metadata_bytes = tally
                .metadata_bytes
                .saturating_sub(tally.active_configuration.owned_bytes());
        }
        tally.configuration = configuration.as_ref().clone();
        tally.active_configuration = configuration;
    }
    if branch.kind == Some("compaction") {
        // tokensBefore is historical pressure, never current fullness.
        // Native 18.10.4 optionally records the reduced tokensAfter; older
        // receipts cannot establish a new measurement. Spend is untouched.
        tally.ctx_tokens = serde_json::from_str::<CompactionProbe>(text)
            .ok()
            .and_then(|entry| entry.tokens_after);
        return;
    }
    if !text.contains("\"usage\"") && !text.contains("\"assistant\"") {
        return;
    }
    let Ok(probe) = serde_json::from_str::<LineProbe>(text) else {
        return;
    };
    match probe.kind.as_deref() {
        Some("model_usage") => add_cost(tally, probe.usage.as_ref()),
        Some("message") => {
            let Some(message) = probe.message else {
                return;
            };
            match message.role.as_deref() {
                Some("assistant") => {
                    add_cost(tally, message.usage.as_ref());
                    if probe.id.is_some() {
                        tally.last_assistant_id = probe.id;
                    }
                    // Aborted and failed turns report empty usage; they say
                    // nothing about how full the context is.
                    if !matches!(message.stop_reason.as_deref(), Some("aborted" | "error")) {
                        tally.ctx_tokens = prompt_tokens(
                            message.context_snapshot.as_ref(),
                            message.usage.as_ref(),
                        );
                    }
                }
                Some("toolResult") if message.tool_name.as_deref() == Some("task") => {
                    // Subagent spend rides in `details.usage`; task results are
                    // rare enough to reparse whole.
                    let usage = serde_json::from_str::<Value>(text)
                        .ok()
                        .and_then(|v| v.pointer("/message/details/usage").cloned());
                    add_cost(tally, usage.as_ref());
                }
                _ => {}
            }
        }
        _ => {}
    }
}

fn add_cost(tally: &mut UsageTally, usage: Option<&Value>) {
    if let Some(cost) = usage
        .and_then(|u| u.pointer("/cost/total"))
        .and_then(Value::as_f64)
        .filter(|c| c.is_finite() && *c >= 0.0)
    {
        tally.cost_total += cost;
    }
}

fn count(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n as u64)
}

/// `contextSnapshot.promptTokens` when recorded, else the whole prompt
/// (input + cache read + cache write), else unknown.
fn prompt_tokens(snapshot: Option<&Value>, usage: Option<&Value>) -> Option<u64> {
    if let Some(tokens) = count(snapshot.and_then(|s| s.get("promptTokens"))) {
        return Some(tokens);
    }
    let usage = usage?;
    let parts = ["input", "cacheRead", "cacheWrite"].map(|k| count(usage.get(k)));
    parts
        .iter()
        .any(Option::is_some)
        .then(|| parts.iter().flatten().sum())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    fn fixture(name: &str, body: &str) -> Fixture {
        let path =
            std::env::temp_dir().join(format!("pulse-usage-{name}-{}.jsonl", std::process::id()));
        fs::write(&path, body).unwrap();
        Fixture(path)
    }
    fn assistant(id: &str, cost: f64, input: u64, stop: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"{id}\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"hi\"}}],\"stopReason\":\"{stop}\",\"usage\":{{\"input\":{input},\"output\":5,\"cacheRead\":100,\"cacheWrite\":10,\"cost\":{{\"total\":{cost}}}}}}}}}\n"
        )
    }
    fn fold(path: &Path, prior: &UsageTally) -> UsageTally {
        let len = fs::metadata(path).unwrap().len();
        let mut budget = u64::MAX;
        fold_usage(path, prior, len, &mut budget).unwrap()
    }

    #[test]
    fn sums_assistant_model_usage_and_task_costs_and_keeps_newest_context() {
        let body = [
            "{\"type\":\"session\",\"id\":\"h\",\"cwd\":\"/x\"}\n".to_string(),
            "{\"type\":\"message\",\"id\":\"u1\",\"message\":{\"role\":\"user\",\"content\":\"assistant usage\"}}\n".to_string(),
            assistant("a1", 0.25, 1000, "toolUse"),
            "{\"type\":\"message\",\"id\":\"t1\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"task\",\"content\":[],\"details\":{\"results\":[1,2],\"usage\":{\"cost\":{\"total\":0.5}}}}}\n".to_string(),
            "{\"type\":\"model_usage\",\"id\":\"m1\",\"usage\":{\"input\":9,\"cost\":{\"total\":0.125}}}\n".to_string(),
            "{\"type\":\"message\",\"id\":\"a2\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\",\"contextSnapshot\":{\"promptTokens\":4242},\"usage\":{\"input\":1,\"cost\":{\"total\":0.125}}}}\n".to_string(),
            // A bash tool result whose output mentions usage is not spend.
            "{\"type\":\"message\",\"id\":\"t2\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"bash\",\"details\":{\"usage\":{\"cost\":{\"total\":99}}}}}\n".to_string(),
        ]
        .concat();
        let f = fixture("sum", &body);
        let tally = fold(&f.0, &UsageTally::default());
        assert!(tally.caught_up);
        assert_eq!(tally.cost_total, 1.0);
        assert_eq!(tally.ctx_tokens, Some(4242));
        assert_eq!(tally.last_assistant_id.as_deref(), Some("a2"));
        assert_eq!(tally.offset, body.len() as u64);
    }

    #[test]
    fn compaction_replaces_context_without_changing_whole_session_spend() {
        for (name, reduced, expected) in [
            ("measured", ",\"tokensAfter\":1234", Some(1234)),
            ("unmeasured", "", None),
            ("zero", ",\"tokensAfter\":0", Some(0)),
            ("invalid", ",\"tokensAfter\":-1", None),
        ] {
            let first = assistant("a1", 0.5, 90000, "stop");
            let f = fixture(name, &first);
            let before = fold(&f.0, &UsageTally::default());
            let receipt = format!(
                "{{\"type\":\"compaction\",\"id\":\"c\",\"parentId\":\"a1\",\"tokensBefore\":90110,\"summary\":\"contains assistant and usage\"{reduced}}}\n"
            );
            fs::OpenOptions::new()
                .append(true)
                .open(&f.0)
                .unwrap()
                .write_all(receipt.as_bytes())
                .unwrap();
            let after = fold(&f.0, &before);
            assert_eq!(after.ctx_tokens, expected);
            assert_eq!(after.cost_total, 0.5);
            assert_eq!(after.last_assistant_id.as_deref(), Some("a1"));
            let cold = fold(&f.0, &UsageTally::default());
            assert_eq!(cold.ctx_tokens, expected);
            assert_eq!(cold.cost_total, after.cost_total);
            fs::OpenOptions::new()
                .append(true)
                .open(&f.0)
                .unwrap()
                .write_all(assistant("a2", 0.25, 2000, "stop").as_bytes())
                .unwrap();
            let resumed = fold(&f.0, &after);
            assert_eq!(resumed.ctx_tokens, Some(2110));
            assert_eq!(resumed.cost_total, 0.75);
        }
    }

    #[test]
    fn malformed_lines_and_usage_are_skipped_without_losing_the_rest() {
        let body = [
            "{not json \"usage\"\n".to_string(),
            "{\"type\":\"message\",\"id\":\"x\",\"message\":{\"role\":\"assistant\",\"usage\":{\"cost\":{\"total\":\"1.5\"}}}}\n".to_string(),
            "{\"type\":\"message\",\"id\":\"y\",\"message\":{\"role\":\"assistant\",\"usage\":{\"cost\":{\"total\":-3}}}}\n".to_string(),
            "{\"type\":\"message\",\"id\":7,\"message\":{\"role\":\"assistant\",\"usage\":{\"cost\":{\"total\":1}}}}\n".to_string(),
            "{\"type\":\"message\",\"message\":\"assistant\"}\n".to_string(),
            "{\"type\":\"model_usage\",\"usage\":\"none\"}\n".to_string(),
            assistant("ok", 0.75, 50, "stop"),
            // An aborted turn's empty usage must not erase the context figure.
            "{\"type\":\"message\",\"id\":\"ab\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"aborted\",\"usage\":{\"input\":0,\"cost\":{\"total\":0}}}}\n".to_string(),
        ]
        .concat();
        let f = fixture("malformed", &body);
        let tally = fold(&f.0, &UsageTally::default());
        assert!(tally.caught_up);
        assert_eq!(tally.cost_total, 0.75);
        assert_eq!(tally.ctx_tokens, Some(160));
        assert_eq!(tally.last_assistant_id.as_deref(), Some("ab"));
    }

    #[test]
    fn missing_prompt_metadata_on_the_newest_turn_reports_unknown_context() {
        let body = [
            assistant("a1", 0.1, 50, "stop"),
            "{\"type\":\"message\",\"id\":\"a2\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\",\"usage\":{\"output\":3}}}\n".to_string(),
        ]
        .concat();
        let f = fixture("nocontext", &body);
        assert_eq!(fold(&f.0, &UsageTally::default()).ctx_tokens, None);
    }

    #[test]
    fn appended_turns_fold_only_new_bytes_and_a_partial_line_waits() {
        let first = assistant("a1", 0.5, 10, "stop");
        let f = fixture("append", &first);
        let one = fold(&f.0, &UsageTally::default());
        assert_eq!(one.cost_total, 0.5);
        let second = assistant("a2", 0.25, 20, "stop");
        let (done, partial) = second.split_at(second.len() / 2);
        fs::OpenOptions::new()
            .append(true)
            .open(&f.0)
            .unwrap()
            .write_all(done.as_bytes())
            .unwrap();
        let waiting = fold(&f.0, &one);
        assert!(waiting.caught_up);
        assert_eq!(waiting.offset, first.len() as u64);
        assert_eq!(waiting.cost_total, 0.5);
        fs::OpenOptions::new()
            .append(true)
            .open(&f.0)
            .unwrap()
            .write_all(partial.as_bytes())
            .unwrap();
        // Budget 1 byte: a resumed fold still finishes the appended line it
        // started, proving it resumed rather than rereading from zero.
        let len = fs::metadata(&f.0).unwrap().len();
        let mut budget = 1;
        let two = fold_usage(&f.0, &waiting, len, &mut budget).unwrap();
        assert_eq!(budget, 0);
        assert_eq!(two.cost_total, 0.75);
        assert_eq!(two.last_assistant_id.as_deref(), Some("a2"));
        assert_eq!(two.ctx_tokens, Some(130));
    }

    #[test]
    fn a_rewritten_or_shrunk_file_restarts_the_tally() {
        let f = fixture(
            "rewrite",
            &[
                assistant("a1", 0.5, 10, "stop"),
                assistant("a2", 0.5, 10, "stop"),
            ]
            .concat(),
        );
        let before = fold(&f.0, &UsageTally::default());
        assert_eq!(before.cost_total, 1.0);
        // Same length, different bytes before the offset: seal mismatch.
        fs::write(
            &f.0,
            [
                assistant("b1", 0.25, 10, "stop"),
                assistant("b2", 0.25, 10, "stop"),
            ]
            .concat(),
        )
        .unwrap();
        let rewritten = fold(&f.0, &before);
        assert_eq!(rewritten.cost_total, 0.5);
        assert_eq!(rewritten.last_assistant_id.as_deref(), Some("b2"));
        fs::write(&f.0, assistant("c1", 0.125, 10, "stop")).unwrap();
        let shrunk = fold(&f.0, &rewritten);
        assert_eq!(shrunk.cost_total, 0.125);
    }

    #[test]
    fn exhausted_budget_leaves_the_tally_incomplete_until_resumed() {
        let line = assistant("a", 0.5, 10, "stop");
        let f = fixture("budget", &line.repeat(4));
        let len = fs::metadata(&f.0).unwrap().len();
        let mut budget = line.len() as u64;
        let part = fold_usage(&f.0, &UsageTally::default(), len, &mut budget).unwrap();
        assert!(!part.caught_up);
        assert_eq!(part.cost_total, 0.5);
        let mut budget = u64::MAX;
        let rest = fold_usage(&f.0, &part, len, &mut budget).unwrap();
        assert!(rest.caught_up);
        assert_eq!(rest.cost_total, 2.0);
    }

    #[test]
    fn old_control_receipts_survive_paging_and_resume_without_conflating_auto_effort() {
        let initial = concat!(
            "{\"type\":\"thinking_level_change\",\"id\":\"t1\",\"timestamp\":\"2026-10-25T10:00:00Z\",\"thinkingLevel\":\"low\",\"configured\":\"auto\"}\n",
            "{\"type\":\"custom\",\"id\":\"f1\",\"timestamp\":\"2026-10-25T10:00:01Z\",\"customType\":\"omp-pulse-model-fallback\",\"data\":{\"type\":\"retry_fallback_applied\",\"from\":\"openai/primary\",\"to\":\"anthropic/recovery\",\"role\":\"default\",\"reason\":\"Request failed: overloaded\"}}\n"
        );
        let f = fixture(
            "controls",
            &format!("{initial}{}", assistant("a", 0.25, 10, "stop").repeat(600)),
        );
        assert!(
            super::super::read_backward(&f.0, None, 50)
                .entries
                .iter()
                .all(|entry| { entry.get("type").and_then(Value::as_str) == Some("message") })
        );
        let len = fs::metadata(&f.0).unwrap().len();
        let mut budget = initial.len() as u64;
        let partial = fold_usage(&f.0, &UsageTally::default(), len, &mut budget).unwrap();
        assert!(!partial.caught_up);
        let tally = fold(&f.0, &partial);
        assert!(tally.caught_up);
        assert_eq!(tally.cost_total, 150.0);
        assert_eq!(
            tally.configuration.configured_thinking_level.as_deref(),
            Some("auto")
        );
        assert_eq!(tally.configuration.thinking_level.as_deref(), Some("low"));
        let fallback = tally.configuration.model_fallback.as_ref().unwrap();
        assert_eq!(fallback.entry_id.as_deref(), Some("f1"));
        assert_eq!(fallback.at, Some(1_792_922_401_000.0));
        assert_eq!(
            fallback.reason.as_deref(),
            Some("Request failed: overloaded")
        );
        let resolution = concat!(
            "{\"type\":\"thinking_level_change\",\"id\":\"t2\",\"thinkingLevel\":\"high\",\"configured\":\"auto\"}\n",
            "{\"type\":\"thinking_level_change\",\"id\":\"t3\",\"thinkingLevel\":\"high\",\"configured\":\"high\"}\n"
        );
        fs::OpenOptions::new()
            .append(true)
            .open(&f.0)
            .unwrap()
            .write_all(resolution.as_bytes())
            .unwrap();
        let pinned = fold(&f.0, &tally);
        assert_eq!(
            pinned.configuration.configured_thinking_level.as_deref(),
            Some("high")
        );
        assert_eq!(pinned.configuration.thinking_level.as_deref(), Some("high"));
        assert_eq!(
            pinned.configuration.thinking_entry_id.as_deref(),
            Some("t3")
        );
        assert_eq!(
            pinned.configuration.model_fallback,
            tally.configuration.model_fallback
        );
        fs::write(&f.0, assistant("replacement", 0.5, 20, "stop")).unwrap();
        let replaced = fold(&f.0, &pinned);
        assert_eq!(replaced.configuration, SessionConfiguration::default());
    }

    #[test]
    fn active_branch_receipts_ignore_abandoned_siblings_and_late_usage() {
        let f = fixture(
            "branch-controls",
            concat!(
                "{\"type\":\"thinking_level_change\",\"id\":\"auto\",\"parentId\":null,\"thinkingLevel\":\"low\",\"configured\":\"auto\"}\n",
                "{\"type\":\"custom\",\"id\":\"reason\",\"parentId\":\"auto\",\"customType\":\"omp-pulse-model-fallback\",\"data\":{\"from\":\"p/a\",\"to\":\"p/b\",\"role\":\"default\",\"reason\":\"first capacity failure\"}}\n",
                "{\"type\":\"message\",\"id\":\"a\",\"parentId\":\"reason\",\"message\":{\"role\":\"assistant\",\"usage\":{\"cost\":{\"total\":1}}}}\n",
                "{\"type\":\"thinking_level_change\",\"id\":\"pinned\",\"parentId\":\"a\",\"thinkingLevel\":\"high\",\"configured\":\"high\"}\n",
                "{\"type\":\"custom\",\"id\":\"abandoned\",\"parentId\":\"pinned\",\"customType\":\"omp-pulse-model-fallback\",\"data\":{\"from\":\"p/b\",\"to\":\"p/c\",\"role\":\"default\",\"reason\":\"abandoned branch failure\"}}\n",
                "{\"type\":\"branch_summary\",\"id\":\"branch\",\"parentId\":\"reason\",\"summary\":\"back to Auto\"}\n",
                "{\"type\":\"model_usage\",\"id\":\"late\",\"parentId\":\"abandoned\",\"activeLeafId\":\"branch\",\"usage\":{\"cost\":{\"total\":2}}}\n"
            ),
        );
        let tally = fold(&f.0, &UsageTally::default());
        assert_eq!(
            tally.cost_total, 3.0,
            "session spend still includes both branches"
        );
        assert_eq!(
            tally.configuration.configured_thinking_level.as_deref(),
            Some("auto")
        );
        assert_eq!(
            tally
                .configuration
                .model_fallback
                .as_ref()
                .unwrap()
                .reason
                .as_deref(),
            Some("first capacity failure")
        );
    }

    #[test]
    fn branch_metadata_retention_is_bounded_and_old_parents_are_unknown() {
        let mut lines = String::from(
            "{\"type\":\"thinking_level_change\",\"id\":\"root\",\"parentId\":null,\"thinkingLevel\":\"low\",\"configured\":\"auto\"}\n",
        );
        let mut parent = String::from("root");
        for i in 0..MAX_CONFIGURATION_ENTRIES + 10 {
            let id = format!("m{i}");
            lines.push_str(&format!("{{\"type\":\"message\",\"id\":\"{id}\",\"parentId\":\"{parent}\",\"message\":{{\"role\":\"user\",\"content\":\"x\"}}}}\n"));
            parent = id;
        }
        let f = fixture("bounded-controls", &lines);
        let tally = fold(&f.0, &UsageTally::default());
        assert_eq!(tally.branch_configurations.len(), MAX_CONFIGURATION_ENTRIES);
        assert_eq!(tally.configuration_order.len(), MAX_CONFIGURATION_ENTRIES);
        assert_eq!(
            tally.configuration.configured_thinking_level.as_deref(),
            Some("auto"),
            "a long linear run retains its active receipt"
        );
        fs::OpenOptions::new().append(true).open(&f.0).unwrap().write_all(
            b"{\"type\":\"branch_summary\",\"id\":\"old-branch\",\"parentId\":\"root\",\"summary\":\"return\"}\n"
        ).unwrap();
        let branched = fold(&f.0, &tally);
        assert_eq!(
            branched.configuration,
            SessionConfiguration::default(),
            "never substitute a later abandoned-branch selector for an expired parent"
        );
    }

    #[test]
    fn cached_branch_snapshot_is_unchanged_when_a_clone_resumes_folding() {
        let mut cached = UsageTally::default();
        fold_line(&mut cached, br#"{"type":"thinking_level_change","id":"auto","parentId":null,"thinkingLevel":"low","configured":"auto"}"#);
        let mut resumed = cached.clone();
        fold_line(&mut resumed, br#"{"type":"thinking_level_change","id":"pinned","parentId":"auto","thinkingLevel":"high","configured":"high"}"#);
        assert_eq!(
            resumed.configuration.configured_thinking_level.as_deref(),
            Some("high")
        );
        assert_eq!(
            cached.configuration.configured_thinking_level.as_deref(),
            Some("auto")
        );
        // A concurrent older snapshot must not acquire entries appended only
        // to the resumed fold, even when the index containers were shared.
        fold_line(
            &mut cached,
            br#"{"type":"branch_summary","id":"branch","parentId":"pinned","summary":""}"#,
        );
        assert_eq!(cached.configuration, SessionConfiguration::default());
        assert_eq!(
            resumed.configuration.configured_thinking_level.as_deref(),
            Some("high")
        );
    }

    #[test]
    fn unreadable_file_is_none() {
        let mut budget = u64::MAX;
        assert!(
            fold_usage(
                Path::new("/nonexistent/pulse-usage.jsonl"),
                &UsageTally::default(),
                0,
                &mut budget
            )
            .is_none()
        );
    }
}
