use super::*;
use serde_json::{Value, json};
use std::fs::{File, FileTimes, OpenOptions};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::broadcast::{Receiver, error::TryRecvError};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    dir: PathBuf,
    path: PathBuf,
    generation: u64,
}

impl Fixture {
    fn new(tag: &str, bytes: &[u8]) -> Self {
        let serial = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-attachment-{}-{serial}-{tag}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("synthetic.jsonl");
        std::fs::write(&path, bytes).unwrap();
        let mut fixture = Self {
            dir,
            path,
            generation: 0,
        };
        fixture.stamp();
        fixture
    }

    fn stamp(&mut self) {
        self.generation += 1;
        let when = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000 + self.generation);
        File::options()
            .write(true)
            .open(&self.path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(when))
            .unwrap();
    }

    fn append(&mut self, bytes: &[u8]) {
        assert!(
            std::fs::metadata(&self.path).unwrap().len() + bytes.len() as u64
                <= MAX_TAIL_CATCHUP + 32
        );
        OpenOptions::new()
            .append(true)
            .open(&self.path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
        self.stamp();
    }

    fn name(&self) -> &str {
        self.path.to_str().unwrap()
    }

    fn watch(&self, audience: Audience) -> (Arc<Watcher>, Receiver<WatchEvent>) {
        let (tx, rx) = broadcast::channel(16);
        let watcher = Watcher::new(test_config(), tx, audience);
        watcher.watch(self.name());
        (watcher, rx)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).unwrap();
    }
}

fn events(rx: &mut Receiver<WatchEvent>) -> Vec<WatchEvent> {
    let mut result = Vec::new();
    loop {
        match rx.try_recv() {
            Ok(event) => result.push(event),
            Err(TryRecvError::Empty) => return result,
            other => panic!("unexpected broadcast outcome: {other:?}"),
        }
    }
}

fn entries(output: &[WatchEvent]) -> Vec<Value> {
    output
        .iter()
        .flat_map(|event| match event {
            WatchEvent::Entries { entries, .. } => entries.clone(),
            other => panic!("expected only Entries, got {other:?}"),
        })
        .collect()
}

#[test]
fn initial_attachment_completes_every_json_and_utf8_split_once() {
    let base = b"{\"i\":0}\n";
    let line = "{\"i\":1,\"text\":\"a€🦀z\"}\n".as_bytes();
    for split in 1..line.len() {
        let mut file = Fixture::new("splits", &[base.as_slice(), &line[..split]].concat());
        let (watcher, mut rx) = file.watch(always_watch());
        assert_eq!(
            watcher.offset_for(file.name()),
            Some(base.len() as u64),
            "split {split}"
        );
        assert!(
            events(&mut rx).is_empty(),
            "attachment itself emits nothing"
        );
        file.append(&[&line[split..], b"{\"i\":2}\n"].concat());
        watcher.drain(file.name());
        assert_eq!(
            entries(&events(&mut rx)),
            vec![json!({"i":1,"text":"a€🦀z"}), json!({"i":2})],
            "split {split}"
        );
        watcher.drain(file.name());
        assert!(events(&mut rx).is_empty(), "split {split} must not replay");
    }
}

#[test]
fn valid_unterminated_json_already_in_history_is_emitted_once_on_newline() {
    let line =
        br#"{"type":"message","id":"stable-entry","message":{"role":"user","content":"hello"}}"#;
    let mut file = Fixture::new(
        "valid-no-newline",
        &[b"{\"i\":0}\n".as_slice(), line].concat(),
    );
    let history = jsonl::read_backward(&file.path, None, 200);
    assert_eq!(history.entries.last().unwrap()["id"], "stable-entry");
    let (watcher, mut rx) = file.watch(always_watch());
    file.append(b"\n");
    watcher.drain(file.name());
    assert_eq!(entries(&events(&mut rx)), vec![history.entries[1].clone()]);
    watcher.drain(file.name());
    assert!(events(&mut rx).is_empty());
}

