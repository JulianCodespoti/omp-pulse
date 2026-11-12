import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode, RefObject } from "react";

import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { prefersReducedMotion } from "../../platform/appearance";
import { drawerTarget, releaseVelocity, springFrames } from "./drawer-motion";

// A drawer that slides in from the left (the session switcher,
// min(85vw, 360px)) or the right (the workspace, wider), with the chat still
// visible beside it, so the drawer reads as a layer over this conversation,
// not another page of it. Given `push`, the drawer and that screen move as
// one, as in DeepSeek: the screen slides over by the drawer's width and
// shrinks to 95% under a faint veil while the drawer grows from 95% out of a
// 20% shade. Release physics follow
// DeepSeek's drawer (drawer-motion.ts): the finger's velocity seeds a
// near-critically-damped spring, a flick of 326px/s or more goes where it
// points and a slower drag commits past half the width. A gesture only
// claims the touch once it has moved 15px sideways and clearly more sideways
// than vertically, so vertical scrolling never fights it.
//
// Built on the same Base UI dialog as BottomSheet, so focus is contained,
// Escape and a scrim tap close it, and it is an Android back layer while open
// (components/ui/dialog.tsx). Opening it never focuses a field: the keyboard
// must not cover the list the user came for.
//
// The opening swipe (rightward for the left drawer, leftward for the right
// one) starts anywhere on the chat, not at the screen edge: under Android
// gesture navigation the system takes edge swipes as Back, so an edge strip
// never reached the WebView on the phone. A swipe that begins in something
// that can still scroll that way (scrollsAlong) belongs to it; the workspace
// pager therefore pages back until Agents, and only then closes the drawer.

const INTENT_PX = 15;
const FAIL_PX = 10;
// A predictive back swipe slides the panel this share of the way out before
// the commit finishes it, as a native drawer does.
const BACK_PREVIEW = 0.25;
// DeepSeek's push: how much the pushed screen shrinks and the drawer grows over the open, and how dark the
// drawer starts.
const PUSH_SCALE = 0.05;
const PANEL_SHADE = 0.2;

/** The drawer is `vw` of the window wide, up to `max` px. */
export interface PanelSize {
  vw: number;
  max: number;
}
const SWITCHER_SIZE: PanelSize = { vw: 0.85, max: 360 };

interface Gesture {
  kind: "open" | "close";
  startX: number;
  startY: number;
  claimed: boolean;
  samples: { x: number; t: number }[];
  /** Panel offset when the finger took hold (0 open, width closed, or wherever a spring was caught). */
  origin?: number;
  /** A swipe-open that showed the already-mounted popup in the DOM and has not told React yet. */
  deferred?: boolean;
}

