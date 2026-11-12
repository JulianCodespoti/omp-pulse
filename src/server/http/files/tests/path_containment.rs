//! Pure filesystem regressions for the session cwd resolver; no outside writes.

use super::resolve_under_cwd;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
    cwd: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pulse-path-containment-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).unwrap();
        let cwd = root.join("project");
        fs::create_dir(&cwd).unwrap();
        Self { root, cwd }
    }

    fn resolve(&self, rel: &str) -> Option<PathBuf> {
        resolve_under_cwd(&self.cwd, rel)
    }

    fn canonical(&self, rel: &str) -> PathBuf {
        self.cwd.canonicalize().unwrap().join(rel)
    }

    fn assert_no_outside_target(&self) {
        // Every fixture file/link is created inside project. Outside link
        // destinations are deliberately absent and are never opened or written.
        let names: Vec<_> = fs::read_dir(&self.root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["project"]);
    }

    #[cfg(unix)]
    fn symlink(&self, target: impl AsRef<std::path::Path>, name: &str) {
        std::os::unix::fs::symlink(target, self.cwd.join(name)).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.assert_no_outside_target();
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn existing_in_cwd_targets_keep_canonical_paths_and_bytes() {
    let fixture = Fixture::new();
    fs::write(fixture.cwd.join("file.txt"), "original café 👋\n").unwrap();
    fs::create_dir(fixture.cwd.join("directory")).unwrap();

    assert_eq!(fixture.resolve(""), Some(fixture.canonical("")));
    assert_eq!(fixture.resolve("."), Some(fixture.canonical("")));
    assert_eq!(fixture.resolve("directory/.."), Some(fixture.canonical("")));
    assert_eq!(
        fixture.resolve("file.txt"),
        Some(fixture.canonical("file.txt"))
    );
    assert_eq!(
        fixture.resolve(fixture.cwd.join("file.txt").to_str().unwrap()),
        Some(fixture.canonical("file.txt")),
    );
    assert_eq!(
        fs::read_to_string(fixture.cwd.join("file.txt")).unwrap(),
        "original café 👋\n",
    );
}

#[test]
fn missing_nested_targets_remain_eligible_without_parent_creation() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.cwd.join("existing")).unwrap();

    for rel in [
        "new.txt",
        "missing/nested/file.txt",
        "existing/missing/file.txt",
    ] {
        assert_eq!(fixture.resolve(rel), Some(fixture.canonical(rel)));
    }

    assert!(!fixture.cwd.join("new.txt").exists());
    assert!(!fixture.cwd.join("missing").exists());
    assert!(!fixture.cwd.join("existing/missing").exists());
}

#[test]
fn ordinary_outside_paths_are_refused() {
    let fixture = Fixture::new();
    assert!(fixture.resolve("..").is_none());
    assert!(fixture.resolve("../outside-new.txt").is_none());
    assert!(fixture.resolve("../project-other/new.txt").is_none());
    assert!(
        fixture
            .resolve(fixture.root.join("outside-new.txt").to_str().unwrap())
            .is_none()
    );
}

#[cfg(unix)]
#[test]
fn absolute_dangling_outside_leaf_is_refused_without_opening_target() {
    let fixture = Fixture::new();
    let outside = fixture.root.join("outside-new.txt");
    fixture.symlink(&outside, "link");

    assert!(fixture.resolve("link").is_none());
    assert_eq!(fs::read_link(fixture.cwd.join("link")).unwrap(), outside);
    fixture.assert_no_outside_target();
}

#[cfg(unix)]
#[test]
fn relative_dangling_outside_leaf_is_refused_without_opening_target() {
    let fixture = Fixture::new();
    fixture.symlink("../outside-new.txt", "link");

    assert!(fixture.resolve("link").is_none());
    assert_eq!(
        fs::read_link(fixture.cwd.join("link")).unwrap(),
        std::path::Path::new("../outside-new.txt"),
    );
}

#[cfg(unix)]
#[test]
fn dangling_outside_ancestor_and_link_chain_are_refused() {
    let fixture = Fixture::new();
    fixture.symlink(fixture.root.join("outside-directory"), "directory-link");
    fixture.symlink("directory-link", "chain");

    for rel in [
        "directory-link/new.txt",
        "directory-link/missing/nested.txt",
        "chain",
        "chain/new.txt",
    ] {
        assert!(fixture.resolve(rel).is_none(), "accepted {rel}");
    }
    assert!(!fixture.cwd.join("directory-link").exists());
}

