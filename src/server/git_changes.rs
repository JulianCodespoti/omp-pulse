//! Git working-tree changes of a session's cwd against HEAD, for the phone's Workspace → Changes panel.
//!
//! WHY the `git` CLI rather than a crate: the user's own git honours their
//! repository config, attributes and ignore rules exactly as their terminal
//! does, and a libgit2 binding would add a C dependency that the Windows and
//! musl targets have to carry. Every call goes through [`run_streaming`], which
//! kills git when the collection deadline passes, so a wedged filesystem or a
//! huge repository costs a bounded wait, never a hung request.
//!
//! WHY the caps: the phone renders these patches, and one generated file or a
//! vendored directory can be hundreds of megabytes of diff. Each file keeps at
//! most [`Limits::per_file`] bytes of patch, the whole response at most
//! [`Limits::total`], and at most [`Limits::max_files`] files are listed. Any
//! cap that bites sets `truncated` rather than failing the request: a partial
//! view of the changes is useful, an error is not.
//!
//! Paths are relative to `repoRoot`, as git reports them. Changes cover the
//! whole repository, not only the session's subdirectory, the same scope
//! `git status` shows.

use std::collections::HashMap;
use std::fs::Metadata;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Git's own binary heuristic: a NUL byte in the first 8000 bytes.
const BINARY_SNIFF: usize = 8000;
/// Stderr is only read for an error message; the rest is drained unread.
const STDERR_KEEP: u64 = 64 * 1024;
const PATCH_HEADER: &[u8] = b"diff --git ";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What one collection returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Every file with its unified patch: the Workspace → Changes panel.
    Full,
    /// Paths, status and line counts, no patches: the chat's `+a −r` pill,
    /// read on every chat open and turn end. Skips `git diff --patch`
    /// entirely and reads untracked files only far enough to count lines.
    Summary,
}

/// Bounds for one collection. [`Limits::DEFAULT`] and [`Limits::SUMMARY`] are
/// what the endpoint uses; tests shrink them so a cap can be exercised
/// without megabytes of fixture.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Patch bytes kept per file.
    pub per_file: usize,
    /// Patch bytes kept across all files.
    pub total: usize,
    /// Files listed; `totals` still covers the rest.
    pub max_files: usize,
    /// Bytes of one untracked file read to count its lines. Past it the count
    /// is a lower bound and `truncated` is set: a multi-gigabyte log that is
    /// not ignored must not cost a full read.
    pub count_per_file: u64,
    /// Bytes of all untracked files read to count lines.
    pub count_total: u64,
    pub budget: Duration,
}

impl Limits {
    pub const DEFAULT: Limits = Limits {
        per_file: 200 * 1024,
        total: 2 * 1024 * 1024,
        max_files: 1000,
        count_per_file: 16 * 1024 * 1024,
        count_total: 64 * 1024 * 1024,
        budget: Duration::from_secs(15),
    };
    pub const SUMMARY: Limits = Limits {
        per_file: 0,
        total: 0,
        max_files: 1000,
        count_per_file: 1024 * 1024,
        count_total: 8 * 1024 * 1024,
        budget: Duration::from_secs(10),
    };

