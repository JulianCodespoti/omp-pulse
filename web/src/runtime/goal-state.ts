/**
 * omp goal mode as the phone shows it. Three sources carry the same `Goal`
 * (omp wire/state.ts): `get_state.goal` is a `GoalModeState | null` whose
 * `.goal` is it, the `goal` RPC answers `{goal, state}`, and the
 * `goal_updated` event (`{goal, state?}`) fires on every change, including
 * ones the agent makes with its own `goal` tool.
 */
export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface GoalSnapshot {
  readonly id: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly tokensUsed: number;
  readonly tokenBudget?: number;
  /** omp's epoch-ms change stamp; orders a late reply against a newer event. */
  readonly updatedAt: number;
}

export const GOAL_STATUS_LABEL: Readonly<Record<GoalStatus, string>> = {
  active: "Active",
  paused: "Paused",
  "budget-limited": "Limit reached",
  complete: "Done",
  dropped: "Dropped",
};

function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && Object.hasOwn(GOAL_STATUS_LABEL, value);
}

/** A wire `Goal`: null for an explicit null, undefined when absent or malformed. */
export function parseGoal(raw: unknown): GoalSnapshot | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === undefined) return undefined;
  const goal: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const { id, objective, status, tokensUsed, tokenBudget: budget, updatedAt } = goal;
  if (typeof id !== "string" || typeof objective !== "string" || !isGoalStatus(status)) return undefined;
  return {
    id,
    objective,
    status,
    tokensUsed: typeof tokensUsed === "number" && Number.isFinite(tokensUsed) ? tokensUsed : 0,
    ...(typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? { tokenBudget: budget } : {}),
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

/**
 * The goal in `get_state` data. undefined when the snapshot does not speak
 * for goals at all (the daemon's file-only peek, a desktop bridge), so the
 * caller keeps what it knew instead of erasing it.
 */
export function goalFromState(data: unknown): GoalSnapshot | null | undefined {
  if (typeof data !== "object" || data === null || !("goal" in data)) return undefined;
  const mode = data.goal;
  if (mode === null) return null;
  if (typeof mode !== "object" || mode === undefined || !("goal" in mode)) return undefined;
  return parseGoal(mode.goal);
}

/**
 * Apply any goal report (`goal_updated` event or `goal` RPC reply, both
 * `{goal, …}`) to what the phone shows. A malformed report changes nothing,
 * and a report older than the same goal's current snapshot (an RPC reply
 * overtaken by its own `goal_updated`) never rolls it back.
 */
export function reduceGoal(previous: GoalSnapshot | null, report: unknown): GoalSnapshot | null {
  if (typeof report !== "object" || report === null || !("goal" in report)) return previous;
  const next = parseGoal(report.goal);
  if (next === undefined) return previous;
  if (next && previous && next.id === previous.id && next.updatedAt < previous.updatedAt) return previous;
  return next;
}

/** Worth a header chip: the goal still needs the user to know it exists. */
export function goalIsOpen(goal: GoalSnapshot | null): goal is GoalSnapshot {
  return goal !== null && (goal.status === "active" || goal.status === "paused" || goal.status === "budget-limited");
}

function compactTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "12k of 50k tokens" / "12k tokens". */
export function goalTokensLabel(goal: GoalSnapshot): string {
  return goal.tokenBudget
    ? `${compactTokens(goal.tokensUsed)} of ${compactTokens(goal.tokenBudget)} tokens`
    : `${compactTokens(goal.tokensUsed)} tokens`;
}
