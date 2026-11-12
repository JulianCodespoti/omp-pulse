package com.omppulse.app.runtime;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.IOException;

/** {@link Posix} backed by android.system.Os (API 21+). */
final class AndroidPosix implements Posix {
    static final AndroidPosix INSTANCE = new AndroidPosix();

    private AndroidPosix() {}

    @Override
    public void symlink(String target, File link) throws IOException {
        try {
            Os.symlink(target, link.getAbsolutePath());
        } catch (ErrnoException e) {
            throw new IOException("symlink " + link + " -> " + target + ": " + e.getMessage(), e);
        }
    }

    @Override
    public void chmod(File file, int mode) throws IOException {
        try {
            Os.chmod(file.getAbsolutePath(), mode & 07777);
        } catch (ErrnoException e) {
            throw new IOException("chmod " + file + ": " + e.getMessage(), e);
        }
    }

    @Override
    public boolean isSymlink(File file) {
        try {
            return OsConstants.S_ISLNK(Os.lstat(file.getAbsolutePath()).st_mode);
        } catch (ErrnoException e) {
            return false;
        }
    }

    @Override
    public String readlink(File file) {
        try {
            return Os.readlink(file.getAbsolutePath());
        } catch (ErrnoException e) {
            return null;
        }
    }
}
