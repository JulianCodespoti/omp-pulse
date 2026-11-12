"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import type { JSX } from "react";

import { showToast } from "@/app/Notices";
import { cn } from "@/lib/utils";
import { ClipboardAttempt } from "@/platform/clipboard";

/**
 * A path inside prose. It reads as the inline code it is (text-code on
 * surface-2, radius 6, wrapping with the sentence) rather than a bordered
 * pill, and stays tappable: tap opens it when a viewer is wired, otherwise
 * tap copies; hold always copies.
 */
export function PathChip({
  path,
  onOpen,
}: {
  path: string;
  /**
   * When present, tap opens the path in a file viewer and copy moves to
   * long-press / right-click. Without it (link previews, anywhere with no
   * session to resolve against) tap copies, exactly as before.
   */
  onOpen?: (path: string) => void;
}): JSX.Element {
  const lastCopyRef = useRef(0);
  const copyAttempt = useRef(new ClipboardAttempt()).current;
  const pressTimerRef = useRef<number | null>(null);

  const doCopy = useCallback(async () => {
    // A touch long-press fires touchstart-timer AND contextmenu: one toast.
    if (copyAttempt.busy || Date.now() - lastCopyRef.current < 2000) return;
    lastCopyRef.current = Date.now();
    const result = await copyAttempt.run(path);
    if (result === null) return;
    // The toast is the one confirmation; the chip itself does not change.
    showToast(result ? "Copied path" : "Couldn't copy path", result ? "success" : "error");
  }, [copyAttempt, path]);

  const handleClick = useCallback(() => {
    // Tap opens when a viewer is wired; copy stays one long-press away.
    if (onOpen) {
      onOpen(path);
      return;
    }
    void doCopy();
  }, [path, onOpen, doCopy]);

  const clearPressTimer = useCallback(() => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    lastCopyRef.current = 0;
    return () => {
      // A late clipboard outcome belongs to the old path.
      copyAttempt.cancel();
      clearPressTimer();
    };
  }, [clearPressTimer, copyAttempt, path]);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!onOpen) return;
      // Don't also start the transcript row's long-press selection.
      e.stopPropagation();
      clearPressTimer();
      pressTimerRef.current = window.setTimeout(() => {
        pressTimerRef.current = null;
        void doCopy();
      }, 550);
    },
    [onOpen, clearPressTimer, doCopy],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!onOpen) return;
      e.preventDefault();
      e.stopPropagation();
      void doCopy();
    },
    [onOpen, doCopy],
  );
  return (
    <button
      aria-label={onOpen ? `Open file ${path}` : `Copy path ${path}`}
      className={cn(
        // Inline, so a long path wraps with the sentence like any code span.
        // The 44px tap target comes from a transparent inset that costs no
        // line height.
        "relative inline rounded-sm bg-surface-2 px-1 py-0.5 text-left font-mono text-code text-foreground [box-decoration-break:clone] [overflow-wrap:anywhere] outline-none",
        "after:absolute after:inset-x-0 after:-inset-y-3 after:content-['']",
        "transition-colors duration-[var(--dur-fast)] active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
      )}
      data-testid="path-chip"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onTouchCancel={clearPressTimer}
      onTouchEnd={clearPressTimer}
      onTouchMove={clearPressTimer}
      onTouchStart={handleTouchStart}
      title={onOpen ? `${path} — tap to open, hold to copy` : path}
      type="button"
    >
      {path}
    </button>
  );
}
