//! `omp_pulse doctor` — self-test of the daemon chain, portable across
//! platforms.
//!
//! Walks the chain a stranger's machine needs verified (omp present, sessions
//! discoverable, state sane, daemon reachable and current, service registered,
//! adoption and ownership protection available, phone URL a secure context)
//! and prints one line per check:
//!
//! ```text
//! PASS <name> — <detail>
//! FAIL <name> — <detail> :: FIX <remedy>
//! ```
//!
//! then a final summary line `doctor: N passed, M failed`. A failed check is
//! a normal report line — [`run`] returns `Err` only for an internal failure
//! (e.g. HOME unset). All checks are independent; a failure never aborts the
//! rest. Checks that do not apply to this platform (or to a machine that has
//! not used omp yet) PASS with a "not applicable" detail rather than FAIL: a
//! FAIL line means something is actually broken. No collab link or room
//! secret is ever printed; only room ids and session basenames.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::authority::guard;
use crate::paths::Paths;
use crate::server::assets;
use crate::server::device_auth::DeviceRegistry;
use crate::service::{self, ServiceState};
use crate::terminal::adopt;
use crate::types::{CliOverrides, Config};

/// State file for the `omp-version-drift` check:
///
/// ```json
/// { "version": "omp/17.2.15", "lastPassedProbe": 1752350000 }
/// ```
///
/// Written (0600) only after a PASSING live-probe, so a version change since
/// the last passing probe is detectable as drift. Lives under the daemon's
/// state dir (same place as the token, keys and link registry).
const DRIFT_STATE_FILE: &str = "doctor-version.json";

/// One check result; printed by [`Check::report`] in the CLI and serialized
/// by [`Check::as_json`] into the `/api/diagnostics` `checks` array. The
/// two renderings consume the SAME data — there is no second check logic for
/// the endpoint, so the machine-readable report can never drift from what
/// `omp_pulse doctor` prints. `fix` is printer-only (the wire shape is fixed
/// to `{name, pass, detail}` by the phone contract).
pub struct Check {
    name: &'static str,
    passed: bool,
    detail: String,
    fix: String,
}

impl Check {
    fn report(&self) {
        if self.passed {
            println!("PASS {} — {}", self.name, self.detail);
        } else {
            println!("FAIL {} — {} :: FIX {}", self.name, self.detail, self.fix);
        }
    }

    /// The machine-readable form consumed by `GET /api/diagnostics`:
    /// `{name, pass, detail}` exactly as the shared contract fixes it.
    pub fn as_json(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "pass": self.passed,
            "detail": self.detail,
        })
    }
}

fn pass(name: &'static str, detail: String) -> Check {
    Check {
        name,
        passed: true,
        detail,
        fix: String::new(),
    }
}

fn fail(name: &'static str, detail: String, fix: String) -> Check {
    Check {
        name,
        passed: false,
        detail,
        fix,
    }
}

/// True on Unix only when the executable bit is set; on other platforms file
/// existence is the only signal we get without spawning.
#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The desktop owner credential, with the same precedence the daemon itself
/// uses: env (`OMP_PULSE_TOKEN`, legacy `OMP_REMOTE_TOKEN`) first, then the
/// state-dir token file (which `omp-pulse setup` writes and the legacy
/// migration in `Paths::resolve` populates from `~/.omp`). The direct legacy
/// read is a last resort for a machine where neither has run yet. This value
/// is used only for the local daemon probe and is never printed.
fn read_token(paths: &Paths) -> Option<String> {
    std::env::var("OMP_PULSE_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("OMP_REMOTE_TOKEN")
                .ok()
                .filter(|s| !s.is_empty())
        })
        .or_else(|| read_trimmed(&paths.token_file))
        .or_else(|| read_trimmed(&paths.home.join(".omp/omp-remote.token")))
}

/// The effective bind/port, exactly as the daemon resolves them
/// (`Config::from_layers` with no CLI overrides): env (`OMP_PULSE_*`, legacy
/// `OMP_REMOTE_*` fallback) > `config.toml` > default. Doctor never runs with
/// CLI flags of its own, so the daemon's effective config IS the configured
/// bind/port. This also runs the one-time legacy-state migration
/// (`Paths::resolve`), which the state-dir check then reports on.
fn effective_config() -> Result<Config, String> {
    Config::from_layers(&CliOverrides::default())
}

/// The address to connect to when probing the daemon: an all-interfaces bind
/// cannot be connected to, so loop back.
fn connect_host(bind: &str) -> &str {
    match bind.trim() {
        "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        other => other,
    }
}

/// How to start the daemon right now, per the platform's own service manager.
fn daemon_start_hint() -> String {
    match service::manager_name() {
        "systemd (user)" => "systemctl --user start omp-pulse.service".to_string(),
        "launchd" => "launchctl kickstart gui/$(id -u)/sh.omp.pulse".to_string(),
        "Task Scheduler" => "schtasks /Run /TN OmpPulse".to_string(),
        _ => "start it with `omp-pulse serve`".to_string(),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `omp-binary` — omp itself, the one dependency the user must provide.
// ───────────────────────────────────────────────────────────────────────────

/// The omp binary, resolved exactly as the daemon resolves it
/// (`paths::find_omp_binary`), plus its `--version` (best-effort).
async fn check_omp_binary() -> (Check, Option<String>) {
    let fix = "install the omp CLI and make sure it is on PATH, or set OMP_BIN to its absolute path (the daemon also looks in ~/.bun/bin/omp and ~/.local/bin/omp)"
        .to_string();
    let Some(bin) = crate::paths::find_omp_binary() else {
        return (
            fail("omp-binary", "omp executable not found".to_string(), fix),
            None,
        );
    };
    if !bin.is_file() {
        return (
            fail(
                "omp-binary",
                format!("{} does not exist", bin.display()),
                fix,
            ),
            None,
        );
    }
    if !is_executable(&bin) {
        return (
            fail(
                "omp-binary",
                format!("{} exists but is not executable", bin.display()),
                format!("fix the permissions on {}", bin.display()),
            ),
            None,
        );
    }
    let child = match tokio::process::Command::new(&bin)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                fail(
                    "omp-binary",
                    format!(
                        "{} exists and is executable, but --version failed to spawn: {e}",
                        bin.display()
                    ),
                    "check that the binary is a valid executable".to_string(),
                ),
                None,
            );
        }
    };
    let out = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await;
    let version = match out {
        Ok(Ok(o)) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { None } else { Some(s) }
        }
        Ok(Ok(_)) | Ok(Err(_)) => None,
        // The timeout drops the wait future and with it the child handle;
        // `kill_on_drop(true)` above reaps it. The handle was moved into
        // `wait_with_output`, so an explicit kill here is not possible.
        Err(_) => None,
    };
    match &version {
        Some(v) => (
            pass(
                "omp-binary",
                format!("{} exists, executable — version {v}", bin.display()),
            ),
            version,
        ),
        None => (
            pass(
                "omp-binary",
                format!("{} exists, executable — version unreadable", bin.display()),
            ),
            version,
        ),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `sessions-root` — omp's session store is where the daemon looks.
// ───────────────────────────────────────────────────────────────────────────

/// Count `*.jsonl` sessions the same way `jsonl::list_sessions` does: files
/// in the root AND in its immediate subdirectories. `Err` means the root
/// cannot be listed at all.
fn count_sessions(root: &Path) -> Result<usize, String> {
    let mut n = 0usize;
    let entries = std::fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_file() {
            if path.extension().is_some_and(|e| e == "jsonl") {
                n += 1;
            }
        } else if ft.is_dir() {
            let Ok(sub) = std::fs::read_dir(&path) else {
                continue;
            };
            for sub_entry in sub.flatten() {
                let sub_path = sub_entry.path();
                if sub_path.extension().is_some_and(|e| e == "jsonl") {
                    n += 1;
                }
            }
        }
    }
    Ok(n)
}

