//! Daemon wiring for omp-pulse: CLI dispatch, module construction, the single
//! event serializer (router task), supervision, serving, and graceful shutdown.
//!
//! Event flow: modules publish `ChildEvent`/`WatchEvent` on broadcast
//! channels; exactly ONE router task consumes both, serializes each event to
//! a frame string once, and fans it out via the [`WsHub`] — O(1) per client.

mod native_publish;
mod plugin;

// The `term` subcommand host (bin-only; NOT part of the lib). It replaces a
// plain `omp` launch with the TUI under a daemon-owned pty.
// The pty-driven TUI launcher needs raw parent stdin, TIOCGWINSZ and SIGWINCH,
// none of which exist on Windows, so the module compiles only where it can run.
// Windows gets the stub that reports the platform honestly; compiling the whole
// pty implementation there produced 22 dead-code warnings for code that can
// never execute.
#[cfg(unix)]
mod term;
#[cfg(not(unix))]
mod term {
    pub async fn run() -> Result<(), String> {
        Err("omp-pulse term is not supported on this platform (Linux and macOS only)".to_string())
    }
}

use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use tokio::sync::broadcast;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use omp_pulse::cli::{self, Cli, Command, ServeArgs, ServiceCommand};
use omp_pulse::omp::child::ChildManager;
use omp_pulse::omp::collab::{CollabManager, RelayManager};
use omp_pulse::paths;
use omp_pulse::server::assets;
use omp_pulse::server::delta::DeltaEncoder;
use omp_pulse::server::device_auth::{DeviceRegistry, DeviceRole};
use omp_pulse::server::http::AppState;
use omp_pulse::server::push::{self, Push};
use omp_pulse::server::ws::{Collapse, WsHub};
use omp_pulse::service::ServiceState;
use omp_pulse::sessions::watcher::Watcher;
use omp_pulse::types::{ChildEvent, CliOverrides, Config, SharedConfig, WatchEvent};

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

/// Runtime workers: `OMP_PULSE_WORKER_THREADS`, else at most 2. The default
/// runtime starts one worker per visible core, but the daemon serves one or two
/// phones and runs listing scans and serialization on the blocking pool; extra
/// workers only add idle park/unpark churn, and on the phone every futex and
/// epoll call is also trapped by proot.
fn worker_threads() -> usize {
    worker_threads_from(
        std::env::var("OMP_PULSE_WORKER_THREADS").ok().as_deref(),
        std::thread::available_parallelism().map_or(1, |n| n.get()),
    )
}

fn worker_threads_from(env: Option<&str>, cores: usize) -> usize {
    env.and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| cores.clamp(1, 2))
}

fn main() {
    let cli = Cli::parse();
    if matches!(&cli.command, Some(Command::NativePublish)) {
        if let Err(error) = native_publish::run() {
            eprintln!("omp-pulse error: {error}");
            std::process::exit(1);
        }
        return;
    }
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads())
        .enable_all()
        .build()
        .expect("build the tokio runtime")
        .block_on(run(cli));
}

async fn run(cli: Cli) {
    let result = match cli.command.unwrap_or(Command::Serve(ServeArgs::default())) {
        Command::Serve(args) => cmd_serve(args).await,
        Command::Setup(args) => cmd_setup(args),
        Command::DesktopControl(args) => cmd_desktop_control(args),
        Command::Plugin(args) => plugin::run(args),
        Command::Pair(args) => cmd_pair(args),
        Command::Doctor => cmd_doctor().await,
        Command::MigrateOwnerToken => cmd_migrate_owner_token(),
        Command::NativePublish => {
            unreachable!("native-publish is dispatched before runtime startup")
        }
        Command::Asr(args) => match Config::from_env() {
            Err(e) => Err(format!("config error: {e}")),
            Ok(c) => {
                let cfg = Arc::new(c);
                match args.command {
                    omp_pulse::cli::AsrCommand::Install { multilingual } => {
                        omp_pulse::server::asr::install(&cfg, multilingual)
                    }
                    omp_pulse::cli::AsrCommand::Status => {
                        println!("{}", omp_pulse::server::asr::status_line(&cfg));
                        Ok(())
                    }
                }
            }
        },
        Command::Service(service) => cmd_service(service),
        Command::PushTest(args) => cmd_push_test(args).await,
        Command::Version => cmd_version().await,
        Command::Term { .. } => {
            // `omp_pulse term` is a separate entry point: the desktop TUI
            // under a daemon-owned pty (auto /collab + link scrape/register).
            // It installs its own stderr tracing and never touches daemon
            // wiring; the passthrough args are derived from the raw process
            // argv inside term::run, so nothing is forwarded from here.
            term::run().await
        }
    };
    if let Err(e) = result {
        eprintln!("omp-pulse error: {e}");
        std::process::exit(1);
    }
}

async fn cmd_doctor() -> Result<(), String> {
    // Doctor manages its own reporting (a failed CHECK is a report line, not
    // an Err); exit codes follow the uniform dispatch above.
    omp_pulse::doctor::run().await
}

/// Send one real notification per subscribed device.
///
/// This exercises the whole push chain - VAPID signing, RFC 8291 encryption and
/// the POST to the provider - against the user's actual endpoint, which is the
/// only way to know notifications work. Nothing else in the product can tell you
/// whether a phone will buzz.
async fn cmd_push_test(args: cli::PushTestArgs) -> Result<(), String> {
    init_tracing();
    let cfg: SharedConfig = Arc::new(Config::from_layers(&CliOverrides::default())?);
    let devices = Arc::new(DeviceRegistry::open(&cfg.state_dir)?);
    let push = Push::load(Arc::clone(&cfg), devices)?;
    let sessions = match args.session {
        Some(s) => vec![s],
        None => push.subscribed_sessions(),
    };
    if sessions.is_empty() {
        println!(
            "No devices are subscribed yet. Open the app on your phone, allow \
             notifications, then run this again."
        );
        return Ok(());
    }
    let mut devices = 0usize;
    for session in &sessions {
        let n = push.device_count(session);
        devices += n;
        let name = std::path::Path::new(session)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| session.clone());
        println!("sending to {n} device(s) subscribed to {name}");
        push.notify(
            session,
            "omp-pulse test",
            "Notifications are working.",
            "test",
        )
        .await;
    }
    println!(
        "\nSent {devices} notification(s). If nothing arrives, check that the app is \
         installed to your home screen and that notifications are allowed for it."
    );
    Ok(())
}

