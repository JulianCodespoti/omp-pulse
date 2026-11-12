import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "@/lib/utils";

const TONE = {
  muted: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-danger",
} as const;

/**
 * One figure: a 14px icon and a tabular number, the way assistant apps show
 * duration, speed, cost or counts. `label` names it for assistive tech and
 * hover ("Duration", "Cost"). The icon vocabulary is fixed across the app:
 * Timer duration, Gauge speed, CircleDollarSign cost, Hash token counts,
 * FileDiff changed files. Context is never a Metric; it is a ContextMeter.
 *
 * `live` marks a figure that ticks. Tabular digits plus a min-width sized to
 * the current digit count keep the row from shifting on every tick.
 */
export function Metric({
  icon: Icon,
  value,
  label,
  tone = "muted",
  live = false,
  className,
  testId,
}: {
  icon: LucideIcon;
  value: ReactNode;
  label: string;
  tone?: keyof typeof TONE;
  live?: boolean;
  className?: string;
  testId?: string;
}): JSX.Element {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : null;
  // A plain figure is announced as one phrase ("Cost $0.42"); a composed value
  // stays readable as content, with the label as a visually hidden prefix.
  const a11y = text !== null ? { role: "img" as const, "aria-label": `${label} ${text}` } : {};
  return (
    <span
      data-slot="metric"
      data-testid={testId}
      title={label}
      {...a11y}
      className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-meta tabular-nums", TONE[tone], className)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {text === null ? <span className="sr-only">{label}: </span> : null}
      <span aria-hidden={text !== null || undefined} style={live && text !== null ? { minWidth: `${text.length}ch` } : undefined}>
        {value}
      </span>
    </span>
  );
}

/** Lays metrics (and a ContextMeter) out in a row with 12px gaps, no separators. */
export function MetricRow({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <span data-slot="metric-row" className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1", className)}>
      {children}
    </span>
  );
}
