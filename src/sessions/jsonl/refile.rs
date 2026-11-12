//! Per-project session directories and the startup refile that moves sessions
//! stranded in the sessions root into their project's directory.

use super::*;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Lexically normalize a path the way Node's `path.resolve` does: make it
/// absolute (against the process cwd when relative), then collapse `.` and
/// `..` components and drop any trailing separator. No filesystem access, so
/// it never fails and never depends on what exists.
fn lexical_normalize(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(p)
    };
    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Mirrors omp's `resolveEquivalentPath` (pi-utils/dirs.ts): the real path
/// when it exists (symlinks resolved), else the lexically-normalized path.
/// Applied to cwd/home/temp exactly like omp does, so a symlinked project or
/// home directory files into the same directory the real omp uses.
fn resolve_equivalent(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| lexical_normalize(p))
}

/// Node `path.relative(root, path)` as a classification: `Some(rel)` when
/// `path` is `root` itself (rel is "") or strictly under it, `None`
/// otherwise. Component-wise, so a sibling that merely shares a string
/// prefix (`/home/u2` vs `/home/u`) is correctly NOT under the root.
fn relative_within(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().into_owned())
}

/// `encodeRelativeSessionDirName` (session-paths.ts): every `/`, `\` and `:`
/// becomes `-`; an empty relative path yields the bare prefix (`-` for
/// `$HOME` itself, `-tmp` for the temp dir itself); otherwise the prefix and
/// the encoded relative path join with a single `-`.
fn encode_relative(prefix: &str, rel: &str) -> String {
    let encoded: String = rel
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .collect();
    if encoded.is_empty() {
        prefix.to_string()
    } else if prefix.ends_with('-') {
        format!("{prefix}{encoded}")
    } else {
        format!("{prefix}-{encoded}")
    }
}

/// `encodeLegacyAbsoluteSessionDirName` (session-paths.ts): strip the leading
/// separator, encode `/`, `\` and `:` as `-`, wrap in `--…--`.
fn encode_absolute(cwd: &Path) -> String {
    let s = cwd.to_string_lossy();
    let stripped = s
        .strip_prefix('/')
        .or_else(|| s.strip_prefix('\\'))
        .unwrap_or(&s);
    let encoded: String = stripped
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .collect();
    format!("--{encoded}--")
}

/// The per-project session directory NAME for `cwd`, mirroring omp's
/// `getDefaultSessionDirName` (packages/coding-agent/src/session/session-paths.ts)
/// exactly: resolve the cwd, then classify by location —
///
/// - under `$HOME` (or `$HOME` itself): `-` + home-relative path encoded;
/// - else under the temp dir (or the temp dir itself): `-tmp-` + encoded;
/// - else: `--` + encoded absolute path + `--`.
///
/// `home`/`temp` are injected so tests are machine-independent; production
/// callers go through [`project_session_dir`], which passes the real
/// `std::env::temp_dir()`.
fn project_dir_name(cwd: &str, home: &Path, temp: &Path) -> String {
    let resolved = resolve_equivalent(Path::new(cwd));
    let home_norm = resolve_equivalent(home);
    let temp_norm = resolve_equivalent(temp);
    if let Some(rel) = relative_within(&home_norm, &resolved) {
        encode_relative("-", &rel)
    } else if let Some(rel) = relative_within(&temp_norm, &resolved) {
        encode_relative("-tmp", &rel)
    } else {
        encode_absolute(&resolved)
    }
}

/// The directory a session for `cwd` must be filed under, inside the sessions
/// root. Mirrors omp's own per-project directory naming so the daemon's
/// phone-created sessions land where BOTH surfaces list sessions:
/// `scan_sessions` (this module) recurses exactly one level and omp's listing
/// globs `*/*.jsonl`. The old code passed the sessions ROOT as `--session-dir`
/// (see `ChildManager::spawn`), which parked every new session directly at the
/// root where both lister hide them — measured: 87 real sessions stranded,
/// largest 8.5 MB, invisible to the phone and to `omp resume`.
pub fn project_session_dir(sessions_root: &Path, cwd: &str, home: &Path) -> PathBuf {
    sessions_root.join(project_dir_name(cwd, home, &std::env::temp_dir()))
}

/// One root-level session file the startup refile chose to leave in place,
/// with why. A skip is a deliberate safety stop, never an error.
#[derive(Debug, Clone)]
pub struct RefileSkip {
    pub path: PathBuf,
    pub reason: String,
}

