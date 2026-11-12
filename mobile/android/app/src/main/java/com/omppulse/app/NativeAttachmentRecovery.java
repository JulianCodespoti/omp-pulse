package com.omppulse.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Build;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.util.Log;

import java.io.File;
import java.io.FileDescriptor;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

/** Bounded, fail-closed reclamation of app-owned attachment files with no SQL reference. */
final class NativeAttachmentRecovery {
    private static final String TAG = "OmpAttachmentRecovery";
    private static final String DIRECTORY = "native-outbox";
    private static final String QUARANTINE = "native-outbox-recovery.quarantine";
    private static final int MAX_REFERENCES = 4096;
    private static final int MAX_ENTRIES = 4096;
    private static final int MAX_DELETIONS = 256;
    private static final long BUDGET_MS = 250;
    private static final Pattern NAME = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.b64");
    private static final AtomicBoolean ATTEMPTED = new AtomicBoolean();
    static final ReentrantLock OWNERSHIP = new ReentrantLock();

    private NativeAttachmentRecovery() {}

    /** Called after helper publication, outside the helper monitor; never waits for the worker. */
    static void schedule(Context context, SQLiteOpenHelper helper) {
        if (Build.VERSION.SDK_INT < 26 || !ATTEMPTED.compareAndSet(false, true)) return;
        Context app = context.getApplicationContext();
        try {
            Thread worker = new Thread(() -> run(app, helper), "omp-attachment-recovery");
            worker.setDaemon(true);
            worker.start();
        } catch (RuntimeException failure) {
            Log.w(TAG, "Attachment recovery worker unavailable; files retained", failure);
        }
    }

    private static void run(Context context, SQLiteOpenHelper helper) {
        try {
            // Never wait for ownership while holding an opening/migration transaction.
            SQLiteDatabase db = helper.getWritableDatabase();
            if (db.inTransaction() || !OWNERSHIP.tryLock()) return;
            try {
                if (!authorized(context, db)) return;
                // NIO classes are resolved only through the API26 implementation.
                Api26.recover(context, db);
            } finally {
                OWNERSHIP.unlock();
            }
        } catch (Exception failure) {
            Log.w(TAG, "Attachment recovery stopped; remaining files retained", failure);
        }
    }

    private static boolean authorized(Context context, SQLiteDatabase db) throws ErrnoException, IOException {
        File parent = context.getFilesDir();
        StructStat stat = lstat(parent);
        return db.isOpen() && !db.inTransaction() && stat != null
                && OsConstants.S_ISDIR(stat.st_mode)
                && lstat(new File(parent, QUARANTINE)) == null;
    }

    /** Runs before CREATE on every supported API; never acquires OWNERSHIP. */
    static void beforeDatabaseCreate(Context context) {
        try {
            File parent = context.getFilesDir();
            StructStat parentStat = lstat(parent);
            if (parentStat == null || !OsConstants.S_ISDIR(parentStat.st_mode))
                throw new IOException("Private attachment parent is not a directory");
            File marker = new File(parent, QUARANTINE);
            if (lstat(marker) == null && lstat(new File(parent, DIRECTORY)) == null) return;
            if (lstat(marker) == null) {
                FileDescriptor fd = Os.open(marker.getAbsolutePath(),
                        OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL
                                | OsConstants.O_NOFOLLOW, 0600);
                try { Os.fsync(fd); } finally { Os.close(fd); }
            }
            // Marker existence alone means quarantine, including zero-length interrupted publication.
            FileDescriptor directory = Os.open(parent.getAbsolutePath(),
                    OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_NONBLOCK, 0);
            try {
                // O_DIRECTORY is not public SDK API. Validate the opened no-follow handle instead.
                StructStat opened = Os.fstat(directory);
                if (!OsConstants.S_ISDIR(opened.st_mode) || opened.st_dev != parentStat.st_dev
                        || opened.st_ino != parentStat.st_ino)
                    throw new IOException("Private attachment parent changed during open");
                Os.fsync(directory);
            } finally { Os.close(directory); }
        } catch (Exception failure) {
            // Do not complete DB recreation if the next process could mistake unknown refs for none.
            throw new SQLiteException("Cannot preserve attachment recovery quarantine", failure);
        }
    }

    private static StructStat lstat(File file) throws ErrnoException {
        try { return Os.lstat(file.getAbsolutePath()); }
        catch (ErrnoException missing) {
            if (missing.errno == OsConstants.ENOENT) return null;
            throw missing;
        }
    }

    /** Minimal streaming boundary; keeps the ownership policy independently testable. */
    interface Directory extends AutoCloseable {
        String absolutePath();
        Entry next() throws IOException;
        boolean unchanged() throws IOException;
        boolean deleteIfSame(Entry entry) throws IOException;
        @Override void close() throws IOException;
    }

    static final class Entry {
        final String name;
        final boolean regular;
        final Object identity;
        Entry(String name, boolean regular, Object identity) {
            this.name = name;
            this.regular = regular;
            this.identity = identity;
        }
    }

