use super::super::internal_resource;
use std::{
    fs::{self, File},
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pulse-resources-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        for name in ["a", "b"] {
            fs::write(root.join(format!("{name}.jsonl")), "{}\n").unwrap();
            fs::create_dir_all(root.join(name).join("local")).unwrap();
            fs::write(
                root.join(name).join("local/PLAN.md"),
                format!("{name} plan\n"),
            )
            .unwrap();
            fs::write(
                root.join(name).join("0.bash"),
                format!("{name} saved output\n"),
            )
            .unwrap();
        }
        Self(root)
    }
    fn read(&self, session: &str, uri: &str) -> Result<(Vec<u8>, bool), String> {
        let resource = internal_resource::resolve(&self.0.join(format!("{session}.jsonl")), uri)?;
        resource
            .read_preview(File::open(&resource.path).unwrap())
            .map_err(|e| e.to_string())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn identical_uris_read_only_the_originating_conversations_bytes() {
    let f = Fixture::new();
    for (session, expected) in [("a", "a"), ("b", "b")] {
        assert_eq!(
            f.read(session, "local://PLAN.md").unwrap(),
            (format!("{expected} plan\n").into_bytes(), false)
        );
        assert_eq!(
            f.read(session, "artifact://0").unwrap(),
            (format!("{expected} saved output\n").into_bytes(), false)
        );
    }
    fs::remove_file(f.0.join("a/0.bash")).unwrap();
    assert!(
        f.read("a", "artifact://0").is_err(),
        "must not search b for an absent a output"
    );
    assert!(f.read("missing", "artifact://0").is_err());
}

#[test]
fn native_line_selector_forms_return_selected_bytes() {
    let f = Fixture::new();
    fs::write(f.0.join("a/0.bash"), "one\ntwo\nthree\nfour\nfive").unwrap();
    for (uri, expected) in [
        ("artifact://0:2-3", "two\nthree\n"),
        ("artifact://0:raw:2+2", "two\nthree\n"),
        ("artifact://0:2-3:raw", "two\nthree\n"),
        ("artifact://0:2,4", "two\nfour\n"),
        ("artifact://0:L2..L3", "two\nthree\n"),
        ("artifact://0:4", "four\nfive"),
        ("artifact://0:-2", "four\nfive"),
        ("artifact://0:raw:-2", "four\nfive"),
        ("artifact://0:99-100", ""),
    ] {
        assert_eq!(
            f.read("a", uri).unwrap(),
            (expected.as_bytes().to_vec(), false),
            "{uri}"
        );
    }
    fs::write(f.0.join("a/local/with space.txt"), "one\ntwo\nthree\n").unwrap();
    assert_eq!(
        f.read("a", "local://with%20space.txt:2-2").unwrap().0,
        b"two\n"
    );
}

#[test]
fn invalid_or_foreign_references_never_fall_back_to_filesystem_paths() {
    let f = Fixture::new();
    for uri in [
        "local://../b/local/PLAN.md",
        "local://%2e%2e/b/local/PLAN.md",
        "local://..%5cb/local/PLAN.md",
        "local:////etc/passwd",
        "local://%2fetc/passwd",
        "local://PLAN.md?session=b",
        "local://%00",
        "local://%zz",
        "local://missing",
        "artifact://../b/0.bash",
        "artifact://0/file",
        "artifact://0?session=b",
        "artifact://0#b",
        "artifact://0:0-2",
        "artifact://0:4-2",
        "artifact://0:2+0",
        "artifact://0:2:3",
        "artifact://0:999999999999999999999999",
        "artifact://0:",
        "artifact:0",
        "local:PLAN.md",
    ] {
        assert!(f.read("a", uri).is_err(), "{uri}");
    }
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_redirect_local_or_saved_output_into_another_conversation() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    symlink(f.0.join("b/local/PLAN.md"), f.0.join("a/local/foreign")).unwrap();
    symlink(f.0.join("b/0.bash"), f.0.join("a/1.bash")).unwrap();
    assert!(f.read("a", "local://foreign").is_err());
    assert!(f.read("a", "artifact://1").is_err());
    fs::remove_dir_all(f.0.join("a/local")).unwrap();
    symlink(f.0.join("b/local"), f.0.join("a/local")).unwrap();
    assert!(f.read("a", "local://PLAN.md").is_err());
    fs::remove_dir_all(f.0.join("a")).unwrap();
    symlink(f.0.join("b"), f.0.join("a")).unwrap();
    assert!(f.read("a", "artifact://0").is_err());
}

#[test]
fn selectors_skip_large_lines_without_allocating_them_and_keep_preview_cap() {
    let f = Fixture::new();
    let mut bytes = vec![b'x'; super::super::MAX_FILE_READ as usize + 9];
    bytes.extend_from_slice(b"\nselected\n");
    fs::write(f.0.join("a/0.bash"), bytes).unwrap();
    assert_eq!(
        f.read("a", "artifact://0:2-2").unwrap(),
        (b"selected\n".to_vec(), false)
    );
    let (preview, truncated) = f.read("a", "artifact://0:1-1").unwrap();
    assert_eq!(preview.len(), super::super::MAX_FILE_READ as usize);
    assert!(truncated);
}
