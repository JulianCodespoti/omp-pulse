//! `omp-pulse plugin <verb>`: manage plugin folders from the terminal.
//!
//! The CLI edits the plugin folder and the decision file directly. A running
//! daemon re-reads both on every request, so nothing needs signalling. Enabling
//! prints what the plugin will be allowed to do (its slots, the exact argv of
//! every host command and action, what it can see and do in conversations),
//! asks, and only then records the approval for the reviewed hash.

use std::io::{BufRead, IsTerminal, Write};

use omp_pulse::cli::{PluginArgs, PluginCommand};
use omp_pulse::paths::Paths;
use omp_pulse::plugins::{self, PluginDirs, PluginError, PluginInfo, PluginStatus};
use serde_json::{Map, Value};

pub fn run(args: PluginArgs) -> Result<(), String> {
    let paths = Paths::resolve()?;
    let dirs = PluginDirs::from_paths(&paths);
    match args.command {
        PluginCommand::Dir => {
            println!("{}", dirs.plugins_dir.display());
        }
        PluginCommand::List { json } => {
            let found = plugins::list(&dirs);
            if json {
                let text = serde_json::to_string_pretty(&found)
                    .map_err(|e| format!("could not encode the plugin list: {e}"))?;
                println!("{text}");
            } else {
                for info in &found {
                    println!("{}", list_line(info));
                }
            }
        }
        PluginCommand::Check { dir } => {
            let info = plugins::check(&dir).map_err(|e| e.to_string())?;
            println!("ok: {} {}", info.id, info.version);
            print_review(&info);
        }
        PluginCommand::Link { dir } => {
            let info = plugins::link(&dirs, &dir).map_err(|e| e.to_string())?;
            println!(
                "linked {} {} -> {}",
                info.id,
                info.version,
                info.dir.display()
            );
            println!(
                "It stays off until you review and enable it: omp-pulse plugin enable {}",
                info.id
            );
        }
        PluginCommand::Unlink { id } => {
            plugins::unlink(&dirs, &id).map_err(|e| e.to_string())?;
            println!("unlinked {id}");
        }
        PluginCommand::Enable { id, yes } => {
            let info = plugins::get(&dirs, &id).ok_or_else(|| PluginError::NotFound.to_string())?;
            // An invalid plugin has nothing to review; `set_enabled` refuses it
            // with the validation reason below.
            if info.status != PluginStatus::Invalid {
                print_review(&info);
                if !yes && !confirm_enable(&id)? {
                    println!("left {id} off");
                    return Ok(());
                }
            }
            // The hash printed above, so a plugin edited while the person read
            // the review is refused rather than approved unseen.
            plugins::set_enabled(&dirs, &id, true, Some(&info.hash)).map_err(|e| e.to_string())?;
            println!("enabled {id}");
        }
        PluginCommand::Disable { id } => {
            plugins::set_enabled(&dirs, &id, false, None).map_err(|e| e.to_string())?;
            println!("disabled {id}");
        }
        PluginCommand::Options { id, pairs } => {
            let info = plugins::get(&dirs, &id).ok_or_else(|| PluginError::NotFound.to_string())?;
            if info.status == PluginStatus::Invalid {
                // Options are only defined for a valid manifest; say why it is not.
                return Err(info
                    .error
                    .clone()
                    .unwrap_or_else(|| format!("plugin {} is invalid", info.id)));
            }
            let info = if pairs.is_empty() {
                info
            } else {
                let values = parse_option_pairs(&info, &pairs)?;
                plugins::set_options(&dirs, &id, &values).map_err(|e| e.to_string())?
            };
            for option in &info.options {
                let value = info
                    .option_values
                    .get(&option.id)
                    .unwrap_or(&option.default);
                println!("{} = {}", option.id, value_text(value));
            }
        }
        PluginCommand::Skill => {
            let agent_dir = omp_pulse::paths::omp_agent_dir(&paths.home)?;
            let done = plugins::skill::install(&agent_dir)?;
            if done.changed {
                println!(
                    "installed the pulse-plugin skill in {}",
                    done.skill_dir.display()
                );
                println!(
                    "installed the /pulse-plugin command in {}",
                    done.command_file.display()
                );
            } else {
                println!(
                    "the pulse-plugin skill ({}) and /pulse-plugin command ({}) are up to date",
                    done.skill_dir.display(),
                    done.command_file.display()
                );
            }
            println!(
                "New omp sessions pick them up: type /pulse-plugin <what the plugin should do>, or ask for a Pulse plugin."
            );
        }
    }
    Ok(())
}

