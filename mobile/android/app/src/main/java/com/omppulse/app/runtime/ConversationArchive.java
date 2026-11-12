package com.omppulse.app.runtime;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.SequenceInputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.CodeSigner;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.Certificate;
import java.security.cert.CertificateEncodingException;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.jar.JarEntry;
import java.util.jar.JarInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Authenticated, bounded conversation transfer; no Android or guest-process dependencies. */
public final class ConversationArchive {
    private static final int MAX_ENTRIES = 100_000;
    private static final int MAX_METADATA = 64 * 1024;
    private static final int MAX_SIGNATURE = 4 * 1024 * 1024;
    private static final long MAX_SIGNATURE_TOTAL = 8L * 1024 * 1024;
    private static final int MAX_SIGNATURE_BLOCK = 256 * 1024;
    private static final long MAX_SIGNATURE_BLOCK_TOTAL = 1024 * 1024;
    private static final int MAX_MANIFEST_SECTIONS = 10_000;
    private static final int MAX_MANIFEST_ATTRIBUTES = 40_000;
    private static final int MAX_SECTION_ATTRIBUTES = 32;
    private static final int MAX_MANIFEST_FIELD = 8192;
    private static final long MAX_MANIFEST_RETAINED = 4L * 1024 * 1024;
    private static final int MAX_SIGNATURE_CAPTURE = (int) MAX_SIGNATURE_TOTAL + 1024 * 1024;
    private static final long MAX_FILE = 512L * 1024 * 1024;
    private static final long MAX_TOTAL = 4L * 1024 * 1024 * 1024;
    private static final String TARGET = "root/.local/share/omp/";

    private ConversationArchive() {}

    public interface MetadataListener {
        void verified(Properties properties) throws IOException;
    }

    /** Implementations MUST atomically move exclusively, never copy or replace a destination. */
    public interface Publisher {
        void publish(File staged, File destination) throws IOException;
    }

    public static final class Entry {
        public final String path;
        public final String sha256;
        public final long bytes;
        private final File staged;

        private Entry(String path, String sha256, long bytes, File staged) {
            this.path = path;
            this.sha256 = sha256;
            this.bytes = bytes;
            this.staged = staged;
        }
    }

    public static final class Result {
        public final int imported;
        public final int unchanged;
        /** Total verified destination bytes, including unchanged files. */
        public final long bytes;

        private Result(int imported, int unchanged, long bytes) {
            this.imported = imported;
            this.unchanged = unchanged;
            this.bytes = bytes;
        }
    }
    /** Content-free failure details safe to return through the authenticated receipt. */
    public static final class PublishFailure extends IOException {
        private static final long serialVersionUID = 1L;
        public final String operation;
        public final int entryIndex;

        private PublishFailure(String operation, int entryIndex) {
            super("Conversation publication failed");
            this.operation = operation;
            this.entryIndex = entryIndex;
        }
    }


    public static final class Prepared implements Closeable {
        public final Properties metadata;
        public final List<Entry> files;
        private final File staging;
        private final List<File> owned;
        private boolean closed;

        private Prepared(Properties metadata, List<Entry> files, File staging, List<File> owned) {
            this.metadata = copyProperties(metadata);
            this.files = Collections.unmodifiableList(new ArrayList<>(files));
            this.staging = staging;
            this.owned = owned;
        }