async fn cmd_version() -> Result<(), String> {
    let paths = paths::Paths::resolve()?;
    println!("omp-pulse {}", env!("CARGO_PKG_VERSION"));
    println!("app build:   {}", assets::build_id());
    println!("config file: {}", paths.config_file.display());
    println!("state dir:   {}", paths.state_dir.display());
    println!("sessions:    {}", paths.sessions_root.display());
    match paths::find_omp_binary() {
        Some(bin) => {
            println!("omp binary:  {}", bin.display());
            match omp_version(&bin).await {
                Some(v) => println!("omp version: {v}"),
                None => println!("omp version: (unavailable)"),
            }
        }
        None => println!("omp binary:  (not found; install omp or set OMP_BIN)"),
    }
    Ok(())
}

/// First line of `omp --version`, best-effort (a slow or missing binary must
/// not fail the version command).
async fn omp_version(bin: &Path) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(bin).arg("--version").output(),
    )
    .await
    .ok()?
    .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// The raw auth token for pairing: env override first, then the state-dir
/// token file (which the legacy migration populates from `~/.omp`).
fn current_token(cfg: &Config) -> Option<String> {
    std::env::var("OMP_PULSE_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("OMP_REMOTE_TOKEN")
                .ok()
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            std::fs::read_to_string(&cfg.paths.token_file)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

/// Persist a desktop-only owner credential with owner-only permissions on unix.
/// A temp file and rename keep a failed rotation from leaving a truncated
/// credential.
fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("token path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
    file.write_all(token.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("cannot persist {}: {e}", tmp.display()))?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot commit {}: {e}", path.display()))?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| format!("cannot sync {}: {e}", parent.display()))?;
    Ok(())
}

fn request_pairing_code(
    host: &str,
    port: u16,
    owner_token: &str,
    role: DeviceRole,
    name: Option<&str>,
) -> Result<String, String> {
    // The daemon is the registry's sole writer while running. Writing a code
    // from this CLI process would miss its in-memory snapshot and can overwrite
    // device revocations with an older copy of the registry.
    let host = match host {
        "0.0.0.0" => "127.0.0.1",
        "::" | "[::]" => "[::1]",
        other => other,
    };
    let authority = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(3)))
        .timeout_global(Some(Duration::from_secs(6)))
        .build()
        .new_agent();
    let mut response = agent
        .post(format!("http://{authority}/api/devices/pairing-codes"))
        .header("Authorization", format!("Bearer {owner_token}"))
        .send_json(serde_json::json!({ "role": role, "name": name }))
        .map_err(|error| {
            format!("cannot issue enrollment code; start the updated daemon first: {error}")
        })?;
    let body: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|error| format!("invalid enrollment response: {error}"))?;
    if body.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("the daemon did not issue an enrollment code".to_string());
    }
    body.get("code")
        .and_then(serde_json::Value::as_str)
        .filter(|code| !code.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "the daemon returned no enrollment code".to_string())
}

fn cmd_setup(args: cli::SetupArgs) -> Result<(), String> {
    init_tracing();
    let paths = paths::Paths::resolve()?;
    paths.ensure_dirs()?;
    // The bind/port a user passes to `setup` are exactly the ones their phone
    // will use, so they must flow into the config file AND into the enrollment
    // URL printed below.
    let overrides = CliOverrides {
        bind: args.bind.clone(),
        port: args.port,
        ..Default::default()
    };
    let cfg: SharedConfig = Arc::new(Config::from_layers(&overrides)?);

    // The owner credential is retained for desktop administration only. Setup
    // never prints it; it prints a short-lived control enrollment code instead.
    let owner_token = match current_token(&cfg) {
        Some(token) => {
            if !cfg.paths.token_file.exists() {
                write_token_file(&cfg.paths.token_file, &token)?;
            }
            token
        }
        None => {
            let token = cli::generate_token();
            write_token_file(&cfg.paths.token_file, &token)?;
            info!(path = %cfg.paths.token_file.display(), "generated a new desktop owner credential");
            token
        }
    };
    let devices = Arc::new(DeviceRegistry::open(&cfg.state_dir)?);
    let (pairing_host, pairing_port, pairing_code) = match paths::read_runtime(&cfg.paths) {
        Some(runtime) => {
            let code = request_pairing_code(
                &runtime.bind,
                runtime.port,
                &owner_token,
                DeviceRole::Control,
                None,
            )?;
            (runtime.bind, runtime.port, code)
        }
        None => {
            // First-time setup happens before serve opens the registry.
            let code = devices.issue_pairing_code(DeviceRole::Control, None)?.code;
            (cfg.host.clone(), cfg.port, code)
        }
    };

    let _push = Push::load(Arc::clone(&cfg), Arc::clone(&devices))?;

    // Config file: written once with commented defaults; never clobbers an
    // existing one (re-running setup must be safe).
    if cfg.paths.config_file.exists() {
        info!(
            path = %cfg.paths.config_file.display(),
            "config file exists; leaving it unchanged"
        );
    } else {
        if let Some(parent) = cfg.paths.config_file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        let content = omp_pulse::types::config_toml_with(args.bind.as_deref(), args.port);
        std::fs::write(&cfg.paths.config_file, content)
            .map_err(|e| format!("cannot write {}: {e}", cfg.paths.config_file.display()))?;
        info!(
            path = %cfg.paths.config_file.display(),
            "wrote config file with commented defaults"
        );
    }

    let extension_path = omp_pulse::omp::desktop_control::install_extension(&cfg)?;
    info!(
        path = %extension_path.display(),
        "installed omp desktop-control extension"
    );
    // A skill or command of the same name that the user wrote is theirs to keep:
    // the installer refuses it, and setup still completes.
    match paths::omp_agent_dir(&cfg.home)
        .and_then(|agent_dir| omp_pulse::plugins::skill::install(&agent_dir))
    {
        Ok(done) => info!(
            path = %done.skill_dir.display(),
            "installed the pulse-plugin omp skill and /pulse-plugin command"
        ),
        Err(e) => warn!(error = %e, "pulse-plugin omp skill not installed"),
    }
    println!("omp-pulse is configured.\n");
    println!("Open this address on your phone, or scan the QR code below:\n");
    let plan =
        cli::plan_pairing_with_owner(&pairing_host, pairing_port, &owner_token, &pairing_code);
    cli::print_pairing(&plan);
    println!("\nTo run it as a background service:");
    println!(
        "  omp-pulse service install --bind {} --port {}",
        cfg.host, cfg.port
    );
    println!(
        "\nThe enrollment code expires in five minutes and can be redeemed once. \
         Then start the daemon with `omp-pulse serve`."
    );
    Ok(())
}

