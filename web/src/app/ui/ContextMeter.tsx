import type { JSX } from "react";

import { cn } from "@/lib/utils";

import { contextTier } from "../session-format";

/** Short token count: `840`, `84K`, `1.2M`. Empty when unknown. */
export function formatTokens(tokens: number | null | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return "";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(Math.round(tokens));
}

// Track widths per size; `full` fills its container and is taller so it reads
// as the sheet's subject rather than a row decoration. A 28px row track was
// too short to read a fill from, so rows get 40px; the composer's bottom row
// has no slack at 412px, so compact keeps its 28px.
const TRACK = {
  row: "h-1 w-10",
  compact: "h-1 w-7",
  full: "h-1.5 w-full min-w-0 flex-1",
} as const;

/**
 * Fill colour by how full the window is. Below the 70% tier the bar is the
 * accent: a meter that stayed grey until it was nearly too late read as
 * decoration, so the healthy state now has colour too, and amber/red still
 * take over at the existing tiers.
 */
export function contextFill(percent: number): { fill: string; tone: string; tier: "amber" | "red" | null } {
  const tier = contextTier(percent);
  if (tier === "red") return { fill: "bg-danger", tone: "text-danger", tier };
  if (tier === "amber") return { fill: "bg-warning", tone: "text-warning", tier };
  return { fill: "bg-primary-text", tone: "text-muted-foreground", tier };
}

/**
 * The one context meter: how full the model's whole context window is. A
 * thin rounded bar in the accent, warning and danger past the existing 70/90
 * tiers, with the figure beside it. Every place context appears (session
 * rows, composer, usage sheet, model picker) renders this, never a ring.
 *
 * `tokens` labels it "202K / 1M" when both counts are known (a percentage
 * beside a bar said the same thing twice); otherwise the percentage.
 *
 * The fill grows and changes colour over a spring instead of jumping, so a
 * turn that eats context reads as the bar filling; the global reduced-motion
 * rule collapses both transitions to an instant snap.
 */
export function ContextMeter({
  percent,
  usedTokens,
  windowTokens,
  size = "row",
  showLabel = true,
  tokens = false,
  className,
  testId,
}: {
  percent: number;
  usedTokens?: number;
  windowTokens?: number;
  size?: keyof typeof TRACK;
  showLabel?: boolean;
  tokens?: boolean;
  className?: string;
  testId?: string;
}): JSX.Element {
  const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const rounded = Math.round(value);
  const { fill, tone, tier } = contextFill(value);
  const used = formatTokens(usedTokens);
  const total = formatTokens(windowTokens);
  const label = used && total && (size === "full" || tokens)
    ? size === "full" ? `${used} of ${total} · ${rounded}%` : `${used} / ${total}`
    : `${rounded}%`;
  return (
    <span
      role="meter"
      aria-valuenow={rounded}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Context ${rounded}% used`}
      data-slot="context-meter"
      data-tone={tier ?? "muted"}
      data-testid={testId}
      className={cn("inline-flex min-w-0 items-center gap-1.5", size === "full" && "flex w-full gap-3", className)}
    >
      {/* foreground/12, not surface-3: the track must read as an empty bar
          against any surface, or a low fill looks like no meter at all. */}
      <span aria-hidden className={cn("relative shrink-0 overflow-hidden rounded-full bg-foreground/12", TRACK[size])}>
        <span
          className={cn(
            // scale, not width: a width transition lays out every frame, and
            // this bar sits beside the composer while a turn streams.
            "absolute inset-y-0 left-0 w-full origin-left rounded-full transition-[scale,background-color] duration-[400ms] ease-[var(--ease-position)]",
            fill,
          )}
          // 1% of a 40px track is under a pixel: keep a visible sliver.
          style={{ scale: String(Math.max(value >= 1 ? 0.02 : 0, Math.min(100, value) / 100)) }}
        />
      </span>
      {showLabel ? (
        <span
          aria-hidden
          className={cn(
            "shrink-0 whitespace-nowrap text-meta tabular-nums transition-colors duration-[400ms] ease-[var(--ease-spring)]",
            tone,
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
