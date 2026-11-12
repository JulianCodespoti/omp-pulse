"use client";

import * as React from "react";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { InboxIcon, SearchIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { haptic } from "@/platform/haptic";
import { prefersReducedMotion } from "@/platform/appearance";
import { SETTLE, springFrames, springKeyframes } from "./motion";
import { EmptyState } from "@/app/ui/EmptyState";
import { Notice } from "@/app/ui/Notice";
import { ScreenActivityContext } from "../nav/screen-activity";

// BottomSheet — single unified sheet shell
// Shape: bottom-anchored, rounded-t-xl, full width, height fits its content up
//  to 88dvh (a two-row sheet is two rows tall, not a third of the screen),
//  refined grab handle centred at top, safe-area bottom padding.
// Header: title left (text-ui/500: the sheet's rows are the content, not its
//  name), optional purpose subtitle below it, single 20px close on the right.
//  The row is items-start and the title sits in a 44 px line box, so the X is
//  level with the title whether or not a subtitle exists.
// Body: a plain overflow container with px-4; rows via `ui/Row` in callers.
// Footer: optional sticky bottom area with safe-area; lay actions out with
//  `SheetFooter`.
// Dismissal: scrim tap (Dialog) + handle/header swipe down + velocity flick —
//   scrim fades in sync with panel so sheet never floats over undimmed page.
// Stacking: scrim z-overlay, panel z-sheet — panel must stay above scrim.
//
// Motion: enter `sheet-in` over --dur-panel on --ease-sheet, a spring that
//   overshoots ~3% (a solid shadow below the sheet fills the gap the lift
//   opens); exit `sheet-out 240ms` on --ease-smooth (no bounce on the way
//   out). Scrim `scrim-in`/`scrim-out` on the same timings so
//   scrim and panel finish together. Keyframes live in styles.css; the global
//   prefers-reduced-motion rule neutralises their durations.
//  - Drag: distance OR velocity closes; rubber-band past 64 px; snap-back
//    springs with the same curve instead of teleporting; hit zone is the whole
//    header+handle (≥44 px), plus the scroll viewport when at scrollTop 0.

export function captureSheetOpener(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  // A menu closes when its sheet opens, removing the focused item.
  // Base UI labels the menu with the surviving trigger's id.
  const menu = active?.closest('[role="menu"]');
  const triggerId = menu?.getAttribute("aria-labelledby");
  return (triggerId ? document.getElementById(triggerId) : null) ?? active;
}

export type BottomSheetProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  /**
   * Optional subtitle naming WHICH session/place the sheet acts on (a project
   * name, a folder). Never a raw id, never a restatement of the title. When
   * omitted no description node is rendered (A11Y-12).
   */
  description?: string;
  /** Optional extra actions rendered immediately left of the close affordance (e.g. Copy/Download). */
  headerActions?: React.ReactNode;
  /** Optional control rendered left of the title (e.g. a back button). */
  leading?: React.ReactNode;
  /** Optional non-scrolling sub-header anchored below the main header (e.g. breadcrumbs). */
  subHeader?: React.ReactNode;
  /** Main scrollable body. */
  children: React.ReactNode;
  /** Optional sticky footer (e.g. primary CTA). Safe-area padding is applied automatically. */
  footer?: React.ReactNode;
  /** Optional data-testid forwarded to DialogContent */
  testId?: string;
  /** Explicit focus ownership for sheets replaced during lazy loading. */
  returnFocus?: () => HTMLElement | false;
  /**
   * Drop the header X when the footer already holds every exit (ConfirmSheet:
   * Cancel + confirm). Scrim tap, swipe, Escape and Back still close it.
   */
  hideClose?: boolean;
};

// Drag constants
const DISTANCE_THRESHOLD = 64;
const VELOCITY_THRESHOLD = 0.6; // px/ms over last ~80 ms
const RUBBER_FRICTION = 0.35;
const RUBBER_START = 64;
const DRAG_MAX = 180;
// How far a predictive back swipe lowers the sheet at full progress.
const BACK_PREVIEW_MAX = 96;

