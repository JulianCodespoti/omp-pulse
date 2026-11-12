/** Quiet this long and a live turn says so; omp turns run far longer than a chat reply, so ChatGPT's 5-24s ladder would nag. */
export const STALL_NOTICE_MS = 40_000;
/** Past this, the line stops apologising and rotates through reassurances. */
export const STALL_ROTATE_FROM_MS = 80_000;
export const STALL_ROTATE_EVERY_MS = 7_000;

const REASSURANCES = ["Still working on it", "Feel free to check back in a moment"] as const;

/**
 * What the live footer says once nothing (token, tool event, step change) has
 * arrived for `idleMs`; null while the turn is still recent. Pure, so the
 * ladder is testable without a clock.
 */
export function stallNotice(idleMs: number): string | null {
  if (!(idleMs >= STALL_NOTICE_MS)) return null;
  if (idleMs < STALL_ROTATE_FROM_MS) return "Taking longer than usual";
  return REASSURANCES[Math.floor((idleMs - STALL_ROTATE_FROM_MS) / STALL_ROTATE_EVERY_MS) % REASSURANCES.length]!;
}
