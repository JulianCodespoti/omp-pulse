//! Service installation per platform.
//!
//! `omp-pulse service install` registers the daemon to start at login and
//! restart on failure, entirely inside the current user's session: no root,
//! no admin, no daemon tooling a stranger would not already have. Each
//! platform uses the manager the OS ships with:
//!
//! * **Linux**: a systemd **user** unit under `$XDG_CONFIG_HOME/systemd/user`
//!   (the very directory `systemctl --user` reads, so nothing else needs
//!   telling). On a non-systemd distro there is no `systemctl` to honour the
//!   file, so [`supported`] is false and [`install`] refuses rather than
//!   writing a unit nobody will read.
//! * **macOS**: a launchd LaunchAgent at `~/Library/LaunchAgents`, bootstrapped
//!   into the per-user `gui/<uid>` domain (`launchctl load -w` on older
//!   systems), with stdout/stderr redirected under the state dir's `logs/`.
//! * **Windows**: an ONLOGON Task Scheduler task. The honest tradeoff for a
//!   user-level tool: a real Windows service needs a service-control-handler
//!   binary compiled against the Windows API and an administrator to register
//!   it, which a per-user daemon does not warrant; an ONLOGON task starts the
//!   daemon at every logon with no admin rights at all.
//!
//! All three write a human-readable summary of what was written where and how
//! to inspect logs, and all three are reversible with [`uninstall`].
//!
//! This module is deliberately synchronous and process-spawning: it is
//! invoked from one-shot CLI subcommands and from `doctor`, never from the
//! daemon's async core.

use std::path::{Path, PathBuf};
use std::process::Command;

/// launchd label (reverse-DNS, unique per install).
#[cfg(any(target_os = "macos", all(test, unix)))]
const LAUNCHD_LABEL: &str = "sh.omp.pulse";
/// Task Scheduler task name (must match `uninstall` and `status`).
#[cfg(any(windows, test))]
const SCHTASKS_TASK: &str = "OmpPulse";
/// systemd unit file name; also the service name passed to `systemctl`.
#[cfg(target_os = "linux")]
const SYSTEMD_UNIT: &str = "omp-pulse.service";

/// What `service::install` wrote on the current platform, if anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceState {
    /// Nothing is registered on this machine.
    NotInstalled,
    /// A unit/task/agent exists; `running` is the manager's own verdict and
    /// `detail` carries the raw status the manager reported.
    Installed { running: bool, detail: String },
}

/// The service manager this platform would use, for display and for
/// [`supported`]. `"unsupported"` covers every platform with no user-level
/// manager (the daemon still runs fine in the foreground).
pub fn manager_name() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "systemd (user)"
    }
    #[cfg(target_os = "macos")]
    {
        "launchd"
    }
    #[cfg(target_os = "windows")]
    {
        "Task Scheduler"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        "unsupported"
    }
}

/// True when this machine can actually run the manager, not just name it.
/// Linux is the only platform where the manager is optional: `systemctl`
/// exists on sysvinit Debian without systemd being PID 1, so the binary alone
/// is not proof — `/run/systemd/system` exists only under systemd.
pub fn supported() -> bool {
    match manager_name() {
        #[cfg(target_os = "linux")]
        "systemd (user)" => systemctl_available(),
        #[cfg(target_os = "macos")]
        "launchd" => true, // launchctl ships with every macOS
        #[cfg(target_os = "windows")]
        "Task Scheduler" => true, // schtasks ships with every Windows
        _ => false,
    }
}

/// Register the daemon to start at login and restart on failure.
/// `Ok` carries a human-readable summary: what was written where, and how to
/// inspect status and logs. Never requires elevation.
pub fn install(bind: &str, port: u16) -> Result<String, String> {
    install_impl(bind, port)
}

/// Remove the login registration and stop the daemon. Idempotent: a manager
/// that no longer knows the unit/task/agent is not an error.
pub fn uninstall() -> Result<String, String> {
    uninstall_impl()
}

/// What the manager says about the current registration. `Err` means the
/// manager itself is unavailable or failed to run, not merely that nothing is
/// installed (that is [`ServiceState::NotInstalled`]).
pub fn status() -> Result<ServiceState, String> {
    status_impl()
}

