//! Platform-aware paths. Resolves every filesystem location
//! the daemon touches ONCE at startup: our own state follows the platform
//! convention (`directories`), while omp's session store follows omp's OWN
//! XDG rule on every OS — see [`omp_sessions_root`].

use std::path::{Path, PathBuf};

use directories::BaseDirs;

/// Every filesystem location the daemon uses, resolved once at startup.
#[derive(Debug, Clone)]
pub struct Paths {
    /// `<config_dir>/omp-pulse/config.toml`. `config_dir` is Linux
    /// `$XDG_CONFIG_HOME` else `~/.config`, macOS `~/Library/Application
    /// Support`, Windows `%APPDATA%`.
    pub config_file: PathBuf,
    /// Our own state: token, VAPID keys, push store, collab link registry,
    /// logs. Linux `$XDG_STATE_HOME/omp-pulse` else
    /// `~/.local/state/omp-pulse`; macOS `~/Library/Application
    /// Support/omp-pulse`; Windows `%APPDATA%\omp-pulse`.
    /// `OMP_PULSE_STATE_DIR` (legacy `OMP_REMOTE_STATE_DIR`) overrides it so
    /// an isolated instance (tests) can never touch the real one.
    pub state_dir: PathBuf,
    /// `<state_dir>/token` — the desktop-only owner credential.
    /// It is never sent to or embedded in phone pairing URLs.
    pub token_file: PathBuf,
    /// `<state_dir>/vapid.json` — web-push signing keys.
    pub vapid_file: PathBuf,
    /// `<state_dir>/push.json` — device-wide Web Push subscription store.
    pub push_file: PathBuf,
    /// `<state_dir>/collab.json` — the collab link registry.
    pub collab_file: PathBuf,
    /// `<state_dir>/logs` — daemon service logs.
    pub log_dir: PathBuf,
    /// Written by a running daemon so `doctor` and `pair` can find it whatever
    /// flags it was launched with.
    pub runtime_file: PathBuf,
    /// Plugins folder: `OMP_PULSE_PLUGINS_DIR` when set and non-empty, else
    /// `<config_dir>/omp-pulse/plugins` (a sibling of `config.toml`). It is
    /// NOT created by [`Paths::ensure_dirs`]: `plugin link` makes it on demand,
    /// so a machine that never uses plugins never gains an empty folder.
    pub plugins_dir: PathBuf,
    /// `<state_dir>/plugins.json` — per-plugin on/off decisions and approved hashes.
    pub plugins_state_file: PathBuf,
    /// omp's own session store (see [`omp_sessions_root`]).
    pub sessions_root: PathBuf,
    /// The user's home directory.
    pub home: PathBuf,
}

impl Paths {
    /// Resolve every path from the environment and platform conventions.
    /// Reads the environment AT CALL TIME (HOME/USERPROFILE, XDG_*,
    /// OMP_PULSE_STATE_DIR / legacy OMP_REMOTE_STATE_DIR), so a test or
    /// sandbox can point a temp HOME + XDG_* at a scratch tree and exercise
    /// exactly the same code path a fresh machine takes.
    ///
    /// Also performs the one-time legacy-state migration: the old daemon kept
    /// its state in `~/.omp`; if those files exist and the new location does
    /// not, they are COPIED across (one log line each, copy never clobbers),
    /// so an existing token keeps working — the author's live daemon and
    /// phone depend on that token continuing to work.
    pub fn resolve() -> Result<Paths, String> {
        let home = home_dir().ok_or_else(|| {
            "cannot determine home directory (set HOME or USERPROFILE)".to_string()
        })?;
        let base =
            BaseDirs::new().ok_or_else(|| "cannot determine base directories".to_string())?;
        let state_dir = state_dir_env().unwrap_or_else(|| platform_state_dir(&base));
        let paths = Paths {
            config_file: base.config_dir().join("omp-pulse").join("config.toml"),
            token_file: state_dir.join("token"),
            vapid_file: state_dir.join("vapid.json"),
            push_file: state_dir.join("push.json"),
            collab_file: state_dir.join("collab.json"),
            log_dir: state_dir.join("logs"),
            runtime_file: state_dir.join("daemon.json"),
            plugins_dir: env_nonempty("OMP_PULSE_PLUGINS_DIR")
                .unwrap_or_else(|| base.config_dir().join("omp-pulse").join("plugins")),
            plugins_state_file: state_dir.join("plugins.json"),
            sessions_root: omp_sessions_root(),
            state_dir,
            home,
        };
        migrate_legacy_state(&paths);
        Ok(paths)
    }

