import { readBrowserPreference, writeBrowserPreference } from "./browser-storage";

const KEY = "omp-pulse:notification-nudge";

/** How long a turn must run before the ask is worth interrupting for. */
export const NUDGE_AFTER_TURN_MS = 20_000;
/** After a "Not now" the ask stays quiet this long. */
export const NUDGE_QUIET_MS = 14 * 24 * 60 * 60 * 1000;
/** The ask never returns after this many declines. */
export const NUDGE_MAX_DECLINES = 2;

/** What the user has said no to: how many times, and when last (epoch ms). */
export type NudgeDeclines = { count: number; lastAt: number };

export const NO_DECLINES: NudgeDeclines = { count: 0, lastAt: 0 };

export type NudgeInput = {
  /** Notifications can be turned on from here (shell permission still askable or switched off; browser push supported and undecided). */
  available: boolean;
  /** Already delivering to this device. */
  on: boolean;
  /** The system or browser refuses; only its settings can change that, so Settings owns it. */
  blocked: boolean;
  /** How long the open chat's turn has been running. */
  runningMs: number;
  declines: NudgeDeclines;
  now: number;
};

/**
 * Whether to offer notifications now. The permission prompt was only ever
 * reachable inside Settings › Notifications, so most people never saw it; this
 * asks once a long turn makes a notification useful, and stops when declined.
 */
export function shouldShowNotificationNudge({ available, on, blocked, runningMs, declines, now }: NudgeInput): boolean {
  if (!available || on || blocked) return false;
  if (runningMs < NUDGE_AFTER_TURN_MS) return false;
  if (declines.count >= NUDGE_MAX_DECLINES) return false;
  // A clock set back leaves lastAt in the future; that must not silence the ask for good.
  if (declines.count > 0 && now >= declines.lastAt && now - declines.lastAt < NUDGE_QUIET_MS) return false;
  return true;
}

export function readNudgeDeclines(): NudgeDeclines {
  try {
    const parsed: unknown = JSON.parse(readBrowserPreference(KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return NO_DECLINES;
    const { count, lastAt } = parsed as Record<string, unknown>;
    if (typeof count !== "number" || typeof lastAt !== "number" || !Number.isFinite(count) || !Number.isFinite(lastAt) || count < 0) {
      return NO_DECLINES;
    }
    return { count: Math.floor(count), lastAt };
  } catch {
    return NO_DECLINES;
  }
}

/** Records a decline and returns the new record; a storage failure only costs the memory of it. */
export function recordNudgeDecline(now: number): NudgeDeclines {
  const next = { count: readNudgeDeclines().count + 1, lastAt: now };
  writeBrowserPreference(KEY, JSON.stringify(next));
  return next;
}
