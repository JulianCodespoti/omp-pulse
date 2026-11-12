//! Bound session memo retention independently of scan completeness or roots.
use crate::sessions::jsonl;
use std::collections::{HashMap, VecDeque};
use std::time::SystemTime;

const MAX_MEMO_ENTRIES: usize = 4096;
const MAX_MEMO_BYTES: usize = 4 * 1024 * 1024;

type FileValue<V> = (Option<SystemTime>, u64, V);

pub(super) trait RetainedBytes {
    fn retained_bytes(&self) -> usize;
}

impl RetainedBytes for Option<String> {
    fn retained_bytes(&self) -> usize {
        self.as_ref().map_or(0, String::capacity)
    }
}

impl RetainedBytes for Option<jsonl::Snippet> {
    fn retained_bytes(&self) -> usize {
        self.as_ref().map_or(0, |value| {
            value.role.capacity().saturating_add(value.text.capacity())
        })
    }
}

impl RetainedBytes for jsonl::SessionMetadata {
    fn retained_bytes(&self) -> usize {
        self.latest_entry_id
            .retained_bytes()
            .saturating_add(self.last_turn_outcome.retained_bytes())
    }
}

impl RetainedBytes for jsonl::usage::UsageTally {
    fn retained_bytes(&self) -> usize {
        let configuration = &self.configuration;
        self.last_assistant_id
            .retained_bytes()
            .saturating_add(configuration.thinking_level.retained_bytes())
            .saturating_add(configuration.configured_thinking_level.retained_bytes())
            .saturating_add(configuration.thinking_entry_id.retained_bytes())
            .saturating_add(self.metadata_retained_bytes())
            .saturating_add(configuration.model_fallback.as_ref().map_or(0, |fallback| {
                fallback
                    .from
                    .capacity()
                    .saturating_add(fallback.to.capacity())
                    .saturating_add(fallback.role.capacity())
                    .saturating_add(fallback.reason.retained_bytes())
                    .saturating_add(fallback.entry_id.retained_bytes())
            }))
    }
}

struct MemoEntry<V> {
    value: FileValue<V>,
    /// Both owned path strings: one map key, one queue key.
    key_bytes: usize,
    bytes: usize,
}

/// FIFO by first insertion, bounded by count AND owned dynamic bytes. Values
/// returned by the readers are unchanged when admission is denied. The byte
/// limit excludes inline entries, container backing allocations, allocator
/// overhead and temporary reader/clone allocations; it is not an RSS limit.
/// The entry cap also bounds map/queue bookkeeping, with no stale queue keys.
pub(super) struct FileMemo<V> {
    entries: HashMap<String, MemoEntry<V>>,
    order: VecDeque<String>,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
}

impl<V: RetainedBytes> FileMemo<V> {
    pub(super) fn new() -> Self {
        Self::with_limits(MAX_MEMO_ENTRIES, MAX_MEMO_BYTES)
    }

    pub(super) fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_entries,
            max_bytes,
        }
    }

    pub(super) fn get(&self, path: &str) -> Option<&FileValue<V>> {
        self.entries.get(path).map(|entry| &entry.value)
    }

    pub(super) fn insert(&mut self, path: String, value: FileValue<V>) {
        let value_bytes = value.2.retained_bytes();
        if let Some(entry) = self.entries.get_mut(&path) {
            let bytes = entry.key_bytes.saturating_add(value_bytes);
            if bytes > self.max_bytes || self.max_entries == 0 {
                // Keeping the previous value would retain obsolete data; a
                // later admissible read can insert this path afresh.
                self.remove(&path);
                return;
            }
            self.bytes = self.bytes.saturating_sub(entry.bytes).saturating_add(bytes);
            entry.value = value;
            entry.bytes = bytes;
            // Replacements keep the original FIFO position, just like the
            // listing-query cache. Hits do not move entries either.
        } else {
            let queue_path = path.clone();
            let key_bytes = path.capacity().saturating_add(queue_path.capacity());
            let bytes = key_bytes.saturating_add(value_bytes);
            if bytes > self.max_bytes || self.max_entries == 0 {
                return;
            }
            self.entries.insert(
                path,
                MemoEntry {
                    value,
                    key_bytes,
                    bytes,
                },
            );
            self.order.push_back(queue_path);
            self.bytes = self.bytes.saturating_add(bytes);
        }
        // Every insertion, including a reader that completed after another
        // root's scan, applies the same policy under its existing mutex.
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            let Some(path) = self.order.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&path) {
                self.bytes = self.bytes.saturating_sub(entry.bytes);
            }
        }
    }

    fn remove(&mut self, path: &str) {
        if let Some(entry) = self.entries.remove(path) {
            self.bytes = self.bytes.saturating_sub(entry.bytes);
            if let Some(position) = self.order.iter().position(|key| key == path) {
                self.order.remove(position);
            }
        }
    }
}

#[cfg(test)]
mod tests;