#[cfg(unix)]
#[test]
fn trailing_path_syntax_cannot_hide_dangling_symlinks() {
    let fixture = Fixture::new();
    fixture.symlink(fixture.root.join("outside-directory"), "link");

    for rel in [
        "link/",
        "link/.",
        "link/./",
        "link//",
        "link/./new.txt",
        "./link/./new.txt",
    ] {
        assert!(fixture.resolve(rel).is_none(), "accepted {rel}");
    }
}

#[cfg(unix)]
#[test]
fn unresolved_in_cwd_symlinks_are_conservatively_refused() {
    let fixture = Fixture::new();
    fixture.symlink("missing.txt", "relative-link");
    fixture.symlink(fixture.cwd.join("missing-directory"), "absolute-link");

    for rel in ["relative-link", "absolute-link", "absolute-link/new.txt"] {
        assert!(fixture.resolve(rel).is_none(), "accepted {rel}");
    }
    assert!(!fixture.cwd.join("missing.txt").exists());
    assert!(!fixture.cwd.join("missing-directory").exists());
}

#[cfg(unix)]
#[test]
fn resolved_in_cwd_symlinks_and_missing_children_remain_eligible() {
    let fixture = Fixture::new();
    fs::write(fixture.cwd.join("file.txt"), "unchanged").unwrap();
    fs::create_dir(fixture.cwd.join("directory")).unwrap();
    fixture.symlink("file.txt", "file-link");
    fixture.symlink(fixture.cwd.join("directory"), "directory-link");
    fixture.symlink("file-link", "file-chain");

    for rel in ["file-link", "file-chain"] {
        assert_eq!(fixture.resolve(rel), Some(fixture.canonical("file.txt")));
    }
    assert_eq!(
        fixture.resolve("directory-link/"),
        Some(fixture.canonical("directory")),
    );
    assert_eq!(
        fixture.resolve("directory-link/missing/new.txt"),
        Some(fixture.canonical("directory/missing/new.txt")),
    );
    assert!(!fixture.cwd.join("directory/missing").exists());
    assert_eq!(
        fs::read_to_string(fixture.cwd.join("file.txt")).unwrap(),
        "unchanged"
    );
}

#[cfg(unix)]
#[test]
fn canonical_cwd_and_existing_outside_symlinks_keep_their_boundary() {
    let fixture = Fixture::new();
    // Cwd itself may be reached through a link; the containment root is still
    // canonical. The alias and its target are both inside this fixture project.
    fs::create_dir(fixture.cwd.join("real-project")).unwrap();
    fixture.symlink("real-project", "cwd-alias");
    let alias = fixture.cwd.join("cwd-alias");
    assert_eq!(
        resolve_under_cwd(&alias, "missing/new.txt"),
        Some(fixture.canonical("real-project/missing/new.txt")),
    );
    fixture.symlink(&fixture.root, "outside-link");
    assert!(fixture.resolve("outside-link").is_none());
    assert!(fixture.resolve("outside-link/missing.txt").is_none());
}

#[cfg(unix)]
#[test]
fn symlink_loop_is_refused() {
    let fixture = Fixture::new();
    fixture.symlink("loop-b", "loop-a");
    fixture.symlink("loop-a", "loop-b");

    assert!(fixture.resolve("loop-a").is_none());
    assert!(fixture.resolve("loop-a/missing.txt").is_none());
}

#[cfg(unix)]
#[test]
fn non_directory_obstruction_is_not_treated_as_missing() {
    let fixture = Fixture::new();
    fs::write(fixture.cwd.join("file.txt"), "unchanged").unwrap();
    let target = fixture.cwd.join("file.txt/child.txt");
    assert_ne!(
        fs::symlink_metadata(&target).unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );

    assert!(fixture.resolve("file.txt/child.txt").is_none());
    assert_eq!(
        fs::read_to_string(fixture.cwd.join("file.txt")).unwrap(),
        "unchanged"
    );
}
