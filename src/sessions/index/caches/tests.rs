use super::*;
use crate::sessions::index::tests::scratch_session;

#[test]
fn memoized_reads_once_per_stamp() {
    let memo: Mutex<FileMemo<Option<String>>> = Mutex::new(FileMemo::new());
    let at = std::time::SystemTime::UNIX_EPOCH;
    let mut reads = 0;
    for _ in 0..3 {
        let value = memoized("/s/a.jsonl", (Some(at), 10), &memo, || {
            reads += 1;
            Some("model".to_string())
        });
        assert_eq!(value.as_deref(), Some("model"));
    }
    assert_eq!(reads, 1);
    // A new length is a new stamp: read again.
    let value = memoized("/s/a.jsonl", (Some(at), 11), &memo, || {
        reads += 1;
        None
    });
    assert_eq!(value, None);
    assert_eq!(reads, 2);
}

#[test]
fn usage_memo_resumes_appends_and_withholds_unfinished_folds() {
    let line = "{\"type\":\"message\",\"id\":\"a\",\"message\":{\"role\":\"assistant\",\"usage\":{\"cost\":{\"total\":0.5}}}}\n";
    let path = scratch_session("usage-memo", &line.repeat(2));
    let path = path.to_str().unwrap();
    let memo = Mutex::new(FileMemo::new());
    // Budget for one line: the fold is unfinished, so the row says nothing.
    let mut budget = line.len() as u64;
    assert!(usage_at_with_cache(path, stamp(path).unwrap(), &memo, &mut budget).is_none());
    let mut budget = u64::MAX;
    let done = usage_at_with_cache(path, stamp(path).unwrap(), &memo, &mut budget).unwrap();
    assert_eq!(done.cost_total, 1.0);
    // An unchanged stamp is a pure memo hit: no budget spent.
    let mut budget = 0;
    assert_eq!(
        usage_at_with_cache(path, stamp(path).unwrap(), &memo, &mut budget)
            .unwrap()
            .cost_total,
        1.0
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()))
        .unwrap();
    // One line plus the EOF probe: resuming reads only the append.
    let mut budget = line.len() as u64 + 1;
    let grown = usage_at_with_cache(path, stamp(path).unwrap(), &memo, &mut budget).unwrap();
    assert_eq!(grown.cost_total, 1.5);
}

mod resilience;
mod retention;
