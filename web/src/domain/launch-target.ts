/** A chat as the launch decision sees it. */
export interface LaunchChat {
  path: string;
  /** Epoch ms of its last real activity; 0 when unknown. */
  activeAt: number;
  /** A turn is in progress. */
  running: boolean;
  /** A question or approval is waiting on the user. */
  needsYou: boolean;
}

/** A chat idle longer than this is history, not the thing the user is in the middle of. */
export const FRESH_CHAT_MS = 30 * 60_000;

/**
 * Where a cold start lands: the most recent chat when the user is plausibly
 * still in it (active in the last 30 minutes, mid-turn, or waiting on them),
 * otherwise null, which means the new-chat home. Only the single most recent
 * chat is considered: an older chat that is running is reachable from the
 * drawer, and opening it would hide the one the user used last.
 */
export function launchTarget(chats: readonly LaunchChat[], now: number): string | null {
  let latest: LaunchChat | null = null;
  for (const chat of chats) if (!latest || chat.activeAt > latest.activeAt) latest = chat;
  if (!latest) return null;
  return latest.running || latest.needsYou || now - latest.activeAt <= FRESH_CHAT_MS ? latest.path : null;
}
