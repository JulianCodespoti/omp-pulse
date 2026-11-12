//! Plugin manifest: parses and validates `pulse-plugin.toml` and the client
//! script next to it, and computes the content hash a plugin is approved by.
//!
//! WHY strict (`deny_unknown_fields`, closed slot list, numeric ranges): the
//! manifest is what a person reviews before switching a plugin on, so a typo
//! must surface in `plugin check` instead of silently doing nothing, and every
//! limit the daemon relies on (source count, intervals, script size) is
//! enforced here once, before any other code sees the plugin.

use std::io::Read;
use std::path::{Component, Path};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The manifest's file name inside a plugin folder.
pub const MANIFEST_FILE: &str = "pulse-plugin.toml";
/// Slots a plugin may declare. A closed list: the client only knows how to draw these.
pub const KNOWN_SLOTS: [&str; 8] = [
    "composer.status",
    "composer.actions",
    "drawer",
    "page",
    "session.row",
    "session.menu",
    "transcript.tool",
    "transcript.message",
];
/// What a plugin may ask to do on a tap; each needs declaring so review shows it.
const KNOWN_PERMISSIONS: [&str; 5] = [
    "session.read",
    "session.compose",
    "session.prompt",
    "session.bash",
    "session.rpc",
];
/// The one placeholder an action's argv may contain, as an element of its own.
pub(crate) const ARG_PLACEHOLDER: &str = "{arg}";
/// Longest text option value or default, in characters.
pub(crate) const TEXT_OPTION_MAX_CHARS: usize = 200;

const CLIENT_MAX_BYTES: u64 = 262_144;
/// A manifest that large is not a manifest; the cap bounds what one bad folder can make us read.
const MANIFEST_MAX_BYTES: u64 = 65_536;
const MAX_SOURCES: usize = 8;
const MAX_OPTIONS: usize = 16;
const MAX_ACTIONS: usize = 8;
const MAX_CLAIMS: usize = 16;
const DEFAULT_INTERVAL_S: u64 = 30;
const DEFAULT_TIMEOUT_S: u64 = 5;
const DEFAULT_ACTION_TIMEOUT_S: u64 = 30;
/// Compiled-size cap for an action's `arg_pattern` (regex crate default is 10 MiB).
const PATTERN_SIZE_LIMIT: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    // Signed so a stray `schema = -1` reports "must be 1" rather than a type error.
    schema: i64,
    id: String,
    name: String,
    version: String,
    description: Option<String>,
    client: String,
    slots: Vec<String>,
    #[serde(default)]
    permissions: Vec<String>,
    tools: Option<Vec<String>>,
    messages: Option<Vec<String>>,
    #[serde(default)]
    sources: Vec<RawSource>,
    #[serde(default)]
    options: Vec<RawOption>,
    #[serde(default)]
    actions: Vec<RawAction>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSource {
    id: String,
    command: Vec<String>,
    // Signed for the same reason as `schema`: report the range, not a parse error.
    interval_s: Option<i64>,
    timeout_s: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOption {
    id: String,
    label: String,
    #[serde(rename = "type")]
    kind: String,
    choices: Option<Vec<String>>,
    // Any TOML value, so a default of the wrong type is reported against the
    // option's type instead of as a parse error with no option named.
    default: Option<toml::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAction {
    id: String,
    label: String,
    command: Vec<String>,
    arg_pattern: Option<String>,
    timeout_s: Option<i64>,
}

/// One declared host command, after validation and defaults.
#[derive(Debug, Clone)]
pub(crate) struct SourceSpec {
    pub id: String,
    pub command: Vec<String>,
    pub interval_s: u64,
    pub timeout_s: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OptionKind {
    Bool,
    Choice,
    Text,
}

impl OptionKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            OptionKind::Bool => "bool",
            OptionKind::Choice => "choice",
            OptionKind::Text => "text",
        }
    }
}

/// A per-plugin setting the owner can change in Settings.
#[derive(Debug, Clone)]
pub(crate) struct OptionSpec {
    pub id: String,
    pub label: String,
    pub kind: OptionKind,
    /// Empty unless `kind` is `Choice`.
    pub choices: Vec<String>,
    /// A JSON boolean or string, matching `kind`.
    pub default: serde_json::Value,
}

impl OptionSpec {
    /// Whether `value` is acceptable for this option's type and choices.
    pub(crate) fn check_value(&self, value: &serde_json::Value) -> Result<(), String> {
        use serde_json::Value;
        match (self.kind, value) {
            (OptionKind::Bool, Value::Bool(_)) => Ok(()),
            (OptionKind::Bool, _) => Err("must be true or false".to_owned()),
            (OptionKind::Choice, Value::String(s)) if self.choices.contains(s) => Ok(()),
            (OptionKind::Choice, _) => Err("must be one of the declared choices".to_owned()),
            (OptionKind::Text, Value::String(s)) => {
                if s.chars().count() > TEXT_OPTION_MAX_CHARS {
                    Err(format!(
                        "must be at most {TEXT_OPTION_MAX_CHARS} characters"
                    ))
                } else if has_unsafe_chars(s) {
                    Err("must not contain control characters".to_owned())
                } else {
                    Ok(())
                }
            }
            (OptionKind::Text, _) => Err("must be a string".to_owned()),
        }
    }
}

/// A host command the owner can start with a tap, after validation and defaults.
#[derive(Debug, Clone)]
pub(crate) struct ActionSpec {
    pub id: String,
    pub label: String,
    pub command: Vec<String>,
    /// Present exactly when `command` has [`ARG_PLACEHOLDER`].
    pub arg_pattern: Option<String>,
    pub timeout_s: u64,
}

/// A fully validated plugin folder. `hash` and `client_text` come from the very
/// bytes that were parsed, so what is approved is exactly what is served.
#[derive(Debug, Clone)]
pub(crate) struct Loaded {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub slots: Vec<String>,
    pub permissions: Vec<String>,
    pub tools: Vec<String>,
    pub messages: Vec<String>,
    pub sources: Vec<SourceSpec>,
    pub options: Vec<OptionSpec>,
    pub actions: Vec<ActionSpec>,
    pub hash: String,
    pub client_text: String,
    /// One sentence per file in the plugin folder that a declared command runs
    /// or reads: the hash covers only the manifest and the client script, so
    /// an edit to such a file reaches the computer without a review.
    pub unhashed: Vec<String>,
}

