"use client";

import { ChevronRightIcon } from "lucide-react";
import { agentTimeLabel, humanizeAgentName } from "@/domain/agents-from-transcript";
import { cn } from "@/lib/utils";

/**
 * Only running, failed and uncertain states are worth a word on a row; healthy
 * idle/finished agents stay quiet. Uncertain is kept visible because an
 * unknown status is still information worth showing.
 */
export type AgentTone = "running" | "failed" | "uncertain" | "quiet";

export function agentTone(status: string): AgentTone {
  const low = status.toLowerCase();
  if (low === "running") return "running";
  if (low === "failed" || low === "error" || low === "aborted") return "failed";
  if (low === "" || low === "unknown") return "uncertain";
  return "quiet";
}

/** "42s", "1m 24s", "2h 05m": the run's age, never a clock face. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "850", "64K", "1.2M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}K`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

const TONE_TEXT: Record<AgentTone, string> = {
  running: "text-primary-text",
  failed: "text-danger-text",
  uncertain: "text-attention",
  quiet: "text-muted-foreground",
};

/** A status word; only a running agent carries the small primary dot (no green for healthy). */
export function AgentStatus({ label, tone, title, className }: { label: string; tone: AgentTone; title?: string; className?: string }) {
  return (
    <span
      data-testid="agent-status"
      title={title}
      className={cn("inline-flex shrink-0 items-center gap-1.5 text-caption font-medium", TONE_TEXT[tone], className)}
    >
      {tone === "running" ? <span aria-hidden className="size-1.5 rounded-full bg-primary-text" /> : null}
      {label}
    </span>
  );
}

export type AgentCardFacts = {
  /** Raw name/id as reported; rows and the detail title humanize it for display. */
  name: string;
  status: string;
  tone: AgentTone;
  /** Why the status may be stale, e.g. it is the last one the desktop reported. */
  statusTitle?: string;
  elapsedMs?: number;
  activity?: string;
  contextTokens?: number;
  /** When the agent was last heard from; the quiet trailing time of a settled row. */
  at?: number;
  /** The agent type ("scout"); shown only in the detail view. */
  agentType?: string;
};

/**
 * The one agent row: line 1 is the humanized name alone, so it
 * keeps the full width at 150% text; line 2 leads with the state — a status
 * word only when notable, otherwise a quiet time — then the
 * intent, clamped to two lines. A chevron whenever the row is tappable
 * (the conversation, or the task in this chat); no repeated bot glyph.
 */
export function AgentRowBody({ facts, opens }: { facts: AgentCardFacts; opens: boolean }) {
  const name = humanizeAgentName(facts.name);
  // One whitespace run per gap so a multi-line assignment clamps cleanly.
  const activity = facts.activity?.replace(/\s+/g, " ").trim();
  const notable = facts.tone !== "quiet";
  // Read at render: the roster clock only ticks while something runs.
  const time = !notable && facts.at !== undefined ? agentTimeLabel(facts.at) : undefined;
  return (
    // A container in rem terms: at 150% text on a 360px phone the row is
    // under 20rem, and there the name may take a second line instead of
    // ending in an ellipsis after two words.
    <span className="@container/agentrow flex min-w-0 items-center gap-4">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate break-words text-body font-medium text-foreground @max-[20rem]/agentrow:line-clamp-2 @max-[20rem]/agentrow:whitespace-normal" title={name}>{name}</span>
        {notable || time || activity ? (
          <span className="line-clamp-2 break-words text-meta text-muted-foreground">
            {notable ? <AgentStatus label={facts.status} tone={facts.tone} title={facts.statusTitle} className="text-meta" /> : null}
            {time ? <span className="tabular-nums">{time}</span> : null}
            {(notable || time) && activity ? " · " : null}
            {activity}
          </span>
        ) : null}
      </span>
      {opens ? <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden /> : null}
    </span>
  );
}

/** Flat 56dp+ row inside a `divide-y divide-hairline` list; pressed state is the only surface. */
export const AGENT_ROW_CLASS =
  "pressable block min-h-14 w-full min-w-0 py-3 text-left transition-colors active:bg-surface-3 hover:bg-surface-3/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
