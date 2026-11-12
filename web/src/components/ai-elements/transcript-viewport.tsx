/*!---------------------------------------------------------------------------------------------
 *  Copyright (c) StackBlitz. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
"use client";
// Ported from use-stick-to-bottom 1.1.6 (MIT, StackBlitz) and rewritten for omp-pulse. The licence text is in NOTICE in this directory.

import { createContext, useContext, useMemo, useState, useSyncExternalStore } from "react";
import type { ComponentProps, MouseEvent, RefObject } from "react";

import { prefersReducedMotion } from "@/platform/appearance";

/**
 * One owner of the transcript's scroll position.
 *
 * Seven places wrote the scroller's scrollTop (the use-stick-to-bottom spring,
 * the toggled-row hold, the send anchor, the load-earlier restore loop,
 * keepBottomOnShrink, message navigation's settle loop and the Down button's
 * jump), each patched against the others. Measured on a 150-turn chat, that
 * gave: a first paint 5,546 px above the newest message that then travelled for
 * 730-790 ms; an older page landing yanked the reader back DOWN by up to 964 px
 * (the anchor was re-asserted against the finger); the library re-locking to the
 * bottom within 70 px on ANY downward movement or content shrink; and PageUp
 * unable to leave a streaming reply.
 *
 * The rules, in short (the lock decision itself is `decideLock`):
 * - The reader frees the view by an upward drag, wheel, key or mouse selection,
 *   or a scroll event that moved up outside a resize window. Only the reader's
 *   own downward scroll to within RELOCK_PX of the end, or `follow()`, locks it
 *   again. A `release("program")` stays until one of those two.
 * - Opening is instant, inside the first measurement, so no frame shows the top.
 * - A scroller resize (soft keyboard, composer growth) moves the view with it.
 * - `hold()` keeps one element at an offset while layout settles, and never
 *   fights a finger.
 * - A free reader's place is kept by `placeTick`: one transcript row is
 *   measured every frame while the view moves or its layout changes, and any
 *   shift of that row that was not the reader's own scrolling is written back.
 *   Native scroll anchoring is off (`overflow-anchor: none`) so this is the only
 *   answer, identically in every browser. It covers prepended pages (including
 *   one that lands in the same commit as a bottom trim, which leaves the row
 *   count unchanged), rows above the view re-measuring, and late images.
 */

/** The UI's "near the end" (Down button, unread count). It is not a lock rule. */
export const NEAR_BOTTOM_PX = 70;
/**
 * A reader whose own downward scroll ends this close to the end is following
 * again. The library re-locked within 70 px on any downward movement or content
 * shrink, so a reader still reading 60 px above the end was taken over by the
 * next shrink or the next token.
 */
export const RELOCK_PX = 24;
/** A content shrink that leaves the view this close to the end undoes a READER release. */
const SHRINK_RELOCK_PX = 2;
/** After the first measurement, growth is followed instantly for this long (or until the first gesture). */
const OPEN_SETTLE_MS = 500;
/** Before a scroller resize, a view this close to the end counts as pinned to it. */
const PINNED_BEFORE_RESIZE_PX = 48;

/**
 * How the view follows growth. Firmer than the library's default ("smooth":
 * damping 0.7, stiffness 0.05, mass 1.25), which trailed a streaming reply by a
 * floaty ~150ms time constant. These are DeepSeek's catch-up spring (critically
 * damped, stiffness 700) mapped onto the library's per-frame model: critically
 * damped there at 60 Hz and overdamped at 120 Hz, so it never overshoots the
 * bottom on either.
 */
const SPRING = { damping: 0.41, stiffness: 0.13, mass: 1 } as const;
const SIXTY_FPS_INTERVAL_MS = 1000 / 60;
/** Growth arrives in bursts (a streaming reply, a late image); a loop that outlives each burst keeps its velocity. */
const RETAIN_ANIMATION_MS = 350;

/** How long a hold lasts unless the caller says otherwise. */
const HOLD_MS = 600;
/** Sub-pixel drift is rounding, not movement. */
const HOLD_DRIFT_PX = 0.5;
/** A hold ends once the scroll height has not changed for this many frames (rows above the view re-measure over several). */
const HOLD_STABLE_FRAMES = 8;
/** A row that moved by less than this against the reader's own scrolling is rounding, not layout. */
const PLACE_DRIFT_PX = 0.5;
/** Frames without a scroll or a layout shift before the place-keeper stops asking for frames. */
const PLACE_QUIET_FRAMES = 12;
/** The transcript's rows: whatever carries the id of the entry it shows. */
const PLACE_ROW = "[data-entry-id]";
/** Finger travel before a drag counts as intent rather than a tap's jitter. */
const DRAG_ESCAPE_PX = 12;
/** The browser's `scrollend` is not guaranteed (a scroll of 0 px emits none); this is the fallback. */
const SMOOTH_SETTLE_MS = 700;
/** Anything the reader does themselves takes the scroll position back from a hold. */
const INTERRUPTS = ["pointerdown", "touchstart", "wheel", "keydown"] as const;

