import { isRefusalText } from "../domain/turn-errors";
import type { CommandReceipt, CommandReceiptState } from "./api-types";

/**
 * How a turn the agent RECEIVED ended. None of these is a delivery failure:
 * the prompt is in the transcript, so its bubble needs no "Failed" line.
 *
 * The daemon settles them as `completed` with one of these codes; receipts
 * written before that settled the same outcomes as `failed`, and both read the
 * same here. `failed` without one of these codes still means the prompt never
 * reached the agent.
 */
export type TurnOutcome = "stopped" | "errored" | "refused" | "interrupted";

const TURN_CODES: Readonly<Record<string, TurnOutcome>> = {
  agent_aborted: "stopped",
  agent_failed: "errored",
  agent_refused: "refused",
  agent_interrupted: "interrupted",
};

/** An outbox entry (its receipt nested) or a server receipt itself. */
export interface ReceiptEvidence {
  state: CommandReceiptState;
  code?: string;
  receipt?: Pick<CommandReceipt, "code" | "error">;
  error?: string;
}

export function turnOutcome(entry: ReceiptEvidence): TurnOutcome | null {
  if (entry.state !== "completed" && entry.state !== "failed") return null;
  // Native rows store the bare code as the error when the receipt had no text,
  // and older daemons prefixed the error with it.
  const code = entry.receipt?.code || entry.code || entry.error?.match(/^([a-z][a-z0-9_]*)(?::|$)/)?.[1];
  const outcome = code ? TURN_CODES[code] : undefined;
  if (!outcome) return null;
  if (outcome === "errored" && isRefusalText(entry.receipt?.error ?? entry.error)) return "refused";
  return outcome;
}

/** The send never reached the agent: the one case worded as "Failed". */
export function deliveryFailed(entry: ReceiptEvidence): boolean {
  return entry.state === "failed" && turnOutcome(entry) === null;
}