export function BottomSheet({
  open: requestedOpen,
  onOpenChange: requestedOpenChange,
  title,
  description,
  headerActions,
  leading,
  subHeader,
  children,
  footer,
  testId,
  returnFocus,
  hideClose = false,
}: BottomSheetProps) {
  const active = React.useContext(ScreenActivityContext);
  const open = requestedOpen && active;
  const onOpenChange = React.useCallback((next: boolean) => {
    if (active) requestedOpenChange(next);
  }, [active, requestedOpenChange]);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const closeBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const visitOpenRef = React.useRef(false);
  const lastFocusRef = React.useRef<HTMLElement | null>(null);
  const resumeFocusRef = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (!requestedOpen) {
      lastFocusRef.current = null;
      resumeFocusRef.current = null;
    } else if (!active) {
      // The portal is hidden before layout effects run; a browser may already
      // have blurred it. Remember focus from events, not only activeElement.
      resumeFocusRef.current = lastFocusRef.current;
    }
  }, [active, requestedOpen]);

  // Drag state
  const startYRef = React.useRef<number | null>(null);
  const startTRef = React.useRef<number | null>(null);
  const historyRef = React.useRef<Array<{ y: number; t: number }>>([]);
  const draggingRef = React.useRef(false);
  const scrollDragArmedRef = React.useRef(false);
  const [isDragging, setIsDragging] = React.useState(false);
  // The finger-follow path never touches React state: moves write the panel's
  // transform and the scrim's opacity straight to the DOM, one write per frame.
  const dragYRef = React.useRef(0);
  const rafRef = React.useRef(0);
  const settleTimerRef = React.useRef<number | undefined>(undefined);
  // The settle runs as a WAAPI spring so it can start at the finger's release
  // velocity; anything that takes the panel back (a new drag, a close) cancels
  // it, or `fill: forwards` would overrule the inline transform.
  const settleAnimationsRef = React.useRef<Animation[]>([]);
  const backdropRef = React.useRef<HTMLDivElement | null>(null);
  const stopSettle = React.useCallback(() => {
    for (const animation of settleAnimationsRef.current) animation.cancel();
    settleAnimationsRef.current = [];
  }, []);
  const paint = React.useCallback(() => {
    rafRef.current = 0;
    stopSettle();
    const y = dragYRef.current;
    const p = panelRef.current?.style;
    if (p) {
      p.transition = "none";
      p.transform = y > 0 ? `translateY(${y}px)` : "";
    }
    // The scrim follows the finger: fully dim at rest, clear at DRAG_MAX.
    const s = backdropRef.current?.style;
    if (s) {
      s.transition = "none";
      s.opacity = y > 0 ? String(Math.max(0.2, 1 - y / (DRAG_MAX * 1.4))) : "";
    }
  }, []);
  const queuePaint = React.useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(paint);
  }, [paint]);
  const clearInline = React.useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    window.clearTimeout(settleTimerRef.current);
    stopSettle();
    dragYRef.current = 0;
    const p = panelRef.current?.style;
    if (p) {
      p.transform = "";
      p.transition = "";
    }
    const s = backdropRef.current?.style;
    if (s) {
      s.opacity = "";
      s.transition = "";
    }
  }, [stopSettle]);
  React.useEffect(() => clearInline, [clearInline]);
  // Where the exit animation starts. A flick-to-dismiss used to reset the drag
  // to 0 and then play the exit from the resting position, so the sheet
  // jumped back up under the finger before falling away. The exit keyframe
  // reads `--sheet-from`; it is only cleared when the sheet next opens.
  const [closeFrom, setCloseFrom] = React.useState(0);
  // Content scrolled under the title gets a hairline edge, so rows never look
  // sliced flat against the header.
  const [scrolled, setScrolled] = React.useState(false);

  // INVARIANT: focus must return to the element that opened the sheet (A11Y-09).
  // Base UI restores focus automatically when initialFocus is not forced to the
  // panel. We store the trigger on open and restore on close after the exit
  // animation so keyboard users do not land on the Back button. A later focus
  // owner supersedes that fallback; an outgoing sheet must never reclaim focus.
  React.useEffect(() => {
    let cancelRestore: (() => void) | undefined;
    // An explicit owner delegates restoration to Base UI, without a competing
    // delayed focus timer from the outgoing loading/error shell.
    if (open) {
      setCloseFrom(0);
      setScrolled((scrollRef.current?.scrollTop ?? 0) > 0);
      if (!visitOpenRef.current) {
        const focused = document.activeElement as HTMLElement | null;
        // Don't capture focus that is already inside the dialog portal.
        triggerRef.current = !returnFocus && focused && !focused.closest("[data-slot='dialog-portal']")
          ? focused : null;
      }
      visitOpenRef.current = true;
    } else {
      const t = triggerRef.current;
      const panel = panelRef.current;
      const ownsFocus = (active: Node | null = document.activeElement) => {
        return !active || active === document.body || active === t || !!panel?.contains(active);
      };
      if (active && !returnFocus && t?.isConnected && ownsFocus()) {
        // Delay until after the exit, but relinquish ownership permanently if
        // another control takes focus, even if it blurs before the timer fires.
        const onFocus = (event: FocusEvent) => {
          // Capture the new owner even if its handler blurs synchronously or
          // stops bubbling before document.activeElement can be inspected.
          if (event.target instanceof Node && !ownsFocus(event.target)) cancelRestore?.();
        };
        const timer = window.setTimeout(() => {
          cancelRestore?.();
          if (!t.isConnected || !ownsFocus()
            || Number(document.documentElement.dataset.sheetOpen ?? 0) > 0) return;
          try {
            t.focus();
          } catch {
            // An opener can become unfocusable during the exit.
          }
        }, 260);
        cancelRestore = () => {
          window.clearTimeout(timer);
          document.removeEventListener("focusin", onFocus, true);
          window.removeEventListener("popstate", cancelRestore!);
          window.removeEventListener("hashchange", cancelRestore!);
        };
        document.addEventListener("focusin", onFocus, true);
        window.addEventListener("popstate", cancelRestore);
        window.addEventListener("hashchange", cancelRestore);
      }
      if (!requestedOpen) {
        triggerRef.current = null;
        visitOpenRef.current = false;
      }
      // also reset any drag state when the sheet closes externally
      draggingRef.current = false;
      startYRef.current = null;
      startTRef.current = null;
      historyRef.current = [];
      scrollDragArmedRef.current = false;
      clearInline();
      setIsDragging(false);
    }
    // Reopen, owner replacement and session unmount invalidate this visit.
    return () => cancelRestore?.();
  }, [active, open, requestedOpen, returnFocus, clearInline]);

  // `html[data-sheet-open]` counts open sheets. Focus restoration above reads
  // it so an outgoing sheet never steals focus from a successor sheet, and
  // styles can key off it. A count, not a boolean: sheets open over sheets.
  React.useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.dataset.sheetOpen = String(Number(root.dataset.sheetOpen ?? 0) + 1);
    return () => {
      const left = Number(root.dataset.sheetOpen ?? 1) - 1;
      if (left <= 0) delete root.dataset.sheetOpen;
      else root.dataset.sheetOpen = String(left);
    };
  }, [open]);

  const resetDrag = React.useCallback(() => {
    draggingRef.current = false;
    startYRef.current = null;
    startTRef.current = null;
    historyRef.current = [];
    scrollDragArmedRef.current = false;
    clearInline();
    setIsDragging(false);
  }, [clearInline]);

  // Snap back with the shared spring — do not teleport (MOTION-04). It starts
  // at the finger's release velocity, so letting go of a fast drag continues
  // the motion instead of stopping dead for a frame the way a CSS transition
  // starting at velocity 0 does.
  const snapBack = React.useCallback((velocity = 0) => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    window.clearTimeout(settleTimerRef.current);
    stopSettle();
    const from = dragYRef.current;
    dragYRef.current = 0;
    const panel = panelRef.current;
    if (!panel || typeof panel.animate !== "function" || prefersReducedMotion() || Math.abs(from) < 0.5) {
      resetDrag();
      return;
    }
    const dim = (y: number) => Math.max(0, 1 - y / DRAG_MAX);
    const frames = springFrames(from, 0, velocity, SETTLE);
    const move = springKeyframes(frames, (y) => ({ transform: `translateY(${y}px)` }));
    const animations = [panel.animate(move.keyframes, { duration: move.duration, fill: "forwards" })];
    const backdrop = backdropRef.current;
    if (backdrop) {
      const fade = springKeyframes(frames, (y) => ({ opacity: String(dim(y)) }));
      animations.push(backdrop.animate(fade.keyframes, { duration: fade.duration, fill: "forwards" }));
    }
    settleAnimationsRef.current = animations;
    settleTimerRef.current = window.setTimeout(resetDrag, move.duration);
  }, [resetDrag, stopSettle]);

  // Android predictive back: the sheet lowers with the system swipe exactly as
  // it does under a finger drag, springs back if the swipe is abandoned, and
  // on commit leaves from where the swipe put it (see `closeFrom`).
  const backOffsetRef = React.useRef(0);
  const back = React.useMemo(
    () => ({
      onProgress: (progress: number) => {
        backOffsetRef.current = progress * BACK_PREVIEW_MAX;
        cancelAnimationFrame(rafRef.current);
        window.clearTimeout(settleTimerRef.current);
        dragYRef.current = backOffsetRef.current;
        paint();
      },
      onCancel: () => {
        backOffsetRef.current = 0;
        snapBack();
      },
      onCommit: () => {
        setCloseFrom(backOffsetRef.current);
        backOffsetRef.current = 0;
        resetDrag();
      },
    }),
    [paint, resetDrag, snapBack],
  );

  const computeEffective = React.useCallback((delta: number): number => {
    if (delta <= RUBBER_START) return delta;
    const over = delta - RUBBER_START;
    return Math.min(RUBBER_START + over * RUBBER_FRICTION, DRAG_MAX);
  }, []);

  const computeVelocity = React.useCallback((): number => {
    const h = historyRef.current;
    if (h.length < 2) return 0;
    const last = h[h.length - 1];
    // window of ~80 ms
    const windowStart = last.t - 80;
    let first = h[0];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= windowStart) {
        first = h[i];
        break;
      }
      if (i === 0) first = h[i];
    }
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    const dy = last.y - first.y;
    return dy / dt; // px/ms, positive = downward
  }, []);

  const onPointerDown = React.useCallback((clientY: number, fromScrollViewport: boolean) => {
    // If the drag originates from the scroll viewport, only arm it — the
    // actual drag starts on move when we confirm scrollTop === 0 and
    // delta > 0. From the header/handle zone we start dragging immediately.
    if (fromScrollViewport) {
      scrollDragArmedRef.current = true;
      startYRef.current = clientY;
      startTRef.current = performance.now();
      historyRef.current = [{ y: clientY, t: performance.now() }];
      return;
    }
    startYRef.current = clientY;
    startTRef.current = performance.now();
    historyRef.current = [{ y: clientY, t: performance.now() }];
    draggingRef.current = true;
    setIsDragging(true);
    window.clearTimeout(settleTimerRef.current);
    stopSettle();
  }, [stopSettle]);

  const onPointerMove = React.useCallback(
    (clientY: number) => {
      const now = performance.now();

      // Handle scroll-viewport armed drag: only start dragging if the viewport
      // is at the top and the finger is moving down. Otherwise let the
      // viewport scroll naturally.
      if (scrollDragArmedRef.current && !draggingRef.current) {
        const sY = startYRef.current;
        if (sY == null) return;
        const delta = clientY - sY;
        const scrollTop = scrollRef.current?.scrollTop ?? 0;
        if (delta > 8 && scrollTop <= 0) {
          draggingRef.current = true;
          setIsDragging(true);
          window.clearTimeout(settleTimerRef.current);
        } else if (delta < -4 || scrollTop > 0) {
          // Finger moved up or viewport is scrollable — this is a scroll, not a drag.
          scrollDragArmedRef.current = false;
          startYRef.current = null;
          historyRef.current = [];
          return;
        } else {
          // Still within threshold, keep arming.
          historyRef.current.push({ y: clientY, t: now });
          if (historyRef.current.length > 12) historyRef.current.shift();
          return;
        }
      }

      if (!draggingRef.current || startYRef.current == null) return;
      const delta = clientY - startYRef.current;
      if (delta <= 0) {
        dragYRef.current = 0;
        queuePaint();
        return;
      }
      dragYRef.current = computeEffective(delta);
      queuePaint();
      historyRef.current.push({ y: clientY, t: now });
      if (historyRef.current.length > 12) historyRef.current.shift();
      // Keep only last ~100 ms of history
      const cutoff = now - 120;
      while (historyRef.current.length > 2 && historyRef.current[0].t < cutoff) {
        historyRef.current.shift();
      }
    },
    [computeEffective, queuePaint],
  );

  const onPointerUp = React.useCallback(() => {
    // If we were only armed from the scroll viewport and never started dragging,
    // just reset the arm.
    if (scrollDragArmedRef.current && !draggingRef.current) {
      scrollDragArmedRef.current = false;
      startYRef.current = null;
      historyRef.current = [];
      return;
    }
    if (!draggingRef.current) return;
    const dragY = dragYRef.current;
    const velocity = computeVelocity();
    const shouldClose = dragY > DISTANCE_THRESHOLD || velocity > VELOCITY_THRESHOLD;
    if (shouldClose) {
      setCloseFrom(dragY);
      onOpenChange(false);
      // reset immediately; the exit animation takes over from `closeFrom`
      resetDrag();
    } else {
      snapBack(velocity);
    }
  }, [computeVelocity, onOpenChange, resetDrag, snapBack]);

  // Touch handlers for the header/handle zone (and scroll viewport when needed)
  const handleHeaderTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    // Don't start a drag when the close button, header actions or leading slot are the target
    if (target.closest('[data-testid="sheet-close"]') || target.closest("[data-sheet-header-action]")) return;
    onPointerDown(e.touches[0].clientY, false);
  };
  const handleHeaderTouchMove = (e: React.TouchEvent) => {
    if (!draggingRef.current && !scrollDragArmedRef.current) return;
    // Prevent the page from scrolling while dragging the sheet
    if (draggingRef.current) e.preventDefault();
    onPointerMove(e.touches[0].clientY);
  };
  const handleHeaderTouchEnd = () => onPointerUp();

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-testid="sheet-close"]') || target.closest("[data-sheet-header-action]")) return;
    if (e.button !== 0) return;
    onPointerDown(e.clientY, false);
  };

  const handleScrollTouchStart = (e: React.TouchEvent) => {
    // Only arm a viewport drag when at the very top
    const top = scrollRef.current?.scrollTop ?? 0;
    if (top > 0) return;
    onPointerDown(e.touches[0].clientY, true);
  };
  const handleScrollTouchMove = (e: React.TouchEvent) => {
    if (!scrollDragArmedRef.current && !draggingRef.current) return;
    if (draggingRef.current) e.preventDefault();
    onPointerMove(e.touches[0].clientY);
  };
  const handleScrollTouchEnd = () => onPointerUp();

  React.useEffect(() => {
    if (!isDragging) return;
    const onMove = (ev: MouseEvent) => onPointerMove(ev.clientY);
    const onUp = () => onPointerUp();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, onPointerMove, onPointerUp]);

  const panelStyle = { "--sheet-from": `${closeFrom}px` } as React.CSSProperties;

  return (
    <Dialog open={open} modal={active} onOpenChange={onOpenChange} back={back}>
      {/* Keep this visit's DOM through suspension and reactivation. Let normal
          closes unmount after their exit animation, as before. */}
      <DialogPortal keepMounted={requestedOpen} hidden={!active} inert={!active} aria-hidden={!active || undefined}>
        <DialogPrimitive.Backdrop
          data-sheet-backdrop
          // forceRender: Base UI skips the backdrop of a dialog nested in
          // another, so a sheet (or ConfirmSheet) opened over a sheet left the
          // first sheet's rows undimmed and tappable-looking behind it.
          forceRender
          className="fixed inset-0 z-overlay bg-scrim data-open:animate-[scrim-in_320ms_var(--ease-sheet)_both] data-closed:animate-[scrim-out_240ms_var(--ease-sheet)_both]"
          ref={backdropRef}
        />
        <DialogPrimitive.Popup
          data-testid={testId}
          data-sheet-panel
          // The panel itself takes initial focus on a tap: screen readers enter
          // the dialog at its top, and no control wears a focus ring nobody
          // asked for. A keyboard open lands on the close button (when the
          // sheet has one). Base UI still returns focus to the trigger on
          // close (A11Y-09).
          onFocusCapture={(event) => { lastFocusRef.current = event.target as HTMLElement; }}
          initialFocus={(openType) => {
            if (!active) return false;
            const target = resumeFocusRef.current;
            resumeFocusRef.current = null;
            if (target?.isConnected && panelRef.current?.contains(target)) {
              const scrollTop = scrollRef.current?.scrollTop ?? 0;
              target.focus({ preventScroll: true });
              if (scrollRef.current) scrollRef.current.scrollTop = scrollTop;
              return false;
            }
            return openType === "keyboard" && closeBtnRef.current ? closeBtnRef.current : panelRef.current;
          }}
          finalFocus={!active ? false : returnFocus ? () => {
            const target = returnFocus();
            const active = document.activeElement;
            // Explicit finalFocus bypasses Base UI's moved-focus guard. Keep
            // a successor dialog/control in charge during an animated exit.
            if (active && active !== document.body && active !== target
              && !panelRef.current?.contains(active)) return false;
            return target;
          } : undefined}
          ref={panelRef}
          tabIndex={-1}
          className="z-sheet fixed !left-0 !right-0 !top-auto !bottom-0 !translate-x-0 !translate-y-0 !max-w-none flex h-auto max-h-[88dvh] w-full flex-col gap-0 overflow-hidden rounded-t-xl rounded-b-none bg-surface-1 p-0 shadow-[0_-1px_0_oklch(1_0_0/0.07),0_-24px_48px_-24px_oklch(0_0_0/0.6),0_48px_0_0_var(--surface-1)] data-open:animate-[sheet-in_var(--dur-panel)_var(--ease-sheet)_both] data-closed:animate-[sheet-out_240ms_var(--ease-smooth)_both] outline-none"
          style={panelStyle}
        >
          {/* Drag zone — header + handle share one 48 px+ hit area (MOTION-06, TOUCH-10).
              The visual handle pill is centred in a 32 px tall transparent strip so
              the thumb never has to hit a 22 px target. 12 px separation from the
              close button is enforced by the header's gap. */}
          <div
            className="flex shrink-0 flex-col touch-none select-none"
            onTouchStart={handleHeaderTouchStart}
            onTouchMove={handleHeaderTouchMove}
            onTouchEnd={handleHeaderTouchEnd}
            onMouseDown={handleHeaderMouseDown}
            role="presentation"
          >
            {/* Grab handle — 20 px strip, M3 drag handle 32×4 */}
            <div className="flex h-5 shrink-0 items-end justify-center" aria-hidden="true">
              <div className="h-1 w-9 rounded-full bg-foreground/25" />
            </div>

            {/* Header — part of the same drag zone so the whole top edge drags.
                Edge padding and the 48px row are fixed px: at 150% text the
                title grows a little (capped at 26px), the chrome does not. */}
            <div className="flex shrink-0 items-start justify-between gap-2 px-[16px] pb-2 pt-2">
              {leading ? (
                <span className="flex min-h-[48px] shrink-0 items-center" data-sheet-header-action>
                  {leading}
                </span>
              ) : null}
              <DialogHeader className="min-w-0 flex-1 gap-0 p-0 text-left">
                <DialogTitle className="flex min-h-[48px] items-center text-title font-semibold">
                  <span data-testid="sheet-title-text" title={title} className="line-clamp-2 break-words [overflow-wrap:anywhere]">{title}</span>
                </DialogTitle>
                {description ? (
                  <DialogDescription data-testid="sheet-description" title={description} className="mt-0.5 line-clamp-2 break-words text-meta font-normal text-muted-foreground [overflow-wrap:anywhere]">{description}</DialogDescription>
                ) : null}
              </DialogHeader>
              <div className="flex shrink-0 items-center gap-1" data-sheet-header-action>
                {headerActions ? <span data-sheet-header-action>{headerActions}</span> : null}
                {hideClose ? null : (
                  <Button
                    ref={closeBtnRef}
                    variant="ghost"
                    size="icon"
                    className="size-[48px] text-muted-foreground hover:text-foreground"
                    onClick={() => onOpenChange(false)}
                    aria-label="Close"
                    data-testid="sheet-close"
                  >
                    <XIcon aria-hidden className="size-5" strokeWidth={1.5} />
                  </Button>
                )}
              </div>
            </div>
          </div>

          {subHeader ? <div className="shrink-0">{subHeader}</div> : null}

          {/*
            A plain overflow container, NOT Base UI's ScrollArea.

            ScrollArea's viewport is `size-full`, i.e. `height: 100%`. A
            percentage height resolves against the parent's height, and this
            popup's height is INDEFINITE — `h-auto` bounded only by
            `max-h-[85dvh]`. So the percentage fell back to auto, the viewport
            grew to its own content, and nothing ever overflowed: measured on
            the emulator, the timeline scroller reported scrollHeight 2076 and
            clientHeight 2076. With no overflow there is nothing to scroll, and
            the popup's `overflow-hidden` silently clipped everything past
            85dvh — so the sheet looked scrollable and simply was not, which is
            exactly the "can't scroll in Timeline and Agents" report.

            `min-h-0 flex-1 overflow-y-auto` on an in-flow div is the shape
            RecentDrawer and CollabDialog already use, and both scroll
            reliably. It keeps hug-content for short sheets, because the div
            still contributes its content height until flex clamps it.

            The data-slot is retained: TimelineSheet:227 finds this element to
            attach its load-earlier paging listener.

            Touch handling: when scrollTop === 0 a downward swipe initiates a
            sheet drag instead of scrolling (MOTION-06).
          */}
          <div
            ref={scrollRef}
            data-slot="scroll-area-viewport"
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y border-t transition-colors duration-150 [-webkit-overflow-scrolling:touch]",
              scrolled ? "border-hairline" : "border-transparent",
            )}
            onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
            onTouchStart={handleScrollTouchStart}
            onTouchMove={handleScrollTouchMove}
            onTouchEnd={handleScrollTouchEnd}
          >
            {/* `clip`, not `hidden`: overflow-x:hidden makes this div a scroll
                container (overflow-y computes to auto), which breaks
                `position: sticky` headers inside sheets (ModelPicker groups). */}
            <div className="min-w-0 overflow-x-clip px-4 pb-4 pt-2">{children}</div>
          </div>

          {footer ? (
            <div className="shrink-0 border-t border-hairline bg-surface-1 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">{footer}</div>
          ) : (
            // safe-area for sheets without a footer — pad the scroll viewport bottom via spacer
            <div className="shrink-0 pb-[env(safe-area-inset-bottom)]" aria-hidden="true" />
          )}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shared state treatments — identical loading / empty / error in all sheets