fn check_sessions_root(paths: &Paths) -> Check {
    let root = &paths.sessions_root;
    if !root.is_dir() {
        return fail(
            "sessions-root",
            format!("{} is not a directory", root.display()),
            "omp creates it on first run; start omp once, or point OMP_PULSE_SESSIONS_ROOT / OMP_REMOTE_SESSIONS_ROOT / XDG_DATA_HOME at the right place"
                .to_string(),
        );
    }
    match count_sessions(root) {
        Ok(0) => pass(
            "sessions-root",
            format!(
                "{} readable, no sessions yet; an empty root just means omp has not been used on this machine",
                root.display()
            ),
        ),
        Ok(n) => pass(
            "sessions-root",
            format!(
                "{} readable — {n} session file{}",
                root.display(),
                if n == 1 { "" } else { "s" }
            ),
        ),
        Err(e) => fail(
            "sessions-root",
            format!("{} exists but cannot be listed: {e}", root.display()),
            "fix the permissions on the sessions directory".to_string(),
        ),
    }
}

/// Session files stranded DIRECTLY at the sessions root — the condition the
/// startup refile exists to clear. Root-level files are hidden by every
/// lister (scan_sessions skips them; omp's listing globs `*/*.jsonl`), so
/// each one is a real session invisible to the phone AND to `omp resume`.
/// 0 = pass. Names the first few so an operator can see what is stranded
/// from `/api/diagnostics` or the CLI doctor without guessing.
fn check_stranded_sessions(paths: &Paths) -> Check {
    let root = &paths.sessions_root;
    if !root.is_dir() {
        // sessions-root already reports the missing root; do not double-fail.
        return pass(
            "stranded-sessions",
            "no sessions root yet; nothing can be stranded".to_string(),
        );
    }
    let stranded = crate::sessions::jsonl::stranded_root_sessions(root);
    if stranded.is_empty() {
        return pass(
            "stranded-sessions",
            "no session files stranded at the sessions root".to_string(),
        );
    }
    let names: Vec<String> = stranded
        .iter()
        .take(3)
        .map(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.display().to_string())
        })
        .collect();
    fail(
        "stranded-sessions",
        format!(
            "{} session file{} stranded at the sessions root ({}), where every lister hides them",
            stranded.len(),
            if stranded.len() == 1 { "" } else { "s" },
            names.join(", ")
        ),
        "restart the daemon so the startup refile moves them into their per-project directories"
            .to_string(),
    )
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `state-dir` — daemon-owned state: token, keys, registry, logs.
// ───────────────────────────────────────────────────────────────────────────

fn check_state_dir(paths: &Paths) -> Check {
    let state = &paths.state_dir;
    if !state.is_dir() {
        return fail(
            "state-dir",
            format!("{} does not exist", state.display()),
            "start the daemon once (`omp-pulse serve`); it creates its state directory and migrates any legacy ~/.omp files on first run"
                .to_string(),
        );
    }
    // A writability probe that cannot clobber anything: write one file, then
    // delete it again.
    let probe = state.join(format!(".doctor-write-{}", std::process::id()));
    let writable = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    if !writable {
        return fail(
            "state-dir",
            format!("{} exists but is not writable", state.display()),
            format!("fix the permissions on {}", state.display()),
        );
    }
    let registry = match DeviceRegistry::open(state) {
        Ok(registry) => registry,
        Err(error) => {
            return fail(
                "state-dir",
                format!("{} device registry is invalid: {error}", state.display()),
                "repair or restore devices.json before restarting the daemon; it fails closed on corrupt credential state"
                    .to_string(),
            );
        }
    };
    let token_ok = read_token(paths).is_some();
    let vapid_ok = paths.vapid_file.is_file();
    let mut detail = format!(
        "{} writable; auth token: {}",
        state.display(),
        if token_ok { "present" } else { "MISSING" }
    );
    detail.push_str(&format!(
        "; VAPID keys: {}",
        if vapid_ok {
            "present".to_string()
        } else {
            "not generated yet (created on the first push notification)".to_string()
        }
    ));
    detail.push_str(&format!(
        "; device credentials: {} active, {} revoked",
        registry.active_count(),
        registry.revoked_count()
    ));
    // The legacy location still existing next to the new one is the migration
    // having run: `Paths::resolve` copies the old files across (never moves
    // them), so both existing at once is the expected, healthy state.
    if paths.home.join(".omp/omp-remote.token").is_file() && paths.token_file.is_file() {
        detail.push_str(
            "; legacy ~/.omp/omp-remote.token still present alongside the new token file (migrated by copy, as designed)",
        );
    }
    if token_ok {
        pass("state-dir", detail)
    } else {
        fail(
            "state-dir",
            detail,
            "run `omp-pulse setup` to generate a token (or set OMP_PULSE_TOKEN), then restart the daemon; without one every /api route rejects with 401"
                .to_string(),
        )
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `bind-exposure` — what the configured bind means. Never a failure,
// but always visible.
// ───────────────────────────────────────────────────────────────────────────

fn is_private_ip(host: &str) -> bool {
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return ip.is_private() || ip.is_link_local();
    }
    if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
        // Unique-local (fc00::/7), loopback, or link-local (fe80::/10).
        return ip.is_unique_local() || ip.is_loopback() || (ip.segments()[0] & 0xffc0) == 0xfe80;
    }
    false
}

