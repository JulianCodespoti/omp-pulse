//! `omp_pulse term` — the desktop TUI under a daemon-owned pty.
//!
//! Replaces a plain `omp` launch: the user's terminal connects through this
//! host, the daemon auto-runs `/collab`, scrapes the printed collab link from
//! the pty stream, and registers it with the daemon — making live phone
//! streaming fully automatic (no /collab typing, no scan, no paste).
//!
//! Everything runs on the one machine:
//! - parent stdin → pty master (raw input, every keystroke passes through),
//! - pty master → parent stdout (plus a rolling tail for the link scrape),
//! - SIGWINCH → read the parent size → resize the pty,
//! - auto `/collab` injection ~2.5s after spawn, retried with alternating
//!   candidate forms (`/collab`, `/collab start`) until the link is scraped,
//! - the first scraped link is POSTed to `/api/collab/register` once.
//!
//! On TUI exit the terminal is restored and the child's exit status is
//! propagated. Bin-only: declared in main.rs, never in lib.rs.
//!
//! Platform split: the pty machinery (portable-pty) is cross-platform, but
//! raw parent stdin, parent-window size and resize-on-SIGWINCH need termios
//! and TIOCGWINSZ, which Windows lacks. So the command is Linux/macOS only:
//! on Windows `run` returns a clear "not supported" error and every
//! unix-only piece is gated out so the crate still compiles.

use std::collections::VecDeque;

use omp_pulse::terminal::linkscrape::{scrape_link, tail_contains_linkish};
#[cfg(unix)]
use std::io::IsTerminal;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
#[cfg(unix)]
use futures_util::future::Either;
use futures_util::pin_mut;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use omp_pulse::types::Config;

/// Rolling output tail kept for link scraping. The TUI prints box art and QR
/// block characters around the link, so the tail is generous (bytes).
const TAIL_CAP: usize = 8 * 1024;

/// Delay after spawn before auto-typing `/collab` — the TUI needs a moment to
/// boot and reach its input prompt.
const COLLAB_SETTLE: Duration = Duration::from_millis(2500);

/// How long to keep forwarding pty output after the TUI exits before giving
/// up and restoring the terminal (a grandchild may briefly hold the slave).
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Timeout for the one-shot register POST so a wedged daemon can never hang
/// the terminal on exit.
const REGISTER_TIMEOUT: Duration = Duration::from_secs(5);

/// Candidate auto-/collab submissions, tried in order across retry attempts.
/// `"/collab\r"` is first: in omp ≥17.2.15 `/collab` is a group command whose
/// first positional is the relay URL, so the bare form is the correct one.
/// `"/collab start\r"` is the fallback for grammars where a bare command is
/// swallowed by a completion popup (it was a subcommand before the
/// group-command change). CR is Enter in a raw terminal.
const COLLAB_CANDIDATES: [&[u8]; 2] = [b"/collab\r", b"/collab start\r"];

/// Candidate index for a 0-based retry attempt. The first TWO attempts repeat
/// candidate 0: the first retry usually races a slow TUI startup (MCP connect
/// can take longer than the settle), so re-submitting the same — correct —
/// candidate after a longer settle is more likely to land than switching
/// grammar. Only attempt 3 moves to candidate 1, then the two alternate.
fn collab_candidate(attempt: usize) -> usize {
    if attempt < 2 {
        0
    } else if attempt.is_multiple_of(2) {
        1
    } else {
        0
    }
}

/// Parent terminal size via TIOCGWINSZ; `None` when the fd is not a tty or
/// the ioctl fails. Unix-only: the ioctl is a POSIX facility.
#[cfg(unix)]
fn terminal_size(fd: i32) -> Option<PtySize> {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) } != 0 {
        return None;
    }
    if ws.ws_row == 0 || ws.ws_col == 0 {
        return None;
    }
    Some(PtySize {
        rows: ws.ws_row,
        cols: ws.ws_col,
        pixel_width: ws.ws_xpixel,
        pixel_height: ws.ws_ypixel,
    })
}

