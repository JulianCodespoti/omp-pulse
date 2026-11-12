import { isJsonObject } from "./protocol";
import type { JsonObject, OmpContentPart, OmpEntry, OmpMessage } from "./protocol";
import { rawAssistantText, withRawAssistantText } from "./message-provenance";
import { withAmbiguousResponseItem, withResponseItem } from "./response-item-provenance";
export type UiRole = "user" | "assistant";

/**
 * A rendered piece of a turn.
 *
 * The wire keeps a turn's reasoning, tool calls and images as sibling parts of
 * one assistant message (`message.content[]`), while the RESULT of a tool lands
 * later as its own `role: "toolResult"` entry carrying `toolCallId`. We stitch
 * the result back onto the call so the UI can show one tool with its input
 * and output together, which is what every modern chat client does.
 */
export type UiPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; redacted?: boolean }
  | { kind: "image"; src: string | null; mimeType: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: unknown;
      intent?: string;
      state: "running" | "ok" | "error";
      startedAt?: number;
      /**
       * When the tool finished (epoch ms): the live `tool_execution_end`
       * moment, or the timestamp of its `toolResult` entry. With `startedAt`
       * this is the command's real duration, never a clock still counting.
       */
      endedAt?: number;
      output?: string;
      edits?: UiToolEdit[];
      /** The todo list after this call (todo tool results only). */
      todo?: UiTodoPhase[];
      /** Images returned by the tool, e.g. reading a screenshot. */
      images?: UiToolImage[];
      /** Reported shell completion, independent of the generic tool error flag. */
      shell?: UiShellOutcome;
      /** Native search coverage and provider outcome, independent of output wording. */
      search?: UiSearchResult;
      /** `true` when the daemon pruned the output from the transcript. */
      pruned?: boolean;
      /**
       * Subagent statuses this call's result reported: a `task` spawn's
       * `details.progress` or a `wait` result's task-job snapshot.
       */
      agents?: UiAgentStatus[];
    };

export interface UiMessage {
  id: string;
  role: UiRole;
  /** Concatenated visible text. Kept for previews, search and copy. */
  text: string;
  parts: UiPart[];
  createdAt?: Date;
  /** Wall time when the daemon marked this turn complete, when present. */
  completedAt?: Date;
  sourceEntryId?: string;
  /** Deliberately displayed extension content, not model reasoning or tool activity. */
  customType?: string;
  /** Structured `details` an omp extension passed to `pi.sendMessage`; handed to a claiming transcript plugin. */
  customDetails?: unknown;
  /** Client-only composition of the admitted prompt; not a delivery or storage receipt. */
  localAttachmentCount?: number;
  /** Shared stream/history identity, including replies stopped before a provider id exists. */
  responseKey?: string;
  /** Client-only live-ingested Markdown policy; never persisted or proof of paint. */
  eagerMarkdown?: boolean;
  stopReason?: string;
  /** Assistant turns carry the model that produced them. */
  model?: string;
  /** Set when the provider returned an error for this turn. */
  errorMessage?: string;
  /** Per-turn token usage forwarded from the daemon (assistant turns only). */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    total?: number;
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };
  /** Provider request duration in ms (assistant only); omp's tokens/s denominator. */
  duration?: number;
  /**
   * Live only: bytes the daemon says the model has generated so far (the
   * delta frame's `g`), covering thinking and tool args the phone never
   * receives as text. See src/server/delta.rs `generated_len`.
   */
  generated?: number;
  /** Snapshot of context pressure at the end of this turn (assistant only). */
  contextSnapshot?: {
    promptTokens?: number;
    nonMessageTokens?: number;
    compactionEpoch?: number;
  };
  /**
   * omp's auto-retry verdict on this errored attempt: `superseded` once a
   * retry replaced it, `recovered` once a retry succeeded. Absent on the
   * error a turn ended on.
   */
  retry?: { status: "superseded" | "recovered"; attempt: number };
}

/** A `role: "toolResult"` entry that has not found its call yet. */
export interface UiToolResult {
  callId: string;
  name: string;
  output: string;
  isError: boolean;
  pruned: boolean;
  /** Image blocks from the result; a tool_result may carry them (types.ts:941). */
  images?: UiToolImage[];
  shell?: UiShellOutcome;
  search?: UiSearchResult;
  /** Epoch ms the result entry was written: the moment the tool finished. */
  at?: number;
  edits?: UiToolEdit[];
  todo?: UiTodoPhase[];
  agents?: UiAgentStatus[];
}

export interface UiSearchResult {
  kind: "grep" | "web";
  matchCount?: number;
  sourceCount?: number;
  error?: string;
  truncated: boolean;
  fileLimitReached?: number;
  /** Native grep also uses this field for its configured total-match cap. */
  perFileLimitReached?: number;
  linesTruncated?: boolean;
  outputTruncated?: boolean;
}

/**
 * OMP 18.10.4: tools/grep.ts reports caps only in details; web/search/index.ts
 * returns provider failures in details.error without setting isError.
 * Never infer either outcome from words inside the returned matches/answer.
 */