// ---------------------------------------------------------------------------

export function SheetLoading({ label = "Loading…" }: { label?: string }) {
  // Nothing for the first 180 ms so a fast fetch never flashes (MOTION-09),
  // then a small spinner. No pulsing skeleton: one busy indicator at a time.
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const t = window.setTimeout(() => setVisible(true), 180);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-meta text-muted-foreground" aria-label={label} aria-busy="true">
      {visible ? <Spinner /> : null}
      <span className={visible ? undefined : "sr-only"}>{label}</span>
    </div>
  );
}

/** A section label inside sheets for content that is not a RowGroup (whose `title` is its label). */
/**
 * A sheet's empty body, drawn by the one EmptyState so every sheet's first
 * run looks the same. `action` is a ready control (a button, a link row).
 */
export function SheetEmpty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center">
      <EmptyState icon={icon ?? <InboxIcon />} title={title} description={description} className="py-8" />
      {action ? <div className="-mt-4 pb-6">{action}</div> : null}
    </div>
  );
}

/** A sheet's load failure: the one in-context notice, with Retry when it can. */
export function SheetError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Notice tone="danger" className="my-2" action={onRetry ? { label: "Retry", onClick: onRetry } : undefined}>
      {message}
    </Notice>
  );
}

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("pb-2 pt-4 text-meta font-medium text-muted-foreground first:pt-0", className)}>{children}</p>;
}