fn cmd_desktop_control(args: cli::DesktopControlArgs) -> Result<(), String> {
    match args.command {
        cli::DesktopControlCommand::Install => {
            let cfg = Config::from_env()?;
            let path = omp_pulse::omp::desktop_control::install_extension(&cfg)?;
            println!(
                "installed omp desktop-control extension at {}",
                path.display()
            );
            println!(
                "restart omp (or reload its extensions) before using desktop model/reasoning controls"
            );
            Ok(())
        }
    }
}

fn cmd_pair(args: cli::PairArgs) -> Result<(), String> {
    let cfg = Config::from_layers(&CliOverrides::default())?;
    let owner_token = current_token(&cfg).ok_or_else(|| {
        "no owner credential found: run `omp-pulse setup` first (or set OMP_PULSE_TOKEN)"
            .to_string()
    })?;
    let role = args.role.parse::<DeviceRole>()?;
    // Prefer the RUNNING daemon's address: pairing against the configured
    // default would hand the phone a URL nothing is listening on whenever the
    // daemon was started by a service unit with its own --bind.
    let (host, port) = match paths::read_runtime(&cfg.paths) {
        Some(rt) => (rt.bind, rt.port),
        None => (cfg.host.clone(), cfg.port),
    };
    let pairing_code = request_pairing_code(&host, port, &owner_token, role, args.name.as_deref())?;
    // The owner token stays in authenticated requests to the local daemon;
    // the printed URL carries only the one-use enrollment code.
    cli::print_pairing(&cli::plan_pairing_with_owner(
        &host,
        port,
        &owner_token,
        &pairing_code,
    ));
    Ok(())
}

/// Explicitly rotate the desktop owner credential. This is intentionally a
/// separate command rather than an implicit setup side effect: operators can
/// stop the daemon, rotate, restart, and then issue fresh enrollment codes.
fn cmd_migrate_owner_token() -> Result<(), String> {
    init_tracing();
    let cfg = Config::from_layers(&CliOverrides::default())?;
    if paths::read_runtime(&cfg.paths).is_some() {
        return Err(
            "refusing to rotate the owner credential while omp-pulse is running; \
             stop the daemon/service first"
                .to_string(),
        );
    }
    if std::env::var("OMP_PULSE_TOKEN")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some()
        || std::env::var("OMP_REMOTE_TOKEN")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .is_some()
    {
        return Err(
            "refusing to rotate while OMP_PULSE_TOKEN or OMP_REMOTE_TOKEN is set; \
             unset the override so the persisted owner credential is authoritative"
                .to_string(),
        );
    }
    let old = std::fs::read_to_string(&cfg.paths.token_file)
        .map_err(|e| format!("cannot read existing owner credential: {e}"))?;
    if old.trim().is_empty() {
        return Err("existing owner credential is empty; run `omp-pulse setup` first".to_string());
    }
    let replacement = cli::generate_token();
    write_token_file(&cfg.paths.token_file, &replacement)?;
    println!(
        "Desktop owner credential rotated. Start the daemon, then run \
         `omp-pulse pair --role admin` to issue a fresh administrator enrollment code."
    );
    Ok(())
}

fn cmd_service(service: cli::ServiceArgs) -> Result<(), String> {
    match service.command {
        ServiceCommand::Install { bind, port } => {
            if !omp_pulse::service::supported() {
                return Err(format!(
                    "background service is not supported on this platform (manager: {})",
                    omp_pulse::service::manager_name()
                ));
            }
            // Defaults come from the resolved daemon config so the unit always
            // matches what `serve` would do.
            let cfg = Config::from_layers(&CliOverrides::default())?;
            let bind = bind.unwrap_or(cfg.host);
            let port = port.unwrap_or(cfg.port);
            println!("{}", omp_pulse::service::install(&bind, port)?);
        }
        ServiceCommand::Uninstall => {
            println!("{}", omp_pulse::service::uninstall()?);
        }
        ServiceCommand::Status => match omp_pulse::service::status()? {
            ServiceState::NotInstalled => {
                println!(
                    "not installed (manager: {})",
                    omp_pulse::service::manager_name()
                );
                println!("install with: omp-pulse service install");
            }
            ServiceState::Installed { running, detail } => {
                println!(
                    "installed (manager: {}): running = {running}; {detail}",
                    omp_pulse::service::manager_name()
                );
            }
        },
    }
    Ok(())
}

