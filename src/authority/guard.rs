//! Foreign-owner guard for session files.
//!
//! WHY this exists: the desktop `omp` TUI holds its session `.jsonl` file open
//! and rewrites the WHOLE file from its in-memory entry list on compaction,
//! `/move`, `/fork`, `/drop` and the exit/Ctrl-C flush (`session-manager.ts`
//! rewrite path in omp 17.2.15). It never re-reads the file mid-session and
//! takes no file lock, so entries appended by another process while the TUI is
//! live are silently DESTROYED at the next rewrite. omp is a packaged,
//! self-updating binary we cannot patch, so the daemon refuses to spawn an RPC
//! child that would write to a session file a foreign omp process holds open.
//!
//! Detection is layered, most reliable first, so every platform gets the
//! protection its kernel can provide (see `detection_capability`):
//!
//!  (a) sidecar — `owner::lookup`: our RPC children declare `<session>.owner`
//!      so a SECOND omp-pulse instance can recognise them without kernel
//!      process inspection (their argv is `omp --mode rpc-ui`, which layer (b)
//!      deliberately skips). Works on every platform.
//!  (b) argv — a `sysinfo` process sweep for an omp binary whose command line
//!      names this session (full path, or a session-id token of 8+ chars).
//!      Works on every platform.
//!  (c) open files — the process has the session file open. Linux reads
//!      `/proc/<pid>/fd`; macOS resolves fds through `libc::proc_pidinfo`
//!      (`PROC_PIDLISTFDS` + per-fd `proc_pidfdinfo`, same-user processes,
//!      no root needed, any error counts as "unknown" not "not an owner");
//!      Windows has no cheap equivalent, so the layer contributes nothing.
//!
//! Layer (c) exists because a freshly resumed TUI holds the file open before
//! it has written anything, so argv matching alone leaves a window: a session
//! chosen from INSIDE a running TUI (the picker, `/resume`) appears in no
//! process's argv, and only becomes visible to the fd layer. On Windows the
//! sidecar plus argv matching are the whole story.
//!
//! Synchronous and allocation-light: it runs rarely (only when a NEW writer
//! would be spawned) and the HTTP layer caches the verdict (`owner_cache_ms`).

use std::path::Path;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// A foreign process that looks like omp and has the session file open.
#[derive(Debug, Clone)]
pub struct ForeignOwner {
    pub pid: i32,
    /// argv rendered space-separated, truncated to at most 120 chars.
    pub cmdline: String,
}

/// The refusal text shared by `ChildManager::do_open` (the authoritative gate)
/// and the HTTP layer's up-front check on `/api/prompt`, so a client always
/// sees the same string. Starts with the stable machine-readable code
/// `session_owned_by_terminal` (no space) followed by `: ` and a short human
/// explanation including the foreign pid.
pub(crate) fn refusal_message(owner: &ForeignOwner) -> String {
    format!(
        "session_owned_by_terminal: session file is held open by another omp process (pid {}, {})",
        owner.pid, owner.cmdline
    )
}

/// What protection this build provides, for `doctor` to report honestly:
/// `"sidecar+argv+fd"` where the kernel allows fd inspection (Linux, macOS),
/// `"sidecar+argv"` where it does not (Windows and anything else).
pub fn detection_capability() -> &'static str {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        "sidecar+argv+fd"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        "sidecar+argv"
    }
}

