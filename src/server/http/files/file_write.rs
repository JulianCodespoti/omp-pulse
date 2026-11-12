//! Serialised conditional project saves with same-directory staged replacement.

use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

// The admission semaphore allows two jobs and is NOT a write lock. Keep path
// resolution, comparison and publication under this process-wide boundary,
// including saves reached through different sessions or symlink aliases.
static SAVES: Mutex<()> = Mutex::new(());

pub(super) fn serialise<T>(operation: impl FnOnce() -> T) -> T {
    let _guard = SAVES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation()
}

pub(crate) fn validate_target(target: &Path) -> io::Result<()> {
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        // The HTTP resolver canonicalises legitimate in-cwd symlinks. Refuse
        // unresolved replacements and special files without opening them.
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[derive(Debug)]
pub(super) enum Error {
    Conflict,
    Io(io::Error),
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

fn matches(target: &Path, expected: &str) -> io::Result<bool> {
    validate_target(target)?;
    let mut file = match fs::File::open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let mut buffer = [0; 8192];
    let mut offset = 0;
    loop {
        let count = match file.read(&mut buffer) {
            Ok(0) => return Ok(offset == expected.len()),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let end = offset + count;
        if expected.as_bytes().get(offset..end) != Some(&buffer[..count]) {
            return Ok(false);
        }
        offset = end;
    }
}

struct Staged(PathBuf);

impl Staged {
    fn new(parent: &Path, content: &str, permissions: Option<fs::Permissions>) -> io::Result<Self> {
        let (staged, mut file) = loop {
            let path = parent.join(format!(".pulse-file-save-{:032x}", rand::random::<u128>()));
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            if permissions.is_some() {
                use std::os::unix::fs::OpenOptionsExt;
                // Never expose a private file's draft under the default umask.
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => break (Self(path), file),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        };
        file.write_all(content.as_bytes())?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)?;
        }
        file.sync_all()?;
        Ok(staged)
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn publish_new(staged: &Path, target: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let staged = CString::new(staged.as_os_str().as_bytes())?;
        let target = CString::new(target.as_os_str().as_bytes())?;
        // A staged hard link passed reads but became inaccessible after the
        // daemon exited under phone proot. Publish a real directory entry
        // without replacing a file another writer created in the meantime.
        // The raw syscall, not libc::renameat2: the musl that cargo-zigbuild links
        // for the phone runtime has no renameat2 wrapper (undefined symbol).
        // SAFETY: both paths are live NUL-terminated buffers; no pointers escape.
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                staged.as_ptr(),
                libc::AT_FDCWD,
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        fs::hard_link(staged, target)
    }
}

/// Caller holds SAVES from before resolving the confined target.
///
/// The compare/replace boundary serialises Pulse saves only. Atomic replacement
/// avoids partial files, but is NOT compare-and-swap against arbitrary external
/// writers: omp does not share this lock, and can write after our final compare.
/// Do not describe this as protecting that external-writer commit-time race.
pub(super) fn save(target: &Path, content: &str, expected: Option<&str>) -> Result<(), Error> {
    validate_target(target)?;
    match expected {
        Some(expected) if !matches(target, expected)? => {
            return Err(Error::Conflict);
        }
        None if target.try_exists()? => return Err(Error::Conflict),
        _ => {}
    }
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "file has no parent"))?;
    fs::create_dir_all(parent)?;
    let permissions = if expected.is_some() {
        Some(fs::metadata(target)?.permissions())
    } else {
        None
    };
    let staged = Staged::new(parent, content, permissions)?;
    if let Some(expected) = expected {
        // Stage first, then compare again so slow writes/fsync do not enlarge
        // the external-writer race. This second read is still not external CAS.
        if !matches(target, expected)? {
            return Err(Error::Conflict);
        }
        fs::rename(&staged.0, target)?;
    } else {
        // Publication must not replace a file created after the initial check.
        match publish_new(&staged.0, target) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(Error::Conflict);
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
