//! The read-only command and model catalogues: answered by any live child in
//! the project or a short-lived unregistered one, cached in memory and on disk.

use super::*;
use crate::metrics;

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tracing::debug;

/// How long a fetched command catalogue stays usable. It changes only when the
/// omp build or the project's own command files change, so a cache keeps the
/// palette instant without keeping a ~270MB child alive to answer it. 30
/// minutes, not 5: each miss boots a full omp child (~1 s CPU), and the palette
/// is fetched on every chat open, so 5 minutes spawned one on most opens.
const CATALOGUE_TTL_MS: u64 = 30 * 60 * 1000;

/// Command catalogues keyed by command + cwd, with the unix-ms time they were
/// fetched. Process-wide because the answer does not belong to any one
/// session, which is the whole point of fetching it this way. Mirrored on disk
/// (`catalogue_dir`) so a restart does not cost a child boot per project, and
/// so a full pool can still answer from the last known catalogue.
static CATALOGUE: std::sync::LazyLock<Mutex<HashMap<String, (u64, Value)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// One in-flight fetch per catalogue key: concurrent misses (several phones,
/// the palette and model picker opening together) queued a child EACH.
static CATALOGUE_INFLIGHT: std::sync::LazyLock<
    Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn catalogue_file(dir: &Path, key: &str) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(key.as_bytes());
    let name: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{name}.json"))
}

/// The catalogue for `key`: memory first, then the disk mirror (which also
/// refills memory). `fresh_only` drops answers older than the TTL; a full
/// pool asks for any age, because last hour's command list beats none.
fn catalogue_lookup(dir: &Path, key: &str, fresh_only: bool, now: u64) -> Option<Value> {
    let fresh = |fetched: u64| !fresh_only || now.saturating_sub(fetched) < CATALOGUE_TTL_MS;
    if let Some((fetched, commands)) = lock_poisoned(&CATALOGUE).get(key)
        && fresh(*fetched)
    {
        return Some(commands.clone());
    }
    let bytes = std::fs::read(catalogue_file(dir, key)).ok()?;
    let stored: Value = serde_json::from_slice(&bytes).ok()?;
    // The file name is a hash prefix: the stored key is the real identity.
    if stored.get("key").and_then(Value::as_str) != Some(key) {
        return None;
    }
    let fetched = stored.get("fetchedAt").and_then(Value::as_u64)?;
    let commands = stored.get("data")?.clone();
    {
        let mut map = lock_poisoned(&CATALOGUE);
        let newer_in_memory = map.get(key).is_some_and(|(at, _)| *at >= fetched);
        if !newer_in_memory {
            map.insert(key.to_string(), (fetched, commands.clone()));
        }
    }
    fresh(fetched).then_some(commands)
}

/// Remember a fetched catalogue in memory and, best-effort, on disk (written
/// to a temp file and renamed, so a reader never sees half a catalogue).
fn catalogue_store(dir: &Path, key: &str, commands: Value, now: u64) {
    let stored = json!({ "key": key, "fetchedAt": now, "data": commands });
    lock_poisoned(&CATALOGUE).insert(key.to_string(), (now, commands));
    let path = catalogue_file(dir, key);
    let tmp = path.with_extension("json.tmp");
    let written = std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&tmp, stored.to_string()))
        .and_then(|()| std::fs::rename(&tmp, &path));
    if let Err(e) = written {
        debug!(path = %path.display(), error = %e, "catalogue cache not persisted");
    }
}

fn merge_prompt_templates(data: &mut Value, templates: Value) {
    let Some(commands) = data.get_mut("commands").and_then(Value::as_array_mut) else {
        return;
    };
    let mut names = std::collections::HashSet::new();
    for command in commands.iter() {
        if let Some(name) = command.get("name").and_then(Value::as_str) {
            names.insert(name.to_string());
        }
        if let Some(aliases) = command.get("aliases").and_then(Value::as_array) {
            names.extend(aliases.iter().filter_map(Value::as_str).map(str::to_string));
        }
    }
    if let Some(templates) = templates.get("templates").and_then(Value::as_array) {
        for template in templates {
            if let Some(name) = template.get("name").and_then(Value::as_str)
                && !name.is_empty()
                && names.insert(name.to_string())
            {
                commands.push(template.clone());
            }
        }
    }
}

