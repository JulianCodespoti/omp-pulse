//! Durable command receipts and request-ID deduplication.
//!
//! The ledger is deliberately boring: one versioned JSON file, guarded by a
//! mutex, written with fsync + same-directory rename. A command is inserted
//! before its transport is touched, so a lost HTTP response can always be
//! reconciled without replaying an ambiguous handoff.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const FILE_NAME: &str = "commands.json";
/// Receipts kept in the hot `commands.json`. Every submit and state change
/// rewrites (and fsyncs) the whole file under the ledger mutex, so its size is
/// paid several times per prompt: at the old 4096 cap it would reach ~1.9 MB
/// (measured ~455 B per receipt). Older settled receipts move to the per-id
/// archive, which still answers deduplication and `GET /api/receipts/{id}`.
pub(crate) const MAX_RECEIPTS: usize = 256;

/// Older daemons gave up watching an accepted turn after ten minutes and left
/// it `uncertain` with `child_lifecycle_timeout`. The child had acknowledged
/// the prompt, so the command was delivered; only its outcome went unrecorded.
/// Uncertain work counts against the Android outbox cap forever (it is never
/// replayed), so such receipts blocked new sends. They settle as `forwarded`:
/// delivered, outcome not tracked, nothing resent.
pub(crate) const ACCEPTED_OUTCOME_UNTRACKED: &str = "agent_accepted_outcome_untracked";

/// The receipt of a send that was waiting for a free agent when the daemon
/// restarted. The code stays `agents_busy`.
pub(crate) const HELD_SEND_RESTARTED: &str =
    "The app restarted before an agent was free, so this was not sent. Send it again.";

fn settle_accepted_timeout(receipt: &mut CommandReceipt) -> bool {
    if !matches!(receipt.state, ReceiptState::Uncertain)
        || receipt.code.as_deref() != Some("child_lifecycle_timeout")
    {
        return false;
    }
    receipt.state = ReceiptState::Forwarded;
    receipt.code = Some(ACCEPTED_OUTCOME_UNTRACKED.into());
    // Not an error: the Send details sheet words this code itself.
    receipt.error = None;
    true
}

/// Receipt codes for a prompt the agent RECEIVED whose turn then ended
/// badly. These settle `completed`, never `failed`: `failed` means the
/// prompt never reached the agent, and resending a delivered prompt would
/// run it twice.
pub(crate) const AGENT_ABORTED: &str = "agent_aborted";
pub(crate) const AGENT_FAILED: &str = "agent_failed";
pub(crate) const AGENT_REFUSED: &str = "agent_refused";
pub(crate) const AGENT_INTERRUPTED: &str = "agent_interrupted";

/// The code for a received prompt's turn that ended with `error`.
pub(crate) fn turn_error_code(error: &str) -> &'static str {
    if error.starts_with("Refusal") || error.starts_with("Content flagged by safety filters") {
        AGENT_REFUSED
    } else if error.contains("Previous OMP process exited") {
        AGENT_INTERRUPTED
    } else {
        AGENT_FAILED
    }
}

/// Older daemons recorded a delivered prompt whose turn was stopped or
/// errored as `failed`. The child had accepted those prompts (both codes are
/// only written after acceptance), so they settle `completed` with the turn's
/// outcome as the code.
fn settle_delivered_turn_failure(receipt: &mut CommandReceipt) -> bool {
    if !matches!(receipt.state, ReceiptState::Failed) {
        return false;
    }
    let code = match receipt.code.as_deref() {
        Some(AGENT_ABORTED) => AGENT_ABORTED,
        Some(AGENT_FAILED) => turn_error_code(receipt.error.as_deref().unwrap_or("")),
        _ => return false,
    };
    receipt.state = ReceiptState::Completed;
    receipt.code = Some(code.into());
    true
}

