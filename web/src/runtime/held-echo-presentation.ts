import type { UiMessage } from "../domain/messages";
import type { QueuedPrompt } from "./offline-queue";
import { turnOutcome } from "./receipt-outcome";
import type { QueuedMessages } from "./omp-store";

/**
 * Hide the optimistic `local:` echo of a message omp is still holding.
 *
 * A message sent while the agent works goes to omp as a follow-up, and omp
 * holds it in its queue until the turn ends. QueuedMessagesBar shows it there
 * as a chip with Send now / Remove. The echo painted at send time stayed in the
 * transcript too, and once the receipt was accepted its status line cleared,
 * so one message read as both sent (a plain bubble) and unsent (a chip offering
 * to send it). While omp's own queue report holds the text, the chip is the
 * message; when omp delivers it the chip leaves and the transcript entry
 * replaces the echo, so the bubble appears exactly once.
 *
 * Echoes pair one-to-one, oldest first, with held occurrences of the same
 * trimmed text: an identical earlier message omp already delivered keeps its
 * bubble. The live-steered steering prefix omp reports is already with the
 * model, not held. A failed send never reached omp, so its echo (and Retry)
 * stays even when an identical message is queued. Read-only render projection;
 * the store keeps the echo, so delivery still reconciles it as before.
 */
export function hideHeldEchoes(
  messages: UiMessage[],
  queued: QueuedMessages,
  outbox: readonly QueuedPrompt[],
): UiMessage[] {
  const steering = queued.liveSteered ? queued.steering.slice(queued.liveSteered) : queued.steering;
  if (steering.length === 0 && queued.followUp.length === 0) return messages;
  const held = new Map<string, number>();
  for (const text of [...steering, ...queued.followUp]) {
    const key = text.trim();
    if (key) held.set(key, (held.get(key) ?? 0) + 1);
  }
  if (held.size === 0) return messages;
  let failed: Set<string> | null = null;
  let filtered: UiMessage[] | null = null;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const key = message.role === "user" && !message.sourceEntryId && message.id.startsWith("local:")
      ? message.text.trim() : "";
    const left = key ? held.get(key) ?? 0 : 0;
    if (left > 0) {
      failed ??= new Set(outbox.filter(entry => entry.state === "failed" && !turnOutcome(entry)).map(entry => entry.commandId));
      if (!failed.has(message.id.slice(6))) {
        held.set(key, left - 1);
        filtered ??= messages.slice(0, index);
        continue;
      }
    }
    filtered?.push(message);
  }
  return filtered ?? messages;
}
