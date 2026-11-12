//! Native OMP resources, deliberately confined to the originating journal.
//! OMP 18.8.6: session-manager L4e/getArtifactsDir, local-protocol Sx/t8s,
//! artifact-protocol S$n (numeric ID -> `<id>.*`), tools/read-selector DF.
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek},
    path::{Path, PathBuf},
};

use super::MAX_FILE_READ;

#[derive(Debug)]
pub(super) struct Resource {
    pub path: PathBuf,
    selector: Selector,
}

#[derive(Debug, Default)]
enum Selector {
    #[default]
    All,
    Lines(Vec<(u64, u64)>),
    Tail(u64),
}

pub(super) fn is_internal(uri: &str) -> bool {
    uri.get(..6)
        .is_some_and(|s| s.eq_ignore_ascii_case("local:"))
        || uri
            .get(..9)
            .is_some_and(|s| s.eq_ignore_ascii_case("artifact:"))
}

fn positive(value: &str) -> Result<u64, String> {
    let value = value
        .strip_prefix('L')
        .or_else(|| value.strip_prefix('l'))
        .unwrap_or(value);
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid resource line selector".into());
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| "invalid resource line selector".into())
}

fn selector(raw: &str) -> Result<Selector, String> {
    let parts: Vec<_> = raw.split(':').collect();
    let range = match parts.as_slice() {
        [one] if one.eq_ignore_ascii_case("raw") => return Ok(Selector::All),
        [one] => *one,
        [raw, range] if raw.eq_ignore_ascii_case("raw") => *range,
        [range, raw] if raw.eq_ignore_ascii_case("raw") => *range,
        _ => return Err("invalid resource line selector".into()),
    };
    if let Some(count) = range.strip_prefix('-') {
        return Ok(Selector::Tail(positive(count)?));
    }
    let mut ranges = Vec::new();
    let multiple = range.contains(',');
    for item in range.split(',') {
        let (start, end) = if let Some((start, count)) = item.split_once('+') {
            let start = positive(start)?;
            (
                start,
                start
                    .checked_add(positive(count)? - 1)
                    .ok_or("invalid resource line selector")?,
            )
        } else if let Some((start, end)) = item.split_once('-').or_else(|| item.split_once("..")) {
            (
                positive(start)?,
                if end.is_empty() {
                    u64::MAX
                } else {
                    positive(end)?
                },
            )
        } else {
            // Native :N starts at N; :N-N selects just that line.
            let start = positive(item)?;
            (start, if multiple { start } else { u64::MAX })
        };
        if end < start {
            return Err("invalid resource line selector".into());
        }
        ranges.push((start, end));
    }
    Ok(Selector::Lines(ranges))
}

fn decode_path(raw: &str) -> Result<String, String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw
                .get(i + 1..i + 3)
                .ok_or("invalid resource URL encoding")?;
            decoded.push(u8::from_str_radix(hex, 16).map_err(|_| "invalid resource URL encoding")?);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "invalid resource URL encoding".into())
}

pub(super) fn resolve(session: &Path, uri: &str) -> Result<Resource, String> {
    let real_session = session
        .canonicalize()
        .map_err(|_| "source session is unavailable")?;
    if !real_session.is_file() {
        return Err("source session is unavailable".into());
    }
    let stem = real_session
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_suffix(".jsonl"))
        .ok_or("invalid source session")?;
    let root = real_session.with_file_name(stem);
    // Do not let a substituted artifacts root point at another conversation.
    let real_root = root
        .canonicalize()
        .map_err(|_| "session resources are unavailable")?;
    if real_root != root {
        return Err("resource root escapes source session".into());
    }
    let (scheme, rest) = uri.split_once("://").ok_or("invalid resource URI")?;
    let (name, selection) = if let Some((name, sel)) = rest.split_once(':') {
        (name, selector(sel)?)
    } else {
        (rest, Selector::All)
    };
    let (base, candidate) = if scheme.eq_ignore_ascii_case("local") {
        let name = decode_path(name.strip_prefix('/').unwrap_or(name))?.replace('\\', "/");
        if name.is_empty()
            || name.starts_with('/')
            || name.contains(['\0', '?', '#', ':'])
            || name.split('/').any(|s| s == "..")
        {
            return Err("invalid local resource path".into());
        }
        let base = root.join("local");
        if base.canonicalize().ok().as_ref() != Some(&base) {
            return Err("local resource root is unavailable or foreign".into());
        }
        let target = base.join(name);
        (base, target)
    } else if scheme.eq_ignore_ascii_case("artifact") {
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
            return Err("artifact ID must be numeric".into());
        }
        let prefix = format!("{name}.");
        let mut found = None;
        for entry in fs::read_dir(&root).map_err(|_| "session resources are unavailable")? {
            let entry = entry.map_err(|_| "session resources are unavailable")?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|s| s.starts_with(&prefix))
            {
                if found.is_some() {
                    return Err("artifact ID is ambiguous".into());
                }
                found = Some(entry.path());
            }
        }
        (
            root,
            found.ok_or("saved output is unavailable in this conversation")?,
        )
    } else {
        return Err("unsupported resource URI".into());
    };
    let path = candidate
        .canonicalize()
        .map_err(|_| "resource is unavailable in this conversation")?;
    if !path.starts_with(&base) || !path.is_file() {
        return Err("resource is not a file in this conversation".into());
    }
    Ok(Resource {
        path,
        selector: selection,
    })
}

impl Resource {
    pub fn read_preview(&self, mut file: File) -> io::Result<(Vec<u8>, bool)> {
        if matches!(self.selector, Selector::All) {
            return super::read_file_preview(file);
        }
        // Snapshot length bounds scanning even if an agent is appending. Skip
        // unselected bytes in-place; never allocate an arbitrarily long line.
        let length = file.metadata()?.len();
        let mut ranges = match &self.selector {
            Selector::Lines(ranges) => ranges.clone(),
            Selector::Tail(count) => {
                let mut reader = BufReader::new((&mut file).take(length));
                let mut lines = 0u64;
                let mut last = None;
                loop {
                    let chunk = reader.fill_buf()?;
                    if chunk.is_empty() {
                        break;
                    }
                    lines += chunk.iter().filter(|b| **b == b'\n').count() as u64;
                    last = chunk.last().copied();
                    let n = chunk.len();
                    reader.consume(n);
                }
                if last.is_some_and(|b| b != b'\n') {
                    lines += 1;
                }
                file.rewind()?;
                vec![(
                    lines.saturating_sub(*count).saturating_add(1).max(1),
                    u64::MAX,
                )]
            }
            Selector::All => unreachable!(),
        };
        ranges.sort_unstable();
        let mut reader = BufReader::new(file.take(length));
        let mut line = 1u64;
        let mut out = Vec::new();
        loop {
            let chunk = reader.fill_buf()?;
            if chunk.is_empty() {
                break;
            }
            for segment in chunk.split_inclusive(|b| *b == b'\n') {
                if ranges
                    .iter()
                    .any(|(start, end)| line >= *start && line <= *end)
                {
                    let available = MAX_FILE_READ as usize + 1 - out.len();
                    out.extend_from_slice(&segment[..segment.len().min(available)]);
                    if out.len() > MAX_FILE_READ as usize {
                        out.truncate(MAX_FILE_READ as usize);
                        return Ok((out, true));
                    }
                }
                if segment.last() == Some(&b'\n') {
                    line += 1;
                }
            }
            let n = chunk.len();
            reader.consume(n);
            if ranges.iter().all(|(_, end)| line > *end) {
                break;
            }
        }
        Ok((out, false))
    }
}
