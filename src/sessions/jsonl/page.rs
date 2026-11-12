//! Paged history reads: forward from a byte offset and backward from the end,
//! bounded per call and safe against a partially written last line.

use super::*;
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Max bytes read per forward chunk; the common watcher drain (a few appended
/// lines) completes inside the first `read`, so this bounds the allocation
/// without ever over-reading — the limit cut-off stops the reads entirely.
const FORWARD_CHUNK: usize = 256 * 1024;

/// Incremental forward read: parse complete newline-terminated JSONL lines
/// strictly after byte offset `after` through EOF, returning at most `limit`
/// entries (oldest→newest) plus `end_offset` = the byte offset just past the
/// last line consumed, so the caller can poll `after=end_offset` next.
///
/// Consumed-bytes semantics (replicating server.ts `readHistoryForward`):
/// when more than `limit` complete lines landed, `end_offset` advances ONLY
/// past the lines actually processed — never past unreturned entries (the
/// >200-lines/tick data-loss fix). Empty and unparseable (torn) lines are
/// > skipped but their bytes still count as consumed within the returned
/// > window. A trailing non-newline-terminated tail is never consumed; the
/// > client re-polls and picks it up once the newline lands.
///
/// The tail is read in 256 KiB chunks with early exit once `limit` entries
/// are parsed, so a long session costs only the bytes up to the batch cut —
/// never the whole [after, EOF) region, and never twice (the watcher used to
/// re-read the region `read_forward` had just read; docs/internals/performance.md F7/F12).
pub fn read_forward(path: &Path, after: u64, limit: usize) -> ForwardRead {
    let empty = || ForwardRead {
        entries: Vec::new(),
        end_offset: after,
    };
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        // File vanished between the caller's stat and here — nothing to
        // read; never throw on a racing delete.
        Err(_) => return empty(),
    };
    let size_hint = match f.metadata() {
        Ok(m) => m.len(),
        Err(_) => return empty(),
    };
    if after >= size_hint {
        return ForwardRead {
            entries: Vec::new(),
            end_offset: size_hint,
        };
    }
    if f.seek(SeekFrom::Start(after)).is_err() {
        return empty();
    }
    if limit == 0 {
        // The original loop breaks before processing any line, yet `consumed`
        // keeps its all-lines default, so end_offset still advances past every
        // complete line. Read to EOF tracking only the final-newline position.
        let mut chunk = [0u8; FORWARD_CHUNK];
        let mut last_nl: u64 = 0;
        let mut scanned: u64 = 0;
        loop {
            let n = match f.read(&mut chunk) {
                Ok(n) => n,
                Err(_) => return empty(),
            };
            if n == 0 {
                break;
            }
            if let Some(rel) = chunk[..n].iter().rposition(|&b| b == b'\n') {
                last_nl = scanned + rel as u64 + 1;
            }
            scanned += n as u64;
        }
        return ForwardRead {
            entries: Vec::new(),
            end_offset: after + last_nl,
        };
    }

    // Chunked reads with early exit: once `limit` entries are parsed the
    // unread tail can never be consumed (end_offset advances only past
    // processed lines), so it is never fetched — the old read_to_end pulled
    // the entire [after, EOF) region, including an arbitrarily large partial
    // line the watcher had already seen (docs/internals/performance.md F7/F12).
    let mut buf: Vec<u8> = Vec::new();
    let mut entries: Vec<Value> = Vec::new();
    // Relative offsets into `buf` (bytes past `after`).
    let mut line_start: u64 = 0; // start of the line currently being scanned
    let mut consumed_end: u64 = 0; // end of the last consumed line
    let mut last_newline_end: u64 = 0; // end of the final newline seen
    let mut chunk = [0u8; FORWARD_CHUNK];
    'outer: loop {
        let n = match f.read(&mut chunk) {
            Ok(n) => n,
            Err(_) => return empty(),
        };
        if n == 0 {
            break; // EOF
        }
        buf.extend_from_slice(&chunk[..n]);
        // `position` finds no newline when the buffer tail holds only an
        // incomplete line: leave the inner loop and read more (or stop at
        // EOF when the outer loop sees n == 0).
        while let Some(rel) = buf[line_start as usize..].iter().position(|&b| b == b'\n') {
            let nl = line_start as usize + rel;
            let line_end = nl as u64 + 1;
            if entries.len() < limit {
                let line = &buf[line_start as usize..nl];
                if !line.is_empty() {
                    if let Ok(v) = serde_json::from_slice::<Value>(line) {
                        entries.push(v);
                    }
                    consumed_end = line_end;
                }
                line_start = line_end;
                last_newline_end = line_end;
            } else {
                // `limit` was reached before this line: the original loop
                // breaks at this point, so this line is not consumed and the
                // rest of the file is never read.
                break 'outer;
            }
        }
        if entries.len() >= limit {
            break;
        }
    }

    // Consumed-bytes semantics: when the limit cut the batch, advance only
    // past the lines actually processed; when the whole file was read, past
    // the final newline (empty and unparseable lines count in both windows).
    let consumed_bytes = if entries.len() >= limit {
        consumed_end
    } else {
        last_newline_end
    };
    ForwardRead {
        entries,
        end_offset: (after + consumed_bytes).min(after + buf.len() as u64),
    }
}