export function parseToolSearch(name: string, details: unknown): UiSearchResult | undefined {
  if (!isJsonObject(details)) return undefined;
  const tool = name.toLowerCase().split(/[.:/]/).at(-1);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (tool === "web_search") {
    const response = details.response;
    if (!isJsonObject(response) || typeof response.provider !== "string" || !Array.isArray(response.sources)) return undefined;
    return {
      kind: "web", sourceCount: response.sources.length, truncated: false,
      ...(typeof details.error === "string" && details.error.trim() ? { error: details.error } : {}),
    };
  }
  if (tool !== "grep") return undefined;
  const meta = isJsonObject(details.meta) ? details.meta : undefined;
  const limits = isJsonObject(meta?.limits) ? meta.limits : undefined;
  const fileLimitReached = count(details.fileLimitReached);
  const perFileLimitReached = count(details.perFileLimitReached);
  const linesTruncated = details.linesTruncated === true || isJsonObject(limits?.columnTruncated);
  const outputTruncated = isJsonObject(meta?.truncation) || (isJsonObject(details.truncation) && details.truncation.truncated === true);
  return {
    kind: "grep", matchCount: count(details.matchCount),
    truncated: details.truncated === true || fileLimitReached !== undefined || perFileLimitReached !== undefined || linesTruncated || outputTruncated,
    fileLimitReached, perFileLimitReached, linesTruncated, outputTruncated,
  };
}

export interface UiToolEdit {
  path: string;
  added: number;
  removed: number;
  diff: string;
  truncated: boolean;
  firstChangedLine?: number;
  op?: string;
  sourcePath?: string;
  /** This file's own failure inside a batch; it carries no diff to count. */
  error?: string;
}

/**
 * OMP 18.10.4 records one edit directly, or a multi-file batch in
 * `perFileResults`. Its aggregate `diff` has no per-file identity; never
 * substitute that, snapshots or today's file contents for a recorded diff.
 */
export function parseToolEdits(name: string, details: unknown): UiToolEdit[] | undefined {
  const tool = name.toLowerCase().split(/[.:/]/).at(-1);
  if ((tool !== "edit" && tool !== "write") || !isJsonObject(details)) return undefined;
  const records = Array.isArray(details.perFileResults) ? details.perFileResults : [details];
  const edits = records.filter(isJsonObject).flatMap((record) => {
    const path = typeof record.path === "string" ? record.path : "";
    if (!path) return [];
    return [parseRecordedEdit(path, record)];
  });
  return edits.length ? edits : undefined;
}

/**
 * A failed call is only trusted per file: a batch that marks which files failed
 * keeps the ones that landed. Without such a marker (a single edit, or a batch
 * that merely failed) no recorded diff may claim success.
 */
export function recordedEdits(name: string, details: unknown, isError: boolean): UiToolEdit[] | undefined {
  const edits = parseToolEdits(name, details);
  return isError && !edits?.some((edit) => edit.error) ? undefined : edits;
}

/** The edits of a finished call that really landed: none while running, and none from a failed call that did not say which files failed. */
export function landedEdits(part: { state: string; edits?: readonly UiToolEdit[] }): UiToolEdit[] {
  if (part.state === "running" || !part.edits) return [];
  if (part.state === "error" && !part.edits.some((edit) => edit.error)) return [];
  return part.edits.filter((edit) => !edit.error);
}

/** Count the full recorded patch before capping its display, independently per file. */
function parseRecordedEdit(path: string, record: JsonObject): UiToolEdit {
  const text = typeof record.diff === "string" ? record.diff : "";
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { inHunk = false; continue; }
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk && /^(?:\+\+\+|---)(?:\s|$)/.test(line)) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  const limit = 20_000;
  const boundary = text.lastIndexOf("\n", limit);
  const end = text.length > limit ? (boundary >= 0 ? boundary : limit) : text.length;
  return { path, added, removed, diff: text.slice(0, end), truncated: text.length > limit,
    firstChangedLine: typeof record.firstChangedLine === "number" ? record.firstChangedLine : undefined,
    op: typeof record.op === "string" ? record.op : undefined,
    sourcePath: typeof record.sourcePath === "string" ? record.sourcePath : undefined,
    error: typeof record.displayErrorText === "string" && record.displayErrorText ? record.displayErrorText
      : typeof record.errorText === "string" && record.errorText ? record.errorText
        : record.isError === true ? "This file could not be edited." : undefined };
}

export interface UiTodoTask {
  content: string;
  /** omp: pending | in_progress | blocked | completed | abandoned. */
  status: string;
  notes?: string;
  blocker?: string;
}

export interface UiTodoPhase {
  name: string;
  tasks: UiTodoTask[];
}

/**
 * The todo tool's result carries the WHOLE list after the change
 * (`details.phases`, session.md "todo" snapshots), so the newest result is the
 * current board; nothing needs replaying.
 */
export function parseTodoPhases(name: string, details: unknown): UiTodoPhase[] | undefined {
  if (name.toLowerCase().split(/[.:/]/).at(-1) !== "todo" || !isJsonObject(details) || !Array.isArray(details.phases)) return undefined;
  const phases: UiTodoPhase[] = [];
  for (const raw of details.phases) {
    if (!isJsonObject(raw) || !Array.isArray(raw.tasks)) continue;
    const tasks: UiTodoTask[] = [];
    for (const task of raw.tasks) {
      if (!isJsonObject(task) || typeof task.content !== "string") continue;
      tasks.push({
        content: task.content,
        status: typeof task.status === "string" ? task.status : "pending",
        notes: typeof task.notes === "string" && task.notes ? task.notes
          : Array.isArray(task.notes) ? task.notes.filter((note): note is string => typeof note === "string").join("\n") || undefined : undefined,
        blocker: typeof task.blocker === "string" && task.blocker ? task.blocker : undefined,
      });
    }
    phases.push({ name: typeof raw.name === "string" ? raw.name : "", tasks });
  }
  return phases;
}

/**
 * One subagent's reported status (`pending`, `running`, `completed`,
 * `failed`, `cancelled`…), keyed by omp's agent/job id. omp runs `task`
 * asynchronously: the call returns at spawn time with every agent `pending`,
 * and each agent's end arrives later as a `wait` snapshot or an
 * `async-result` notice, never as a second result of that call.
 */
