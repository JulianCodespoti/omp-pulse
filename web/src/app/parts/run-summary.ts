import { landedEdits, type UiMessage, type UiPart, type UiToolEdit, type UiTodoPhase } from "@/domain/messages";
import { isJsonObject, type OmpSessionSummary } from "@/domain/protocol";
import { spokenDuration } from "./duration";
import { toolSummary } from "./tool-summary";
import { delegatedTasks, deviceName, filePathsForTool, todoProgress } from "./tools/describe";

export interface RunPhoto {
  key: string;
  src: string | null;
  mimeType: string;
  caption: string;
  /** The call whose result carried it; null for an image the agent posted itself. */
  callId: string | null;
  /** Shown in the chat flow; the rest wait inside the expanded steps. */
  inline: boolean;
}

/** Whether the reply names the file a screenshot was read from. */
function namedIn(reply: string, path: string): boolean {
  if (!reply || !path) return false;
  const base = path.split(/[/\\]/).at(-1) ?? "";
  return reply.includes(path) || (base.includes(".") && reply.includes(base));
}

type ToolUiPart = Extract<UiPart, { kind: "tool" }>;
export type RunKind = "read" | "commands" | "edited" | "searched" | "web" | "delegated" | "planned" | "used" | "steps";

const KIND_ORDER: readonly RunKind[] = ["read", "commands", "edited", "searched", "web", "delegated", "planned", "used", "steps"];

function shortName(name: string): string {
  return name.toLowerCase().split(/[.:/]/).at(-1) ?? name.toLowerCase();
}

function runKind(name: string): RunKind {
  const lower = shortName(name);
  if (lower === "read") return "read";
  if (["edit", "write", "apply_patch", "hashline", "ast_edit"].includes(lower)) return "edited";
  if (["grep", "glob", "find", "search", "ast_grep"].includes(lower)) return "searched";
  if (["web_search", "websearch"].includes(lower)) return "web";
  if (["task", "agent"].includes(lower)) return "delegated";
  if (lower === "todo") return "planned";
  if (["bash", "eval", "hub", "shell", "run", "js", "python"].includes(lower)) return "commands";
  return "steps";
}

