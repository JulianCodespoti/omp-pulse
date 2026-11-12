//! The `/api/tree` branch shape: user turns, decisions and completed-answer
//! resume targets with turn stats, in omp `/tree` order, cached by file stamp.

use super::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// One user-turn row of the phone's branch tree (`/api/tree`), mirroring
/// omp's `/tree` (tree-selector.ts `flattenTree`) on the wire:
/// - `indent` is the display indent level (3 cells per level, client-side);
/// - `connector` is `"branch"`/`"last"` when this row is a FORK CHILD (its
///   parent has 2+ user-turn children), null otherwise;
/// - `gutters` are the levels where a `│` must be drawn: each ancestor that
///   still has a LATER sibling pending contributes its connector column
///   (`indent - 1`), so the line continues below the row;
/// - `active` means the row lies on the raw `parentId` chain of the file's
///   resolved active leaf; `current` is the newest active row;
/// - `stats` summarises the turn's own work (see `TurnStats`).
#[derive(Debug, Clone)]
pub struct TreeRow {
    pub id: String,
    pub text: String,
    /// User turns own usage; ask decisions are zero-cost navigation points.
    pub kind: &'static str,
    pub answer: Option<String>,
    /// Completed assistant answers on this turn's branches, not rewind prompts.
    pub resume_targets: Vec<TreeResumeTarget>,
    pub indent: usize,
    pub connector: Option<&'static str>,
    pub gutters: Vec<usize>,
    pub active: bool,
    pub current: bool,
    /// omp entry label (`/tree` Shift+L, or the phone's Timeline), newest
    /// `label` entry for this id wins; `None` when unset or cleared.
    pub label: Option<String>,
    pub stats: TurnStats,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TreeResumeTarget {
    pub id: String,
    pub text: String,
    pub at: Option<f64>,
}

/// What one user turn cost and produced: every entry whose nearest user-turn
/// ancestor (raw `parentId` chain) is this turn belongs to it, so a branch's
/// replies count only on the turn they answered. Throughput is decode speed:
/// output tokens over the assistant messages' `duration - ttft` (the time
/// spent streaming, without the wait for the first token or any tool run).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnStats {
    /// Epoch ms the user sent the turn.
    pub at: Option<f64>,
    /// Epoch ms of the turn's newest entry (an assistant reply's completion
    /// when it records one).
    pub last_at: Option<f64>,
    pub replies: u32,
    pub tools: u32,
    pub output_tokens: u64,
    /// Summed streaming time of the replies, ms.
    pub stream_ms: f64,
    pub cost: f64,
    /// The newest reply's model.
    pub model: Option<String>,
    /// The newest reply's `stopReason` (`error`/`aborted` mark a turn that
    /// did not finish).
    pub stop: Option<String>,
}

impl TurnStats {
    fn observe(&mut self, v: &Value) {
        let at = entry_time_ms(v);
        let Some(message) = v
            .get("message")
            .filter(|_| v.get("type").and_then(Value::as_str) == Some("message"))
        else {
            self.extend_to(at);
            return;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            self.extend_to(at);
            return;
        }
        self.extend_to(message.get("completedAt").and_then(Value::as_f64).or(at));
        self.replies += 1;
        if let Some(parts) = message.get("content").and_then(Value::as_array) {
            let calls = parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("toolCall"))
                .count();
            self.tools += u32::try_from(calls).unwrap_or(u32::MAX);
        }
        if let Some(usage) = message.get("usage") {
            let output = usage.get("output").and_then(Value::as_u64).unwrap_or(0);
            self.output_tokens += output;
            self.cost += usage
                .pointer("/cost/total")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let duration = message
                .get("duration")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let ttft = message.get("ttft").and_then(Value::as_f64).unwrap_or(0.0);
            // Only replies that streamed tokens count toward the speed: a
            // reply with no output (or no timing) would only dilute it.
            if output > 0 && duration > ttft {
                self.stream_ms += duration - ttft;
            }
        }
        if let Some(model) = message.get("model").and_then(Value::as_str) {
            self.model = Some(model.to_string());
        }
        self.stop = message
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    fn extend_to(&mut self, at: Option<f64>) {
        if let Some(at) = at {
            self.last_at = Some(self.last_at.map_or(at, |last| last.max(at)));
        }
    }

    /// Output tokens per second of streaming, when there was any.
    pub fn tokens_per_second(&self) -> Option<f64> {
        (self.stream_ms >= 1.0 && self.output_tokens > 0)
            .then(|| self.output_tokens as f64 * 1000.0 / self.stream_ms)
    }
}

/// Cache key for a computed tree: the file's (path, length, mtime). A session
/// file only ever grows, so a matching triple means byte-identical input; the
/// nanosecond `mtime_millis` (the listing's own mtime) plus the length also
/// catch an in-place rewrite (TUI compaction rewrites the file wholesale from
/// memory — see guard.rs) that a millisecond-rounded mtime alone could miss.
type TreeCacheKey = (PathBuf, u64, f64);

/// Tiny LRU of computed trees so scroll-up paging does not re-parse a 44 MB
/// session on every page (measured: a line-by-line parse of that file costs
/// ~0.13 s in Python; a Rust parse is faster but still a full file read).
/// Four entries is plenty — the active session plus a couple of recently
/// viewed ones — and the cap bounds memory to at most four full parses. The
/// same mtime-memoization idiom as `index::SNIPPET_CACHE`, with an LRU cap on
/// top so flipping between sessions cannot accumulate unbounded entries.
/// The retained entries, newest at the back. Named because the bare nesting trips
/// clippy's type-complexity lint, and a name is cheaper to read than four levels of
/// generics at every use.
type TreeCacheEntries = VecDeque<(TreeCacheKey, Arc<Vec<TreeRow>>)>;

static TREE_CACHE: std::sync::LazyLock<Mutex<TreeCacheEntries>> =
    std::sync::LazyLock::new(|| Mutex::new(VecDeque::new()));

