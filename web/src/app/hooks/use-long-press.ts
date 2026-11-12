"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import { haptic } from "../../platform/haptic"

/**
 * Unified long-press hook — 500ms hold, >10px movement cancels,
 * 800ms post-fire click guard, a long-press haptic on fire.
 * Caller supplies the action via closure or per-pointerDown callback.
 */
export function useLongPress(
  onLongPress?: () => void,
  opts?: { delay?: number; threshold?: number; guardMs?: number },
) {
  const delay = opts?.delay ?? 500;
  const threshold = opts?.threshold ?? 10;
  const guardMs = opts?.guardMs ?? 800;

  const callbackRef = useRef(onLongPress);
  useEffect(() => {
    callbackRef.current = onLongPress;
  }, [onLongPress]);

  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const guardUntilRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // keep startRef for move threshold until up; pending cleared via startRef reset
  }, []);

  // unmount cleanup — critical for leak fix
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Cancels the pending press the moment the platform starts selecting text.
  // Event-driven rather than timing-based: the WebView begins its selection
  // somewhere around 500ms, but that is not a contract, so comparing it
  // against our own delay is a race we would lose on some devices. Listening
  // for `selectionchange` aborts the instant it actually happens, whenever
  // that is.
  const selectionWatchRef = useRef<(() => void) | null>(null);
  const stopSelectionWatch = useCallback(() => {
    if (selectionWatchRef.current) {
      document.removeEventListener("selectionchange", selectionWatchRef.current);
      selectionWatchRef.current = null;
    }
  }, []);

  // The document-level listener outlives this component if a press is still
  // pending when the row unmounts — and transcript rows unmount constantly
  // while paging history.
  useEffect(() => stopSelectionWatch, [stopSelectionWatch]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent, cb?: () => void) => {
      if (e.button !== 0) return;
      if (cb) callbackRef.current = cb;
      firedRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY };
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      stopSelectionWatch();
      const onSelectionChange = () => {
        if ((window.getSelection()?.toString() ?? "").trim() === "") return;
        // Text is being selected — this press belongs to the user copying.
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        startRef.current = null;
        stopSelectionWatch();
      };
      selectionWatchRef.current = onSelectionChange;
      document.addEventListener("selectionchange", onSelectionChange);
      timerRef.current = window.setTimeout(() => {
        if (firedRef.current) return;
        // If the platform has already begun selecting text under this press,
        // the user is copying, not summoning a menu — stand down.
        //
        // Android starts its selection gesture at roughly the same 500ms as
        // this timer, so both fired and ours painted over it: long-pressing a
        // path or a command in the transcript offered "copy the whole message"
        // instead of selection handles, which made copying a snippet
        // impossible. `delay` is also set above the platform threshold for
        // message text so the selection lands first and is visible here.
        const selected = typeof window !== "undefined" ? (window.getSelection()?.toString() ?? "") : "";
        if (selected.trim() !== "") {
          timerRef.current = null;
          startRef.current = null;
          return;
        }
        firedRef.current = true;
        guardUntilRef.current = Date.now() + guardMs;
        haptic("medium");
        callbackRef.current?.();
        timerRef.current = null;
        // startRef cleared after fire to prevent move from cancelling post-fire
        startRef.current = null;
        stopSelectionWatch();
      }, delay) as unknown as number;
    },
    [delay, guardMs, stopSelectionWatch],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!startRef.current || timerRef.current === null) return;
      if (firedRef.current) return;
      const dx = e.clientX - startRef.current.x;
      const dy = e.clientY - startRef.current.y;
      if (Math.hypot(dx, dy) > threshold) {
        clearTimer();
        startRef.current = null;
      }
    },
    [clearTimer, threshold],
  );

  const onPointerUp = useCallback(() => {
    clearTimer();
    stopSelectionWatch();
  }, [clearTimer, stopSelectionWatch]);

  const onPointerCancel = onPointerUp;
  const onPointerLeave = onPointerUp;

  const shouldSuppressClick = useCallback(() => {
    if (firedRef.current || Date.now() < guardUntilRef.current) {
      // consume the fired flag so next click isn't forever suppressed; guard timestamp naturally expires
      // keep fired for 800ms via guard, but reset fired after consumption? SessionRow resets fired on click.
      // We keep guardUntil for time-based suppression, and clear firedRef after check to allow next interaction.
      return true;
    }
    return false;
  }, []);

  // helper to reset fired after a suppressed click (caller should call after handling)
  const consumeFired = useCallback(() => {
    firedRef.current = false;
  }, []);

  // One object for the component's lifetime. Every member is already stable,
  // but a fresh literal per render made `useMessageActions().bind` change
  // identity on every render, which broke the transcript rows' memo check and
  // re-rendered all ~400 loaded messages on every streamed frame.
  return useMemo(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave,
      clearTimer,
      shouldSuppressClick,
      consumeFired,
      // expose refs for advanced usage if needed
      _guardUntilRef: guardUntilRef,
      _firedRef: firedRef,
    }),
    [
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave,
      clearTimer,
      shouldSuppressClick,
      consumeFired,
    ],
  );
}

/** Read by assistive technology through `aria-describedby` on a row that opens its actions. */
export const ROW_ACTIONS_HINT = "Hold, or press Shift+F10, for more actions";

/**
 * The non-hold routes to a row's actions menu: a right-click, the ContextMenu
 * key and Shift+F10. Rows were reachable only by a 500ms hold, so desktop and
 * keyboard users had no way in. Some Android browsers also send `contextmenu`
 * after a hold, and browsers send it after Shift+F10, so an open within the
 * last moment (the hold's own guard, or a keyboard open) swallows the echo
 * instead of opening the menu twice.
 */
export function useRowActionsTrigger(
  longPress: { _guardUntilRef: { current: number } },
  open: (row: HTMLElement) => void,
) {
  const lastOpenRef = useRef(0);
  const openOnce = (row: HTMLElement) => {
    const now = Date.now();
    if (now < longPress._guardUntilRef.current || now - lastOpenRef.current < 500) return;
    lastOpenRef.current = now;
    open(row);
  };
  return {
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      openOnce(event.currentTarget);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      openOnce(event.currentTarget);
    },
  };
}
