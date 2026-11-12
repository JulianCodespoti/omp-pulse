//! Speech-to-text for the phone's dictation button.
//!
//! WHY A SIDECAR: the crate's dependency policy forbids anything that pulls
//! `openssl-sys`, and an ONNX Runtime binding is a large native dependency that
//! would have to build for the shipped `x86_64-pc-windows-gnu` and
//! `x86_64-unknown-linux-musl` targets. So Cargo.toml is untouched and the model
//! runs in a python sidecar, exactly as `omp` itself runs as a child process.
//!
//! WHY WARM: loading Parakeet 0.6B int8 costs ~3s; decoding 7.4s of speech costs
//! ~0.45s (measured on a Core Ultra 9 285H, 6 threads). A per-request process
//! would spend most of its life loading weights, so the sidecar is spawned on
//! demand (`warm` when recording starts, else the first transcription), reused
//! across a burst, and reaped after `IDLE_TIMEOUT` because it holds ~0.73 GiB
//! resident and peaks near 1 GiB while decoding (measured on the phone; see the
//! sidecar's MEMORY note).
//!
//! WHY THIS MODEL: NVIDIA Parakeet, via sherpa-onnx, rather than Whisper. It is
//! more accurate than Whisper large-v3 on the Open ASR Leaderboard English sets
//! (5.91% vs ~7.4% average WER) at a third of the parameters, it runs on CPU with
//! no PyTorch, and — the reason that decides it for dictation — a transducer
//! cannot emit tokens without audio evidence, so it does not hallucinate
//! sentences during the silence that starts and ends every recording. That is a
//! documented Whisper failure mode and it is unacceptable when the output is
//! about to be sent to a coding agent.
//!
//! Requests are SERIALIZED. Dictation is one-at-a-time per person, so a mutex
//! around the sidecar is simpler and more predictable than a correlation map,
//! and it bounds CPU use to one decode at a time.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::time::Instant;
use tracing::{info, warn};

use crate::metrics;
use crate::types::SharedConfig;

/// The sidecar script, embedded so a packaged binary carries it and so the copy
/// on disk can never drift from the daemon that speaks its protocol.
const SIDECAR_SRC: &str = include_str!("asr-server.py");

/// First request pays the model load; 60s is generous for a cold page cache.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// A 5-minute clip decodes in ~20s at 15x realtime; 120s is the ceiling.
const DECODE_TIMEOUT: Duration = Duration::from_secs(120);
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(60);
/// The sidecar holds ~0.73 GiB resident (~1 GiB while decoding, measured on the
/// phone), enough to get a memory-tight phone's whole app killed. Keep it only
/// across a burst of dictation; `warm` hides the respawn inside the next recording.
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);
/// Refuse absurd uploads before spending a temp file on them. 25 MiB of opus is
/// over an hour of speech.
const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
/// Hard cap on decoded audio; a phone that uploads an album gets truncated
/// rather than pinning a core for minutes.
const MAX_AUDIO_SECS: u64 = 300;

/// Why transcription is unavailable, phrased for the phone to display verbatim.
#[derive(Debug, Clone)]
pub enum Availability {
    Ready { model: String },
    Missing { reason: String },
}

pub struct Transcript {
    pub text: String,
    pub decode_ms: u64,
    pub audio_ms: u64,
    pub model: String,
}

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// Own the exact sidecar while an inference is in flight. A cancelled request
/// must not leave that process doing untracked work (or leave its response for
/// the next request). Merely waiting for the slot never owns or kills it.
struct ActiveSidecar<'a> {
    slot: tokio::sync::MutexGuard<'a, Option<Sidecar>>,
    completed: bool,
}

impl Drop for ActiveSidecar<'_> {
    fn drop(&mut self) {
        if !self.completed
            && let Some(mut sidecar) = self.slot.take()
        {
            let _ = sidecar.child.start_kill();
        }
    }
}