    pub fn for_mode(mode: Mode) -> Limits {
        match mode {
            Mode::Full => Limits::DEFAULT,
            Mode::Summary => Limits::SUMMARY,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

/// Git's unmerged index states, not a scan for conflict markers in the worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UnmergedStatus {
    DD,
    AU,
    UD,
    UA,
    DU,
    AA,
    UU,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unmerged: Option<UnmergedStatus>,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    /// [`Mode::Full`] only. Unified diff including its `diff --git` header;
    /// empty when a cap left no room for it (then `patch_truncated` is set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_truncated: Option<bool>,
}

/// Sums over every changed file git reported, including files past the
/// `max_files` list cap, so a pill can show the whole change.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Totals {
    pub files: usize,
    pub additions: u64,
    pub deletions: u64,
}

impl Totals {
    fn add(&mut self, additions: u64, deletions: u64) {
        self.files += 1;
        self.additions += additions;
        self.deletions += deletions;
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub cwd: String,
    pub repo_root: Option<String>,
    /// Current branch; `None` when HEAD is detached or outside a repository.
    pub branch: Option<String>,
    pub not_repo: bool,
    pub files: Vec<ChangedFile>,
    pub totals: Totals,
    /// A cap or the deadline bit: the list, a patch or an untracked line
    /// count (then a lower bound) is incomplete.
    pub truncated: bool,
}

/// Collect the changes of the repository containing `cwd` with the mode's caps.
pub fn collect(cwd: &Path, mode: Mode) -> Result<Changes, String> {
    collect_with(cwd, &Limits::for_mode(mode), mode)
}

pub fn collect_with(cwd: &Path, limits: &Limits, mode: Mode) -> Result<Changes, String> {
    let deadline = Instant::now() + limits.budget;
    let cwd_text = cwd.to_string_lossy().into_owned();
    let patches = mode == Mode::Full;

    let top = run(cwd, &["rev-parse", "--show-toplevel"], deadline)?;
    if !top.success {
        // LC_ALL=C (see `git_command`) keeps this message untranslated.
        if top.stderr.contains("not a git repository") {
            return Ok(Changes {
                cwd: cwd_text,
                repo_root: None,
                branch: None,
                not_repo: true,
                files: Vec::new(),
                totals: Totals::default(),
                truncated: false,
            });
        }
        return Err(git_failure("rev-parse", &top.stderr));
    }
    let root_text = trim_line(&top.stdout);
    let root = PathBuf::from(&root_text);

    // `symbolic-ref` also names an unborn branch, which `rev-parse
    // --abbrev-ref` cannot; it fails only on a detached HEAD.
    let head_ref = run(&root, &["symbolic-ref", "--short", "-q", "HEAD"], deadline)?;
    let branch = head_ref
        .success
        .then(|| trim_line(&head_ref.stdout))
        .filter(|b| !b.is_empty());

    // A repository without commits diffs against the empty tree. Its id is
    // asked of git rather than hard-coded: SHA-256 repositories differ.
    let has_head = run(
        &root,
        &["rev-parse", "--verify", "-q", "HEAD^{commit}"],
        deadline,
    )?
    .success;
    let base = if has_head {
        "HEAD".to_string()
    } else {
        let empty = run(&root, &["hash-object", "-t", "tree", "--stdin"], deadline)?;
        if !empty.success {
            return Err(git_failure("hash-object", &empty.stderr));
        }
        trim_line(&empty.stdout)
    };

    let diff = |extra: &[&'static str]| -> Vec<String> {
        let mut args: Vec<String> = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M"]
            .iter()
            .chain(extra)
            .map(|s| s.to_string())
            .collect();
        args.push(base.clone());
        args.push("--".into());
        args
    };

    let name_status = run_owned(&root, &diff(&["--name-status", "-z"]), deadline)?;
    if !name_status.success {
        return Err(git_failure("diff", &name_status.stderr));
    }
    let numstat = run_owned(&root, &diff(&["--numstat", "-z"]), deadline)?;
    if !numstat.success {
        return Err(git_failure("diff", &numstat.stderr));
    }
    let mut stats = parse_numstat(&numstat.stdout);
    // A diff against HEAD describes content, not the index's merge state.
    // In particular, removing markers does not resolve an unmerged entry,
    // and some unmerged paths have no content difference from HEAD at all.
    let status = run(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=no"],
        deadline,
    )?;
    if !status.success {
        return Err(git_failure("status", &status.stderr));
    }
    let mut unmerged = parse_unmerged_status(&status.stdout);

    let entries = parse_name_status(&name_status.stdout);
    let mut totals = Totals::default();
    let mut truncated = entries.len() > limits.max_files;
    let mut files: Vec<ChangedFile> = Vec::with_capacity(entries.len().min(limits.max_files));
    for (status, old_path, path) in entries {
        let conflict = unmerged.remove(&path);
        let stat = stats.remove(&path).unwrap_or_default();
        totals.add(stat.additions, stat.deletions);
        if files.len() < limits.max_files {
            files.push(ChangedFile {
                path,
                old_path,
                status: if conflict.is_some() {
                    ChangeStatus::Conflicted
                } else {
                    status
                },
                unmerged: conflict,
                additions: stat.additions,
                deletions: stat.deletions,
                binary: stat.binary,
                patch: patches.then(String::new),
                patch_truncated: patches.then_some(false),
            });
        }
    }

    let mut budget = Budget {
        per_file: limits.per_file,
        total_left: limits.total,
        exhausted: false,
    };
    if patches && !files.is_empty() {
        truncated |= fill_tracked_patches(
            &root,
            &diff(&["--patch"]),
            deadline,
            &mut files,
            &mut budget,
        )?;
    }
    // Append index-only conflicts after patch collection: the existing files
    // must retain the diff queue's order while its sections are assigned.
    let mut remaining: Vec<_> = unmerged.into_iter().collect();
    remaining.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    for (path, conflict) in remaining {
        let stat = stats.remove(&path).unwrap_or_default();
        totals.add(stat.additions, stat.deletions);
        if files.len() < limits.max_files {
            files.push(ChangedFile {
                path,
                old_path: None,
                status: ChangeStatus::Conflicted,
                unmerged: Some(conflict),
                additions: stat.additions,
                deletions: stat.deletions,
                binary: stat.binary,
                patch: patches.then(String::new),
                patch_truncated: patches.then_some(false),
            });
        } else {
            truncated = true;
        }
    }

    let others = run(
        &root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        deadline,
    )?;
    if !others.success {
        return Err(git_failure("ls-files", &others.stderr));
    }
    let mut counter = LineCounter {
        per_file: limits.count_per_file,
        left: limits.count_total,
        deadline,
    };
    for rel in split_z(&others.stdout) {
        if Instant::now() >= deadline {
            truncated = true;
            break;
        }
        let listed = files.len() < limits.max_files;
        let patch_budget = (patches && listed).then_some(&mut budget);
        let (file, counted) = untracked_file(&root, &rel, patch_budget, &mut counter);
        truncated |= !counted;
        totals.add(file.additions, 0);
        if listed {
            files.push(file);
        } else {
            truncated = true;
        }
    }

    truncated |= budget.exhausted || files.iter().any(|f| f.patch_truncated == Some(true));
    Ok(Changes {
        cwd: cwd_text,
        repo_root: Some(root_text),
        branch,
        not_repo: false,
        files,
        totals,
        truncated,
    })
}

// --- Patch budget -----------------------------------------------------------

struct Budget {
    per_file: usize,
    total_left: usize,
    /// The total cap was hit: later patches are dropped, not just cut.
    exhausted: bool,
}

#[derive(Default)]
struct PatchBuf {
    bytes: Vec<u8>,
    truncated: bool,
}

impl Budget {
    /// Append one whole line or none of it, so a cut patch always ends at a
    /// line boundary and still parses as a unified diff.
    fn push(&mut self, buf: &mut PatchBuf, line: &[u8]) {
        if buf.truncated {
            return;
        }
        if self.exhausted || line.len() > self.total_left {
            self.exhausted = true;
            buf.truncated = true;
            return;
        }
        if buf.bytes.len() + line.len() > self.per_file {
            buf.truncated = true;
            return;
        }
        buf.bytes.extend_from_slice(line);
        self.total_left -= line.len();
    }
}

/// Stream `git diff --patch` and hand each `diff --git` section to the file
/// at the same index. `--name-status` and `--patch` walk the same diff queue
/// in the same order, so position is the identity; parsing paths back out of
/// patch headers would be ambiguous for names containing spaces.
/// Returns whether patches were cut short by the deadline.
fn fill_tracked_patches(
    root: &Path,
    args: &[String],
    deadline: Instant,
    files: &mut [ChangedFile],
    budget: &mut Budget,
) -> Result<bool, String> {
    let mut sections: Vec<PatchBuf> = Vec::new();
    let mut stopped = false;
    let line_cap = budget.per_file + 1;
    let finished = run_streaming(root, args, deadline, |reader| {
        let mut line = Vec::new();
        loop {
            line.clear();
            match read_line_capped(reader, &mut line, line_cap) {
                Ok(true) => {}
                Ok(false) | Err(_) => return false,
            }
            if line.starts_with(PATCH_HEADER) {
                if sections.len() == files.len() {
                    // The file list was capped; the rest of the stream is unused.
                    stopped = true;
                    return true;
                }
                sections.push(PatchBuf::default());
            }
            let Some(current) = sections.last_mut() else {
                continue;
            };
            budget.push(current, &line);
            if budget.exhausted {
                stopped = true;
                return true;
            }
        }
    })?;
    let filled = sections.len();
    for (file, section) in files.iter_mut().zip(sections) {
        file.patch = Some(String::from_utf8_lossy(&section.bytes).into_owned());
        file.patch_truncated = Some(section.truncated);
    }
    if finished.timed_out && filled > 0 {
        // The section being read when git was killed is incomplete.
        files[filled - 1].patch_truncated = Some(true);
    }
    if stopped || finished.timed_out {
        for file in files.iter_mut().skip(filled) {
            file.patch_truncated = Some(true);
        }
    }
    Ok(finished.timed_out)
}

/// Read one line (with its `\n`) into `line`, keeping at most `max` bytes and
/// consuming the rest of an over-long line unkept, so a single minified line
/// of hundreds of megabytes never lands in memory. `Ok(false)` at EOF.
fn read_line_capped(reader: &mut impl BufRead, line: &mut Vec<u8>, max: usize) -> io::Result<bool> {
    let mut read_any = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(read_any);
        }
        read_any = true;
        let (chunk, done) = match available.iter().position(|b| *b == b'\n') {
            Some(i) => (&available[..=i], true),
            None => (available, false),
        };
        let room = max.saturating_sub(line.len());
        line.extend_from_slice(&chunk[..chunk.len().min(room)]);
        let used = chunk.len();
        reader.consume(used);
        if done {
            return Ok(true);
        }
    }
}