/// Incremental backward read: pages entries ending before byte offset
/// `before` (None = EOF). Returns up to `limit` entries in file order plus
/// `next_before` = the byte offset of the first (oldest) returned entry, so
/// the next call pages further back without overlap or loss; None when the
/// oldest returned entry is the file's first line (no older data).
///
/// Reads backward in ≤256 KiB chunks, accumulating a window until it holds
/// enough complete lines to satisfy `limit` (or the file start), so single
/// lines larger than one chunk are captured whole. Only the window's bytes
/// are read from the file — a 200-line page on the 44 MiB session costs
/// ~1 chunk instead of the whole-file `fs::read` that measured 36.4 ms and a
/// 319 MB RSS spike (docs/internals/performance.md F4). Only lines that parse as JSON are returned;
/// a missing file yields an empty page.
pub fn read_backward(path: &Path, before: Option<u64>, limit: usize) -> BackwardRead {
    let empty = |end_offset: u64| BackwardRead {
        entries: Vec::new(),
        next_before: None,
        end_offset,
    };
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        // Vanished between the caller's stat and here — empty page, never an error.
        Err(_) => return empty(0),
    };
    let file_size = match f.metadata() {
        Ok(m) => m.len(),
        Err(_) => return empty(0),
    };
    let mut end = match before {
        None => file_size,
        Some(b) => b.min(file_size),
    };
    if end == 0 {
        return empty(file_size);
    }

    let mut need = limit;
    // Newest → oldest parsed entries; unparseable (but non-empty) lines still
    // consume limit slots yet are dropped here — the original two-phase shape
    // (take bytes, parse at the end) with the parse hoisted to take time so no
    // per-line `to_vec` copy exists (docs/internals/performance.md F4).
    let mut newest_first: Vec<Value> = Vec::new();
    let mut oldest_start: Option<u64> = None;
    let mut acc_start = end;
    let mut win = WinBuf::new();
    let mut end_offset = file_size;
    let mut nl_count = 0usize; // newlines inside `win`
    let mut chunk = vec![0u8; BACKWARD_CHUNK as usize];
    while need > 0 && end > 0 {
        // Grow the window backward until it holds need+1 newlines (enough to
        // bound `need` complete lines) or reaches the file start.
        while acc_start > 0 && nl_count < need + 1 {
            let ws = acc_start.saturating_sub(BACKWARD_CHUNK);
            let n = (acc_start - ws) as usize;
            // A file that shrank mid-read tears the window: hand back an
            // empty page rather than a half window with wrong offsets
            // (racing files yield empty results — never an error or panic).
            if f.seek(SeekFrom::Start(ws)).is_err() || f.read_exact(&mut chunk[..n]).is_err() {
                return empty(file_size);
            }
            nl_count += count_newlines(&chunk[..n]);
            win.prepend(&chunk[..n]);
            acc_start = ws;
        }
        let window = win.window();
        // Segment the window on newlines, recording each segment's start
        // offset relative to the window so the oldest taken line's byte
        // offset is O(1) (the original re-summed parts[..idx] per take).
        let mut parts: Vec<(&[u8], u64)> = Vec::new();
        let mut rel: u64 = 0;
        for seg in window.split(|&b| b == b'\n') {
            parts.push((seg, rel));
            rel += seg.len() as u64 + 1;
        }
        // First segment is a partial line when the window starts mid-file;
        // last segment is a partial line when the window ends mid-file.
        let lo = if acc_start > 0 { 1 } else { 0 };
        let hi = if end < file_size {
            parts.len() - 1
        } else {
            parts.len()
        };
        let complete = &parts[lo..hi];
        // Only non-empty segments are real lines (an empty trailing segment
        // appears after the final newline); empty segments must not consume
        // limit slots.
        let real: Vec<usize> = (0..complete.len())
            .filter(|&i| !complete[i].0.is_empty())
            .collect();
        let take = need.min(real.len());
        if take > 0 {
            // Only this read's first window can end at EOF, so only it can
            // hold a line omp has not finished writing.
            let torn_tail =
                (end == file_size && window.last() != Some(&b'\n')).then_some(parts.len() - 1);
            // Take the NEWEST `take` real lines; push reversed so
            // newest_first stays newest-first.
            for &ri in real[real.len() - take..].iter().rev() {
                match serde_json::from_slice::<Value>(complete[ri].0) {
                    Ok(v) => newest_first.push(v),
                    Err(_) if torn_tail == Some(lo + ri) => {
                        end_offset = acc_start + parts[lo + ri].1;
                    }
                    Err(_) => {}
                }
            }
            need -= take;
            let idx_in_parts = lo + real[real.len() - take];
            oldest_start = Some(acc_start + parts[idx_in_parts].1);
        }
        if need > 0 {
            // Everything accumulated was consumed; move to older data.
            end = acc_start;
            win.clear();
            nl_count = 0;
            acc_start = end;
        }
    }
    newest_first.reverse();
    BackwardRead {
        entries: newest_first,
        next_before: match oldest_start {
            Some(0) => None,
            other => other,
        },
        end_offset,
    }
}

