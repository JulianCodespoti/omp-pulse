use super::*;
use std::path::PathBuf;

/// Unique-per-test temp file (tempfile is not a dependency; matches the
/// collab.rs/doctor.rs precedent of temp_dir + unique tag).
pub(super) fn scratch(tag: &str, content: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "omp-pulse-jsonl-{}-{tag}.jsonl",
        std::process::id()
    ));
    std::fs::write(&path, content).unwrap();
    path
}
#[test]
fn parse_header_skips_empty_titles() {
    // omp writes `"title":""` for untitled sessions: an empty entry must
    // not claim the slot and block the session-entry fallback.
    let p = scratch(
        "empty-title",
        "{\"type\":\"title\",\"title\":\"\"}\n{\"type\":\"session\",\"id\":\"s1\",\"title\":\"Real\"}\n",
    );
    assert_eq!(parse_header(&p).title.as_deref(), Some("Real"));
    let p = scratch(
        "all-empty-title",
        "{\"type\":\"title\",\"title\":\"  \"}\n{\"type\":\"session\",\"id\":\"s2\"}\n",
    );
    assert_eq!(parse_header(&p).title, None);
    let _ = std::fs::remove_file(&p);
}

/// A unique-per-test temp DIRECTORY (tempfile is not a dependency).
pub(super) fn scratch_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("omp-pulse-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Write a minimal real session file (session header with id+cwd + title).
pub(super) fn session_file(dir: &Path, name: &str, cwd: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(
        &p,
        format!(
            "{{\"type\":\"session\",\"version\":1,\"id\":\"{name}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"{cwd}\"}}\n\
                 {{\"type\":\"title\",\"id\":\"t0\",\"title\":\"fixture\"}}\n"
        ),
    )
    .unwrap();
    p
}

/// A phone-created session as the daemon wrote it before 2026-10-14:
/// the cwd basename set as a user title ~90 ms after creation.
pub(super) fn folder_titled(title: &str, updated_at: &str, prompt: &str) -> String {
    format!(
        "{{\"type\":\"title\",\"v\":1,\"title\":\"{title}\",\"source\":\"user\",\"updatedAt\":\"{updated_at}\"}}\n\
             {{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"timestamp\":\"2026-10-14T14:37:30.741Z\",\"cwd\":\"/home/dev/code/todo-list-app\",\"title\":\"{title}\",\"titleSource\":\"user\"}}\n\
             {{\"type\":\"title_change\",\"id\":\"a\",\"timestamp\":\"2026-10-14T14:37:30.832Z\",\"title\":\"todo-list-app\",\"source\":\"user\"}}\n\
             {{\"type\":\"message\",\"id\":\"m\",\"timestamp\":\"2026-10-14T14:38:17.834Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{prompt}\"}}]}}}}\n"
    )
}

#[test]
fn folder_name_written_at_creation_reads_as_untitled() {
    let prompt = "Fix the login form\\nIt keeps failing";
    let p = scratch(
        "folder-title",
        &folder_titled("todo-list-app", "2026-10-14T14:37:30.832Z", prompt),
    );
    let header = parse_header(&p);
    assert_eq!(header.title.as_deref(), Some("todo-list-app"));
    assert_eq!(header.chosen_title(), None);
    assert_eq!(display_title(&p).as_deref(), Some("Fix the login form"));
    let _ = std::fs::remove_file(&p);
}

#[test]
fn a_later_rename_or_a_different_title_stands() {
    // Renamed by hand minutes later, even to the folder name: a choice.
    let p = scratch(
        "folder-title-renamed",
        &folder_titled("todo-list-app", "2026-10-14T14:45:00.000Z", "hello"),
    );
    assert_eq!(parse_header(&p).chosen_title(), Some("todo-list-app"));
    assert_eq!(display_title(&p).as_deref(), Some("todo-list-app"));
    let p2 = scratch(
        "folder-title-other",
        &folder_titled("Login form", "2026-10-14T14:37:30.832Z", "hello"),
    );
    assert_eq!(parse_header(&p2).chosen_title(), Some("Login form"));
    let _ = std::fs::remove_file(&p);
    let _ = std::fs::remove_file(&p2);
}

#[test]
fn prompt_titles_cut_at_a_word_boundary() {
    assert_eq!(
        prompt_title("  \n  Short ask  \nmore").as_deref(),
        Some("Short ask")
    );
    assert_eq!(prompt_title(" \n\t").as_deref(), None);
    let long = "Please review every open pull request in the omp pulse repository today";
    let title = prompt_title(long).unwrap();
    assert_eq!(title, "Please review every open pull request in the…");
    assert!(title.chars().count() <= PROMPT_TITLE_MAX);
    // One unbroken word: a hard cut, still within the limit.
    let word = "x".repeat(80);
    let title = prompt_title(&word).unwrap();
    assert_eq!(title.chars().count(), PROMPT_TITLE_MAX);
    assert!(title.ends_with('…'));
    // Multibyte text never splits a character.
    let wide = "é".repeat(60);
    assert_eq!(
        prompt_title(&wide).unwrap().chars().count(),
        PROMPT_TITLE_MAX
    );
}

mod timestamp;
