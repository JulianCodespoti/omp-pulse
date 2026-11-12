import type { QueuedImage } from "./offline-queue";

/**
 * Messages omp was holding when Stop withdrew them (`/api/abort` with
 * `restoreQueue`, omp's `abort_and_restore_queue`). Their text goes back to
 * the composer; nothing re-sends them.
 */
export interface WithdrawnMessage {
  readonly text: string;
  readonly images: readonly QueuedImage[];
}

export interface WithdrawnQueue {
  /** Oldest first: steering, then follow-ups. */
  readonly messages: readonly WithdrawnMessage[];
  /** Native frame limits actually prevented recovery of some photos. */
  readonly imagesDropped: boolean;
  /** omp returned only the oldest part of a very large queue. */
  readonly truncated: boolean;
  /** Daemon journal id; acknowledge it only after the draft save is durable. */
  readonly recoveryId?: string;
  /** The record was too large for the reply and must be replayed from the journal. */
  readonly recoveryPending?: boolean;
}

/** The daemon's `withdrawn` reply field; null when absent or malformed. */
export function parseWithdrawnQueue(raw: unknown): WithdrawnQueue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  // Stop's `withdrawn`, a journal record's owner-shaped queue, or one removed message.
  const entries = Array.isArray(value.messages) ? value.messages
    : Array.isArray(value.steering) && Array.isArray(value.followUp) ? [...value.steering, ...value.followUp]
    : value.removed === true && typeof value.text === "string" ? [value]
    : value.recoveryPending === true ? [] : null;
  if (!entries) return null;
  const messages: WithdrawnMessage[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const message = entry as { text?: unknown; images?: unknown };
    if (typeof message.text !== "string") continue;
    messages.push({ text: message.text, images: parseQueueImages(message.images) });
  }
  return {
    messages,
    imagesDropped: value.imagesDropped === true,
    truncated: value.truncated === true,
    recoveryId: typeof value.recoveryId === "string" ? value.recoveryId : undefined,
    recoveryPending: value.recoveryPending === true,
  };
}

export function parseQueueImages(raw: unknown): QueuedImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((image): image is QueuedImage => {
    if (typeof image !== "object" || image === null) return false;
    const value = image as { data?: unknown; mimeType?: unknown };
    return typeof value.data === "string" && typeof value.mimeType === "string";
  }).map(({ data, mimeType }) => ({ data, mimeType }));
}
