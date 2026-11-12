//! Shared types for the omp-pulse daemon. Every module depends on this file;
//! it depends only on std, serde and `crate::paths`.

use std::path::PathBuf;
use std::sync::Arc;

use crate::paths::{self, Paths};

/// Command-line overrides, applied LAST in [`Config::from_layers`] (they win
/// over env vars and the config file). Fields mirror the `serve` flags.
#[derive(Debug, Clone, Default)]
pub struct CliOverrides {
    pub bind: Option<String>,
    pub port: Option<u16>,
    pub token: Option<String>,
    pub public_dir: Option<PathBuf>,
    pub omp_bin: Option<PathBuf>,
    /// Explicit config.toml path. A missing file here is an error (typo
    /// protection), unlike the default path where absence just means
    /// "built-in defaults".
    pub config: Option<PathBuf>,
}

/// Daemon configuration, loaded once at startup from layered sources:
/// built-in defaults, then `config.toml`, then `OMP_PULSE_*` environment
/// variables (legacy `OMP_REMOTE_*` names still honoured as a fallback), then
/// explicit command-line overrides.
#[derive(Debug, Clone)]
pub struct Config {
    /// Bind address. Default `127.0.0.1` — loopback only, the safe default.
    pub host: String,
    pub port: u16,
    pub sessions_root: PathBuf,
    pub omp_bin: PathBuf,
    /// Directory to serve the web app from instead of the embedded copy;
    /// `None` = embedded assets.
    pub public_dir: Option<PathBuf>,
    /// sha256 of the auth token; `None` means "no token configured" and every
    /// authenticated route rejects with 401 (matches old daemon semantics).
    pub token_hash: Option<[u8; 32]>,
    /// LRU cap on concurrently alive RPC children (~270MB each).
    pub max_children: usize,
    pub push_store_path: PathBuf,
    pub vapid_path: PathBuf,
    /// Directory holding daemon-owned state (push store, VAPID keys, collab
    /// link registry). `OMP_PULSE_STATE_DIR` / legacy `OMP_REMOTE_STATE_DIR`
    /// overrides it so an isolated instance cannot touch the real one.
    pub state_dir: PathBuf,
    pub home: PathBuf,
    /// Fallback poll interval; inotify is the primary trigger.
    pub watch_interval_ms: u64,
    /// Per-client WS queue depth. Queues CONFLATE (a newer supersedable frame
    /// replaces a pending one), so this is a hard memory ceiling per phone, not
    /// a throughput knob: a stalled client used to pin RSS without limit
    /// (measured 2.55x the appended bytes).
    pub ws_queue_cap: usize,
    /// Per-client queue BUDGET in bytes. The frame count alone is not a memory
    /// bound: a watcher `entries`/`partial` frame can be megabytes, so 64 of
    /// them is hundreds of MiB. Measured with a count-only cap: a non-reading
    /// client still grew RSS 182 MiB while 150 MiB was appended. Past the
    /// budget a client is sent a single resync order instead — it refetches
    /// history over HTTP, which is paged and compressed.
    pub ws_queue_bytes: usize,
    /// Reap a child that has been idle this long. Children cost ~281 MiB and
    /// used to live until LRU eviction or shutdown.
    pub child_idle_secs: u64,
    /// Reap a child sooner when nobody is looking: no running turn, no open
    /// dialog, no in-flight RPC, and no `/ws` viewer attached to its session
    /// for this long (0 disables; `child_idle_secs` still applies). A child is
    /// ~300-430 MiB on a phone whose low-memory killer takes the whole app
    /// down, so a conversation nobody has open must not pin one for the full
    /// idle TTL. The next prompt/open respawns it lazily (~1.3-2.7 s boot).
    pub child_unwatched_secs: u64,
    /// Recycle a non-streaming child once its resident + swapped memory
    /// (VmRSS + VmSwap) reaches this (MiB); 0 disables.
    /// `switch_session` accumulates (measured 291 -> 582 MiB over five switches),
    /// so a long-lived child needs a generational bound.
    pub child_rss_mb: u64,
    /// Start RPC children with JavaScriptCore's unlinked-code jettisoning on
    /// (`BUN_JSC_useUnlinkedCodeBlockJettisoning` plus the 10x shorter
    /// old-age clock), so bytecode of functions that ran once — omp evaluates
    /// ~60k functions at boot — is dropped at GC and regenerated from source
    /// if it ever runs again. Measured on the phone (omp 18.8.6, Bun 1.4.2,
    /// 3 runs each, 6 mock turns): child anon RSS 283 -> 260 MiB, peak
    /// 407 -> 393 MiB, ~50 ms extra CPU per turn, same boot time. The omp
    /// daemon broker inherits the child's env and gets the same setting.
    /// A value already set in the daemon's own environment wins.
    pub child_lean_js: bool,
    /// Spawn a child when a phone merely ATTACHES a socket. Off by default:
    /// browsing a conversation should not cost 281 MiB. Intent (composer focus)
    /// drives pre-warm instead, via `POST /api/prewarm`.
    pub prewarm_on_attach: bool,
    /// How long a session's terminal-ownership verdict stays valid. The verdict
    /// needs a full /proc sweep (~7.5 ms) and only changes when a process starts
    /// or exits.
    pub owner_cache_ms: u64,
    /// WS frames at or above this size are sent as raw-deflate BINARY frames to
    /// clients advertising the `defl` capability (browsers decode natively with
    /// `DecompressionStream('deflate-raw')`).
    pub ws_deflate_min: usize,
    /// Every filesystem location, resolved once at startup.
    pub paths: Arc<Paths>,
    /// Speech-to-text, all optional. The feature is available only when both a
    /// python interpreter and a model directory resolve to real paths, so a
    /// packaged install without them simply reports the feature as unavailable
    /// instead of failing at request time.
    ///
    /// Defaults live under the state dir (`<state>/asr/venv/bin/python` and
    /// `<state>/asr/<model>`), which is where `omp-pulse asr install` puts them.
    pub asr_python: Option<PathBuf>,
    pub asr_model_dir: Option<PathBuf>,
    /// ONNX intra-op threads. Measured on a 16-core Core Ultra 9: 6 threads
    /// decode 7.4s of speech in 0.45s. More threads stop helping well before
    /// the core count because the encoder is memory-bound.
    pub asr_threads: usize,
}

