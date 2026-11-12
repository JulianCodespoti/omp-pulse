import type { UiMessage } from "@/domain/messages";
import type { OmpStore } from "@/runtime/omp-store";

/** One mounted status line owns one immutable transcript snapshot/result. */
export function createLastUserMessageAtSelector(): (state: OmpStore) => number | null {
  let previous: readonly UiMessage[] | undefined;
  let timestamp: number | null = null;
  return (state) => {
    // History actions replace this array. Streaming-only notifications do not,
    // so a long tool-heavy turn need not rescan finished rows for every token.
    if (state.messages === previous) return timestamp;
    previous = state.messages;
    timestamp = null;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const message = state.messages[i];
      if (message.role !== "user") continue;
      const ms = message.createdAt?.getTime();
      timestamp = ms !== undefined && Number.isFinite(ms) ? ms : null;
      break;
    }
    return timestamp;
  };
}
