import { useEffect, useState } from "react";

/**
 * iOS visualViewport keyboard inset.
 * Subscribes to `visualViewport` resize + scroll and computes
 * inset = max(0, innerHeight - (visualViewport.height + visualViewport.offsetTop)).
 * Degrades to 0 where visualViewport is absent, and while pinch-zoomed: a
 * zoomed visual viewport is shorter than the layout viewport with no keyboard
 * at all, and reading that gap as a keyboard lifted the composer mid-zoom.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const compute = () => {
      // `scale` is 1 unless the reader pinch-zoomed; only then is the gap a keyboard.
      const zoomed = Math.abs((vv.scale || 1) - 1) > 0.01;
      const value = zoomed ? 0 : Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      setInset(value);
    };

    compute();
    vv.addEventListener("resize", compute);
    vv.addEventListener("scroll", compute);
    return () => {
      vv.removeEventListener("resize", compute);
      vv.removeEventListener("scroll", compute);
    };
  }, []);

  return inset;
}
