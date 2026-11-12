/**
 * Context fill and session spend for the always-visible meters (chat header,
 * session rows). Framework-free so the store selectors, the header and the
 * list share one definition of "how full" and "how much".
 */
import type { UiMessage } from "./messages";

/** Percent of `window` that `tokens` fills (one decimal), or undefined when either is unknown. */
export function contextPercent(tokens: number | undefined, window: number | undefined): number | undefined {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return undefined;
  return Math.min(100, Math.round((tokens / window) * 1000) / 10);
}

/**
 * Short spend label: `<$0.01`, `$1.24`, `$128`. Null when there is nothing
 * worth showing (unknown, zero, or nonsense), so callers hide the slot rather
 * than print `$0.00` on every subscription-billed session.
 */
export function formatCost(usd: number | undefined | null): string | null {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.01) return "<$0.01";
  // Round before choosing the format so $99.996 reads $100, not $100.00.
  const cents = Math.round(usd * 100) / 100;
  return cents < 100 ? `$${cents.toFixed(2)}` : `$${Math.round(usd).toLocaleString("en-US")}`;
}

/**
 * Whole-session cost: the daemon's file total plus assistant turns the phone
 * holds that the total does not include yet.
 *
 * `through` is the newest assistant entry the daemon folded. Turns after it in
 * `messages` are newer than the total, so they are added; a turn at or before
 * it is already counted. Absent, the file held no assistant turn, so every
 * held turn is newer. Not loaded (the reader's view no longer reaches it, or a
 * live copy has a different id), nothing is added: the next listing refresh
 * catches up, and undercounting for a second beats double counting.
 */
export function sessionCost(
  base: number | undefined,
  through: string | undefined,
  messages: readonly UiMessage[],
): number | undefined {
  if (typeof base !== "number" || !Number.isFinite(base) || base < 0) return undefined;
  let extra = 0;
  // Backwards: the anchor is almost always among the last few messages, so
  // this stays cheap on every streaming store update.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (through !== undefined && message.id === through) return base + extra;
    if (message.role !== "assistant") continue;
    const cost = message.usage?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) extra += cost;
  }
  return through === undefined ? base + extra : base;
}