/// Validate the plugin in `dir`. The error is one line, fit for `plugin check`
/// and for the `error` field of an invalid catalog entry.
pub(crate) fn load(dir: &Path) -> Result<Loaded, String> {
    let manifest_bytes = read_capped(&dir.join(MANIFEST_FILE), MANIFEST_MAX_BYTES, MANIFEST_FILE)?;
    let text = std::str::from_utf8(&manifest_bytes)
        .map_err(|_| format!("{MANIFEST_FILE} is not valid UTF-8"))?;
    let raw: RawManifest = toml::from_str(text).map_err(|e| describe_toml_error(text, &e))?;

    if raw.schema != 1 {
        return Err(format!("schema must be 1, found {}", raw.schema));
    }
    if !valid_plugin_id(&raw.id) {
        return Err(format!(
            "id {:?} is invalid: use 1 to 64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit",
            raw.id
        ));
    }
    let name = bounded("name", &raw.name, 1, 64)?;
    let version = bounded("version", &raw.version, 1, 32)?;
    let description = match &raw.description {
        Some(d) => bounded("description", d, 0, 200)?,
        None => String::new(),
    };
    let slots = validate_slots(&raw.slots)?;
    let permissions = validate_permissions(&raw.permissions)?;
    let tools = validate_claims("tools", "transcript.tool", raw.tools.as_deref(), &slots)?;
    let messages = validate_claims(
        "messages",
        "transcript.message",
        raw.messages.as_deref(),
        &slots,
    )?;
    let sources = validate_sources(&raw.sources)?;
    let options = validate_options(&raw.options)?;
    let actions = validate_actions(&raw.actions)?;

    check_client_name(&raw.client)?;
    let client_path = dir.join(&raw.client);
    let client_bytes = read_capped(&client_path, CLIENT_MAX_BYTES, &raw.client)?;
    // A symlinked script that resolves elsewhere would make "the plugin folder"
    // a lie; the hash would still cover the bytes, but review is of a folder.
    if let (Ok(root), Ok(real)) = (
        std::fs::canonicalize(dir),
        std::fs::canonicalize(&client_path),
    ) && !real.starts_with(&root)
    {
        return Err(format!(
            "client file {} resolves outside the plugin folder",
            raw.client
        ));
    }
    let client_text = String::from_utf8(client_bytes)
        .map_err(|_| format!("client file {} is not valid UTF-8", raw.client))?;

    let hash = content_hash(&manifest_bytes, client_text.as_bytes());
    let commands = sources
        .iter()
        .map(|source| ("source", source.id.as_str(), source.command.as_slice()))
        .chain(
            actions
                .iter()
                .map(|action| ("action", action.id.as_str(), action.command.as_slice())),
        );
    let unhashed = unhashed_inputs(dir, &raw.client, commands);
    Ok(Loaded {
        id: raw.id,
        name,
        version,
        description,
        slots,
        permissions,
        tools,
        messages,
        sources,
        options,
        actions,
        hash,
        client_text,
        unhashed,
    })
}

/// Sentences naming each file inside `dir` that a command uses as its program
/// or as an argument, other than the manifest and the client script (which the
/// hash covers). A bare program name is looked up on PATH, never in the folder,
/// so only a program written as a path counts; options (`-x`) and `{arg}` never
/// name a file here. Best effort by design: a path inside a `sh -c` script is
/// not parsed, which is why the review also shows every argv in full.
fn unhashed_inputs<'a>(
    dir: &Path,
    client: &str,
    commands: impl Iterator<Item = (&'a str, &'a str, &'a [String])>,
) -> Vec<String> {
    let Ok(root) = std::fs::canonicalize(dir) else {
        return Vec::new();
    };
    let hashed = [root.join(MANIFEST_FILE), root.join(client)];
    let mut found = Vec::new();
    for (kind, id, command) in commands {
        for (index, part) in command.iter().enumerate() {
            let is_program = index == 0;
            if part == ARG_PLACEHOLDER || part.starts_with('-') || part.is_empty() {
                continue;
            }
            let path = Path::new(part);
            if is_program && path.components().count() < 2 && !path.is_absolute() {
                continue;
            }
            let candidate = if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            };
            let Ok(real) = std::fs::canonicalize(&candidate) else {
                continue;
            };
            if real.is_file() && real.starts_with(&root) && !hashed.contains(&real) {
                found.push(format!(
                    "{kind} {id} uses {part} from the plugin folder, which approval does not cover: an edit to it runs without a new review"
                ));
            }
        }
    }
    found
}

/// Best-effort id of a plugin whose manifest failed validation, so the broken
/// entry is still addressable (and unlinkable) under the name its author gave it.
pub(crate) fn lenient_id(dir: &Path) -> Option<String> {
    let bytes = read_capped(&dir.join(MANIFEST_FILE), MANIFEST_MAX_BYTES, MANIFEST_FILE).ok()?;
    let table: toml::Table = toml::from_str(std::str::from_utf8(&bytes).ok()?).ok()?;
    table
        .get("id")
        .and_then(toml::Value::as_str)
        .filter(|id| valid_plugin_id(id))
        .map(str::to_owned)
}

/// Lowercase hex SHA-256 over `manifest ++ 0x00 ++ client`. The separator keeps
/// "ab"+"c" and "a"+"bc" from hashing alike.
pub(crate) fn content_hash(manifest: &[u8], client: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hasher = Sha256::new();
    hasher.update(manifest);
    hasher.update([0u8]);
    hasher.update(client);
    let mut out = String::with_capacity(64);
    for byte in hasher.finalize() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `^[a-z0-9][a-z0-9._-]{0,63}$`, written out so no regex has to compile at runtime.
pub(crate) fn valid_plugin_id(id: &str) -> bool {
    valid_id(id, 64, true)
}

fn valid_source_id(id: &str) -> bool {
    valid_id(id, 32, false)
}

fn valid_id(id: &str, max_len: usize, allow_dot: bool) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && id.len() <= max_len
        && chars.all(|c| {
            c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || c == '_'
                || c == '-'
                || (allow_dot && c == '.')
        })
}

/// True for anything that could rewrite a terminal or reorder what a person
/// reads: C0/C1 controls (including ESC and CSI), zero-width marks, bidi
/// overrides and the byte-order mark. A manifest string reaches `plugin check`
/// and `plugin list` output, where an escape sequence could hide the very
/// lines (slots, commands) that the review step exists to show.
pub(crate) fn has_unsafe_chars(value: &str) -> bool {
    value.chars().any(|c| {
        c.is_control()
            || matches!(
                c,
                '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
            )
    })
}

/// `value` with every unsafe character shown as an escape, for text we did not
/// author (the toml crate's messages quote the manifest).
fn escaped(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if has_unsafe_chars(c.encode_utf8(&mut [0u8; 4])) {
                c.escape_default().to_string()
            } else {
                c.to_string()
            }
        })
        .collect()
}

