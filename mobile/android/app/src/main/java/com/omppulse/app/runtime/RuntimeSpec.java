package com.omppulse.app.runtime;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Pins for the on-device runtime, parsed from {@code assets/runtime/runtime.json}.
 *
 * INVARIANT: every download URL, checksum and size comes from runtime.json; Java holds no URL
 * constants. Adding an ABI is a new {@code abis} entry plus vendor libs, never a code change.
 *
 * The spec is selected for the first device ABI (in the device's preference order) that has an
 * entry. A device with no matching ABI gets an unsupported spec (no target) instead of an
 * exception, because laptop-mode users must never be affected by a phone-mode limitation.
 */
public final class RuntimeSpec {
    static final int SCHEMA = 1;

    /** One pinned download: a rootfs tarball or the omp binary. */
    static final class Artifact {
        final String version;
        final String url;
        final List<String> mirrors;
        final String sha256;
        final long bytes;

        Artifact(String version, String url, List<String> mirrors, String sha256, long bytes) {
            this.version = version;
            this.url = url;
            this.mirrors = Collections.unmodifiableList(new ArrayList<>(mirrors));
            this.sha256 = sha256;
            this.bytes = bytes;
        }

        /** Primary URL first, then mirrors in order. */
        List<String> urls() {
            List<String> all = new ArrayList<>(mirrors.size() + 1);
            all.add(url);
            all.addAll(mirrors);
            return all;
        }
    }

    /** Pins for the selected ABI. */
    static final class Target {
        final String abi;
        final String alpineRepo;
        final Artifact rootfs;
        final Artifact omp;

        Target(String abi, String alpineRepo, Artifact rootfs, Artifact omp) {
            this.abi = abi;
            this.alpineRepo = alpineRepo;
            this.rootfs = rootfs;
            this.omp = omp;
        }
    }

    final List<String> packages;
    /** Null when no device ABI has artifacts. */
    final Target target;
    private final long downloadBytes;

    private RuntimeSpec(List<String> packages, Target target, long downloadBytes) {
        this.packages = packages;
        this.target = target;
        this.downloadBytes = downloadBytes;
    }

    /** The pinned omp release, e.g. "v18.10.4"; "" when this device is unsupported. */
    public String ompVersion() {
        return target == null ? "" : target.omp.version;
    }

    /** Bytes still to download before the runtime is installed; 0 once installed. */
    public long downloadBytes() {
        return downloadBytes;
    }

    boolean supported() {
        return target != null;
    }

    /** Same pins, carrying the caller-computed remaining download size. */
    RuntimeSpec withDownloadBytes(long remaining) {
        return new RuntimeSpec(packages, target, Math.max(0, remaining));
    }

    /** Spec for a build whose runtime.json is unusable: phone mode is reported unsupported. */
    static RuntimeSpec unsupported() {
        return new RuntimeSpec(Collections.<String>emptyList(), null, 0);
    }

    /**
     * Parses runtime.json and selects the first of {@code deviceAbis} that has an entry.
     *
     * @throws IllegalArgumentException with a precise reason when the file violates the schema
     */
    static RuntimeSpec parse(String json, String[] deviceAbis) {
        Map<String, Object> root = map(Json.parse(json), "runtime.json");
        long schema = number(root, "schema", "runtime.json");
        if (schema != SCHEMA) {
            throw new IllegalArgumentException("runtime.json schema " + schema + " is not supported (expected " + SCHEMA + ")");
        }
        List<String> packages = strings(root.get("packages"), "packages");
        if (packages.isEmpty()) throw new IllegalArgumentException("packages must not be empty");
        for (String p : packages) {
            // Package names reach `apk add` as argv; reject anything that is not a plain name.
            if (!p.matches("[A-Za-z0-9][A-Za-z0-9+._-]*")) {
                throw new IllegalArgumentException("invalid package name: " + p);
            }
        }
        Map<String, Object> abis = map(root.get("abis"), "abis");
        Target target = null;
        if (deviceAbis != null) {
            for (String abi : deviceAbis) {
                Object entry = abis.get(abi);
                if (entry != null) {
                    target = target(abi, map(entry, "abis." + abi));
                    break;
                }
            }
        }
        // Validate every entry, not only the selected one, so a broken pin for another ABI fails
        // the unit tests on the build host rather than on somebody's phone.
        for (Map.Entry<String, Object> e : abis.entrySet()) {
            target(e.getKey(), map(e.getValue(), "abis." + e.getKey()));
        }
        return new RuntimeSpec(Collections.unmodifiableList(packages), target, 0);
    }

    private static Target target(String abi, Map<String, Object> m) {
        String where = "abis." + abi;
        String repo = string(m, "alpineRepo", where);
        requireHttps(repo, where + ".alpineRepo");
        if (repo.endsWith("/")) throw new IllegalArgumentException(where + ".alpineRepo must not end with '/'");
        return new Target(abi, repo,
                artifact(map(m.get("rootfs"), where + ".rootfs"), where + ".rootfs"),
                artifact(map(m.get("omp"), where + ".omp"), where + ".omp"));
    }

    private static Artifact artifact(Map<String, Object> m, String where) {
        String version = string(m, "version", where);
        String url = string(m, "url", where);
        requireHttps(url, where + ".url");
        List<String> mirrors = m.containsKey("mirrors") ? strings(m.get("mirrors"), where + ".mirrors") : new ArrayList<String>();
        for (String mirror : mirrors) requireHttps(mirror, where + ".mirrors");
        String sha = string(m, "sha256", where);
        if (!sha.matches("[0-9a-f]{64}")) throw new IllegalArgumentException(where + ".sha256 must be 64 lowercase hex digits");
        long bytes = number(m, "bytes", where);
        if (bytes <= 0) throw new IllegalArgumentException(where + ".bytes must be positive");
        return new Artifact(version, url, mirrors, sha, bytes);
    }

    private static void requireHttps(String url, String where) {
        // Integrity comes from sha256, but https still keeps the request itself private.
        if (!url.startsWith("https://") || url.length() <= "https://".length()) {
            throw new IllegalArgumentException(where + " must be an https URL: " + url);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object v, String where) {
        if (!(v instanceof Map)) throw new IllegalArgumentException(where + " must be an object");
        return (Map<String, Object>) v;
    }

    private static String string(Map<String, Object> m, String key, String where) {
        Object v = m.get(key);
        if (!(v instanceof String) || ((String) v).isEmpty()) {
            throw new IllegalArgumentException(where + "." + key + " must be a non-empty string");
        }
        return (String) v;
    }

    private static long number(Map<String, Object> m, String key, String where) {
        Object v = m.get(key);
        if (!(v instanceof Long)) throw new IllegalArgumentException(where + "." + key + " must be an integer");
        return (Long) v;
    }

    private static List<String> strings(Object v, String where) {
        if (!(v instanceof List)) throw new IllegalArgumentException(where + " must be an array");
        List<String> out = new ArrayList<>();
        for (Object item : (List<?>) v) {
            if (!(item instanceof String) || ((String) item).isEmpty()) {
                throw new IllegalArgumentException(where + " must contain non-empty strings");
            }
            out.add((String) item);
        }
        return out;
    }
}