/// `key=value` pairs as option values: `true`/`false` for a switch, the text as
/// typed for everything else. A pair without `=` or naming an undeclared option
/// is refused before anything is written; the store checks choices and length.
fn parse_option_pairs(info: &PluginInfo, pairs: &[String]) -> Result<Map<String, Value>, String> {
    let mut values = Map::new();
    for pair in pairs {
        let (key, raw) = pair
            .split_once('=')
            .ok_or_else(|| format!("expected KEY=VALUE, got {}", plain(pair)))?;
        let option = info
            .options
            .iter()
            .find(|option| option.id == key)
            .ok_or_else(|| format!("{} has no option {}", info.id, plain(key)))?;
        let value = if option.kind == "bool" {
            match raw {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => {
                    return Err(format!(
                        "option {key} is a switch: use {key}=true or {key}=false"
                    ));
                }
            }
        } else {
            Value::String(raw.to_owned())
        };
        values.insert(key.to_owned(), value);
    }
    Ok(values)
}

/// The wire name of a status, so the text listing and `--json` agree.
fn status_name(status: PluginStatus) -> &'static str {
    match status {
        PluginStatus::Enabled => "enabled",
        PluginStatus::Disabled => "disabled",
        PluginStatus::NeedsReview => "needs_review",
        PluginStatus::Invalid => "invalid",
    }
}

fn list_line(info: &PluginInfo) -> String {
    let mut line = format!(
        "{}  {}  {}",
        info.id,
        info.version,
        status_name(info.status)
    );
    if let Some(reason) = &info.error {
        line.push_str(&format!(": {reason}"));
    }
    line
}

/// What a person approves: where the plugin draws, which commands it runs and
/// what it can see and do in conversations.
fn print_review(info: &PluginInfo) {
    println!("slots: {}", info.slots.join(", "));
    for source in &info.sources {
        println!(
            "source {}: {}  (at most every {} s, timeout {} s)",
            source.id,
            argv_line(&source.command),
            source.interval_s,
            source.timeout_s
        );
    }
    for warning in &info.warnings {
        println!("warning: {}", plain(warning));
    }
    for permission in &info.permissions {
        if let Some(text) = permission_text(permission) {
            println!("on a tap, can: {text}  ({permission})");
        }
    }
    if !info.tools.is_empty() {
        println!("sees tool calls: {}", info.tools.join(", "));
    }
    if !info.messages.is_empty() {
        println!("sees extension messages: {}", info.messages.join(", "));
    }
    if info.slots.iter().any(|slot| slot.starts_with("session.")) {
        println!("sees conversation titles, folders and models");
    }
    if info.permissions.iter().any(|p| p == "session.read") {
        println!("sees the open conversation's title, folder and model");
    }
    for action in &info.actions {
        println!("action {}: {}", action.id, argv_line(&action.command));
        if let Some(pattern) = &action.arg_pattern {
            println!("  {{arg}} must match: {}", plain(pattern));
        }
    }
    for option in &info.options {
        println!(
            "option {} ({}): {}",
            option.id,
            option.kind,
            plain(&option.label)
        );
    }
}

/// What a tap lets a plugin do with each permission, in the words of the
/// phone's review (web/src/app/plugins/PluginsSettings.tsx `PERMISSION_LABEL`;
/// keep the two in step). `session.read` is a "sees" line, not an action.
fn permission_text(permission: &str) -> Option<&'static str> {
    match permission {
        "session.compose" => Some("put text in the message box"),
        "session.prompt" => {
            Some("send messages to the conversation (skills and prompt templates too)")
        }
        "session.bash" => {
            Some("run any shell command it chooses on this computer, in the conversation's folder")
        }
        "session.rpc" => {
            Some("read the whole conversation and change it (settings, rewind, fork, compact)")
        }
        _ => None,
    }
}

/// Asks on the terminal whether to switch `id` on. Without a terminal there is
/// nobody to ask: a script must pass `--yes`, and an agent running the CLI
/// cannot approve a plugin by accident.
fn confirm_enable(id: &str) -> Result<bool, String> {
    if !std::io::stdin().is_terminal() {
        return Err(format!(
            "no terminal to ask in: read the review above, then run `omp-pulse plugin enable {id} --yes`"
        ));
    }
    print!("Switch {id} on with the access listed above? [y/N] ");
    std::io::stdout()
        .flush()
        .map_err(|e| format!("could not write the question: {e}"))?;
    let mut answer = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut answer)
        .map_err(|e| format!("could not read the answer: {e}"))?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

/// An option value as `id = value` prints it.
fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => plain(text),
        other => other.to_string(),
    }
}

/// `text` as is, or quoted with escapes when it holds a control character, so
/// a hand-edited file cannot drive the terminal.
fn plain(text: &str) -> String {
    if text.chars().any(char::is_control) {
        format!("{text:?}")
    } else {
        text.to_owned()
    }
}

/// The argv as typed into a shell, quoting only what needs it, so the line
/// shows the exact arguments (an empty or space-holding argument stays visible).
fn argv_line(command: &[String]) -> String {
    command
        .iter()
        .map(|arg| {
            let simple = !arg.is_empty()
                && arg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,{}".contains(c));
            if simple {
                arg.clone()
            } else {
                format!("{arg:?}")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
