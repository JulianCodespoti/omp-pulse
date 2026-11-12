package com.omppulse.app.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class RuntimePathsTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private final NioPosix posix = new NioPosix();

    // A work-profile user: storage is NOT /storage/emulated/0.
    private final RuntimePaths paths = new RuntimePaths(
            new File("/data/user/10/app/files/phone"),
            new File("/data/app/x/lib/arm64"),
            new File("/storage/emulated/10"),
            posix);

    @Test
    public void sdcardMapsToThisUsersStorage() {
        assertEquals(new File("/storage/emulated/10"), paths.hostPath("/sdcard"));
        assertEquals(new File("/storage/emulated/10/Download/a.txt"), paths.hostPath("/sdcard/Download/a.txt"));
    }

    @Test
    public void storagePathsStayAsIs() {
        assertEquals(new File("/storage/emulated/10/DCIM"), paths.hostPath("/storage/emulated/10/DCIM"));
    }

    @Test
    public void everythingElseLivesInTheRootfs() {
        assertEquals(new File("/data/user/10/app/files/phone/rootfs/root/x"), paths.hostPath("/root/x"));
        // Only this user's storage is real storage; a prefix look-alike is a guest path.
        assertEquals(new File("/data/user/10/app/files/phone/rootfs/sdcardx"), paths.hostPath("/sdcardx"));
        assertEquals(new File("/data/user/10/app/files/phone/rootfs/storage/emulated/0/a"), paths.hostPath("/storage/emulated/0/a"));
    }

    @Test
    public void dotDotAndRelativePathsAreRejected() {
        assertRejected(paths, "/sdcard/../../../data/user/0/pkg/shared_prefs/x.xml");
        assertRejected(paths, "/../../shared_prefs/omp_pulse_prefs.xml");
        assertRejected(paths, "/root/..");
        assertRejected(paths, "/storage/emulated/10/../0/a");
        assertRejected(paths, "root/x");
    }

    @Test
    public void guestAbsoluteSymlinksResolveInsideTheGuest() throws IOException {
        RuntimePaths p = realPaths();
        File harness = p.inRootfs("/root/projects/harness/agent");
        harness.mkdirs();
        File agents = new File(harness, "AGENTS.md");
        Files.write(agents.toPath(), new byte[0]);
        File omp = p.inRootfs("/root/.omp/agent");
        omp.mkdirs();
        posix.symlink("/root/projects/harness/agent/AGENTS.md", new File(omp, "AGENTS.md"));
        assertEquals(agents, p.hostPath("/root/.omp/agent/AGENTS.md"));
        // A relative link climbing above the guest root stops at the root, like the kernel.
        posix.symlink("../../../../../etc", p.inRootfs("/root/up"));
        assertEquals(p.inRootfs("/etc/passwd"), p.hostPath("/root/up/passwd"));
    }

    @Test
    public void symlinksToHostPathsStayInTheGuest() throws IOException {
        RuntimePaths p = realPaths();
        File secret = tmp.newFile("secret.xml");
        p.inRootfs("/root").mkdirs();
        // Guest-absolute: the host path is reinterpreted inside the rootfs, never escaping it.
        posix.symlink(secret.getAbsolutePath(), p.inRootfs("/root/s"));
        assertEquals(p.inRootfs(secret.getAbsolutePath()), p.hostPath("/root/s"));
    }

    @Test
    public void storageSymlinkEscapesAreRejected() throws IOException {
        RuntimePaths p = realPaths();
        File secret = tmp.newFile("secret.xml");
        posix.symlink(secret.getAbsolutePath(), new File(p.externalStorage, "evil"));
        assertRejected(p, "/sdcard/evil");
        posix.symlink(tmp.getRoot().getAbsolutePath(), new File(p.externalStorage, "evildir"));
        assertRejected(p, "/sdcard/evildir/secret.xml");
    }

    @Test
    public void symlinkLoopsAreRejected() throws IOException {
        RuntimePaths p = realPaths();
        p.inRootfs("/root").mkdirs();
        posix.symlink("/root/b", p.inRootfs("/root/a"));
        posix.symlink("/root/a", p.inRootfs("/root/b"));
        assertRejected(p, "/root/a/x");
    }

    private RuntimePaths realPaths() throws IOException {
        File base = tmp.newFolder("phone");
        new File(base, "rootfs").mkdirs();
        return new RuntimePaths(base, tmp.newFolder("lib"), tmp.newFolder("storage"), posix);
    }

    private static void assertRejected(RuntimePaths p, String guestPath) {
        try {
            p.hostPath(guestPath);
            fail("accepted " + guestPath);
        } catch (IllegalArgumentException expected) {
            // rejected
        }
    }
}