function kindOf(part: ToolUiPart): RunKind {
  return deviceName(part) !== null ? "used" : runKind(part.name);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The file a read/edit touched, without a trailing `:50-80` line selector. */
function filePath(part: ToolUiPart): string {
  const paths = filePathsForTool(part);
  if (paths.length > 1) return `${paths.length} files`;
  // `ast_edit` has no path-shaped summary to fall back on; a wrong name is worse than none.
  const raw = paths[0] ?? (shortName(part.name) !== "ast_edit" ? toolSummary(part.name, part.args) : "");
  return raw.replace(/:(?:\d|raw|conflicts)[^/\\]*$/, "");
}

/** What the step acts on, taken from its real arguments; "" when it names nothing. */
function stepTarget(part: ToolUiPart, kind: RunKind): string {
  if (kind === "used") return deviceName(part) ?? "";
  if (kind === "read" || kind === "edited") return filePath(part);
  const lower = shortName(part.name);
  if (kind === "commands") {
    if (lower === "eval" || lower === "js" || lower === "python") return "code";
    return lower === "hub" ? "" : toolSummary(part.name, part.args);
  }
  // Delegated and planned runs are counted, never named.
  return kind === "steps" || kind === "planned" || kind === "delegated" ? "" : toolSummary(part.name, part.args);
}

/** The name a finished step contributes to the line; quoted where it is a pattern or query. */
function finishedName(part: ToolUiPart, kind: RunKind): string {
  const target = stepTarget(part, kind).trim();
  if (!target) return "";
  switch (kind) {
    case "read":
    case "edited": return clip(target.slice(Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\")) + 1), 28);
    case "searched":
    case "web": return `"${clip(target, 24)}"`;
    default: return clip(target, 28);
  }
}

const FINISHED_VERB: Record<RunKind, string> = {
  read: "Read", commands: "Ran", edited: "Edited", searched: "Searched", web: "Searched the web for", delegated: "", planned: "", used: "Used", steps: "",
};

/** Plural-aware counts: "Ran 5 commands", "Read 3 files". */
function finishedCount(kind: RunKind, n: number): string {
  switch (kind) {
    case "read": return `Read ${plural(n, "file")}`;
    case "commands": return `Ran ${plural(n, "command")}`;
    case "edited": return `Edited ${plural(n, "file")}`;
    case "searched": return `Searched ${plural(n, "time")}`;
    case "web": return n === 1 ? "Searched the web" : `Searched the web ${n} times`;
    case "delegated": return `Started ${plural(n, "agent")}`;
    case "planned": return "Updated tasks";
    case "used": return `Used ${plural(n, "tool")}`;
    case "steps": return plural(n, "step");
  }
}

interface Tally {
  /** Every step of the kind, including one still running. */
  total: number;
  /** Distinct names in call order; a lone named call is spelled out ("Ran git status"). */
  names: string[];
}

/**
 * One pass over the run; details stay unmounted until someone asks for them.
 * `live`: the run's turn is in flight, so a call without a result is running;
 * otherwise it was interrupted and the label says so.
 *
 * Failure tone: a failed call is routine unless the turn ended on it. Agents
 * run shell commands that exit non-zero all the time (grep with no match, a
 * probe, a test expected to fail) and carry on, so a failure followed by a
 * later call in the run, or by a later assistant message (`continued`), is
 * counted quietly. Only the run's LAST call failing with nothing after it is
 * the failure the turn ended on (`finalFailureId`), and only that is red. A
 * live run has not ended, so nothing in it is final yet.
 *
 * Photos: only the newest tool screenshot stays in the chat flow, with any
 * the `reply` names by file and any image the agent posted itself. A phone
 * run stacked 19 full-width screenshots (14,000 px) above its reply; the rest
 * now sit with their steps.
 */
export function summarizeRun(messages: readonly UiMessage[], { continued = false, live = false, reply = "" }: { continued?: boolean; live?: boolean; reply?: string } = {}): {
  /** Past tense with counts: "Read 3 files, ran 5 commands"; a lone named call is spelled out ("Ran git status"). */
  label: string;
  /** The first kind named in the label (its icon leads the row); null for a run of thought only. */
  kind: RunKind | null;
  failed: number;
  /** Calls whose result never came. */
  interrupted: number;
  /** The call the turn ended on, when it failed; every other failure is routine. */
  finalFailureId: string | null;
  photos: RunPhoto[];
} {
  const tallies = new Map<RunKind, Tally>();
  let failed = 0;
  let interrupted = 0;
  // Agents, not calls: one task call can start several subagents.
  let agents = 0;
  let lastTool: ToolUiPart | null = null;
  let thinking = false;
  let caption = "";
  let plan: UiTodoPhase[] | null = null;
  const photos: RunPhoto[] = [];
  const seenPhotos = new Set<string>();
  let newestToolPhoto = -1;
  const addPhoto = (photo: RunPhoto, deduplicate = true): void => {
    if (deduplicate && photo.src && seenPhotos.has(photo.src)) return;
    if (deduplicate && photo.src) seenPhotos.add(photo.src);
    if (photo.callId !== null) newestToolPhoto = photos.length;
    photos.push(photo);
  };
  for (const message of messages) {
    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index]!;
      if (part.kind === "thinking") thinking = true;
      if (part.kind === "image") {
        addPhoto({ key: `${message.id}:${index}`, src: part.src, mimeType: part.mimeType, caption, callId: null, inline: true });
      }
      if (part.kind !== "tool") continue;
      caption = toolSummary(part.name, part.args, part.intent) || part.name;
      lastTool = part;
      if (part.state === "error") failed++;
      else if (part.state === "running" && !live) interrupted++;
      if (part.todo?.length) plan = part.todo;
      const kind = kindOf(part);
      if (kind === "delegated") agents += Math.max(1, delegatedTasks(part.args).length);
      let tally = tallies.get(kind);
      if (!tally) { tally = { total: 0, names: [] }; tallies.set(kind, tally); }
      tally.total++;
      const name = kind === "steps" || kind === "planned" || kind === "delegated" ? "" : finishedName(part, kind);
      if (name && !tally.names.includes(name)) tally.names.push(name);
      const generated = shortName(part.name) === "generate_image";
      const named = generated || ((part.images?.length ?? 0) > 0 && namedIn(reply, filePath(part)));
      for (let imageIndex = 0; imageIndex < (part.images?.length ?? 0); imageIndex++) {
        const image = part.images![imageIndex]!;
        addPhoto({ key: `${part.callId}:${imageIndex}`, ...image, caption, callId: part.callId, inline: named }, !generated);
      }
    }
  }
  // Every image of the newest screenshot's call, not just its last one.
  const newestCall = newestToolPhoto >= 0 ? photos[newestToolPhoto]!.callId : null;
  for (const photo of photos) if (newestCall !== null && photo.callId === newestCall) photo.inline = true;
  const labels: string[] = [];
  let first: RunKind | null = null;
  for (const kind of KIND_ORDER) {
    const tally = tallies.get(kind);
    if (!tally) continue;
    first ??= kind;
    if (kind === "planned" && plan) {
      // The plan's state after the run, not how many times it was edited.
      const { done, total } = todoProgress(plan);
      labels.push(total ? `${done}/${total} tasks done` : finishedCount(kind, tally.total));
      continue;
    }
    if (kind === "delegated") { labels.push(finishedCount(kind, agents)); continue; }
    labels.push(tallies.size === 1 && tally.total === 1 && tally.names.length === 1 ? `${FINISHED_VERB[kind]} ${tally.names[0]}` : finishedCount(kind, tally.total));
  }
  // A run of thought only has no call to end it, so no measured duration.
  const joined = labels.map((text, index) => (index ? text.charAt(0).toLowerCase() + text.slice(1) : text)).join(", ");
  const label = joined || (thinking ? "Thought" : photos.length ? "Shared photos" : "Working");
  const finalFailureId = !live && !continued && lastTool?.state === "error" ? lastTool.callId : null;
  return { label: label.charAt(0).toUpperCase() + label.slice(1), kind: first, failed, interrupted, finalFailureId, photos };
}

export type ThinkingUiPart = Extract<UiPart, { kind: "thinking" }>;

export interface RunStepTool {
  part: ToolUiPart;
  /** The message that issued the call; only the live message's calls can still be running. */
  messageId: string;
}

/** One thought and the calls it led to. */
export interface RunStep {
  /** The thinking that opened the step; null for calls made before any thought. */
  thought: ThinkingUiPart | null;
  /**
   * How long the thought took, when both ends were recorded: from the end of
   * the call before it to the start of the first call it led to. There is no
   * other honest clock for reasoning (a component's mount time made a reopened
   * chat claim every turn thought for 0-2 seconds).
   */
  thoughtMs?: number;
  tools: RunStepTool[];
}

/**
 * A run as the agent worked it: each thinking block opens a step, and the
 * calls after it belong to that step until the next thought. Calls before any
 * thought form a step of their own. Part objects are passed through, never
 * copied, so a settled step compares equal across streamed frames.
 */
export function groupRunSteps(messages: readonly UiMessage[]): RunStep[] {
  const steps: RunStep[] = [];
  let current: RunStep | null = null;
  let lastEnded: number | undefined;
  let thoughtFrom: number | undefined;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === "thinking") {
        current = { thought: part, tools: [] };
        thoughtFrom = lastEnded;
        steps.push(current);
      } else if (part.kind === "tool") {
        if (!current) { current = { thought: null, tools: [] }; steps.push(current); }
        if (current.thought && current.tools.length === 0 && thoughtFrom !== undefined && part.startedAt !== undefined && part.startedAt > thoughtFrom) {
          current.thoughtMs = part.startedAt - thoughtFrom;
        }
        current.tools.push({ part, messageId: message.id });
        if (part.endedAt !== undefined) lastEnded = part.endedAt;
      }
    }
  }
  return steps;
}

