//! Plugin sources: runs the host commands an enabled plugin declared and hands
//! back their latest output, so a sandboxed client script can show host data
//! without any other access to the machine.
//!
//! INVARIANT: bounded hot path. Nothing here runs on a timer. A command runs
//! only because a client asked for it and the cached reading was older than the
//! source's `interval_s`; concurrent askers share one run (single flight), at
//! most [`MAX_CONCURRENT_RUNS`] commands run at once daemon-wide, output is
//! capped at [`OUTPUT_CAP`] bytes and the cache holds at most [`CACHE_CAPACITY`]
//! readings. A phone that polls hard therefore cannot fork-bomb the computer.
//!
//! Commands are argv lists executed directly, never through a shell, so nothing
//! a client sends can reach a command line. Output is never logged. A command
//! inherits the daemon's environment minus the daemon's own credential, and
//! runs in its own process group so a timeout ends everything it started.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::{ChildStdout, Command};
use tokio::sync::Semaphore;

use super::registry::{self, PluginDirs, PluginError};

/// Most stdout bytes kept from one run.
const OUTPUT_CAP: usize = 65_536;
/// Source commands running at once, across every plugin.
const MAX_CONCURRENT_RUNS: usize = 4;
/// Readings kept. Editing a plugin changes its hash and so its keys; the old
/// readings age out of this bound rather than needing explicit invalidation.
const CACHE_CAPACITY: usize = 256;

pub(super) static RUNS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_RUNS);

/// plugin id + plugin hash + source id. The hash is in the key so an edited
/// (and re-approved) plugin never serves output produced by its old command.
type Key = (String, String, String);

struct Cached {
    reading: SourceReading,
    at: Instant,
}

/// One per key. The async mutex is held for the whole run: that is the single
/// flight, later callers wait on it and then find the fresh reading.
type Cell = Arc<tokio::sync::Mutex<Option<Cached>>>;

struct CacheEntry {
    cell: Cell,
    touched: Instant,
}

/// Guarded by a std mutex that is only ever held for map bookkeeping and never
/// across an `.await`: callers clone the `Cell` out, drop the guard, then await.
static CACHE: LazyLock<Mutex<HashMap<Key, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReading {
    /// The process started and exited 0 within the timeout.
    pub ok: bool,
    /// Stdout, lossy UTF-8, at most 65536 bytes.
    pub text: String,
    pub exit_code: Option<i32>,
    /// Unix ms when the command finished.
    pub fetched_at_ms: u64,
    pub truncated: bool,
    /// `timed out`, `could not start <argv0>: <os error>`, `exited with status N`, ...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Latest reading of one declared source of an ENABLED plugin. `NotFound`, `NotEnabled`
/// or `SourceNotFound` otherwise. Runs the command only when the cached reading is older
/// than `interval_s` (or absent); concurrent callers share one run.
pub async fn read_source(
    dirs: &PluginDirs,
    plugin_id: &str,
    source_id: &str,
) -> Result<SourceReading, PluginError> {
    let info = lookup_enabled(dirs, plugin_id).await?;
    let source = info
        .sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or(PluginError::SourceNotFound)?;

    let cell = cell_for((info.id.clone(), info.hash.clone(), source.id.clone()));
    let mut slot = cell.lock().await;
    if let Some(cached) = slot.as_ref()
        && cached.at.elapsed() < Duration::from_secs(source.interval_s)
    {
        return Ok(cached.reading.clone());
    }
    // Queueing for one of the daemon-wide slots is not part of the command's
    // own time budget, so the timeout starts only after the permit is held.
    let Ok(_permit) = RUNS.acquire().await else {
        return Err(PluginError::Io("source runner is shut down".to_owned()));
    };
    // The first check was made before waiting for the cache slot and the permit.
    // A plugin switched off (or edited) meanwhile must not get one last run:
    // require it to be enabled now with the hash this request started with.
    let current = lookup_enabled(dirs, plugin_id).await?;
    if current.hash != info.hash {
        return Err(PluginError::NotEnabled);
    }
    let reading = run(RunSpec {
        dir: &info.dir,
        plugin_id: &info.id,
        action_id: None,
        command: &source.command,
        timeout_s: source.timeout_s,
        omp_bin: dirs.omp_bin.as_deref(),
    })
    .await;
    // Failures are cached too: a broken command must not be re-run on every
    // request, or a polling client turns one bad plugin into a fork storm.
    *slot = Some(Cached {
        reading: reading.clone(),
        at: Instant::now(),
    });
    Ok(reading)
}

/// `registry::enabled`, off the async worker threads: it reads and hashes files.
pub(super) async fn lookup_enabled(
    dirs: &PluginDirs,
    id: &str,
) -> Result<registry::PluginInfo, PluginError> {
    let dirs = dirs.clone();
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || registry::enabled(&dirs, &id))
        .await
        .map_err(|e| PluginError::Io(format!("plugin lookup failed: {e}")))?
}

