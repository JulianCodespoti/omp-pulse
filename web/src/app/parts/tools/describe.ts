import {
  BotIcon,
  FilePenLineIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

import { parseShellOutcome, type UiPart, type UiShellOutcome, type UiTodoPhase, type UiTodoTask } from "@/domain/messages";
import { isJsonObject } from "@/domain/protocol";

import { firstLine, toolSummary } from "../tool-summary";

export type ToolUiPart = Extract<UiPart, { kind: "tool" }>;
export type ToolKind = "bash" | "file" | "search" | "task" | "todo" | "generic";

function shortName(name: string): string {
  return name.toLowerCase().split(/[.:/]/).at(-1) ?? name.toLowerCase();
}

export function toolKind(name: string): ToolKind {
  const n = shortName(name);
  if (n === "todo") return "todo";
  if (n === "task" || n === "agent" || n.includes("task")) return "task";
  if (n === "bash" || n === "shell" || n === "run" || n.includes("bash") || n.includes("shell")) return "bash";
  if (n === "read" || n === "write" || n === "edit" || n === "apply_patch" || n === "hashline") return "file";
  if (n.includes("grep") || n.includes("glob") || n.includes("search") || n.includes("find")) return "search";
  return "generic";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function commandFromArgs(args: unknown): string {
  if (!isJsonObject(args)) return "";
  const v = str(args.command) || str(args.cmd) || str(args.code);
  // Keep whitespace in a real command: its copy action must preserve the source.
  return v.trim() ? v : "";
}

function numeric(...values: unknown[]): number | null {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function shellOutcome(part: ToolUiPart): UiShellOutcome {
  if (part.shell) return part.shell;
  return parseShellOutcome(part.name, undefined, part.output ?? "", part.state === "error") ?? { kind: "unknown" };
}

export function shellStatusLabel(outcome: UiShellOutcome): string {
  switch (outcome.kind) {
    case "exit": return `exit ${outcome.code}`;
    case "timeout": return "Timed out";
    case "cancelled": return "Cancelled";
    case "unknown": return "Exit status unknown";
  }
}

export function filePathFromArgs(args: unknown): string {
  if (!isJsonObject(args)) return "";
  const direct = str(args.path) || str(args.file) || str(args.file_path) || str(args.filename);
  if (direct) return direct;
  // omp's `edit` tool takes no path argument at all: the target lives in the
  // hashline patch's section header, `[path/to/file.ts#A1B2]`. Without this the
  // row fell back to the bare tool name and every edit rendered as "edit".
  const patch = str(args.input) || str(args.content) || str(args.patch);
  return /^\s*\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]/m.exec(patch)?.[1] ?? "";
}

/** Every hashline section matters; a multi-file call must not be named for only its first file. */
export function filePathsForTool(part: ToolUiPart): string[] {
  if (part.edits?.length) return [...new Set(part.edits.map((edit) => edit.path))];
  if (!isJsonObject(part.args)) return [];
  const direct = str(part.args.path) || str(part.args.file) || str(part.args.file_path) || str(part.args.filename);
  if (direct) return [direct];
  const patch = str(part.args.input) || str(part.args.content) || str(part.args.patch);
  const paths = [...patch.matchAll(/^\s*\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]/gm)].map((match) => match[1]!);
  return paths.length ? [...new Set(paths)] : [filePathFromArgs(part.args)].filter(Boolean);
}

/** Display only: split at real separators, preserving Unicode and whitespace. Roots keep their spelling. */
export function filePathLabel(rawPath: string): { basename: string; parent: string } {
  const separator = Math.max(rawPath.lastIndexOf("/"), rawPath.lastIndexOf("\\"));
  const basename = rawPath.slice(separator + 1);
  const isUncRoot = /^[\\/]{2}[^\\/]+(?:[\\/][^\\/]+)?$/.test(rawPath);
  if (!basename || isUncRoot) return { basename: rawPath, parent: "" };
  const parentSeparator = separator > 0
    ? Math.max(rawPath.lastIndexOf("/", separator - 1), rawPath.lastIndexOf("\\", separator - 1))
    : -1;
  return { basename, parent: separator > 0 ? rawPath.slice(parentSeparator + 1, separator) : "" };
}

export function fileRangeFromArgs(args: unknown): string | null {
  if (!isJsonObject(args)) return null;
  const explicit = [args.range, args.selection, args.lineRange, args.lines].map((v) => str(v).trim()).find(Boolean);
  if (explicit) return explicit;
  const start = numeric(args.start, args.start_line, args.startLine, args.offset, args.line, args.line_start);
  const end = numeric(args.end, args.end_line, args.endLine);
  if (start !== null && end !== null) return `${start}-${end}`;
  if (typeof args.offset === "number" && typeof args.limit === "number") return `${args.offset}-${args.offset + args.limit}`;
  if (start !== null) return `${start}`;
  return [args.offset, args.start, args.start_line, args.startLine].map((v) => str(v).trim()).find(Boolean) ?? null;
}

export interface DelegatedTask {
  /** What the subagent was asked to do, in a line. */
  description: string;
  /** The agent kind (e.g. "explore"), when named. */
  agent: string;
}

/** The subagent specs of a task call: `{ tasks: [{ agent?, description?, assignment?, task? }] }` or a single flat spec. */
export function delegatedTasks(args: unknown): DelegatedTask[] {
  if (!isJsonObject(args)) return [];
  const one = (spec: Record<string, unknown>): DelegatedTask => ({
    description: firstLine((str(spec.description) || str(spec.task) || str(spec.assignment) || str(spec.prompt)).trim()),
    agent: str(spec.agent) || str(spec.subagent_type) || str(args.agent),
  });
  if (Array.isArray(args.tasks)) return args.tasks.filter(isJsonObject).map(one);
  const flat = one(args);
  return flat.description || flat.agent ? [flat] : [];
}

export function todoDone(task: UiTodoTask): boolean {
  return task.status === "completed" || task.status === "done";
}

/** The phase being worked: the first with an open task, else the last one. */
export function activeTodoPhase(phases: readonly UiTodoPhase[]): UiTodoPhase | null {
  return phases.find((phase) => phase.tasks.some((task) => !todoDone(task) && task.status !== "abandoned")) ?? phases.at(-1) ?? null;
}

export function todoProgress(phases: readonly UiTodoPhase[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === "abandoned") continue;
      total++;
      if (todoDone(task)) done++;
    }
  }
  return { done, total };
}

