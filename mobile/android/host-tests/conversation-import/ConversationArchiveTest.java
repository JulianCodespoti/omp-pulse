package com.omppulse.app.runtime;

import java.io.File;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.Manifest;
import java.util.stream.Stream;

final class ConversationArchiveTest {
    private static final String PACKAGE = "com.omppulse.app.next";
    private static final String BASE = "root/.local/share/omp/";
    private static int assertions;
    private static Path fixtures;
    private static Path staging;
    private static Set<String> trusted;

    private interface Action { void run() throws Exception; }

    private static void check(boolean condition, String message) {
        assertions++;
        if (!condition) throw new AssertionError(message);
    }

    private static void rejected(Action action, String message) throws Exception {
        try {
            action.run();
        } catch (IOException expected) {
            check(expected.getCause() == null, "no private native cause: " + message);
            return;
        }
        throw new AssertionError("Accepted " + message);
    }

    private static Set<String> stagingNames() throws IOException {
        Set<String> names = new HashSet<>();
        try (Stream<Path> children = Files.list(staging)) {
            children.forEach(path -> names.add(path.getFileName().toString()));
        }
        return names;
    }

    private static ConversationArchive.Prepared prepare(String name,
            ConversationArchive.MetadataListener listener) throws IOException {
        return ConversationArchive.prepare(Files.newInputStream(fixtures.resolve(name + ".jar")),
                staging.toFile(), trusted, PACKAGE, listener);
    }

    // Semantic exclusive-move fixture only: copy refuses existing destinations, then removes staging.
    // Atomicity is provided by the APK native helper and requires native/device verification.
    private static ConversationArchive.Publisher publisher() {
        return (source, destination) -> {
            Files.copy(source.toPath(), destination.toPath());
            Files.delete(source.toPath());
        };
    }