/// Outcome of [`refile_root_sessions`]: how many root-level session files
/// were moved into their per-project directories, and which were left with
/// their reasons.
#[derive(Debug, Clone, Default)]
pub struct RefileReport {
    pub moved: usize,
    pub skipped: usize,
    pub skips: Vec<RefileSkip>,
}

/// What to do with one root-level session file.
enum RefileDecision {
    /// Move it to this destination.
    Move(PathBuf),
    /// Leave it; the reason is logged and reported.
    Skip(&'static str),
}

/// Decide the fate of one root-level `*.jsonl` file. Every safety rule lives
/// here so the real migration and the diagnostic dry run make the SAME
/// decisions:
///   - never move a file whose first 4096 bytes carry no session header;
///   - never overwrite an existing destination file;
///   - never move a file another process holds open (`/proc/*/fd` on Linux);
///   - never move into a directory that cannot be created (that check lives
///     at the move site, where the error is available).
fn refile_decision(
    sessions_root: &Path,
    home: &Path,
    src: &Path,
    held: &HashSet<PathBuf>,
) -> RefileDecision {
    let hdr = parse_header(src);
    // A session header (`id` — the same check scan_sessions uses to tell a
    // real session from a headerless scratch/sidecar file) is the proof this
    // is phone material. Files without one never move.
    let Some(_id) = hdr.id else {
        return RefileDecision::Skip("no session header in the first 4096 bytes");
    };
    let Some(cwd) = hdr.cwd else {
        return RefileDecision::Skip("session header carries no cwd to file by");
    };
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return RefileDecision::Skip("session header cwd is empty");
    }
    let dest =
        project_session_dir(sessions_root, cwd, home).join(src.file_name().unwrap_or_default());
    // A destination that already exists is somebody's data — a prior run, a
    // hand move, a rename collision. Never overwrite.
    if dest.exists() {
        return RefileDecision::Skip("destination file already exists");
    }
    // Moving a file another process has open strands that holder's next write
    // in a NEW file at the old path (omp writes by path), so the moved copy
    // would silently stop receiving turns. Leave the file where it is; the
    // next startup refile picks it up once the holder exits.
    if let Ok(canon) = src.canonicalize()
        && held.contains(&canon)
    {
        return RefileDecision::Skip("another process holds the file open (/proc/*/fd)");
    }
    RefileDecision::Move(dest)
}

/// Canonicalized paths of every file any OTHER process has open (Linux:
/// `/proc/*/fd` readlinks, which are already symlink-resolved). Own fds are
/// excluded — renaming a file we merely read is safe (POSIX keeps the inode
/// alive); the danger is a WRITER that keeps the old path and recreates the
/// file after we move it. One sweep serves every candidate (a per-file sweep
/// would repeat the whole /proc walk for each of the 87 stranded files).
/// On non-Linux platforms there is no /proc fd inspection, so this returns
/// the empty set and the held-open check is a documented no-op, not a
/// data-loss hole: the holder's next write recreates the file at the root
/// and the next startup refile picks it up.
fn open_fd_set() -> HashSet<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let mut out = HashSet::new();
        let Ok(procs) = fs::read_dir("/proc") else {
            return out;
        };
        let me = std::process::id();
        for proc in procs.flatten() {
            let name = proc.file_name();
            let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
                continue;
            };
            if pid == me {
                continue;
            }
            let Ok(fds) = fs::read_dir(proc.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                if let Ok(link) = fs::read_link(fd.path()) {
                    // fd links are already resolved; canonicalize defensively
                    // (relative links, bind mounts) and keep the set small.
                    if let Ok(c) = link.canonicalize() {
                        out.insert(c);
                    }
                }
            }
        }
        out
    }
    #[cfg(not(target_os = "linux"))]
    {
        HashSet::new()
    }
}