fn cell_for(key: Key) -> Cell {
    let mut map = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    if let Some(entry) = map.get_mut(&key) {
        entry.touched = now;
        return Arc::clone(&entry.cell);
    }
    if map.len() >= CACHE_CAPACITY {
        evict_one(&mut map);
    }
    let cell = Cell::default();
    map.insert(
        key,
        CacheEntry {
            cell: Arc::clone(&cell),
            touched: now,
        },
    );
    cell
}

/// Drop the least recently used entry nobody is waiting on; if every entry is
/// in use, the least recently used one anyway (its holders keep their `Arc`).
fn evict_one(map: &mut HashMap<Key, CacheEntry>) {
    let victim = map
        .iter()
        .filter(|(_, entry)| Arc::strong_count(&entry.cell) == 1)
        .min_by_key(|(_, entry)| entry.touched)
        .or_else(|| map.iter().min_by_key(|(_, entry)| entry.touched))
        .map(|(key, _)| key.clone());
    if let Some(key) = victim {
        map.remove(&key);
    }
}

/// Stdout kept so far; bytes past the cap are read and dropped.
#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

impl Capture {
    /// Read to EOF. Past the cap the pipe is still drained, so the command is
    /// not killed by a broken pipe and its real exit status is reported.
    async fn drain(&mut self, reader: &mut ChildStdout) -> std::io::Result<()> {
        let mut chunk = [0u8; 8192];
        loop {
            let n = reader.read(&mut chunk).await?;
            if n == 0 {
                return Ok(());
            }
            let take = n.min(OUTPUT_CAP - self.bytes.len());
            self.bytes.extend_from_slice(&chunk[..take]);
            if take < n {
                self.truncated = true;
            }
        }
    }