async fn cmd_serve(args: ServeArgs) -> Result<(), String> {
    init_tracing();
    std::panic::set_hook(Box::new(|info| {
        eprintln!("panic: {info}");
    }));

    let overrides = args.overrides();
    let cfg: SharedConfig = match Config::from_layers(&overrides) {
        Ok(cfg) => Arc::new(cfg),
        Err(e) => return Err(format!("config error: {e}")),
    };
    // Developer override: serve the web app from a live directory instead of
    // the embedded copy (http.rs reads through `assets::read`, which consults
    // this), so UI iteration needs no rebuild.
    assets::set_override_dir(cfg.public_dir.clone());
    // An installed pulse-plugin skill describes the manifest this daemon
    // validates, so an upgrade refreshes it; one never installed stays absent.
    // Test daemons (e2e/with-test-daemon.sh, the bench) keep the developer's
    // real HOME and set OMP_PULSE_SKIP_SKILL_REFRESH: without it every run from
    // a branch rewrote the developer's installed skill with that branch's copy.
    let skip_skill_refresh =
        std::env::var_os("OMP_PULSE_SKIP_SKILL_REFRESH").is_some_and(|value| !value.is_empty());
    if !skip_skill_refresh {
        let home = cfg.home.clone();
        tokio::task::spawn_blocking(move || {
            match paths::omp_agent_dir(&home)
                .and_then(|agent_dir| omp_pulse::plugins::skill::refresh_if_installed(&agent_dir))
            {
                Ok(Some(done)) if done.changed => info!(
                    path = %done.skill_dir.display(),
                    "refreshed the pulse-plugin omp skill"
                ),
                Ok(_) => {}
                Err(e) => warn!(error = %e, "pulse-plugin omp skill not refreshed"),
            }
        });
    }

    let hub = WsHub::new(cfg.clone());
    // Sessions list live push: index owns the broadcast (it knows when the
    // etag actually churned), so give it the hub here.
    omp_pulse::sessions::index::set_sessions_hub(Arc::clone(&hub));
    let delta = DeltaEncoder::new();
    let children = ChildManager::new(cfg.clone());
    // A conversation open on some phone keeps its child warm; one nobody has
    // open is reaped after `child_unwatched_secs` (child.rs reap_and_recycle).
    // Only VISIBLE pages count: the web app keeps its `/ws` open while
    // backgrounded, so counting every socket let a pocketed phone pin a
    // ~380 MB child for the full 15 min idle TTL. Streaming and the agent_end
    // buzz never read this; the watcher's tail gate below reads visibility
    // too, through `has_audience`.
    children.set_viewers({
        let hub = Arc::clone(&hub);
        Arc::new(move |session: &str| hub.visible_count(session) > 0)
            as omp_pulse::sessions::watcher::Audience
    });
    // No receiver is kept here: tokio's broadcast frees a slot's value only once
    // every receiver has read it, so an idle receiver held for the daemon's
    // lifetime pinned the last 1024 tailed batches (entries and whole partial
    // lines) in memory forever. The router subscribes when it starts.
    let watch_tx = broadcast::channel::<WatchEvent>(1024).0;
    // The watcher only pays for a tail somebody can actually receive and see:
    // at least one attached client must be VISIBLE and have queue headroom.
    // No clients, or every client stalled with a full queue, means reading and
    // parsing the tail produces frames nothing can accept — measured at
    // +320 MiB of RSS for a 150 MiB append. Stalled clients already hold a
    // resync order and refetch over HTTP, so nothing is lost by not tailing on
    // their behalf. Hidden clients (locked phone, backgrounded app: the web
    // app keeps its socket open there) count for nothing either: counting them
    // kept the tail and its 250 ms stat loop running in a pocket, so the phone
    // never slept. A hidden client whose tail is skipped is owed one resync,
    // sent when it reports visible (`tail_skipped`/`set_visible`). Turn-end
    // notifications do not depend on this: they come from the child/bridge/
    // collab event stream in the router, never from tailing.
    let audience = {
        let hub = Arc::clone(&hub);
        std::sync::Arc::new(move |session: &str| hub.has_audience(session))
            as omp_pulse::sessions::watcher::Audience
    };
    let watcher = Watcher::new(cfg.clone(), watch_tx.clone(), audience);
    watcher.on_tail_skipped({
        let hub = Arc::clone(&hub);
        Arc::new(move |session: &str| hub.tail_skipped(session))
    });
    // With no audience the watcher's tick parks; the hub restarts it on every
    // event that can create one. Weak: the watcher's audience already holds
    // the hub, and both live as long as the daemon.
    hub.set_audience_wake({
        let watcher = Arc::downgrade(&watcher);
        Box::new(move || {
            if let Some(watcher) = watcher.upgrade() {
                watcher.audience_changed();
            }
        })
    });
    watcher.start();
    // Open one live device registry for both HTTP authentication and Web Push
    // delivery checks; no delivery path reads a separate file snapshot.
    let devices = Arc::new(
        DeviceRegistry::open(&cfg.state_dir)
            .map_err(|e| format!("device registry startup failed: {e}"))?,
    );
    // Push needs the VAPID keys to sign anything; without them the feature is
    // dead, so treat a load failure as fatal with a clear message.
    let push = match Push::load(cfg.clone(), Arc::clone(&devices)) {
        Ok(push) => push,
        Err(e) => {
            error!(error = %e, "push init failed; aborting startup");
            return Err(e);
        }
    };
    let collab = CollabManager::new(
        cfg.clone(),
        Arc::clone(&hub),
        Arc::clone(&delta),
        Arc::clone(&push),
    );
    // Self-hosted collab relay (replaces the my.omp.sh dependency): the room
    // key is derived client-side from the link secret; the relay maps the
    // bare /r/{roomId} connection to a session and forwards guest-path frames.
    let relay = RelayManager::new(
        cfg.clone(),
        Arc::clone(&hub),
        Arc::clone(&delta),
        Arc::clone(&push),
    );

    // Dictation. Construction never fails and never loads a model: the sidecar
    // starts on the first recording and the reaper gives its ~1 GiB back when
    // dictation goes quiet.
    let asr = omp_pulse::server::asr::Asr::new(cfg.clone(), Some(Arc::clone(&children)));
    asr.start_reaper();
    // Security and command persistence are startup-critical. Corrupt or
    // unwritable state must stop the daemon rather than silently dropping
    // receipts or device revocations.
    let commands = Arc::new(
        omp_pulse::authority::command_ledger::CommandLedger::open(&cfg.state_dir)
            .map_err(|e| format!("command ledger startup failed: {e}"))?,
    );
    // Uncertain sends whose prompt is in the transcript were delivered: settle
    // them (startup catches restarts; a minute tick while any receipt is
    // uncertain, a child that went silent). Parked while nothing is uncertain.
    tokio::spawn(omp_pulse::authority::receipt_proof::run(Arc::clone(
        &commands,
    )));
    let session_states =
        Arc::new(omp_pulse::authority::session_state::SessionStateRegistry::default());
    omp_pulse::omp::collab::init_authority(Arc::clone(&session_states));
    // Turns the previous daemon's children were running when it died: each is
    // shown as interrupted until a new turn starts or the user dismisses it,
    // and announced once. Before the router starts, so no new turn can race it.
    for session in omp_pulse::authority::interrupted::init(&cfg.state_dir) {
        info!(session = %session, "turn cut off by the last shutdown");
        notify_interrupted(
            &push,
            &session,
            omp_pulse::authority::interrupted::Cause::Restart,
        );
    }
    let state = Arc::new(AppState {
        cfg: cfg.clone(),
        children: Arc::clone(&children),
        session_states: Arc::clone(&session_states),
        commands: Arc::clone(&commands),
        devices: Arc::clone(&devices),
        hub: Arc::clone(&hub),
        watcher: Arc::clone(&watcher),
        push: Arc::clone(&push),
        collab,
        relay,
        asr: Arc::clone(&asr),
        // Resolved here, at startup, because detection shells out to
        // `tailscale serve status --json` and `/api/status` is polled. A daemon
        // that gains a front door later is one restart from advertising it —
        // the same lifetime as the bind address it is published beside.
        https_origin: cli::detect_front_door(&cfg.host, cfg.port),
    });
    omp_pulse::sessions::index::start_session_discovery(&state);
    // herdr agent-state oracle: laptop TUI panes report working/blocked/idle
    // hook-by-hook from omp itself (exact once the herdr-omp extension loads
    // in each TUI). A 1 s `agent list` poll (40 ms) feeds the listing's
    // running/needs-reply legs and pokes refresh on change; absent herdr
    // means the task idles and heuristics carry on.
    let herdr = std::sync::Arc::new(omp_pulse::terminal::herdr_state::HerdrState::default());
    omp_pulse::terminal::herdr_state::set_global(Arc::clone(&herdr));
    omp_pulse::terminal::herdr_state::spawn_poller(Arc::clone(&herdr), Arc::clone(&state));
    let app = omp_pulse::server::http::router(Arc::clone(&state));
    omp_pulse::server::http::spawn_export_sweeper(&cfg.state_dir);
    omp_pulse::terminal::herdr_state::spawn_blocked_watcher(Arc::clone(&push));

    tokio::spawn(supervise_router(
        Arc::clone(&children),
        watch_tx,
        Arc::clone(&hub),
        Arc::clone(&delta),
        Arc::clone(&push),
        Arc::clone(&state),
    ));
    // Live activity: what every agent is doing now, pushed to the listing
    // socket and the native notification stream.
    omp_pulse::authority::activity::init(Arc::clone(&hub), Arc::clone(&session_states));
    // Desktop omp processes stream their own agent events through the
    // extension; routed through the child pipeline above.
    omp_pulse::omp::bridge::spawn(Arc::clone(&state));

    // Bind exactly the resolved host. With the loopback default the desktop
    // TUI's collab relay (ws://127.0.0.1:{port}, hardcoded by `term`) always
    // reaches the listener and nothing else can. A non-loopback bind (LAN or
    // tailnet IP, or 0.0.0.0) is how a phone connects; the warning below
    // names that exposure. Note that binding a SPECIFIC address does not
    // accept 127.0.0.1 connections — use 0.0.0.0 or :: if the TUI relay and
    // a non-loopback phone bind must coexist.
    let listener = match tokio::net::TcpListener::bind((cfg.host.as_str(), cfg.port)).await {
        Ok(l) => l,
        Err(e) => {
            error!(host = %cfg.host, port = cfg.port, error = %e, "bind failed");
            return Err(format!("bind {}:{} failed: {e}", cfg.host, cfg.port));
        }
    };
    // Warm the default listing only once the socket is accepting: see
    // `index::warm_default` for why this must never delay the bind.
    {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(error) = omp_pulse::sessions::index::warm_default(&state).await {
                warn!(error = ?error, "default session listing warm failed");
            }
        });
    }
    let addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;
    // Loopback verdict from the ACTUAL bound address, never the configured
    // string, so the log cannot diverge from what the listener accepted.
    let loopback = addr.ip().is_loopback();
    info!(
        version = env!("CARGO_PKG_VERSION"),
        app_build = assets::build_id(),
        bind = %addr,
        loopback_only = loopback,
        state_dir = %cfg.paths.state_dir.display(),
        sessions_root = %cfg.sessions_root.display(),
        omp_bin = %cfg.omp_bin.display(),
        "omp-pulse starting"
    );
    if !loopback {
        warn!(
            bind = %addr,
            "binding outside loopback: anyone who can reach this address and knows the \
             pairing token can drive your omp sessions. Point a firewall at the port, or \
             prefer the 127.0.0.1 default (docs/user/networking.md). Note the desktop TUI's \
             collab relay connects on 127.0.0.1, which this bind does not accept unless it \
             covers loopback (0.0.0.0 or ::)."
        );
    }
    // ALWAYS keep loopback reachable when the primary bind does not cover it.
    //
    // WHY: the desktop TUI's collab relay dials ws://127.0.0.1:<port>. Binding a
    // single LAN or tailnet address therefore silently breaks live sharing - the
    // phone works, /collab appears to do nothing, and nothing says why. A user who
    // narrows the bind for safety should not lose a feature for it, so the daemon
    // adds a second listener on 127.0.0.1 and shares one router between them.
    // Best-effort: if that port is already taken on loopback we log and carry on
    // rather than refusing to start.
    let loopback_listener = if loopback || addr.ip().is_unspecified() {
        None
    } else {
        match tokio::net::TcpListener::bind(("127.0.0.1", cfg.port)).await {
            Ok(l) => {
                info!(
                    port = cfg.port,
                    "also listening on 127.0.0.1 for the collab relay"
                );
                Some(l)
            }
            Err(e) => {
                warn!(
                    port = cfg.port,
                    error = %e,
                    "could not also bind 127.0.0.1: the desktop TUI's collab relay will not \
                     be able to reach this daemon, so live sharing from a terminal will fail"
                );
                None
            }
        }
    };
    state.relay.register_listener(addr);
    if let Some(listener) = &loopback_listener
        && let Ok(address) = listener.local_addr()
    {
        state.relay.register_listener(address);
    }
    info!(
        "listening on http://{addr} (collab relay: ws://127.0.0.1:{})",
        cfg.port
    );
    // Two daemons sharing one state dir is a misconfiguration, not a feature:
    // they would fight over the token file, the push store and the link
    // registry, and whichever wrote last would own the descriptor that `doctor`
    // and `pair` trust. Say so plainly rather than letting the symptoms appear
    // later as "my phone paired with the wrong instance".
    if let Some(other) = paths::read_runtime(&cfg.paths)
        && other.pid != std::process::id()
    {
        warn!(
            other_pid = other.pid,
            other_bind = %format!("{}:{}", other.bind, other.port),
            state_dir = %cfg.paths.state_dir.display(),
            "another omp-pulse is already running against this state directory; \
             they will contend for the token, push store and link registry. Use a \
             separate OMP_PULSE_STATE_DIR per instance."
        );
    }
    // Publish where we actually are, so `omp-pulse doctor` and `omp-pulse pair`
    // work for a daemon started by a service unit with flags they cannot see.
    paths::write_runtime(
        &cfg.paths,
        &paths::RuntimeInfo {
            bind: addr.ip().to_string(),
            port: addr.port(),
            pid: std::process::id(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            build: assets::build_id().to_string(),
        },
    );

    let serve = axum::serve(listener, app.clone());
    let serve_loopback = async {
        match loopback_listener {
            Some(l) => axum::serve(l, app).await,
            // Never resolves, so the select below is driven by the primary
            // listener and the shutdown signal exactly as before.
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        res = serve => {
            if let Err(e) = res {
                error!(error = %e, "server error");
            }
        }
        res = serve_loopback => {
            if let Err(e) = res {
                error!(error = %e, "loopback server error");
            }
        }
        _ = shutdown_signal() => {
            info!("shutdown signal received; killing children");
            children.shutdown().await;
            asr.shutdown().await;
        }
    }
    paths::clear_runtime(&cfg.paths);
    info!("omp-pulse stopped");
    Ok(())
}

/// Best-effort `needs_input` push for a child `extension_ui_request` event:
/// only blocking dialogs (`ui_dialog::BLOCKING_METHODS`, `ask` included)
/// warrant a push; setWidget/notify/setStatus/setTitle/... are
/// fire-and-forget UI pushes, not questions. The body is the question itself
/// (`ui_dialog::question_text`), never the method name: every such request
/// carries `method`, so trying it first made every push read "confirm". The
/// debounce and 120-char cap live in `push::maybe_push_needs_input`, which
/// the collab forward path shares, so both kinds of dialog notify through ONE
/// per-session window. The dialog's id travels as the payload's optional
/// `reqId` so a notification tap can land on the exact question.
fn maybe_push_needs_input(push: &Arc<Push>, session: &str, event: &serde_json::Value) {
    use omp_pulse::omp::ui_dialog;
    if !ui_dialog::is_blocking(event.get("method").and_then(|m| m.as_str())) {
        return;
    }
    let body = ui_dialog::question_text(event).unwrap_or_else(|| "agent needs your input".into());
    push::maybe_push_needs_input_with_req_id(push, session, &body, extension_req_id(event));
}

/// The one notification for a turn that was cut off. It goes out as
/// `agent_end`, the kind the phone already treats as "this turn is over":
/// it clears the live working notification and offers Reply, and the user
/// asked to be notified on turn ends only. Nothing is resent; the chat offers
/// Continue.
fn notify_interrupted(
    push: &Arc<Push>,
    session: &str,
    cause: omp_pulse::authority::interrupted::Cause,
) {
    let push = Arc::clone(push);
    let title = push::session_title(session);
    // A partial reply the dead turn noted must not become a later turn's body.
    push::take_assistant_text(session);
    let body = omp_pulse::authority::interrupted::notice(cause).to_string();
    let session = session.to_string();
    tokio::spawn(async move {
        push.notify(&session, &title, &body, push::KIND_AGENT_END)
            .await;
    });
}

/// The child's `extension_ui_request` id is a 16-hex-char snowflake STRING on
/// the wire (rpc-types.ts `Snowflake`), but the push contract carries a
/// numeric `reqId` — parse it here so a tap can land on the exact dialog.
/// `None` when the id is not numeric (the payload field is optional).
fn extension_req_id(event: &serde_json::Value) -> Option<u64> {
    let id = event.get("id")?.as_str()?;
    if id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        u64::from_str_radix(id, 16).ok()
    } else {
        id.parse().ok()
    }
}

