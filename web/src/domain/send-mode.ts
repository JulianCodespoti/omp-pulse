/**
 * How a message joins a turn that is already running. omp's TUI steers on
 * Enter while the agent works (the message lands at the next step) and offers
 * follow-up as the alternative (held until the turn ends); pulse used to
 * hard-code follow-up. `interrupt` stops the turn and starts a new one.
 * Framework-free: the composer and the outbox both depend on these rules.
 */
export type PromptDelivery = "steer" | "queue" | "interrupt";

/** The persisted composer choice. Interrupt is a one-off gesture, never sticky. */
export type SendMode = "steer" | "queue";

/** TUI parity: Enter steers. */
export const DEFAULT_SEND_MODE: SendMode = "steer";

export function parseSendMode(value: unknown): SendMode {
  return value === "queue" ? "queue" : DEFAULT_SEND_MODE;
}

export function isPromptDelivery(value: unknown): value is PromptDelivery {
  return value === "steer" || value === "queue" || value === "interrupt";
}

/**
 * `false` only when the daemon REPORTED the session cannot (collab host always
 * steers; the desktop bridge has no abort-and-prompt). Unreported (`null`)
 * keeps the option: the daemon falls back to queue for a mode it cannot
 * express, so offering it never loses a message.
 */
export interface SendModeContext {
  running: boolean;
  hasContent: boolean;
  canQueue: boolean | null;
  canInterrupt: boolean | null;
}

/**
 * Steer | Queue appears when there is a running turn to join, queueing is
 * possible, and the field is focused or has content: it arrives with the
 * keyboard rather than on the first keystroke under the thumb.
 */
export function sendModeChoiceVisible(context: SendModeContext & { focused: boolean }): boolean {
  return context.running && (context.hasContent || context.focused) && context.canQueue !== false;
}

/**
 * Why Send is greyed out, or null when it is allowed. `foreign` is a terminal
 * on the computer that holds the session file.
 */
export function sendBlockedReason(sendAllowed: boolean, ownerKind: string | undefined): string | null {
  if (sendAllowed) return null;
  return ownerKind === "foreign"
    ? "This chat is open on your computer. Run /collab there to send from here."
    : "Sending isn’t available for this chat right now.";
}

/** Long-press Send offers "Stop and send" only where it can actually abort. */
export function stopAndSendAvailable(context: SendModeContext): boolean {
  return context.running && context.hasContent && context.canInterrupt !== false;
}

/**
 * The delivery a send carries. Idle sends carry none: the mode means nothing
 * without a running turn, and a durable replay that finds the agent busy
 * later should not inherit a choice made for a turn that already ended.
 */
export function deliveryForSend(
  running: boolean,
  mode: SendMode,
  canQueue: boolean | null,
): PromptDelivery | undefined {
  if (!running) return undefined;
  // Hidden choice = the session cannot queue; say what will actually happen.
  return canQueue === false ? "steer" : mode;
}
