//! The `pulse-plugin` omp skill and `/pulse-plugin` command, which teach an
//! agent to build, check and link a plugin. The binary embeds them with the
//! user guide (as the skill's `reference.md`) and the example plugins, and
//! installs them into omp's agent directory, so the guide an agent reads
//! always matches the daemon that validates its plugin.
//!
//! As with the desktop-control extension, a file is replaced only when it
//! carries the managed marker: a skill or command of the same name that the
//! user wrote is refused, never overwritten.

use std::borrow::Cow;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::omp::desktop_control::{read_file_bounded, write_managed_atomic};

const SKILL_DIR: &str = "pulse-plugin";
const COMMAND_FILE: &str = "pulse-plugin.md";
/// YAML comment lines in each file's frontmatter: omp ignores them, and they
/// are distinctive enough that a user's own skill is never taken for ours.
const SKILL_MARKER: &str = "# omp-pulse managed skill";
const COMMAND_MARKER: &str = "# omp-pulse managed command";
/// The marker sits in the frontmatter, which opens the file.
const MARKER_LINES: usize = 8;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Deeper than any path in [`SKILL_FILES`]; bounds the walk of an old copy.
const MAX_DEPTH: usize = 4;

/// Every file of the skill folder, by `/`-separated path relative to it.
const SKILL_FILES: &[(&str, &str)] = &[
    (
        "SKILL.md",
        include_str!("../../extensions/pulse-plugin/SKILL.md"),
    ),
    // The user guide is the full reference: shipping it verbatim keeps one
    // source for both readers instead of a second copy that drifts.
    ("reference.md", include_str!("../../docs/user/plugins.md")),
    (
        "examples/host-usage/pulse-plugin.toml",
        include_str!("../../examples/plugins/host-usage/pulse-plugin.toml"),
    ),
    (
        "examples/host-usage/client.js",
        include_str!("../../examples/plugins/host-usage/client.js"),
    ),
    (
        "examples/provider-usage/pulse-plugin.toml",
        include_str!("../../examples/plugins/provider-usage/pulse-plugin.toml"),
    ),
    (
        "examples/provider-usage/client.js",
        include_str!("../../examples/plugins/provider-usage/client.js"),
    ),
    (
        "examples/systemd-timers/pulse-plugin.toml",
        include_str!("../../examples/plugins/systemd-timers/pulse-plugin.toml"),
    ),
    (
        "examples/systemd-timers/client.js",
        include_str!("../../examples/plugins/systemd-timers/client.js"),
    ),
];
const COMMAND_SOURCE: &str = include_str!("../../extensions/pulse-plugin/command.md");

/// Where the skill and command live, and whether this call changed them.
#[derive(Debug)]
pub struct SkillInstall {
    pub skill_dir: PathBuf,
    pub command_file: PathBuf,
    pub changed: bool,
}

/// Install or refresh the skill folder and the command file under
/// `agent_dir` (omp's agent directory, see [`crate::paths::omp_agent_dir`]).
/// Both are checked for ownership before either is written, so a refusal
/// leaves nothing half-installed.
pub fn install(agent_dir: &Path) -> Result<SkillInstall, String> {
    let skill_dir = agent_dir.join("skills").join(SKILL_DIR);
    let command_file = agent_dir.join("commands").join(COMMAND_FILE);
    let skill_current = skill_is_current(&skill_dir)?;
    let command_current = command_is_current(&command_file)?;
    if !skill_current {
        replace_skill_dir(&skill_dir)?;
    }
    if !command_current {
        if let Some(parent) = command_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        write_managed_atomic(&command_file, COMMAND_SOURCE.as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", command_file.display()))?;
    }
    Ok(SkillInstall {
        skill_dir,
        command_file,
        changed: !skill_current || !command_current,
    })
}

/// Bring an installed skill and command up to this build; `None` when neither
/// is installed, so a starting daemon never adds them uninvited.
pub fn refresh_if_installed(agent_dir: &Path) -> Result<Option<SkillInstall>, String> {
    let skill_md = agent_dir.join("skills").join(SKILL_DIR).join("SKILL.md");
    let command_file = agent_dir.join("commands").join(COMMAND_FILE);
    if !is_managed(&skill_md, SKILL_MARKER) && !is_managed(&command_file, COMMAND_MARKER) {
        return Ok(None);
    }
    install(agent_dir).map(Some)
}

/// `Ok(true)` when the folder holds exactly this build's files, `Ok(false)`
/// when it is missing or an older managed copy, an error when it is not ours.
fn skill_is_current(dir: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("cannot inspect {}: {e}", dir.display())),
        // A symlink or a file under our name is the user's arrangement.
        Ok(meta) if !meta.is_dir() => return Err(refusal(dir, "skill")),
        Ok(_) => {}
    }
    let skill_md = dir.join("SKILL.md");
    let existing =
        read_file_bounded(&skill_md, MAX_FILE_BYTES).map_err(|_| refusal(dir, "skill"))?;
    if !has_marker(&existing, SKILL_MARKER) {
        return Err(refusal(dir, "skill"));
    }
    let all_equal = SKILL_FILES.iter().all(|(rel, text)| {
        read_file_bounded(&nested(dir, rel), MAX_FILE_BYTES)
            .is_ok_and(|bytes| bytes == installed_text(rel, text).as_bytes())
    });
    Ok(all_equal && count_files(dir, 0) == SKILL_FILES.len())
}