/// Tail kept from each text block of a `tool_execution_update`'s partial
/// result. The phone renders only the last 4 KiB of live output; the final
/// result arrives whole with `tool_execution_end` and in the session file.
const TOOL_UPDATE_TAIL_BYTES: usize = 16 * 1024;

/// Updates carry the tool's ENTIRE accumulated output and arrive at ~20 Hz, so
/// a long bash run re-sent megabytes per second to every phone socket (and
/// rebuilt the frame each time). Keep only the tail the client can show.
fn clip_tool_update(event: &mut serde_json::Value) {
    if event.get("type").and_then(|t| t.as_str()) != Some("tool_execution_update") {
        return;
    }
    let Some(blocks) = event
        .pointer_mut("/partialResult/content")
        .and_then(|c| c.as_array_mut())
    else {
        return;
    };
    for block in blocks {
        let Some(text) = block.get_mut("text") else {
            continue;
        };
        let Some(s) = text.as_str() else { continue };
        if s.len() <= TOOL_UPDATE_TAIL_BYTES {
            continue;
        }
        let mut cut = s.len() - TOOL_UPDATE_TAIL_BYTES;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        *text = serde_json::Value::String(s[cut..].to_string());
    }
}

/// Serialize a `ChildEvent` to its WS frame string ONCE and broadcast it.
fn handle_child_event(
    ev: ChildEvent,
    hub: &Arc<WsHub>,
    delta: &DeltaEncoder,
    push: &Arc<Push>,
    state: &Arc<omp_pulse::server::http::AppState>,
) {
    match ev {
        ChildEvent::Event {
            session,
            mut event,
            source,
        } => {
            let Some(source) = source else { return };
            if event.get("type").and_then(serde_json::Value::as_str)
                == Some("session_binding_retired")
            {
                // An idle child moved to another chat (retarget): like a
                // planned stop, this chat is simply no longer held.
                if state
                    .session_states
                    .release_source(&session, &source.identity)
                {
                    omp_pulse::authority::activity::publish_idle(&session);
                }
                omp_pulse::sessions::index::trigger_refresh(state);
                return;
            }
            if !state
                .session_states
                .observe_event(&session, &source, &event)
            {
                return;
            }
            if event.get("bridgeLost").and_then(serde_json::Value::as_bool) == Some(true) {
                state
                    .session_states
                    .retire_source(&session, &source.identity);
            }
            clip_tool_update(&mut event);
            let authority = state.session_states.current(&session);
            let frame = Arc::<str>::from(
                serde_json::json!({
                    "type": "event", "event": event, "sessionState": authority,
                    "now": authority.as_ref().map(|state| state.legacy_now()),
                    "at": omp_pulse::authority::activity::now_ms(),
                })
                .to_string(),
            );
            let mut out = delta.encode_event(hub, &session, frame, &event);
            if let Some((_, payload)) = out.delta.as_mut() {
                // Deltas carry the same authority fence as their full fallback.
                let metadata =
                    serde_json::to_string(&authority).expect("session authority serializes");
                let mut stamped = String::with_capacity(payload.len() + metadata.len() + 17);
                stamped.push_str(&payload[..payload.len() - 1]);
                stamped.push_str(",\"sessionState\":");
                stamped.push_str(&metadata);
                stamped.push('}');
                *payload = Arc::from(stamped);
            }
            hub.broadcast_frame(&session, out);
            omp_pulse::authority::activity::observe(&session, &event);
            // The turn journal follows the authority's turn: a turn the
            // daemon's own child starts is in flight until the record goes
            // idle, so a kill in between leaves it to be found at startup.
            if let Some(journal) = omp_pulse::authority::interrupted::journal() {
                if event.get("type").and_then(serde_json::Value::as_str) == Some("agent_start") {
                    journal.started(
                        &session,
                        omp_pulse::authority::activity::now_ms(),
                        source.identity.kind
                            == omp_pulse::authority::session_state::SourceKind::Child,
                    );
                } else if authority.as_ref().map(|a| a.turn)
                    == Some(omp_pulse::authority::session_state::Turn::Idle)
                {
                    journal.settled(&session);
                }
            }
            // Sessions list live: the `running`/`live` chips are derived from
            // ChildManager state, so a lifecycle frame must invalidate the
            // listing even if the file hasn't grown yet. The settle frames
            // start and end a row's background-work state.
            if let Some(t) = event.get("type").and_then(|t| t.as_str())
                && matches!(
                    t,
                    "agent_start"
                        | "agent_end"
                        | "message_start"
                        | "message_end"
                        | "prompt_result"
                        | "session_settled"
                )
            {
                omp_pulse::sessions::index::trigger_refresh(state);
            }
            match event.get("type").and_then(|t| t.as_str()) {
                Some("agent_end") => {
                    let is_terminal = event
                        .get("isTerminal")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true)
                        && event.get("bridgeLost").and_then(serde_json::Value::as_bool)
                            != Some(true);
                    // conversation as done. Intermediate tool-loop iterations
                    // have isTerminal:false — the "numerous requests" case
                    // the user asked not to be notified for.
                    tracing::info!(session=%session, clients=hub.client_count(&session), is_terminal, "agent_end seen");
                    // INVARIANT: a terminal turn always notifies, even while the
                    // app is foregrounded. Previous versions suppressed this
                    // when a client was attached to the session (`has_headroom`,
                    // then `client_count > 0`, then a `watching` flag) — which
                    // made the buzz unreliable exactly when it was wanted: a
                    // quick background after sending raced the flag flip, and
                    // the user asked for "notify whether or not im in the
                    // app". Nothing may be reintroduced here without that
                    // decision changing.
                    if is_terminal {
                        // The turn's dialogs are gone; the next turn's first
                        // question must buzz.
                        push::rearm_needs_input(&session);
                        if push::turn_was_aborted(
                            &session,
                            Some(&source.identity),
                            event.get("commandId").and_then(serde_json::Value::as_str),
                            event.get("stopReason").and_then(serde_json::Value::as_str),
                        ) {
                            push::take_assistant_text(&session);
                        } else if push::take_turn_failed(&session) {
                            // The failed-turn marker was consumed; prompt_failed
                            // owns the buzz.
                        } else {
                            let push = Arc::clone(push);
                            let title = push::session_title(&session);
                            // Say what it actually replied. Falls back only
                            // when the turn produced no readable text at all.
                            let body = push::take_assistant_text(&session)
                                .unwrap_or_else(|| "agent finished".to_string());
                            tokio::spawn(async move {
                                push.notify(&session, &title, &body, push::KIND_AGENT_END)
                                    .await;
                            });
                        }
                    }
                }
                Some("agent_start") => {
                    // A new run supersedes any un-consumed failure marker (a
                    // run that died between message_end and agent_end): this
                    // run's completion must buzz normally.
                    push::clear_turn_failed(&session);
                    push::clear_turn_aborted(&session);
                }
                Some("message_end") => {
                    // stopReason "error" is the wire signal for a failed or
                    // refused turn (the PWA renders it as the red stop chip).
                    // Record it as the turn's failure marker; the alert itself
                    // was disabled per user preference, so `prompt_failed`
                    // pushes nothing and only the marker survives, consumed by
                    // the `agent_end` that follows.
                    let message = event.get("message");
                    let stop = message
                        .and_then(|m| m.get("stopReason"))
                        .and_then(|s| s.as_str());
                    let failed = stop == Some("error");
                    if failed {
                        push::note_turn_failed(&session);
                        // Notify-only-on-agent-end: the prompt_failed alert is
                        // disabled per user preference, so a failed turn keeps
                        // only the marker the `agent_end` consumes.
                        push::take_assistant_text(&session);
                    } else if stop == Some("aborted") {
                        push::clear_turn_failed(&session);
                        push::note_turn_aborted(
                            &session,
                            Some(&source.identity),
                            event.get("commandId").and_then(serde_json::Value::as_str),
                        );
                        push::take_assistant_text(&session);
                    } else if stop.is_some() {
                        // An assistant message that ended cleanly (or was
                        // aborted) supersedes a failure marker; a USER
                        // message_end carries no stopReason and must not
                        // disturb the marker of the turn still settling.
                        push::clear_turn_failed(&session);
                        if let Some(text) = message.and_then(push::summarise_assistant) {
                            push::note_assistant_text(&session, text);
                        }
                    }
                }
                Some("extension_ui_request") => {
                    // A cancel resolves a dialog: omp's own (abort, timeout)
                    // or the daemon's when a client answered it.
                    if event.get("method").and_then(serde_json::Value::as_str) == Some("cancel") {
                        push::rearm_needs_input(&session);
                    } else {
                        maybe_push_needs_input(push, &session, &event);
                    }
                }
                _ => {}
            }
        }
        ChildEvent::BashResult {
            session,
            id,
            command,
            result,
            source,
        } => {
            let Some(source) = source else { return };
            if !state.session_states.observe_event(
                &session,
                &source,
                &serde_json::json!({"type":"bash_result"}),
            ) {
                return;
            }
            let frame = Arc::<str>::from(format!(
                r#"{{"type":"bash_result","id":{},"command":{},"result":{}}}"#,
                serde_json::Value::String(id),
                serde_json::Value::String(command),
                result
            ));
            let out = delta.encode_plain(hub, &session, frame, Collapse::None);
            hub.broadcast_frame(&session, out);
        }
        ChildEvent::BashOutput {
            session,
            id,
            text,
            source,
        } => {
            let Some(source) = source else { return };
            if !state.session_states.observe_event(
                &session,
                &source,
                &serde_json::json!({"type":"bash_output"}),
            ) {
                return;
            }
            let frame = Arc::<str>::from(format!(
                r#"{{"type":"bash_output","id":{},"text":{}}}"#,
                serde_json::Value::String(id),
                serde_json::Value::String(text),
            ));
            let out = delta.encode_plain(hub, &session, frame, Collapse::None);
            hub.broadcast_frame(&session, out);
        }
        ChildEvent::Notice {
            session,
            message,
            source,
        } => {
            let Some(source) = source else { return };
            if !state.session_states.observe_event(
                &session,
                &source,
                &serde_json::json!({"type":"notice"}),
            ) {
                return;
            }
            if message.starts_with("agent process ") {
                state
                    .session_states
                    .retire_source(&session, &source.identity);
            }
            // A child-death notice (child.rs `finish_child` formats it as
            // "agent process <why>") is the one daemon-side death signal that
            // reaches the router — a crashed agent strands a phone user just
            // as surely as a failed prompt. The "agent process " prefix is
            // owned solely by finish_child's format string (the other Notice
            // producer, child stderr, is arbitrary text); the empty-session
            // guard skips the never-registered catalogue-query children.
            let child_died = !session.is_empty() && message.starts_with("agent process ");
            if child_died {
                // A dead turn is over whatever the event stream last said.
                omp_pulse::authority::activity::end(&session);
                // Notify-only-on-agent-end: child_died pushes are disabled per
                // user preference. A turn the death cut off is the exception:
                // it is a turn ending, so it says so once, as one.
                if omp_pulse::authority::interrupted::journal().is_some_and(|journal| {
                    journal.agent_exited(&session, omp_pulse::authority::activity::now_ms())
                }) {
                    notify_interrupted(
                        push,
                        &session,
                        omp_pulse::authority::interrupted::Cause::Exited,
                    );
                    omp_pulse::sessions::index::trigger_refresh(state);
                }
            }
            let frame = Arc::<str>::from(format!(
                r#"{{"type":"error","message":{}}}"#,
                serde_json::Value::String(message)
            ));
            let out = delta.encode_plain(hub, &session, frame, Collapse::None);
            hub.broadcast_frame(&session, out);
        }
        ChildEvent::Stopped {
            session,
            why,
            source,
        } => {
            // A child the daemon stopped on purpose (reap, idle eviction, rss
            // recycle): the session is simply no longer held. No error frame
            // and no "reconnecting": the record goes unowned/idle/connected,
            // and the activity frame carries that state to the session list
            // and to any chat still open on it. One-shot query children have
            // no session and nothing to tell.
            let Some(source) = source else { return };
            if session.is_empty() {
                return;
            }
            tracing::debug!(%session, %why, "child stopped as planned");
            if state
                .session_states
                .release_source(&session, &source.identity)
            {
                omp_pulse::authority::activity::publish_idle(&session);
                omp_pulse::sessions::index::trigger_refresh(state);
            }
        }
    }
}

