import { withoutLocalSendOwner } from "../domain/local-send-provenance";
import { withoutResponseItem } from "../domain/response-item-provenance";
import { isActivityOnlyCustomMessageType, type UiContextBoundary, type UiMessage, type UiPart } from "../domain/messages";
import { withoutRawAssistantText } from "../domain/message-provenance";
import { isJsonObject } from "../domain/protocol";
import type { OmpProjectSummary, OmpSessionSummary } from "../domain/protocol";
import { offlineQueueNamespaceForCredential } from "./offline-queue";

const DB_NAME = "omp-pulse-offline";
const STORE_NAME = "history";
const SESSION_STORE_NAME = "sessions";
const DB_VERSION = 3;
const MAX_TAIL = 50;
const MAX_SESSIONS = 8;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_LIST_ROWS = 200;
const MAX_SESSION_LIST_BYTES = 512 * 1024;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHED_TOOL_TEXT = 16 * 1024;
const SESSION_LIST_REWRITE_MS = 60 * 1000;
// Not 1500: cold-link-boot-routing finds the controller's 1500 ms history
// fallback timer by its delay.
const TAIL_WRITE_INTERVAL_MS = 2000;

export interface CachedTail {
  messages: UiMessage[];
  savedAt: number;
  stale: boolean;
  /** Native-clock context reset; omitted on older cache records, null when cleared. */
  contextBoundary?: UiContextBoundary | null;
}
interface StoredRecord {
  key: string;
  namespace: string;
  sessionPath: string;
  messages: UiMessage[];
  contextBoundary?: UiContextBoundary | null;
  savedAt: number;
  bytes: number;
}
// Everything retention and eviction decide on. Pruning reads this much and
// leaves the retained message bodies in place instead of rewriting them.
interface RecordMeta {
  key: string;
  namespace: string;
  savedAt: number;
  bytes: number;
}
// The history store's own index of every tail's RecordMeta, kept in key order
// and rewritten by each save inside the same transaction, so it cannot drift
// from the rows across views or reloads. Every other path that deletes rows
// drops it instead; the next save rebuilds it with one full scan. The key sorts
// after every `${namespace}:${path}` record key and is never a recordKey().
const META_KEY = "\uffffmeta";
interface StoredMetaIndex {
  key: typeof META_KEY;
  records: RecordMeta[];
}

