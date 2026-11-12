import { useEffect, useRef } from "react";
import type { JSX, ReactNode } from "react";

import { handleNativeBack } from "../../platform/native-back";
import { useBackLayer } from "../back-layer";
import { ScreenBoundary } from "../ui/RecoveryBoundary";
import { ScreenActivityContext } from "./screen-activity";

// How far a predictive back swipe moves and shrinks a screen at full
// progress; the chat surface in App.tsx uses the same numbers.
export const BACK_SHIFT_PX = 24;
export const BACK_SCALE = 0.08;
export const BACK_RADIUS_PX = 28;

/** Follow a predictive back swipe on a whole screen, as a native screen does. */
export function previewBack(el: HTMLElement, progress: number, edge: "left" | "right" | "none"): void {
  const direction = edge === "right" ? -1 : 1;
  el.style.transition = "none";
  el.style.overflow = "hidden";
  el.style.transform = `translateX(${direction * progress * BACK_SHIFT_PX}px) scale(${1 - progress * BACK_SCALE})`;
  el.style.borderRadius = `${progress * BACK_RADIUS_PX}px`;
}

/**
 * Return a screen to rest after a back swipe. The transform lives only for
 * the gesture: a lasting one would become the containing block for the
 * screen's fixed chrome. `animate` springs it back after an abandoned swipe;
 * without it the inline styles go at once (the pop transition already
 * snapshotted the shrunk surface).
 */
export function resetBackPreview(el: HTMLElement | null, animate: boolean): void {
  if (!el) return;
  if (!animate) {
    el.style.removeProperty("transform");
    el.style.removeProperty("transition");
    el.style.removeProperty("border-radius");
    el.style.removeProperty("overflow");
    return;
  }
  el.style.transition =
    "transform var(--dur-base) var(--ease-smooth), border-radius var(--dur-base) var(--ease-smooth)";
  el.style.transform = "none";
  el.style.borderRadius = "0px";
  window.setTimeout(() => {
    if (el.isConnected && el.style.transform === "none") resetBackPreview(el, false);
  }, 320);
}

/**
 * A full-screen layer pushed over the list or the chat (Settings, New
 * session). It slides in and out with the stack's view transition (the
 * openers in panels.ts run it), follows a predictive back swipe, and is a
 * screen-level back layer: sheets opened inside it close first, and Back on
 * the screen itself returns to what is beneath. The screen draws its own
 * header and safe-area insets.
 */
export function PushedScreen({
  open,
  covered = false,
  onClose,
  testId,
  title,
  children,
}: {
  open: boolean;
  covered?: boolean;
  onClose: () => void;
  testId: string;
  title: string;
  children: ReactNode;
}): JSX.Element | null {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const active = open && !covered;
  useBackLayer(active, {
    base: true,
    onProgress: (progress, edge) => {
      if (surfaceRef.current) previewBack(surfaceRef.current, progress, edge);
    },
    onCancel: () => resetBackPreview(surfaceRef.current, true),
    // The pop transition snapshots the shrunk surface, then the screen
    // unmounts, so nothing needs resetting on commit.
    onBack: onClose,
  });
  // Escape is Back for a keyboard: it closes whatever is on top, a detail
  // page inside the screen first. An open sheet handles its own Escape.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.documentElement.dataset.sheetOpen) return;
      handleNativeBack("commit");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);
  if (!open) return null;
  return (
    <div ref={surfaceRef} data-testid={testId} inert={covered} aria-hidden={covered || undefined} className="fixed inset-0 z-overlay flex flex-col bg-background">
      <ScreenActivityContext.Provider value={active}>
        <ScreenBoundary title={title} onBack={onClose}>{children}</ScreenBoundary>
      </ScreenActivityContext.Provider>
    </div>
  );
}
