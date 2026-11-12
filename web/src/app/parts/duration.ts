import { useEffect, useState } from "react";
import { startVisibleInterval } from "@/runtime/visible-interval";

/**
 * A span older than this is not a measured duration: it is a start time from
 * a transcript whose end never arrived (a killed session). No clock is honest
 * there, so nothing is shown.
 */
export const MAX_HONEST_MS = 12 * 60 * 60 * 1000;

/** A tool call's duration is only worth a figure once it is long enough to notice. */
export const NOTABLE_TOOL_MS = 5_000;

/** "14s", "3m 04s", "1h 04m"; null when the span is unknown or not a real measurement. */
export function spokenDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_HONEST_MS) return null;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  // Two-digit seconds keep a ticking figure the same width.
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The wall clock, re-read every second while `active` and the page is
 * visible. Re-reading rather than counting ticks: a backgrounded WebView
 * throttles timers, and a counted clock drifts. A hidden page arms no timer;
 * showing it re-reads at once.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return startVisibleInterval(() => setNow(Date.now()), 1000, { tickOnShow: true });
  }, [active]);
  return now;
}
