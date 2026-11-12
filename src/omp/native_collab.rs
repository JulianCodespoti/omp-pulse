//! Discovery of active native omp Collab hosts through the supported CLI.
//!
//! The CLI owns registry IPC authentication and generation checks. We only
//! select the exact session reported by omp, request its capability, and
//! verify the generation still matches before returning the URL to the attach
//! path. Capability output is never included in errors or logs.
//! Tern discovery uses the owner's runtime/profile rather than the daemon's:
//! a printed join hint can outlive its host and is not share authority.

use crate::paths;
use serde_json::Value;
use std::{path::Path, time::Duration};
use tokio::io::AsyncReadExt;

const REGISTRY_VERSION: u64 = 1;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CLI_BYTES: u64 = 1024 * 1024;

/// An external owner's CLI and exact environment overrides. Missing values
/// remove inherited daemon variables rather than leaking its profile.
pub(crate) struct OwnerCli<'a> {
    pub bin: &'a Path,
    pub env: &'a [(&'static str, Option<&'a str>)],
}

async fn cli_output(cli: &OwnerCli<'_>, args: &[&str]) -> Result<Vec<u8>, ()> {
    let mut command = tokio::process::Command::new(cli.bin);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for &(name, value) in cli.env {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    let mut child = command.spawn().map_err(|_| ())?;
    let stdout = child.stdout.take().ok_or(())?;
    let output = async {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_CLI_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| ())?;
        if bytes.len() as u64 > MAX_CLI_BYTES {
            return Err(());
        }
        let status = child.wait().await.map_err(|_| ())?;
        if status.success() { Ok(bytes) } else { Err(()) }
    };
    tokio::time::timeout(COMMAND_TIMEOUT, output)
        .await
        .map_err(|_| ())?
}

