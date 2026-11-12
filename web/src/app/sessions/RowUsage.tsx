import { cn } from "@/lib/utils";

import type { OmpSessionSummary } from "../../domain/protocol";
import { contextWindowFor } from "../../runtime/omp-store";
import { contextTier, getCtxPercent } from "../session-format";
import { formatTokens } from "../ui/ContextMeter";

export interface RowUsageFigures {
  /** Whenever known (picking which conversation to continue depends on how full it is). */
  percent: number;
  /** Tokens in use and the model's window, for the "202K / 1M" label; absent when either is unknown. */
  usedTokens?: number;
  windowTokens?: number;
}

/** A row's context fill, or null when it is unknown. */
export function rowUsage(session: OmpSessionSummary): RowUsageFigures | null {
  const percent = getCtxPercent(session);
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const windowTokens = contextWindowFor(typeof session.model === "string" ? session.model : undefined);
  // A live child's exact percent wins over the listing's last-turn tokens (see
  // getCtxPercent), so the label is derived from that percent: "10K / 100K"
  // beside a 91% bar would contradict itself.
  const live = typeof session.ctxPercent === "number" && Number.isFinite(session.ctxPercent);
  const usedTokens = windowTokens
    ? live ? Math.round((percent / 100) * windowTokens) : session.ctxTokens
    : undefined;
  return { percent, usedTokens, windowTokens };
}

const RING_R = 5;
const RING_LEN = 2 * Math.PI * RING_R;

/**
 * A session row's context fill: a 14px ring with the percent beside it
 * (amber/red past the tiers, otherwise quiet). The token figures
 * ("202K / 1M") live in the tooltip.
 */
export function RowUsage({ usage }: { usage: RowUsageFigures }) {
  const { percent, usedTokens, windowTokens } = usage;
  const tier = contextTier(percent);
  const tone = tier === "red" ? "text-danger" : tier === "amber" ? "text-warning" : "text-tertiary";
  const shown = Math.min(100, Math.max(0, percent));
  const tokens = usedTokens !== undefined && windowTokens ? `${formatTokens(usedTokens)} / ${formatTokens(windowTokens)} tokens` : undefined;
  return (
    <span
      data-testid="session-usage-context"
      data-tone={tier ?? "muted"}
      role="meter"
      aria-label={`Context ${Math.round(percent)}% used`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown)}
      title={tokens}
      className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums", tone)}
    >
      <svg aria-hidden viewBox="0 0 14 14" className="size-3.5 -rotate-90">
        <circle cx="7" cy="7" r={RING_R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle
          cx="7"
          cy="7"
          r={RING_R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING_LEN}
          strokeDashoffset={RING_LEN * (1 - shown / 100)}
        />
      </svg>
      {Math.round(percent)}%
    </span>
  );
}
