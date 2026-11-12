//! Pure reader regressions for bounded project-file previews; no filesystem I/O.

use super::{MAX_FILE_READ, read_file_preview};
use std::{
    collections::VecDeque,
    io::{self, Cursor, Read},
};

struct ShortReader {
    bytes: Vec<u8>,
    position: usize,
    chunk: usize,
    faults: VecDeque<(usize, io::ErrorKind)>,
}

impl ShortReader {
    fn new(bytes: impl Into<Vec<u8>>, chunk: usize) -> Self {
        assert!(chunk > 0);
        Self {
            bytes: bytes.into(),
            position: 0,
            chunk,
            faults: VecDeque::new(),
        }
    }

    fn fault(mut self, offset: usize, kind: io::ErrorKind) -> Self {
        self.faults.push_back((offset, kind));
        self
    }
}

impl Read for ShortReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let before_fault = if let Some(&(offset, kind)) = self.faults.front() {
            assert!(offset >= self.position);
            if offset == self.position {
                self.faults.pop_front();
                return Err(io::Error::new(kind, "injected read failure"));
            }
            offset - self.position
        } else {
            usize::MAX
        };
        let count = buf
            .len()
            .min(self.chunk)
            .min(self.bytes.len() - self.position)
            .min(before_fault);
        buf[..count].copy_from_slice(&self.bytes[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }
}

#[test]
fn complete_file_is_not_silently_reduced_to_first_short_read() {
    let bytes = b"complete readable file content";
    let (preview, truncated) = read_file_preview(ShortReader::new(bytes, 2)).unwrap();
    assert_eq!(preview, bytes);
    assert!(!truncated);
}

#[test]
fn empty_source_returns_empty_complete_preview() {
    let (preview, truncated) = read_file_preview(Cursor::new([])).unwrap();
    assert!(preview.is_empty());
    assert!(!truncated);
}

#[test]
fn shorter_source_reaches_eof_without_padding() {
    // A prior metadata sample can be larger after a concurrent shrink. It is
    // deliberately not an input to the helper or a reason to pad/fail at EOF.
    let (preview, truncated) = read_file_preview(ShortReader::new(b"now small", 1)).unwrap();
    assert_eq!(preview, b"now small");
    assert!(!truncated);
}

#[test]
fn exactly_limit_is_complete_after_short_reads() {
    let bytes = vec![b'x'; MAX_FILE_READ as usize];
    let (preview, truncated) = read_file_preview(ShortReader::new(bytes.clone(), 997)).unwrap();
    assert_eq!(preview, bytes);
    assert!(!truncated);
}

#[test]
fn extra_byte_marks_truncation_and_is_not_returned() {
    let mut bytes = vec![b'x'; MAX_FILE_READ as usize];
    bytes.push(b'!');
    let mut reader = ShortReader::new(bytes, 997);
    let (preview, truncated) = read_file_preview(&mut reader).unwrap();
    assert_eq!(preview, vec![b'x'; MAX_FILE_READ as usize]);
    assert!(truncated);
    assert_eq!(reader.position as u64, MAX_FILE_READ + 1);
}

#[test]
fn arbitrarily_growing_reader_is_bounded_by_limit_plus_one() {
    struct GrowingReader(u64);
    impl Read for GrowingReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            // There is always more data, regardless of any earlier metadata.
            buf.fill(b'g');
            self.0 += buf.len() as u64;
            assert!(self.0 <= MAX_FILE_READ + 1);
            Ok(buf.len())
        }
    }
    let mut reader = GrowingReader(0);
    let (preview, truncated) = read_file_preview(&mut reader).unwrap();
    assert_eq!(preview, vec![b'g'; MAX_FILE_READ as usize]);
    assert!(truncated);
    assert_eq!(reader.0, MAX_FILE_READ + 1);
}

#[test]
fn interrupted_reads_retry_before_and_between_chunks() {
    let reader = ShortReader::new(b"interrupted content", 2)
        .fault(0, io::ErrorKind::Interrupted)
        .fault(0, io::ErrorKind::Interrupted)
        .fault(3, io::ErrorKind::Interrupted);
    let (preview, truncated) = read_file_preview(reader).unwrap();
    assert_eq!(preview, b"interrupted content");
    assert!(!truncated);
}

