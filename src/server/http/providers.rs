//! Model-provider management for paired devices: list providers and sign in
//! through `omp login`.
//!
//! `omp login <id>` is interactive: it prints an authorization URL (or a device
//! code) and may then wait for a pasted code or API key. The phone drives it by
//! polling the transcript and forwarding lines. Every route here is Admin-only
//! (`auth::required_role`): the channel carries pasted API keys, and signing in
//! changes which account the computer's omp uses.
//!
//! The transcript and the input lines can hold authorization URLs and API keys,
//! so neither is ever logged.

use super::*;
use axum::{extract::State, http::StatusCode, response::Response};
use serde_json::{Value, json};
use std::{
    path::Path as FsPath,
    process::Stdio,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::{mpsc, oneshot},
};

/// A sign-in nobody finishes must not keep a process (and its local callback
/// port) alive for ever.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const SHORT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// Login transcripts are a few lines; the cap only bounds a runaway process.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// A pasted redirect URL is the longest legitimate line.
const MAX_INPUT_BYTES: usize = 16 * 1024;
/// How long output may keep trickling in from a killed process's orphans.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

struct Login {
    generation: u64,
    provider: String,
    /// Raw bytes, tail-capped; ANSI is stripped when the state is read.
    output: Vec<u8>,
    exit: Option<i32>,
    input: Option<mpsc::UnboundedSender<String>>,
    /// INVARIANT: dropping a `Login` stops its process (the supervisor treats a
    /// closed sender like a sent one), so replacing or clearing the slot is
    /// always a cancel.
    cancel: Option<oneshot::Sender<()>>,
}

/// One sign-in at a time, machine-wide: omp's credential store is per user.
static LOGIN: Mutex<Option<Login>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(1);

fn login_slot() -> MutexGuard<'static, Option<Login>> {
    LOGIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Provider ids come from omp's own list. Anything else would reach the
