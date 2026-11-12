import { useEffect } from "react";

/** The composer's editor; the selector is the composer's own contract. */
export const COMPOSER_INPUT_SELECTOR = 'textarea[data-composer-input]';

// Finger travel before a drag counts as a flick. Small enough to feel
// immediate, large enough that a tap or a sideways code-block pan never
// throws the keyboard away.
const FLICK_PX = 24;

/**
 * Native chat apps drop the keyboard when you drag the conversation down to
 * read back. Without this the keyboard pinned the transcript to a sliver
 * until you found the system back gesture. Only a downward drag (towards
 * older messages) that starts in the scroller dismisses; scrolling to the
 * latest message while typing keeps the keyboard. Takes the element (not a
 * ref) because the transcript scroller remounts per session.
 */
export function useBlurComposerOnScroll(scroller: HTMLElement | null): void {
  useEffect(() => {
    if (!scroller) return;
    let startY: number | null = null;
    const onStart = (event: TouchEvent) => {
      startY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
    };
    const onMove = (event: TouchEvent) => {
      if (startY === null) return;
      const dy = event.touches[0]!.clientY - startY;
      if (dy < FLICK_PX) return;
      startY = null;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches(COMPOSER_INPUT_SELECTOR)) active.blur();
    };
    const onEnd = () => {
      startY = null;
    };
    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: true });
    scroller.addEventListener("touchend", onEnd, { passive: true });
    scroller.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", onEnd);
    };
  }, [scroller]);
}
