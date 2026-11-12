import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

import { RefreshCwIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/platform/appearance";
import { NO_NOTICE_PAUSE, isNoticePaused, setNoticePause } from "./notice-pause";
import type { NoticePauseReason } from "./notice-pause";
import { admit, dragOffsetY, dropUndo, expire, isToastPaused, swipeOutcome, toastDurationMs } from "./toast-stack";
import type { Toast, ToastTone } from "./toast-stack";
import { humanizeDaemonError, humanizeReceiptError } from "./ui/OwnedBySession";
import { errorRecoveryAction, type RecoveryAction } from "./ui/error-recovery";
import { NoticePill } from "./ui/NoticePill";
import { BottomSheet } from "./ui/Sheet";
import { CopyButton } from "./parts/CopyButton";

type Tone = ToastTone;
type BannerEntry = { message: string; tone: Tone; action?: RecoveryAction } | null;

// Two toasts at most, oldest on top (the policy is in toast-stack.ts). One slot
// let any later toast wipe an Undo while its delete still fired and dropped
// the second of two replies finishing together; the old "+3 more" counters
// made every hiccup read as a backlog, so the cap stays small.
let toastSeq = 0;
let toasts: readonly Toast[] = [];
let bannerEntry: BannerEntry = null;
// The top notice column's slot for the chat's own error (see ChatScreen), so
// that error stacks with toasts and banners instead of floating over them.
let noticeSlot: HTMLElement | null = null;

function setNoticeSlot(el: HTMLElement | null): void {
  if (noticeSlot === el) return;
  noticeSlot = el;
  emit();
}

export function useNoticeSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => noticeSlot, () => null);
}

