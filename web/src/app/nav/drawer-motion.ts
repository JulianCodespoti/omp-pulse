// The drawer's release physics, ported from DeepSeek's Android drawer
// (Compose AnchoredDraggable). Pure so the numbers can be tested without a DOM.
// Positions are px of panel offset from fully open (0) to fully closed (width);
// velocities are px/ms along that axis, positive meaning toward closed.
import { springFrames as sharedSpringFrames } from "../ui/motion";

/** DeepSeek aj7.a: spring(dampingRatio = 0.9, stiffness = 1500), mass 1. */
const SPRING = { stiffness: 1500, dampingRatio: 0.9 };
/** DeepSeek im3: velocityThreshold = 326dp/s. A CSS px is a dp, so 0.326 px/ms. */
export const FLICK_VELOCITY = 0.326;
/** Only the last 100ms of the finger's path says where it is going. */
const VELOCITY_WINDOW_MS = 100;
// Stop once the panel is within half a pixel and creeping slower than that
// decays at the spring's natural frequency; the last frame then snaps to rest.
// The sampling itself lives in ../ui/motion so the sheets, menus and bars share
// one integrator.
const REST = { frameMs: 4, maxMs: 600, restDistance: 0.5, restVelocity: 20 };

/**
 * Finger velocity in px/ms: the least-squares slope of x over the samples in
 * the 100ms before `now`, so one jittery pair of points cannot swing it and a
 * finger that rested before lifting reads as zero.
 */
export function releaseVelocity(samples: readonly { x: number; t: number }[], now: number): number {
  const recent = samples.filter((s) => s.t >= now - VELOCITY_WINDOW_MS);
  if (recent.length < 2) return 0;
  const meanT = recent.reduce((sum, s) => sum + s.t, 0) / recent.length;
  const meanX = recent.reduce((sum, s) => sum + s.x, 0) / recent.length;
  let num = 0;
  let den = 0;
  for (const s of recent) {
    num += (s.t - meanT) * (s.x - meanX);
    den += (s.t - meanT) ** 2;
  }
  return den > 0 ? num / den : 0;
}

/**
 * DeepSeek's computeTarget for two anchors: a flick at or above the threshold
 * goes to the anchor it points at (so a reversing flick wins over how far the
 * panel had travelled), otherwise the panel commits once past half the width.
 */
export function drawerTarget(px: number, width: number, velocity: number): number {
  if (Math.abs(velocity) >= FLICK_VELOCITY) return velocity > 0 ? width : 0;
  return px >= width / 2 ? width : 0;
}

/**
 * Sampled position of the settle spring from `from` to `to`, starting at
 * `velocity` (the finger's, so the hand-off has no stall). Closed form for an
 * underdamped spring, so frame spacing affects only how finely it is sampled.
 */
export function springFrames(from: number, to: number, velocity: number): { ms: number; x: number }[] {
  return sharedSpringFrames(from, to, velocity, SPRING, REST);
}