/// Optional view of `config.toml`. Every key is optional; unknown keys are
/// ignored so an older binary can still start on a newer file.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct FileConfig {
    host: Option<String>,
    port: Option<u16>,
    sessions_root: Option<PathBuf>,
    omp_bin: Option<PathBuf>,
    public_dir: Option<PathBuf>,
    max_children: Option<usize>,
    watch_interval_ms: Option<u64>,
    ws_queue_cap: Option<usize>,
    ws_queue_bytes: Option<usize>,
    child_idle_secs: Option<u64>,
    child_unwatched_secs: Option<u64>,
    child_rss_mb: Option<u64>,
    child_lean_js: Option<bool>,
    prewarm_on_attach: Option<bool>,
    owner_cache_ms: Option<u64>,
    ws_deflate_min: Option<usize>,
    asr_python: Option<PathBuf>,
    asr_model_dir: Option<PathBuf>,
    asr_threads: Option<usize>,
}

/// A single env var holding a path; empty means unset.
fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.exists()).cloned()
}

/// The newest-looking sherpa-onnx model directory under `<state>/asr`. Matching
/// by directory contents rather than by an exact name means updating the model
/// is a download-and-extract, with no config edit and no code change.
fn default_asr_model_dir(state_dir: &std::path::Path) -> Option<PathBuf> {
    std::fs::read_dir(state_dir.join("asr"))
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("encoder.int8.onnx").is_file() && p.join("tokens.txt").is_file())
        .max()
}

/// New-style `OMP_PULSE_*` name, falling back to the legacy `OMP_REMOTE_*`.
fn env2(new_key: &str, old_key: &str) -> Option<String> {
    env_nonempty(new_key).or_else(|| env_nonempty(old_key))
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

fn env_u16(new_key: &str, old_key: &str) -> Option<u16> {
    env2(new_key, old_key).and_then(|v| v.trim().parse().ok())
}

fn env_usize(new_key: &str, old_key: &str) -> Option<usize> {
    env2(new_key, old_key).and_then(|v| v.trim().parse().ok())
}

/// Default child cap. 6 covers the handful of conversations anyone switches
/// between on a laptop. On the phone itself 6 × ~380 MB is more than the
/// ~3 GB the device typically has available beside the WebView, and Android's
/// low-memory killer takes the whole app (daemon included) rather than one
/// child, so the phone gets 3. Busy children are never evicted either way;
/// a full pool holds sends (`agents_busy`) instead of failing them.
fn default_max_children(android: bool) -> usize {
    if android { 3 } else { 6 }
}

/// True when the kernel is Android's: the APK's own daemon and a daemon in a
/// proot/Termux userland on the phone both see the host kernel, whose release
/// string carries `android` (GKI: `6.6.98-android15-8-…`); `ANDROID_ROOT` covers
/// older non-GKI kernels when the launcher passes the Android environment.
fn host_is_android() -> bool {
    std::env::var_os("ANDROID_ROOT").is_some()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|release| release.to_ascii_lowercase().contains("android"))
}

