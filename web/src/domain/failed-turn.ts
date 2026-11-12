/**
 * Which failed turn may be retried, as a pure rule over the transcript.
 *
 * Only the newest assistant reply qualifies, and only when it ended in an
 * error a re-send may get past (`classifyTurnError(...).retryable`): a turn
 * the user stopped is a choice, a restart has its own Continue, a refusal or
 * usage limit needs another model, and an attempt omp's auto-retry already
 * replaced is omp's to handle. An older error was already followed by
 * something newer. Retrying re-sends the user message that started the turn
 * (see `OmpSessionController.retryFailedTurn` for why that, not omp's `/retry`).
 */
import type { UiMessage } from "./messages";
import { classifyTurnError } from "./turn-errors";

const STOPPED_BY_USER = /\b(?:interrupted|stopped|aborted|cancelled|canceled) by user\b/;

/** A turn the user ended (Stop, Esc on the desktop). Shared with the error label.
 *  A daemon restart also ends the turn as `aborted`, but nobody chose it: it
 *  keeps its "Interrupted by a restart" notice (classifyTurnError). */
export function turnStoppedByUser(message: UiMessage): boolean {
  const raw = message.errorMessage ?? "";
  if (/previous omp process exited/i.test(raw)) return false;
  return message.stopReason === "aborted" || STOPPED_BY_USER.test(raw.toLowerCase());
}

export interface FailedTurn {
  /** The assistant message that failed; only its row offers Retry. */
  failedId: string;
  /** The user message whose text and images are sent again. */
  prompt: UiMessage;
}

export function failedTurnToRetry(messages: readonly UiMessage[]): FailedTurn | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    // A user message after the failure (sent, queued or echoed locally)
    // means the conversation moved on; retrying would answer out of order.
    if (message.role === "user") return null;
    if (message.role !== "assistant") continue;
    if (!message.errorMessage || message.retry || !classifyTurnError(message)?.retryable) return null;
    for (let j = i - 1; j >= 0; j--) {
      const prompt = messages[j];
      if (prompt.role !== "user") continue;
      const hasImages = prompt.parts.some((part) => part.kind === "image") || (prompt.localAttachmentCount ?? 0) > 0;
      return prompt.text.trim() || hasImages ? { failedId: message.id, prompt } : null;
    }
    return null;
  }
  return null;
}