export type ReleaseBy = "reader" | "program";

/** Following the newest message, or free (and who freed it). */
export type LockMode = { readonly kind: "following" } | { readonly kind: "free"; readonly by: ReleaseBy };

/** What can change the mode. "reader-up" is any upward input; "reader-down" is the reader's own downward scroll. */
export type LockEvent =
  | { readonly kind: "reader-up" }
  | { readonly kind: "reader-down" }
  | { readonly kind: "shrink" }
  | { readonly kind: "follow" }
  | { readonly kind: "release"; readonly by: ReleaseBy };

const FOLLOWING: LockMode = { kind: "following" };
const FREE_BY_READER: LockMode = { kind: "free", by: "reader" };
const FREE_BY_PROGRAM: LockMode = { kind: "free", by: "program" };

/**
 * The lock decision, without a DOM.
 *
 * - `reader-up` always frees a following view; a view that is already free keeps
 *   whoever freed it.
 * - `reader-down` follows again within RELOCK_PX of the end, whoever freed it.
 * - `shrink` (the content got shorter) follows again within 2 px of the end, but
 *   only for a READER release: a program release (a send, a navigation jump)
 *   exists to keep the view where the program put it, and a shorter reply must
 *   not undo it.
 * - `follow` always follows. `release` by the program always becomes a program
 *   release; `release` by the reader never downgrades a program release.
 *
 * Returns `mode` itself when nothing changes, so callers can compare identity.
 */
export function decideLock(mode: LockMode, event: LockEvent, distanceFromEnd: number): LockMode {
  switch (event.kind) {
    case "follow":
      return FOLLOWING;
    case "release":
      if (event.by === "program") return mode.kind === "free" && mode.by === "program" ? mode : FREE_BY_PROGRAM;
      return mode.kind === "following" ? FREE_BY_READER : mode;
    case "reader-up":
      return mode.kind === "following" ? FREE_BY_READER : mode;
    case "reader-down":
      return mode.kind === "free" && distanceFromEnd <= RELOCK_PX ? FOLLOWING : mode;
    case "shrink":
      return mode.kind === "free" && mode.by === "reader" && distanceFromEnd <= SHRINK_RELOCK_PX ? FOLLOWING : mode;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export interface TranscriptViewport {
  /** The scroller element. */
  scrollRef: RefObject<HTMLElement | null>;
  /** React state: following the newest message. */
  following: boolean;
  /** React state: within NEAR_BOTTOM_PX (70) of the end. For UI only (Down button, unread reset). */
  nearBottom: boolean;
  /** Always-current reads for effects and event handlers. */
  isFollowing(): boolean;
  distanceFromBottom(): number;
  /** Stop following. "program" releases stay until the reader returns to the end or follow() is called. Defaults to "program": reader releases come from the reader's own input, which is handled here. */
  release(by?: "reader" | "program"): void;
  /** Follow again and go to the end. Resolves true on arrival, false when the reader took over. Defaults to "smooth". */
  follow(behavior?: "instant" | "smooth"): Promise<boolean>;
  /** A program write: never read as the reader scrolling, never changes the mode. `smooth` uses the browser's smooth scroll and ignores its scroll events for lock decisions until `scrollend` (or 700 ms). */
  scrollTo(top: number, options?: { smooth?: boolean }): void;
  /** Keep `target` at `offsetPx` from the scroller's top edge while layout settles. See the rules at the top of this file. */
  hold(target: Element, offsetPx: number, options?: { maxMs?: number; persistent?: boolean }): { cancel(): void; done: Promise<void> };
}

interface Snapshot {
  readonly following: boolean;
  readonly nearBottom: boolean;
}

interface Drag {
  readonly x: number;
  readonly y: number;
  readonly nested: boolean;
  done: boolean;
}

interface ActiveHold {
  readonly target: Element;
  /** Where `target` should sit, from the scroller's top edge. Adopted anew whenever someone else moves the view. */
  goal: number;
  readonly persistent: boolean;
  readonly deadline: number;
  /** scrollTop after the hold's own last write (or last observation): anything else is somebody else moving the view. */
  lastTop: number;
  lastHeight: number;
  stableFrames: number;
  frame: number | null;
  stopListening: () => void;
  readonly finish: () => void;
}

function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options: AddEventListenerOptions,
): () => void;
function listen<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  options: AddEventListenerOptions,
): () => void;
function listen(target: EventTarget, type: string, handler: () => void, options: AddEventListenerOptions): () => void;
function listen(target: EventTarget, type: string, handler: (event: never) => void, options: AddEventListenerOptions): () => void {
  // The overloads above tie `handler` to the event type; this is the one place that has to forget it.
  const listener = handler as EventListener;
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}