fn env_u64(new_key: &str, old_key: &str) -> Option<u64> {
    env2(new_key, old_key).and_then(|v| v.trim().parse().ok())
}

fn env_bool(new_key: &str, old_key: &str) -> Option<bool> {
    env2(new_key, old_key).map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

impl Config {
    /// Resolve configuration by layering sources in this order (later wins):
    /// 1. built-in defaults, 2. `config.toml`, 3. `OMP_PULSE_*` env vars
    ///    (`OMP_REMOTE_*` fallback), 4. the given CLI overrides.
    pub fn from_layers(cli: &CliOverrides) -> Result<Config, String> {
        let paths = Paths::resolve()?;
        paths.ensure_dirs()?;

        // Where to read config.toml from: --config wins, then the env var,
        // then the default location. An explicitly named file that does not
        // exist is an error; the default file may simply be absent (first run).
        let explicit_config = cli.config.is_some() || env_nonempty("OMP_PULSE_CONFIG").is_some();
        let config_path = cli
            .config
            .clone()
            .or_else(|| env_nonempty("OMP_PULSE_CONFIG").map(PathBuf::from))
            .unwrap_or_else(|| paths.config_file.clone());
        let file = read_config(&config_path, explicit_config)?;

        let host = cli
            .bind
            .clone()
            // `OMP_PULSE_BIND` is accepted as an alias because the CLI flag is
            // `--bind` and the config key is `host`: a user who has only seen
            // the flag reaches for BIND first, and silently ignoring it would
            // leave them exposed on a default they thought they had changed.
            .or_else(|| env2("OMP_PULSE_HOST", "OMP_REMOTE_HOST"))
            .or_else(|| {
                std::env::var("OMP_PULSE_BIND")
                    .ok()
                    .filter(|v| !v.trim().is_empty())
            })
            .or(file.host)
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let port = cli
            .port
            .or_else(|| env_u16("OMP_PULSE_PORT", "OMP_REMOTE_PORT"))
            .or(file.port)
            .unwrap_or(7681);
        // `OMP_PULSE_SESSIONS_ROOT` / `OMP_REMOTE_SESSIONS_ROOT` isolates which
        // sessions this daemon can see. Redirecting XDG_DATA_HOME would look
        // equivalent but breaks the omp children: their native addon
        // (`pi_natives`) resolves under that path and fails to load, so a
        // child exits immediately.
        let sessions_root = env2("OMP_PULSE_SESSIONS_ROOT", "OMP_REMOTE_SESSIONS_ROOT")
            .map(PathBuf::from)
            .or(file.sessions_root)
            .unwrap_or_else(|| paths.sessions_root.clone());
        let omp_bin = cli
            .omp_bin
            .clone()
            .or_else(|| env_nonempty("OMP_BIN").map(PathBuf::from))
            .or(file.omp_bin)
            .or_else(paths::find_omp_binary)
            .unwrap_or_else(|| PathBuf::from("omp"));
        let public_dir = cli
            .public_dir
            .clone()
            .or_else(|| env_nonempty("OMP_PULSE_PUBLIC_DIR").map(PathBuf::from))
            .or(file.public_dir);
        // The token is deliberately NOT in config.toml: it is a secret and
        // lives in the state dir (0600), overridable per launch via env or
        // --token for scripts and tests.
        let token = cli
            .token
            .clone()
            .or_else(|| env2("OMP_PULSE_TOKEN", "OMP_REMOTE_TOKEN"))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                std::fs::read_to_string(&paths.token_file)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            });
        let token_hash = token.map(|t| {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(t.as_bytes());
            let out = h.finalize();
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&out);
            arr
        });
        Ok(Config {
            host,
            port,
            sessions_root,
            omp_bin,
            public_dir,
            token_hash,
            // Warm children are what make a phone prompt feel instant: a live
            // child answers an RPC in ~4ms, a cold spawn costs ~1.3s (measured
            // — essentially all of it the omp child's own boot; history size
            // is nearly free). Each child holds ~270-380MB, so cap by memory,
            // not by fear: see `default_max_children`.
            max_children: env_usize("OMP_PULSE_MAX_CHILDREN", "OMP_REMOTE_MAX_CHILDREN")
                .or(file.max_children)
                .filter(|n| *n >= 1)
                .unwrap_or_else(|| default_max_children(host_is_android())),
            push_store_path: paths.push_file.clone(),
            vapid_path: paths.vapid_file.clone(),
            state_dir: paths.state_dir.clone(),
            home: paths.home.clone(),
            watch_interval_ms: env_u64(
                "OMP_PULSE_WATCH_INTERVAL_MS",
                "OMP_REMOTE_WATCH_INTERVAL_MS",
            )
            .or(file.watch_interval_ms)
            .unwrap_or(250),
            ws_queue_cap: env_usize("OMP_PULSE_WS_QUEUE_CAP", "OMP_REMOTE_WS_QUEUE_CAP")
                .or(file.ws_queue_cap)
                .unwrap_or(64),
            ws_queue_bytes: env_usize("OMP_PULSE_WS_QUEUE_BYTES", "OMP_REMOTE_WS_QUEUE_BYTES")
                .or(file.ws_queue_bytes)
                .unwrap_or(1 << 20),
            child_idle_secs: env_u64("OMP_PULSE_CHILD_IDLE_SECS", "OMP_REMOTE_CHILD_IDLE_SECS")
                .or(file.child_idle_secs)
                .unwrap_or(900),
            // 60 s, not the former 300 s: a child is ~380 MB on the phone, and
            // reading history never needs one (only a send does, and composer
            // focus prewarms it). With the 10 s maintenance tick it is released
            // 60-70 s after the last visible viewer leaves.
            child_unwatched_secs: env_nonempty("OMP_PULSE_CHILD_UNWATCHED_SECS")
                .and_then(|v| v.trim().parse().ok())
                .or(file.child_unwatched_secs)
                .unwrap_or(60),
            child_rss_mb: env_u64("OMP_PULSE_CHILD_RSS_MB", "OMP_REMOTE_CHILD_RSS_MB")
                .or(file.child_rss_mb)
                .unwrap_or(700),
            child_lean_js: env_nonempty("OMP_PULSE_CHILD_LEAN_JS")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .or(file.child_lean_js)
                .unwrap_or(true),
            prewarm_on_attach: env_bool(
                "OMP_PULSE_PREWARM_ON_ATTACH",
                "OMP_REMOTE_PREWARM_ON_ATTACH",
            )
            .or(file.prewarm_on_attach)
            .unwrap_or(false),
            owner_cache_ms: env_u64("OMP_PULSE_OWNER_CACHE_MS", "OMP_REMOTE_OWNER_CACHE_MS")
                .or(file.owner_cache_ms)
                .unwrap_or(3000),
            ws_deflate_min: env_usize("OMP_PULSE_WS_DEFLATE_MIN", "OMP_REMOTE_WS_DEFLATE_MIN")
                .or(file.ws_deflate_min)
                .unwrap_or(4096),
            asr_python: env_path("OMP_PULSE_ASR_PYTHON")
                .or_else(|| file.asr_python.clone())
                .or_else(|| first_existing(&[paths.state_dir.join("asr/venv/bin/python")])),
            asr_model_dir: env_path("OMP_PULSE_ASR_MODEL_DIR")
                .or_else(|| file.asr_model_dir.clone())
                .or_else(|| default_asr_model_dir(&paths.state_dir)),
            asr_threads: env_usize("OMP_PULSE_ASR_THREADS", "OMP_REMOTE_ASR_THREADS")
                .or(file.asr_threads)
                .filter(|n| *n >= 1)
                .unwrap_or(6),
            paths: Arc::new(paths),
        })
    }

    /// Thin wrapper for `term` and tests: layered resolution with no CLI
    /// overrides (env + config file + defaults).
    pub fn from_env() -> Result<Config, String> {
        Self::from_layers(&CliOverrides::default())
    }
}

