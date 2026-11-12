import type { UiMessage } from "./messages";

/** The standalone transcript renderer owns actions for persisted prose replies. */
export function hasReplyActions(message: Pick<UiMessage, "role" | "text">): boolean {
  return message.role === "assistant" && message.text.trim().length > 0;
}
