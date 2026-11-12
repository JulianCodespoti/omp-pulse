import type { UiMessage } from "../domain/messages";
import { isRefusalText } from "../domain/turn-errors";
import { isPendingIntent } from "./browser-pending-presentation";
import type { QueuedPrompt } from "./offline-queue";
import { turnOutcome } from "./receipt-outcome";

/** What one user row shows from the outbox. */
export interface UserRowStatus {
  /** Sends that still need the user's eyes, shown inside the bubble. */
  pills: QueuedPrompt[];
  /** The model declined this prompt: a note stands where the reply would be. */
  refused: QueuedPrompt | null;
}

/** Image-only prompts have no text, so their image count keys them instead. */
function rowKey(text: string, images: number, native: boolean): string | null {
  const trimmed = text.trim();
  if (trimmed) return native ? JSON.stringify([trimmed, images]) : trimmed;
  return images > 0 ? `\u0000img:${images}` : null;
}

/**
 * Whether the prompt is (or may be) in the transcript, so it owns a transcript
 * row. A send the daemon still holds for a free agent, or one that never left
 * this device, has no row yet and must not take an older same-text row's place.
 */
function ownsTranscriptRow(entry: QueuedPrompt): boolean {
  switch (entry.state) {
    case "accepted":
      return entry.receipt?.code !== "agents_busy";
    case "received":
    case "running":
    case "completed":
    case "forwarded":
    case "uncertain":
      return true;
    case "failed":
      return turnOutcome(entry) !== null;
    default:
      return false;
  }
}

/**
 * Bind outbox entries to the user rows they belong to.
 *
 * The optimistic `local:<commandId>` echo carries the command id, so it binds
 * exactly. Transcript rows carry no id: entries pair with same-key rows from
 * the newest end, counting every entry that reached the transcript (finished
 * ones included), so one repeated "Continue" cannot land its status on the
 * wrong bubble. Entries with no row yet stay visible on the newest same-key
 * row rather than vanish.
 */
export function bindUserRowStatus(
  messages: readonly UiMessage[],
  entries: readonly QueuedPrompt[],
  sessionPath: string | null,
  browser: boolean,
): Map<string, UserRowStatus> {
  const result = new Map<string, UserRowStatus>();
  if (!sessionPath || entries.length === 0) return result;
  const echoRows = new Map<string, string>();
  const transcriptRows = new Map<string, string[]>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (!message.sourceEntryId && message.id.startsWith("local:")) {
      echoRows.set(message.id.slice(6), message.id);
      continue;
    }
    let images = 0;
    for (const part of message.parts) if (part.kind === "image") images++;
    const key = rowKey(message.text, images, !browser);
    if (!key) continue;
    const rows = transcriptRows.get(key);
    if (rows) rows.push(message.id);
    else transcriptRows.set(key, [message.id]);
  }

  const attach = (rowId: string, entry: QueuedPrompt): void => {
    if (!browser) {
      const row = messages.find(message => message.id === rowId);
      if (row?.createdAt && (row.sourceEntryId || !row.id.startsWith("local:"))
        && row.createdAt.getTime() < entry.createdAt) return;
    }
    const outcome = turnOutcome(entry);
    if (outcome !== "refused" && (outcome || entry.state === "completed" || entry.state === "forwarded")) return;
    let status = result.get(rowId);
    if (!status) {
      status = { pills: [], refused: null };
      result.set(rowId, status);
    }
    if (outcome === "refused") {
      if (!status.refused || status.refused.createdAt < entry.createdAt) status.refused = entry;
    } else status.pills.push(entry);
  };

  const ranked = new Map<string, QueuedPrompt[]>();
  const rowless = new Map<string, QueuedPrompt[]>();
  for (const entry of entries) {
    if (entry.sessionPath !== sessionPath) continue;
    // Browser pending intents render from their exact local projection.
    if (browser && isPendingIntent(entry)) continue;
    const echo = echoRows.get(entry.commandId);
    if (echo) {
      attach(echo, entry);
      continue;
    }
    // Native rowless intents have their own retained queue surface. Never put
    // a saved/failed new send's actions onto an older same-text transcript row.
    if (!browser && !ownsTranscriptRow(entry)) continue;
    const key = rowKey(entry.text, entry.imageCount, !browser);
    if (!key || !transcriptRows.has(key)) continue;
    const bucket = ownsTranscriptRow(entry) ? ranked : rowless;
    const list = bucket.get(key);
    if (list) list.push(entry);
    else bucket.set(key, [entry]);
  }
  for (const [key, list] of ranked) {
    const rows = transcriptRows.get(key)!;
    list.sort((a, b) => b.createdAt - a.createdAt);
    // Newest entry pairs with the newest row; more entries than rows (rows
    // trimmed from memory) keep the surplus on the newest row.
    list.forEach((entry, index) => attach(rows[index < rows.length ? rows.length - 1 - index : rows.length - 1]!, entry));
  }
  for (const [key, list] of rowless) {
    const newest = transcriptRows.get(key)!.at(-1)!;
    for (const entry of list) attach(newest, entry);
  }

  // A refusal the live stream already put in the transcript speaks for itself.
  if ([...result.values()].some((status) => status.refused)) {
    let row: string | null = null;
    for (const message of messages) {
      if (message.role === "user") row = message.id;
      else if (row && message.role === "assistant" && isRefusalText(message.errorMessage)) {
        const status = result.get(row);
        if (status) status.refused = null;
      }
    }
  }
  for (const [row, status] of result) {
    if (status.pills.length === 0 && !status.refused) result.delete(row);
    else status.pills.sort((a, b) => a.createdAt - b.createdAt);
  }
  return result;
}
