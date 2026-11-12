import {
  BotIcon,
  CircleAlertIcon,
  CodeXmlIcon,
  ListTreeIcon,
  ScanSearchIcon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { LIST_ROW } from "./card-field";

import { StatusDot, StatusRing } from "@/app/ui/Status";
import { deriveAgents, type AgentContext, type DerivedAgent } from "@/domain/agents-from-transcript";
import { desktopAgentsFromSnapshot, type DesktopAgentStatus } from "@/domain/desktop-agents";
import type { UiMessage } from "@/domain/messages";

/**
 * One vocabulary for a subagent, whichever source reported it (a daemon child's
 * `get_subagents`, the computer's roster, or the transcript). Green means it
 * finished well; a task only recorded in the transcript has no known outcome,
 * so it gets no colour at all.
 */
export type AgentState = "working" | "needsYou" | "done" | "failed" | "stopped" | "idle" | "parked" | "recorded" | "unknown";

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  working: "Running",
  needsYou: "Needs you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  idle: "Idle",
  parked: "Parked",
  // A task the transcript records with no known outcome: it was started.
  recorded: "Started",
  unknown: "Unknown",
};

const RPC_STATE: Record<string, AgentState> = {
  running: "working",
  in_progress: "working",
  working: "working",
  pending: "working",
  queued: "working",
  starting: "working",
  // Only explicit input waits establish that someone needs to answer.
  awaiting_input: "needsYou",
  needs_input: "needsYou",
  completed: "done",
  complete: "done",
  done: "done",
  succeeded: "done",
  success: "done",
  ok: "done",
  failed: "failed",
  error: "failed",
  errored: "failed",
  cancelled: "stopped",
  canceled: "stopped",
  aborted: "stopped",
  stopped: "stopped",
  idle: "idle",
  parked: "parked",
};