// --- Untracked files --------------------------------------------------------

/// Bytes still available for counting untracked lines, shared across files.
struct LineCounter {
    per_file: u64,
    left: u64,
    deadline: Instant,
}

/// An untracked file as git would show it after `git add -N`: a whole-file
/// addition. Symlinks are never followed — the link target is the content,
/// as in git — so a link out of the repository cannot leak what it points at.
/// `patch` is `None` when no patch is wanted (summary mode, or past the list
/// cap where only the totals need the line count). Returns whether the line
/// count is exact.
fn untracked_file(
    root: &Path,
    rel: &str,
    mut patch: Option<&mut Budget>,
    counter: &mut LineCounter,
) -> (ChangedFile, bool) {
    let with_patch = patch.is_some();
    let mut file = ChangedFile {
        path: rel.to_string(),
        old_path: None,
        status: ChangeStatus::Untracked,
        unmerged: None,
        additions: 0,
        deletions: 0,
        binary: false,
        patch: with_patch.then(String::new),
        patch_truncated: with_patch.then_some(false),
    };
    let full = root.join(rel);
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        // Vanished between ls-files and now.
        return (file, true);
    };
    let header = |mode: &str| format!("diff --git a/{rel} b/{rel}\nnew file mode {mode}\n");
    let mut buf = PatchBuf::default();
    let mut counted = true;
    if meta.file_type().is_symlink() {
        file.additions = 1;
        if let Some(budget) = patch.as_deref_mut() {
            let target = std::fs::read_link(&full)
                .map(|t| t.to_string_lossy().into_owned())
                .unwrap_or_default();
            let text = format!(
                "{}--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1 @@\n+{target}\n\\ No newline at end of file\n",
                header("120000")
            );
            push_lines(budget, &mut buf, text.as_bytes());
        }
    } else if meta.is_file() {
        let keep = patch.as_deref().map_or(0, |budget| budget.per_file);
        let limit = counter.per_file.min(counter.left);
        // Unreadable (permissions, vanished): listed without a patch.
        if let Ok(content) = read_untracked(&full, keep, limit, counter.deadline) {
            counter.left = counter.left.saturating_sub(content.read);
            counted = content.complete;
            file.binary = content.binary;
            file.additions = content.lines;
            if let Some(budget) = patch {
                untracked_patch(budget, &mut buf, rel, file_mode(&meta), &content);
            }
        }
    }
    // A directory here is an untracked nested repository: listed, no patch.
    if with_patch {
        file.patch = Some(String::from_utf8_lossy(&buf.bytes).into_owned());
        file.patch_truncated = Some(buf.truncated);
    }
    (file, counted)
}