fn classify_bind(bind: &str) -> &'static str {
    let b = bind.trim().trim_start_matches('[').trim_end_matches(']');
    match b {
        "127.0.0.1" | "::1" | "localhost" => "loopback",
        "0.0.0.0" | "::" => "all",
        _ if is_private_ip(b) => "lan",
        _ => "specific",
    }
}

/// Report the bind the RUNNING daemon chose, falling back to the resolved
/// configuration when it is not reachable.
///
/// WHY: a service unit passes `--bind` on the command line, so the environment
/// this check reads can say 127.0.0.1 while the daemon is actually listening on
/// a tailnet address. Reporting the configured value in that case is worse than
/// saying nothing: it tells an operator they are unexposed when they are not.
async fn check_bind_exposure_live(paths: &Paths, bind: &str, port: u16) -> Check {
    let live = match daemon_get(paths, bind, port, "/api/status").await {
        Ok((status, body)) if status == "200" => serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("bind")
                    .and_then(|b| b.as_str())
                    .map(|s| s.to_string())
            }),
        _ => None,
    };
    match live {
        Some(actual) => {
            let (host, p) = match actual.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), p.parse().unwrap_or(port)),
                None => (actual.clone(), port),
            };
            let mut check = check_bind_exposure(&host, p);
            check.detail = format!("{} (reported by the running daemon)", check.detail);
            check
        }
        None => check_bind_exposure(bind, port),
    }
}

fn check_bind_exposure(bind: &str, port: u16) -> Check {
    let (kind, meaning) = match classify_bind(bind) {
        "loopback" => (
            "loopback-only",
            "only this machine can reach the daemon; a phone must reach it through a tunnel (Tailscale, SSH -L) or a LAN forward",
        ),
        "lan" => (
            "LAN",
            "any device on the same network can reach it; keep the token set and mind the secure-context check below",
        ),
        "all" => (
            "all interfaces",
            "reachable from every network this machine is on; firewall exposure, so make sure a token is set",
        ),
        _ => (
            "a specific address",
            "only that network (e.g. a VPN or tailnet) can reach it",
        ),
    };
    pass(
        "bind-exposure",
        format!("daemon listens on {bind}:{port}; {kind}: {meaning}"),
    )
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `daemon` — reachable on the configured address, /api/status parses,
// and it reports its own version and app build id.
// ───────────────────────────────────────────────────────────────────────────

/// GET `<path>` on the daemon over raw HTTP/1.1 with the bearer token (no
/// HTTP client dependency). Returns `(HTTP status, body)`; `Err` carries the
/// failure detail (connect, write, read or timeout).
async fn daemon_get(
    paths: &Paths,
    bind: &str,
    port: u16,
    path: &str,
) -> Result<(String, String), String> {
    let token = read_token(paths);
    // `TcpStream::connect` needs a bracketed IPv6 literal in host:port form.
    let host = connect_host(bind);
    let addr = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let connect = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(&addr),
    );
    let mut stream = match connect.await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("{addr} unreachable: {e}")),
        Err(_) => return Err(format!("{addr} connect timed out")),
    };
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
    if let Some(t) = &token {
        req.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    req.push_str("\r\n");
    let write = tokio::time::timeout(Duration::from_secs(5), stream.write_all(req.as_bytes()));
    if let Err(e) = write.await {
        return Err(format!("write failed: {e}"));
    }
    let mut resp = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut resp)).await;
    match read {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(format!("read failed: {e}")),
        Err(_) => return Err("response timed out".to_string()),
    }
    let text = String::from_utf8_lossy(&resp);
    let (head, body) = match text.split_once("\r\n\r\n") {
        Some((h, b)) => (h.to_string(), b.to_string()),
        None => (text.to_string(), String::new()),
    };
    let status = head.split_whitespace().nth(1).unwrap_or("?").to_string();
    Ok((status, body))
}

