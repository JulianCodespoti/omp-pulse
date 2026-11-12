//! Process-lifetime diagnostic counters and timings for the live-sync paths.
//!
//! These are monotonic, in-memory, process-wide numbers: they reset on daemon
//! restart and exist so `omp_pulse doctor` and `GET /api/status` can say which
//! delivery path handled recent prompts and how long adoption/attach/child
//! boot took. They are for diagnosis, not billing — nothing here is durable.
//!
//! Lock poisoning is handled the crate's usual way (recover the inner guard
//! and continue): recording a metric is best-effort and must never panic.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// One observed timing: call count, accumulated milliseconds, and the single
/// largest observation (`total_ms / count` is the average).
#[derive(Default)]
struct Timing {
    count: u64,
    total_ms: u64,
    max_ms: u64,
}

static COUNTERS: LazyLock<Mutex<HashMap<&'static str, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static TIMINGS: LazyLock<Mutex<HashMap<&'static str, Timing>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Record one occurrence of a named event (e.g. `prompt_via_host`).
pub fn inc(counter: &'static str) {
    let mut guard = match COUNTERS.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    *guard.entry(counter).or_insert(0) += 1;
}

/// Record a named observation of `ms` (e.g. `adopt_ms`), keeping the call
/// count, running total and maximum. The caller measures the elapsed time.
pub fn observe_ms(name: &'static str, ms: u64) {
    let mut guard = match TIMINGS.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let t = guard.entry(name).or_default();
    t.count += 1;
    t.total_ms += ms;
    t.max_ms = t.max_ms.max(ms);
}

/// Current snapshot as
/// `{ "counters": {name: n}, "timings": {name: {"count":n,"total_ms":n,"max_ms":n}} }`.
/// Only names that have been recorded appear.
pub fn snapshot() -> serde_json::Value {
    let counters: serde_json::Map<String, serde_json::Value> = {
        let guard = match COUNTERS.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard
            .iter()
            .map(|(k, v)| ((*k).to_string(), serde_json::json!(v)))
            .collect()
    };
    let timings: serde_json::Map<String, serde_json::Value> = {
        let guard = match TIMINGS.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard
            .iter()
            .map(|(k, t)| {
                (
                    (*k).to_string(),
                    serde_json::json!({
                        "count": t.count,
                        "total_ms": t.total_ms,
                        "max_ms": t.max_ms,
                    }),
                )
            })
            .collect()
    };
    serde_json::json!({ "counters": counters, "timings": timings })
}
