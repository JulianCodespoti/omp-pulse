use super::*;
use std::sync::{Arc, Barrier};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pulse-file-write-{}-{:032x}",
            std::process::id(),
            rand::random::<u128>(),
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn path(&self) -> PathBuf {
        self.0.join("file.txt")
    }

    fn save(&self, content: &str, expected: Option<&str>) -> Result<(), Error> {
        serialise(|| save(&self.path(), content, expected))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn stale_baseline_preserves_the_external_writers_bytes() {
    let fixture = Fixture::new();
    fs::write(fixture.path(), "baseline").unwrap();
    let baseline = fs::read_to_string(fixture.path()).unwrap();
    fs::write(fixture.path(), "agent edit").unwrap();

    assert!(matches!(
        fixture.save("phone edit", Some(&baseline)),
        Err(Error::Conflict)
    ));
    assert_eq!(fs::read_to_string(fixture.path()).unwrap(), "agent edit");
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[test]
fn unchanged_baseline_saves_exact_utf8_and_empty_content() {
    let fixture = Fixture::new();
    fs::write(fixture.path(), "baseline").unwrap();
    let content = "  café 👋\n\tkeep whitespace  \n";
    fixture.save(content, Some("baseline")).unwrap();
    assert_eq!(fs::read(fixture.path()).unwrap(), content.as_bytes());
    fixture.save("", Some(content)).unwrap();
    assert!(fs::read(fixture.path()).unwrap().is_empty());
    assert_eq!(
        fs::read_dir(&fixture.0).unwrap().count(),
        1,
        "staging is removed"
    );
}

#[test]
fn concurrent_pulse_saves_share_the_compare_and_commit_boundary() {
    let fixture = Fixture::new();
    fs::write(fixture.path(), "baseline").unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let handles: Vec<_> = ["first phone", "second phone"]
        .into_iter()
        .map(|content| {
            let path = fixture.path();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (
                    content,
                    serialise(|| save(&path, content, Some("baseline"))),
                )
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(
        results.iter().filter(|(_, result)| result.is_ok()).count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|(_, result)| matches!(result, Err(Error::Conflict)))
            .count(),
        1
    );
    let winner = results.iter().find(|(_, result)| result.is_ok()).unwrap().0;
    assert_eq!(fs::read_to_string(fixture.path()).unwrap(), winner);
}

#[test]
fn create_only_preserves_existing_files_and_creates_missing_parents() {
    let fixture = Fixture::new();
    fixture.save("created", None).unwrap();
    assert!(matches!(
        fixture.save("overwrite", None),
        Err(Error::Conflict)
    ));
    assert_eq!(fs::read_to_string(fixture.path()).unwrap(), "created");
    let nested = fixture.0.join("missing/nested/new.txt");
    serialise(|| save(&nested, "new file", None)).unwrap();
    assert_eq!(fs::read_to_string(nested).unwrap(), "new file");
    let absent = fixture.0.join("still-missing/new.txt");
    assert!(matches!(
        serialise(|| save(&absent, "draft", Some("baseline"))),
        Err(Error::Conflict)
    ));
    assert!(!fixture.0.join("still-missing").exists());
}

#[test]
fn create_only_publication_preserves_a_racing_creators_file() {
    let fixture = Fixture::new();
    let staged = Staged::new(&fixture.0, "phone draft", None).unwrap();
    fs::write(fixture.path(), "concurrent creator").unwrap();
    assert_eq!(
        publish_new(&staged.0, &fixture.path()).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        fs::read_to_string(fixture.path()).unwrap(),
        "concurrent creator"
    );
    assert_eq!(fs::read_to_string(&staged.0).unwrap(), "phone draft");
}

#[test]
fn directory_is_refused_without_mutation() {
    let fixture = Fixture::new();
    let directory = fixture.0.join("directory");
    fs::create_dir(&directory).unwrap();
    assert_eq!(
        validate_target(&directory).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn metadata_errors_other_than_not_found_are_preserved() {
    let fixture = Fixture::new();
    fs::write(fixture.path(), "unchanged").unwrap();
    let child = fixture.path().join("child.txt");
    let original = fs::metadata(&child).unwrap_err();
    assert_ne!(original.kind(), io::ErrorKind::NotFound);
    assert_eq!(validate_target(&child).unwrap_err().kind(), original.kind());
    assert_eq!(fs::read_to_string(fixture.path()).unwrap(), "unchanged");
}

#[cfg(unix)]
#[test]
fn executable_mode_is_preserved_and_symlink_replacements_are_refused() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let fixture = Fixture::new();
    fs::write(fixture.path(), "baseline").unwrap();
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o751)).unwrap();
    fixture.save("replacement", Some("baseline")).unwrap();
    assert_eq!(
        fs::metadata(fixture.path()).unwrap().permissions().mode() & 0o777,
        0o751
    );
    let link = fixture.0.join("link");
    symlink(fixture.path(), &link).unwrap();
    assert_eq!(
        validate_target(&link).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    validate_target(&link.canonicalize().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(fixture.path()).unwrap(), "replacement");
}

#[cfg(unix)]
#[test]
fn fifo_is_refused_without_opening_it() {
    use std::os::unix::fs::FileTypeExt;
    let _env = crate::paths::testenv::with_tool_path();
    let fixture = Fixture::new();
    let fifo = fixture.0.join("pipe");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(
        validate_target(&fifo).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert!(fs::metadata(&fifo).unwrap().file_type().is_fifo());
}
