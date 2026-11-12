//! Small deterministic policy tests; no filesystem, process, or network use.
use super::*;
use std::collections::HashSet;

fn value(text: &str) -> FileValue<Option<String>> {
    (None, 1, Some(text.to_string()))
}

fn check<V: RetainedBytes>(cache: &FileMemo<V>) {
    assert!(cache.entries.len() <= cache.max_entries);
    assert!(cache.bytes <= cache.max_bytes);
    assert_eq!(cache.order.len(), cache.entries.len());
    let keys: HashSet<_> = cache.order.iter().collect();
    assert_eq!(keys.len(), cache.order.len());
    let mut total = 0;
    for (key, entry) in &cache.entries {
        let queued = cache.order.iter().find(|queued| *queued == key).unwrap();
        assert_eq!(entry.key_bytes, key.capacity() + queued.capacity());
        assert_eq!(
            entry.bytes,
            entry.key_bytes + entry.value.2.retained_bytes()
        );
        total += entry.bytes;
    }
    assert_eq!(total, cache.bytes);
}

#[test]
fn entry_boundary_is_fifo_and_hits_do_not_promote() {
    let mut cache = FileMemo::with_limits(2, 100);
    cache.insert("a".into(), value("1"));
    cache.insert("b".into(), value("2"));
    assert_eq!(cache.entries.len(), 2);
    assert!(cache.get("a").is_some());
    cache.insert("c".into(), value("3"));
    assert!(cache.get("a").is_none());
    assert!(cache.get("b").is_some());
    assert!(cache.get("c").is_some());
    check(&cache);
}

#[test]
fn exact_byte_boundary_admits_and_one_byte_more_evicts() {
    let mut cache = FileMemo::with_limits(10, 6);
    cache.insert("a".into(), value("1")); // 1 + 1 path bytes + 1 value byte.
    cache.insert("b".into(), value("2"));
    assert_eq!(cache.bytes, 6);
    assert_eq!(cache.entries.len(), 2);
    cache.insert("b".into(), value("22"));
    assert!(cache.get("a").is_none());
    assert_eq!(cache.bytes, 4);
    check(&cache);
}