/// At most this many computed trees are retained; the oldest (front) is
/// evicted first when the cap is exceeded.
const TREE_CACHE_MAX: usize = 4;

/// Build the phone's branch tree for a session file: every user turn — a
/// `message`/user entry or a `custom_message`/collab-prompt entry with
/// non-whitespace text — as one row, parented to its NEAREST user-turn
/// ancestor through the raw `parentId` chain, in omp `/tree` display order
/// (pre-order DFS, active subtree first).
///
/// WHY A FULL FILE PASS: the raw parent chain is LINEAR (measured on the live
/// 44 MB session: depth == entry count, 11,597 lines / 97 user turns / 5 fork
/// points / widest 3), so indenting per entry is meaningless — the tree must
/// be re-derived from `parentId` links, which needs the whole file. The
/// `TREE_CACHE` above means that cost is paid once per file change, not once
/// per scroll-up page.
///
/// Robustness matches the rest of the module: unparseable lines are skipped,
/// entries without an `id` cannot be rows or parent-chain targets, a missing
/// or unreadable file yields an empty tree (never an error or panic), and a
/// `parentId` cycle (malformed file) terminates and degrades to a root.
/// Traversal is iterative only — a 91-deep chain must not recurse (a Python
/// prototype hit the recursion limit on this exact data).
pub fn read_tree(path: &Path) -> Vec<TreeRow> {
    let (len, mtime) = match fs::metadata(path) {
        Ok(m) => (m.len(), mtime_millis(&m)),
        Err(_) => return Vec::new(),
    };
    let key = (path.to_path_buf(), len, mtime);
    {
        let mut cache = TREE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(pos) = cache.iter().position(|(k, _)| *k == key) {
            // Hit: refresh LRU recency (move to the back) and return.
            let rows = cache[pos].1.clone();
            let _ = cache.remove(pos);
            cache.push_back((key, rows.clone()));
            return rows.as_ref().clone();
        }
    }
    let rows = Arc::new(build_tree_rows(path));
    let mut cache = TREE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.push_back((key, rows.clone()));
    while cache.len() > TREE_CACHE_MAX {
        cache.pop_front();
    }
    rows.as_ref().clone()
}

/// One parsed session entry, reduced to the fields the tree needs.
struct RawEntry {
    id: String,
    parent: Option<String>,
    session_entry: bool,
    /// `Some` (user-turn text) for rows; `None` for every other entry AND for
    /// user messages whose text is empty or whitespace-only — those are not
    /// turns at all, so they are skipped as rows and cannot be parent targets.
    text: Option<String>,
    ask: Option<AskDecision>,
}

struct AskDecision {
    tool_call_id: String,
    answer: String,
}

/// OMP 18.10.4 late usage keeps its initiating parent but may capture another
/// active leaf. Keep null distinct from an absent/malformed marker, and retain
/// only the newest self-selecting entry for dangling-marker recovery.
#[derive(Default)]
pub(crate) struct ActiveLeafSelection {
    selected: Option<String>,
    latest_self_selected: Option<String>,
    captured: bool,
}

fn is_session_entry(value: &Value) -> bool {
    !matches!(
        value.get("type").and_then(Value::as_str),
        Some("session" | "title")
    )
}

impl ActiveLeafSelection {
    pub(crate) fn observe(&mut self, id: &str, value: &Value) {
        let captured = if value.get("type").and_then(Value::as_str) == Some("model_usage") {
            match value.get("activeLeafId") {
                Some(Value::String(target)) => Some(Some(target.as_str())),
                Some(Value::Null) => Some(None),
                _ => None,
            }
        } else {
            None
        };
        self.captured = captured.is_some();
        self.selected = captured.unwrap_or(Some(id)).map(str::to_string);
        if self.selected.as_deref() == Some(id) && is_session_entry(value) {
            self.latest_self_selected = Some(id.to_string());
        }
    }

    pub(crate) fn resolve(self, is_known_entry: impl FnOnce(&str) -> bool) -> Option<String> {
        if self.captured
            && self
                .selected
                .as_deref()
                .is_some_and(|id| !is_known_entry(id))
        {
            self.latest_self_selected
        } else {
            self.selected
        }
    }
}

/// One user turn in the re-derived user tree.
struct TurnNode {
    id: String,
    text: String,
    kind: &'static str,
    answer: Option<String>,
    /// Node indices of user-turn children, in FILE order. Display order is
    /// derived per node (the active child first, the rest in file order).
    children: Vec<usize>,
}

/// One DFS stack frame: the node plus its already-computed row attributes.
struct Frame {
    node: usize,
    indent: usize,
    connector: Option<&'static str>,
    /// Whether this node is the LAST sibling in display order — the flag the
    /// children's gutters need (`│` continues only while a later sibling is
    /// still pending below).
    is_last: bool,
    gutters: Vec<usize>,
}

