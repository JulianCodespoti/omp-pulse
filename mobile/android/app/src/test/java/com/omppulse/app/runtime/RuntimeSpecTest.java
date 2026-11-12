package com.omppulse.app.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class RuntimeSpecTest {
    private static final String SHA = "9bf70a7f18ea44094cbb5f70c58f9af129c8214745743db0e68e5502cc2ce773";

    private static String spec(String abiBody) {
        return "{\"schema\":1,\"packages\":[\"bash\",\"libstdc++\"],\"abis\":{" + abiBody + "}}";
    }

    private static String abi(String name, String rootfsUrl, String sha, long bytes) {
        return "\"" + name + "\":{\"alpineRepo\":\"https://repo.example/alpine/v3.24\","
                + "\"rootfs\":{\"version\":\"3.24.2\",\"url\":\"" + rootfsUrl + "\",\"mirrors\":[\"https://m.example/r.tgz\"],"
                + "\"sha256\":\"" + sha + "\",\"bytes\":" + bytes + "},"
                + "\"omp\":{\"version\":\"v1.2.3\",\"url\":\"https://x.example/omp\",\"sha256\":\"" + SHA + "\",\"bytes\":10}}";
    }

    @Test
    public void bundledRuntimeJsonIsValidForArm64() throws IOException {
        // Gradle runs unit tests from the module directory.
        File asset = new File("src/main/assets/runtime/runtime.json");
        String json = new String(Files.readAllBytes(asset.toPath()), StandardCharsets.UTF_8);
        RuntimeSpec s = RuntimeSpec.parse(json, new String[] {"arm64-v8a", "armeabi-v7a"});
        assertTrue(s.supported());
        assertEquals("arm64-v8a", s.target.abi);
        assertEquals("v18.10.4", s.ompVersion());
        assertEquals(230166448L, s.target.omp.bytes);
        assertTrue(s.packages.contains("python3"));
        assertEquals(s.target.rootfs.url, s.target.rootfs.urls().get(0));
    }

    @Test
    public void selectsFirstDeviceAbiWithAnEntry() {
        String json = spec(abi("x86_64", "https://a/x.tgz", SHA, 5) + "," + abi("arm64-v8a", "https://a/arm.tgz", SHA, 7));
        RuntimeSpec s = RuntimeSpec.parse(json, new String[] {"riscv64", "arm64-v8a", "x86_64"});
        assertEquals("arm64-v8a", s.target.abi);
        assertEquals(7, s.target.rootfs.bytes);
        assertEquals(Arrays.asList("https://a/arm.tgz", "https://m.example/r.tgz"), s.target.rootfs.urls());
        assertEquals(Arrays.asList("https://x.example/omp"), s.target.omp.urls());
    }

    @Test
    public void unknownAbiIsUnsupportedNotAnError() {
        RuntimeSpec s = RuntimeSpec.parse(spec(abi("arm64-v8a", "https://a/r.tgz", SHA, 5)), new String[] {"armeabi-v7a"});
        assertFalse(s.supported());
        assertNull(s.target);
        assertEquals("", s.ompVersion());
        assertEquals(0, s.downloadBytes());
    }

    @Test
    public void downloadBytesIsCarriedByCopy() {
        RuntimeSpec s = RuntimeSpec.parse(spec(abi("arm64-v8a", "https://a/r.tgz", SHA, 5)), new String[] {"arm64-v8a"});
        assertEquals(0, s.downloadBytes());
        assertEquals(42, s.withDownloadBytes(42).downloadBytes());
        assertEquals("v1.2.3", s.withDownloadBytes(42).ompVersion());
    }

    @Test
    public void rejectsSchemaViolations() {
        String[] abis = {"arm64-v8a"};
        expectInvalid(spec(abi("arm64-v8a", "http://insecure/r.tgz", SHA, 5)), abis, "https");
        expectInvalid(spec(abi("arm64-v8a", "https://a/r.tgz", "ABC", 5)), abis, "sha256");
        expectInvalid(spec(abi("arm64-v8a", "https://a/r.tgz", SHA, 0)), abis, "bytes");
        // A broken entry for another ABI still fails: pins are validated as a whole.
        expectInvalid(spec(abi("arm64-v8a", "https://a/r.tgz", SHA, 5) + "," + abi("x86_64", "https://a/r.tgz", "", 5)), abis, "sha256");
        expectInvalid("{\"schema\":2,\"packages\":[\"bash\"],\"abis\":{}}", abis, "schema");
        expectInvalid("{\"schema\":1,\"packages\":[\"bash; rm -rf /\"],\"abis\":{}}", abis, "package");
        expectInvalid("{\"schema\":1,\"packages\":[],\"abis\":{}}", abis, "packages");
        expectInvalid("{\"schema\":1,", abis, "JSON");
    }

    @Test
    public void jsonReaderHandlesEscapesAndNumbers() {
        @SuppressWarnings("unchecked")
        Map<String, Object> m = (Map<String, Object>) Json.parse(
                "{\"s\":\"a\\\"b\\u00e9\\n\",\"i\":-12,\"d\":1.5e3,\"t\":true,\"n\":null,\"l\":[1,\"x\"]}");
        assertEquals("a\"b\u00e9\n", m.get("s"));
        assertEquals(-12L, m.get("i"));
        assertEquals(1500.0, (Double) m.get("d"), 0.0);
        assertEquals(Boolean.TRUE, m.get("t"));
        assertTrue(m.containsKey("n"));
        assertNull(m.get("n"));
        assertEquals(Arrays.<Object>asList(1L, "x"), (List<?>) m.get("l"));
    }

    private static void expectInvalid(String json, String[] abis, String fragment) {
        try {
            RuntimeSpec.parse(json, abis);
            fail("expected rejection mentioning " + fragment);
        } catch (IllegalArgumentException e) {
            assertTrue(e.getMessage(), e.getMessage().contains(fragment));
        }
    }
}