/** Renders `children` inside the top notice column (nothing until it mounts). */
export function InNoticeSlot({ children }: { children: ReactNode }): JSX.Element | null {
  const slot = useNoticeSlot();
  return slot ? createPortal(children, slot) : null;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setToasts(next: readonly Toast[]): void {
  if (next === toasts) return;
  toasts = next;
  emit();
}

/**
 * `options.durationMs` is the countdown; without one an actionable toast stays
 * until dismissed (setup cannot race a countdown) and any other toast lasts as
 * long as its text takes to read. `kind: "undo"` marks a toast whose window is
 * a real deadline: it never pauses and is never displaced by a toast without
 * an action. `group` makes later toasts of the same group update this one.
 */
export function showToast(
  message: string,
  tone: Tone = "info",
  action?: RecoveryAction,
  options?: { durationMs?: number; kind?: "undo"; group?: string; title?: string },
): void {
  const recovery = action ?? (tone === "error" ? errorRecoveryAction(message) : undefined);
  setToasts(admit(toasts, {
    message,
    tone,
    title: options?.title,
    group: options?.group,
    kind: options?.kind,
    action: recovery,
    durationMs: options?.durationMs ?? (recovery ? null : toastDurationMs(message, tone)),
  }, performance.now(), ++toastSeq));
}

/** Keep the original classification available before turning a failure into copy. */
export function showErrorToast(error: unknown): void {
  showToast(typeof error === "string" ? humanizeReceiptError(error) : humanizeDaemonError(error), "error", errorRecoveryAction(error));
}

function removeToast(id: number): void {
  setToasts(expire(toasts, id));
}

/**
 * A persistent message that stays until dismissed or acted on (an update is
 * ready, the computer needs updating). One at a time; the newest replaces.
 */
export function showBanner(message: string, tone: Tone = "info", action?: RecoveryAction): void {
  bannerEntry = { message, tone, action: action ?? (tone === "error" ? errorRecoveryAction(message) : undefined) };
  emit();
}

export function clearBanner(): void {
  bannerEntry = null;
  emit();
}

function getSnapshotToasts(): readonly Toast[] {
  return toasts;
}

function getSnapshotBanner(): BannerEntry {
  return bannerEntry;
}

const FADE_MS = 240; // --dur-base
const ENTER_MS = 320;
const EXIT_MS = 160;
const SPRING_BACK_MS = 240;
const BUMP_MS = 90;
const DRAG_SLOP = 8; // px before a press becomes a drag; a tap must stay a tap
const SPRING = "var(--ease-spring)";
const SMOOTH = "var(--ease-smooth)";

type Gesture = {
  pointerId: number;
  x0: number;
  y0: number;
  dragging: boolean;
  /** Recent moves, for the release velocity. */
  samples: { t: number; x: number; y: number }[];
};

function releaseVelocity(samples: Gesture["samples"]): { vx: number; vy: number } {
  const last = samples[samples.length - 1];
  const first = samples.find((s) => last.t - s.t <= 100);
  if (!last || !first) return { vx: 0, vy: 0 };
  const dt = Math.max(1, last.t - first.t);
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

/**
 * One toast. Motion is written straight to the pill's style (translate, scale,
 * opacity as separate properties so they never fight): a drag follows the
 * finger at pointer rate, and a React render per move would be a re-render of
 * the stack for nothing. The wrapper around it collapses its height on exit so
 * the toast below glides up instead of jumping.
 */
function ToastRow({ toast, leaving, onExited }: { toast: Toast; leaving: boolean; onExited: (id: number) => void }): JSX.Element {
  const pillRef = useRef<HTMLDivElement>(null);
  const remainingRef = useRef(toast.durationMs ?? 0);
  const revisionRef = useRef(toast.revision);
  const bumpedRef = useRef(toast.revision);
  const gestureRef = useRef<Gesture | null>(null);
  const swipedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const swipeTimerRef = useRef<number | null>(null);
  const [pauseState, setPauseState] = useState(NO_NOTICE_PAUSE);
  const paused = isToastPaused(toast, isNoticePaused(pauseState));

  // Hover, focus, touch and a hidden page pause the countdown; it resumes
  // with what was left, so a toast is never gone before it was seen. An undo
  // toast ignores all of that (see isToastPaused). A new revision (a toast
  // coalesced into this one) restarts the full countdown.
  useEffect(() => {
    if (revisionRef.current !== toast.revision) {
      revisionRef.current = toast.revision;
      remainingRef.current = toast.durationMs ?? 0;
    }
    if (leaving || toast.durationMs === null || paused) return;
    const started = performance.now();
    const timer = window.setTimeout(() => removeToast(toast.id), remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - started));
    };
  }, [leaving, paused, toast.id, toast.revision, toast.durationMs]);

  const setPause = useCallback((reason: NoticePauseReason, active: boolean) => setPauseState((state) => setNoticePause(state, reason, active)), []);

  useEffect(() => {
    const updateVisibility = () => {
      const hidden = document.visibilityState !== "visible";
      if (hidden) gestureRef.current = null;
      setPauseState((state) => {
        const next = setNoticePause(state, "hidden", hidden);
        return hidden ? { ...next, touch: false, hover: false } : next;
      });
    };
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => () => {
    if (swipeTimerRef.current !== null) window.clearTimeout(swipeTimerRef.current);
  }, []);

  // Enter: from above, 320 ms spring. Reduced motion is opacity only.
  useLayoutEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    const reduced = prefersReducedMotion();
    el.style.transition = "none";
    el.style.opacity = "0";
    if (!reduced) {
      el.style.translate = "0px -16px";
      el.style.scale = "0.96";
    }
    void el.offsetWidth; // commit the start values so the transition has something to run from
    el.style.transition = reduced
      ? `opacity ${EXIT_MS}ms ${SMOOTH}`
      : `translate ${ENTER_MS}ms ${SPRING}, scale ${ENTER_MS}ms ${SPRING}, opacity ${EXIT_MS}ms ${SMOOTH}`;
    el.style.opacity = "1";
    el.style.translate = "0px 0px";
    el.style.scale = "1";
  }, []);

  // A coalesced update plays one subtle bump so the changed text is noticed.
  useEffect(() => {
    if (bumpedRef.current === toast.revision) return;
    bumpedRef.current = toast.revision;
    const el = pillRef.current;
    if (!el || prefersReducedMotion() || gestureRef.current?.dragging) return;
    el.style.transition = `scale ${BUMP_MS}ms ${SMOOTH}`;
    el.style.scale = "1.04";
    const timer = window.setTimeout(() => {
      el.style.transition = `scale ${SPRING_BACK_MS}ms ${SPRING}`;
      el.style.scale = "1";
    }, BUMP_MS);
    return () => {
      window.clearTimeout(timer);
      el.style.scale = "1";
    };
  }, [toast.revision]);

  // Exit: fade up 8 px (opacity only under reduced motion). A swiped toast has
  // already left under the finger, so only the row collapses.
  useEffect(() => {
    if (!leaving) return;
    const el = pillRef.current;
    if (el && !swipedRef.current) {
      const reduced = prefersReducedMotion();
      el.style.transition = reduced ? `opacity ${EXIT_MS}ms ${SMOOTH}` : `translate ${EXIT_MS}ms ${SMOOTH}, opacity ${EXIT_MS}ms ${SMOOTH}`;
      el.style.opacity = "0";
      if (!reduced) el.style.translate = "0px -8px";
    }
    const timer = window.setTimeout(() => onExited(toast.id), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onExited, toast.id]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (leaving || gestureRef.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    gestureRef.current = { pointerId: event.pointerId, x0: event.clientX, y0: event.clientY, dragging: false, samples: [] };
    setPause("touch", true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x0;
    const dy = event.clientY - gesture.y0;
    const el = event.currentTarget;
    if (!gesture.dragging) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      // Captured only once it is a drag: capturing on press would retarget the
      // click and make the action and dismiss buttons dead.
      gesture.dragging = true;
      el.setPointerCapture(event.pointerId);
      el.style.transition = "none";
    }
    gesture.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    while (gesture.samples.length > 2 && event.timeStamp - gesture.samples[0].t > 100) gesture.samples.shift();
    el.style.translate = `${dx}px ${dragOffsetY(dy)}px`;
  };

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (!gesture.dragging) {
      setPause("touch", false);
      return;
    }
    // The click that ends a drag must not tap the toast.
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 50);
    const el = event.currentTarget;
    const dx = event.clientX - gesture.x0;
    const dy = event.clientY - gesture.y0;
    const { vx, vy } = releaseVelocity(gesture.samples);
    const outcome = cancelled ? "back" : swipeOutcome(dx, dy, vx, vy);
    if (outcome === "back") {
      el.style.transition = prefersReducedMotion() ? `translate ${EXIT_MS}ms ${SMOOTH}` : `translate ${SPRING_BACK_MS}ms ${SPRING}`;
      el.style.translate = "0px 0px";
      setPause("touch", false);
      return;
    }
    // A swiped undo toast is dismissed, never undone: only its button undoes.
    swipedRef.current = true;
    const x = outcome === "up" ? dx : (outcome === "left" ? -1 : 1) * (el.offsetWidth + 48);
    const y = outcome === "up" ? -(el.offsetHeight + 48) : dragOffsetY(dy);
    el.style.transition = `translate ${EXIT_MS}ms ${SMOOTH}, opacity ${EXIT_MS}ms ${SMOOTH}`;
    el.style.translate = `${x}px ${y}px`;
    el.style.opacity = "0";
    swipeTimerRef.current = window.setTimeout(() => removeToast(toast.id), EXIT_MS);
  };

  const runAction = () => {
    removeToast(toast.id);
    toast.action?.onClick();
  };
  // A tap on a toast that goes somewhere or fixes something runs it; an undo's
  // body is inert (only its button undoes); a plain toast dismisses (a clamped
  // message expands first, inside NoticePill).
  const onBodyClick = toast.kind === "undo" ? undefined : toast.action ? runAction : () => removeToast(toast.id);

  return (
    <div
      className={cn(
        "grid w-full transition-[grid-template-rows] duration-[160ms] ease-[var(--ease-smooth)] motion-reduce:transition-none",
        leaving ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
      )}
    >
      <div className={cn("min-h-0", leaving && "overflow-hidden")}>
        <div className="pb-2">
          <div
            ref={pillRef}
            data-slot="toast"
            data-tone={toast.tone}
            className={cn("pointer-events-auto mx-auto w-fit max-w-full touch-none select-none", leaving && "pointer-events-none")}
            onMouseEnter={() => setPause("hover", true)}
            onMouseLeave={() => setPause("hover", false)}
            onFocusCapture={() => setPause("focus", true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setPause("focus", false);
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => finishGesture(event, false)}
            onPointerCancel={(event) => finishGesture(event, true)}
            onClickCapture={(event) => {
              if (!suppressClickRef.current) return;
              suppressClickRef.current = false;
              event.stopPropagation();
              event.preventDefault();
            }}
          >
            <NoticePill
              tone={toast.tone}
              title={toast.title}
              action={toast.action ? { label: toast.action.label, icon: toast.action.icon, onClick: runAction } : undefined}
              onDismiss={toast.durationMs === null ? () => removeToast(toast.id) : undefined}
              onBodyClick={onBodyClick}
              progress={toast.kind === "undo" && toast.durationMs !== null ? { startedAt: toast.startedAt, durationMs: toast.durationMs } : undefined}
            >
              {toast.message}
            </NoticePill>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * `bannerAt`: where a persistent banner floats. Under the chat's 56px bar it
 * covers only scrolling transcript; on screens with a large title (Sessions)
 * that spot covered the title and the connection line, so they take it at
 * the bottom, where nothing is pinned.
 */
export function Notices({ bannerAt = "top" }: { bannerAt?: "top" | "bottom" } = {}): JSX.Element {
  const current = useSyncExternalStore(subscribe, getSnapshotToasts, getSnapshotToasts);
  const banner = useSyncExternalStore(subscribe, getSnapshotBanner, getSnapshotBanner);
  const [sharingHelp, setSharingHelp] = useState(false);
  useEffect(() => {
    const open = () => setSharingHelp(true);
    window.addEventListener("recovery:sharing", open);
    return () => window.removeEventListener("recovery:sharing", open);
  }, []);

  // An undo's countdown never pauses, so a hidden page drops it rather than
  // showing an Undo that lapsed in the background.
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== "visible") setToasts(dropUndo(toasts));
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);

  const [renderBanner, setRenderBanner] = useState(banner);
  const [bannerExiting, setBannerExiting] = useState(false);

  // A toast that left the store (expired, replaced, dismissed, acted on) stays
  // mounted for its exit. Derived during render, not in an effect: an effect
  // would paint one frame without it and the exit would flicker.
  const [seen, setSeen] = useState(current);
  const [leaving, setLeaving] = useState<readonly Toast[]>([]);
  if (seen !== current) {
    setSeen(current);
    const gone = seen.filter((t) => !current.some((c) => c.id === t.id));
    if (gone.length) setLeaving((l) => [...l, ...gone]);
  }
  const onExited = useCallback((id: number) => setLeaving((l) => l.filter((t) => t.id !== id)), []);
  const rows = [
    ...current.map((toast) => ({ toast, leaving: false })),
    ...leaving.map((toast) => ({ toast, leaving: true })),
  ].sort((a, b) => a.toast.id - b.toast.id);

  useEffect(() => {
    if (banner) {
      setRenderBanner(banner);
      setBannerExiting(false);
    } else if (renderBanner) {
      setBannerExiting(true);
      const t = window.setTimeout(() => {
        setRenderBanner(null);
        setBannerExiting(false);
      }, FADE_MS);
      return () => window.clearTimeout(t);
    }
  }, [banner, renderBanner]);

  // Toasts: fixed at the top under the status bar, above sheets (z-toast).
  // At the bottom they covered Send and the sheet's last rows; pointer events
  // are captured by the pill only, never the strip around it.
  //
  // Persistent banners are NOT toasts: they used to share the toast slot and
  // sat over the screen header, hiding Settings and New until tapped. They
  // render as a floating pill just below the 56px header bar instead, with
  // their one action and a dismiss, and never compete with a toast.
  const bannerShown = renderBanner !== null;
  const [bannerIn, setBannerIn] = useState(false);
  useEffect(() => {
    if (!bannerShown) { setBannerIn(false); return; }
    const id = requestAnimationFrame(() => setBannerIn(true));
    return () => cancelAnimationFrame(id);
  }, [bannerShown]);
  return (
    <>
      <BottomSheet open={sharingHelp} onOpenChange={setSharingHelp} title="Share this conversation" testId="sharing-recovery">
        <div className="space-y-3 pb-2 text-meta">
          <p>To share control, run this in the open omp conversation on your computer.</p>
          <div className="flex min-w-0 items-center gap-3">
            <code className="min-w-0 flex-1 select-text break-words font-mono">/collab</code>
            <CopyButton text="/collab" label="Copy sharing command" className="size-[48px]" />
          </div>
          <details className="text-muted-foreground">
            <summary className="min-h-12 cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-ring">Next steps</summary>
            <p>Connect the resulting sharing link here. Copying the command does not change who controls the conversation.</p>
          </details>
        </div>
      </BottomSheet>
      {/* ONE column for everything that floats at the top, so nothing can sit
          on anything else: the chat's error (portaled into `slot` by
          ChatScreen), the sticky banner, then the timed toasts. Sticky notices
          sit above the toasts and a new toast never replaces them. Anchored
          under the 56px chat bar so the floating header buttons stay
          reachable. Every surface is opaque: 95% + blur let the transcript
          show through the text. A bottom banner (Sessions: its large title
          would be covered) leaves the column and pins itself above the
          safe area. */}
      <div
        className="pointer-events-none fixed inset-x-4 top-[calc(env(safe-area-inset-top)+3.5rem+0.75rem)] z-toast mx-auto flex max-w-[480px] flex-col items-center gap-2"
        aria-live="polite"
      >
      <div ref={setNoticeSlot} className="flex w-full flex-col items-center gap-2 empty:hidden" />
      {renderBanner ? (
        <NoticePill
          tone={renderBanner.tone}
          icon={renderBanner.action?.label === "Update" ? RefreshCwIcon : undefined}
          testId="app-banner"
          action={renderBanner.action ? {
            label: renderBanner.action.label,
            icon: renderBanner.action.icon,
            onClick: () => {
              const fn = renderBanner.action?.onClick;
              clearBanner();
              fn?.();
            },
          } : undefined}
          actionStyle="filled"
          onDismiss={clearBanner}
          className={cn(
            "pointer-events-auto",
            bannerAt === "bottom" && "fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+1rem)] mx-auto",
            "transition-[opacity,translate,scale] motion-reduce:translate-y-0 motion-reduce:scale-100",
            // DeepSeek's toast pop: 150ms in, 150ms out. The 520ms spring
            // outlived the message it was introducing.
            bannerExiting
              ? "opacity-0 duration-150 ease-[var(--ease-smooth)]"
              : "duration-[150ms] ease-[var(--ease-position)]",
            bannerIn ? "translate-y-0 scale-100 opacity-100" : cn("scale-90 opacity-0", bannerAt === "top" ? "-translate-y-3" : "translate-y-3"),
          )}
        >
          {renderBanner.message}
        </NoticePill>
      ) : null}
      {rows.length ? (
        <div className="flex w-full flex-col" data-slot="toast-stack">
          {rows.map(({ toast, leaving: isLeaving }) => (
            <ToastRow key={toast.id} toast={toast} leaving={isLeaving} onExited={onExited} />
          ))}
        </div>
      ) : null}
    </div>
    </>
  );
}