/// Find the first foreign omp-like process that owns `session_path`, in layer
/// order (a) declared sidecar owner, (b) argv evidence, (c) open-fd evidence.
/// Skips our own pid and every pid in `our_pids` (the daemon's live RPC
/// children). Returns `None` when no such owner exists.
pub fn foreign_session_owner(session_path: &str, our_pids: &[i32]) -> Option<ForeignOwner> {
    let me = std::process::id() as i32;
    // Layer (a): a declared owner (typically another daemon's live RPC child)
    // whose pid is not ours. `owner::lookup` already rejects dead and reused
    // pids, so a hit here is a live foreign writer.
    if let Some(rec) = crate::authority::owner::lookup(session_path)
        && rec.pid != me
        && !our_pids.contains(&rec.pid)
    {
        return Some(ForeignOwner {
            pid: rec.pid,
            cmdline: cmdline_for(rec.pid, &rec.kind),
        });
    }
    // Layers (b) + (c): one sysinfo sweep, replacing the old /proc walk
    // (which only exists on Linux). exe() is refreshed too: when argv is
    // unreadable it still tells us whether the process is an omp binary,
    // which is enough to apply layer (c).
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_exe(UpdateKind::OnlyIfNotSet),
    );
    let target = Path::new(session_path);
    // Fully-resolved form of the target, computed ONCE before the pid loop:
    // fd links are already resolved, so this catches paths that differ from
    // the fd link only by symlinks.
    let canonical = std::fs::canonicalize(session_path).ok();

    for (pid, proc) in sys.processes() {
        let pid = pid.as_u32() as i32;
        if pid == me || our_pids.contains(&pid) {
            continue;
        }
        let Some(cmdline) = render_cmdline(proc.cmd()) else {
            // argv unavailable (raced exit, kernel thread, unreadable). The
            // executable path still classifies the binary, so layer (c) can
            // apply; layer (b) cannot — naming the session needs argv.
            let Some(exe) = proc.exe().and_then(|e| e.to_str()) else {
                continue;
            };
            if !looks_like_omp(exe) {
                continue;
            }
            if fd_evidence(pid, target, canonical.as_deref()) == Some(true) {
                return Some(ForeignOwner {
                    pid,
                    cmdline: truncate_120(exe),
                });
            }
            continue;
        };
        // A substring test on purpose: it covers `--mode rpc-ui` (our own
        // children) as well as plain `--mode rpc` hosts.
        if cmdline.contains("--mode rpc") || !looks_like_omp(&cmdline) {
            continue;
        }
        // Layer (b): the process was LAUNCHED for this session (`omp -r
        // <path>` or `--resume <id-prefix>`), so it owns the file's in-memory
        // copy even before its first write — and its eventual rewrite would
        // clobber us.
        if cmdline_references_session(&cmdline, session_path) {
            return Some(ForeignOwner {
                pid,
                cmdline: truncate_120(&cmdline),
            });
        }
        // Layer (c): open-fd evidence (best effort). `None` means "unknown"
        // (could not inspect) and contributes nothing — it must never be read
        // as "checked and clear".
        if fd_evidence(pid, target, canonical.as_deref()) == Some(true) {
            return Some(ForeignOwner {
                pid,
                cmdline: truncate_120(&cmdline),
            });
        }
    }
    None
}

/// Layer (c) per platform. `Some(true)` = open-fd evidence that the process
/// holds `target` (or its canonical form); `Some(false)` = inspected, does
/// not hold it; `None` = could not inspect ("unknown") — never a verdict.
fn fd_evidence(pid: i32, target: &Path, canonical: Option<&Path>) -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        Some(fd_holds_session(
            &format!("/proc/{pid}/fd"),
            target,
            canonical,
        ))
    }
    #[cfg(target_os = "macos")]
    {
        return macos_fds::holds(pid, target, canonical);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        // Windows (and anything else): no cheap cross-process fd enumeration —
        // /proc does not exist and a handle snapshot needs SeDebugPrivilege
        // for other processes. The sidecar plus argv matching are the whole
        // story there.
        let _ = (pid, target, canonical);
        None
    }
}

/// Best-effort argv for a declared owner, for the refusal message: the live
/// cmdline when readable (a second daemon's `omp --mode rpc-ui` child), else a
/// description from the record's kind.
fn cmdline_for(pid: i32, kind: &str) -> String {
    let pid = Pid::from_u32(pid as u32);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
    match sys.process(pid).and_then(|p| render_cmdline(p.cmd())) {
        Some(cmdline) => truncate_120(&cmdline),
        None => format!("<declared owner: {kind}>"),
    }
}