export interface UiAgentStatus {
  id: string;
  status: string;
}

/** Agent statuses a `task` (`details.progress`) or `wait` (`details.jobs`, task jobs only) result carries. */
export function parseAgentStatuses(name: string, details: unknown): UiAgentStatus[] | undefined {
  if (!isJsonObject(details)) return undefined;
  const tool = name.toLowerCase().split(/[.:/]/).at(-1);
  const rows = tool === "task" ? details.progress : tool === "wait" ? details.jobs : undefined;
  if (!Array.isArray(rows)) return undefined;
  const out: UiAgentStatus[] = [];
  for (const raw of rows) {
    if (!isJsonObject(raw) || (tool === "wait" && raw.type !== undefined && raw.type !== "task")) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
    if (id && status) out.push({ id, status });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * A background job's completion notice (`custom_message`, customType
 * `async-result`): the task jobs it delivered. The outcome is read from the
 * notice's `<task-result … status="…">` tag; a delivered job without one
 * still finished.
 */
function asyncResultStatuses(entry: OmpEntry | OmpMessage): UiAgentStatus[] {
  const details = entry.details;
  if (!isJsonObject(details) || !Array.isArray(details.jobs)) return [];
  const content = typeof entry.content === "string" ? entry.content
    : Array.isArray(entry.content) ? entry.content.map((part) =>
      isJsonObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("") : "";
  const out: UiAgentStatus[] = [];
  for (const job of details.jobs) {
    if (!isJsonObject(job) || job.type !== "task") continue;
    const id = typeof job.jobId === "string" ? job.jobId.trim() : "";
    if (!id) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tag = new RegExp(`<task-result id="${escaped}"[^>]*\\bstatus="([A-Za-z_-]+)"`).exec(content);
    out.push({ id, status: tag?.[1]?.toLowerCase() ?? "completed" });
  }
  return out;
}

/** `{ agents }` only when there are some, so parts without agents keep their exact shape. */
export function withAgents(agents: UiAgentStatus[] | undefined): { agents?: UiAgentStatus[] } {
  return agents ? { agents } : {};
}

export interface Transcript {
  messages: UiMessage[];
  /** Results whose call is in an older page than this batch. */
  orphanResults: UiToolResult[];
  /** Agents that custom `async-result` notices in this batch report as finished. */
  settledAgents: UiAgentStatus[];
}

/**
 * Images are stored by content hash (`blob:sha256:…`) and the bytes stay on the
 * desktop, so the phone can only render inline base64. Anything else becomes a
 * placeholder rather than a broken image.
 */
function imageSrc(part: JsonObject, inlineLimit = 200_000): string | null {
  const data = typeof part.data === "string" ? part.data : "";
  if (!data) return null;
  if (data.startsWith("data:")) return data.length <= inlineLimit ? data : null;
  if (/^blob:/i.test(data)) {
    // Keep the `blob:sha256:<hash>` reference — ImagePart will fetch via `/api/blob/{hash}`.
    return data;
  }
  if (data.length > inlineLimit) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) return null;
  const mime = typeof part.mimeType === "string" && part.mimeType ? part.mimeType : "image/png";
  return `data:${mime};base64,${data}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function partsFromContent(content: OmpMessage["content"] | OmpEntry["content"], displayBoundaries?: number[]): UiPart[] {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];

  const parts: UiPart[] = [];
  let rawOffset = 0;
  for (const raw of content as OmpContentPart[]) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as JsonObject;
    switch (part.type) {
      case "text": {
        const text = typeof part.text === "string" ? part.text : "";
        if (!text) break;
        // Coalesce runs of text so markdown split across parts still parses
        // as one document. Bare `previous.text += text` broke fenced blocks:
        // "construction:" + "```ts\n..." => "construction:```ts" — fence not at
        // line start, renderer emitted inline garble instead of a block. Insert
        // a single newline only when the next chunk starts a fence. A blank
        // line ("\\n\\n") would also fix the fence but turns a mid-sentence
        // split ("Hello " + "world") into a paragraph break; a single "\\n"
        // keeps mid-sentence on one line (rendered as a soft break) while still
        // putting "```" at column 0. We also avoid doubling newlines already
        // present.
        const previous = parts.at(-1);
        if (previous?.kind === "text") {
          const trimmed = text.trimStart();
          const startsFence = trimmed.startsWith("```") || trimmed.startsWith("~~~");
          const needsNewline =
            startsFence && !previous.text.endsWith("\n") && !text.startsWith("\n");
          // Record the actual insertion, including adjacency exposed by omitted
          // parts. Non-text parts never add units to the wire coordinate base.
          if (needsNewline) displayBoundaries?.push(rawOffset);
          previous.text += needsNewline ? `\n${text}` : text;
        } else parts.push({ kind: "text", text });
        rawOffset += text.length;
        break;
      }
      case "thinking": {
        const text = typeof part.thinking === "string" ? part.thinking : "";
        const sig = typeof part.thinkingSignature === "string" ? part.thinkingSignature : "";
        const redacted = !text && !!sig;
        if (!text && !redacted) break;
        if (redacted) {
          parts.push({ kind: "thinking", text: "", redacted: true });
          break;
        }
        const previous = parts.at(-1);
        if (previous?.kind === "thinking" && !previous.redacted) previous.text += text;
        else parts.push({ kind: "thinking", text });
        break;
      }
      case "redactedThinking": {
        // Provider fully redacted the reasoning block.
        parts.push({ kind: "thinking", text: "", redacted: true });
        break;
      }
      case "image":
        parts.push({
          kind: "image",
          src: imageSrc(part),
          mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png",
        });
        break;
      case "toolCall":
      case "tool_use": {
        const callId =
          typeof part.id === "string"
            ? part.id
            : typeof part.tool_use_id === "string"
              ? part.tool_use_id
              : "";
        if (!callId) break;
        parts.push({
          kind: "tool",
          callId,
          name: typeof part.name === "string" ? part.name : "tool",
          args: part.arguments ?? part.input ?? null,
          intent: typeof part.intent === "string" ? part.intent : undefined,
          state: "running",
        });
        break;
      }
      // Anthropic's native server-side tools (web search, code execution)
      // arrive as their own block type, NOT as a `toolCall`
      // (packages/ai/src/types.ts:712). They fell through `default` and
      // vanished: the answer rendered with nothing above it, so a turn that
      // searched the web looked like the model simply knew.
      case "anthropicServerTool": {
        const block = isJsonObject(part.block) ? part.block : null;
        if (!block) break;
        const blockType = typeof block.type === "string" ? block.type : "";
        const id =
          typeof block.id === "string"
            ? block.id
            : typeof block.tool_use_id === "string"
              ? block.tool_use_id
              : "";
        if (!id) break;
        if (blockType.endsWith("_tool_result")) {
          // The result half: attach it to the call rather than adding a card.
          const call = parts.find((p) => p.kind === "tool" && p.callId === id);
          if (call && call.kind === "tool") {
            call.state = "ok";
            call.output = stringify(block.content);
          }
          break;
        }
        parts.push({
          kind: "tool",
          callId: id,
          name: typeof block.name === "string" ? block.name : blockType || "server tool",
          args: block.input ?? null,
          state: "running",
        });
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

export function textFromParts(parts: readonly UiPart[]): string {
  let text = "";
  for (const part of parts) if (part.kind === "text") text += part.text;
  return text;
}

/**
 * Human-readable peek at a daemon `partial` frame (the unterminated tail of
 * the session file). Ports the legacy client's `cleanPartialText
 * (public/index.html): a fully-written line not yet newline-terminated
 * parses whole; a torn mid-string line surfaces the tail of the last
 * text/thinking value via incremental unescape. Returns null when no prose
 * is recoverable — callers fall back to the raw blob or nothing, never JSON
 * in the transcript. Caps mirror the legacy client (4k in, 2k out).
 */
export function provisionalTextFromPartial(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const capped = text.length > 4000 ? text.slice(-4000) : text;
  try {
    const value: unknown = JSON.parse(capped);
    if (isJsonObject(value)) {
      const message = value.message;
      if (value.type === "custom_message" || isJsonObject(message) && (message.role === "custom" || message.role === "hookMessage")) {
        return entryToUiMessage(value as OmpEntry, 0)?.text.trim() || null;
      }
      if (isJsonObject(message)) {
        const out = textFromParts(
          partsFromContent(message.content as OmpMessage["content"]),
        ).trim();
        return out || null;
      }
    }
  } catch {
    // Torn line: fall through to the tail scan below.
  }
  // A torn custom entry has not established its display policy yet. In
  // particular display:false may occur after content in the serialized row.
  if (/"(?:type|role)"\s*:\s*"(?:custom_message|custom|hookMessage)"/.test(text.slice(0, 4000))) return null;
  const keys = ['"thinking":"', '"text":"'];
  let at = -1;
  let keyLen = 0;
  for (const key of keys) {
    const idx = capped.lastIndexOf(key);
    if (idx > at) {
      at = idx;
      keyLen = key.length;
    }
  }
  if (at < 0) return null;
  const show = unescapeJsonTail(capped.slice(at + keyLen));
  return show.trim() || null;
}

/** Best-effort unescape of an in-progress JSON string value: decode escapes
 * until the unescaped closing quote, which may not exist yet. */
function unescapeJsonTail(s: string): string {
  let out = "";
  let clipped = s;
  if (clipped.length > 2000) clipped = clipped.slice(0, 1997) + "…";
  let i = 0;
  while (i < clipped.length) {
    const ch = clipped[i];
    if (ch === '"') break;
    if (ch === "\\") {
      i++;
      if (i >= clipped.length) {
        out += "\\";
        break;
      }
      const e = clipped[i];
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === "r") out += "\r";
      else if (e === "b") out += "\b";
      else if (e === "f") out += "\f";
      else if (e === "u") {
        const hex = clipped.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += "\\u";
        }
      } else out += e;
    } else {
      out += ch;
    }
    i++;
  }
  return out;
}