pub(crate) enum Discovery {
    NoHost,
    Link(String),
    Refused(&'static str),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Host {
    instance_id: String,
    generation: u64,
    pid: u32,
    access: Access,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Access {
    View,
    Control,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListError {
    Unsupported,
    MalformedMatchingHost,
    Ambiguous,
    WrongOwner,
}

/// Look for the active native host for exactly `session_id` and request its control URL.
/// No terminal I/O is performed here. A matching view-only host is a refusal,
/// not a reason to type `/collab` and attempt to upgrade it.
pub(crate) async fn discover(
    session_id: &str,
    owner_pid: Option<i32>,
    owner_cli: Option<OwnerCli<'_>>,
) -> Discovery {
    let scoped = owner_cli.is_some();
    let default_bin;
    let cli = match owner_cli {
        Some(cli) => cli,
        None => {
            if !registry_may_have_hosts() {
                return Discovery::NoHost;
            }
            let Some(bin) = paths::find_omp_binary() else {
                return Discovery::NoHost;
            };
            default_bin = bin;
            OwnerCli {
                bin: &default_bin,
                env: &[],
            }
        }
    };
    let unavailable =
        "the desktop omp cannot report its active Collab hosts; check its runtime and profile";
    let list = match cli_output(&cli, &["collab", "list", "--json"]).await {
        Ok(raw) => raw,
        Err(()) if scoped => return Discovery::Refused(unavailable),
        Err(()) => return Discovery::NoHost,
    };
    let host = match select_host(&list, session_id, owner_pid) {
        Ok(Some(host)) => host,
        Ok(None) => return Discovery::NoHost,
        Err(ListError::Unsupported) if scoped => return Discovery::Refused(unavailable),
        Err(ListError::Unsupported) => return Discovery::NoHost,
        Err(ListError::MalformedMatchingHost) => {
            return Discovery::Refused("the matching Collab host metadata is invalid");
        }
        Err(ListError::WrongOwner) => {
            return Discovery::Refused(
                "the Collab host belongs to a different session owner; refusing to attach",
            );
        }
        Err(ListError::Ambiguous) => {
            return Discovery::Refused(
                "multiple Collab hosts match this session; refusing to choose one",
            );
        }
    };

    if let Err(reason) = control_access(&host) {
        return Discovery::Refused(reason);
    }

    let instance_id = host.instance_id.as_str();
    let args = ["collab", "link", instance_id, "--json"];
    let result = match cli_output(&cli, &args).await {
        Ok(raw) => raw,
        Err(()) => {
            return Discovery::Refused(
                "the Collab host changed or stopped while its link was being requested; retry the attach",
            );
        }
    };
    match parse_link_response(&result, &host) {
        Ok(url) => Discovery::Link(url),
        Err(()) => Discovery::Refused(
            "the Collab host changed while its link was being requested; retry the attach",
        ),
    }
}

/// Whether omp's local Collab registry can list any host at all, decided from
/// the filesystem instead of by asking omp. `omp collab list` is a full omp
/// start (a ~220 MB binary): on the phone under proot that cost seconds and a
/// memory spike on every send window, only to report the empty registry of a
/// machine where Collab Autostart never ran (diagnostics showed 7 adoption
/// attempts, 0 successes). omp keeps the registry at
/// `~/.omp/run/collab-hosts`; a missing or empty directory means no host has
/// published. A custom `PI_CONFIG_DIR` keeps the CLI probe, because omp's
/// resolution of that variable is not mirrored here.
pub(crate) fn registry_may_have_hosts() -> bool {
    if std::env::var_os("PI_CONFIG_DIR").is_some_and(|dir| !dir.is_empty()) {
        return true;
    }
    let Some(home) = paths::home_dir() else {
        return true;
    };
    registry_dir_has_entries(&home.join(".omp/run/collab-hosts"))
}

fn registry_dir_has_entries(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_some())
}

/// Match the exact session and, when known, its owner even if only one host is
/// listed. A copied session id must not lend another writer's room authority.
fn select_host(
    raw: &[u8],
    session_id: &str,
    owner_pid: Option<i32>,
) -> Result<Option<Host>, ListError> {
    let value: Value = serde_json::from_slice(raw).map_err(|_| ListError::Unsupported)?;
    let Some(root) = value.as_object() else {
        return Err(ListError::Unsupported);
    };
    if root.get("version").and_then(Value::as_u64) != Some(REGISTRY_VERSION) {
        return Err(ListError::Unsupported);
    }
    let Some(hosts) = root.get("hosts").and_then(Value::as_array) else {
        return Err(ListError::Unsupported);
    };

    let mut matches = Vec::new();
    for row in hosts {
        let Some(fields) = row.as_object() else {
            continue;
        };
        if fields.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            continue;
        }

        let (Some(instance_id), Some(generation), Some(pid), Some(access)) = (
            fields.get("instanceId").and_then(Value::as_str),
            fields.get("generation").and_then(Value::as_u64),
            fields.get("pid").and_then(Value::as_u64),
            fields.get("access").and_then(Value::as_str),
        ) else {
            return Err(ListError::MalformedMatchingHost);
        };
        if !valid_instance_id(instance_id) || generation == 0 || pid == 0 || pid > u32::MAX as u64 {
            return Err(ListError::MalformedMatchingHost);
        }
        let access = match access {
            "view" => Access::View,
            "control" => Access::Control,
            _ => return Err(ListError::MalformedMatchingHost),
        };
        matches.push(Host {
            instance_id: instance_id.to_string(),
            generation,
            pid: pid as u32,
            access,
        });
    }

    match matches.len() {
        0 => Ok(None),
        1 => {
            let host = matches.pop();
            if let (Some(owner), Some(host)) = (owner_pid, host.as_ref())
                && u32::try_from(owner).ok() != Some(host.pid)
            {
                return Err(ListError::WrongOwner);
            }
            Ok(host)
        }
        _ => {
            let Some(owner_pid) = owner_pid.and_then(|pid| u32::try_from(pid).ok()) else {
                return Err(ListError::Ambiguous);
            };
            let mut owned = matches.into_iter().filter(|host| host.pid == owner_pid);
            let Some(selected) = owned.next() else {
                return Err(ListError::Ambiguous);
            };
            if owned.next().is_some() {
                return Err(ListError::Ambiguous);
            }
            Ok(Some(selected))
        }
    }
}

fn valid_instance_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn control_access(host: &Host) -> Result<(), &'static str> {
    match host.access {
        Access::Control => Ok(()),
        Access::View => Err(
            "the session is already shared in view-only mode; automatic adoption will not request control access",
        ),
    }
}