/// Windows has no TIOCGWINSZ, and portable-pty's `get_size` reports the pty's
/// own size, not the parent console's — there is nothing honest to read, so
/// the caller falls back to the fixed wide default (see `run`).
#[cfg(not(unix))]
fn terminal_size(_fd: i32) -> Option<PtySize> {
    None
}

/// Best available parent terminal size: stdin first, then stdout. On
/// non-unix platforms `terminal_size` is a stub returning None (no
/// TIOCGWINSZ), so the fixed default in `run` applies there.
#[cfg(unix)]
fn parent_size() -> Option<PtySize> {
    terminal_size(libc::STDIN_FILENO).or_else(|| terminal_size(libc::STDOUT_FILENO))
}

#[cfg(not(unix))]
fn parent_size() -> Option<PtySize> {
    // The fd is irrelevant: the stub always returns None.
    terminal_size(0)
}

/// Best-effort omp version string for the give-up diagnostic: runs the
/// configured binary with `--version` under a short timeout. Any failure
/// yields `unknown` — a wedged binary must never delay or crash the report.
fn omp_version(bin: &std::path::Path) -> String {
    let mut child = match std::process::Command::new(bin)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return "unknown".to_string(),
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let _ = child.wait();
                    return "unknown".to_string();
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return "unknown".to_string();
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return "unknown".to_string(),
        }
    }
    let mut out = String::new();
    match child
        .stdout
        .take()
        .and_then(|mut s| s.read_to_string(&mut out).ok())
    {
        Some(_) => {
            let v = out.trim();
            if v.is_empty() {
                "unknown".to_string()
            } else {
                v.to_string()
            }
        }
        None => "unknown".to_string(),
    }
}

/// Raw mode on the parent stdin for the duration of the TUI, restored on drop
/// AND explicitly before `process::exit` (which skips destructors).
///
/// Only the INPUT side is made raw (ICANON/ECHO/ISIG/ICRNL/IXON/IEXTEN off,
/// VMIN=1): every keystroke — Ctrl-C, arrows, Ctrl-V — passes straight
/// through to the TUI. Output flags are left untouched so our own writes and
/// the relayed TUI stream still render like a normal cooked terminal.
///
/// Unix-only: termios is a POSIX API. On Windows the whole `term` command is
/// unsupported (see `run`), so this never exists there.
#[cfg(unix)]
struct RawStdin {
    saved: Option<termios::Termios>,
}

#[cfg(unix)]
impl RawStdin {
    fn enter() -> Result<Self, String> {
        if !std::io::stdin().is_terminal() {
            return Ok(RawStdin { saved: None });
        }
        let fd = libc::STDIN_FILENO;
        let saved =
            termios::Termios::from_fd(fd).map_err(|e| format!("tcgetattr(stdin) failed: {e}"))?;
        let mut raw = saved;
        raw.c_lflag &= !(termios::ICANON | termios::ECHO | termios::ISIG | termios::IEXTEN);
        raw.c_iflag &= !(termios::ICRNL | termios::IXON);
        raw.c_cc[termios::VMIN] = 1;
        raw.c_cc[termios::VTIME] = 0;
        termios::tcsetattr(fd, termios::TCSANOW, &raw)
            .map_err(|e| format!("tcsetattr(stdin) failed: {e}"))?;
        Ok(RawStdin { saved: Some(saved) })
    }

    /// Restore the saved termios; idempotent.
    fn restore(&mut self) {
        if let Some(saved) = self.saved.take()
            && let Err(e) = termios::tcsetattr(libc::STDIN_FILENO, termios::TCSANOW, &saved)
        {
            warn!(error = %e, "failed to restore terminal settings");
        }
    }
}

#[cfg(unix)]
impl Drop for RawStdin {
    fn drop(&mut self) {
        self.restore();
    }
}

