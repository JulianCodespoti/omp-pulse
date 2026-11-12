package com.omppulse.app.runtime;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Downloads pinned artifacts: resumable, mirror-aware, sha256-verified.
 *
 * Files are content-addressed ({@code downloads/<sha256>}), so a file at its final name has
 * already been verified, and a {@code .part} file can be resumed from any mirror (they all serve
 * the same bytes, or the hash check rejects them).
 *
 * INVARIANT: nothing is renamed to its final name before its sha256 matches the pin.
 */
final class Fetcher {
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    /** Attempts per URL; each one resumes from what earlier attempts saved. */
    private static final int ATTEMPTS_PER_URL = 3;

    private final File dir;

    Fetcher(File downloadsDir) {
        this.dir = downloadsDir;
    }

    File target(RuntimeSpec.Artifact a) {
        return new File(dir, a.sha256);
    }

    private File part(RuntimeSpec.Artifact a) {
        return new File(dir, a.sha256 + ".part");
    }

    /** Bytes still to transfer for {@code a} (0 when already downloaded). */
    long remaining(RuntimeSpec.Artifact a) {
        if (target(a).isFile()) return 0;
        long have = part(a).length();
        return have > a.bytes ? a.bytes : a.bytes - have;
    }

    /** Removes downloads that belong to no current pin (e.g. a .part of a superseded version). */
    void pruneExcept(RuntimeSpec.Artifact... keep) {
        File[] entries = dir.listFiles();
        if (entries == null) return;
        outer:
        for (File f : entries) {
            for (RuntimeSpec.Artifact a : keep) {
                if (f.getName().equals(a.sha256) || f.getName().equals(a.sha256 + ".part")) continue outer;
            }
            f.delete();
        }
    }

    /**
     * Returns the verified file for {@code a}, downloading what is missing.
     *
     * @param progress receives (bytes on disk, a.bytes) as the transfer advances
     */
    File fetch(RuntimeSpec.Artifact a, Progress progress) throws IOException {
        File target = target(a);
        if (target.isFile()) return target;
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File part = part(a);
        IOException last = null;
        for (String url : a.urls()) {
            for (int attempt = 0; attempt < ATTEMPTS_PER_URL; attempt++) {
                try {
                    transfer(url, part, a.bytes, progress);
                    String actual = sha256(part);
                    if (!actual.equals(a.sha256)) {
                        // A corrupt prefix would poison every resume; start over cleanly.
                        part.delete();
                        throw new IOException("checksum mismatch from " + host(url));
                    }
                    if (!part.renameTo(target)) throw new IOException("cannot move " + part + " to " + target);
                    return target;
                } catch (IOException e) {
                    last = e;
                }
                if (Thread.currentThread().isInterrupted()) throw new IOException("download cancelled");
            }
        }
        throw new IOException("download failed (" + (last == null ? "no URL" : last.getMessage())
                + "). Check the internet connection and try again.", last);
    }

    private static void transfer(String url, File part, long expected, Progress progress) throws IOException {
        long have = part.length();
        if (have > expected) {
            part.delete();
            have = 0;
        }
        if (have == expected) return; // complete; the caller verifies it
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            // Identity encoding keeps byte offsets meaningful for Range and the size check.
            conn.setRequestProperty("Accept-Encoding", "identity");
            if (have > 0) conn.setRequestProperty("Range", "bytes=" + have + "-");
            int code = conn.getResponseCode();
            boolean append;
            if (code == HttpURLConnection.HTTP_PARTIAL && have > 0) {
                append = true;
            } else if (code == HttpURLConnection.HTTP_OK) {
                append = false; // server ignored Range: restart from zero
                have = 0;
            } else if (code == 416) {
                // Range not satisfiable: the .part does not match this server's file.
                part.delete();
                throw new IOException("HTTP 416 from " + host(url));
            } else {
                throw new IOException("HTTP " + code + " from " + host(url));
            }
            byte[] buf = new byte[1 << 16];
            try (InputStream in = conn.getInputStream();
                 OutputStream out = new FileOutputStream(part, append)) {
                progress.update(have, expected);
                int n;
                while ((n = in.read(buf)) > 0) {
                    have += n;
                    if (have > expected) {
                        throw new IOException("server sent more than the pinned " + expected + " bytes");
                    }
                    out.write(buf, 0, n);
                    progress.update(have, expected);
                    if (Thread.currentThread().isInterrupted()) throw new IOException("download cancelled");
                }
            }
            if (have != expected) throw new IOException("connection closed at " + have + " of " + expected + " bytes");
        } finally {
            conn.disconnect();
        }
    }

    static String sha256(File file) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException("SHA-256 unavailable", e);
        }
        byte[] buf = new byte[1 << 16];
        try (InputStream in = new FileInputStream(file)) {
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder(64);
        for (byte b : md.digest()) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }

    private static String host(String url) {
        try {
            return new URL(url).getHost();
        } catch (IOException e) {
            return url;
        }
    }
}