/**
 * MCP tools and `xd://` tool devices are actions, not files: a `write` to
 * `xd://mcp__phone_act` is a phone tap. Returns a readable name ("phone act"),
 * or null for an ordinary tool.
 */
export function deviceName(part: ToolUiPart): string | null {
  const raw = deviceRaw(part);
  return raw ? raw.replace(/^mcp__/, "").replace(/_+/g, " ").trim() || null : null;
}

function deviceRaw(part: ToolUiPart): string {
  if (part.name.startsWith("mcp__")) return part.name;
  if (isJsonObject(part.args) && typeof part.args.path === "string" && part.args.path.startsWith("xd://")) return part.args.path.slice(5);
  return "";
}

// Names whose plain lowercase reads wrong as a noun in "Used …".
const SOURCE_LABELS: Record<string, string> = { workiq: "WorkIQ", lsp: "LSP" };

/**
 * Who a generic call belongs to, so a run of calls to one MCP server or tool
 * device is one group and not "Used tools": `mcp__workiq_call` and
 * `xd://mcp__workiq_describe` are both WorkIQ (the server is the name up to
 * the first underscore), a write to `xd://lsp` is LSP, anything else is its own name.
 */
export function toolSource(part: ToolUiPart): { id: string; label: string } {
  const raw = deviceRaw(part) || shortName(part.name);
  const id = (raw.startsWith("mcp__") ? raw.slice(5).split(/_+/)[0]! : raw).toLowerCase();
  return { id, label: SOURCE_LABELS[id] ?? id.replace(/_+/g, " ") };
}

/** The collapsed face of a call: what it did (muted) and what it acted on (tertiary). */
export interface ToolFace {
  icon: LucideIcon;
  label: string;
  target: string;
  /** Set only for a failed call: "exit 2", or "Failed" when no code is known. */
  failure: string | null;
}