fn command_is_current(file: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(file) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("cannot inspect {}: {e}", file.display())),
        Ok(meta) if !meta.is_file() => return Err(refusal(file, "command")),
        Ok(_) => {}
    }
    let existing = read_file_bounded(file, MAX_FILE_BYTES).map_err(|_| refusal(file, "command"))?;
    if existing == COMMAND_SOURCE.as_bytes() {
        return Ok(true);
    }
    if has_marker(&existing, COMMAND_MARKER) {
        Ok(false)
    } else {
        Err(refusal(file, "command"))
    }
}

/// Stage the whole folder beside the target and swap it in, so a build that
/// drops an example leaves no stale copy and omp never reads half a skill.
/// Staging in the same parent keeps both renames on one filesystem, which a
/// symlinked `skills/` would otherwise break.
fn replace_skill_dir(dir: &Path) -> Result<(), String> {
    let parent = dir
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", dir.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let pid = std::process::id();
    let staging = parent.join(format!(".{SKILL_DIR}-staging-{pid}"));
    let old = parent.join(format!(".{SKILL_DIR}-old-{pid}"));
    remove_if_present(&staging)?;
    remove_if_present(&old)?;
    if let Err(e) = write_files(&staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("cannot write the pulse-plugin skill: {e}"));
    }
    let had_old = dir.exists();
    if had_old && let Err(e) = fs::rename(dir, &old) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("cannot move the old {} aside: {e}", dir.display()));
    }
    if let Err(e) = fs::rename(&staging, dir) {
        if had_old {
            let _ = fs::rename(&old, dir);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("cannot install {}: {e}", dir.display()));
    }
    if had_old {
        let _ = fs::remove_dir_all(&old);
    }
    Ok(())
}

fn write_files(root: &Path) -> io::Result<()> {
    for (rel, text) in SKILL_FILES {
        let path = nested(root, rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, installed_text(rel, text).as_bytes())?;
    }
    Ok(())
}

/// The text a skill file is installed with. `reference.md` is the user guide,
/// whose example links are relative to `docs/user/` in the repository; in the
/// skill folder the examples sit beside it, under `examples/<id>/`, and the
/// repository's links pointed at a folder that does not exist there.
fn installed_text(rel: &str, text: &'static str) -> Cow<'static, str> {
    if rel == "reference.md" {
        Cow::Owned(text.replace("](../../examples/plugins/", "](examples/"))
    } else {
        Cow::Borrowed(text)
    }
}

fn remove_if_present(dir: &Path) -> Result<(), String> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => {
            Err(format!("cannot remove {}: {e}", dir.display()))
        }
        _ => Ok(()),
    }
}

/// Files under `dir`, counting anything that is not a folder; a walk that
/// cannot finish reports `usize::MAX`, which never equals the expected count.
fn count_files(dir: &Path, depth: usize) -> usize {
    if depth > MAX_DEPTH {
        return usize::MAX;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return usize::MAX;
    };
    let mut count = 0usize;
    for entry in entries {
        let Ok(entry) = entry else {
            return usize::MAX;
        };
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        let found = if is_dir {
            count_files(&entry.path(), depth + 1)
        } else {
            1
        };
        count = count.saturating_add(found);
    }
    count
}

