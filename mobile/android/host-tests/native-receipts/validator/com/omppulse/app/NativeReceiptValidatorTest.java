package com.omppulse.app;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.BigInteger;

/** Hermetic tests of the exact production validator, with a synthetic typed JSON-object boundary. */
public final class NativeReceiptValidatorTest {
    private static final String ID = "native-command-17";
    private static final String RAW = "/alias/session.jsonl";
    private static final String CANONICAL = "/sessions/canonical.jsonl";
    private static int checks;

    private NativeReceiptValidatorTest() {}

    public static void main(String[] args) {
        supportedReceipts();
        envelopeAndIdentityTypes();
        timestampTypes();
        optionalFields();
        incomingBindings();
        retainedBindings();
        System.out.println("PASS native receipt validator: " + checks + " checks");
        System.out.println("Boundary: exact production Java helper; synthetic org.json objects; " +
                "no parser, Android, persistence, transport, scheduling, device or daemon acceptance.");
    }

    private static void supportedReceipts() {
        String[] states = {"accepted", "dispatching", "forwarded", "received", "running",
                "completed", "failed", "uncertain"};
        for (String state : states) {
            accepted("legacy state " + state, envelope(receipt(RAW, state)), null, null);
            accepted("bound alias state " + state, bound(receipt(CANONICAL, state)), null, null);
        }
        for (Object state : new Object[]{"saved", "rejected", "complete", "COMPLETED", "",
                1, true, JSONObject.NULL, null}) {
            rejected("unsupported state " + state,
                    envelope(receipt(RAW, "accepted").put("state", state)), null, null);
        }
        JSONObject response = bound(receipt(CANONICAL, "completed"));
        NativeReceiptValidator.Evidence evidence = accepted("evidence keeps exact objects", response,
                null, null);
        check(evidence.receipt == response.opt("receipt"), "receipt object preserved");
        check(evidence.binding == response.opt("receiptBinding"), "binding object preserved");
        NativeReceiptValidator.Evidence legacy = accepted("absent legacy stays absent",
                envelope(receipt(RAW, "accepted")), null, null);
        check(legacy.binding == null, "legacy binding is Java null");
        accepted("exact raw path may acquire witness", envelope(receipt(RAW, "accepted"))
                .put("receiptBinding", binding(RAW, RAW)), null, null);
        accepted("no input normalization", bound(receipt(CANONICAL, "accepted"))
                .put("receiptBinding", binding(" /raw/../alias ", CANONICAL)), ID,
                " /raw/../alias ", null, null);
        accepted("unknown additive envelope and receipt fields", envelope(receipt(RAW, "accepted")
                .put("futureOptionalField", true)).put("futureOptionalField", 7), null, null);
    }

    private static void envelopeAndIdentityTypes() {
        rejected("null response", null, null, null);
        for (Object ok : new Object[]{false, "true", 1, JSONObject.NULL, null}) {
            rejected("nonliteral ok " + ok, envelope(receipt(RAW, "accepted")).put("ok", ok),
                    null, null);
        }
        for (Object invalid : new Object[]{JSONObject.NULL, "receipt", 1, true, null}) {
            rejected("invalid receipt object " + invalid, envelope(invalid), null, null);
        }
        for (Object invalid : new Object[]{"other-command", "", 1, true, JSONObject.NULL, null}) {
            rejected("invalid receipt ID " + invalid,
                    envelope(receipt(RAW, "accepted").put("commandId", invalid)), null, null);
        }
        for (Object invalid : new Object[]{"", 1, true, JSONObject.NULL, null}) {
            rejected("invalid receipt path " + invalid,
                    envelope(receipt(RAW, "accepted").put("sessionPath", invalid)), null, null);
        }
        rejected("legacy alias without witness", envelope(receipt(CANONICAL, "completed")),
                null, null);
        rejected("legacy raw path trailing separator mismatch",
                envelope(receipt(RAW + "/", "completed")), null, null);
        rejected("null expected ID", envelope(receipt(RAW, "completed")), null, RAW, null, null);
        rejected("empty expected ID", envelope(receipt(RAW, "completed")), "", RAW, null, null);
        rejected("null raw path", envelope(receipt(RAW, "completed")), ID, null, null, null);
        rejected("empty raw path", envelope(receipt(RAW, "completed")), ID, "", null, null);
    }

