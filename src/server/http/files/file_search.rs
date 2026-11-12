//! Ignore-aware, bounded project-file suggestions for composer `@` mentions.

use std::cmp::Ordering;
use std::path::Path;
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use serde::Serialize;

const MAX_ENTRIES: usize = 200_000;
const MAX_RESULTS: usize = 32;
const SEARCH_TIME: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize)]
pub(super) struct FileMatch {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    kind: &'static str,
}

pub(super) struct SearchResult {
    pub entries: Vec<FileMatch>,
    pub truncated: bool,
}

struct Candidate {
    score: usize,
    depth: usize,
    file: FileMatch,
}

/// Match case-insensitive subsequences without allocating a folded candidate
/// string for every path visited. Adjacent and word-start matches rank first.
fn score(value: &str, query: &[char]) -> Option<usize> {
    if query.is_empty() {
        return Some(0);
    }
    let mut matched = 0;
    let mut start = 0;
    let mut last = 0;
    let mut gaps = 0;
    let mut boundary = false;
    let mut previous = None;
    for (index, ch) in value.chars().flat_map(char::to_lowercase).enumerate() {
        if ch == query[matched] {
            if matched == 0 {
                start = index;
                boundary = previous.is_none_or(|ch: char| !ch.is_alphanumeric() || ch == '_');
            } else {
                gaps += (index - last - 1).min(5);
            }
            last = index;
            matched += 1;
            if matched == query.len() {
                return Some(if gaps == 0 {
                    if start == 0 {
                        0
                    } else if boundary {
                        1
                    } else {
                        2
                    }
                } else {
                    3 + gaps
                });
            }
        }
        previous = Some(ch);
    }
    None
}

fn compare(score: usize, depth: usize, path: &str, other: &Candidate) -> Ordering {
    score
        .cmp(&other.score)
        .then_with(|| depth.cmp(&other.depth))
        .then_with(|| path.len().cmp(&other.file.path.len()))
        .then_with(|| path.cmp(&other.file.path))
}

pub(super) fn search(cwd: &Path, query: &str) -> Result<SearchResult, String> {
    search_with(cwd, query, MAX_ENTRIES, MAX_RESULTS, SEARCH_TIME)
}

fn search_with(
    cwd: &Path,
    query: &str,
    max_entries: usize,
    max_results: usize,
    duration: Duration,
) -> Result<SearchResult, String> {
    let root = cwd.canonicalize().map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("working directory no longer exists".to_string());
    }
    let query = query.strip_prefix("./").unwrap_or(query);
    if query.is_empty() {
        return Ok(SearchResult {
            entries: Vec::new(),
            truncated: false,
        });
    }
    let folded: Vec<char> = query.chars().flat_map(char::to_lowercase).collect();
    let path_query = query.contains('/');
    let hidden = !query.split('/').any(|part| part.starts_with('.'));
    let mut walker = WalkBuilder::new(&root);
    walker
        .hidden(hidden)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    let started = Instant::now();
    let mut best: Vec<Candidate> = Vec::with_capacity(max_results);
    let mut truncated = false;
    for (visited, entry) in walker.build().enumerate() {
        if visited >= max_entries || started.elapsed() >= duration {
            truncated = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        // Never traverse or suggest links, including links into another project.
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(&root) else {
            continue;
        };
        let (Some(path), Some(name)) = (relative.to_str(), entry.file_name().to_str()) else {
            truncated = true;
            continue;
        };
        #[cfg(windows)]
        let normalized = path.replace('\\', "/");
        #[cfg(windows)]
        let path = normalized.as_str();
        let candidate_score = if path_query {
            score(path, &folded)
        } else {
            score(name, &folded).or_else(|| score(path, &folded).map(|value| value + 100))
        };
        let Some(candidate_score) = candidate_score else {
            continue;
        };
        let depth = entry.depth();
        if best.len() == max_results
            && best
                .last()
                .is_none_or(|last| compare(candidate_score, depth, path, last) != Ordering::Less)
        {
            truncated = true;
            continue;
        }
        let index = best.partition_point(|other| {
            compare(candidate_score, depth, path, other) == Ordering::Greater
        });
        best.insert(
            index,
            Candidate {
                score: candidate_score,
                depth,
                file: FileMatch {
                    name: name.to_string(),
                    path: path.to_string(),
                    kind: "file",
                },
            },
        );
        if best.len() > max_results {
            best.pop();
            truncated = true;
        }
    }
    Ok(SearchResult {
        entries: best.into_iter().map(|candidate| candidate.file).collect(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn project(name: &str, files: &[&str]) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("omp-file-search-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        for file in files {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "fixture").unwrap();
        }
        root
    }

    #[test]
    fn nested_filename_and_path_queries_find_full_references() {
        let root = project(
            "nested",
            &[
                "Composer.tsx",
                "src/deep/Composer.tsx",
                "src/other/Compare.ts",
                "docs/Résumé notes.md",
            ],
        );
        let matches = search(&root, "compo").unwrap();
        assert_eq!(
            matches
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["Composer.tsx", "src/deep/Composer.tsx"]
        );
        let matches = search(&root, "src/d/comp").unwrap();
        assert_eq!(
            matches
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["src/deep/Composer.tsx"]
        );
        let matches = search(&root, "RÉSUMÉ").unwrap();
        assert_eq!(matches.entries[0].path, "docs/Résumé notes.md");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignore_rules_hidden_opt_in_and_repository_metadata_are_respected() {
        let root = project(
            "ignores",
            &[
                "src/Needle.ts",
                "generated/Needle.ts",
                ".hidden/Needle.ts",
                ".git/Needle.ts",
                ".env.local",
            ],
        );
        fs::write(root.join(".gitignore"), "generated/\n").unwrap();
        let matches = search(&root, "Needle").unwrap();
        assert_eq!(
            matches
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["src/Needle.ts"]
        );
        assert_eq!(search(&root, ".env").unwrap().entries[0].path, ".env.local");
        assert_eq!(
            search(&root, ".hidden/Needle").unwrap().entries[0].path,
            ".hidden/Needle.ts"
        );
        assert!(search(&root, ".git/Needle").unwrap().entries.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn caps_report_incomplete_results_and_preserve_best_matches() {
        let root = project("bounded", &["a/needle.ts", "b/needle.ts", "needle.ts"]);
        let matches = search_with(&root, "needle", MAX_ENTRIES, 1, SEARCH_TIME).unwrap();
        assert_eq!(matches.entries[0].path, "needle.ts");
        assert!(matches.truncated);
        let matches = search_with(&root, "needle", 0, 1, SEARCH_TIME).unwrap();
        assert!(matches.entries.is_empty() && matches.truncated);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn links_cannot_expose_another_projects_files() {
        let root = project("links", &["inside/needle.ts"]);
        let outside = project("outside", &["secret-needle.ts"]);
        std::os::unix::fs::symlink(&outside, root.join("outside")).unwrap();
        std::os::unix::fs::symlink(
            outside.join("secret-needle.ts"),
            root.join("linked-needle.ts"),
        )
        .unwrap();
        let matches = search(&root, "needle").unwrap();
        assert_eq!(
            matches
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["inside/needle.ts"]
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
