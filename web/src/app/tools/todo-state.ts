import type { UiMessage, UiTodoPhase } from "../../domain/messages";

/**
 * The agent's todo list as of its newest `todo` tool result. Each result holds
 * the whole list after that call, so the newest one IS the board; there is no
 * history to replay. `undefined` means this session has not used the todo tool
 * (or its newest call is outside the loaded window).
 *
 * Kept apart from TasksTab so the chat can show progress without pulling the
 * tab's code into the first load.
 */
export function latestTodos(messages: readonly UiMessage[]): UiTodoPhase[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]!.parts;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      if (part.kind === "tool" && part.todo) return part.todo;
    }
  }
  return undefined;
}

export interface TodoProgress {
  done: number;
  total: number;
  /** The task being worked on now, if any. */
  current?: string;
}

export function todoProgress(phases: readonly UiTodoPhase[] | undefined): TodoProgress | null {
  if (!phases) return null;
  let done = 0;
  let total = 0;
  let current: string | undefined;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      // An abandoned task is closed too: it no longer blocks the plan.
      total++;
      if (task.status === "completed" || task.status === "abandoned") done++;
      else if (task.status === "in_progress" && current === undefined) current = task.content;
    }
  }
  return total > 0 ? { done, total, current } : null;
}
