/**
 * The chat screen's code-split chunk, and the ability to fetch it early.
 *
 * WHY THIS IS ITS OWN MODULE: both `App` (which owns the lazy boundary) and
 * `NewSessionScreen` (which preloads while the user sits on home) need it,
 * so keeping it standalone avoids import cycles across screen modules.
 *
 * WHY PRELOADING AT ALL: the chat screen carries the markdown renderer, the
 * syntax highlighter and the transcript machinery, so splitting it keeps the
 * first paint of the sessions list cheap. But that moved the cost onto the tap.
 * Measured at 4x CPU throttle, tapping a session left the user on a dead screen
 * for 775ms before the chat mounted, and once mounted all 40 messages painted
 * in the SAME frame while the history request behind it had resolved in 5ms.
 * Practically the whole delay was fetching, parsing and evaluating this chunk,
 * with the data sitting ready the entire time.
 *
 * The sessions list is idle while the user reads it, which is when this should
 * be paid for.
 */

import type * as ChatScreenModule from "./ChatScreen";

let chatScreen: Promise<typeof ChatScreenModule> | null = null;

export function importChatScreen() {
  // Share successful/in-flight preloads with navigation; do not keep our own
  // rejected promise on top of the browser's module-map failure.
  return chatScreen ??= import("./ChatScreen").catch((error: unknown) => {
    chatScreen = null;
    throw error;
  });
}

let started: Promise<unknown> | null = null;

/**
 * Fetch the chat chunk now, at most once, and then its rich markdown layer
 * (Streamdown, ~440 KB, otherwise loaded only after the first chat has
 * already painted every reply as plain text and then re-rendered it).
 *
 * Safe to call repeatedly and from several places: the module system memoises
 * the import, and this guard avoids even constructing the promise again.
 * Failure clears our latch; browsers that retain the failed ESM download use
 * the screen boundary's draft-safe document reload rather than a blind retry.
 */
export function preloadChat(): void {
  if (started) return;
  started = importChatScreen()
    .then((chat) => chat.preloadMarkdown())
    .catch(() => {
      started = null;
    });
}
