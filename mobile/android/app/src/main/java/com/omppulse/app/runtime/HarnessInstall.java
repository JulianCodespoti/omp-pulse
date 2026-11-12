package com.omppulse.app.runtime;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The "Phone tools for the agent" setting applied to the guest. On: the phone harness (this
 * repository's {@code phone-harness/}, kept at {@link #DIR}) is seeded or upgraded ({@link HarnessMerge})
 * and linked where omp, PATH and the job broker look, and its {@code phone} MCP server is
 * registered. Off: nothing is seeded, and every link and the MCP entry the app created are removed.
 *
 * WHY opt-in: the harness gives the agent the phone (apps, screen, files through the {@code android}
 * command) and loads phone-mode instructions, skills, an omp extension and an environment file into
 * every session. A user who only wants omp on the phone gets plain omp.
 *
 * WHY tracked: turning it off must never touch a file of the user's own. Every link and the MCP entry
 * the app writes is recorded in {@link #TRACKING}; off removes a recorded link only while it still
 * points where the app pointed it, and the MCP entry only while it is exactly the app's. The harness
 * repo itself stays: it holds the agent's own commits, and turning the setting on again merges into it.
 *
 * Pure Java (no android.* types) so the decision and the guest changes are unit-testable.
 */
final class HarnessInstall {
    /** Seeds or upgrades the harness repo; the caller reports its own failures. */
    interface Seeder {
        void seed() throws IOException, InterruptedException;
    }

    /** Where non-fatal problems go (android.util.Log in the app). */
    interface Warn {
        void warn(String message, Exception e);
    }

    static final String DIR = "/root/projects/phone-harness";
    /** Links and MCP entry the app created, so turning the setting off removes exactly those. */
    static final String TRACKING = "/root/.config/omp-phone/harness-links.json";
    static final String MCP_CONFIG = "/root/.omp/agent/mcp.json";
    static final String MCP_SERVER = "phone";
    /**
     * Links the app owns outright: omp reads its global instructions and skills only from these
     * places, so they are always pointed at the harness.
     */
    private static final String[][] LINKS = {
            {"/root/.omp/agent/AGENTS.md", "agent/AGENTS.md"},
            {"/root/.omp/agent/skills", "agent/skills"},
            {"/usr/local/bin/android", "bin/android"},
    };
    /**
     * Links created only where nothing else lives: a user's own .env, extension or toolchain
     * binary at these paths is never replaced (`android doctor` reports the missing link instead).
     */
    private static final String[][] LINKS_IF_FREE = {
            {"/root/.omp/agent/.env", "agent/env"},
            {"/root/.omp/agent/extensions/heavy-jobs.ts", "agent/extensions/heavy-jobs.ts"},
            {"/usr/local/bin/cargo", "bin/shims/cargo"},
            {"/usr/local/bin/node", "bin/shims/node"},
            {"/usr/local/bin/npx", "bin/shims/npx"},
            {"/usr/local/bin/gradle", "bin/shims/gradle"},
    };

    private final RuntimePaths paths;
    private final Posix posix;
    private final Warn warn;

    HarnessInstall(RuntimePaths paths, Posix posix, Warn warn) {
        this.paths = paths;
        this.posix = posix;
        this.warn = warn;
    }

    /**
     * The setting: {@code stored} when the user (or an earlier call) chose, else on only for an
     * install that already has the harness. WHY: before the setting existed every phone-mode install
     * was seeded; turning the tools off under an upgrading user would silently take the phone away
     * from their agent. A new install has no harness, so it starts off.
     */
    boolean enabled(Boolean stored) {
        return stored != null ? stored : paths.inRootfs(DIR).isDirectory();
    }

    /** Applies the setting; call while no other thread applies it. */
    void apply(boolean enabled, Seeder seeder) throws IOException, InterruptedException {
        if (enabled) install(seeder);
        else remove();
    }

    private void install(Seeder seeder) throws IOException, InterruptedException {
        seeder.seed();
        Map<String, Object> links = new LinkedHashMap<>();
        for (String[] l : LINKS) {
            String target = DIR + "/" + l[1];
            link(l[0], target);
            links.put(l[0], target);
        }
        for (String[] l : LINKS_IF_FREE) {
            String target = DIR + "/" + l[1];
            if (linkIfFree(l[0], target)) links.put(l[0], target);
        }
        Map<String, Object> tracking = new LinkedHashMap<>();
        tracking.put("links", links);
        tracking.put("mcp", registerPhoneMcp());
        RuntimeIo.writeTextAtomic(paths.inRootfs(TRACKING), Json.write(tracking));
    }

    /**
     * Removes the recorded links and MCP entry. Without a record (builds before the setting existed
     * never wrote one) the candidates are every harness link at its fixed place; either way a link is
     * removed only while it still points at the app's target, so a user's own file or link survives.
     */
    private void remove() throws IOException {
        File trackingFile = paths.inRootfs(TRACKING);
        Map<String, String> links = new LinkedHashMap<>();
        boolean mcp = true;
        Map<String, Object> tracking = readTracking(trackingFile);
        if (tracking != null) {
            Object recorded = tracking.get("links");
            if (recorded instanceof Map) {
                for (Map.Entry<?, ?> e : ((Map<?, ?>) recorded).entrySet()) {
                    if (e.getKey() instanceof String && e.getValue() instanceof String) {
                        links.put((String) e.getKey(), (String) e.getValue());
                    }
                }
            }
            mcp = Boolean.TRUE.equals(tracking.get("mcp"));
        } else {
            for (String[] l : LINKS) links.put(l[0], DIR + "/" + l[1]);
            for (String[] l : LINKS_IF_FREE) links.put(l[0], DIR + "/" + l[1]);
        }
        for (Map.Entry<String, String> l : links.entrySet()) {
            File file = paths.inRootfs(l.getKey());
            if (posix.isSymlink(file) && l.getValue().equals(posix.readlink(file)) && !file.delete()) {
                throw new IOException("cannot remove " + l.getKey());
            }
        }
        if (mcp) unregisterPhoneMcp();
        if (trackingFile.exists() && !trackingFile.delete()) throw new IOException("cannot delete " + TRACKING);
    }

    /** The tracking record, or null when there is none or it is unreadable. */
    private Map<String, Object> readTracking(File file) {
        if (!file.exists()) return null;
        try {
            Object parsed = Json.parse(RuntimeIo.readText(file));
            if (!(parsed instanceof Map)) return null;
            @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) parsed;
            return m;
        } catch (IOException | IllegalArgumentException e) {
            warn.warn("unreadable " + TRACKING + "; removing harness links at their fixed places", e);
            return null;
        }
    }

    /**
     * Points guest path {@code at} to {@code target}. A real directory already there (e.g. skills
     * the user created before the link existed) has its entries moved into the target first so
     * nothing is lost.
     */
    private void link(String at, String target) throws IOException {
        File file = paths.inRootfs(at);
        File parent = file.getParentFile();
        if (parent != null) parent.mkdirs();
        if (posix.isSymlink(file)) {
            if (target.equals(posix.readlink(file))) return;
        } else if (file.isDirectory()) {
            File into = paths.inRootfs(target);
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    File dest = new File(into, child.getName());
                    if (!dest.exists()) child.renameTo(dest);
                }
            }
        }
        RuntimeIo.deleteTree(file, posix);
        posix.symlink(target, file);
    }

    /**
     * Links {@code at} → {@code target} when nothing is there or it is already a harness link.
     * Returns whether the link is now the app's (false: a file or link of the user's own is there).
     */
    private boolean linkIfFree(String at, String target) throws IOException {
        File file = paths.inRootfs(at);
        if (posix.isSymlink(file)) {
            String current = posix.readlink(file);
            if (target.equals(current)) return true;
            if (current == null || !current.startsWith(DIR + "/")) return false;
            file.delete();
        } else if (file.exists()) {
            return false;
        }
        File parent = file.getParentFile();
        if (parent != null) parent.mkdirs();
        posix.symlink(target, file);
        return true;
    }

    /** The {@code phone} entry the app writes into omp's mcp.json. */
    static Map<String, Object> phoneMcpEntry() {
        Map<String, Object> phone = new LinkedHashMap<>();
        phone.put("type", "stdio");
        phone.put("command", DIR + "/bin/phone-mcp");
        phone.put("args", new ArrayList<Object>());
        phone.put("cwd", DIR);
        phone.put("timeout", 120000L);
        return phone;
    }

    /**
     * Registers the harness's `phone` MCP server in omp's mcp.json when it has no `phone` entry.
     * An existing entry (the user may have tuned it) and an unreadable file are left alone. Returns
     * whether the entry there is now exactly the app's.
     */
    private boolean registerPhoneMcp() {
        File file = paths.inRootfs(MCP_CONFIG);
        try {
            Map<String, Object> config = file.exists() ? readObject(file) : new LinkedHashMap<String, Object>();
            if (config == null) return false;
            Object servers = config.get("mcpServers");
            if (servers == null) {
                servers = new LinkedHashMap<String, Object>();
                config.put("mcpServers", servers);
            }
            if (!(servers instanceof Map)) return false;
            @SuppressWarnings("unchecked") Map<String, Object> s = (Map<String, Object>) servers;
            if (s.containsKey(MCP_SERVER)) return phoneMcpEntry().equals(s.get(MCP_SERVER));
            s.put(MCP_SERVER, phoneMcpEntry());
            RuntimeIo.writeTextAtomic(file, Json.write(config));
            return true;
        } catch (IOException | IllegalArgumentException e) {
            warn.warn("cannot register the phone MCP server", e);
            return false;
        }
    }

    /** Drops the `phone` entry from omp's mcp.json while it is exactly the app's; keeps the rest. */
    private void unregisterPhoneMcp() {
        File file = paths.inRootfs(MCP_CONFIG);
        if (!file.exists()) return;
        try {
            Map<String, Object> config = readObject(file);
            if (config == null) return;
            Object servers = config.get("mcpServers");
            if (!(servers instanceof Map) || !phoneMcpEntry().equals(((Map<?, ?>) servers).get(MCP_SERVER))) return;
            ((Map<?, ?>) servers).remove(MCP_SERVER);
            RuntimeIo.writeTextAtomic(file, Json.write(config));
        } catch (IOException | IllegalArgumentException e) {
            warn.warn("cannot unregister the phone MCP server", e);
        }
    }

    /** A JSON object file, or null when it holds anything else. */
    private static Map<String, Object> readObject(File file) throws IOException {
        Object parsed = Json.parse(RuntimeIo.readText(file));
        if (!(parsed instanceof Map)) return null;
        @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) parsed;
        return m;
    }
}
