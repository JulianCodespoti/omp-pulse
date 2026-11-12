package com.omppulse.app.runtime;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The phone harness seed the APK carries: omp-pulse's {@code phone-harness/} directory, packaged by the
 * Gradle task {@code packageHarnessSeed}.
 *
 * Asset layout under {@code phone/}: {@code harness.manifest} has one line per file,
 * {@code <sha256> <644|755> <path>}, sorted by path; {@code harness/<sha256>} holds that file's
 * bytes. WHY content-addressed: aapt's asset filters drop dotfiles ({@code .gitignore}) and the
 * build's ignore patterns ({@code *.gz}, {@code *.map}, …), and assets carry no file modes; a
 * manifest of hashes keeps every harness path, its exec bit and its exact bytes.
 *
 * The seed's identity ({@link #digest}) is the sha256 of the manifest, which covers every path,
 * mode and content hash: equal digests mean an identical seed.
 */
final class HarnessSeed {
    /** Opens an asset by name relative to {@code phone/}. */
    interface Source {
        InputStream open(String name) throws IOException;
    }

    static final String MANIFEST = "harness.manifest";
    static final String BLOBS = "harness/";

    /** One seed file. */
    static final class Entry {
        final String sha256;
        final boolean executable;
        final String path;

        Entry(String sha256, boolean executable, String path) {
            this.sha256 = sha256;
            this.executable = executable;
            this.path = path;
        }
    }

    private final Source source;
    final List<Entry> entries;
    final String digest;

    HarnessSeed(Source source) throws IOException {
        this.source = source;
        byte[] manifest = readAll(source.open(MANIFEST));
        this.digest = hex(sha256().digest(manifest));
        this.entries = parse(new String(manifest, StandardCharsets.UTF_8));
    }

    /**
     * Parses a manifest. Rejects anything that could write outside the target directory or into a
     * repository's metadata (absolute paths, {@code ..}, {@code .git}), duplicates and malformed
     * lines: a bad manifest is a build bug, and seeding half of it would commit a broken harness.
     */
    static List<Entry> parse(String text) throws IOException {
        List<Entry> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String line : text.split("\n")) {
            if (line.isEmpty()) continue;
            String[] f = line.split(" ", 3);
            if (f.length != 3 || !f[0].matches("[0-9a-f]{64}") || !(f[1].equals("644") || f[1].equals("755"))) {
                throw new IOException("bad harness manifest line: " + line);
            }
            String path = f[2];
            if (!safeRelative(path)) throw new IOException("unsafe harness path: " + path);
            if (!seen.add(path)) throw new IOException("duplicate harness path: " + path);
            out.add(new Entry(f[0], f[1].equals("755"), path));
        }
        if (out.isEmpty()) throw new IOException("empty harness manifest");
        return Collections.unmodifiableList(out);
    }

    private static boolean safeRelative(String path) {
        if (path.isEmpty() || path.startsWith("/") || path.endsWith("/") || path.contains("\\")) return false;
        for (String seg : path.split("/", -1)) {
            if (seg.isEmpty() || seg.equals(".") || seg.equals("..") || seg.equals(".git")) return false;
        }
        return true;
    }

    /**
     * Writes every seed file under {@code dir} with its mode, verifying each file's sha256 so a
     * manifest that went stale against its blobs fails instead of seeding wrong bytes.
     */
    void writeTo(File dir, Posix posix) throws IOException {
        byte[] buf = new byte[8192];
        for (Entry e : entries) {
            File dest = new File(dir, e.path);
            File parent = dest.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create " + parent);
            MessageDigest md = sha256();
            try (InputStream in = source.open(BLOBS + e.sha256);
                 FileOutputStream out = new FileOutputStream(dest)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);
                }
            }
            if (!hex(md.digest()).equals(e.sha256)) throw new IOException("harness asset does not match its manifest: " + e.path);
            posix.chmod(dest, e.executable ? 0755 : 0644);
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream src = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = src.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        return sb.toString();
    }
}
