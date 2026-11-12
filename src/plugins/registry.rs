//! Plugin registry: finds plugin folders (directly in the plugins folder, or
//! linked through `<id>.path` files), derives each one's status from its
//! content hash and the stored on/off decision, and edits links and decisions.
//!
//! WHY every call re-reads the disk: a plugin is a folder the user edits, the
//! CLI changes links and decisions without a running daemon knowing, and the
//! catalog is tiny. Re-reading means an edited script is `needs_review` on the
//! very next request, with no cache to invalidate and no signal to send.
//!
//! The security-relevant rule lives here: a plugin runs only while its decision
//! says `enabled` AND the approved hash equals the hash of the files on disk
//! now, so changing a plugin after approving it switches it off until it is
//! reviewed again.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use serde_json::{Map, Value};

use super::manifest::{self, ActionSpec, Loaded, OptionSpec, SourceSpec};

/// Where plugins and their decisions live; see [`crate::paths::Paths`].
#[derive(Debug, Clone)]
pub struct PluginDirs {
    pub plugins_dir: PathBuf,
    pub state_file: PathBuf,
    /// The omp the daemon itself runs. A source or action whose program is
    /// exactly `omp` runs this instead: a service's PATH often lacks the user's omp.
    pub omp_bin: Option<PathBuf>,
}

impl PluginDirs {
    pub fn from_paths(paths: &crate::paths::Paths) -> Self {
        PluginDirs {
            plugins_dir: paths.plugins_dir.clone(),
            state_file: paths.plugins_state_file.clone(),
            omp_bin: None,
        }
    }

    pub fn with_omp_bin(mut self, omp_bin: Option<PathBuf>) -> Self {
        self.omp_bin = omp_bin;
        self
    }
}

/// `enabled` | `disabled` | `needs_review` | `invalid` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginStatus {
    Enabled,
    Disabled,
    NeedsReview,
    Invalid,
}

/// A declared host command, as shown for review and used to run it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    pub command: Vec<String>,
    pub interval_s: u64,
    pub timeout_s: u64,
}

fn source_info(spec: &SourceSpec) -> SourceInfo {
    SourceInfo {
        id: spec.id.clone(),
        command: spec.command.clone(),
        interval_s: spec.interval_s,
        timeout_s: spec.timeout_s,
    }
}

/// A per-plugin setting, as shown in Settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionInfo {
    pub id: String,
    pub label: String,
    /// `bool` | `choice` | `text`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Empty unless `kind` is `choice`.
    pub choices: Vec<String>,
    /// A boolean or a string, matching `kind`.
    pub default: Value,
}

fn option_info(spec: &OptionSpec) -> OptionInfo {
    OptionInfo {
        id: spec.id.clone(),
        label: spec.label.clone(),
        kind: spec.kind.as_str().to_owned(),
        choices: spec.choices.clone(),
        default: spec.default.clone(),
    }
}

/// A host command the owner can start with a tap, as shown for review.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionInfo {
    pub id: String,
    pub label: String,
    pub command: Vec<String>,
    /// Present exactly when `command` has `{arg}`; matched against the whole argument.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arg_pattern: Option<String>,
    pub timeout_s: u64,
}

fn action_info(spec: &ActionSpec) -> ActionInfo {
    ActionInfo {
        id: spec.id.clone(),
        label: spec.label.clone(),
        command: spec.command.clone(),
        arg_pattern: spec.arg_pattern.clone(),
        timeout_s: spec.timeout_s,
    }
}

/// One catalog entry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// For an invalid plugin whose id cannot be read: the entry name without `.path`.
    pub id: String,
    /// Falls back to the id when invalid.
    pub name: String,
    /// Empty when invalid.
    pub version: String,
    /// Empty when absent.
    pub description: String,
    pub status: PluginStatus,
    /// Empty when invalid.
    pub hash: String,
    pub slots: Vec<String>,
    /// What a tap on this plugin's views may do; empty when invalid.
    pub permissions: Vec<String>,
    /// Tool-name claim patterns (`transcript.tool`); empty when invalid.
    pub tools: Vec<String>,
    /// Custom-message claim patterns (`transcript.message`); empty when invalid.
    pub messages: Vec<String>,
    pub sources: Vec<SourceInfo>,
    pub options: Vec<OptionInfo>,
    /// Effective value per declared option: the stored one while it is still
    /// valid for the current schema, else the default. Empty when invalid.
    pub option_values: Map<String, Value>,
    pub actions: Vec<ActionInfo>,
    pub linked: bool,
    /// True when `status` is `NeedsReview` because a plugin that was approved
    /// has been edited since; false for a new plugin and for every other status.
    pub changed: bool,
    /// Files in the plugin folder that a declared command runs or reads,
    /// which the approval hash does not cover; one sentence each, shown in
    /// review. Empty when invalid.
    pub warnings: Vec<String>,
    /// Set only when `status` is `Invalid`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The plugin folder on this machine. Never sent to a client.
    #[serde(skip)]
    pub dir: PathBuf,
}

#[derive(Debug)]
pub enum PluginError {
    NotFound,
    SourceNotFound,
    NotEnabled,
    HashMismatch,
    ActionNotFound,
    ActionBusy,
    Invalid(String),
    Io(String),
}

impl PluginError {
    /// `plugin_not_found` | `source_not_found` | `plugin_not_enabled` |
    /// `plugin_hash_mismatch` | `action_not_found` | `plugin_action_busy` |
    /// `plugin_invalid` | `plugin_io`.
    pub fn code(&self) -> &'static str {
        match self {
            PluginError::NotFound => "plugin_not_found",
            PluginError::SourceNotFound => "source_not_found",
            PluginError::NotEnabled => "plugin_not_enabled",
            PluginError::HashMismatch => "plugin_hash_mismatch",
            PluginError::ActionNotFound => "action_not_found",
            PluginError::ActionBusy => "plugin_action_busy",
            PluginError::Invalid(_) => "plugin_invalid",
            PluginError::Io(_) => "plugin_io",
        }
    }
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PluginError::NotFound => f.write_str("plugin not found"),
            PluginError::SourceNotFound => f.write_str("source not found"),
            PluginError::NotEnabled => f.write_str("plugin is not enabled"),
            PluginError::HashMismatch => f.write_str(
                "plugin has changed since it was reviewed; review it again before turning it on",
            ),
            PluginError::ActionNotFound => f.write_str("action not found"),
            PluginError::ActionBusy => f.write_str("an action of this plugin is already running"),
            PluginError::Invalid(reason) | PluginError::Io(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for PluginError {}

// ---------------------------------------------------------------------------
// Decisions file
// ---------------------------------------------------------------------------

/// `plugins.json`. Unknown ids are carried through every rewrite, so a plugin
/// that is temporarily absent (an unplugged drive behind a link) keeps its decision.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Decisions {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    plugins: BTreeMap<String, Decision>,
}