/**
 * Flat list group on the sheet canvas. Rows and section headings share the
 * shell gutter; only separators and interaction states add visual structure.
 */
export function SheetGroup({ children, className, footnote, testId }: { children: React.ReactNode; className?: string; footnote?: React.ReactNode; testId?: string }) {
  // Inset hairlines between rows only; no border-y closing the group.
  return (
    <div className={className}>
      <div data-slot="sheet-group" data-testid={testId} className="divide-y divide-hairline [&_[data-slot=sheet-row]]:rounded-none [&_[data-slot=sheet-row]]:px-0">
        {children}
      </div>
      {footnote ? <p className="pt-2 text-caption text-muted-foreground">{footnote}</p> : null}
    </div>
  );
}

/**
 * The one tappable list row in sheets: borderless, optional leading icon,
 * title + one meta line, optional trailing slot. 48dp minimum, surface-3 on
 * press, and a calm surface when `selected` (never a tick). Title 16 / meta
 * 14, the same pair as ListRow, so rows read the same in every sheet.
 */
export function SheetRow({
  icon,
  title,
  meta,
  trailing,
  selected,
  onClick,
  disabled,
  className,
  testId,
  ariaLabel,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const body = (
    <>
      {icon ? <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-5">{icon}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body text-foreground">{title}</span>
        {meta ? <span className="truncate text-meta text-muted-foreground">{meta}</span> : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">{trailing}</span> : null}
    </>
  );
  const cls = cn(
    "flex min-h-12 w-full min-w-0 items-center gap-4 rounded-lg px-0 py-2 text-left transition-colors",
    selected && "bg-surface-3",
    onClick && "pressable active:bg-surface-3 hover:bg-surface-3/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-50",
    className,
  );
  return onClick ? (
    <button type="button" data-slot="sheet-row" className={cls} onClick={onClick} disabled={disabled} data-testid={testId} aria-label={ariaLabel} aria-current={selected ? "true" : undefined}>
      {body}
    </button>
  ) : (
    <div data-slot="sheet-row" className={cls} data-testid={testId} aria-label={ariaLabel}>
      {body}
    </div>
  );
}

/** The one search field in sheets (the model picker's look, without cmdk). */
export function SheetSearch({
  value,
  onChange,
  placeholder,
  testId,
  className,
  onKeyDown,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId?: string;
  className?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoFocus?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    // The one field recipe: 44px, 12px radius, borderless surface-2
    // on the sheet canvas; focus is a 1px ring-coloured border, not a halo.
    <div className={cn("flex h-11 items-center gap-2 rounded-lg border border-transparent bg-surface-2 pl-3 transition-colors focus-within:border-ring", value ? "pr-1" : "pr-4", className)}>
      <label className="flex h-full min-w-0 flex-1 items-center gap-2">
        <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={autoFocus}
          data-testid={testId}
          className="h-full min-w-0 flex-1 bg-transparent text-body outline-hidden placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
      {value ? (
        <button type="button" aria-label="Clear search"
          className="pressable flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => { onChange(""); inputRef.current?.focus(); }}>
          <XIcon aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Action layout for a sheet's `footer`: full-width buttons stacked in the
 * order given (primary first), 8px apart.
 */
export function SheetFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div data-slot="sheet-footer" className={cn("flex flex-col gap-2 [&>*]:w-full", className)}>{children}</div>;
}

export type ConfirmSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "<Verb> <object>?" */
  title: string;
  /** One consequence sentence. */
  description: React.ReactNode;
  confirmLabel: string;
  /** danger for anything that destroys or revokes; primary otherwise. */
  tone?: "danger" | "primary";
  onConfirm: () => void;
  /** While the confirmed action runs: both buttons disable and the confirm shows `busyLabel`. */
  busy?: boolean;
  busyLabel?: string;
  cancelLabel?: string;
  /** Extra content under the description (an inline Notice after a failure). */
  children?: React.ReactNode;
  testId?: string;
};

/**
 * The one confirmation. A sheet from the bottom, like every other choice in
 * the app, replacing the centred alert and the inline "tap again to confirm"
 * boxes, which each confirmed differently. The caller stays in charge of
 * `open`: confirm does not close it, so an async action can show `busy` and
 * then close (or keep it open with an error in `children`).
 */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = "danger",
  onConfirm,
  busy = false,
  busyLabel,
  cancelLabel = "Cancel",
  children,
  testId,
}: ConfirmSheetProps) {
  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => { if (!busy || next) onOpenChange(next); }}
      title={title}
      testId={testId}
      hideClose
      footer={
        <SheetFooter>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            disabled={busy}
            data-testid="confirm-sheet-confirm"
            onClick={() => {
              if (tone === "danger") haptic("warning");
              onConfirm();
            }}
          >
            {busy && busyLabel ? busyLabel : confirmLabel}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
        </SheetFooter>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        <p className="text-ui text-muted-foreground">{description}</p>
        {children}
      </div>
    </BottomSheet>
  );
}
