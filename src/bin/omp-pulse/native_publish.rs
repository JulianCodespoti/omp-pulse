//! Private, synchronous publication protocol for the Android archive importer.
//! This entry point must not touch daemon configuration, tracing, or Tokio.

pub fn run() -> Result<(), &'static str> {
    #[cfg(target_os = "linux")]
    {
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        linux::serve(&mut stdin.lock(), &mut stdout.lock())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("native publication is unsupported on this platform")
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::borrow::Cow;
    use std::ffi::CString;
    use std::io::{self, BufRead, Write};
    use std::path::Path;

    use serde::Deserialize;

    // Includes the terminating LF, and bounds storage even for an untrusted pipe.
    const MAX_REQUEST_BYTES: usize = 65_536;
    const PROTOCOL_ERROR: &str = "invalid native publication request";
    const IO_ERROR: &str = "native publication I/O failed";

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request<'a> {
        #[serde(borrow)]
        source: Cow<'a, str>,
        #[serde(borrow)]
        destination: Cow<'a, str>,
    }

    pub(super) fn serve(
        input: &mut impl BufRead,
        output: &mut impl Write,
    ) -> Result<(), &'static str> {
        let mut line = Vec::with_capacity(MAX_REQUEST_BYTES);
        while read_request(input, &mut line)? {
            // Derived struct deserializers also accept JSON arrays. This wire
            // protocol deliberately accepts only objects with the two named fields.
            if line.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
                return Err(PROTOCOL_ERROR);
            }
            let request: Request<'_> = serde_json::from_slice(&line).map_err(|_| PROTOCOL_ERROR)?;
            let errno = publish(&request.source, &request.destination);
            writeln!(output, "{errno}").map_err(|_| IO_ERROR)?;
            output.flush().map_err(|_| IO_ERROR)?;
        }
        Ok(())
    }

    fn read_request(input: &mut impl BufRead, line: &mut Vec<u8>) -> Result<bool, &'static str> {
        line.clear();
        loop {
            let available = input.fill_buf().map_err(|_| IO_ERROR)?;
            if available.is_empty() {
                return if line.is_empty() {
                    Ok(false)
                } else {
                    Err(PROTOCOL_ERROR)
                };
            }
            let count = available
                .iter()
                .take(MAX_REQUEST_BYTES - line.len() + 1)
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if count > MAX_REQUEST_BYTES - line.len() {
                return Err(PROTOCOL_ERROR);
            }
            line.extend_from_slice(&available[..count]);
            input.consume(count);
            if line.last() == Some(&b'\n') {
                return Ok(true);
            }
        }
    }

    fn publish(source: &str, destination: &str) -> i32 {
        if !Path::new(source).is_absolute() || !Path::new(destination).is_absolute() {
            return libc::EINVAL;
        }
        let (Ok(source), Ok(destination)) = (CString::new(source), CString::new(destination))
        else {
            return libc::EINVAL;
        };
        // SAFETY: both C strings remain live for the syscall. AT_FDCWD and
        // RENAME_NOREPLACE are Linux ABI constants; no pointers are retained.
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            0
        } else {
            // Never fall back to a replacing rename, a link, or a preflight check.
            io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;
        use std::fs;
        use std::io::{BufReader, Cursor, Read};
        use std::os::unix::fs::{MetadataExt, symlink};
        use std::path::PathBuf;
        use std::rc::Rc;
        use std::sync::atomic::{AtomicU64, Ordering};

        struct Scratch(PathBuf);

        impl Scratch {
            fn new() -> Self {
                static NEXT: AtomicU64 = AtomicU64::new(0);
                let path = std::env::temp_dir().join(format!(
                    "omp-pulse-native-publish-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&path).unwrap();
                Self(path)
            }

            fn path(&self, name: &str) -> PathBuf {
                self.0.join(name)
            }
        }

        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        fn rename(source: &Path, destination: &Path) -> i32 {
            publish(source.to_str().unwrap(), destination.to_str().unwrap())
        }

        fn request(source: &Path, destination: &Path) -> Vec<u8> {
            let mut bytes = serde_json::to_vec(&serde_json::json!({
                "source": source.to_str().unwrap(),
                "destination": destination.to_str().unwrap(),
            }))
            .unwrap();
            bytes.push(b'\n');
            bytes
        }

        #[test]
        fn exclusive_rename_moves_the_original_inode() {
            let scratch = Scratch::new();
            let source = scratch.path("source");
            let destination = scratch.path("destination");
            fs::write(&source, b"authenticated archive content").unwrap();
            let inode = fs::metadata(&source).unwrap().ino();

            assert_eq!(rename(&source, &destination), 0);
            assert!(!source.try_exists().unwrap());
            assert_eq!(
                fs::read(&destination).unwrap(),
                b"authenticated archive content"
            );
            assert_eq!(fs::metadata(&destination).unwrap().ino(), inode);
        }

        #[test]
        fn existing_destination_is_unchanged_and_source_is_retained() {
            let scratch = Scratch::new();
            let source = scratch.path("source");
            let destination = scratch.path("destination");
            fs::write(&source, b"staged content").unwrap();
            fs::write(&destination, b"existing conversation").unwrap();
            let source_inode = fs::metadata(&source).unwrap().ino();
            let destination_inode = fs::metadata(&destination).unwrap().ino();

            assert_eq!(rename(&source, &destination), libc::EEXIST);
            assert_eq!(fs::read(&source).unwrap(), b"staged content");
            assert_eq!(fs::read(&destination).unwrap(), b"existing conversation");
            assert_eq!(fs::metadata(&source).unwrap().ino(), source_inode);
            assert_eq!(fs::metadata(&destination).unwrap().ino(), destination_inode);
        }

        #[test]
        fn dangling_destination_symlink_is_not_replaced() {
            let scratch = Scratch::new();
            let source = scratch.path("source");
            let destination = scratch.path("destination");
            let missing = scratch.path("missing");
            fs::write(&source, b"staged content").unwrap();
            symlink(&missing, &destination).unwrap();
            let inode = fs::symlink_metadata(&destination).unwrap().ino();

            assert_eq!(rename(&source, &destination), libc::EEXIST);
            assert_eq!(fs::read(&source).unwrap(), b"staged content");
            assert_eq!(fs::read_link(&destination).unwrap(), missing);
            assert_eq!(fs::symlink_metadata(&destination).unwrap().ino(), inode);
            assert!(!missing.try_exists().unwrap());
        }

        #[test]
        fn kernel_errors_do_not_move_or_create_files() {
            let scratch = Scratch::new();
            let source = scratch.path("source");
            let destination = scratch.path("missing-parent/destination");
            fs::write(&source, b"staged content").unwrap();
            assert_eq!(rename(&source, &destination), libc::ENOENT);
            assert_eq!(fs::read(&source).unwrap(), b"staged content");
            assert!(!destination.try_exists().unwrap());

            let existing = scratch.path("existing");
            fs::write(&existing, b"existing content").unwrap();
            assert_eq!(rename(&scratch.path("absent"), &existing), libc::ENOENT);
            assert_eq!(fs::read(&existing).unwrap(), b"existing content");
        }

        #[test]
        fn invalid_paths_report_einval_without_touching_files() {
            let scratch = Scratch::new();
            let source = scratch.path("source");
            let destination = scratch.path("destination");
            fs::write(&source, b"staged content").unwrap();
            for invalid in ["", "relative/file", "/private/\0file"] {
                assert_eq!(
                    publish(invalid, destination.to_str().unwrap()),
                    libc::EINVAL
                );
                assert_eq!(publish(source.to_str().unwrap(), invalid), libc::EINVAL);
            }
            assert_eq!(fs::read(&source).unwrap(), b"staged content");
            assert!(!destination.try_exists().unwrap());
        }

        #[test]
        fn protocol_processes_multiple_requests_and_preserves_errno() {
            let scratch = Scratch::new();
            let source = scratch.path("source with \"quotes\" and \\ slash and café");
            let destination = scratch.path("destination");
            let second_source = scratch.path("second-source");
            fs::write(&source, b"first").unwrap();
            fs::write(&second_source, b"second").unwrap();
            let mut input = request(&source, &destination);
            input.extend(request(&second_source, &destination));
            input.extend(request(&scratch.path("absent"), &scratch.path("unused")));
            let mut output = Vec::new();

            serve(
                &mut BufReader::with_capacity(3, Cursor::new(input)),
                &mut output,
            )
            .unwrap();
            assert_eq!(
                output,
                format!("0\n{}\n{}\n", libc::EEXIST, libc::ENOENT).as_bytes()
            );
            assert!(!source.try_exists().unwrap());
            assert_eq!(fs::read(&destination).unwrap(), b"first");
            assert_eq!(fs::read(&second_source).unwrap(), b"second");
        }

        #[test]
        fn empty_stream_exits_cleanly() {
            let mut output = Vec::new();
            serve(&mut Cursor::new([]), &mut output).unwrap();
            assert!(output.is_empty());
        }

        #[test]
        fn strict_protocol_rejects_invalid_requests_without_responses() {
            let malformed: &[&[u8]] = &[
                b"\n",
                b"not-json\n",
                b"{}\n",
                b"[]\n",
                b"[\"/source\",\"/destination\"]\n",
                b"{\"source\":\"/s\"}\n",
                b"{\"source\":1,\"destination\":\"/d\"}\n",
                b"{\"source\":\"/s\",\"destination\":null}\n",
                b"{\"source\":\"/s\",\"destination\":\"/d\",\"extra\":true}\n",
                b"{\"source\":\"/s\",\"source\":\"/s\",\"destination\":\"/d\"}\n",
                b"{\"source\":\"/s\",\"destination\":\"/d\"}{}\n",
                b"{\"source\":\"/\xff\",\"destination\":\"/d\"}\n",
                b"{\"source\":\"/s\",\"destination\":\"/d\"}",
            ];
            for input in malformed {
                let mut output = Vec::new();
                assert_eq!(
                    serve(&mut Cursor::new(*input), &mut output),
                    Err(PROTOCOL_ERROR)
                );
                assert!(output.is_empty());
            }
        }

        #[test]
        fn malformed_or_unterminated_request_never_publishes() {
            let scratch = Scratch::new();
            let source = scratch.path("source");
            let destination = scratch.path("destination");
            fs::write(&source, b"staged content").unwrap();
            let mut unterminated = request(&source, &destination);
            unterminated.pop();
            let mut extra_field = unterminated.clone();
            extra_field.pop();
            extra_field.extend_from_slice(b",\"extra\":true}\n");
            for input in [unterminated, extra_field] {
                let mut output = Vec::new();
                assert_eq!(
                    serve(&mut Cursor::new(input), &mut output),
                    Err(PROTOCOL_ERROR)
                );
                assert!(output.is_empty());
                assert_eq!(fs::read(&source).unwrap(), b"staged content");
                assert!(!destination.try_exists().unwrap());
            }
        }

        #[test]
        fn encoded_limit_includes_newline_and_is_enforced_before_publication() {
            let scratch = Scratch::new();
            let source = scratch.path("source");
            let destination = scratch.path("destination");
            fs::write(&source, b"staged content").unwrap();
            let mut bounded = request(&source, &destination);
            bounded.pop();
            bounded.resize(MAX_REQUEST_BYTES - 1, b' ');
            bounded.push(b'\n');
            let mut oversized = bounded.clone();
            oversized.insert(oversized.len() - 1, b' ');
            let mut output = Vec::new();
            assert_eq!(
                serve(
                    &mut BufReader::with_capacity(17, Cursor::new(oversized)),
                    &mut output
                ),
                Err(PROTOCOL_ERROR)
            );
            assert!(output.is_empty());
            assert_eq!(fs::read(&source).unwrap(), b"staged content");
            assert!(!destination.try_exists().unwrap());

            serve(
                &mut BufReader::with_capacity(17, Cursor::new(bounded)),
                &mut output,
            )
            .unwrap();
            assert_eq!(output, b"0\n");
            assert!(!source.try_exists().unwrap());
            assert_eq!(fs::read(&destination).unwrap(), b"staged content");
        }

        #[test]
        fn oversized_unterminated_stream_uses_bounded_storage() {
            let mut input = BufReader::with_capacity(7, io::repeat(b'x').take(1_000_000));
            let mut line = Vec::with_capacity(MAX_REQUEST_BYTES);
            let capacity = line.capacity();
            assert_eq!(read_request(&mut input, &mut line), Err(PROTOCOL_ERROR));
            assert!(line.len() <= MAX_REQUEST_BYTES);
            assert_eq!(line.capacity(), capacity);
        }

        #[test]
        fn nul_and_relative_paths_are_valid_requests_with_einval_responses() {
            let input = b"{\"source\":\"/s\\u0000\",\"destination\":\"/d\"}\n\
                          {\"source\":\"relative\",\"destination\":\"/d\"}\n";
            let mut output = Vec::new();
            serve(&mut Cursor::new(input), &mut output).unwrap();
            assert_eq!(output, format!("{0}\n{0}\n", libc::EINVAL).as_bytes());
        }

        #[test]
        fn response_is_flushed_before_next_request_is_read() {
            struct FlushWriter(Rc<RefCell<Vec<u8>>>);

            impl Write for FlushWriter {
                fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                    self.0.borrow_mut().extend_from_slice(bytes);
                    Ok(bytes.len())
                }

                fn flush(&mut self) -> io::Result<()> {
                    assert_eq!(&*self.0.borrow(), b"22\n");
                    self.0.borrow_mut().clear();
                    Ok(())
                }
            }

            struct SerialReader {
                first: Cursor<Vec<u8>>,
                second: Cursor<Vec<u8>>,
                pending: Rc<RefCell<Vec<u8>>>,
            }

            impl Read for SerialReader {
                fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                    let available = self.fill_buf()?;
                    let count = bytes.len().min(available.len());
                    bytes[..count].copy_from_slice(&available[..count]);
                    self.consume(count);
                    Ok(count)
                }
            }

            impl BufRead for SerialReader {
                fn fill_buf(&mut self) -> io::Result<&[u8]> {
                    if self.first.position() < self.first.get_ref().len() as u64 {
                        self.first.fill_buf()
                    } else {
                        assert!(self.pending.borrow().is_empty(), "response was not flushed");
                        self.second.fill_buf()
                    }
                }

                fn consume(&mut self, count: usize) {
                    if self.first.position() < self.first.get_ref().len() as u64 {
                        self.first.consume(count);
                    } else {
                        self.second.consume(count);
                    }
                }
            }

            let pending = Rc::new(RefCell::new(Vec::new()));
            let invalid = b"{\"source\":\"relative\",\"destination\":\"/d\"}\n".to_vec();
            let mut input = SerialReader {
                first: Cursor::new(invalid.clone()),
                second: Cursor::new(invalid),
                pending: Rc::clone(&pending),
            };
            serve(&mut input, &mut FlushWriter(Rc::clone(&pending))).unwrap();
            assert!(pending.borrow().is_empty());
        }
    }
}
