//! Command-line interface. Clap derive definitions plus the small pure
//! helpers (pairing URL, QR rendering, loopback check, token generation) and
//! the pairing planner that decides which URL to print (HTTPS front door vs
//! direct link). The subcommand BODIES live in the binary (`src/bin/omp-pulse/main.rs`).

use std::path::PathBuf;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};
use qrcode::QrCode;
use qrcode::render::unicode;

use crate::types::CliOverrides;

/// Drive your Oh My Pi coding sessions from your phone.
#[derive(Parser, Debug)]
#[command(
    name = "omp-pulse",
    version,
    about = "Drive your Oh My Pi coding sessions from your phone",
    long_about = "Drive your Oh My Pi coding sessions from your phone: a single-binary \
                  daemon plus an installable PWA. It watches omp's session files, spawns \
                  omp RPC children and serves the PWA, so a phone can browse sessions, \
                  send prompts and watch agents work.\n\
                  \n\
                  The safe default binds to 127.0.0.1 only, so nothing is exposed. To pair \
                  a phone, run `omp-pulse setup`, then bind a LAN or Tailscale address \
                  (--bind) and keep a firewall in front of the port."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Run the daemon and serve the PWA (the default when no command is given)
    Serve(ServeArgs),
    /// First-run setup: generate keys, write the config file, and print a
    /// short-lived one-use enrollment QR code (never the owner token)
    Setup(SetupArgs),
    /// Install the omp extension used for real desktop model and reasoning controls
    DesktopControl(DesktopControlArgs),
    /// Manage plugins: folders with a manifest and a script that add views to the app
    Plugin(PluginArgs),
    /// Issue and print a short-lived one-use enrollment QR code
    Pair(PairArgs),
    /// Run the self-test chain and report problems
    Doctor,
    /// Install, remove or check the background service
    Service(ServiceArgs),
    /// Send a test notification to every device that has subscribed
    PushTest(PushTestArgs),
    /// Print version, paths and the detected omp binary
    Version,
    /// Install or check the local speech-to-text model used by the dictation button
    Asr(AsrArgs),
    /// Rotate the desktop-only owner credential after stopping the daemon.
    #[command(name = "migrate-owner-token")]
    MigrateOwnerToken,
    /// (internal) Atomically publish staged conversation files without replacement
    #[command(hide = true)]
    NativePublish,
    /// (internal) Run the desktop TUI under a daemon-owned pty
    #[command(hide = true)]
    Term {
        /// Arguments passed through to omp
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

#[derive(Debug, clap::Args)]
pub struct PairArgs {
    /// Credential role for the new device: admin, control (default), or read.
    #[arg(long, default_value = "control", value_name = "ROLE")]
    pub role: String,
    /// Optional human-readable device name.
    #[arg(long, value_name = "NAME")]
    pub name: Option<String>,
}

#[derive(Debug, Default, clap::Args)]
pub struct PushTestArgs {
    /// Only notify devices subscribed to this session file
    #[arg(long, value_name = "PATH")]
    pub session: Option<String>,
}

#[derive(Debug, Default, clap::Args)]
pub struct SetupArgs {
    /// Bind address to record in the config file; default 127.0.0.1 (loopback
    /// only). Set your LAN or Tailscale address here if a phone must reach it.
    #[arg(long, value_name = "HOST")]
    pub bind: Option<String>,
    /// Port to record in the config file (default 7681)
    #[arg(long, value_name = "PORT")]
    pub port: Option<u16>,
}

#[derive(Debug, clap::Args)]
pub struct DesktopControlArgs {
    #[command(subcommand)]
    pub command: DesktopControlCommand,
}

#[derive(Debug, Subcommand)]
pub enum DesktopControlCommand {
    /// Install or refresh the managed desktop-control extension
    Install,
}

#[derive(Debug, clap::Args)]
pub struct PluginArgs {
    #[command(subcommand)]
    pub command: PluginCommand,
}

#[derive(Debug, Subcommand)]
pub enum PluginCommand {
    /// Print the folder plugins are read from
    Dir,
    /// List installed plugins with their version and status
    List {
        /// Print the plugins as a JSON array
        #[arg(long)]
        json: bool,
    },
    /// Validate a plugin folder without installing it
    Check {
        /// The plugin folder (holds pulse-plugin.toml)
        dir: PathBuf,
    },
    /// Install a plugin folder by linking to it (it stays off until enabled)
    Link {
        /// The plugin folder (holds pulse-plugin.toml)
        dir: PathBuf,
    },
    /// Remove the link to a linked plugin
    Unlink {
        /// The plugin id
        id: String,
    },
    /// Print what a plugin may do, ask, then switch it on
    Enable {
        /// The plugin id
        id: String,
        /// Switch it on without asking (scripts; read the printed review first).
        /// Without a terminal to ask in, enabling needs this.
        #[arg(long)]
        yes: bool,
    },
    /// Switch a plugin off
    Disable {
        /// The plugin id
        id: String,
    },
    /// Show a plugin's options, or set some with KEY=VALUE pairs (true/false for switches)
    Options {
        /// The plugin id
        id: String,
        /// Option values to set, as KEY=VALUE; none lists the current values
        pairs: Vec<String>,
    },
    /// Install or refresh the pulse-plugin omp skill and /pulse-plugin command,
    /// which teach an agent to write a plugin
    Skill,
}

#[derive(Args, Debug, Default)]
pub struct ServeArgs {
    /// Bind address; default 127.0.0.1 (loopback only, nothing exposed).
    /// Set this to your machine's LAN or Tailscale IP to reach the PWA from
    /// a phone, and read docs/user/networking.md before exposing the daemon.
    #[arg(long, value_name = "HOST")]
    pub bind: Option<String>,
    /// Port to listen on (default 7681)
    #[arg(long)]
    pub port: Option<u16>,
    /// Auth token, overriding the token file (for scripts and tests)
    #[arg(long, value_name = "TOKEN")]
    pub token: Option<String>,
    /// Serve the web app from this directory instead of the embedded copy
    #[arg(long, value_name = "DIR")]
    pub public_dir: Option<PathBuf>,
    /// Path to the omp executable
    #[arg(long, value_name = "BIN")]
    pub omp_bin: Option<PathBuf>,
    /// Config file to read (default <config_dir>/omp-pulse/config.toml)
    #[arg(long, value_name = "FILE")]
    pub config: Option<PathBuf>,
}

impl ServeArgs {
    /// Convert to the layered-resolution overrides consumed by
    /// [`Config::from_layers`].
    pub fn overrides(&self) -> CliOverrides {
        CliOverrides {
            bind: self.bind.clone(),
            port: self.port,
            token: self.token.clone(),
            public_dir: self.public_dir.clone(),
            omp_bin: self.omp_bin.clone(),
            config: self.config.clone(),
        }
    }
}

#[derive(Args, Debug)]
pub struct ServiceArgs {
    #[command(subcommand)]
    pub command: ServiceCommand,
}

#[derive(Args, Debug)]
pub struct AsrArgs {
    #[command(subcommand)]
    pub command: AsrCommand,
}

#[derive(Subcommand, Debug)]
pub enum AsrCommand {
    /// Download the model and build the sidecar environment (about 650 MB)
    Install {
        /// Install the 25-language model instead of the English-only one. English
        /// only is the default because it is more accurate on English and cannot
        /// mis-detect the language of a three-second clip.
        #[arg(long)]
        multilingual: bool,
    },
    /// Report whether dictation is ready, and why not if it is not
    Status,
}

#[derive(Subcommand, Debug)]
pub enum ServiceCommand {
    /// Install the background service (systemd user unit, launchd or Task Scheduler)
    Install {
        /// Bind address to bake into the service (default: current config)
        #[arg(long, value_name = "HOST")]
        bind: Option<String>,
        /// Port to bake into the service (default: current config)
        #[arg(long)]
        port: Option<u16>,
    },
    /// Remove the background service
    Uninstall,
    /// Show whether the service is installed and running
    Status,
}

/// The pairing deep link opens the web app and carries a short-lived enrollment
/// code. The owner token is deliberately never embedded in a phone URL.
pub fn pairing_url(base: &str, code: &str) -> String {
    let base = base.trim_end_matches('/');
    let app = if base.ends_with("/app") {
        base.to_string()
    } else {
        format!("{base}/app")
    };
    format!("{app}/#pair={code}")
}

/// Render `data` as a scannable terminal QR code (UTF-8 half-block glyphs,
/// one module per character cell, with the quiet zone included).
pub fn render_qr(data: &str) -> Result<String, String> {
    let code = QrCode::new(data).map_err(|e| format!("cannot encode QR code: {e}"))?;
    Ok(code.render::<unicode::Dense1x2>().quiet_zone(true).build())
}

/// True when the bind host is loopback-only, i.e. reachable from this
/// machine but nowhere else.
pub fn is_loopback(host: &str) -> bool {
    matches!(
        host,
        "127.0.0.1" | "localhost" | "::1" | "[::1]" | "0:0:0:0:0:0:0:1"
    )
}

/// Everything `pair` (and the pairing block of `setup`) needs to print: the
/// primary link, the daemon facts behind it, and whether an HTTPS front door
/// fronts the daemon.
pub struct Pairing {
    /// The primary link the phone should open: the HTTPS front door when one
    /// serves this daemon, otherwise the direct `http://host:port` link.
    pub url: String,
    /// The daemon's actual bind host: from `/api/status` when it answers,
    /// otherwise the caller's resolution (runtime file, then config).
    pub host: String,
    /// The daemon's actual port.
    pub port: u16,
    /// The HTTPS front-door origin (e.g. `https://desktop.tail1234ab.ts.net/`)
    /// when `tailscale serve` fronts this daemon, else `None`.
    pub front_door: Option<String>,
    /// True when the daemon binds loopback only. The loopback warning is only
    /// printed when this is true AND no front door was found.
    pub loopback_only: bool,
}

/// Resolve the pairing display with the owner token only for the local
/// `/api/status` probe. The returned URL contains `code`, never `owner_token`.
pub fn plan_pairing_with_owner(host: &str, port: u16, owner_token: &str, code: &str) -> Pairing {
    // The daemon's own word beats any file: `/api/status` publishes `bind`
    // as "host:port". Fall back to the caller's resolution when it does not
    // answer. An empty owner token intentionally disables this probe.
    let (host, port) = match live_daemon_addr(host, port, owner_token) {
        Some((host, port)) => (host, port),
        None => (host.to_string(), port),
    };
    let front_door = detect_front_door(&host, port);
    let url = match &front_door {
        Some(door) => pairing_url(door, code),
        None => pairing_url(&format!("http://{host}:{port}"), code),
    };
    let loopback_only = is_loopback(&host);
    Pairing {
        url,
        host,
        port,
        front_door,
        loopback_only,
    }
}

/// Print the pairing block: the primary link, a QR code encoding exactly that
/// enrollment URL, and the notes. The URL carries only a short-lived,
/// single-use code; the desktop owner token is never printed.
pub fn print_pairing(plan: &Pairing) {
    println!("{}\n", plan.url);
    match render_qr(&plan.url) {
        Ok(qr) => println!("{qr}\n"),
        Err(e) => eprintln!("{e}"),
    }
    // A plain-HTTP origin is not a secure context, so the PWA's microphone,
    // service worker (offline support) and Web Push would all be unavailable
    // there. The HTTPS origin fixes all three, which is why it is preferred.
    // The URL contains only a one-use enrollment code, never the owner token.
    if plan.front_door.is_some() {
        println!(
            "This HTTPS link is preferred: it is a secure context, which the microphone, \
             offline support and notifications require."
        );
        println!(
            "The link contains a short-lived, single-use enrollment code. Treat it as \
             sensitive until pairing completes."
        );
    } else {
        // No front door: offer the one-liner that creates one. It always
        // targets 127.0.0.1 because tailscale serve proxies to a local
        // address regardless of what the daemon binds.
        println!(
            "No HTTPS front door found. Make the link secure (needed for the microphone, \
             offline support and notifications) with:\n  tailscale serve --bg --set-path / \
             http://127.0.0.1:{}\n",
            plan.port
        );
        if plan.loopback_only {
            println!(
                "Note: the daemon binds {} (loopback only), so the direct link above only \
                 works from this machine.",
                plan.host
            );
        } else {
            println!(
                "Warning: binding {} exposes the daemon to every machine that can reach it. \
                 Keep a firewall in front of port {} (see docs/user/networking.md).",
                plan.host, plan.port
            );
        }
    }
}

/// Ask the running daemon for its actual bind address. `/api/status`
/// requires the bearer token (every `/api/*` route does) and publishes
/// `bind` as `"host:port"`. Returns `None` on any failure — daemon down,
/// wrong token, non-JSON body, missing `bind` — so the caller keeps its own
/// resolution instead.
fn live_daemon_addr(host: &str, port: u16, token: &str) -> Option<(String, u16)> {
    let url = format!("http://{host}:{port}/api/status");
    // Bounded like the push client so a dead address cannot pin `pair`
    // forever; the daemon answers in milliseconds when it is up.
    let agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(3)))
        .timeout_global(Some(Duration::from_secs(6)))
        .build()
        .new_agent();
    let resp = agent
        .get(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .ok()?;
    let body = resp.into_body().read_to_string().ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let bind = json.get("bind").and_then(|b| b.as_str())?;
    parse_host_port(bind)
}