    /// Lossy text of at most [`OUTPUT_CAP`] bytes, never ending in half a character.
    fn into_text(mut self) -> (String, bool) {
        let mut truncated = self.truncated;
        if truncated
            && let Err(e) = std::str::from_utf8(&self.bytes)
            && e.error_len().is_none()
        {
            // The cap fell inside a multi-byte character: drop the fragment.
            self.bytes.truncate(e.valid_up_to());
        }
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        if text.len() > OUTPUT_CAP {
            // Invalid bytes become 3-byte replacement characters, which can overshoot.
            let mut cut = OUTPUT_CAP;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            truncated = true;
        }
        (text, truncated)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn failed(error: String) -> SourceReading {
    SourceReading {
        ok: false,
        text: String::new(),
        exit_code: None,
        fetched_at_ms: now_ms(),
        truncated: false,
        error: Some(error),
    }
}

fn finished(
    capture: Capture,
    ok: bool,
    exit_code: Option<i32>,
    error: Option<String>,
) -> SourceReading {
    let (text, truncated) = capture.into_text();
    SourceReading {
        ok,
        text,
        exit_code,
        fetched_at_ms: now_ms(),
        truncated,
        error,
    }
}

/// What to run. Sources and actions differ only in where their argv comes from,
/// so both go through [`run`].
pub(super) struct RunSpec<'a> {
    pub dir: &'a Path,
    pub plugin_id: &'a str,
    /// Set for an action: exported as `OMP_PULSE_PLUGIN_ACTION`.
    pub action_id: Option<&'a str>,
    pub command: &'a [String],
    pub timeout_s: u64,
    /// What the program name `omp` means, when the daemon knows its own omp.
    pub omp_bin: Option<&'a Path>,
}

/// Runs the command. The caller holds a [`RUNS`] permit; it is acquired there,
/// not here, so the plugin can be re-checked after the wait and before spawning.
pub(super) async fn run(spec: RunSpec<'_>) -> SourceReading {
    let Some((program, args)) = spec.command.split_first() else {
        return failed("source has no command".to_owned());
    };
    // WHY: a service's PATH often lacks the user's omp, but the daemon has
    // already resolved the omp it spawns itself. Only the bare name `omp` is
    // mapped; any other program, including a path to some other omp, runs as written.
    let executable = match spec.omp_bin {
        Some(bin) if program.as_str() == "omp" => bin.as_os_str(),
        _ => OsStr::new(program.as_str()),
    };
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(spec.dir)
        // The daemon's own bearer token when it was configured by environment
        // (the installed service reads a file instead). Source output reaches
        // every paired device, so a command must never see it.
        .env_remove("OMP_PULSE_TOKEN")
        .env_remove("OMP_REMOTE_TOKEN")
        .env("OMP_PULSE_PLUGIN_ID", spec.plugin_id)
        .env("OMP_PULSE_PLUGIN_DIR", spec.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Discarded rather than piped: nothing reads it, and an unread pipe
        // would stall a command that writes a lot to stderr.
        .stderr(Stdio::null())
        // A dropped request (client gone, daemon stopping) must not leave the command running.
        .kill_on_drop(true);
    // Its own process group, so `kill_tree` reaches what the command started: a
    // backgrounded grandchild holding stdout open outlived the timeout before.
    #[cfg(unix)]
    command.process_group(0);
    if let Some(action) = spec.action_id {
        command.env("OMP_PULSE_PLUGIN_ACTION", action);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return failed(format!("could not start {program}: {e}")),
    };
    let Some(mut stdout) = child.stdout.take() else {
        kill_tree(&mut child);
        return failed("could not capture output".to_owned());
    };

    let mut capture = Capture::default();
    let outcome = tokio::time::timeout(Duration::from_secs(spec.timeout_s), async {
        capture.drain(&mut stdout).await?;
        child.wait().await
    })
    .await;
    match outcome {
        Ok(Ok(status)) => {
            let error = if status.success() {
                None
            } else {
                Some(match status.code() {
                    Some(code) => format!("exited with status {code}"),
                    None => "stopped by a signal".to_owned(),
                })
            };
            finished(capture, status.success(), status.code(), error)
        }
        Ok(Err(e)) => {
            kill_tree(&mut child);
            finished(
                capture,
                false,
                None,
                Some(format!("could not read output: {e}")),
            )
        }
        Err(_elapsed) => {
            // Signal the kill but never wait for the exit: a process stuck in
            // uninterruptible sleep (`df` on a dead NFS mount) would never exit
            // and would pin a run permit and this cache slot forever. The child
            // is `kill_on_drop`, so tokio reaps it in the background.
            kill_tree(&mut child);
            finished(capture, false, None, Some("timed out".to_owned()))
        }
    }
}

/// SIGKILL the command's process group (Unix) and the command itself. On
/// other platforms only the command is killed; what it started exits when its
/// stdio closes.
fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
        // SAFETY: kill(2) takes plain integers and touches no memory.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    let _ = child.start_kill();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::testkit::{Scratch, install_default};
    use std::path::PathBuf;

    /// Install and enable a plugin whose only source `s` runs `command` (a TOML
    /// array literal). Every test passes its own `id`: the reading cache is
    /// process-wide and keyed by plugin id plus hash.
    fn enabled_plugin(
        scratch: &Scratch,
        id: &str,
        command: &str,
        extra: &str,
    ) -> (PluginDirs, PathBuf) {
        let dirs = scratch.dirs();
        let dir = install_default(
            &dirs,
            id,
            &format!("[[sources]]\nid = \"s\"\ncommand = {command}\n{extra}\n"),
        );
        let hash = registry::get(&dirs, id).unwrap().hash;
        registry::set_enabled(&dirs, id, true, Some(&hash)).unwrap();
        (dirs, dir)
    }

    #[tokio::test]
    async fn a_program_that_does_not_exist_is_a_failed_reading_naming_it() {
        let scratch = Scratch::new("src-missing");
        let (dirs, _) = enabled_plugin(
            &scratch,
            "src-missing",
            r#"["omp-pulse-no-such-program-xyz", "arg"]"#,
            "",
        );
        let reading = read_source(&dirs, "src-missing", "s").await.unwrap();
        assert!(!reading.ok);
        assert_eq!(reading.exit_code, None);
        assert!(reading.text.is_empty());
        let error = reading.error.unwrap();
        assert!(error.contains("omp-pulse-no-such-program-xyz"), "{error}");
        assert!(error.starts_with("could not start"), "{error}");
    }

    #[tokio::test]
    async fn only_enabled_plugins_and_declared_sources_can_be_read() {
        let scratch = Scratch::new("src-gate");
        let dirs = scratch.dirs();
        install_default(
            &dirs,
            "src-gate",
            "[[sources]]\nid = \"s\"\ncommand = [\"omp-pulse-no-such-program-xyz\"]\n",
        );
        assert!(matches!(
            read_source(&dirs, "src-gate", "s").await,
            Err(PluginError::NotEnabled)
        ));
        assert!(matches!(
            read_source(&dirs, "nobody", "s").await,
            Err(PluginError::NotFound)
        ));
        let hash = registry::get(&dirs, "src-gate").unwrap().hash;
        registry::set_enabled(&dirs, "src-gate", true, Some(&hash)).unwrap();
        assert!(matches!(
            read_source(&dirs, "src-gate", "other").await,
            Err(PluginError::SourceNotFound)
        ));
        registry::set_enabled(&dirs, "src-gate", false, None).unwrap();
        assert!(matches!(
            read_source(&dirs, "src-gate", "s").await,
            Err(PluginError::NotEnabled)
        ));
    }

    #[test]
    fn eviction_prefers_idle_entries_and_respects_the_bound() {
        let mut map: HashMap<Key, CacheEntry> = HashMap::new();
        let base = Instant::now();
        let busy = Cell::default();
        let busy_holder = Arc::clone(&busy);
        for i in 0..3u64 {
            let cell = if i == 0 {
                Arc::clone(&busy)
            } else {
                Cell::default()
            };
            map.insert(
                (format!("p{i}"), "h".to_owned(), "s".to_owned()),
                CacheEntry {
                    cell,
                    touched: base + Duration::from_secs(i),
                },
            );
        }
        // p0 is the oldest but in use (busy_holder + the map): the idle p1 goes instead.
        evict_one(&mut map);
        assert_eq!(map.len(), 2);
        assert!(map.contains_key(&("p0".to_owned(), "h".to_owned(), "s".to_owned())));
        assert!(!map.contains_key(&("p1".to_owned(), "h".to_owned(), "s".to_owned())));
        drop(busy_holder);
    }

    #[test]
    fn text_is_clamped_to_the_cap_without_splitting_a_character() {
        // 'é' is two bytes: a cap landing between them must drop the fragment.
        let capture = Capture {
            bytes: {
                let mut b = vec![b'a'; OUTPUT_CAP - 1];
                b.push(0xC3);
                b
            },
            truncated: true,
        };
        let (text, truncated) = capture.into_text();
        assert!(truncated);
        assert_eq!(text.len(), OUTPUT_CAP - 1);
        assert!(!text.contains('\u{fffd}'));

        // Invalid bytes expand to 3 bytes each when decoded lossily; still never over the cap.
        let capture = Capture {
            bytes: vec![0xFF; OUTPUT_CAP],
            truncated: true,
        };
        let (text, _) = capture.into_text();
        assert!(text.len() <= OUTPUT_CAP);
    }

    // The tests below run `sh`, so they are Unix-only.

    #[cfg(unix)]
    fn runs(dir: &Path) -> usize {
        std::fs::read_to_string(dir.join("runs.log"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_second_read_inside_the_interval_does_not_run_the_command_again() {
        // Other tests swap PATH under the env lock; hold it so `sh` stays findable.
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-cache");
        let (dirs, dir) = enabled_plugin(
            &scratch,
            "src-cache",
            r#"["sh", "-c", "echo run >> runs.log; echo hello"]"#,
            "interval_s = 3600",
        );
        let first = read_source(&dirs, "src-cache", "s").await.unwrap();
        assert!(first.ok, "{first:?}");
        assert_eq!(first.text, "hello\n");
        assert_eq!(first.exit_code, Some(0));
        assert!(first.error.is_none());
        let second = read_source(&dirs, "src-cache", "s").await.unwrap();
        assert_eq!(second.text, "hello\n");
        assert_eq!(second.fetched_at_ms, first.fetched_at_ms);
        assert_eq!(runs(&dir), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_expired_reading_is_fetched_again() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-expiry");
        let (dirs, dir) = enabled_plugin(
            &scratch,
            "src-expiry",
            r#"["sh", "-c", "echo run >> runs.log; echo hello"]"#,
            "interval_s = 2",
        );
        read_source(&dirs, "src-expiry", "s").await.unwrap();
        tokio::time::sleep(Duration::from_millis(2100)).await;
        read_source(&dirs, "src-expiry", "s").await.unwrap();
        assert_eq!(runs(&dir), 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_readers_share_one_run() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-flight");
        let (dirs, dir) = enabled_plugin(
            &scratch,
            "src-flight",
            r#"["sh", "-c", "echo run >> runs.log; sleep 1; echo done"]"#,
            "interval_s = 3600",
        );
        let (a, b, c, d) = tokio::join!(
            read_source(&dirs, "src-flight", "s"),
            read_source(&dirs, "src-flight", "s"),
            read_source(&dirs, "src-flight", "s"),
            read_source(&dirs, "src-flight", "s"),
        );
        for reading in [a, b, c, d] {
            assert_eq!(reading.unwrap().text, "done\n");
        }
        assert_eq!(runs(&dir), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_timeout_kills_a_command_that_sleeps() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-timeout");
        let (dirs, _) = enabled_plugin(
            &scratch,
            "src-timeout",
            r#"["sh", "-c", "echo before; exec sleep 30"]"#,
            "timeout_s = 1",
        );
        let started = Instant::now();
        let reading = read_source(&dirs, "src-timeout", "s").await.unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "did not stop at the timeout"
        );
        assert!(!reading.ok);
        assert_eq!(reading.error.as_deref(), Some("timed out"));
        assert_eq!(reading.exit_code, None);
        assert_eq!(reading.text, "before\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_over_the_cap_is_truncated_but_the_exit_status_still_counts() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-cap");
        let (dirs, _) = enabled_plugin(
            &scratch,
            "src-cap",
            r#"["sh", "-c", "yes aaaaaaaaa | head -c 200000"]"#,
            "",
        );
        let reading = read_source(&dirs, "src-cap", "s").await.unwrap();
        assert!(reading.ok, "{reading:?}");
        assert!(reading.truncated);
        assert_eq!(reading.text.len(), OUTPUT_CAP);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failing_command_reports_its_exit_code_and_partial_output() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-exit");
        let (dirs, _) = enabled_plugin(
            &scratch,
            "src-exit",
            r#"["sh", "-c", "echo partial; exit 3"]"#,
            "",
        );
        let reading = read_source(&dirs, "src-exit", "s").await.unwrap();
        assert!(!reading.ok);
        assert_eq!(reading.exit_code, Some(3));
        assert_eq!(reading.text, "partial\n");
        assert!(reading.error.unwrap().contains('3'));
        assert!(!reading.truncated);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_command_runs_in_the_plugin_folder_with_its_identity_in_the_environment() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-env");
        let (dirs, dir) = enabled_plugin(
            &scratch,
            "src-env",
            r#"["sh", "-c", "echo \"$OMP_PULSE_PLUGIN_ID $OMP_PULSE_PLUGIN_DIR\"; test -f client.js && echo cwd-ok"]"#,
            "",
        );
        let reading = read_source(&dirs, "src-env", "s").await.unwrap();
        assert_eq!(reading.text, format!("src-env {}\ncwd-ok\n", dir.display()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_never_sees_the_daemons_token() {
        let mut env = crate::paths::testenv::with_tool_path();
        env.set("OMP_PULSE_TOKEN", Some("secret-new"));
        env.set("OMP_REMOTE_TOKEN", Some("secret-legacy"));
        let scratch = Scratch::new("src-token");
        let (dirs, _) = enabled_plugin(
            &scratch,
            "src-token",
            r#"["sh", "-c", "echo \"[${OMP_PULSE_TOKEN-unset}][${OMP_REMOTE_TOKEN-unset}]\""]"#,
            "",
        );
        let reading = read_source(&dirs, "src-token", "s").await.unwrap();
        assert_eq!(reading.text, "[unset][unset]\n");
    }

    /// True once `pid` is gone or a zombie waiting for its reaper.
    #[cfg(target_os = "linux")]
    fn exited(pid: &str) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            // The state follows the parenthesised command name.
            Ok(stat) => stat
                .rsplit_once(')')
                .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
        }
    }

    // Linux only: it reads /proc to see whether the grandchild is still alive.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_timeout_also_kills_what_the_command_started() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-tree");
        // The shell exits at once; the backgrounded sleep keeps stdout open, so
        // the read only ends at the timeout (lab finding H8: it then lived on).
        let (dirs, dir) = enabled_plugin(
            &scratch,
            "src-tree",
            r#"["sh", "-c", "sleep 30 & echo $! > grandchild.pid; echo started"]"#,
            "timeout_s = 1",
        );
        let reading = read_source(&dirs, "src-tree", "s").await.unwrap();
        assert_eq!(reading.error.as_deref(), Some("timed out"));
        let pid = std::fs::read_to_string(dir.join("grandchild.pid")).unwrap();
        let pid = pid.trim();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !exited(pid) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            exited(pid),
            "the backgrounded sleep {pid} outlived the timeout"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_that_reads_stdin_sees_end_of_input() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-stdin");
        let (dirs, _) = enabled_plugin(
            &scratch,
            "src-stdin",
            r#"["sh", "-c", "cat; echo eof"]"#,
            "",
        );
        let reading = read_source(&dirs, "src-stdin", "s").await.unwrap();
        assert_eq!(reading.text, "eof\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_program_omp_means_the_daemons_own_omp_binary() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("src-omp");
        // `/bin/sh` stands in for omp, so nothing named `omp` has to exist on PATH.
        let (dirs, _) = enabled_plugin(
            &scratch,
            "src-omp",
            r#"["omp", "-c", "echo from-fake-omp"]"#,
            "",
        );
        let dirs = dirs.with_omp_bin(Some(std::path::PathBuf::from("/bin/sh")));
        let reading = read_source(&dirs, "src-omp", "s").await.unwrap();
        assert_eq!(reading.text, "from-fake-omp\n");
    }
}