/** True when `target` sits inside a scroller of its own, so a drag or key there is not ours. */
function insideNestedScroller(target: EventTarget | null, scroller: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== scroller; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return true;
  }
  return false;
}

/** Typing in a field must never be read as scrolling the transcript. */
function inEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null;
}

/** A mouse selection that touches the transcript (the library's `isSelecting`, minus the collapsed caret a plain click leaves). */
function selectionWithin(scroller: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const { commonAncestorContainer: common } = selection.getRangeAt(0);
  return common.contains(scroller) || scroller.contains(common);
}

function keyDirection(event: KeyboardEvent): "up" | "down" | null {
  switch (event.key) {
    case "PageUp":
    case "ArrowUp":
    case "Home":
      return "up";
    case "PageDown":
    case "ArrowDown":
    case "End":
      return "down";
    case " ":
      return event.shiftKey ? "up" : "down";
    default:
      return null;
  }
}

/** Where `target` sits from the scroller's top edge. */
function offsetOf(target: Element, scroller: HTMLElement): number {
  return target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

/** The spring's goal. One short of the true end, as the library has it, so sub-pixel scroll sizes still arrive. */
function targetTop(scroller: HTMLElement): number {
  return scroller.scrollHeight - 1 - scroller.clientHeight;
}

/**
 * The scroll position's one owner. Plain class, not hooks: every timer, frame,
 * observer and listener it starts is registered here, so `stopAll()` can end
 * them all when the scroller goes away.
 */
class ViewportEngine {
  readonly scrollRef: RefObject<HTMLElement | null> = { current: null };

  private contentObserver: ResizeObserver | null = null;
  private contentEl: HTMLElement | null = null;
  private scrollerObserver: ResizeObserver | null = null;
  private teardown: Array<() => void> = [];

  private mode: LockMode = FOLLOWING;
  private near = true;
  private snapshot: Snapshot = { following: true, nearBottom: true };
  private readonly listeners = new Set<() => void>();

  // Everything scheduled goes through frame() / timer().
  private readonly frames = new Set<number>();
  private readonly timers = new Set<number>();

  // The spring.
  private springFrame: number | null = null;
  private velocity = 0;
  private accumulated = 0;
  private lastTick: number | undefined;
  private retainUntil = 0;
  private forceInstant = false;
  private arrivals: Array<(arrived: boolean) => void> = [];

  // Telling the reader from the layout.
  private lastTop = 0;
  private ignoreTop: number | undefined;
  private scrollerHeight: number | undefined;
  private contentHeight: number | undefined;
  private openingUntil = 0;
  private touching = false;
  private drag: Drag | null = null;
  private mouseDown = false;
  private resizing = false;
  private resizeTicket = 0;
  private smoothing = false;
  private smoothTimer: number | null = null;

  private activeHold: ActiveHold | null = null;

  // Keeping a free reader's place (see placeTick).
  private place: { row: Element; offset: number; top: number } | null = null;
  private placeFrame: number | null = null;
  private placeQuiet = 0;
  private placeLastTop = 0;
  private contentMutations: MutationObserver | null = null;

  // ---- React binding -------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): Snapshot => this.snapshot;

  private publish(): void {
    const following = this.mode.kind === "following";
    if (following === this.snapshot.following && this.near === this.snapshot.nearBottom) return;
    this.snapshot = { following, nearBottom: this.near };
    for (const listener of this.listeners) listener();
  }

  private measureNear(): void {
    const near = this.distanceFromBottom() <= NEAR_BOTTOM_PX;
    if (near === this.near) return;
    this.near = near;
    this.publish();
  }

  // ---- Public API ----------------------------------------------------------

  readonly isFollowing = (): boolean => this.mode.kind === "following";

  readonly distanceFromBottom = (): number => {
    const el = this.scrollRef.current;
    return el ? Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) : 0;
  };

  readonly release = (by: ReleaseBy = "program"): void => {
    this.apply({ kind: "release", by });
  };

  readonly follow = (behavior: "instant" | "smooth" = "smooth"): Promise<boolean> => {
    const el = this.scrollRef.current;
    if (!el) return Promise.resolve(false);
    this.endHold();
    this.endSmoothing();
    this.apply({ kind: "follow" });
    this.forceInstant = behavior === "instant";
    this.retainUntil = 0;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.arrivals.push(resolve);
    if (this.forceInstant) this.pinEnd();
    if (!this.resolveIfArrived(el)) this.startSpring();
    return promise;
  };

  readonly scrollTo = (top: number, options: { smooth?: boolean } = {}): void => {
    const el = this.scrollRef.current;
    if (!el) return;
    this.endSmoothing();
    if (options.smooth === true && !prefersReducedMotion()) {
      this.smoothing = true;
      this.smoothTimer = this.timer(() => {
        this.smoothTimer = null;
        this.endSmoothing();
      }, SMOOTH_SETTLE_MS);
      el.scrollTo({ top, behavior: "smooth" });
    } else {
      this.write(top);
    }
  };

  readonly hold = (
    target: Element,
    offsetPx: number,
    options: { maxMs?: number; persistent?: boolean } = {},
  ): { cancel(): void; done: Promise<void> } => {
    this.endHold();
    const el = this.scrollRef.current;
    if (!el) return { cancel: () => {}, done: Promise.resolve() };
    const { promise, resolve } = Promise.withResolvers<void>();
    const hold: ActiveHold = {
      target,
      goal: offsetPx,
      persistent: options.persistent === true,
      deadline: performance.now() + (options.maxMs ?? HOLD_MS),
      lastTop: el.scrollTop,
      lastHeight: el.scrollHeight,
      stableFrames: 0,
      frame: null,
      stopListening: () => {},
      finish: resolve,
    };
    const stops = INTERRUPTS.map((type) => listen(document, type, () => this.endHold(hold), { capture: true, passive: true }));
    hold.stopListening = () => {
      for (const stop of stops) stop();
    };
    this.activeHold = hold;
    this.correct(hold, el);
    hold.frame = this.frame(this.holdTick);
    return { cancel: () => this.endHold(hold), done: promise };
  };

  /**
   * A tapped [aria-expanded] control keeps its place while its row opens or
   * closes: the browser clamps or re-anchors scrollTop and the row the reader
   * just tapped would slide away. Measured before the click is handled, put
   * back afterwards. A reader at the end is left to follow it.
   */
  readonly holdToggledRow = (event: MouseEvent<HTMLElement>): void => {
    const el = this.scrollRef.current;
    if (!el || !(event.target instanceof Element)) return;
    const trigger = event.target.closest("[aria-expanded]");
    if (!trigger || !el.contains(trigger) || this.isFollowing() || this.distanceFromBottom() <= NEAR_BOTTOM_PX) return;
    this.hold(trigger, offsetOf(trigger, el));
  };

  // ---- Keeping the reader's place ------------------------------------------

  /**
   * Asks for the place-keeper to look at the next frame. Called by anything
   * that can shift rows under a reader: a scroll, a content resize, rows added
   * or removed. A following view needs none of it (the end is its anchor).
   */
  private watchPlace(now = false): void {
    if (this.mode.kind === "following") {
      this.place = null;
      return;
    }
    this.placeQuiet = 0;
    if (now) this.placeTick();
    else if (this.placeFrame === null && this.scrollRef.current) this.placeFrame = this.frame(this.placeTick);
  }

  /**
   * The row to measure. The first row that STARTS in view, so that anything above
   * it (including the sliver of a row cut by the top edge, whose height can change
   * under it) moves it and is seen. Only when no row starts in view (one tall row
   * fills the screen) is the row containing the top edge used.
   */
  private pickPlace(el: HTMLElement, edge: number): { row: Element; offset: number; top: number } | null {
    const bottom = edge + el.clientHeight;
    let spanning: Element | null = null;
    let spanningOffset = 0;
    for (const row of el.querySelectorAll(PLACE_ROW)) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= edge) continue;
      if (rect.top >= edge) {
        if (rect.top < bottom) return { row, offset: rect.top - edge, top: el.scrollTop };
        break;
      }
      spanning ??= row;
      if (row === spanning) spanningOffset = rect.top - edge;
    }
    return spanning ? { row: spanning, offset: spanningOffset, top: el.scrollTop } : null;
  }

  /**
   * Native scroll anchoring failed here in two ways that were measured on a
   * 700-turn chat while flinging up: a page that landed in the same commit as a
   * bottom trim (the window is capped, so the row count did not grow) moved the
   * reader a whole page (15,400 px, 18 times), and rows above the view that
   * re-measured shorter than their content-visibility estimate pushed the
   * reader back down by 29-309 px (33 times, 9,800 px in all). Both are one
   * thing: the reference row moved by something other than the reader.
   *
   * A row's offset changes by (layout shift) minus (change in scrollTop), so the
   * shift is `offset change + scrollTop change`. Whatever the reader scrolled is
   * therefore never touched; only the remainder is written back. A hold owns
   * the position while it lasts, and so does a smooth program scroll.
   */
  private readonly placeTick = (): void => {
    if (this.placeFrame !== null) this.cancelFrame(this.placeFrame);
    this.placeFrame = null;
    const el = this.scrollRef.current;
    if (!el) return;
    if (this.mode.kind === "following" || this.activeHold !== null || this.smoothing) {
      this.place = null;
      return;
    }
    const edge = el.getBoundingClientRect().top;
    let place = this.place;
    let corrected = false;
    if (place && place.row.isConnected) {
      const shift = place.row.getBoundingClientRect().top - edge - place.offset + (el.scrollTop - place.top);
      if (Math.abs(shift) >= PLACE_DRIFT_PX) {
        this.write(el.scrollTop + shift);
        corrected = true;
        place = null;
      }
    } else {
      place = null;
    }
    if (place) {
      // Re-baseline once the row has left the view: a shift between it and the reader would go unseen.
      const rect = place.row.getBoundingClientRect();
      if (rect.bottom <= edge || rect.top >= edge + el.clientHeight) place = null;
    }
    this.place = place ?? this.pickPlace(el, edge);
    const top = el.scrollTop;
    this.placeQuiet = corrected || top !== this.placeLastTop ? 0 : this.placeQuiet + 1;
    this.placeLastTop = top;
    if (this.placeQuiet < PLACE_QUIET_FRAMES) this.placeFrame = this.frame(this.placeTick);
  };

  // ---- Lock mode -----------------------------------------------------------

  private apply(event: LockEvent): void {
    const next = decideLock(this.mode, event, this.distanceFromBottom());
    if (next === this.mode) return;
    this.mode = next;
    if (next.kind === "free") this.stopSpring();
    this.publish();
  }

  // ---- Writing the scroll position ----------------------------------------

  /**
   * Every program write goes through here. It records where the write landed,
   * so the scroll event it causes is recognised as ours and never read as the reader.
   */
  private write(top: number): void {
    const el = this.scrollRef.current;
    if (!el) return;
    // A CSS scroll-behavior of smooth would turn this write into an animation.
    const { scrollBehavior } = getComputedStyle(el);
    const inline = el.style.scrollBehavior;
    if (scrollBehavior !== "auto") el.style.scrollBehavior = "auto";
    el.scrollTop = top;
    if (scrollBehavior !== "auto") el.style.scrollBehavior = inline;
    const landed = el.scrollTop;
    this.ignoreTop = landed;
    this.lastTop = landed;
  }

  private pinEnd(): void {
    const el = this.scrollRef.current;
    if (el) this.write(el.scrollHeight - el.clientHeight);
  }

  // ---- The spring ----------------------------------------------------------

  private startSpring(): void {
    if (this.springFrame === null && this.scrollRef.current) this.springFrame = this.frame(this.tick);
  }

  private readonly tick = (): void => {
    this.springFrame = null;
    const el = this.scrollRef.current;
    // A hold owns the position while it lasts; the spring would fight its corrections.
    if (!el || this.mode.kind !== "following" || this.activeHold !== null) {
      this.stopSpring();
      return;
    }
    const now = performance.now();
    const delta = (now - (this.lastTick ?? now)) / SIXTY_FPS_INTERVAL_MS;
    this.lastTick = now;
    const target = targetTop(el);
    const top = el.scrollTop;
    if (top < target) {
      if (this.forceInstant || now < this.openingUntil || prefersReducedMotion()) {
        this.pinEnd();
      } else {
        this.velocity = (SPRING.damping * this.velocity + SPRING.stiffness * (target - top)) / SPRING.mass;
        this.accumulated += this.velocity * delta;
        this.write(top + this.accumulated);
        // The browser may round the write away; keep the remainder until it takes.
        if (el.scrollTop !== top) this.accumulated = 0;
      }
    }
    const arrived = this.resolveIfArrived(el);
    if (!arrived || now < this.retainUntil) this.springFrame = this.frame(this.tick);
    else this.idleSpring();
  };

  private idleSpring(): void {
    this.velocity = 0;
    this.accumulated = 0;
    this.lastTick = undefined;
  }

  private stopSpring(): void {
    if (this.springFrame !== null) this.cancelFrame(this.springFrame);
    this.springFrame = null;
    this.retainUntil = 0;
    this.idleSpring();
    this.resolveArrivals(false);
  }

  private resolveIfArrived(el: HTMLElement): boolean {
    if (el.scrollTop < targetTop(el)) return false;
    this.resolveArrivals(true);
    return true;
  }

  private resolveArrivals(arrived: boolean): void {
    this.forceInstant = false;
    const pending = this.arrivals;
    this.arrivals = [];
    for (const resolve of pending) resolve(arrived);
  }

  // ---- Holds ---------------------------------------------------------------

  private correct(hold: ActiveHold, el: HTMLElement): void {
    const drift = offsetOf(hold.target, el) - hold.goal;
    if (Math.abs(drift) < HOLD_DRIFT_PX) return;
    this.write(el.scrollTop + drift);
    hold.lastTop = el.scrollTop;
  }

  private readonly holdTick = (): void => {
    const hold = this.activeHold;
    const el = this.scrollRef.current;
    if (!hold) return;
    hold.frame = null;
    if (!el || !hold.target.isConnected) {
      this.endHold(hold);
      return;
    }
    const top = el.scrollTop;
    if (this.touching || (!this.smoothing && top !== hold.lastTop)) {
      // A finger is down, or the view moved by something other than this hold's
      // own write: the reader, a fling, or native scroll anchoring. Take where
      // the target is now as the new goal and write nothing. Pulling back
      // against a finger was the 964 px yank when an older page landed.
      hold.goal = offsetOf(hold.target, el);
      hold.lastTop = top;
    } else if (this.smoothing) {
      // Our own smooth scroll is travelling; correct what is left when it lands.
      hold.lastTop = top;
    } else {
      this.correct(hold, el);
    }
    const height = el.scrollHeight;
    hold.stableFrames = height === hold.lastHeight ? hold.stableFrames + 1 : 0;
    hold.lastHeight = height;
    if (!hold.persistent && (hold.stableFrames >= HOLD_STABLE_FRAMES || performance.now() >= hold.deadline)) {
      this.endHold(hold);
      return;
    }
    hold.frame = this.frame(this.holdTick);
  };

  private endHold(only?: ActiveHold): void {
    const hold = this.activeHold;
    if (hold === null || (only !== undefined && only !== hold)) return;
    this.activeHold = null;
    if (hold.frame !== null) this.cancelFrame(hold.frame);
    hold.stopListening();
    hold.finish();
    this.watchPlace();
  }

  // ---- Scheduling ----------------------------------------------------------

  private frame(callback: () => void): number {
    const id = requestAnimationFrame(() => {
      this.frames.delete(id);
      callback();
    });
    this.frames.add(id);
    return id;
  }

  private cancelFrame(id: number): void {
    cancelAnimationFrame(id);
    this.frames.delete(id);
  }

  private timer(callback: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private cancelTimer(id: number): void {
    window.clearTimeout(id);
    this.timers.delete(id);
  }

  /** Nothing the engine started may outlive the scroller. */
  private stopAll(): void {
    this.stopSpring();
    this.endHold();
    for (const id of this.frames) cancelAnimationFrame(id);
    this.frames.clear();
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.smoothTimer = null;
    this.smoothing = false;
    this.resizing = false;
    this.placeFrame = null;
    this.place = null;
  }

  // ---- Reading the reader --------------------------------------------------

  /** Any gesture ends the opening settle and hands a smooth program scroll back to the browser. */
  private gesture(): void {
    this.openingUntil = 0;
    this.endSmoothing();
  }

  private endSmoothing(): void {
    if (this.smoothTimer !== null) this.cancelTimer(this.smoothTimer);
    this.smoothTimer = null;
    if (!this.smoothing) return;
    this.smoothing = false;
    const el = this.scrollRef.current;
    // What the smooth scroll travelled is not "someone else moved the view" to a hold.
    if (this.activeHold && el) this.activeHold.lastTop = el.scrollTop;
    if (el) this.watchPlace();
  }

  private readonly onScroll = (): void => {
    const el = this.scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const previous = this.lastTop;
    const ignored = this.ignoreTop;
    this.lastTop = top;
    this.ignoreTop = undefined;
    this.measureNear();
    this.watchPlace();
    // Our own write, or the native smooth scroll we started, is not the reader.
    if (top === ignored || this.smoothing) return;
    // A scroll event can arrive before the ResizeObserver callback for the layout
    // that caused it (https://github.com/WICG/resize-observer/issues/25), so the
    // decision waits a tick. Only UP is suspect inside a resize window: content
    // that shrinks clamps scrollTop upward. A downward move is the reader's (or
    // an anchoring jump far from the end), and while a reply streams the window
    // never closes, so ignoring it too would make returning to the end impossible.
    this.timer(() => {
      if (top < previous) {
        if (!this.resizing) this.apply({ kind: "reader-up" });
      } else if (top > previous) {
        this.apply({ kind: "reader-down" });
      }
    }, 1);
  };

  private readonly onScrollEnd = (): void => {
    this.endSmoothing();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    const el = this.scrollRef.current;
    if (!el) return;
    this.gesture();
    // The browser may cancel a wheel scroll if the spring writes in the meantime,
    // so an upward wheel frees the view without waiting for the scroll event.
    if (event.deltaY < 0 && el.scrollHeight > el.clientHeight && !insideNestedScroller(event.target, el)) {
      this.apply({ kind: "reader-up" });
    }
  };

  private readonly onPointerDown = (): void => {
    this.gesture();
  };

  private readonly onTouchStart = (event: TouchEvent): void => {
    const el = this.scrollRef.current;
    if (!el) return;
    this.gesture();
    this.touching = event.touches.length > 0;
    const touch = event.touches[0];
    this.drag =
      touch && event.touches.length === 1
        ? { x: touch.clientX, y: touch.clientY, nested: insideNestedScroller(event.target, el), done: false }
        : null;
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
    const el = this.scrollRef.current;
    const gesture = this.drag;
    const touch = event.touches[0];
    if (!el || !gesture || gesture.done || gesture.nested || !touch) return;
    const dy = touch.clientY - gesture.y;
    // A finger moving DOWN scrolls the content UP: the reader is leaving the end.
    // Released from the touch itself, because while a reply streams the scroll
    // events land inside resize windows and the first drag would be swallowed,
    // after which the spring drags the reader back down.
    if (dy >= DRAG_ESCAPE_PX && dy > Math.abs(touch.clientX - gesture.x) && el.scrollTop > 0) {
      gesture.done = true;
      this.apply({ kind: "reader-up" });
    }
  };

  private readonly onTouchEnd = (event: TouchEvent): void => {
    this.touching = event.touches.length > 0;
    if (!this.touching) this.drag = null;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const el = this.scrollRef.current;
    const direction = keyDirection(event);
    if (!el || direction === null || event.defaultPrevented || inEditable(event.target)) return;
    const target = event.target;
    const inside = target instanceof Node && el.contains(target);
    // Focus elsewhere (a sheet, the header) is not scrolling this transcript.
    if (!inside && target !== document.body && target !== document.documentElement) return;
    if (inside && insideNestedScroller(target, el)) return;
    this.gesture();
    if (direction === "up") this.apply({ kind: "reader-up" });
  };

  private readonly onMouseDown = (): void => {
    this.mouseDown = true;
  };

  private readonly onMouseUp = (): void => {
    this.mouseDown = false;
  };

  private readonly onSelectionChange = (): void => {
    const el = this.scrollRef.current;
    if (el && this.mouseDown && selectionWithin(el)) this.apply({ kind: "reader-up" });
  };

  // ---- Layout --------------------------------------------------------------

  /**
   * Scroll events caused by layout (clamping when content shrinks, a scroller
   * that resizes) fire inside this window and must not be read as the reader.
   * It closes a frame and a tick after the last resize.
   */
  private openResizeWindow(): void {
    this.resizing = true;
    const ticket = ++this.resizeTicket;
    this.frame(() => {
      this.timer(() => {
        if (ticket === this.resizeTicket) this.resizing = false;
      }, 1);
    });
  }

  private readonly onContentResize = (entries: ResizeObserverEntry[]): void => {
    const entry = entries[entries.length - 1];
    const el = this.scrollRef.current;
    if (!entry || !el) return;
    this.watchPlace(true);
    // The border box, so padding counts: the composer's height lands in the content's padding-bottom.
    const height = entry.borderBoxSize[0].blockSize;
    const first = this.contentHeight === undefined;
    const difference = height - (this.contentHeight ?? height);
    this.contentHeight = height;
    this.openResizeWindow();
    const now = performance.now();
    if (first) {
      // Opening. This callback runs before the first paint, so writing the end
      // here means no frame shows the top of the page and nothing travels (the
      // chat used to paint 5,546 px above the newest message and then spring
      // for ~750 ms through ~45 visible positions, flashing the Down button).
      this.openingUntil = now + OPEN_SETTLE_MS;
      if (this.mode.kind === "following") this.pinEnd();
    } else if (difference >= 0) {
      // Height changes AFTER layout still need following: images are lazy and
      // Shiki replaces code markup asynchronously, both of which grow the
      // document under the reader.
      if (this.mode.kind === "following") {
        if (now < this.openingUntil) {
          this.pinEnd();
        } else {
          this.retainUntil = now + RETAIN_ANIMATION_MS;
          this.startSpring();
        }
      }
    } else {
      // The content got shorter: a reader who released it themselves and now
      // sits at the end is following again; a program release stays.
      this.apply({ kind: "shrink" });
    }
    this.measureNear();
  };

  /**
   * The scroller itself changed height: the soft keyboard (Android shrinks the
   * layout viewport), the composer growing, an attachment strip. The content
   * observer never sees this. Native chat apps move the conversation with the
   * keyboard; before, a reader scrolled up lost the lines above the composer.
   */
  private readonly onScrollerResize = (): void => {
    const el = this.scrollRef.current;
    if (!el) return;
    const height = el.clientHeight;
    const previous = this.scrollerHeight;
    this.scrollerHeight = height;
    // The first callback only reports the size the scroller had all along.
    if (previous === undefined || previous === height) return;
    this.openResizeWindow();
    const top = el.scrollTop;
    const max = Math.max(0, el.scrollHeight - height);
    const hold = this.activeHold;
    if (hold) {
      if (!this.touching) this.correct(hold, el);
    } else if (
      this.mode.kind === "following" ||
      // Judged with the height from BEFORE the change: measured afterwards, a
      // reader who was at the end is already `previous - height` px short.
      el.scrollHeight - top - previous <= PINNED_BEFORE_RESIZE_PX ||
      // The browser already clamped a growing scroller to its end.
      top >= max - 1
    ) {
      this.pinEnd();
    } else {
      // Keep the BOTTOM edge of what the reader sees where it was.
      this.write(Math.min(Math.max(top - (height - previous), 0), max));
    }
    this.measureNear();
  };

  // ---- Attaching to the DOM ------------------------------------------------

  readonly attachScroller = (el: HTMLElement | null): void => {
    if (el === this.scrollRef.current) return;
    this.detachScroller();
    if (el === null) return;
    this.scrollRef.current = el;
    // Nothing in the stylesheet makes this element scroll (scrollClassName is
    // only a hook for callers), so, as the library did, an element left at
    // `overflow: visible` gets `auto`.
    if (getComputedStyle(el).overflow === "visible") el.style.overflow = "auto";
    // The place-keeper is the only thing that answers a layout shift above the view.
    el.style.overflowAnchor = "none";
    this.lastTop = el.scrollTop;
    this.scrollerHeight = undefined;
    const passive = { passive: true };
    const capturing = { passive: true, capture: true };
    this.teardown = [
      listen(el, "scroll", this.onScroll, passive),
      listen(el, "scrollend", this.onScrollEnd, passive),
      listen(el, "wheel", this.onWheel, passive),
      listen(el, "pointerdown", this.onPointerDown, capturing),
      listen(el, "touchstart", this.onTouchStart, capturing),
      listen(el, "touchmove", this.onTouchMove, capturing),
      listen(el, "touchend", this.onTouchEnd, capturing),
      listen(el, "touchcancel", this.onTouchEnd, capturing),
      listen(document, "keydown", this.onKeyDown, passive),
      listen(document, "selectionchange", this.onSelectionChange, passive),
      listen(document, "mousedown", this.onMouseDown, capturing),
      listen(document, "mouseup", this.onMouseUp, capturing),
      listen(document, "click", this.onMouseUp, capturing),
    ];
    this.scrollerObserver = new ResizeObserver(this.onScrollerResize);
    this.scrollerObserver.observe(el);
    this.measureNear();
  };

  readonly attachContent = (el: HTMLElement | null): void => {
    if (el === this.contentEl) return;
    this.detachContent();
    if (el === null) return;
    this.contentEl = el;
    this.contentObserver = new ResizeObserver(this.onContentResize);
    this.contentObserver.observe(el, { box: "border-box" });
    this.contentMutations = new MutationObserver(() => this.watchPlace(true));
    this.contentMutations.observe(el, { childList: true, subtree: true });
  };

  private detachScroller(): void {
    for (const stop of this.teardown) stop();
    this.teardown = [];
    this.scrollerObserver?.disconnect();
    this.scrollerObserver = null;
    this.stopAll();
    this.scrollRef.current = null;
    this.ignoreTop = undefined;
    this.scrollerHeight = undefined;
    this.touching = false;
    this.drag = null;
    this.mouseDown = false;
    this.openingUntil = 0;
  }

  private detachContent(): void {
    this.contentObserver?.disconnect();
    this.contentObserver = null;
    this.contentMutations?.disconnect();
    this.contentMutations = null;
    this.contentEl = null;
    this.contentHeight = undefined;
  }
}