function dateFromValue(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp);
  }
  return undefined;
}

export interface UiContextBoundary {
  entryId: string;
  /** Epoch ms on the native clock, matching history message.createdAt. */
  at: number;
  /** Native reduced context estimate; absence means unknown, never tokensBefore. */
  tokens?: number;
}

/** Newer compaction receipts invalidate old context measurements, not session spend. */
export function newestCompactionBoundary(entries: readonly OmpEntry[], after: number): UiContextBoundary | null {
  let newest: UiContextBoundary | null = null;
  for (const entry of entries) {
    if (entry.type !== "compaction" || typeof entry.id !== "string") continue;
    const at = dateFromValue(entry.timestamp)?.getTime();
    if (at === undefined || !Number.isFinite(at) || at <= after || (newest && at < newest.at)) continue;
    const tokens = typeof entry.tokensAfter === "number" && Number.isSafeInteger(entry.tokensAfter) && entry.tokensAfter >= 0
      ? entry.tokensAfter : undefined;
    newest = { entryId: entry.id, at, ...(tokens !== undefined ? { tokens } : {}) };
  }
  return newest;
}

function messageId(entry: OmpEntry, message: OmpMessage, index: number): string {
  return message.id ?? entry.id ?? `entry:${index}`;
}

export interface UiToolImage {
  src: string | null;
  mimeType: string;
}

