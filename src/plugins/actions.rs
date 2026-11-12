//! Plugin actions: runs a host command a plugin declared in `[[actions]]` when
//! the owner taps something it drew, with at most one validated argument.
//!
//! WHY this is stricter than a source: an action does something (starts a
//! service) rather than reads something, and its trigger comes from a phone. So
//! the caller must name the hash it reviewed, the argument must match the
//! manifest's pattern in full before it reaches an argv, only one action per
//! plugin runs at a time, and the plugin is checked again after the wait for a
//! run slot. The argument is one argv element, never a shell line.
//!
//! Runs share the spawning code, the daemon-wide limit of concurrent runs and
//! the kill-without-unbounded-wait behaviour of sources (see `sources`), and are
//! never cached: asking twice runs twice.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use super::manifest::{ARG_PLACEHOLDER, compile_arg_pattern, has_unsafe_chars};
use super::registry::{PluginDirs, PluginError};
use super::sources::{RUNS, RunSpec, SourceReading, lookup_enabled, run};

/// Longest argument, in characters.
const ARG_MAX_CHARS: usize = 256;

/// Plugin ids with an action in flight. A std mutex, only ever held for set
/// bookkeeping and never across an `.await`.
static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// The claim on "this plugin is running an action", released on drop so a
/// cancelled request (client gone) frees it too.
struct ActionSlot(String);

impl ActionSlot {
    fn claim(plugin_id: &str) -> Option<ActionSlot> {
        let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        running
            .insert(plugin_id.to_owned())
            .then(|| ActionSlot(plugin_id.to_owned()))
    }
}

impl Drop for ActionSlot {
    fn drop(&mut self) {
        RUNNING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.0);
    }
}

/// Run one declared action of an ENABLED plugin whose current hash equals `expected_hash`
/// (else `HashMismatch`). `arg` must be given exactly when the command has `{arg}`, at most 256
/// characters, no control characters, and match `arg_pattern` in full; otherwise `Invalid`.
/// At most one action per plugin runs at a time (`ActionBusy`). Runs like a source (argv, no
/// shell, cwd = plugin folder, stdin closed, stderr discarded, env + OMP_PULSE_PLUGIN_ID,
/// OMP_PULSE_PLUGIN_DIR and OMP_PULSE_PLUGIN_ACTION = action id), shares the daemon-wide
/// limit of 4 concurrent runs, killed at `timeout_s`, stdout capped at 65536 bytes, never
/// cached. Re-checks enabled + hash after acquiring the run permit, as `read_source` does.
pub async fn run_action(
    dirs: &PluginDirs,
    plugin_id: &str,
    action_id: &str,
    expected_hash: &str,
    arg: Option<&str>,
) -> Result<SourceReading, PluginError> {
    let info = lookup_enabled(dirs, plugin_id).await?;
    // The caller names the hash it reviewed: a plugin edited and re-approved
    // since the phone loaded its catalogue must not run on the old say-so.
    if info.hash != expected_hash {
        return Err(PluginError::HashMismatch);
    }
    let action = info
        .actions
        .iter()
        .find(|a| a.id == action_id)
        .ok_or(PluginError::ActionNotFound)?;
    let argv = build_argv(&action.command, action.arg_pattern.as_deref(), arg)?;

    let _slot = ActionSlot::claim(&info.id).ok_or(PluginError::ActionBusy)?;
    let Ok(_permit) = RUNS.acquire().await else {
        return Err(PluginError::Io("source runner is shut down".to_owned()));
    };
    // Checked before waiting for the slot and the permit; switched off or edited
    // since must not get one last run.
    let current = lookup_enabled(dirs, plugin_id).await?;
    if current.hash != info.hash {
        return Err(PluginError::NotEnabled);
    }
    Ok(run(RunSpec {
        dir: &info.dir,
        plugin_id: &info.id,
        action_id: Some(&action.id),
        command: &argv,
        timeout_s: action.timeout_s,
        omp_bin: dirs.omp_bin.as_deref(),
    })
    .await)
}