#[test]
fn rewatch_preserves_an_in_progress_line() {
    let mut file = Fixture::new("rewatch", b"{\"i\":0}\n");
    let (watcher, mut rx) = file.watch(always_watch());
    file.append(b"{\"i\":");
    watcher.drain(file.name());
    assert!(matches!(
        events(&mut rx).as_slice(),
        [WatchEvent::Partial { offset: 8, .. }]
    ));
    watcher.watch(file.name());
    file.append(b"1}\n");
    watcher.drain(file.name());
    assert_eq!(entries(&events(&mut rx)), vec![json!({"i":1})]);
    file.append(b"{\"i\":3}\n");
    watcher.drain(file.name());
    assert_eq!(entries(&events(&mut rx)), vec![json!({"i":3})]);
}

#[test]
fn hidden_incomplete_record_arrives_after_visible_recovery() {
    let mut file = Fixture::new("hidden-partial", b"{\"i\":0}\n");
    let visible = Arc::new(AtomicBool::new(true));
    let audience = Arc::clone(&visible);
    let (watcher, mut rx) = file.watch(Arc::new(move |_| audience.load(Ordering::SeqCst)));

    visible.store(false, Ordering::SeqCst);
    file.append(b"{\"i\":");
    watcher.drain(file.name());
    assert!(events(&mut rx).is_empty());
    assert_eq!(
        jsonl::read_backward(&file.path, None, 200).entries,
        vec![json!({"i":0})]
    );

    visible.store(true, Ordering::SeqCst);
    file.append(b"1}\n");
    watcher.drain(file.name());
    assert_eq!(entries(&events(&mut rx)), vec![json!({"i":1})]);
}

#[test]
fn oversized_hidden_record_requests_history_when_it_completes() {
    let mut file = Fixture::new("hidden-large-partial", b"{\"i\":0}\n");
    let visible = Arc::new(AtomicBool::new(true));
    let audience = Arc::clone(&visible);
    let (watcher, mut rx) = file.watch(Arc::new(move |_| audience.load(Ordering::SeqCst)));
    let prefix = format!(
        "{{\"i\":1,\"pad\":\"{}",
        "x".repeat(MAX_TAIL_CATCHUP as usize + 1)
    );
    let split = prefix.len() / 2;

    visible.store(false, Ordering::SeqCst);
    for part in [&prefix.as_bytes()[..split], &prefix.as_bytes()[split..]] {
        file.append(part);
        watcher.drain(file.name());
    }
    assert!(events(&mut rx).is_empty());
    assert_eq!(jsonl::read_backward(&file.path, None, 200).entries.len(), 1);

    visible.store(true, Ordering::SeqCst);
    file.append(b"x");
    watcher.drain(file.name());
    assert!(events(&mut rx).is_empty());
    file.append(b"\"}\n");
    watcher.drain(file.name());
    assert!(matches!(
        events(&mut rx).as_slice(),
        [WatchEvent::Poll { .. }]
    ));
    let history = jsonl::read_backward(&file.path, None, 200);
    assert_eq!(history.entries[1]["i"], 1);
    assert_eq!(
        history.entries[1]["pad"].as_str().unwrap().len(),
        MAX_TAIL_CATCHUP as usize + 2
    );
}

#[test]
fn oversized_record_at_initial_attachment_requests_history_on_completion() {
    let mut prefix = b"{\"i\":0}\n{\"i\":1,\"pad\":\"".to_vec();
    prefix.extend(std::iter::repeat_n(b'x', MAX_TAIL_CATCHUP as usize + 1));
    let mut file = Fixture::new("attached-large-partial", &prefix);
    let (watcher, mut rx) = file.watch(always_watch());
    assert_eq!(jsonl::read_backward(&file.path, None, 200).entries.len(), 1);

    file.append(b"\"}\n");
    watcher.drain(file.name());
    assert!(matches!(
        events(&mut rx).as_slice(),
        [WatchEvent::Poll { .. }]
    ));
    let history = jsonl::read_backward(&file.path, None, 200);
    assert_eq!(history.entries[1]["i"], 1);
    assert_eq!(
        history.entries[1]["pad"].as_str().unwrap().len(),
        MAX_TAIL_CATCHUP as usize + 1
    );
}

