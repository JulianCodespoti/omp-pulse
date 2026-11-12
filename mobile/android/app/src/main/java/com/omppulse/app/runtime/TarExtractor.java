package com.omppulse.app.runtime;

import java.io.BufferedInputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.GZIPInputStream;

/**
 * Extracts a (gzip-compressed) tar archive in pure Java.
 *
 * WHY not /system/bin/tar: toybox tar differs across OEMs and Android releases (some builds lack
 * it or its gzip support), and its failure output is not actionable for users.
 *
 * Supports ustar, GNU long names/links ('L'/'K') and pax extended headers ('x'); regular files,
 * directories, symlinks and hardlinks. Devices and FIFOs are skipped because proot binds the host
 * /dev. Ownership is ignored (proot -0 fakes root).
 *
 * INVARIANT: the destination is an empty directory, and nothing is ever written outside it:
 * entry names containing ".." are rejected, absolute names are made relative, and no entry may be
 * created beneath a symlink the archive itself created (writing through it would escape).
 */
final class TarExtractor {
    private static final int BLOCK = 512;
    /** Upper bound for in-memory metadata entries (long names, pax headers). */
    private static final long MAX_META = 1 << 20;

    private final Posix posix;

    TarExtractor(Posix posix) {
        this.posix = posix;
    }

    /** Extracts a .tar.gz file, reporting progress over the compressed bytes read. */
    void extractTarGz(File archive, File dest, Progress progress) throws IOException {
        long total = archive.length();
        try (InputStream raw = new CountingInputStream(new FileInputStream(archive), total, progress);
             InputStream gz = new GZIPInputStream(new BufferedInputStream(raw, 1 << 16), 1 << 16)) {
            extract(gz, dest);
        }
    }

    /** Extracts an uncompressed tar stream into {@code dest} (created if absent). */
    void extract(InputStream in, File dest) throws IOException {
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("cannot create " + dest);
        Set<String> symlinks = new HashSet<>();
        Set<String> files = new HashSet<>();
        List<File> dirs = new ArrayList<>();
        List<Integer> dirModes = new ArrayList<>();
        byte[] header = new byte[BLOCK];
        String longName = null;
        String longLink = null;
        Map<String, String> pax = null;

        while (readBlock(in, header)) {
            if (allZero(header)) break; // end-of-archive marker
            verifyChecksum(header);
            char type = (char) header[156];
            long size = number(header, 124, 12);

            if (type == 'L' || type == 'K' || type == 'x' || type == 'g') {
                byte[] data = readMeta(in, size);
                if (type == 'L') longName = cString(data, 0, data.length);
                else if (type == 'K') longLink = cString(data, 0, data.length);
                else if (type == 'x') pax = parsePax(data);
                // 'g' (global pax) carries nothing we use.
                continue;
            }

            String name = longName != null ? longName : ustarName(header);
            String link = longLink != null ? longLink : cString(header, 157, 100);
            if (pax != null) {
                if (pax.containsKey("path")) name = pax.get("path");
                if (pax.containsKey("linkpath")) link = pax.get("linkpath");
                if (pax.containsKey("size")) {
                    try {
                        size = Long.parseLong(pax.get("size"));
                    } catch (NumberFormatException e) {
                        throw new IOException("corrupt archive: bad pax size for " + name);
                    }
                }
            }
            longName = null;
            longLink = null;
            pax = null;
            if (size < 0) throw new IOException("corrupt archive: negative size for " + name);

            int mode = (int) number(header, 100, 8);
            String rel = normalize(name);
            if (rel.isEmpty()) { // the archive root itself ("./")
                skip(in, padded(size));
                continue;
            }
            requireNotUnderSymlink(rel, name, symlinks);
            File target = new File(dest, rel);

            switch (type) {
                case '5':
                    if (symlinks.contains(rel) || files.contains(rel)) {
                        throw new IOException("unsafe archive: directory replaces a link or file: " + name);
                    }
                    if (!target.isDirectory() && !target.mkdirs()) throw new IOException("cannot create " + target);
                    dirs.add(target);
                    dirModes.add(mode);
                    skip(in, padded(size));
                    break;
                case '0':
                case '\0':
                case '7': // contiguous file: a regular file everywhere that matters
                    replace(target, rel, symlinks, files);
                    try (OutputStream out = new FileOutputStream(target)) {
                        copy(in, out, size);
                    }
                    skip(in, padded(size) - size);
                    // WHY | 0600: the app UID is the real owner; it must always be able to update
                    // or delete what it extracted (proot reports the guest's fake root anyway).
                    posix.chmod(target, mode | 0600);
                    files.add(rel);
                    break;
                case '2':
                    if (link.isEmpty()) throw new IOException("corrupt archive: empty symlink target for " + name);
                    replace(target, rel, symlinks, files);
                    // Symlink targets are interpreted inside the guest (proot), so absolute targets
                    // are legitimate; safety comes from never writing beneath a created link.
                    posix.symlink(link, target);
                    symlinks.add(rel);
                    skip(in, padded(size));
                    break;
                case '1': {
                    String source = normalize(link);
                    if (source.isEmpty()) throw new IOException("corrupt archive: empty hardlink target for " + name);
                    requireNotUnderSymlink(source, link, symlinks);
                    if (!files.contains(source)) {
                        throw new IOException("unsafe archive: hardlink " + name + " to " + link + ", which is not a file extracted earlier");
                    }
                    replace(target, rel, symlinks, files);
                    // WHY copy instead of link(2): Android's SELinux policy denies hard links in
                    // app data, so a copy is the only portable way to materialise the entry.
                    try (InputStream src = new FileInputStream(new File(dest, source));
                         OutputStream out = new FileOutputStream(target)) {
                        copy(src, out, new File(dest, source).length());
                    }
                    posix.chmod(target, mode | 0600);
                    files.add(rel);
                    skip(in, padded(size));
                    break;
                }
                default:
                    // Character/block devices, FIFOs and vendor extensions: nothing to create.
                    skip(in, padded(size));
                    break;
            }
        }

        // Directory modes last: a read-only directory mode applied early would block its children.
        for (int i = 0; i < dirs.size(); i++) {
            posix.chmod(dirs.get(i), dirModes.get(i) | 0700);
        }
    }