/// The daemon's auth token: `OMP_REMOTE_TOKEN` env first, else the daemon's
/// token file. `cfg.paths.token_file` (<state_dir>/token) is the canonical
/// location for the setup-generated token; the legacy `~/.omp/omp-remote.token`
/// is kept as a fallback for installs that predate the state-dir migration
/// (Paths::resolve copies legacy files across, but a token may exist in only
/// one place on a half-migrated machine).
fn read_token(cfg: &Config) -> Option<String> {
    std::env::var("OMP_REMOTE_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| read_token_file(&cfg.paths.token_file))
        .or_else(|| read_token_file(&cfg.home.join(".omp/omp-remote.token")))
}

/// The trimmed contents of a token file, or None when unreadable/empty.
fn read_token_file(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// POST the scraped link to the daemon's register endpoint over plain
/// HTTP/1.1 on the loopback listener. Never logs the link or its secret —
/// only the room id. A missing token is logged and skipped (the daemon
/// rejects unauthenticated registrations anyway).
async fn register_collab(port: u16, token: Option<String>, link: &str, room: &str) {
    let Some(token) = token else {
        warn!(
            room = %room,
            "collab register skipped: no auth token (OMP_REMOTE_TOKEN or ~/.omp/omp-remote.token)"
        );
        return;
    };
    let body = serde_json::json!({ "link": link }).to_string();
    let addr = format!("127.0.0.1:{port}");
    let connect = tokio::time::timeout(REGISTER_TIMEOUT, tokio::net::TcpStream::connect(&addr));
    let mut stream = match connect.await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            warn!(room = %room, error = %e, "collab register: connect failed");
            return;
        }
        Err(_) => {
            warn!(room = %room, "collab register: connect timed out");
            return;
        }
    };
    let req = format!(
        "POST /api/collab/register HTTP/1.1\r\n\
         Host: {addr}\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {0}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );
    if let Err(e) = stream.write_all(req.as_bytes()).await {
        warn!(room = %room, error = %e, "collab register: write failed");
        return;
    }
    let mut resp = Vec::new();
    let read = tokio::time::timeout(REGISTER_TIMEOUT, stream.read_to_end(&mut resp)).await;
    match read {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            warn!(room = %room, error = %e, "collab register: read failed");
            return;
        }
        Err(_) => {
            warn!(room = %room, "collab register: response timed out");
            return;
        }
    }
    let text = String::from_utf8_lossy(&resp);
    let (head, resp_body) = match text.split_once("\r\n\r\n") {
        Some((h, b)) => (h, b),
        None => (text.as_ref(), ""),
    };
    let status = head.split_whitespace().nth(1).unwrap_or("?").to_string();
    let json = serde_json::from_str::<serde_json::Value>(resp_body).ok();
    let ok = json
        .as_ref()
        .and_then(|v| v.get("ok"))
        .and_then(|o| o.as_bool())
        .unwrap_or(false);
    if status.starts_with('2') && ok {
        info!(room = %room, "collab link registered; phone streaming is live");
    } else {
        let err = json
            .as_ref()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| format!("HTTP {status}"));
        warn!(room = %room, error = %err, "collab register rejected");
    }
}