/// Trim `value` and require its length in characters to fall in `min..=max`.
fn bounded(field: &str, value: &str, min: usize, max: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if has_unsafe_chars(trimmed) {
        return Err(format!("{field} must not contain control characters"));
    }
    let len = trimmed.chars().count();
    if len < min || len > max {
        return Err(format!(
            "{field} must be {min} to {max} characters, found {len}"
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_slots(raw: &[String]) -> Result<Vec<String>, String> {
    if raw.is_empty() {
        return Err("slots must list at least one slot".to_owned());
    }
    let mut slots: Vec<String> = Vec::with_capacity(raw.len());
    for slot in raw {
        if !KNOWN_SLOTS.contains(&slot.as_str()) {
            return Err(format!(
                "unknown slot {slot:?} (expected {})",
                KNOWN_SLOTS.join(", ")
            ));
        }
        if slots.contains(slot) {
            return Err(format!("duplicate slot {slot:?}"));
        }
        slots.push(slot.clone());
    }
    Ok(slots)
}

fn validate_permissions(raw: &[String]) -> Result<Vec<String>, String> {
    let mut permissions: Vec<String> = Vec::with_capacity(raw.len());
    for permission in raw {
        if !KNOWN_PERMISSIONS.contains(&permission.as_str()) {
            return Err(format!(
                "unknown permission {permission:?} (expected {})",
                KNOWN_PERMISSIONS.join(", ")
            ));
        }
        if permissions.contains(permission) {
            return Err(format!("duplicate permission {permission:?}"));
        }
        permissions.push(permission.clone());
    }
    Ok(permissions)
}

/// `tools` / `messages`: required and non-empty exactly when the slot that uses
/// them is declared, rejected otherwise. A claim that nobody asked for would be
/// invisible at review, so the manifest may only carry what its slots use.
fn validate_claims(
    field: &str,
    slot: &str,
    claims: Option<&[String]>,
    slots: &[String],
) -> Result<Vec<String>, String> {
    let declared = slots.iter().any(|s| s == slot);
    match (declared, claims) {
        (false, None) => Ok(Vec::new()),
        (false, Some(_)) => Err(format!("{field} is only allowed when slots has {slot}")),
        (true, None | Some([])) => Err(format!(
            "{field} is required, and must not be empty, when slots has {slot}"
        )),
        (true, Some(list)) => {
            if list.len() > MAX_CLAIMS {
                return Err(format!(
                    "{field} may have at most {MAX_CLAIMS} entries, found {}",
                    list.len()
                ));
            }
            for claim in list {
                if !valid_claim(claim) {
                    return Err(format!(
                        "{field} entry {claim:?} is invalid: use 1 to 64 characters from A-Z a-z 0-9 _ . : / - and *"
                    ));
                }
            }
            Ok(list.to_vec())
        }
    }
}

fn valid_claim(claim: &str) -> bool {
    let len = claim.chars().count();
    (1..=64).contains(&len)
        && claim
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '/' | '-' | '*'))
}

fn validate_sources(raw: &[RawSource]) -> Result<Vec<SourceSpec>, String> {
    if raw.len() > MAX_SOURCES {
        return Err(format!(
            "at most {MAX_SOURCES} sources are allowed, found {}",
            raw.len()
        ));
    }
    let mut sources: Vec<SourceSpec> = Vec::with_capacity(raw.len());
    for source in raw {
        if !valid_source_id(&source.id) {
            return Err(format!(
                "source id {:?} is invalid: use 1 to 32 characters of a-z, 0-9, '_' or '-', starting with a letter or digit",
                source.id
            ));
        }
        if sources.iter().any(|s| s.id == source.id) {
            return Err(format!("duplicate source id {:?}", source.id));
        }
        if source.command.is_empty() || source.command.iter().any(String::is_empty) {
            return Err(format!(
                "source {:?}: command must be a non-empty list of non-empty strings",
                source.id
            ));
        }
        // The argv is printed at review; a control character there is never legitimate.
        if source.command.iter().any(|arg| has_unsafe_chars(arg)) {
            return Err(format!(
                "source {:?}: command must not contain control characters",
                source.id
            ));
        }
        sources.push(SourceSpec {
            id: source.id.clone(),
            command: source.command.clone(),
            interval_s: ranged(
                "source",
                &source.id,
                "interval_s",
                source.interval_s,
                DEFAULT_INTERVAL_S,
                2,
                3600,
            )?,
            timeout_s: ranged(
                "source",
                &source.id,
                "timeout_s",
                source.timeout_s,
                DEFAULT_TIMEOUT_S,
                1,
                30,
            )?,
        });
    }
    Ok(sources)
}

fn validate_options(raw: &[RawOption]) -> Result<Vec<OptionSpec>, String> {
    if raw.len() > MAX_OPTIONS {
        return Err(format!(
            "at most {MAX_OPTIONS} options are allowed, found {}",
            raw.len()
        ));
    }
    let mut options: Vec<OptionSpec> = Vec::with_capacity(raw.len());
    for option in raw {
        let id = &option.id;
        if !valid_source_id(id) {
            return Err(format!(
                "option id {id:?} is invalid: use 1 to 32 characters of a-z, 0-9, '_' or '-', starting with a letter or digit"
            ));
        }
        if options.iter().any(|o| o.id == *id) {
            return Err(format!("duplicate option id {id:?}"));
        }
        let label = bounded(&format!("option {id:?} label"), &option.label, 1, 64)?;
        let kind = match option.kind.as_str() {
            "bool" => OptionKind::Bool,
            "choice" => OptionKind::Choice,
            "text" => OptionKind::Text,
            other => {
                return Err(format!(
                    "option {id:?}: type must be bool, choice or text, found {other:?}"
                ));
            }
        };
        let choices = match (kind, &option.choices) {
            (OptionKind::Choice, Some(list)) => {
                if list.is_empty() || list.len() > 20 {
                    return Err(format!(
                        "option {id:?}: choices must have 1 to 20 entries, found {}",
                        list.len()
                    ));
                }
                for (i, choice) in list.iter().enumerate() {
                    plain(&format!("option {id:?} choice"), choice, 1, 64)?;
                    if list[..i].contains(choice) {
                        return Err(format!("option {id:?}: duplicate choice {choice:?}"));
                    }
                }
                list.clone()
            }
            (OptionKind::Choice, None) => {
                return Err(format!(
                    "option {id:?}: choices is required for type choice"
                ));
            }
            (_, Some(_)) => {
                return Err(format!(
                    "option {id:?}: choices is only allowed for type choice"
                ));
            }
            (_, None) => Vec::new(),
        };
        let default = option_default(id, kind, &choices, option.default.as_ref())?;
        options.push(OptionSpec {
            id: id.clone(),
            label,
            kind,
            choices,
            default,
        });
    }
    Ok(options)
}

/// The declared default, or the type's natural one; a default of the wrong type
/// is an error rather than being coerced.
fn option_default(
    id: &str,
    kind: OptionKind,
    choices: &[String],
    declared: Option<&toml::Value>,
) -> Result<serde_json::Value, String> {
    use serde_json::Value;
    let wrong = |why: &str| Err(format!("option {id:?}: default {why}"));
    match (kind, declared) {
        (OptionKind::Bool, None) => Ok(Value::Bool(false)),
        (OptionKind::Bool, Some(toml::Value::Boolean(b))) => Ok(Value::Bool(*b)),
        (OptionKind::Bool, Some(_)) => wrong("must be true or false"),
        (OptionKind::Choice, None) => {
            Ok(Value::String(choices.first().cloned().unwrap_or_default()))
        }
        (OptionKind::Choice, Some(toml::Value::String(s))) if choices.contains(s) => {
            Ok(Value::String(s.clone()))
        }
        (OptionKind::Choice, Some(_)) => wrong("must be one of the choices"),
        (OptionKind::Text, None) => Ok(Value::String(String::new())),
        (OptionKind::Text, Some(toml::Value::String(s))) => {
            plain(
                &format!("option {id:?} default"),
                s,
                0,
                TEXT_OPTION_MAX_CHARS,
            )?;
            Ok(Value::String(s.clone()))
        }
        (OptionKind::Text, Some(_)) => wrong("must be a string"),
    }
}

fn validate_actions(raw: &[RawAction]) -> Result<Vec<ActionSpec>, String> {
    if raw.len() > MAX_ACTIONS {
        return Err(format!(
            "at most {MAX_ACTIONS} actions are allowed, found {}",
            raw.len()
        ));
    }
    let mut actions: Vec<ActionSpec> = Vec::with_capacity(raw.len());
    for action in raw {
        let id = &action.id;
        if !valid_source_id(id) {
            return Err(format!(
                "action id {id:?} is invalid: use 1 to 32 characters of a-z, 0-9, '_' or '-', starting with a letter or digit"
            ));
        }
        if actions.iter().any(|a| a.id == *id) {
            return Err(format!("duplicate action id {id:?}"));
        }
        let label = bounded(&format!("action {id:?} label"), &action.label, 1, 80)?;
        if action.command.is_empty() || action.command.iter().any(String::is_empty) {
            return Err(format!(
                "action {id:?}: command must be a non-empty list of non-empty strings"
            ));
        }
        if action.command.iter().any(|arg| has_unsafe_chars(arg)) {
            return Err(format!(
                "action {id:?}: command must not contain control characters"
            ));
        }
        let placeholders = action
            .command
            .iter()
            .filter(|a| a.as_str() == ARG_PLACEHOLDER)
            .count();
        if placeholders > 1 {
            return Err(format!(
                "action {id:?}: command may contain {ARG_PLACEHOLDER} only once"
            ));
        }
        if action
            .command
            .iter()
            .any(|a| a.as_str() != ARG_PLACEHOLDER && a.contains(ARG_PLACEHOLDER))
        {
            return Err(format!(
                "action {id:?}: {ARG_PLACEHOLDER} must be an element of its own, not part of a longer one"
            ));
        }
        let arg_pattern = match (placeholders, &action.arg_pattern) {
            (0, None) => None,
            (0, Some(_)) => {
                return Err(format!(
                    "action {id:?}: arg_pattern is only allowed when command has {ARG_PLACEHOLDER}"
                ));
            }
            (_, None) => {
                return Err(format!(
                    "action {id:?}: arg_pattern is required when command has {ARG_PLACEHOLDER}"
                ));
            }
            (_, Some(pattern)) => {
                plain(&format!("action {id:?} arg_pattern"), pattern, 1, 200)?;
                compile_arg_pattern(pattern).map_err(|why| format!("action {id:?}: {why}"))?;
                Some(pattern.clone())
            }
        };
        actions.push(ActionSpec {
            id: id.clone(),
            label,
            command: action.command.clone(),
            arg_pattern,
            timeout_s: ranged(
                "action",
                id,
                "timeout_s",
                action.timeout_s,
                DEFAULT_ACTION_TIMEOUT_S,
                1,
                120,
            )?,
        });
    }
    Ok(actions)
}

/// Compile an action's `arg_pattern` so that it must match a WHOLE argument:
/// wrapped as `^(?:PATTERN)$`. The pattern is compiled on its own first, because
/// wrapping alone would let `a)|(b` close the group early and turn the anchors
/// into one branch of an alternation, so the "whole argument" rule would not hold.
/// The compiled size is capped so a hostile pattern cannot use much memory.
pub(crate) fn compile_arg_pattern(pattern: &str) -> Result<regex::Regex, String> {
    let build = |source: &str| {
        regex::RegexBuilder::new(source)
            .size_limit(PATTERN_SIZE_LIMIT)
            .build()
    };
    build(pattern).map_err(pattern_error)?;
    build(&format!("^(?:{pattern})$")).map_err(pattern_error)
}

/// One line, without the regex crate's multi-line excerpt of the pattern.
fn pattern_error(err: regex::Error) -> String {
    match err {
        regex::Error::Syntax(text) => {
            let reason = text.lines().last().unwrap_or("invalid syntax");
            format!(
                "arg_pattern is not a valid pattern: {}",
                escaped(reason.trim_start_matches("error: "))
            )
        }
        regex::Error::CompiledTooBig(_) => "arg_pattern is too complex".to_owned(),
        _ => "arg_pattern is not a valid pattern".to_owned(),
    }
}

/// Like [`bounded`] but untrimmed: choices and defaults are compared verbatim.
fn plain(field: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    if has_unsafe_chars(value) {
        return Err(format!("{field} must not contain control characters"));
    }
    let len = value.chars().count();
    if len < min || len > max {
        return Err(format!(
            "{field} must be {min} to {max} characters, found {len}"
        ));
    }
    Ok(())
}

fn ranged(
    kind: &str,
    owner: &str,
    field: &str,
    value: Option<i64>,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64, String> {
    let Some(value) = value else {
        return Ok(default);
    };
    match u64::try_from(value) {
        Ok(v) if (min..=max).contains(&v) => Ok(v),
        _ => Err(format!(
            "{kind} {owner:?}: {field} must be {min} to {max}, found {value}"
        )),
    }
}

/// A bare file name: exactly one normal path component, no separators, no `..`.
/// Checked with `Path::components` as well as by character so Windows drive
/// prefixes (`C:x`) are refused too.
fn check_client_name(client: &str) -> Result<(), String> {
    let mut components = Path::new(client).components();
    let single_name = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    );
    if !single_name
        || has_unsafe_chars(client)
        || client.contains(['/', '\\'])
        || client.contains("..")
    {
        return Err(format!(
            "client {client:?} must be a file name in the plugin folder (no path separators or '..')"
        ));
    }
    Ok(())
}

/// Read a regular file of at most `max` bytes. Rejects non-regular files before
/// opening (a FIFO would block forever) and caps the read itself so a file that
/// grows between the check and the read still cannot exhaust memory.
fn read_capped(path: &Path, max: u64, label: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read {label}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("cannot read {label}: {e}"))?;
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read {label}: {e}"))?;
    if bytes.len() as u64 > max {
        return Err(format!("{label} is larger than {max} bytes"));
    }
    Ok(bytes)
}

/// The toml crate's `Display` is a multi-line source excerpt; the catalog and
/// the CLI want one line, so keep its message and add the line number. The
/// message can quote manifest text, so control characters are escaped.
fn describe_toml_error(text: &str, err: &toml::de::Error) -> String {
    let message = escaped(err.message());
    match err.span().and_then(|span| text.get(..span.start)) {
        Some(before) => format!(
            "{MANIFEST_FILE} line {}: {message}",
            before.matches('\n').count() + 1
        ),
        None => format!("{MANIFEST_FILE}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::testkit::{Scratch, manifest, write_plugin};

    /// Load a plugin built from `manifest_text` and (optionally) a client file.
    fn try_load(manifest_text: &str, client: Option<&[u8]>) -> Result<Loaded, String> {
        let scratch = Scratch::new("manifest");
        let dir = scratch.root.join("p");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(MANIFEST_FILE), manifest_text).unwrap();
        if let Some(bytes) = client {
            std::fs::write(dir.join("client.js"), bytes).unwrap();
        }
        load(&dir)
    }

    fn err_of(manifest_text: &str) -> String {
        match try_load(manifest_text, Some(b"export default {}")) {
            Ok(_) => panic!("manifest should have been rejected:\n{manifest_text}"),
            Err(e) => e,
        }
    }

    #[test]
    fn files_in_the_folder_that_commands_use_are_named_as_outside_the_hash() {
        let scratch = Scratch::new("manifest-unhashed");
        let dir = scratch.root.join("p");
        let extra = concat!(
            "[[sources]]\nid = \"helper\"\ncommand = [\"sh\", \"helper.sh\"]\n",
            "[[sources]]\nid = \"local\"\ncommand = [\"./run\", \"--flag\", \"notes.txt\"]\n",
            "[[sources]]\nid = \"plain\"\ncommand = [\"cat\", \"/proc/loadavg\", \"client.js\", \"pulse-plugin.toml\"]\n",
            "[[actions]]\nid = \"go\"\nlabel = \"Go\"\ncommand = [\"run\", \"missing.sh\", \"{arg}\"]\narg_pattern = \"[a-z]+\"\n",
        );
        write_plugin(
            &dir,
            &manifest("p", "client.js", r#"["drawer"]"#, extra),
            "export default {}",
        );
        for name in ["helper.sh", "run", "notes.txt"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        let loaded = load(&dir).unwrap();
        let named: Vec<&str> = loaded
            .unhashed
            .iter()
            .map(|line| {
                line.split(" uses ")
                    .nth(1)
                    .and_then(|rest| rest.split(' ').next())
                    .unwrap()
            })
            .collect();
        // The hashed files, a program found on PATH, a missing file, an option
        // and the placeholder are not named; files the commands use are.
        assert_eq!(
            named,
            ["helper.sh", "./run", "notes.txt"],
            "{:?}",
            loaded.unhashed
        );
        assert!(loaded.unhashed[0].starts_with("source helper uses helper.sh"));
    }

    fn source(extra: &str) -> String {
        manifest(
            "p",
            "client.js",
            r#"["drawer"]"#,
            &format!("[[sources]]\nid = \"s\"\ncommand = [\"x\"]\n{extra}\n"),
        )
    }

    #[test]
    fn a_complete_manifest_loads_with_source_defaults_applied() {
        let text = manifest(
            "host-usage",
            "client.js",
            r#"["drawer", "page"]"#,
            "description = \"  Load  \"\n[[sources]]\nid = \"load\"\ncommand = [\"cat\", \"/proc/loadavg\"]\n",
        );
        let loaded = try_load(&text, Some(b"export default {}")).unwrap();
        assert_eq!(loaded.id, "host-usage");
        assert_eq!(loaded.description, "Load");
        assert_eq!(loaded.slots, ["drawer", "page"]);
        assert_eq!(loaded.sources.len(), 1);
        assert_eq!(loaded.sources[0].command, ["cat", "/proc/loadavg"]);
        assert_eq!(loaded.sources[0].interval_s, 30);
        assert_eq!(loaded.sources[0].timeout_s, 5);
    }

    #[test]
    fn unknown_keys_are_rejected_at_every_level() {
        let top = manifest("p", "client.js", r#"["drawer"]"#, "colour = \"red\"\n");
        assert!(err_of(&top).contains("colour"), "{}", err_of(&top));
        let nested = source("intervall_s = 5");
        assert!(
            err_of(&nested).contains("intervall_s"),
            "{}",
            err_of(&nested)
        );
    }

    #[test]
    fn schema_must_be_exactly_one() {
        let text =
            manifest("p", "client.js", r#"["drawer"]"#, "").replace("schema = 1", "schema = 2");
        assert!(err_of(&text).contains("schema"));
    }

    #[test]
    fn plugin_ids_follow_the_documented_pattern() {
        let long_ok = format!("a{}", "b".repeat(63));
        let long_bad = format!("a{}", "b".repeat(64));
        // The fixture's generated name embeds the id, which would trip the
        // 64-character name rule for a long id; pin a short name so only the id is tested.
        let with_id = |id: &str| {
            manifest(id, "client.js", r#"["drawer"]"#, "")
                .replace(&format!("name = \"Test {id}\""), "name = \"Short\"")
        };
        for good in ["a", "0x", "host-usage", "a.b_c-d", long_ok.as_str()] {
            let result = try_load(&with_id(good), Some(b"x"));
            assert!(result.is_ok(), "{good} should be valid: {result:?}");
        }
        for bad in [
            "",
            "Upper",
            "-x",
            ".x",
            "a b",
            "a/b",
            "é",
            // TOML escape for a real ESC: the id pattern must refuse it.
            "a\\u001bb",
            long_bad.as_str(),
        ] {
            let err = try_load(&with_id(bad), Some(b"x")).unwrap_err();
            assert!(
                err.starts_with("id "),
                "{bad:?} rejected for the wrong reason: {err}"
            );
        }
    }

    #[test]
    fn name_version_and_description_lengths_are_enforced_after_trimming() {
        let blank_name = manifest("p", "client.js", r#"["drawer"]"#, "").replace("Test p", "   ");
        assert!(err_of(&blank_name).contains("name"));
        let long_description = manifest(
            "p",
            "client.js",
            r#"["drawer"]"#,
            &format!("description = \"{}\"\n", "d".repeat(201)),
        );
        assert!(err_of(&long_description).contains("description"));
        let max_description = manifest(
            "p",
            "client.js",
            r#"["drawer"]"#,
            &format!("description = \"{}\"\n", "d".repeat(200)),
        );
        assert!(try_load(&max_description, Some(b"x")).is_ok());
    }

    #[test]
    fn client_must_be_a_bare_file_name() {
        for bad in [
            "sub/client.js",
            "..\\client.js",
            "../client.js",
            "a..js",
            "/etc/passwd",
        ] {
            let text = manifest("p", bad, r#"["drawer"]"#, "");
            let err = err_of(&text);
            assert!(err.contains("client"), "{bad}: {err}");
        }
    }

    #[test]
    fn a_missing_client_file_is_reported_by_name() {
        let text = manifest("p", "client.js", r#"["drawer"]"#, "");
        let err = try_load(&text, None).unwrap_err();
        assert!(err.contains("client.js"), "{err}");
    }

    #[test]
    fn client_size_limit_is_inclusive() {
        let text = manifest("p", "client.js", r#"["drawer"]"#, "");
        assert!(try_load(&text, Some(&vec![b'a'; 262_144])).is_ok());
        let err = try_load(&text, Some(&vec![b'a'; 262_145])).unwrap_err();
        assert!(err.contains("262144"), "{err}");
    }

    #[test]
    fn a_client_that_is_not_utf8_is_refused() {
        let text = manifest("p", "client.js", r#"["drawer"]"#, "");
        let err = try_load(&text, Some(&[0xff, 0xfe, 0x00])).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
    }

    #[test]
    fn slots_must_be_non_empty_known_and_unique() {
        let empty = manifest("p", "client.js", "[]", "");
        assert!(err_of(&empty).contains("slots"));
        let unknown = manifest("p", "client.js", r#"["drawer", "sidebar"]"#, "");
        assert!(err_of(&unknown).contains("sidebar"));
        let dup = manifest("p", "client.js", r#"["page", "drawer", "page"]"#, "");
        assert!(err_of(&dup).contains("duplicate slot"));
    }

    #[test]
    fn source_interval_and_timeout_boundaries() {
        for (extra, ok) in [
            ("interval_s = 1", false),
            ("interval_s = 2", true),
            ("interval_s = 3600", true),
            ("interval_s = 3601", false),
            ("interval_s = -5", false),
            ("timeout_s = 0", false),
            ("timeout_s = 1", true),
            ("timeout_s = 30", true),
            ("timeout_s = 31", false),
        ] {
            let result = try_load(&source(extra), Some(b"x"));
            assert_eq!(result.is_ok(), ok, "{extra}: {result:?}");
        }
    }

    #[test]
    fn sources_are_capped_unique_and_argv_only() {
        let block = |id: &str| format!("[[sources]]\nid = \"{id}\"\ncommand = [\"x\"]\n");
        let nine: String = (0..9).map(|i| block(&format!("s{i}"))).collect();
        assert!(err_of(&manifest("p", "client.js", r#"["drawer"]"#, &nine)).contains("at most 8"));
        let eight: String = (0..8).map(|i| block(&format!("s{i}"))).collect();
        assert!(
            try_load(
                &manifest("p", "client.js", r#"["drawer"]"#, &eight),
                Some(b"x")
            )
            .is_ok()
        );

        let dup = format!("{}{}", block("a"), block("a"));
        assert!(
            err_of(&manifest("p", "client.js", r#"["drawer"]"#, &dup)).contains("duplicate source")
        );

        let empty_cmd = "[[sources]]\nid = \"a\"\ncommand = []\n";
        assert!(
            err_of(&manifest("p", "client.js", r#"["drawer"]"#, empty_cmd)).contains("command")
        );
        let empty_arg = "[[sources]]\nid = \"a\"\ncommand = [\"x\", \"\"]\n";
        assert!(
            err_of(&manifest("p", "client.js", r#"["drawer"]"#, empty_arg)).contains("command")
        );
        // A shell line is one string, not an argv: a bare string must not parse as a command.
        let shell_line = "[[sources]]\nid = \"a\"\ncommand = \"cat /proc/loadavg\"\n";
        assert!(
            try_load(
                &manifest("p", "client.js", r#"["drawer"]"#, shell_line),
                Some(b"x")
            )
            .is_err()
        );

        let long_id = block(&"s".repeat(33));
        assert!(
            err_of(&manifest("p", "client.js", r#"["drawer"]"#, &long_id)).contains("source id")
        );
        let dotted = block("a.b");
        assert!(
            err_of(&manifest("p", "client.js", r#"["drawer"]"#, &dotted)).contains("source id")
        );
        let escaped_id = block("a\\u001bb");
        assert!(
            err_of(&manifest("p", "client.js", r#"["drawer"]"#, &escaped_id)).contains("source id")
        );
    }

    #[test]
    fn syntax_errors_name_the_line_and_stay_on_one_line() {
        let err = err_of("schema = 1\nid = \n");
        assert!(err.contains("line 2"), "{err}");
        assert!(!err.contains('\n'), "{err}");
    }

    #[test]
    fn control_characters_in_displayed_text_are_rejected_naming_the_field() {
        // `\u001b` is TOML's escape for ESC; SGR conceal (`ESC[8m`) would hide review output.
        let base = manifest("p", "client.js", r#"["drawer"]"#, "");
        let version = base.replace("version = \"0.1.0\"", "version = \"1\\u001b[8m\"");
        assert!(
            err_of(&version).contains("version must not contain control characters"),
            "{}",
            err_of(&version)
        );
        let name = base.replace("Test p", "n\\u001b[8mx");
        assert!(
            err_of(&name).contains("name must not contain control characters"),
            "{}",
            err_of(&name)
        );
        let description = manifest(
            "p",
            "client.js",
            r#"["drawer"]"#,
            "description = \"line\\nbreak\"\n",
        );
        assert!(err_of(&description).contains("description must not contain control characters"));
        let command = manifest(
            "p",
            "client.js",
            r#"["drawer"]"#,
            "[[sources]]\nid = \"a\"\ncommand = [\"x\", \"\\u001b[8m\"]\n",
        );
        assert!(
            err_of(&command).contains("command must not contain control characters"),
            "{}",
            err_of(&command)
        );
        // Bidi overrides reorder text on screen without being "control" characters.
        let bidi = base.replace("version = \"0.1.0\"", "version = \"1\\u202e0\"");
        assert!(err_of(&bidi).contains("version"));
    }

    #[test]
    fn parser_messages_cannot_carry_raw_control_characters() {
        // The key itself holds an ESC; the toml crate quotes it in its message.
        let err = err_of("schema = 1\n\"bad\\u001b[8m\" = 1\n");
        assert!(!err.chars().any(char::is_control), "{err:?}");
    }

    #[test]
    fn the_hash_covers_both_files_and_their_boundary() {
        let h = content_hash(b"manifest", b"client");
        assert_eq!(h.len(), 64);
        assert!(
            h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_ne!(h, content_hash(b"manifest", b"client2"));
        assert_ne!(h, content_hash(b"manifest2", b"client"));
        assert_ne!(content_hash(b"ab", b"c"), content_hash(b"a", b"bc"));
    }

    #[test]
    fn load_hashes_the_bytes_it_served() {
        let scratch = Scratch::new("hash");
        let dir = scratch.root.join("p");
        let text = manifest("p", "client.js", r#"["drawer"]"#, "");
        write_plugin(&dir, &text, "one");
        let first = load(&dir).unwrap();
        assert_eq!(first.hash, content_hash(text.as_bytes(), b"one"));
        write_plugin(&dir, &text, "two");
        assert_ne!(load(&dir).unwrap().hash, first.hash);
    }

    #[test]
    fn lenient_id_survives_an_otherwise_invalid_manifest() {
        let scratch = Scratch::new("lenient");
        let dir = scratch.root.join("p");
        write_plugin(&dir, "id = \"kept\"\nnonsense = true\n", "x");
        assert_eq!(lenient_id(&dir).as_deref(), Some("kept"));
        write_plugin(&dir, "id = \"Bad Id\"\n", "x");
        assert_eq!(lenient_id(&dir), None);
    }

    fn loaded(text: &str) -> Loaded {
        try_load(text, Some(b"x")).unwrap_or_else(|e| panic!("{e}\n{text}"))
    }

    fn with_extra(slots: &str, extra: &str) -> String {
        manifest("p", "client.js", slots, extra)
    }

    fn with_option(extra: &str) -> String {
        with_extra(
            r#"["drawer"]"#,
            &format!("[[options]]\nid = \"o\"\nlabel = \"O\"\n{extra}\n"),
        )
    }

    fn with_action(extra: &str) -> String {
        with_extra(
            r#"["drawer"]"#,
            &format!("[[actions]]\nid = \"a\"\nlabel = \"A\"\n{extra}\n"),
        )
    }

    #[test]
    fn every_slot_is_accepted_and_permissions_are_a_closed_unique_list() {
        let slots = r#"["composer.status", "composer.actions", "drawer", "page", "session.row", "session.menu"]"#;
        assert_eq!(loaded(&with_extra(slots, "")).slots.len(), 6);
        let all = with_extra(
            r#"["transcript.tool", "transcript.message"]"#,
            "tools = [\"t\"]\nmessages = [\"m\"]\n",
        );
        assert_eq!(
            loaded(&all).slots,
            ["transcript.tool", "transcript.message"]
        );

        let perms = with_extra(
            r#"["drawer"]"#,
            "permissions = [\"session.read\", \"session.compose\", \"session.prompt\", \"session.bash\", \"session.rpc\"]\n",
        );
        let loaded_perms = loaded(&perms).permissions;
        assert_eq!(loaded_perms.len(), 5);
        assert_eq!(loaded_perms[0], "session.read");
        let unknown = with_extra(r#"["drawer"]"#, "permissions = [\"session.delete\"]\n");
        assert!(err_of(&unknown).contains("session.delete"));
        let dup = with_extra(
            r#"["drawer"]"#,
            "permissions = [\"session.read\", \"session.read\"]\n",
        );
        assert!(err_of(&dup).contains("duplicate permission"));
    }

    #[test]
    fn claims_are_required_exactly_when_their_slot_is_declared() {
        let tool_slot = r#"["transcript.tool"]"#;
        assert!(err_of(&with_extra(tool_slot, "")).contains("tools"));
        assert!(err_of(&with_extra(tool_slot, "tools = []\n")).contains("tools"));
        // Claims without the slot that uses them are refused, not ignored.
        let stray = with_extra(r#"["drawer"]"#, "tools = [\"x\"]\n");
        assert!(err_of(&stray).contains("tools is only allowed"));
        let message_slot = r#"["transcript.message"]"#;
        assert!(err_of(&with_extra(message_slot, "")).contains("messages"));
        let crossed = with_extra(tool_slot, "tools = [\"x\"]\nmessages = [\"y\"]\n");
        assert!(err_of(&crossed).contains("messages is only allowed"));

        let good = with_extra(
            tool_slot,
            "tools = [\"schedule_*\", \"mcp__cron__list\", \"a.b/c:d-e\"]\n",
        );
        assert_eq!(
            loaded(&good).tools,
            ["schedule_*", "mcp__cron__list", "a.b/c:d-e"]
        );
    }

    #[test]
    fn claim_patterns_use_a_closed_character_set_and_length() {
        let tool_slot = r#"["transcript.tool"]"#;
        let bad_chars = ["has space", "a?b", "a[b]", "é", "a\\\\b", ""];
        for bad in bad_chars {
            let text = with_extra(tool_slot, &format!("tools = [\"{bad}\"]\n"));
            let err = err_of(&text);
            assert!(err.contains("tools entry"), "{bad:?}: {err}");
        }
        let long = "a".repeat(65);
        assert!(
            err_of(&with_extra(tool_slot, &format!("tools = [\"{long}\"]\n")))
                .contains("tools entry")
        );
        let max = "a".repeat(64);
        loaded(&with_extra(tool_slot, &format!("tools = [\"{max}\"]\n")));

        let sixteen: Vec<String> = (0..16).map(|i| format!("\"t{i}\"")).collect();
        loaded(&with_extra(
            tool_slot,
            &format!("tools = [{}]\n", sixteen.join(", ")),
        ));
        let seventeen: Vec<String> = (0..17).map(|i| format!("\"t{i}\"")).collect();
        let err = err_of(&with_extra(
            tool_slot,
            &format!("tools = [{}]\n", seventeen.join(", ")),
        ));
        assert!(err.contains("at most 16"), "{err}");
    }

    #[test]
    fn options_get_typed_defaults() {
        let flag = loaded(&with_option("type = \"bool\""));
        assert_eq!(flag.options[0].default, serde_json::json!(false));
        let on = loaded(&with_option("type = \"bool\"\ndefault = true"));
        assert_eq!(on.options[0].default, serde_json::json!(true));
        let choice = loaded(&with_option(
            "type = \"choice\"\nchoices = [\"70\", \"80\"]",
        ));
        assert_eq!(choice.options[0].default, serde_json::json!("70"));
        let picked = loaded(&with_option(
            "type = \"choice\"\nchoices = [\"70\", \"80\"]\ndefault = \"80\"",
        ));
        assert_eq!(picked.options[0].default, serde_json::json!("80"));
        let text = loaded(&with_option("type = \"text\""));
        assert_eq!(text.options[0].default, serde_json::json!(""));
        assert_eq!(text.options[0].kind.as_str(), "text");
    }

    #[test]
    fn option_schemas_are_checked_against_their_type() {
        for (extra, field) in [
            ("type = \"bool\"\ndefault = \"yes\"", "default"),
            ("type = \"text\"\ndefault = true", "default"),
            (
                "type = \"choice\"\nchoices = [\"a\"]\ndefault = 5",
                "default",
            ),
            (
                "type = \"choice\"\nchoices = [\"a\", \"b\"]\ndefault = \"c\"",
                "default",
            ),
            ("type = \"choice\"", "choices"),
            ("type = \"choice\"\nchoices = []", "choices"),
            (
                "type = \"choice\"\nchoices = [\"a\", \"a\"]",
                "duplicate choice",
            ),
            ("type = \"bool\"\nchoices = [\"a\"]", "choices"),
            ("type = \"text\"\nchoices = [\"a\"]", "choices"),
            ("type = \"number\"", "type"),
        ] {
            let err = err_of(&with_option(extra));
            assert!(err.contains(field), "{extra}: {err}");
            assert!(err.contains("option \"o\""), "{extra}: {err}");
        }
        let long_default = format!("type = \"text\"\ndefault = \"{}\"", "d".repeat(201));
        assert!(err_of(&with_option(&long_default)).contains("default"));
        loaded(&with_option(&format!(
            "type = \"text\"\ndefault = \"{}\"",
            "d".repeat(200)
        )));

        let twenty_one: Vec<String> = (0..21).map(|i| format!("\"c{i}\"")).collect();
        let err = err_of(&with_option(&format!(
            "type = \"choice\"\nchoices = [{}]",
            twenty_one.join(", ")
        )));
        assert!(err.contains("1 to 20"), "{err}");
    }

    #[test]
    fn option_ids_labels_and_counts_are_limited() {
        let block =
            |id: &str| format!("[[options]]\nid = \"{id}\"\nlabel = \"L\"\ntype = \"bool\"\n");
        let dup = format!("{}{}", block("a"), block("a"));
        assert!(err_of(&with_extra(r#"["drawer"]"#, &dup)).contains("duplicate option id"));
        assert!(err_of(&with_extra(r#"["drawer"]"#, &block("Bad"))).contains("option id"));
        let sixteen: String = (0..16).map(|i| block(&format!("o{i}"))).collect();
        assert_eq!(
            loaded(&with_extra(r#"["drawer"]"#, &sixteen)).options.len(),
            16
        );
        let seventeen: String = (0..17).map(|i| block(&format!("o{i}"))).collect();
        assert!(err_of(&with_extra(r#"["drawer"]"#, &seventeen)).contains("at most 16"));
        let blank = with_option("type = \"bool\"").replace("label = \"O\"", "label = \"  \"");
        assert!(err_of(&blank).contains("label"));
        let escape =
            with_option("type = \"bool\"").replace("label = \"O\"", "label = \"\\u001b[8m\"");
        assert!(err_of(&escape).contains("must not contain control characters"));
    }

    #[test]
    fn an_action_with_an_argument_needs_a_pattern_and_vice_versa() {
        let good = with_action(
            "command = [\"systemctl\", \"--user\", \"start\", \"{arg}\"]\narg_pattern = '[A-Za-z0-9@._:-]+\\.service'",
        );
        let action = &loaded(&good).actions[0];
        assert_eq!(action.timeout_s, 30);
        assert_eq!(action.command[3], "{arg}");
        assert!(action.arg_pattern.is_some());

        let missing = with_action("command = [\"x\", \"{arg}\"]");
        assert!(err_of(&missing).contains("arg_pattern is required"));
        let stray = with_action("command = [\"x\"]\narg_pattern = 'a+'");
        assert!(err_of(&stray).contains("arg_pattern is only allowed"));
        let twice = with_action("command = [\"x\", \"{arg}\", \"{arg}\"]\narg_pattern = 'a+'");
        assert!(err_of(&twice).contains("only once"));
        // `--unit={arg}` would splice text into an element the pattern cannot police.
        let glued = with_action("command = [\"x\", \"--unit={arg}\"]\narg_pattern = 'a+'");
        assert!(err_of(&glued).contains("element of its own"));
    }

    #[test]
    fn arg_patterns_must_compile_and_match_the_whole_argument() {
        let broken = with_action("command = [\"x\", \"{arg}\"]\narg_pattern = '('");
        assert!(err_of(&broken).contains("arg_pattern"));
        // Wrapped naively as ^(?:...)$ this would parse as `^(?:a)` OR `(b)$`.
        let escape_the_group = with_action("command = [\"x\", \"{arg}\"]\narg_pattern = 'a)|(b'");
        assert!(err_of(&escape_the_group).contains("arg_pattern"));
        let huge = with_action("command = [\"x\", \"{arg}\"]\narg_pattern = '(a{1000}){1000}'");
        assert!(err_of(&huge).contains("arg_pattern"));
        let long = format!(
            "command = [\"x\", \"{{arg}}\"]\narg_pattern = '{}'",
            "a".repeat(201)
        );
        assert!(err_of(&with_action(&long)).contains("arg_pattern"));

        let matcher = compile_arg_pattern("[a-z]+").unwrap();
        assert!(matcher.is_match("abc"));
        assert!(!matcher.is_match("abc1"));
        assert!(!matcher.is_match("1abc"));
        let alternation = compile_arg_pattern("a|b").unwrap();
        assert!(alternation.is_match("b"));
        assert!(
            !alternation.is_match("xb"),
            "alternatives are anchored together"
        );
    }

    #[test]
    fn action_timeouts_ids_and_text_are_limited() {
        for (value, ok) in [(0, false), (1, true), (120, true), (121, false)] {
            let text = with_action(&format!("command = [\"x\"]\ntimeout_s = {value}"));
            assert_eq!(
                try_load(&text, Some(b"x")).is_ok(),
                ok,
                "timeout_s = {value}"
            );
        }
        let long_label = with_action("command = [\"x\"]")
            .replace("label = \"A\"", &format!("label = \"{}\"", "l".repeat(81)));
        assert!(err_of(&long_label).contains("label"));
        let escape = with_action("command = [\"x\", \"\\u001b[8m\"]");
        assert!(err_of(&escape).contains("command must not contain control characters"));
        let empty = with_action("command = []");
        assert!(err_of(&empty).contains("command"));

        let block =
            |id: &str| format!("[[actions]]\nid = \"{id}\"\nlabel = \"L\"\ncommand = [\"x\"]\n");
        let dup = format!("{}{}", block("a"), block("a"));
        assert!(err_of(&with_extra(r#"["drawer"]"#, &dup)).contains("duplicate action id"));
        let nine: String = (0..9).map(|i| block(&format!("a{i}"))).collect();
        assert!(err_of(&with_extra(r#"["drawer"]"#, &nine)).contains("at most 8"));
    }
}