// No ETag on purpose. The snapshot keeps at most MAX_SESSION_LIST_ROWS rows,
// so pairing it with the full listing's ETag let a reload revalidate to a 304
// and keep the truncated (or an empty, boot-time) list on screen for as long
// as the listing did not change. The snapshot is paint-only: the first
// network fetch after a cold start is always a full 200.
export interface CachedSessionList {
  sessions: OmpSessionSummary[];
  projects?: OmpProjectSummary[];
  savedAt: number;
}
interface StoredSessionList extends CachedSessionList {
  key: string;
  namespace: string;
  bytes: number;
}
let cacheNamespace = "anonymous";
let dbPromise: Promise<IDBDatabase | null> | null = null;
export function setOfflineCacheNamespace(credentialOrNamespace: string): void {
  cacheNamespace =
    !credentialOrNamespace || credentialOrNamespace === "anonymous"
      ? "anonymous"
      : credentialOrNamespace.startsWith("cred-")
        ? credentialOrNamespace
        : offlineQueueNamespaceForCredential(credentialOrNamespace);
}
export function offlineCacheNamespaceForCredential(credential: string): string {
  return offlineQueueNamespaceForCredential(credential);
}
function scopeOf(namespace?: string): string {
  return namespace || cacheNamespace;
}
function recordKey(sessionPath: string, namespace = cacheNamespace): string {
  return `${namespace}:${sessionPath}`;
}
function sessionListKey(namespace = cacheNamespace): string {
  return `${namespace}:sessions`;
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (
          db.objectStoreNames.contains(STORE_NAME) &&
          request.transaction?.objectStore(STORE_NAME).keyPath !== "key"
        ) {
          // Old caches were keyed only by sessionPath and had no credential
          // provenance. Rebuild this disposable cache; never assign it to a device.
          db.deleteObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(STORE_NAME))
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        if (!db.objectStoreNames.contains(SESSION_STORE_NAME))
          db.createObjectStore(SESSION_STORE_NAME, { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}
const STORAGE_UNAVAILABLE = "Offline history storage is unavailable";
const WRITE_FAILED = "offline cache write failed";
const WRITE_ABORTED = "offline cache write aborted";
async function getRecord(key: string): Promise<StoredRecord | null> {
  const db = await openDb();
  if (!db) throw new Error(STORAGE_UNAVAILABLE);
  return new Promise((resolve, reject) => {
    try {
      const request = db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(key);
      request.onsuccess = () =>
        resolve((request.result as StoredRecord | undefined) ?? null);
      request.onerror = () => reject(new Error(STORAGE_UNAVAILABLE));
    } catch {
      reject(new Error(STORAGE_UNAVAILABLE));
    }
  });
}
async function deleteRecord(key: string): Promise<void> {
  const db = await openDb();
  if (!db) throw new Error(STORAGE_UNAVAILABLE);
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(key);
      store.delete(META_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(WRITE_FAILED));
      tx.onabort = () => reject(new Error(WRITE_ABORTED));
    } catch {
      reject(new Error(WRITE_FAILED));
    }
  });
}
// Drop a record only while it is still the exact one that went stale. A save
// that replaced it inside this transaction (or since the read) keeps its row:
// an expired read must never erase a fresh tail.
async function deleteExpiredRecord(key: string, savedAt: number): Promise<void> {
  const db = await openDb();
  if (!db) throw new Error(STORAGE_UNAVAILABLE);
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const current = request.result as StoredRecord | undefined;
        if (current && current.savedAt === savedAt) {
          store.delete(key);
          store.delete(META_KEY);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(WRITE_FAILED));
      tx.onabort = () => reject(new Error(WRITE_ABORTED));
    } catch {
      reject(new Error(WRITE_FAILED));
    }
  });
}
async function deleteNamespaceRecords(namespace: string): Promise<void> {
  const db = await openDb();
  if (!db) throw new Error(STORAGE_UNAVAILABLE);
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(META_KEY);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value as StoredRecord | undefined;
        if (record && record.namespace === namespace) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(WRITE_FAILED));
      tx.onabort = () => reject(new Error(WRITE_ABORTED));
    } catch {
      reject(new Error(WRITE_FAILED));
    }
  });
}
async function getSessionListRecord(
  namespace: string,
): Promise<StoredSessionList | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    try {
      const request = db
        .transaction(SESSION_STORE_NAME, "readonly")
        .objectStore(SESSION_STORE_NAME)
        .get(sessionListKey(namespace));
      request.onsuccess = () =>
        resolve((request.result as StoredSessionList | undefined) ?? null);
      request.onerror = () =>
        reject(new Error("Offline session storage is unavailable"));
    } catch {
      reject(new Error("Offline session storage is unavailable"));
    }
  });
}
async function putSessionListRecord(record: StoredSessionList): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(SESSION_STORE_NAME, "readwrite");
      tx.objectStore(SESSION_STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("offline session cache write failed"));
      tx.onabort = () => reject(new Error("offline session cache write aborted"));
    } catch {
      reject(new Error("offline session cache write failed"));
    }
  });
}
function reviveDates(messages: UiMessage[]): UiMessage[] {
  return messages.map((source) => {
    const { eagerMarkdown: _eagerMarkdown, localAttachmentCount: _localAttachmentCount, ...message } = withoutLocalSendOwner(withoutResponseItem(withoutRawAssistantText(source)));
    if (message.createdAt && typeof message.createdAt === "string") {
      const date = new Date(message.createdAt as unknown as string);
      if (!Number.isNaN(date.getTime())) return { ...message, createdAt: date };
    }
    if (message.completedAt && typeof message.completedAt === "string") {
      const date = new Date(message.completedAt as unknown as string);
      if (!Number.isNaN(date.getTime()))
        return { ...message, completedAt: date };
    }
    return message;
  });
}
// The cache is a cold-open preview the authoritative history page replaces,
// yet every save cloned full tool outputs and data: images into IndexedDB and
// loadTail cloned them back into the WebView heap. Keep what the preview
// shows: the output's tail (live output is tail-capped the same way), the
// head of oversized argument strings, and only blob: image references.
function capToolArgs(args: unknown): unknown {
  if (typeof args === "string")
    return args.length > MAX_CACHED_TOOL_TEXT ? args.slice(0, MAX_CACHED_TOOL_TEXT) : args;
  if (!isJsonObject(args)) return args;
  let capped: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(args)) {
    if (typeof value !== "string" || value.length <= MAX_CACHED_TOOL_TEXT) continue;
    capped ??= { ...args };
    capped[name] = value.slice(0, MAX_CACHED_TOOL_TEXT);
  }
  return capped ?? args;
}
function sanitizePart(part: UiPart): UiPart {
  if (part.kind === "image") {
    if (part.src && part.src.startsWith("blob:")) return part;
    return { ...part, src: null };
  }
  if (part.kind !== "tool") return part;
  const args = capToolArgs(part.args);
  const outputCapped = part.output !== undefined && part.output.length > MAX_CACHED_TOOL_TEXT;
  const images = part.images?.map((image) => image.src && !image.src.startsWith("blob:") ? { ...image, src: null } : image);
  const imagesCapped = images?.some((image, index) => image !== part.images?.[index]) ?? false;
  if (args === part.args && !outputCapped && !imagesCapped) return part;
  const { images: _images, ...rest } = part;
  return {
    ...rest,
    args,
    ...(outputCapped ? { output: part.output?.slice(-MAX_CACHED_TOOL_TEXT) } : {}),
    ...(images && images.length > 0 ? { images } : {}),
  };
}
function sanitizeMessages(messages: readonly UiMessage[]): UiMessage[] {
  return messages
    .slice(-MAX_TAIL)
    .map((source) => {
      const { eagerMarkdown: _eagerMarkdown, localAttachmentCount: _localAttachmentCount, ...message } = withoutLocalSendOwner(withoutResponseItem(withoutRawAssistantText(source)));
      return { ...message, parts: message.parts.map(sanitizePart) };
    });
}
function byteSize(record: Omit<StoredRecord, "bytes">): number {
  try {
    return JSON.stringify(record).length * 2;
  } catch {
    return 0;
  }
}
function compact(
  records: readonly RecordMeta[],
  now: number,
  namespace: string,
): RecordMeta[] {
  let kept = records
    .filter((record) => now - record.savedAt <= TTL_MS)
    .sort((a, b) => b.savedAt - a.savedAt);
  let retainedSessions = 0;
  kept = kept.filter(
    (record) =>
      record.namespace !== namespace || retainedSessions++ < MAX_SESSIONS,
  );
  let total = kept.reduce((sum, record) => sum + record.bytes, 0);
  while (total > MAX_TOTAL_BYTES && kept.length > 0) {
    const removed = kept.pop();
    if (removed) total -= removed.bytes;
  }
  return kept;
}
function metaOf(record: StoredRecord): RecordMeta {
  return {
    key: record.key,
    namespace: record.namespace,
    savedAt: record.savedAt,
    bytes: record.bytes,
  };
}
function readMetaIndex(value: unknown): RecordMeta[] | null {
  const records = (value as Partial<StoredMetaIndex> | undefined)?.records;
  if (!Array.isArray(records)) return null;
  return records.every(
    (record: RecordMeta | null) =>
      typeof record?.key === "string" && typeof record.namespace === "string",
  )
    ? records
    : null;
}
// One transaction writes the new tail and prunes. Readwrite transactions over
// this store are serialized by IndexedDB, so two views saving different
// sessions cannot drop each other's rows, and a save never rewrites a retained
// record it did not change.
//
// Pruning reads only the META_KEY index. Walking the store with a value cursor
// structured-cloned every retained tail (up to MAX_TOTAL_BYTES of message
// bodies) on every save just to read four fields. The full scan remains the
// fallback whenever the index is missing: a cache from before it existed, or
// one a delete path invalidated.
async function saveRecord(
  next: StoredRecord,
  now: number,
  namespace: string,
): Promise<void> {
  const db = await openDb();
  if (!db) throw new Error(STORAGE_UNAVAILABLE);
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const fail = () => {
        // A failed structured clone must also roll back pruning. Otherwise a
        // failed save can delete valid history before the transaction commits.
        tx.abort();
        reject(new Error(WRITE_FAILED));
      };
      // `stored` is in the store's key order (the index is kept sorted).
      const prune = (stored: readonly RecordMeta[]) => {
        // Newest first, then the store's own key order. Array#sort is stable, so
        // rows sharing a savedAt keep this retention order.
        const scanned = [metaOf(next), ...stored.filter((record) => record.key !== next.key)];
        const kept = compact(scanned, now, namespace);
        const retained = new Set(kept.map((record) => record.key));
        for (const record of scanned)
          if (!retained.has(record.key)) store.delete(record.key);
        // A tail larger than the whole budget is pruned by the same pass that
        // wrote it: an evicted record is never written back.
        if (retained.has(next.key)) store.put(next);
        const records = kept.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const index: StoredMetaIndex = { key: META_KEY, records };
        store.put(index);
      };
      const request = store.get(META_KEY);
      request.onsuccess = () => {
        try {
          const known = readMetaIndex(request.result);
          if (known) {
            prune(known);
            return;
          }
          const scanned: RecordMeta[] = [];
          const scan = store.openCursor();
          scan.onsuccess = () => {
            try {
              const cursor = scan.result;
              if (cursor) {
                const record = cursor.value as StoredRecord | undefined;
                if (record && record.key !== META_KEY) scanned.push(metaOf(record));
                cursor.continue();
                return;
              }
              prune(scanned);
            } catch {
              fail();
            }
          };
        } catch {
          fail();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(WRITE_FAILED));
      tx.onabort = () => reject(new Error(WRITE_ABORTED));
    } catch {
      reject(new Error(WRITE_FAILED));
    }
  });
}
function sanitizeContextBoundary(value: unknown): UiContextBoundary | null | undefined {
  if (value === null) return null;
  if (!isJsonObject(value) || typeof value.entryId !== "string" || !value.entryId || value.entryId.length > 256
    || typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
  const tokens = typeof value.tokens === "number" && Number.isSafeInteger(value.tokens) && value.tokens >= 0
    ? value.tokens : undefined;
  return { entryId: value.entryId, at: value.at, ...(tokens !== undefined ? { tokens } : {}) };
}

async function writeTail(
  sessionPath: string,
  messages: readonly UiMessage[],
  scope: string,
  contextBoundary?: UiContextBoundary | null,
): Promise<void> {
  try {
    const now = Date.now();
    const partial: Omit<StoredRecord, "bytes"> = {
      key: recordKey(sessionPath, scope),
      namespace: scope,
      sessionPath,
      messages: sanitizeMessages(messages),
      ...(contextBoundary !== undefined ? { contextBoundary } : {}),
      savedAt: now,
    };
    await saveRecord({ ...partial, bytes: byteSize(partial) }, now, scope);
  } catch {
    /* history never blocks a live session */
  }
}
// The controller saves the tail on every `entries` frame, and each write
// sanitizes 50 messages, stringifies them to size the record and runs a
// readwrite transaction. Per tail, a save with no write in the last
// TAIL_WRITE_INTERVAL_MS writes at once (so a single save, like the one after
// an open, still lands immediately); later saves coalesce into one trailing
// write of the newest messages. The cache only exists for a cold reopen, so a
// pending write lands as soon as the page is hidden or unloaded, and before a
// loadTail of the same tail reads the store.
interface PendingTail {
  sessionPath: string;
  messages: readonly UiMessage[];
  contextBoundary?: UiContextBoundary | null;
  settled: Array<() => void>;
  timer: ReturnType<typeof setTimeout>;
}
interface TailWriter {
  scope: string;
  startedAt: number;
  pending: PendingTail | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}
const tailWriters = new Map<string, TailWriter>();
let flushOnHideInstalled = false;
function cancelIdleTailWriter(writer: TailWriter): void {
  if (writer.idleTimer !== null) clearTimeout(writer.idleTimer);
  writer.idleTimer = null;
}
// Retain only the current coalescing window, not every session ever visited.
// The identity and timer checks fence clearing/replacement and a newer window.
function scheduleIdleTailWriter(key: string, writer: TailWriter): void {
  cancelIdleTailWriter(writer);
  const timer = setTimeout(() => {
    if (writer.idleTimer !== timer) return;
    writer.idleTimer = null;
    if (tailWriters.get(key) === writer && !writer.pending) tailWriters.delete(key);
  }, TAIL_WRITE_INTERVAL_MS);
  writer.idleTimer = timer;
}
function startPendingTail(writer: TailWriter): Promise<void> | null {
  const write = writer.pending;
  if (!write) return null;
  clearTimeout(write.timer);
  writer.pending = null;
  writer.startedAt = Date.now();
  scheduleIdleTailWriter(recordKey(write.sessionPath, writer.scope), writer);
  const done = writeTail(write.sessionPath, write.messages, writer.scope, write.contextBoundary);
  void done.then(() => {
    for (const settle of write.settled) settle();
  });
  return done;
}
function flushPendingTails(): void {
  for (const writer of tailWriters.values()) void startPendingTail(writer);
}
// A cleared tail must not be resurrected by a write still waiting to land.
function cancelPendingTail(key: string): void {
  const writer = tailWriters.get(key);
  if (!writer) return;
  cancelIdleTailWriter(writer);
  if (writer.pending) {
    clearTimeout(writer.pending.timer);
    for (const settle of writer.pending.settled) settle();
  }
  tailWriters.delete(key);
}
function flushPendingTailsOnHide(): void {
  if (flushOnHideInstalled || typeof document === "undefined" || typeof window === "undefined")
    return;
  flushOnHideInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingTails();
  });
  window.addEventListener("pagehide", flushPendingTails);
}
// Resolves once the write carrying these messages (or a newer save of the
// same tail) has landed or failed, or the tail was cleared. Never rejects.
export async function saveTail(
  sessionPath: string,
  messages: readonly UiMessage[],
  namespace?: string,
  contextBoundary?: UiContextBoundary | null,
): Promise<void> {
  const scope = scopeOf(namespace);
  const boundary = sanitizeContextBoundary(contextBoundary);
  if (!sessionPath) return;
  const key = recordKey(sessionPath, scope);
  const now = Date.now();
  const writer = tailWriters.get(key);
  if (!writer) {
    const next: TailWriter = { scope, startedAt: now, pending: null, idleTimer: null };
    tailWriters.set(key, next);
    scheduleIdleTailWriter(key, next);
    return writeTail(sessionPath, messages, scope, boundary);
  }
  if (!writer.pending && now - writer.startedAt >= TAIL_WRITE_INTERVAL_MS) {
    writer.startedAt = now;
    scheduleIdleTailWriter(key, writer);
    return writeTail(sessionPath, messages, scope, boundary);
  }
  return new Promise<void>((resolve) => {
    if (writer.pending) {
      writer.pending.messages = messages;
      writer.pending.contextBoundary = boundary;
      writer.pending.settled.push(resolve);
      return;
    }
    cancelIdleTailWriter(writer);
    writer.pending = {
      sessionPath,
      messages,
      contextBoundary: boundary,
      settled: [resolve],
      timer: setTimeout(() => void startPendingTail(writer), TAIL_WRITE_INTERVAL_MS),
    };
    flushPendingTailsOnHide();
  });
}
export async function loadTail(
  sessionPath: string,
  namespace?: string,
): Promise<CachedTail | null> {
  const scope = scopeOf(namespace);
  if (!sessionPath) return null;
  const key = recordKey(sessionPath, scope);
  try {
    const writer = tailWriters.get(key);
    const flushed = writer ? startPendingTail(writer) : null;
    if (flushed) await flushed;
    const record = await getRecord(key);
    if (!record || !Array.isArray(record.messages)) return null;
    const age = Date.now() - record.savedAt;
    if (age > TTL_MS) {
      await deleteExpiredRecord(record.key, record.savedAt);
      return null;
    }
    const contextBoundary = sanitizeContextBoundary(record.contextBoundary);
    return {
      // Older clients cached internal deliveries as assistant replies; never
      // repaint them while waiting for correctly normalised history.
      messages: reviveDates(record.messages.filter((message) => !isActivityOnlyCustomMessageType(message.customType))),
      savedAt: record.savedAt,
      stale: age > 0,
      ...(contextBoundary !== undefined ? { contextBoundary } : {}),
    };
  } catch {
    return null;
  }
}
// The listing polls every few seconds and a 304 hands back the very same page
// arrays, so this skips rewriting an unchanged snapshot. Length is part of the
// identity because the controller may append older rows to its page array.
// A periodic rewrite keeps savedAt (the "refreshed" age shown after a cold
// open) and the TTL honest while the listing stays unchanged.
interface SessionListWrite {
  sessions: readonly OmpSessionSummary[];
  sessionCount: number;
  projects: readonly OmpProjectSummary[] | undefined;
  projectCount: number | undefined;
  savedAt: number;
}
const lastSessionListWrite = new Map<string, SessionListWrite>();
export async function saveSessionList(
  sessions: readonly OmpSessionSummary[],
  namespace?: string,
  projects?: readonly OmpProjectSummary[],
): Promise<void> {
  const scope = scopeOf(namespace);
  const savedAt = Date.now();
  const last = lastSessionListWrite.get(scope);
  if (
    last &&
    last.sessions === sessions &&
    last.sessionCount === sessions.length &&
    last.projects === projects &&
    last.projectCount === projects?.length &&
    savedAt - last.savedAt < SESSION_LIST_REWRITE_MS
  )
    return;
  const remember = () =>
    lastSessionListWrite.set(scope, {
      sessions,
      sessionCount: sessions.length,
      projects,
      projectCount: projects?.length,
      savedAt,
    });
  try {
    const bounded = sessions.slice(0, MAX_SESSION_LIST_ROWS);
    const partial: Omit<StoredSessionList, "bytes"> = {
      key: sessionListKey(scope),
      namespace: scope,
      sessions: [],
      projects: projects ? [...projects] : undefined,
      savedAt,
    };
    // Size the record once: the serialized list is the empty record plus each
    // row and the commas between them. Re-stringifying all rows per dropped row
    // was quadratic. A row that cannot serialize ends the list there, exactly
    // where dropping rows from the end used to reach a serializable record.
    let chars: number;
    try {
      chars = JSON.stringify({ ...partial, bytes: MAX_SESSION_LIST_BYTES }).length;
    } catch {
      remember();
      return;
    }
    const rowChars: number[] = [];
    for (const row of bounded) {
      try {
        rowChars.push((JSON.stringify(row) ?? "null").length);
      } catch {
        break;
      }
    }
    let count = rowChars.length;
    for (const size of rowChars) chars += size;
    if (count > 1) chars += count - 1;
    while (chars * 2 >= MAX_SESSION_LIST_BYTES && count > 0) {
      count--;
      chars -= rowChars[count] + (count > 0 ? 1 : 0);
    }
    const bytes = chars * 2;
    // Do not replace a useful snapshot with an empty one just because a row is
    // too large to fit inside the on-device cache budget.
    if ((sessions.length > 0 && count === 0) || bytes >= MAX_SESSION_LIST_BYTES) {
      remember();
      return;
    }
    await putSessionListRecord({ ...partial, sessions: bounded.slice(0, count), bytes });
    remember();
  } catch {
    /* The session list remains usable when its small offline cache cannot be written. */
  }
}
export async function loadSessionList(
  namespace?: string,
): Promise<CachedSessionList | null> {
  const scope = scopeOf(namespace);
  try {
    const record = await getSessionListRecord(scope);
    if (
      !record ||
      record.key !== sessionListKey(scope) ||
      record.namespace !== scope ||
      !Array.isArray(record.sessions) ||
      !Number.isFinite(record.savedAt)
    )
      return null;
    if (Date.now() - record.savedAt > TTL_MS) {
      await clearSessionList(scope);
      return null;
    }
    return {
      sessions: record.sessions.slice(0, MAX_SESSION_LIST_ROWS),
      projects: Array.isArray(record.projects) ? record.projects : undefined,
      savedAt: record.savedAt,
    };
  } catch {
    return null;
  }
}
export async function clearSessionList(namespace?: string): Promise<void> {
  const scope = scopeOf(namespace);
  lastSessionListWrite.delete(scope);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(SESSION_STORE_NAME, "readwrite");
      tx.objectStore(SESSION_STORE_NAME).delete(sessionListKey(scope));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("offline session cache clear failed"));
      tx.onabort = () => reject(new Error("offline session cache clear aborted"));
    } catch {
      reject(new Error("offline session cache clear failed"));
    }
  });
}
export async function clearTail(
  sessionPath: string,
  namespace?: string,
): Promise<void> {
  const scope = scopeOf(namespace);
  if (!sessionPath) return;
  const key = recordKey(sessionPath, scope);
  cancelPendingTail(key);
  await deleteRecord(key);
}
export async function clearAllCachedHistory(namespace?: string): Promise<void> {
  const scope = scopeOf(namespace);
  for (const [key, writer] of tailWriters)
    if (writer.scope === scope) cancelPendingTail(key);
  await Promise.all([deleteNamespaceRecords(scope), clearSessionList(scope)]);
}
export async function clearOfflineHistory(namespace?: string): Promise<void> {
  await clearAllCachedHistory(namespace);
}
export const clearCachedHistory = clearAllCachedHistory;