const EngineContext = createContext<ViewportEngine | null>(null);
const ViewportContext = createContext<TranscriptViewport | null>(null);

export type TranscriptViewportRootProps = ComponentProps<"div">;

/** The transcript's root: owns the viewport and provides it to everything inside. */
export function TranscriptViewportRoot({ children, onClickCapture, ...props }: TranscriptViewportRootProps) {
  const [engine] = useState(() => new ViewportEngine());
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const viewport = useMemo<TranscriptViewport>(
    () => ({
      scrollRef: engine.scrollRef,
      following: snapshot.following,
      nearBottom: snapshot.nearBottom,
      isFollowing: engine.isFollowing,
      distanceFromBottom: engine.distanceFromBottom,
      release: engine.release,
      follow: engine.follow,
      scrollTo: engine.scrollTo,
      hold: engine.hold,
    }),
    [engine, snapshot],
  );
  return (
    <EngineContext value={engine}>
      <ViewportContext value={viewport}>
        <div
          {...props}
          onClickCapture={(event) => {
            onClickCapture?.(event);
            engine.holdToggledRow(event);
          }}
        >
          {children}
        </div>
      </ViewportContext>
    </EngineContext>
  );
}

export type TranscriptViewportContentProps = Omit<ComponentProps<"div">, "ref"> & {
  /** Classes for the scroller element, which wraps the content element. */
  scrollClassName?: string;
};

const SCROLLER_STYLE = { height: "100%", width: "100%", scrollbarGutter: "stable both-edges" } as const;

/** Root div, scroller div (`scrollClassName`), content div (the props): the same three elements as use-stick-to-bottom. */
export function TranscriptViewportContent({ children, scrollClassName, ...props }: TranscriptViewportContentProps) {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("TranscriptViewportContent must be used within a TranscriptViewportRoot");
  return (
    <div ref={engine.attachScroller} style={SCROLLER_STYLE} className={scrollClassName}>
      <div {...props} ref={engine.attachContent}>
        {children}
      </div>
    </div>
  );
}

/** The transcript's viewport, from anywhere inside a TranscriptViewportRoot. */
export function useTranscriptViewport(): TranscriptViewport {
  const viewport = useContext(ViewportContext);
  if (!viewport) throw new Error("useTranscriptViewport must be used within a TranscriptViewportRoot");
  return viewport;
}
