import type { RecoveryAction } from "./ui/error-recovery";

// Pure policy for the toast stack, kept apart from Notices.tsx so it can be
// unit-tested without a DOM. No runtime imports: tests load this file as-is.
//
// Bugs it replaces (audit M6): a single slot meant "Conversation deleted ·
// Undo" was wiped by any later toast ("Copied", a reply-ready toast) while the
// delete still fired, and two replies finishing together produced one toast.

export type ToastTone = "info" | "success" | "warn" | "error";

export type Toast = {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
  /** First line (the conversation's name on a reply-ready toast); `message` is then secondary. */
  readonly title?: string;
  /** Toasts sharing a group update one another in place instead of stacking. */
  readonly group?: string;
  /** An undo toast's deadline is real: the delete fires on its own timer. */
  readonly kind?: "undo";
  readonly action?: RecoveryAction;
  /** Countdown in ms; `null` stays until dismissed (an actionable toast without an explicit window). */
  readonly durationMs: number | null;
  /** Bumped when a later toast coalesces into this one: restarts the countdown and plays the bump. */
  readonly revision: number;
  /** `performance.now()` at admission or the last coalesce; the undo progress line drains from here. */
  readonly startedAt: number;
};

export type ToastInput = Omit<Toast, "id" | "revision" | "startedAt">;

export const MAX_VISIBLE_TOASTS = 2;

// A toast is read, not glanced at: a fixed 2.2 s cut a long sentence off
// mid-read, so the time grows with the text (40 ms per character past 60).
export function toastDurationMs(message: string, tone: ToastTone): number {
  const base = tone === "error" ? 4000 : 2200;
  return Math.min(8000, base + 40 * Math.max(0, message.length - 60));
}

// A routine info/success (a "Copied") must not wipe an error the user has not
// finished reading; a warn/error, or anything with an action, still can.
function isRoutine(t: ToastInput): boolean {
  return !t.action && t.kind !== "undo" && (t.tone === "info" || t.tone === "success");
}

function isPlainError(t: ToastInput): boolean {
  return t.tone === "error" && !t.action;
}

// An undo toast only coalesces with another undo toast of the same explicit
// group: two deletions both say "Conversation deleted", and merging them would
// drop the first one's Undo while its delete still fires.
function sameToast(existing: Toast, incoming: ToastInput): boolean {
  if (existing.kind === "undo" || incoming.kind === "undo") {
    return existing.kind === incoming.kind && incoming.group !== undefined && existing.group === incoming.group;
  }
  if (isRoutine(incoming) && isPlainError(existing)) return false;
  return (incoming.group !== undefined && existing.group === incoming.group)
    || (existing.message === incoming.message && existing.tone === incoming.tone);
}

// Who a newcomer may replace when the stack is full, oldest first: a toast
// without an action, then one that is not an undo, then (only for a newcomer
// with an action) the older undo. An undo is never replaced by a toast
// without an action, and a routine toast never replaces an unread plain error.
function pickVictim(stack: readonly Toast[], incoming: ToastInput): Toast | undefined {
  const routine = isRoutine(incoming);
  const eligible = stack.filter(t => (incoming.action !== undefined || t.kind !== "undo") && !(routine && isPlainError(t)));
  return eligible.find(t => !t.action && t.kind !== "undo")
    ?? eligible.find(t => t.kind !== "undo")
    ?? eligible[0];
}

/**
 * Add a toast. Oldest first: the array order is the on-screen order, the
 * newer toast below the older. Returns the same array when the newcomer is
 * dropped (it may displace nothing).
 */
export function admit(stack: readonly Toast[], incoming: ToastInput, now: number, id: number): readonly Toast[] {
  const same = stack.findIndex(t => sameToast(t, incoming));
  if (same >= 0) {
    const next = stack.slice();
    next[same] = { ...incoming, id: stack[same].id, revision: stack[same].revision + 1, startedAt: now };
    return next;
  }
  const toast: Toast = { ...incoming, id, revision: 0, startedAt: now };
  if (stack.length < MAX_VISIBLE_TOASTS) return [...stack, toast];
  const victim = pickVictim(stack, incoming);
  return victim ? [...stack.filter(t => t !== victim), toast] : stack;
}

export function expire(stack: readonly Toast[], id: number): readonly Toast[] {
  return stack.some(t => t.id === id) ? stack.filter(t => t.id !== id) : stack;
}

/**
 * A hidden page drops its undo toasts: their countdown never pauses (the
 * delete fires on its own timer), so one left behind would show an Undo that
 * had already lapsed when the page came back.
 */
export function dropUndo(stack: readonly Toast[]): readonly Toast[] {
  return stack.some(t => t.kind === "undo") ? stack.filter(t => t.kind !== "undo") : stack;
}

/** Hover, focus, touch and a hidden page pause a countdown, except an undo's: its deadline is real. */
export function isToastPaused(toast: Toast, pointerOrPageHold: boolean): boolean {
  return toast.kind !== "undo" && pointerOrPageHold;
}

/** Up or sideways past this many px sends a toast away; anything less springs back. */
export const SWIPE_DISTANCE = 48;
const SWIPE_FLICK_SPEED = 0.5; // px per ms: a quick flick dismisses before the distance
const SWIPE_FLICK_MIN = 12; // ...but a twitch of a few px is not a flick

export type SwipeOutcome = "up" | "left" | "right" | "back";

/**
 * What a released drag does. Down never dismisses: the toast sits at the top,
 * so "away" is up or sideways. `vx`/`vy` are px per ms over the last ~100 ms.
 */
export function swipeOutcome(dx: number, dy: number, vx: number, vy: number): SwipeOutcome {
  const up = -dy;
  const side = Math.abs(dx);
  const upward = up > SWIPE_DISTANCE || (vy < -SWIPE_FLICK_SPEED && up > SWIPE_FLICK_MIN);
  const sideways = side > SWIPE_DISTANCE || (Math.abs(vx) > SWIPE_FLICK_SPEED && side > SWIPE_FLICK_MIN);
  if (!upward && !sideways) return "back";
  if (sideways && (!upward || side >= up)) return (dx || vx) < 0 ? "left" : "right";
  return "up";
}

/** Where the pill sits under the finger: a downward drag is resisted to a third of the distance. */
export function dragOffsetY(dy: number): number {
  return dy > 0 ? dy / 3 : dy;
}
