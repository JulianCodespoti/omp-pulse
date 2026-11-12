"use client";

import type { JSX } from "react";
import { TargetIcon } from "lucide-react";

import { useStoreValue } from "@/app/store-hooks";
import { GOAL_STATUS_LABEL, goalIsOpen, goalTokensLabel } from "@/runtime/goal-state";
import type { OmpStoreApi } from "@/runtime/omp-store";

/** A quiet row under the header while the session has a goal; tap opens the goal sheet. */
export function GoalChip({ store, onOpen }: { store: OmpStoreApi; onOpen: () => void }): JSX.Element | null {
  const goal = useStoreValue(store, (state) => state.goal);
  if (!goalIsOpen(goal)) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="goal-chip"
      aria-label={`Goal: ${goal.objective}. ${GOAL_STATUS_LABEL[goal.status]}, ${goalTokensLabel(goal)}`}
      className="pressable mx-3 flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-3 text-meta text-muted-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <TargetIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left text-foreground">{goal.objective}</span>
      <span className="shrink-0 tabular-nums">
        {GOAL_STATUS_LABEL[goal.status]} · {goalTokensLabel(goal)}
      </span>
    </button>
  );
}