    /** Caller owns OWNERSHIP and a trusted open DB; no deletion until both scans finish. */
    static void recover(Context context, SQLiteDatabase db, Directory directory) throws Exception {
        long started = SystemClock.elapsedRealtime();
        Set<String> referenced = new HashSet<>();
        String prefix = directory.absolutePath() + File.separator;
        int count = 0;
        try (Cursor rows = db.query("attachments", new String[]{"file_path"},
                null, null, null, null, null)) {
            while (rows.moveToNext()) {
                if (++count > MAX_REFERENCES || expired(started)) return;
                String path = rows.getString(0);
                if (path == null || !path.startsWith(prefix)
                        || !NAME.matcher(path.substring(prefix.length())).matches()) return;
                referenced.add(path);
            }
        }
        List<Entry> candidates = new ArrayList<>();
        count = 0;
        Entry entry;
        while ((entry = directory.next()) != null) {
            if (++count > MAX_ENTRIES || expired(started)) return;
            if (entry.regular && NAME.matcher(entry.name).matches()
                    && !referenced.contains(prefix + entry.name)) {
                if (entry.identity == null) return;
                candidates.add(entry);
            }
        }
        if (expired(started) || !authorized(context, db) || !directory.unchanged()) return;
        int deleted = 0;
        for (Entry candidate : candidates) {
            if (deleted >= MAX_DELETIONS || expired(started)
                    || !authorized(context, db) || !directory.unchanged()) return;
            if (directory.deleteIfSame(candidate)) deleted++;
        }
    }

    private static boolean expired(long started) {
        return SystemClock.elapsedRealtime() - started >= BUDGET_MS;
    }

    /** No NIO types escape this class; API22–25 never load it. */
    private static final class Api26 {
        static void recover(Context context, SQLiteDatabase db) throws Exception {
            java.nio.file.Path parent = context.getFilesDir().toPath();
            try (java.nio.file.DirectoryStream<java.nio.file.Path> opened =
                         java.nio.file.Files.newDirectoryStream(parent)) {
                if (!(opened instanceof java.nio.file.SecureDirectoryStream<?>)) return;
                @SuppressWarnings("unchecked")
                java.nio.file.SecureDirectoryStream<java.nio.file.Path> secureParent =
                        (java.nio.file.SecureDirectoryStream<java.nio.file.Path>) opened;
                java.nio.file.Path name = parent.getFileSystem().getPath(DIRECTORY);
                java.nio.file.attribute.BasicFileAttributes root = secureParent.getFileAttributeView(
                        name, java.nio.file.attribute.BasicFileAttributeView.class,
                        java.nio.file.LinkOption.NOFOLLOW_LINKS).readAttributes();
                if (!root.isDirectory() || root.isSymbolicLink() || root.fileKey() == null) return;
                try (SecureDirectory directory = new SecureDirectory(secureParent, name,
                        parent.resolve(name).toAbsolutePath().toString(), root.fileKey())) {
                    NativeAttachmentRecovery.recover(context, db, directory);
                }
            }
        }

        private static final class SecureDirectory implements Directory {
            private final java.nio.file.SecureDirectoryStream<java.nio.file.Path> parent;
            private final java.nio.file.SecureDirectoryStream<java.nio.file.Path> child;
            private final java.nio.file.Path name;
            private final String absolute;
            private final Object identity;
            private final java.util.Iterator<java.nio.file.Path> entries;

            SecureDirectory(java.nio.file.SecureDirectoryStream<java.nio.file.Path> parent,
                            java.nio.file.Path name, String absolute, Object identity) throws IOException {
                this.parent = parent;
                this.name = name;
                this.absolute = absolute;
                this.identity = identity;
                child = parent.newDirectoryStream(name, java.nio.file.LinkOption.NOFOLLOW_LINKS);
                try {
                    java.nio.file.attribute.BasicFileAttributes opened = child.getFileAttributeView(
                            java.nio.file.attribute.BasicFileAttributeView.class).readAttributes();
                    if (!opened.isDirectory() || opened.isSymbolicLink() || !identity.equals(opened.fileKey()))
                        throw new IOException("Attachment directory identity changed during open");
                    entries = child.iterator();
                } catch (IOException | RuntimeException | Error failure) {
                    try { child.close(); } catch (IOException closeFailure) { failure.addSuppressed(closeFailure); }
                    throw failure;
                }
            }

            @Override public String absolutePath() { return absolute; }

            @Override public Entry next() throws IOException {
                if (!entries.hasNext()) return null;
                java.nio.file.Path path = entries.next().getFileName();
                java.nio.file.attribute.BasicFileAttributes attrs = attributes(path);
                return new Entry(path.toString(), attrs.isRegularFile() && !attrs.isSymbolicLink(), attrs.fileKey());
            }

            private java.nio.file.attribute.BasicFileAttributes attributes(java.nio.file.Path path) throws IOException {
                return child.getFileAttributeView(path, java.nio.file.attribute.BasicFileAttributeView.class,
                        java.nio.file.LinkOption.NOFOLLOW_LINKS).readAttributes();
            }

            @Override public boolean unchanged() throws IOException {
                java.nio.file.attribute.BasicFileAttributes opened = child.getFileAttributeView(
                        java.nio.file.attribute.BasicFileAttributeView.class).readAttributes();
                java.nio.file.attribute.BasicFileAttributes attrs = parent.getFileAttributeView(
                        name, java.nio.file.attribute.BasicFileAttributeView.class,
                        java.nio.file.LinkOption.NOFOLLOW_LINKS).readAttributes();
                return opened.isDirectory() && !opened.isSymbolicLink() && identity.equals(opened.fileKey())
                        && attrs.isDirectory() && !attrs.isSymbolicLink() && identity.equals(attrs.fileKey());
            }

            @Override public boolean deleteIfSame(Entry entry) throws IOException {
                java.nio.file.Path path = name.getFileSystem().getPath(entry.name);
                java.nio.file.attribute.BasicFileAttributes attrs = attributes(path);
                if (!attrs.isRegularFile() || attrs.isSymbolicLink() || !entry.identity.equals(attrs.fileKey())) return false;
                child.deleteFile(path);
                return true;
            }

            @Override public void close() throws IOException { child.close(); }
        }
    }
}