    /**
     * Relative, normalised form of an archive path ("./usr/bin/" → "usr/bin").
     *
     * @throws IOException for any ".." component: such entries could escape the destination
     */
    static String normalize(String name) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (String part : name.split("/")) {
            if (part.isEmpty() || part.equals(".")) continue;
            if (part.equals("..")) throw new IOException("unsafe archive: path traversal in " + name);
            if (sb.length() > 0) sb.append('/');
            sb.append(part);
        }
        return sb.toString();
    }

    private static void requireNotUnderSymlink(String rel, String name, Set<String> symlinks) throws IOException {
        for (int i = rel.indexOf('/'); i >= 0; i = rel.indexOf('/', i + 1)) {
            if (symlinks.contains(rel.substring(0, i))) {
                throw new IOException("unsafe archive: " + name + " lies beneath a symlink");
            }
        }
    }

    /** Clears whatever an earlier entry left at {@code target} so a new entry never writes through it. */
    private void replace(File target, String rel, Set<String> symlinks, Set<String> files) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create " + parent);
        if (posix.isSymlink(target) || target.isFile()) {
            if (!target.delete()) throw new IOException("cannot replace " + target);
        } else if (target.exists()) {
            throw new IOException("unsafe archive: entry replaces a directory: " + rel);
        }
        symlinks.remove(rel);
        files.remove(rel);
    }

    private static String ustarName(byte[] h) {
        String name = cString(h, 0, 100);
        boolean ustar = h[257] == 'u' && h[258] == 's' && h[259] == 't' && h[260] == 'a' && h[261] == 'r';
        if (ustar) {
            String prefix = cString(h, 345, 155);
            if (!prefix.isEmpty()) return prefix + "/" + name;
        }
        return name;
    }

    private static void verifyChecksum(byte[] h) throws IOException {
        long stored = number(h, 148, 8);
        long unsigned = 0;
        long signed = 0;
        for (int i = 0; i < BLOCK; i++) {
            int b = (i >= 148 && i < 156) ? ' ' : h[i];
            unsigned += b & 0xff;
            signed += (i >= 148 && i < 156) ? ' ' : h[i];
        }
        // Historic tars summed signed bytes; accept either like GNU tar does.
        if (stored != unsigned && stored != signed) throw new IOException("corrupt archive: header checksum mismatch");
    }

    /** Octal (NUL/space terminated) or GNU base-256 numeric field. */
    static long number(byte[] h, int off, int len) throws IOException {
        if ((h[off] & 0x80) != 0) {
            long v = h[off] & 0x3f;
            if ((h[off] & 0x40) != 0) throw new IOException("corrupt archive: negative numeric field");
            for (int i = off + 1; i < off + len; i++) {
                if (v > (Long.MAX_VALUE >> 8)) throw new IOException("corrupt archive: numeric field overflow");
                v = (v << 8) | (h[i] & 0xff);
            }
            return v;
        }
        int i = off;
        int end = off + len;
        while (i < end && (h[i] == ' ' || h[i] == 0)) i++;
        long v = 0;
        for (; i < end && h[i] != 0 && h[i] != ' '; i++) {
            int d = h[i] - '0';
            if (d < 0 || d > 7) throw new IOException("corrupt archive: bad octal field");
            v = (v << 3) | d;
        }
        return v;
    }

    private static String cString(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    /** Pax records: "<len> <key>=<value>\n", where len counts the whole record in bytes. */
    private static Map<String, String> parsePax(byte[] data) throws IOException {
        Map<String, String> out = new HashMap<>();
        int pos = 0;
        while (pos < data.length) {
            if (data[pos] == 0) break;
            int space = pos;
            while (space < data.length && data[space] != ' ') space++;
            int len;
            try {
                len = Integer.parseInt(new String(data, pos, space - pos, StandardCharsets.US_ASCII));
            } catch (NumberFormatException e) {
                throw new IOException("corrupt archive: bad pax record");
            }
            if (len <= 0 || pos + len > data.length || space >= pos + len) throw new IOException("corrupt archive: bad pax record");
            String record = new String(data, space + 1, pos + len - space - 1, StandardCharsets.UTF_8);
            if (record.endsWith("\n")) record = record.substring(0, record.length() - 1);
            int eq = record.indexOf('=');
            if (eq > 0) out.put(record.substring(0, eq), record.substring(eq + 1));
            pos += len;
        }
        return out;
    }

    private static byte[] readMeta(InputStream in, long size) throws IOException {
        if (size < 0 || size > MAX_META) throw new IOException("corrupt archive: metadata entry of " + size + " bytes");
        byte[] data = new byte[(int) size];
        readFully(in, data, 0, data.length);
        skip(in, padded(size) - size);
        return data;
    }

    private static long padded(long size) {
        return (size + BLOCK - 1) / BLOCK * BLOCK;
    }

    /** Reads one header block; false on a clean EOF at a block boundary. */
    private static boolean readBlock(InputStream in, byte[] block) throws IOException {
        int n = in.read(block, 0, BLOCK);
        if (n < 0) return false;
        readFully(in, block, n, BLOCK - n);
        return true;
    }

    private static void readFully(InputStream in, byte[] b, int off, int len) throws IOException {
        while (len > 0) {
            int n = in.read(b, off, len);
            if (n < 0) throw new EOFException("truncated archive");
            off += n;
            len -= n;
        }
    }

    private static void copy(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buf = new byte[1 << 16];
        long left = size;
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) throw new EOFException("truncated archive");
            out.write(buf, 0, n);
            left -= n;
        }
    }

    private static void skip(InputStream in, long n) throws IOException {
        byte[] buf = null;
        while (n > 0) {
            long s = in.skip(n);
            if (s > 0) {
                n -= s;
                continue;
            }
            // skip() may legally return 0 before EOF; fall back to reading.
            if (buf == null) buf = new byte[BLOCK * 16];
            int r = in.read(buf, 0, (int) Math.min(buf.length, n));
            if (r < 0) throw new EOFException("truncated archive");
            n -= r;
        }
    }

    private static boolean allZero(byte[] b) {
        for (byte x : b) {
            if (x != 0) return false;
        }
        return true;
    }

    /** Reports how much of the compressed file has been consumed. */
    private static final class CountingInputStream extends FilterInputStream {
        private final long total;
        private final Progress progress;
        private long done;

        CountingInputStream(InputStream in, long total, Progress progress) {
            super(in);
            this.total = total;
            this.progress = progress;
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            if (b >= 0) advance(1);
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, len);
            if (n > 0) advance(n);
            return n;
        }

        @Override
        public long skip(long n) throws IOException {
            long s = super.skip(n);
            if (s > 0) advance(s);
            return s;
        }

        private void advance(long n) {
            done += n;
            progress.update(done, total);
        }
    }
}