/** A daemon child reports free-form status words (`in_progress`, `completed`…). */
export function agentStateFromStatus(raw: string | undefined): AgentState {
  return RPC_STATE[(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")] ?? "unknown";
}

// Parked workers have been retained on disk after their idle TTL, not asked a question.
const DESKTOP_STATE: Record<DesktopAgentStatus, AgentState> = {
  running: "working",
  parked: "parked",
  idle: "idle",
  aborted: "stopped",
  unknown: "unknown",
};

export function desktopAgentState(status: DesktopAgentStatus): AgentState {
  return DESKTOP_STATE[status];
}

export function derivedAgentState(state: DerivedAgent["state"]): AgentState {
  return state === "running" ? "working"
    : state === "done" ? "done"
      : state === "error" ? "failed"
        : state === "stopped" ? "stopped"
          : "recorded";
}

/**
 * The name a row shows: omp's agent ids often end in "Agent"
 * ("ResearchAgent", "review-agent"), which every row in an agents list would
 * repeat. Only an identifier's suffix goes; a phrase ("Current agent") is
 * prose and stays whole. Callers keep the full name in the title/aria-label.
 */
export function agentDisplayName(name: string): string {
  const short = name.replace(/(?<=[A-Za-z0-9])(?:Agent|[-_]agent)$/, "");
  return short || name;
}

/** The leading glyph for an agent; quiet states draw `fallback` (or nothing). */
export function AgentStatusGlyph({ state, fallback = null }: { state: AgentState; fallback?: ReactNode }): JSX.Element | null {
  if (state === "working") return <StatusRing />;
  if (state === "needsYou") return <CircleAlertIcon aria-hidden className="size-3.5 text-warning" />;
  if (state === "done") return <StatusDot tone="success" size={8} />;
  if (state === "failed") return <StatusDot tone="danger" size={8} />;
  return <>{fallback}</>;
}

/**
 * The state word's colour: only the states that need a look (running, needs
 * you, failed) are tinted; routine ones stay grey.
 */
export const AGENT_STATE_TONE: Partial<Record<AgentState, string>> = {
  working: "text-running",
  needsYou: "text-warning",
  failed: "text-danger",
};

// First match wins: "security-reviewer" is a reviewer, "research" a search.
const KIND_ICON: readonly (readonly [RegExp, LucideIcon])[] = [
  [/review|audit|critic/i, ScanSearchIcon],
  [/explor|scout|search|research|investigat/i, SearchIcon],
  [/plan|architect/i, ListTreeIcon],
  [/task|implement|code|coder|worker|build|fix/i, CodeXmlIcon],
];

const TILE_TONE: Partial<Record<AgentState, string>> = {
  working: "bg-running-tint text-running",
  needsYou: "bg-warning-tint text-warning",
  failed: "bg-danger-tint text-danger",
};

/**
 * The 36px leading tile of an agent row: what kind of agent it is (from its
 * type or name), tinted by what it is doing so a working or stuck agent
 * stands out of the list before its words are read. Decorative; the row
 * names the agent and its state.
 */
export function AgentTile({ kind, state }: { kind: string | undefined; state: AgentState }): JSX.Element {
  const Icon = KIND_ICON.find(([pattern]) => pattern.test(kind ?? ""))?.[1] ?? BotIcon;
  return (
    <span
      aria-hidden
      data-slot="agent-tile"
      data-state={state}
      className={cn(
        "flex size-9 items-center justify-center rounded-md transition-colors duration-[var(--dur-base)]",
        TILE_TONE[state] ?? "bg-surface-2 text-muted-foreground",
      )}
    >
      <Icon className="size-4.5" />
    </span>
  );
}

/**
 * The one muted line under an agent's name: state word (coloured only when it
 * matters, with a pulsing dot while it runs) · age or run time · what it is
 * doing or was asked. Every row says its state; a task with no known outcome
 * says "Started". `time` is an age ("21m ago") or a run time ("4m 12s").
 */
export function agentMeta(state: AgentState, time?: string, snippet?: string): JSX.Element {
  const dot = <span aria-hidden className="shrink-0">·</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <span className={cn("flex shrink-0 items-center gap-1.5", AGENT_STATE_TONE[state])}>
        {state === "working" ? <StatusRing /> : null}
        {AGENT_STATE_LABEL[state]}
      </span>
      {time ? <>{dot}<span className="shrink-0">{time}</span></> : null}
      {snippet ? <>{dot}<span className="min-w-0 truncate">{snippet}</span></> : null}
    </span>
  );
}

/**
 * The page's top line: "1 needs you · 2 running · 3 finished". Only the
 * groups that exist appear; a problem leads, routine "finished" is quietest.
 */
export function agentSummaryParts(states: readonly AgentState[]): { text: string; tone?: string }[] {
  const count = (...wanted: AgentState[]) => states.filter((state) => wanted.includes(state)).length;
  const parts: { text: string; tone?: string }[] = [];
  const needs = count("needsYou");
  const failed = count("failed");
  const running = count("working");
  const finished = count("done", "stopped", "idle", "parked", "recorded", "unknown");
  if (needs) parts.push({ text: `${needs} ${needs === 1 ? "needs" : "need"} you`, tone: "text-warning" });
  if (failed) parts.push({ text: `${failed} failed`, tone: "text-danger" });
  if (running) parts.push({ text: `${running} running`, tone: "text-running" });
  if (finished) parts.push({ text: `${finished} finished` });
  return parts;
}

export function AgentSummary({ states }: { states: readonly AgentState[] }): JSX.Element | null {
  const parts = agentSummaryParts(states);
  if (parts.length === 0) return null;
  return (
    <p data-testid="agents-summary" className="flex flex-wrap items-baseline gap-x-1.5 pb-2 text-meta font-medium text-muted-foreground">
      {parts.map((part, index) => (
        <span key={part.text} className="whitespace-nowrap">
          {index > 0 ? <span aria-hidden className="pr-1.5">·</span> : null}
          <span className={part.tone}>{part.text}</span>
        </span>
      ))}
    </p>
  );
}

/** Working agents get the turning accent ring, ones waiting on you the amber one; the rest none. */
export function agentRing(state: AgentState): "live" | "attention" | undefined {
  return state === "working" ? "live" : state === "needsYou" ? "attention" : undefined;
}

/** An agent Row's classes: the shared list row, a touch taller for its two lines. */
export const AGENT_ROW_CLASS = `${LIST_ROW} min-h-15`;

/**
 * Agents working / waiting on the user in a session, from what the chat
 * already holds: the computer's roster plus the transcript's running spawns
 * (see `deriveAgents` for when a background agent still counts). A spawn the
 * roster also lists (same id) is counted once, by the roster's live status.
 * `recheckAt` is when a spawn running on the ghost guard's grace stops
 * counting, so a caller can recompute then. Pure; memoise on its inputs.
 */
export function agentCounts(
  collabAgents: readonly unknown[] | undefined,
  messages: readonly UiMessage[],
  context: AgentContext,
): { working: number; needsYou: number; recheckAt?: number } {
  const roster = desktopAgentsFromSnapshot(collabAgents ?? []);
  const rostered = new Set<string>();
  let working = 0;
  let needsYou = 0;
  for (const agent of roster) {
    rostered.add(agent.id);
    const state = DESKTOP_STATE[agent.status];
    if (state === "working") working++;
    else if (state === "needsYou") needsYou++;
  }
  let recheckAt: number | undefined;
  for (const agent of deriveAgents(messages, context)) {
    if (agent.state !== "running" || (agent.agentId !== undefined && rostered.has(agent.agentId))) continue;
    working++;
    if (agent.runningUntil !== undefined) recheckAt = Math.min(recheckAt ?? Infinity, agent.runningUntil);
  }
  return recheckAt === undefined ? { working, needsYou } : { working, needsYou, recheckAt };
}