    /// Create every directory the daemon owns. Deliberately NOT omp's
    /// sessions root: omp creates that itself, and an empty dir we made here
    /// could shadow the real one.
    pub fn ensure_dirs(&self) -> Result<(), String> {
        let mut dirs = vec![self.state_dir.clone(), self.log_dir.clone()];
        if let Some(parent) = self.config_file.parent() {
            dirs.push(parent.to_path_buf());
        }
        for dir in dirs {
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        Ok(())
    }
}

/// Where omp itself keeps sessions. CRITICAL: omp uses the XDG rule on EVERY
/// platform (`XDG_DATA_HOME` else `~/.local/share`, verified in omp's
/// cli/commands/init-xdg.ts:13) — it does NOT use ~/Library or %APPDATA%. So
/// this MUST mirror omp, NOT platform convention, or we look in the wrong
/// place.
pub fn omp_sessions_root() -> PathBuf {
    let home = home_dir().unwrap_or_default();
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    data.join("omp").join("sessions")
}

/// omp's agent directory, resolved exactly as omp's `getAgentDir()` does: a
/// named profile (`OMP_PROFILE`/`PI_PROFILE`) puts it under
/// `<config root>/profiles/<name>/agent` and ignores `PI_CODING_AGENT_DIR`;
/// otherwise `PI_CODING_AGENT_DIR` wins, else `<config root>/agent`. The
/// config root is `PI_CONFIG_DIR` (relative to home) or `~/.omp`.
pub fn omp_agent_dir(home: &Path) -> Result<PathBuf, String> {
    omp_layout(home).map(|layout| layout.agent_dir)
}

/// Directories that may hold omp's content-addressed image blobs
/// (`blob:sha256:<hex>` in a session), newest layout first.
///
/// omp writes blobs to its DATA dir: `$XDG_DATA_HOME/omp` (per profile) when
/// that directory already exists and the agent dir is not overridden,
/// otherwise the agent dir itself — on a default install `~/.omp/agent/blobs`.
/// `/api/blob` used to read only `~/.local/share/omp/blobs`, where older omp
/// releases wrote; after omp moved them every image read in a chat 404'd and
/// the phone showed "Image could not be loaded" for files that existed. That
/// old directory stays as the second candidate so earlier sessions still load.
pub fn omp_blob_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::with_capacity(2);
    if let Ok(layout) = omp_layout(home) {
        dirs.push(layout.data_dir().join("blobs"));
    }
    let legacy = xdg_data_home(home).join("omp").join("blobs");
    if !dirs.contains(&legacy) {
        dirs.push(legacy);
    }
    dirs
}

struct OmpLayout {
    agent_dir: PathBuf,
    profile: Option<String>,
    /// `PI_CODING_AGENT_DIR` moved the agent dir away from its default; omp
    /// then keeps data beside it instead of under `XDG_DATA_HOME`.
    overridden: bool,
}

impl OmpLayout {
    fn data_dir(&self) -> PathBuf {
        if !self.overridden
            && let Some(xdg) = env_trimmed("XDG_DATA_HOME")
        {
            let mut dir = PathBuf::from(xdg).join("omp");
            if let Some(profile) = &self.profile {
                dir = dir.join("profiles").join(profile);
            }
            // omp only adopts the XDG dir when it already exists.
            if dir.is_dir() {
                return dir;
            }
        }
        self.agent_dir.clone()
    }
}

fn omp_layout(home: &Path) -> Result<OmpLayout, String> {
    let config_root = match env_trimmed("PI_CONFIG_DIR") {
        Some(raw) => {
            let path = PathBuf::from(raw);
            if path.is_absolute() {
                path
            } else {
                home.join(path)
            }
        }
        None => home.join(".omp"),
    };
    let profile = env_trimmed("OMP_PROFILE").or_else(|| env_trimmed("PI_PROFILE"));
    let profile = match profile.as_deref().map(str::trim) {
        None | Some("") | Some("default") => None,
        Some(profile) if is_valid_profile(profile) => Some(profile.to_owned()),
        Some(profile) => {
            return Err(format!(
                "invalid omp profile {profile:?}; expected lowercase letters, digits, '.', '_' or '-'"
            ));
        }
    };
    if let Some(profile) = profile {
        let agent_dir = config_root.join("profiles").join(&profile).join("agent");
        return Ok(OmpLayout {
            agent_dir,
            profile: Some(profile),
            overridden: false,
        });
    }
    let default_dir = config_root.join("agent");
    let agent_dir = match env_trimmed("PI_CODING_AGENT_DIR") {
        Some(raw) => make_absolute(PathBuf::from(raw))?,
        None => default_dir.clone(),
    };
    Ok(OmpLayout {
        overridden: agent_dir != default_dir,
        agent_dir,
        profile: None,
    })
}