/// command line, so a leading `-` (a flag) or a shell/cmd metacharacter on
/// Windows' `omp.cmd` is refused outright.
fn valid_provider(id: &str) -> bool {
    id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Remove ANSI escape sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`)
/// and two-character escapes.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(n) = chars.next() {
                    if n == '\x07' {
                        break;
                    }
                    if n == '\x1b' {
                        // String terminator `ESC \`.
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Append `chunk`, keeping only the newest `MAX_OUTPUT_BYTES`. The cut never
/// leaves a half UTF-8 character at the front.
fn append_capped(output: &mut Vec<u8>, chunk: &[u8]) {
    output.extend_from_slice(chunk);
    if output.len() > MAX_OUTPUT_BYTES {
        output.drain(..output.len() - MAX_OUTPUT_BYTES);
        let skip = output.iter().take_while(|b| **b & 0xC0 == 0x80).count();
        output.drain(..skip);
    }
}

fn clean_output(raw: &[u8]) -> String {
    strip_ansi(&String::from_utf8_lossy(raw))
}

/// `omp auth-broker list` prints `  <id> <label…>` per provider under a header
/// line; ids that are not valid provider ids (wrapped hints, notes) are dropped.
fn parse_provider_list(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter(|line| line.starts_with("  "))
        .filter_map(|line| {
            let line = line.trim();
            let (id, label) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
            valid_provider(id).then(|| {
                let label = label.trim();
                let label = if label.is_empty() { id } else { label };
                (id.to_owned(), label.to_owned())
            })
        })
        .collect()
}

fn omp_command(bin: &FsPath) -> Command {
    let mut cmd = Command::new(bin);
    cmd.kill_on_drop(true);
    // Own process group so a kill reaches whatever omp itself started.
    #[cfg(unix)]
    cmd.process_group(0);
    // No console window flashing up when the daemon runs as a Windows service.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(0x0800_0000);
    }
    cmd
}

fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
        // SAFETY: kill(2) takes plain integers and touches no memory.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    // Elsewhere only omp itself is killed; its helpers exit when their stdio closes.
    let _ = child.start_kill();
}

async fn pump(generation: u64, mut reader: impl AsyncRead + Unpin) {
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => match login_slot().as_mut() {
                Some(login) if login.generation == generation => {
                    append_capped(&mut login.output, &buffer[..read]);
                }
                _ => return,
            },
        }
    }
}

/// Owns the process until it ends, is cancelled, or times out, and records the
/// exit code (`-1` when killed or signalled) in the slot.
async fn supervise(
    generation: u64,
    mut child: Child,
    mut stdin: tokio::process::ChildStdin,
    mut input: mpsc::UnboundedReceiver<String>,
    mut cancel: oneshot::Receiver<()>,
    outputs: [tokio::task::JoinHandle<()>; 2],
    timeout: Duration,
) {
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut timed_out = false;
    let exit = loop {
        tokio::select! {
            status = child.wait() => break status.ok().and_then(|s| s.code()).unwrap_or(-1),
            Some(line) = input.recv() => {
                // A process that already closed stdin is about to exit; its
                // status arrives through the branch above.
                let _ = stdin.write_all(line.as_bytes()).await;
                let _ = stdin.flush().await;
            }
            _ = &mut cancel => {
                kill_tree(&mut child);
                let _ = child.wait().await;
                break -1;
            }
            _ = &mut deadline => {
                timed_out = true;
                kill_tree(&mut child);
                let _ = child.wait().await;
                break -1;
            }
        }
    };
    drop(stdin);
    for output in outputs {
        // An orphan holding the pipe open must not keep the state "running".
        let abort = output.abort_handle();
        if tokio::time::timeout(DRAIN_GRACE, output).await.is_err() {
            abort.abort();
        }
    }
    let mut slot = login_slot();
    if let Some(login) = slot.as_mut().filter(|l| l.generation == generation) {
        if timed_out {
            append_capped(&mut login.output, b"\nSign-in timed out.\n");
        }
        login.exit = Some(exit);
        login.input = None;
        login.cancel = None;
        tracing::info!(provider = %login.provider, exit, "provider sign-in finished");
    }
}

/// Start `<bin> login <provider>`, replacing any sign-in already running.
fn start_login(bin: &FsPath, provider: &str, timeout: Duration) -> Result<(), String> {
    let mut cmd = omp_command(bin);
    cmd.args(["login", provider])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut slot = login_slot();
    // Stop the old process before the new one starts: both would listen on the
    // provider's local callback port.
    *slot = None;
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("omp could not be started: {error}"))?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        kill_tree(&mut child);
        return Err("omp could not be started: no pipes".to_owned());
    };
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
    let (input_tx, input_rx) = mpsc::unbounded_channel();
    let (cancel_tx, cancel_rx) = oneshot::channel();
    *slot = Some(Login {
        generation,
        provider: provider.to_owned(),
        output: Vec::new(),
        exit: None,
        input: Some(input_tx),
        cancel: Some(cancel_tx),
    });
    // omp prints prompts and the URL on either stream.
    let outputs = [
        tokio::spawn(pump(generation, stdout)),
        tokio::spawn(pump(generation, stderr)),
    ];
    tokio::spawn(supervise(
        generation, child, stdin, input_rx, cancel_rx, outputs, timeout,
    ));
    Ok(())
}

/// Same shape as the Android bridge's `loginState()`, plus the provider id so a
/// reloaded page can say which sign-in it found.
fn state_json(slot: &Option<Login>) -> Value {
    match slot {
        Some(login) => json!({
            "ok": true,
            "provider": login.provider,
            "running": login.exit.is_none(),
            "exitCode": login.exit,
            "output": clean_output(&login.output),
        }),
        None => json!({ "ok": true, "running": false, "exitCode": null, "output": "" }),
    }
}

pub(super) async fn providers_list(State(state): State<Arc<AppState>>) -> Response {
    let mut cmd = omp_command(&state.cfg.omp_bin);
    cmd.args(["auth-broker", "list"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = match tokio::time::timeout(SHORT_COMMAND_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return err(&format!("omp could not be started: {error}")),
        Err(_) => {
            return err(&format!(
                "omp did not answer within {} s.",
                SHORT_COMMAND_TIMEOUT.as_secs()
            ));
        }
    };
    let stdout = clean_output(&output.stdout);
    let listed = parse_provider_list(&stdout);
    if listed.is_empty() {
        let mut tail = format!("{stdout}{}", clean_output(&output.stderr));
        tail = tail.trim().to_owned();
        if let Some((cut, _)) = tail.char_indices().rev().nth(599) {
            tail = format!("…{}", &tail[cut..]);
        }
        let code = output.status.code().unwrap_or(-1);
        return err(&if tail.is_empty() {
            format!("omp exited with code {code}.")
        } else {
            format!("omp exited with code {code}: {tail}")
        });
    }
    let root = state.cfg.sessions_root.clone();
    let signed_in = tokio::task::spawn_blocking(move || {
        crate::sessions::model_usage::signed_in_providers(&root)
    })
    .await
    .unwrap_or_default();
    let providers: Vec<Value> = listed
        .into_iter()
        .map(|(id, label)| {
            let signed = signed_in.contains(&id);
            json!({ "id": id, "label": label, "signedIn": signed })
        })
        .collect();
    ok(json!({ "ok": true, "providers": providers }))
}

pub(super) async fn login_start(
    State(state): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Response {
    let body = body_value(body);
    let provider = body.get("provider").and_then(Value::as_str).unwrap_or("");
    if !valid_provider(provider) {
        return err_status(StatusCode::BAD_REQUEST, "invalid provider");
    }
    if let Err(message) = start_login(&state.cfg.omp_bin, provider, LOGIN_TIMEOUT) {
        return err(&message);
    }
    ok(state_json(&login_slot()))
}

pub(super) async fn login_state() -> Response {
    ok(state_json(&login_slot()))
}

pub(super) async fn login_input(body: Option<Json<Value>>) -> Response {
    let body = body_value(body);
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if text.is_empty() {
        return err_status(StatusCode::BAD_REQUEST, "nothing to send");
    }
    if text.len() > MAX_INPUT_BYTES {
        return err_status(StatusCode::BAD_REQUEST, "input is too long");
    }
    let sent = login_slot()
        .as_ref()
        .and_then(|login| login.input.as_ref())
        .is_some_and(|input| input.send(format!("{text}\n")).is_ok());
    if sent {
        ok(json!({ "ok": true }))
    } else {
        err("No sign-in is running.")
    }
}

pub(super) async fn login_cancel() -> Response {
    // Dropping the login stops its process (see `Login::cancel`).
    *login_slot() = None;
    ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_csi_osc_and_short_escapes() {
        assert_eq!(strip_ansi("\x1b[1;32mOpen\x1b[0m this"), "Open this");
        assert_eq!(
            strip_ansi("a\x1b]8;;https://x\x07link\x1b]8;;\x1b\\b"),
            "alinkb"
        );
        assert_eq!(strip_ansi("x\x1b7y\x1b[2K\r\n"), "xy\r\n");
        // A sequence cut off at the end of the buffer is dropped, not echoed.
        assert_eq!(strip_ansi("done\x1b[3"), "done");
        assert_eq!(strip_ansi("ünïcode ✓"), "ünïcode ✓");
    }

    #[test]
    fn output_keeps_the_newest_bytes_on_a_character_boundary() {
        let mut out = Vec::new();
        append_capped(&mut out, b"old");
        assert_eq!(out, b"old");
        let chunk = vec![b'a'; MAX_OUTPUT_BYTES];
        append_capped(&mut out, &chunk);
        assert_eq!(out.len(), MAX_OUTPUT_BYTES);
        assert!(out.iter().all(|b| *b == b'a'));
        // Cutting inside a 3-byte character drops its remaining bytes.
        let mut out = "✓".repeat(MAX_OUTPUT_BYTES / 3 + 1).into_bytes();
        append_capped(&mut out, b"");
        assert!(out.len() <= MAX_OUTPUT_BYTES);
        assert!(std::str::from_utf8(&out).is_ok());
    }

    #[test]
    fn parses_the_auth_broker_list() {
        let text = "\nAvailable providers:\n\n  openai-codex         ChatGPT Plus/Pro (Codex Subscription)\n  openrouter           OpenRouter\n  bare\n    --bad hint line\n  -x flag\nnot indented\n";
        assert_eq!(
            parse_provider_list(text),
            [
                (
                    "openai-codex".into(),
                    "ChatGPT Plus/Pro (Codex Subscription)".into()
                ),
                ("openrouter".into(), "OpenRouter".into()),
                ("bare".into(), "bare".into()),
            ]
        );
        assert!(parse_provider_list("error: nope\n").is_empty());
    }

    #[test]
    fn provider_ids_cannot_reach_the_command_line_as_flags() {
        assert!(valid_provider("github-copilot"));
        assert!(valid_provider("openai-codex-device"));
        assert!(!valid_provider(""));
        assert!(!valid_provider("-x"));
        assert!(!valid_provider("a b"));
        assert!(!valid_provider("a&b"));
        assert!(!valid_provider(&"a".repeat(65)));
    }

    #[test]
    fn idle_state_reports_not_running() {
        let state = state_json(&None);
        assert_eq!(state["running"], false);
        assert_eq!(state["exitCode"], Value::Null);
        assert_eq!(state["output"], "");
    }

    /// The one test that touches the process-wide slot: input, success, cancel
    /// and timeout run in sequence so they cannot race each other.
    #[cfg(unix)]
    #[tokio::test]
    async fn login_lifecycle_over_a_fake_omp() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("omp-pulse-login-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("fake-omp");
        let script = "#!/bin/sh\nprintf '\\033[1mOpen this URL:\\033[0m\\nhttps://example.test/auth\\n'\nif [ \"$2\" = hang ]; then sleep 30; fi\nIFS= read -r line\necho \"got:$line\" >&2\n[ \"$line\" = good ]\n";
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        async fn finished() -> Value {
            for _ in 0..200 {
                let state = state_json(&login_slot());
                if state["running"] == false {
                    return state;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("login never finished");
        }
        async fn output_contains(needle: &str) {
            for _ in 0..200 {
                if state_json(&login_slot())["output"]
                    .as_str()
                    .unwrap()
                    .contains(needle)
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("never saw {needle}");
        }

        // Success: URL shown (ANSI stripped), a pasted line reaches stdin.
        start_login(&bin, "fake", LOGIN_TIMEOUT).unwrap();
        output_contains("https://example.test/auth").await;
        let running = state_json(&login_slot());
        assert_eq!(running["running"], true);
        assert!(!running["output"].as_str().unwrap().contains('\x1b'));
        login_slot()
            .as_ref()
            .unwrap()
            .input
            .as_ref()
            .unwrap()
            .send("good\n".into())
            .unwrap();
        let done = finished().await;
        assert_eq!(done["exitCode"], 0);
        assert!(done["output"].as_str().unwrap().contains("got:good"));

        // Failure: a nonzero exit is reported, not hidden.
        start_login(&bin, "fake", LOGIN_TIMEOUT).unwrap();
        login_slot()
            .as_ref()
            .unwrap()
            .input
            .as_ref()
            .unwrap()
            .send("bad\n".into())
            .unwrap();
        assert_eq!(finished().await["exitCode"], 1);

        // Cancel kills the process and clears the state.
        start_login(&bin, "hang", LOGIN_TIMEOUT).unwrap();
        output_contains("https://example.test/auth").await;
        *login_slot() = None;
        assert_eq!(state_json(&login_slot())["running"], false);

        // Timeout kills it and says so.
        start_login(&bin, "hang", Duration::from_millis(300)).unwrap();
        let timed_out = finished().await;
        assert_eq!(timed_out["exitCode"], -1);
        assert!(timed_out["output"].as_str().unwrap().contains("timed out"));

        *login_slot() = None;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
