import type { UiMessage, UiPart } from "./messages";

// Verified against real session at ~/.local/share/omp/sessions/*/*.jsonl:
// toolCall name is lowercase "task" (case-insensitive handle for "Task").
// No other spawn-shaped tool confirmed — bash/read/edit/grep etc are file ops.
// task args shape: { i?: string, context?: string, tasks: [{ name?: string, agent?: string, task?: string, id?: string, description?: string, assignment?: string }] }
// Also seen older variant: tasks with { id, description, assignment } and no agent field.
// Intent for the part is args.i / part.intent — per-message intent, but per-subagent
// intent lives in tasks[i].task or tasks[i].assignment.
//
// omp runs `task` in the background: the call's result arrives at spawn time
// with `details.progress[i] = { id, status: "pending" }`, and each agent's end
// arrives later as a `wait` result's job snapshot or an `async-result` notice
// (see `UiAgentStatus` in ./messages). A call that is still waiting for its
// result is the older synchronous shape.

/**
 * `ok`: the call returned but nothing says how the agent ended (a sync result
 * without progress, an old transcript, or a spawn past the ghost guard).
 */
export type DerivedAgentState = "running" | "ok" | "done" | "error" | "stopped";

export interface DerivedAgent {
  id: string; // the tool callId that spawned it (suffix added when one call spawns many)
  name: string; // task name/id from the tool args (agent type only as a fallback)
  intent?: string; // the task given to it
  state: DerivedAgentState;
  startedAt?: Date;
  output?: string; // result summary when finished
  /** omp's own id for the agent (its job id), when the call or its args name one. */
  agentId?: string;
  /** Running only on the ghost guard's grace: epoch ms when it stops counting. */
  runningUntil?: number;
}

export interface AgentContext {
  /** The session's turn is running right now. */
  live: boolean;
  /** When the running turn started (epoch ms, this device's clock), when known. */
  turnStartedAt?: number;
  /** Epoch ms. */
  now: number;
  /** Agents `async-result` notices reported finished, id → status (store `settledAgents`). */
  settled?: Readonly<Record<string, string>>;
}

/**
 * The ghost guard. An agent with no end report counts as running only if it
 * was spawned during the running turn, or less than 30 minutes ago.
 * - The turn alone is not enough either way: omp's parent often ends its turn
 *   and lets results auto-deliver, so its agents keep working while the
 *   session reads idle (the 30 minutes cover that); and reopening an old chat
 *   to send one message must not revive every spawn it ever missed an end for.
 * - The window bounds a missed end notice (a daemon restart, a killed job):
 *   past it the row reads as only started, never as months of "Working".
 */
export const UNSETTLED_AGENT_GRACE_MS = 30 * 60_000;
/** Spawn and turn times come from different clocks (laptop entries, phone-shifted activity). */
const TURN_CLOCK_SLACK_MS = 60_000;

const STATUS_STATE: Record<string, Exclude<DerivedAgentState, "ok">> = {
  pending: "running",
  queued: "running",
  starting: "running",
  running: "running",
  in_progress: "running",
  working: "running",
  completed: "done",
  complete: "done",
  done: "done",
  succeeded: "done",
  success: "done",
  ok: "done",
  failed: "error",
  error: "error",
  errored: "error",
  cancelled: "stopped",
  canceled: "stopped",
  aborted: "stopped",
  stopped: "stopped",
  killed: "stopped",
};

type ToolPart = Extract<UiPart, { kind: "tool" }>;

function isTaskPart(part: UiPart): part is ToolPart {
  // Only the confirmed spawn tool — lowercase "task", handle "Task" defensively.
  return part.kind === "tool" && part.name.toLowerCase() === "task";
}

/**
 * Each agent's latest reported status: spawn progress and `wait` snapshots in
 * transcript order, then `async-result` notices (always an end) on top.
 */
function reportedStatuses(messages: readonly UiMessage[], settled: AgentContext["settled"]): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.kind !== "tool" || !part.agents) continue;
      for (const agent of part.agents) statuses.set(agent.id, agent.status);
    }
  }
  if (settled) for (const [id, status] of Object.entries(settled)) statuses.set(id, status);
  return statuses;
}