        /** Preflight is read-only. A commit race fails without rolling back successful moves. */
        public synchronized Result publish(File rootfs, Publisher publisher) throws IOException {
            if (closed || rootfs == null || publisher == null) throw failure();
            String operation = "root_directory";
            int entryIndex = -1;
            try {
                File root = rootfs.getAbsoluteFile();
                requireDirectoryChain(root, false);
                List<File> destinations = new ArrayList<>(files.size());
                boolean[] existing = new boolean[files.size()];
                byte[] buffer = new byte[64 * 1024];
                // Do not create even directories until every conflict has been ruled out.
                for (int i = 0; i < files.size(); i++) {
                    entryIndex = i;
                    operation = "preflight_directory";
                    Entry entry = files.get(i);
                    File destination = new File(root, TARGET + entry.path);
                    requireDirectoryChain(destination.getParentFile(), true);
                    operation = "preflight_path";
                    requireCanonical(destination);
                    if (destination.exists()) {
                        operation = "preflight_conflict";
                        requireContents(destination, entry, buffer);
                        existing[i] = true;
                    }
                    destinations.add(destination);
                }
                int imported = 0;
                int unchanged = 0;
                long bytes = 0;
                for (int i = 0; i < files.size(); i++) {
                    entryIndex = i;
                    Entry entry = files.get(i);
                    File destination = destinations.get(i);
                    if (existing[i]) {
                        unchanged++;
                    } else {
                        operation = "mkdir";
                        createDirectoryChain(destination.getParentFile());
                        operation = "destination_race";
                        requireCanonical(destination);
                        // The publisher is exclusive even if a writer wins after this check.
                        if (destination.exists()) throw failure();
                        operation = "staged_readback";
                        requireContents(entry.staged, entry, buffer);
                        operation = "move";
                        publisher.publish(entry.staged, destination);
                        imported++;
                    }
                    bytes += entry.bytes;
                }
                // Recheck unchanged files as well: a concurrent writer must not get a receipt.
                for (int i = 0; i < files.size(); i++) {
                    entryIndex = i;
                    operation = "destination_readback";
                    File destination = destinations.get(i);
                    requireDirectoryChain(destination.getParentFile(), false);
                    requireCanonical(destination);
                    requireContents(destination, files.get(i), buffer);
                }
                return new Result(imported, unchanged, bytes);
            } catch (IOException | RuntimeException e) {
                // Native messages and paths can contain private data. Do not chain causes.
                throw new PublishFailure(operation, entryIndex);
            }
        }

        /** Deletes only our flat, private staging names, never destinations or their trees. */
        @Override public synchronized void close() throws IOException {
            if (closed) return;
            if (!cleanup(staging, owned)) throw failure();
            closed = true;
        }
    }