async fn check_daemon(paths: &Paths, bind: &str, port: u16) -> Check {
    let start_fix = daemon_start_hint();
    let (status, body) = match daemon_get(paths, bind, port, "/api/status").await {
        Ok(x) => x,
        Err(detail) => return fail("daemon", detail, start_fix),
    };
    if status != "200" {
        let detail = if status == "401" {
            format!(
                "HTTP 401 — auth token missing or wrong ({}{})",
                if read_token(paths).is_none() {
                    "none configured"
                } else {
                    "configured"
                },
                if read_token(paths).is_none() {
                    "; see the state-dir check"
                } else {
                    ""
                }
            )
        } else {
            format!("HTTP {status} — /api/status refused")
        };
        return fail("daemon", detail, start_fix);
    }
    let json = match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(v) => v,
        Err(e) => {
            return fail(
                "daemon",
                format!("HTTP 200 but /api/status body is not JSON: {e}"),
                "the deployed binary is not the omp-pulse daemon".to_string(),
            );
        }
    };
    if json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return fail(
            "daemon",
            "/api/status answers but ok != true".to_string(),
            start_fix,
        );
    }
    // /api/status reports the daemon crate version AND the app build id (the
    // fingerprint the stale-client heartbeat sends). This doctor binary
    // embeds its own copy via assets::build_id, so a mismatch means the
    // daemon is stale or has a public_dir override.
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let build_id = json
        .get("buildId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let local = assets::build_id();
    let mut detail = String::from("HTTP 200 — /api/status ok");
    match &version {
        Some(v) => detail.push_str(&format!("; daemon version {v}")),
        None => detail.push_str("; daemon version unknown (stale binary?)"),
    }
    match (&build_id, local) {
        (Some(b), l) if *b == l => {
            detail.push_str(&format!("; app build {b} (matches this binary)"));
        }
        (Some(b), l) => detail.push_str(&format!(
            "; app build {b}, this doctor binary embeds {l}; stale daemon or a public_dir override"
        )),
        (None, _) => detail.push_str("; app build id missing from /api/status (stale binary)"),
    }
    // The binary the DAEMON resolved, versus the one this doctor would resolve.
    // These diverge whenever the service's PATH differs from the shell's, which
    // is the normal case for systemd: the daemon spawned a stale ~/.bun/bin/omp
    // while doctor cheerfully reported the current ~/.local/bin/omp, so every
    // check passed while no child could boot. A diagnostic that resolves its own
    // copy of a dependency must say so out loud when it disagrees.
    let daemon_bin = json.get("ompBin").and_then(|v| v.as_str());
    let local_bin = crate::paths::find_omp_binary();
    match (daemon_bin, &local_bin) {
        (Some(d), Some(l)) if std::path::Path::new(d) == l.as_path() => {
            detail.push_str(&format!("; spawns omp at {d} (same as this shell)"));
        }
        (Some(d), Some(l)) => {
            return fail(
                "daemon",
                format!(
                    "{detail}; the daemon spawns omp at {d} but this shell resolves {}: children boot from a DIFFERENT binary than everything you test by hand",
                    l.display()
                ),
                format!(
                    "restart the daemon so it re-resolves, or pin it: set OMP_BIN={} in the service environment",
                    l.display()
                ),
            );
        }
        (Some(d), None) => detail.push_str(&format!("; spawns omp at {d}")),
        (None, _) => detail.push_str("; /api/status does not report ompBin (stale daemon)"),
    }
    pass("daemon", detail)
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `service` — the login service registration, per platform.
// ───────────────────────────────────────────────────────────────────────────

fn check_service() -> Check {
    let manager = service::manager_name();
    if manager == "unsupported" {
        return pass(
            "service",
            "not applicable on this platform; no user-level service manager, so run the daemon directly with `omp-pulse serve`"
                .to_string(),
        );
    }
    // No service manager here (phone mode under proot, containers, non-systemd
    // inits): nothing can be registered, and whatever started the daemon
    // supervises it — in phone mode the Android app restarts it. `status`'s
    // install-refusal reason told phone users to "use a non-systemd distro",
    // which is advice for a different problem on a machine they cannot change.
    if !service::supported() {
        return pass(
            "service",
            format!(
                "not applicable: {manager} is not running on this machine, so there is nothing to register; the daemon runs under whatever started it (in phone mode the Android app supervises and restarts it)"
            ),
        );
    }
    match service::status() {
        Ok(ServiceState::NotInstalled) => pass(
            "service",
            format!(
                "{manager}: not installed; run `omp-pulse service install` to start at login and restart on failure"
            ),
        ),
        Ok(ServiceState::Installed {
            running: true,
            detail,
        }) => pass(
            "service",
            format!("{manager}: installed and running ({detail})"),
        ),
        Ok(ServiceState::Installed {
            running: false,
            detail,
        }) => fail(
            "service",
            format!("{manager}: installed but not running ({detail})"),
            format!("start it: {}", daemon_start_hint()),
        ),
        Err(reason) => pass(
            "service",
            format!("not applicable on this platform; {reason}"),
        ),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `terminal-control` — what auto-collab can drive here. Informational:
// the manual /collab path always works.
// ───────────────────────────────────────────────────────────────────────────

fn check_terminal_control() -> Check {
    let backends = adopt::available_backends();
    let detail = if backends.is_empty() {
        "no adoption backend available here; auto-collab cannot drive a foreign terminal on this platform. The manual /collab path always works (run /collab in the TUI and paste the printed link once)"
            .to_string()
    } else {
        format!(
            "auto-collab can drive: {}; the manual /collab path always works as a fallback",
            backends.join(", ")
        )
    };
    pass("terminal-control", detail)
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `ownership-guard` — what protection this platform provides against
// a foreign TUI silently clobbering the session file.
// ───────────────────────────────────────────────────────────────────────────

/// Human description of a `guard::detection_capability()` string. The
/// machine-readable form is kept verbatim in the report so the raw
/// capability stays visible.
fn describe_detection(cap: &str) -> String {
    // The fd layer is /proc on Linux and libproc on macOS, so name the mechanism
    // per platform rather than claiming /proc everywhere: a macOS user reading
    // "scans /proc" would reasonably conclude the check was lying to them.
    let fd_mechanism = if cfg!(target_os = "macos") {
        "inspects open file handles (argv, libproc)"
    } else {
        "inspects open file handles (argv, /proc)"
    };
    let mut parts = Vec::new();
    if cap.contains("fd") {
        parts.push(fd_mechanism);
    }
    if cap.contains("argv") {
        parts.push("matches process arguments (argv) naming the session");
    }
    if cap.contains("sidecar") {
        parts.push("reads sidecar .owner records declared by omp-pulse children");
    }
    if parts.is_empty() {
        return format!("capability \"{cap}\"");
    }
    parts.join("; ")
}

fn check_ownership_guard() -> Check {
    let cap = guard::detection_capability();
    pass(
        "ownership-guard",
        format!(
            "protection: {} (capability {cap}); the daemon refuses to spawn a writer for a session a foreign omp process holds open",
            describe_detection(cap)
        ),
    )
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `secure-context` — whether the URL the phone will use is a secure
// context. Service workers, Web Push and DecompressionStream require one, so
// a plain-http LAN address means a degraded PWA. Informational: the degraded
// tier is a choice the user may accept.
// ───────────────────────────────────────────────────────────────────────────

/// Whether `url` is a secure context: https anywhere, or http to localhost
/// (any 127.0.0.0/8 address or ::1).
fn is_secure_context(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    match scheme {
        "https" => true,
        "http" => {
            let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
            let host = if let Some(inner) = authority.strip_prefix('[') {
                inner.split(']').next().unwrap_or("")
            } else {
                match authority.rsplit_once(':') {
                    Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => h,
                    _ => authority,
                }
            };
            is_loopback_host(host)
        }
        _ => false,
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host == "::1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

fn check_secure_context(bind: &str, port: u16) -> Check {
    let url = format!("http://{bind}:{port}/");
    let detail = if is_secure_context(&url) {
        format!(
            "{url} is a secure context; service workers, Web Push and DecompressionStream will work for the phone"
        )
    } else {
        format!(
            "{url} is NOT a secure context; plain-http means a degraded PWA: service workers, Web Push and DecompressionStream are unavailable. Remedies: reach the daemon over Tailscale, put a TLS tunnel in front, or accept the degraded tier"
        )
    };
    pass("secure-context", detail)
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `link-registry-health` — session-keyed vs room-keyed entries and
// how many room-keyed entries reference rooms with no live host.
// ───────────────────────────────────────────────────────────────────────────

/// cwds of live `omp-pulse term` pty hosts, from a `/proc` cmdline scan
/// (their session directory names follow `cwd` with `/` → `-`). Best-effort;
/// unreadable entries are skipped. Empty on platforms without /proc.
fn proc_term_host_cwds() -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if pid.parse::<u32>().is_err() {
            continue;
        }
        let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
            continue;
        };
        let text = String::from_utf8_lossy(&cmdline);
        if !text.contains("omp-pulse") && !text.contains("omp_pulse") {
            continue;
        }
        if !text.contains("term") {
            continue;
        }
        if let Ok(cwd) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
            out.push(cwd.to_string_lossy().into_owned());
        }
    }
    out
}

/// `~/.local/bin/herdr` — a terminal workspace manager for AI coding agents;
/// its `agent list` reports live omp TUIs by cwd. This is the same probe
/// `adopt` uses, kept here because the registry-health heuristic needs the
/// cwds, which `adopt::available_backends` (names only) does not expose.
const HERDR_REL: &str = ".local/bin/herdr";

/// Run `herdr agent list` and return the cwds of live `omp` agents. `None`
/// when herdr is missing, not executable, refuses, times out, or the output
/// is unparseable.
async fn herdr_omp_agent_cwds(home: &Path) -> Option<Vec<String>> {
    let herdr = home.join(HERDR_REL);
    if !herdr.is_file() || !is_executable(&herdr) {
        return None;
    }
    let out = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(&herdr)
            .args(["agent", "list"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let agents = value.get("result")?.get("agents")?.as_array()?;
    let mut cwds = Vec::new();
    for agent in agents {
        if agent.get("agent").and_then(|v| v.as_str()) != Some("omp") {
            continue;
        }
        if let Some(cwd) = agent.get("cwd").and_then(|v| v.as_str())
            && !cwd.is_empty()
        {
            cwds.push(cwd.to_string());
        }
    }
    Some(cwds)
}

/// Session-directory names that correspond to a live host's cwd: the cwd
/// RELATIVE TO HOME with `/` → `-` (the observed convention —
/// `/home/me/Coding/App` → `-Coding-App`, `/home/me/.omp` → `-.omp`),
/// plus the plain basename as a defensive fallback.
///
/// The absolute-cwd form (`cwd.replace('/', "-")`) was WRONG for real cwds:
/// `/home/me/Coding/App` became `-home-me-Coding-App`, which never matches
/// the actual session dir `-Coding-App` — so every room-keyed entry backed by
/// a herdr-hosted session was reported "almost-certainly-dead (no live host)"
/// while the host was sitting there sharing.
fn session_dirs_for_cwd(cwd: &str, home: &Path) -> Vec<String> {
    let mut names = Vec::with_capacity(3);
    let relative = Path::new(cwd)
        .strip_prefix(home)
        .unwrap_or_else(|_| Path::new(cwd));
    names.push(relative.to_string_lossy().replace('/', "-"));
    if let Some(base) = Path::new(cwd).file_name() {
        let base = base.to_string_lossy().into_owned();
        if !names.contains(&base) {
            names.push(base);
        }
    }
    names
}

/// Split the registry into session-keyed (path keys) vs room-keyed (bare
/// room-id keys) entries and report how many room-keyed entries reference
/// rooms that are almost certainly dead (no live host). A room-keyed entry
/// is judged live only when its room is embedded in a session-keyed entry
/// whose session file exists under a live host's cwd (a herdr omp agent or
/// an `omp-pulse term` pty host). This is a heuristic — an in-flight room
/// whose tap has not resolved yet is the one false positive — the daemon's
/// own prune (on the next adoption) is authoritative. Links and secrets are
/// never printed; only room ids and session basenames.
async fn check_link_registry_health(paths: &Paths) -> Check {
    let path = &paths.collab_file;
    let map = match read_registry(path) {
        Some(m) => m,
        // A missing registry is the normal state of a machine that never
        // used collab (every phone-mode install): nothing is registered, so
        // nothing can be stale. Failing here showed phone users a red check
        // telling them to start a collab room they have no use for.
        None if !path.is_file() => {
            return pass(
                "link-registry-health",
                "no collab links registered yet; nothing to check".to_string(),
            );
        }
        None => {
            return fail(
                "link-registry-health",
                "registry unparseable".to_string(),
                "run `omp-pulse term` once and start a collab room, or check the daemon logs"
                    .to_string(),
            );
        }
    };
    // Session paths always contain `/`; room ids are bare base64url; announced
    // session ids carry the `id:` prefix — the three key spaces never collide.
    let session_keys: Vec<String> = map.keys().filter(|k| k.contains('/')).cloned().collect();
    let announced_keys: Vec<String> = map
        .keys()
        .filter(|k| k.starts_with("id:"))
        .cloned()
        .collect();
    let room_keys: Vec<String> = map
        .keys()
        .filter(|k| !k.contains('/') && !k.starts_with("id:"))
        .cloned()
        .collect();

    // Room → session path, from the room embedded in each session link.
    let mut room_session: HashMap<String, String> = HashMap::new();
    for k in &session_keys {
        if let Some(room) = map.get(k).and_then(room_in_link) {
            room_session.insert(room, k.clone());
        }
    }

    // Live session-directory names: `omp-pulse term` hosts + herdr omp agents.
    let mut live_dirs: HashSet<String> = HashSet::new();
    for cwd in proc_term_host_cwds() {
        live_dirs.extend(session_dirs_for_cwd(&cwd, &paths.home));
    }
    if let Some(agent_cwds) = herdr_omp_agent_cwds(&paths.home).await {
        for cwd in agent_cwds {
            live_dirs.extend(session_dirs_for_cwd(&cwd, &paths.home));
        }
    }

    let mut dead: Vec<&str> = Vec::new();
    let mut live = 0usize;
    for rk in &room_keys {
        let Some(session_path) = room_session.get(rk.as_str()) else {
            // No session was ever resolved for this room — the host that
            // registered it is long gone.
            dead.push(rk.as_str());
            continue;
        };
        let session_file = Path::new(session_path);
        let dir_name = session_file
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if session_file.is_file() && live_dirs.contains(&dir_name) {
            live += 1;
        } else {
            dead.push(rk.as_str());
        }
    }

    // Announced mappings name no path, so liveness is link validity: an
    // unparseable announced link can never attach and counts as stale.
    let mut stale_announced = 0usize;
    for ak in &announced_keys {
        if map.get(ak).and_then(room_in_link).is_none() {
            stale_announced += 1;
        }
    }

    let mut detail = format!(
        "{} session-keyed, {} room-keyed, {} announced",
        session_keys.len(),
        room_keys.len(),
        announced_keys.len()
    );
    if stale_announced > 0 {
        detail.push_str(&format!(
            "; {stale_announced} announced {} unparseable (can never attach)",
            if stale_announced == 1 {
                "link is"
            } else {
                "links are"
            }
        ));
    }
    if room_keys.is_empty() {
        detail.push_str("; no room-keyed entries");
        return pass("link-registry-health", detail);
    }
    if dead.is_empty() && stale_announced == 0 {
        detail.push_str(&format!(
            "; all {live} room-keyed entries reference live rooms"
        ));
        return pass("link-registry-health", detail);
    }
    if !dead.is_empty() {
        let shown: Vec<&str> = dead.iter().take(6).copied().collect();
        detail.push_str(&format!(
            "; {} room-keyed {} reference almost-certainly-dead rooms (no live host): {}",
            dead.len(),
            if dead.len() == 1 { "entry" } else { "entries" },
            shown.join(", ")
        ));
        if dead.len() > shown.len() {
            detail.push_str(&format!(" …+{} more", dead.len() - shown.len()));
        }
    }
    // Stale room-keyed entries are HARMLESS: they cost bytes, adoption prunes
    // them, and a stale auto-attach gets a 4004 which prunes the link too. A
    // FAIL line has to mean something is broken, or the report stops being worth
    // reading — so report the count and stay green.
    detail.push_str("; harmless — pruned on the next adoption or on a 4004");
    pass("link-registry-health", detail)
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `live-probe` — spawn `<exe> term` in a scratch dir, wait for a NEW
// room tied to a session under the probe cwd to appear in the registry; ALWAYS
// kills the child and removes the temp dir before returning. Gated on
// adoption being available: on a platform where auto-collab cannot drive a
// foreign terminal, the probe's failure mode would be a confusing artefact of
// the platform, so it skips cleanly instead.
// ───────────────────────────────────────────────────────────────────────────

async fn check_live_probe(paths: &Paths) -> Check {
    if adopt::available_backends().is_empty() {
        return pass(
            "live-probe",
            "skipped; no adoption backend on this platform, so the auto-/collab chain is not exercised here (the manual /collab path always works)"
                .to_string(),
        );
    }
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            return fail(
                "live-probe",
                format!("cannot resolve own binary: {e}"),
                "install omp-pulse as a binary (cargo build --release)".to_string(),
            );
        }
    };
    let tag = format!("omp-pulse-doctor-{}", std::process::id());
    let tmp = std::env::temp_dir().join(&tag);
    let _ = std::fs::remove_dir_all(&tmp);
    if let Err(e) = std::fs::create_dir_all(&tmp) {
        return fail(
            "live-probe",
            format!("cannot create scratch dir {}: {e}", tmp.display()),
            "check temp dir permissions".to_string(),
        );
    }
    let registry_path = &paths.collab_file;
    let before: HashSet<String> = read_registry(registry_path)
        .as_ref()
        .map(rooms_from_map)
        .unwrap_or_default();

    let mut child = match tokio::process::Command::new(&exe)
        .arg("term")
        .current_dir(&tmp)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return fail(
                "live-probe",
                format!("term failed to start: {e}"),
                LIVE_PROBE_FIX.to_string(),
            );
        }
    };

    // Capture term's stderr tail for diagnosis (the pty host logs there).
    let stderr_tail = child.stderr.take().map(|mut s| {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = tokio::time::timeout(Duration::from_secs(45), s.read_to_end(&mut buf)).await;
            let text = String::from_utf8_lossy(&buf);
            let tail: String = text
                .chars()
                .rev()
                .take(800)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            tail
        })
    });

    // Poll the registry for a new room tied to a session under the probe cwd
    // (the TUI stores sessions under sessions/<cwd-basename>/…). 40s covers
    // the /collab settle + 3 injection retries.
    let deadline = Instant::now() + Duration::from_secs(40);
    let mut new_room: Option<String> = None;
    let mut exited: Option<String> = None;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(750)).await;
        if let Some(map) = read_registry(registry_path) {
            new_room = map.iter().find_map(|(k, v)| {
                if !k.contains('/') || !k.contains(tag.as_str()) {
                    return None;
                }
                let room = room_in_link(v)?;
                (!before.contains(&room)).then_some(room)
            });
            if new_room.is_none() {
                // Fall back to any brand-new room (session naming may drift).
                let now: HashSet<String> = rooms_from_map(&map);
                new_room = now.iter().find(|r| !before.contains(*r)).cloned();
            }
            if new_room.is_some() {
                break;
            }
        }
        if let Some(status) = child.try_wait().ok().flatten() {
            exited = Some(format!("term exited early (status {status})"));
            break;
        }
    }

    let tail = match stderr_tail {
        Some(h) => tokio::time::timeout(Duration::from_millis(500), h)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default(),
        None => String::new(),
    };
    let _ = child.kill().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    let _ = std::fs::remove_dir_all(&tmp);

    match new_room {
        Some(room) => pass(
            "live-probe",
            format!(
                "new room {} registered via auto-/collab + scrape + register (cwd {})",
                room,
                tmp.display()
            ),
        ),
        None => {
            let mut detail =
                exited.unwrap_or_else(|| "no new room registered within 40s".to_string());
            if !tail.is_empty() {
                detail.push_str(&format!("; term stderr tail: {}", tail.trim()));
            }
            fail("live-probe", detail, LIVE_PROBE_FIX.to_string())
        }
    }
}

