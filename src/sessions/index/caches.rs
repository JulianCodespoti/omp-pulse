//! Per-file memo caches for the listing's derived fields (snippet, metadata,
//! activity, model, usage), keyed by one stat per row.

use super::*;
use memo::FileMemo;

use crate::sessions::jsonl;
use std::collections::HashMap;
use std::path::Path as FsPath;
use std::sync::Mutex;
#[cfg(test)]
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Session path → (precise modification time, file length, cached snippet).
type SnippetCache = FileMemo<Option<jsonl::Snippet>>;

/// Snippet cache, memoized by precise mtime and length. Rounding mtime to
/// wire milliseconds misses same-size rewrites within one millisecond. Length
/// still detects size changes when the filesystem timestamp is unchanged.
/// An unavailable mtime is None; metadata-only keys cannot detect every edit.
/// Each file memo independently caps retained owned path/value bytes and count;
/// eviction is FIFO and oversized values are returned without retention.
static SNIPPET_CACHE: std::sync::LazyLock<Mutex<SnippetCache>> =
    std::sync::LazyLock::new(|| Mutex::new(FileMemo::new()));

/// A session file's memo key: precise mtime (None when unavailable) and length.
type Stamp = (Option<std::time::SystemTime>, u64);

/// The one `stat` a listing step needs per session. The snippet, metadata and
/// model memos used to stat the same file each, three times per row per
/// serialized listing, and every stat is a syscall proot intercepts (~0.5 ms
/// each in a phone's proot guest, 2026-10-14). Callers that consult several memos for
/// one row stamp once and pass it to the `*_at` readers.
pub(super) fn stamp(path: &str) -> Option<Stamp> {
    std::fs::metadata(path)
        .ok()
        .map(|meta| (meta.modified().ok(), meta.len()))
}

/// The memoized value for `path` at `stamp`, reading it on a miss.
fn memoized<V: Clone + memo::RetainedBytes>(
    path: &str,
    (mtime, size): Stamp,
    memo: &Mutex<FileMemo<V>>,
    read: impl FnOnce() -> V,
) -> V {
    {
        let cache = memo.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((cached_mtime, cached_size, value)) = cache.get(path)
            && *cached_mtime == mtime
            && *cached_size == size
        {
            return value.clone();
        }
    }
    let value = read();
    let mut cache = memo.lock().unwrap_or_else(|p| p.into_inner());
    cache.insert(path.to_string(), (mtime, size, value.clone()));
    value
}

pub(super) fn snippet_for(path: &str) -> Option<jsonl::Snippet> {
    snippet_at(path, stamp(path))
}

pub(super) fn snippet_at(path: &str, stamp: Option<Stamp>) -> Option<jsonl::Snippet> {
    memoized(path, stamp?, &SNIPPET_CACHE, || {
        jsonl::last_snippet(FsPath::new(path))
    })
}

#[cfg(test)]
fn snippet_for_with_cache(path: &str, memo: &Mutex<SnippetCache>) -> Option<jsonl::Snippet> {
    memoized(path, stamp(path)?, memo, || {
        jsonl::last_snippet(FsPath::new(path))
    })
}

type MetadataCache = FileMemo<jsonl::SessionMetadata>;
static METADATA_CACHE: std::sync::LazyLock<Mutex<MetadataCache>> =
    std::sync::LazyLock::new(|| Mutex::new(FileMemo::new()));

#[cfg(test)]
fn metadata_for(path: &str) -> jsonl::SessionMetadata {
    metadata_at(path, stamp(path))
}

pub(super) fn metadata_at(path: &str, stamp: Option<Stamp>) -> jsonl::SessionMetadata {
    let Some(stamp) = stamp else {
        return jsonl::SessionMetadata::default();
    };
    memoized(path, stamp, &METADATA_CACHE, || {
        jsonl::session_metadata(FsPath::new(path))
    })
}

#[cfg(test)]
fn metadata_for_with_cache(path: &str, memo: &Mutex<MetadataCache>) -> jsonl::SessionMetadata {
    let Some(stamp) = stamp(path) else {
        return jsonl::SessionMetadata::default();
    };
    memoized(path, stamp, memo, || {
        jsonl::session_metadata(FsPath::new(path))
    })
}
type ActivityCache = HashMap<String, (bool, u64)>;
static ACTIVITY_CACHE: std::sync::LazyLock<Mutex<ActivityCache>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn daemon_activity_observation(path: &str, running: bool) -> u64 {
    let mut cache = ACTIVITY_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((previous, observed_at)) = cache.get(path)
        && *previous == running
    {
        return *observed_at;
    }
    let observed_at = now_epoch_ms();
    cache.insert(path.to_string(), (running, observed_at));
    observed_at
}

type ModelCache = FileMemo<Option<String>>;
static MODEL_CACHE: std::sync::LazyLock<Mutex<ModelCache>> =
    std::sync::LazyLock::new(|| Mutex::new(FileMemo::new()));

#[cfg(test)]
fn model_for(path: &str) -> Option<String> {
    model_at(path, stamp(path))
}

pub(super) fn model_at(path: &str, stamp: Option<Stamp>) -> Option<String> {
    memoized(path, stamp?, &MODEL_CACHE, || {
        jsonl::last_model(FsPath::new(path))
    })
}

#[cfg(test)]
fn model_for_with_cache(path: &str, memo: &Mutex<ModelCache>) -> Option<String> {
    memoized(path, stamp(path)?, memo, || {
        jsonl::last_model(FsPath::new(path))
    })
}

/// Whole-file usage tallies, stamped by (mtime, length) like the memos above
/// but RESUMED rather than recomputed when the stamp moves: an appended turn
/// costs only its own bytes (see `jsonl::usage`).
type UsageCache = FileMemo<jsonl::usage::UsageTally>;
static USAGE_CACHE: std::sync::LazyLock<Mutex<UsageCache>> =
    std::sync::LazyLock::new(|| Mutex::new(FileMemo::new()));

/// Bytes of session files one serialized listing may fold. Steady state reads
/// only appends; this bounds the cold path (first listing after start, or a
/// page of never-seen sessions tens of megabytes each) so it cannot stall a
/// listing. Rows left unfinished omit their usage fields and finish on a
/// later refresh, which the changed payload then announces.
pub(super) const USAGE_FOLD_BUDGET: u64 = 16 * 1024 * 1024;

pub(super) fn usage_at(
    path: &str,
    stamp: Option<Stamp>,
    budget: &mut u64,
) -> Option<jsonl::usage::UsageTally> {
    usage_at_with_cache(path, stamp?, &USAGE_CACHE, budget)
}

/// The complete tally for `path` at `stamp`, or None while it is unreadable
/// or still being folded.
fn usage_at_with_cache(
    path: &str,
    (mtime, size): Stamp,
    memo: &Mutex<UsageCache>,
    budget: &mut u64,
) -> Option<jsonl::usage::UsageTally> {
    let prior = {
        let cache = memo.lock().unwrap_or_else(|p| p.into_inner());
        match cache.get(path) {
            Some((cached_mtime, cached_size, tally))
                if *cached_mtime == mtime && *cached_size == size && tally.caught_up =>
            {
                return Some(tally.clone());
            }
            Some((_, _, tally)) => tally.clone(),
            None => jsonl::usage::UsageTally::default(),
        }
    };
    let tally = jsonl::usage::fold_usage(FsPath::new(path), &prior, size, budget)?;
    let mut cache = memo.lock().unwrap_or_else(|p| p.into_inner());
    cache.insert(path.to_string(), (mtime, size, tally.clone()));
    tally.caught_up.then_some(tally)
}

pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}
pub(super) fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
