//! Session listing: walking the sessions root, with a header memo validated by
//! each file's (mtime, length) so a refresh only re-reads changed files.

use super::*;
use crate::types::*;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Modification time is kept at fractional-millisecond precision so listing
/// ordering stays stable across platforms.
/// Modification time as fractional milliseconds since the epoch.
///
/// PORTABILITY: this used to read `MetadataExt::mtime`/`mtime_nsec`, which are
/// POSIX-only and stopped the crate compiling for Windows. `Metadata::modified`
/// is portable and carries the same nanosecond resolution, so the wire value is
/// unchanged including its fractional part - the listing's total order depends on
/// it, and rounding here would reshuffle equal-second sessions.
pub(super) fn mtime_millis(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1_000_000.0)
        .unwrap_or(0.0)
}

/// `parse_header` answers from the previous `list_sessions` walk, keyed by path
/// and validated by the (mtime, length) the walk stats anyway. The header sits
/// in the first 4 KiB of an append-only file, so without this every listing
/// refresh re-opened and re-read every idle session for an unchanged answer:
/// ~3 ms of open+read+close per file under proot (measured on a phone,
/// 38 sessions, 2026-10-14), about half of a ~220 ms scan. Each walk keeps only
/// the files it saw, so the memo never outgrows the catalogue. The last field
/// is an untitled session's first-prompt title: once found, it survives a stamp
/// change only while the freshly parsed header has the same present session
/// ID. Appending to that session needs no new prompt scan, while a different
/// session at the same path must derive its own label.
type HeaderMemo = HashMap<
    PathBuf,
    (
        Option<std::time::SystemTime>,
        u64,
        SessionHeader,
        Option<String>,
    ),
>;
static HEADER_MEMO: std::sync::LazyLock<Mutex<HeaderMemo>> =
    std::sync::LazyLock::new(|| Mutex::new(HeaderMemo::new()));

pub fn list_sessions(root: &Path) -> Vec<SessionInfo> {
    // Taken, not locked across the walk: a concurrent walk (search, collab
    // id lookup) starts from an empty memo and re-reads, and the last walk to
    // finish stores its memo. Both outcomes only cost reads, never answers.
    let mut memo = std::mem::take(&mut *HEADER_MEMO.lock().unwrap_or_else(|p| p.into_inner()));
    let out = list_sessions_with_memo(root, &mut memo);
    *HEADER_MEMO.lock().unwrap_or_else(|p| p.into_inner()) = memo;
    out
}

fn list_sessions_with_memo(root: &Path, memo: &mut HeaderMemo) -> Vec<SessionInfo> {
    let mut previous = std::mem::take(memo);
    let mut out: Vec<SessionInfo> = Vec::new();
    scan_sessions(root, true, &mut out, &mut previous, memo);
    out.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    out
}