pub struct Asr {
    cfg: SharedConfig,
    /// Absent only for the CLI readiness query, which never runs ASR work.
    work: Option<Arc<crate::omp::child::ChildManager>>,
    sidecar: AsyncMutex<Option<Sidecar>>,
    last_used: Mutex<Instant>,
    /// Fired on every sidecar spawn: the reaper parks on it while there is no
    /// sidecar to reap.
    spawned: Notify,
    next_id: AtomicU64,
}

impl Asr {
    pub fn new(cfg: SharedConfig, work: Option<Arc<crate::omp::child::ChildManager>>) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            work,
            sidecar: AsyncMutex::new(None),
            last_used: Mutex::new(Instant::now()),
            spawned: Notify::new(),
            next_id: AtomicU64::new(1),
        })
    }

    /// Resolved python + model, or the specific reason the feature is off. Called
    /// by `/api/status` so the phone can hide the button with an explanation
    /// rather than offering a control that fails.
    pub fn availability(&self) -> Availability {
        let Some(python) = self.cfg.asr_python.as_ref() else {
            return Availability::Missing {
                reason: "no python interpreter for speech-to-text; run `omp-pulse asr install`"
                    .to_string(),
            };
        };
        if !python.is_file() {
            return Availability::Missing {
                reason: format!("speech-to-text interpreter missing: {}", python.display()),
            };
        }
        let Some(model) = self.cfg.asr_model_dir.as_ref() else {
            return Availability::Missing {
                reason: "no speech-to-text model installed; run `omp-pulse asr install`"
                    .to_string(),
            };
        };
        if !model.join("encoder.int8.onnx").is_file() {
            return Availability::Missing {
                reason: format!("speech-to-text model incomplete: {}", model.display()),
            };
        }
        if which_ffmpeg().is_none() {
            return Availability::Missing {
                reason: "ffmpeg not found; it decodes the phone's audio before transcription"
                    .to_string(),
            };
        }
        Availability::Ready {
            model: model
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }

    /// Load the model in the background so it overlaps the recording instead of
    /// trailing it. Called when the phone starts recording: a dictation lasts
    /// seconds, about what a cold model load costs. Returns whether the feature
    /// is available at all. The spawn runs under the same lock `transcribe`
    /// takes, so a transcription arriving mid-load waits for this sidecar
    /// instead of starting a second one.
    pub fn warm(self: &Arc<Self>) -> bool {
        if !matches!(self.availability(), Availability::Ready { .. }) {
            return false;
        }
        // Acquire before scheduling: queued warm-ups are active work too.
        let work = self.work.as_ref().map(|children| children.track_work());
        self.touch();
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let _work = work;
            let mut guard = me.sidecar.lock().await;
            if let Err(e) = me.ensure_spawned(&mut guard).await {
                // `transcribe` retries the spawn and reports the failure to the
                // phone; here it is only worth a log line.
                warn!("asr warm-up failed: {e}");
            }
            me.touch();
        });
        true
    }

    /// Decode `audio` (whatever the phone's MediaRecorder produced) and return
    /// its transcript.
    pub async fn transcribe(&self, audio: &[u8], mime: &str) -> Result<Transcript, String> {
        let model = match self.availability() {
            Availability::Ready { model } => model,
            Availability::Missing { reason } => return Err(reason),
        };
        // Covers decoding, queueing on the sidecar, loading and inference.
        // Cancellation drops both the process future and this busy guard.
        let _work = self.work.as_ref().map(|children| children.track_work());
        // Mark activity before the ffmpeg pass so the reaper cannot take the
        // sidecar between now and the moment this request locks it.
        self.touch();
        if audio.is_empty() {
            return Err("empty audio upload".to_string());
        }
        if audio.len() > MAX_AUDIO_BYTES {
            return Err(format!(
                "audio too large: {} bytes, limit {MAX_AUDIO_BYTES}",
                audio.len()
            ));
        }
        let scratch = Scratch::new(&self.cfg.state_dir, mime, audio)?;
        // 16 kHz mono s16: what the model was trained on, and what the sidecar's
        // wav reader expects. `-vn` guards against a container carrying video.
        let ff = tokio::process::Command::new(which_ffmpeg().unwrap_or_else(|| "ffmpeg".into()))
            .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&scratch.input)
            .args([
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-t",
                &MAX_AUDIO_SECS.to_string(),
                "-f",
                "wav",
                "-acodec",
                "pcm_s16le",
            ])
            .arg(&scratch.wav)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output();
        let out = tokio::time::timeout(FFMPEG_TIMEOUT, ff)
            .await
            .map_err(|_| "ffmpeg timed out decoding the upload".to_string())?
            .map_err(|e| format!("ffmpeg failed to start: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let tail = err.lines().last().unwrap_or("unknown error");
            return Err(format!("could not decode the recording: {tail}"));
        }

        let id = format!("t{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let wav = scratch.wav.to_string_lossy().into_owned();
        let mut request = ActiveSidecar {
            slot: self.sidecar.lock().await,
            completed: false,
        };
        self.ensure_spawned(&mut request.slot).await?;
        // One retry: a sidecar that dies between that check and the write is
        // invisible until the write fails, and losing a dictation to that would
        // be indistinguishable from losing it to a bug.
        let response = match self
            .round_trip(request.slot.as_mut().unwrap(), &id, &wav)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                warn!("asr sidecar failed ({e}); restarting once");
                if let Some(mut dead) = request.slot.take() {
                    let _ = dead.child.start_kill();
                }
                *request.slot = Some(self.spawn().await?);
                self.round_trip(request.slot.as_mut().unwrap(), &id, &wav)
                    .await?
            }
        };
        // Touch while still holding the lock: a reaper queued on it must see
        // this request's activity, not the stale timestamp it saw before.
        self.touch();
        request.completed = true;
        drop(request);

        if let Some(err) = response.get("error").and_then(|v| v.as_str()) {
            metrics::inc("asr_failed");
            return Err(err.to_string());
        }
        let text = response
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let decode_ms = response.get("ms").and_then(|v| v.as_u64()).unwrap_or(0);
        let audio_ms = response
            .get("audioMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        metrics::inc("asr_transcribed");
        metrics::observe_ms("asr_decode_ms", decode_ms);
        Ok(Transcript {
            text,
            decode_ms,
            audio_ms,
            model,
        })
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
    }

    /// Make `slot` hold a live sidecar. One that already exited (crash, OOM
    /// kill) is replaced here instead of being discovered by a failed write.
    async fn ensure_spawned(&self, slot: &mut Option<Sidecar>) -> Result<(), String> {
        if let Some(sidecar) = slot.as_mut() {
            if matches!(sidecar.child.try_wait(), Ok(None)) {
                return Ok(());
            }
            warn!("asr sidecar had exited; respawning");
            *slot = None;
        }
        *slot = Some(self.spawn().await?);
        Ok(())
    }

    async fn round_trip(
        &self,
        sidecar: &mut Sidecar,
        id: &str,
        wav: &str,
    ) -> Result<Value, String> {
        let line = serde_json::json!({ "id": id, "wav": wav }).to_string();
        sidecar
            .stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|e| format!("sidecar stdin write failed: {e}"))?;
        sidecar
            .stdin
            .flush()
            .await
            .map_err(|e| format!("sidecar stdin flush failed: {e}"))?;
        let deadline = tokio::time::Instant::now() + DECODE_TIMEOUT;
        loop {
            let mut buf = String::new();
            let read = tokio::time::timeout_at(deadline, sidecar.stdout.read_line(&mut buf))
                .await
                .map_err(|_| "transcription timed out".to_string())?
                .map_err(|e| format!("sidecar stdout read failed: {e}"))?;
            if read == 0 {
                return Err("sidecar exited".to_string());
            }
            let Ok(value) = serde_json::from_str::<Value>(buf.trim()) else {
                continue;
            };
            // Ignore anything that is not this request's answer: the ready frame
            // may still be queued, and a stale answer from a previous timed-out
            // request must not be handed to the caller as if it were theirs.
            if value.get("id").and_then(|v| v.as_str()) == Some(id) {
                return Ok(value);
            }
        }
    }

    async fn spawn(&self) -> Result<Sidecar, String> {
        let python = self
            .cfg
            .asr_python
            .clone()
            .ok_or_else(|| "no python for speech-to-text".to_string())?;
        let model_dir = self
            .cfg
            .asr_model_dir
            .clone()
            .ok_or_else(|| "no speech-to-text model".to_string())?;
        let script = self.materialize_script()?;
        let mut child = tokio::process::Command::new(&python)
            .arg(&script)
            .arg(&model_dir)
            .arg(self.cfg.asr_threads.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to start the speech-to-text sidecar: {e}"))?;
        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        let mut stdout = BufReader::new(stdout);
        // Drain stderr so a chatty sidecar cannot fill its pipe and block.
        if let Some(err) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    warn!("asr sidecar: {l}");
                }
            });
        }
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        loop {
            let mut buf = String::new();
            let read = tokio::time::timeout_at(deadline, stdout.read_line(&mut buf))
                .await
                .map_err(|_| "speech-to-text model did not load in time".to_string())?
                .map_err(|e| format!("sidecar stdout read failed: {e}"))?;
            if read == 0 {
                return Err("speech-to-text sidecar exited during startup".to_string());
            }
            let Ok(value) = serde_json::from_str::<Value>(buf.trim()) else {
                continue;
            };
            match value.get("type").and_then(|v| v.as_str()) {
                Some("ready") => {
                    let model = value
                        .get("model")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let load_ms = value.get("loadMs").and_then(|v| v.as_u64()).unwrap_or(0);
                    info!("asr sidecar ready: {model} in {load_ms}ms");
                    metrics::observe_ms("asr_load_ms", load_ms);
                    break;
                }
                Some("fatal") => {
                    let reason = value
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    return Err(format!("speech-to-text unavailable: {reason}"));
                }
                _ => continue,
            }
        }
        metrics::inc("asr_spawn");
        // Every live sidecar passes through here, so this is the one place
        // that wakes the parked reaper.
        self.spawned.notify_one();
        Ok(Sidecar {
            child,
            stdin,
            stdout,
        })
    }

    /// Write the embedded script next to the model, but only when the content
    /// differs, so a running sidecar's file is not rewritten under it on every
    /// spawn and an operator can see which version is live.
    fn materialize_script(&self) -> Result<PathBuf, String> {
        let dir = self.cfg.state_dir.join("asr");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let path = dir.join("asr-server.py");
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if current != SIDECAR_SRC {
            std::fs::write(&path, SIDECAR_SRC)
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        }
        Ok(path)
    }

    /// Reap the sidecar once dictation has been idle, giving back ~0.73 GiB.
    pub fn start_reaper(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            reap_idle(
                &me.spawned,
                &me.last_used,
                &me.sidecar,
                |mut sidecar, idle| {
                    let _ = sidecar.child.start_kill();
                    metrics::inc("asr_reaped_idle");
                    info!("asr sidecar reaped after {}s idle", idle.as_secs());
                },
            )
            .await;
        });
    }

    pub async fn shutdown(&self) {
        let mut guard = self.sidecar.lock().await;
        if let Some(mut sidecar) = guard.take() {
            let _ = sidecar.child.start_kill();
        }
    }
}