/// What the owner decided about one plugin. `enabled` is absent until they
/// enable or disable it (setting an option alone is not a review decision), and
/// keys this version does not know are carried through rewrites in `extra`.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Decision {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approved_hash: Option<String>,
    /// Stored option values, including ids the plugin no longer declares: they
    /// are ignored when computing effective values but kept for a plugin that gets them back.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    options: Map<String, Value>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Serialises read-modify-write of the decisions file inside this process. It is
/// only ever held across synchronous code, never an `.await`.
static DECISIONS_WRITE: Mutex<()> = Mutex::new(());

/// A missing file is "no decisions"; anything else that stops us reading it is an error.
fn try_read_decisions(path: &Path) -> Result<Decisions, String> {
    // No path in these messages: they can travel to HTTP clients inside `PluginError::Io`.
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("the plugin state file is damaged ({e}); fix or delete it")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Decisions::default()),
        Err(e) => Err(format!("cannot read the plugin state file: {e}")),
    }
}

/// An exclusive advisory lock on a sidecar file next to the decisions file,
/// released when the returned file is dropped. The decisions file itself cannot
/// carry the lock: every write replaces it by rename. Blocks until it is free.
fn lock_decisions(state_file: &Path) -> Result<std::fs::File, String> {
    let parent = state_file
        .parent()
        .ok_or_else(|| "plugin state file has no parent folder".to_owned())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create the plugin state folder: {e}"))?;
    let name = state_file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(parent.join(format!(".{name}.lock")))
        .map_err(|e| format!("cannot open the plugin state lock: {e}"))?;
    file.lock()
        .map_err(|e| format!("cannot lock the plugin state: {e}"))?;
    Ok(file)
}

/// Reading is tolerant: a damaged file means "no decisions", which only ever
/// turns plugins OFF (`needs_review`), the safe direction.
fn read_decisions(path: &Path) -> Decisions {
    try_read_decisions(path).unwrap_or_default()
}

/// Write `bytes` to `path` through a temp file in the same folder and a rename,
/// so a reader never sees a half-written file. The temp name starts with a dot
/// so plugin discovery (which ignores dot-entries) never mistakes it for a link.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Messages here can reach HTTP clients through `PluginError::Io`, so they
    // name the operation and the OS error but never a path.
    let parent = path
        .parent()
        .ok_or_else(|| "plugin state file has no parent folder".to_owned())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("cannot create the folder: {e}"))?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let written = std::fs::File::create(&tmp)
        .and_then(|mut f| f.write_all(bytes).and_then(|()| f.sync_all()))
        .map_err(|e| format!("cannot write the temporary file: {e}"));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    // std::fs::rename replaces an existing file on Windows too.
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot replace the file: {e}")
    })
}

fn write_decisions(path: &Path, decisions: &mut Decisions) -> Result<(), String> {
    decisions.version = 1;
    let mut bytes = serde_json::to_vec_pretty(decisions)
        .map_err(|e| format!("cannot encode plugin state: {e}"))?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// One folder (direct or linked) found in the plugins folder, validated.
struct Entry {
    /// File name inside the plugins folder: the sort key.
    name: String,
    id: String,
    dir: PathBuf,
    linked: bool,
    loaded: Result<Loaded, String>,
}

/// A link file is a path and a newline; anything bigger is not a link.
const LINK_FILE_MAX_BYTES: u64 = 4096;

fn read_link_target(path: &Path) -> Result<PathBuf, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("cannot read link file: {e}"))?;
    let mut text = String::new();
    file.take(LINK_FILE_MAX_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("cannot read link file: {e}"))?;
    if text.len() as u64 > LINK_FILE_MAX_BYTES {
        return Err("link file is too large".to_owned());
    }
    let target = text.trim();
    if target.is_empty() {
        return Err("link file is empty".to_owned());
    }
    Ok(PathBuf::from(target))
}

fn entry_for(name: &str, path: &Path) -> Option<Entry> {
    if let Some(stem) = name.strip_suffix(".path").filter(|s| !s.is_empty())
        && path.is_file()
    {
        let target = match read_link_target(path) {
            Ok(target) => target,
            Err(reason) => {
                return Some(Entry {
                    name: name.to_owned(),
                    id: stem.to_owned(),
                    dir: path.to_path_buf(),
                    linked: true,
                    loaded: Err(reason),
                });
            }
        };
        let loaded = if !target.is_absolute() {
            Err("the link does not hold an absolute path".to_owned())
        } else if !target.is_dir() {
            Err("linked folder not found".to_owned())
        } else {
            manifest::load(&target)
        };
        let id = entry_id(&loaded, &target, stem);
        return Some(Entry {
            name: name.to_owned(),
            id,
            dir: target,
            linked: true,
            loaded,
        });
    }
    if path.is_dir() && path.join(manifest::MANIFEST_FILE).exists() {
        let loaded = manifest::load(path);
        let id = entry_id(&loaded, path, name);
        return Some(Entry {
            name: name.to_owned(),
            id,
            dir: path.to_path_buf(),
            linked: false,
            loaded,
        });
    }
    None
}

fn entry_id(loaded: &Result<Loaded, String>, dir: &Path, fallback: &str) -> String {
    match loaded {
        Ok(l) => l.id.clone(),
        Err(_) => manifest::lenient_id(dir).unwrap_or_else(|| fallback.to_owned()),
    }
}

