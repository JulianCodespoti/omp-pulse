# Native attachment recovery tests

Run from the repository root:

    python3 mobile/android/host-tests/native-attachments/run.py
    python3 mobile/android/host-tests/native-attachments/run.py --mutations --output /tmp/native-attachment-proof
    python3 mobile/android/host-tests/native-receipts/run.py --mutations --output /tmp/native-receipt-proof

The new runner compiles the complete production NativeAttachmentRecovery class
with `java com.sun.tools.javac.Main -Xlint:all -Werror`. Its only source substitution
changes the ReentrantLock import to a deterministic lock boundary; production method
bodies remain unchanged. Android context, SQLite, Os, elapsed time, Thread and lock
boundaries are in-memory fixtures. It extracts the exact current SQLite Helper
from NativeOutbox, invokes its onCreate against SQL-recording boundaries, and
compiles its column-driven onUpgrade (executed by the receipt suite).

The core streaming policy uses a fake Directory boundary. The actual nested API26
SecureDirectory adapter is separately exercised with fake SecureDirectoryStream
handles, including opened-root substitution, parent-path substitution, constructor
failure cleanup, leaf substitution, no-follow options and anchored filename-only
unlink. No fixture points at app data or deletes real files.

Seventy-seven assertions cover positive orphan cleanup, global references, malformed
references, query/cursor/enumeration errors, root/leaf identities, unknown names,
symlinks/directories, bounds, quarantine and synchronous publication failures,
two restarts and API22 recreation followed by API26 startup, database-first lock
admission, busy insertion, one-attempt scheduling and rejected worker creation.
Eleven production mutations remove global reference protection, ownership admission,
quarantine recognition, unscoped reference reads, directory fsync and opened-root
identity checks, staging ownership through the exact insertion fixture, and opened
parent type/device/inode/nonblocking checks; each must fail with an assertion, not
a compilation error. A separate negative API-surface control reintroduces the
non-public O_DIRECTORY constant and must fail compilation. It is not counted as a
behavioral mutant. The corrected OsConstants fixture intentionally omits that
constant, matching the actual Android SDK failure that exposed the initial mistake.

The receipt integration suite retains the actual insertion code and now asserts
ownership at synthetic attachment staging and transaction end. Focused failures
verify release after staging error, rollback/failed-stage cleanup and success.
Its recovery guard is a no-op boundary; actual quarantine logic is exercised by the
new runner. The existing real Python SQLite migration/reopen checks remain intact.

## Limits

These are deterministic source-bound proofs, not Android runtime acceptance or real
thread/SQLite lock scheduling. NativeOutbox factory scheduling order and lock
enclosure are source assertions. Fake Os sync does not prove physical filesystem
durability. Real Android API22 class loading, API26 provider availability, device
restart/archive behavior, syscall enforcement, actual attachment disk I/O and full
repository gates are separate checks.

Primary AOSP sources support expected SecureDirectoryStream availability on stock
API26 and API35: Android8's UnixFileSystemProvider selects the secure stream when
native at-syscalls and O_NOFOLLOW exist; compiled UnixNativeDispatcher requires
symbols exported by Android8 bionic, including futimesat introduced in API26.
Non-supporting providers skip safely. Source expectation is not device proof.

- https://android.googlesource.com/platform/libcore/+/android-8.0.0_r1/ojluni/src/main/java/sun/nio/fs/UnixFileSystemProvider.java
- https://android.googlesource.com/platform/libcore/+/android-8.0.0_r1/ojluni/src/main/native/UnixNativeDispatcher.c
- https://android.googlesource.com/platform/bionic/+/android-8.0.0_r1/libc/libc.map.txt