/// Run the TUI under a daemon-owned pty until it exits, then propagate its
/// exit status (via `process::exit`, after restoring the terminal). Returns
/// `Err` only for internal setup/relay failures.
pub async fn run() -> Result<(), String> {
    // tracing to stderr — stdout is the TUI's raw byte stream here.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();

    let cfg = Config::from_env()?;
    // Same env override as the daemon; the side-by-side default is 7682 (see
    // omp-pulse.service) so the register POST always finds the listener.
    let port = std::env::var("OMP_REMOTE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7682);
    let cwd = std::env::current_dir().map_err(|e| format!("current_dir: {e}"))?;
    // Args after `term` are passed straight to the omp child, so a PATH shim
    // (`omp` → `omp_pulse term`) preserves flags like `omp --version`.
    let passthrough: Vec<String> = std::env::args()
        .skip_while(|a| a != "term")
        .skip(1)
        .collect();

    // Raw parent stdin FIRST so no keystroke is lost between spawn and relay.
    #[cfg(unix)]
    let mut raw = RawStdin::enter()?;

    // With no controlling terminal (systemd, CI, `omp_pulse doctor`'s probe)
    // nothing renders to a human, so pick a wide pty instead of the 80x24
    // default: the TUI wraps its box at the pty width, and a wrapped collab
    // link is the narrow-terminal failure the de-wrapping scrape exists for.
    // Being wide here keeps headless output on one line as well.
    let size = parent_size().unwrap_or(PtySize {
        rows: 60,
        cols: 220,
        pixel_width: 0,
        pixel_height: 0,
    });
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;
    let master = pair.master;

    let mut cmd = CommandBuilder::new(&cfg.omp_bin);
    for arg in &passthrough {
        cmd.arg(arg);
    }
    // portable-pty defaults the cwd to $HOME; the TUI must start where we did.
    cmd.cwd(&cwd);
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {} failed: {e}", cfg.omp_bin.display()))?;

    // Single shared master writer: the stdin relay and the /collab injection
    // both write to it. It is kept alive (never dropped) until the process
    // exits, so the slave never sees a master-side EOF while the TUI runs.
    let writer = match master.take_writer() {
        Ok(w) => Arc::new(Mutex::new(w)),
        Err(e) => {
            let _ = child.kill();
            return Err(format!("take_writer: {e}"));
        }
    };

    // stdin -> master. On parent stdin EOF the TUI stays alive (it may be
    // waiting); we just stop relaying. The writer is NOT dropped here —
    // dropping it would send EOF to the slave.
    let stdin_writer = Arc::clone(&writer);
    let _stdin_thread = std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        let mut buf = [0u8; 4096];
        loop {
            let n = match input.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut w = match stdin_writer.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if w.write_all(&buf[..n]).is_err() {
                break;
            }
        }
    });

    // master -> stdout (+ rolling tail for the link scrape). The channel is
    // bounded: when the parent terminal is slow, the TUI throttles via pty
    // flow control instead of unbounded buffering.
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let reader = match master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = child.kill();
            return Err(format!("try_clone_reader: {e}"));
        }
    };
    let _reader_thread = std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // pty EOF: the TUI and its slaves are gone
                Ok(n) => n,
            };
            if tx.blocking_send(buf[..n].to_vec()).is_err() {
                break; // main loop gone
            }
        }
    });

    // Auto-/collab: inject the command candidates once the TUI has had a
    // moment to reach its prompt, then RETRY until the link is scraped. A
    // fixed early settle races the TUI's startup (MCP connect can take longer
    // than the delay), and a bare `/collab` is correct for omp ≥17.2.15 —
    // see COLLAB_CANDIDATES for the ordering rationale.
    let omp_bin = cfg.omp_bin.clone();
    let scraped = Arc::new(AtomicBool::new(false));
    let linkish_seen = Arc::new(AtomicBool::new(false));
    let collab_writer = Arc::clone(&writer);
    let collab_scraped = Arc::clone(&scraped);
    let collab_linkish = Arc::clone(&linkish_seen);
    let _collab_thread = std::thread::spawn(move || {
        std::thread::sleep(COLLAB_SETTLE);
        for attempt in 0..5 {
            if collab_scraped.load(Ordering::SeqCst) {
                return;
            }
            // Every submission is preceded by the existing ESC-clear: Escape
            // empties the input bar so a leftover partial command from an
            // earlier attempt cannot corrupt the next candidate.
            {
                let mut w = match collab_writer.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                let _ = w.write_all(b"\x1b");
            }
            std::thread::sleep(Duration::from_millis(200));
            let candidate = COLLAB_CANDIDATES[collab_candidate(attempt)];
            {
                let mut w = match collab_writer.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                if let Err(e) = w.write_all(candidate) {
                    warn!(error = %e, "auto /collab write failed");
                    return;
                }
            }
            std::thread::sleep(Duration::from_secs(8));
        }
        if !collab_scraped.load(Ordering::SeqCst) {
            // Real degradation: the TUI may be hosting but the phone can
            // never attach. Log at ERROR with the omp version (best-effort),
            // a trigger-vs-scrape verdict, and the doctor remedy.
            let version = omp_version(&omp_bin);
            let verdict = if collab_linkish.load(Ordering::SeqCst) {
                "a link-looking `/r/` string WAS printed but did not validate — scrape failure (link grammar changed)"
            } else {
                "no link-looking output was seen — trigger failure (/collab command grammar likely changed)"
            };
            error!(
                version = %version,
                "auto /collab gave up: no collab link scraped after retries; live streaming not enabled. \
                 {verdict}. Fix: run `omp_pulse doctor`."
            );
        }
    });

    // SIGWINCH -> read the parent size -> resize the pty. Re-armed per signal.
    // Unix-only: tokio's unix signal module does not exist on Windows, and
    // there is no window-change signal there anyway; the arm is a
    // never-resolving future so the select shape stays identical.
    #[cfg(unix)]
    let winch_arm =
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change()) {
            Ok(mut sig) => Either::Left(async move {
                loop {
                    let _ = sig.recv().await;
                }
            }),
            Err(e) => {
                warn!(error = %e, "SIGWINCH unavailable; resize disabled");
                Either::Right(std::future::pending())
            }
        };
    #[cfg(not(unix))]
    let winch_arm = std::future::pending::<()>();
    pin_mut!(winch_arm);

    // Reap the child off the async executor.
    let child_fut = tokio::task::spawn_blocking(move || child.wait()).fuse();
    pin_mut!(child_fut);

    let mut out = std::io::stdout();
    let mut tail: VecDeque<u8> = VecDeque::with_capacity(TAIL_CAP);
    let mut scanning = true;
    let mut register_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut rx_opt = Some(rx);
    let mut child_done = false;
    let mut exit_code: u32 = 0;
    let mut drain_deadline: Option<tokio::time::Instant> = None;

    loop {
        if child_done && rx_opt.is_none() {
            break;
        }
        if let Some(dl) = drain_deadline
            && tokio::time::Instant::now() >= dl
        {
            break;
        }

        tokio::select! {
            maybe = async {
                match rx_opt.as_mut() {
                    Some(r) => r.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                match maybe {
                    Some(chunk) => {
                        if out.write_all(&chunk).is_err() {
                            warn!("stdout write failed; output relay dropped");
                        }
                        if scanning {
                            for &b in &chunk {
                                tail.push_back(b);
                            }
                            while tail.len() > TAIL_CAP {
                                tail.pop_front();
                            }
                            if let Some(found) = scrape_link(&tail, true) {
                                scanning = false;
                                scraped.store(true, Ordering::SeqCst);
                                let token = read_token(&cfg);
                                register_task = Some(tokio::spawn(async move {
                                    register_collab(port, token, &found.link, &found.room).await;
                                }));
                            } else if !linkish_seen.load(Ordering::SeqCst)
                                && tail_contains_linkish(&tail)
                            {
                                // A link-looking `/r/` string printed but did
                                // not validate — remember it for the give-up
                                // verdict (scrape failure vs trigger failure).
                                linkish_seen.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                    None => {
                        // Master closed: the reader thread is done; nothing
                        // more will arrive. One final scrape with the stream
                        // known closed, so a link that completed exactly at
                        // the end of the stream (no trailing newline) still
                        // registers.
                        rx_opt = None;
                        if scanning {
                            if let Some(found) = scrape_link(&tail, false) {
                                scanning = false;
                                scraped.store(true, Ordering::SeqCst);
                                let token = read_token(&cfg);
                                register_task = Some(tokio::spawn(async move {
                                    register_collab(port, token, &found.link, &found.room).await;
                                }));
                            } else if !linkish_seen.load(Ordering::SeqCst)
                                && tail_contains_linkish(&tail)
                            {
                                linkish_seen.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                }
            }
            res = &mut child_fut => {
                child_done = true;
                exit_code = match res {
                    Ok(Ok(status)) => status.exit_code(),
                    Ok(Err(e)) => {
                        warn!(error = %e, "wait on omp failed");
                        1
                    }
                    Err(e) => {
                        warn!(error = %e, "omp wait task failed");
                        1
                    }
                };
                drain_deadline = Some(tokio::time::Instant::now() + DRAIN_GRACE);
            }
            _ = &mut winch_arm => {
                if let Some(size) = parent_size()
                    && let Err(e) = master.resize(size) {
                        warn!(error = %e, "pty resize failed");
                    }
            }
        }
    }

    // Let an in-flight register finish so a just-scraped link is not lost on
    // a fast TUI exit; the POST itself is timeout-bounded.
    if let Some(task) = register_task.take() {
        let _ = task.await;
    }
    let _ = out.flush();
    #[cfg(unix)]
    raw.restore(); // explicit — process::exit skips destructors
    std::process::exit(exit_code as i32);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real collab-link shape: 22-char base64url room id + 64-char secret
    /// (48 random bytes, base64url unpadded) — the same shape the TUI prints.
    const ROOM: &str = "2W-_lMf1VJGNw3YatCL4Eg";
    const SECRET_48: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v";

    fn tail(s: &str) -> VecDeque<u8> {
        s.as_bytes().iter().copied().collect()
    }

    /// The exact shape omp 17.2.15 prints inside its box at 80 columns, taken
    /// verbatim from a captured pty stream: `omp join` on one visual line, the
    /// quoted link split mid-secret across the next two, with padding.
    /// Scraping this is the difference between auto-collab working in a normal
    /// terminal window and failing silently.
    #[test]
    fn wrapped_link_across_visual_lines_scrapes() {
        let (a, b) = SECRET_48.split_at(46);
        let text = format!(
            " Share this session live. Run this from another terminal: omp join       \n \"ws://127.0.0.1:7682/r/{ROOM}.{a} \n {b}\"                        \n Anyone with the link can read the session.\n"
        );
        let found = scrape_link(&tail(&text), false).expect("wrapped link must scrape");
        assert_eq!(found.room, ROOM);
        assert_eq!(
            found.link,
            format!("ws://127.0.0.1:7682/r/{ROOM}.{SECRET_48}")
        );
    }

    /// Box-drawing borders between the wrapped halves must not defeat the join.
    #[test]
    fn wrapped_link_across_box_borders_scrapes() {
        let (a, b) = SECRET_48.split_at(30);
        let text = format!("│ omp join \"ws://127.0.0.1:7682/r/{ROOM}.{a} │\n│ {b}\" │\n");
        let found = scrape_link(&tail(&text), false).expect("bordered wrap must scrape");
        assert_eq!(
            found.link,
            format!("ws://127.0.0.1:7682/r/{ROOM}.{SECRET_48}")
        );
    }

    /// A wrapped web deep link loses its boundary when de-wrapped (the next
    /// line's prose glues onto the secret), so it MUST be rejected rather than
    /// guessed at — registering a mis-sliced key would attach to a room we can
    /// never decrypt.
    #[test]
    fn dewrapped_secret_glued_to_prose_is_rejected() {
        let (a, b) = SECRET_48.split_at(50);
        let text = format!(
            " 127.0.0.1:7682/#ws://127.0.0.1:7682/r/{ROOM}.{a}\n {b}\n Anyone with the link\n"
        );
        assert!(scrape_link(&tail(&text), false).is_none());
    }

    /// …but when the same output ALSO carries the quoted `omp join` render —
    /// which is what omp actually prints — the quote-bounded secret wins even
    /// though the ambiguous web-link form appears first in the stream.
    #[test]
    fn quoted_render_wins_over_ambiguous_web_link() {
        let (a, b) = SECRET_48.split_at(50);
        let (c, d) = SECRET_48.split_at(46);
        let text = format!(
            " 127.0.0.1:7682/#ws://127.0.0.1:7682/r/{ROOM}.{a}\n {b}\n Anyone with the link\n omp join       \n \"ws://127.0.0.1:7682/r/{ROOM}.{c} \n {d}\"    \n"
        );
        let found = scrape_link(&tail(&text), false).expect("quoted render must scrape");
        assert_eq!(
            found.link,
            format!("ws://127.0.0.1:7682/r/{ROOM}.{SECRET_48}")
        );
    }

    /// A half-printed wrapped secret while the stream is still open must NOT
    /// register: the 43-char prefix of a 48-byte secret can decode as a
    /// plausible 32-byte view key, which would never decrypt.
    #[test]
    fn half_printed_wrapped_secret_rejected_while_open() {
        let head = &SECRET_48[..47];
        let text = format!(" omp join \"ws://127.0.0.1:7682/r/{ROOM}.{head}");
        assert!(scrape_link(&tail(&text), true).is_none());
    }

    #[test]
    fn quoted_hint_scrapes_at_tail_end_with_stream_open() {
        // The `omp join "<link>"` copy-paste hint, last thing in the tail,
        // with the stream still open: the closing quote proves completeness,
        // so the mid-secret guard must not reject it.
        let t = tail(&format!(
            "Copy: omp join \"ws://relay.local:7682/r/{ROOM}.{SECRET_48}\""
        ));
        let found = scrape_link(&t, true).expect("quoted hint should scrape");
        assert_eq!(found.room, ROOM);
        assert_eq!(
            found.link,
            format!("ws://relay.local:7682/r/{ROOM}.{SECRET_48}")
        );
    }

    #[test]
    fn quoted_hint_with_bad_secret_rejected() {
        // A 40-char cut of the 64-char secret decodes to 30 bytes — not a
        // valid 32B view or 48B full secret — so the quoted path must reject
        // it (no bare-URL fallback to the same link).
        let bad = &SECRET_48[..40];
        let t = tail(&format!("omp join \"ws://relay.local/r/{ROOM}.{bad}\""));
        assert!(
            scrape_link(&t, true).is_none(),
            "wrong-length secret must be rejected"
        );
    }

    #[test]
    fn bare_url_scrapes_after_quote_or_prose() {
        // 17.2.15 wraps the link in quotes; the bare matcher must still
        // accept a URL followed by the closing quote (no `omp join "` prefix
        // for the anchored hint to match).
        let quoted = tail(&format!("ws://relay.local/r/{ROOM}.{SECRET_48}\""));
        let found = scrape_link(&quoted, true).expect("bare URL before a quote should scrape");
        assert_eq!(found.room, ROOM);

        // Trailing same-line prose is fine as long as the secret itself is
        // complete — the guard only rejects a mid-secret cut.
        let prose = tail(&format!(
            "ws://relay.local/r/{ROOM}.{SECRET_48} press enter"
        ));
        let found = scrape_link(&prose, true).expect("bare URL before prose should scrape");
        assert_eq!(found.link, format!("ws://relay.local/r/{ROOM}.{SECRET_48}"));
    }

    #[test]
    fn truncated_bare_secret_rejected_while_stream_open() {
        // A 43-char cut of a 64-char secret decodes to exactly 32 bytes — a
        // valid view secret — so the ONLY thing rejecting it while the
        // stream is open is the mid-secret guard, not the length check.
        let cut = &SECRET_48[..43];
        let t = tail(&format!("ws://relay.local/r/{ROOM}.{cut}"));
        assert!(
            scrape_link(&t, true).is_none(),
            "mid-secret cut must wait for more output"
        );
    }

    #[test]
    fn collab_candidate_cycles_bare_first_then_alternates() {
        // Attempt order: 0, 0 (bare /collab twice — first attempt, then
        // again after a longer settle), then 1, 0, 1, … alternating.
        let seq: Vec<usize> = (0..6).map(collab_candidate).collect();
        assert_eq!(seq, vec![0, 0, 1, 0, 1, 0]);
    }
}
