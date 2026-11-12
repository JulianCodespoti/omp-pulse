package com.omppulse.app.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * The "Phone tools for the agent" opt-in: what the guest gets with it off and on, and that turning
 * it off removes only what the app created. Guest paths live under a temporary rootfs; link targets
 * are guest-absolute, so they dangle on the host and are compared as strings.
 */
public class HarnessInstallTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private final NioPosix posix = new NioPosix();
    private final List<String> warnings = new ArrayList<>();
    private RuntimePaths paths;
    private HarnessInstall install;
    private int seeds;
    private final HarnessInstall.Seeder seeder = () -> {
        seeds++;
        guest(HarnessInstall.DIR).mkdirs();
    };

    @Before
    public void setUp() throws IOException {
        File base = tmp.newFolder("phone");
        paths = new RuntimePaths(base, tmp.newFolder("lib"), tmp.newFolder("storage"), posix);
        guest("/").mkdirs();
        install = new HarnessInstall(paths, posix, (message, e) -> warnings.add(message));
    }

    private File guest(String path) {
        return paths.inRootfs(path);
    }

    private String link(String path) {
        return posix.readlink(guest(path));
    }

    private void write(String path, String content) throws IOException {
        File f = guest(path);
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), content.getBytes(StandardCharsets.UTF_8));
    }

    private String read(String path) throws IOException {
        return new String(Files.readAllBytes(guest(path).toPath()), StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> mcpServers() throws IOException {
        Map<String, Object> config = (Map<String, Object>) Json.parse(RuntimeIo.readText(guest(HarnessInstall.MCP_CONFIG)));
        return (Map<String, Object>) config.get("mcpServers");
    }

    private void writeMcp(Map<String, Object> servers) throws IOException {
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("mcpServers", servers);
        write(HarnessInstall.MCP_CONFIG, Json.write(config));
    }

    private static Map<String, Object> otherServer() {
        Map<String, Object> other = new LinkedHashMap<>();
        other.put("type", "stdio");
        other.put("command", "/root/bin/mine");
        return other;
    }

    @Test
    public void newInstallDefaultsOffAndAChoiceIsKept() {
        assertFalse("no harness yet: a new install starts without phone tools", install.enabled(null));
        assertTrue(install.enabled(true));
        assertFalse(install.enabled(false));
    }

    @Test
    public void upgradeWithAnExistingHarnessDefaultsOn() {
        guest(HarnessInstall.DIR).mkdirs();
        assertTrue("an earlier build seeded the harness: keep the agent's phone tools", install.enabled(null));
        assertFalse("the user's own choice still wins", install.enabled(false));
    }

    @Test
    public void offSeedsAndLinksNothing() throws Exception {
        install.apply(false, seeder);
        assertEquals(0, seeds);
        assertFalse(guest(HarnessInstall.DIR).exists());
        for (String path : Arrays.asList("/root/.omp/agent/AGENTS.md", "/root/.omp/agent/skills", "/root/.omp/agent/.env",
                "/root/.omp/agent/extensions/heavy-jobs.ts", "/usr/local/bin/android", "/usr/local/bin/node")) {
            assertFalse(path, posix.isSymlink(guest(path)) || guest(path).exists());
        }
        assertFalse(guest(HarnessInstall.MCP_CONFIG).exists());
        assertFalse(guest(HarnessInstall.TRACKING).exists());
        assertEquals(new ArrayList<String>(), warnings);
    }

    @Test
    public void onSeedsLinksAndRegistersThePhoneMcpServer() throws Exception {
        install.apply(true, seeder);
        assertEquals(1, seeds);
        String dir = HarnessInstall.DIR;
        assertEquals(dir + "/agent/AGENTS.md", link("/root/.omp/agent/AGENTS.md"));
        assertEquals(dir + "/agent/skills", link("/root/.omp/agent/skills"));
        assertEquals(dir + "/agent/env", link("/root/.omp/agent/.env"));
        assertEquals(dir + "/agent/extensions/heavy-jobs.ts", link("/root/.omp/agent/extensions/heavy-jobs.ts"));
        assertEquals(dir + "/bin/android", link("/usr/local/bin/android"));
        assertEquals(dir + "/bin/shims/gradle", link("/usr/local/bin/gradle"));
        assertEquals(HarnessInstall.phoneMcpEntry(), mcpServers().get(HarnessInstall.MCP_SERVER));
        assertTrue(guest(HarnessInstall.TRACKING).isFile());
    }

    @Test
    public void onLeavesTheUsersOwnFilesAlone() throws Exception {
        write("/root/.omp/agent/.env", "MINE=1\n");
        Map<String, Object> tuned = HarnessInstall.phoneMcpEntry();
        tuned.put("timeout", 5L);
        Map<String, Object> servers = new LinkedHashMap<>();
        servers.put(HarnessInstall.MCP_SERVER, tuned);
        writeMcp(servers);
        install.apply(true, seeder);
        assertFalse(posix.isSymlink(guest("/root/.omp/agent/.env")));
        assertEquals("MINE=1\n", read("/root/.omp/agent/.env"));
        assertEquals(tuned, mcpServers().get(HarnessInstall.MCP_SERVER));
    }

    @Test
    public void turningOffRemovesOnlyWhatTheAppCreated() throws Exception {
        write("/root/.omp/agent/.env", "MINE=1\n");
        Map<String, Object> servers = new LinkedHashMap<>();
        servers.put("other", otherServer());
        writeMcp(servers);
        install.apply(true, seeder);
        // The user points a link of the app's at their own tool after it was created.
        guest("/usr/local/bin/node").delete();
        posix.symlink("/usr/bin/node", guest("/usr/local/bin/node"));

        install.apply(false, seeder);
        assertEquals("off seeds nothing", 1, seeds);
        assertFalse(posix.isSymlink(guest("/root/.omp/agent/AGENTS.md")));
        assertFalse(posix.isSymlink(guest("/root/.omp/agent/skills")));
        assertFalse(posix.isSymlink(guest("/usr/local/bin/android")));
        assertFalse(posix.isSymlink(guest("/root/.omp/agent/extensions/heavy-jobs.ts")));
        assertFalse(posix.isSymlink(guest("/usr/local/bin/cargo")));
        assertEquals("MINE=1\n", read("/root/.omp/agent/.env"));
        assertEquals("/usr/bin/node", link("/usr/local/bin/node"));
        assertNull(mcpServers().get(HarnessInstall.MCP_SERVER));
        assertEquals(otherServer(), mcpServers().get("other"));
        assertFalse(guest(HarnessInstall.TRACKING).exists());
        assertTrue("the harness repo keeps the agent's commits", guest(HarnessInstall.DIR).isDirectory());
    }

    @Test
    public void turningOffKeepsAPhoneMcpEntryTheUserTuned() throws Exception {
        install.apply(true, seeder);
        Map<String, Object> servers = mcpServers();
        @SuppressWarnings("unchecked") Map<String, Object> phone = (Map<String, Object>) servers.get(HarnessInstall.MCP_SERVER);
        phone.put("timeout", 5L);
        writeMcp(servers);
        install.apply(false, seeder);
        assertEquals(5L, ((Map<?, ?>) mcpServers().get(HarnessInstall.MCP_SERVER)).get("timeout"));
    }

    @Test
    public void turningOffWithoutARecordRemovesTheLinksOfEarlierBuilds() throws Exception {
        // Builds before the setting linked the harness but recorded nothing.
        guest("/root/.omp/agent").mkdirs();
        guest("/usr/local/bin").mkdirs();
        posix.symlink(HarnessInstall.DIR + "/agent/AGENTS.md", guest("/root/.omp/agent/AGENTS.md"));
        posix.symlink(HarnessInstall.DIR + "/bin/shims/npx", guest("/usr/local/bin/npx"));
        posix.symlink("/opt/mine/android", guest("/usr/local/bin/android"));
        Map<String, Object> servers = new LinkedHashMap<>();
        servers.put(HarnessInstall.MCP_SERVER, HarnessInstall.phoneMcpEntry());
        writeMcp(servers);

        install.apply(false, seeder);
        assertFalse(posix.isSymlink(guest("/root/.omp/agent/AGENTS.md")));
        assertFalse(posix.isSymlink(guest("/usr/local/bin/npx")));
        assertEquals("a link of the user's own stays", "/opt/mine/android", link("/usr/local/bin/android"));
        assertNull(mcpServers().get(HarnessInstall.MCP_SERVER));
    }

    @Test
    public void onAgainRestoresTheLinks() throws Exception {
        install.apply(true, seeder);
        install.apply(false, seeder);
        install.apply(true, seeder);
        assertEquals(2, seeds);
        assertEquals(HarnessInstall.DIR + "/agent/AGENTS.md", link("/root/.omp/agent/AGENTS.md"));
        assertEquals(HarnessInstall.phoneMcpEntry(), mcpServers().get(HarnessInstall.MCP_SERVER));
    }
}
