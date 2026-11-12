package com.omppulse.app.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.GZIPOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class TarExtractorTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private final TarExtractor extractor = new TarExtractor(new NioPosix());

    /** Minimal ustar writer for test archives. */
    private static final class Tar {
        private final ByteArrayOutputStream out = new ByteArrayOutputStream();

        Tar dir(String name, int mode) {
            return entry(name, '5', mode, "", new byte[0]);
        }

        Tar file(String name, int mode, String content) {
            return entry(name, '0', mode, "", content.getBytes(StandardCharsets.UTF_8));
        }

        Tar symlink(String name, String target) {
            return entry(name, '2', 0777, target, new byte[0]);
        }

        Tar hardlink(String name, String target) {
            return entry(name, '1', 0644, target, new byte[0]);
        }

        /** GNU long-name record followed by the real entry with a truncated name. */
        Tar longFile(String name, String content) {
            byte[] n = (name + "\0").getBytes(StandardCharsets.UTF_8);
            entry("././@LongLink", 'L', 0, "", n);
            return entry(name.substring(0, 99), '0', 0644, "", content.getBytes(StandardCharsets.UTF_8));
        }

        Tar paxPath(String path, String content) {
            String rec = " path=" + path + "\n";
            int len = rec.length() + 1;
            while ((len + rec).length() != len) len = (len + rec).length();
            entry("PaxHeaders/x", 'x', 0644, "", (len + rec).getBytes(StandardCharsets.UTF_8));
            return entry("placeholder", '0', 0644, "", content.getBytes(StandardCharsets.UTF_8));
        }

        Tar entry(String name, char type, int mode, String link, byte[] data) {
            byte[] h = new byte[512];
            put(h, 0, 100, name);
            put(h, 100, 8, String.format("%07o", mode));
            put(h, 108, 8, "0000000");
            put(h, 116, 8, "0000000");
            put(h, 124, 12, String.format("%011o", data.length));
            put(h, 136, 12, "00000000000");
            h[156] = (byte) type;
            put(h, 157, 100, link);
            put(h, 257, 6, "ustar");
            put(h, 263, 2, "00");
            for (int i = 148; i < 156; i++) h[i] = ' ';
            int sum = 0;
            for (byte b : h) sum += b & 0xff;
            put(h, 148, 8, String.format("%06o", sum) + "\0 ");
            out.write(h, 0, 512);
            out.write(data, 0, data.length);
            int pad = (512 - data.length % 512) % 512;
            out.write(new byte[pad], 0, pad);
            return this;
        }

        byte[] bytes() {
            out.write(new byte[1024], 0, 1024);
            return out.toByteArray();
        }

        private static void put(byte[] h, int off, int len, String s) {
            byte[] b = s.getBytes(StandardCharsets.UTF_8);
            System.arraycopy(b, 0, h, off, Math.min(b.length, len));
        }
    }

    private File extract(Tar tar) throws IOException {
        File dest = new File(tmp.getRoot(), "out");
        extractor.extract(new ByteArrayInputStream(tar.bytes()), dest);
        return dest;
    }

    private static String read(File f) throws IOException {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    @Test
    public void extractsFilesDirectoriesAndModes() throws IOException {
        File out = extract(new Tar()
                .dir("./", 0755)
                .dir("./usr/bin/", 0755)
                .file("./usr/bin/tool", 0755, "#!/bin/sh\n")
                .file("/etc/motd", 0444, "hello"));
        assertEquals("#!/bin/sh\n", read(new File(out, "usr/bin/tool")));
        assertEquals(0755, NioPosix.mode(new File(out, "usr/bin/tool")));
        // Absolute names land inside the destination; owner write is always kept.
        assertEquals("hello", read(new File(out, "etc/motd")));
        assertEquals(0644, NioPosix.mode(new File(out, "etc/motd")));
    }

    @Test
    public void createsSymlinksVerbatim() throws IOException {
        File out = extract(new Tar()
                .file("bin/busybox", 0755, "bb")
                .symlink("bin/sh", "/bin/busybox")
                .symlink("usr/lib/libz.so.1", "libz.so.1.3"));
        assertTrue(Files.isSymbolicLink(new File(out, "bin/sh").toPath()));
        assertEquals("/bin/busybox", Files.readSymbolicLink(new File(out, "bin/sh").toPath()).toString());
        assertEquals("libz.so.1.3", Files.readSymbolicLink(new File(out, "usr/lib/libz.so.1").toPath()).toString());
    }

    @Test
    public void materialisesHardlinksAsCopies() throws IOException {
        File out = extract(new Tar()
                .file("usr/bin/a", 0755, "payload")
                .hardlink("usr/bin/b", "./usr/bin/a"));
        File b = new File(out, "usr/bin/b");
        assertFalse(Files.isSymbolicLink(b.toPath()));
        assertEquals("payload", read(b));
    }

    @Test
    public void rejectsPathTraversal() throws IOException {
        expectUnsafe(new Tar().file("../escape", 0644, "x"));
        expectUnsafe(new Tar().file("usr/../../escape", 0644, "x"));
        assertFalse(new File(tmp.getRoot(), "escape").exists());
    }

    @Test
    public void rejectsHardlinkTraversal() throws IOException {
        expectUnsafe(new Tar().hardlink("stolen", "../../etc/passwd"));
    }

    @Test
    public void rejectsHardlinkToUnknownFile() throws IOException {
        expectUnsafe(new Tar().hardlink("b", "missing"));
    }

    @Test
    public void rejectsWritingThroughAnArchiveSymlink() throws IOException {
        File outside = tmp.newFolder("outside");
        expectUnsafe(new Tar()
                .symlink("evil", outside.getAbsolutePath())
                .file("evil/planted", 0644, "x"));
        assertFalse(new File(outside, "planted").exists());
    }

    @Test
    public void replacingASymlinkWithAFileDoesNotFollowIt() throws IOException {
        File victim = tmp.newFile("victim");
        File out = extract(new Tar()
                .symlink("x", victim.getAbsolutePath())
                .file("x", 0644, "new"));
        assertEquals("", read(victim));
        assertFalse(Files.isSymbolicLink(new File(out, "x").toPath()));
        assertEquals("new", read(new File(out, "x")));
    }

    @Test
    public void supportsGnuLongNamesAndPaxPaths() throws IOException {
        String longName = "usr/share/" + repeat("d", 120) + "/file";
        File out = extract(new Tar()
                .longFile(longName, "long")
                .paxPath("opt/pax/named", "pax"));
        assertEquals("long", read(new File(out, longName)));
        assertEquals("pax", read(new File(out, "opt/pax/named")));
        assertFalse(new File(out, "placeholder").exists());
    }

    @Test
    public void rejectsCorruptHeaderChecksum() {
        byte[] bytes = new Tar().file("a", 0644, "x").bytes();
        bytes[0] = 'b';
        try {
            extractor.extract(new ByteArrayInputStream(bytes), new File(tmp.getRoot(), "out"));
            fail("expected checksum failure");
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("checksum"));
        }
    }

    @Test
    public void extractsGzipFilesWithProgress() throws IOException {
        File archive = tmp.newFile("a.tar.gz");
        try (GZIPOutputStream gz = new GZIPOutputStream(new FileOutputStream(archive))) {
            gz.write(new Tar().file("bin/busybox", 0755, "bb").bytes());
        }
        final long[] last = {0, 0};
        File dest = new File(tmp.getRoot(), "gz");
        extractor.extractTarGz(archive, dest, (done, total) -> {
            last[0] = done;
            last[1] = total;
        });
        assertEquals("bb", read(new File(dest, "bin/busybox")));
        assertEquals(archive.length(), last[1]);
        assertEquals(archive.length(), last[0]);
    }

    @Test
    public void normalizeStripsDotsAndSlashes() throws IOException {
        assertEquals("usr/bin", TarExtractor.normalize("./usr//bin/"));
        assertEquals("", TarExtractor.normalize("./"));
        assertEquals("etc/hosts", TarExtractor.normalize("/etc/./hosts"));
    }

    private void expectUnsafe(Tar tar) throws IOException {
        File dest = new File(tmp.getRoot(), "unsafe" + System.nanoTime());
        try {
            extractor.extract(new ByteArrayInputStream(tar.bytes()), dest);
            fail("expected the archive to be rejected");
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().startsWith("unsafe archive"));
        }
    }

    private static String repeat(String s, int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(s);
        return sb.toString();
    }
}
