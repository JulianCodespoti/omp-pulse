package com.omppulse.app;

import org.json.JSONObject;

import java.math.BigDecimal;

/** Pure validation of server receipt identity and its optional canonical-path witness. */
final class NativeReceiptValidator {
    private NativeReceiptValidator() {}

    static final class Evidence {
        final JSONObject receipt;
        // Java null denotes genuinely absent legacy proof; JSONObject.NULL is never valid proof.
        final JSONObject binding;

        private Evidence(JSONObject receipt, JSONObject binding) {
            this.receipt = receipt;
            this.binding = binding;
        }
    }

    /**
     * Validate the entire envelope before returning evidence for atomic persistence.
     * A browser-imported optional null must be converted to absence by the import boundary.
     */
    static Evidence validate(JSONObject response, String commandId, String rawSessionPath,
                             JSONObject priorReceipt, Object priorBinding) {
        require(commandId != null && !commandId.isEmpty(), "Missing command identity");
        require(rawSessionPath != null && !rawSessionPath.isEmpty(), "Missing requested session path");
        require(response != null && Boolean.TRUE.equals(response.opt("ok")),
                "Invalid command receipt envelope");
        Object value = response.opt("receipt");
        require(value instanceof JSONObject, "Missing command receipt");
        JSONObject receipt = (JSONObject) value;
        validateReceipt(receipt, commandId);

        JSONObject retainedBinding = null;
        if (priorBinding != null) {
            // Retained data is evidence only after independent validation against its own receipt.
            validateReceipt(priorReceipt, commandId);
            retainedBinding = validateBinding(priorBinding, rawSessionPath, priorReceipt);
        }

        JSONObject binding = null;
        if (response.has("receiptBinding")) {
            // Present-null and malformed proof must never fall back to exact-path compatibility.
            binding = validateBinding(response.opt("receiptBinding"), rawSessionPath, receipt);
            require(retainedBinding == null || retainedBinding.opt("canonicalSessionPath")
                    .equals(binding.opt("canonicalSessionPath")), "Receipt canonical path changed");
        } else {
            require(retainedBinding == null, "Receipt binding cannot be discarded");
            require(rawSessionPath.equals(receipt.opt("sessionPath")),
                    "Unbound receipt session path differs from request");
        }
        return new Evidence(receipt, binding);
    }

    private static void validateReceipt(JSONObject receipt, String commandId) {
        require(receipt != null, "Missing retained command receipt");
        require(commandId.equals(receipt.opt("commandId")), "Receipt command identity differs");
        require(nonemptyString(receipt.opt("sessionPath")), "Invalid receipt session path");
        Object state = receipt.opt("state");
        require(state instanceof String && supportedState((String) state), "Invalid receipt state");
        require(nonnegativeInteger(receipt.opt("createdAt")) &&
                nonnegativeInteger(receipt.opt("updatedAt")), "Invalid receipt timestamps");
        require(!receipt.has("code") || receipt.opt("code") instanceof String,
                "Invalid receipt code");
        require(!receipt.has("error") || receipt.opt("error") instanceof String,
                "Invalid receipt error");
        // Server wall clocks can roll back and multiple states can share a millisecond.
        // Freshness and terminal preservation are the caller's local transaction responsibility.
    }

    private static JSONObject validateBinding(Object value, String rawSessionPath, JSONObject receipt) {
        require(value instanceof JSONObject, "Invalid receipt binding");
        JSONObject binding = (JSONObject) value;
        BigDecimal version = numeric(binding.opt("version"));
        require(version != null && version.compareTo(BigDecimal.ONE) == 0,
                "Unsupported receipt binding version");
        require(rawSessionPath.equals(binding.opt("requestedSessionPath")),
                "Receipt binding requested path differs");
        Object canonical = binding.opt("canonicalSessionPath");
        require(nonemptyString(canonical) && canonical.equals(receipt.opt("sessionPath")),
                "Receipt binding canonical path differs");
        return binding;
    }

    private static boolean supportedState(String state) {
        switch (state) {
            case "accepted":
            case "dispatching":
            case "forwarded":
            case "received":
            case "running":
            case "completed":
            case "failed":
            case "uncertain":
                return true;
            default:
                return false;
        }
    }

    private static boolean nonemptyString(Object value) {
        return value instanceof String && !((String) value).isEmpty();
    }

    private static boolean nonnegativeInteger(Object value) {
        BigDecimal number = numeric(value);
        return number != null && number.signum() >= 0 && number.stripTrailingZeros().scale() <= 0;
    }

    private static BigDecimal numeric(Object value) {
        if (!(value instanceof Number)) return null;
        try {
            // Decimal comparison rejects strings, NaN/infinity, fractional values and rounding
            // shortcuts, without imposing a new client-side maximum on server integers.
            return new BigDecimal(value.toString());
        } catch (NumberFormatException error) {
            return null;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