export type UiShellOutcome =
  | { kind: "exit"; code: number }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "unknown" };

/** Native generation results put images in details, not content. Keep failed slots. */
export function parseToolImages(name: string, content: unknown, details: unknown): UiToolImage[] | undefined {
  const generated = name.toLowerCase().split(/[.:/]/).at(-1) === "generate_image";
  const records = generated && isJsonObject(details) && Array.isArray(details.images)
    ? details.images : Array.isArray(content) ? content.filter((raw) => isJsonObject(raw) && raw.type === "image") : [];
  // Live results may still be inline; persisted OMP results use cheap blob refs.
  // Bound retained inline data per call, without silently dropping unavailable slots.
  let remaining = 16 * 1024 * 1024;
  const images = records.map((raw): UiToolImage => {
    const block = isJsonObject(raw) ? raw : {};
    const src = imageSrc(block, Math.min(8 * 1024 * 1024, remaining));
    if (src && !src.startsWith("blob:")) remaining -= src.length;
    return { src, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" };
  });
  // A generated image whose record was dropped still has its path; keep its slot visible.
  if (generated && isJsonObject(details) && Array.isArray(details.imagePaths)) {
    while (images.length < details.imagePaths.length) images.push({ src: null, mimeType: "image/png" });
  }
  return images.length || (generated && isJsonObject(details) && Array.isArray(details.images)) ? images : undefined;
}

/** OMP's structured result wins over legacy output notices. A failure is not exit 1. */
export function parseShellOutcome(name: string, details: unknown, output: string, isError: boolean): UiShellOutcome | undefined {
  if (!/(?:^|[.:/])(?:bash|shell|run)$/.test(name.toLowerCase())) return undefined;
  if (isJsonObject(details)) {
    if (details.timedOut === true) return { kind: "timeout" };
    if (details.cancelled === true || (isJsonObject(details.async) && details.async.state === "cancelled")) return { kind: "cancelled" };
    if (typeof details.exitCode === "number" && Number.isSafeInteger(details.exitCode)) return { kind: "exit", code: details.exitCode };
  }
  // Thrown ToolError cancellations have no details. Match only native notices,
  // never a random mention in stdout, and never inspect an unbounded output.
  const tail = output.slice(-4096).trimEnd();
  if (isError && (output.startsWith("[Command cancelled]") || /(?:^|\n)(?:\[Command (?:cancelled|aborted)\]|Command aborted)\s*$/.test(tail))) return { kind: "cancelled" };
  if (isError && /(?:^|\n)\[?Command timed out(?: after [\d.]+ seconds)?\]?\s*$/.test(tail)) return { kind: "timeout" };
  const notice = /(?:^|\n)(?:\[)?Command exited with (?:code|status) (-?\d+)(?:\])?\s*$/.exec(tail);
  if (notice) return { kind: "exit", code: Number(notice[1]) };
  return { kind: "unknown" };
}

export function toolResultFromEntry(message: OmpMessage, at?: number): UiToolResult | null {
  const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
  if (!callId) return null;
  const name = typeof message.toolName === "string" ? message.toolName : "tool";
  let output: string;
  if (Array.isArray(message.content)) {
    const textual: unknown[] = [];
    for (const raw of message.content as OmpContentPart[]) {
      const block = raw as JsonObject | null;
      if (block && typeof block === "object" && block.type === "image") {
        // Image slots are normalized together with native generated images below.
        continue;
      }
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        textual.push(block.text);
        continue;
      }
      textual.push(raw);
    }
    output = textual.every((t) => typeof t === "string")
      ? (textual as string[]).join("")
      : stringify(textual);
  } else {
    output = stringify(message.content);
  }
  const search = parseToolSearch(name, message.details);
  return {
    callId,
    name,
    output,
    isError: message.isError === true || !!search?.error,
    pruned: message.prunedAt !== undefined && message.prunedAt !== null,
    images: parseToolImages(name, message.content, message.details),
    shell: parseShellOutcome(name, message.details, output, message.isError === true),
    ...(search ? { search } : {}),
    at,
    edits: recordedEdits(typeof message.toolName === "string" ? message.toolName : "", message.details, message.isError === true),
    todo: parseTodoPhases(typeof message.toolName === "string" ? message.toolName : "", message.details),
    ...withAgents(parseAgentStatuses(typeof message.toolName === "string" ? message.toolName : "", message.details)),
  };
}

/**
 * `bashExecution` / `pythonExecution` rows (a `!cmd` or `$code` run from the
 * desktop prompt) carry `command`/`code`, `output`, `exitCode`, `cancelled` and
 * `truncated`, and NO `content` (session/messages.ts BashExecutionMessage), so
 * reading `content` made every one render blank. Shown as one preformatted
 * block, the way the terminal prints it.
 */
