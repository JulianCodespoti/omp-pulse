//! Safely configure and launch the selected Herdr server without tying its
//! lifetime to omp-pulse.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::process::{Child, Command};
use toml_edit::{DocumentMut, Item, Table, Value, value};

static TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

/// Disable restore-time agent relaunch, then start Herdr's server in a detached
/// process that is not reaped by Pulse's service cgroup.
pub(crate) async fn start(bin: &Path) -> Result<Child, String> {
    // Syntactically valid TOML can still fail Herdr's schema and make it use
    // defaults, which ENABLE agent restore. Let the installed Herdr validate
    // its own schema before changing configuration or launching anything.
    crate::terminal::adopt::herdr_within(
        bin,
        &["config", "check"],
        std::time::Duration::from_secs(10),
    )
    .await
    .map_err(|_| {
        "Herdr rejected its configuration; run herdr config check on the computer".to_string()
    })?;
    prepare_config(&herdr_config_path())?;

    let mut command = launcher(bin);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("OMP_PULSE_CHILD");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.as_std_mut().pre_exec(|| {
                // SAFETY: setsid is async-signal-safe and does not access Rust state.
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command
            .as_std_mut()
            .creation_flags(0x0000_0008 | 0x0800_0000);
    }

    command
        .spawn()
        .map_err(|e| format!("cannot launch Herdr server {}: {e}", bin.display()))
}

fn launcher(bin: &Path) -> Command {
    #[cfg(target_os = "linux")]
    if Path::new("/run/systemd/system").is_dir() {
        let mut command = Command::new("systemd-run");
        command
            .args(["--user", "--scope", "--quiet", "--collect", "--"])
            .arg(bin)
            .arg("server");
        if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
            command.env(
                "XDG_RUNTIME_DIR",
                format!("/run/user/{}", unsafe { libc::geteuid() }),
            );
        }
        return command;
    }

    let mut command = Command::new(bin);
    command.arg("server");
    command
}

fn herdr_config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("HERDR_CONFIG_PATH") {
        return PathBuf::from(path);
    }

    #[cfg(windows)]
    let config_dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|home| PathBuf::from(home).join("AppData").join("Roaming"))
        })
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(std::env::temp_dir);

    #[cfg(not(windows))]
    let config_dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(std::env::temp_dir);

    config_dir.join("herdr").join("config.toml")
}

fn prepare_config(path: &Path) -> Result<(), String> {
    let (target, existing_permissions) = resolve_config_target(path)?;
    let content = match fs::read_to_string(&target) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(format!(
                "cannot read Herdr config at {}: {error}",
                target.display()
            ));
        }
    };
    let updated = disable_resume_agents(&content).map_err(|reason| {
        format!(
            "cannot safely update Herdr config at {}: {reason}",
            target.display()
        )
    })?;
    if updated == content && existing_permissions.is_some() {
        return Ok(());
    }
    atomic_replace(&target, updated.as_bytes(), existing_permissions).map_err(|error| {
        format!(
            "cannot safely write Herdr config at {}: {error}",
            target.display()
        )
    })
}

fn resolve_config_target(path: &Path) -> Result<(PathBuf, Option<fs::Permissions>), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let target = fs::canonicalize(path).map_err(|error| {
                format!(
                    "cannot resolve Herdr config path {}: {error}",
                    path.display()
                )
            })?;
            let metadata = fs::metadata(&target).map_err(|error| {
                format!(
                    "cannot inspect Herdr config at {}: {error}",
                    target.display()
                )
            })?;
            Ok((target, Some(metadata.permissions())))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "cannot create Herdr config directory {}: {error}",
                    parent.display()
                )
            })?;
            let canonical_parent = fs::canonicalize(parent).map_err(|error| {
                format!(
                    "cannot resolve Herdr config directory {}: {error}",
                    parent.display()
                )
            })?;
            let name = path
                .file_name()
                .ok_or_else(|| format!("Herdr config path {} has no filename", path.display()))?;
            Ok((canonical_parent.join(name), None))
        }
        Err(error) => Err(format!(
            "cannot inspect Herdr config path {}: {error}",
            path.display()
        )),
    }
}

fn disable_resume_agents(content: &str) -> Result<String, &'static str> {
    let mut document = if content.trim().is_empty() {
        DocumentMut::new()
    } else {
        content
            .parse::<DocumentMut>()
            .map_err(|_| "configuration is malformed TOML")?
    };

    if document.get("session").is_none() {
        document["session"] = Item::Table(Table::new());
    }

    match document.get_mut("session") {
        Some(Item::Table(session)) => set_table_setting(session),
        Some(Item::Value(Value::InlineTable(session))) => set_inline_setting(session),
        Some(_) => Err("session must be a TOML table"),
        None => Err("session table could not be created"),
    }?;
    Ok(document.to_string())
}