/// Split a `"host:port"` string (as `/api/status` publishes `bind`),
/// tolerating a bracketed IPv6 host. `None` when the port is absent or not
/// numeric — the caller then keeps its own resolution.
fn parse_host_port(s: &str) -> Option<(String, u16)> {
    if let Some(rest) = s.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = after.strip_prefix(':')?.parse().ok()?;
        Some((host.to_string(), port))
    } else {
        let (host, port) = s.rsplit_once(':')?;
        Some((host.to_string(), port.parse().ok()?))
    }
}

/// Find the HTTPS front door that serves this daemon, if any. The lookup is
/// strictly best-effort: `tailscale` missing, failing or returning something
/// we do not understand all mean "no front door".
/// The HTTPS origin a phone should use, if a tailscale serve front door proxies
/// this daemon. Shelling out to `tailscale serve status --json` costs ~50ms, so
/// callers on a hot path (the status endpoint) MUST cache the result; `pair` calls
/// it once per invocation.
pub fn detect_front_door(host: &str, port: u16) -> Option<String> {
    let status = tailscale_serve_status_json()?;
    front_door_from_status(&status, host, port)
}

/// Locate the `tailscale` CLI.
///
/// WHY NOT JUST PATH: a systemd/launchd service inherits a minimal PATH
/// (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`), while the
/// binary is frequently a per-user install — measured on this machine at
/// `~/.local/bin/tailscale`, which the service could not see. The result was a
/// daemon that silently reported no HTTPS front door while `pair`, run from an
/// interactive shell, found one: the same class of bug as resolving `omp` from a
/// shell PATH that the service did not share.
fn tailscale_binary() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            candidates.push(dir.join("tailscale"));
            // WHY: the Windows installer ships `tailscale.exe`, and a candidate
            // without the extension is never a file there — `is_file` rejected
            // it, so a Windows daemon with a working `tailscale serve` front
            // door reported none and printed a loopback-only pairing link.
            #[cfg(windows)]
            candidates.push(dir.join("tailscale.exe"));
        }
    }
    if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
        candidates.push(home.join(".local/bin/tailscale"));
        candidates.push(home.join("bin/tailscale"));
    }
    // The Windows installer's fixed location, which a logon task's PATH (and
    // %LOCALAPPDATA%-only installs) may not include. Same class of bug as the
    // minimal service PATH above.
    #[cfg(windows)]
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            std::path::Path::new(&program_files)
                .join("Tailscale")
                .join("tailscale.exe"),
        );
    }
    candidates.push(std::path::PathBuf::from("/usr/bin/tailscale"));
    candidates.push(std::path::PathBuf::from("/usr/local/bin/tailscale"));
    // macOS App Store build ships the CLI inside the bundle.
    candidates.push(std::path::PathBuf::from(
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ));
    candidates.into_iter().find(|p| p.is_file())
}

