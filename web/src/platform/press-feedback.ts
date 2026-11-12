/**
 * ChatGPT's touch feedback, for the whole app from one place:
 *
 * - `press-bounce` elements keep `data-pressed` for at least 120ms
 *   (DILPressFeedback's minimum), so a quick tap still shows the 0.98
 *   squeeze that `:active` alone drops before the next frame.
 * - `pressable` rows get the Android ripple: the touch point and the radius
 *   that reaches the farthest corner, then data-ripple "in" → "out" → gone.
 * - A tap on a pressable in a reply plays the "selection" haptic, as
 *   DILPressFeedback does for every pressable in a ChatGPT reply, unless the
 *   tap's own handler already played one.
 */
import { haptic, msSinceHaptic } from "./haptic";

const MIN_PRESS_MS = 120;
const RIPPLE_OUT_MS = 350;

function release(startedAt: number, apply: () => void): void {
  const wait = Math.max(0, MIN_PRESS_MS - (performance.now() - startedAt));
  if (wait) window.setTimeout(apply, wait);
  else apply();
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const element = event.target.closest<HTMLElement>(".press-bounce, .pressable");
  if (!element || element.matches(":disabled, [aria-disabled='true']")) return;
  const startedAt = performance.now();
  const ripple = element.classList.contains("pressable");
  if (ripple) {
    const box = element.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const radius = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y));
    element.style.setProperty("--press-x", `${x}px`);
    element.style.setProperty("--press-y", `${y}px`);
    element.style.setProperty("--press-r", `${radius}px`);
    // A retap mid-fade must grow again from the touch point, not resume.
    element.removeAttribute("data-ripple");
    void element.offsetWidth;
    element.dataset.ripple = "in";
  } else {
    element.dataset.pressed = "";
  }
  const end = () => {
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    release(startedAt, () => {
      if (!ripple) {
        delete element.dataset.pressed;
        return;
      }
      if (element.dataset.ripple !== "in") return;
      element.dataset.ripple = "out";
      window.setTimeout(() => {
        if (element.dataset.ripple === "out") element.removeAttribute("data-ripple");
      }, RIPPLE_OUT_MS);
    });
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}

function onClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return;
  const element = event.target.closest(".press-bounce, .pressable");
  // Reply content only: the transcript, not the user's own messages.
  if (!element?.closest(".chat-scroll") || element.closest(".is-user")) return;
  // Bubble phase on window runs after React's handlers: one buzz per tap.
  if (msSinceHaptic() < 50) return;
  haptic("selection");
}

let installed = false;

export function installPressFeedback(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  window.addEventListener("click", onClick);
}