/// Backward-growing read window: the accumulated bytes live right-aligned in
/// a buffer with free headroom at the front, so prepending the next (older)
/// chunk is O(chunk). The window is relocated only when it outgrows the
/// headroom, at doubling capacity — total copy cost O(final window) instead
/// of the original per-step re-copy of the whole accumulated window (docs/internals/performance.md
/// F4: 36.4 ms + a 319 MB RSS peak to return 70 KB from the 44 MiB file).
pub(super) struct WinBuf {
    buf: Vec<u8>,
    slack: usize, // free bytes at the FRONT of buf
    len: usize,   // occupied window length
}

impl WinBuf {
    pub(super) fn new() -> Self {
        WinBuf {
            buf: Vec::new(),
            slack: 0,
            len: 0,
        }
    }

    /// The accumulated window, oldest byte first.
    pub(super) fn window(&self) -> &[u8] {
        &self.buf[self.slack..self.slack + self.len]
    }

    /// Prepend `chunk` (the next-older bytes) to the window.
    pub(super) fn prepend(&mut self, chunk: &[u8]) {
        let n = chunk.len();
        if n == 0 {
            return;
        }
        if self.slack < n {
            let need = self.len + n;
            let new_cap = (need * 2).max(BACKWARD_CHUNK as usize);
            let new_slack = new_cap - need;
            self.buf.resize(new_cap, 0);
            // Relocate the window to the tail region (memmove); the chunk
            // then lands in the new headroom.
            self.buf
                .copy_within(self.slack..self.slack + self.len, new_slack);
            self.slack = new_slack;
        }
        self.buf[self.slack - n..self.slack].copy_from_slice(chunk);
        self.slack -= n;
        self.len += n;
    }