fn xdg_data_home(home: &Path) -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"))
}

fn make_absolute(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path);
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .map_err(|e| format!("cannot resolve omp agent directory: {e}"))
}

fn env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn is_valid_profile(profile: &str) -> bool {
    profile.len() <= 64
        && profile
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && profile
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// The `omp` executable: `OMP_BIN` wins outright; otherwise every candidate on
/// PATH and in the two install directories is collected and the NEWEST VERSION
/// wins.
///
/// Directory order used to decide this, `~/.bun/bin` before `~/.local/bin`, and
/// that silently broke the service on a machine with both. A service started by
/// systemd has a minimal PATH that contains neither directory, so the fallback
/// ran and picked `~/.bun/bin/omp` (17.2.15) while the user's shell, and
/// therefore every manual test and the doctor's own check, picked
/// `~/.local/bin/omp` (17.3.3). The stale child exited the moment the daemon
/// negotiated, so the phone's command palette was empty and live turns died,
/// and every check I ran by hand passed. Version comparison is self-correcting:
/// whichever install the user updates most recently is the one that gets used.
pub fn find_omp_binary() -> Option<PathBuf> {
    if let Some(bin) = env_nonempty("OMP_BIN") {
        return Some(bin);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut push = |candidate: PathBuf| {
        if candidate.is_file() && !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            // Checking all three names on every platform is deliberate: the
            // extensionless `omp` is the unix name, `omp.cmd`/`omp.exe` the
            // Windows ones, and `is_file()` on a nonexistent path is free.
            for name in ["omp", "omp.cmd", "omp.exe"] {
                push(dir.join(name));
            }
        }
    }
    if let Some(home) = home_dir() {
        // The home-dir fallback needs the Windows names too, and needs them MORE
        // than the PATH search does: bun installs `omp.exe`/`omp.cmd` under
        // %USERPROFILE%\.bun\bin, and a service started by Task Scheduler often
        // has a narrower PATH than the shell the user tested in.
        for name in ["omp", "omp.cmd", "omp.exe"] {
            push(home.join(".bun").join("bin").join(name));
            push(home.join(".local").join("bin").join(name));
        }
    }
    if candidates.len() < 2 {
        return candidates.into_iter().next();
    }
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for candidate in candidates {
        let version = omp_version(&candidate).unwrap_or_default();
        let newer = match &best {
            None => true,
            Some((best_version, _)) => version > *best_version,
        };
        if newer {
            best = Some((version, candidate));
        }
    }
    best.map(|(_, path)| path)
}

/// `omp --version` as comparable numbers, e.g. `omp/17.3.3` -> `[17, 3, 3]`.
/// An empty vec sorts lowest, so a candidate that cannot report a version loses
/// to one that can but still beats nothing at all.
fn omp_version(bin: &std::path::Path) -> Option<Vec<u64>> {
    let out = std::process::Command::new(bin)
        .arg("--version")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let parts: Vec<u64> = digits
        .split('.')
        .filter_map(|p| p.parse::<u64>().ok())
        .collect();
    (!parts.is_empty()).then_some(parts)
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .or_else(|| BaseDirs::new().map(|b| b.home_dir().to_path_buf()))
}

fn env_nonempty(key: &str) -> Option<PathBuf> {
    std::env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn state_dir_env() -> Option<PathBuf> {
    env_nonempty("OMP_PULSE_STATE_DIR").or_else(|| env_nonempty("OMP_REMOTE_STATE_DIR"))
}

/// Our own state follows platform convention, NOT omp's XDG rule.
#[cfg(target_os = "linux")]
fn platform_state_dir(base: &BaseDirs) -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| base.home_dir().join(".local/state"))
        .join("omp-pulse")
}

