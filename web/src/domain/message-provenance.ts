import type { UiMessage, UiPart } from "./messages";
import type { OmpMessage } from "./protocol";

// Enumerable so immutable spreads retain it, but neither JSON nor structured
// clone can serialize a symbol key. Only this module can mint the provenance.
const rawAssistantSource = Symbol("raw assistant source");
type TextPart = Extract<UiPart, { kind: "text" }>;
interface SourceSnapshot {
  id: string;
  responseKey: string | undefined;
  text: string;
  // Avoid retaining a second aggregate when source and display are identical.
  raw: string | null;
  /** Normalizer-proven synthetic fence newlines at raw UTF-16 offsets. */
  displayBoundaries: readonly number[];
  parts: readonly { part: TextPart; text: string }[];
}
type SourcedMessage = UiMessage & { [rawAssistantSource]?: SourceSnapshot };

/** Match src/server/delta.rs content_text, before any display-only fence repair. */
export function rawAssistantText(message: OmpMessage): string | null {
  if (message.role !== "assistant") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content.map((part) => part && typeof part === "object" &&
    part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
}

/** Attach only to a fully constructed snapshot, never to a display projection. */
export function withRawAssistantText(message: UiMessage, raw: string | null, displayBoundaries: readonly number[] = []): UiMessage {
  if (raw === null || message.role !== "assistant") return withoutRawAssistantText(message);
  const snapshot: SourceSnapshot = {
    id: message.id, responseKey: message.responseKey, text: message.text,
    raw: raw === message.text ? null : raw,
    displayBoundaries,
    parts: message.parts.filter((part): part is TextPart => part.kind === "text")
      .map((part) => ({ part, text: part.text })),
  };
  const sourced: SourcedMessage = { ...message, [rawAssistantSource]: snapshot };
  return sourced;
}

/** A spread that changes prose/identity cannot borrow the old source proof.
 * Tool-only changes retain the text-part objects and remain valid. */
export function getRawAssistantText(message: UiMessage): string | null {
  const source = (message as SourcedMessage)[rawAssistantSource];
  if (!source || message.role !== "assistant" || source.id !== message.id ||
      source.responseKey !== message.responseKey || source.text !== message.text) return null;
  let index = 0;
  for (const part of message.parts) {
    if (part.kind !== "text") continue;
    const bound = source.parts[index++];
    if (!bound || bound.part !== part || bound.text !== part.text) return null;
  }
  return index === source.parts.length ? source.raw ?? message.text : null;
}

/** Bound by the same identity/text proof and stripped with it at cache seams. */
export function getAssistantDisplayBoundaries(message: UiMessage): readonly number[] {
  if (getRawAssistantText(message) === null) return [];
  return (message as SourcedMessage)[rawAssistantSource]!.displayBoundaries;
}

/** Explicit cache boundary, including in-memory/test storage implementations. */
export function withoutRawAssistantText(message: UiMessage): UiMessage {
  const { [rawAssistantSource]: _source, ...rest } = message as SourcedMessage;
  return rest;
}
