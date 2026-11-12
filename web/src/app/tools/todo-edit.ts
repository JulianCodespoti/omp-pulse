import type { UiTodoPhase, UiTodoTask } from "../../domain/messages";

/**
 * Editing the board goes through omp's own `/todo` verbs (POST /api/command),
 * not the `set_todos` RPC: `/todo` records a `user_todo_edit` entry in the
 * session, so the edit survives a resume and later `/todo` commands read it
 * back, while `set_todos` only replaces omp's in-memory list (rpc-mode.ts)
 * and is lost with the process. OMP picks the first case-insensitive exact
 * text match; duplicate text is not a row identity and must be refused.
 */
export type TodoAction = "start" | "done" | "drop" | "rm";

export const TODO_ACTION_LABEL: Record<TodoAction, string> = {
  start: "Start",
  done: "Done",
  drop: "Drop",
  rm: "Remove",
};

/** What a task in this state can still become. A closed task reopens through `start`. */
export function todoActions(status: string): TodoAction[] {
  switch (status) {
    case "in_progress":
      return ["done", "drop", "rm"];
    case "completed":
    case "abandoned":
      return ["start", "rm"];
    default:
      return ["start", "done", "drop", "rm"];
  }
}

/** `start` on a closed task reads as reopening it. */
export function todoActionLabel(action: TodoAction, status: string): string {
  return action === "start" && (status === "completed" || status === "abandoned") ? "Reopen" : TODO_ACTION_LABEL[action];
}

/**
 * The `/todo` line for an action. `start` and `append` tokenize their
 * argument (quotes group, `\` escapes); `done`/`drop`/`rm` match the raw
 * remainder, where quotes would become part of the text.
 */
export function todoCommand(action: TodoAction | "append", content: string): string {
  // Matching is exact first, so a task's own spacing must survive.
  const text = action === "append" ? content.replace(/\s+/g, " ").trim() : content.trim();
  // Quoted the way omp's tokenizer reads it back: `"` groups, `\` escapes.
  if (action === "start" || action === "append") return `/todo ${action} "${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return `/todo ${action} ${text}`;
}

/** omp's `normalizeInProgressTask`: one task in progress, else the first pending one starts. */
function normalize(phases: UiTodoPhase[]): void {
  const tasks = phases.flatMap((phase) => phase.tasks);
  const active = tasks.filter((task) => task.status === "in_progress");
  for (const task of active.slice(1)) task.status = "pending";
  if (active.length > 0) return;
  const next = tasks.find((task) => task.status === "pending");
  if (next) next.status = "in_progress";
}

export interface TodoTarget {
  phase: number;
  task: number;
}

/** Never let OMP's text/fuzzy selector silently choose a different row or a phase. */
export function todoTargetError(phases: readonly UiTodoPhase[], target: TodoTarget, content: string): string | null {
  const selected = phases[target.phase]?.tasks[target.task];
  if (!selected || selected.content !== content) return "This task changed. Reopen Tasks before changing it.";
  const query = content.trim().toLowerCase();
  if (!query || selected.content.toLowerCase() !== query) {
    return "This task cannot be selected exactly. Give it a distinct name in OMP before changing it.";
  }
  let matches = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.content.toLowerCase() === query && ++matches > 1) {
        return "Several tasks have this name. Give them distinct names in OMP before changing one.";
      }
    }
  }
  return null;
}

/**
 * The board right after `action`, the way omp's `/todo` computes it, shown
 * while the command runs; the session's real state replaces it once omp
 * answers. An out-of-range target leaves the board unchanged.
 */
export function applyTodoAction(phases: readonly UiTodoPhase[], action: TodoAction, target: TodoTarget): UiTodoPhase[] {
  const next = structuredClone(phases) as UiTodoPhase[];
  const task: UiTodoTask | undefined = next[target.phase]?.tasks[target.task];
  if (!task) return next;
  switch (action) {
    case "start":
      for (const other of next.flatMap((phase) => phase.tasks)) {
        if (other.status === "in_progress") other.status = "pending";
      }
      task.status = "in_progress";
      // A blocked task that is acted on is no longer blocked.
      delete task.blocker;
      break;
    case "done":
      task.status = "completed";
      delete task.blocker;
      break;
    case "drop":
      task.status = "abandoned";
      delete task.blocker;
      break;
    case "rm":
      next[target.phase]!.tasks.splice(target.task, 1);
      break;
  }
  normalize(next);
  return next;
}

/** `/todo append <task>`: the last phase, or a new "Todos" one; first letter capitalized; no auto-start. */
export function appendTodo(phases: readonly UiTodoPhase[], content: string): UiTodoPhase[] {
  const text = content.replace(/\s+/g, " ").trim();
  const next = structuredClone(phases) as UiTodoPhase[];
  if (!text) return next;
  let phase = next.at(-1);
  if (!phase) {
    phase = { name: "Todos", tasks: [] };
    next.push(phase);
  }
  phase.tasks.push({ content: text[0]!.toUpperCase() + text.slice(1), status: "pending" });
  return next;
}
