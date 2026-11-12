package com.omppulse.app.runtime;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Seeds the guest's harness repo (/root/projects/phone-harness) from the APK's {@link HarnessSeed}
 * and upgrades it on app updates without clobbering the agent's own edits.
 *
 * The agent edits and commits its harness on whatever branch is checked out. Each seed the app has
 * shipped is a commit on branch {@code upstream}, parented on the previous one, so the merge base
 * of upstream and the agent's branch is the last seed it merged and only the changes upstream made
 * since then are applied:
 *
 * 1. Skip everything when the status file already records this seed digest as applied.
 * 2. Write the seed to a scratch directory and commit it to {@code upstream} through a private
 *    index file: the agent's working tree and index are never touched. An unchanged tree makes no
 *    commit.
 * 3. A repo without commits (first run) has its branch reset to upstream: state {@code seeded}.
 * 4. Otherwise merge upstream into the checked-out branch ({@code --no-ff}). For every conflicted
 *    path the device's whole file is kept (or its deletion) and the path is listed: state
 *    {@code conflicts}; the agent reconciles it by hand, guided by {@code android doctor}.
 *    Not merged at all, state {@code pending}, when HEAD is detached, a merge/rebase/cherry-pick is
 *    in progress, tracked files have uncommitted changes, or git refuses (an untracked file would
 *    be overwritten). upstream already holds the seed, so `git merge upstream` finishes it by hand;
 *    the next app start retries.
 * 5. The outcome goes to the status file that {@code android doctor} reads.
 *
 * Legacy repos (seeded before the upstream branch existed) whose root commit is that old seed get
 * upstream started there, so it is the merge base. Any other history (a harness cloned by hand)
 * merges as unrelated histories: files on both sides that differ conflict and keep the device's
 * version, files only upstream has are added.
 *
 * Every step is idempotent: a crash or an interrupted start just redoes it on the next start.
 */
final class HarnessMerge {
    static final String BRANCH = "upstream";
    static final String LEGACY_SEED_SUBJECT = "Seed phone harness from omp-pulse";
    static final String SEEDED = "seeded";
    static final String MERGED = "merged";
    static final String CONFLICTS = "conflicts";
    static final String PENDING = "pending";

    /**
     * Commits made here are the app's, not the agent's; hooks and signing the agent configured for
     * its own commits must neither block nor alter an automatic seed merge.
     */
    private static final List<String> GIT_CONFIG = Arrays.asList(
            "-c", "user.name=omp-pulse", "-c", "user.email=omp-pulse@localhost",
            "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false");
    private static final String[] IN_PROGRESS = {"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"};

    /** Outcome of one apply, as stored in the status file. */
    static final class Status {
        String seed = "";
        String release = "";
        String state = PENDING;
        String upstream = "";
        String merge = "";
        List<String> conflicts = Collections.emptyList();
        String detail = "";

        String toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("seed", seed);
            m.put("release", release);
            m.put("state", state);
            m.put("upstream", upstream);
            m.put("merge", merge);
            m.put("conflicts", new ArrayList<Object>(conflicts));
            m.put("detail", detail);
            return Json.write(m);
        }

        /** The recorded status, or null when absent or unreadable (treated as "never applied"). */
        static Status read(File file) {
            String text = RuntimeIo.readTextOrNull(file);
            if (text == null) return null;
            try {
                Object v = Json.parse(text);
                if (!(v instanceof Map)) return null;
                Map<?, ?> m = (Map<?, ?>) v;
                Status s = new Status();
                s.seed = str(m.get("seed"));
                s.release = str(m.get("release"));
                s.state = str(m.get("state"));
                s.upstream = str(m.get("upstream"));
                s.merge = str(m.get("merge"));
                s.detail = str(m.get("detail"));
                List<String> c = new ArrayList<>();
                if (m.get("conflicts") instanceof List) {
                    for (Object o : (List<?>) m.get("conflicts")) c.add(str(o));
                }
                s.conflicts = c;
                return s;
            } catch (IllegalArgumentException e) {
                return null;
            }
        }

