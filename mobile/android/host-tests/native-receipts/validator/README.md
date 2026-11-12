# Native receipt validator focused tests

These tests compile the exact production `NativeReceiptValidator.java` using the installed
JDK compiler module. They do not copy or reimplement the validation algorithm.

From the repository root:

```sh
classes=$(mktemp -d)
trap 'rm -rf "$classes"' EXIT
java com.sun.tools.javac.Main -Xlint:all -Werror -d "$classes" \
  mobile/android/app/src/main/java/com/omppulse/app/NativeReceiptValidator.java \
  mobile/android/host-tests/native-receipts/validator/org/json/JSONObject.java \
  mobile/android/host-tests/native-receipts/validator/com/omppulse/app/NativeReceiptValidatorTest.java
java -cp "$classes" com.omppulse.app.NativeReceiptValidatorTest
```

The JSON boundary is deliberately synthetic: a minimal object fixture supplies `opt`, `has`,
`put`, and `remove` with typed values. It is not a parser and does not establish Android
`org.json` parser fidelity, numeric parsing behavior, SQLite persistence, native scheduling,
HTTP transport, endpoint handling, device acceptance, or deployed correctness. Some malformed
numeric objects are injected directly even though a JSON parser would reject them earlier.

Coverage includes all eight server states, exact-path legacy acceptance, alias witnesses,
strict envelope/field types, optional fields, absent versus present-null network proof,
retained proof continuity and downgrade prevention, malformed retained evidence, legacy
proof acquisition, equal timestamps, and backwards server-clock changes. Receipt freshness
and terminal preservation remain responsibilities of the transaction caller, tested separately.

Browser-import `receiptBinding: null` is converted to Java/SQL absence outside this helper.
This helper intentionally rejects `JSONObject.NULL` when supplied as retained proof.