    private static void timestampTypes() {
        Object[] valid = {0, 1L, Long.MAX_VALUE, 1.0, -0.0,
                new BigInteger("18446744073709551615"), new BigDecimal("5.000")};
        for (String field : new String[]{"createdAt", "updatedAt"}) {
            for (Object value : valid) {
                accepted("integral numeric " + field + " " + value,
                        envelope(receipt(RAW, "running").put(field, value)), null, null);
            }
            for (Object value : new Object[]{-1, -0.01, 1.5, "1", true, JSONObject.NULL, null,
                    Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY,
                    new BigDecimal("1.0000000000000000000000001")}) {
                rejected("invalid " + field + " " + value,
                        envelope(receipt(RAW, "running").put(field, value)), null, null);
            }
        }
        accepted("equal timestamps", envelope(receipt(RAW, "completed")
                .put("createdAt", 7).put("updatedAt", 7)), null, null);
        accepted("clock rollback within receipt", envelope(receipt(RAW, "completed")
                .put("createdAt", 1000).put("updatedAt", 5)), null, null);
        JSONObject previous = receipt(CANONICAL, "running").put("updatedAt", 1000);
        accepted("equal timestamp completion with retained witness", bound(receipt(CANONICAL,
                "completed").put("updatedAt", 1000)), previous, binding(RAW, CANONICAL));
        accepted("clock rollback completion with retained witness", bound(receipt(CANONICAL,
                "completed").put("updatedAt", 1)), previous, binding(RAW, CANONICAL));
        accepted("helper imposes no nonterminal state ranking", bound(receipt(CANONICAL,
                "accepted")), previous, binding(RAW, CANONICAL));
    }

    private static void optionalFields() {
        for (String field : new String[]{"code", "error"}) {
            accepted("omitted optional " + field, envelope(receipt(RAW, "failed")), null, null);
            accepted("empty optional " + field,
                    envelope(receipt(RAW, "failed").put(field, "")), null, null);
            accepted("string optional " + field,
                    envelope(receipt(RAW, "failed").put(field, "daemon detail")), null, null);
            for (Object value : new Object[]{JSONObject.NULL, 1, true, new JSONObject()}) {
                rejected("invalid optional " + field + " " + value,
                        envelope(receipt(RAW, "failed").put(field, value)), null, null);
            }
        }
    }

    private static void incomingBindings() {
        for (Object value : new Object[]{JSONObject.NULL, "binding", 1, true, new JSONObject()}) {
            rejected("present malformed network witness " + value,
                    envelope(receipt(RAW, "completed")).put("receiptBinding", value), null, null);
        }
        for (Object version : new Object[]{null, JSONObject.NULL, "1", true, 0, 2, -1, 1.1,
                Double.NaN, Double.POSITIVE_INFINITY, new BigDecimal("1.0000000000000000001")}) {
            rejected("invalid witness version " + version, bound(receipt(CANONICAL, "completed"))
                    .put("receiptBinding", binding(RAW, CANONICAL).put("version", version)),
                    null, null);
        }
        for (Object version : new Object[]{1, 1L, 1.0, new BigDecimal("1.00")}) {
            accepted("numeric v1 " + version, bound(receipt(CANONICAL, "completed"))
                    .put("receiptBinding", binding(RAW, CANONICAL).put("version", version)),
                    null, null);
        }
        for (Object path : new Object[]{null, JSONObject.NULL, 1, true, "", CANONICAL, RAW + "/"}) {
            rejected("invalid requested echo " + path, bound(receipt(CANONICAL, "completed"))
                    .put("receiptBinding", binding(RAW, CANONICAL).put("requestedSessionPath", path)),
                    null, null);
        }
        for (Object path : new Object[]{null, JSONObject.NULL, 1, true, "", RAW, CANONICAL + "/"}) {
            rejected("invalid canonical echo " + path, bound(receipt(CANONICAL, "completed"))
                    .put("receiptBinding", binding(RAW, CANONICAL).put("canonicalSessionPath", path)),
                    null, null);
        }
        accepted("additive witness fields", bound(receipt(CANONICAL, "completed"))
                .put("receiptBinding", binding(RAW, CANONICAL).put("futureField", 1)), null, null);
        rejected("raw equality cannot bypass malformed present witness",
                envelope(receipt(RAW, "completed")).put("receiptBinding", new JSONObject()),
                null, null);
    }