/// Hand the sidecar in `slot` to `reap` once dictation has been idle for
/// `IDLE_TIMEOUT`.
///
/// This used to wake every 30 s for the daemon's whole life, sidecar or not,
/// so a phone that never dictated still woke twice a minute and could not
/// sleep. Now it parks on `spawned` while there is no sidecar and otherwise
/// sleeps exactly until `last_used + IDLE_TIMEOUT` (which also reaps on time
/// rather than up to one tick late). `notify_one` keeps a permit, so a spawn
/// racing a reap is never missed; at worst it costs one spare check.
async fn reap_idle<T>(
    spawned: &Notify,
    last_used: &Mutex<Instant>,
    slot: &AsyncMutex<Option<T>>,
    mut reap: impl FnMut(T, Duration),
) {
    let last = || *last_used.lock().unwrap_or_else(|p| p.into_inner());
    loop {
        spawned.notified().await;
        loop {
            tokio::time::sleep_until(last() + IDLE_TIMEOUT).await;
            if last().elapsed() < IDLE_TIMEOUT {
                continue;
            }
            let mut guard = slot.lock().await;
            // Re-check under the lock: a request or warm-up may have run
            // while this task waited for it.
            let idle = last().elapsed();
            if idle < IDLE_TIMEOUT {
                continue;
            }
            // Taken here, or already gone (shutdown): either way there is no
            // sidecar left, so park until the next spawn.
            if let Some(sidecar) = guard.take() {
                reap(sidecar, idle);
            }
            break;
        }
    }
}

