/**
 * One spring, sampled for the compositor.
 *
 * DeepSeek's client is springs-only: 141 `spring(...)` sites and a single
 * tween, damping 1.0 for anything positional and 0.9 for the drawer, stiffness
 * from 400 to 1600. Ours was beziers at fixed durations, and a bezier cannot
 * start at the finger's release velocity nor stop early when the distance is
 * short: it always spends the whole duration, which reads as "stall, then
 * slide" after a flick.
 *
 * These samples are precomputed, so every caller animates only `transform`,
 * `opacity` or a scroll offset, and a CSS `linear()` string plays them on the
 * compositor at whatever the display runs at. Nothing here touches React.
 *
 * Physics in Compose's units: `stiffness` is ω² (mass 1), so a stiffness of
 * 1200 is ω ≈ 34.6 rad/s; `velocity` is px per millisecond along the same axis
 * as `from` and `to`, positive meaning toward `to`.
 */
export interface Spring {
  stiffness: number;
  dampingRatio: number;
}

/** Anything that moves a surface into place: ζ 1.0, ~170 ms to settle. */
export const POSITION: Spring = { stiffness: 1200, dampingRatio: 1 };
/** A released gesture: ζ 0.9, a hair of overshoot, ~250 ms. */
export const SETTLE: Spring = { stiffness: 1500, dampingRatio: 0.9 };

const FRAME_MS = 4;
const MAX_MS = 600;
const REST_DISTANCE = 0.5;
const REST_VELOCITY = 20; // px per second

export interface SpringSample {
  ms: number;
  x: number;
}

/**
 * Position over time for a damped spring released at `velocity`. Dense 4 ms
 * samples: a hand-off to the compositor is piecewise linear, so the chord has
 * to stay within a pixel of the curve.
 */
export function springFrames(
  from: number,
  to: number,
  velocity = 0,
  spring: Spring = POSITION,
  options: { frameMs?: number; maxMs?: number; restDistance?: number; restVelocity?: number } = {},
): SpringSample[] {
  const { frameMs = FRAME_MS, maxMs = MAX_MS, restDistance = REST_DISTANCE, restVelocity = REST_VELOCITY } = options;
  const wn = Math.sqrt(spring.stiffness);
  const zeta = spring.dampingRatio;
  const d0 = from - to;
  const v0 = velocity * 1000;
  const frames: SpringSample[] = [{ ms: 0, x: from }];
  for (let ms = frameMs; ms < maxMs; ms += frameMs) {
    const t = ms / 1000;
    let d: number;
    let v: number;
    if (Math.abs(zeta - 1) < 1e-6) {
      // Critically damped: (A + Bt)e^{-ωt}, no oscillation.
      const b = v0 + wn * d0;
      const e = Math.exp(-wn * t);
      d = (d0 + b * t) * e;
      v = (b - wn * (d0 + b * t)) * e;
    } else {
      const decay = zeta * wn;
      const wd = wn * Math.sqrt(1 - zeta * zeta);
      const e = Math.exp(-decay * t);
      const cos = Math.cos(wd * t);
      const sin = Math.sin(wd * t);
      const b = (v0 + decay * d0) / wd;
      d = e * (d0 * cos + b * sin);
      v = e * ((b * wd - decay * d0) * cos - (d0 * wd + decay * b) * sin);
    }
    if (Math.abs(d) < restDistance && Math.abs(v) < restVelocity) {
      frames.push({ ms, x: to });
      return frames;
    }
    frames.push({ ms, x: to + d });
  }
  frames.push({ ms: maxMs, x: to });
  return frames;
}

/**
 * The same spring as a CSS `linear()` easing plus the duration it takes, for
 * the places a transition is simpler than a WAAPI animation. `from` is 0 and
 * `to` is 1, so the offsets are the curve itself.
 */
export function springEasing(spring: Spring = POSITION, frameMs = 8): { easing: string; duration: number } {
  // The curve's axis is 0…1, not pixels: the pixel rest rule (half a pixel)
  // would call a 1-unit move finished in two frames and flatten the spring.
  const frames = springFrames(0, 1, 0, spring, { frameMs, restDistance: 0.002, restVelocity: 2 });
  const total = frames[frames.length - 1].ms || frameMs;
  const stops = frames.map((frame) => {
    const at = Math.round((frame.ms / total) * 10000) / 100;
    const value = Math.round(frame.x * 10000) / 10000;
    return `${value} ${at}%`;
  });
  return { easing: `linear(${stops.join(", ")})`, duration: total };
}

/**
 * Publish the curves once, as variables the stylesheet's transitions use.
 * Idempotent, and a no-op without a document (tests).
 */
export function installMotionTokens(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  if (root.getPropertyValue("--ease-position")) return;
  // Easings only: a spring's duration grows with the distance it covers, so
  // each site pairs the curve with its own 150–260 ms (see the callers).
  root.setProperty("--ease-position", springEasing(POSITION).easing);
  root.setProperty("--ease-settle", springEasing(SETTLE).easing);
}

/** `frames` as WAAPI keyframes for one property, offsets included. */
export function springKeyframes<T extends Keyframe>(
  frames: readonly SpringSample[],
  at: (x: number) => T,
): { keyframes: T[]; duration: number } {
  const total = frames[frames.length - 1].ms || FRAME_MS;
  return {
    keyframes: frames.map((frame) => ({ ...at(frame.x), offset: frame.ms / total }) as T),
    duration: total,
  };
}
