"use client";

import { ChevronRightIcon, TimerIcon, TriangleAlertIcon } from "lucide-react";

import { Metric } from "@/app/ui/Metric";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { NOTABLE_TOOL_MS, spokenDuration, useNow } from "../duration";
import { ShimmerText } from "../ShimmerText";
import type { ToolFace } from "./describe";

/** A running call's clock: it appears only once the call has taken long enough to notice. */
function LiveDuration({ startedAt }: { startedAt: number }) {
  const now = useNow(true);
  const ms = now - startedAt;
  const value = ms >= NOTABLE_TOOL_MS ? spokenDuration(ms) : null;
  return value ? <Metric icon={TimerIcon} value={value} label="Running for" live testId="tool-duration" /> : null;
}

/**
 * The face of every tool call, whatever the tool: one quiet line, icon + what
 * it did + what it acted on (`Ran git status · 794 lines`) + a chevron. A tap
 * opens the call's whole detail in a sheet, so nothing here grows the
 * transcript. Running swaps the chevron for a spinner and shimmers the verb,
 * unless it sits inside a work group, whose live title is the one shimmer.
 * A failure the turn ended on is a danger-tinted row that keeps the first
 * error line in view; one the agent went on past stays untinted, with the
 * same line in tertiary ink.
 */
export function ToolRow({
  face,
  state,
  interrupted = false,
  startedAt,
  meta,
  error,
  mono = false,
  onOpen,
  routineFailure = false,
  shimmer = true,
}: {
  face: ToolFace;
  state: "running" | "ok" | "error";
  /** The turn ended without this call's result. */
  interrupted?: boolean;
  startedAt?: number;
  /** Quiet trailing fact, e.g. "794 lines". */
  meta?: string | null;
  /** First line of a failed call's output. */
  error?: string;
  /** The target is a shell command. */
  mono?: boolean;
  onOpen: () => void;
  /** A failure the agent went on past (see summarizeRun): shown, but not in danger colour. */
  routineFailure?: boolean;
  /** Off inside a work group, whose live title is the one shimmering voice. */
  shimmer?: boolean;
}) {
  const running = state === "running";
  const failed = state === "error";
  const alarming = failed && !routineFailure;
  const Icon = failed ? TriangleAlertIcon : face.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      data-testid="tool-row"
      data-state={interrupted ? "interrupted" : state}
      className={cn(
        "relative flex w-full min-w-0 gap-2 rounded-lg text-left text-ui text-muted-foreground outline-none transition-colors duration-[var(--dur-fast)] after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring",
        alarming ? "press-bounce items-start bg-danger-tint px-2 py-1.5" : "press-bounce min-h-8 items-center",
        failed && "items-start",
      )}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", failed ? "mt-1" : "", alarming && "text-danger")} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline">
          <span className="min-w-0 truncate">
            <ShimmerText active={running && shimmer}>{face.label}</ShimmerText>
            {face.target ? <span className={cn(mono && "font-mono text-code")}> {face.target}</span> : null}
          </span>
          {meta ? <span className="shrink-0 whitespace-pre text-tertiary"> · {meta}</span> : null}
        </span>
        {failed && error ? (
          <span className={cn("min-w-0 truncate text-meta", alarming ? "text-danger" : "text-tertiary")} data-testid="tool-error-line">{error}</span>
        ) : null}
      </span>
      {running ? <span className="sr-only">Running</span> : null}
      {running && startedAt !== undefined ? <LiveDuration startedAt={startedAt} /> : null}
      {failed && face.failure ? (
        <span className={cn("shrink-0 text-meta tabular-nums", alarming ? "text-danger" : "text-tertiary")}>{face.failure}</span>
      ) : interrupted ? (
        <span className="shrink-0 text-meta text-tertiary">Interrupted</span>
      ) : null}
      {running ? (
        <span aria-hidden className="flex h-5 shrink-0 items-center"><Spinner size={14} label={null} /></span>
      ) : (
        <ChevronRightIcon aria-hidden className={cn("size-4 shrink-0 text-tertiary", failed && "mt-1")} />
      )}
    </button>
  );
}