/// Every rewrite an older ledger record needs; true when it changed.
fn migrate_legacy(receipt: &mut CommandReceipt) -> bool {
    settle_accepted_timeout(receipt) || settle_delivered_turn_failure(receipt)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptState {
    Accepted,
    Dispatching,
    /// Delivered without a tracked outcome: written to the desktop transport,
    /// or accepted by a child whose turn ended unobserved
    /// (`ACCEPTED_OUTCOME_UNTRACKED`). Never an agent completion.
    Forwarded,
    Received,
    Running,
    Completed,
    Failed,
    Uncertain,
}

impl ReceiptState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Dispatching => "dispatching",
            Self::Forwarded => "forwarded",
            Self::Received => "received",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Uncertain => "uncertain",
        }
    }

    fn terminal(&self) -> bool {
        matches!(self, Self::Forwarded | Self::Completed | Self::Failed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceipt {
    pub command_id: String,
    pub session_path: String,
    pub state: ReceiptState,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredReceipt {
    receipt: CommandReceipt,
    fingerprint: String,
    /// `transcript_witness` of the prompt: session, text and image COUNT.
    /// The transcript keeps images re-encoded, so only this (not the full
    /// fingerprint) can find a photo message there. Absent on older records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    witness: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DiskStore {
    version: u32,
    receipts: HashMap<String, StoredReceipt>,
}

#[derive(Serialize)]
struct DiskSnapshot<'a> {
    version: u32,
    receipts: &'a HashMap<String, StoredReceipt>,
}

pub(crate) struct ProofRow {
    pub command_id: String,
    pub session_path: String,
    pub created_at: u64,
    pub uncertain: bool,
    pub fingerprint: String,
    pub witness: Option<String>,
}

struct LedgerInner {
    receipts: HashMap<String, StoredReceipt>,
}

pub struct CommandLedger {
    path: PathBuf,
    archive_dir: PathBuf,
    inner: Mutex<LedgerInner>,
    /// Fired whenever a hot receipt becomes `Uncertain`, the only state the
    /// transcript reconciler (`receipt_proof::run`) can settle, so it parks
    /// instead of polling a ledger with nothing to settle.
    uncertain_wake: tokio::sync::Notify,
}

pub enum Submission {
    New(CommandReceipt),
    Existing(CommandReceipt),
}

#[derive(Debug)]
pub enum SubmitError {
    Persistence(String),
    Conflict(CommandReceipt),
    Capacity,
}

impl std::fmt::Display for SubmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Persistence(e) => write!(f, "command ledger persistence failed: {e}"),
            Self::Conflict(_) => f.write_str("commandId already used for a different request"),
            Self::Capacity => f.write_str(
                "command receipt ledger is full of active work; no saved command was removed",
            ),
        }
    }
}

impl CommandLedger {
    /// Open the durable ledger below `state_dir`. Interrupted non-terminal
    /// work is marked uncertain before the constructor returns; it is never
    /// replayed automatically.
    pub fn open(state_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(state_dir)
            .map_err(|e| format!("create command ledger directory: {e}"))?;
        let path = state_dir.join(FILE_NAME);
        let archive_dir = state_dir.join("command-receipts");
        fs::create_dir_all(&archive_dir).map_err(|e| format!("create receipt archive: {e}"))?;
        let mut receipts = if path.exists() {
            let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
            let disk: DiskStore = serde_json::from_slice(&bytes)
                .map_err(|e| format!("parse {}: {e}", path.display()))?;
            if disk.version != 1 {
                return Err(format!(
                    "unsupported command ledger version {}",
                    disk.version
                ));
            }
            disk.receipts
        } else {
            HashMap::new()
        };
        let now = now_ms();
        let mut changed = false;
        for item in receipts.values_mut() {
            if migrate_legacy(&mut item.receipt) {
                changed = true;
                continue;
            }
            // Only work that was IN FLIGHT when the process died is swept. A
            // receipt already marked uncertain was settled by whatever noticed
            // the ambiguity — a transport that never acknowledged, a child that
            // stopped reporting — and re-stamping it on every later restart
            // would reset its age forever and overwrite the reason it went
            // uncertain with a generic "interrupted_dispatch".
            if item.receipt.state.terminal()
                || matches!(item.receipt.state, ReceiptState::Uncertain)
            {
                continue;
            }
            item.receipt.updated_at = now;
            // Held for a free agent (`accepted` + `agents_busy`, see
            // http.rs `dispatch_child_prompt`): it provably never reached an
            // agent, so the outcome is certain, not ambiguous.
            if matches!(item.receipt.state, ReceiptState::Accepted)
                && item.receipt.code.as_deref() == Some(crate::omp::child::AGENTS_BUSY)
            {
                item.receipt.state = ReceiptState::Failed;
                item.receipt.error = Some(HELD_SEND_RESTARTED.into());
                changed = true;
                continue;
            }
            // The child acknowledged the prompt (`received`) or started its
            // turn (`running`): delivered, only the outcome was lost with the
            // daemon. Before that point the handoff itself is ambiguous.
            if matches!(
                item.receipt.state,
                ReceiptState::Received | ReceiptState::Running
            ) {
                item.receipt.state = ReceiptState::Forwarded;
                item.receipt.code = Some(ACCEPTED_OUTCOME_UNTRACKED.into());
                item.receipt.error = None;
            } else {
                item.receipt.state = ReceiptState::Uncertain;
                item.receipt.code = Some("interrupted_dispatch".into());
                item.receipt.error =
                    Some("daemon restarted while command handoff was ambiguous".into());
            }
            changed = true;
        }
        // Receipts swept to `Uncertain` above need no wake: the reconciler's
        // startup pass sees them.
        let ledger = Self {
            path,
            archive_dir,
            inner: Mutex::new(LedgerInner { receipts }),
            uncertain_wake: tokio::sync::Notify::new(),
        };
        // A ledger written under a larger cap is trimmed once here; submit
        // then keeps it at the cap one eviction at a time.
        changed |= ledger.archive_oldest_settled(MAX_RECEIPTS)? > 0;
        if changed {
            ledger.persist_locked().map_err(|e| e.to_string())?;
        }
        Ok(ledger)
    }