/// Temp files for one request, deleted on drop so a failure path cannot leak
/// audio into the state dir.
struct Scratch {
    input: PathBuf,
    wav: PathBuf,
}

impl Scratch {
    fn new(state_dir: &Path, mime: &str, audio: &[u8]) -> Result<Self, String> {
        let dir = state_dir.join("asr").join("tmp");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let input = dir.join(format!("rec-{stamp}-in.{}", ext_for(mime)));
        // INVARIANT: the decoded output must never collide with the input.
        // `ext_for` maps audio/wav to "wav", so without the `-in`/`-out` split
        // both paths became `rec-{stamp}.wav` and ffmpeg was asked to read and
        // write one file, failing every wav upload with the opaque
        // "Error opening output files: Invalid argument".
        let wav = dir.join(format!("rec-{stamp}-out.wav"));
        std::fs::write(&input, audio).map_err(|e| format!("cannot buffer the upload: {e}"))?;
        Ok(Self { input, wav })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.input);
        let _ = std::fs::remove_file(&self.wav);
    }
}

/// ffmpeg sniffs the container, so the extension is a hint only — but a wrong
/// one makes its error messages misleading, and phones differ: iOS Safari
/// records mp4/aac, Chrome records webm/opus.
fn ext_for(mime: &str) -> &'static str {
    let mime = mime.to_ascii_lowercase();
    if mime.contains("webm") {
        "webm"
    } else if mime.contains("ogg") || mime.contains("opus") {
        "ogg"
    } else if mime.contains("mp4") || mime.contains("m4a") || mime.contains("aac") {
        "m4a"
    } else if mime.contains("wav") || mime.contains("pcm") {
        "wav"
    } else if mime.contains("mpeg") || mime.contains("mp3") {
        "mp3"
    } else {
        "bin"
    }
}

