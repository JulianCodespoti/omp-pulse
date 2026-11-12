import { CircleAlertIcon } from "lucide-react";
import { memo, useLayoutEffect, useRef } from "react";
import type { JSX } from "react";

import { cn } from "@/lib/utils";

import { STATUS_LABEL, type SessionState } from "../session-status";
import { prefersReducedMotion } from "../../platform/appearance";

export type StatusTone = "success" | "warning" | "danger" | "running" | "unread";

const DOT_TONE: Record<StatusTone, string> = {
  success: "bg-dot-success",
  warning: "bg-dot-warning",
  danger: "bg-dot-danger",
  running: "bg-dot-running",
  unread: "bg-dot-unread",
};

/** A solid status dot. Decorative: the state's words live next to it. */
export function StatusDot({
  tone,
  size = 6,
  className,
}: {
  tone: StatusTone;
  size?: 6 | 8;
  className?: string;
}): JSX.Element {
  return (
    <span
      aria-hidden
      data-slot="status-dot"
      className={cn("inline-block shrink-0 rounded-full", size === 8 ? "size-2" : "size-1.5", DOT_TONE[tone], className)}
    />
  );
}

// One period and one epoch for every ring. A list can hold a dozen running
// rows; rings started at mount time drift out of step and the screen
// shimmers. Anchoring every animation at document-timeline 0 puts a ring that
// mounts mid-flight exactly in phase with the ones already turning.
const RING_PERIOD_MS = 900;
// The core breathes slower than the arc turns, so the two read as one calm
// motion rather than a flicker; same epoch rule as the arc.
const BREATH_PERIOD_MS = 1600;

/**
 * The running indicator, and the only pulsing thing in the app: a 6px running
 * dot inside a faint track with a rotating quarter arc (12px overall); the dot
 * breathes so live work reads as alive. Under reduced motion it stands still.
 */
export const StatusRing = memo(function StatusRing({ className }: { className?: string }): JSX.Element {
  const arcRef = useRef<HTMLSpanElement | null>(null);
  const coreRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const arc = arcRef.current;
    const core = coreRef.current;
    if (!arc || !core || typeof arc.animate !== "function") return;
    if (prefersReducedMotion()) return;
    const animations = [
      arc.animate(
        { transform: ["rotate(0deg)", "rotate(360deg)"] },
        { duration: RING_PERIOD_MS, easing: "linear", iterations: Number.POSITIVE_INFINITY },
      ),
      core.animate(
        { transform: ["scale(1)", "scale(0.7)", "scale(1)"], opacity: [1, 0.55, 1] },
        { duration: BREATH_PERIOD_MS, easing: "ease-in-out", iterations: Number.POSITIVE_INFINITY },
      ),
    ];
    for (const animation of animations) animation.startTime = 0;
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, []);
  return (
    <span
      aria-hidden
      data-slot="status-ring"
      className={cn("relative inline-flex size-3 shrink-0 items-center justify-center text-running", className)}
    >
      <span className="absolute inset-0 rounded-full border-[1.5px] border-current opacity-30" />
      <span ref={arcRef} className="absolute inset-0 rounded-full border-[1.5px] border-transparent border-t-current opacity-90" />
      <span ref={coreRef} className="size-1.5 rounded-full bg-dot-running" />
    </span>
  );
});

/**
 * The glyph for one of the five session states. Idle renders nothing.
 * Named for assistive tech unless `decorative` (the label is already beside it).
 */
export function SessionStatusGlyph({
  state,
  decorative = false,
  className,
}: {
  state: SessionState;
  decorative?: boolean;
  className?: string;
}): JSX.Element | null {
  if (state === "idle") return null;
  const glyph =
    state === "needs-you" ? (
      <CircleAlertIcon aria-hidden className="size-3.5 text-warning" />
    ) : state === "working" ? (
      <StatusRing />
    ) : (
      <StatusDot tone={state === "unread" ? "unread" : "success"} />
    );
  return (
    <span
      data-slot="session-status"
      data-state={state}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": STATUS_LABEL[state] })}
      className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}
    >
      {glyph}
    </span>
  );
}