/** "Thought for 12s", "Thought", or the one redaction string. */
export function thoughtLabel(thought: ThinkingUiPart, ms?: number): string {
  if (thought.redacted) return "Reasoning hidden";
  const took = ms !== undefined ? spokenDuration(ms) : null;
  return took ? `Thought for ${took}` : "Thought";
}

/** Only the current user turn can supply a live step, never an old interrupted call. */
export function runningStepTitle(messages: readonly UiMessage[], streaming?: UiMessage | null): string | null {
  const fromMessage = (message: UiMessage): string | null => {
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i]!;
      if (part.kind === "tool" && part.state === "running") {
        return toolSummary(part.name, part.args, part.intent) || "Working";
      }
    }
    return null;
  };
  if (streaming) return fromMessage(streaming);
  const newest = messages.at(-1);
  return newest?.role === "assistant" ? fromMessage(newest) : null;
}

export interface EditedFile {
  path: string;
  added: number;
  removed: number;
  changes: UiToolEdit[];
}

export function summarizeEdits(messages: readonly UiMessage[]): EditedFile[] {
  const files = new Map<string, EditedFile>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.kind !== "tool" || seen.has(part.callId)) continue;
      const landed = landedEdits(part);
      if (!landed.length) continue;
      seen.add(part.callId);
      for (const edit of landed) {
        let file = files.get(edit.path);
        if (!file) { file = { path: edit.path, added: 0, removed: 0, changes: [] }; files.set(edit.path, file); }
        file.added += edit.added;
        file.removed += edit.removed;
        file.changes.push(edit);
      }
    }
  }
  return Array.from(files.values());
}

export type PendingAsk = OmpSessionSummary["pendingAsk"];
export interface QuickQuestion { callId: string; question: string; options: string[]; }

/** Match the authoritative pending call, not a historical ask whose UI state is still running. */
export function pendingQuickQuestion(messages: readonly UiMessage[], pending: PendingAsk): QuickQuestion | null {
  if (!pending?.id || (pending.total ?? 1) !== 1 || (pending.index ?? 0) !== 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") break;
    for (const part of message.parts) {
      if (part.kind !== "tool" || part.callId !== pending.id || part.state !== "running" || !isJsonObject(part.args)) continue;
      const questions = part.args.questions;
      if (!Array.isArray(questions) || questions.length !== 1) return null;
      const question = questions[0];
      if (!isJsonObject(question) || question.multi === true || typeof question.question !== "string" || !Array.isArray(question.options)) return null;
      const options: string[] = [];
      for (const option of question.options) {
        if (!isJsonObject(option) || typeof option.label !== "string" || !option.label.trim()) return null;
        options.push(option.label);
      }
      if (!options.length || pending.question !== question.question || pending.options?.length !== options.length
        || options.some((option, index) => pending.options?.[index] !== option)) return null;
      return { callId: part.callId, question: question.question, options };
    }
  }
  return null;
}