fn untracked_patch(
    budget: &mut Budget,
    buf: &mut PatchBuf,
    rel: &str,
    mode: &str,
    content: &UntrackedContent,
) {
    let header = format!("diff --git a/{rel} b/{rel}\nnew file mode {mode}\n");
    if content.binary {
        let text = format!("{header}Binary files /dev/null and b/{rel} differ\n");
        push_lines(budget, buf, text.as_bytes());
        return;
    }
    // git prints neither file header nor hunk for an empty file.
    if content.lines > 0 {
        let range = if content.lines == 1 {
            "+1".to_string()
        } else {
            format!("+1,{}", content.lines)
        };
        let text = format!("{header}--- /dev/null\n+++ b/{rel}\n@@ -0,0 {range} @@\n");
        push_lines(budget, buf, text.as_bytes());
    } else {
        push_lines(budget, buf, header.as_bytes());
    }
    let mut body = content.head.as_slice();
    if content.head_partial {
        // Never end on half a line.
        let keep = body.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        body = &body[..keep];
    }
    for line in body.split_inclusive(|b| *b == b'\n') {
        let mut out = Vec::with_capacity(line.len() + 1);
        out.push(b'+');
        out.extend_from_slice(line);
        if !line.ends_with(b"\n") {
            out.extend_from_slice(b"\n\\ No newline at end of file\n");
        }
        budget.push(buf, &out);
    }
    buf.truncated |= content.head_partial;
}

fn push_lines(budget: &mut Budget, buf: &mut PatchBuf, text: &[u8]) {
    for line in text.split_inclusive(|b| *b == b'\n') {
        budget.push(buf, line);
    }
}

struct UntrackedContent {
    binary: bool,
    /// Lines in the bytes read (a final line without `\n` counts only when
    /// the whole file was read); a lower bound unless `complete`.
    lines: u64,
    /// The first `keep` bytes, the most a capped patch can show.
    head: Vec<u8>,
    head_partial: bool,
    /// Bytes read, charged to the shared count budget.
    read: u64,
    /// The whole file was read, so `lines` is exact.
    complete: bool,
}

/// Count lines in at most `limit` bytes, keeping only the first `keep`, and
/// stop at the deadline: the count stays exact when only the patch is cut,
/// and is a lower bound (`complete: false`) only when the read is.
fn read_untracked(
    path: &Path,
    keep: usize,
    limit: u64,
    deadline: Instant,
) -> io::Result<UntrackedContent> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let mut chunk = vec![0u8; 64 * 1024];
    let mut head: Vec<u8> = Vec::new();
    let mut lines = 0u64;
    let mut seen = 0u64;
    let mut last = b'\n';
    let mut eof = false;
    while seen < limit && Instant::now() < deadline {
        let want = chunk
            .len()
            .min(usize::try_from(limit - seen).unwrap_or(usize::MAX));
        let n = f.read(&mut chunk[..want])?;
        if n == 0 {
            eof = true;
            break;
        }
        let data = &chunk[..n];
        if seen < BINARY_SNIFF as u64 {
            let sniff = (BINARY_SNIFF - seen as usize).min(n);
            if data[..sniff].contains(&0) {
                return Ok(UntrackedContent {
                    binary: true,
                    lines: 0,
                    head: Vec::new(),
                    head_partial: false,
                    read: seen + n as u64,
                    complete: true,
                });
            }
        }
        seen += n as u64;
        lines += data.iter().filter(|b| **b == b'\n').count() as u64;
        last = data[n - 1];
        if head.len() < keep {
            let take = (keep - head.len()).min(n);
            head.extend_from_slice(&data[..take]);
        }
    }
    // Stopping exactly at the length the file had when opened is a full read.
    let complete = eof || seen >= len;
    if complete && last != b'\n' {
        lines += 1;
    }
    Ok(UntrackedContent {
        binary: false,
        lines,
        head_partial: !complete || seen > head.len() as u64,
        head,
        read: seen,
        complete,
    })
}

fn file_mode(meta: &Metadata) -> &'static str {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            return "100755";
        }
    }
    #[cfg(not(unix))]
    let _ = meta;
    "100644"
}

// --- Output parsing ---------------------------------------------------------

/// NUL-separated git output. Lossy rather than skipping non-UTF-8 paths:
/// dropping a token would shift every later old/new pair onto the wrong file.
fn split_z(out: &[u8]) -> impl Iterator<Item = String> + '_ {
    out.split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
}

/// `--name-status -z`: `M\0path\0`, or `R086\0old\0new\0` for a rename.
fn parse_name_status(out: &[u8]) -> Vec<(ChangeStatus, Option<String>, String)> {
    let mut tokens = split_z(out);
    let mut entries = Vec::new();
    while let Some(code) = tokens.next() {
        let paired = code.starts_with('R') || code.starts_with('C');
        let first = tokens.next();
        let (old, path) = if paired {
            (first, tokens.next())
        } else {
            (None, first)
        };
        let Some(path) = path else { break };
        let status = match code.as_bytes()[0] {
            b'A' | b'C' => ChangeStatus::Added,
            b'D' => ChangeStatus::Deleted,
            b'R' => ChangeStatus::Renamed,
            // M, T (type change), U (unmerged) and anything newer.
            _ => ChangeStatus::Modified,
        };
        let old = if status == ChangeStatus::Renamed {
            old
        } else {
            None
        };
        entries.push((status, old, path));
    }
    entries
}