/// macOS (`~/Library/Application Support/omp-pulse`) and Windows
/// (`%APPDATA%\omp-pulse`) both derive from the platform config base.
#[cfg(not(target_os = "linux"))]
fn platform_state_dir(base: &BaseDirs) -> PathBuf {
    base.config_dir().join("omp-pulse")
}

/// Copy legacy `~/.omp` state into the new location. Copy, never move: the
/// old files stay put, so the author's existing scripts, systemd unit and the
/// `term`/`doctor` paths that still read `~/.omp/omp-remote.token` keep
/// working. Copy is also idempotent — a second resolve is a no-op.
fn migrate_legacy_state(paths: &Paths) {
    let legacy_dir = paths.home.join(".omp");
    let pairs: [(&str, &Path); 4] = [
        ("omp-remote.token", paths.token_file.as_path()),
        ("omp-remote.push.json", paths.push_file.as_path()),
        ("omp-remote.vapid.json", paths.vapid_file.as_path()),
        ("omp-pulse.collab.json", paths.collab_file.as_path()),
    ];
    for (name, target) in pairs {
        let src = legacy_dir.join(name);
        if !src.is_file() || target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::copy(&src, target) {
            Ok(_) => tracing::info!(
                from = %src.display(),
                to = %target.display(),
                "migrated legacy state file"
            ),
            Err(e) => tracing::warn!(
                from = %src.display(),
                to = %target.display(),
                error = %e,
                "legacy state migration failed"
            ),
        }
    }
}

/// A fixture-friendly instance with every path under the system temp dir.
/// Test modules that construct `Config` literals (ws.rs, watcher.rs) can
/// fill the new `paths` field in one line: `Arc::new(Paths::default())`.
#[cfg(test)]
impl Default for Paths {
    fn default() -> Self {
        let base = std::env::temp_dir().join("omp-pulse-test-fixture");
        let _ = std::fs::create_dir_all(&base);
        Paths {
            config_file: base.join("config.toml"),
            state_dir: base.clone(),
            token_file: base.join("token"),
            vapid_file: base.join("vapid.json"),
            push_file: base.join("push.json"),
            collab_file: base.join("collab.json"),
            log_dir: base.join("logs"),
            runtime_file: base.join("daemon.json"),
            plugins_dir: base.join("plugins"),
            plugins_state_file: base.join("plugins.json"),
            sessions_root: base.join("sessions"),
            home: base,
        }
    }
}