/// argv rendered space-separated and trimmed, exactly like the old
/// `/proc/<pid>/cmdline` reader (NUL separators became spaces).
fn render_cmdline(cmd: &[std::ffi::OsString]) -> Option<String> {
    let mut rendered = String::new();
    for (i, arg) in cmd.iter().enumerate() {
        if i > 0 {
            rendered.push(' ');
        }
        rendered.push_str(&arg.to_string_lossy());
    }
    let rendered = rendered.trim().to_string();
    if rendered.is_empty() {
        None
    } else {
        Some(rendered)
    }
}

/// True only when the EXECUTABLE is omp: argv[0]'s file stem is `omp` or
/// `omp_pulse`, or an interpreter (`bun`/`node`/`deno`) is running a script
/// whose stem is `omp`.
///
/// Precision matters here. A previous version accepted any cmdline containing
/// `/omp`, which every session path does (`…/.local/share/omp/sessions/…`) — so
/// a `curl` posting a session path in its JSON body was reported as the owning
/// omp process and writes were refused. Caught by a live probe; the rule is now
/// about the binary, never about arguments.
fn looks_like_omp(rendered: &str) -> bool {
    let mut argv = rendered.split_whitespace();
    let Some(argv0) = argv.next() else {
        return false;
    };
    let stem = |s: &str| {
        Path::new(s)
            .file_stem()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_string()
    };
    let exe = stem(argv0);
    if exe == "omp" || exe == "omp_pulse" {
        return true;
    }
    if matches!(exe.as_str(), "bun" | "node" | "deno") {
        // `bun /…/omp/index.js` — the SCRIPT is omp's entrypoint: its stem is
        // `omp`, or it lives in a directory named `omp`. Only argv[1] is
        // considered, never arbitrary arguments.
        return argv
            .next()
            .map(|a| {
                let p = Path::new(a);
                stem(a) == "omp"
                    || p.components()
                        .any(|c| c.as_os_str().to_str() == Some("omp"))
            })
            .unwrap_or(false);
    }
    false
}

/// True when this process's argv NAMES the session as an argument: a token that
/// IS the session path, or a session-id token/prefix of 8+ characters (what
/// `--resume` takes).
///
/// Tokens must match exactly. Substring matching flagged unrelated processes
/// that merely mention the path (an HTTP client posting `{"sessionPath":"…"}`),
/// which then blocked legitimate writes.
///
/// LIMITATION: this cannot see a session opened from inside a running TUI (the
/// picker, or `/resume`) before that TUI's first write — stock omp exposes no
/// registry, socket or state file naming the session a live TUI holds (verified
/// against 17.2.15). That window is covered by the fd layer as soon as it
/// writes.
fn cmdline_references_session(cmdline: &str, session_path: &str) -> bool {
    let Some(stem) = Path::new(session_path).file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    let id = stem.rsplit('_').next().unwrap_or(stem);
    cmdline.split_whitespace().any(|tok| {
        let tok = tok.trim_matches(|c: char| c == '"' || c == '\'' || c == ',');
        if tok == session_path {
            return true;
        }
        id.len() >= 8 && tok.len() >= 8 && (tok == id || id.starts_with(tok))
    })
}

/// True when any fd of the process resolves to `target` (or its canonical
/// form). IO errors are ignored — fds close and files move mid-scan.
#[cfg(target_os = "linux")]
fn fd_holds_session(fd_dir: &str, target: &Path, canonical: Option<&Path>) -> bool {
    let Ok(fds) = std::fs::read_dir(fd_dir) else {
        return false;
    };
    for fd in fds.flatten() {
        let Ok(link) = std::fs::read_link(fd.path()) else {
            continue;
        };
        if link == *target {
            return true;
        }
        if let Some(c) = canonical
            && link == *c
        {
            return true;
        }
    }
    false
}