// The task's own name/id ("LedgerClientAudit") identifies the row; the agent
// type ("scout") is implementation detail, so it is only the last resort.
function taskLabel(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.name === "string" && entry.name) return entry.name;
  if (typeof entry.id === "string" && entry.id) return entry.id;
  if (typeof entry.agent === "string" && entry.agent) return entry.agent;
  return undefined;
}

// The short description reads best on a two-line row; the full assignment is
// the fallback.
function taskIntent(
  entry: Record<string, unknown>,
  fallbackIntent?: string,
): string | undefined {
  if (typeof entry.description === "string" && entry.description) return entry.description;
  if (typeof entry.task === "string" && entry.task) return entry.task;
  if (typeof entry.assignment === "string" && entry.assignment) return entry.assignment;
  if (typeof fallbackIntent === "string" && fallbackIntent) return fallbackIntent;
  return undefined;
}

function entryAgentId(entry: Record<string, unknown> | null): string | undefined {
  if (!entry) return undefined;
  if (typeof entry.name === "string" && entry.name) return entry.name;
  if (typeof entry.id === "string" && entry.id) return entry.id;
  return undefined;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*$/;

/**
 * "LedgerClientAudit" → "Ledger client audit", "fix_api-retry" → "Fix api
 * retry", "APIClient" → "API client". Only bare identifiers are rewritten:
 * prose, ids with spaces and hash-like tokens pass through untouched.
 */
export function humanizeAgentName(raw: string): string {
  const name = raw.trim();
  if (!IDENTIFIER.test(name)) return raw;
  const words = name
    .split(/[-_.]+/)
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" "));
  if (words.some((word) => word.length >= 6 && /\d/.test(word) && /^[0-9a-f]+$/i.test(word))) return raw;
  return words
    .map((word, index) => {
      if (word.length > 1 && /[A-Z]/.test(word) && word === word.toUpperCase()) return word;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Just now", "2 min ago", "3 hours ago", "Yesterday", "Aug 28" — never an ambiguous "48d". */
export function agentTimeLabel(at: number, now = Date.now()): string {
  const diff = now - at;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) {
    const hours = Math.floor(diff / 3_600_000);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (at >= yesterday.getTime()) return "Yesterday";
  const date = new Date(at);
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === today.getFullYear() ? label : `${label}, ${date.getFullYear()}`;
}

export function deriveAgents(messages: readonly UiMessage[], context: AgentContext): DerivedAgent[] {
  const out: DerivedAgent[] = [];
  const statuses = reportedStatuses(messages, context.settled);

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (!isTaskPart(part)) continue;

      const args = part.args as unknown;
      const argsObj = args !== null && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null;

      const fallbackIntent = typeof part.intent === "string" ? part.intent : undefined;
      const spawnedAt = part.endedAt ?? part.startedAt ?? msg.createdAt?.getTime();
      // The spawn result lists agents in `tasks` order; when it does not line
      // up, the args' own names are omp's ids.
      const reportedIds = part.agents;
      const push = (id: string, name: string, intent: string | undefined, index: number, entry: Record<string, unknown> | null, count: number): void => {
        const agentId = reportedIds && reportedIds.length === count ? reportedIds[index]!.id : entryAgentId(entry);
        out.push({
          id,
          name,
          intent,
          ...stateOf(part, agentId, statuses, spawnedAt, context),
          startedAt: msg.createdAt,
          output: part.output,
          ...(agentId ? { agentId } : {}),
        });
      };

      // Preferred shape: args.tasks is an array of subagent specs.
      if (argsObj !== null && Array.isArray(argsObj.tasks)) {
        const tasks = argsObj.tasks as unknown[];
        if (tasks.length === 0) {
          push(part.callId, fallbackIntent ? fallbackIntent.slice(0, 80) : "task", fallbackIntent, 0, null, 1);
          continue;
        }
        for (let idx = 0; idx < tasks.length; idx++) {
          const raw = tasks[idx];
          const entry =
            raw !== null && typeof raw === "object" && !Array.isArray(raw)
              ? (raw as Record<string, unknown>)
              : null;
          if (entry === null) {
            push(tasks.length === 1 ? part.callId : `${part.callId}:${idx}`, "agent", fallbackIntent, idx, null, tasks.length);
            continue;
          }
          // When one tool call spawns many agents, suffix the callId so rows stay key-stable.
          const id = tasks.length === 1 ? part.callId : `${part.callId}:${entry.name ?? entry.id ?? idx}`;
          push(id, taskLabel(entry) ?? "agent", taskIntent(entry, fallbackIntent), idx, entry, tasks.length);
        }
        continue;
      }

      // Fallback shape: single agent encoded directly in args (no tasks array).
      // Seen in older transcript shapes: { agent, task } at top level.
      if (argsObj !== null) {
        const singleName =
          (typeof argsObj.name === "string" && argsObj.name) ||
          (typeof argsObj.agent === "string" && argsObj.agent) ||
          undefined;
        const singleIntent =
          (typeof argsObj.task === "string" && argsObj.task) ||
          (typeof argsObj.assignment === "string" && argsObj.assignment) ||
          (typeof argsObj.description === "string" && argsObj.description) ||
          fallbackIntent ||
          undefined;
        if (singleName !== undefined || singleIntent !== undefined) {
          push(part.callId, singleName ?? "task", singleIntent, 0, null, 1);
          continue;
        }
      }

      // Last resort: generic task call with no discoverable sub-structure.
      // Use the tool intent (args.i) as both name hint and intent so the row is still useful.
      const genericName = fallbackIntent ? fallbackIntent.split("\n")[0].slice(0, 40).trim() || "task" : "task";
      push(part.callId, genericName, fallbackIntent, 0, null, 1);
    }
  }

  // Transcript is oldest-first; UI wants newest first.
  out.reverse();
  return out;
}

