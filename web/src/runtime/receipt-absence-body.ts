const MAX_ABSENCE_BODY_BYTES = 65_536;
const MAX_ABSENCE_BODY_CHUNKS = 1_024;
const typedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag,
)?.get;

// A 404 is absence only after its original fetch stream reaches EOF. Discard
// bytes without decoding or retaining a body, and keep request.ts's deadline.
export async function consumeReceiptAbsenceBody(response: Response): Promise<void> {
  const body = response.body;
  if (response.bodyUsed || body?.locked) {
    throw new Error("Receipt absence body is unavailable");
  }
  if (body === null) return;

  const reader = body.getReader();
  let bytes = 0;
  let chunks = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (++chunks > MAX_ABSENCE_BODY_CHUNKS) {
        throw new Error("Receipt absence body exceeds the read limit");
      }
      // The intrinsic brand accepts real cross-realm bytes without accepting a
      // non-byte view or an object that only spoofs Symbol.toStringTag.
      if (!ArrayBuffer.isView(value) || typedArrayTag?.call(value) !== "Uint8Array") {
        throw new Error("Receipt absence body contains a non-byte chunk");
      }
      if (value.byteLength > MAX_ABSENCE_BODY_BYTES - bytes) {
        throw new Error("Receipt absence body exceeds the byte limit");
      }
      bytes += value.byteLength;
    }
  } catch (error) {
    // Cleanup cannot turn a failed read into absence or hang its rejection.
    try { void reader.cancel().catch(() => {}); } catch { /* Preserve the read failure. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
