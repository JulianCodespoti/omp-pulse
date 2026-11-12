import type { TranscriptViewport } from "@/components/ai-elements/transcript-viewport";

/**
 * Transcript navigation between user turns.
 *
 * Two bugs motivated this being a separate, stateless module:
 *
 * 1. The previous implementation held a `currentIdx` cursor into the list of
 *    user turns. Manual scrolling never updated it, so after a scroll the next
 *    press moved relative to a stale position — pressing DOWN at the bottom
 *    could scroll UP. Position is now DERIVED from the live scroll offset on
 *    every press, so the cursor cannot drift out of sync.
 *
 * 2. It used `scrollIntoView({ block: "center" })`. Centring shows the MIDDLE
 *    of a tall message, which reads as landing "halfway". Worse, message rows
 *    carry `content-visibility: auto` with `contain-intrinsic-size: auto 80px`,
 *    so every off-screen row reports an ESTIMATED 80px height until it is
 *    actually rendered. Any long jump is therefore computed against wrong
 *    heights and lands short. We align the target's TOP and the viewport's hold
 *    keeps it there until the position stops moving, which converges as rows
 *    realise their true heights.
 */

/** Gap between the sticky header and the message we land on. */
export const LANDING_OFFSET_PX = 12;
/** Anything within this of the anchor line counts as "the current turn". */
const ANCHOR_EPSILON_PX = 24;

/** Below this distance a smooth scroll still feels instant. */
const SMOOTH_MAX_PX = 900;

export interface NavTarget {
  entryId: string;
  element: HTMLElement;
  /** Top of the row relative to the scroller's content box. */
  top: number;
}

function escapeId(entryId: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(entryId);
  return entryId.replace(/"/g, '\\"');
}

/**
 * Resolve the navigable rows in DOM order with their live offsets. Reading
 * geometry once per press keeps this O(targets) and avoids a layout thrash.
 */
export function readTargets(scroller: HTMLElement, entryIds: readonly string[]): NavTarget[] {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const targets: NavTarget[] = [];
  for (const entryId of entryIds) {
    const element = scroller.querySelector(`[data-entry-id="${escapeId(entryId)}"]`);
    if (!(element instanceof HTMLElement)) continue;
    targets.push({
      entryId,
      element,
      top: element.getBoundingClientRect().top - scrollerTop + scroller.scrollTop,
    });
  }
  // DOM order is transcript order, but a caller could pass ids out of order.
  targets.sort((a, b) => a.top - b.top);
  return targets;
}

/** The line the user perceives as "where I am": just below the header. */
function anchorLine(scroller: HTMLElement): number {
  return scroller.scrollTop + LANDING_OFFSET_PX;
}

/** The target the anchor line is currently resting on, if any. */
export function findCurrent(scroller: HTMLElement, targets: readonly NavTarget[]): NavTarget | null {
  const anchor = anchorLine(scroller);
  let best: NavTarget | null = null;
  for (const target of targets) {
    if (target.top <= anchor + ANCHOR_EPSILON_PX) best = target;
    else break;
  }
  return best;
}

export function isAtBottom(scroller: HTMLElement, epsilon = 8): boolean {
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= epsilon;
}

/**
 * Scroll so `element`'s top sits `LANDING_OFFSET_PX` below the viewport top,
 * then hold it there while the layout settles. The settling itself (rows
 * swapping their 80px estimate for a real height after the scroll was issued)
 * is the viewport's hold; this only picks the destination and the pace.
 */
export async function scrollToTarget(viewport: TranscriptViewport, element: HTMLElement): Promise<void> {
  const scroller = viewport.scrollRef.current;
  if (!scroller) return;
  // Leave the follow lock first: without this the viewport would pull the view
  // back to the newest message as soon as the content grew (verify-nav-paging
  // walked 119,118,119,118).
  viewport.release("program");
  const distance = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - LANDING_OFFSET_PX;
  // A long jump is snapped instantly: smooth-scrolling thousands of pixels
  // reads as lag, and the intermediate frames are meaningless to the user.
  viewport.scrollTo(Math.max(0, scroller.scrollTop + distance), { smooth: Math.abs(distance) <= SMOOTH_MAX_PX });
  await viewport.hold(element, LANDING_OFFSET_PX, { maxMs: 400 }).done;
}

/** Briefly shimmer the message box’s bottom edge — same language as Sessions list (purple h-[2px] shimmer), not a ring. Targets the inner [data-message-box], not the whole row. */
export function flashTarget(element: HTMLElement): void {
  const box = (element.querySelector("[data-message-box]") as HTMLElement | null) ?? element;
  box.querySelector("[data-flash-shimmer]")?.remove();
  const hadRelative = box.classList.contains("relative");
  const hadOverflowHidden = box.classList.contains("overflow-hidden");
  if (!hadRelative) box.classList.add("relative");
  if (!hadOverflowHidden) box.classList.add("overflow-hidden");
  // Subtle card tint like Sessions list — makes the shimmer pop on assistant’s transparent box.
  const hadBgTint = box.classList.contains("bg-primary/[0.06]");
  if (!hadBgTint) box.classList.add("bg-primary/[0.06]");
  const shim = document.createElement("span");
  shim.dataset.flashShimmer = "true";
  shim.className = "pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden rounded-b-lg";
  (shim as HTMLElement).style.height = "2px";
  shim.setAttribute("aria-hidden", "true");
  const inner = document.createElement("span");
  inner.className = "block h-full w-1/3 bg-primary/60 animate-[shimmer_1.2s_linear_infinite] motion-reduce:animate-none";
  (inner as HTMLElement).style.background = "linear-gradient(90deg, transparent, oklch(from var(--accent-glow) l c h / 0.8), transparent)";
  (inner as HTMLElement).style.width = "40%";
  shim.appendChild(inner);
  box.appendChild(shim);
  window.setTimeout(() => {
    shim.remove();
    if (!hadBgTint) box.classList.remove("bg-primary/[0.06]");
    if (!hadRelative) box.classList.remove("relative");
    if (!hadOverflowHidden) box.classList.remove("overflow-hidden");
  }, 1200);
}