function stateOf(
  part: ToolPart,
  agentId: string | undefined,
  statuses: ReadonlyMap<string, string>,
  spawnedAt: number | undefined,
  context: AgentContext,
): Pick<DerivedAgent, "state" | "runningUntil"> {
  const raw = agentId ? statuses.get(agentId) : undefined;
  const reported = raw === undefined ? undefined : stateFromStatus(raw);
  if (reported !== undefined && reported !== "running") return { state: reported };
  if (part.state === "error") return { state: "error" };
  // No result yet: the synchronous shape. Without a running turn the call
  // was interrupted, so it is only recorded.
  if (part.state === "running" && !context.live) return { state: "ok" };
  // A returned call that reports no agents (a sync result, an old transcript)
  // says nothing more than that they were started.
  if (part.state !== "running" && reported === undefined) return { state: "ok" };
  const thisTurn = context.live && spawnedAt !== undefined && context.turnStartedAt !== undefined
    && spawnedAt >= context.turnStartedAt - TURN_CLOCK_SLACK_MS;
  if (thisTurn) return { state: "running" };
  const until = spawnedAt === undefined ? undefined : spawnedAt + UNSETTLED_AGENT_GRACE_MS;
  return until !== undefined && context.now < until ? { state: "running", runningUntil: until } : { state: "ok" };
}

/** omp's status word for an agent as a derived state; undefined for words it does not know. */
export function stateFromStatus(status: string): Exclude<DerivedAgentState, "ok"> | undefined {
  const key = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return Object.prototype.hasOwnProperty.call(STATUS_STATE, key) ? STATUS_STATE[key] : undefined;
}

/**
 * The Agents sheet's transcript rows: the loaded window plus what the
 * daemon's whole-file scan (`/api/agents`, oldest first) found before it.
 *
 * The scan runs once per opening, so a subagent spawned afterwards exists
 * only in the window; preferring the scan whenever it had rows hid it until
 * the sheet was reopened. A spawning call in the window wins over its scanned
 * copy because only the window knows whether it is still running. The two
 * sources suffix multi-task call ids differently, so calls match on the base
 * call id. Newest first, like `deriveAgents`.
 */
export function mergeAgentRows(scanned: readonly DerivedAgent[] | null, fromWindow: readonly DerivedAgent[]): DerivedAgent[] {
  if (!scanned || scanned.length === 0) return [...fromWindow];
  const inWindow = new Set(fromWindow.map((agent) => agent.id.split(":")[0]));
  const older = scanned.filter((agent) => !inWindow.has(agent.id.split(":")[0])).reverse();
  return [...fromWindow, ...older];
}
