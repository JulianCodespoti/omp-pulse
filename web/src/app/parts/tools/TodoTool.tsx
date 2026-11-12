"use client";

import { CheckIcon, CirclePauseIcon } from "lucide-react";

import type { UiTodoPhase, UiTodoTask } from "@/domain/messages";
import { cn } from "@/lib/utils";

import { todoDone } from "./describe";

/** 16px status mark: a filled check once done, an accent ring with a dot while worked, a hollow ring otherwise. */
function TaskGlyph({ task }: { task: UiTodoTask }) {
  if (todoDone(task)) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-background">
        <CheckIcon aria-hidden className="size-3" strokeWidth={3} />
      </span>
    );
  }
  if (task.status === "blocked") {
    return <CirclePauseIcon aria-hidden className="size-4 shrink-0 text-warning" />;
  }
  if (task.status === "in_progress") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full border-2 border-primary-text">
        <span className="size-1.5 rounded-full bg-primary-text" />
      </span>
    );
  }
  // A dropped task keeps the hollow ring, dashed: it was never done.
  return <span className={cn("size-4 shrink-0 rounded-full border-[1.5px] border-tertiary", task.status === "abandoned" && "border-dashed")} />;
}

function statusWord(task: UiTodoTask): string {
  if (todoDone(task)) return "Done";
  if (task.status === "in_progress") return "In progress";
  if (task.status === "abandoned") return "Dropped";
  if (task.status === "blocked") return "Blocked";
  return "To do";
}

/**
 * One task: its status mark, text struck through once done. `connector` draws
 * the thin line down to the next task's mark, so a plan reads as one sequence.
 * Spans with list roles, so a task may sit inside any phrasing container.
 */
export function TodoTaskRow({ task, notes = false, connector = false }: { task: UiTodoTask; notes?: boolean; connector?: boolean }) {
  const finished = todoDone(task) || task.status === "abandoned";
  return (
    <span role="listitem" className="relative flex min-w-0 items-start gap-2.5 py-1.5" data-testid="todo-task" data-status={task.status}>
      {connector ? (
        // From 2px under this mark (6px pad + 2px + 16px mark) to 2px above the next one, centred on the 16px column.
        <span aria-hidden className="absolute bottom-[calc(-0.5rem+2px)] left-[calc(0.5rem-0.5px)] top-[calc(1.5rem+2px)] w-px bg-surface-3" />
      ) : null}
      <span className="flex h-5 items-center"><TaskGlyph task={task} /></span>
      <span className="min-w-0 flex-1">
        <span className="sr-only">{statusWord(task)}: </span>
        <span className={cn("text-ui [overflow-wrap:anywhere]", finished ? "text-tertiary" : "text-foreground")}>{task.content}</span>
        {task.status === "blocked" ? <span className="block text-meta text-warning [overflow-wrap:anywhere]">Blocked{task.blocker ? `: ${task.blocker}` : ""}</span> : null}
        {notes && task.notes ? <span className="block text-meta text-muted-foreground [overflow-wrap:anywhere]">{task.notes}</span> : null}
      </span>
    </span>
  );
}

/** Every phase of the board, for the call's detail view. */
export function TodoBoard({ phases }: { phases: readonly UiTodoPhase[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="todo-board">
      {phases.map((phase, index) => (
        <section key={index} className="min-w-0">
          {phase.name ? <h3 className="pb-1 text-meta font-medium text-muted-foreground">{phase.name}</h3> : null}
          <div role="list">
            {phase.tasks.map((task, taskIndex) => <TodoTaskRow key={taskIndex} task={task} notes connector={taskIndex < phase.tasks.length - 1} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