    /// Archive and drop the oldest settled receipts until at most `keep`
    /// remain. Each one is archived BEFORE it leaves the hot map, so either
    /// crash order keeps its id deduplicated. Active work is never moved.
    fn archive_oldest_settled(&self, keep: usize) -> Result<usize, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let excess = inner.receipts.len().saturating_sub(keep);
        if excess == 0 {
            return Ok(0);
        }
        let mut settled: Vec<(u64, String)> = inner
            .receipts
            .iter()
            .filter(|(_, r)| {
                r.receipt.state.terminal() || matches!(r.receipt.state, ReceiptState::Uncertain)
            })
            .map(|(id, r)| (r.receipt.updated_at, id.clone()))
            .collect();
        settled.sort_unstable();
        let mut moved = 0;
        for (_, id) in settled.into_iter().take(excess) {
            if let Some(stored) = inner.receipts.get(&id) {
                self.persist_archived(stored)?;
                inner.receipts.remove(&id);
                moved += 1;
            }
        }
        Ok(moved)
    }

    pub fn fingerprint(session_path: &str, text: &str, images: &[serde_json::Value]) -> String {
        // Length-delimited fields are unambiguous without copying potentially
        // tens of megabytes of image data into another JSON tree and buffer.
        let mut hash = Sha256::new();
        hash.update(b"omp-pulse-command-v1");
        for field in [session_path, text] {
            hash.update((field.len() as u64).to_le_bytes());
            hash.update(field.as_bytes());
        }
        hash.update((images.len() as u64).to_le_bytes());
        for image in images {
            for key in ["mimeType", "data"] {
                let field = image
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                hash.update((field.len() as u64).to_le_bytes());
                hash.update(field.as_bytes());
            }
        }
        URL_SAFE_NO_PAD.encode(hash.finalize())
    }

    /// What the session transcript can prove about a prompt: its session,
    /// text and number of images. See `StoredReceipt::witness`.
    pub fn transcript_witness(session_path: &str, text: &str, image_count: usize) -> String {
        let mut hash = Sha256::new();
        hash.update(b"omp-pulse-transcript-v1");
        for field in [session_path, text] {
            hash.update((field.len() as u64).to_le_bytes());
            hash.update(field.as_bytes());
        }
        hash.update((image_count as u64).to_le_bytes());
        URL_SAFE_NO_PAD.encode(hash.finalize())
    }

    pub fn submit(
        &self,
        command_id: &str,
        session_path: &str,
        fingerprint: &str,
    ) -> Result<Submission, SubmitError> {
        self.submit_witnessed(command_id, session_path, fingerprint, None)
    }

    pub fn submit_witnessed(
        &self,
        command_id: &str,
        session_path: &str,
        fingerprint: &str,
        witness: Option<&str>,
    ) -> Result<Submission, SubmitError> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = inner.receipts.get(command_id) {
            if existing.fingerprint != fingerprint {
                return Err(SubmitError::Conflict(existing.receipt.clone()));
            }
            return Ok(Submission::Existing(existing.receipt.clone()));
        }
        if let Some(existing) = self
            .read_archived(command_id)
            .map_err(SubmitError::Persistence)?
        {
            if existing.fingerprint != fingerprint {
                return Err(SubmitError::Conflict(existing.receipt));
            }
            return Ok(Submission::Existing(existing.receipt));
        }
        let now = now_ms();
        let receipt = CommandReceipt {
            command_id: command_id.into(),
            session_path: session_path.into(),
            state: ReceiptState::Accepted,
            created_at: now,
            updated_at: now,
            code: None,
            error: None,
        };
        if inner.receipts.len() >= MAX_RECEIPTS {
            let victim = inner
                .receipts
                .iter()
                .filter(|(_, r)| {
                    r.receipt.state.terminal() || matches!(r.receipt.state, ReceiptState::Uncertain)
                })
                .min_by_key(|(_, r)| r.receipt.updated_at)
                .map(|(id, r)| (id.clone(), r.clone()));
            let Some((id, old)) = victim else {
                return Err(SubmitError::Capacity);
            };
            // Evict the hot diagnostic record, NEVER the deduplication proof.
            // An old phone may still be reconciling a response it never saw.
            // Archive before replacing the main snapshot; either crash order
            // retains the old ID, so capacity can never permit a second send.
            self.persist_archived(&old)
                .map_err(SubmitError::Persistence)?;
            inner.receipts.remove(&id);
            inner.receipts.insert(
                command_id.into(),
                StoredReceipt {
                    receipt: receipt.clone(),
                    fingerprint: fingerprint.into(),
                    witness: witness.map(str::to_owned),
                },
            );
            if let Err(e) = self.persist_locked_inner(&inner) {
                inner.receipts.remove(command_id);
                inner.receipts.insert(id, old);
                return Err(SubmitError::Persistence(e));
            }
            return Ok(Submission::New(receipt));
        }
        inner.receipts.insert(
            command_id.into(),
            StoredReceipt {
                receipt: receipt.clone(),
                fingerprint: fingerprint.into(),
                witness: witness.map(str::to_owned),
            },
        );
        if let Err(e) = self.persist_locked_inner(&inner) {
            inner.receipts.remove(command_id);
            return Err(SubmitError::Persistence(e));
        }
        Ok(Submission::New(receipt))
    }

    pub fn update(
        &self,
        command_id: &str,
        state: ReceiptState,
        code: Option<&str>,
        error: Option<&str>,
    ) -> Result<CommandReceipt, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let Some(stored) = inner.receipts.get_mut(command_id) else {
            let mut archived = self
                .read_archived(command_id)?
                .ok_or_else(|| "command receipt not found".to_string())?;
            archived.receipt.state = state;
            archived.receipt.updated_at = now_ms();
            archived.receipt.code = code.map(str::to_owned);
            archived.receipt.error = error.map(str::to_owned);
            self.persist_archived(&archived)?;
            return Ok(archived.receipt);
        };
        // A repeated report (a second `agent_start` re-marking Running) changes
        // nothing durable: skip the whole-file rewrite and its two fsyncs.
        if stored.receipt.state.as_str() == state.as_str()
            && stored.receipt.code.as_deref() == code
            && stored.receipt.error.as_deref() == error
        {
            return Ok(stored.receipt.clone());
        }
        let old = stored.clone();
        stored.receipt.state = state;
        stored.receipt.updated_at = now_ms();
        stored.receipt.code = code.map(str::to_owned);
        stored.receipt.error = error.map(str::to_owned);
        let receipt = stored.receipt.clone();
        if let Err(e) = self.persist_locked_inner(&inner) {
            inner.receipts.insert(command_id.to_string(), old);
            return Err(e);
        }
        // Archived receipts are never reconciled (`proof_rows` is hot-only),
        // so only this path wakes the reconciler. `notify_one` keeps a permit
        // for a reconciler that is mid-pass.
        if matches!(receipt.state, ReceiptState::Uncertain) {
            self.uncertain_wake.notify_one();
        }
        Ok(receipt)
    }

    pub fn get(&self, command_id: &str) -> Result<Option<CommandReceipt>, String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(stored) = inner.receipts.get(command_id) {
            return Ok(Some(stored.receipt.clone()));
        }
        self.read_archived(command_id)
            .map(|stored| stored.map(|r| r.receipt))
    }

    pub fn for_session(&self, session_path: &str) -> Vec<CommandReceipt> {
        let mut out: Vec<_> = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .receipts
            .values()
            .filter(|r| r.receipt.session_path == session_path)
            .map(|r| r.receipt.clone())
            .collect();
        out.sort_by_key(|r| r.created_at);
        out
    }

    /// Every hot receipt, for matching against session transcripts
    /// (`receipt_proof`). Settled ones take part too: each transcript entry
    /// proves at most one command.
    pub(crate) fn proof_rows(&self) -> Vec<ProofRow> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner
            .receipts
            .values()
            .map(|r| ProofRow {
                command_id: r.receipt.command_id.clone(),
                session_path: r.receipt.session_path.clone(),
                created_at: r.receipt.created_at,
                uncertain: matches!(r.receipt.state, ReceiptState::Uncertain),
                fingerprint: r.fingerprint.clone(),
                witness: r.witness.clone(),
            })
            .collect()
    }

    /// Whether any hot receipt is `Uncertain`, i.e. whether the transcript
    /// reconciler has anything left to settle.
    pub(crate) fn has_uncertain(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .receipts
            .values()
            .any(|r| matches!(r.receipt.state, ReceiptState::Uncertain))
    }

    /// Resolves at the next transition of a hot receipt into `Uncertain`
    /// (or at once, for one that happened since the last wait).
    pub(crate) async fn uncertain_added(&self) {
        self.uncertain_wake.notified().await;
    }

    /// Settle uncertain receipts whose prompt was found in the transcript:
    /// delivered, outcome not recorded. Anything no longer uncertain is left
    /// alone. One write for the batch.
    pub(crate) fn settle_delivered(&self, command_ids: &[String]) -> Result<usize, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let now = now_ms();
        let mut settled = 0;
        for id in command_ids {
            let Some(stored) = inner.receipts.get_mut(id) else {
                continue;
            };
            if !matches!(stored.receipt.state, ReceiptState::Uncertain) {
                continue;
            }
            stored.receipt.state = ReceiptState::Forwarded;
            stored.receipt.code = Some(ACCEPTED_OUTCOME_UNTRACKED.into());
            stored.receipt.error = None;
            stored.receipt.updated_at = now;
            settled += 1;
        }
        if settled > 0 {
            self.persist_locked_inner(&inner)?;
        }
        Ok(settled)
    }

    fn persist_locked(&self) -> Result<(), String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        self.persist_locked_inner(&inner)
    }

    fn persist_locked_inner(&self, inner: &LedgerInner) -> Result<(), String> {
        atomic_write(
            &self.path,
            &DiskSnapshot {
                version: 1,
                receipts: &inner.receipts,
            },
        )
    }

    fn archive_path(&self, command_id: &str) -> PathBuf {
        self.archive_dir.join(format!(
            "{}.json",
            URL_SAFE_NO_PAD.encode(Sha256::digest(command_id.as_bytes()))
        ))
    }

    fn read_archived(&self, command_id: &str) -> Result<Option<StoredReceipt>, String> {
        let path = self.archive_path(command_id);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("read archived receipt: {error}")),
        };
        let stored: StoredReceipt = serde_json::from_slice(&bytes)
            .map_err(|error| format!("read archived receipt: {error}"))?;
        if stored.receipt.command_id != command_id {
            return Err("archived receipt identity mismatch".into());
        }
        let mut stored = stored;
        migrate_legacy(&mut stored.receipt);
        Ok(Some(stored))
    }

    fn persist_archived(&self, stored: &StoredReceipt) -> Result<(), String> {
        atomic_write(&self.archive_path(&stored.receipt.command_id), stored)
    }
}

