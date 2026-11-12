//! Session ownership sidecar.
//!
//! WHY this exists: the argv layer of `guard::foreign_session_owner` must
//! skip `omp --mode rpc`/`rpc-ui` processes (they are indistinguishable from our own
//! RPC children by argv alone), so a SECOND omp-pulse instance cannot see
//! that the first instance's RPC child owns a session file without inspecting
//! the kernel process table. Every time we spawn a child that will write a
//! session file we therefore declare ownership in a small JSON sidecar next
//! to the file (`<session>.owner`); any other instance reads it and refuses
//! to start a second writer for that session.
//!
//! The record is validated against the live process table on every read: a
//! crashed daemon's records evaporate when the pid dies, and pid reuse is
//! caught by comparing the process start time. Start time is obtained via
//! `sysinfo`, which works on Linux, macOS and Windows alike.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tracing::warn;

/// A declared owner of a session file, written next to it as `<session>.owner`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OwnerRecord {
    pub pid: i32,
    /// The declared process's start time in UNIX milliseconds, read from the
    /// live process at declaration time. sysinfo reports whole seconds, so
    /// this is always a multiple of 1000 and `lookup` can detect pid reuse by
    /// exact match.
    pub started_unix_ms: u64,
    /// What kind of writer declared (e.g. "rpc"); surfaced in refusal text.
    pub kind: String,
}

/// Declare that `pid` owns `session_path` by writing `<session>.owner`
/// atomically (temp file in the same directory, fsync, rename over).
///
/// A failure NEVER breaks the caller's operation: a warning is logged and
/// `Err` returned for diagnostics only — the argv and fd layers of the guard
/// still protect the session without the sidecar. Callers should treat the
/// result as informational.
pub fn declare(session_path: &str, pid: i32, kind: &str) -> Result<(), String> {
    let Some(started_ms) = process_start_ms(pid) else {
        let msg =
            format!("cannot read start time of pid {pid} to declare ownership of {session_path}");
        warn!(pid, "owner sidecar: {msg}");
        return Err(msg);
    };
    let rec = OwnerRecord {
        pid,
        started_unix_ms: started_ms,
        kind: kind.to_string(),
    };
    write_atomic(&owner_path_for(session_path), &rec)
}

/// Remove `<session>.owner`, but ONLY when the record names `pid`, so one
/// instance can never delete another instance's claim.
pub fn release(session_path: &str, pid: i32) {
    let owner_path = owner_path_for(session_path);
    let Some(rec) = read_record(&owner_path) else {
        return; // no record (or an unreadable one) — nothing to remove
    };
    if rec.pid != pid {
        return; // another process's claim — leave it alone
    }
    if let Err(e) = std::fs::remove_file(&owner_path) {
        warn!(
            path = %owner_path.display(),
            error = %e,
            "owner sidecar: release failed"
        );
    }
}

/// Live declared owner of `session_path`, or `None`. A record is ignored when
/// its pid no longer exists, or when the process's start time no longer
/// matches `started_unix_ms` (the pid was reused by a different process).
pub fn lookup(session_path: &str) -> Option<OwnerRecord> {
    let owner_path = owner_path_for(session_path);
    let rec = read_record(&owner_path)?;
    if !process_alive_as(rec.pid, rec.started_unix_ms) {
        return None;
    }
    Some(rec)
}

/// `<session>.owner`, next to the session file so the claim travels with it.
fn owner_path_for(session_path: &str) -> PathBuf {
    let mut s = session_path.to_owned();
    s.push_str(".owner");
    PathBuf::from(s)
}

fn read_record(owner_path: &Path) -> Option<OwnerRecord> {
    let raw = std::fs::read_to_string(owner_path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(rec) => Some(rec),
        Err(e) => {
            warn!(
                path = %owner_path.display(),
                error = %e,
                "owner sidecar: ignoring unreadable record"
            );
            None
        }
    }
}

/// True when a process with `pid` exists and its start time matches
/// `started_unix_ms`. When the start time cannot be determined the record is
/// treated as live: a false "stale" would let a second writer destroy the
/// session, while a false "live" only defers writes until the owner exits.
fn process_alive_as(pid: i32, started_unix_ms: u64) -> bool {
    let pid = Pid::from_u32(pid as u32);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    let Some(proc) = sys.process(pid) else {
        return false; // pid gone (daemon crashed, child exited)
    };
    let secs = proc.start_time();
    if secs == 0 {
        return true; // start time unknown — conservative (see doc above)
    }
    secs.saturating_mul(1000) == started_unix_ms
}