/// Shared FIX text for the live-probe failure: the two known silent-breakage
/// causes are omp's `/collab` grammar and the link render.
const LIVE_PROBE_FIX: &str = "omp's /collab grammar changed or the link render changed — inspect the injection candidates (the bare `/collab` + CR writes) and scrape_link (COLLAB_LINK_PATTERN) in src/bin/omp-pulse/term.rs against the current omp output (collabLinkHint); re-run after adjusting";

// ───────────────────────────────────────────────────────────────────────────
// Check: `omp-version-drift` — compare current version to the one recorded
// at the last passing live-probe; write a fresh record (0600) on a pass.
// ───────────────────────────────────────────────────────────────────────────

fn check_version_drift(paths: &Paths, version: Option<&str>, probe_passed: bool) -> Check {
    let path = paths.state_dir.join(DRIFT_STATE_FILE);
    let recorded: Option<(String, u64)> = std::fs::read_to_string(&path).ok().and_then(|text| {
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        let ver = v.get("version")?.as_str()?;
        let ts = v.get("lastPassedProbe")?.as_u64()?;
        Some((ver.to_string(), ts))
    });

    let write_state = |v: &str| {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let body = serde_json::json!({ "version": v, "lastPassedProbe": ts }).to_string();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::write(&path, body).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    };

    let Some(current) = version else {
        return pass(
            "omp-version-drift",
            "omp version unknown; nothing to compare".to_string(),
        );
    };
    if !probe_passed {
        return match &recorded {
            Some((v, ts)) => pass(
                "omp-version-drift",
                format!(
                    "last passing probe recorded {v} at ts {ts}; live-probe did not pass this run — record not updated"
                ),
            ),
            None => pass(
                "omp-version-drift",
                "no prior passing probe recorded; live-probe did not pass this run".to_string(),
            ),
        };
    }
    match &recorded {
        Some((old, ts)) if old != current => {
            write_state(current);
            fail(
                "omp-version-drift",
                format!("omp updated {old} -> {current} since the last passing probe (ts {ts})"),
                format!(
                    "a version bump is the known silent-breakage trigger — the live-probe above passed, so the /collab + link-render chain still works; state file now records {current}"
                ),
            )
        }
        Some((old, ts)) => {
            write_state(current);
            pass(
                "omp-version-drift",
                format!("no drift since the last passing probe ({old} at ts {ts})"),
            )
        }
        None => {
            write_state(current);
            pass(
                "omp-version-drift",
                format!(
                    "no prior passing probe recorded; wrote {current} to {}",
                    path.display()
                ),
            )
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Check: `daemon-metrics` — informational counters from /api/status.
// ───────────────────────────────────────────────────────────────────────────

/// The counters `GET /api/status` reports, in display order.
const METRIC_COUNTERS: [&str; 11] = [
    "prompt_via_host",
    "prompt_via_child",
    "prompt_refused_owned",
    "adopt_attempt",
    "adopt_success",
    "adopt_stale_view",
    "adopt_no_pane",
    "child_spawn",
    "child_evict",
    "attach_success",
    "attach_failure",
];

/// The timings `GET /api/status` reports, as (name, label).
const METRIC_TIMINGS: [(&str, &str); 3] = [
    ("adopt_ms", "adopt"),
    ("child_boot_ms", "child boot"),
    ("attach_ms", "attach"),
];

/// Fetch `GET /api/status` (same raw HTTP/1.1 + bearer-token approach as
/// `daemon`) and print the interesting counters: prompts via host vs child,
/// refusals, adoptions, attaches, child spawn/evict, and the
/// adopt/attach/child-boot timings. PASS whenever the endpoint answers; this
/// check is informational, so zero counters are `no traffic yet`, not a fault.
async fn check_daemon_metrics(paths: &Paths, bind: &str, port: u16) -> Check {
    let (status, body) = match daemon_get(paths, bind, port, "/api/status").await {
        Ok(x) => x,
        Err(detail) => {
            return fail("daemon-metrics", detail, daemon_start_hint());
        }
    };
    if status != "200" {
        return fail(
            "daemon-metrics",
            format!("HTTP {status} — /api/status missing or refused"),
            "the running daemon predates the metrics endpoint — restart it with the current binary"
                .to_string(),
        );
    }
    let value: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            return fail(
                "daemon-metrics",
                format!("HTTP 200 but /api/status body is not JSON: {e}"),
                "the deployed binary is not the metrics-aware omp-pulse".to_string(),
            );
        }
    };
    // /api/status nests these under "metrics" (`metrics.counters` /
    // `metrics.timings`). Reading the top level made this check report
    // "no traffic yet" forever while the daemon was actually refusing and
    // adopting — the failure this check exists to surface.
    let counters = value
        .get("metrics")
        .and_then(|m| m.get("counters"))
        .and_then(|c| c.as_object());
    let timings = value
        .get("metrics")
        .and_then(|m| m.get("timings"))
        .and_then(|t| t.as_object());
    let counter = |name: &str| -> u64 {
        counters
            .and_then(|o| o.get(name))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
    };
    let timing = |name: &str| -> Option<(u64, u64, u64)> {
        let o = timings?.get(name)?.as_object()?;
        Some((
            o.get("count")?.as_u64()?,
            o.get("total_ms")?.as_u64()?,
            o.get("max_ms")?.as_u64()?,
        ))
    };

    let host = counter("prompt_via_host");
    let child = counter("prompt_via_child");
    let refused = counter("prompt_refused_owned");
    let adopt_attempt = counter("adopt_attempt");
    let adopt_success = counter("adopt_success");
    let adopt_stale_view = counter("adopt_stale_view");
    let adopt_no_pane = counter("adopt_no_pane");
    let child_spawn = counter("child_spawn");
    let child_evict = counter("child_evict");
    let attach_success = counter("attach_success");
    let attach_failure = counter("attach_failure");

    let mut parts: Vec<String> = Vec::new();
    parts.push(format!(
        "prompts: {host} via host, {child} via child, {refused} refused"
    ));
    parts.push(format!(
        "adoptions: {adopt_attempt} attempted, {adopt_success} succeeded ({adopt_stale_view} stale-view, {adopt_no_pane} no-pane)"
    ));
    parts.push(format!(
        "children: {child_spawn} spawned, {child_evict} evicted"
    ));
    parts.push(format!(
        "attaches: {attach_success} ok, {attach_failure} failed"
    ));

    let mut timing_parts: Vec<String> = Vec::new();
    for (name, label) in METRIC_TIMINGS {
        if let Some((count, total, max)) = timing(name)
            && let Some(avg) = total.checked_div(count)
        {
            timing_parts.push(format!("{label}: {count}× avg {avg} ms max {max} ms"));
        }
    }
    if !timing_parts.is_empty() {
        parts.push(timing_parts.join("; "));
    }

    let any_traffic = METRIC_COUNTERS.iter().any(|n| counter(n) > 0);
    let detail = if any_traffic {
        parts.join("; ")
    } else {
        format!("{}; no traffic yet", parts.join("; "))
    };
    pass("daemon-metrics", detail)
}

// ───────────────────────────────────────────────────────────────────────────
// Runner
// ───────────────────────────────────────────────────────────────────────────

/// Run every check against the daemon-facing configuration. Shared by the
/// CLI printer ([`run`]) and the `GET /api/diagnostics` endpoint — one
/// source of truth, so the endpoint's `checks` array IS the report the CLI
/// prints, in data form.
///
/// A RUNNING daemon publishes its real address; prefer that over the address
/// this process would resolve, because a service unit's flags are invisible
/// here and probing the wrong address reports a healthy daemon as down.
pub async fn run_checks(cfg: &Config) -> Vec<Check> {
    let live = crate::paths::read_runtime(&cfg.paths);
    let (bind_owned, port) = match &live {
        Some(rt) => (rt.bind.clone(), rt.port),
        None => (cfg.host.clone(), cfg.port),
    };
    let bind = bind_owned.as_str();

    let mut checks: Vec<Check> = Vec::new();

    let (check_omp, version) = check_omp_binary().await;
    checks.push(check_omp);
    checks.push(check_sessions_root(&cfg.paths));
    checks.push(check_stranded_sessions(&cfg.paths));
    checks.push(check_state_dir(&cfg.paths));
    checks.push(check_bind_exposure_live(&cfg.paths, bind, port).await);
    checks.push(check_daemon(&cfg.paths, bind, port).await);
    checks.push(check_service());
    checks.push(check_terminal_control());
    checks.push(check_ownership_guard());
    checks.push(check_secure_context(bind, port));
    checks.push(check_link_registry_health(&cfg.paths).await);
    checks.push(check_daemon_metrics(&cfg.paths, bind, port).await);
    checks.push(check_live_probe(&cfg.paths).await);
    let probe_passed = checks.last().map(|c| c.passed).unwrap_or(false);
    checks.push(check_version_drift(
        &cfg.paths,
        version.as_deref(),
        probe_passed,
    ));
    checks
}

/// (a failed CHECK is a normal report line, not an Err).
pub async fn run() -> Result<(), String> {
    let cfg = effective_config().map_err(|e| format!("cannot resolve daemon config: {e}"))?;
    let checks = run_checks(&cfg).await;
    for c in &checks {
        c.report();
    }
    let passed = checks.iter().filter(|c| c.passed).count();
    println!(
        "doctor: {} passed, {} failed",
        passed,
        checks.len() - passed
    );
    Ok(())
}

// ───────────────────────────────────────────────────────────────────────────
// Registry helpers, shared by the live-probe and registry-health checks.
// (`rm -rf` on a superseded check took these with it; they are small, pure and
// belong here regardless of which check happens to use them.)

/// The stored-link registry as a flat map, or `None` when missing/unparseable.
/// Keys are either session paths (they contain `/`) or room ids; values are
/// collab links, which this module NEVER prints.
fn read_registry(path: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// The room id embedded in a collab link (`ws(s)://host/r/<room>.<secret>`).
fn room_in_link(link: &serde_json::Value) -> Option<String> {
    let s = link.as_str()?;
    let after = s.rsplit_once("/r/")?.1;
    let room = after.split('.').next()?;
    (!room.is_empty()).then(|| room.to_string())
}

/// Every room id the registry knows: room-keyed entries plus the rooms embedded
/// in session-keyed and announced (`id:`) links.
fn rooms_from_map(map: &serde_json::Map<String, serde_json::Value>) -> HashSet<String> {
    let mut out = HashSet::new();
    for (k, v) in map {
        if k.contains('/') || k.starts_with("id:") {
            if let Some(room) = room_in_link(v) {
                out.insert(room);
            }
        } else {
            out.insert(k.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_context_decisions() {
        // Acceptance cases.
        assert!(is_secure_context("https://x"));
        assert!(is_secure_context("http://localhost"));
        assert!(is_secure_context("http://127.0.0.1"));
        assert!(!is_secure_context("http://192.168.1.5"));
        // Ports, paths, IPv6 and the rest of 127.0.0.0/8.
        assert!(is_secure_context("https://omp.example.com:7682/"));
        assert!(is_secure_context("http://localhost:7682/"));
        assert!(is_secure_context("http://127.0.0.1:7682/"));
        assert!(is_secure_context("http://127.0.1.9:7682"));
        assert!(is_secure_context("http://[::1]:7682/"));
        assert!(!is_secure_context("http://10.0.0.5:7682"));
        assert!(!is_secure_context("http://172.16.4.4:7682"));
        assert!(!is_secure_context("http://omp.local:7682"));
        assert!(!is_secure_context("192.168.1.5:7682")); // no scheme
        assert!(!is_secure_context(""));
    }

    #[test]
    fn bind_classification() {
        assert_eq!(classify_bind("127.0.0.1"), "loopback");
        assert_eq!(classify_bind("::1"), "loopback");
        assert_eq!(classify_bind("localhost"), "loopback");
        assert_eq!(classify_bind("0.0.0.0"), "all");
        assert_eq!(classify_bind("::"), "all");
        assert_eq!(classify_bind("192.168.1.5"), "lan");
        assert_eq!(classify_bind("10.0.0.1"), "lan");
        assert_eq!(classify_bind("172.20.0.2"), "lan");
        assert_eq!(classify_bind("169.254.3.3"), "lan");
        assert_eq!(classify_bind("100.64.0.1"), "specific"); // tailnet IP
        assert_eq!(classify_bind("8.8.8.8"), "specific");
        assert_eq!(classify_bind("omp.local"), "specific");
    }

    #[test]
    fn detection_description_covers_known_capabilities() {
        // Full capability (Linux and macOS): all three layers named.
        let full = describe_detection("sidecar+argv+fd");
        assert!(full.contains("file handles"));
        assert!(full.contains("argv"));
        assert!(full.contains("sidecar"));
        // Reduced capability (Windows and anything else): no file-handle layer,
        // so the description must not claim one.
        let reduced = describe_detection("sidecar+argv");
        assert!(!reduced.contains("file handles"));
        assert!(reduced.contains("argv"));
        assert!(reduced.contains("sidecar"));
        // An unknown capability string is reported verbatim rather than guessed at.
        assert_eq!(
            describe_detection("something-new"),
            "capability \"something-new\""
        );
    }
}