/// Read and parse `config.toml`. Missing default file = defaults; a missing
/// EXPLICIT file (from `--config` or `OMP_PULSE_CONFIG`) is an error — the
/// user pointed at it on purpose. An unparseable file is always an error: a
/// broken config must fail loudly, not silently boot with defaults.
fn read_config(path: &std::path::Path, explicit: bool) -> Result<FileConfig, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => toml::from_str(&raw)
            .map_err(|e| format!("config file {} unparseable: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !explicit => {
            Ok(FileConfig::default())
        }
        Err(e) => Err(format!("cannot read config file {}: {e}", path.display())),
    }
}

/// The `config.toml` template written by `omp-pulse setup`: every key is
/// shown commented out with its default, so the file doubles as reference
/// docs and never fights the running defaults.
/// The config template with `host`/`port` written as ACTIVE keys when the user
/// supplied them.
///
/// WHY: `setup --bind 192.168.1.5` prints a pairing URL for that address. If the
/// config file it writes leaves `host` commented out, the next `serve` (or the
/// installed service, which has no flags) binds loopback instead and the URL the
/// user just scanned cannot work. Setup must persist what it advertises.
pub fn config_toml_with(host: Option<&str>, port: Option<u16>) -> String {
    let mut out = String::new();
    for line in default_config_toml().lines() {
        let trimmed = line.trim_start();
        if let Some(h) = host
            && (trimmed.starts_with("# host =") || trimmed.starts_with("host ="))
        {
            out.push_str(&format!("host = \"{h}\"\n"));
            continue;
        }
        if let Some(p) = port
            && (trimmed.starts_with("# port =") || trimmed.starts_with("port ="))
        {
            out.push_str(&format!("port = {p}\n"));
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

pub fn default_config_toml() -> &'static str {
    r#"# omp-pulse configuration. Every line is a comment: the value shown is
# the built-in default, so uncomment the keys you want to change.
#
# Precedence (highest first): command-line flag, then OMP_PULSE_* environment
# variable, then this file, then the built-in default. Legacy OMP_REMOTE_*
# names still work as a fallback for existing setups.
#
# The auth token is NOT stored here: it lives in the state dir (token file)
# and can be overridden per launch with OMP_PULSE_TOKEN.

# Bind address. The safe default is loopback-only: your phone cannot reach
# it. Set this to your machine's LAN or Tailscale IP to pair a phone, and
# see docs/user/networking.md before exposing the daemon.
# host = "127.0.0.1"

# HTTP port for the PWA and API.
# port = 7681

# Where omp keeps its sessions. Auto-detected with omp's own rule
# ($XDG_DATA_HOME else ~/.local/share, then omp/sessions) on every platform;
# only set this to point at a different omp install.
# sessions_root = ""

# The omp executable. Auto-detected: $OMP_BIN, then PATH, then
# ~/.bun/bin/omp, then ~/.local/bin/omp.
# omp_bin = ""

# Serve the web app from this directory instead of the embedded copy
# (development only; the binary ships with the app compiled in).
# public_dir = ""

# Maximum concurrently alive RPC children (~270-380MB each). Default 6, or 3
# when the daemon runs on Android (the phone itself).
# max_children = 6

# Fallback poll interval in ms; inotify is the primary trigger.
# watch_interval_ms = 250

# Per-client WS queue depth (queues conflate, so this caps memory per phone).
# ws_queue_cap = 64

# Per-client WS queue byte budget; past it a client gets a resync order.
# ws_queue_bytes = 1048576

# Reap a child that has been idle this many seconds.
# child_idle_secs = 900

# Reap sooner when no running turn, no open dialog and no visible viewer for
# this many seconds (0 disables). A backgrounded app is not a viewer.
# child_unwatched_secs = 60

# Recycle a non-streaming child past this resident + swapped size in MiB
# (0 disables).
# child_rss_mb = 700

# Start omp children with JavaScriptCore unlinked-code jettisoning (~23 MiB
# less per child, ~50 ms more CPU per turn). Env: OMP_PULSE_CHILD_LEAN_JS.
# child_lean_js = true

# Spawn a child when a phone merely attaches a socket (off by default).
# prewarm_on_attach = false

# How long a session terminal-ownership verdict stays valid, in ms.
# owner_cache_ms = 3000

# WS frames at or above this size are sent as raw-deflate BINARY frames.
# ws_deflate_min = 4096
"#
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::testenv;
    use sha2::{Digest, Sha256};

    fn clean_env(home: &std::path::Path) -> Vec<(String, Option<String>)> {
        // Every var from_layers can read, pointed at a fresh scratch HOME so
        // a test never touches the real machine's state or omp store.
        //
        // The explicit list below is documentation; the SWEEP after it is what
        // makes this correct. A hand-maintained list silently rots: `OMP_PULSE_BIND`
        // was added to the config later and never added here, so a test asserting
        // the default bind read the developer's ambient environment and would have
        // passed or failed depending on their shell. Any `OMP_PULSE_*`/`OMP_REMOTE_*`
        // variable that exists in the process environment is now cleared whether or
        // not anyone remembered to list it.
        let h = Some(home.to_str().unwrap().to_string());
        let mut kvs: Vec<(String, Option<String>)> = vec![
            ("HOME", h),
            ("USERPROFILE", None),
            ("XDG_DATA_HOME", None),
            ("XDG_STATE_HOME", None),
            ("OMP_PULSE_STATE_DIR", None),
            ("OMP_REMOTE_STATE_DIR", None),
            ("OMP_PULSE_CONFIG", None),
            ("OMP_PULSE_HOST", None),
            ("OMP_REMOTE_HOST", None),
            ("OMP_PULSE_PORT", None),
            ("OMP_REMOTE_PORT", None),
            ("OMP_PULSE_TOKEN", None),
            ("OMP_REMOTE_TOKEN", None),
            ("OMP_BIN", None),
            ("OMP_PULSE_SESSIONS_ROOT", None),
            ("OMP_REMOTE_SESSIONS_ROOT", None),
            ("OMP_PULSE_PUBLIC_DIR", None),
            ("OMP_PULSE_MAX_CHILDREN", None),
            ("OMP_REMOTE_MAX_CHILDREN", None),
            ("OMP_PULSE_WATCH_INTERVAL_MS", None),
            ("OMP_REMOTE_WATCH_INTERVAL_MS", None),
            ("OMP_PULSE_WS_QUEUE_CAP", None),
            ("OMP_REMOTE_WS_QUEUE_CAP", None),
            ("OMP_PULSE_WS_QUEUE_BYTES", None),
            ("OMP_REMOTE_WS_QUEUE_BYTES", None),
            ("OMP_PULSE_CHILD_IDLE_SECS", None),
            ("OMP_REMOTE_CHILD_IDLE_SECS", None),
            ("OMP_PULSE_CHILD_UNWATCHED_SECS", None),
            ("OMP_PULSE_CHILD_RSS_MB", None),
            ("OMP_REMOTE_CHILD_RSS_MB", None),
            ("OMP_PULSE_CHILD_LEAN_JS", None),
            ("OMP_PULSE_PREWARM_ON_ATTACH", None),
            ("OMP_REMOTE_PREWARM_ON_ATTACH", None),
            ("OMP_PULSE_OWNER_CACHE_MS", None),
            ("OMP_REMOTE_OWNER_CACHE_MS", None),
            ("OMP_PULSE_WS_DEFLATE_MIN", None),
            ("OMP_PULSE_ASR_PYTHON", None),
            ("OMP_PULSE_ASR_MODEL_DIR", None),
            ("OMP_PULSE_ASR_THREADS", None),
            ("OMP_REMOTE_ASR_THREADS", None),
            ("OMP_PULSE_FFMPEG", None),
            ("OMP_REMOTE_WS_DEFLATE_MIN", None),
            ("PATH", None),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        // The sweep: clear anything this project could read that the list forgot.
        for (key, _) in std::env::vars() {
            if (key.starts_with("OMP_PULSE_") || key.starts_with("OMP_REMOTE_"))
                && !kvs.iter().any(|(k, _)| *k == key)
            {
                kvs.push((key, None));
            }
        }
        kvs
    }

    /// The full env a test needs: the clean baseline plus deltas. Applied in
    /// ONE `set_env` call, because the env lock is not reentrant and env is
    /// process-global — every test must state everything it reads.
    fn full_env(
        home: &std::path::Path,
        extra: &[(&'static str, Option<&str>)],
    ) -> Vec<(String, Option<String>)> {
        // Owned values: a borrowed view over a temporary Vec was dropped while
        // still in use, which is exactly the kind of test-only breakage that
        // never shows up until someone compiles the tests.
        let mut kvs: Vec<(String, Option<String>)> = clean_env(home);
        for (k, v) in extra {
            let owned = v.map(|s| s.to_string());
            if let Some(slot) = kvs.iter_mut().find(|(key, _)| key == k) {
                *slot = ((*k).to_string(), owned);
            } else {
                kvs.push(((*k).to_string(), owned));
            }
        }
        kvs
    }

    fn write_config(dir: &std::path::Path, body: &str) -> PathBuf {
        let path = dir.join("config.toml");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn defaults_are_loopback_and_embedded() {
        let tmp = testenv::scratch("defaults");
        let home = tmp.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let _g = testenv::set_env_owned(&full_env(&home, &[]));
        let cfg = Config::from_layers(&CliOverrides::default()).unwrap();
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 7681);
        assert!(cfg.public_dir.is_none());
        assert_eq!(cfg.omp_bin, PathBuf::from("omp"));
        assert!(cfg.token_hash.is_none());
        assert_eq!(cfg.max_children, default_max_children(host_is_android()));
        assert_eq!(cfg.child_idle_secs, 900);
        assert_eq!(cfg.child_unwatched_secs, 60);
        assert!(cfg.child_lean_js);
        assert_eq!(cfg.sessions_root, home.join(".local/share/omp/sessions"));
        // Our state follows platform convention (paths::platform_state_dir).
        #[cfg(target_os = "linux")]
        let state_dir = home.join(".local/state/omp-pulse");
        #[cfg(not(target_os = "linux"))]
        let state_dir = directories::BaseDirs::new()
            .unwrap()
            .config_dir()
            .join("omp-pulse");
        assert_eq!(cfg.state_dir, state_dir);
        assert_eq!(cfg.push_store_path, cfg.state_dir.join("push.json"));
        assert_eq!(cfg.vapid_path, cfg.state_dir.join("vapid.json"));
    }

    #[test]
    fn the_phone_defaults_to_half_the_children() {
        assert_eq!(default_max_children(false), 6);
        assert_eq!(default_max_children(true), 3);
    }

    #[test]
    fn clean_env_sweeps_project_vars_the_list_forgot() {
        // The hole this closes was real and found by a fresh reader: `OMP_PULSE_BIND`
        // is read by from_layers but was never added to clean_env's hand-written
        // list, so any test asserting a default read the developer's own shell. The
        // sweep must clear a project variable nobody listed.
        let tmp = testenv::scratch("env-sweep");
        let home = tmp.join("home");
        std::fs::create_dir_all(&home).unwrap();
        // A name that is deliberately NOT in the explicit list.
        let unlisted = "OMP_PULSE_BIND";
        // EVERY mutation stays INSIDE the lock, and the variable is planted THROUGH
        // the guard. Planting it beforehand published OMP_PULSE_BIND=10.9.9.9 to the
        // whole process, so a sibling test that legitimately held the lock resolved
        // that host instead of the default - measured as a 1-in-5 flake in
        // `defaults_are_loopback_and_embedded`.
        let mut guard =
            testenv::set_env_owned(&[(unlisted.to_string(), Some("10.9.9.9".to_string()))]);
        // clean_env reads the LIVE environment, so the variable has to be set for the
        // sweep to have anything to find.
        let kvs = clean_env(&home);
        assert!(
            kvs.iter().any(|(k, v)| k == unlisted && v.is_none()),
            "clean_env must clear {unlisted} even though it is not in the list"
        );
        // Applying that swept environment is what removes it; the resolved config must
        // then read the default rather than 10.9.9.9. Applied through the held guard
        // (set_env would deadlock on the lock), so it is restored with the rest.
        for (key, value) in full_env(&home, &[]) {
            guard.set(&key, value.as_deref());
        }
        let cfg = Config::from_layers(&CliOverrides::default()).unwrap();
        assert_eq!(cfg.host, "127.0.0.1");
        drop(guard);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn precedence_is_cli_then_env_then_file_then_default() {
        let tmp = testenv::scratch("layers");
        let home = tmp.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let config = write_config(
            &tmp,
            "host = \"10.0.0.9\"\nport = 7777\nmax_children = 3\nchild_unwatched_secs = 120\nchild_lean_js = false\n",
        );
        // Env beats file (OMP_PULSE_PORT), legacy env name beats file too
        // (OMP_REMOTE_HOST with no OMP_PULSE_HOST present), CLI beats both.
        let _g = testenv::set_env_owned(&full_env(
            &home,
            &[
                ("OMP_PULSE_PORT", Some("8888")),
                ("OMP_PULSE_CHILD_UNWATCHED_SECS", Some("45")),
                ("OMP_REMOTE_HOST", Some("10.1.1.1")),
            ],
        ));
        let cli = CliOverrides {
            bind: Some("10.2.2.2".to_string()),
            config: Some(config),
            ..Default::default()
        };
        let cfg = Config::from_layers(&cli).unwrap();
        // CLI beats env.
        assert_eq!(cfg.host, "10.2.2.2");
        // Env beats file.
        assert_eq!(cfg.port, 8888);
        // File applies where no env var is set.
        assert_eq!(cfg.max_children, 3);
        assert!(!cfg.child_lean_js);
        // Env beats file for the reap knob too.
        assert_eq!(cfg.child_unwatched_secs, 45);
    }

    #[test]
    fn legacy_env_names_still_honoured() {
        let tmp = testenv::scratch("legacy");
        let home = tmp.join("home");
        std::fs::create_dir_all(&home).unwrap();
        // Only the legacy name is set -> it wins.
        let _g = testenv::set_env_owned(&full_env(&home, &[("OMP_REMOTE_PORT", Some("9999"))]));
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.port, 9999);
        drop(_g);
        // New name beats legacy when both are set.
        let _g = testenv::set_env_owned(&full_env(
            &home,
            &[
                ("OMP_REMOTE_PORT", Some("9999")),
                ("OMP_PULSE_PORT", Some("10000")),
            ],
        ));
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.port, 10000);
    }

    #[test]
    fn token_hash_comes_from_env_preferring_new_name() {
        let tmp = testenv::scratch("token");
        let home = tmp.join("home");
        std::fs::create_dir_all(&home).unwrap();
        // Legacy env token is honoured when the new name is absent.
        let _g = testenv::set_env_owned(&full_env(&home, &[("OMP_REMOTE_TOKEN", Some("sekrit"))]));
        let expected = {
            let mut h = Sha256::new();
            h.update(b"sekrit");
            let out = h.finalize();
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&out);
            arr
        };
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.token_hash, Some(expected));
        drop(_g);
        // The new name wins when both are set.
        let _g = testenv::set_env_owned(&full_env(
            &home,
            &[
                ("OMP_REMOTE_TOKEN", Some("sekrit")),
                ("OMP_PULSE_TOKEN", Some("fresh")),
            ],
        ));
        let expected2 = {
            let mut h = Sha256::new();
            h.update(b"fresh");
            let out = h.finalize();
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&out);
            arr
        };
        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.token_hash, Some(expected2));
    }

    #[test]
    fn explicit_config_path_missing_is_an_error() {
        let tmp = testenv::scratch("explicit");
        let home = tmp.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let kvs = clean_env(&home);
        let _g = testenv::set_env_owned(&kvs);
        let cli = CliOverrides {
            config: Some(tmp.join("nope.toml")),
            ..Default::default()
        };
        assert!(Config::from_layers(&cli).is_err());
    }

    #[test]
    fn unparseable_config_is_an_error() {
        let tmp = testenv::scratch("broken");
        let home = tmp.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let kvs = clean_env(&home);
        let _g = testenv::set_env_owned(&kvs);
        let config = write_config(&tmp, "port = not-a-number\n");
        let cli = CliOverrides {
            config: Some(config),
            ..Default::default()
        };
        assert!(Config::from_layers(&cli).is_err());
    }
}