    /// Drop the window for the next (older) round; capacity is retained.
    pub(super) fn clear(&mut self) {
        self.slack = 0;
        self.len = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::jsonl::tests::scratch;

    #[test]
    fn read_backward_pages_across_chunk_boundary() {
        // Five ~400 KiB lines force the window to span several 256 KiB
        // chunks; paging with limit=2 must walk the whole file with no
        // overlap, no loss, and exact next_before offsets.
        let pad = "a".repeat(400_000);
        let mut content = String::new();
        let mut starts = [0u64; 5];
        for (i, slot) in starts.iter_mut().enumerate() {
            *slot = content.len() as u64;
            content.push_str(&format!("{{\"i\":{i},\"pad\":\"{pad}\"}}\n"));
        }
        let path = scratch("pages", &content);

        let p1 = read_backward(&path, None, 2);
        assert_eq!(p1.entries.len(), 2);
        assert_eq!(p1.entries[0]["i"], 3);
        assert_eq!(p1.entries[1]["i"], 4);
        assert_eq!(p1.next_before, Some(starts[3]));

        let p2 = read_backward(&path, p1.next_before, 2);
        assert_eq!(p2.entries.len(), 2);
        assert_eq!(p2.entries[0]["i"], 1);
        assert_eq!(p2.entries[1]["i"], 2);
        assert_eq!(p2.next_before, Some(starts[1]));

        let p3 = read_backward(&path, p2.next_before, 2);
        assert_eq!(p3.entries.len(), 1);
        assert_eq!(p3.entries[0]["i"], 0);
        assert_eq!(p3.next_before, None);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_backward_single_line_larger_than_chunk() {
        // A 2 MiB single line: the window must keep growing until it holds
        // the whole line, and the line must come back uncut.
        let pad = "a".repeat(2 * 1024 * 1024);
        let path = scratch("bigline", &format!("{{\"i\":0,\"pad\":\"{pad}\"}}\n"));
        let br = read_backward(&path, None, 10);
        assert_eq!(br.entries.len(), 1);
        assert_eq!(br.entries[0]["i"], 0);
        assert_eq!(
            br.entries[0]["pad"].as_str().unwrap().len(),
            2 * 1024 * 1024
        );
        assert_eq!(br.next_before, None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_backward_next_before_reaches_first_line() {
        let path = scratch("firstline", "{\"i\":0}\n{\"i\":1}\n{\"i\":2}\n");
        let p1 = read_backward(&path, None, 2);
        assert_eq!(p1.entries.len(), 2);
        assert_eq!(p1.entries[0]["i"], 1);
        assert_eq!(p1.entries[1]["i"], 2);
        assert_eq!(p1.next_before, Some(8));
        // The second page lands on the file's first line: next_before is None
        // (the offset 0 is normalized), so the client stops paging.
        let p2 = read_backward(&path, p1.next_before, 2);
        assert_eq!(p2.entries.len(), 1);
        assert_eq!(p2.entries[0]["i"], 0);
        assert_eq!(p2.next_before, None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_backward_page_with_unparseable_lines() {
        // "not json" lines consume limit slots (the window grows to
        // accommodate them) but are dropped from the page; next_before still
        // points at the oldest TAKEN line, which may itself be unparseable.
        let path = scratch(
            "unparseable",
            "not json\n{\"i\":1}\nnot json either\n{\"i\":2}\n",
        );
        let p1 = read_backward(&path, None, 2);
        assert_eq!(p1.entries.len(), 1);
        assert_eq!(p1.entries[0]["i"], 2);
        assert_eq!(p1.next_before, Some(17));
        let p2 = read_backward(&path, p1.next_before, 2);
        assert_eq!(p2.entries.len(), 1);
        assert_eq!(p2.entries[0]["i"], 1);
        assert_eq!(p2.next_before, None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_backward_includes_parseable_unterminated_tail_at_eof() {
        // At EOF the trailing unterminated segment IS part of the complete
        // window (hi == parts.len()), so a parseable torn tail line is
        // returned on the first page — the stream's newest entry.
        let path = scratch("tail", "{\"i\":0}\n{\"i\":1}");
        let br = read_backward(&path, None, 10);
        assert_eq!(br.entries.len(), 2);
        assert_eq!(br.entries[0]["i"], 0);
        assert_eq!(br.entries[1]["i"], 1);
        assert_eq!(br.next_before, None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_backward_end_offset_stops_before_a_torn_tail() {
        // A parseable tail was delivered, so the cursor may pass it.
        let path = scratch("end-parsed", "{\"i\":0}\n{\"i\":1}");
        assert_eq!(read_backward(&path, None, 10).end_offset, 15);
        let _ = std::fs::remove_file(&path);
        // A line omp is still writing was NOT delivered: the cursor must stop
        // at its start, or `?after=endOffset` skips it once it completes.
        let path = scratch("end-torn", "{\"i\":0}\n{\"i\":1,\"te");
        let br = read_backward(&path, None, 10);
        assert_eq!(br.entries.len(), 1);
        assert_eq!(br.end_offset, 8);
        let fr = read_forward_after_completion(&path, br.end_offset);
        assert_eq!(fr.entries.len(), 1);
        assert_eq!(fr.entries[0]["i"], 1);
        let _ = std::fs::remove_file(&path);
        // Terminated file: everything up to EOF is accounted for.
        let path = scratch("end-full", "{\"i\":0}\n{\"i\":1}\n");
        assert_eq!(read_backward(&path, None, 10).end_offset, 16);
        let _ = std::fs::remove_file(&path);
    }

    fn read_forward_after_completion(path: &Path, after: u64) -> ForwardRead {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(b"xt\":\"done\"}\n").unwrap();
        read_forward(path, after, 10)
    }

    #[test]
    fn read_backward_empty_and_missing_edge_cases() {
        let path = scratch("empty", "{\"i\":0}\n{\"i\":1}\n{\"i\":2}\n");
        // before == 0 → empty page, no next_before.
        let br = read_backward(&path, Some(0), 5);
        assert!(br.entries.is_empty());
        assert_eq!(br.next_before, None);
        // before beyond EOF is clamped to the file size (acts like None).
        let br = read_backward(&path, Some(999), 5);
        assert_eq!(br.entries.len(), 3);
        assert_eq!(br.next_before, None);
        // limit == 0 → empty page, no next_before.
        let br = read_backward(&path, None, 0);
        assert!(br.entries.is_empty());
        assert_eq!(br.next_before, None);
        let _ = std::fs::remove_file(&path);

        let missing = std::env::temp_dir().join(format!(
            "omp-pulse-jsonl-{}-missing.jsonl",
            std::process::id()
        ));
        let br = read_backward(&missing, None, 5);
        assert!(br.entries.is_empty());
        assert_eq!(br.next_before, None);
    }

    #[test]
    fn read_forward_limit_cuts_batch_without_data_loss() {
        let path = scratch("flimit", "{\"i\":0}\n{\"i\":1}\n{\"i\":2}\n{\"i\":3}\n");
        let f1 = read_forward(&path, 0, 2);
        assert_eq!(f1.entries.len(), 2);
        assert_eq!(f1.entries[0]["i"], 0);
        assert_eq!(f1.entries[1]["i"], 1);
        // The consumed-bytes fix: end_offset advances ONLY past the returned
        // entries (16 = past {"i":1}\n), never past the unreturned ones.
        assert_eq!(f1.end_offset, 16);
        let f2 = read_forward(&path, f1.end_offset, 2);
        assert_eq!(f2.entries.len(), 2);
        assert_eq!(f2.entries[0]["i"], 2);
        assert_eq!(f2.entries[1]["i"], 3);
        assert_eq!(f2.end_offset, 32);
        let f3 = read_forward(&path, f2.end_offset, 2);
        assert!(f3.entries.is_empty());
        assert_eq!(f3.end_offset, 32);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_forward_trailing_partial_not_consumed_until_newline() {
        let path = scratch("fpartial", "{\"i\":0}\n{\"i\":1}");
        let f1 = read_forward(&path, 0, 10);
        assert_eq!(f1.entries.len(), 1);
        assert_eq!(f1.entries[0]["i"], 0);
        // {"i":1} is not newline-terminated: never consumed.
        assert_eq!(f1.end_offset, 8);
        std::fs::write(&path, "{\"i\":0}\n{\"i\":1}\n").unwrap();
        let f2 = read_forward(&path, f1.end_offset, 10);
        assert_eq!(f2.entries.len(), 1);
        assert_eq!(f2.entries[0]["i"], 1);
        assert_eq!(f2.end_offset, 16);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_forward_after_past_end_returns_size_hint() {
        let path = scratch("fpast", "{\"i\":0}\n{\"i\":1}\n{\"i\":2}\n{\"i\":3}\n");
        let f = read_forward(&path, 100, 5);
        assert!(f.entries.is_empty());
        assert_eq!(f.end_offset, 32); // NOT 100: clamped to the file size
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_forward_empty_lines_consume_window_bytes() {
        let path = scratch("fempty", "{\"i\":0}\n\n{\"i\":2}\n");
        let f1 = read_forward(&path, 0, 1);
        assert_eq!(f1.entries.len(), 1);
        assert_eq!(f1.entries[0]["i"], 0);
        assert_eq!(f1.end_offset, 8);
        let f2 = read_forward(&path, f1.end_offset, 1);
        assert_eq!(f2.entries.len(), 1);
        assert_eq!(f2.entries[0]["i"], 2);
        // The empty line between the entries is within the consumed window.
        assert_eq!(f2.end_offset, 17);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_forward_limit_zero_reads_all_complete_lines() {
        // limit == 0 keeps the original all-lines end_offset advance but
        // returns nothing (matches the old loop's default `consumed`).
        let path = scratch("fzero", "{\"i\":0}\n{\"i\":1}\n{\"i\":2}\n{\"i\":3}\n");
        let f = read_forward(&path, 0, 0);
        assert!(f.entries.is_empty());
        assert_eq!(f.end_offset, 32);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_forward_line_spanning_chunks_is_captured_whole() {
        let pad = "a".repeat(400_000);
        let path = scratch(
            "fbig",
            &format!("{{\"i\":0,\"pad\":\"{pad}\"}}\n{{\"i\":1}}\n"),
        );
        let f = read_forward(&path, 0, 10);
        assert_eq!(f.entries.len(), 2);
        assert_eq!(f.entries[0]["pad"].as_str().unwrap().len(), 400_000);
        assert_eq!(f.entries[1]["i"], 1);
        assert_eq!(f.end_offset, std::fs::metadata(&path).unwrap().len());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_forward_missing_file_returns_after() {
        let missing = std::env::temp_dir().join(format!(
            "omp-pulse-jsonl-{}-fmissing.jsonl",
            std::process::id()
        ));
        let f = read_forward(&missing, 42, 5);
        assert!(f.entries.is_empty());
        assert_eq!(f.end_offset, 42);
    }
}
