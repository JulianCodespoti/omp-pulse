package com.omppulse.app.runtime;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermission;
import java.util.EnumSet;
import java.util.Set;

/** JVM {@link Posix} for unit tests (android.system.Os is a stub off-device). */
final class NioPosix implements Posix {
    @Override
    public void symlink(String target, File link) throws IOException {
        Files.createSymbolicLink(link.toPath(), Paths.get(target));
    }

    @Override
    public void chmod(File file, int mode) throws IOException {
        Set<PosixFilePermission> perms = EnumSet.noneOf(PosixFilePermission.class);
        PosixFilePermission[] order = {
                PosixFilePermission.OTHERS_EXECUTE, PosixFilePermission.OTHERS_WRITE, PosixFilePermission.OTHERS_READ,
                PosixFilePermission.GROUP_EXECUTE, PosixFilePermission.GROUP_WRITE, PosixFilePermission.GROUP_READ,
                PosixFilePermission.OWNER_EXECUTE, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_READ,
        };
        for (int bit = 0; bit < order.length; bit++) {
            if ((mode & (1 << bit)) != 0) perms.add(order[bit]);
        }
        Files.setPosixFilePermissions(file.toPath(), perms);
    }

    @Override
    public boolean isSymlink(File file) {
        return Files.isSymbolicLink(file.toPath());
    }

    @Override
    public String readlink(File file) {
        try {
            Path p = file.toPath();
            return Files.isSymbolicLink(p) ? Files.readSymbolicLink(p).toString() : null;
        } catch (IOException e) {
            return null;
        }
    }

    static int mode(File f) throws IOException {
        int mode = 0;
        Set<PosixFilePermission> perms = Files.getPosixFilePermissions(f.toPath(), LinkOption.NOFOLLOW_LINKS);
        if (perms.contains(PosixFilePermission.OWNER_READ)) mode |= 0400;
        if (perms.contains(PosixFilePermission.OWNER_WRITE)) mode |= 0200;
        if (perms.contains(PosixFilePermission.OWNER_EXECUTE)) mode |= 0100;
        if (perms.contains(PosixFilePermission.GROUP_READ)) mode |= 040;
        if (perms.contains(PosixFilePermission.GROUP_WRITE)) mode |= 020;
        if (perms.contains(PosixFilePermission.GROUP_EXECUTE)) mode |= 010;
        if (perms.contains(PosixFilePermission.OTHERS_READ)) mode |= 04;
        if (perms.contains(PosixFilePermission.OTHERS_WRITE)) mode |= 02;
        if (perms.contains(PosixFilePermission.OTHERS_EXECUTE)) mode |= 01;
        return mode;
    }
}