/// Run `tailscale serve status --json`. `None` on any failure (binary
/// missing, non-zero exit, unparseable output) — pairing must keep working
/// on machines without tailscale.
fn tailscale_serve_status_json() -> Option<serde_json::Value> {
    let output = std::process::Command::new(tailscale_binary()?)
        .args(["serve", "status", "--json"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// Recover the public `https://<dns-name>/` origin of the first `tailscale
/// serve` handler whose proxy target is this daemon's `host:port`. Accepts a
/// loopback target (`127.0.0.1`/`localhost`) as well as the bind address
/// itself — serve always proxies to a local address, so the daemon's own
/// tailnet IP never appears in the table.
fn front_door_from_status(status: &serde_json::Value, host: &str, port: u16) -> Option<String> {
    // Modern `tailscale serve status --json` publishes the table flat under
    // `Web`; older releases nested it under `ServeConfig.Web`. Accept both so
    // a stale tailscale still yields a working link.
    let web = status
        .get("Web")
        .or_else(|| status.get("ServeConfig").and_then(|c| c.get("Web")))?;
    let web = web.as_object()?;
    for (key, entry) in web {
        // The key is "<dns-name>:<port>"; the origin wants the dns-name only.
        let dns_name = key.rsplit_once(':').map(|(name, _)| name).unwrap_or(key);
        let Some(handlers) = entry.get("Handlers").and_then(|h| h.as_object()) else {
            continue;
        };
        for handler in handlers.values() {
            let Some(proxy) = handler.get("Proxy").and_then(|p| p.as_str()) else {
                continue;
            };
            if let Some((target_host, target_port)) = proxy_target(proxy)
                && target_port == port
                && (target_host == host || target_host == "127.0.0.1" || target_host == "localhost")
            {
                return Some(format!("https://{dns_name}/"));
            }
        }
    }
    None
}

/// The `host:port` a `tailscale serve` proxy target URL points at.
fn proxy_target(url: &str) -> Option<(String, u16)> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let host_port = rest.split(['/', '?']).next()?;
    if let Some(after_bracket) = host_port.strip_prefix('[') {
        let (host, after) = after_bracket.split_once(']')?;
        let port = after.strip_prefix(':')?.parse().ok()?;
        Some((host.to_string(), port))
    } else {
        let (host, port) = host_port.rsplit_once(':')?;
        Some((host.to_string(), port.parse().ok()?))
    }
}

/// A fresh owner credential: 64 hex characters (32 random bytes). It is stored
/// for desktop administration and is never embedded in a phone pairing URL.
pub fn generate_token() -> String {
    use rand::{RngExt, rng};
    // rand 0.10: `random()` on the Rng trait; the crate's other call sites
    // (collab.rs room keys) use the same spelling.
    let bytes: [u8; 32] = rng().random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_url_uses_app_pair_fragment_without_owner_token() {
        assert_eq!(
            pairing_url("http://10.0.0.5:7681", "abc"),
            "http://10.0.0.5:7681/app/#pair=abc"
        );
        // A trailing slash on the base must not double up.
        assert_eq!(
            pairing_url("http://10.0.0.5:7681/", "abc"),
            "http://10.0.0.5:7681/app/#pair=abc"
        );
        // Callers that already resolved the app path also remain stable.
        assert_eq!(
            pairing_url("https://phone.example/app/", "abc"),
            "https://phone.example/app/#pair=abc"
        );
    }
    #[test]
    fn qr_renders_scannable_utf8_blocks() {
        let qr = render_qr("http://10.0.0.5:7681/app/#pair=deadbeef").unwrap();
        assert!(qr.contains('█'), "QR must use half-block glyphs");
        assert!(qr.lines().count() > 10);
    }

    #[test]
    fn loopback_detection() {
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("localhost"));
        assert!(is_loopback("::1"));
        assert!(!is_loopback("0.0.0.0"));
        assert!(!is_loopback("100.64.0.1"));
    }

    #[test]
    fn pairing_url_works_for_an_https_front_door() {
        assert_eq!(
            pairing_url("https://desktop.tail1234ab.ts.net/", "tok"),
            "https://desktop.tail1234ab.ts.net/app/#pair=tok"
        );
    }

    #[test]
    fn parse_host_port_handles_ipv4_and_bracketed_ipv6() {
        assert_eq!(
            parse_host_port("100.64.100.16:7682"),
            Some(("100.64.100.16".to_string(), 7682))
        );
        assert_eq!(
            parse_host_port("[::1]:7682"),
            Some(("::1".to_string(), 7682))
        );
        assert_eq!(parse_host_port("127.0.0.1"), None);
        assert_eq!(parse_host_port("host:notaport"), None);
    }

    #[test]
    fn front_door_matches_loopback_proxy_targets() {
        // Modern `tailscale serve status --json` shape; the daemon binds a
        // tailnet IP while serve proxies to 127.0.0.1.
        let status = serde_json::json!({
            "TCP": { "443": { "HTTPS": true } },
            "Web": {
                "desktop.tail1234ab.ts.net:443": {
                    "Handlers": { "/": { "Proxy": "http://127.0.0.1:7682" } }
                }
            }
        });
        assert_eq!(
            front_door_from_status(&status, "100.64.100.16", 7682),
            Some("https://desktop.tail1234ab.ts.net/".to_string())
        );
        // `localhost` is an equally valid loopback spelling.
        let localhost = serde_json::json!({
            "Web": {
                "phone.example.com:443": {
                    "Handlers": { "/": { "Proxy": "http://localhost:7682" } }
                }
            }
        });
        assert_eq!(
            front_door_from_status(&localhost, "100.64.100.16", 7682),
            Some("https://phone.example.com/".to_string())
        );
    }

    #[test]
    fn front_door_matches_the_bind_address_and_legacy_shape() {
        // A proxy target written as the daemon's own bind address matches,
        // and the older `ServeConfig` nesting is accepted too.
        let status = serde_json::json!({
            "ServeConfig": {
                "Web": {
                    "phone.example.com:443": {
                        "Handlers": { "/": { "Proxy": "http://100.64.100.16:7682" } }
                    }
                }
            }
        });
        assert_eq!(
            front_door_from_status(&status, "100.64.100.16", 7682),
            Some("https://phone.example.com/".to_string())
        );
    }

    #[test]
    fn front_door_rejects_other_ports_and_garbage_input() {
        // A handler pointing at a different port does not front this daemon.
        let wrong_port = serde_json::json!({
            "Web": {
                "other.example.com:443": {
                    "Handlers": { "/": { "Proxy": "http://127.0.0.1:9999" } }
                }
            }
        });
        assert_eq!(
            front_door_from_status(&wrong_port, "100.64.100.16", 7682),
            None
        );
        // Unrelated handlers, non-JSON-shaped tables and absent `Web` must
        // all yield `None` — never a panic.
        let unrelated = serde_json::json!({
            "Web": {
                "other.example.com:443": {
                    "Handlers": { "/static": { "Proxy": "http://127.0.0.1:7681" } }
                }
            }
        });
        assert_eq!(
            front_door_from_status(&unrelated, "100.64.100.16", 7682),
            None
        );
        assert_eq!(
            front_door_from_status(&serde_json::json!(null), "100.64.100.16", 7682),
            None
        );
        assert_eq!(
            front_door_from_status(&serde_json::json!({"Web": 42}), "100.64.100.16", 7682),
            None
        );
        assert_eq!(
            front_door_from_status(&serde_json::json!({}), "100.64.100.16", 7682),
            None
        );
        assert_eq!(
            front_door_from_status(
                &serde_json::json!({"Web": {"x:443": 7}}),
                "100.64.100.16",
                7682
            ),
            None
        );
        assert_eq!(proxy_target("not a url"), None);
        assert_eq!(proxy_target("http://127.0.0.1:notaport"), None);
    }

    #[test]
    fn generated_token_is_64_hex_chars() {
        let t = generate_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
