import type { UiMessage } from "./messages";

/**
 * True while the agent's `ask` tool is still waiting on this turn.
 *
 * Since omp 18.18.3 `ask` walks its HTML form field by field, and cancelling
 * any one field aborts the whole turn and discards every earlier answer. The
 * dialogs use this to call their dismiss control "Stop turn" (honest, and
 * confirmed) instead of "Skip question", which now reads as harmless but isn't.
 */
export function askToolRunning(messages: readonly UiMessage[], streaming: UiMessage | null = null): boolean {
  // A call is a part of the still-streaming message until omp ends that
  // message; only then is it merged into `messages`. Checking `messages`
  // alone missed an ask whose message had not been committed yet.
  for (let i = messages.length; i >= 0; i--) {
    const message = i === messages.length ? streaming : messages[i];
    if (!message) continue;
    if (message.role === "user") return false;
    if (message.parts.some((part) => part.kind === "tool" && part.name === "ask" && part.state === "running")) return true;
  }
  return false;
}