#[test]
fn replacements_keep_position_and_may_evict_themselves() {
    let mut cache = FileMemo::with_limits(2, 8);
    cache.insert("a".into(), value("1"));
    cache.insert("b".into(), value("2"));
    cache.insert("a".into(), value("11"));
    assert_eq!(
        cache.order.iter().map(String::as_str).collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(cache.bytes, 7);
    cache.insert("a".into(), value("1111")); // 6 itself, 9 total: evict oldest a.
    assert!(cache.get("a").is_none());
    assert!(cache.get("b").is_some());
    assert_eq!(cache.bytes, 3);
    check(&cache);
}

#[test]
fn oversized_replacement_removes_queue_node_and_reinserts_cleanly() {
    let mut cache = FileMemo::with_limits(2, 8);
    cache.insert("a".into(), value("1"));
    cache.insert("b".into(), value("2"));
    for _ in 0..5 {
        cache.insert("a".into(), value("1234567"));
        assert!(cache.get("a").is_none());
        assert_eq!(cache.bytes, 3);
        check(&cache);
        cache.insert("a".into(), value("1"));
        assert_eq!(
            cache.order.iter().map(String::as_str).collect::<Vec<_>>(),
            ["b", "a"]
        );
        check(&cache);
    }
    cache.insert("c".into(), value("3"));
    assert!(cache.get("b").is_none());
    check(&cache);
}

#[test]
fn capacity_not_length_includes_both_path_copies_and_all_value_strings() {
    let mut path = String::with_capacity(40);
    path.push('a');
    let mut text = String::with_capacity(60);
    text.push('x');
    let mut cache = FileMemo::with_limits(2, 1000);
    let text_capacity = text.capacity();
    cache.insert(path, (None, 1, Some(text)));
    check(&cache);
    assert!(cache.bytes >= 40 + 1 + 60);
    let exact = cache.bytes;
    cache.max_bytes = exact;
    cache.insert("a".into(), value("x"));
    assert_eq!(cache.bytes, exact - text_capacity + 1);
    // Metadata and snippet count all their independently allocated strings.
    let mut id = String::with_capacity(32);
    id.push('i');
    let mut outcome = String::with_capacity(24);
    outcome.push('o');
    let metadata_capacity = id.capacity() + outcome.capacity();
    let metadata = jsonl::SessionMetadata {
        latest_entry_id: Some(id),
        last_turn_outcome: Some(outcome),
        ..Default::default()
    };
    assert_eq!(metadata.retained_bytes(), metadata_capacity);
    let mut role = String::with_capacity(16);
    role.push('r');
    let mut text = String::with_capacity(48);
    text.push('t');
    let snippet_capacity = role.capacity() + text.capacity();
    let snippet = Some(jsonl::Snippet {
        role,
        text,
        at: None,
    });
    assert_eq!(snippet.retained_bytes(), snippet_capacity);
    let mut reject = FileMemo::with_limits(2, 10);
    let mut reserved = String::with_capacity(20);
    reserved.push('x');
    reject.insert("a".into(), (None, 1, Some(reserved)));
    assert!(reject.get("a").is_none());
    check(&reject);
}

#[test]
fn no_payload_and_zero_limits_do_not_allow_unbounded_bookkeeping() {
    let mut cache = FileMemo::<Option<String>>::with_limits(2, 4);
    for key in ["a", "b", "c", "d"] {
        cache.insert(key.into(), (None, 0, None));
        check(&cache);
    }
    assert_eq!(cache.entries.len(), 2);
    assert_eq!(cache.bytes, 4);
    for (count, bytes) in [(0, 100), (10, 0)] {
        let mut disabled = FileMemo::with_limits(count, bytes);
        disabled.insert("a".into(), value("1"));
        assert!(disabled.entries.is_empty());
        check(&disabled);
    }
}

#[test]
fn repeated_updates_shrink_grow_and_remove_without_accounting_drift() {
    let mut cache = FileMemo::with_limits(3, 30);
    for round in 0..12 {
        for (key, count) in [("a", round % 8), ("b", 2), ("c", 3), ("d", 4)] {
            cache.insert(key.into(), value(&"x".repeat(count)));
            check(&cache);
        }
    }
    cache.remove("b");
    cache.remove("absent");
    check(&cache);
}

#[test]
fn delayed_insert_from_another_root_obeys_the_same_limits() {
    use std::sync::{Barrier, Mutex};
    let cache = Mutex::new(FileMemo::with_limits(2, 100));
    let ready = Barrier::new(2);
    let resume = Barrier::new(2);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let parsed = value("late");
            ready.wait();
            resume.wait();
            cache.lock().unwrap().insert("root-a/late".into(), parsed);
        });
        ready.wait();
        {
            let mut memo = cache.lock().unwrap();
            memo.insert("root-b/old".into(), value("old"));
            memo.insert("root-b/new".into(), value("new"));
            check(&memo);
        }
        resume.wait();
    });
    let memo = cache.lock().unwrap();
    assert!(memo.get("root-b/old").is_none());
    assert!(memo.get("root-b/new").is_some());
    assert!(memo.get("root-a/late").is_some());
    check(&memo);
}

#[test]
fn overflow_sized_weight_is_rejected_without_large_allocation() {
    struct SyntheticWeight(usize);
    impl RetainedBytes for SyntheticWeight {
        fn retained_bytes(&self) -> usize {
            self.0
        }
    }
    let mut cache = FileMemo::with_limits(2, 100);
    cache.insert("a".into(), (None, 1, SyntheticWeight(1)));
    cache.insert("huge".into(), (None, 1, SyntheticWeight(usize::MAX)));
    assert!(cache.get("huge").is_none());
    assert!(cache.get("a").is_some());
    check(&cache);
    cache.insert("a".into(), (None, 1, SyntheticWeight(usize::MAX)));
    assert!(cache.entries.is_empty());
    check(&cache);
}