fn nested(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn is_managed(path: &Path, marker: &str) -> bool {
    read_file_bounded(path, MAX_FILE_BYTES).is_ok_and(|bytes| has_marker(&bytes, marker))
}

fn has_marker(bytes: &[u8], marker: &str) -> bool {
    bytes
        .split(|byte| *byte == b'\n')
        .take(MARKER_LINES)
        .any(|line| std::str::from_utf8(line).is_ok_and(|line| line.trim().starts_with(marker)))
}

fn refusal(path: &Path, what: &str) -> String {
    format!(
        "refusing to replace {}: it is not the pulse-plugin {what} omp-pulse installs; rename or remove it, then run `omp-pulse plugin skill` again",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::testkit::Scratch;

    fn embedded(rel: &str) -> String {
        SKILL_FILES
            .iter()
            .find(|(path, _)| *path == rel)
            .map(|(path, text)| installed_text(path, text).into_owned())
            .unwrap()
    }

    #[test]
    fn a_fresh_install_writes_every_file_and_a_second_changes_nothing() {
        let scratch = Scratch::new("skill-fresh");
        let first = install(&scratch.root).unwrap();
        assert!(first.changed);
        for (rel, text) in SKILL_FILES {
            assert_eq!(
                fs::read_to_string(nested(&first.skill_dir, rel)).unwrap(),
                installed_text(rel, text)
            );
        }
        assert_eq!(
            fs::read_to_string(&first.command_file).unwrap(),
            COMMAND_SOURCE
        );
        assert!(!install(&scratch.root).unwrap().changed);
    }

    #[test]
    fn the_installed_guide_links_to_examples_that_exist_beside_it() {
        let scratch = Scratch::new("skill-links");
        let installed = install(&scratch.root).unwrap();
        let guide = fs::read_to_string(installed.skill_dir.join("reference.md")).unwrap();
        assert!(
            !guide.contains("../../examples"),
            "a repository-relative link survived"
        );
        let links: Vec<&str> = guide
            .split("](examples/")
            .skip(1)
            .filter_map(|rest| rest.split_once(')').map(|(target, _)| target))
            .collect();
        assert_eq!(links.len(), 3, "{links:?}");
        for target in links {
            let dir = nested(
                &installed.skill_dir.join("examples"),
                target.trim_end_matches('/'),
            );
            assert!(dir.join("pulse-plugin.toml").is_file(), "{target}");
        }
    }

    #[test]
    fn an_older_copy_is_replaced_and_loses_files_this_build_no_longer_ships() {
        let scratch = Scratch::new("skill-outdated");
        let installed = install(&scratch.root).unwrap();
        fs::write(installed.skill_dir.join("reference.md"), "old guide").unwrap();
        let retired = installed
            .skill_dir
            .join("examples")
            .join("retired")
            .join("client.js");
        fs::create_dir_all(retired.parent().unwrap()).unwrap();
        fs::write(&retired, "old").unwrap();
        fs::write(
            &installed.command_file,
            format!("{COMMAND_SOURCE}\nold wording"),
        )
        .unwrap();

        let again = install(&scratch.root).unwrap();
        assert!(again.changed);
        assert_eq!(
            fs::read_to_string(again.skill_dir.join("reference.md")).unwrap(),
            embedded("reference.md")
        );
        assert!(!retired.exists());
        assert_eq!(
            fs::read_to_string(&again.command_file).unwrap(),
            COMMAND_SOURCE
        );
    }

    #[test]
    fn a_skill_the_user_wrote_is_refused_and_nothing_is_written() {
        let scratch = Scratch::new("skill-foreign");
        let own = scratch.root.join("skills").join(SKILL_DIR);
        fs::create_dir_all(&own).unwrap();
        let mine = "---\nname: pulse-plugin\ndescription: mine\n---\nmine\n";
        fs::write(own.join("SKILL.md"), mine).unwrap();

        assert!(install(&scratch.root).unwrap_err().contains("refusing"));
        assert_eq!(fs::read_to_string(own.join("SKILL.md")).unwrap(), mine);
        assert!(!scratch.root.join("commands").join(COMMAND_FILE).exists());
    }

    #[test]
    fn a_command_the_user_wrote_is_refused_and_nothing_is_written() {
        let scratch = Scratch::new("skill-foreign-command");
        let commands = scratch.root.join("commands");
        fs::create_dir_all(&commands).unwrap();
        fs::write(commands.join(COMMAND_FILE), "Do my own thing: $ARGUMENTS\n").unwrap();

        assert!(install(&scratch.root).unwrap_err().contains("refusing"));
        assert_eq!(
            fs::read_to_string(commands.join(COMMAND_FILE)).unwrap(),
            "Do my own thing: $ARGUMENTS\n"
        );
        assert!(!scratch.root.join("skills").join(SKILL_DIR).exists());
    }

    #[test]
    fn a_daemon_refresh_adds_nothing_until_the_skill_was_installed() {
        let scratch = Scratch::new("skill-refresh");
        assert!(refresh_if_installed(&scratch.root).unwrap().is_none());
        assert!(!scratch.root.join("skills").exists());
        assert!(!scratch.root.join("commands").exists());

        let installed = install(&scratch.root).unwrap();
        fs::write(installed.skill_dir.join("reference.md"), "old guide").unwrap();
        let refreshed = refresh_if_installed(&scratch.root).unwrap().unwrap();
        assert!(refreshed.changed);
        assert_eq!(
            fs::read_to_string(refreshed.skill_dir.join("reference.md")).unwrap(),
            embedded("reference.md")
        );
    }
}