    /** Consumes and closes input, including on failure. Listener receives authenticated metadata only. */
    public static Prepared prepare(InputStream input, File stagingParent,
            Set<String> trustedSignerSha256, String expectedPackage, MetadataListener listener)
            throws IOException {
        File staging = null;
        List<File> owned = new ArrayList<>();
        boolean success = false;
        try {
            Prepared result;
            try (InputStream source = input) {
                if (source == null || stagingParent == null || expectedPackage == null
                        || expectedPackage.isEmpty() || trustedSignerSha256 == null
                        || trustedSignerSha256.isEmpty()) throw failure();
                Set<String> trusted = new HashSet<>();
                for (String digest : trustedSignerSha256) {
                    if (digest == null || !digest.matches("[0-9a-fA-F]{64}")) throw failure();
                    trusted.add(digest.toLowerCase(Locale.ROOT));
                }
                requireDirectoryChain(stagingParent.getAbsoluteFile(), false);
                staging = privateDirectory(stagingParent);
                List<Entry> files = new ArrayList<>();
                Set<String> paths = new HashSet<>();
                Set<String> parents = new HashSet<>();
                Set<String> names = new HashSet<>();
                names.add("META-INF/MANIFEST.MF");
                Properties metadata = null;
                long total = 0;
                long signatureTotal = 0;
                int conversations = 0;
                byte[] buffer = new byte[64 * 1024];
                // Privately spool just the leading compressed section, not the archive's data.
                // Bound ALL verifier metadata before any JAR verifier sees the stream.
                File prefix = new File(staging, "signature-prefix");
                if (!prefix.createNewFile()) throw failure();
                owned.add(prefix);
                LeadingMetadata leading = leadingMetadata(
                        new BufferedInputStream(source, buffer.length), prefix, buffer);
                int entries = leading.entries;
                try (InputStream replay = leading.stream;
                     JarInputStream jar = new JarInputStream(replay, true)) {
                    if (jar.getManifest() == null) throw failure();
                    JarEntry item;
                    while ((item = jar.getNextJarEntry()) != null) {
                        if (++entries > MAX_ENTRIES) throw failure();
                        String name = item.getName();
                        if (name.regionMatches(true, 0, "META-INF/", 0, 9)) {
                            if (!names.add(name.toUpperCase(Locale.ROOT)) || metadata != null
                                    || !signatureName(name) || item.isDirectory()) throw failure();
                            signatureTotal += copy(jar, null, null, MAX_SIGNATURE, buffer);
                            if (signatureTotal > MAX_SIGNATURE_TOTAL) throw failure();
                            continue;
                        }
                        if (!paths.add(name) || item.isDirectory()) throw failure();
                        if (metadata == null) {
                            if (!name.equals("transfer.properties")) throw failure();
                            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                            copy(jar, bytes, null, MAX_METADATA, buffer);
                            requireSigner(item, trusted);
                            metadata = parseMetadata(bytes.toByteArray(), expectedPackage);
                            if (listener != null) listener.verified(copyProperties(metadata));
                        } else {
                            validatePath(name);
                            if (parents.contains(name)) throw failure();
                            for (int slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1)) {
                                String parent = name.substring(0, slash);
                                if (paths.contains(parent)) throw failure();
                                parents.add(parent);
                            }
                            File staged = new File(staging, Integer.toString(files.size()));
                            if (!staged.createNewFile()) throw failure();
                            owned.add(staged);
                            MessageDigest digest = sha256();
                            long size;
                            try (FileOutputStream output = new FileOutputStream(staged)) {
                                size = copy(jar, output, digest, Math.min(MAX_FILE, MAX_TOTAL - total), buffer);
                            }
                            requireSigner(item, trusted);
                            total += size;
                            files.add(new Entry(name, hex(digest.digest()), size, staged));
                            if (isConversation(name)) conversations++;
                        }
                    }
                }
                if (metadata == null || decimal(metadata, "fileCount", MAX_ENTRIES) != files.size()
                        || decimal(metadata, "conversationCount", MAX_ENTRIES) != conversations) throw failure();
                result = new Prepared(metadata, files, staging, owned);
            }
            success = true;
            return result;
        } catch (IOException | RuntimeException e) {
            throw failure();
        } finally {
            if (!success && staging != null) cleanup(staging, owned);
        }
    }

    private static final class LeadingMetadata {
        final InputStream stream;
        final int entries;
        LeadingMetadata(InputStream stream, int entries) { this.stream = stream; this.entries = entries; }
    }

    private static LeadingMetadata leadingMetadata(InputStream source, File prefix, byte[] buffer)
            throws IOException {
        int hiddenEntries = 1;
        try (FileOutputStream capture = new FileOutputStream(prefix)) {
            InputStream recording = new FilterInputStream(source) {
                private int count;
                @Override public int read() throws IOException {
                    int value = in.read();
                    if (value >= 0) {
                        if (count >= MAX_SIGNATURE_CAPTURE) throw failure();
                        capture.write(value);
                        count++;
                    }
                    return value;
                }
                @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                    int n = in.read(bytes, offset, Math.min(length, MAX_SIGNATURE_CAPTURE + 1 - count));
                    if (n > 0) {
                        if ((long) count + n > MAX_SIGNATURE_CAPTURE) throw failure();
                        capture.write(bytes, offset, n);
                        count += n;
                    }
                    return n;
                }
                @Override public void close() { /* The replay stream owns source. */ }
            };
            try (ZipInputStream zip = new ZipInputStream(recording)) {
                ZipEntry first = zip.getNextEntry();
                if (first != null && first.getName().equalsIgnoreCase("META-INF/")) {
                    if (!first.isDirectory() || copy(zip, null, null, 0, buffer) != 0) throw failure();
                    first = zip.getNextEntry();
                    hiddenEntries++;
                }
                if (first == null || !first.getName().equalsIgnoreCase("META-INF/MANIFEST.MF")
                        || first.isDirectory()) throw failure();
                ManifestBudget budget = new ManifestBudget();
                long total = inspectManifest(zip, MAX_SIGNATURE, buffer, budget);
                long blocks = 0;
                Set<String> names = new HashSet<>();
                names.add("META-INF/MANIFEST.MF");
                int entries = hiddenEntries;
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    if (++entries > MAX_ENTRIES) throw failure();
                    String name = entry.getName();
                    if (!name.regionMatches(true, 0, "META-INF/", 0, 9)) break;
                    if (!names.add(name.toUpperCase(Locale.ROOT)) || entry.isDirectory()
                            || !signatureName(name)) throw failure();
                    long remaining = MAX_SIGNATURE_TOTAL - total;
                    if (name.toUpperCase(Locale.ROOT).endsWith(".SF")) {
                        total += inspectManifest(zip, Math.min(MAX_SIGNATURE, remaining), buffer, budget);
                    } else {
                        long size = copy(zip, null, null, Math.min(MAX_SIGNATURE_BLOCK,
                                Math.min(MAX_SIGNATURE_BLOCK_TOTAL - blocks, remaining)), buffer);
                        blocks += size;
                        total += size;
                    }
                }
                if (entry == null) throw failure();
            }
        }
        return new LeadingMetadata(
                new SequenceInputStream(new FileInputStream(prefix), source), hiddenEntries);
    }

    private static final class ManifestBudget {
        int sections;
        int attributes;
        long retained;
    }

    /** Bound parser object expansion, not only inflated bytes, before JAR/PKCS7 verification. */
    private static long inspectManifest(InputStream input, long limit, byte[] buffer,
            ManifestBudget budget) throws IOException {
        if (++budget.sections > MAX_MANIFEST_SECTIONS) throw failure();
        long bytes = 0;
        int sectionAttributes = 0;
        int lineLength = 0;
        int fieldLength = 0;
        boolean haveAttribute = false;
        boolean pendingCR = false;
        int n;
        while ((n = input.read(buffer, 0, (int) Math.min(buffer.length, limit - bytes + 1))) != -1) {
            bytes += n;
            if (bytes > limit) throw failure();
            for (int i = 0; i < n; i++) {
                int value = buffer[i] & 255;
                if (pendingCR) {
                    if (value != '\n') throw failure();
                    pendingCR = false;
                    continue;
                }
                if (value == '\r' || value == '\n') {
                    if (lineLength == 0) {
                        if (++budget.sections > MAX_MANIFEST_SECTIONS) throw failure();
                        sectionAttributes = 0;
                        haveAttribute = false;
                        fieldLength = 0;
                    }
                    lineLength = 0;
                    pendingCR = value == '\r';
                    continue;
                }
                if (lineLength == 0) {
                    if (value == ' ') {
                        if (!haveAttribute) throw failure();
                    } else {
                        if (++budget.attributes > MAX_MANIFEST_ATTRIBUTES
                                || ++sectionAttributes > MAX_SECTION_ATTRIBUTES) throw failure();
                        haveAttribute = true;
                        fieldLength = 0;
                    }
                }
                lineLength++;
                if (++fieldLength > MAX_MANIFEST_FIELD
                        || ++budget.retained > MAX_MANIFEST_RETAINED) throw failure();
            }
        }
        // Accept standard CRLF/LF records only; reject ambiguous/incomplete parser input.
        if (pendingCR || lineLength != 0) throw failure();
        return bytes;
    }

    private static boolean signatureName(String name) {
        String upper = name.toUpperCase(Locale.ROOT);
        String leaf = upper.substring(9);
        return !leaf.isEmpty() && leaf.indexOf('/') < 0 && !leaf.equals("MANIFEST.MF")
                && (leaf.endsWith(".SF") || leaf.endsWith(".RSA")
                || leaf.endsWith(".DSA") || leaf.endsWith(".EC"));
    }

    private static void requireSigner(JarEntry entry, Set<String> trusted) throws IOException {
        CodeSigner[] signers = entry.getCodeSigners();
        if (signers == null || signers.length == 0) throw failure();
        for (CodeSigner signer : signers) {
            List<? extends Certificate> certificates = signer.getSignerCertPath().getCertificates();
            if (certificates.isEmpty()) continue;
            try {
                if (trusted.contains(hex(sha256().digest(certificates.get(0).getEncoded())))) return;
            } catch (CertificateEncodingException e) {
                throw failure();
            }
        }
        throw failure();
    }

    private static final class UniqueProperties extends Properties {
        private static final long serialVersionUID = 1L;
        @Override public synchronized Object put(Object key, Object value) {
            if (containsKey(key)) throw new IllegalArgumentException();
            return super.put(key, value);
        }
    }

    private static Properties parseMetadata(byte[] bytes, String expectedPackage) throws IOException {
        Properties properties = new UniqueProperties();
        properties.load(new InputStreamReader(new ByteArrayInputStream(bytes),
                StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT)));
        if (!"omp-conversations-v1".equals(properties.getProperty("format"))
                || !expectedPackage.equals(properties.getProperty("targetPackage"))) throw failure();
        String request = required(properties, "requestId");
        if (!UUID.fromString(request).toString().equals(request)) throw failure();
        String token = required(properties, "callbackToken");
        if (!token.matches("[0-9a-fA-F]{64}|[A-Za-z0-9_-]{43}")) throw failure();
        try {
            URI callback = new URI(required(properties, "callbackUrl"));
            int port = callback.getPort();
            if (port < 1 || port > 65535 || !("http://127.0.0.1:" + port + "/result")
                    .equals(callback.toString())) throw failure();
        } catch (URISyntaxException e) {
            throw failure();
        }
        validateTimestamp(required(properties, "snapshotTime"));
        int fileCount = decimal(properties, "fileCount", MAX_ENTRIES);
        if (decimal(properties, "conversationCount", MAX_ENTRIES) > fileCount) throw failure();
        int cwdCount = decimal(properties, "cwdCount", MAX_ENTRIES);
        Set<String> keys = new HashSet<>();
        Collections.addAll(keys, "format", "targetPackage", "requestId", "callbackUrl", "callbackToken",
                "fileCount", "conversationCount", "snapshotTime", "cwdCount");
        for (int i = 0; i < cwdCount; i++) {
            String key = "cwd." + i;
            String cwd = required(properties, key);
            if (!cwd.startsWith("/") || cwd.length() > 4096 || cwd.indexOf('\\') >= 0) throw failure();
            if (!cwd.equals("/")) validateComponents(cwd.substring(1));
            keys.add(key);
        }
        if (!keys.equals(properties.stringPropertyNames())) throw failure();
        return properties;
    }

    // java.time is not available on all supported Android releases.
    private static void validateTimestamp(String value) throws IOException {
        if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z")) {
            throw failure();
        }
        String seconds = value.substring(0, 19) + "Z";
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        format.setLenient(false);
        ParsePosition position = new ParsePosition(0);
        Date date = format.parse(seconds, position);
        if (date == null || position.getIndex() != seconds.length()) throw failure();
    }

    private static int decimal(Properties properties, String key, int maximum) throws IOException {
        String value = required(properties, key);
        if (!value.matches("0|[1-9][0-9]{0,8}")) throw failure();
        int number = Integer.parseInt(value);
        if (number > maximum) throw failure();
        return number;
    }

    private static String required(Properties properties, String key) throws IOException {
        String value = properties.getProperty(key);
        if (value == null || value.isEmpty()) throw failure();
        return value;
    }

    private static void validatePath(String path) throws IOException {
        if (path.length() > 4096 || !(path.startsWith("sessions/") || path.startsWith("blobs/"))) {
            throw failure();
        }
        validateComponents(path);
        for (String part : path.split("/")) {
            String lower = part.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".owner") || lower.endsWith(".lock") || lower.equals("lock")) throw failure();
        }
    }

    private static void validateComponents(String path) throws IOException {
        for (String part : path.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) throw failure();
            for (int i = 0; i < part.length(); i++) {
                char c = part.charAt(i);
                if (c < 32 || c == 127 || c == '\\') throw failure();
            }
        }
    }

    private static boolean isConversation(String path) {
        if (!path.startsWith("sessions/") || !path.endsWith(".jsonl")) return false;
        int project = path.indexOf('/', "sessions/".length());
        return project >= 0 && path.indexOf('/', project + 1) < 0;
    }

    private static long copy(InputStream input, java.io.OutputStream output, MessageDigest digest,
            long limit, byte[] buffer) throws IOException {
        long size = 0;
        int n;
        while ((n = input.read(buffer, 0, (int) Math.min(buffer.length, limit - size + 1))) != -1) {
            if (n == 0) continue;
            size += n;
            if (size > limit) throw failure();
            if (output != null) output.write(buffer, 0, n);
            if (digest != null) digest.update(buffer, 0, n);
        }
        return size;
    }

    private static void requireContents(File file, Entry entry, byte[] buffer) throws IOException {
        requireCanonical(file);
        if (!file.isFile() || file.length() != entry.bytes) throw failure();
        MessageDigest digest = sha256();
        long bytes;
        try (InputStream input = new FileInputStream(file)) {
            bytes = copy(input, null, digest, entry.bytes, buffer);
        }
        if (bytes != entry.bytes || !entry.sha256.equals(hex(digest.digest()))) throw failure();
    }

    private static void requireCanonical(File file) throws IOException {
        // Comparing every component also rejects symlink ancestors that point inside the root.
        if (!file.getAbsoluteFile().equals(file.getCanonicalFile())) throw failure();
    }

    private static void requireDirectoryChain(File directory, boolean allowMissing) throws IOException {
        for (File current = directory; current != null; current = current.getParentFile()) {
            requireCanonical(current);
            if (!current.isDirectory() && (!allowMissing || current.exists())) throw failure();
        }
    }

    private static void createDirectoryChain(File directory) throws IOException {
        List<File> missing = new ArrayList<>();
        File current = directory;
        while (!current.isDirectory()) {
            requireCanonical(current);
            if (current.exists()) throw failure();
            missing.add(current);
            current = current.getParentFile();
            if (current == null) throw failure();
        }
        requireDirectoryChain(current, false);
        for (int i = missing.size() - 1; i >= 0; i--) {
            File next = missing.get(i);
            requireCanonical(next);
            if (!next.mkdir() && !next.isDirectory()) throw failure();
            requireCanonical(next);
        }
    }

    private static File privateDirectory(File parent) throws IOException {
        File directory = new File(parent, "conversation-import-" + UUID.randomUUID());
        if (!directory.mkdir()) throw failure();
        if (!directory.setReadable(false, false) || !directory.setWritable(false, false)
                || !directory.setExecutable(false, false) || !directory.setReadable(true, true)
                || !directory.setWritable(true, true) || !directory.setExecutable(true, true)) {
            directory.delete();
            throw failure();
        }
        return directory;
    }

    private static boolean cleanup(File staging, List<File> owned) {
        try {
            if (!staging.exists()) return true;
            requireDirectoryChain(staging, false);
            boolean clean = true;
            for (File file : owned) {
                requireCanonical(file);
                if (!file.delete() && file.exists()) clean = false;
            }
            if (!staging.delete() && staging.exists()) clean = false;
            return clean;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    private static Properties copyProperties(Properties source) {
        Properties copy = new Properties();
        copy.putAll(source);
        return copy;
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException();
        }
    }

    private static String hex(byte[] bytes) {
        char[] text = new char[bytes.length * 2];
        char[] alphabet = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            text[i * 2] = alphabet[(bytes[i] & 255) >>> 4];
            text[i * 2 + 1] = alphabet[bytes[i] & 15];
        }
        return new String(text);
    }

    private static IOException failure() { return new IOException("Conversation archive rejected"); }
}