/// Serialize a `WatchEvent` to its WS frame string ONCE and broadcast it.
fn handle_watch_event(
    ev: WatchEvent,
    hub: &Arc<WsHub>,
    delta: &DeltaEncoder,
    state: &Arc<omp_pulse::server::http::AppState>,
) {
    match ev {
        WatchEvent::Entries { session, entries } => {
            // Entries are ALWAYS forwarded. Two narrower rules were tried and
            // both were wrong: suppressing them whenever a child exists, and
            // suppressing them while it streams. Either way the phone lost
            // content that ONLY the file carries — the user's own prompt entry
            // is the clearest case, and the browser suite caught it as a
            // "new content" pill that never appeared. The duplicate cost with
            // the live event stream is ~3.4 KB per turn and the client dedupes
            // by key, which is a fair price for the file remaining authoritative.
            //
            // Memory is bounded elsewhere, and better: the watcher only reads a
            // tail when some visible client still has queue headroom (see the
            // audience policy in `cmd_serve`), and per-client queues are byte-capped.
            // `Value::Array` moves the batch into the frame; `json!(entries)`
            // deep-cloned every entry (tool outputs included) just to print it.
            let frame = Arc::<str>::from(format!(
                r#"{{"type":"entries","entries":{}}}"#,
                serde_json::Value::Array(entries)
            ));
            let out = delta.encode_plain(hub, &session, frame, Collapse::None);
            hub.broadcast_frame(&session, out);
            // File grew — the sessions list's snippet/mtime is stale.
            omp_pulse::sessions::index::trigger_refresh(state);
        }
        WatchEvent::Partial {
            session,
            text,
            offset,
        } => {
            let frame = Arc::<str>::from(format!(
                r#"{{"type":"partial","text":{},"offset":{}}}"#,
                serde_json::Value::String(text),
                offset
            ));
            // Each drain re-sends the whole growing line, so a newer partial at
            // the same anchor supersedes a queued one. Uncollapsed, a long
            // streamed line filled a slow client's queue with stale copies of
            // itself and forced a resync (a full history refetch).
            let out = delta.encode_plain(hub, &session, frame, Collapse::Partial(offset));
            hub.broadcast_frame(&session, out);
        }
        WatchEvent::Poll { session } => {
            let out = delta.encode_plain(
                hub,
                &session,
                Arc::from(r#"{"type":"poll"}"#),
                Collapse::None,
            );
            hub.broadcast_frame(&session, out);
        }
    }
}

/// The ONE serializer: consumes child + watcher events, serializes each to a
/// frame string exactly once, and broadcasts it to the session's WS clients.
async fn router_task(
    mut child_rx: broadcast::Receiver<ChildEvent>,
    mut watch_rx: broadcast::Receiver<WatchEvent>,
    hub: Arc<WsHub>,
    delta: Arc<DeltaEncoder>,
    push: Arc<Push>,
    state: Arc<omp_pulse::server::http::AppState>,
) {
    loop {
        tokio::select! {
            ev = child_rx.recv() => match ev {
                Ok(child_event) => handle_child_event(child_event, &hub, &delta, &push, &state),
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    // INVARIANT: Lagged means `n` events are gone forever.
                    // Silently skipping wedges the phone showing a truncated
                    // transcript — exactly what a radio-sleep does. Force a
                    // resync (seq 0) so the client refetches history over HTTP
                    // (paged/compressed) and delta chains reset via seq 0.
                    warn!(lagged = n, "child event channel lagged; forcing resync");
                    omp_pulse::metrics::inc("router_lagged_child");
                    hub.resync_all("lagged");
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("child event channel closed; router task ending");
                    return;
                }
            },
            ev = watch_rx.recv() => match ev {
                Ok(watch_event) => handle_watch_event(watch_event, &hub, &delta, &state),
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(lagged = n, "watch event channel lagged; forcing resync");
                    omp_pulse::metrics::inc("router_lagged_watch");
                    hub.resync_all("lagged");
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("watch event channel closed; router task ending");
                    return;
                }
            },
        }
    }
}