// A horizontal swipe that starts inside something that can still scroll that
// way (a wide diff, a code block) belongs to the scroller, not the panel.
function scrollsAlong(target: EventTarget | null, stop: Element | null, towardStart: boolean): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== stop && el !== document.body) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === "auto" || overflow === "scroll") {
        if (towardStart ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

export function SidePanel({
  open,
  onOpenChange,
  label,
  swipeOpen,
  testId,
  side = "left",
  size = SWITCHER_SIZE,
  keepMounted = false,
  push,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the panel. */
  label: string;
  /** Listen for a swipe across the chat (toward the drawer's own side's far edge) to open the drawer. */
  swipeOpen: boolean;
  testId?: string;
  /** The edge it slides in from; a left drawer opens on a rightward swipe, a right one on a leftward swipe. */
  side?: "left" | "right";
  size?: PanelSize;
  /** Keep the content mounted while closed (hidden), so scroll positions and local state survive. */
  keepMounted?: boolean;
  /** A screen to slide and shrink with the drawer instead of leaving it still under a dark scrim. */
  push?: RefObject<HTMLElement | null>;
  children: ReactNode;
}): JSX.Element {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const shadeRef = useRef<HTMLDivElement | null>(null);
  // Distance from the open position toward this side's edge, in px, while a
  // finger, a back swipe or a settling spring holds the panel off the class
  // list's rest position; null leaves it there. Written straight to the DOM by
  // `paint`, never through React state, so a busy main thread cannot make the
  // panel lag the finger.
  const motion = useRef<number | null>(null);
  const raf = useRef(0);
  // The settle animations (panel, scrim) while a spring runs; empty at rest.
  const flight = useRef<Animation[]>([]);
  // The open state the panel's position last followed. An `open` that differs
  // came from outside (menu button, scrim tap, Escape) and springs on its own.
  const shown = useRef(open);
  // A programmatic open whose popup has not mounted yet.
  const entering = useRef(false);
  // The commit that tells React where a release ended up, queued behind the
  // spring's first frame; `awaiting` is set while an open is still to land.
  const commit = useRef({ raf: 0, timer: 0 });
  const awaiting = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const openRef = useRef(open);
  const swipeRef = useRef(swipeOpen);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    openRef.current = open;
    swipeRef.current = swipeOpen;
    onOpenChangeRef.current = onOpenChange;
  });

  const width = useCallback(() => Math.max(1, Math.min(window.innerWidth * size.vw, size.max)), [size.vw, size.max]);
  const sign = side === "left" ? -1 : 1;

  // The pushed screen's styles at open fraction `p` (0 closed, 1 open). Inline
  // and not a class because a transform makes the screen the containing block
  // for its fixed chrome; it must exist only while the drawer is out.
  const pushAt = useCallback((p: number): Keyframe => ({
    translate: `${-sign * p * width()}px 0`,
    scale: String(1 - PUSH_SCALE * p),
  }), [sign, width]);

  // Apply `motion` to the panel and scrim; null clears the inline motion so the
  // class list's rest position owns it again.
  const paint = useCallback(() => {
    raf.current = 0;
    const m = motion.current;
    const p = m === null ? (shown.current ? 1 : 0) : 1 - m / width();
    const panel = popupRef.current?.style;
    if (panel) {
      panel.translate = m === null ? "" : `${sign * m}px 0`;
      panel.scale = m === null || !push ? "" : String(1 - PUSH_SCALE * (1 - Math.min(1, p)));
    }
    const scrim = backdropRef.current?.style;
    if (scrim) scrim.opacity = m === null ? "" : String(p);
    const shade = shadeRef.current?.style;
    if (shade) shade.opacity = String(PANEL_SHADE * (1 - Math.min(1, p)));
    const screen = push?.current?.style;
    if (screen) {
      const at = pushAt(p);
      screen.translate = p > 0 ? String(at.translate) : "";
      screen.scale = p > 0 ? String(at.scale) : "";
      screen.willChange = p > 0 ? "translate, scale" : "";
    }
  }, [sign, width, push, pushAt]);

  const stop = useCallback(() => {
    for (const animation of flight.current) animation.cancel();
    flight.current = [];
  }, []);

  // Hand the panel back to the class list's rest position.
  const rest = useCallback(() => {
    stop();
    motion.current = null;
    paint();
  }, [stop, paint]);

  // Base UI renders a closed keepMounted popup `hidden`. A swipe shows and
  // hides it here, in the DOM: opening through React cost a 60-75ms task
  // inside the claiming touchmove (traced, 4x CPU), during which the panel
  // could not follow the finger. React's `hidden` prop does not change while
  // this runs, so nothing re-hides it.
  const reveal = useCallback((show: boolean) => {
    if (popupRef.current) popupRef.current.hidden = !show;
    if (backdropRef.current) backdropRef.current.hidden = !show;
  }, []);

  const cancelCommit = useCallback(() => {
    cancelAnimationFrame(commit.current.raf);
    window.clearTimeout(commit.current.timer);
    commit.current = { raf: 0, timer: 0 };
    awaiting.current = false;
  }, []);

  // Commit React state only after the compositor has the spring's first
  // frame (a frame, then a task), so the commit's render cost lands while the
  // panel is already moving instead of delaying its start.
  const commitLater = useCallback((next: boolean) => {
    cancelCommit();
    awaiting.current = next;
    commit.current.raf = requestAnimationFrame(() => {
      commit.current.timer = window.setTimeout(() => {
        commit.current = { raf: 0, timer: 0 };
        awaiting.current = false;
        onOpenChangeRef.current(next);
      }, 0);
    });
  }, [cancelCommit]);

  // Where the panel is now: while a spring runs its value lives on the
  // compositor, so ask the style engine; otherwise the last painted offset, or
  // `rest` when nothing has moved it.
  const position = useCallback((rest: number) => {
    const popup = popupRef.current;
    if (popup && flight.current.length) return Math.abs(parseFloat(getComputedStyle(popup).translate)) || 0;
    return motion.current ?? rest;
  }, []);

  // Spring to `to` (0 open, width closed) from wherever the panel is, seeded
  // with `velocity` (px/ms toward closed) so a flick carries on without a stall.
  // A Web Animation over pre-sampled spring frames, not a rAF loop: Base UI
  // already holds an exiting popup mounted until its animations finish, the
  // compositor keeps it smooth while a list mounts, and the panel and scrim
  // frames come from the one sampled position. The animations fill forwards so
  // the panel never flickers back to its inline value between the last frame
  // and `onfinish`, which then hands it to the class list's rest position.
  // `enter` is a swipe-open still waiting for React to open (it holds the open
  // position until it has); `abort` is one that fell back closed, so the popup
  // is hidden again at the end and React never hears of it.
  const settle = useCallback((to: number, velocity = 0, mode: "plain" | "enter" | "abort" = "plain") => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    shown.current = to === 0;
    const from = position(to === 0 ? width() : 0);
    stop();
    const popup = popupRef.current;
    if (!popup || typeof popup.animate !== "function" || prefersReducedMotion() || Math.abs(from - to) < 0.5) {
      // Closing keeps the inline position until the dialog reports it closed,
      // so the panel does not flash open before the state change lands.
      motion.current = mode === "enter" ? 0 : mode === "abort" || to === 0 ? null : to;
      paint();
      if (mode === "abort") reveal(false);
      return;
    }
    motion.current = from;
    paint();
    const frames = springFrames(from, to, velocity);
    const total = frames[frames.length - 1].ms;
    const w = width();
    const play = (el: HTMLElement | null | undefined, at: (x: number) => Keyframe) =>
      el?.animate(frames.map((f) => ({ ...at(f.x), offset: f.ms / total })), { duration: total, fill: "forwards" });
    const frac = (x: number) => 1 - x / w;
    const animations = [
      play(popup, (x) => ({
        translate: `${sign * x}px 0`,
        ...(push ? { scale: String(1 - PUSH_SCALE * (1 - Math.min(1, frac(x)))) } : {}),
      })),
      play(backdropRef.current, (x) => ({ opacity: Math.min(1, Math.max(0, frac(x))) })),
      play(shadeRef.current, (x) => ({ opacity: PANEL_SHADE * Math.min(1, Math.max(0, 1 - frac(x))) })),
      play(push?.current, (x) => pushAt(Math.max(0, frac(x)))),
    ].filter((animation): animation is Animation => !!animation);
    flight.current = animations;
    animations[0].onfinish = () => {
      if (flight.current !== animations) return;
      // The held end frame is the open position; onOpenChangeComplete lets go.
      if (mode === "enter" && awaiting.current) return;
      rest();
      if (mode === "abort") reveal(false);
    };
  }, [paint, position, stop, rest, reveal, sign, width, push, pushAt]);

  useLayoutEffect(() => {
    if (open === shown.current) return;
    if (popupRef.current) settle(open ? 0 : width());
    else {
      shown.current = open;
      entering.current = open;
    }
  }, [open, settle, width]);

  useEffect(() => () => {
    stop();
    cancelCommit();
    cancelAnimationFrame(raf.current);
  }, [stop, cancelCommit]);

  useEffect(() => {
    // The left drawer closes toward negative x, the right one toward positive.
    const closeSign = side === "left" ? -1 : 1;

    // Move/end are heard on the touch's own target, not the document: touch
    // events keep targeting the node the finger first landed on, and once that
    // node leaves the DOM (a live turn re-rendering the row under the finger)
    // they no longer bubble to the document. Listening there froze the
    // drawer part-way open with no touchend to settle it.
    let target: EventTarget | null = null;
    const release = () => {
      if (!target) return;
      target.removeEventListener("touchmove", onMove as EventListener);
      target.removeEventListener("touchend", onEnd);
      target.removeEventListener("touchcancel", onEnd);
      target = null;
    };
    const begin = (g: Gesture, node: EventTarget | null) => {
      g.samples.push({ x: g.startX, t: performance.now() });
      gesture.current = g;
      target = node;
      node?.addEventListener("touchmove", onMove as EventListener, { passive: true });
      node?.addEventListener("touchend", onEnd, { passive: true });
      node?.addEventListener("touchcancel", onEnd, { passive: true });
    };

    const onStart = (event: TouchEvent) => {
      // A claimed drag that never heard its end still owes the panel a resting place.
      if (gesture.current?.claimed) onEnd();
      gesture.current = null;
      release();
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (openRef.current) {
        if (!popupRef.current?.contains(event.target as Node)) return;
        begin({ kind: "close", startX: touch.clientX, startY: touch.clientY, claimed: false, samples: [] }, event.target);
        return;
      }
      if (!swipeRef.current) return;
      // A sheet over the chat owns every touch until it closes.
      if (document.documentElement.dataset.sheetOpen) return;
      // Typing, selecting text and opted-out surfaces keep their own drags.
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-swipe-ignore]")) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      begin({ kind: "open", startX: touch.clientX, startY: touch.clientY, claimed: false, samples: [] }, event.target);
    };

    function onMove(event: TouchEvent) {
      const g = gesture.current;
      const touch = event.touches[0];
      if (!g || !touch) return;
      const now = performance.now();
      g.samples.push({ x: touch.clientX, t: now });
      while (g.samples.length > 2 && g.samples[0].t < now - 100) g.samples.shift();
      const dx = touch.clientX - g.startX;
      const dy = touch.clientY - g.startY;
      // Positive when moving the way this gesture wants to go.
      const along = g.kind === "close" ? dx * closeSign : -dx * closeSign;
      if (!g.claimed) {
        if (along <= -FAIL_PX || (Math.abs(dy) > FAIL_PX && Math.abs(dy) > Math.abs(dx))) {
          gesture.current = null;
          return;
        }
        // Opening starts mid-chat, beside scrolling text: demand a clearly
        // horizontal swipe, not just a diagonal one that leans sideways.
        const ratio = g.kind === "open" ? 1.5 : 1;
        if (along < INTENT_PX || Math.abs(dx) <= Math.abs(dy) * ratio) return;
        // A finger moving right scrolls content toward its start.
        if (scrollsAlong(event.target, g.kind === "close" ? popupRef.current : null, dx > 0)) {
          gesture.current = null;
          return;
        }
        g.claimed = true;
        cancelCommit();
        // Grabbing a panel mid-spring carries on from where it is, not from rest.
        const grabbed = flight.current.length ? position(0) : null;
        stop();
        g.origin = grabbed ?? (g.kind === "close" ? 0 : width());
        if (g.kind === "open") {
          // The keyboard goes now, while the drawer covers the resize, not mid-spring when the panel takes focus.
          const focused = document.activeElement;
          if (focused instanceof HTMLElement && focused.matches("input, textarea, [contenteditable='true']")) focused.blur();
          motion.current = g.origin;
          paint();
          if (popupRef.current) {
            // Mounted already (keepMounted): show it and drive it in the DOM;
            // React hears of the open on release.
            g.deferred = true;
            reveal(true);
          } else {
            // Not mounted yet: it mounts on this open and its ref callback paints the offset.
            shown.current = true;
            onOpenChangeRef.current(true);
          }
        }
      }
      const travelled = Math.min(width(), Math.max(0, along - INTENT_PX));
      // One DOM write per frame, not one React render per touchmove.
      motion.current = Math.min(width(), Math.max(0, (g.origin ?? 0) + (g.kind === "close" ? travelled : -travelled)));
      if (!raf.current) raf.current = requestAnimationFrame(paint);
    }

    function onEnd() {
      const g = gesture.current;
      gesture.current = null;
      release();
      if (!g?.claimed) return;
      // Panel offset grows toward closed, which is closeSign along x.
      const velocity = releaseVelocity(g.samples, performance.now()) * closeSign;
      const to = drawerTarget(motion.current ?? 0, width(), velocity);
      if (g.deferred) {
        if (to === 0) {
          settle(0, velocity, "enter");
          commitLater(true);
        } else settle(width(), velocity, "abort");
        return;
      }
      settle(to, velocity);
      if (to !== 0) commitLater(false);
    }

    document.addEventListener("touchstart", onStart, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      release();
    };
  }, [settle, width, side, paint, position, stop, reveal, cancelCommit, commitLater]);

  const back = {
    onProgress: (progress: number) => {
      cancelAnimationFrame(raf.current);
      stop();
      motion.current = progress * BACK_PREVIEW * width();
      paint();
    },
    onCancel: () => settle(0),
    // The dialog closes itself right after this; leave from the preview.
    onCommit: () => settle(width()),
  };

  // The spring can overshoot the open position by a sub-pixel; a
  // background-coloured shadow on the SCREEN-EDGE side fills the gap that
  // would open there. (It once sat on the inner side, where it drew a 24px
  // dark band between the chat and the panel.) No hairline ring: the panel
  // is set apart by its shadow and rounded edge, not a border.
  const bleed = `${sign * 24}px 0 0 0 var(--color-${side === "left" ? "surface-1" : "background"})`;
  const panelStyle: CSSProperties = {
    width: `min(${size.vw * 100}vw, ${size.max}px)`,
    // Pushing, the screen abuts the panel and the veil sets it apart; a shadow would only smudge its edge.
    boxShadow: push ? bleed : `0 0 48px -8px oklch(0 0 0 / 0.6), ${bleed}`,
  };

  const setPopup = useCallback((node: HTMLDivElement | null) => {
    popupRef.current = node;
    if (!node) return;
    // A programmatic open of a popup that mounts late springs in from closed.
    if (entering.current) {
      entering.current = false;
      settle(0);
    } else paint();
  }, [paint, settle]);
  const setBackdrop = useCallback((node: HTMLDivElement | null) => {
    backdropRef.current = node;
    if (node) paint();
  }, [paint]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      onOpenChangeComplete={(next) => {
        // A drag or back swipe that closed the panel left its position
        // inline; the next open must start from the spring again.
        if (!next) {
          stop();
          motion.current = null;
          paint();
        } else if (!gesture.current?.claimed && flight.current.every((a) => a.playState === "finished")) {
          // A swipe-open held the open position until React caught up.
          rest();
        }
      }}
      back={back}
    >
      <DialogPortal keepMounted={keepMounted}>
        {/* A lighter scrim than a sheet's: the chat beside a drawer is the
            context it was opened from and must stay readable, not go black. */}
        {/* will-change: the scrim and panel get compositor layers of their own. Without them every drag
            frame repainted the whole transcript under the drawer (a 390x3727 paint per frame, traced). */}
        <DialogPrimitive.Backdrop
          className={cn(
            "fixed inset-0 z-overlay will-change-[opacity] data-starting-style:opacity-0 data-ending-style:opacity-0",
            // Pushing, DeepSeek's veil: a faint lift in the drawer's light, not a black scrim.
            push ? "bg-[oklch(1_0_0/0.06)]" : "bg-[oklch(0_0_0/0.38)]",
          )}
          ref={setBackdrop}
        />
        <DialogPrimitive.Popup
          ref={setPopup}
          aria-label={label}
          data-testid={testId}
          initialFocus={popupRef}
          tabIndex={-1}
          className={cn(
            // The left drawer is ChatGPT's #212121 sheet over the black chat.
            "fixed inset-y-0 z-overlay flex flex-col overflow-hidden outline-none touch-pan-y will-change-[translate,scale]",
            side === "left" ? "bg-surface-1" : "bg-background",
            "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
            side === "left"
              ? cn("left-0 pl-[env(safe-area-inset-left)] data-starting-style:-translate-x-full data-ending-style:-translate-x-full", push ? "border-r border-border" : "rounded-r-xl")
              : cn("right-0 pr-[env(safe-area-inset-right)] data-starting-style:translate-x-full data-ending-style:translate-x-full", push ? "border-l border-border" : "rounded-l-xl"),
          )}
          style={panelStyle}
        >
          {children}
          {push && <div ref={shadeRef} aria-hidden className="pointer-events-none absolute inset-0 bg-black opacity-0 will-change-[opacity]" />}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