fn which_ffmpeg() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("OMP_PULSE_FFMPEG") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|d| d.join("ffmpeg"))
        .find(|p| p.is_file())
}

/// The two models this installer knows about, both exported for sherpa-onnx by
/// the k2-fsa project. English-only is the default: it is the more accurate of
/// the two on English (5.91% vs 6.34% average WER on the Open ASR Leaderboard
/// English sets) and it cannot mis-detect the language of a three-second clip,
/// which is the realistic failure mode for a dictation button.
///
/// Both are NVIDIA Parakeet 0.6B under CC-BY-4.0: attribution is required if you
/// redistribute the weights. This installer downloads them at the user's request
/// rather than bundling them, so the daemon itself carries no CC-BY material.
const MODEL_EN: &str = "sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming";
const MODEL_MULTI: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const MODEL_BASE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

/// `omp-pulse asr install`: build the sidecar environment and fetch the model.
///
/// Deliberately shells out to the tools a developer machine already has rather
/// than reimplementing a package manager or a tar reader in the daemon. Every
/// step is idempotent, so re-running after a partial failure resumes instead of
/// starting over.
pub fn install(cfg: &SharedConfig, multilingual: bool) -> Result<(), String> {
    let dir = cfg.state_dir.join("asr");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let model = if multilingual { MODEL_MULTI } else { MODEL_EN };

    if which_ffmpeg().is_none() {
        return Err(
            "ffmpeg is required to decode the phone's audio. Install it and re-run.".to_string(),
        );
    }

    let venv = dir.join("venv");
    let python = venv.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    });
    // `uv` creates environments in seconds but WITHOUT pip, so the two paths need
    // different install commands: `uv pip install --python <venv>` targets the
    // environment from outside it, while a stdlib venv has its own pip inside.
    let uv = run("uv", &["--version"]).is_ok();
    if !python.is_file() {
        println!("creating the sidecar environment in {}", venv.display());
        let made = if uv {
            run("uv", &["venv", venv.to_string_lossy().as_ref()]).is_ok()
        } else {
            run("python3", &["-m", "venv", venv.to_string_lossy().as_ref()]).is_ok()
        };
        if !made {
            return Err(
                "could not create a python environment: install `uv` or python3".to_string(),
            );
        }
    }
    println!("installing sherpa-onnx and numpy");
    if uv {
        run(
            "uv",
            &[
                "pip",
                "install",
                "--quiet",
                "--python",
                python.to_string_lossy().as_ref(),
                "sherpa-onnx",
                "numpy",
            ],
        )
        .map_err(|e| format!("uv pip install failed: {e}"))?;
    } else {
        run(
            python.to_string_lossy().as_ref(),
            &["-m", "pip", "install", "--quiet", "sherpa-onnx", "numpy"],
        )
        .map_err(|e| format!("pip install failed: {e}"))?;
    }

    let model_dir = dir.join(model);
    if model_dir.join("encoder.int8.onnx").is_file() {
        println!("model already present: {}", model_dir.display());
    } else {
        let url = format!("{MODEL_BASE_URL}/{model}.tar.bz2");
        let tarball = dir.join(format!("{model}.tar.bz2"));
        println!("downloading {model} (about 470 MB)");
        run(
            "curl",
            &[
                "-fL",
                "--retry",
                "3",
                "-o",
                tarball.to_string_lossy().as_ref(),
                &url,
            ],
        )
        .map_err(|e| format!("download failed: {e}"))?;
        println!("extracting");
        run(
            "tar",
            &[
                "xjf",
                tarball.to_string_lossy().as_ref(),
                "-C",
                dir.to_string_lossy().as_ref(),
            ],
        )
        .map_err(|e| format!("extract failed: {e}"))?;
        let _ = std::fs::remove_file(&tarball);
    }
    if !model_dir.join("encoder.int8.onnx").is_file() {
        return Err(format!(
            "install finished but {} has no encoder.int8.onnx",
            model_dir.display()
        ));
    }
    println!(
        "dictation ready: {model}\n  model weights are CC-BY-4.0 (NVIDIA Parakeet); attribution is required if you redistribute them\n  restart the daemon to pick it up"
    );
    Ok(())
}

