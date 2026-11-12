package com.omppulse.app.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class HarnessSeedTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** In-memory asset tree laid out like packageHarnessSeed's output. */
    static final class Assets implements HarnessSeed.Source {
        final Map<String, byte[]> files = new HashMap<>();

        /** Seed from path → content; paths under bin/ are executable, as in the real harness. */
        static Assets of(Map<String, String> tree) {
            Assets a = new Assets();
            StringBuilder manifest = new StringBuilder();
            for (Map.Entry<String, String> e : new TreeMap<>(tree).entrySet()) {
                byte[] bytes = e.getValue().getBytes(StandardCharsets.UTF_8);
                String sha = sha256(bytes);
                a.files.put(HarnessSeed.BLOBS + sha, bytes);
                manifest.append(sha).append(e.getKey().startsWith("bin/") ? " 755 " : " 644 ").append(e.getKey()).append('\n');
            }
            a.files.put(HarnessSeed.MANIFEST, manifest.toString().getBytes(StandardCharsets.UTF_8));
            return a;
        }

        @Override
        public java.io.InputStream open(String name) throws IOException {
            byte[] b = files.get(name);
            if (b == null) throw new FileNotFoundException(name);
            return new ByteArrayInputStream(b);
        }
    }

    static Map<String, String> tree(String... pathsAndContents) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i < pathsAndContents.length; i += 2) m.put(pathsAndContents[i], pathsAndContents[i + 1]);
        return m;
    }

    static String sha256(byte[] bytes) {
        try {
            return HarnessSeed.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String manifestLine(String path) {
        return sha256(new byte[0]) + " 644 " + path + "\n";
    }

    @Test
    public void writesEveryFileWithItsMode() throws Exception {
        HarnessSeed seed = new HarnessSeed(Assets.of(tree(
                "agent/AGENTS.md", "rules\n", "bin/android", "#!/usr/bin/env python3\n", ".gitignore", "__pycache__/\n")));
        File out = tmp.newFolder("out");
        seed.writeTo(out, new NioPosix());
        assertEquals("rules\n", new String(Files.readAllBytes(new File(out, "agent/AGENTS.md").toPath()), StandardCharsets.UTF_8));
        assertEquals("dotfiles survive", "__pycache__/\n",
                new String(Files.readAllBytes(new File(out, ".gitignore").toPath()), StandardCharsets.UTF_8));
        assertEquals(0755, NioPosix.mode(new File(out, "bin/android")));
        assertEquals(0644, NioPosix.mode(new File(out, "agent/AGENTS.md")));
        assertEquals(Arrays.asList(".gitignore", "agent/AGENTS.md", "bin/android"),
                Arrays.asList(seed.entries.get(0).path, seed.entries.get(1).path, seed.entries.get(2).path));
    }

    @Test
    public void digestChangesWithAnyContent() throws Exception {
        String a = new HarnessSeed(Assets.of(tree("a", "1"))).digest;
        assertEquals(a, new HarnessSeed(Assets.of(tree("a", "1"))).digest);
        assertNotEquals(a, new HarnessSeed(Assets.of(tree("a", "2"))).digest);
        assertNotEquals(a, new HarnessSeed(Assets.of(tree("b", "1"))).digest);
    }

    @Test
    public void rejectsPathsOutsideTheRepoOrIntoGitMetadata() {
        for (String bad : new String[] {"../x", "/etc/passwd", "a/../../x", ".git/config", "a/.git/hooks/x", "a//b", "a/", "./a", "a\\b"}) {
            try {
                HarnessSeed.parse(manifestLine(bad));
                fail("accepted " + bad);
            } catch (IOException expected) {
                // a bad manifest is a build bug; nothing is seeded
            }
        }
    }

    @Test
    public void rejectsDuplicatesMalformedLinesAndEmptyManifests() {
        String[] bad = {manifestLine("a") + manifestLine("a"), "nothex 644 a\n", sha256(new byte[0]) + " 600 a\n", "", "\n"};
        for (String manifest : bad) {
            try {
                HarnessSeed.parse(manifest);
                fail("accepted " + manifest);
            } catch (IOException expected) {
                // rejected as a whole
            }
        }
    }

    @Test
    public void blobNotMatchingItsManifestFails() throws Exception {
        Assets assets = Assets.of(tree("agent/AGENTS.md", "rules\n"));
        for (Map.Entry<String, byte[]> e : assets.files.entrySet()) {
            if (e.getKey().startsWith(HarnessSeed.BLOBS)) e.setValue("tampered".getBytes(StandardCharsets.UTF_8));
        }
        try {
            new HarnessSeed(assets).writeTo(tmp.newFolder("out"), new NioPosix());
            fail("expected a hash mismatch");
        } catch (IOException expected) {
            // a stale manifest must not seed wrong bytes
        }
    }
}