/// A capability is usable only if the CLI's second registry resolution still
/// refers to the exact listed host generation and its published access.
fn parse_link_response(raw: &[u8], host: &Host) -> Result<String, ()> {
    let value: Value = serde_json::from_slice(raw).map_err(|_| ())?;
    let fields = value.as_object().ok_or(())?;
    if fields.get("version").and_then(Value::as_u64) != Some(REGISTRY_VERSION)
        || fields.get("instanceId").and_then(Value::as_str) != Some(host.instance_id.as_str())
        || fields.get("generation").and_then(Value::as_u64) != Some(host.generation)
        || fields.get("access").and_then(Value::as_str) != Some("control")
    {
        return Err(());
    }
    let url = fields.get("url").and_then(Value::as_str).ok_or(())?.trim();
    if url.is_empty() {
        return Err(());
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "target-session";
    const OTHER: &str = "other-session";
    const ID_A: &str = "host-aaaa";
    const ID_B: &str = "host-bbbb";

    fn list(hosts: Value) -> Vec<u8> {
        serde_json::json!({ "version": 1, "hosts": hosts })
            .to_string()
            .into_bytes()
    }

    fn host(id: &str, sid: &str, pid: u32, access: &str, generation: u64) -> Value {
        serde_json::json!({
            "instanceId": id,
            "generation": generation,
            "pid": pid,
            "sessionId": sid,
            "access": access,
        })
    }

    fn listed_host() -> Host {
        Host {
            instance_id: ID_A.to_string(),
            generation: 4,
            pid: 40,
            access: Access::Control,
        }
    }

    #[test]
    fn discovery_ignores_hosts_for_every_other_session() {
        let raw = list(serde_json::json!([
            host(ID_B, OTHER, 42, "control", 4),
            host(ID_A, SESSION, 40, "control", 4),
        ]));
        assert_eq!(
            select_host(&raw, SESSION, None).unwrap(),
            Some(listed_host())
        );
        assert_eq!(select_host(&raw, "not-the-session", None).unwrap(), None);
    }

    #[test]
    fn duplicate_session_hosts_require_owner_pid_disambiguation() {
        let raw = list(serde_json::json!([
            host(ID_A, SESSION, 40, "control", 4),
            host(ID_B, SESSION, 41, "control", 2),
        ]));
        assert_eq!(select_host(&raw, SESSION, None), Err(ListError::Ambiguous));
        assert_eq!(
            select_host(&raw, SESSION, Some(41))
                .unwrap()
                .unwrap()
                .instance_id,
            ID_B
        );
        assert_eq!(
            select_host(&raw, SESSION, Some(99)),
            Err(ListError::Ambiguous)
        );
    }

    #[test]
    fn a_single_host_still_must_belong_to_the_known_owner() {
        let raw = list(serde_json::json!([host(ID_A, SESSION, 40, "control", 4)]));
        assert_eq!(
            select_host(&raw, SESSION, Some(41)),
            Err(ListError::WrongOwner)
        );
        assert_eq!(
            select_host(&raw, SESSION, Some(40)).unwrap(),
            Some(listed_host())
        );
    }

    #[test]
    fn exact_session_view_host_is_never_upgraded_to_control() {
        let raw = list(serde_json::json!([host(ID_A, SESSION, 40, "view", 4)]));
        let selected = select_host(&raw, SESSION, None).unwrap().unwrap();
        assert!(control_access(&selected).is_err());
        assert_eq!(control_access(&listed_host()), Ok(()));
    }
    #[test]
    fn capability_response_must_match_selected_generation_and_access() {
        let host = listed_host();
        let good = serde_json::json!({
            "version": 1,
            "instanceId": ID_A,
            "generation": 4,
            "access": "control",
            "url": "https://relay.example/#wss://relay.example/r/abcdefghijklmnop.abcdefgh",
        });
        assert!(parse_link_response(good.to_string().as_bytes(), &host).is_ok());

        let successor = serde_json::json!({
            "version": 1,
            "instanceId": ID_A,
            "generation": 5,
            "access": "control",
            "url": "https://relay.example/#wss://relay.example/r/abcdefghijklmnop.successor",
        });
        assert!(parse_link_response(successor.to_string().as_bytes(), &host).is_err());

        let upgraded = serde_json::json!({
            "version": 1,
            "instanceId": ID_A,
            "generation": 4,
            "access": "view",
            "url": "https://relay.example/#wss://relay.example/r/abcdefghijklmnop.view",
        });
        assert!(parse_link_response(upgraded.to_string().as_bytes(), &host).is_err());
    }
}