/// Durable write of one ledger file: temp file, fsync, rename, directory
/// fsync. Callers are mostly async tasks (the prompt route and each receipt
/// watcher, several transitions per prompt) and the daemon runs two runtime
/// workers, so two fsyncs on proot storage would stall every socket scheduled
/// on the caller's worker. `block_in_place` hands that worker's other tasks to
/// another thread while this one blocks. Unlike `spawn_blocking` it keeps the
/// call synchronous: the receipt is still durable before `submit`/`update`
/// return, and writes stay serialized under the ledger mutex in call order.
/// A current-thread runtime (unit tests) cannot hand work off; it blocks as
/// before.
fn atomic_write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(|| write_and_sync(path, value))
        }
        _ => write_and_sync(path, value),
    }
}

fn write_and_sync(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let data = serde_json::to_vec(value).map_err(|error| format!("serialize receipt: {error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("create receipt: {error}"))?;
        file.write_all(&data)
            .map_err(|error| format!("write receipt: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync receipt: {error}"))?;
        fs::rename(&temporary, path).map_err(|error| format!("replace receipt: {error}"))?;
        // The file's fsync does not make its renamed directory entry durable.
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| format!("sync receipt directory: {error}"))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_delivery_survives_restart_without_replay_or_execution_claim() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-forwarded-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let ledger = CommandLedger::open(&dir).unwrap();
        let fingerprint = CommandLedger::fingerprint("/session", "hello", &[]);
        ledger
            .submit("forwarded", "/session", &fingerprint)
            .unwrap();
        ledger
            .update("forwarded", ReceiptState::Forwarded, None, None)
            .unwrap();
        drop(ledger);
        let ledger = CommandLedger::open(&dir).unwrap();
        let Submission::Existing(receipt) = ledger
            .submit("forwarded", "/session", &fingerprint)
            .unwrap()
        else {
            panic!("forwarded command must never dispatch twice");
        };
        assert!(matches!(receipt.state, ReceiptState::Forwarded));
        assert!(receipt.error.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fingerprint_changes_with_images() {
        assert_ne!(
            CommandLedger::fingerprint("s", "x", &[]),
            CommandLedger::fingerprint("s", "x", &[serde_json::json!({"data":"a"})])
        );
    }

    #[test]
    fn accepted_turn_timeout_settles_as_delivered_on_restart_and_archive_read() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-accepted-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let ledger = CommandLedger::open(&dir).unwrap();
        for id in ["long", "ambiguous"] {
            let fp = CommandLedger::fingerprint("/s.jsonl", id, &[]);
            ledger.submit(id, "/s.jsonl", &fp).unwrap();
        }
        ledger
            .update(
                "long",
                ReceiptState::Uncertain,
                Some("child_lifecycle_timeout"),
                Some("x"),
            )
            .unwrap();
        ledger
            .update(
                "ambiguous",
                ReceiptState::Uncertain,
                Some("interrupted_dispatch"),
                Some("y"),
            )
            .unwrap();
        // An archived copy written by an older daemon settles on read too.
        let mut archived = ledger
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .receipts["long"]
            .clone();
        archived.receipt.command_id = "archived".into();
        ledger.persist_archived(&archived).unwrap();
        drop(ledger);

        let reopened = CommandLedger::open(&dir).unwrap();
        for id in ["long", "archived"] {
            let receipt = reopened.get(id).unwrap().unwrap();
            assert!(matches!(receipt.state, ReceiptState::Forwarded), "{id}");
            assert_eq!(receipt.code.as_deref(), Some(ACCEPTED_OUTCOME_UNTRACKED));
            assert!(receipt.error.is_none());
        }
        // Without proof the agent received it, ambiguity stays.
        let ambiguous = reopened.get("ambiguous").unwrap().unwrap();
        assert!(matches!(ambiguous.state, ReceiptState::Uncertain));
        // Settled durably, and still deduplicated: never dispatched again.
        let on_disk = String::from_utf8(std::fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert!(on_disk.contains(ACCEPTED_OUTCOME_UNTRACKED));
        let fp = CommandLedger::fingerprint("/s.jsonl", "long", &[]);
        assert!(matches!(
            reopened.submit("long", "/s.jsonl", &fp),
            Ok(Submission::Existing(_))
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn delivered_turn_failures_settle_completed_on_restart_and_archive_read() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-turn-outcome-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let ledger = CommandLedger::open(&dir).unwrap();
        let cases: [(&str, &str, &str); 5] = [
            ("stopped", AGENT_ABORTED, "The turn was stopped."),
            ("errored", AGENT_FAILED, "socket closed"),
            ("refused", AGENT_FAILED, "Refusal (cyber): no"),
            (
                "exited",
                AGENT_FAILED,
                "Previous OMP process exited before completing the turn",
            ),
            ("rejected", "agent_rejected", "Agent is already processing."),
        ];
        for (id, code, error) in cases {
            let fp = CommandLedger::fingerprint("/s.jsonl", id, &[]);
            ledger.submit(id, "/s.jsonl", &fp).unwrap();
            ledger
                .update(id, ReceiptState::Failed, Some(code), Some(error))
                .unwrap();
        }
        let mut archived = ledger
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .receipts["refused"]
            .clone();
        archived.receipt.command_id = "archived".into();
        ledger.persist_archived(&archived).unwrap();
        drop(ledger);

        let reopened = CommandLedger::open(&dir).unwrap();
        for (id, code) in [
            ("stopped", AGENT_ABORTED),
            ("errored", AGENT_FAILED),
            ("refused", AGENT_REFUSED),
            ("exited", AGENT_INTERRUPTED),
            ("archived", AGENT_REFUSED),
        ] {
            let receipt = reopened.get(id).unwrap().unwrap();
            assert!(matches!(receipt.state, ReceiptState::Completed), "{id}");
            assert_eq!(receipt.code.as_deref(), Some(code), "{id}");
            assert!(receipt.error.is_some(), "{id} keeps its detail");
        }
        // Never reached the agent: still failed.
        let rejected = reopened.get("rejected").unwrap().unwrap();
        assert!(matches!(rejected.state, ReceiptState::Failed));
        assert_eq!(rejected.code.as_deref(), Some("agent_rejected"));
        let on_disk = String::from_utf8(std::fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert!(on_disk.contains(AGENT_REFUSED));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restart_marks_dispatching_uncertain_and_preserves_dedup() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-ledger-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let ledger = CommandLedger::open(&dir).unwrap();
        let fp = CommandLedger::fingerprint("/session.jsonl", "hello", &[]);
        assert!(matches!(
            ledger.submit("c1", "/session.jsonl", &fp),
            Ok(Submission::New(_))
        ));
        ledger
            .update("c1", ReceiptState::Dispatching, None, None)
            .unwrap();
        drop(ledger);

        let reopened = CommandLedger::open(&dir).unwrap();
        let settled = reopened.get("c1").unwrap().unwrap();
        assert!(matches!(settled.state, ReceiptState::Uncertain));
        assert_eq!(settled.code.as_deref(), Some("interrupted_dispatch"));
        assert!(matches!(
            reopened.submit("c1", "/session.jsonl", &fp),
            Ok(Submission::Existing(_))
        ));
        // The daemon keeps running: the transport gives up with a reason of its
        // own, and a second command is still in flight when it restarts again.
        let reason = reopened
            .update(
                "c1",
                ReceiptState::Uncertain,
                Some("desktop_transport_unacknowledged"),
                Some("socket closed before the desktop acknowledged"),
            )
            .unwrap();
        let fp2 = CommandLedger::fingerprint("/session.jsonl", "second", &[]);
        assert!(matches!(
            reopened.submit("c2", "/session.jsonl", &fp2),
            Ok(Submission::New(_))
        ));
        let in_flight = std::fs::read(dir.join(FILE_NAME)).unwrap();
        drop(reopened);

        let again = CommandLedger::open(&dir).unwrap();
        let after = again.get("c1").unwrap().unwrap();
        assert!(matches!(after.state, ReceiptState::Uncertain));
        assert_eq!(
            after.updated_at, reason.updated_at,
            "a settled uncertain receipt keeps its age across a restart"
        );
        assert_eq!(
            after.code, reason.code,
            "the reason it went uncertain survives"
        );
        assert_eq!(after.error, reason.error);
        // Truly in-flight work is still swept, and deduplication still holds.
        assert!(matches!(
            again.get("c2").unwrap().map(|r| r.state),
            Some(ReceiptState::Uncertain)
        ));
        assert!(matches!(
            again.submit("c1", "/session.jsonl", &fp),
            Ok(Submission::Existing(_))
        ));
        let settled = std::fs::read(dir.join(FILE_NAME)).unwrap();
        assert_ne!(settled, in_flight, "the in-flight sweep is persisted");
        drop(again);

        // Nothing is in flight now, so a third restart has nothing to sweep and
        // must leave the settled records — bytes included — exactly as they are.
        let third = CommandLedger::open(&dir).unwrap();
        assert_eq!(std::fs::read(dir.join(FILE_NAME)).unwrap(), settled);
        let unchanged = third.get("c1").unwrap().unwrap();
        assert_eq!(unchanged.updated_at, reason.updated_at);
        assert_eq!(unchanged.code, reason.code);
        assert_eq!(unchanged.error, reason.error);
        assert!(matches!(
            third.submit("c1", "/session.jsonl", &fp),
            Ok(Submission::Existing(_))
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restart_fails_a_send_held_for_a_free_agent_and_keeps_dedup() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-ledger-held-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let ledger = CommandLedger::open(&dir).unwrap();
        let fp = CommandLedger::fingerprint("/session.jsonl", "held", &[]);
        assert!(matches!(
            ledger.submit("held", "/session.jsonl", &fp),
            Ok(Submission::New(_))
        ));
        ledger
            .update(
                "held",
                ReceiptState::Accepted,
                Some(crate::omp::child::AGENTS_BUSY),
                Some("Waiting for a free agent."),
            )
            .unwrap();
        // A plain accepted receipt (handoff not yet started) stays ambiguous.
        let fp_plain = CommandLedger::fingerprint("/session.jsonl", "plain", &[]);
        assert!(matches!(
            ledger.submit("plain", "/session.jsonl", &fp_plain),
            Ok(Submission::New(_))
        ));
        drop(ledger);

        let reopened = CommandLedger::open(&dir).unwrap();
        let held = reopened.get("held").unwrap().unwrap();
        assert!(matches!(held.state, ReceiptState::Failed));
        assert_eq!(held.code.as_deref(), Some(crate::omp::child::AGENTS_BUSY));
        assert_eq!(held.error.as_deref(), Some(HELD_SEND_RESTARTED));
        let plain = reopened.get("plain").unwrap().unwrap();
        assert!(matches!(plain.state, ReceiptState::Uncertain));
        assert_eq!(plain.code.as_deref(), Some("interrupted_dispatch"));
        // Never dispatched again under the same id.
        assert!(matches!(
            reopened.submit("held", "/session.jsonl", &fp),
            Ok(Submission::Existing(_))
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn same_id_different_fingerprint_is_rejected() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-ledger-conflict-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let ledger = CommandLedger::open(&dir).unwrap();
        let first = CommandLedger::fingerprint("/s", "one", &[]);
        let second = CommandLedger::fingerprint("/s", "two", &[]);
        ledger.submit("c1", "/s", &first).unwrap();
        assert!(matches!(
            ledger.submit("c1", "/s", &second),
            Err(SubmitError::Conflict(_))
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn oversized_ledger_is_trimmed_to_the_hot_cap_without_losing_dedup() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-ledger-trim-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fp = CommandLedger::fingerprint("/s", "x", &[]);
        let total = MAX_RECEIPTS + 10;
        let mut receipts = HashMap::new();
        for i in 0..total {
            let id = format!("c{i}");
            // c0 is still running: active work stays hot however old it is.
            let state = if i == 0 {
                ReceiptState::Running
            } else {
                ReceiptState::Completed
            };
            receipts.insert(
                id.clone(),
                StoredReceipt {
                    receipt: CommandReceipt {
                        command_id: id,
                        session_path: "/s".into(),
                        state,
                        created_at: i as u64,
                        updated_at: i as u64,
                        code: None,
                        error: None,
                    },
                    fingerprint: fp.clone(),
                    witness: None,
                },
            );
        }
        let disk = serde_json::to_vec(&DiskStore {
            version: 1,
            receipts,
        })
        .unwrap();
        fs::write(dir.join(FILE_NAME), disk).unwrap();

        let ledger = CommandLedger::open(&dir).unwrap();
        assert_eq!(ledger.for_session("/s").len(), MAX_RECEIPTS);
        // The restart sweep settles the running c0 as delivered and stamps it
        // now, so it stays hot; the ten oldest completed (c1..c10) move out.
        let hot = ledger.for_session("/s");
        let c0 = hot.iter().find(|r| r.command_id == "c0").unwrap();
        assert!(
            matches!(c0.state, ReceiptState::Forwarded),
            "a started turn was delivered"
        );
        assert_eq!(c0.code.as_deref(), Some(ACCEPTED_OUTCOME_UNTRACKED));
        assert!(
            hot.iter()
                .all(|r| r.command_id != "c1" && r.command_id != "c10")
        );
        assert!(hot.iter().any(|r| r.command_id == "c11"));
        assert!(matches!(
            ledger.submit("c1", "/s", &fp),
            Ok(Submission::Existing(_))
        ));
        assert!(ledger.get("c5").unwrap().is_some());
        assert!(ledger.get(&format!("c{}", total - 1)).unwrap().is_some());
        drop(ledger);
        let stored: DiskStore =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored.receipts.len(), MAX_RECEIPTS);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn repeating_the_current_state_does_not_rewrite_the_ledger() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-ledger-noop-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let ledger = CommandLedger::open(&dir).unwrap();
        let fp = CommandLedger::fingerprint("/s", "x", &[]);
        ledger.submit("c1", "/s", &fp).unwrap();
        let first = ledger
            .update("c1", ReceiptState::Running, None, None)
            .unwrap();
        let bytes = fs::read(dir.join(FILE_NAME)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let again = ledger
            .update("c1", ReceiptState::Running, None, None)
            .unwrap();
        assert_eq!(again.updated_at, first.updated_at);
        assert_eq!(fs::read(dir.join(FILE_NAME)).unwrap(), bytes);
        let done = ledger
            .update("c1", ReceiptState::Completed, None, None)
            .unwrap();
        assert!(matches!(done.state, ReceiptState::Completed));
        let _ = fs::remove_dir_all(dir);
    }

    /// The daemon writes receipts from tasks on its multi-thread runtime,
    /// where the write steps off the worker; every transition must still be
    /// on disk when `update` returns, from a runtime task and from a
    /// blocking-pool thread alike, without panicking in either.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn runtime_writes_are_durable_when_update_returns() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-ledger-runtime-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let ledger = CommandLedger::open(&dir).unwrap();
        let fp = CommandLedger::fingerprint("/s", "x", &[]);
        ledger.submit("c1", "/s", &fp).unwrap();
        ledger
            .update("c1", ReceiptState::Running, None, None)
            .unwrap();
        let stored: DiskStore =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored.receipts["c1"].receipt.state.as_str(), "running");
        let ledger = std::sync::Arc::new(ledger);
        let off = std::sync::Arc::clone(&ledger);
        tokio::task::spawn_blocking(move || {
            off.update("c1", ReceiptState::Completed, None, None)
                .unwrap();
        })
        .await
        .unwrap();
        let stored: DiskStore =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored.receipts["c1"].receipt.state.as_str(), "completed");
        let _ = fs::remove_dir_all(dir);
    }
}