/// Porcelain v1 `-z` keeps arbitrary path whitespace and terminates renames
/// with a second (old-path) token. Only these seven XY pairs are unmerged.
fn parse_unmerged_status(out: &[u8]) -> HashMap<String, UnmergedStatus> {
    let mut tokens = split_z(out);
    let mut conflicts = HashMap::new();
    while let Some(record) = tokens.next() {
        let bytes = record.as_bytes();
        if bytes.len() < 4 || bytes[2] != b' ' {
            continue;
        }
        let state = match &bytes[..2] {
            b"DD" => Some(UnmergedStatus::DD),
            b"AU" => Some(UnmergedStatus::AU),
            b"UD" => Some(UnmergedStatus::UD),
            b"UA" => Some(UnmergedStatus::UA),
            b"DU" => Some(UnmergedStatus::DU),
            b"AA" => Some(UnmergedStatus::AA),
            b"UU" => Some(UnmergedStatus::UU),
            _ => None,
        };
        if let Some(state) = state {
            conflicts.insert(record[3..].to_string(), state);
        }
        if matches!(bytes[0], b'R' | b'C') || matches!(bytes[1], b'R' | b'C') {
            let _old_path = tokens.next();
        }
    }
    conflicts
}

#[derive(Default)]
struct NumStat {
    additions: u64,
    deletions: u64,
    binary: bool,
}

/// `--numstat -z`, keyed by (new) path: `adds\tdels\tpath\0`, or
/// `adds\tdels\t\0old\0new\0` for a rename; `-\t-` marks a binary file.
fn parse_numstat(out: &[u8]) -> HashMap<String, NumStat> {
    let mut tokens = split_z(out);
    let mut stats = HashMap::new();
    while let Some(record) = tokens.next() {
        let mut parts = record.splitn(3, '\t');
        let (Some(adds), Some(dels), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = tokens.next();
            match tokens.next() {
                Some(new) => new,
                None => break,
            }
        } else {
            path.to_string()
        };
        stats.insert(
            path,
            NumStat {
                additions: adds.parse().unwrap_or(0),
                deletions: dels.parse().unwrap_or(0),
                binary: adds == "-" && dels == "-",
            },
        );
    }
    stats
}

fn trim_line(out: &[u8]) -> String {
    String::from_utf8_lossy(out)
        .trim_end_matches(['\n', '\r'])
        .to_string()
}

fn git_failure(what: &str, stderr: &str) -> String {
    let detail = stderr
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if detail.is_empty() {
        format!("git {what} failed")
    } else {
        format!("git {what} failed: {detail}")
    }
}

// --- Running git ------------------------------------------------------------

fn git_command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    // Pin every config that changes the output format this module parses or
    // the phone renders: quoted non-ASCII paths, colour, prefixes, and a
    // `diff.relative` that would make paths relative to a subdirectory.
    for config in [
        "core.quotepath=off",
        "color.ui=false",
        "diff.noprefix=false",
        "diff.mnemonicPrefix=false",
        "diff.relative=false",
    ] {
        cmd.arg("-c").arg(config);
    }
    // GIT_OPTIONAL_LOCKS=0: a read must never take index.lock and collide
    // with the user's own git in the same repository. Inherited GIT_DIR and
    // friends would point git at some other repository entirely.
    cmd.env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A daemon without a console would otherwise flash a window per call.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

struct Output {
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
}

struct Finished {
    success: bool,
    stderr: String,
    timed_out: bool,
}

fn run(dir: &Path, args: &[&str], deadline: Instant) -> Result<Output, String> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    run_owned(dir, &owned, deadline)
}

/// Run git to completion, failing on the deadline: a half-read path list is
/// worse than an error.
fn run_owned(dir: &Path, args: &[String], deadline: Instant) -> Result<Output, String> {
    let mut stdout = Vec::new();
    let finished = run_streaming(dir, args, deadline, |reader| {
        let _ = reader.read_to_end(&mut stdout);
        false
    })?;
    if finished.timed_out {
        return Err("git timed out".into());
    }
    Ok(Output {
        success: finished.success,
        stdout,
        stderr: finished.stderr,
    })
}

fn lock(child: &Mutex<Child>) -> MutexGuard<'_, Child> {
    child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Spawn git and hand its stdout to `consume`, which returns `true` to stop