impl ChildManager {
    /// Read-only catalogues belong to the omp BUILD and to the project's own
    /// files, not to a session: a child answers `get_available_commands` and
    /// `get_available_models` with NO session bound at all (measured: 130
    /// commands in about a second). Routing those queries through the session's
    /// exclusive child left the phone with an empty command palette and an empty
    /// model picker in the NORMAL case, because the desktop holds the session
    /// file open and the ownership guard refuses. The answer is cached per cwd
    /// and command, in memory and on disk.
    ///
    /// Order on a miss: a live child already in this project (any session,
    /// even mid-turn: the query is read-only), else a short-lived,
    /// never-registered child in the cwd if the pool has room. A full pool
    /// never boots one: it answers from this project's cached catalogue of any
    /// age, then refuses. Another project's models and commands are not evidence
    /// of availability here.
    ///
    /// Returns the response's `data` object as-is; callers pick the field they
    /// need. Only pass commands whose answer is independent of WHICH session
    /// asks (see `CATALOGUE_RPC_COMMANDS`).
    pub async fn catalogue_rpc(&self, cwd: &str, command: &str) -> Result<Value, String> {
        // Old command caches predate prompt-template discovery.
        let version = if command == "get_available_commands" {
            "templates-v1"
        } else {
            "v1"
        };
        let key = format!("{command}\u{0}{version}\u{0}{cwd}");
        let dir = self.catalogue_dir();
        if let Some(hit) = catalogue_lookup(&dir, &key, true, now_ms()) {
            metrics::inc("catalogue_cache_hit");
            return Ok(hit);
        }
        let gate = Arc::clone(
            lock_poisoned(&CATALOGUE_INFLIGHT)
                .entry(key.clone())
                .or_default(),
        );
        let _fetching = gate.lock().await;
        if let Some(hit) = catalogue_lookup(&dir, &key, true, now_ms()) {
            metrics::inc("catalogue_cache_hit");
            return Ok(hit);
        }
        let normalize = |data: Value| match data {
            Value::Null => Value::Object(serde_json::Map::new()),
            other => other,
        };
        if let Some(child) = self.live_child(|c| c.cwd == cwd) {
            let binding = lock_poisoned(&child.session).clone();
            if let Ok(data) = self
                .rpc_on_bound(&child, &binding, command, Value::Null, RPC_TIMEOUT)
                .await
            {
                let data = self
                    .augment_command_catalogue(&child, &binding, command, normalize(data))
                    .await?;
                catalogue_store(&dir, &key, data.clone(), now_ms());
                metrics::inc("catalogue_from_live_child");
                return Ok(data);
            }
        }
        let fetched = match self.try_reserve().await {
            Some(reserved) => {
                let (child, scope) = self.spawn_ephemeral(cwd, reserved)?;
                let outcome = async {
                    self.rpc_on(
                        &child,
                        "negotiate_protocol",
                        json!({ "protocolVersion": 2 }),
                        NEGOTIATE_TIMEOUT,
                    )
                    .await?;
                    let data = self
                        .rpc_on(&child, command, Value::Null, RPC_TIMEOUT)
                        .await?;
                    self.augment_command_catalogue(&child, "", command, data)
                        .await
                }
                .await;
                // This child exists for exactly one question: it is never
                // registered, so nothing can route to it, and it dies here
                // whether the query worked or not.
                // Cancellation also closes this scope. The monitor owns the
                // admission charge until it observes the process reaped.
                drop(scope);
                Some(outcome)
            }
            None => None,
        };
        let failure = match fetched {
            Some(Ok(data)) => {
                let data = normalize(data);
                catalogue_store(&dir, &key, data.clone(), now_ms());
                metrics::inc("catalogue_fetched");
                return Ok(data);
            }
            Some(Err(e)) => e,
            None => self.busy_error(),
        };
        // A historical model list is not confirmed availability: project model
        // configuration and credentials can change while the pool is full.
        if command == "get_available_models" {
            return Err(failure);
        }
        if let Some(stale) = catalogue_lookup(&dir, &key, false, now_ms()) {
            metrics::inc("catalogue_stale_hit");
            return Ok(stale);
        }
        Err(failure)
    }

    /// Native command discovery omits prompt templates. Only call a metadata
    /// command whose exact name was advertised by this owner.
    async fn augment_command_catalogue(
        &self,
        child: &Arc<Child>,
        binding: &str,
        command: &str,
        mut data: Value,
    ) -> Result<Value, String> {
        if command != "get_available_commands"
            || !extension::catalogue_has_command(&data, "pulse-command-templates")
        {
            return Ok(data);
        }
        let templates = self
            .extension_call(
                child,
                binding,
                "pulse-command-templates",
                json!({}),
                RPC_TIMEOUT,
            )
            .await?;
        merge_prompt_templates(&mut data, templates);
        Ok(data)
    }

    /// Where catalogues persist across restarts.
    fn catalogue_dir(&self) -> std::path::PathBuf {
        self.config.state_dir.join("catalogues")
    }