#[test]
fn completion_survives_batches_and_malformed_complete_lines() {
    let mut file = Fixture::new("batches", b"{\"i\":0}\n{\"i\":");
    let (watcher, mut rx) = file.watch(always_watch());
    let mut suffix = b"1}\n\nnot-json\n".to_vec();
    for i in 2..=205 {
        suffix.extend_from_slice(format!("{{\"i\":{i}}}\n").as_bytes());
    }
    file.append(&suffix);
    watcher.drain(file.name());
    let output = events(&mut rx);
    assert_eq!(output.len(), 2);
    assert_eq!(
        entries(&output),
        (1..=205).map(|i| json!({"i":i})).collect::<Vec<_>>()
    );
    assert_eq!(
        watcher.offset_for(file.name()),
        Some(std::fs::metadata(&file.path).unwrap().len())
    );
    watcher.drain(file.name());
    assert!(events(&mut rx).is_empty());
}

#[test]
fn no_audience_still_skips_to_eof_without_parsing_or_emitting() {
    let mut file = Fixture::new("no-audience", b"{\"i\":0}\n{\"i\":");
    let (watcher, mut rx) = file.watch(Arc::new(|_| false));
    assert_eq!(watcher.offset_for(file.name()), Some(8));
    file.append(b"1}\n");
    watcher.drain(file.name());
    assert_eq!(watcher.offset_for(file.name()), Some(16));
    assert!(events(&mut rx).is_empty());
}

struct ProbeReader {
    cursor: Cursor<Vec<u8>>,
    read_bytes: usize,
    read_calls: usize,
    max_request: usize,
    max_read: usize,
    fail_read_after: Option<usize>,
    fail_seek: bool,
    interrupt_once: bool,
}

impl ProbeReader {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            cursor: Cursor::new(bytes),
            read_bytes: 0,
            read_calls: 0,
            max_request: 0,
            max_read: usize::MAX,
            fail_read_after: None,
            fail_seek: false,
            interrupt_once: false,
        }
    }

    fn probe(&mut self) -> io::Result<u64> {
        let size = self.cursor.get_ref().len() as u64;
        probe_attachment_offset(self, size)
    }
}

impl Read for ProbeReader {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.read_calls += 1;
        self.max_request = self.max_request.max(bytes.len());
        if std::mem::take(&mut self.interrupt_once) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        if self
            .fail_read_after
            .is_some_and(|after| self.read_bytes >= after)
        {
            return Err(io::ErrorKind::Other.into());
        }
        let take = bytes.len().min(self.max_read);
        let n = self.cursor.read(&mut bytes[..take])?;
        self.read_bytes += n;
        Ok(n)
    }
}

impl Seek for ProbeReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        if self.fail_seek {
            return Err(io::ErrorKind::Other.into());
        }
        self.cursor.seek(from)
    }
}

#[test]
fn complete_eof_stops_in_first_small_chunk_and_empty_reads_nothing() {
    let mut bytes = vec![b'x'; 3 * ATTACH_PROBE_CHUNK];
    *bytes.last_mut().unwrap() = b'\n';
    let mut reader = ProbeReader::new(bytes);
    assert_eq!(reader.probe().unwrap(), (3 * ATTACH_PROBE_CHUNK) as u64);
    assert_eq!(reader.read_bytes, ATTACH_PROBE_CHUNK);
    assert_eq!(reader.read_calls, 1);
    let mut empty = ProbeReader::new(Vec::new());
    assert_eq!(empty.probe().unwrap(), 0);
    assert_eq!(empty.read_calls, 0);
}

#[test]
fn nearest_newline_crosses_chunks_without_reading_older_prefix() {
    let mut bytes = vec![b'x'; 4 * ATTACH_PROBE_CHUNK];
    let last_newline = 2 * ATTACH_PROBE_CHUNK - 1;
    bytes[last_newline] = b'\n';
    bytes[17] = b'\n';
    let mut reader = ProbeReader::new(bytes);
    assert_eq!(reader.probe().unwrap(), last_newline as u64 + 1);
    assert_eq!(reader.read_bytes, 3 * ATTACH_PROBE_CHUNK);
    assert_eq!(reader.max_request, ATTACH_PROBE_CHUNK);
}