fn scan_sessions(
    dir: &Path,
    recurse: bool,
    out: &mut Vec<SessionInfo>,
    previous: &mut HeaderMemo,
    next: &mut HeaderMemo,
) {
    let ents = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for ent in ents {
        let ent = match ent {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = ent.file_name();
        let name = name.to_string_lossy();
        let ft = match ent.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            // The agent's own session store IS phone material — the user
            // drives those conversations too. Only real sessions (header
            // check below) are listed; subagent transcripts and other
            // headerless sidecar jsonl stay hidden.
            if recurse {
                scan_sessions(&ent.path(), false, out, previous, next);
            }
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        if !name.ends_with(".jsonl") {
            continue;
        }
        // Files directly under sessions_root are scratch/test sessions
        // (created via /api/new with cwd outside a project — e.g. the agent
        // store or /tmp land at root). Real sessions always live in
        // per-project subdirectories, so root-level files never belong in the
        // phone list. `recurse` is true only for the root scan.
        if recurse {
            continue;
        }
        let path = ent.path();
        let st = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = st.modified().ok();
        let (hdr, mut prompt, fresh) = match previous.remove(&path) {
            Some((was_mtime, was_len, hdr, prompt))
                if was_mtime == mtime && was_len == st.len() =>
            {
                (hdr, prompt, false)
            }
            Some((_, _, old_header, prompt @ Some(_))) => {
                let header = parse_header(&path);
                let same_session = old_header.id.is_some() && old_header.id == header.id;
                (header, if same_session { prompt } else { None }, true)
            }
            _ => (parse_header(&path), None, true),
        };
        // `omp-pulse doctor`'s live probe runs a real TUI in a temp scratch
        // dir, and every run leaves one conversation behind. Those were
        // showing up in the phone list as "Collaborate on a Shared Task".
        // Only real sessions (first entry carries a session header) belong in
        // the phone list — subagent transcripts and other sidecar jsonl have
        // no header and would otherwise clutter the inbox.
        let listed = hdr.id.is_some() && !hdr.cwd.as_deref().is_some_and(is_doctor_scratch);
        if listed && fresh && prompt.is_none() && hdr.chosen_title().is_none() {
            prompt = first_prompt_title(&path);
        }
        next.insert(path.clone(), (mtime, st.len(), hdr.clone(), prompt.clone()));
        if !listed {
            continue;
        }
        let title = hdr.chosen_title().map(str::to_string).or(prompt);
        let Some(id) = hdr.id else { continue };
        out.push(SessionInfo {
            path: path.to_string_lossy().into_owned(),
            id,
            // Metadata-only sessions are real new/abandoned chats, not files
            // for the user to interpret. Keep them, with an honest fallback.
            title: title.unwrap_or_else(|| "Untitled session".to_string()),
            cwd: hdr.cwd.unwrap_or_default(),
            mtime: mtime_millis(&st),
            // Replaced by the scan with the newest message's timestamp.
            active_at: mtime_millis(&st),
            size: st.len(),
            running: false,
            owner_pid: None,
            live: false,
            shared: false,
        });
    }
}

/// A cwd inside the doctor's live-probe scratch dir (`doctor::live_probe`
/// names it `omp-pulse-doctor-<pid>` under the temp dir).
fn is_doctor_scratch(cwd: &str) -> bool {
    Path::new(cwd)
        .strip_prefix(std::env::temp_dir())
        .ok()
        .and_then(|rest| rest.components().next())
        .and_then(|c| c.as_os_str().to_str())
        .is_some_and(|name| name.starts_with("omp-pulse-doctor-"))
}

/// Count complete (newline-terminated) lines in a session file, used as the
/// lazy `/api/open` message-count approximation. Missing/unreadable file → 0.
pub fn line_count(path: &Path) -> usize {
    use std::io::Read;
    // Streamed: `fs::read` allocated a full copy of the file (tens of MB for
    // a routine coding session) on every `/api/open` just to count bytes.
    let Ok(mut file) = fs::File::open(path) else {
        return 0;
    };
    let mut buf = vec![0u8; 64 * 1024];
    let mut lines = 0;
    loop {
        match file.read(&mut buf) {
            Ok(0) | Err(_) => return lines,
            Ok(n) => lines += buf[..n].iter().filter(|&&b| b == b'\n').count(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::jsonl::tests::folder_titled;
    use crate::sessions::jsonl::tests::scratch_dir;

    #[test]
    fn list_sessions_header_memo_follows_mtime_and_length() {
        let root = scratch_dir("header-memo");
        let project = root.join("-proj");
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join("a.jsonl");
        let header = |title: &str| {
            format!("{{\"type\":\"session\",\"id\":\"s1\",\"cwd\":\"/w\",\"title\":\"{title}\"}}\n")
        };
        let mut memo = HeaderMemo::new();
        std::fs::write(&file, header("One")).unwrap();
        assert_eq!(list_sessions_with_memo(&root, &mut memo)[0].title, "One");
        assert_eq!(memo.len(), 1);

        // Same length and the old mtime: the memo answers, the file is not
        // re-read (the stale title proves which path ran).
        let mtime = std::fs::metadata(&file).unwrap().modified().unwrap();
        std::fs::write(&file, header("Two")).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        assert_eq!(list_sessions_with_memo(&root, &mut memo)[0].title, "One");

        // A new length invalidates the entry.
        std::fs::write(&file, header("Three")).unwrap();
        assert_eq!(list_sessions_with_memo(&root, &mut memo)[0].title, "Three");

        // A file the walk no longer sees leaves the memo.
        std::fs::remove_file(&file).unwrap();
        assert!(list_sessions_with_memo(&root, &mut memo).is_empty());
        assert!(memo.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn memo_title_session(id: &str, prompt: Option<&str>, title: Option<&str>) -> String {
        let mut body = serde_json::json!({
            "type": "session", "id": id, "cwd": "/w", "title": title,
        })
        .to_string();
        body.push('\n');
        if let Some(prompt) = prompt {
            body.push_str(
                &serde_json::json!({
                    "type": "message", "message": { "role": "user", "content": prompt },
                })
                .to_string(),
            );
            body.push('\n');
        }
        body
    }

    fn write_memo_title_session(path: &Path, body: &str, stamp: u64) {
        std::fs::write(path, body).unwrap();
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(stamp))
            .unwrap();
    }

    #[test]
    fn list_sessions_prompt_memo_is_scoped_to_session_identity() {
        let root = scratch_dir("prompt-memo-identity");
        let project = root.join("-proj");
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join("a.jsonl");
        let mut memo = HeaderMemo::new();
        for (stamp, id, prompt, chosen, expected) in [
            (1, "a", Some("Old prompt"), None, "Old prompt"),
            (2, "b", Some("New prompt"), None, "New prompt"),
            (3, "c", None, None, "Untitled session"),
            (
                4,
                "e",
                Some("Cached before name"),
                None,
                "Cached before name",
            ),
            (
                5,
                "d",
                Some("Hidden prompt"),
                Some("Chosen name"),
                "Chosen name",
            ),
        ] {
            write_memo_title_session(&file, &memo_title_session(id, prompt, chosen), stamp);
            let rows = list_sessions_with_memo(&root, &mut memo);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].id, id);
            assert_eq!(rows[0].title, expected);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn list_sessions_prompt_memo_drops_identity_through_missing_header() {
        for recovered_id in ["a", "b"] {
            let root = scratch_dir(&format!("prompt-memo-missing-{recovered_id}"));
            let project = root.join("-proj");
            std::fs::create_dir_all(&project).unwrap();
            let file = project.join("a.jsonl");
            let mut memo = HeaderMemo::new();
            write_memo_title_session(&file, &memo_title_session("a", Some("Old prompt"), None), 1);
            assert_eq!(
                list_sessions_with_memo(&root, &mut memo)[0].title,
                "Old prompt"
            );
            write_memo_title_session(&file, "{\"type\":\"session\",", 2);
            assert!(list_sessions_with_memo(&root, &mut memo).is_empty());
            assert!(memo[&file].2.id.is_none());
            assert!(
                memo[&file].3.is_none(),
                "an unlisted identity must not retain a prompt"
            );
            write_memo_title_session(
                &file,
                &memo_title_session(recovered_id, Some("Recovered prompt"), None),
                3,
            );
            let rows = list_sessions_with_memo(&root, &mut memo);
            assert_eq!(rows[0].id, recovered_id);
            assert_eq!(rows[0].title, "Recovered prompt");
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn list_sessions_prompt_memo_preserves_same_identity_append() {
        let root = scratch_dir("prompt-memo-append");
        let project = root.join("-proj");
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join("a.jsonl");
        let mut memo = HeaderMemo::new();
        let body = memo_title_session("a", Some("First prompt"), None);
        write_memo_title_session(&file, &body, 1);
        assert_eq!(
            list_sessions_with_memo(&root, &mut memo)[0].title,
            "First prompt"
        );
        write_memo_title_session(&file, &(body + "{\"type\":\"bookkeeping\"}\n"), 2);
        assert_eq!(
            list_sessions_with_memo(&root, &mut memo)[0].title,
            "First prompt"
        );
        assert_eq!(memo[&file].3.as_deref(), Some("First prompt"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn listing_titles_untitled_sessions_from_their_first_prompt() {
        let root = scratch_dir("prompt-title");
        let project = root.join("-home-dev-code-todo-list-app");
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join("a.jsonl");
        let mut memo = HeaderMemo::new();
        // Header only: nothing to derive from yet.
        std::fs::write(
            &file,
            "{\"type\":\"session\",\"id\":\"s1\",\"timestamp\":\"2026-10-14T14:37:30.741Z\",\"cwd\":\"/home/dev/code/todo-list-app\"}\n",
        )
        .unwrap();
        assert_eq!(
            list_sessions_with_memo(&root, &mut memo)[0].title,
            "Untitled session"
        );
        std::fs::write(
            &file,
            folder_titled(
                "todo-list-app",
                "2026-10-14T14:37:30.832Z",
                "Why is the list full of folders",
            ),
        )
        .unwrap();
        assert_eq!(
            list_sessions_with_memo(&root, &mut memo)[0].title,
            "Why is the list full of folders"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