/// Cap the stored cmdline at 120 chars without splitting a UTF-8 char.
fn truncate_120(s: &str) -> String {
    if s.len() <= 120 {
        return s.to_string();
    }
    let mut end = 120;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// macOS fd inspection: `libc::proc_pidinfo` with `PROC_PIDLISTFDS` lists a
/// same-user process's open fds (no root needed); each vnode fd is then
/// resolved to its path with `proc_pidfdinfo` and the companion
/// `PROC_PIDFDVNODEPATHINFO` flavor (present since macOS 10.15 — on older
/// macOS every call fails and the layer reports "unknown"). Any error counts
/// as "unknown", never as "not an owner": a false negative here would let a
/// second writer destroy the session, while "unknown" merely means this layer
/// contributes nothing for that process.
#[cfg(target_os = "macos")]
mod macos_fds {
    // The layout structs below exist only so the kernel can fill our buffer:
    // their fields are never read by Rust (only vip_path is), so the field
    // dead_code lint is noise here.
    #![allow(dead_code)]

    use std::ffi::{CStr, OsStr, c_char};
    use std::mem::size_of;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    /// MAXPATHLEN from sys/param.h.
    const MAXPATHLEN: usize = 1024;
    /// PROX_FDTYPE_VNODE from sys/proc_info.h — only vnode fds are files.
    const PROX_FDTYPE_VNODE: u32 = 1;
    /// Not declared by libc; from sys/proc_info.h.
    const PROC_PIDFDVNODEPATHINFO: libc::c_int = 2;
    /// Start at 64 fds and double on ENOMEM; a TUI's fd count is in the
    /// hundreds at most, so this almost never loops.
    const INITIAL_FD_CAP: usize = 64;
    const MAX_FD_CAP: usize = 65536;

    // The layout mirrors sys/proc_info.h exactly. Verified against the C
    // sizes compiled from the header: vnode_fdinfowithpath is 1200 bytes with
    // the path at offset 176; the asserts below lock that in at compile time.
    #[repr(C)]
    struct VinfoStat {
        vst_dev: u32,
        vst_mode: u16,
        vst_nlink: u16,
        vst_ino: u64,
        vst_uid: u32,
        vst_gid: u32,
        vst_atime: i64,
        vst_atimensec: i64,
        vst_mtime: i64,
        vst_mtimensec: i64,
        vst_ctime: i64,
        vst_ctimensec: i64,
        vst_birthtime: i64,
        vst_birthtimensec: i64,
        vst_size: i64,
        vst_blocks: i64,
        vst_blksize: i32,
        vst_flags: u32,
        vst_gen: u32,
        vst_rdev: u32,
        vst_qspare: [i64; 2],
    }
    #[repr(C)]
    struct Fsid {
        val: [i32; 2],
    }
    #[repr(C)]
    struct VnodeInfo {
        vi_stat: VinfoStat,
        vi_type: i32,
        vi_pad: i32,
        vi_fsid: Fsid,
    }
    #[repr(C)]
    struct VnodeInfoPath {
        vip_vi: VnodeInfo,
        vip_path: [c_char; MAXPATHLEN],
    }
    // Clone is required by the `vec![ProcFdinfo{..}; n]` buffer allocation below.
    // Without it this module does not compile for macOS at all, which a Linux
    // build cannot notice because the whole module is cfg'd out.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ProcFdinfo {
        proc_fd: i32,
        proc_fdtype: u32,
    }
    #[repr(C)]
    struct ProcFileinfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: i64,
        fi_type: i32,
        fi_guardflags: u32,
    }
    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileinfo,
        pvip: VnodeInfoPath,
    }

    // Compile-time lock on the kernel ABI layout (C-compiler-verified sizes).
    const _: () = {
        assert!(size_of::<ProcFdinfo>() == 8);
        assert!(size_of::<VnodeInfo>() == 152);
        assert!(size_of::<VnodeInfoPath>() == 1176);
        assert!(size_of::<ProcFileinfo>() == 24);
        assert!(size_of::<VnodeFdInfoWithPath>() == 1200);
    };

    pub(super) fn holds(pid: i32, target: &Path, canonical: Option<&Path>) -> Option<bool> {
        let fds = fd_list(pid)?;
        let mut all_known = true;
        for fd in fds {
            if fd.proc_fdtype != PROX_FDTYPE_VNODE {
                continue; // sockets, pipes, kqueues cannot be the session file
            }
            let Some(path) = fd_path(pid, fd.proc_fd) else {
                all_known = false; // a vnode fd we could not resolve — unknown
                continue;
            };
            if path == *target || canonical.is_some_and(|c| path == *c) {
                return Some(true);
            }
        }
        if all_known { Some(false) } else { None }
    }

    /// Enumerate the process's open fds. `None` = error (EPERM for another
    /// user's process, ESRCH after exit) or the fd count exceeded the cap.
    fn fd_list(pid: i32) -> Option<Vec<ProcFdinfo>> {
        let mut cap = INITIAL_FD_CAP;
        loop {
            let bytes = (cap * size_of::<ProcFdinfo>()) as libc::c_int;
            let mut buf = vec![
                ProcFdinfo {
                    proc_fd: 0,
                    proc_fdtype: 0
                };
                cap
            ];
            let n = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDLISTFDS,
                    0,
                    buf.as_mut_ptr() as *mut libc::c_void,
                    bytes,
                )
            };
            if n > 0 {
                buf.truncate(n as usize / size_of::<ProcFdinfo>());
                return Some(buf);
            }
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ENOMEM) && cap < MAX_FD_CAP {
                cap *= 2;
                continue;
            }
            return None; // ENOMEM past the cap, EPERM, ESRCH, or empty
        }
    }

    /// Resolve one fd to its path. `None` when the fd is not a resolvable
    /// file (or the platform is too old for the flavor).
    fn fd_path(pid: i32, fd: i32) -> Option<PathBuf> {
        let mut info: VnodeFdInfoWithPath = unsafe { std::mem::zeroed() };
        let n = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd,
                PROC_PIDFDVNODEPATHINFO,
                (&mut info as *mut VnodeFdInfoWithPath).cast::<libc::c_void>(),
                size_of::<VnodeFdInfoWithPath>() as libc::c_int,
            )
        };
        if n <= 0 {
            return None;
        }
        // The kernel writes a NUL-terminated path; guard against a full
        // buffer without a terminator anyway.
        let bytes = unsafe {
            std::slice::from_raw_parts(info.pvip.vip_path.as_ptr() as *const u8, MAXPATHLEN)
        };
        let cs = CStr::from_bytes_until_nul(bytes).ok()?;
        Some(PathBuf::from(OsStr::from_bytes(cs.to_bytes())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "/home/u/.local/share/omp/sessions/-proj/2026-08-12T09-37-00-155Z_019ff555-0efb-7000-afc5-1234567890ab.jsonl";

    /// The false positive that blocked a legitimate write in a live probe: an
    /// HTTP client posting the session path in a JSON body. Session paths
    /// contain "/omp/", so a substring rule flagged curl as the owning TUI.
    #[test]
    fn http_client_mentioning_the_path_is_not_an_owner() {
        let curl = format!(
            "curl -s -X POST -H Content-Type: application/json -d {{\"sessionPath\":\"{SESSION}\",\"text\":\"hi\"}}"
        );
        assert!(!looks_like_omp(&curl), "curl must not look like omp");
        // Even if the executable check passed, the reference must be a token.
        assert!(!cmdline_references_session(&curl, SESSION));
    }

    #[test]
    fn tools_reading_a_session_are_not_omp() {
        assert!(!looks_like_omp(&format!("grep -c message {SESSION}")));
        assert!(!looks_like_omp(&format!("tail -f {SESSION}")));
        assert!(!looks_like_omp(&format!("python3 /tmp/probe.py {SESSION}")));
        assert!(!looks_like_omp("/usr/bin/chromium --headless"));
    }

    #[test]
    fn interpreter_running_omp_is_omp() {
        assert!(looks_like_omp("bun /home/u/Coding/omp/index.js -r x"));
        assert!(!looks_like_omp("bun /home/u/other/script.js"));
    }

    /// A real `-r <path>` launch is still detected (the pre-write signal).
    #[test]
    fn resume_by_path_token_is_an_owner() {
        assert!(cmdline_references_session(
            &format!("/home/u/.bun/bin/omp -r {SESSION}"),
            SESSION
        ));
    }
    #[test]
    fn cmdline_with_full_session_path_is_an_owner() {
        assert!(cmdline_references_session(
            &format!("/home/u/.bun/bin/omp -r {SESSION}"),
            SESSION
        ));
    }

    #[test]
    fn cmdline_with_resume_id_prefix_is_an_owner() {
        // `omp --resume 019ff555` — the exact form the picker prints.
        assert!(cmdline_references_session("omp --resume 019ff555", SESSION));
        assert!(cmdline_references_session(
            "omp -r 019ff555-0efb-7000-afc5-1234567890ab",
            SESSION
        ));
    }

    #[test]
    fn quoted_resume_argument_is_an_owner() {
        assert!(cmdline_references_session(
            "omp -r \"019ff555-0efb\"",
            SESSION
        ));
    }

    #[test]
    fn unrelated_or_too_short_tokens_are_not_owners() {
        assert!(!cmdline_references_session("omp", SESSION));
        assert!(!cmdline_references_session("omp -r 019f", SESSION)); // < 8 chars
        assert!(!cmdline_references_session("omp -r 019ff999-dead", SESSION)); // different id
        assert!(!cmdline_references_session(
            "omp --mode rpc --cwd /home/u/proj --session-dir /home/u/.local/share/omp/sessions",
            SESSION
        ));
    }

    #[test]
    fn omp_detection_covers_real_launch_shapes() {
        assert!(looks_like_omp("omp"));
        assert!(looks_like_omp("/home/u/.bun/bin/omp -r x"));
        assert!(looks_like_omp(
            "/home/u/Coding/omp-pulse/target/release/omp_pulse term"
        ));
        assert!(!looks_like_omp("tail -f session.jsonl"));
        assert!(!looks_like_omp("nvim notes.md"));
    }

    // --- Portable-owner layers -------------------------------------------

    /// Unique-per-test temp session (tempfile is not a dependency; matches the
    /// collab.rs/doctor.rs precedent of temp_dir + unique tag).
    fn scratch(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "omp-pulse-guard-{}-{tag}.jsonl",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn detection_capability_matches_the_compiled_platform() {
        let cap = detection_capability();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert_eq!(cap, "sidecar+argv+fd");
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        assert_eq!(cap, "sidecar+argv");
    }

    /// A sidecar record naming OUR pid must never count as foreign, whether
    /// or not our pid is listed in `our_pids` (the `me` skip covers it).
    #[test]
    fn our_own_declared_pid_is_not_a_foreign_owner() {
        let session = scratch("ours");
        let me = std::process::id() as i32;
        crate::authority::owner::declare(&session, me, "rpc")
            .expect("declaring our own pid must succeed");
        assert!(
            foreign_session_owner(&session, &[me]).is_none(),
            "our declared pid in our_pids must be skipped"
        );
        assert!(
            foreign_session_owner(&session, &[]).is_none(),
            "our own pid must never be foreign, even outside our_pids"
        );
        let _ = std::fs::remove_file(format!("{session}.owner"));
    }

    /// A sidecar record whose pid is gone must not block: `owner::lookup`
    /// rejects it, and the guard falls through to the (empty) sweep.
    #[test]
    fn stale_declared_owner_is_ignored_by_the_guard() {
        let session = scratch("stale");
        let rec = crate::authority::owner::OwnerRecord {
            pid: i32::MAX, // can never be a live pid
            started_unix_ms: 1_700_000_000_000,
            kind: "rpc".into(),
        };
        std::fs::write(
            format!("{session}.owner"),
            serde_json::to_vec(&rec).unwrap(),
        )
        .unwrap();
        assert!(
            foreign_session_owner(&session, &[]).is_none(),
            "a dead declared owner must not refuse writes"
        );
        let _ = std::fs::remove_file(format!("{session}.owner"));
    }

    #[test]
    fn render_cmdline_matches_the_old_proc_format() {
        use std::ffi::OsString;
        let args = [
            OsString::from("omp"),
            OsString::from("-r"),
            OsString::from(SESSION),
        ];
        assert_eq!(render_cmdline(&args).unwrap(), format!("omp -r {SESSION}"));
        assert_eq!(render_cmdline(&[]), None);
    }
}