    private static void retainedBindings() {
        JSONObject prior = receipt(CANONICAL, "accepted");
        JSONObject proof = binding(RAW, CANONICAL);
        accepted("retained witness continuity", bound(receipt(CANONICAL, "completed")), prior, proof);
        accepted("serialized-value equivalent retained witness",
                bound(receipt(CANONICAL, "completed")), receipt(CANONICAL, "accepted"),
                binding(RAW, CANONICAL));
        accepted("legacy exact receipt acquires first alias proof", bound(receipt(CANONICAL,
                "completed")), receipt(RAW, "accepted"), null);
        accepted("old receipt alone does not pin canonical", bound(receipt(CANONICAL,
                "completed")), receipt("/old/unbound/canonical.jsonl", "accepted"), null);
        accepted("old malformed receipt with no witness does not manufacture proof",
                bound(receipt(CANONICAL, "completed")), new JSONObject(), null);
        rejected("bound receipt cannot drop witness", envelope(receipt(CANONICAL, "completed")),
                prior, proof);
        rejected("raw equality cannot downgrade retained witness", envelope(receipt(RAW, "completed")),
                prior, proof);
        rejected("canonical cannot retarget", envelope(receipt("/other/canonical.jsonl", "completed"))
                .put("receiptBinding", binding(RAW, "/other/canonical.jsonl")), prior, proof);
        for (Object value : new Object[]{JSONObject.NULL, "binding", 1, true, new JSONObject(),
                binding(RAW, CANONICAL).put("version", 2), binding("/other/raw", CANONICAL),
                binding(RAW, "/other/canonical")}) {
            rejected("malformed retained proof blocks new witness " + value,
                    bound(receipt(CANONICAL, "completed")), prior, value);
            rejected("malformed retained proof blocks legacy fallback " + value,
                    envelope(receipt(RAW, "completed")), prior, value);
        }
        rejected("retained witness requires prior receipt", bound(receipt(CANONICAL, "completed")),
                null, proof);
        for (JSONObject value : new JSONObject[]{new JSONObject(),
                receipt(CANONICAL, "accepted").put("commandId", "other-command"),
                receipt(CANONICAL, "accepted").put("sessionPath", "/other/canonical"),
                receipt(CANONICAL, "saved"),
                receipt(CANONICAL, "accepted").put("createdAt", "1"),
                receipt(CANONICAL, "accepted").put("updatedAt", -1),
                receipt(CANONICAL, "accepted").put("error", JSONObject.NULL)}) {
            rejected("retained receipt must independently validate", bound(receipt(CANONICAL,
                    "completed")), value, proof);
        }
        rejected("incoming null cannot replace retained witness",
                bound(receipt(CANONICAL, "completed")).put("receiptBinding", JSONObject.NULL),
                prior, proof);
    }

    private static JSONObject receipt(String path, String state) {
        return new JSONObject().put("commandId", ID).put("sessionPath", path).put("state", state)
                .put("createdAt", 100).put("updatedAt", 200);
    }

    private static JSONObject envelope(Object receipt) {
        return new JSONObject().put("ok", true).put("receipt", receipt);
    }

    private static JSONObject bound(JSONObject receipt) {
        return envelope(receipt).put("receiptBinding", binding(RAW, CANONICAL));
    }

    private static JSONObject binding(String requested, String canonical) {
        return new JSONObject().put("version", 1).put("requestedSessionPath", requested)
                .put("canonicalSessionPath", canonical);
    }

    private static NativeReceiptValidator.Evidence accepted(String name, JSONObject response,
                                                            JSONObject prior, Object binding) {
        return accepted(name, response, ID, RAW, prior, binding);
    }

    private static NativeReceiptValidator.Evidence accepted(String name, JSONObject response,
                                                            String id, String raw,
                                                            JSONObject prior, Object binding) {
        try {
            NativeReceiptValidator.Evidence evidence = NativeReceiptValidator.validate(response, id,
                    raw, prior, binding);
            check(evidence != null, name);
            return evidence;
        } catch (IllegalStateException error) {
            throw new AssertionError("Unexpected rejection: " + name, error);
        }
    }

    private static void rejected(String name, JSONObject response, JSONObject prior, Object binding) {
        rejected(name, response, ID, RAW, prior, binding);
    }

    private static void rejected(String name, JSONObject response, String id, String raw,
                                 JSONObject prior, Object binding) {
        try {
            NativeReceiptValidator.validate(response, id, raw, prior, binding);
        } catch (IllegalStateException expected) {
            checks++;
            return;
        }
        throw new AssertionError("Unexpected acceptance: " + name);
    }

    private static void check(boolean condition, String name) {
        if (!condition) throw new AssertionError(name);
        checks++;
    }
}
