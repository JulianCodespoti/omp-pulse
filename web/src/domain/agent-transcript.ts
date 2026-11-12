import { applyToolResults, entriesToTranscript, mergeToolParts, type UiMessage, type UiToolResult } from "./messages";
import type { OmpEntry } from "./protocol";

export const AGENT_MESSAGE_LIMIT = 200;
export const AGENT_BYTE_LIMIT = 8 * 1024 * 1024;
export const AGENT_RECORD_LIMIT = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
// The retained budget is the UTF-8 length of the buffer's JSON, as it always
// was, but each message/result is serialized once per object identity.
// Re-stringifying all retained payload (up to 8 MiB) on every 3 s poll, and
// again for each record dropped while trimming, churned multi-MB strings in
// the WebView. Transcript records are immutable: revisions are new objects.
const sizes = new WeakMap<object, number>();
function recordBytes(value: object): number {
  let size = sizes.get(value);
  if (size === undefined) { size = bytes(JSON.stringify(value)); sizes.set(value, size); }
  return size;
}
// JSON.stringify(array): brackets, every element, and a comma between each.
const arrayBytes = (count: number, payload: number) => 2 + payload + Math.max(count - 1, 0);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export type AgentTranscriptBuffer = {
  messages: UiMessage[];
  orphanResults: UiToolResult[];
  carry: string;
  sequence: number;
  limited: boolean;
  /** Newest `model_change` record; a long transcript keeps it after its messages are trimmed. */
  model?: string;
  /** Newest `thinking_level_change` record. Assistant turns never carry the level. */
  thinkingLevel?: string;
};
export const emptyAgentTranscript = (): AgentTranscriptBuffer => ({ messages: [], orphanResults: [], carry: "", sequence: 0, limited: false });

function settings(state: AgentTranscriptBuffer, entries: readonly OmpEntry[]): Pick<AgentTranscriptBuffer, "model" | "thinkingLevel"> {
  let { model, thinkingLevel } = state;
  for (const value of entries as readonly Record<string, unknown>[]) {
    if (value.type === "model_change" && typeof value.model === "string" && value.model.trim()) model = value.model;
    else if (value.type === "thinking_level_change" && typeof value.thinkingLevel === "string") thinkingLevel = value.thinkingLevel;
  }
  return { model, thinkingLevel };
}

function entry(value: unknown, sequence: number): OmpEntry {
  if (!object(value) || (value.message !== undefined && !object(value.message))) throw new Error("The agent transcript contains an invalid record.");
  // RPC versions may expose raw messages instead of session-file entries.
  const normalized = typeof value.role === "string" && value.message === undefined ? { type: "message", id: value.id, message: value } : value;
  return { ...normalized, id: typeof normalized.id === "string" && normalized.id ? normalized.id : `agent-record-${sequence}` } as OmpEntry;
}

function append(state: AgentTranscriptBuffer, entries: OmpEntry[]): AgentTranscriptBuffer {
  const page = entriesToTranscript(entries);
  const messages = [...state.messages];
  for (const message of page.messages) {
    const index = messages.findIndex((previous) => previous.id === message.id);
    if (index < 0) messages.push(message);
    else messages[index] = mergeToolParts(message, messages[index]);
  }
  // A current page may already have stitched a newer result onto its call.
  // Never overwrite that with an older orphan retained from a previous page.
  const resolvedHere = new Set(page.messages.flatMap((message) => message.parts.flatMap((part) =>
    part.kind === "tool" && part.state !== "running" ? [part.callId] : [])));
  const applied = applyToolResults(messages, [...state.orphanResults.filter((result) => !resolvedHere.has(result.callId)), ...page.orphanResults]);
  let retained = applied.messages;
  let orphans = applied.unmatched;
  let limited = state.limited;
  // Bound both rendered turns and retained payload bytes, including unmatched
  // results. A single oversized record stops the read instead of silently
  // deleting a message or tool output from the conversation.
  if (retained.length > AGENT_MESSAGE_LIMIT) { retained = retained.slice(-AGENT_MESSAGE_LIMIT); limited = true; }
  if (orphans.length > AGENT_MESSAGE_LIMIT) { orphans = orphans.slice(-AGENT_MESSAGE_LIMIT); limited = true; }
  let retainedPayload = retained.reduce((sum, message) => sum + recordBytes(message), 0);
  let orphanPayload = orphans.reduce((sum, result) => sum + recordBytes(result), 0);
  const carryBytes = bytes(state.carry);
  let dropRetained = 0;
  let dropOrphans = 0;
  const total = () => arrayBytes(retained.length - dropRetained, retainedPayload) + arrayBytes(orphans.length - dropOrphans, orphanPayload) + carryBytes;
  while (total() > AGENT_BYTE_LIMIT && (retained.length - dropRetained > 1 || orphans.length - dropOrphans)) {
    if (orphans.length - dropOrphans) orphanPayload -= recordBytes(orphans[dropOrphans++]);
    else retainedPayload -= recordBytes(retained[dropRetained++]);
    limited = true;
  }
  if (total() > AGENT_BYTE_LIMIT) throw new Error("This transcript record is too large to display safely.");
  if (dropRetained) retained = retained.slice(dropRetained);
  if (dropOrphans) orphans = orphans.slice(dropOrphans);
  return { ...state, ...settings(state, entries), messages: retained, orphanResults: orphans, limited };
}

function appendValues(state: AgentTranscriptBuffer, values: unknown[]): AgentTranscriptBuffer {
  const entries = values.map((value, index) => entry(value, state.sequence + index));
  return append({ ...state, sequence: state.sequence + entries.length }, entries);
}

/** An empty page returns the same buffer, so an idle poll can skip publishing. */
export function appendAgentEntries(state: AgentTranscriptBuffer, values: unknown[]): AgentTranscriptBuffer {
  return values.length ? appendValues(state, values) : state;
}

/** The server owns the byte cursor. JS character counts never advance it. */
export function appendAgentJsonl(state: AgentTranscriptBuffer, text: string): AgentTranscriptBuffer {
  const combined = state.carry + text;
  const lastNewline = combined.lastIndexOf("\n");
  const carry = combined.slice(lastNewline + 1);
  if (bytes(carry) > AGENT_RECORD_LIMIT) throw new Error("This transcript record is too large to display safely.");
  const values: unknown[] = [];
  for (const line of combined.slice(0, lastNewline + 1).split("\n")) {
    if (!line.trim()) continue;
    if (bytes(line) > AGENT_RECORD_LIMIT) throw new Error("This transcript record is too large to display safely.");
    try { values.push(JSON.parse(line)); }
    catch { throw new Error("The agent transcript contains an invalid record."); }
  }
  // Nothing completed and the unfinished tail is unchanged: nothing new.
  if (!values.length && carry === state.carry) return state;
  return appendValues({ ...state, carry }, values);
}

/** Only complete records are visible; an unfinished record never becomes a turn. */
export function visibleAgentTranscript(state: AgentTranscriptBuffer): { messages: UiMessage[]; limited: boolean; partial: boolean; model?: string; thinkingLevel?: string } {
  return { messages: state.messages, limited: state.limited, partial: Boolean(state.carry.trim()), model: state.model, thinkingLevel: state.thinkingLevel };
}