/**
 * `unsettled`: the call has no result and none is coming or provable (an
 * interrupted turn, a passive transcript). Its face then makes no claim
 * either way: no "Running", no "Ran", and not the call's own intent, which
 * agents write optimistically ("Wrote and finished the changes").
 */
export function toolFace(part: ToolUiPart, unsettled = false): ToolFace {
  // [in progress, finished, unknown]
  const tense = unsettled ? 2 : part.state === "running" ? 0 : 1;
  const pick = (forms: readonly [string, string, string]) => forms[tense];
  const intent = !unsettled && part.intent?.trim() ? firstLine(part.intent.trim()) : "";
  const kind = toolKind(part.name);
  const failed = part.state === "error";
  switch (kind) {
    case "bash": {
      const command = toolSummary(part.name, part.args) || firstLine(commandFromArgs(part.args)).trim();
      const outcome = shellOutcome(part);
      return {
        icon: TerminalIcon,
        label: intent || (command ? pick(["Running", "Ran", "Command"]) : pick(["Running a command", "Ran a command", "Command"])),
        // An intent already says what the command is for; gluing the command
        // after it pushed both off a phone row. The detail shows `$ command`.
        target: intent ? "" : command,
        failure: failed ? shellStatusLabel(outcome) : null,
      };
    }
    case "file": {
      const name = shortName(part.name);
      const paths = filePathsForTool(part);
      const path = paths.length === 1 ? paths[0]! : "";
      const { basename, parent } = filePathLabel(path);
      const range = fileRangeFromArgs(part.args);
      const verb = name === "read" ? pick(["Reading", "Read", "File"]) : name === "write" ? pick(["Writing", "Wrote", "Write"]) : pick(["Editing", "Edited", "Edit"]);
      const base = paths.length > 1 ? `${paths.length} files` : path ? `${parent ? `${parent}/` : ""}${basename}` : toolSummary(part.name, part.args);
      const target = intent ? "" : base && range ? `${base}:${range}` : base;
      return { icon: name === "read" ? FileTextIcon : FilePenLineIcon, label: intent || verb, target, failure: failed ? "Failed" : null };
    }
    case "search": {
      const query = toolSummary(part.name, part.args);
      const web = shortName(part.name).includes("web");
      return {
        icon: web ? GlobeIcon : SearchIcon,
        label: intent || (web ? pick(["Searching the web", "Searched the web", "Web search"]) : pick(["Searching", "Searched", "Search"])),
        target: !intent && query ? `“${query}”` : "",
        failure: failed ? "Failed" : null,
      };
    }
    case "task": {
      const tasks = delegatedTasks(part.args);
      const agents = [...new Set(tasks.map((task) => task.agent).filter(Boolean))];
      const who = tasks.length > 1 ? `${tasks.length} agents` : agents[0] ? `${agents[0]} agent` : "Agent";
      // Several tasks: name who was sent when they differ, else the first job and how many more;
      // tasks[0] alone would claim the whole call was one agent's work.
      const target = tasks.length < 2
        ? tasks[0]?.description || intent
        : agents.length > 1
          ? agents.join(", ")
          : tasks[0]?.description ? `${tasks[0].description} +${tasks.length - 1}` : intent;
      return {
        icon: BotIcon,
        label: who.charAt(0).toUpperCase() + who.slice(1),
        target,
        failure: failed ? "Failed" : null,
      };
    }
    case "todo": {
      const progress = part.todo ? todoProgress(part.todo) : null;
      return {
        icon: ListChecksIcon,
        label: pick(["Updating tasks", "Updated tasks", "Tasks"]),
        target: progress && progress.total ? `${progress.done}/${progress.total} done` : "",
        failure: failed ? "Failed" : null,
      };
    }
    case "generic": {
      const device = deviceName(part);
      const name = shortName(part.name);
      const code = name === "eval" || name === "js" || name === "python";
      const summary = code ? "" : toolSummary(part.name, part.args);
      return {
        icon: WrenchIcon,
        label: intent || (code ? pick(["Running code", "Ran code", "Code"]) : device ? pick([`Using ${device}`, `Used ${device}`, device]) : part.name),
        target: intent ? "" : summary,
        failure: failed ? "Failed" : null,
      };
    }
  }
}