fn set_table_setting(session: &mut Table) -> Result<(), &'static str> {
    match session.get_mut("resume_agents_on_restore") {
        Some(Item::Value(current)) if current.is_bool() => {
            set_boolean_preserving_decor(current);
            Ok(())
        }
        Some(_) => Err("session.resume_agents_on_restore must be a boolean"),
        None => {
            session.insert("resume_agents_on_restore", value(false));
            Ok(())
        }
    }
}

fn set_inline_setting(session: &mut toml_edit::InlineTable) -> Result<(), &'static str> {
    match session.get_mut("resume_agents_on_restore") {
        Some(current) if current.is_bool() => {
            set_boolean_preserving_decor(current);
            Ok(())
        }
        Some(_) => Err("session.resume_agents_on_restore must be a boolean"),
        None => {
            session.insert("resume_agents_on_restore", Value::from(false));
            Ok(())
        }
    }
}

fn set_boolean_preserving_decor(current: &mut Value) {
    let mut disabled = Value::from(false);
    *disabled.decor_mut() = current.decor().clone();
    *current = disabled;
}

fn atomic_replace(
    path: &Path,
    contents: &[u8],
    permissions: Option<fs::Permissions>,
) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();

    for _ in 0..8 {
        let id = TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".{file_name}.herdr-{}-{id}.tmp",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&temporary) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let mut cleanup = TempCleanup(Some(temporary.clone()));
        file.write_all(contents)?;
        if let Some(permissions) = permissions.as_ref() {
            file.set_permissions(permissions.clone())?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        cleanup.0 = None;
        return Ok(());
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique temporary config file",
    ))
}

struct TempCleanup(Option<PathBuf>);

impl Drop for TempCleanup {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omp-pulse-herdr-config-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn preserves_comments_values_and_file_permissions() {
        let dir = scratch_dir();
        let path = dir.join("config.toml");
        let original = "# keep this comment\n[general]\nvalue = \"secret\" # keep this too\n\n[session]\n# saved setting\nresume_agents_on_restore = true # keep this value comment\nlayout = \"split\"\n";
        fs::write(&path, original).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        }

        prepare_config(&path).unwrap();
        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.contains("# keep this comment"));
        assert!(updated.contains("value = \"secret\" # keep this too"));
        assert!(updated.contains("# saved setting"));
        assert!(updated.contains("resume_agents_on_restore = false # keep this value comment"));
        assert!(updated.contains("layout = \"split\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn supports_inline_and_dotted_session_tables_idempotently() {
        let inline = "session = { layout = \"split\", resume_agents_on_restore = true }\n";
        let changed = disable_resume_agents(inline).unwrap();
        assert!(
            changed.contains("session = { layout = \"split\", resume_agents_on_restore = false }")
        );
        assert_eq!(disable_resume_agents(&changed).unwrap(), changed);

        let dotted = "session.layout = \"split\"\nsession.resume_agents_on_restore = true\n";
        let changed = disable_resume_agents(dotted).unwrap();
        assert!(changed.contains("session.layout = \"split\""));
        assert!(changed.contains("session.resume_agents_on_restore = false"));
        assert_eq!(disable_resume_agents(&changed).unwrap(), changed);
    }

    #[test]
    fn refuses_malformed_or_wrong_typed_session_settings_without_changes() {
        let dir = scratch_dir();
        for (index, original) in [
            "[session\nresume_agents_on_restore = true",
            "session = 1",
            "[session]\nresume_agents_on_restore = \"true\"\n",
            "session = { resume_agents_on_restore = \"true\" }\n",
        ]
        .into_iter()
        .enumerate()
        {
            let path = dir.join(format!("config-{index}.toml"));
            fs::write(&path, original).unwrap();
            assert!(prepare_config(&path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn updates_symlink_target_without_replacing_symlink() {
        use std::os::unix::fs::symlink;

        let dir = scratch_dir();
        let target = dir.join("real-config.toml");
        let link = dir.join("config.toml");
        fs::write(&target, "[session]\nresume_agents_on_restore = true\n").unwrap();
        symlink(&target, &link).unwrap();

        prepare_config(&link).unwrap();

        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(
            fs::read_to_string(&target)
                .unwrap()
                .contains("resume_agents_on_restore = false")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn creates_missing_config_and_is_idempotent() {
        let dir = scratch_dir();
        let path = dir.join("nested").join("config.toml");
        prepare_config(&path).unwrap();
        let first = fs::read_to_string(&path).unwrap();
        assert!(first.contains("[session]"));
        assert!(first.contains("resume_agents_on_restore = false"));
        prepare_config(&path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), first);
        fs::remove_dir_all(dir).unwrap();
    }
}