/// Supervisor: keep the router task alive. If it returns or dies, recreate
/// both receivers (fresh subscription from the same senders) and respawn.
async fn supervise_router(
    children: Arc<ChildManager>,
    watch_tx: broadcast::Sender<WatchEvent>,
    hub: Arc<WsHub>,
    delta: Arc<DeltaEncoder>,
    push: Arc<Push>,
    state: Arc<omp_pulse::server::http::AppState>,
) {
    loop {
        let child_rx = children.subscribe();
        let watch_rx = watch_tx.subscribe();
        let task = tokio::spawn(router_task(
            child_rx,
            watch_rx,
            Arc::clone(&hub),
            Arc::clone(&delta),
            Arc::clone(&push),
            Arc::clone(&state),
        ));
        match task.await {
            Ok(()) => warn!("router task ended unexpectedly; respawning"),
            Err(e) if e.is_panic() => error!(error = %e, "router task panicked; respawning"),
            Err(e) => warn!(error = %e, "router task cancelled; respawning"),
        }
        // Avoid a hot respawn loop if the channel is wedged.
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Resolves on SIGINT or SIGTERM.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            warn!(error = %e, "failed to install ctrl_c handler");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => warn!(error = %e, "failed to install SIGTERM handler"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_defaults_to_two_workers_unless_overridden() {
        assert_eq!(worker_threads_from(None, 8), 2);
        assert_eq!(worker_threads_from(None, 1), 1);
        assert_eq!(worker_threads_from(Some("6"), 8), 6);
        assert_eq!(worker_threads_from(Some("0"), 8), 2);
        assert_eq!(worker_threads_from(Some("lots"), 8), 2);
    }
}
