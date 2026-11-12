import { useRef, type MouseEvent } from "react";

/**
 * A scrim that appears under a held finger (a long-press menu) must not close
 * on that finger's release: the lift lands on the scrim as a click, and the
 * menu vanished the moment it opened. Only a tap that began on the scrim, or
 * a click no pointer made (keyboard, assistive tech: `detail === 0`), closes.
 */
export function useScrimDismiss(close: () => void) {
  const pressed = useRef(false);
  return {
    onPointerDown: () => { pressed.current = true; },
    onClick: (event: MouseEvent) => {
      if (pressed.current || event.detail === 0) close();
      pressed.current = false;
    },
  };
}
