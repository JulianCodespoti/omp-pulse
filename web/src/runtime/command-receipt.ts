import type { CommandReceipt, ReceiptBinding, ReceiptIntent, ReceiptResponse } from "./api-types";

/** A response after handoff cannot establish failure or authorize replay. */
export class ReceiptValidationError extends Error {
  override name = "ReceiptValidationError";
  constructor() {
    super("Command receipt did not match the requested identity or supported state");
  }
}

const SERVER_STATES = new Set([
  "accepted", "dispatching", "forwarded", "received", "running",
  "completed", "failed", "uncertain",
]);

function validTimestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) &&
    Number.isInteger(value) && value >= 0;
}

/** Validate correlation before any caller applies a server delivery state. */
export function validateCommandReceipt(
  value: unknown,
  expectedCommandId?: string,
): CommandReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ReceiptValidationError();
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.commandId !== "string" || receipt.commandId.length === 0 ||
    typeof receipt.sessionPath !== "string" || receipt.sessionPath.length === 0 ||
    (expectedCommandId !== undefined && receipt.commandId !== expectedCommandId) ||
    typeof receipt.state !== "string" || !SERVER_STATES.has(receipt.state) ||
    !validTimestamp(receipt.createdAt) || !validTimestamp(receipt.updatedAt) ||
    (receipt.code !== undefined && typeof receipt.code !== "string") ||
    (receipt.error !== undefined && typeof receipt.error !== "string")
  ) throw new ReceiptValidationError();
  return value as CommandReceipt;
}

export const RECEIPT_BINDING_CAPABILITY = "receipt-session-binding-v1";

function validateBinding(value: unknown, receipt: CommandReceipt, sessionPath: string): ReceiptBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ReceiptValidationError();
  const binding = value as Record<string, unknown>;
  if (binding.version !== 1 || binding.requestedSessionPath !== sessionPath ||
    typeof binding.canonicalSessionPath !== "string" || !binding.canonicalSessionPath ||
    binding.canonicalSessionPath !== receipt.sessionPath) throw new ReceiptValidationError();
  return value as ReceiptBinding;
}

/** A receipt alone (including local uncertainty) never establishes a witness. */
export function retainedReceiptBinding(intent: ReceiptIntent): ReceiptBinding | undefined {
  if (!intent || typeof intent.commandId !== "string" || !intent.commandId ||
    typeof intent.sessionPath !== "string" || !intent.sessionPath) throw new ReceiptValidationError();
  if (intent.receiptBinding === undefined || intent.receiptBinding === null) return undefined;
  return validateBinding(intent.receiptBinding,
    validateCommandReceipt(intent.receipt, intent.commandId), intent.sessionPath);
}

/** Validate the server's request-resolution witness before unwrapping a receipt. */
export function validateBoundReceiptResponse(value: unknown, intent: ReceiptIntent): ReceiptResponse {
  if (!intent.commandId || !intent.sessionPath || value === null ||
    typeof value !== "object" || Array.isArray(value)) throw new ReceiptValidationError();
  const response = value as Record<string, unknown>;
  if (response.ok !== true) throw new ReceiptValidationError();
  const receipt = validateCommandReceipt(response.receipt, intent.commandId);
  const binding = validateBinding(response.receiptBinding, receipt, intent.sessionPath);
  const prior = retainedReceiptBinding(intent);
  if (prior && prior.canonicalSessionPath !== binding.canonicalSessionPath)
    throw new ReceiptValidationError();
  return value as ReceiptResponse;
}