    private static String digest(byte[] bytes) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder text = new StringBuilder();
        for (byte value : hash) text.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return text.toString();
    }

    private static void exact(Path root, ConversationArchive.Prepared prepared) throws Exception {
        for (ConversationArchive.Entry entry : prepared.files) {
            byte[] expected = Files.readAllBytes(fixtures.resolve("expected").resolve(entry.path));
            byte[] actual = Files.readAllBytes(root.resolve(BASE).resolve(entry.path));
            check(Arrays.equals(expected, actual), "published bytes exact");
            check(entry.bytes == expected.length && entry.sha256.equals(digest(expected)), "reported hash and size exact");
        }
    }

    private static void validAndIdempotent() throws Exception {
        Path root = Files.createDirectory(fixtures.resolve("valid-root"));
        Set<String> before = stagingNames();
        int[] callbacks = {0};
        try (ConversationArchive.Prepared prepared = prepare("valid", properties -> {
            callbacks[0]++;
            check(PACKAGE.equals(properties.getProperty("targetPackage")), "listener sees authenticated target");
            // Listener mutation must not alter the import's validated properties.
            properties.setProperty("fileCount", "999");
        })) {
            check(callbacks[0] == 1 && prepared.files.size() == 3, "one metadata callback and three files");
            check("3".equals(prepared.metadata.getProperty("fileCount")), "listener receives defensive properties copy");
            int[] moves = {0};
            ConversationArchive.Result first = prepared.publish(root.toFile(), (source, destination) -> {
                check(source.toPath().startsWith(staging), "source is owned private staging");
                publisher().publish(source, destination);
                check(!source.exists(), "successful publication consumes staged source");
                moves[0]++;
            });
            long total = 0;
            for (ConversationArchive.Entry entry : prepared.files) total += entry.bytes;
            check(first.imported == 3 && first.unchanged == 0 && first.bytes == total && moves[0] == 3,
                    "first import counters and total bytes");
            exact(root, prepared);
            ConversationArchive.Result repeat = prepared.publish(root.toFile(), (source, destination) -> {
                throw new AssertionError("idempotent publish must not invoke publisher");
            });
            check(repeat.imported == 0 && repeat.unchanged == 3 && repeat.bytes == total, "same prepare idempotence");
        }
        check(stagingNames().equals(before), "close removes owned staging only");
        try (ConversationArchive.Prepared again = prepare("valid", null)) {
            ConversationArchive.Result repeat = again.publish(root.toFile(), publisher());
            check(repeat.imported == 0 && repeat.unchanged == 3, "fresh prepare idempotence");
            exact(root, again);
        }
        check(Files.isRegularFile(root.resolve(BASE + "blobs/fixture.png")), "close leaves published files intact");
    }

    private static void conflicts() throws Exception {
        Path root = Files.createDirectory(fixtures.resolve("conflict-root"));
        Path conflict = root.resolve(BASE + "blobs/fixture.png");
        Files.createDirectories(conflict.getParent());
        byte[] original = "existing user data".getBytes(StandardCharsets.UTF_8);
        Files.write(conflict, original);
        try (ConversationArchive.Prepared prepared = prepare("valid", null)) {
            rejected(() -> prepared.publish(root.toFile(), (source, destination) -> {
                throw new AssertionError("conflict preflight must not publish any file");
            }), "destination conflict");
        }
        check(Arrays.equals(original, Files.readAllBytes(conflict)), "conflicting bytes unchanged");
        check(!Files.exists(root.resolve(BASE + "sessions")), "preflight does not create directories or earlier files");
        Path ancestorRoot = Files.createDirectory(fixtures.resolve("ancestor-conflict-root"));
        Path ancestor = ancestorRoot.resolve(BASE + "sessions/project");
        Files.createDirectories(ancestor.getParent());
        Files.write(ancestor, original);
        try (ConversationArchive.Prepared prepared = prepare("valid", null)) {
            rejected(() -> prepared.publish(ancestorRoot.toFile(), publisher()), "file parent conflict");
        }
        check(Arrays.equals(original, Files.readAllBytes(ancestor)), "ancestor conflict unchanged");
    }

    private static void jdkAuthenticatesStructuralFixture(String fixture) throws Exception {
        try (JarFile jar = new JarFile(fixtures.resolve(fixture + ".jar").toFile(), true)) {
            byte[] buffer = new byte[8192];
            boolean signedMetadata = false;
            java.util.Enumeration<JarEntry> entries = jar.entries();
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                try (InputStream input = jar.getInputStream(entry)) {
                    while (input.read(buffer) != -1) { /* Trigger independent JDK verification. */ }
                }
                if (entry.getName().equals("transfer.properties")) {
                    check(entry.getCodeSigners() != null && entry.getCodeSigners().length > 0,
                            "hostile structural fixture has authenticated metadata");
                    check(trusted.contains(digest(entry.getCodeSigners()[0].getSignerCertPath()
                            .getCertificates().get(0).getEncoded())), "hostile fixture uses disposable trusted key");
                    signedMetadata = true;
                }
            }
            check(signedMetadata, "structural fixture contains signed metadata");
            Manifest manifest = jar.getManifest();
            if (fixture.equals("many-manifest-sections")) {
                check(manifest.getEntries().size() > 10000, "many-section fixture retains hostile sections");
            } else if (fixture.equals("many-sf-sections")) {
                check(manifest.getEntries().size() >= 6000, "manifest and signed SF exceed combined section budget");
            } else if (fixture.equals("many-manifest-attributes")) {
                int attributes = manifest.getMainAttributes().size();
                for (java.util.jar.Attributes section : manifest.getEntries().values()) attributes += section.size();
                check(attributes > 40000, "many-attribute fixture retains hostile attributes");
            } else if (fixture.equals("many-section-attributes")) {
                check(manifest.getMainAttributes().size() > 32, "single section retains excessive attributes");
            } else if (fixture.equals("long-folded-field")) {
                check(manifest.getMainAttributes().getValue("X-Long").length() > 8192,
                        "continuation fixture retains excessive logical field");
            }
        }
    }

    private static void authenticationAndSchema() throws Exception {
        String[] structural = {"many-manifest-sections", "many-sf-sections", "many-manifest-attributes",
                "many-section-attributes", "long-folded-field"};
        for (String fixture : structural) jdkAuthenticatesStructuralFixture(fixture);
        Set<String> structuralFixtures = new HashSet<>(Arrays.asList(structural));
        String[] invalid = {"unsigned", "tampered", "metadata-tampered", "wrong-target", "wrong-format",
                "count-mismatch", "conversation-mismatch", "duplicate-property", "invalid-utf8", "unknown-property",
                "oversized-metadata", "bad-cwd", "bad-callback", "bad-token", "bad-date", "bad-count",
                "too-many-count", "traversal", "absolute", "empty-component", "backslash", "owner", "lock",
                "owner-suffix", "owner-uppercase", "bare-lock",
                "outside", "prefix-collision", "metadata-late", "unsigned-extra", "duplicate-entry", "oversized-manifest",
                "oversized-sf", "oversized-rsa", "oversized-dsa", "oversized-ec", "oversized-signature-total",
                "many-manifest-sections", "many-sf-sections", "many-manifest-attributes", "many-section-attributes",
                "long-folded-field"};
        Set<String> before = stagingNames();
        for (String fixture : invalid) {
            int[] callbacks = {0};
            rejected(() -> {
                try (ConversationArchive.Prepared unexpected = prepare(fixture, properties -> callbacks[0]++)) {
                    throw new AssertionError("accepted invalid fixture with " + unexpected.files.size() + " files");
                }
            }, fixture);
            check(stagingNames().equals(before), "failed prepare cleans staging: " + fixture);
            if (fixture.equals("unsigned") || fixture.equals("metadata-tampered") || fixture.equals("wrong-target")
                    || fixture.equals("metadata-late") || structuralFixtures.contains(fixture)
                    || fixture.startsWith("oversized-")) {
                check(callbacks[0] == 0, "callback cannot see unverified or wrong-target metadata");
            }
        }
        rejected(() -> {
            try (ConversationArchive.Prepared unexpected = ConversationArchive.prepare(
                    Files.newInputStream(fixtures.resolve("valid.jar")), staging.toFile(),
                    Collections.singleton(String.join("", Collections.nCopies(64, "0"))), PACKAGE,
                    properties -> { throw new AssertionError("untrusted metadata callback"); })) {
                throw new AssertionError("accepted untrusted signer with " + unexpected.files.size() + " files");
            }
        }, "untrusted signer");
        rejected(() -> {
            try (ConversationArchive.Prepared unexpected = prepare("valid", properties -> {
                throw new IOException("sensitive callback details must not escape");
            })) {
                throw new AssertionError("accepted failing listener with " + unexpected.files.size() + " files");
            }
        }, "listener failure");
        check(stagingNames().equals(before), "untrusted signer and listener cleanup");
    }

    private static void symlinks() throws Exception {
        Path outside = Files.createDirectory(fixtures.resolve("outside-root"));
        Path root = Files.createDirectory(fixtures.resolve("symlink-root"));
        Path base = root.resolve(BASE);
        Files.createDirectories(base);
        Files.createSymbolicLink(base.resolve("sessions"), outside);
        try (ConversationArchive.Prepared prepared = prepare("valid", null)) {
            rejected(() -> prepared.publish(root.toFile(), publisher()), "symlink parent");
        }
        try (Stream<Path> children = Files.list(outside)) {
            check(children.count() == 0, "symlink parent cannot write outside root");
        }
        Path fileRoot = Files.createDirectory(fixtures.resolve("symlink-file-root"));
        Path destination = fileRoot.resolve(BASE + "sessions/project/chat.jsonl");
        Files.createDirectories(destination.getParent());
        Files.createSymbolicLink(destination, fixtures.resolve("expected/sessions/project/chat.jsonl"));
        try (ConversationArchive.Prepared prepared = prepare("valid", null)) {
            rejected(() -> prepared.publish(fileRoot.toFile(), publisher()), "identical destination symlink");
        }
        check(Files.isSymbolicLink(destination), "destination symlink is never replaced or removed");
        Path rootLink = fixtures.resolve("root-link");
        Files.createSymbolicLink(rootLink, fileRoot);
        try (ConversationArchive.Prepared prepared = prepare("valid", null)) {
            rejected(() -> prepared.publish(rootLink.toFile(), publisher()), "symlink rootfs");
        }
        Path stagingLink = fixtures.resolve("staging-link");
        Files.createSymbolicLink(stagingLink, staging);
        rejected(() -> {
            try (ConversationArchive.Prepared unexpected = ConversationArchive.prepare(
                    Files.newInputStream(fixtures.resolve("valid.jar")), stagingLink.toFile(), trusted, PACKAGE, null)) {
                throw new AssertionError("accepted staging symlink with " + unexpected.files.size() + " files");
            }
        }, "symlink staging parent");
    }

    private static void racesAndReadback() throws Exception {
        Set<String> before = stagingNames();
        Path root = Files.createDirectory(fixtures.resolve("race-root"));
        int[] moved = {0};
        byte[] winner = "concurrent winner".getBytes(StandardCharsets.UTF_8);
        try (ConversationArchive.Prepared prepared = prepare("valid", null)) {
            try {
                prepared.publish(root.toFile(), (source, destination) -> {
                    if (moved[0]++ == 1) Files.write(destination.toPath(), winner);
                    try {
                        publisher().publish(source, destination);
                    } catch (IOException e) {
                        check(source.isFile(), "exclusive move failure retains staged source");
                        throw e;
                    }
                });
                throw new AssertionError("Accepted exclusive publication race");
            } catch (ConversationArchive.PublishFailure expected) {
                check(expected.getCause() == null, "move failure does not expose a native cause");
                check(expected.operation.equals("move") && expected.entryIndex == 1,
                        "exclusive move failure reports bounded operation and entry");
            }
        }
        check(Arrays.equals(Files.readAllBytes(fixtures.resolve("expected/sessions/project/chat.jsonl")),
                Files.readAllBytes(root.resolve(BASE + "sessions/project/chat.jsonl"))),
                "earlier successful import remains after failure and close");
        check(Arrays.equals(winner, Files.readAllBytes(root.resolve(BASE + "sessions/project/chat/subagents/worker/tool.bin"))),
                "race winner remains unchanged");
        check(!Files.exists(root.resolve(BASE + "blobs/fixture.png")), "failed race stops further publication");
        check(stagingNames().equals(before), "failed publish close removes only private staging");
        Path readbackRoot = Files.createDirectory(fixtures.resolve("readback-root"));
        try (ConversationArchive.Prepared prepared = prepare("valid", null)) {
            rejected(() -> prepared.publish(readbackRoot.toFile(), (source, destination) -> {
                publisher().publish(source, destination);
                if (destination.getName().equals("fixture.png")) {
                    byte[] changed = Files.readAllBytes(destination.toPath());
                    changed[0] ^= 1;
                    Files.write(destination.toPath(), changed);
                }
            }), "same-size destination hash readback");
        }
        check(Files.exists(readbackRoot.resolve(BASE + "blobs/fixture.png")), "readback failure never rolls back published files");
        Path unchangedRoot = fixtures.resolve("valid-root");
        try (ConversationArchive.Prepared prepared = prepare("valid", null)) {
            Path destination = unchangedRoot.resolve(BASE + "blobs/fixture.png");
            byte[] changed = Files.readAllBytes(destination);
            changed[0] ^= 1;
            Files.write(destination, changed);
            rejected(() -> prepared.publish(unchangedRoot.toFile(), publisher()), "same-size existing conflict");
        }
    }

    private static void closingFailure() throws Exception {
        Set<String> before = stagingNames();
        InputStream source = new FilterInputStream(Files.newInputStream(fixtures.resolve("valid.jar"))) {
            private int closes;
            @Override public void close() throws IOException {
                super.close();
                if (++closes >= 2) throw new IOException("sensitive source close failure");
            }
        };
        rejected(() -> {
            try (ConversationArchive.Prepared unexpected = ConversationArchive.prepare(
                    source, staging.toFile(), trusted, PACKAGE, null)) {
                throw new AssertionError("accepted close failure with " + unexpected.files.size() + " files");
            }
        }, "input close failure");
        check(stagingNames().equals(before), "late input close failure cleans prepared staging");
        ConversationArchive.Prepared closed = prepare("valid", null);
        closed.close();
        closed.close();
        rejected(() -> closed.publish(fixtures.resolve("valid-root").toFile(), publisher()), "closed prepared import");
    }

    public static void main(String[] args) throws Exception {
        fixtures = new File(args[0]).getCanonicalFile().toPath();
        staging = Files.createDirectory(fixtures.resolve("staging"));
        Path unrelated = staging.resolve("unrelated-user-file");
        Files.write(unrelated, new byte[] {7, 8, 9});
        trusted = Collections.singleton(new String(Files.readAllBytes(fixtures.resolve("trusted.sha256")), StandardCharsets.UTF_8));
        validAndIdempotent();
        conflicts();
        authenticationAndSchema();
        symlinks();
        racesAndReadback();
        closingFailure();
        check(Arrays.equals(Files.readAllBytes(unrelated), new byte[] {7, 8, 9}), "cleanup preserves unrelated staging-parent data");
        System.out.println("PASS " + assertions + " signed conversation archive assertions");
    }
}