/// Root-level `*.jsonl` files whose first 4096 bytes carry a session header
/// (an `id`). These are real sessions stranded where every lister hides
/// them — the condition [`refile_root_sessions`] clears and the doctor check
/// counts.
pub fn stranded_root_sessions(sessions_root: &Path) -> Vec<PathBuf> {
    let Ok(ents) = fs::read_dir(sessions_root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in ents.flatten() {
        let Ok(ft) = ent.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        if !ent.file_name().to_string_lossy().ends_with(".jsonl") {
            continue;
        }
        if parse_header(&ent.path()).id.is_some() {
            out.push(ent.path());
        }
    }
    out
}

/// Startup refile: move every root-level session file into its per-project
/// directory (omp's own layout, see [`project_session_dir`]). Called once at
/// daemon startup, BEFORE the first listing is served.
///
/// WHY (measured): the daemon used to spawn children with
/// `--session-dir <sessions_root>`, which overrode omp's per-project
/// directory, so every phone-created session landed DIRECTLY at the sessions
/// root. Both surfaces hide root-level files — `scan_sessions` skips them and
/// omp's listing globs `*/*.jsonl` — so 87 real sessions (largest 8.5 MB)
/// became invisible to the phone AND to `omp resume`.
///
/// Idempotent: a moved file is no longer at the root, so a second run finds
/// nothing to do; a file skipped for a safety reason is skipped again with
/// the same reason. Files in subdirectories are already correctly filed and
/// are never touched. Every move and every skip is logged with its reason.
pub fn refile_root_sessions(sessions_root: &Path, home: &Path) -> RefileReport {
    let mut report = RefileReport::default();
    let ents = match fs::read_dir(sessions_root) {
        Ok(e) => e,
        Err(e) => {
            warn!(
                path = %sessions_root.display(),
                error = %e,
                "refile: cannot read sessions root"
            );
            return report;
        }
    };
    // Built on the first root-level session only: it readlink()s every fd
    // of every process (~75 ms of proot-trapped calls at phone boot), and
    // the root normally holds none.
    let mut held: Option<HashSet<PathBuf>> = None;
    for ent in ents.flatten() {
        let Ok(ft) = ent.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        if !ent.file_name().to_string_lossy().ends_with(".jsonl") {
            continue;
        }
        let src = ent.path();
        let held = held.get_or_insert_with(open_fd_set);
        match refile_decision(sessions_root, home, &src, held) {
            RefileDecision::Skip(reason) => {
                report.skipped += 1;
                report.skips.push(RefileSkip {
                    path: src.clone(),
                    reason: reason.to_string(),
                });
                warn!(
                    path = %src.display(),
                    reason,
                    "refile: leaving root session in place"
                );
            }
            RefileDecision::Move(dest) => {
                if let Some(dir) = dest.parent()
                    && let Err(e) = fs::create_dir_all(dir)
                {
                    report.skipped += 1;
                    report.skips.push(RefileSkip {
                        path: src.clone(),
                        reason: format!("cannot create destination directory: {e}"),
                    });
                    warn!(
                        path = %src.display(),
                        dest = %dest.display(),
                        error = %e,
                        "refile: cannot create destination directory"
                    );
                    continue;
                }
                match fs::rename(&src, &dest) {
                    Ok(()) => {
                        report.moved += 1;
                        info!(
                            path = %src.display(),
                            dest = %dest.display(),
                            "refile: moved root session into its project directory"
                        );
                    }
                    Err(e) => {
                        report.skipped += 1;
                        report.skips.push(RefileSkip {
                            path: src.clone(),
                            reason: format!("rename failed: {e}"),
                        });
                        warn!(
                            path = %src.display(),
                            dest = %dest.display(),
                            error = %e,
                            "refile: rename failed"
                        );
                    }
                }
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::jsonl::tests::scratch_dir;
    use crate::sessions::jsonl::tests::session_file;

    // Unix only: the inputs are POSIX paths, which gain a drive letter on
    // Windows. omp's encoding of Windows paths has no test.
    #[cfg(unix)]
    #[test]
    fn project_dir_name_mirrors_omp_encoding() {
        // Synthetic, non-existent roots: resolve_equivalent falls back to the
        // lexical path, so these assertions hold on any machine.
        let home = Path::new("/home/omp-test-user");
        let temp = Path::new("/tmp/omp-test-tmp");
        // A path under $HOME.
        assert_eq!(
            project_dir_name("/home/omp-test-user/Coding/App", home, temp),
            "-Coding-App"
        );
        // Deep under $HOME.
        assert_eq!(
            project_dir_name("/home/omp-test-user/a/b/c", home, temp),
            "-a-b-c"
        );
        // $HOME itself.
        assert_eq!(project_dir_name("/home/omp-test-user", home, temp), "-");
        // A path under the temp dir.
        assert_eq!(
            project_dir_name("/tmp/omp-test-tmp/pulse-smoke-proj", home, temp),
            "-tmp-pulse-smoke-proj"
        );
        // The temp dir itself.
        assert_eq!(project_dir_name("/tmp/omp-test-tmp", home, temp), "-tmp");
        // An absolute path outside both.
        assert_eq!(
            project_dir_name("/mnt/data/proj", home, temp),
            "--mnt-data-proj--"
        );
        // A path containing `:` (legal on POSIX) encodes the `:` as `-`.
        assert_eq!(
            project_dir_name("/home/omp-test-user/My:Proj", home, temp),
            "-My-Proj"
        );
        // A trailing-slash cwd normalizes before encoding.
        assert_eq!(
            project_dir_name("/home/omp-test-user/Coding/App/", home, temp),
            "-Coding-App"
        );
        // A sibling of $HOME is NOT under it.
        assert_eq!(
            project_dir_name("/home/omp-test-user2", home, temp),
            "--home-omp-test-user2--"
        );
        // `..` components collapse lexically.
        assert_eq!(
            project_dir_name("/home/omp-test-user/a/../b", home, temp),
            "-b"
        );
        // The observed real-store names (batch context) come out of this rule.
        assert_eq!(
            project_dir_name(
                "/home/somebody/Coding/App",
                Path::new("/home/somebody"),
                temp
            ),
            "-Coding-App"
        );
        assert_eq!(
            project_dir_name("/home/somebody/.omp", Path::new("/home/somebody"), temp),
            "-.omp"
        );
        // -tmp-pulse-smoke-proj is the observed name for /tmp/pulse-smoke-proj
        // under the REAL temp root; under the injected temp the same relative
        // shape encodes identically (covered above), and a cwd under the real
        // /tmp but OUTSIDE the injected temp is correctly NOT temp-scoped.
        assert_eq!(
            project_dir_name("/tmp/pulse-smoke-proj", home, temp),
            "--tmp-pulse-smoke-proj--"
        );
    }

    #[test]
    fn project_session_dir_joins_under_sessions_root() {
        // The public wrapper joins the encoded name under the sessions root and
        // uses the REAL temp dir; assert the composition, not the machine.
        let root = Path::new("/sessions");
        let home = Path::new("/home/omp-test-user");
        let cwd = "/home/omp-test-user/Coding/App";
        let expected = root.join(project_dir_name(cwd, home, &std::env::temp_dir()));
        assert_eq!(project_session_dir(root, cwd, home), expected);
    }

    #[test]
    fn refile_moves_stranded_session_into_project_dir_and_is_idempotent() {
        let root = scratch_dir("refile-move");
        let home = Path::new("/home/omp-test-user");
        let stranded = session_file(
            &root,
            "2026-01-01T00-00-00-000Z_abc.jsonl",
            "/home/omp-test-user/Coding/App",
        );
        // A file already in a per-project subdirectory is never touched.
        let nested_dir = root.join("-Other");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let nested = session_file(
            &nested_dir,
            "2026-01-02T00-00-00-000Z_def.jsonl",
            "/home/omp-test-user/Other",
        );

        let report = refile_root_sessions(&root, home);
        assert_eq!(report.moved, 1, "one stranded root session moves");
        assert_eq!(report.skipped, 0, "nothing else is skipped");
        assert!(report.skips.is_empty());
        // Moved into the per-project directory; the root no longer holds it.
        assert!(!stranded.exists());
        let dest = root.join("-Coding-App").join(stranded.file_name().unwrap());
        assert!(dest.exists(), "session landed in its project directory");
        assert!(nested.exists(), "correctly-filed sessions are untouched");

        // Idempotent: a second run has nothing left to do.
        let second = refile_root_sessions(&root, home);
        assert_eq!(second.moved, 0);
        assert_eq!(second.skipped, 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refile_never_moves_headerless_or_destless_files() {
        let root = scratch_dir("refile-skip");
        let home = Path::new("/home/omp-test-user");
        // No session header at all (scratch file).
        let scratch = root.join("2026-01-01T00-00-00-000Z_scratch.jsonl");
        std::fs::write(
            &scratch,
            "{\"type\":\"title\",\"id\":\"t0\",\"title\":\"scratch\"}\n",
        )
        .unwrap();
        // Session header with an id but NO cwd.
        let no_cwd = root.join("2026-01-02T00-00-00-000Z_nocwd.jsonl");
        std::fs::write(
            &no_cwd,
            "{\"type\":\"session\",\"version\":1,\"id\":\"nocwd\",\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n",
        )
        .unwrap();
        // A real session whose destination file ALREADY exists.
        let colliding = session_file(
            &root,
            "2026-01-03T00-00-00-000Z_collide.jsonl",
            "/home/omp-test-user/Coding/App",
        );
        let dest_dir = root.join("-Coding-App");
        std::fs::create_dir_all(&dest_dir).unwrap();
        std::fs::write(
            dest_dir.join(colliding.file_name().unwrap()),
            "existing data\n",
        )
        .unwrap();

        let report = refile_root_sessions(&root, home);
        assert_eq!(report.moved, 0, "nothing moves");
        assert_eq!(report.skipped, 3);
        assert!(scratch.exists(), "headerless scratch file stays");
        assert!(no_cwd.exists(), "no-cwd session stays");
        assert!(colliding.exists(), "colliding session stays");
        let reasons: Vec<&str> = report.skips.iter().map(|s| s.reason.as_str()).collect();
        assert!(reasons.contains(&"no session header in the first 4096 bytes"));
        assert!(reasons.contains(&"session header carries no cwd to file by"));
        assert!(reasons.contains(&"destination file already exists"));
        // The pre-existing destination was NOT overwritten.
        assert_eq!(
            std::fs::read_to_string(dest_dir.join(colliding.file_name().unwrap())).unwrap(),
            "existing data\n"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    // Linux only: open_fd_set reads /proc/*/fd; elsewhere the held-open check
    // is a documented no-op (see open_fd_set).
    #[cfg(target_os = "linux")]
    #[test]
    fn refile_skips_a_file_another_process_holds_open() {
        use std::process::{Command, Stdio};
        let root = scratch_dir("refile-held");
        let home = Path::new("/home/omp-test-user");
        let held = session_file(
            &root,
            "2026-01-01T00-00-00-000Z_held.jsonl",
            "/home/omp-test-user/Coding/App",
        );
        // A separate process (different pid) opens the file as its stdin and
        // stays alive; open_fd_set excludes OUR pid, so this is exactly the
        // live-writer shape the safety rule protects against. /bin/sleep is
        // absolute because parallel config tests remove PATH from the process
        // env while holding the global env lock — a PATH-resolved binary (or
        // a shell resolving `sleep` via PATH) would fail to exec inside that
        // window and the child would exit before open_fd_set sees its fd.
        let f = std::fs::File::open(&held).unwrap();
        let mut child = Command::new("/bin/sleep")
            .arg("3")
            .stdin(Stdio::from(f))
            .spawn()
            .unwrap();
        let held_set = open_fd_set();
        match refile_decision(&root, home, &held, &held_set) {
            RefileDecision::Skip(reason) => {
                assert_eq!(reason, "another process holds the file open (/proc/*/fd)")
            }
            RefileDecision::Move(_) => panic!("a file another process holds open must not move"),
        }
        let _ = child.wait();
        assert!(held.exists(), "the held file is never moved");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "diagnostic only: read-only dry run against a REAL sessions root; set OMP_PULSE_REFILE_DRY_RUN_ROOT (and optionally OMP_PULSE_REFILE_DRY_RUN_HOME)"]
    fn refile_real_store_dry_run() {
        let Some(root) = std::env::var("OMP_PULSE_REFILE_DRY_RUN_ROOT").ok() else {
            eprintln!("refile dry run: OMP_PULSE_REFILE_DRY_RUN_ROOT unset; doing nothing");
            return;
        };
        let root = PathBuf::from(root);
        assert!(
            root.is_dir(),
            "dry-run root is not a directory: {}",
            root.display()
        );
        let home = std::env::var("OMP_PULSE_REFILE_DRY_RUN_HOME")
            .map(PathBuf::from)
            .or_else(|_| std::env::var("HOME").map(PathBuf::from))
            .unwrap_or_else(|_| root.clone());
        let held = open_fd_set();
        let mut total = 0usize;
        let mut moved = 0usize;
        let mut skipped: Vec<(PathBuf, String)> = Vec::new();
        let Ok(ents) = fs::read_dir(&root) else {
            eprintln!("refile dry run: cannot read {}", root.display());
            return;
        };
        for ent in ents.flatten() {
            let Ok(ft) = ent.file_type() else { continue };
            if !ft.is_file() || !ent.file_name().to_string_lossy().ends_with(".jsonl") {
                continue;
            }
            total += 1;
            let src = ent.path();
            match refile_decision(&root, &home, &src, &held) {
                RefileDecision::Move(dest) => {
                    moved += 1;
                    println!("DRY MOVE {} -> {}", src.display(), dest.display());
                }
                RefileDecision::Skip(reason) => skipped.push((src, reason.to_string())),
            }
        }
        println!(
            "refile dry run: root={} root-level .jsonl={} would move={} would skip={}",
            root.display(),
            total,
            moved,
            skipped.len()
        );
        for (p, reason) in &skipped {
            println!("  SKIP {} — {}", p.display(), reason);
        }
        // Read-only guarantee: the dry run never relocates anything.
        assert_eq!(total, moved + skipped.len());
    }
}