/// Human-readable readiness, for `omp-pulse asr status`.
pub fn status_line(cfg: &SharedConfig) -> String {
    let asr = Asr::new(cfg.clone(), None);
    match asr.availability() {
        Availability::Ready { model } => format!(
            "READY  model {model}\n       python {}\n       threads {}",
            cfg.asr_python
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            cfg.asr_threads
        ),
        Availability::Missing { reason } => format!("NOT READY  {reason}"),
    }
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{program} failed to start: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(err.lines().last().unwrap_or("unknown error").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_inference_retires_only_its_owned_sidecar() {
        async fn stand_in() -> Sidecar {
            let mut child = tokio::process::Command::new("cat")
                // Configuration tests temporarily clear the process-wide PATH.
                .env("PATH", env!("PATH"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .expect("stand-in sidecar");
            Sidecar {
                stdin: child.stdin.take().expect("stdin"),
                stdout: BufReader::new(child.stdout.take().expect("stdout")),
                child,
            }
        }
        let slot = Arc::new(AsyncMutex::new(Some(stand_in().await)));
        let (started, ready) = tokio::sync::oneshot::channel();
        let inference = tokio::spawn({
            let slot = Arc::clone(&slot);
            async move {
                let _request = ActiveSidecar {
                    slot: slot.lock().await,
                    completed: false,
                };
                let _ = started.send(());
                std::future::pending::<()>().await;
            }
        });
        ready.await.expect("inference owns its sidecar");
        inference.abort();
        let _ = inference.await;
        assert!(
            slot.lock().await.is_none(),
            "cancelled inference is not left running"
        );

        *slot.lock().await = Some(stand_in().await);
        let mut completed = ActiveSidecar {
            slot: slot.lock().await,
            completed: false,
        };
        completed.completed = true;
        drop(completed);
        assert!(
            slot.lock().await.is_some(),
            "completed inference stays warm"
        );
    }

    /// The reaper sleeps with no sidecar, wakes on a spawn, waits out the idle
    /// timeout from the LAST use (activity pushes it back), reaps, and parks
    /// again until the next spawn.
    #[tokio::test(start_paused = true)]
    async fn reaper_parks_without_a_sidecar_and_reaps_after_the_last_use() {
        struct Fake {
            spawned: Notify,
            last_used: Mutex<Instant>,
            slot: AsyncMutex<Option<u32>>,
            reaped: Mutex<Vec<u32>>,
        }
        let fake = Arc::new(Fake {
            spawned: Notify::new(),
            last_used: Mutex::new(Instant::now()),
            slot: AsyncMutex::new(None),
            reaped: Mutex::new(Vec::new()),
        });
        let touch = |fake: &Fake| {
            *fake.last_used.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now()
        };
        let reaped = |fake: &Fake| {
            fake.reaped
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
        };
        let task = tokio::spawn({
            let fake = Arc::clone(&fake);
            async move {
                reap_idle(&fake.spawned, &fake.last_used, &fake.slot, |id, _| {
                    fake.reaped
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push(id);
                })
                .await;
            }
        });
        let second = Duration::from_secs(1);

        // A spawn wakes it; it reaps only once the timeout passes the last use.
        *fake.slot.lock().await = Some(1);
        touch(&fake);
        fake.spawned.notify_one();
        tokio::time::sleep(IDLE_TIMEOUT - second).await;
        touch(&fake);
        tokio::time::sleep(IDLE_TIMEOUT - second).await;
        assert!(reaped(&fake).is_empty(), "activity defers the reap");
        tokio::time::sleep(second * 2).await;
        assert_eq!(reaped(&fake), vec![1]);
        assert!(fake.slot.lock().await.is_none());

        // No sidecar: nothing to do however long it waits, and the next spawn
        // is still reaped.
        tokio::time::sleep(Duration::from_secs(3600)).await;
        *fake.slot.lock().await = Some(2);
        touch(&fake);
        fake.spawned.notify_one();
        tokio::time::sleep(IDLE_TIMEOUT + second).await;
        assert_eq!(reaped(&fake), vec![1, 2]);
        task.abort();
    }
    /// Every upload mime must yield distinct ffmpeg input and output paths.
    /// `audio/wav` once mapped both to `rec-{stamp}.wav`, so ffmpeg was handed
    /// the same file to read and write and every wav upload failed with
    /// "Error opening output files: Invalid argument".
    #[test]
    fn scratch_input_never_collides_with_decoded_output() {
        let dir = std::env::temp_dir().join(format!("omp-pulse-asr-{}", std::process::id()));
        for mime in [
            "audio/wav",
            "audio/x-wav",
            "audio/wave",
            "audio/pcm",
            "audio/webm;codecs=opus",
            "audio/mp4",
            "audio/ogg",
            "audio/mpeg",
            "application/octet-stream",
        ] {
            let scratch = Scratch::new(&dir, mime, b"not real audio").expect("scratch");
            assert_ne!(
                scratch.input, scratch.wav,
                "input and output collided for mime {mime}"
            );
            assert_eq!(
                scratch.wav.extension().and_then(|e| e.to_str()),
                Some("wav"),
                "decoded output must stay a .wav for mime {mime}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
