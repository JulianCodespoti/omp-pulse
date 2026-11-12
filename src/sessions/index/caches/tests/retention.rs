//! Synthetic filesystem coverage of the exact readers with small memo budgets.
use super::*;
use std::fs;
use std::path::PathBuf;
use std::sync::Barrier;

struct Fixture(PathBuf);

impl Fixture {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "omp-pulse-bounded-memo-{}-{tag}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    /// `relative` uses `/`; it is joined by component so the key matches the
    /// `\`-separated paths `list_sessions` reports on Windows.
    fn session(&self, relative: &str, contents: &str) -> PathBuf {
        let path = relative
            .split('/')
            .fold(self.0.clone(), |dir, part| dir.join(part));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Memos {
    metadata: Mutex<MetadataCache>,
    snippet: Mutex<SnippetCache>,
    model: Mutex<ModelCache>,
}

impl Memos {
    fn new(count: usize, bytes: usize) -> Self {
        Self {
            metadata: Mutex::new(FileMemo::with_limits(count, bytes)),
            snippet: Mutex::new(FileMemo::with_limits(count, bytes)),
            model: Mutex::new(FileMemo::with_limits(count, bytes)),
        }
    }

    fn read(&self, path: &FsPath) -> (Option<String>, Option<String>, Option<String>) {
        let path = path.to_str().unwrap();
        (
            metadata_for_with_cache(path, &self.metadata).latest_entry_id,
            snippet_for_with_cache(path, &self.snippet).map(|snippet| snippet.text),
            model_for_with_cache(path, &self.model),
        )
    }

    fn contains(&self, path: &FsPath) -> [bool; 3] {
        let path = path.to_str().unwrap();
        [
            self.metadata.lock().unwrap().get(path).is_some(),
            self.snippet.lock().unwrap().get(path).is_some(),
            self.model.lock().unwrap().get(path).is_some(),
        ]
    }

    fn catalogue(&self, root: &FsPath) -> usize {
        let rows = jsonl::list_sessions(root);
        for row in &rows {
            let path = FsPath::new(&row.path);
            assert_eq!(self.read(path), fresh(path));
        }
        rows.len()
    }
}

fn content(id: &str, text: &str, model: &str) -> String {
    format!(
        "{}\n{}\n",
        json!({"type":"session", "id":"synthetic", "cwd":"/synthetic", "title":"Synthetic"}),
        json!({"type":"message", "id":id, "message":{
            "role":"assistant", "timestamp":1000, "content":text, "model":model, "stopReason":"stop"
        }})
    )
}

fn fresh(path: &FsPath) -> (Option<String>, Option<String>, Option<String>) {
    (
        jsonl::session_metadata(path).latest_entry_id,
        jsonl::last_snippet(path).map(|snippet| snippet.text),
        jsonl::last_model(path),
    )
}

#[test]
fn rename_archive_and_delete_churn_remains_count_bounded() {
    let fixture = Fixture::new("churn");
    let root = fixture.0.join("sessions");
    let mut path = fixture.session(
        "sessions/project/a.jsonl",
        &content("entry", "text", "model"),
    );
    let memos = Memos::new(2, 4096);
    let mut names = vec![path.clone()];
    assert_eq!(memos.catalogue(&root), 1);
    for name in ["b.jsonl", "c.jsonl", "d.jsonl"] {
        let next = path.with_file_name(name);
        fs::rename(&path, &next).unwrap();
        path = next;
        names.push(path.clone());
        assert_eq!(memos.catalogue(&root), 1);
        for (index, seen) in names.iter().enumerate() {
            assert_eq!(memos.contains(seen), [index + 2 >= names.len(); 3]);
        }
    }
    fs::rename(root.join("project"), root.join("renamed")).unwrap();
    path = root.join("renamed").join("d.jsonl");
    names.push(path.clone());
    assert_eq!(memos.catalogue(&root), 1);
    for (index, seen) in names.iter().enumerate() {
        assert_eq!(memos.contains(seen), [index + 2 >= names.len(); 3]);
    }
    let archive = root.join("renamed").join("archive").join("d.jsonl");
    fs::create_dir(archive.parent().unwrap()).unwrap();
    fs::rename(&path, &archive).unwrap();
    assert_eq!(memos.catalogue(&root), 0);
    fs::remove_file(archive).unwrap();
    for _ in 0..3 {
        assert_eq!(memos.catalogue(&root), 0);
        assert_eq!(memos.read(&path), (None, None, None));
    }
    // Bounds do not imply immediate reclamation or absence inference.
    for (index, seen) in names.iter().enumerate() {
        assert_eq!(memos.contains(seen), [index + 2 >= names.len(); 3]);
    }
}

#[test]
fn oversized_replacements_return_full_reader_values_without_retaining_old_ones() {
    let fixture = Fixture::new("oversize");
    let path = fixture.session("sessions/p/a.jsonl", &content("old", "small", "m"));
    let memos = Memos::new(2, 2 * path.to_str().unwrap().len() + 32);
    assert_eq!(memos.read(&path), fresh(&path));
    assert_eq!(memos.contains(&path), [true; 3]);
    let id = "i".repeat(256);
    let text = "t".repeat(512);
    let model = "m".repeat(768);
    fs::write(&path, content(&id, &text, &model)).unwrap();
    for _ in 0..2 {
        let result = memos.read(&path);
        assert_eq!(result, fresh(&path));
        assert_eq!(result.0.as_deref(), Some(id.as_str()));
        assert_eq!(result.2.as_deref(), Some(model.as_str()));
        assert_eq!(memos.contains(&path), [false; 3]);
    }
    fs::write(&path, content("new", "short", "n")).unwrap();
    assert_eq!(memos.read(&path), fresh(&path));
    assert_eq!(memos.contains(&path), [true; 3]);
}

#[test]
fn concurrent_roots_and_empty_scans_do_not_claim_unrelated_entries_are_absent() {
    let fixture = Fixture::new("roots");
    let a = fixture.session("root-a/project/same.jsonl", &content("a", "text", "ma"));
    let b = fixture.session("root-b/project/same.jsonl", &content("b", "text", "mb"));
    let memos = Memos::new(4, 4096);
    let ready = Barrier::new(2);
    std::thread::scope(|scope| {
        for name in ["root-a", "root-b"] {
            let root = fixture.0.join(name);
            let memos = &memos;
            let ready = &ready;
            scope.spawn(move || {
                ready.wait();
                assert_eq!(memos.catalogue(&root), 1);
            });
        }
    });
    assert_eq!(memos.contains(&a), [true; 3]);
    assert_eq!(memos.contains(&b), [true; 3]);
    fs::remove_file(&a).unwrap();
    assert_eq!(memos.catalogue(&fixture.0.join("root-a")), 0);
    assert_eq!(memos.catalogue(&fixture.0.join("nonexistent")), 0);
    assert_eq!(memos.read(&b), fresh(&b));
    assert_eq!(memos.contains(&b), [true; 3]);
    assert_eq!(memos.read(&a), (None, None, None));
}

#[test]
fn unchanged_precise_keys_still_hit_after_same_stamp_same_length_rewrite() {
    use std::fs::{File, FileTimes};
    let fixture = Fixture::new("stamp");
    let before = content("old", "older", "old-model");
    let after = content("new", "newer", "new-model");
    assert_eq!(before.len(), after.len());
    let path = fixture.session("sessions/project/a.jsonl", &before);
    let stamp = UNIX_EPOCH + Duration::new(1_800_000_000, 1_200_000);
    let set_stamp = || {
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(stamp))
            .unwrap()
    };
    set_stamp();
    let memos = Memos::new(2, 4096);
    let cached = memos.read(&path);
    fs::write(&path, &after).unwrap();
    set_stamp();
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), stamp);
    assert_ne!(fresh(&path), cached);
    assert_eq!(memos.read(&path), cached);
}
