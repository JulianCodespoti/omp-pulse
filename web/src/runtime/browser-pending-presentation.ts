import type { UiMessage } from "../domain/messages";
import { ownsLocalSend } from "../domain/local-send-provenance";
import type { QueuedPrompt } from "./offline-queue";
import type { QueuedMessages } from "./omp-store";
import { turnOutcome } from "./receipt-outcome";

export function isPendingIntent(entry: QueuedPrompt): boolean {
  return entry.state === "saved" || entry.state === "dispatching" || entry.state === "uncertain";
}

function rowKey(text: string, images: number): string {
  return JSON.stringify([text.trim(), images]);
}

/** Canonical rows consume reached intents newest-first, including successful
 * sends, so a repeated prompt's older receipt cannot claim its newer row. */
function canonicalIntents(messages: readonly UiMessage[], entries: readonly QueuedPrompt[]): Set<string> {
  const rows = new Map<string, UiMessage[]>();
  for (const message of messages) {
    if (message.role !== "user" || (!message.sourceEntryId && message.id.startsWith("local:"))) continue;
    const key = rowKey(message.text, message.parts.filter(part => part.kind === "image").length);
    const bucket = rows.get(key);
    if (bucket) bucket.push(message); else rows.set(key, [message]);
  }
  const matched = new Set<string>();
  for (const entry of [...entries].sort((a, b) => b.createdAt - a.createdAt)) {
    if (entry.state === "saved" || entry.state === "dispatching"
      || (entry.state === "failed" && !turnOutcome(entry)) || entry.receipt?.code === "agents_busy") continue;
    const bucket = rows.get(rowKey(entry.text, entry.imageCount));
    const row = bucket?.at(-1);
    // A known older transcript row is never evidence for this newer intent.
    if (!row || (row.createdAt && row.createdAt.getTime() < entry.createdAt)) continue;
    bucket!.pop();
    matched.add(entry.commandId);
  }
  return matched;
}

/** Read-only projection of the active credential's retained intents. Native
 * persistence survives a WebView/controller; its rowless intents need no local
 * echo proof. Existing local echoes still require their exact live provenance. */
export function projectPendingIntents(
  messages: UiMessage[], entries: readonly QueuedPrompt[], sessionPath: string | null,
  scope: string, controller: object, mode: "browser" | "native", queued?: QueuedMessages,
): { messages: UiMessage[]; pending: QueuedPrompt[]; localEntries: Map<UiMessage, QueuedPrompt> } {
  const localEntries = new Map<UiMessage, QueuedPrompt>();
  if (!scope || !sessionPath) return { messages, pending: [], localEntries };
  const scoped = entries.filter(entry => entry.sessionPath === sessionPath);
  const canonical = mode === "native" ? canonicalIntents(messages, scoped) : new Set<string>();
  const held = new Map<string, number>();
  if (mode === "native" && queued) {
    const steering = queued.liveSteered ? queued.steering.slice(queued.liveSteered) : queued.steering;
    for (const text of [...steering, ...queued.followUp]) held.set(text.trim(), (held.get(text.trim()) ?? 0) + 1);
  }
  const heldIds = new Set<string>();
  for (const entry of scoped) {
    if (entry.state !== "accepted" && entry.state !== "received" && entry.state !== "running") continue;
    const count = held.get(entry.text.trim()) ?? 0;
    if (count > 0 && !canonical.has(entry.commandId)) {
      heldIds.add(entry.commandId);
      held.set(entry.text.trim(), count - 1);
    }
  }
  const intents = new Map(scoped.filter(entry => isPendingIntent(entry) || (mode === "native"
    && (entry.state === "accepted" || entry.state === "received" || entry.state === "running"
      || entry.state === "failed" || turnOutcome(entry) === "refused")))
    .map(entry => [entry.commandId, entry]));
  const owned = new Set<string>();
  const retained = mode === "native" ? new Map(scoped.map(entry => [entry.commandId, entry])) : intents;
  let filtered: UiMessage[] | null = null;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const entry = message.role === "user" && !message.sourceEntryId && message.id.startsWith("local:")
      ? retained.get(message.id.slice(6)) : undefined;
    if (entry && (canonical.has(entry.commandId) || heldIds.has(entry.commandId)
      || !ownsLocalSend(message, entry, scope, controller) || owned.has(entry.commandId))) {
      filtered ??= messages.slice(0, index);
      continue;
    }
    if (entry && intents.has(entry.commandId)) { owned.add(entry.commandId); localEntries.set(message, entry); }
    filtered?.push(message);
  }
  const pending = [...intents.values()].filter(entry => !owned.has(entry.commandId)
    && !canonical.has(entry.commandId) && !heldIds.has(entry.commandId))
    .sort((a, b) => a.createdAt - b.createdAt || a.commandId.localeCompare(b.commandId));
  return { messages: filtered ?? messages, pending, localEntries };
}