#[test]
fn error_before_bytes_is_propagated() {
    let reader = ShortReader::new(b"unread", 2).fault(0, io::ErrorKind::PermissionDenied);
    let error = read_file_preview(reader).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(error.to_string(), "injected read failure");
}

#[test]
fn error_after_partial_content_is_not_partial_success() {
    let mut reader = ShortReader::new(b"partial content", 2).fault(5, io::ErrorKind::Other);
    let error = read_file_preview(&mut reader).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert_eq!(reader.position, 5);
}

#[test]
fn would_block_is_an_error_not_an_end_of_file_or_retry() {
    let reader = ShortReader::new(b"partial content", 2).fault(3, io::ErrorKind::WouldBlock);
    assert_eq!(
        read_file_preview(reader).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

#[test]
fn failure_on_probe_is_not_a_complete_preview() {
    let reader = ShortReader::new(vec![b'x'; MAX_FILE_READ as usize + 1], 997)
        .fault(MAX_FILE_READ as usize, io::ErrorKind::Other);
    assert_eq!(
        read_file_preview(reader).unwrap_err().kind(),
        io::ErrorKind::Other
    );
}

#[test]
fn interrupted_probe_retries_and_detects_extra_byte() {
    let reader = ShortReader::new(vec![b'x'; MAX_FILE_READ as usize + 1], 997)
        .fault(MAX_FILE_READ as usize, io::ErrorKind::Interrupted);
    let (preview, truncated) = read_file_preview(reader).unwrap();
    assert_eq!(preview.len() as u64, MAX_FILE_READ);
    assert!(truncated);
}

#[test]
fn reading_stops_before_errors_beyond_the_probe() {
    let mut reader = ShortReader::new(vec![b'x'; MAX_FILE_READ as usize + 2], 997)
        .fault(MAX_FILE_READ as usize + 1, io::ErrorKind::Other);
    let (preview, truncated) = read_file_preview(&mut reader).unwrap();
    assert_eq!(preview.len() as u64, MAX_FILE_READ);
    assert!(truncated);
    assert_eq!(reader.faults.len(), 1);
}

#[test]
fn unicode_is_reassembled_before_lossy_decoding() {
    let text = "café 👋\n";
    let (preview, truncated) = read_file_preview(ShortReader::new(text.as_bytes(), 1)).unwrap();
    assert_eq!(String::from_utf8_lossy(&preview), text);
    assert!(!truncated);
}

#[test]
fn invalid_utf8_keeps_lossy_replacement_behavior() {
    let (preview, truncated) = read_file_preview(ShortReader::new(b"a\xffb", 1)).unwrap();
    assert_eq!(String::from_utf8_lossy(&preview), "a\u{fffd}b");
    assert!(!truncated);
}

#[test]
fn unicode_split_at_payload_limit_keeps_existing_lossy_boundary() {
    let mut bytes = vec![b'x'; MAX_FILE_READ as usize - 1];
    bytes.extend_from_slice("é".as_bytes());
    let (preview, truncated) = read_file_preview(ShortReader::new(bytes, 997)).unwrap();
    assert_eq!(preview.len() as u64, MAX_FILE_READ);
    assert_eq!(preview.last(), Some(&0xc3));
    assert!(String::from_utf8_lossy(&preview).ends_with('\u{fffd}'));
    assert!(truncated);
}

#[test]
fn binary_sniff_stays_limited_to_first_8192_payload_bytes() {
    for offset in [8191, 8192, MAX_FILE_READ as usize] {
        let mut bytes = vec![b'x'; MAX_FILE_READ as usize + 1];
        bytes[offset] = 0;
        let (preview, truncated) = read_file_preview(ShortReader::new(bytes, 997)).unwrap();
        let binary = preview[..preview.len().min(8192)].contains(&0);
        assert_eq!(binary, offset < 8192);
        assert!(truncated);
        assert_eq!(preview.len() as u64, MAX_FILE_READ);
    }
}