function executionParts(message: JsonObject, role: string): UiPart[] {
  const python = role === "pythonExecution";
  const raw = python ? message.code : message.command;
  const source = typeof raw === "string" ? raw : "";
  const output = typeof message.output === "string" ? message.output.replace(/\s+$/, "") : "";
  const lines: string[] = [];
  if (source) lines.push(python ? source : `$ ${source}`);
  if (output) lines.push(output);
  const notes: string[] = [];
  if (message.excludeFromContext === true) notes.push("deliberately excluded from model context");
  if (message.cancelled === true) notes.push("cancelled");
  else if (typeof message.exitCode === "number" && message.exitCode !== 0) notes.push(`exit ${message.exitCode}`);
  if (message.truncated === true) notes.push("output truncated");
  if (notes.length) lines.push(`[${notes.join(", ")}]`);
  if (lines.length === 0) return [];
  const body = lines.join("\n");
  // A fence longer than any backtick run inside, so output cannot close it early.
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), (run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [{ kind: "text", text: `${fence}${python ? "python" : "sh"}\n${body}\n${fence}` }];
}

/**
 * A `fileMention` row records what `@file` did with each mention. A skipped file
 * (too large, binary) was never sent to the model, which the user cannot tell
 * from the prompt alone.
 */
function fileMentionParts(message: JsonObject): UiPart[] {
  if (!Array.isArray(message.files)) return [];
  const lines = message.files.filter(isJsonObject).filter((file) => typeof file.path === "string").map((file) => {
    const path = JSON.stringify(file.path);
    const size = typeof file.byteSize === "number" ? ` (${file.byteSize.toLocaleString("en-US")} bytes)` : "";
    if (typeof file.skippedReason === "string" && file.skippedReason) {
      const reason = file.skippedReason === "tooLarge" ? "file too large" : file.skippedReason === "binary" ? "binary file" : file.skippedReason;
      return `Skipped ${path}: ${reason}${size}. Contents were not automatically included.`;
    }
    return `Read ${path}${file.image === true ? " (image)" : typeof file.lineCount === "number" ? ` (${file.lineCount} lines)` : ""}.`;
  });
  // Escape markdown: a file name such as `a_b_c` must not turn into emphasis.
  return lines.length ? [{ kind: "text", text: lines.join("\n\n").replace(/([\\`*_<>])/g, "\\$1") }] : [];
}

/**
 * These OMP messages request activity markers, never conversation bodies.
 * `local-image-labels` is the desktop TUI's display:true list of pasted
 * images as file:// links into the laptop's blob store; the phone cannot open
 * them, so it rendered a bubble of "[Image #1] [blocked]" after image turns.
 */
export function isActivityOnlyCustomMessageType(customType: unknown): boolean {
  return customType === "irc:incoming" || customType === "async-result" || customType === "launch-completion"
    || customType === "local-image-labels";
}

/**
 * Extension conversation messages contain text/image content, not model
 * reasoning or executable tool calls. Their display flag is opt-in; custom
 * session bookkeeping without it must never become a transcript row.
 */
function customEntryMessage(entry: OmpEntry, message: OmpMessage | undefined): UiMessage | null {
  const persisted = entry.type === "custom_message";
  const source = persisted ? entry : message;
  if (!source) return null;
  // OMP sets display:true on internal deliveries to request activity markers.
  // Treating that flag as chat prose leaked coordination and job instructions.
  if (isActivityOnlyCustomMessageType(source.customType)) return null;
  const collabPrompt = source.customType === "collab-prompt";
  if (!collabPrompt && source.display !== true) return null;
  const content = source.content;
  const parts = partsFromContent(Array.isArray(content)
    ? content.filter((part) => isJsonObject(part) && (part.type === "text" || part.type === "image"))
    : content);
  if (parts.length === 0) return null;
  const timestamp = dateFromValue(source.timestamp);
  return {
    // Unanchored live rows are transient: controllers request authoritative
    // history rather than merging them by text or an approximate timestamp.
    // Equal content is not proof that two deliberate messages are the same.
    id: message?.id ?? entry.id ?? `live:custom:${JSON.stringify([source.customType, timestamp?.getTime()])}`,
    role: collabPrompt ? "user" : "assistant",
    customType: typeof source.customType === "string" ? source.customType : undefined,
    ...(source.details !== undefined ? { customDetails: source.details } : {}),
    text: textFromParts(parts),
    parts,
    createdAt: timestamp,
    sourceEntryId: entry.id,
  };
}

/** Normalize a live custom/hook end without touching the assistant stream. */
export function customMessageToTranscript(message: OmpMessage): Transcript | null {
  if (message.role !== "custom" && message.role !== "hookMessage") return null;
  return entriesToTranscript([{ type: "message", id: message.id, message }]);
}

export function entryToUiMessage(entry: OmpEntry, index: number): UiMessage | null {
  const message = entry.message;
  if (entry.type === "custom_message" || message?.role === "custom" || message?.role === "hookMessage") {
    return customEntryMessage(entry, message);
  }
  if (!message) return null;

  const role = message.role;
  // `bashExecution` and `pythonExecution` are real turns omp persists
  // (session/messages.ts:923,940) — background job output and broker-injected
  // async results land with these roles. They were dropped wholesale, so the
  // transcript on the phone simply skipped them. Render them as assistant
  // turns, which is how the terminal shows them.
  const isExecution = role === "bashExecution" || role === "pythonExecution";
  const isFileMention = role === "fileMention";
  if (role !== "user" && role !== "assistant" && !isExecution && !isFileMention) return null;

  const rawText = message ? rawAssistantText(message) : null;
  const displayBoundaries: number[] = [];
  const parts = isFileMention ? fileMentionParts(message) : isExecution ? executionParts(message, role) : partsFromContent(message.content, displayBoundaries);
  // Preserve per-turn usage / cost and contextSnapshot when present on the wire.
  // The daemon forwards these verbatim from the transcript (see delta.rs envelope).
  let usage: UiMessage["usage"];
  const rawUsage = (message as JsonObject | undefined)?.usage;
  if (isJsonObject(rawUsage)) {
    const costRaw = (rawUsage as JsonObject).cost;
    const cost = isJsonObject(costRaw)
      ? {
          input: typeof costRaw.input === "number" && Number.isFinite(costRaw.input) ? costRaw.input : undefined,
          output: typeof costRaw.output === "number" && Number.isFinite(costRaw.output) ? costRaw.output : undefined,
          cacheRead: typeof costRaw.cacheRead === "number" && Number.isFinite(costRaw.cacheRead) ? costRaw.cacheRead : undefined,
          cacheWrite: typeof costRaw.cacheWrite === "number" && Number.isFinite(costRaw.cacheWrite) ? costRaw.cacheWrite : undefined,
          total: typeof costRaw.total === "number" && Number.isFinite(costRaw.total) ? costRaw.total : undefined,
        }
      : undefined;
    const hasCost = cost && Object.values(cost).some((v) => typeof v === "number");
    const u: NonNullable<UiMessage["usage"]> = {};
    if (typeof rawUsage.input === "number" && Number.isFinite(rawUsage.input)) u.input = rawUsage.input;
    if (typeof rawUsage.output === "number" && Number.isFinite(rawUsage.output)) u.output = rawUsage.output;
    if (typeof rawUsage.cacheRead === "number" && Number.isFinite(rawUsage.cacheRead)) u.cacheRead = rawUsage.cacheRead;
    if (typeof rawUsage.cacheWrite === "number" && Number.isFinite(rawUsage.cacheWrite)) u.cacheWrite = rawUsage.cacheWrite;
    if (typeof rawUsage.totalTokens === "number" && Number.isFinite(rawUsage.totalTokens)) u.totalTokens = rawUsage.totalTokens;
    if (typeof rawUsage.total === "number" && Number.isFinite(rawUsage.total)) u.total = rawUsage.total;
    if (hasCost) u.cost = cost;
    if (Object.keys(u).length) usage = u;
  }
  let contextSnapshot: UiMessage["contextSnapshot"];
  const rawCtx = (message as JsonObject | undefined)?.contextSnapshot;
  if (isJsonObject(rawCtx)) {
    const c: NonNullable<UiMessage["contextSnapshot"]> = {};
    if (typeof rawCtx.promptTokens === "number" && Number.isFinite(rawCtx.promptTokens)) c.promptTokens = rawCtx.promptTokens;
    if (typeof rawCtx.nonMessageTokens === "number" && Number.isFinite(rawCtx.nonMessageTokens)) c.nonMessageTokens = rawCtx.nonMessageTokens;
    if (typeof rawCtx.compactionEpoch === "number" && Number.isFinite(rawCtx.compactionEpoch)) c.compactionEpoch = rawCtx.compactionEpoch;
    if (Object.keys(c).length) contextSnapshot = c;
  }
  const rawRetry = (message as JsonObject | undefined)?.retryRecovery;
  const retryStatus = isJsonObject(rawRetry) ? rawRetry.status : undefined;
  const retryAttempt = isJsonObject(rawRetry) ? rawRetry.attempt : undefined;
  const retry = retryStatus === "superseded" || retryStatus === "recovered"
    ? { status: retryStatus as "superseded" | "recovered", attempt: typeof retryAttempt === "number" && Number.isFinite(retryAttempt) ? retryAttempt : 1 }
    : undefined;
  const rawDuration = (message as JsonObject | undefined)?.duration;
  // Entry timestamps record persistence, not response start. Use the message
  // timestamp shared by both transports when interruption precedes a provider id.
  const startedAt = dateFromValue(message?.timestamp);
  const responseKey = role !== "assistant" ? undefined
    : typeof message?.responseId === "string" && message.responseId
      ? `response:${message.responseId}`
      : startedAt
        ? `started:${startedAt.getTime()}:${String(message?.provider ?? "")}:${String(message?.model ?? "")}`
        : undefined;
  const uiMessage: UiMessage = {
    id: messageId(entry, message ?? {}, index),
    // Execution turns render on the assistant side; UiRole has no separate kind
    // and inventing one would touch every renderer for no visible gain.
    role: isExecution || isFileMention ? "assistant" : role,
    text: textFromParts(parts),
    parts,
    createdAt: dateFromValue(entry.timestamp ?? message?.timestamp),
    completedAt: dateFromValue(entry.completedAt ?? message?.completedAt),
    sourceEntryId: entry.id,
    model: typeof message?.model === "string" ? message.model : undefined,
    errorMessage:
      typeof message?.errorMessage === "string" ? message.errorMessage : undefined,
    stopReason: typeof message?.stopReason === "string" ? message.stopReason : undefined,
    responseKey,
    ...(usage ? { usage } : {}),
    ...(role === "assistant" && typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration > 0
      ? { duration: rawDuration }
      : {}),
    ...(contextSnapshot ? { contextSnapshot } : {}),
    ...(retry && role === "assistant" ? { retry } : {}),
  };
  const sourced = message ? withResponseItem(uiMessage, message) : uiMessage;
  return rawText === null ? sourced : withRawAssistantText(sourced, rawText, displayBoundaries);
}

/**
 * Merge two revisions of one assistant message's tool calls, keeping the
 * freshest execution state of each call. A persisted revision (no output, no
 * start time) inherits what the live stream saw; a live update keeps its own
 * new output. Taking the older side unconditionally discarded every
 * `tool_execution_update` for a call already in the transcript, so a tool
 * that started before the phone connected showed "Running · 0:00" and no
 * output for its whole run.
 */
export function mergeToolParts(incoming: UiMessage, previous: UiMessage | null): UiMessage {
  if (!previous) return incoming;
  const live = previous.parts.filter((part): part is Extract<UiPart, { kind: "tool" }> => part.kind === "tool");
  if (!live.length) return incoming;
  const seen = new Set<string>();
  const parts = incoming.parts.map((part) => {
    if (part.kind !== "tool") return part;
    seen.add(part.callId);
    const older = live.find((item) => item.callId === part.callId);
    if (!older || part.state !== "running") return part;
    const state = older.state;
    const output = part.output ?? older.output;
    const endedAt = part.endedAt ?? older.endedAt;
    const edits = part.edits ?? older.edits;
    const agents = part.agents ?? older.agents;
    const images = part.images ?? older.images;
    const todo = part.todo ?? older.todo;
    const shell = part.shell ?? older.shell;
    const search = part.search ?? older.search;
    // Either side may have first seen the call late; the earlier sighting
    // is the closer one to the real start.
    const startedAt = part.startedAt !== undefined && older.startedAt !== undefined
      ? Math.min(part.startedAt, older.startedAt)
      : part.startedAt ?? older.startedAt;
    if (state === part.state && output === part.output && startedAt === part.startedAt && endedAt === part.endedAt && edits === part.edits && agents === part.agents && images === part.images && todo === part.todo && shell === part.shell && search === part.search) return part;
    return { ...part, state, output, startedAt, endedAt, edits, images, todo, shell, ...(search ? { search } : {}), ...withAgents(agents) };
  });
  for (const part of live) if (!seen.has(part.callId)) parts.push(part);
  return parts.length === incoming.parts.length && parts.every((part, index) => part === incoming.parts[index])
    ? incoming : { ...incoming, parts };
}

/**
 * Apply tool results to already-rendered messages. Identity is preserved for
 * every message that does not change, so memoised rows do not re-render.
 */
export function applyToolResults(
  messages: readonly UiMessage[],
  results: readonly UiToolResult[],
): { messages: UiMessage[]; unmatched: UiToolResult[] } {
  if (results.length === 0) return { messages: messages as UiMessage[], unmatched: [] };

  const byCallId = new Map<string, UiToolResult>();
  for (const result of results) byCallId.set(result.callId, result);

  let next: UiMessage[] | undefined;
  const matched = new Set<string>();
  messages.forEach((message, index) => {
    let parts: UiPart[] | undefined;
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i];
      if (part.kind !== "tool") continue;
      const result = byCallId.get(part.callId);
      if (!result) continue;
      parts ??= message.parts.slice();
      parts[i] = {
        ...part,
        state: result.isError ? "error" : "ok",
        output: result.output,
        pruned: result.pruned,
        images: result.images,
        shell: result.shell,
        ...(result.search ? { search: result.search } : {}),
        endedAt: part.endedAt ?? result.at,
        edits: result.edits ?? part.edits,
        todo: result.todo ?? part.todo,
        ...withAgents(result.agents ?? part.agents),
      };
      matched.add(result.callId);
    }
    if (!parts) return;
    next ??= messages.slice();
    next[index] = { ...message, parts };
  });

  return {
    messages: next ?? (messages as UiMessage[]),
    unmatched: results.filter((result) => !matched.has(result.callId)),
  };
}

/**
 * Fold a page of entries into renderable turns. Tool results are stitched onto
 * their calls inside the batch; anything whose call lives in another page is
 * returned so the store can apply it to what it already holds.
 */
export function entriesToTranscript(entries: readonly OmpEntry[]): Transcript {
  const seen = new Map<string, number>();
  const rawIds = new Set<string>();
  const messages: UiMessage[] = [];
  const results: UiToolResult[] = [];
  const settledAgents: UiAgentStatus[] = [];
  let duplicateId = false;

  entries.forEach((entry, index) => {
    if (typeof entry.id === "string") {
      if (rawIds.has(entry.id)) duplicateId = true;
      rawIds.add(entry.id);
    }
    const message = entry.message;
    const custom = entry.type === "custom_message" ? entry
      : message?.role === "custom" || message?.role === "hookMessage" ? message : null;
    if (custom?.customType === "async-result") {
      settledAgents.push(...asyncResultStatuses(custom));
    }
    if (message?.role === "toolResult") {
      const result = toolResultFromEntry(message, dateFromValue(entry.timestamp ?? message.timestamp)?.getTime());
      if (result) results.push(result);
      return;
    }
    const ui = entryToUiMessage(entry, index);
    if (!ui) return;
    const previous = seen.get(ui.id);
    if (previous !== undefined) {
      duplicateId = true;
      return;
    }
    seen.set(ui.id, messages.length);
    messages.push(ui);
  });

  // Role filtering and message IDs can conceal duplicate raw entry IDs.
  // Hidden claims must veto aliases without changing transcript deduplication.
  const unambiguous = duplicateId ? messages.map(withAmbiguousResponseItem) : messages;
  const applied = applyToolResults(unambiguous, results);
  return { messages: applied.messages, orphanResults: applied.unmatched, settledAgents };
}

export function entriesToUiMessages(entries: readonly OmpEntry[]): UiMessage[] {
  return entriesToTranscript(entries).messages;
}


export function createUserMessage(text: string, commandId: string, createdAt: number, imageCount = 0): UiMessage {
  return {
    id: `local:${commandId}`,
    ...(Number.isSafeInteger(imageCount) && imageCount > 0 ? { localAttachmentCount: imageCount } : {}),
    role: "user",
    text,
    parts: [{ kind: "text", text }],
    createdAt: new Date(createdAt),
  };
}