/// Every plugin entry in name order, with later duplicates of an id marked invalid.
fn discover(plugins_dir: &Path) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(plugins_dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.') && !manifest::has_unsafe_chars(n))
        .collect();
    names.sort();

    let mut entries: Vec<Entry> = Vec::with_capacity(names.len());
    // id -> name of the entry that claimed it first
    let mut claimed: HashMap<String, String> = HashMap::new();
    for name in names {
        let Some(mut entry) = entry_for(&name, &plugins_dir.join(&name)) else {
            continue;
        };
        match claimed.get(&entry.id) {
            Some(first) => {
                if entry.loaded.is_ok() {
                    entry.loaded = Err(format!(
                        "duplicate id: {:?} is already provided by {first:?}",
                        entry.id
                    ));
                }
            }
            None => {
                claimed.insert(entry.id.clone(), name.clone());
            }
        }
        entries.push(entry);
    }
    entries
}

/// The status, and whether it is `NeedsReview` because an approved plugin was
/// edited since (as opposed to never having been reviewed).
fn status_for(hash: &str, decision: Option<&Decision>) -> (PluginStatus, bool) {
    // A decision that only holds option values has no `enabled`: it says
    // nothing about review, so the plugin is still new.
    let Some((decision, enabled)) = decision.and_then(|d| d.enabled.map(|e| (d, e))) else {
        return (PluginStatus::NeedsReview, false);
    };
    if !enabled {
        (PluginStatus::Disabled, false)
    } else if decision.approved_hash.as_deref() == Some(hash) {
        (PluginStatus::Enabled, false)
    } else {
        // Approved, then edited: it must be reviewed again.
        (PluginStatus::NeedsReview, true)
    }
}

/// Each declared option's effective value: the stored one while it is still
/// valid for the current schema (an edited plugin may have changed the choices
/// or the type), otherwise the default.
fn effective_options(loaded: &Loaded, stored: Option<&Map<String, Value>>) -> Map<String, Value> {
    loaded
        .options
        .iter()
        .map(|option| {
            let value = stored
                .and_then(|s| s.get(&option.id))
                .filter(|v| option.check_value(v).is_ok())
                .cloned()
                .unwrap_or_else(|| option.default.clone());
            (option.id.clone(), value)
        })
        .collect()
}

fn info_ok(
    loaded: &Loaded,
    status: PluginStatus,
    changed: bool,
    linked: bool,
    dir: PathBuf,
    stored_options: Option<&Map<String, Value>>,
) -> PluginInfo {
    PluginInfo {
        id: loaded.id.clone(),
        name: loaded.name.clone(),
        version: loaded.version.clone(),
        description: loaded.description.clone(),
        status,
        hash: loaded.hash.clone(),
        slots: loaded.slots.clone(),
        permissions: loaded.permissions.clone(),
        tools: loaded.tools.clone(),
        messages: loaded.messages.clone(),
        sources: loaded.sources.iter().map(source_info).collect(),
        options: loaded.options.iter().map(option_info).collect(),
        option_values: effective_options(loaded, stored_options),
        actions: loaded.actions.iter().map(action_info).collect(),
        changed,
        warnings: loaded.unhashed.clone(),
        linked,
        error: None,
        dir,
    }
}

fn info_of(entry: &Entry, decisions: &Decisions) -> PluginInfo {
    match &entry.loaded {
        Ok(loaded) => {
            let decision = decisions.plugins.get(&loaded.id);
            let (status, changed) = status_for(&loaded.hash, decision);
            info_ok(
                loaded,
                status,
                changed,
                entry.linked,
                entry.dir.clone(),
                decision.map(|d| &d.options),
            )
        }
        Err(reason) => PluginInfo {
            changed: false,
            warnings: Vec::new(),
            id: entry.id.clone(),
            name: entry.id.clone(),
            version: String::new(),
            description: String::new(),
            status: PluginStatus::Invalid,
            hash: String::new(),
            slots: Vec::new(),
            permissions: Vec::new(),
            tools: Vec::new(),
            messages: Vec::new(),
            sources: Vec::new(),
            options: Vec::new(),
            option_values: Map::new(),
            actions: Vec::new(),
            linked: entry.linked,
            error: Some(reason.clone()),
            dir: entry.dir.clone(),
        },
    }
}

