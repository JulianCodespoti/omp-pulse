package com.omppulse.app.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * Seed and upgrade of the guest harness repo, with real git: the "guest" is the host, and guest
 * paths equal host paths.
 */
public class HarnessMergeTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private File repo;
    private File status;
    private File home;
    private final List<String> commands = new ArrayList<>();

    /** Runs argv on the host with git isolated from the developer's own configuration. */
    private final GuestExec host = argv -> {
        commands.add(String.join(" ", argv));
        ProcessBuilder pb = new ProcessBuilder(argv).redirectErrorStream(true);
        pb.environment().put("HOME", home.getAbsolutePath());
        pb.environment().put("GIT_CONFIG_NOSYSTEM", "1");
        pb.environment().put("GIT_CONFIG_GLOBAL", new File(home, "gitconfig").getAbsolutePath());
        Process p = pb.start();
        String out = RuntimeIo.drain(p.getInputStream());
        return new GuestExec.Result(p.waitFor(), out);
    };

    @Before
    public void setUp() throws IOException {
        repo = new File(tmp.getRoot(), "phone-harness");
        status = new File(tmp.getRoot(), "config/harness-seed.json");
        home = tmp.newFolder("home");
    }

    private HarnessMerge merge() {
        File stage = new File(tmp.getRoot(), "stage");
        return new HarnessMerge(host, repo, repo.getAbsolutePath(), stage, stage.getAbsolutePath(), status, new NioPosix());
    }

    private static HarnessSeed seed(Map<String, String> tree) throws IOException {
        return new HarnessSeed(HarnessSeedTest.Assets.of(tree));
    }

    private static Map<String, String> v1() {
        return HarnessSeedTest.tree(
                "agent/AGENTS.md", "# Rules\nbe brief\n",
                "bin/android", "#!/bin/sh\necho v1\n",
                "docs/old.md", "old\n",
                "README.md", "harness\n");
    }

    private String git(String... args) throws Exception {
        List<String> argv = new ArrayList<>(Arrays.asList("git", "-C", repo.getAbsolutePath(),
                "-c", "user.name=agent", "-c", "user.email=agent@test"));
        argv.addAll(Arrays.asList(args));
        GuestExec.Result r = host.exec(argv.toArray(new String[0]));
        if (!r.ok()) throw new IOException(String.join(" ", args) + ": " + r.output);
        return r.output.trim();
    }

    private String read(String path) throws IOException {
        return new String(Files.readAllBytes(new File(repo, path).toPath()), StandardCharsets.UTF_8);
    }

    private void write(String path, String content) throws IOException {
        File f = new File(repo, path);
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), content.getBytes(StandardCharsets.UTF_8));
    }

    private void agentCommit(String msg) throws Exception {
        git("add", "-A");
        git("commit", "-q", "-m", msg);
    }

    @Test
    public void firstRunSeedsTheRepoAtTheUpstreamCommit() throws Exception {
        HarnessMerge.Status s = merge().apply(seed(v1()), "r1");
        assertEquals(HarnessMerge.SEEDED, s.state);
        assertEquals("# Rules\nbe brief\n", read("agent/AGENTS.md"));
        assertEquals(git("rev-parse", "HEAD"), git("rev-parse", "upstream"));
        assertEquals(s.upstream, git("rev-parse", "upstream"));
        assertTrue("exec bit is committed", git("ls-files", "-s", "bin/android").startsWith("100755"));
        assertEquals("", git("status", "--porcelain"));
        HarnessMerge.Status recorded = HarnessMerge.Status.read(status);
        assertEquals(HarnessMerge.SEEDED, recorded.state);
        assertEquals("r1", recorded.release);
        assertEquals(s.seed, recorded.seed);
        assertFalse("scratch copy is removed", new File(tmp.getRoot(), "stage").exists());
    }

    @Test
    public void unchangedSeedRunsNothing() throws Exception {
        merge().apply(seed(v1()), "r1");
        commands.clear();
        HarnessMerge.Status s = merge().apply(seed(v1()), "r1");
        assertEquals(HarnessMerge.SEEDED, s.state);
        assertEquals("app start with the same seed spawns no guest command", Collections.emptyList(), commands);
    }

    @Test
    public void upgradeAppliesUpstreamChangesAndKeepsTheAgentsCommits() throws Exception {
        merge().apply(seed(v1()), "r1");
        write("agent/skills/mine/SKILL.md", "my skill\n");
        write("README.md", "harness, improved by the agent\n");
        agentCommit("agent: my skill");

        Map<String, String> v2 = v1();
        v2.put("bin/android", "#!/bin/sh\necho v2\n");
        v2.remove("docs/old.md");
        v2.put("docs/new.md", "new\n");
        HarnessMerge.Status s = merge().apply(seed(v2), "r2");

        assertEquals(HarnessMerge.MERGED, s.state);
        assertEquals(Collections.emptyList(), s.conflicts);
        assertEquals("#!/bin/sh\necho v2\n", read("bin/android"));
        assertEquals("new\n", read("docs/new.md"));
        assertFalse(new File(repo, "docs/old.md").exists());
        assertEquals("my skill\n", read("agent/skills/mine/SKILL.md"));
        assertEquals("harness, improved by the agent\n", read("README.md"));
        assertEquals(s.merge, git("rev-parse", "HEAD"));
        assertEquals("merge commit", 2, git("rev-list", "--parents", "-1", "HEAD").split(" ").length - 1);
        assertEquals("upstream chains seeds", git("rev-parse", "upstream~1"), git("rev-parse", "HEAD~1~1"));
        assertEquals("", git("status", "--porcelain"));
    }

    @Test
    public void conflictKeepsTheDevicesWholeFileAndRecordsIt() throws Exception {
        merge().apply(seed(v1()), "r1");
        write("agent/AGENTS.md", "# Rules\nbe very brief\n");
        new File(repo, "docs/old.md").delete();
        agentCommit("agent: tune rules, drop old doc");

        Map<String, String> v2 = v1();
        v2.put("agent/AGENTS.md", "# Rules\nbe brief and kind\n");
        v2.put("docs/old.md", "old, updated upstream\n");
        v2.put("bin/android", "#!/bin/sh\necho v2\n");
        HarnessMerge.Status s = merge().apply(seed(v2), "r2");

        assertEquals(HarnessMerge.CONFLICTS, s.state);
        assertEquals(Arrays.asList("agent/AGENTS.md", "docs/old.md"), s.conflicts);
        assertEquals("# Rules\nbe very brief\n", read("agent/AGENTS.md"));
        assertFalse("the device's deletion wins too", new File(repo, "docs/old.md").exists());
        assertEquals("non-conflicting upstream changes still land", "#!/bin/sh\necho v2\n", read("bin/android"));
        assertEquals("", git("status", "--porcelain"));
        assertEquals("upstream counts as merged", 0, host.exec("git", "-C", repo.getAbsolutePath(),
                "merge-base", "--is-ancestor", "upstream", "HEAD").code);
        assertTrue(git("log", "-1", "--format=%B").contains("agent/AGENTS.md"));
        HarnessMerge.Status recorded = HarnessMerge.Status.read(status);
        assertEquals(s.conflicts, recorded.conflicts);
        assertEquals(s.merge, recorded.merge);

        commands.clear();
        merge().apply(seed(v2), "r2");
        assertTrue("recorded conflicts are not re-merged on the next start", commands.isEmpty());
    }

    @Test
    public void uncommittedChangesLeaveTheMergePendingUntilTheyAreCommitted() throws Exception {
        merge().apply(seed(v1()), "r1");
        write("README.md", "work in progress\n");
        Map<String, String> v2 = v1();
        v2.put("bin/android", "#!/bin/sh\necho v2\n");

        HarnessMerge.Status s = merge().apply(seed(v2), "r2");
        assertEquals(HarnessMerge.PENDING, s.state);
        String pendingSeed = git("rev-parse", "upstream");
        assertTrue(s.detail, s.detail.contains("README.md"));
        assertEquals("work in progress\n", read("README.md"));
        assertEquals("#!/bin/sh\necho v1\n", read("bin/android"));
        assertEquals("the seed already waits on upstream", "#!/bin/sh\necho v2\n", git("show", "upstream:bin/android") + "\n");

        agentCommit("agent: readme");
        s = merge().apply(seed(v2), "r2");
        assertEquals(HarnessMerge.MERGED, s.state);
        assertEquals("#!/bin/sh\necho v2\n", read("bin/android"));
        assertEquals("work in progress\n", read("README.md"));
        assertEquals("the retry reuses the seed commit", pendingSeed, git("rev-parse", "upstream"));
    }

    @Test
    public void detachedHeadIsPending() throws Exception {
        merge().apply(seed(v1()), "r1");
        git("checkout", "-q", "--detach");
        Map<String, String> v2 = v1();
        v2.put("README.md", "v2\n");
        assertEquals(HarnessMerge.PENDING, merge().apply(seed(v2), "r2").state);
    }

    @Test
    public void untrackedFileInTheWayIsPendingAndUntouched() throws Exception {
        merge().apply(seed(v1()), "r1");
        write("docs/new.md", "the agent's own, not committed\n");
        Map<String, String> v2 = v1();
        v2.put("docs/new.md", "upstream\n");
        HarnessMerge.Status s = merge().apply(seed(v2), "r2");
        assertEquals(HarnessMerge.PENDING, s.state);
        assertEquals("the agent's own, not committed\n", read("docs/new.md"));
        assertFalse(new File(repo, ".git/MERGE_HEAD").exists());
    }

    @Test
    public void legacySeedCommitBecomesTheMergeBase() throws Exception {
        // What builds before the upstream branch did: copy the seed, commit it as the root.
        for (Map.Entry<String, String> e : v1().entrySet()) write(e.getKey(), e.getValue());
        git("init", "-q");
        agentCommit("Seed phone harness from omp-pulse r0");
        String root = git("rev-parse", "HEAD");
        write("README.md", "harness, improved by the agent\n");
        agentCommit("agent: readme");

        Map<String, String> v2 = v1();
        v2.put("bin/android", "#!/bin/sh\necho v2\n");
        HarnessMerge.Status s = merge().apply(seed(v2), "r2");

        assertEquals(HarnessMerge.MERGED, s.state);
        assertEquals(root, git("rev-parse", "upstream~1"));
        assertEquals("#!/bin/sh\necho v2\n", read("bin/android"));
        assertEquals("harness, improved by the agent\n", read("README.md"));
    }

    @Test
    public void unrelatedHistoryKeepsEveryDifferingDeviceFile() throws Exception {
        write("agent/AGENTS.md", "# My own rules\n");
        write("README.md", "harness\n");
        git("init", "-q");
        agentCommit("my harness");

        HarnessMerge.Status s = merge().apply(seed(v1()), "r1");

        assertEquals(HarnessMerge.CONFLICTS, s.state);
        assertEquals(Collections.singletonList("agent/AGENTS.md"), s.conflicts);
        assertEquals("# My own rules\n", read("agent/AGENTS.md"));
        assertEquals("files only upstream has are added", "#!/bin/sh\necho v1\n", read("bin/android"));
        assertEquals("", git("status", "--porcelain"));
    }

    @Test
    public void seedFailureIsRecordedAsPending() throws Exception {
        HarnessSeedTest.Assets broken = HarnessSeedTest.Assets.of(v1());
        broken.files.keySet().removeIf(k -> k.startsWith(HarnessSeed.BLOBS));
        try {
            merge().apply(new HarnessSeed(broken), "r1");
            fail("expected the missing blob to fail");
        } catch (IOException expected) {
            // the caller logs it; the daemon still starts
        }
        HarnessMerge.Status recorded = HarnessMerge.Status.read(status);
        assertEquals(HarnessMerge.PENDING, recorded.state);
        assertTrue(recorded.detail, recorded.detail.startsWith("seeding failed"));
    }
}