fn build_tree_rows(path: &Path) -> Vec<TreeRow> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    // Pass 1: every parseable line → (id, parentId, user-turn text).
    let mut entries: Vec<RawEntry> = Vec::new();
    let mut parents: HashMap<String, Option<String>> = HashMap::new();
    let mut user_turns: HashMap<String, usize> = HashMap::new(); // id → entries index
    // `label` entries carry `targetId` + `label` (absent or empty = cleared);
    // the newest in file order wins, as in omp's own label index.
    let mut labels: HashMap<String, Option<String>> = HashMap::new();
    let mut leaf = ActiveLeafSelection::default();
    // Each entry's owning user turn (itself for a turn), memoised in file
    // order: an entry's parent precedes it, so one lookup per entry finds
    // the nearest user-turn ancestor without walking the 11k-deep chain.
    let mut owner: HashMap<String, String> = HashMap::new();
    let mut stats: HashMap<String, TurnStats> = HashMap::new();
    let mut resume_targets: HashMap<String, Vec<TreeResumeTarget>> = HashMap::new();
    // Native ask recovery stops at the nearest assistant or user message.
    // Key calls by their containing entry, never by a globally reused call id.
    let mut ask_calls: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut user_messages: HashSet<String> = HashSet::new();
    for line in bytes.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue; // unparseable (torn/garbage) lines are never fatal
        };
        let Some(obj) = v.as_object() else { continue };
        let Some(id) = obj.get("id").and_then(|i| i.as_str()) else {
            continue; // no id → cannot be a row or a chain target
        };
        let id = id.to_string();
        if obj.get("type").and_then(Value::as_str) == Some("label")
            && let Some(target) = obj.get("targetId").and_then(Value::as_str)
        {
            let label = obj
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string);
            labels.insert(target.to_string(), label);
        }
        let parent = obj
            .get("parentId")
            .and_then(|p| p.as_str())
            .map(str::to_string);
        let text = user_turn_text(&v);
        let message = v
            .get("message")
            .filter(|_| v.get("type").and_then(Value::as_str) == Some("message"));
        let role = message.and_then(|m| m.get("role")).and_then(Value::as_str);
        if role == Some("user") {
            user_messages.insert(id.clone());
        }
        if role == Some("assistant") {
            let mut calls = HashMap::new();
            if let Some(parts) = message
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            {
                for part in parts {
                    if part.get("type").and_then(Value::as_str) != Some("toolCall")
                        || part.get("name").and_then(Value::as_str) != Some("ask")
                    {
                        continue;
                    }
                    if let (Some(call_id), Some(questions)) = (
                        part.get("id").and_then(Value::as_str),
                        part.pointer("/arguments/questions")
                            .and_then(Value::as_array),
                    ) {
                        let text = questions
                            .iter()
                            .filter_map(|q| q.get("question").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n");
                        if !text.trim().is_empty() {
                            calls.insert(call_id.to_string(), text);
                        }
                    }
                }
            }
            ask_calls.insert(id.clone(), calls);
        }
        let ask = message
            .filter(|m| {
                role == Some("toolResult")
                    && m.get("toolName").and_then(Value::as_str) == Some("ask")
            })
            .and_then(|m| {
                let tool_call_id = m.get("toolCallId")?.as_str()?.to_string();
                let answer = match m.get("content")? {
                    Value::String(text) => text.clone(),
                    Value::Array(parts) => parts
                        .iter()
                        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => return None,
                };
                Some(AskDecision {
                    tool_call_id,
                    answer,
                })
            });
        if text.is_some() {
            user_turns.insert(id.clone(), entries.len());
        }
        let owned_by = if text.is_some() {
            Some(id.clone())
        } else {
            parent.as_ref().and_then(|p| owner.get(p)).cloned()
        };
        if let Some(turn) = owned_by {
            // Selecting a user entry rewinds past it in native navigateTree.
            // Keep completed answers separately so continuing a branch preserves
            // its last prompt AND answer, including sibling answers to one prompt.
            if let Some(message) = message.filter(|m| {
                role == Some("assistant")
                    && matches!(
                        m.get("stopReason").and_then(Value::as_str),
                        Some("stop" | "length")
                    )
                    && m.get("errorMessage")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty)
                    && !m
                        .get("content")
                        .and_then(Value::as_array)
                        .is_some_and(|parts| {
                            parts.iter().any(|part| {
                                part.get("type").and_then(Value::as_str) == Some("toolCall")
                            })
                        })
            }) {
                let text = match message.get("content") {
                    Some(Value::String(text)) => Some(text.as_str()),
                    Some(Value::Array(parts)) => parts
                        .iter()
                        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .find(|text| !text.trim().is_empty()),
                    _ => None,
                };
                resume_targets
                    .entry(turn.clone())
                    .or_default()
                    .push(TreeResumeTarget {
                        id: id.clone(),
                        text: text
                            .unwrap_or("Completed answer")
                            .chars()
                            .take(160)
                            .collect(),
                        at: entry_time_ms(&v),
                    });
            }
            let entry = stats.entry(turn.clone()).or_default();
            if text.is_some() {
                entry.at = entry_time_ms(&v);
            }
            entry.observe(&v);
            owner.insert(id.clone(), turn);
        }
        parents.insert(id.clone(), parent.clone());
        entries.push(RawEntry {
            id: id.clone(),
            parent,
            session_entry: is_session_entry(&v),
            text,
            ask,
        });
        leaf.observe(&id, &v);
    }
    // Historical ask results become rows only when the original call on that
    // exact branch can be recovered. Costs remain assigned to the user turn.
    for (index, entry) in entries.iter_mut().enumerate() {
        let Some(ask) = &entry.ask else { continue };
        let mut parent = entry.parent.as_deref();
        let mut seen = HashSet::new();
        while let Some(id) = parent {
            if !seen.insert(id) || user_messages.contains(id) {
                break;
            }
            if let Some(calls) = ask_calls.get(id) {
                if let Some(text) = calls.get(&ask.tool_call_id) {
                    entry.text = Some(text.clone());
                    user_turns.insert(entry.id.clone(), index);
                }
                break;
            }
            parent = parents.get(id).and_then(|p| p.as_deref());
        }
    }
    // Pass 2: each user turn's parent is its NEAREST user-turn ancestor up
    // the raw parentId chain — assistant/tool entries in between do not break
    // attachment (the walk keeps stepping until it finds a user turn, a
    // missing id, or the file's root). A cycle (malformed file) is cut by a
    // step cap; the turn degrades to a root instead of looping forever.
    let cap = parents.len().max(1);
    let mut user_parent: HashMap<String, Option<String>> = HashMap::new();
    for e in &entries {
        if e.text.is_none() {
            continue;
        }
        let mut cur = e.parent.clone();
        let mut steps = 0usize;
        let found = loop {
            match cur {
                Some(id) if user_turns.contains_key(&id) => break Some(id),
                Some(id) => match parents.get(&id) {
                    Some(p) => {
                        cur = p.clone();
                        steps += 1;
                        if steps > cap {
                            break None;
                        }
                    }
                    None => break None,
                },
                None => break None,
            }
        };
        user_parent.insert(e.id.clone(), found);
    }
    // Pass 3: node table in file order; children lists in file order.
    let mut nodes: Vec<TurnNode> = Vec::new();
    let mut node_idx: HashMap<String, usize> = HashMap::new();
    for e in &entries {
        if let Some(text) = &e.text {
            node_idx.insert(e.id.clone(), nodes.len());
            nodes.push(TurnNode {
                id: e.id.clone(),
                text: text.clone(),
                kind: if e.ask.is_some() { "ask" } else { "user" },
                answer: e.ask.as_ref().map(|ask| ask.answer.clone()),
                children: Vec::new(),
            });
        }
    }
    let mut roots: Vec<usize> = Vec::new();
    for i in 0..nodes.len() {
        match user_parent
            .get(&nodes[i].id)
            .and_then(|p| p.as_ref())
            .and_then(|p| node_idx.get(p))
        {
            Some(&pi) => nodes[pi].children.push(i),
            None => roots.push(i),
        }
    }
    // Pass 4: the ACTIVE path follows the persisted selection, not a late
    // usage record's initiating branch. Do not rewrite any parent links.
    let mut active: HashSet<String> = HashSet::new();
    let mut current_id: Option<String> = None;
    let mut current_order: Option<usize> = None;
    let mut cur = leaf.resolve(|id| {
        // Match the existing parent map's last-write-wins duplicate policy;
        // headers stay graph links but are not captured session-entry targets.
        entries
            .iter()
            .rev()
            .find(|e| e.id == id)
            .is_some_and(|e| e.session_entry)
    });
    let mut steps = 0usize;
    while let Some(id) = cur {
        if let Some(&order) = user_turns.get(&id) {
            active.insert(id.clone());
            if current_order.map(|c| order > c).unwrap_or(true) {
                current_order = Some(order);
                current_id = Some(id.clone());
            }
        }
        match parents.get(&id) {
            Some(p) => cur = p.clone(),
            None => break,
        }
        steps += 1;
        if steps > cap {
            break;
        }
    }
    // Pass 5: pre-order DFS (iterative — a 91-deep chain must not recurse),
    // mirroring tree-selector.ts `flattenTree`: roots are children of a
    // virtual root (multiple roots ⇒ every root gets indent 1 and a
    // connector), siblings are ordered with the active subtree FIRST, a fork
    // point adds one indent level while a linear chain retains the parent's
    // level, and every descendant of a fork child that still has a later
    // sibling pending inherits a `│` at that ancestor's connector column.
    let multiple_roots = roots.len() > 1;
    let mut ordered_roots: Vec<usize> = roots
        .iter()
        .copied()
        .filter(|&i| active.contains(&nodes[i].id))
        .collect();
    ordered_roots.extend(
        roots
            .iter()
            .copied()
            .filter(|&i| !active.contains(&nodes[i].id)),
    );

    let mut stack: Vec<Frame> = Vec::new();
    for (pos, &ri) in ordered_roots.iter().enumerate().rev() {
        let is_last = pos == ordered_roots.len() - 1;
        stack.push(Frame {
            node: ri,
            indent: usize::from(multiple_roots),
            connector: if multiple_roots {
                Some(if is_last { "last" } else { "branch" })
            } else {
                None
            },
            is_last,
            gutters: Vec::new(),
        });
    }

    let mut rows: Vec<TreeRow> = Vec::with_capacity(nodes.len());
    while let Some(frame) = stack.pop() {
        let node = &nodes[frame.node];
        rows.push(TreeRow {
            id: node.id.clone(),
            text: node.text.clone(),
            kind: node.kind,
            answer: node.answer.clone(),
            resume_targets: resume_targets.remove(&node.id).unwrap_or_default(),
            indent: frame.indent,
            connector: frame.connector,
            gutters: frame.gutters.clone(),
            active: active.contains(&node.id),
            current: current_id.as_deref() == Some(node.id.as_str()),
            stats: stats.remove(&node.id).unwrap_or_default(),
            label: labels.get(&node.id).cloned().flatten(),
        });
        // Children: the active subtree first, the rest in file order.
        let mut ordered: Vec<usize> = node
            .children
            .iter()
            .copied()
            .filter(|&c| active.contains(&nodes[c].id))
            .collect();
        ordered.extend(
            node.children
                .iter()
                .copied()
                .filter(|&c| !active.contains(&nodes[c].id)),
        );
        let child_count = ordered.len();
        // A real fork adds one level; a linear chain stays aligned with its
        // head (the omp rule — text must not drift right after every fork).
        let child_indent = frame.indent + usize::from(child_count >= 2);
        // This node's connector column is `indent - 1` (indent is ≥ 1 for any
        // connector-bearing node: roots under multiple roots start at 1, fork
        // children add 1). While this node still has a later sibling pending,
        // every descendant keeps a `│` there; a node that shows no connector
        // (a linear child) contributes nothing.
        let child_gutters = if frame.connector.is_some() && !frame.is_last {
            let mut g = frame.gutters.clone();
            g.push(frame.indent - 1);
            g
        } else {
            frame.gutters.clone()
        };
        for (pos, &ci) in ordered.iter().enumerate().rev() {
            let is_last = pos == child_count - 1;
            stack.push(Frame {
                node: ci,
                indent: child_indent,
                connector: if child_count >= 2 {
                    Some(if is_last { "last" } else { "branch" })
                } else {
                    None
                },
                is_last,
                gutters: child_gutters.clone(),
            });
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::jsonl::tests::scratch;

    #[test]
    fn active_leaf_resolution_all_markers_have_no_header_fallback() {
        let mut leaf = ActiveLeafSelection::default();
        leaf.observe("header", &serde_json::json!({"type":"session"}));
        leaf.observe(
            "m1",
            &serde_json::json!({"type":"model_usage","activeLeafId":null}),
        );
        leaf.observe(
            "m2",
            &serde_json::json!({"type":"model_usage","activeLeafId":"header"}),
        );
        assert_eq!(leaf.resolve(|id| matches!(id, "m1" | "m2")), None);
    }

    // --- read_tree: the /api/tree branch shape -------------------------------

    fn header_line(id: &str) -> String {
        format!(r#"{{"type":"session","id":"{id}","timestamp":1,"title":"t"}}"#)
    }

    fn user_line(id: &str, parent: &str, text: &str) -> String {
        format!(
            r#"{{"type":"message","id":"{id}","parentId":"{parent}","timestamp":1,"message":{{"role":"user","content":[{{"type":"text","text":"{text}"}}]}}}}"#
        )
    }

    fn assistant_line(id: &str, parent: &str) -> String {
        format!(
            r#"{{"type":"message","id":"{id}","parentId":"{parent}","timestamp":1,"message":{{"role":"assistant","content":[{{"type":"text","text":"reply"}}]}}}}"#
        )
    }

    /// A tool entry — neither a user turn nor a message, but a valid chain link.
    fn tool_line(id: &str, parent: &str) -> String {
        format!(
            r#"{{"type":"tool_call","id":"{id}","parentId":"{parent}","timestamp":1,"tool":"bash","input":"ls"}}"#
        )
    }

    fn collab_line(id: &str, parent: &str, text: &str) -> String {
        format!(
            r#"{{"type":"custom_message","id":"{id}","parentId":"{parent}","customType":"collab-prompt","timestamp":1,"content":[{{"type":"text","text":"{text}"}}]}}"#
        )
    }

    /// Write a fixture session and return (path, rows); the scratch file is
    /// removed once the tree is read (the cache keys on path+len+mtime, so a
    /// removed path never collides with a later test).
    fn tree_fixture(tag: &str, lines: &[&str]) -> (std::path::PathBuf, Vec<TreeRow>) {
        let path = scratch(tag, &lines.join("\n"));
        let rows = read_tree(&path);
        let _ = std::fs::remove_file(&path);
        (path, rows)
    }

    #[test]
    fn completed_sibling_answers_remain_distinct_resume_targets() {
        let answer = |id: &str, parent: &str, reason: &str| {
            serde_json::json!({
                "type":"message", "id":id, "parentId":parent, "timestamp":2,
                "message":{"role":"assistant","stopReason":reason,
                    "content":[{"type":"text","text":"Same completed answer"}]}
            })
            .to_string()
        };
        let (_, rows) = tree_fixture(
            "resume-siblings",
            &[
                &header_line("s"),
                &user_line("u1", "s", "Same prompt"),
                &answer("a1", "u1", "stop"),
                &answer("a2", "u1", "stop"),
                &answer("aborted", "u1", "aborted"),
                &answer("failed", "u1", "error"),
                &answer("tool", "u1", "toolUse"),
                &user_line("u2", "a2", "Next prompt"),
                &answer("a3", "u2", "stop"),
            ],
        );
        let first = rows.iter().find(|row| row.id == "u1").unwrap();
        assert_eq!(
            first
                .resume_targets
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            ["a1", "a2"]
        );
        assert!(
            first
                .resume_targets
                .iter()
                .all(|target| target.text == "Same completed answer")
        );
        let next = rows.iter().find(|row| row.id == "u2").unwrap();
        assert_eq!(next.resume_targets[0].id, "a3");
        assert_eq!(next.resume_targets.len(), 1);
    }

    #[test]
    fn historical_ask_siblings_keep_original_answers_and_user_turn_costs() {
        let call = r#"{"type":"message","id":"call","parentId":"u","message":{"role":"assistant","content":[{"type":"toolCall","id":"q","name":"ask","arguments":{"questions":[{"id":"db","question":"Which database?","options":[{"label":"SQLite"},{"label":"Postgres"}]}]}}],"usage":{"output":11,"cost":{"total":0.25}}}}"#;
        let old = r#"{"type":"message","id":"old-answer","parentId":"call","message":{"role":"toolResult","toolName":"ask","toolCallId":"q","content":[{"type":"text","text":"User selected: SQLite"}]}}"#;
        let new = r#"{"type":"message","id":"new-answer","parentId":"call","message":{"role":"toolResult","toolName":"ask","toolCallId":"q","content":[{"type":"text","text":"User selected: Postgres"}]}}"#;
        let marker = r#"{"type":"custom","id":"move","parentId":"new-answer","customType":"omp-pulse-goto","data":{"targetId":"old-answer"}}"#;
        let label = r#"{"type":"label","id":"label","parentId":"move","targetId":"old-answer","label":"original choice"}"#;
        let (_, rows) = tree_fixture(
            "ask-siblings",
            &[
                &header_line("s"),
                &user_line("u", "s", "Pick storage"),
                call,
                old,
                &user_line("old-followup", "old-answer", "Continue original"),
                new,
                marker,
                label,
            ],
        );
        assert_eq!(
            rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["u", "new-answer", "old-answer", "old-followup"]
        );
        assert_eq!(rows[0].kind, "user");
        assert_eq!(rows[0].stats.output_tokens, 11);
        assert_eq!(rows[0].stats.cost, 0.25);
        assert_eq!(rows[1].kind, "ask");
        assert_eq!(rows[1].text, "Which database?");
        assert_eq!(rows[1].answer.as_deref(), Some("User selected: Postgres"));
        assert!(rows[1].active && rows[1].current);
        assert_eq!(rows[1].connector, Some("branch"));
        assert_eq!(rows[2].answer.as_deref(), Some("User selected: SQLite"));
        assert_eq!(rows[2].label.as_deref(), Some("original choice"));
        assert!(!rows[2].active);
        assert_eq!(rows[2].connector, Some("last"));
        assert_eq!(rows[1].stats, TurnStats::default());
        assert_eq!(rows[2].stats, TurnStats::default());
        assert_eq!(rows.iter().map(|r| r.stats.output_tokens).sum::<u64>(), 11);
    }

    #[test]
    fn historical_ask_matches_call_on_its_own_branch_and_omits_unrecoverable_questions() {
        let call = |id: &str, question: &str| {
            serde_json::json!({
            "type": "message", "id": id, "parentId": "u",
            "message": {"role":"assistant", "content":[{
                "type":"toolCall", "name":"ask", "id":"reused",
                "arguments":{"questions":[{"id":"q","question":question,"options":[{"label":"Yes"}]}]}
            }]}
        }).to_string()
        };
        let answer = |id: &str, parent: &str| {
            serde_json::json!({
                "type":"message", "id":id, "parentId":parent,
                "message":{"role":"toolResult","toolName":"ask","toolCallId":"reused",
                    "content":[{"type":"text","text":"User selected: Yes"}]}
            })
            .to_string()
        };
        let (_, rows) = tree_fixture(
            "ask-branch-match",
            &[
                &header_line("s"),
                &user_line("u", "s", "Choose"),
                &call("a", "Original?"),
                &answer("answer-a", "a"),
                &call("b", "Different?"),
                &answer("answer-b", "b"),
                &assistant_line("unrelated", "answer-b"),
                &answer("missing", "unrelated"),
            ],
        );
        let ask: Vec<_> = rows.iter().filter(|r| r.kind == "ask").collect();
        assert_eq!(ask.len(), 2);
        assert_eq!(
            ask.iter().find(|r| r.id == "answer-a").unwrap().text,
            "Original?"
        );
        assert_eq!(
            ask.iter().find(|r| r.id == "answer-b").unwrap().text,
            "Different?"
        );
        assert!(!rows.iter().any(|r| r.id == "missing"));
    }

    #[test]
    fn read_tree_turn_stats_belong_to_the_turn_each_reply_answered() {
        // m1 is answered twice through a tool call; m2 forks off m1's first
        // reply, so its reply must count on m2 alone, never on m1.
        let user = |id: &str, parent: &str, at: &str| {
            format!(
                r#"{{"type":"message","id":"{id}","parentId":"{parent}","timestamp":"{at}","message":{{"role":"user","content":[{{"type":"text","text":"{id}"}}]}}}}"#
            )
        };
        let reply = |id: &str,
                     parent: &str,
                     at: &str,
                     done: u64,
                     output: u64,
                     duration: f64,
                     ttft: f64,
                     stop: &str,
                     tools: usize| {
            let calls = vec![r#"{"type":"toolCall","id":"c","name":"bash","arguments":{}}"#; tools]
                .join(",");
            format!(
                r#"{{"type":"message","id":"{id}","parentId":"{parent}","timestamp":"{at}","message":{{"role":"assistant","model":"m-{id}","stopReason":"{stop}","completedAt":{done},"duration":{duration},"ttft":{ttft},"usage":{{"output":{output},"cost":{{"total":0.25}}}},"content":[{calls}]}}}}"#
            )
        };
        let (_, rows) = tree_fixture(
            "tree-stats",
            &[
                &header_line("h0"),
                &user("m1", "h0", "2026-10-17T10:00:00.000Z"),
                &reply(
                    "a1",
                    "m1",
                    "2026-10-17T10:00:01.000Z",
                    1_792_231_205_000,
                    100,
                    3_000.0,
                    1_000.0,
                    "toolUse",
                    2,
                ),
                &tool_line("t1", "a1"),
                &reply(
                    "a2",
                    "t1",
                    "2026-10-17T10:00:06.000Z",
                    1_792_231_210_000,
                    50,
                    1_500.0,
                    500.0,
                    "stop",
                    0,
                ),
                &user("m2", "a1", "2026-10-17T10:01:00.000Z"),
                &reply(
                    "b1",
                    "m2",
                    "2026-10-17T10:01:01.000Z",
                    1_792_231_263_000,
                    0,
                    900.0,
                    900.0,
                    "aborted",
                    0,
                ),
            ],
        );
        let m1 = &rows.iter().find(|r| r.id == "m1").unwrap().stats;
        assert_eq!(m1.at, Some(1_792_231_200_000.0));
        assert_eq!(
            m1.last_at,
            Some(1_792_231_210_000.0),
            "the newest reply's completion ends the turn"
        );
        assert_eq!((m1.replies, m1.tools, m1.output_tokens), (2, 2, 150));
        assert_eq!(
            m1.tokens_per_second(),
            Some(50.0),
            "150 tokens over 3s of streaming, not the 4.5s with waits"
        );
        assert!((m1.cost - 0.5).abs() < 1e-9);
        assert_eq!(
            (m1.model.as_deref(), m1.stop.as_deref()),
            (Some("m-a2"), Some("stop"))
        );
        let m2 = &rows.iter().find(|r| r.id == "m2").unwrap().stats;
        assert_eq!((m2.replies, m2.output_tokens), (1, 0));
        assert_eq!(
            m2.tokens_per_second(),
            None,
            "a reply that streamed nothing has no speed"
        );
        assert_eq!(m2.stop.as_deref(), Some("aborted"));
    }

    #[test]
    fn read_tree_linear_session_all_rows_indent_zero_active() {
        // A purely linear conversation: every row indent 0, no connectors, no
        // gutters, every row active, and only the newest active row is
        // current. m2's nearest user ancestor is m1 TWO non-user entries up
        // (tool + assistant) — attachment must survive the gap.
        let (_, rows) = tree_fixture(
            "tree-linear",
            &[
                &header_line("h0"),
                &user_line("m1", "h0", "first"),
                &assistant_line("a1", "m1"),
                &tool_line("t1", "a1"),
                &user_line("m2", "t1", "second"),
                &assistant_line("a2", "m2"),
                &user_line("m3", "a2", "third"),
                &assistant_line("a3", "m3"), // last entry → active path
            ],
        );
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["m1", "m2", "m3"]);
        assert_eq!(rows[0].text, "first");
        for (i, r) in rows.iter().enumerate() {
            assert_eq!(r.indent, 0, "row {i} is linear");
            assert_eq!(r.connector, None, "row {i} is not a fork child");
            assert!(r.gutters.is_empty(), "row {i} has no pending ancestor");
            assert!(r.active, "row {i} lies on the active chain");
            if i < rows.len() - 1 {
                assert!(!r.current, "row {i} is not the newest active turn");
            }
        }
        assert!(rows[2].current, "the newest active turn is current");
    }

    #[test]
    fn read_tree_labels_rows_and_follows_an_in_place_move_marker() {
        // The phone's Timeline sets labels as omp `label` entries (newest
        // wins, an empty label clears) and "Go here" ends in a metadata-only
        // `custom` marker whose parent is the new position: the active path
        // must follow that marker, not the abandoned newest turn.
        let (_, rows) = tree_fixture(
            "tree-labels-goto",
            &[
                &header_line("h0"),
                &user_line("m1", "h0", "first"),
                &assistant_line("a1", "m1"),
                &user_line("m2", "a1", "second"),
                &assistant_line("a2", "m2"),
                r#"{"type":"label","id":"l1","parentId":"a2","timestamp":1,"targetId":"m1","label":"start"}"#,
                r#"{"type":"label","id":"l2","parentId":"l1","timestamp":1,"targetId":"m2","label":"draft"}"#,
                r#"{"type":"label","id":"l3","parentId":"l2","timestamp":1,"targetId":"m2"}"#,
                r#"{"type":"custom","id":"g1","parentId":"a1","timestamp":1,"customType":"omp-pulse-goto","data":{"targetId":"m2"}}"#,
            ],
        );
        let m1 = rows.iter().find(|r| r.id == "m1").unwrap();
        let m2 = rows.iter().find(|r| r.id == "m2").unwrap();
        assert_eq!(m1.label.as_deref(), Some("start"));
        assert_eq!(m2.label, None, "a later empty label clears it");
        assert!(
            m1.active && m1.current,
            "the move made m1 the newest turn on the branch"
        );
        assert!(!m2.active, "the rewound turn is off the active branch");
    }

    #[test]
    fn read_tree_fork_children_get_indent_connectors_and_inactive_subtrees() {
        // One fork: m1 branches into m2 (active) and m3. The two children get
        // indent 1; in display order m2 is the first sibling ("branch") and
        // m3 the final one ("last"). m3's own child m4 — under the
        // NON-active child — is active:false, as is m3 itself.
        let (_, rows) = tree_fixture(
            "tree-fork",
            &[
                &header_line("h0"),
                &user_line("m1", "h0", "root"),
                &assistant_line("a1", "m1"),
                &user_line("m2", "a1", "fork one"),
                &assistant_line("a2", "m2"),
                &user_line("m3", "a1", "fork two"),
                &assistant_line("a3", "m3"),
                &user_line("m4", "a3", "under inactive"),
                &assistant_line("a4", "m4"),
                &user_line("m5", "a2", "active tail"), // last entry
            ],
        );
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        // Display order: active subtree (m2, then m5) before the inactive m3.
        assert_eq!(ids, ["m1", "m2", "m5", "m3", "m4"]);
        assert_eq!(rows[0].indent, 0);
        assert_eq!(rows[0].connector, None);
        assert_eq!((rows[1].indent, rows[1].connector), (1, Some("branch")));
        assert_eq!((rows[3].indent, rows[3].connector), (1, Some("last")));
        // The linear continuation under a fork child keeps the fork's level.
        assert_eq!((rows[2].indent, rows[2].connector), (1, None));
        assert_eq!((rows[4].indent, rows[4].connector), (1, None));
        assert!(rows[0].active && rows[1].active && rows[2].active);
        assert!(
            !rows[3].active && !rows[4].active,
            "rows under the non-active child stay inactive"
        );
        assert!(rows[2].current, "the newest active turn is current");
    }

    #[test]
    fn read_tree_active_subtree_sorts_before_its_sibling() {
        // The ACTIVE child is the SECOND fork child in file order; display
        // order must still put its whole subtree first (activity, not file
        // order, decides sibling order).
        let (_, rows) = tree_fixture(
            "tree-order",
            &[
                &header_line("h0"),
                &user_line("m1", "h0", "root"),
                &assistant_line("a1", "m1"),
                &user_line("m2", "a1", "inactive first"),
                &assistant_line("a2", "m2"),
                &user_line("m3", "a1", "active second"),
                &assistant_line("a3", "m3"),
                &user_line("m4", "a3", "active leaf"), // last entry
            ],
        );
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["m1", "m3", "m4", "m2"]);
        assert_eq!(rows[1].connector, Some("branch"));
        assert_eq!(rows[3].connector, Some("last"));
        // m4 is a linear continuation of m3: same indent, no connector, and a
        // │ at m3's connector column (m3 still has m2 pending below).
        assert_eq!((rows[2].indent, rows[2].connector), (1, None));
        assert_eq!(rows[2].gutters, vec![0]);
        assert!(rows[1].active && rows[2].active && !rows[3].active);
        assert!(rows[2].current);
    }

    #[test]
    fn read_tree_gutters_follow_pending_later_siblings() {
        // m2's children m3/m4 sit above a LATER sibling (m5 is displayed
        // after m2's subtree), so both carry a │ at m2's connector column
        // (level 0). m5's own linear child m9 sits under the LAST displayed
        // sibling: the line terminates at m5's └─, so m9 has NO gutter.
        let (_, rows) = tree_fixture(
            "tree-gutters",
            &[
                &header_line("h0"),
                &user_line("m1", "h0", "root"),
                &assistant_line("a1", "m1"),
                &user_line("m2", "a1", "fork head"),
                &assistant_line("a2", "m2"),
                &user_line("m3", "a2", "fork one"),
                &assistant_line("a3", "m3"),
                &user_line("m4", "a2", "fork two"),
                &assistant_line("a4", "m4"),
                &user_line("m5", "a1", "last sibling"),
                &assistant_line("a5", "m5"),
                &user_line("m9", "a5", "under last"),
                &assistant_line("a9", "m9"),
                &user_line("m6", "a1", "active head"),
                &assistant_line("a6", "m6"),
                &user_line("m8", "a6", "active leaf"), // last entry
            ],
        );
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        // Active subtree (m6, m8) first, then m2's fork, then m5's chain.
        assert_eq!(ids, ["m1", "m6", "m8", "m2", "m3", "m4", "m5", "m9"]);
        let gutters: Vec<Vec<usize>> = rows.iter().map(|r| r.gutters.clone()).collect();
        assert_eq!(
            gutters,
            vec![
                vec![],
                vec![],
                vec![0],
                vec![],
                vec![0],
                vec![0],
                vec![],
                vec![]
            ]
        );
        // Connectors: m6 and m2 are "branch" (later siblings pending), m5 is
        // the final displayed sibling; the linear children have none.
        assert_eq!(rows[1].connector, Some("branch"));
        assert_eq!(rows[3].connector, Some("branch"));
        assert_eq!(rows[6].connector, Some("last"));
        assert_eq!(rows[2].connector, None);
        assert_eq!(rows[7].connector, None);
        assert_eq!(
            (rows[2].indent, rows[7].indent),
            (1, 1),
            "linear chains retain their head's level"
        );
        assert_eq!(
            (rows[4].indent, rows[5].indent),
            (2, 2),
            "fork children gain one level"
        );
        assert!(rows[0].active && rows[1].active && rows[2].active);
        assert!(!rows[3].active && !rows[6].active && !rows[7].active);
        assert!(rows[2].current);
    }

    #[test]
    fn read_tree_collab_prompt_counts_and_whitespace_only_does_not() {
        // A collab-prompt custom entry is a row; a user message whose text is
        // whitespace-only is NOT a turn at all — it is skipped as a row AND
        // as a parent target, so the later turn attaches to the collab entry.
        let (_, rows) = tree_fixture(
            "tree-shapes",
            &[
                &header_line("h0"),
                &user_line("m1", "h0", "Hello"),
                &collab_line("cm1", "m1", "Fork here"),
                &user_line("m2", "cm1", "   "), // whitespace-only (no newline: it would tear the JSON line)
                &user_line("m3", "m2", "Real"),
                &assistant_line("a3", "m3"), // last entry
            ],
        );
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["m1", "cm1", "m3"]);
        // The whitespace-only m2 was skipped, so m3's nearest user ancestor
        // is cm1 — the chain stays linear (indent 0, no connector).
        for r in &rows {
            assert_eq!(r.indent, 0);
            assert_eq!(r.connector, None);
            assert!(r.active);
        }
        assert_eq!(rows[1].text, "Fork here");
        assert!(rows[2].current);
    }

    #[test]
    fn read_tree_nearest_user_ancestor_across_assistant_gap() {
        // m2's parent chain runs through TWO assistant entries and a tool
        // entry before reaching m1; the nearest user ancestor walk must not
        // stop at the first non-user entry (which would make m2 a root).
        let (_, rows) = tree_fixture(
            "tree-gap",
            &[
                &header_line("h0"),
                &user_line("m1", "h0", "first"),
                &assistant_line("a1", "m1"),
                &tool_line("t1", "a1"),
                &assistant_line("a2", "t1"),
                &user_line("m2", "a2", "second"),
                &assistant_line("a3", "m2"), // last entry
            ],
        );
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["m1", "m2"]);
        assert_eq!(rows[1].indent, 0, "m2 attaches to m1, not the virtual root");
        assert_eq!(rows[1].connector, None);
        assert!(rows[0].active && rows[1].active);
        assert!(rows[1].current);
    }

    #[test]
    fn read_tree_skips_unparseable_lines() {
        // Garbage lines never break the parse. The turn whose parentId points
        // at an entry whose line was unparseable loses that ancestor (the id
        // is absent from the chain map) and degrades to a ROOT — so this
        // fixture also exercises the multiple-roots shape: both roots get
        // indent 1 and connectors, active (m2) displayed first.
        let (_, rows) = tree_fixture(
            "tree-garbage",
            &[
                "this is not json",
                &header_line("h0"),
                &user_line("m1", "h0", "first"),
                &user_line("m2", "a1", "orphaned"), // parent a1's only line is the torn one below
                "{\"type\":\"message\",\"id\":\"a1\"", // torn line: unparseable, so a1 never exists
            ],
        );
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["m2", "m1"], "active root displays first");
        assert_eq!(rows[0].indent, 1);
        assert_eq!(rows[1].indent, 1);
        assert_eq!(rows[0].connector, Some("branch"));
        assert_eq!(rows[1].connector, Some("last"));
        assert!(rows[0].active && !rows[1].active);
        assert!(rows[0].current);
    }

    #[test]
    fn read_tree_multiple_roots_get_indent_and_connectors() {
        // Two genuine roots (a fork at the session root): both get indent 1
        // and a connector, exactly like any other fork's children.
        let (_, rows) = tree_fixture(
            "tree-multiroot",
            &[
                &header_line("h0"),
                &user_line("m1", "h0", "first root"),
                &assistant_line("a1", "m1"),
                &user_line("m2", "h0", "second root"),
                &assistant_line("a2", "m2"), // last entry
            ],
        );
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["m2", "m1"]);
        assert_eq!((rows[0].indent, rows[0].connector), (1, Some("branch")));
        assert_eq!((rows[1].indent, rows[1].connector), (1, Some("last")));
        assert!(rows[0].active && !rows[1].active);
        assert!(rows[0].current);
    }

    #[test]
    fn read_tree_missing_file_is_empty() {
        let missing = std::env::temp_dir().join(format!(
            "omp-pulse-jsonl-{}-tree-missing.jsonl",
            std::process::id()
        ));
        assert!(read_tree(&missing).is_empty());
    }
}