/// The declared process's start time in milliseconds. Retried briefly because
/// `declare` runs right after spawn and on some platforms the child may not
/// be visible to the process table for a few milliseconds.
fn process_start_ms(pid: i32) -> Option<u64> {
    let pid = Pid::from_u32(pid as u32);
    let mut sys = System::new();
    for attempt in 0..3 {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        if let Some(proc) = sys.process(pid) {
            let secs = proc.start_time();
            if secs != 0 {
                return Some(secs.saturating_mul(1000));
            }
        }
        if attempt < 2 {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    None
}

/// Write the record atomically: temp file in the same directory, fsync, then
/// rename over the target (atomic on POSIX; `std::fs::rename` uses
/// MOVEFILE_REPLACE_EXISTING on Windows). On failure the temp file is removed
/// and `Err` returned; a warning is logged here so callers may treat the
/// result as informational.
fn write_atomic(owner_path: &Path, rec: &OwnerRecord) -> Result<(), String> {
    use std::io::Write;
    let json =
        serde_json::to_vec(rec).map_err(|e| format!("owner sidecar: cannot serialize: {e}"))?;
    let mut tmp_name = owner_path.as_os_str().to_os_string();
    tmp_name.push(format!(".tmp{}", std::process::id()));
    let tmp = PathBuf::from(tmp_name);
    let write = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, owner_path)
    })();
    if let Err(e) = write {
        let _ = std::fs::remove_file(&tmp); // never leave a stale temp file
        let msg = format!("owner sidecar: cannot write {}: {e}", owner_path.display());
        warn!("{msg}");
        return Err(msg);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique-per-test temp file (tempfile is not a dependency; matches the
    /// collab.rs/doctor.rs precedent of temp_dir + unique tag).
    fn scratch(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "omp-pulse-owner-{}-{tag}.jsonl",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn owner_path(session: &str) -> String {
        format!("{session}.owner")
    }

    fn live_start_ms() -> u64 {
        let pid = Pid::from_u32(std::process::id());
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        sys.process(pid)
            .expect("our own process must be visible to sysinfo")
            .start_time()
            .saturating_mul(1000)
    }

    #[test]
    fn declare_writes_an_atomic_parseable_record() {
        let session = scratch("declare");
        let me = std::process::id() as i32;
        declare(&session, me, "rpc").expect("declaring our own live pid must succeed");
        let raw = std::fs::read_to_string(owner_path(&session)).unwrap();
        let rec: OwnerRecord = serde_json::from_str(&raw).unwrap();
        assert_eq!(rec.pid, me);
        assert_eq!(rec.kind, "rpc");
        // The stored start time is the live process's real start time, so a
        // later `lookup` can verify it by exact match.
        assert_eq!(rec.started_unix_ms, live_start_ms());
        // No temp file may be left behind by the atomic write (checked for
        // exactly this session's temp name so parallel tests cannot race it).
        assert!(
            !Path::new(&format!("{session}.owner.tmp{}", std::process::id())).exists(),
            "temp files must be cleaned up"
        );
        // Re-declaring replaces the record (rename over an existing file).
        declare(&session, me, "tui").unwrap();
        let rec2: OwnerRecord =
            serde_json::from_str(&std::fs::read_to_string(owner_path(&session)).unwrap()).unwrap();
        assert_eq!(rec2.kind, "tui");
        assert_eq!(rec2.started_unix_ms, rec.started_unix_ms);
        let _ = std::fs::remove_file(owner_path(&session));
    }

    #[test]
    fn lookup_ignores_a_record_whose_pid_is_gone() {
        let session = scratch("deadpid");
        // i32::MAX can never be a live pid on any supported platform.
        let rec = OwnerRecord {
            pid: i32::MAX,
            started_unix_ms: 1_700_000_000_000,
            kind: "rpc".into(),
        };
        std::fs::write(owner_path(&session), serde_json::to_vec(&rec).unwrap()).unwrap();
        assert!(
            lookup(&session).is_none(),
            "a dead pid must not be a live owner"
        );
        let _ = std::fs::remove_file(owner_path(&session));
    }

    #[test]
    fn lookup_ignores_a_record_whose_start_time_no_longer_matches() {
        let session = scratch("reused");
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        // Our own pid with a start time from yesterday is exactly what a
        // pid-reused record looks like to a reader.
        let rec = OwnerRecord {
            pid: std::process::id() as i32,
            started_unix_ms: now_ms - 86_400_000,
            kind: "rpc".into(),
        };
        std::fs::write(owner_path(&session), serde_json::to_vec(&rec).unwrap()).unwrap();
        assert!(
            lookup(&session).is_none(),
            "a mismatched start time must look like pid reuse"
        );
        let _ = std::fs::remove_file(owner_path(&session));
    }

    #[test]
    fn lookup_accepts_a_record_matching_our_live_pid() {
        let session = scratch("live");
        let me = std::process::id() as i32;
        declare(&session, me, "rpc").unwrap();
        let rec = lookup(&session).expect("our live declared record must resolve");
        assert_eq!(rec.pid, me);
        assert_eq!(rec.kind, "rpc");
        let _ = std::fs::remove_file(owner_path(&session));
    }

    #[test]
    fn lookup_ignores_a_corrupt_record() {
        let session = scratch("corrupt");
        std::fs::write(owner_path(&session), b"not json at all").unwrap();
        assert!(lookup(&session).is_none());
        let _ = std::fs::remove_file(owner_path(&session));
    }

    #[test]
    fn release_only_removes_the_matching_claim() {
        let session = scratch("release");
        let me = std::process::id() as i32;
        declare(&session, me, "rpc").unwrap();
        release(&session, me.wrapping_add(1)); // someone else's pid
        assert!(
            lookup(&session).is_some(),
            "a foreign claim must survive release"
        );
        release(&session, me);
        assert!(lookup(&session).is_none(), "our own claim must be removed");
        let _ = std::fs::remove_file(owner_path(&session));
    }

    #[test]
    fn declare_refuses_a_pid_with_no_start_time() {
        let session = scratch("dead");
        let err = declare(&session, i32::MAX, "rpc");
        assert!(
            err.is_err(),
            "declaring a dead pid must not produce a record"
        );
        assert!(!Path::new(&owner_path(&session)).exists());
    }
}
