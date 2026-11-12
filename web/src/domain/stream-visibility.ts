import { isRecoveredResponse } from "./response-item-provenance";
import type { UiMessage } from "./messages";
import { getRawAssistantText } from "./message-provenance";

// useSyncExternalStore selectors must return the same object for the same
// snapshots. Both keys are weak: old stream/history snapshots can be collected.
const projections = new WeakMap<UiMessage, WeakMap<readonly UiMessage[], UiMessage>>();

/** History may deliver the same response before its stream-end event. */
export function visibleStreamingMessage(
  messages: readonly UiMessage[],
  streaming: UiMessage | null,
): UiMessage | null {
  if (!streaming) return null;
  const cached = projections.get(streaming)?.get(messages);
  if (cached) return cached;
  const stableId = !!streaming.id && !/^entry:\d+$/.test(streaming.id);
  const persisted = messages.find((message) => {
    if (isRecoveredResponse(message, streaming)) return true;
    if (message.role !== "assistant" || !(
      (stableId && message.id === streaming.id) ||
      (!!message.responseKey && message.responseKey === streaming.responseKey)
    )) return false;
    // Revised/longer text remains visible. Never match independent responses
    // by prose alone: a model may legitimately repeat itself after a tool call.
    const historySource = getRawAssistantText(message);
    const liveSource = getRawAssistantText(streaming);
    return historySource !== null && liveSource !== null
      ? historySource.startsWith(liveSource)
      : message.text.startsWith(streaming.text);
  });
  if (!persisted) return streaming;

  const covered = new Set(persisted.parts.filter((part) => part.kind !== "text").map((part) => JSON.stringify(part)));
  const parts = streaming.parts.filter((part) => part.kind !== "text" && !covered.has(JSON.stringify(part)));
  const freshError = !!streaming.errorMessage && streaming.errorMessage !== persisted.errorMessage;
  if (parts.length === 0 && !freshError) return null;

  // Fresh tool/thinking/image/error details do not make the already-rendered
  // prose new again. Project only those details; do not alter transport state.
  let byHistory = projections.get(streaming);
  const visible = { ...streaming, text: "", parts, errorMessage: freshError ? streaming.errorMessage : undefined };
  if (!byHistory) { byHistory = new WeakMap(); projections.set(streaming, byHistory); }
  byHistory.set(messages, visible);
  return visible;
}