// --- platform dispatch ------------------------------------------------------
//
// Each `*_impl` is compiled only on its own target so an unused arm never
// references a function that does not exist on that platform.

#[cfg(target_os = "linux")]
fn install_impl(bind: &str, port: u16) -> Result<String, String> {
    install_systemd(bind, port)
}

#[cfg(target_os = "macos")]
fn install_impl(bind: &str, port: u16) -> Result<String, String> {
    install_launchd(bind, port)
}

#[cfg(target_os = "windows")]
fn install_impl(bind: &str, port: u16) -> Result<String, String> {
    install_windows(bind, port)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn install_impl(_bind: &str, _port: u16) -> Result<String, String> {
    Err("no supported service manager on this platform; run the daemon directly with `omp-pulse serve`".to_string())
}

#[cfg(target_os = "linux")]
fn uninstall_impl() -> Result<String, String> {
    uninstall_systemd()
}

#[cfg(target_os = "macos")]
fn uninstall_impl() -> Result<String, String> {
    uninstall_launchd()
}

#[cfg(target_os = "windows")]
fn uninstall_impl() -> Result<String, String> {
    uninstall_windows()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn uninstall_impl() -> Result<String, String> {
    Err("no supported service manager on this platform".to_string())
}

#[cfg(target_os = "linux")]
fn status_impl() -> Result<ServiceState, String> {
    status_systemd()
}

#[cfg(target_os = "macos")]
fn status_impl() -> Result<ServiceState, String> {
    status_launchd()
}

#[cfg(target_os = "windows")]
fn status_impl() -> Result<ServiceState, String> {
    status_windows()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn status_impl() -> Result<ServiceState, String> {
    Err("no supported service manager on this platform".to_string())
}

// --- shared helpers ---------------------------------------------------------

/// This executable's absolute path; systemd/launchd/schtasks all exec it
/// directly, so an installed binary registers its real location.
fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("cannot resolve own executable path: {e}"))
}

/// The user config dir (Linux: `$XDG_CONFIG_HOME` else `~/.config`). Only the
/// systemd backend needs it — launchd uses the home dir, schtasks nothing.
#[cfg(target_os = "linux")]
fn config_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.config_dir().to_path_buf())
}

/// The user home dir; only the launchd backend needs it (`~/Library/LaunchAgents`).
#[cfg(target_os = "macos")]
fn home_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.home_dir().to_path_buf())
}

/// True when `name` is an executable on PATH. Only the systemd backend uses a
/// PATH lookup; launchctl and schtasks are guaranteed by their platforms.
#[cfg(target_os = "linux")]
fn command_on_path(name: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(name);
        candidate.is_file() && {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                candidate
                    .metadata()
                    .map(|m| m.permissions().mode() & 0o111 != 0)
                    .unwrap_or(false)
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
    })
}

/// Run one synchronous command and return its output. The only failure mode
/// is being unable to spawn (the binary vanished mid-run).
fn run_sync(cmd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run {cmd}: {e}"))
}

