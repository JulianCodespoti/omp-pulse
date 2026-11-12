package com.omppulse.app.runtime;

import java.io.File;
import java.io.IOException;

/**
 * The few POSIX file operations java.io.File lacks.
 *
 * WHY an interface: production uses android.system.Os (java.nio.file needs API 26), while JVM unit
 * tests cannot call android.system.Os (android.jar stubs throw), so tests supply a java.nio
 * implementation.
 */
interface Posix {
    void symlink(String target, File link) throws IOException;

    /** Sets permission bits (07777 mask); never follows into anything but {@code file} itself. */
    void chmod(File file, int mode) throws IOException;

    /** True when {@code file} itself is a symlink (dangling links included). */
    boolean isSymlink(File file);

    /** Target of a symlink, or null when {@code file} is not one. */
    String readlink(File file);
}
