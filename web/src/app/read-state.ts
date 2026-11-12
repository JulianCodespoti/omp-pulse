import { useEffect, useSyncExternalStore } from "react";

import type { UiMessage } from "../domain/messages";
import type { OmpStoreApi } from "../runtime/omp-store";
import { markSeen, SEEN_ENTRY_LIMIT } from "./session-format";
import { useStoreValue } from "./store-hooks";

/**
 * Newest source entry ids in the transcript, oldest first, joined with "\n"
 * so a store selector can return a value React compares cheaply.
 */
export function shownEntryKey(messages: readonly UiMessage[]): string {
  const ids: string[] = [];
  for (let index = messages.length - 1; index >= 0 && ids.length < SEEN_ENTRY_LIMIT; index--) {
    const id = messages[index]?.sourceEntryId;
    if (id) ids.push(id);
  }
  return ids.reverse().join("\n");
}

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/**
 * INVARIANT: the open, visible chat owns its read state. Every way into a
 * chat (list row, notification or deep link, Recent, new chat, branch) ends
 * at the store's `sessionPath`, so this one owner marks what the user is
 * looking at whenever its listing revision or shown entries change. Marking
 * only on a list tap left a dot on every reply watched to the end, and never
 * cleared one for a chat opened from a notification. A chat in a hidden app
 * is not being read: marking resumes when it becomes visible.
 */
export function useOpenChatReadState(store: OmpStoreApi, open: boolean): void {
  const path = useStoreValue(store, (s) => s.sessionPath);
  const revision = useStoreValue(store, (s) =>
    s.sessionPath ? s.sessions.find((session) => session.path === s.sessionPath)?.revision : undefined);
  const shown = useStoreValue(store, (s) => shownEntryKey(s.messages));
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => true,
  );
  useEffect(() => {
    if (!open || !path || !visible) return;
    markSeen(path, revision, shown ? shown.split("\n") : []);
  }, [open, path, revision, shown, visible]);
}