/// A failed command's stderr (falling back to stdout) for the error message.
fn output_diagnostic(out: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let text = stderr.trim();
    if !text.is_empty() {
        return text.to_string();
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let text = stdout.trim();
    if !text.is_empty() {
        return text.to_string();
    }
    format!("exit status {}", out.status)
}

// --- systemd (Linux) --------------------------------------------------------

#[cfg(target_os = "linux")]
fn systemctl_available() -> bool {
    command_on_path("systemctl") && Path::new("/run/systemd/system").is_dir()
}

#[cfg(target_os = "linux")]
fn systemd_unsupported_reason() -> String {
    "systemd is not running on this system (no `systemctl` on PATH or no \
     /run/systemd/system), so a user unit would never run; run the daemon \
     directly with `omp-pulse serve`, or install the service on a systemd-based \
     system"
        .to_string()
}

/// The unit file text. Pure so the ExecStart shape is unit-tested; the exe is
/// double-quoted (systemd strips the quotes, so spaces in the path survive)
/// and `\`/`"` are escaped per systemd's own ExecStart rules. Only compiled
/// where the systemd backend exists (plus tests, which exercise every
/// platform's generator).
#[cfg(any(target_os = "linux", test))]
fn systemd_unit_text(exe: &Path, bind: &str, port: u16) -> String {
    let escaped = exe
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!(
        "[Unit]\n\
         Description=omp-pulse daemon (drive desktop omp sessions from your phone)\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart=\"{escaped}\" serve --bind {bind} --port {port}\n\
         Restart=on-failure\n\
         RestartSec=2\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

#[cfg(target_os = "linux")]
fn install_systemd(bind: &str, port: u16) -> Result<String, String> {
    if !systemctl_available() {
        return Err(systemd_unsupported_reason());
    }
    let exe = current_exe()?;
    let unit_dir = config_dir()
        .ok_or("cannot resolve the config directory (is XDG_CONFIG_HOME or HOME set)?")?
        .join("systemd/user");
    let unit_file = unit_dir.join(SYSTEMD_UNIT);
    std::fs::create_dir_all(&unit_dir)
        .map_err(|e| format!("cannot create {}: {e}", unit_dir.display()))?;
    std::fs::write(&unit_file, systemd_unit_text(&exe, bind, port))
        .map_err(|e| format!("cannot write {}: {e}", unit_file.display()))?;

    let reload = run_sync("systemctl", &["--user", "daemon-reload"])?;
    if !reload.status.success() {
        return Err(format!(
            "`systemctl --user daemon-reload` failed: {}; the unit file is in place at {}; fix the user manager and re-run `omp-pulse service install`",
            output_diagnostic(&reload),
            unit_file.display()
        ));
    }
    let enable = run_sync("systemctl", &["--user", "enable", "--now", SYSTEMD_UNIT])?;
    if !enable.status.success() {
        return Err(format!(
            "`systemctl --user enable --now {SYSTEMD_UNIT}` failed: {}; the unit file is in place at {}; run `systemctl --user enable --now {SYSTEMD_UNIT}` manually once the cause is fixed",
            output_diagnostic(&enable),
            unit_file.display()
        ));
    }
    Ok(format!(
        "installed omp-pulse as a systemd user service:\n  unit: {}\n  exec: {} serve --bind {bind} --port {port}\n  starts at login, restarts on failure (RestartSec 2s)\nenabled and started in the user manager.\nInspect: systemctl --user status {SYSTEMD_UNIT}\nLogs: journalctl --user -u {SYSTEMD_UNIT} -f",
        unit_file.display(),
        exe.display()
    ))
}

#[cfg(target_os = "linux")]
fn uninstall_systemd() -> Result<String, String> {
    if !systemctl_available() {
        return Err(systemd_unsupported_reason());
    }
    // Stop and disable first; failures are fine (nothing may be enabled).
    let _ = run_sync("systemctl", &["--user", "disable", "--now", SYSTEMD_UNIT]);
    let unit_dir = config_dir()
        .ok_or("cannot resolve the config directory (is XDG_CONFIG_HOME or HOME set)?")?
        .join("systemd/user");
    let unit_file = unit_dir.join(SYSTEMD_UNIT);
    if unit_file.is_file() {
        std::fs::remove_file(&unit_file)
            .map_err(|e| format!("cannot remove {}: {e}", unit_file.display()))?;
    }
    // Forget the unit so `is-enabled` stops reporting a ghost.
    let _ = run_sync("systemctl", &["--user", "daemon-reload"]);
    Ok(format!(
        "stopped and disabled omp-pulse and removed {}; it will no longer start at login",
        unit_file.display()
    ))
}

#[cfg(target_os = "linux")]
fn status_systemd() -> Result<ServiceState, String> {
    if !systemctl_available() {
        return Err(systemd_unsupported_reason());
    }
    let unit_dir = config_dir()
        .ok_or("cannot resolve the config directory (is XDG_CONFIG_HOME or HOME set)?")?
        .join("systemd/user");
    if !unit_dir.join(SYSTEMD_UNIT).is_file() {
        return Ok(ServiceState::NotInstalled);
    }
    let active = run_sync("systemctl", &["--user", "is-active", SYSTEMD_UNIT])?;
    let enabled = run_sync("systemctl", &["--user", "is-enabled", SYSTEMD_UNIT])?;
    let active_str = String::from_utf8_lossy(&active.stdout).trim().to_string();
    let enabled_str = String::from_utf8_lossy(&enabled.stdout).trim().to_string();
    // `is-active` exits non-zero for anything but "active" but still prints
    // the verdict on stdout, which is what we report.
    Ok(ServiceState::Installed {
        running: active_str == "active",
        detail: format!("is-active: {active_str}; is-enabled: {enabled_str}"),
    })
}

// --- launchd (macOS) --------------------------------------------------------

/// XML-escape a string for a plist `<string>` element (`&`, `<`, `>`, `"`,
/// `'`). Pure so the plist generator is unit-tested.
#[cfg(any(target_os = "macos", test))]
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// The LaunchAgent plist XML. Pure: the acceptance test asserts the label,
/// the exec path (XML-escaped) and the log paths all appear.
#[cfg(any(target_os = "macos", all(test, unix)))]
fn launchd_plist(exe: &Path, bind: &str, port: u16, log_dir: &Path) -> String {
    let args = [
        exe.to_string_lossy().into_owned(),
        "serve".to_string(),
        "--bind".to_string(),
        bind.to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
    );
    out.push_str("<plist version=\"1.0\">\n<dict>\n");
    out.push_str(&format!(
        "  <key>Label</key>\n  <string>{}</string>\n",
        xml_escape(LAUNCHD_LABEL)
    ));
    out.push_str("  <key>ProgramArguments</key>\n  <array>\n");
    for a in &args {
        out.push_str(&format!("    <string>{}</string>\n", xml_escape(a)));
    }
    out.push_str("  </array>\n");
    out.push_str("  <key>RunAtLoad</key>\n  <true/>\n");
    out.push_str("  <key>KeepAlive</key>\n  <true/>\n");
    for (key, name) in [
        ("StandardOutPath", "launchd.stdout.log"),
        ("StandardErrorPath", "launchd.stderr.log"),
    ] {
        let path = log_dir.join(name);
        out.push_str(&format!(
            "  <key>{key}</key>\n  <string>{}</string>\n",
            xml_escape(&path.to_string_lossy())
        ));
    }
    out.push_str("</dict>\n</plist>\n");
    out
}

#[cfg(target_os = "macos")]
fn current_uid() -> u32 {
    // SAFETY: getuid takes no arguments and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(target_os = "macos")]
fn launchd_agents_dir() -> Result<PathBuf, String> {
    Ok(home_dir()
        .ok_or("cannot resolve the home directory (is HOME set)?")?
        .join("Library/LaunchAgents"))
}

#[cfg(target_os = "macos")]
fn launchd_target() -> Result<String, String> {
    Ok(format!("gui/{}/{}", current_uid(), LAUNCHD_LABEL))
}

#[cfg(target_os = "macos")]
fn install_launchd(bind: &str, port: u16) -> Result<String, String> {
    let exe = current_exe()?;
    let agents = launchd_agents_dir()?;
    let plist = agents.join(format!("{LAUNCHD_LABEL}.plist"));
    std::fs::create_dir_all(&agents)
        .map_err(|e| format!("cannot create {}: {e}", agents.display()))?;
    // The daemon's own state resolves independently of launchd; its log dir
    // is where StandardOutPath/StandardErrorPath point, so create it now.
    let paths = crate::paths::Paths::resolve()?;
    paths.ensure_dirs()?;
    std::fs::write(&plist, launchd_plist(&exe, bind, port, &paths.log_dir))
        .map_err(|e| format!("cannot write {}: {e}", plist.display()))?;

    let target = format!("gui/{}", current_uid());
    let boot = run_sync(
        "launchctl",
        &["bootstrap", &target, &plist.to_string_lossy()],
    );
    if !boot.as_ref().map(|o| o.status.success()).unwrap_or(false) {
        // Older launchctl has no `bootstrap`; `load -w` is the legacy form.
        let load = run_sync("launchctl", &["load", "-w", &plist.to_string_lossy()])?;
        if !load.status.success() {
            return Err(format!(
                "launchctl refused the agent: bootstrap failed ({}) and `load -w` failed ({})",
                boot.map(|o| output_diagnostic(&o)).unwrap_or_else(|e| e),
                output_diagnostic(&load)
            ));
        }
    }
    Ok(format!(
        "installed omp-pulse as a launchd LaunchAgent:\n  plist: {}\n  exec: {} serve --bind {bind} --port {port}\n  starts at login, kept alive (KeepAlive)\n  logs: {} and {}\nbootstrapped into gui/{}. Inspect: launchctl print gui/{}/{LAUNCHD_LABEL}",
        plist.display(),
        exe.display(),
        paths.log_dir.join("launchd.stdout.log").display(),
        paths.log_dir.join("launchd.stderr.log").display(),
        current_uid(),
        current_uid()
    ))
}

#[cfg(target_os = "macos")]
fn uninstall_launchd() -> Result<String, String> {
    let agents = launchd_agents_dir()?;
    let plist = agents.join(format!("{LAUNCHD_LABEL}.plist"));
    let target = launchd_target()?;
    // Boot the job out of the domain first, then delete the file so a
    // subsequent login cannot re-load it.
    let boot = run_sync("launchctl", &["bootout", &target]);
    if !boot.as_ref().map(|o| o.status.success()).unwrap_or(false) {
        // Legacy fallback: `unload -w` stops the job and forgets it.
        let _ = run_sync("launchctl", &["unload", "-w", &plist.to_string_lossy()]);
    }
    if plist.is_file() {
        std::fs::remove_file(&plist)
            .map_err(|e| format!("cannot remove {}: {e}", plist.display()))?;
    }
    Ok(format!(
        "unloaded and removed {}; omp-pulse will no longer start at login",
        plist.display()
    ))
}

#[cfg(target_os = "macos")]
fn status_launchd() -> Result<ServiceState, String> {
    let agents = launchd_agents_dir()?;
    let plist = agents.join(format!("{LAUNCHD_LABEL}.plist"));
    if !plist.is_file() {
        return Ok(ServiceState::NotInstalled);
    }
    let target = launchd_target()?;
    let print = run_sync("launchctl", &["print", &target]);
    if let Ok(o) = &print {
        if o.status.success() {
            let text = String::from_utf8_lossy(&o.stdout);
            let head = text.lines().take(6).collect::<Vec<_>>().join("\n");
            return Ok(ServiceState::Installed {
                running: true,
                detail: head,
            });
        }
    }
    // Older launchctl has no `print`; `list` prints "PID  Status  Label" —
    // a numeric PID means the job is running, "-" means loaded but idle.
    let list = run_sync("launchctl", &["list"])?;
    if !list.status.success() {
        return Err(format!(
            "launchctl print ({}) and launchctl list ({}) both failed",
            print
                .as_ref()
                .map(|o| output_diagnostic(o))
                .unwrap_or_else(|e| e.clone()),
            output_diagnostic(&list)
        ));
    }
    let text = String::from_utf8_lossy(&list.stdout);
    let line = text.lines().find(|l| l.trim_end().ends_with(LAUNCHD_LABEL));
    match line {
        Some(l) => {
            let pid = l.split_whitespace().next().unwrap_or("-");
            Ok(ServiceState::Installed {
                running: pid.parse::<i32>().is_ok(),
                detail: format!("launchctl list: {}", l.trim()),
            })
        }
        None => Ok(ServiceState::Installed {
            running: false,
            detail: "plist present but the job is not loaded".to_string(),
        }),
    }
}

// --- Task Scheduler (Windows) ------------------------------------------------

/// The full `schtasks /Create` argument vector. /TR takes the whole command
/// line as ONE argument; the outer quotes survive schtasks' parser and the
/// `\"` escapes become the literal quotes around the exe, so a path with
/// spaces registers correctly when spawned directly (no cmd.exe in between).
/// Windows paths cannot contain `"`, so escaping only the exe is unambiguous.
#[cfg(any(target_os = "windows", test))]
fn windows_task_args(exe: &Path, bind: &str, port: u16) -> Vec<String> {
    let exe_str = exe.to_string_lossy();
    let cmdline = format!("\"\\\"{exe_str}\\\" serve --bind {bind} --port {port}\"");
    vec![
        "/Create".to_string(),
        "/SC".to_string(),
        "ONLOGON".to_string(),
        "/TN".to_string(),
        SCHTASKS_TASK.to_string(),
        "/TR".to_string(),
        cmdline,
        "/RL".to_string(),
        "LIMITED".to_string(),
        "/F".to_string(),
    ]
}

#[cfg(any(target_os = "windows", test))]
fn register_and_start_windows(
    exe: &Path,
    bind: &str,
    port: u16,
    mut run: impl FnMut(&[&str]) -> Result<(), String>,
) -> Result<(), String> {
    let args = windows_task_args(exe, bind, port);
    let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&args_refs).map_err(|e| format!("schtasks /Create failed: {e}"))?;
    run(&["/Run", "/TN", SCHTASKS_TASK]).map_err(|e| {
        format!("task registered but schtasks /Run failed: {e}; start it with schtasks /Run /TN {SCHTASKS_TASK}")
    })
}

#[cfg(target_os = "windows")]
fn install_windows(bind: &str, port: u16) -> Result<String, String> {
    let exe = current_exe()?;
    register_and_start_windows(&exe, bind, port, |args| {
        let output = run_sync("schtasks", args)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(output_diagnostic(&output))
        }
    })?;
    // /Run only acknowledges scheduling. Do not send the next `pair` command
    // into the interval before the HTTP listener is actually bound.
    let host = match bind {
        "0.0.0.0" => "127.0.0.1",
        "::" | "[::]" => "::1",
        other => other.trim_matches(['[', ']']),
    };
    use std::net::ToSocketAddrs;
    let addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("task started but cannot resolve daemon address: {e}"))?
        .collect();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if addresses.iter().any(|address| {
            std::net::TcpStream::connect_timeout(address, std::time::Duration::from_millis(250))
                .is_ok()
        }) {
            break;
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "task registered and started, but the daemon did not listen on {bind}:{port} within 30 seconds; inspect schtasks /Query /TN {SCHTASKS_TASK} and daemon logs before pairing"
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let paths = crate::paths::Paths::resolve()?;
    Ok(format!(
        "registered and started Task Scheduler task \"{SCHTASKS_TASK}\" (also runs at logon as the current user, no admin needed); daemon is listening, ready to pair:\n  command: {} serve --bind {bind} --port {port}\n  daemon logs: {}\nInspect: schtasks /Query /TN {SCHTASKS_TASK} (or Task Scheduler)\nRemove: omp-pulse service uninstall",
        exe.display(),
        paths.log_dir.display()
    ))
}

#[cfg(target_os = "windows")]
fn uninstall_windows() -> Result<String, String> {
    let out = run_sync("schtasks", &["/Delete", "/TN", SCHTASKS_TASK, "/F"])?;
    if !out.status.success() {
        // Deleting a task that never existed is the one benign failure (the
        // message text is what identifies it; on a localized system it may
        // not match, and an Err with the raw text is still honest).
        let diag = output_diagnostic(&out);
        if !diag.contains("not find") && !diag.contains("does not exist") {
            return Err(format!("schtasks /Delete failed: {diag}"));
        }
    }
    Ok(format!(
        "deleted Task Scheduler task \"{SCHTASKS_TASK}\"; omp-pulse will no longer start at logon"
    ))
}

#[cfg(target_os = "windows")]
fn status_windows() -> Result<ServiceState, String> {
    // /FO LIST prints "key: value" lines; the Status value is localized, so
    // `running` keys off the ASCII words Task Scheduler itself emits on an
    // English system ("Running", "Ready", "Disabled") and the raw value is
    // always reported verbatim so nothing is hidden on a localized one.
    let out = run_sync("schtasks", &["/Query", "/TN", SCHTASKS_TASK, "/FO", "LIST"])?;
    if !out.status.success() {
        return Ok(ServiceState::NotInstalled);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let status_line = text
        .lines()
        .map(str::trim)
        .find(|l| l.to_ascii_lowercase().starts_with("status:"));
    let status_value = status_line
        .map(|l| {
            l.trim_start_matches(|c| c != ':')
                .trim_start_matches(':')
                .trim()
                .to_string()
        })
        .unwrap_or_else(|| "unknown".to_string());
    let lower = status_value.to_ascii_lowercase();
    let running = lower.contains("running") || lower.contains("ready") || lower == "unknown";
    Ok(ServiceState::Installed {
        running,
        detail: format!("schtasks status: {status_value}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_unit_contains_exec_start_with_resolved_exe() {
        let exe = Path::new("/opt/omp pulse/bin/omp-pulse");
        let text = systemd_unit_text(exe, "127.0.0.1", 7682);
        assert!(text.contains(
            "ExecStart=\"/opt/omp pulse/bin/omp-pulse\" serve --bind 127.0.0.1 --port 7682"
        ));
        assert!(text.contains("Restart=on-failure"));
        assert!(text.contains("RestartSec=2"));
        assert!(text.contains("WantedBy=default.target"));
    }

    #[test]
    fn systemd_unit_escapes_quotes_in_exe_path() {
        let text = systemd_unit_text(Path::new("/tmp/a\"b/omp-pulse"), "127.0.0.1", 7682);
        assert!(text.contains("ExecStart=\"/tmp/a\\\"b/omp-pulse\" serve"));
    }

    // Unix only: the plist is written on macOS alone, and `Path::join` on
    // Windows would put `\` into the log paths this asserts.
    #[cfg(unix)]
    #[test]
    fn launchd_plist_contains_label_exec_and_log_paths() {
        let exe = Path::new("/Applications/Omp Pulse/omp-pulse");
        let log_dir = Path::new("/Users/x/Library/Application Support/omp-pulse/logs");
        let text = launchd_plist(exe, "127.0.0.1", 7682, log_dir);
        assert!(text.contains("<key>Label</key>\n  <string>sh.omp.pulse</string>"));
        assert!(text.contains("<string>/Applications/Omp Pulse/omp-pulse</string>"));
        assert!(text.contains("<string>serve</string>"));
        assert!(text.contains("<string>--bind</string>"));
        assert!(text.contains("<string>127.0.0.1</string>"));
        assert!(text.contains("<string>--port</string>"));
        assert!(text.contains("<string>7682</string>"));
        assert!(text.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(text.contains("<key>KeepAlive</key>\n  <true/>"));
        assert!(text.contains(
            "<string>/Users/x/Library/Application Support/omp-pulse/logs/launchd.stdout.log</string>"
        ));
        assert!(text.contains(
            "<string>/Users/x/Library/Application Support/omp-pulse/logs/launchd.stderr.log</string>"
        ));
    }

    #[test]
    fn xml_escape_handles_plist_specials() {
        assert_eq!(
            xml_escape("a&b<c>d\"e'f"),
            "a&amp;b&lt;c&gt;d&quot;e&apos;f"
        );
    }

    #[test]
    fn windows_task_args_vector() {
        let args = windows_task_args(
            Path::new(r"C:\Program Files\omp-pulse\omp-pulse.exe"),
            "127.0.0.1",
            7682,
        );
        assert_eq!(
            args,
            vec![
                "/Create",
                "/SC",
                "ONLOGON",
                "/TN",
                "OmpPulse",
                "/TR",
                "\"\\\"C:\\Program Files\\omp-pulse\\omp-pulse.exe\\\" serve --bind 127.0.0.1 --port 7682\"",
                "/RL",
                "LIMITED",
                "/F",
            ]
        );
    }

    #[test]
    fn windows_task_args_without_spaces() {
        let args = windows_task_args(Path::new(r"C:\omp-pulse\omp-pulse.exe"), "0.0.0.0", 9000);
        let tr = &args[6];
        assert_eq!(
            tr,
            "\"\\\"C:\\omp-pulse\\omp-pulse.exe\\\" serve --bind 0.0.0.0 --port 9000\""
        );
    }
}

#[cfg(test)]
mod windows_start_tests {
    use super::*;

    #[test]
    fn installation_starts_registered_task_and_reports_partial_failure() {
        let mut calls = Vec::new();
        register_and_start_windows(Path::new("pulse.exe"), "127.0.0.1", 7682, |args| {
            calls.push(args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>());
            Ok(())
        })
        .unwrap();
        assert_eq!(calls[0][0], "/Create");
        assert_eq!(calls[1], ["/Run", "/TN", "OmpPulse"]);
        let error = register_and_start_windows(Path::new("pulse.exe"), "127.0.0.1", 7682, |args| {
            if args[0] == "/Run" {
                Err("denied".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert!(error.contains("task registered"));
        assert!(error.contains("denied"));
        let mut count = 0;
        assert!(
            register_and_start_windows(Path::new("pulse.exe"), "127.0.0.1", 7682, |_| {
                count += 1;
                Err("registration failed".into())
            })
            .is_err()
        );
        assert_eq!(count, 1);
    }
}