/// One row of the /api/sessions listing (wire shape is identical).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionInfo {
    pub path: String,
    pub id: String,
    pub title: String,
    pub cwd: String,
    /// File modification time. NOT when the conversation was last active:
    /// omp appends bookkeeping on exit (`session_exit` on SIGTERM), so
    /// closing a pane that had a weeks-old conversation loaded bumps this.
    pub mtime: f64,
    /// When the conversation last had a real message (user, assistant,
    /// command). What the list sorts, groups and labels by; falls back to
    /// `mtime` only when no message is found in the tail.
    #[serde(rename = "activeAt")]
    pub active_at: f64,
    pub size: u64,
    /// True only when the daemon's own RPC child is streaming this session.
    pub running: bool,
    /// PID of a foreign omp process (e.g. a desktop TUI) holding this
    /// session file open; `None` when no foreign owner exists.
    #[serde(rename = "ownerPid")]
    pub owner_pid: Option<i32>,
    /// True when the session has a live path the phone can stream from:
    /// our own child is streaming it OR the session is collab-attached.
    pub live: bool,
    /// True when the daemon holds a writable collab attachment for this
    /// session, so phone writes route through the host. Derived per scan
    /// from live link state, never persisted; share affordances derive
    /// their visibility from this instead of remembering past taps.
    pub shared: bool,
}

