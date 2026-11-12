package com.omppulse.app.runtime;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Small file helpers shared by the runtime classes. Pure Java. */
final class RuntimeIo {
    private RuntimeIo() {}

    static String drain(InputStream in) throws IOException {
        try (InputStream src = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = src.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    static String readText(File file) throws IOException {
        return drain(new FileInputStream(file)).trim();
    }

    /** Reads a small text file, or null when it is absent/unreadable. */
    static String readTextOrNull(File file) {
        try {
            return readText(file);
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * Writes via a sibling temp file and rename so readers (and a crash mid-write) never observe a
     * truncated file.
     */
    static void writeTextAtomic(File file, String text) throws IOException {
        File dir = file.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(file)) {
            tmp.delete();
            throw new IOException("cannot replace " + file);
        }
    }

    /** Recursive delete that removes symlinks themselves and never follows them. */
    static void deleteTree(File file, Posix posix) {
        if (file == null) return;
        boolean link = posix.isSymlink(file);
        if (!link && !file.exists()) return;
        if (!link && file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteTree(child, posix);
            }
        }
        file.delete();
    }

    /** Last 600 characters of process output: enough to show why a command failed. */
    static String tail(String s) {
        String t = s.trim();
        return t.length() > 600 ? t.substring(t.length() - 600) : t;
    }

    static String join(String sep, String[] parts) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) sb.append(sep);
            sb.append(parts[i]);
        }
        return sb.toString();
    }

    static String megabytes(long bytes) {
        return ((bytes + (1 << 20) - 1) >> 20) + " MB";
    }
}