#[test]
fn cap_includes_delimiter_and_never_guesses_a_boundary_beyond_it() {
    let cap = MAX_TAIL_CATCHUP as usize;
    for (suffix, expected) in [(cap - 1, 2), (cap, cap + 2), (cap + 1, cap + 3)] {
        let mut bytes = b"x\n".to_vec();
        bytes.resize(bytes.len() + suffix, b'x');
        let mut reader = ProbeReader::new(bytes);
        assert_eq!(reader.probe().unwrap(), expected as u64, "suffix {suffix}");
        assert_eq!(reader.read_bytes, cap);
        assert!(reader.max_request <= ATTACH_PROBE_CHUNK);
    }
    for (length, expected) in [(cap, 0), (cap + 1, cap + 1)] {
        let mut reader = ProbeReader::new(vec![b'x'; length]);
        assert_eq!(reader.probe().unwrap(), expected as u64);
        assert_eq!(reader.read_bytes, cap);
    }
}

#[test]
fn short_and_interrupted_reads_complete_but_other_errors_are_not_boundaries() {
    let mut reader = ProbeReader::new(b"a\npartial".to_vec());
    reader.max_read = 2;
    reader.interrupt_once = true;
    assert_eq!(reader.probe().unwrap(), 2);
    assert_eq!(reader.read_bytes, 9);
    let mut reader = ProbeReader::new(vec![b'x'; ATTACH_PROBE_CHUNK + 1]);
    reader.fail_read_after = Some(ATTACH_PROBE_CHUNK);
    let size = reader.cursor.get_ref().len() as u64;
    assert_eq!(reader.probe().unwrap_or(size), size);
    assert_eq!(reader.read_bytes, ATTACH_PROBE_CHUNK);
    let mut reader = ProbeReader::new(b"a\npartial".to_vec());
    reader.fail_seek = true;
    assert_eq!(reader.probe().unwrap_or(9), 9);
    assert_eq!(reader.read_bytes, 0);
    let mut shrunk = Cursor::new(b"short".to_vec());
    assert_eq!(probe_attachment_offset(&mut shrunk, 10).unwrap_or(10), 10);
}

#[test]
fn missing_unreadable_or_truncated_file_falls_back_to_sampled_eof() {
    let file = Fixture::new("errors", b"longer-now");
    let metadata = std::fs::metadata(&file.path).unwrap();
    std::fs::write(&file.path, b"short").unwrap();
    assert_eq!(attachment_offset(&file.path, &metadata).0, 10);
    assert_eq!(
        attachment_offset(&file.dir.join("missing.jsonl"), &metadata).0,
        10
    );
}

#[test]
fn empty_and_known_nonregular_targets_keep_the_sampled_baseline() {
    let file = Fixture::new("admission", b"");
    let empty = std::fs::metadata(&file.path).unwrap();
    assert_eq!(attachment_offset(&file.path, &empty).0, 0);
    let directory = std::fs::metadata(&file.dir).unwrap();
    assert!(!directory.is_file());
    assert_eq!(attachment_offset(&file.dir, &directory).0, directory.len());
    let (watcher, _) = file.watch(always_watch());
    watcher.watch(file.dir.to_str().unwrap());
    assert_eq!(
        watcher.offset_for(file.dir.to_str().unwrap()),
        Some(directory.len())
    );
}

#[test]
fn whole_file_at_probe_cap_still_respects_catch_up_cap_on_completion() {
    let mut file = Fixture::new("cap-completion", &vec![b'x'; MAX_TAIL_CATCHUP as usize]);
    let (watcher, mut rx) = file.watch(always_watch());
    assert_eq!(watcher.offset_for(file.name()), Some(0));
    file.append(b"\n");
    watcher.drain(file.name());
    assert!(matches!(
        events(&mut rx).as_slice(),
        [WatchEvent::Poll { .. }]
    ));
    assert_eq!(watcher.offset_for(file.name()), Some(MAX_TAIL_CATCHUP + 1));
}
