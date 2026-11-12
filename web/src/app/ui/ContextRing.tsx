import type { JSX } from "react";

import { cn } from "@/lib/utils";

import { contextTier } from "../session-format";

const STROKE = { red: "stroke-danger", amber: "stroke-warning" } as const;

/**
 * How full the context window is, as a 64px ring with the percentage inside.
 * Healthy is the running blue; amber and red take over at the shared tiers.
 */
export function ContextRing({ percent, className, compact = false }: { percent: number; className?: string; /** A 24px ring with no figure inside: the composer chip prints the figure beside it. */ compact?: boolean }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  const tier = contextTier(clamped);
  return (
    <span
      role="img"
      aria-label={`Context ${Math.round(clamped)}% full`}
      data-testid="context-ring"
      className={cn("relative inline-flex shrink-0 items-center justify-center", compact ? "size-6" : "size-16", className)}
    >
      <svg aria-hidden viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="stroke-surface-3" />
        <circle
          cx="18"
          cy="18"
          r="15"
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${clamped} 100`}
          className={cn(tier ? STROKE[tier] : "stroke-running", "transition-[stroke-dasharray] duration-[var(--dur-slow)] motion-reduce:transition-none")}
        />
      </svg>
      {compact ? null : <span className="text-ui font-medium tabular-nums text-foreground">{Math.round(clamped)}%</span>}
    </span>
  );
}