        private static String str(Object o) {
            return o instanceof String ? (String) o : "";
        }
    }

    private final GuestExec guest;
    private final File hostRepo;
    private final String guestRepo;
    private final File hostStage;
    private final String guestStage;
    private final File statusFile;
    private final Posix posix;

    /**
     * @param hostRepo / guestRepo the harness repo as the app and as the guest see it
     * @param hostStage / guestStage scratch directory for the seed files (deleted after use)
     * @param statusFile where the outcome is recorded (host path)
     */
    HarnessMerge(GuestExec guest, File hostRepo, String guestRepo, File hostStage, String guestStage,
                 File statusFile, Posix posix) {
        this.guest = guest;
        this.hostRepo = hostRepo;
        this.guestRepo = guestRepo;
        this.hostStage = hostStage;
        this.guestStage = guestStage;
        this.statusFile = statusFile;
        this.posix = posix;
    }

    /**
     * Applies {@code seed} (labelled {@code release} in commit messages) and returns the recorded
     * status. Throws only when the seed could not be committed at all (git missing, bad seed); the
     * status file then records {@code pending} with the reason.
     */
    Status apply(HarnessSeed seed, String release) throws IOException, InterruptedException {
        Status previous = Status.read(statusFile);
        boolean hasRepo = new File(hostRepo, ".git").exists();
        if (hasRepo && previous != null && seed.digest.equals(previous.seed) && !PENDING.equals(previous.state)) {
            return previous;
        }
        Status s = new Status();
        s.seed = seed.digest;
        s.release = release;
        try {
            if (!hostRepo.isDirectory() && !hostRepo.mkdirs()) throw new IOException("cannot create " + hostRepo);
            if (!hasRepo) {
                git("init", "-q");
                git("config", "user.name", "omp phone agent");
                git("config", "user.email", "agent@phone.local");
            }
            String head = revParse("HEAD");
            String upstream = revParse("refs/heads/" + BRANCH);
            if (upstream == null && head != null) upstream = adoptLegacySeed();
            // A pending retry of the same seed reuses the commit it already made.
            boolean staged = previous != null && seed.digest.equals(previous.seed)
                    && upstream != null && upstream.equals(previous.upstream);
            if (!staged) upstream = commitSeed(seed, release, upstream);
            s.upstream = upstream;
            if (head == null) {
                // First run: the agent's branch starts at the seed.
                git("reset", "-q", "--hard", upstream);
                s.state = SEEDED;
            } else if (previous != null && upstream.equals(previous.upstream) && !PENDING.equals(previous.state)) {
                // Same seed content under a new digest (e.g. a rebuilt APK): nothing new to merge,
                // and earlier conflicts are still the ones to report.
                s.state = previous.state;
                s.merge = previous.merge;
                s.conflicts = previous.conflicts;
                s.detail = previous.detail;
            } else {
                merge(s, release);
            }
        } catch (IOException e) {
            s.state = PENDING;
            s.detail = "seeding failed: " + e.getMessage();
            RuntimeIo.writeTextAtomic(statusFile, s.toJson());
            throw e;
        }
        RuntimeIo.writeTextAtomic(statusFile, s.toJson());
        return s;
    }

    /** Points upstream at HEAD's root commit when that is a seed made by an older app build. */
    private String adoptLegacySeed() throws IOException, InterruptedException {
        List<String> roots = lines(git("rev-list", "--max-parents=0", "HEAD"));
        if (roots.size() != 1) return null;
        String root = roots.get(0);
        if (!git("log", "-1", "--format=%s", root).trim().startsWith(LEGACY_SEED_SUBJECT)) return null;
        git("update-ref", "refs/heads/" + BRANCH, root);
        return root;
    }

    /** Commits the seed tree on upstream (parent {@code parent}); returns upstream's new tip. */
    private String commitSeed(HarnessSeed seed, String release, String parent)
            throws IOException, InterruptedException {
        String gitDir = guestRepo + "/.git";
        String index = gitDir + "/omp-pulse-seed.index";
        File hostIndex = new File(hostRepo, ".git/omp-pulse-seed.index");
        RuntimeIo.deleteTree(hostStage, posix);
        hostIndex.delete();
        String tree;
        try {
            seed.writeTo(hostStage, posix);
            // -f: the seed is exactly what ships; the device's ignore rules must not drop any of it.
            check(guest.exec("env", "GIT_INDEX_FILE=" + index, "git", "-C", guestStage, "--git-dir=" + gitDir,
                    "--work-tree=" + guestStage, "add", "-A", "-f", "."));
            tree = check(guest.exec("env", "GIT_INDEX_FILE=" + index, "git", "--git-dir=" + gitDir, "write-tree")).trim();
        } finally {
            hostIndex.delete();
            RuntimeIo.deleteTree(hostStage, posix);
        }
        if (parent != null && tree.equals(revParse(parent + "^{tree}"))) return parent;
        List<String> argv = new ArrayList<>(Arrays.asList("commit-tree", tree));
        if (parent != null) argv.addAll(Arrays.asList("-p", parent));
        argv.addAll(Arrays.asList("-m", "omp-pulse " + release + " harness seed"));
        String commit = git(argv.toArray(new String[0])).trim();
        if (parent != null) {
            git("update-ref", "refs/heads/" + BRANCH, commit, parent);
        } else {
            git("update-ref", "refs/heads/" + BRANCH, commit);
        }
        return commit;
    }

    private void merge(Status s, String release) throws IOException, InterruptedException {
        File gitDir = new File(hostRepo, ".git");
        if (!exec("symbolic-ref", "-q", "HEAD").ok()) {
            pending(s, "HEAD is detached; check out your branch");
            return;
        }
        for (String marker : IN_PROGRESS) {
            if (new File(gitDir, marker).exists()) {
                pending(s, "a merge, rebase or cherry-pick is in progress; finish or abort it");
                return;
            }
        }
        if (exec("merge-base", "--is-ancestor", BRANCH, "HEAD").ok()) {
            s.state = MERGED;
            return;
        }
        String dirty = git("status", "--porcelain", "--untracked-files=no").trim();
        if (!dirty.isEmpty()) {
            pending(s, "uncommitted changes: " + firstLines(dirty, 5));
            return;
        }
        List<String> argv = new ArrayList<>(Arrays.asList("merge", "--no-ff", "--no-edit",
                "-m", "Merge omp-pulse " + release + " harness seed"));
        // No common ancestor: a harness that was not seeded by this app (e.g. cloned by hand).
        if (!exec("merge-base", "HEAD", BRANCH).ok()) argv.add("--allow-unrelated-histories");
        argv.add(BRANCH);
        GuestExec.Result r = exec(argv.toArray(new String[0]));
        if (r.ok()) {
            s.state = MERGED;
            s.merge = revParse("HEAD");
            return;
        }
        if (!new File(gitDir, "MERGE_HEAD").exists()) {
            pending(s, "git merge refused: " + firstLines(r.output.trim(), 5));
            return;
        }
        try {
            s.conflicts = keepDeviceVersions();
            StringBuilder msg = new StringBuilder("Merge omp-pulse " + release + " harness seed\n\n"
                    + "Kept this device's version where the new seed conflicts:\n");
            for (String path : s.conflicts) msg.append("  ").append(path).append('\n');
            git("commit", "-q", "-m", msg.toString());
        } catch (IOException e) {
            // Leave the agent's branch as it was rather than half-merged.
            exec("merge", "--abort");
            pending(s, "merge failed and was aborted: " + e.getMessage());
            return;
        }
        s.state = CONFLICTS;
        s.merge = revParse("HEAD");
    }

    /** Resolves every unmerged path to HEAD's version (or HEAD's deletion); returns the paths. */
    private List<String> keepDeviceVersions() throws IOException, InterruptedException {
        List<String> paths = new ArrayList<>();
        for (String p : git("diff", "--name-only", "--diff-filter=U", "-z").split("\0")) {
            if (!p.isEmpty()) paths.add(p);
        }
        for (String p : paths) {
            if (exec("cat-file", "-e", "HEAD:" + p).ok()) {
                git("checkout", "HEAD", "--", p);
            } else {
                git("rm", "-q", "--cached", "--", p);
                RuntimeIo.deleteTree(new File(hostRepo, p), posix);
            }
        }
        return paths;
    }

    private static void pending(Status s, String why) {
        s.state = PENDING;
        s.detail = why;
    }

    /** Object name of {@code rev}, or null when it does not exist (e.g. HEAD of an empty repo). */
    private String revParse(String rev) throws IOException, InterruptedException {
        GuestExec.Result r = exec("rev-parse", "-q", "--verify", rev);
        return r.ok() ? r.output.trim() : null;
    }

    private GuestExec.Result exec(String... args) throws IOException, InterruptedException {
        List<String> argv = new ArrayList<>(Arrays.asList("git", "-C", guestRepo));
        argv.addAll(GIT_CONFIG);
        argv.addAll(Arrays.asList(args));
        return guest.exec(argv.toArray(new String[0]));
    }

    private String git(String... args) throws IOException, InterruptedException {
        GuestExec.Result r = exec(args);
        if (!r.ok()) throw new IOException("git " + RuntimeIo.join(" ", args) + " failed (" + r.code + "): " + RuntimeIo.tail(r.output));
        return r.output;
    }

    private static String check(GuestExec.Result r) throws IOException {
        if (!r.ok()) throw new IOException("git failed (" + r.code + "): " + RuntimeIo.tail(r.output));
        return r.output;
    }

    private static List<String> lines(String text) {
        List<String> out = new ArrayList<>();
        for (String l : text.split("\n")) {
            if (!l.trim().isEmpty()) out.add(l.trim());
        }
        return out;
    }

    private static String firstLines(String text, int max) {
        String[] l = text.split("\n");
        StringBuilder sb = new StringBuilder();
        for (int k = 0; k < Math.min(max, l.length); k++) {
            if (k > 0) sb.append("; ");
            sb.append(l[k].trim());
        }
        if (l.length > max) sb.append("; …");
        return sb.toString();
    }
}