/// early (git is then killed). A watchdog kills git when `deadline` passes;
/// that closes stdout, so `consume` can never block past it. stderr drains on
/// its own thread so a chatty git cannot fill the pipe and stall.
fn run_streaming(
    dir: &Path,
    args: &[String],
    deadline: Instant,
    consume: impl FnOnce(&mut BufReader<ChildStdout>) -> bool,
) -> Result<Finished, String> {
    let mut child = git_command(dir).args(args).spawn().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            "git is not installed on this computer".to_string()
        } else {
            format!("couldn't run git: {e}")
        }
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stderr_reader = thread::spawn(move || {
        let mut kept = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = (&mut pipe).take(STDERR_KEEP).read_to_end(&mut kept);
            let _ = io::copy(&mut pipe, &mut io::sink());
        }
        kept
    });
    let child = Arc::new(Mutex::new(child));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let watchdog = {
        let child = Arc::clone(&child);
        thread::spawn(move || {
            let wait = deadline.saturating_duration_since(Instant::now());
            match done_rx.recv_timeout(wait) {
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let _ = lock(&child).kill();
                    true
                }
                _ => false,
            }
        })
    };
    let stopped = match stdout {
        Some(pipe) => {
            let mut reader = BufReader::new(pipe);
            let stopped = consume(&mut reader);
            if stopped {
                let _ = lock(&child).kill();
            }
            stopped
        }
        None => false,
    };
    let _ = done_tx.send(());
    let timed_out = watchdog.join().unwrap_or(false);
    let status = lock(&child).wait();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(Finished {
        success: !stopped && !timed_out && status.is_ok_and(|s| s.success()),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("omp-git-changes-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A repository with one commit holding `files`.
    fn repo(name: &str, files: &[(&str, &[u8])]) -> PathBuf {
        let dir = scratch(name);
        git(&dir, &["init", "-q", "-b", "main"]);
        for (path, content) in files {
            fs::write(dir.join(path), content).unwrap();
        }
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "--allow-empty", "-m", "init"]);
        dir
    }

    fn file<'a>(changes: &'a Changes, path: &str) -> &'a ChangedFile {
        changes
            .files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("{path} missing from {:?}", changes.files))
    }

    fn patch(file: &ChangedFile) -> &str {
        file.patch.as_deref().expect("full mode carries a patch")
    }

    fn cut(file: &ChangedFile) -> bool {
        file.patch_truncated
            .expect("full mode carries patchTruncated")
    }

    /// keep.txt modified, gone.txt deleted, `git mv` rename, staged.txt
    /// added, fresh.txt untracked.
    fn every_kind(name: &str) -> PathBuf {
        let dir = repo(
            name,
            &[
                ("keep.txt", b"one\ntwo\nthree\n"),
                ("gone.txt", b"bye\n"),
                ("old name.txt", b"alpha\nbeta\ngamma\ndelta\n"),
            ],
        );
        fs::write(dir.join("keep.txt"), b"one\n2\nthree\nfour\n").unwrap();
        fs::remove_file(dir.join("gone.txt")).unwrap();
        git(&dir, &["mv", "old name.txt", "new name.txt"]);
        fs::write(dir.join("staged.txt"), b"s\n").unwrap();
        git(&dir, &["add", "staged.txt"]);
        fs::write(dir.join("fresh.txt"), b"a\nb").unwrap();
        dir
    }

    #[test]
    fn unmerged_index_states_survive_marker_removal_until_staged() {
        use std::io::Write;

        let _env = crate::paths::testenv::with_tool_path();
        let states = [
            ("DD", UnmergedStatus::DD, &[1][..]),
            ("AU", UnmergedStatus::AU, &[2][..]),
            ("UD", UnmergedStatus::UD, &[1, 2][..]),
            ("UA", UnmergedStatus::UA, &[3][..]),
            ("DU", UnmergedStatus::DU, &[1, 3][..]),
            ("AA", UnmergedStatus::AA, &[2, 3][..]),
            ("UU", UnmergedStatus::UU, &[1, 2, 3][..]),
        ];
        let mut initial: Vec<(&str, &[u8])> = states
            .iter()
            .map(|(name, _, _)| (*name, &b"base\n"[..]))
            .collect();
        initial.push(("ordinary.txt", b"base\n"));
        let dir = repo("unmerged-states", &initial);
        let blob = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["rev-parse", "HEAD:ordinary.txt"])
            .output()
            .unwrap();
        assert!(blob.status.success());
        let blob = trim_line(&blob.stdout);
        let mut index = String::new();
        for (name, _, stages) in &states {
            index.push_str(&format!("0 {}\t{name}\n", "0".repeat(blob.len())));
            for stage in *stages {
                index.push_str(&format!("100644 {blob} {stage}\t{name}\n"));
            }
        }
        let mut update = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["update-index", "--index-info"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        update
            .stdin
            .take()
            .unwrap()
            .write_all(index.as_bytes())
            .unwrap();
        assert!(update.wait().unwrap().success());
        // Marker-like text in an ordinary edit is not a conflict, while all
        // seven real index conflicts have marker-free worktree contents.
        fs::write(
            dir.join("ordinary.txt"),
            b"<<<<<<< literal\n=======\n>>>>>>> literal\n",
        )
        .unwrap();
        fs::remove_file(dir.join("DD")).unwrap();
        for mode in [Mode::Full, Mode::Summary] {
            let changes = collect(&dir, mode).unwrap();
            assert_eq!(changes.totals.files, 8);
            for (name, state, _) in &states {
                let entry = file(&changes, name);
                assert_eq!(entry.status, ChangeStatus::Conflicted, "{name}");
                assert_eq!(entry.unmerged, Some(*state), "{name}");
            }
            assert_eq!(
                file(&changes, "ordinary.txt").status,
                ChangeStatus::Modified
            );
            assert_eq!(file(&changes, "ordinary.txt").unmerged, None);
            if mode == Mode::Full {
                assert!(patch(file(&changes, "ordinary.txt")).contains("+<<<<<<< literal\n"));
            }
        }
        fs::write(dir.join("UU"), b"resolved without markers\n").unwrap();
        assert_eq!(
            file(&collect(&dir, Mode::Full).unwrap(), "UU").unmerged,
            Some(UnmergedStatus::UU)
        );
        git(&dir, &["add", "UU"]);
        let partly_resolved = collect(&dir, Mode::Full).unwrap();
        assert_eq!(file(&partly_resolved, "UU").status, ChangeStatus::Modified);
        assert_eq!(file(&partly_resolved, "UU").unmerged, None);
        assert_eq!(
            file(&partly_resolved, "AA").unmerged,
            Some(UnmergedStatus::AA)
        );
        git(&dir, &["add", "-A"]);
        let resolved = collect(&dir, Mode::Summary).unwrap();
        assert!(resolved.files.iter().all(|entry| entry.unmerged.is_none()));
        assert!(
            resolved
                .files
                .iter()
                .all(|entry| entry.status != ChangeStatus::Conflicted)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_every_kind_of_change() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = every_kind("kinds");
        let changes = collect(&dir, Mode::Full).unwrap();
        assert!(!changes.not_repo);
        assert!(!changes.truncated);
        assert_eq!(changes.branch.as_deref(), Some("main"));
        let root = PathBuf::from(changes.repo_root.as_deref().unwrap());
        assert_eq!(root.canonicalize().unwrap(), dir.canonicalize().unwrap());
        assert_eq!(changes.files.len(), 5, "{:?}", changes.files);

        let keep = file(&changes, "keep.txt");
        assert_eq!(keep.status, ChangeStatus::Modified);
        assert_eq!((keep.additions, keep.deletions), (2, 1));
        assert!(
            patch(keep).starts_with("diff --git a/keep.txt b/keep.txt\n"),
            "{}",
            patch(keep)
        );
        assert!(patch(keep).contains("\n-two\n+2\n"));
        assert!(!patch(keep).contains('\u{1b}'), "no colour codes");

        let gone = file(&changes, "gone.txt");
        assert_eq!(gone.status, ChangeStatus::Deleted);
        assert_eq!((gone.additions, gone.deletions), (0, 1));
        assert!(patch(gone).contains("-bye\n"));

        let renamed = file(&changes, "new name.txt");
        assert_eq!(renamed.status, ChangeStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("old name.txt"));
        assert!(patch(renamed).contains("rename from old name.txt"));

        let staged = file(&changes, "staged.txt");
        assert_eq!(staged.status, ChangeStatus::Added);
        assert_eq!(staged.additions, 1);

        let fresh = file(&changes, "fresh.txt");
        assert_eq!(fresh.status, ChangeStatus::Untracked);
        assert_eq!((fresh.additions, fresh.deletions), (2, 0));
        assert!(!fresh.binary);
        assert!(
            patch(fresh).contains("@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n"),
            "{}",
            patch(fresh)
        );

        // keep +2 −1, gone −1, staged +1, fresh +2; the pure rename adds nothing.
        assert_eq!(
            changes.totals,
            Totals {
                files: 5,
                additions: 5,
                deletions: 2
            }
        );

        let json = serde_json::to_value(&changes).unwrap();
        assert_eq!(json["notRepo"], false);
        assert_eq!(json["files"][0]["patchTruncated"], false);
        assert_eq!(
            json["totals"],
            serde_json::json!({"files": 5, "additions": 5, "deletions": 2})
        );
        let rows = json["files"].as_array().unwrap();
        assert!(rows.iter().any(|f| f["oldPath"] == "old name.txt"));
        assert!(rows.iter().any(|f| f["status"] == "untracked"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn summary_has_the_same_files_and_counts_without_patches() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = every_kind("summary");
        let full = collect(&dir, Mode::Full).unwrap();
        let summary = collect(&dir, Mode::Summary).unwrap();
        assert!(!summary.truncated);
        assert_eq!(summary.totals, full.totals);
        assert_eq!(summary.files.len(), full.files.len());
        for (s, f) in summary.files.iter().zip(&full.files) {
            assert_eq!(
                (
                    &s.path,
                    &s.old_path,
                    s.status,
                    s.additions,
                    s.deletions,
                    s.binary
                ),
                (
                    &f.path,
                    &f.old_path,
                    f.status,
                    f.additions,
                    f.deletions,
                    f.binary
                )
            );
            assert_eq!((&s.patch, s.patch_truncated), (&None, None));
        }
        let json = serde_json::to_value(&summary).unwrap();
        for row in json["files"].as_array().unwrap() {
            assert!(row.get("patch").is_none() && row.get("patchTruncated").is_none());
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn totals_cover_files_past_the_list_cap() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = repo("totals-cap", &[("a.txt", b"a\n"), ("b.txt", b"b\n")]);
        fs::write(dir.join("a.txt"), b"a\nA\n").unwrap();
        fs::write(dir.join("b.txt"), b"b\nB\nBB\n").unwrap();
        fs::write(dir.join("c.txt"), b"1\n2\n3\n").unwrap();
        for mode in [Mode::Full, Mode::Summary] {
            let limits = Limits {
                max_files: 1,
                ..Limits::for_mode(mode)
            };
            let changes = collect_with(&dir, &limits, mode).unwrap();
            assert_eq!(changes.files.len(), 1, "{mode:?}");
            assert!(changes.truncated, "{mode:?}");
            assert_eq!(
                changes.totals,
                Totals {
                    files: 3,
                    additions: 6,
                    deletions: 0
                },
                "{mode:?}"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn untracked_line_count_cap_is_a_lower_bound() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = repo("count-cap", &[]);
        fs::write(dir.join("big.log"), "line\n".repeat(1000)).unwrap();
        fs::write(dir.join("small.txt"), b"x\n").unwrap();
        let limits = Limits {
            count_per_file: 100,
            ..Limits::SUMMARY
        };
        let changes = collect_with(&dir, &limits, Mode::Summary).unwrap();
        assert!(changes.truncated);
        assert_eq!(file(&changes, "big.log").additions, 20);
        assert_eq!(file(&changes, "small.txt").additions, 1);

        // The shared budget runs dry: later files are listed, uncounted.
        let dry = Limits {
            count_total: 0,
            ..Limits::SUMMARY
        };
        let changes = collect_with(&dir, &dry, Mode::Summary).unwrap();
        assert!(changes.truncated);
        assert_eq!(changes.totals.files, 2);
        assert_eq!(changes.totals.additions, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn binary_files_have_no_line_counts() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = repo("binary", &[("blob.bin", b"\x00\x01\x02")]);
        fs::write(dir.join("blob.bin"), b"\x00\x01\x02\x03").unwrap();
        fs::write(dir.join("new.bin"), b"PNG\x00\x00data").unwrap();
        let changes = collect(&dir, Mode::Full).unwrap();
        let tracked = file(&changes, "blob.bin");
        assert!(tracked.binary);
        assert_eq!((tracked.additions, tracked.deletions), (0, 0));
        assert!(patch(tracked).contains("Binary files"));
        let untracked = file(&changes, "new.bin");
        assert!(untracked.binary);
        assert_eq!(untracked.additions, 0);
        assert!(patch(untracked).contains("Binary files /dev/null and b/new.bin differ"));
        let summary = collect(&dir, Mode::Summary).unwrap();
        assert!(file(&summary, "blob.bin").binary && file(&summary, "new.bin").binary);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn per_file_and_total_caps_truncate() {
        let _env = crate::paths::testenv::with_tool_path();
        let line = "x".repeat(99) + "\n";
        let big = line.repeat(50); // 5000 bytes, 50 lines
        let dir = repo("caps", &[("a.txt", b"seed\n"), ("b.txt", b"seed\n")]);
        fs::write(dir.join("a.txt"), &big).unwrap();
        fs::write(dir.join("b.txt"), &big).unwrap();
        fs::write(dir.join("c.txt"), &big).unwrap();
        let limits = Limits {
            per_file: 2000,
            total: 3000,
            max_files: 100,
            ..Limits::DEFAULT
        };
        let changes = collect_with(&dir, &limits, Mode::Full).unwrap();
        assert!(changes.truncated);
        let a = file(&changes, "a.txt");
        assert!(cut(a));
        assert!(patch(a).len() <= 2000 && !patch(a).is_empty());
        assert!(patch(a).ends_with('\n'), "cut at a line boundary");
        assert_eq!(a.additions, 50, "counts stay exact when the patch is cut");
        let total: usize = changes.files.iter().map(|f| patch(f).len()).sum();
        assert!(total <= 3000, "total {total}");
        let c = file(&changes, "c.txt");
        assert!(cut(c));
        assert_eq!(c.additions, 50);

        let few = collect_with(
            &dir,
            &Limits {
                max_files: 1,
                ..limits
            },
            Mode::Full,
        )
        .unwrap();
        assert_eq!(few.files.len(), 1);
        assert!(few.truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn untracked_patch_is_capped_on_a_line_boundary() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = repo("untracked-cap", &[]);
        let body = "line\n".repeat(1000);
        fs::write(dir.join("long.txt"), &body).unwrap();
        let limits = Limits {
            per_file: 500,
            ..Limits::DEFAULT
        };
        let changes = collect_with(&dir, &limits, Mode::Full).unwrap();
        let long = file(&changes, "long.txt");
        assert_eq!(long.additions, 1000);
        assert!(cut(long));
        assert!(patch(long).len() <= 500);
        assert!(patch(long).ends_with("+line\n"));
        assert!(changes.truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn repository_without_commits_diffs_against_the_empty_tree() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = scratch("unborn");
        git(&dir, &["init", "-q", "-b", "trunk"]);
        fs::write(dir.join("staged.txt"), b"s\n").unwrap();
        git(&dir, &["add", "staged.txt"]);
        let changes = collect(&dir, Mode::Full).unwrap();
        assert_eq!(changes.branch.as_deref(), Some("trunk"));
        assert_eq!(file(&changes, "staged.txt").status, ChangeStatus::Added);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn not_a_repository_is_a_state_not_an_error() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = scratch("plain");
        let inside_checkout = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .unwrap()
            .status
            .success();
        if inside_checkout {
            // This machine's temp dir sits inside a repository: nothing here is
            // "not a repository", so there is nothing to observe.
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let changes = collect(&dir, Mode::Summary).unwrap();
        assert!(changes.not_repo);
        assert!(changes.files.is_empty());
        assert_eq!(changes.repo_root, None);
        assert_eq!(serde_json::to_value(&changes).unwrap()["notRepo"], true);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detached_head_has_no_branch() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = repo("detached", &[("a.txt", b"a\n")]);
        git(&dir, &["checkout", "-q", "--detach"]);
        let changes = collect(&dir, Mode::Full).unwrap();
        assert_eq!(changes.branch, None);
        assert!(changes.files.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn expired_budget_is_an_error_not_a_hang() {
        let _env = crate::paths::testenv::with_tool_path();
        let dir = repo("deadline", &[("a.txt", b"a\n")]);
        let limits = Limits {
            budget: Duration::ZERO,
            ..Limits::DEFAULT
        };
        for mode in [Mode::Full, Mode::Summary] {
            assert_eq!(
                collect_with(&dir, &limits, mode).unwrap_err(),
                "git timed out"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn capped_line_reader_drops_overflow_and_keeps_line_starts() {
        let mut reader = BufReader::with_capacity(4, &b"abcdefgh\nxy\n"[..]);
        let mut line = Vec::new();
        assert!(read_line_capped(&mut reader, &mut line, 3).unwrap());
        assert_eq!(line, b"abc");
        line.clear();
        assert!(read_line_capped(&mut reader, &mut line, 3).unwrap());
        assert_eq!(line, b"xy\n");
        line.clear();
        assert!(!read_line_capped(&mut reader, &mut line, 3).unwrap());
    }
}