    /// A live, registered child matching `pick`, preferring an idle one so a
    /// query does not queue behind a running turn's own RPCs.
    fn live_child(&self, pick: impl Fn(&Child) -> bool) -> Option<Arc<Child>> {
        let map = lock_poisoned(&self.children);
        let now = now_ms();
        let mut found: Option<&Arc<Child>> = None;
        for c in map.values() {
            if !c.alive.load(Ordering::SeqCst) || !pick(c.as_ref()) {
                continue;
            }
            if !child_busy(c, now) {
                return Some(Arc::clone(c));
            }
            found.get_or_insert(c);
        }
        found.cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn model_lookup_refuses_other_projects_and_expired_target_models_when_full() {
        let root = std::env::temp_dir().join(format!(
            "pulse-model-project-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let config = crate::types::Config {
            host: "127.0.0.1".into(),
            port: 0,
            sessions_root: root.join("sessions"),
            omp_bin: root.join("must-not-spawn"),
            public_dir: None,
            token_hash: None,
            max_children: 1,
            push_store_path: root.join("push.json"),
            vapid_path: root.join("vapid.json"),
            state_dir: root.join("state"),
            home: root.clone(),
            watch_interval_ms: 250,
            ws_queue_cap: 4,
            ws_queue_bytes: 1 << 20,
            child_idle_secs: 900,
            child_unwatched_secs: 300,
            child_rss_mb: 0,
            child_lean_js: false,
            prewarm_on_attach: false,
            owner_cache_ms: 3000,
            ws_deflate_min: 4096,
            paths: Arc::new(crate::paths::Paths::default()),
            asr_python: None,
            asr_model_dir: None,
            asr_threads: 1,
        };
        // As in rpc's routing fixtures: no startup materialisation, ticker or
        // OMP runtime. The sole foreign-project child is a disposable cat.
        let manager = ChildManager {
            config: Arc::new(config),
            tx: tokio::sync::broadcast::channel(8).0,
            children: Arc::new(Mutex::new(HashMap::new())),
            opening: Arc::new(Mutex::new(HashMap::new())),
            occupied: Arc::new(AtomicUsize::new(1)),
            physical: Arc::new(registered::Registry::new()),
            admission: Mutex::new(()),
            retarget_lock: AsyncMutex::new(()),
            next_id: AtomicU64::new(0),
            next_source_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            viewers: std::sync::OnceLock::new(),
            work_children: Arc::new(Mutex::new(Vec::new())),
            extra_work: Arc::new(AtomicUsize::new(0)),
            busy_wake: Arc::new(Notify::new()),
            busy_rx: tokio::sync::watch::channel(BusyState::default()).1,
            child_added: Notify::new(),
        };
        let child = super::super::tests::stand_in_child();
        child.streaming.store(true, Ordering::SeqCst);
        lock_poisoned(&manager.children).insert("/synthetic/other-session".to_string(), child);
        let cwd = root.join("target").to_string_lossy().into_owned();
        let key = format!("get_available_models\u{0}v1\u{0}{cwd}");
        for stale in [false, true] {
            if stale {
                catalogue_store(
                    &manager.catalogue_dir(),
                    &key,
                    json!({"models":[{"provider":"old","id":"removed"}]}),
                    now_ms().saturating_sub(CATALOGUE_TTL_MS),
                );
            }
            let result = tokio::time::timeout(
                Duration::from_millis(250),
                manager.catalogue_rpc(&cwd, "get_available_models"),
            )
            .await
            .expect("must refuse without querying another project");
            assert!(result.is_err());
        }
        lock_poisoned(&CATALOGUE).remove(&key);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn template_catalogue_keeps_native_commands_aliases_and_first_template() {
        let mut data = json!({"commands": [{"name": "native", "aliases": ["alias"]}]});
        merge_prompt_templates(
            &mut data,
            json!({"templates": [
                {"name": "native", "source": "prompt"},
                {"name": "alias", "source": "prompt"},
                {"name": "review", "description": "first", "input": {"hint": "arguments"}, "source": "prompt"},
                {"name": "review", "description": "shadowed", "source": "prompt"}
            ]}),
        );
        assert_eq!(data["commands"].as_array().unwrap().len(), 2);
        assert_eq!(data["commands"][0]["name"], "native");
        assert_eq!(data["commands"][1]["description"], "first");
        assert_eq!(data["commands"][1]["input"]["hint"], "arguments");
    }

    #[test]
    fn catalogue_survives_a_restart_and_serves_stale_only_when_asked() {
        let dir = std::env::temp_dir().join(format!(
            "omp-pulse-catalogue-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let key = format!("get_available_commands\u{0}{}", dir.display());
        let fetched = 1_000_000u64;
        catalogue_store(&dir, &key, json!({"commands": [{"name": "plan"}]}), fetched);
        // A restart empties memory; the disk copy answers.
        lock_poisoned(&CATALOGUE).remove(&key);
        assert_eq!(
            catalogue_lookup(&dir, &key, true, fetched + 1_000),
            Some(json!({"commands": [{"name": "plan"}]}))
        );
        // Past the TTL it is stale: refused as fresh, served when the pool is
        // full and stale beats nothing.
        let later = fetched + CATALOGUE_TTL_MS;
        assert_eq!(catalogue_lookup(&dir, &key, true, later), None);
        lock_poisoned(&CATALOGUE).remove(&key);
        assert_eq!(catalogue_lookup(&dir, &key, true, later), None);
        assert_eq!(
            catalogue_lookup(&dir, &key, false, later),
            Some(json!({"commands": [{"name": "plan"}]}))
        );
        // Another key never reads this file.
        assert_eq!(
            catalogue_lookup(&dir, "other\u{0}/nowhere", false, later),
            None
        );
        lock_poisoned(&CATALOGUE).remove(&key);
        let _ = std::fs::remove_dir_all(dir);
    }
}