#[cfg(test)]
pub(crate) mod testenv {
    //! Test helpers shared with types.rs tests: env vars are process-global
    //! and tests run in parallel, so every mutation takes this lock.
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard};

    pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Holds [`ENV_LOCK`] and puts every variable it changed back when it
    /// drops. Restoring matters: tests that empty `PATH` or move `HOME` used
    /// to leave them that way, so every later test in the process that spawned
    /// `git` or `mkfifo` by name failed with "program not found".
    #[must_use = "the environment is restored when the guard drops"]
    pub(crate) struct EnvGuard {
        saved: Vec<(String, Option<OsString>)>,
        _lock: MutexGuard<'static, ()>,
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // Reverse order: a key listed twice ends at its original value.
            for (key, value) in self.saved.drain(..).rev() {
                match value {
                    Some(v) => unsafe { std::env::set_var(&key, v) },
                    None => unsafe { std::env::remove_var(&key) },
                }
            }
        }
    }

    impl EnvGuard {
        /// Change one more variable under the lock this guard already holds
        /// (`set_env` would deadlock on it); it is restored with the rest.
        pub(crate) fn set(&mut self, key: &str, value: Option<&str>) {
            self.saved.push((key.to_string(), std::env::var_os(key)));
            match value {
                Some(v) => unsafe { std::env::set_var(key, v) },
                None => unsafe { std::env::remove_var(key) },
            }
        }
    }

    /// Set/remove env vars under the process-wide test lock until the guard
    /// drops. Each test still sets everything it depends on.
    /// Owned-value variant. Building a borrowed view over a freshly returned
    /// Vec drops the temporary while it is still in use, so helpers that
    /// construct their environment return owned strings and call this.
    /// Generic over the key so callers may pass `&'static str` names or owned
    /// `String`s. types.rs builds its baseline by sweeping the live environment,
    /// which yields `String` keys; requiring `&'static str` there would mean
    /// leaking every discovered name.
    pub(crate) fn set_env_owned<K: AsRef<str>>(kvs: &[(K, Option<String>)]) -> EnvGuard {
        let borrowed: Vec<(&str, Option<&str>)> = kvs
            .iter()
            .map(|(k, v)| (k.as_ref(), v.as_deref()))
            .collect();
        set_env(&borrowed)
    }

    /// External-tool fixtures hold the mutation lock so concurrent configuration
    /// tests cannot hide git or mkfifo with a temporary PATH override.
    pub(crate) fn with_tool_path() -> EnvGuard {
        set_env_owned(&[("PATH", Some(env!("PATH").to_owned()))])
    }

    pub(crate) fn set_env(kvs: &[(&str, Option<&str>)]) -> EnvGuard {
        let mut guard = EnvGuard {
            saved: Vec::with_capacity(kvs.len()),
            _lock: ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner()),
        };
        for (key, value) in kvs {
            guard.set(key, *value);
        }
        guard
    }

    /// A fresh scratch dir under the system temp dir (tests must not write
    /// anywhere else).
    pub(crate) fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("omp-pulse-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::testenv::scratch;
    use super::*;

    #[test]
    fn sessions_root_follows_xdg_rule_with_and_without_env() {
        let tmp = scratch("xdg");
        let home = tmp.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let _g = testenv::set_env(&[
            ("HOME", Some(home.to_str().unwrap())),
            ("XDG_DATA_HOME", None),
        ]);
        // No XDG_DATA_HOME -> ~/.local/share, exactly like omp.
        assert_eq!(omp_sessions_root(), home.join(".local/share/omp/sessions"));
        drop(_g);
        let data = tmp.join("data");
        let _g = testenv::set_env(&[
            ("HOME", Some(home.to_str().unwrap())),
            ("XDG_DATA_HOME", Some(data.to_str().unwrap())),
        ]);
        assert_eq!(omp_sessions_root(), data.join("omp/sessions"));
    }

    /// The "Image could not be loaded" bug: omp writes blobs to its agent dir
    /// unless `$XDG_DATA_HOME/omp` already exists, and the daemon only looked
    /// in `~/.local/share/omp/blobs`.
    #[test]
    fn blob_dirs_follow_omps_data_dir_and_keep_the_old_location() {
        let tmp = scratch("blobs");
        let home = tmp.join("home");
        let xdg = tmp.join("xdg-data");
        std::fs::create_dir_all(&home).unwrap();
        let home_s = home.to_string_lossy().into_owned();
        let env = |data: Option<String>, agent: Option<String>, profile: Option<&str>| {
            testenv::set_env_owned(&[
                ("HOME", Some(home_s.clone())),
                ("XDG_DATA_HOME", data),
                ("XDG_STATE_HOME", None),
                ("XDG_CONFIG_HOME", None),
                ("XDG_CACHE_HOME", None),
                ("PI_CODING_AGENT_DIR", agent),
                ("PI_CONFIG_DIR", None),
                ("OMP_PROFILE", profile.map(str::to_owned)),
                ("PI_PROFILE", None),
            ])
        };

        // Default install: the agent dir first, then the pre-move location.
        let g = env(None, None, None);
        assert_eq!(
            omp_blob_dirs(&home),
            vec![
                home.join(".omp/agent/blobs"),
                home.join(".local/share/omp/blobs")
            ]
        );
        drop(g);

        // XDG_DATA_HOME set but `<it>/omp` absent: omp still uses the agent dir.
        let xdg_s = xdg.to_string_lossy().into_owned();
        let g = env(Some(xdg_s.clone()), None, None);
        assert_eq!(
            omp_blob_dirs(&home),
            vec![home.join(".omp/agent/blobs"), xdg.join("omp/blobs")]
        );
        drop(g);

        // Once `<XDG_DATA_HOME>/omp` exists omp adopts it; no duplicate entry.
        std::fs::create_dir_all(xdg.join("omp")).unwrap();
        let g = env(Some(xdg_s.clone()), None, None);
        assert_eq!(omp_blob_dirs(&home), vec![xdg.join("omp/blobs")]);
        drop(g);

        // An overridden agent dir keeps its data beside it, XDG or not.
        let agent = tmp.join("agent");
        let g = env(
            Some(xdg_s.clone()),
            Some(agent.to_string_lossy().into_owned()),
            None,
        );
        assert_eq!(
            omp_blob_dirs(&home),
            vec![agent.join("blobs"), xdg.join("omp/blobs")]
        );
        drop(g);

        // A profile ignores the override and lives under its own XDG subdir.
        std::fs::create_dir_all(xdg.join("omp/profiles/work")).unwrap();
        let g = env(
            Some(xdg_s),
            Some(agent.to_string_lossy().into_owned()),
            Some("work"),
        );
        assert_eq!(
            omp_agent_dir(&home).unwrap(),
            home.join(".omp/profiles/work/agent")
        );
        assert_eq!(
            omp_blob_dirs(&home),
            vec![xdg.join("omp/profiles/work/blobs"), xdg.join("omp/blobs")]
        );
        drop(g);
    }

    #[test]
    fn migration_copies_legacy_state_once_and_never_clobbers() {
        let tmp = scratch("migrate");
        let home = tmp.join("home");
        let state = tmp.join("state");
        std::fs::create_dir_all(home.join(".omp")).unwrap();
        std::fs::write(home.join(".omp/omp-remote.token"), "legacy-token\n").unwrap();
        std::fs::write(home.join(".omp/omp-remote.push.json"), "{}").unwrap();
        std::fs::write(
            home.join(".omp/omp-remote.vapid.json"),
            "{\"publicKey\":\"x\"}",
        )
        .unwrap();
        std::fs::write(home.join(".omp/omp-pulse.collab.json"), "[]").unwrap();
        let _g = testenv::set_env(&[
            ("HOME", Some(home.to_str().unwrap())),
            ("USERPROFILE", None),
            ("XDG_DATA_HOME", None),
            ("XDG_STATE_HOME", None),
            ("XDG_CONFIG_HOME", None),
            ("OMP_PULSE_STATE_DIR", None),
            ("OMP_REMOTE_STATE_DIR", Some(state.to_str().unwrap())),
        ]);

        let paths = Paths::resolve().unwrap();
        // The state-dir env override is honoured.
        assert_eq!(paths.state_dir, state);
        // All four legacy files were copied to the new state dir.
        assert_eq!(
            std::fs::read_to_string(&paths.token_file).unwrap(),
            "legacy-token\n"
        );
        assert!(paths.vapid_file.is_file());
        assert!(paths.push_file.is_file());
        assert!(paths.collab_file.is_file());

        // A newer token that appeared at the target must never be clobbered.
        std::fs::write(&paths.token_file, "newer-token\n").unwrap();
        let paths2 = Paths::resolve().unwrap();
        assert_eq!(
            std::fs::read_to_string(&paths2.token_file).unwrap(),
            "newer-token\n"
        );

        // Nothing migrates when no legacy state exists.
        let empty_home = tmp.join("empty-home");
        std::fs::create_dir_all(&empty_home).unwrap();
        drop(_g);
        let _g = testenv::set_env(&[
            ("HOME", Some(empty_home.to_str().unwrap())),
            ("USERPROFILE", None),
            ("XDG_DATA_HOME", None),
            // XDG_STATE_HOME must be cleared too: leaving it set pointed the
            // resolver at the developer's REAL state dir, so this assertion
            // read a real token and failed for the wrong reason.
            ("XDG_STATE_HOME", None),
            ("XDG_CONFIG_HOME", None),
            ("OMP_REMOTE_STATE_DIR", None),
            ("OMP_PULSE_STATE_DIR", None),
        ]);
        let paths3 = Paths::resolve().unwrap();
        assert!(!paths3.token_file.exists());
    }

    #[test]
    fn omp_discovery_finds_windows_names_in_home_dirs() {
        // A Windows user's omp is `omp.exe` or `omp.cmd` under .bun\bin, and a
        // service's PATH often will not include it, so the home-dir fallback has
        // to know those names. Checking only `omp` reported "not found" while omp
        // worked in the user's own terminal.
        let tmp = scratch("ompnames");
        let home = tmp.join("home");
        std::fs::create_dir_all(home.join(".bun/bin")).unwrap();
        std::fs::write(home.join(".bun/bin/omp.cmd"), "@echo off\n").unwrap();
        let kvs = vec![
            ("HOME", Some(home.to_str().unwrap().to_string())),
            ("USERPROFILE", None),
            ("OMP_BIN", None),
            // An empty PATH forces the home-dir fallback, which is the branch
            // under test.
            ("PATH", Some(String::new())),
        ];
        let _g = testenv::set_env_owned(&kvs);
        let found = find_omp_binary().expect("omp.cmd in .bun/bin must be found");
        assert!(
            found.ends_with("omp.cmd"),
            "expected omp.cmd, got {}",
            found.display()
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_live_descriptor_is_not_stolen_or_deleted_by_another_process() {
        // Both halves of the ownership rule, because each was a real bug: a
        // second instance overwrote the live daemon's descriptor, and its
        // shutdown then deleted it, after which doctor probed the packaged
        // default and called a healthy daemon unreachable.
        let tmp = scratch("runtime");
        std::fs::create_dir_all(&tmp).unwrap();
        let paths = Paths {
            state_dir: tmp.clone(),
            runtime_file: tmp.join("daemon.json"),
            ..Paths::default()
        };

        let ours = std::process::id();
        let mine = RuntimeInfo {
            bind: "10.0.0.1".into(),
            port: 7681,
            pid: ours,
            version: "0.1.0".into(),
            build: "abc".into(),
        };
        write_runtime(&paths, &mine);
        assert_eq!(read_runtime(&paths).map(|r| r.port), Some(7681));

        // A different LIVE pid must not take the file over. Our own pid is the
        // only one guaranteed alive in a test, so the incumbent is us and the
        // challenger claims a different (dead) pid: the rule under test is
        // "leave a live incumbent alone", so use a challenger write and assert
        // the incumbent survived.
        let theirs = RuntimeInfo {
            bind: "10.0.0.2".into(),
            port: 7999,
            pid: u32::MAX,
            version: "0.1.0".into(),
            build: "abc".into(),
        };
        write_runtime(&paths, &theirs);
        assert_eq!(
            read_runtime(&paths).map(|r| r.port),
            Some(7681),
            "a live incumbent's descriptor must not be overwritten"
        );

        // Another process clearing must not remove our descriptor. Simulate by
        // writing a descriptor owned by a dead pid, then clearing as ourselves:
        // the file is not ours, so it must survive.
        std::fs::write(&paths.runtime_file, serde_json::to_vec(&theirs).unwrap()).unwrap();
        clear_runtime(&paths);
        assert!(
            paths.runtime_file.exists(),
            "clear_runtime must only remove a descriptor it owns"
        );

        // And our own is removed.
        write_runtime(&paths, &mine);
        clear_runtime(&paths);
        assert!(!paths.runtime_file.exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_omp_binary_prefers_env_then_home_dirs() {
        let tmp = scratch("bin");
        let home = tmp.join("home");
        std::fs::create_dir_all(home.join(".bun/bin")).unwrap();
        std::fs::write(home.join(".bun/bin/omp"), "#!/bin/sh\n").unwrap();
        let _g = testenv::set_env(&[
            ("HOME", Some(home.to_str().unwrap())),
            ("OMP_BIN", None),
            // No omp anywhere on PATH.
            ("PATH", Some(tmp.join("empty").to_str().unwrap())),
        ]);
        assert_eq!(find_omp_binary(), Some(home.join(".bun/bin/omp")));
        // ~/.local/bin/omp is checked after ~/.bun/bin/omp.
        drop(_g);
        let _g = testenv::set_env(&[
            ("HOME", Some(home.to_str().unwrap())),
            ("PATH", Some(tmp.join("empty").to_str().unwrap())),
            ("OMP_BIN", None),
        ]);
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        std::fs::remove_file(home.join(".bun/bin/omp")).unwrap();
        std::fs::write(home.join(".local/bin/omp"), "#!/bin/sh\n").unwrap();
        assert_eq!(find_omp_binary(), Some(home.join(".local/bin/omp")));
        // OMP_BIN wins even when the file does not exist: spawn fails loudly
        // later and `doctor` diagnoses it — a silent PATH fallback would hide
        // a wrong env setting.
        drop(_g);
        let _g = testenv::set_env(&[
            ("HOME", Some(home.to_str().unwrap())),
            ("PATH", Some(tmp.join("empty").to_str().unwrap())),
            ("OMP_BIN", Some("/definitely/not/omp")),
        ]);
        assert_eq!(
            find_omp_binary(),
            Some(PathBuf::from("/definitely/not/omp"))
        );
    }

    /// The bug this defends against cost hours: a machine with two installs, a
    /// service whose PATH contains neither, and a fallback that chose by
    /// DIRECTORY ORDER. The daemon spawned `~/.bun/bin/omp` 17.2.15 while every
    /// manual check, run from a shell whose PATH found `~/.local/bin/omp`
    /// 17.3.3, passed. Children died on negotiate, the command palette was
    /// empty, and nothing in the logs named a version.
    /// Unix only: the stubs are `#!/bin/sh` scripts, which Windows cannot run.
    #[cfg(unix)]
    #[test]
    fn newest_omp_version_wins_over_directory_order() {
        let tmp = scratch("ompver");
        let home = tmp.join("home");
        std::fs::create_dir_all(home.join(".bun/bin")).unwrap();
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        // Stubs that answer --version the way the real binary does. `.bun` is
        // checked first by the directory walk and must still LOSE.
        let stub = |path: &std::path::Path, version: &str| {
            std::fs::write(path, format!("#!/bin/sh\necho 'omp/{version}'\n")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        };
        stub(&home.join(".bun/bin/omp"), "17.2.15");
        stub(&home.join(".local/bin/omp"), "17.3.3");
        let _g = testenv::set_env(&[
            ("HOME", Some(home.to_str().unwrap())),
            ("OMP_BIN", None),
            ("PATH", Some(tmp.join("empty").to_str().unwrap())),
        ]);
        assert_eq!(
            find_omp_binary(),
            Some(home.join(".local/bin/omp")),
            "17.3.3 in .local must beat 17.2.15 in .bun despite .bun being searched first"
        );
        // And the comparison is numeric, not lexicographic: 17.9.0 < 17.10.0.
        stub(&home.join(".bun/bin/omp"), "17.10.0");
        stub(&home.join(".local/bin/omp"), "17.9.0");
        assert_eq!(
            find_omp_binary(),
            Some(home.join(".bun/bin/omp")),
            "17.10.0 must beat 17.9.0"
        );
    }
}

/// What a running daemon publishes about itself, so `doctor` and `pair` do not
/// have to guess how it was launched.
///
/// WHY: a service unit passes `--bind`/`--port` on the command line, and those
/// values appear in neither the config file nor the environment of a later
/// `omp-pulse doctor`. Without this, doctor reports the DEFAULT address, tells
/// the operator their daemon is unreachable, and is wrong on both counts.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RuntimeInfo {
    pub bind: String,
    pub port: u16,
    pub pid: u32,
    pub version: String,
    pub build: String,
}

/// Publish the runtime descriptor. Best effort: a daemon that cannot write it
/// still serves, it just makes its tools guess again.
///
/// A LIVE descriptor belonging to another process is left alone. The first daemon
/// on a state dir owns it, so a second instance cannot redirect `doctor` and
/// `pair` at itself: sharing a state dir is already a misconfiguration (they
/// contend for the token and push store) and the startup warning names it, but
/// the tools should keep pointing at the instance that was there first.
pub fn write_runtime(paths: &Paths, info: &RuntimeInfo) {
    if let Some(other) = read_runtime(paths)
        && other.pid != info.pid
    {
        return;
    }
    if let Ok(body) = serde_json::to_vec_pretty(info) {
        let tmp = paths.runtime_file.with_extension("json.tmp");
        if std::fs::write(&tmp, &body).is_ok() {
            let _ = std::fs::rename(&tmp, &paths.runtime_file);
        }
    }
}

/// Remove OUR descriptor on clean shutdown, so a stale file never sends a tool
/// to an address nothing is listening on.
///
/// Only removes the file when it still describes THIS process. A second instance
/// sharing the state dir used to wipe the live daemon's descriptor when it exited,
/// after which `doctor` probed the packaged default and reported the healthy
/// daemon as unreachable - the exact failure this file exists to prevent.
pub fn clear_runtime(paths: &Paths) {
    let ours = std::process::id();
    // Someone else's descriptor, or an unreadable one, is left alone.
    if let Ok(raw) = std::fs::read_to_string(&paths.runtime_file)
        && let Ok(info) = serde_json::from_str::<RuntimeInfo>(&raw)
        && info.pid == ours
    {
        let _ = std::fs::remove_file(&paths.runtime_file);
    }
}

/// The descriptor of a daemon that is still alive, or None. A pid that no
/// longer exists means the file is stale (a crash, or a kill -9), and stale
/// beats absent only if you like being lied to.
pub fn read_runtime(paths: &Paths) -> Option<RuntimeInfo> {
    let raw = std::fs::read_to_string(&paths.runtime_file).ok()?;
    let info: RuntimeInfo = serde_json::from_str(&raw).ok()?;
    let mut sys = sysinfo::System::new();
    let pid = sysinfo::Pid::from_u32(info.pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map(|_| info)
}
