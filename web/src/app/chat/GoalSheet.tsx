"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { PauseIcon, PlayIcon, RefreshCwIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useStoreValue } from "@/app/store-hooks";
import { GOAL_STATUS_LABEL, goalIsOpen, goalTokensLabel } from "@/runtime/goal-state";
import type { OmpSessionController } from "@/runtime/omp-session-controller";

import { BottomSheet, SheetGroup, SheetRow } from "../ui/Sheet";
import { ErrorNotice } from "../ui/ErrorNotice";
import { humanizeDaemonError } from "../ui/OwnedBySession";

const FIELD_CLASS =
  "rounded-lg border-0 bg-surface-2 px-4 text-body shadow-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40";

type GoalOp = "get" | "create" | "resume" | "pause" | "drop";

/**
 * omp's goal mode over its `goal` RPC: set an objective (and an optional token
 * budget) the agent keeps working toward, then pause, resume or drop it. The
 * state shown is the store's, fed by `get_state.goal` and `goal_updated`, so
 * a change the agent makes with its own goal tool shows up here too.
 */
export function GoalSheet({
  open,
  onOpenChange,
  controller,
  seed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: OmpSessionController;
  /** Objective prefilled from a typed `/goal …`. */
  seed: string;
}): JSX.Element {
  const goal = useStoreValue(controller.getStore(), (state) => state.goal);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState<GoalOp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visit = useRef(0);

  const run = async (op: GoalOp, params?: { objective?: string; token_budget?: number }): Promise<boolean> => {
    const current = visit.current;
    setBusy(op);
    setError(null);
    try {
      await controller.runGoal(op, params);
      return true;
    } catch (e) {
      if (current === visit.current) setError(humanizeDaemonError(e));
      return false;
    } finally {
      if (current === visit.current) setBusy(null);
    }
  };

  // Each opening is a fresh visit: reset the form and ask omp for the status,
  // since a goal can change while nobody watched the socket.
  useLayoutEffect(() => {
    visit.current++;
    if (!open) return;
    setObjective(seed);
    setBudget("");
    setError(null);
    void run("get");
    // Once per opening: `run` is a fresh closure every render.
  }, [open]);

  const budgetValue = budget.trim() === "" ? undefined : Number(budget.trim());
  const budgetValid = budgetValue === undefined || (Number.isInteger(budgetValue) && budgetValue > 0);
  const canStart = objective.trim() !== "" && budgetValid && busy === null;
  const start = async () => {
    if (!canStart) return;
    if (await run("create", { objective: objective.trim(), ...(budgetValue !== undefined ? { token_budget: budgetValue } : {}) })) {
      setObjective("");
      setBudget("");
    }
  };

  const active = goalIsOpen(goal) ? goal : null;
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Goal"
      testId="goal-sheet"
      footer={
        active ? null : (
          // One full-width CTA; the header × already closes the sheet.
          <Button className="pressable h-auto min-h-12 w-full whitespace-normal rounded-lg px-4 py-2 text-ui font-semibold leading-tight" disabled={!canStart} onClick={() => void start()} type="button">
            {busy === "create" ? "Starting…" : "Start goal"}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {active ? (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-body font-medium text-foreground [overflow-wrap:anywhere]">{active.objective}</p>
              <p className="text-meta text-muted-foreground tabular-nums">
                {GOAL_STATUS_LABEL[active.status]} · {goalTokensLabel(active)}
              </p>
            </div>
            <SheetGroup
              footnote={active.status === "budget-limited" ? "The spending limit is used up. Drop this goal to set a new one." : undefined}
            >
              {active.status === "active" ? (
                <SheetRow icon={<PauseIcon aria-hidden className="size-4" />} title="Pause" meta="The agent stops after this step" disabled={busy !== null} onClick={() => void run("pause")} />
              ) : null}
              {active.status === "paused" ? (
                <SheetRow icon={<PlayIcon aria-hidden className="size-4" />} title="Resume" meta="The agent picks the goal back up" disabled={busy !== null} onClick={() => void run("resume")} />
              ) : null}
              <SheetRow icon={<XIcon aria-hidden className="size-4" />} title="Drop goal" meta="Stop working toward it" disabled={busy !== null} onClick={() => void run("drop")} />
              <SheetRow icon={<RefreshCwIcon aria-hidden className="size-4" />} title="Check status" disabled={busy !== null} onClick={() => void run("get")} />
            </SheetGroup>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <Textarea
              value={objective}
              onChange={(e) => setObjective(e.currentTarget.value)}
              placeholder="What should the agent achieve?"
              aria-label="Goal"
              rows={3}
              className={`min-h-24 resize-none py-3 ${FIELD_CLASS}`}
              autoFocus
            />
            {/* Label and value share a line; when large text leaves no room
                the field drops under its label at full width. */}
            <label className="flex flex-wrap items-center gap-x-4 gap-y-2 py-1">
              <span className="flex min-w-0 flex-1 basis-40 flex-col">
                <span className="text-body text-foreground">Spending limit</span>
                <span className="text-caption text-muted-foreground">In tokens, optional</span>
              </span>
              <Input
                value={budget}
                onChange={(e) => setBudget(e.currentTarget.value.replace(/[^\d]/g, ""))}
                placeholder="No limit"
                aria-label="Spending limit in tokens"
                inputMode="numeric"
                enterKeyHint="done"
                className={`h-12 min-w-0 flex-1 basis-32 tabular-nums ${FIELD_CLASS}`}
              />
            </label>
            <p className="text-caption text-muted-foreground">The agent keeps going until it’s done, hits the limit, or is paused.</p>
          </div>
        )}
        {busy === "get" && !active ? <p className="text-meta text-muted-foreground">Checking for a goal…</p> : null}
        {error ? <ErrorNotice message={error} /> : null}
      </div>
    </BottomSheet>
  );
}