/// The entry for `id`, with its status. When ids collide the first in name order
/// is the one that holds the id, which is also the first in `list`'s stable sort.
fn resolve(dirs: &PluginDirs, id: &str) -> Option<(PluginInfo, Entry)> {
    let decisions = read_decisions(&dirs.state_file);
    let entry = discover(&dirs.plugins_dir)
        .into_iter()
        .find(|e| e.id == id)?;
    Some((info_of(&entry, &decisions), entry))
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/// Every plugin in the folder, sorted by id. Never fails: problems become `Invalid` entries.
pub fn list(dirs: &PluginDirs) -> Vec<PluginInfo> {
    let decisions = read_decisions(&dirs.state_file);
    let mut infos: Vec<PluginInfo> = discover(&dirs.plugins_dir)
        .iter()
        .map(|entry| info_of(entry, &decisions))
        .collect();
    // Stable: entries sharing an id keep name order, the holder of the id first.
    infos.sort_by(|a, b| a.id.cmp(&b.id));
    infos
}

pub fn get(dirs: &PluginDirs, id: &str) -> Option<PluginInfo> {
    resolve(dirs, id).map(|(info, _)| info)
}

/// The script text. `NotFound`, or `NotEnabled` unless status is `Enabled`.
/// The text is the exact content that was hashed, never a second read of the file.
pub fn client_script(dirs: &PluginDirs, id: &str) -> Result<String, PluginError> {
    let (info, entry) = resolve(dirs, id).ok_or(PluginError::NotFound)?;
    if info.status != PluginStatus::Enabled {
        return Err(PluginError::NotEnabled);
    }
    entry
        .loaded
        .map(|loaded| loaded.client_text)
        .map_err(|_| PluginError::NotEnabled)
}

/// The plugin `id` if it is enabled right now: the gate for running its sources.
pub(crate) fn enabled(dirs: &PluginDirs, id: &str) -> Result<PluginInfo, PluginError> {
    let info = get(dirs, id).ok_or(PluginError::NotFound)?;
    if info.status == PluginStatus::Enabled {
        Ok(info)
    } else {
        Err(PluginError::NotEnabled)
    }
}

/// `enabled == true` requires `expected_hash == Some(current hash)`, else `HashMismatch`.
/// An `Invalid` plugin cannot be enabled (`Invalid(reason)`). Returns the updated entry.
pub fn set_enabled(
    dirs: &PluginDirs,
    id: &str,
    enabled: bool,
    expected_hash: Option<&str>,
) -> Result<PluginInfo, PluginError> {
    let _in_process = DECISIONS_WRITE.lock().unwrap_or_else(|p| p.into_inner());
    // INVARIANT: the file lock is held from the first read of the decisions
    // until the rename lands. The CLI is a separate process doing the same
    // read-modify-rename, and without this a daemon write could replace a
    // concurrent `plugin disable` with a stale copy and turn that plugin back on.
    let _file_lock = lock_decisions(&dirs.state_file).map_err(PluginError::Io)?;
    let (info, _) = resolve(dirs, id).ok_or(PluginError::NotFound)?;
    if enabled {
        if info.status == PluginStatus::Invalid {
            return Err(PluginError::Invalid(
                info.error.unwrap_or_else(|| "plugin is invalid".to_owned()),
            ));
        }
        // The caller names the hash it reviewed; anything else means the files
        // moved under them, and approving a hash nobody saw would defeat review.
        if expected_hash != Some(info.hash.as_str()) {
            return Err(PluginError::HashMismatch);
        }
    }
    // Unlike reading, a write refuses to run over a damaged file: it would
    // silently discard every other plugin's decision.
    let mut decisions = try_read_decisions(&dirs.state_file).map_err(PluginError::Io)?;
    let decision = decisions.plugins.entry(info.id.clone()).or_default();
    // Only the enabled state and approval change: stored option values and any
    // keys this version does not know about stay as they were.
    decision.enabled = Some(enabled);
    decision.approved_hash = enabled.then(|| info.hash.clone());
    write_decisions(&dirs.state_file, &mut decisions).map_err(PluginError::Io)?;
    get(dirs, id).ok_or(PluginError::NotFound)
}

/// Merge option values into the plugin's decision (creating the decision entry if needed,
/// without changing its enabled state or approved hash). Every key must be a declared option
/// and its value valid for that option's type and choices (text: at most 200 characters, no
/// control characters); otherwise `Invalid("option <id>: <why>")` and nothing is written.
/// Refused for an invalid plugin. Same locking as `set_enabled`.
pub fn set_options(
    dirs: &PluginDirs,
    id: &str,
    values: &Map<String, Value>,
) -> Result<PluginInfo, PluginError> {
    let _in_process = DECISIONS_WRITE.lock().unwrap_or_else(|p| p.into_inner());
    // INVARIANT: same cross-process lock as `set_enabled`; see there.
    let _file_lock = lock_decisions(&dirs.state_file).map_err(PluginError::Io)?;
    let (info, entry) = resolve(dirs, id).ok_or(PluginError::NotFound)?;
    let loaded = match &entry.loaded {
        Ok(loaded) => loaded,
        Err(reason) => return Err(PluginError::Invalid(reason.clone())),
    };
    // Validate everything before writing anything: a half-applied save would
    // leave the owner's settings in a state they never chose.
    for (key, value) in values {
        let Some(option) = loaded.options.iter().find(|o| o.id == *key) else {
            return Err(PluginError::Invalid(format!(
                "option {}: not declared by this plugin",
                shown(key)
            )));
        };
        option
            .check_value(value)
            .map_err(|why| PluginError::Invalid(format!("option {key}: {why}")))?;
    }
    if values.is_empty() {
        return Ok(info);
    }
    let mut decisions = try_read_decisions(&dirs.state_file).map_err(PluginError::Io)?;
    // A decision created here has no `enabled` yet, so a plugin never reviewed
    // stays `needs_review` rather than turning into `disabled`.
    let decision = decisions.plugins.entry(info.id.clone()).or_default();
    for (key, value) in values {
        decision.options.insert(key.clone(), value.clone());
    }
    write_decisions(&dirs.state_file, &mut decisions).map_err(PluginError::Io)?;
    get(dirs, id).ok_or(PluginError::NotFound)
}

/// A key from a request body, safe to echo into an error: ids that fit the id
/// pattern as they are, anything else escaped and quoted.
fn shown(key: &str) -> String {
    let plain = !key.is_empty()
        && key.len() <= 32
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if plain {
        key.to_owned()
    } else {
        format!("{key:?}")
    }
}

/// Validate `source_dir`, then write `<plugins_dir>/<id>.path` (creating the folder).
/// Refuses (`Invalid`) when a different entry already provides that id.
pub fn link(dirs: &PluginDirs, source_dir: &Path) -> Result<PluginInfo, PluginError> {
    // Canonical so the link keeps working from any later working directory,
    // and so what is approved is the folder that was actually reviewed.
    let canonical = std::fs::canonicalize(source_dir)
        .map_err(|e| PluginError::Invalid(format!("cannot open {}: {e}", source_dir.display())))?;
    let loaded = manifest::load(&canonical).map_err(PluginError::Invalid)?;
    let own_file = format!("{}.path", loaded.id);
    if discover(&dirs.plugins_dir)
        .iter()
        .any(|e| e.id == loaded.id && e.name != own_file)
    {
        return Err(PluginError::Invalid(format!(
            "a different plugin with id {:?} is already installed in {}",
            loaded.id,
            dirs.plugins_dir.display()
        )));
    }
    let target = canonical.to_str().ok_or_else(|| {
        PluginError::Invalid(format!("{} is not a valid UTF-8 path", canonical.display()))
    })?;
    // Created here, not at startup: a machine that never uses plugins gains no folder.
    std::fs::create_dir_all(&dirs.plugins_dir).map_err(|e| {
        PluginError::Io(format!("cannot create {}: {e}", dirs.plugins_dir.display()))
    })?;
    let link_file = dirs.plugins_dir.join(&own_file);
    atomic_write(&link_file, format!("{target}\n").as_bytes())
        .map_err(|e| PluginError::Io(format!("{e} ({})", link_file.display())))?;
    get(dirs, &loaded.id)
        .ok_or_else(|| PluginError::Io("the link was written but cannot be read back".to_owned()))
}

/// Remove `<id>.path`. `NotFound` when that id is not a linked plugin. The decision is kept,
/// so linking the same unchanged plugin again restores its previous state.
pub fn unlink(dirs: &PluginDirs, id: &str) -> Result<(), PluginError> {
    // The file name comes from the directory listing, never from `id`, so a
    // hostile id cannot name a path outside the plugins folder.
    let entry = discover(&dirs.plugins_dir)
        .into_iter()
        .find(|e| e.linked && e.id == id)
        .ok_or(PluginError::NotFound)?;
    let path = dirs.plugins_dir.join(&entry.name);
    std::fs::remove_file(&path)
        .map_err(|e| PluginError::Io(format!("cannot remove {}: {e}", path.display())))
}

/// Validate a folder without installing it. `Ok` carries status `NeedsReview`, `linked: false`.
pub fn check(source_dir: &Path) -> Result<PluginInfo, PluginError> {
    let loaded = manifest::load(source_dir).map_err(PluginError::Invalid)?;
    Ok(info_ok(
        &loaded,
        PluginStatus::NeedsReview,
        false,
        false,
        source_dir.to_path_buf(),
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::testkit::{Scratch, install_default, manifest, write_plugin};

    fn only(dirs: &PluginDirs) -> PluginInfo {
        let mut all = list(dirs);
        assert_eq!(all.len(), 1, "{all:?}");
        all.remove(0)
    }

    #[test]
    fn status_follows_review_edit_and_switching_off() {
        let scratch = Scratch::new("status");
        let dirs = scratch.dirs();
        let dir = install_default(&dirs, "p", "");

        let new = only(&dirs);
        assert_eq!(new.status, PluginStatus::NeedsReview);
        assert!(!new.changed);
        assert_eq!(new.hash.len(), 64);

        let enabled = set_enabled(&dirs, "p", true, Some(&new.hash)).unwrap();
        assert_eq!(enabled.status, PluginStatus::Enabled);

        // Editing the script after approval withdraws the approval.
        std::fs::write(dir.join("client.js"), "export default { changed: true }").unwrap();
        let edited = only(&dirs);
        assert_eq!(edited.status, PluginStatus::NeedsReview);
        // It was approved, then edited: that is "changed", not "new".
        assert!(edited.changed);
        assert_ne!(edited.hash, new.hash);

        // The old hash can no longer turn it on; neither can no hash at all.
        assert!(matches!(
            set_enabled(&dirs, "p", true, Some(&new.hash)),
            Err(PluginError::HashMismatch)
        ));
        assert!(matches!(
            set_enabled(&dirs, "p", true, None),
            Err(PluginError::HashMismatch)
        ));
        assert_eq!(only(&dirs).status, PluginStatus::NeedsReview);

        let again = set_enabled(&dirs, "p", true, Some(&edited.hash)).unwrap();
        assert_eq!(again.status, PluginStatus::Enabled);
        assert!(!again.changed);

        let off = set_enabled(&dirs, "p", false, None).unwrap();
        assert_eq!(off.status, PluginStatus::Disabled);
        assert!(!off.changed);
        assert!(matches!(
            set_enabled(&dirs, "p", true, Some(&new.hash)),
            Err(PluginError::HashMismatch)
        ));
        assert_eq!(only(&dirs).status, PluginStatus::Disabled);
    }

    #[test]
    fn editing_the_manifest_also_withdraws_approval() {
        let scratch = Scratch::new("manifest-edit");
        let dirs = scratch.dirs();
        let dir = install_default(&dirs, "p", "");
        let hash = only(&dirs).hash;
        set_enabled(&dirs, "p", true, Some(&hash)).unwrap();
        // A new source is a new command to run on this computer: it needs a fresh look.
        let text = manifest(
            "p",
            "client.js",
            r#"["drawer"]"#,
            "[[sources]]\nid = \"s\"\ncommand = [\"x\"]\n",
        );
        write_plugin(&dir, &text, "export default {}");
        assert_eq!(only(&dirs).status, PluginStatus::NeedsReview);
    }

    #[test]
    fn unknown_ids_survive_a_decision_write_and_a_damaged_file_blocks_it() {
        let scratch = Scratch::new("decisions");
        let dirs = scratch.dirs();
        install_default(&dirs, "p", "");
        std::fs::create_dir_all(dirs.state_file.parent().unwrap()).unwrap();
        std::fs::write(
            &dirs.state_file,
            r#"{"version":1,"plugins":{"gone":{"enabled":true,"approvedHash":"abc"}}}"#,
        )
        .unwrap();
        let hash = only(&dirs).hash;
        set_enabled(&dirs, "p", true, Some(&hash)).unwrap();
        let stored = std::fs::read_to_string(&dirs.state_file).unwrap();
        assert!(stored.contains("\"gone\""), "{stored}");
        assert!(stored.contains("\"approvedHash\""), "{stored}");

        // Reading a damaged file means no decisions; writing over it is refused.
        std::fs::write(&dirs.state_file, "{not json").unwrap();
        assert_eq!(only(&dirs).status, PluginStatus::NeedsReview);
        assert!(matches!(
            set_enabled(&dirs, "p", true, Some(&hash)),
            Err(PluginError::Io(_))
        ));
        assert_eq!(
            std::fs::read_to_string(&dirs.state_file).unwrap(),
            "{not json"
        );
    }

    #[test]
    fn link_lists_as_linked_and_unlink_keeps_the_decision() {
        let scratch = Scratch::new("link");
        let dirs = scratch.dirs();
        let source = scratch.root.join("elsewhere").join("my-plugin");
        write_plugin(
            &source,
            &manifest("my-plugin", "client.js", r#"["page"]"#, ""),
            "export default {}",
        );
        assert!(
            !dirs.plugins_dir.exists(),
            "plugins folder is created on demand"
        );

        let linked = link(&dirs, &source).unwrap();
        assert!(linked.linked);
        assert_eq!(linked.dir, source);
        assert_eq!(linked.status, PluginStatus::NeedsReview);
        assert!(dirs.plugins_dir.join("my-plugin.path").is_file());
        assert!(only(&dirs).linked);

        set_enabled(&dirs, "my-plugin", true, Some(&linked.hash)).unwrap();
        unlink(&dirs, "my-plugin").unwrap();
        assert!(list(&dirs).is_empty());
        assert!(
            source.join("pulse-plugin.toml").is_file(),
            "unlink never touches the source"
        );
        assert!(matches!(
            unlink(&dirs, "my-plugin"),
            Err(PluginError::NotFound)
        ));

        // The approval outlived the link: the same unchanged plugin comes back on.
        let relinked = link(&dirs, &source).unwrap();
        assert_eq!(relinked.status, PluginStatus::Enabled);
    }

    #[test]
    fn unlink_refuses_plugins_that_are_not_linked_and_hostile_ids() {
        let scratch = Scratch::new("unlink");
        let dirs = scratch.dirs();
        install_default(&dirs, "direct", "");
        std::fs::write(scratch.root.join("victim.path"), "x").unwrap();
        assert!(matches!(
            unlink(&dirs, "direct"),
            Err(PluginError::NotFound)
        ));
        assert!(matches!(
            unlink(&dirs, "../victim"),
            Err(PluginError::NotFound)
        ));
        assert!(scratch.root.join("victim.path").exists());
        assert!(dirs.plugins_dir.join("direct").is_dir());
    }

    #[test]
    fn link_refuses_an_id_another_entry_already_provides() {
        let scratch = Scratch::new("link-conflict");
        let dirs = scratch.dirs();
        install_default(&dirs, "taken", "");
        let source = scratch.root.join("other");
        write_plugin(
            &source,
            &manifest("taken", "client.js", r#"["drawer"]"#, ""),
            "export default {}",
        );
        assert!(matches!(link(&dirs, &source), Err(PluginError::Invalid(_))));
        assert!(!dirs.plugins_dir.join("taken.path").exists());
    }

    #[test]
    fn relinking_the_same_id_points_it_at_the_new_folder() {
        let scratch = Scratch::new("relink");
        let dirs = scratch.dirs();
        let first = scratch.root.join("one");
        let second = scratch.root.join("two");
        for dir in [&first, &second] {
            write_plugin(
                dir,
                &manifest("moved", "client.js", r#"["drawer"]"#, ""),
                "export default {}",
            );
        }
        link(&dirs, &first).unwrap();
        let relinked = link(&dirs, &second).unwrap();
        assert_eq!(relinked.dir, second);
        assert_eq!(list(&dirs).len(), 1);
    }

    #[test]
    fn link_rejects_an_invalid_folder_without_writing_anything() {
        let scratch = Scratch::new("link-invalid");
        let dirs = scratch.dirs();
        let source = scratch.root.join("bad");
        write_plugin(&source, "schema = 1\nbogus = true\n", "x");
        assert!(matches!(link(&dirs, &source), Err(PluginError::Invalid(_))));
        assert!(matches!(
            link(&dirs, &scratch.root.join("missing")),
            Err(PluginError::Invalid(_))
        ));
        assert!(!dirs.plugins_dir.exists());
    }

    #[test]
    fn the_later_of_two_entries_with_one_id_is_invalid() {
        let scratch = Scratch::new("dup");
        let dirs = scratch.dirs();
        for folder in ["a-first", "b-second"] {
            write_plugin(
                &dirs.plugins_dir.join(folder),
                &manifest("same", "client.js", r#"["drawer"]"#, ""),
                "export default {}",
            );
        }
        let all = list(&dirs);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].status, PluginStatus::NeedsReview);
        assert!(all[0].dir.ends_with("a-first"));
        assert_eq!(all[1].status, PluginStatus::Invalid);
        assert!(all[1].error.as_deref().unwrap().contains("duplicate id"));
        // The id belongs to the first, so enabling it by id reaches the first.
        let hash = all[0].hash.clone();
        assert!(set_enabled(&dirs, "same", true, Some(&hash)).is_ok());
    }

    #[test]
    fn an_unreadable_manifest_becomes_an_invalid_entry_named_after_its_folder() {
        let scratch = Scratch::new("broken");
        let dirs = scratch.dirs();
        write_plugin(
            &dirs.plugins_dir.join("broken-one"),
            "schema = 1\ncolour = 3\n",
            "x",
        );
        let info = only(&dirs);
        assert_eq!(info.id, "broken-one");
        assert_eq!(info.name, "broken-one");
        assert_eq!(info.status, PluginStatus::Invalid);
        assert!(info.error.is_some());
        assert!(info.hash.is_empty() && info.version.is_empty());
        assert!(matches!(
            set_enabled(&dirs, "broken-one", true, Some("anything")),
            Err(PluginError::Invalid(_))
        ));
    }

    #[test]
    fn dot_entries_and_stray_folders_are_ignored_and_a_dead_link_is_invalid() {
        let scratch = Scratch::new("ignored");
        let dirs = scratch.dirs();
        install_default(&dirs, "real", "");
        write_plugin(
            &dirs.plugins_dir.join(".hidden"),
            &manifest("hidden", "client.js", r#"["drawer"]"#, ""),
            "x",
        );
        std::fs::create_dir_all(dirs.plugins_dir.join("no-manifest-here")).unwrap();
        std::fs::write(
            dirs.plugins_dir.join(".dotted.path"),
            scratch.root.to_str().unwrap(),
        )
        .unwrap();
        let gone = scratch.root.join("gone");
        std::fs::write(dirs.plugins_dir.join("dead.path"), gone.to_str().unwrap()).unwrap();
        std::fs::write(dirs.plugins_dir.join("relative.path"), "some/where").unwrap();

        let all = list(&dirs);
        let ids: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["dead", "real", "relative"]);
        assert_eq!(all[0].status, PluginStatus::Invalid);
        assert!(all[0].linked);
        assert!(all[0].error.as_deref().unwrap().contains("not found"));
        assert!(all[2].error.as_deref().unwrap().contains("absolute"));
    }

    #[test]
    fn messages_that_reach_other_devices_never_contain_filesystem_paths() {
        let scratch = Scratch::new("no-paths");
        let dirs = scratch.dirs();
        let gone = scratch.root.join("gone-folder");
        std::fs::create_dir_all(&dirs.plugins_dir).unwrap();
        std::fs::write(dirs.plugins_dir.join("dead.path"), gone.to_str().unwrap()).unwrap();
        std::fs::write(dirs.plugins_dir.join("relative.path"), "some-folder-name").unwrap();
        for info in list(&dirs) {
            let error = info.error.unwrap();
            assert!(!error.contains("gone-folder"), "{error}");
            assert!(!error.contains("some-folder-name"), "{error}");
            assert!(!error.contains(scratch.root.to_str().unwrap()), "{error}");
        }

        // A damaged state file fails the write; the text sent to the client names no path.
        install_default(&dirs, "p", "");
        let hash = get(&dirs, "p").unwrap().hash;
        std::fs::create_dir_all(dirs.state_file.parent().unwrap()).unwrap();
        std::fs::write(&dirs.state_file, "{not json").unwrap();
        let text = set_enabled(&dirs, "p", true, Some(&hash))
            .unwrap_err()
            .to_string();
        assert!(!text.contains(scratch.root.to_str().unwrap()), "{text}");
    }

    #[test]
    fn the_script_is_served_only_while_the_plugin_is_enabled() {
        let scratch = Scratch::new("script");
        let dirs = scratch.dirs();
        let dir = install_default(&dirs, "p", "");
        assert!(matches!(
            client_script(&dirs, "nope"),
            Err(PluginError::NotFound)
        ));
        assert!(matches!(
            client_script(&dirs, "p"),
            Err(PluginError::NotEnabled)
        ));

        let hash = only(&dirs).hash;
        set_enabled(&dirs, "p", true, Some(&hash)).unwrap();
        assert_eq!(client_script(&dirs, "p").unwrap(), "export default {}");

        std::fs::write(dir.join("client.js"), "evil()").unwrap();
        assert!(matches!(
            client_script(&dirs, "p"),
            Err(PluginError::NotEnabled)
        ));

        let hash = only(&dirs).hash;
        set_enabled(&dirs, "p", true, Some(&hash)).unwrap();
        set_enabled(&dirs, "p", false, None).unwrap();
        assert!(matches!(
            client_script(&dirs, "p"),
            Err(PluginError::NotEnabled)
        ));
    }

    #[test]
    fn check_validates_without_installing() {
        let scratch = Scratch::new("check");
        let dirs = scratch.dirs();
        let source = scratch.root.join("src");
        write_plugin(
            &source,
            &manifest("checked", "client.js", r#"["drawer", "page"]"#, ""),
            "export default {}",
        );
        let info = check(&source).unwrap();
        assert_eq!(info.status, PluginStatus::NeedsReview);
        assert!(!info.linked);
        assert!(!info.changed);
        assert_eq!(info.slots, ["drawer", "page"]);
        assert!(!dirs.plugins_dir.exists());
        assert!(matches!(
            check(&scratch.root.join("missing")),
            Err(PluginError::Invalid(_))
        ));
    }

    #[test]
    fn wire_shape_is_camel_case_without_the_directory() {
        let scratch = Scratch::new("wire");
        let dirs = scratch.dirs();
        install_default(&dirs, "p", "[[sources]]\nid = \"s\"\ncommand = [\"x\"]\n");
        let value = serde_json::to_value(only(&dirs)).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object["status"], "needs_review");
        assert!(!object.contains_key("dir"));
        assert!(!object.contains_key("error"));
        assert_eq!(object["changed"], false);
        assert_eq!(object["linked"], false);
        assert_eq!(object["sources"][0]["intervalS"], 30);
        assert_eq!(object["sources"][0]["timeoutS"], 5);

        let broken = serde_json::to_value(PluginInfo {
            error: Some("why".to_owned()),
            status: PluginStatus::Invalid,
            ..only(&dirs)
        })
        .unwrap();
        assert_eq!(broken["status"], "invalid");
        assert_eq!(broken["error"], "why");
    }

    #[test]
    fn error_codes_are_the_documented_strings() {
        assert_eq!(PluginError::NotFound.code(), "plugin_not_found");
        assert_eq!(PluginError::SourceNotFound.code(), "source_not_found");
        assert_eq!(PluginError::NotEnabled.code(), "plugin_not_enabled");
        assert_eq!(PluginError::HashMismatch.code(), "plugin_hash_mismatch");
        assert_eq!(PluginError::Invalid(String::new()).code(), "plugin_invalid");
        assert_eq!(PluginError::Io(String::new()).code(), "plugin_io");
        assert_eq!(PluginError::ActionNotFound.code(), "action_not_found");
        assert_eq!(PluginError::ActionBusy.code(), "plugin_action_busy");
    }

    /// A choice, a bool and a text option.
    const OPTIONS: &str = "[[options]]\nid = \"mode\"\nlabel = \"Mode\"\ntype = \"choice\"\nchoices = [\"a\", \"b\"]\ndefault = \"b\"\n\
        [[options]]\nid = \"on\"\nlabel = \"On\"\ntype = \"bool\"\n\
        [[options]]\nid = \"note\"\nlabel = \"Note\"\ntype = \"text\"\n";

    fn values(json: Value) -> Map<String, Value> {
        json.as_object().unwrap().clone()
    }

    fn stored(dirs: &PluginDirs) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&dirs.state_file).unwrap()).unwrap()
    }

    #[test]
    fn option_values_fall_back_to_the_default_when_a_stored_value_no_longer_fits() {
        let scratch = Scratch::new("opt-fallback");
        let dirs = scratch.dirs();
        install_default(&dirs, "p", OPTIONS);
        std::fs::create_dir_all(dirs.state_file.parent().unwrap()).unwrap();
        // `mode` is no longer a choice and `on` has the wrong type (an edited schema);
        // `note` is still fine; `gone` is not declared any more.
        std::fs::write(
            &dirs.state_file,
            r#"{"version":1,"plugins":{"p":{"options":{"mode":"zzz","on":"yes","note":"hello","gone":1}}}}"#,
        )
        .unwrap();
        let info = only(&dirs);
        assert_eq!(info.option_values["mode"], "b");
        assert_eq!(info.option_values["on"], false);
        assert_eq!(info.option_values["note"], "hello");
        assert!(!info.option_values.contains_key("gone"));
        // Settings alone are not a review decision: the plugin is still new.
        assert_eq!(info.status, PluginStatus::NeedsReview);
        assert!(!info.changed);
        assert_eq!(info.options.len(), 3);
        assert_eq!(info.options[0].choices, ["a", "b"]);
    }

    #[test]
    fn set_options_validates_everything_before_writing_anything() {
        let scratch = Scratch::new("opt-validate");
        let dirs = scratch.dirs();
        install_default(&dirs, "p", OPTIONS);
        let invalid = |json: Value| match set_options(&dirs, "p", &values(json)) {
            Err(PluginError::Invalid(why)) => why,
            other => panic!("expected Invalid, got {other:?}"),
        };
        assert!(invalid(serde_json::json!({"nope": true})).contains("option nope"));
        assert!(invalid(serde_json::json!({"mode": "c"})).contains("option mode"));
        assert!(invalid(serde_json::json!({"on": "true"})).contains("option on"));
        assert!(invalid(serde_json::json!({"note": "x".repeat(201)})).contains("option note"));
        assert!(invalid(serde_json::json!({"note": "a\u{1b}[8m"})).contains("option note"));
        // One bad value rejects the whole save, including the good one beside it.
        assert!(invalid(serde_json::json!({"mode": "a", "note": 5})).contains("option note"));
        assert!(!dirs.state_file.exists(), "nothing was written");
        assert_eq!(only(&dirs).option_values["mode"], "b");

        assert!(matches!(
            set_options(&dirs, "nobody", &values(serde_json::json!({}))),
            Err(PluginError::NotFound)
        ));
        write_plugin(
            &dirs.plugins_dir.join("broken"),
            "schema = 1\nbogus = 1\n",
            "x",
        );
        assert!(matches!(
            set_options(&dirs, "broken", &values(serde_json::json!({"mode": "a"}))),
            Err(PluginError::Invalid(_))
        ));
    }

    #[test]
    fn set_options_keeps_review_state_and_survives_enable_and_disable() {
        let scratch = Scratch::new("opt-survive");
        let dirs = scratch.dirs();
        install_default(&dirs, "p", OPTIONS);
        std::fs::create_dir_all(dirs.state_file.parent().unwrap()).unwrap();
        // A stored option of a plugin version that declared it, and a key from a newer daemon.
        std::fs::write(
            &dirs.state_file,
            r#"{"version":1,"plugins":{"p":{"options":{"old":"x"},"future":true}}}"#,
        )
        .unwrap();

        let saved = set_options(
            &dirs,
            "p",
            &values(serde_json::json!({"mode": "a", "note": "hi"})),
        )
        .unwrap();
        assert_eq!(
            saved.status,
            PluginStatus::NeedsReview,
            "saving options must not disable it"
        );
        assert_eq!(saved.option_values["mode"], "a");

        let hash = saved.hash.clone();
        let enabled = set_enabled(&dirs, "p", true, Some(&hash)).unwrap();
        assert_eq!(enabled.status, PluginStatus::Enabled);
        assert_eq!(enabled.option_values["mode"], "a");
        assert_eq!(enabled.option_values["note"], "hi");

        // A later save merges: `mode` stays, approval is untouched.
        let merged = set_options(&dirs, "p", &values(serde_json::json!({"note": "yo"}))).unwrap();
        assert_eq!(merged.status, PluginStatus::Enabled);
        assert_eq!(merged.option_values["mode"], "a");
        assert_eq!(merged.option_values["note"], "yo");

        let off = set_enabled(&dirs, "p", false, None).unwrap();
        assert_eq!(off.status, PluginStatus::Disabled);
        assert_eq!(off.option_values["note"], "yo");

        let file = stored(&dirs);
        assert_eq!(file["plugins"]["p"]["options"]["old"], "x");
        assert_eq!(file["plugins"]["p"]["future"], true);
    }

    #[test]
    fn the_new_catalogue_fields_use_their_wire_names() {
        let scratch = Scratch::new("wire2");
        let dirs = scratch.dirs();
        let extra = format!(
            "permissions = [\"session.bash\"]\n{OPTIONS}\
             [[actions]]\nid = \"go\"\nlabel = \"Go\"\ncommand = [\"x\", \"{{arg}}\"]\narg_pattern = \"a+\"\n\
             [[actions]]\nid = \"stop\"\nlabel = \"Stop\"\ncommand = [\"y\"]\ntimeout_s = 7\n"
        );
        install_default(&dirs, "p", &extra);
        let value = serde_json::to_value(only(&dirs)).unwrap();
        assert_eq!(value["permissions"], serde_json::json!(["session.bash"]));
        assert_eq!(value["tools"], serde_json::json!([]));
        assert_eq!(value["messages"], serde_json::json!([]));
        assert_eq!(value["options"][0]["type"], "choice");
        assert_eq!(
            value["options"][0]["choices"],
            serde_json::json!(["a", "b"])
        );
        assert_eq!(value["options"][1]["choices"], serde_json::json!([]));
        assert_eq!(value["options"][1]["default"], false);
        assert_eq!(value["optionValues"]["mode"], "b");
        assert_eq!(value["actions"][0]["argPattern"], "a+");
        assert_eq!(value["actions"][0]["timeoutS"], 30);
        assert!(value["actions"][1].get("argPattern").is_none());
        assert_eq!(value["actions"][1]["timeoutS"], 7);

        // An invalid plugin carries none of it.
        write_plugin(
            &dirs.plugins_dir.join("aaa-broken"),
            "schema = 1\nbogus = 1\n",
            "x",
        );
        let broken = serde_json::to_value(list(&dirs).remove(0)).unwrap();
        assert_eq!(broken["status"], "invalid");
        assert_eq!(broken["options"], serde_json::json!([]));
        assert_eq!(broken["optionValues"], serde_json::json!({}));
        assert_eq!(broken["actions"], serde_json::json!([]));
        assert_eq!(broken["permissions"], serde_json::json!([]));
    }
}