/// The argv to run: the declared command with `{arg}` replaced by `arg` as ONE
/// element, after `arg` has been checked. Nothing here splits, quotes or
/// interprets the argument, so a space or `;` in it stays inside that element.
fn build_argv(
    command: &[String],
    pattern: Option<&str>,
    arg: Option<&str>,
) -> Result<Vec<String>, PluginError> {
    let invalid = |why: &str| PluginError::Invalid(why.to_owned());
    let takes_arg = command.iter().any(|part| part == ARG_PLACEHOLDER);
    let Some(arg) = arg else {
        return if takes_arg {
            Err(invalid("this action needs an argument"))
        } else {
            Ok(command.to_vec())
        };
    };
    if !takes_arg {
        return Err(invalid("this action takes no argument"));
    }
    if arg.chars().count() > ARG_MAX_CHARS {
        return Err(invalid("the argument is longer than 256 characters"));
    }
    if has_unsafe_chars(arg) {
        return Err(invalid("the argument must not contain control characters"));
    }
    let Some(pattern) = pattern else {
        return Err(invalid("this action has no argument pattern"));
    };
    let matcher = compile_arg_pattern(pattern).map_err(PluginError::Invalid)?;
    if !matcher.is_match(arg) {
        return Err(invalid(
            "the argument does not match what this action allows",
        ));
    }
    Ok(command
        .iter()
        .map(|part| {
            if part == ARG_PLACEHOLDER {
                arg.to_owned()
            } else {
                part.clone()
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::registry;
    use crate::plugins::testkit::{Scratch, enable, install_default};
    use std::path::PathBuf;

    /// Install and enable a plugin with one action `go`. `command` is a TOML
    /// array literal; `extra` adds action keys such as `arg_pattern`. Every test
    /// uses its own plugin id: the busy-slot table is process-wide.
    fn plugin(
        scratch: &Scratch,
        id: &str,
        command: &str,
        extra: &str,
    ) -> (PluginDirs, PathBuf, String) {
        let dirs = scratch.dirs();
        let dir = install_default(
            &dirs,
            id,
            &format!("[[actions]]\nid = \"go\"\nlabel = \"Go\"\ncommand = {command}\n{extra}\n"),
        );
        let hash = enable(&dirs, id);
        (dirs, dir, hash)
    }

    const MISSING: &str = "omp-pulse-no-such-program-xyz";

    #[tokio::test]
    async fn a_stale_hash_is_refused_even_though_the_plugin_is_enabled() {
        let scratch = Scratch::new("act-stale");
        let (dirs, dir, old_hash) = plugin(&scratch, "act-stale", &format!("[\"{MISSING}\"]"), "");
        assert!(matches!(
            run_action(&dirs, "act-stale", "go", &"0".repeat(64), None).await,
            Err(PluginError::HashMismatch)
        ));
        // Edited and re-approved after the caller loaded its catalogue.
        std::fs::write(dir.join("client.js"), "export default { v: 2 }").unwrap();
        let new_hash = registry::get(&dirs, "act-stale").unwrap().hash;
        registry::set_enabled(&dirs, "act-stale", true, Some(&new_hash)).unwrap();
        assert!(matches!(
            run_action(&dirs, "act-stale", "go", &old_hash, None).await,
            Err(PluginError::HashMismatch)
        ));
        let reading = run_action(&dirs, "act-stale", "go", &new_hash, None)
            .await
            .unwrap();
        assert!(reading.error.unwrap().contains(MISSING));
    }

    #[tokio::test]
    async fn only_enabled_plugins_and_declared_actions_run() {
        let scratch = Scratch::new("act-gate");
        let dirs = scratch.dirs();
        install_default(
            &dirs,
            "act-gate",
            &format!("[[actions]]\nid = \"go\"\nlabel = \"Go\"\ncommand = [\"{MISSING}\"]\n"),
        );
        let hash = registry::get(&dirs, "act-gate").unwrap().hash;
        assert!(matches!(
            run_action(&dirs, "act-gate", "go", &hash, None).await,
            Err(PluginError::NotEnabled)
        ));
        assert!(matches!(
            run_action(&dirs, "nobody", "go", &hash, None).await,
            Err(PluginError::NotFound)
        ));
        registry::set_enabled(&dirs, "act-gate", true, Some(&hash)).unwrap();
        assert!(matches!(
            run_action(&dirs, "act-gate", "other", &hash, None).await,
            Err(PluginError::ActionNotFound)
        ));
    }

    #[tokio::test]
    async fn the_argument_must_be_given_exactly_when_declared_and_match_in_full() {
        let scratch = Scratch::new("act-arg");
        let command = format!("[\"{MISSING}\", \"{{arg}}\"]");
        let (dirs, _, hash) = plugin(&scratch, "act-arg", &command, "arg_pattern = \"[a-z]+\"");
        let attempt = |arg: Option<String>| {
            let dirs = dirs.clone();
            let hash = hash.clone();
            async move { run_action(&dirs, "act-arg", "go", &hash, arg.as_deref()).await }
        };
        // Missing.
        assert!(matches!(attempt(None).await, Err(PluginError::Invalid(_))));
        // Matches only a prefix: the pattern is anchored at both ends.
        assert!(matches!(
            attempt(Some("abc1".into())).await,
            Err(PluginError::Invalid(_))
        ));
        assert!(matches!(
            attempt(Some("ABC".into())).await,
            Err(PluginError::Invalid(_))
        ));
        assert!(matches!(
            attempt(Some(String::new())).await,
            Err(PluginError::Invalid(_))
        ));
        // A fitting argument gets as far as starting the (missing) program.
        let reading = attempt(Some("abc".into())).await.unwrap();
        assert!(reading.error.unwrap().starts_with("could not start"));

        // An action with no {arg} takes none.
        let scratch = Scratch::new("act-noarg");
        let (dirs, _, hash) = plugin(&scratch, "act-noarg", &format!("[\"{MISSING}\"]"), "");
        assert!(matches!(
            run_action(&dirs, "act-noarg", "go", &hash, Some("x")).await,
            Err(PluginError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn arguments_over_the_length_cap_or_with_control_characters_are_refused() {
        let scratch = Scratch::new("act-argcap");
        let command = format!("[\"{MISSING}\", \"{{arg}}\"]");
        // A permissive pattern: only the daemon's own rules can refuse these.
        let (dirs, _, hash) = plugin(&scratch, "act-argcap", &command, "arg_pattern = \".*\"");
        let long = "a".repeat(257);
        assert!(matches!(
            run_action(&dirs, "act-argcap", "go", &hash, Some(&long)).await,
            Err(PluginError::Invalid(_))
        ));
        assert!(matches!(
            run_action(&dirs, "act-argcap", "go", &hash, Some("a\u{1b}[8m")).await,
            Err(PluginError::Invalid(_))
        ));
        let at_cap = "a".repeat(256);
        assert!(
            run_action(&dirs, "act-argcap", "go", &hash, Some(&at_cap))
                .await
                .is_ok()
        );
    }

    // The tests below run `sh`, so they are Unix-only.

    #[cfg(unix)]
    fn runs(dir: &std::path::Path) -> usize {
        std::fs::read_to_string(dir.join("runs.log"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_action_runs_each_time_it_is_asked_and_returns_stdout() {
        // Other tests swap PATH under the env lock; hold it so `sh` stays findable.
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("act-run");
        let (dirs, dir, hash) = plugin(
            &scratch,
            "act-run",
            r#"["sh", "-c", "echo run >> runs.log; echo \"$OMP_PULSE_PLUGIN_ACTION\""]"#,
            "",
        );
        let first = run_action(&dirs, "act-run", "go", &hash, None)
            .await
            .unwrap();
        assert!(first.ok, "{first:?}");
        assert_eq!(first.text, "go\n");
        run_action(&dirs, "act-run", "go", &hash, None)
            .await
            .unwrap();
        assert_eq!(runs(&dir), 2, "actions are never cached");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_argument_is_one_argv_element_never_a_shell_line() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("act-verbatim");
        // `sh -c 'printf %s "$1"' sh {arg}`: $1 is exactly the one element we pass.
        let (dirs, dir, hash) = plugin(
            &scratch,
            "act-verbatim",
            r#"["sh", "-c", "printf '%s' \"$1\"", "sh", "{arg}"]"#,
            "arg_pattern = \".*\"",
        );
        let arg = "two words; touch pwned $(touch pwned) `x` | y";
        let reading = run_action(&dirs, "act-verbatim", "go", &hash, Some(arg))
            .await
            .unwrap();
        assert!(reading.ok, "{reading:?}");
        assert_eq!(reading.text, arg);
        assert!(!dir.join("pwned").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_second_run_of_the_same_plugin_is_busy() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("act-busy");
        let (dirs, _, hash) = plugin(
            &scratch,
            "act-busy",
            r#"["sh", "-c", "sleep 1; echo done"]"#,
            "",
        );
        let (a, b) = tokio::join!(
            run_action(&dirs, "act-busy", "go", &hash, None),
            run_action(&dirs, "act-busy", "go", &hash, None),
        );
        let mut busy = 0;
        let mut done = 0;
        for result in [a, b] {
            match result {
                Err(PluginError::ActionBusy) => busy += 1,
                Ok(reading) => {
                    assert_eq!(reading.text, "done\n");
                    done += 1;
                }
                Err(other) => panic!("unexpected: {other}"),
            }
        }
        assert_eq!((busy, done), (1, 1));
        // The slot is free again afterwards.
        assert!(
            run_action(&dirs, "act-busy", "go", &hash, None)
                .await
                .is_ok()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_program_omp_means_the_daemons_own_omp_binary() {
        let _env = crate::paths::testenv::with_tool_path();
        let scratch = Scratch::new("act-omp");
        // `/bin/sh` stands in for omp: no executable has to be written, and
        // nothing named `omp` need exist on PATH.
        let (dirs, _, hash) = plugin(
            &scratch,
            "act-omp",
            r#"["omp", "-c", "echo from-fake-omp"]"#,
            "",
        );
        let dirs = dirs.with_omp_bin(Some(PathBuf::from("/bin/sh")));
        let reading = run_action(&dirs, "act-omp", "go", &hash, None)
            .await
            .unwrap();
        assert_eq!(reading.text, "from-fake-omp\n");
    }
}