/// Events emitted by a child RPC process or the desktop bridge, fanned out to the router.
#[derive(Debug, Clone)]
pub enum ChildEvent {
    Event {
        session: String,
        event: serde_json::Value,
        source: Option<crate::authority::session_state::SourceStamp>,
    },
    BashResult {
        session: String,
        id: String,
        command: String,
        result: serde_json::Value,
        source: Option<crate::authority::session_state::SourceStamp>,
    },
    /// New output from a running user bash command (the Terminal sheet's
    /// live view), keyed by the stream id `/api/bash` was given. The final
    /// `BashResult` carries the whole (capped) output regardless.
    BashOutput {
        session: String,
        id: String,
        text: String,
        source: Option<crate::authority::session_state::SourceStamp>,
    },
    Notice {
        session: String,
        message: String,
        source: Option<crate::authority::session_state::SourceStamp>,
    },
    /// A child the daemon stopped on purpose while it was idle (idle or
    /// unwatched reap, idle eviction, rss recycle, shutdown). A clean end, not
    /// a failure: the session is left unowned and idle, with no error shown.
    Stopped {
        session: String,
        why: String,
        source: Option<crate::authority::session_state::SourceStamp>,
    },
}

/// Events emitted by the file watcher (inotify), fanned out to the router.
#[derive(Debug, Clone)]
pub enum WatchEvent {
    Entries {
        session: String,
        entries: Vec<serde_json::Value>,
    },
    Partial {
        session: String,
        text: String,
        offset: u64,
    },
    Poll {
        session: String,
    },
}

/// Result of a completed /api/bash command (wire shape).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BashResult {
    pub exit_code: Option<i32>,
    pub output: String,
    pub working_dir: String,
    pub cancelled: bool,
    pub truncated: bool,
}

/// Convenience alias so modules don't each import Arc+Config.
pub type SharedConfig = Arc<Config>;
