import { saveBlob } from "../platform/native-shell";
import { ReceiptValidationError, validateBoundReceiptResponse } from "./command-receipt";
import type { CommandReceipt, CommandReceiptState, ReceiptResponse } from "./api-types";
import { usesNativeOutbox, nativeOutboxRequest, nativeSaveAttempt, NativeOutboxError, subscribeNativeOutboxChanges, nativeChangeEventsSupported } from "./native-outbox";
import { startVisibleInterval } from "./visible-interval";
import { getLinkState, subscribeLink } from "./link-state";
import { isPromptDelivery, type PromptDelivery } from "../domain/send-mode";
import { readExtensionDraftsForPairingRepair } from "./extension-feedback";

const STORAGE_PREFIX = "omp-pulse-queue-v3:";
const LEGACY_STORAGE_KEY = "omp-pulse-queue-v2";
const DB_NAME = "omp-pulse-outbox";
const DB_VERSION = 5;
const QUEUE_STORE = "commands-v3";
const LEGACY_QUEUE_STORE = "commands";
const DRAFT_STORE = "draft-attachments-v3";
const LEGACY_DRAFT_STORE = "draft-attachments";
const REPAIR_STORE = "pairing-recovery";
const REPAIR_ROWS = "pairing-recovery-rows";
const REPAIR_CHUNKS = "pairing-recovery-chunks";
const MAX_QUEUE = 50;
const MAX_BYTES = 32 * 1024 * 1024;
const DISPATCH_LEASE_MS = 60_000;
// Local persistence must never leave Send spinning behind a suspended WebView.
const STORAGE_WAIT_MS = 10_000;
// Slowest uplink the dispatch deadline still waits out (weak 3G), so a photo
// that is merely slow to upload is not cut off mid-body.
const DISPATCH_UPLOAD_BYTES_PER_SECOND = 32 * 1024;
const RETAIN_TERMINAL_MS = 24 * 60 * 60 * 1000;
const attachmentFlushers = new Set<() => Promise<void>>();

export function registerDraftAttachmentFlusher(
  flush: () => Promise<void>,
): () => void {
  attachmentFlushers.add(flush);
  return () => attachmentFlushers.delete(flush);
}
export async function flushDraftAttachmentWrites(): Promise<void> {
  await Promise.all(Array.from(attachmentFlushers, (flush) => flush()));
}

export interface QueuedImage {
  data: string;
  mimeType: string;
}
export interface QueuedPrompt {
  /** Stable command identifier. `id` remains for existing UI consumers. */
  id: string;
  commandId: string;
  sessionPath: string;
  text: string;
  imageCount: number;
  imageBytes: number;
  droppedImages: boolean;
  createdAt: number;
  updatedAt: number;
  state: CommandReceiptState;
  receipt?: CommandReceipt;
  receiptBinding?: unknown;
  /** Browser row incarnation; legacy/native rows are deliberately not backfilled. */
  intentToken?: string;
  error?: string;
  /** Durable reservation: editing must finish before any dispatcher can claim it. */
  editToken?: string;
  /** Mid-turn send mode chosen at send time; replays carry it unchanged. */
  delivery?: PromptDelivery;
}
export interface DraftAttachment {
  data: string;
  mimeType: string;
  previewUrl: string;
  name: string;
  /** Stable outbox transfer identity, retained across reservation retries. */
  recoveryId?: string;
  width?: number;
  height?: number;
}
export class QueueCapacityError extends Error {
  override name = "QueueCapacityError";
  code = "offline_outbox_full" as const;
}
export class QueueStorageError extends Error {
  override name = "QueueStorageError";
  code = "offline_outbox_unavailable" as const;
}
export class UncertainDeliveryError extends Error {
  override name = "UncertainDeliveryError";
}
/** Failure before the HTTP handoff: intent is still safe to send later. */
export class UndispatchedError extends Error {
  override name = "UndispatchedError";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

type EnqueueInput = {
  sessionPath: string;
  text: string;
  images?: readonly QueuedImage[];
  commandId?: string;
  namespace?: string;
  delivery?: PromptDelivery;
};
type StoredCommand = QueuedPrompt & {
  images: QueuedImage[];
  namespace: string;
  storageKey: string;
};
type StoredDraft = {
  sessionPath: string;
  images: DraftAttachment[];
  updatedAt: number;
  namespace: string;
  storageKey: string;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;
let openConnection: IDBDatabase | null = null;
let hydration: Promise<void> | null = null;
let hydrationNamespace: string | null = null;
let hydrated = false;
let cachedRaw: string | null | undefined;
const EMPTY_ENTRIES: QueuedPrompt[] = [];
let cachedEntries: QueuedPrompt[] = [];
const queueListeners = new Set<() => void>();
let localMutation: Promise<unknown> = Promise.resolve();
let localDrain: Promise<unknown> = Promise.resolve();
let channel: BroadcastChannel | null = null;
let activeNamespace = "anonymous";
let namespaceEpoch = 0;

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  // Pad only the final partial block. Copying the whole message into a padded
  // buffer duplicated every attached image's base64 once more on native sends
  // (the fingerprint input carries the images), at the moment memory peaks.
  const fullLength = bytes.length - (bytes.length % 64);
  const tail = new Uint8Array(Math.ceil((bytes.length - fullLength + 9) / 64) * 64);
  tail.set(bytes.subarray(fullLength));
  tail[bytes.length - fullLength] = 0x80;
  const tailView = new DataView(tail.buffer);
  tailView.setUint32(tail.length - 4, bitLength >>> 0, false);
  const bodyView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const paddedLength = fullLength + tail.length;
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a;
  let h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    const view = offset < fullLength ? bodyView : tailView;
    const base = offset < fullLength ? offset : offset - fullLength;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(base + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15],
        y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      hh = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + k[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + hh) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");
}
export function offlineQueueNamespaceForCredential(credential: string): string {
  return credential ? `cred-${sha256Hex(credential)}` : "anonymous";
}
export function setOfflineQueueNamespace(namespace: string): void {
  const next = namespace || "anonymous";
  if (next === activeNamespace) return;
  activeNamespace = next;
  namespaceEpoch++;
  hydrated = false;
  hydrationNamespace = null;
  cachedRaw = undefined;
  cachedEntries = [];
  emitQueueChange();
  nativeRefreshNeeded = false;
  nativeChangeVersion++;
  syncNativePoll();
  void ensureHydrated(next).catch(() => undefined);
}
export function getOfflineQueueNamespace(): string {
  return activeNamespace;
}
function scopeOf(namespace?: string): string {
  return namespace || activeNamespace;
}
function storageKey(namespace: string): string {
  return `${STORAGE_PREFIX}${namespace}`;
}
function commandKey(namespace: string, commandId: string): string {
  return `${namespace}:${commandId}`;
}
function draftKey(namespace: string, sessionPath: string): string {
  return `${namespace}:${sessionPath}`;
}
function emitQueueChange(): void {
  for (const callback of queueListeners) callback();
}
function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
export const makeCommandId = makeId;
function isTerminal(state: CommandReceiptState): boolean {
  return state === "forwarded" || state === "completed" || state === "failed";
}
function estimateImages(images: readonly QueuedImage[]): number {
  return images.reduce((bytes, image) => bytes + image.data.length, 0);
}
/**
 * How long one dispatch may go unanswered before it is presumed lost: the
 * lease, plus the time the payload takes to upload on a weak link.
 */
function dispatchDeadlineMs(record: QueuedPrompt): number {
  const bytes = record.text.length * 2 + record.imageBytes;
  return (
    DISPATCH_LEASE_MS +
    Math.ceil((bytes * 1000) / DISPATCH_UPLOAD_BYTES_PER_SECOND)
  );
}
function toPublic(record: QueuedPrompt | StoredCommand): QueuedPrompt {
  if (!("images" in record)) return record;
  const {
    images: _images,
    namespace: _namespace,
    storageKey: _storageKey,
    ...entry
  } = record;
  return entry;
}

function parseFallback(raw: string | null, namespace: string, strict = false): StoredCommand[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      if (strict) throw new Error("Invalid saved send metadata");
      return [];
    }
    return parsed.flatMap((value): StoredCommand[] => {
      if (!value || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const id =
        typeof record.commandId === "string"
          ? record.commandId
          : typeof record.id === "string"
            ? record.id
            : "";
      const sessionPath =
        typeof record.sessionPath === "string" ? record.sessionPath : "";
      if (!id || !sessionPath) return [];
      const now = Date.now();
      const state =
        typeof record.state === "string"
          ? (record.state as CommandReceiptState)
          : "saved";
      return [
        {
          id,
          commandId: id,
          sessionPath,
          text: typeof record.text === "string" ? record.text : "",
          images: [],
          imageCount: Number(record.imageCount) || 0,
          imageBytes: Number(record.imageBytes) || 0,
          droppedImages:
            Boolean(record.droppedImages) || Number(record.imageCount) > 0,
          createdAt: Number(record.createdAt) || now,
          updatedAt: Number(record.updatedAt) || now,
          state,
          receipt: record.receipt as CommandReceipt | undefined,
          receiptBinding: record.receiptBinding,
          intentToken: typeof record.intentToken === "string" ? record.intentToken : undefined,
          editToken: typeof record.editToken === "string" ? record.editToken : undefined,
          error: typeof record.error === "string" ? record.error : undefined,
          delivery: isPromptDelivery(record.delivery) ? record.delivery : undefined,
          namespace,
          storageKey: commandKey(namespace, id),
        },
      ];
    });
  } catch {
    if (strict) throw new QueueStorageError("Saved send metadata couldn't be read. Retry when device storage is available.");
    return [];
  }
}
function refreshSnapshot(records: readonly QueuedPrompt[]): void {
  const next = records
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(toPublic);
  const raw = JSON.stringify(next);
  if (raw === cachedRaw) return;
  // A local committed save also supersedes any older in-flight listing.
  nativeSnapshotGeneration++;
  cachedRaw = raw;
  cachedEntries = next;
  emitQueueChange();
  syncNativePoll();
}
let nativeRefresh: Promise<void> | null = null;
let nativeSnapshotGeneration = 0;
let nativeChangeVersion = 0;
let nativeRefreshNeeded = false;
let nativeRefreshAgain = false;
const nativeMigrations = new Map<string, Promise<void>>();

async function refreshNativeSnapshot(namespace = activeNamespace): Promise<void> {
  if (namespace === "anonymous") return;
  const epoch = namespaceEpoch;
  const generation = namespace === activeNamespace ? ++nativeSnapshotGeneration : nativeSnapshotGeneration;
  const changeVersion = nativeChangeVersion;
  const entries = await nativeOutboxRequest<QueuedPrompt[]>("list", namespace);
  if (epoch === namespaceEpoch && namespace === activeNamespace && generation === nativeSnapshotGeneration) {
    refreshSnapshot(entries);
    hydrated = true;
    hydrationNamespace = namespace;
    if (changeVersion === nativeChangeVersion) nativeRefreshNeeded = false;
    // Even an unchanged snapshot can confirm a pushing APK or settle a retry.
    syncNativePoll();
  }
}

function migrateNativeQueue(namespace: string): Promise<void> {
  const pending = nativeMigrations.get(namespace);
  if (pending) return pending;
  const run = (async () => {
    // Old Web Locks can be owned by a suspended view. Migration reads storage
    // directly; new native saves never wait for this legacy import.
    const records = await readAllRecords(namespace);
    for (const command of records) {
      await nativeOutboxRequest<QueuedPrompt | null>("import", namespace, { command });
      const db = await openDb();
      if (db) {
        await withStore(db, QUEUE_STORE, "readwrite", (store) => store.delete(commandKey(namespace, command.commandId)));
      } else {
        const remaining = (await readAllRecords(namespace)).filter((entry) => entry.commandId !== command.commandId);
        await replaceRecords(remaining, namespace);
      }
    }
    await refreshNativeSnapshot(namespace);
  })().catch((error: unknown) => {
    nativeMigrations.delete(namespace);
    throw error;
  });
  nativeMigrations.set(namespace, run);
  return run;
}

function refreshVisibleNativeQueue(): void {
  if (!usesNativeOutbox() || activeNamespace === "anonymous") return;
  nativeRefreshNeeded = true;
  nativeChangeVersion++;
  syncNativePoll();
  if (document.visibilityState === "hidden") return;
  // A hint may postdate what the pending listing read; keep one trailing read.
  if (nativeRefresh) { nativeRefreshAgain = true; return; }
  const namespace = activeNamespace;
  nativeRefresh = refreshNativeSnapshot(namespace).catch(() => undefined).finally(() => {
    nativeRefresh = null;
    if (!nativeRefreshAgain) return;
    nativeRefreshAgain = false;
    refreshVisibleNativeQueue();
  });
  void migrateNativeQueue(namespace).catch(() => undefined);
}

// A current APK pushes changes, but unfinished rows and failed/missed refreshes
// still keep a visible-only safety poll. Settled rows need no timer. Older APKs
// never advertise changeEvents: keep their 1 s pending / 5 s idle cadence.
const NATIVE_FALLBACK_POLL_MS = 30_000;
let nativePoll: { ms: number; stop: () => void } | null = null;
function syncNativePoll(): void {
  let ms: number | null = null;
  if (usesNativeOutbox() && activeNamespace !== "anonymous") {
    const unfinished = cachedEntries.some((entry) => !isTerminal(entry.state));
    const unsettled = !hydrated || hydrationNamespace !== activeNamespace || nativeRefreshNeeded;
    if (nativeChangeEventsSupported()) ms = unfinished || unsettled ? NATIVE_FALLBACK_POLL_MS : null;
    else ms = unfinished || unsettled ? 1_000 : 5_000;
  }
  if ((nativePoll?.ms ?? null) === ms) return;
  nativePoll?.stop();
  nativePoll = ms === null ? null : { ms, stop: startVisibleInterval(refreshVisibleNativeQueue, ms) };
}

function ensureChannel(): void {
  if (usesNativeOutbox()) return;
  if (channel || typeof BroadcastChannel === "undefined") return;
  try {
    channel = new BroadcastChannel("omp-pulse-outbox");
    channel.onmessage = () => {
      void hydrateFromStorage(activeNamespace).catch(() => undefined);
    };
  } catch {
    channel = null;
  }
}
function announce(namespace = activeNamespace): void {
  ensureChannel();
  try {
    channel?.postMessage({ namespace, changedAt: Date.now() });
  } catch {
    /* storage event remains a fallback */
  }
}

function discardConnection(db: IDBDatabase): void {
  db.close();
  if (openConnection === db) {
    openConnection = null;
    dbPromise = null;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase | null>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new QueueStorageError(message));
    };
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      timer = setTimeout(
        () => fail("Local storage did not respond. Your draft was kept. Try again."),
        STORAGE_WAIT_MS,
      );
      request.onblocked = () => fail(
        "Another app window is blocking local storage. Close it and try again. Your draft was kept.",
      );
      request.onupgradeneeded = () => {
        // IDB opens cannot be cancelled. A rejected attempt must never migrate
        // or keep a connection alive when its blocker eventually disappears.
        if (settled) {
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        const tx = request.transaction;
        if (!db.objectStoreNames.contains(QUEUE_STORE))
          db.createObjectStore(QUEUE_STORE, { keyPath: "storageKey" });
        if (!db.objectStoreNames.contains(DRAFT_STORE))
          db.createObjectStore(DRAFT_STORE, { keyPath: "storageKey" });
        if (!db.objectStoreNames.contains(REPAIR_STORE))
          db.createObjectStore(REPAIR_STORE, { keyPath: "key" });
        if (!db.objectStoreNames.contains(REPAIR_ROWS))
          db.createObjectStore(REPAIR_ROWS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(REPAIR_CHUNKS))
          db.createObjectStore(REPAIR_CHUNKS, { keyPath: "key" });
        if (tx && db.objectStoreNames.contains(LEGACY_QUEUE_STORE)) {
          const source = tx.objectStore(LEGACY_QUEUE_STORE),
            target = tx.objectStore(QUEUE_STORE);
          source.openCursor().onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue>)
              .result;
            if (!cursor) return;
            const value = cursor.value as Record<string, unknown>;
            const id =
              typeof value.commandId === "string"
                ? value.commandId
                : typeof value.id === "string"
                  ? value.id
                  : "";
            if (id)
              target.put({
                ...value,
                id,
                commandId: id,
                namespace: "legacy",
                storageKey: commandKey("legacy", id),
                images: Array.isArray(value.images) ? value.images : [],
              });
            cursor.continue();
          };
        }
        if (tx && db.objectStoreNames.contains(LEGACY_DRAFT_STORE)) {
          const source = tx.objectStore(LEGACY_DRAFT_STORE),
            target = tx.objectStore(DRAFT_STORE);
          source.openCursor().onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue>)
              .result;
            if (!cursor) return;
            const value = cursor.value as Record<string, unknown>;
            const sessionPath =
              typeof value.sessionPath === "string" ? value.sessionPath : "";
            if (sessionPath)
              target.put({
                ...value,
                namespace: "legacy",
                storageKey: draftKey("legacy", sessionPath),
              });
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        openConnection = db;
        db.onversionchange = () => discardConnection(db);
        db.onclose = () => discardConnection(db);
        resolve(db);
      };
      request.onerror = () => fail("Local storage is unavailable. Your draft was kept. Try again.");
    } catch {
      fail("Local storage is unavailable. Your draft was kept. Try again.");
    }
  });
  dbPromise = opening;
  void opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

function withStore<T = void>(
  db: IDBDatabase,
  name: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(name, mode);
    } catch {
      discardConnection(db);
      reject(new QueueStorageError("Local storage closed. Your draft was kept. Try again."));
      return;
    }
    const fail = (message: string) => {
      clearTimeout(timer);
      discardConnection(db);
      reject(new QueueStorageError(message));
    };
    const timer = setTimeout(() => {
      try {
        // Abort before rejecting: a plain Promise.race could commit a late
        // write after Composer restored the draft, duplicating the next send.
        tx.abort();
      } catch {
        // Already committed/aborted; its queued terminal event owns the result.
        return;
      }
      fail("Local storage did not respond. Your draft was kept. Try again.");
    }, STORAGE_WAIT_MS);
    tx.onabort = () => fail("Local storage could not save the change. Your draft was kept. Try again.");
    try {
      const request = operation(tx.objectStore(name));
      tx.oncomplete = () => {
        clearTimeout(timer);
        resolve(request ? request.result : undefined as T);
      };
    } catch {
      tx.abort();
      fail("Local storage could not save the change. Your draft was kept. Try again.");
    }
  });
}
async function readAllRecords(
  namespace = activeNamespace,
): Promise<StoredCommand[]> {
  const db = await openDb();
  if (!db) {
    try {
      return parseFallback(
        localStorage.getItem(storageKey(namespace)),
        namespace,
      );
    } catch {
      throw new QueueStorageError("Offline outbox storage is unavailable");
    }
  }
  const records = await withStore<StoredCommand[]>(db, QUEUE_STORE, "readonly", (store) => store.getAll());
  return records.filter((entry) => entry?.namespace === namespace);
}
async function readRecord(
  commandId: string,
  namespace = activeNamespace,
): Promise<StoredCommand | null> {
  const db = await openDb();
  if (!db) {
    try {
      return (
        parseFallback(
          localStorage.getItem(storageKey(namespace)),
          namespace,
        ).find((entry) => entry.commandId === commandId) ?? null
      );
    } catch {
      throw new QueueStorageError("Offline outbox storage is unavailable");
    }
  }
  const record = await withStore<StoredCommand | undefined>(db, QUEUE_STORE, "readonly", (store) => store.get(commandKey(namespace, commandId)));
  return record?.namespace === namespace ? record : null;
}
function normalizedCommand(
  record: StoredCommand,
  namespace: string,
): StoredCommand {
  return {
    ...record,
    namespace,
    storageKey: commandKey(namespace, record.commandId),
  };
}
function assertEditsFinished(records: readonly QueuedPrompt[], sessionPath: string): void {
  if (records.some(record => record.sessionPath === sessionPath && record.editToken)) {
    throw new QueueStorageError("Finish recovering the saved message before sending. Choose Edit again to finish, or cancel the saved message.");
  }
}

/** The source reservation outlives draft recovery and survives reloads. Read
 * browser storage before native storage so migration cannot hide it in between. */
export async function assertNoPendingEdit(sessionPath: string, namespace: string): Promise<void> {
  assertEditsFinished(await readAllRecords(namespace), sessionPath);
  if (usesNativeOutbox()) {
    assertEditsFinished(await nativeOutboxRequest<QueuedPrompt[]>("list", namespace), sessionPath);
  }
}

async function putRecord(
  record: StoredCommand,
  namespace = activeNamespace,
  newSend = false,
): Promise<void> {
  const next = normalizedCommand(record, namespace);
  const db = await openDb();
  if (!db) {
    try {
      const current = parseFallback(localStorage.getItem(storageKey(namespace)), namespace);
      if (newSend) assertEditsFinished(current, next.sessionPath);
      const records = current.filter((entry) => entry.commandId !== next.commandId);
      records.push(next);
      localStorage.setItem(storageKey(namespace), JSON.stringify(records));
      return;
    } catch (error) {
      if (error instanceof QueueStorageError) throw error;
      throw new QueueStorageError(
        "Offline outbox storage is unavailable or full",
      );
    }
  }
  let failure: unknown;
  await withStore(db, QUEUE_STORE, "readwrite", (store) => {
    if (!newSend) { store.put(next); return; }
    const request = store.getAll();
    request.onsuccess = () => {
      try {
        assertEditsFinished(request.result.filter((entry: StoredCommand) => entry.namespace === namespace), next.sessionPath);
        store.put(next);
      } catch (error) { failure = error; }
    };
  });
  if (failure) throw failure;
}
async function replaceRecords(
  records: readonly StoredCommand[],
  namespace = activeNamespace,
): Promise<void> {
  const db = await openDb();
  if (!db) {
    try {
      localStorage.setItem(
        storageKey(namespace),
        JSON.stringify(
          records.map((record) => normalizedCommand(record, namespace)),
        ),
      );
      return;
    } catch {
      throw new QueueStorageError(
        "Offline outbox storage is unavailable or full",
      );
    }
  }
  await withStore(db, QUEUE_STORE, "readwrite", (store) => {
    const request = store.getAll();
    request.onsuccess = () => {
      for (const old of request.result as StoredCommand[])
        if (old?.namespace === namespace) store.delete(old.storageKey);
      for (const record of records)
        store.put(normalizedCommand(record, namespace));
    };
  });
}
function dispatchExpired(record: QueuedPrompt, now: number): boolean {
  return record.state === "dispatching" && now > record.updatedAt + dispatchDeadlineMs(record);
}

/** Caller owns mutation exclusion. Recheck the lease and witness in each row's
 * transaction: a hydration snapshot must never overwrite another tab's receipt. */
async function maintainRecords(
  expected: readonly QueuedPrompt[],
  scope: string,
  isCurrent: () => boolean,
  pruneTerminal = false,
): Promise<void> {
  let changed = false;
  try {
    for (const entry of expected) {
      if (!isCurrent()) break;
      const now = Date.now();
      const prune = pruneTerminal && isTerminal(entry.state) && now - entry.updatedAt > RETAIN_TERMINAL_MS;
      if (!prune && !dispatchExpired(entry, now)) continue;
      const mutation = await mutateCurrentIntent(entry, current => {
        if (current.state !== entry.state || current.updatedAt !== entry.updatedAt ||
          !sameReceiptEvidence(current, entry)) return null;
        const committedAt = Date.now();
        if (prune) return isTerminal(current.state) && committedAt - current.updatedAt > RETAIN_TERMINAL_MS
          ? { remove: true } : null;
        // Expiry is local uncertainty only. Keep receipt absence, invalid-present
        // bindings, errors and payload bytes exactly as they were persisted.
        return dispatchExpired(current, committedAt)
          ? { put: { ...current, state: "uncertain", updatedAt: committedAt } } : null;
      }, scope, isCurrent);
      changed ||= mutation !== null;
    }
  } finally {
    // Read committed storage even after a partial pass or a competing writer.
    // Failed persistence must not publish the proposed uncertain state.
    const records = await readAllRecords(scope);
    if (isCurrent()) refreshSnapshot(records);
    if (changed) announce(scope);
  }
}

async function hydrateFromStorage(namespace = activeNamespace): Promise<void> {
  if (usesNativeOutbox()) {
    await refreshNativeSnapshot(namespace);
    if (namespace !== "anonymous") void migrateNativeQueue(namespace).catch(() => undefined);
    return;
  }
  const isCurrent = captureQueueScope(namespace);
  return exclusive(namespace, async () => {
    const records = await readAllRecords(namespace);
    await maintainRecords(records, namespace, isCurrent, true);
    if (!isCurrent()) return;
    hydrated = true;
    hydrationNamespace = namespace;
  });
}

/** Browser-local clock maintenance, independent of connectivity/status reads.
 * Native delivery is owned elsewhere; this operation never wakes that owner. */
export async function maintainPendingSends(
  namespace = activeNamespace,
  isCurrent = captureQueueScope(namespace),
): Promise<void> {
  if (usesNativeOutbox() || !isCurrent()) return;
  await ensureHydrated(namespace);
  if (!isCurrent()) return;
  const due = getSnapshot(namespace).filter(entry => dispatchExpired(entry, Date.now()));
  if (due.length === 0) return;
  await exclusive(namespace, () => maintainRecords(due, namespace, isCurrent));
}
async function ensureHydrated(namespace = activeNamespace): Promise<void> {
  if (hydrated && hydrationNamespace === namespace) return;
  if (!hydration || hydrationNamespace !== namespace) {
    hydrationNamespace = namespace;
    hydration = hydrateFromStorage(namespace).finally(() => {
      hydration = null;
    });
  }
  return hydration;
}
async function exclusive<T>(
  namespace: string,
  fn: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new QueueStorageError("Local storage is busy. Your draft was kept. Try again.");
      controller.abort(error);
      reject(error);
    }, STORAGE_WAIT_MS);
  });
  const acquired = () => {
    controller.signal.throwIfAborted();
    clearTimeout(timer);
    return fn();
  };
  const run = () => {
    // Covers both the local promise queue and a different/suspended WebView.
    // Cancel acquisition, never steal a held lock or time out an active write.
    controller.signal.throwIfAborted();
    if (typeof navigator !== "undefined" && navigator.locks?.request)
      return navigator.locks.request(
        `omp-pulse-outbox:${namespace}`,
        { mode: "exclusive", signal: controller.signal },
        acquired,
      );
    return acquired();
  };
  const next = localMutation.then(run, run);
  localMutation = next.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([next, expired]).finally(() => clearTimeout(timer));
}
async function drainExclusive<T>(
  namespace: string,
  fn: () => Promise<T>,
): Promise<T> {
  const run = async () => {
    if (typeof navigator !== "undefined" && navigator.locks?.request)
      return navigator.locks.request(
        `omp-pulse-outbox-drain:${namespace}`,
        { mode: "exclusive" },
        fn,
      );
    return fn();
  };
  const next = localDrain.then(run, run);
  localDrain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function subscribeQueue(callback: () => void): () => void {
  queueListeners.add(callback);
  return () => queueListeners.delete(callback);
}
export const subscribe = subscribeQueue;
export function getSnapshot(namespace?: string): QueuedPrompt[] {
  return scopeOf(namespace) === activeNamespace ? cachedEntries : EMPTY_ENTRIES;
}
export function getServerSnapshot(): QueuedPrompt[] {
  return EMPTY_ENTRIES;
}
if (typeof window !== "undefined") {
  ensureChannel();
  if (usesNativeOutbox()) {
    subscribeNativeOutboxChanges(refreshVisibleNativeQueue);
    // Every restore catches up on hints missed while hidden or before setup.
    syncNativePoll();
    document.addEventListener("visibilitychange", refreshVisibleNativeQueue);
    // Old cadence until the first reply shows whether this APK pushes.
    syncNativePoll();
  }
  window.addEventListener("storage", (event) => {
    if (
      event.key?.startsWith(STORAGE_PREFIX) ||
      event.key === LEGACY_STORAGE_KEY ||
      event.key === null
    )
      void hydrateFromStorage(activeNamespace).catch(() => undefined);
  });
  // Refresh is best-effort; explicit saves still report failures to Composer.
  void ensureHydrated().catch(() => undefined);
}

export function enqueue(input: EnqueueInput): Promise<QueuedPrompt> {
  return storeCommand(input, "saved");
}

/** Imported commands retain their IDs and must reconcile before any replay. */
export function recoverCommand(input: EnqueueInput): Promise<QueuedPrompt> {
  return storeCommand(input, "uncertain");
}

async function storeCommand(input: EnqueueInput, state: "saved" | "uncertain"): Promise<QueuedPrompt> {
  const namespace = scopeOf(input.namespace);
  if (usesNativeOutbox()) {
    if (state === "saved") await assertNoPendingEdit(input.sessionPath, namespace);
    const images = input.images ?? [];
    const commandId = input.commandId ?? nativeSaveAttempt(namespace, input.sessionPath, sha256Hex(JSON.stringify([input.text, images])));
    const command = { ...input, commandId, images, state };
    // A save can commit while its acknowledgement is stuck behind a busy
    // Android main thread. Treating that as a failed send restored the text
    // to the composer even though the message had been saved and delivered,
    // so it sat there until cleared by hand. Native enqueue is idempotent per
    // commandId (same payload returns the stored row), so asking again turns
    // "unconfirmed" into the real answer instead of a guess.
    let entry: QueuedPrompt | null | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        entry = await nativeOutboxRequest<QueuedPrompt | null>(state === "saved" ? "enqueue" : "import", namespace, { command });
        break;
      } catch (error) {
        if (!(error instanceof NativeOutboxError) || error.code !== "unconfirmed" || attempt >= 2) throw error;
      }
    }
    if (!entry) throw new QueueStorageError("This command was already dismissed; it was not resent.");
    // Persistence has committed. A later snapshot failure must never make
    // Composer restore a draft whose native sender already owns the message.
    if (namespace === activeNamespace) refreshSnapshot([...cachedEntries.filter((row) => row.commandId !== commandId), entry]);
    return entry;
  }
  await ensureHydrated(namespace);
  return exclusive(namespace, async () => {
    const records = await readAllRecords(namespace);
    if (state === "saved") assertEditsFinished(records, input.sessionPath);
    const now = Date.now();
    const retained = records.filter(
      (record) =>
        !(
          isTerminal(record.state) &&
          now - record.updatedAt > RETAIN_TERMINAL_MS
        ),
    );
    const images = (input.images ?? []).map((image) => ({
      data: image.data,
      mimeType: image.mimeType,
    }));
    const imageBytes = estimateImages(images);
    const currentBytes = retained.reduce(
      (sum, record) => sum + record.text.length * 2 + record.imageBytes,
      0,
    );
    const commandId = input.commandId ?? makeId();
    const existing = retained.find((record) => record.commandId === commandId);
    if (existing) {
      if (
        existing.sessionPath !== input.sessionPath ||
        existing.text !== input.text ||
        existing.imageBytes !== imageBytes
      )
        throw new QueueCapacityError(
          "This command ID is already used for a different request",
        );
      return toPublic(existing);
    }
    if (
      retained.filter((record) => !isTerminal(record.state)).length >= MAX_QUEUE ||
      currentBytes + input.text.length * 2 + imageBytes > MAX_BYTES
    ) throw new QueueCapacityError("Offline outbox is full. Your draft and attachments were kept.");
    const record: StoredCommand = normalizedCommand(
      {
        id: commandId,
        commandId,
        intentToken: makeId(),
        sessionPath: input.sessionPath,
        text: input.text,
        images,
        imageCount: images.length,
        imageBytes,
        droppedImages: false,
        createdAt: now,
        updatedAt: now,
        state,
        ...(input.delivery ? { delivery: input.delivery } : {}),
        receipt: undefined,
      } as StoredCommand,
      namespace,
    );
    await putRecord(record, namespace, state === "saved");
    const next = retained.filter(
      (candidate) => candidate.commandId !== commandId,
    );
    next.push(record);
    if (namespace === activeNamespace) refreshSnapshot(next);
    announce(namespace);
    return toPublic(record);
  });
}
export function pending(
  sessionPath: string,
  namespace?: string,
): QueuedPrompt[] {
  const scope = scopeOf(namespace);
  return scope === activeNamespace
    ? cachedEntries.filter(
        (entry) =>
          entry.sessionPath === sessionPath && !isTerminal(entry.state),
      )
    : [];
}
export function pendingAll(namespace?: string): QueuedPrompt[] {
  const scope = scopeOf(namespace);
  return scope === activeNamespace
    ? cachedEntries.filter((entry) => !isTerminal(entry.state))
    : [];
}
export function queuedCount(sessionPath?: string, namespace?: string): number {
  return sessionPath
    ? pending(sessionPath, namespace).length
    : pendingAll(namespace).length;
}
export async function getImages(
  commandId: string,
  namespace?: string,
): Promise<QueuedImage[]> {
  const scope = scopeOf(namespace);
  if (usesNativeOutbox()) return nativeOutboxRequest<QueuedImage[]>("images", scope, { commandId });
  await ensureHydrated(scope);
  const record = await readRecord(commandId, scope);
  return record?.images?.map((image) => ({ ...image })) ?? [];
}
export async function getQueued(
  commandId: string,
  namespace?: string,
): Promise<QueuedPrompt | null> {
  const scope = scopeOf(namespace);
  if (usesNativeOutbox()) return nativeOutboxRequest<QueuedPrompt | null>("get", scope, { commandId });
  await ensureHydrated(scope);
  const record = await readRecord(commandId, scope);
  return record ? toPublic(record) : null;
}

export interface OutboxDiagnostics {
  count: number;
  pending: number;
  bytes: number;
  oldestAt: number | null;
  states: Record<string, number>;
}
export async function update(
  commandId: string,
  patch: Partial<Pick<QueuedPrompt, "state" | "receipt" | "receiptBinding" | "error">>,
  namespace?: string,
): Promise<QueuedPrompt | null> {
  const scope = scopeOf(namespace);
  if (usesNativeOutbox()) {
    // Only the native owner reconciles receipts; a delayed WebView observation
    // must not overwrite a newer worker result.
    await nativeOutboxRequest("wake", scope);
    await refreshNativeSnapshot(scope);
    return nativeOutboxRequest<QueuedPrompt | null>("get", scope, { commandId });
  }
  await ensureHydrated(scope);
  return exclusive(scope, async () => {
    const record = await readRecord(commandId, scope);
    if (!record) return null;
    const next = normalizedCommand(
      { ...record, ...patch, updatedAt: Date.now() },
      scope,
    );
    await putRecord(next, scope);
    const records = (await readAllRecords(scope)).filter(
      (candidate) => candidate.commandId !== commandId,
    );
    records.push(next);
    if (scope === activeNamespace) refreshSnapshot(records);
    announce(scope);
    return toPublic(next);
  });
}
/** Exact local intent, distinct from mutable delivery evidence. */
export function sameQueuedIntent(a: QueuedPrompt, b: QueuedPrompt): boolean {
  return a.intentToken === b.intentToken && a.commandId === b.commandId && a.sessionPath === b.sessionPath &&
    a.createdAt === b.createdAt && a.text === b.text &&
    a.imageCount === b.imageCount && a.imageBytes === b.imageBytes &&
    a.droppedImages === b.droppedImages;
}

function sameReceiptEvidence(a: QueuedPrompt, b: QueuedPrompt): boolean {
  return JSON.stringify([a.receipt, a.receiptBinding]) === JSON.stringify([b.receipt, b.receiptBinding]);
}

/** Check again after preflight, before handing the retained payload to HTTP. */
export async function assertDispatchCurrent(
  expected: QueuedPrompt, namespace: string, isCurrent: () => boolean,
): Promise<void> {
  const current = await getQueued(expected.commandId, namespace);
  if (!isCurrent() || !current || !sameQueuedIntent(current, expected) ||
    current.state !== "dispatching" || !sameReceiptEvidence(current, expected))
    throw new UndispatchedError("Send intent changed before handoff");
}

/** Captured before I/O, so leaving and returning to a credential scope is fenced. */
export function captureQueueScope(namespace: string): () => boolean {
  const epoch = namespaceEpoch;
  return () => namespace === activeNamespace && epoch === namespaceEpoch;
}

/** Ask the native delivery owner to reconcile/retry its retained command.
 * Never enqueue a replacement or hand the payload to browser delivery. */
export async function retryNativeIntent(
  expected: QueuedPrompt, namespace: string, isCurrent: () => boolean,
): Promise<CommandReceipt | null> {
  if (!usesNativeOutbox() || !isCurrent() || expected.editToken
    || (expected.state !== "saved" && expected.state !== "uncertain")) return null;
  const current = await getQueued(expected.commandId, namespace);
  if (!isCurrent() || !current || !sameQueuedIntent(current, expected)
    || current.state !== expected.state || current.updatedAt !== expected.updatedAt || current.editToken) return null;
  await nativeOutboxRequest("wake", namespace);
  await refreshNativeSnapshot(namespace);
  if (!isCurrent()) return null;
  const updated = getSnapshot(namespace).find(entry => sameQueuedIntent(entry, expected));
  return updated?.receipt ?? null;
}

type IntentMutation = { put: StoredCommand } | { remove: true };

/** Per-row mutation under the caller's existing exclusion. Both hydration and
 * receipt application share this transaction-level intent/incarnation fence. */
async function mutateCurrentIntent(
  expected: QueuedPrompt,
  transform: (current: StoredCommand) => IntentMutation | null,
  scope: string,
  isCurrent: () => boolean,
): Promise<IntentMutation | null> {
  let mutation: IntentMutation | null = null;
  const change = (current: StoredCommand | null | undefined) => {
    if (!isCurrent() || !current || current.namespace !== scope || !sameQueuedIntent(current, expected)) return;
    mutation = transform(current);
  };
  const db = await openDb();
  if (db) {
    let failure: unknown;
    await withStore(db, QUEUE_STORE, "readwrite", store => {
      const request = store.get(commandKey(scope, expected.commandId));
      request.onsuccess = () => {
        try {
          change(request.result);
          if (mutation && "put" in mutation) store.put(mutation.put);
          else if (mutation) store.delete(commandKey(scope, expected.commandId));
        } catch (error) { failure = error; }
      };
    });
    if (failure) throw failure;
  } else {
    // Fallback keeps the same Web Locks/local exclusion guarantees. Read and
    // conditionally write synchronously, without an await between them.
    try {
      const records = parseFallback(localStorage.getItem(storageKey(scope)), scope);
      change(records.find(entry => entry.commandId === expected.commandId));
      const applied = mutation as IntentMutation | null;
      if (applied) {
        const retained = records.filter(entry => entry.commandId !== expected.commandId);
        if ("put" in applied) retained.push(applied.put);
        localStorage.setItem(storageKey(scope), JSON.stringify(retained));
      }
    } catch (error) {
      if (error instanceof ReceiptValidationError) throw error;
      throw new QueueStorageError("Offline outbox storage is unavailable or full");
    }
  }
  return mutation;
}

async function mutateIntent(
  expected: QueuedPrompt,
  transform: (current: StoredCommand) => StoredCommand | null,
  scope: string,
  isCurrent: () => boolean,
): Promise<QueuedPrompt | null> {
  if (usesNativeOutbox()) throw new ReceiptValidationError();
  await ensureHydrated(scope);
  return exclusive(scope, async () => {
    const mutation = await mutateCurrentIntent(expected, current => {
      const next = transform(current);
      return next ? { put: next } : null;
    }, scope, isCurrent);
    if (!mutation || !("put" in mutation)) return null;
    if (scope === activeNamespace) refreshSnapshot(await readAllRecords(scope));
    announce(scope);
    return toPublic(mutation.put);
  });
}

/** Reserve before reading bytes. A failed/ambiguous transfer stays reserved and
 * resumable: neither a reload nor a background dispatcher may send its copy. */
export async function editSavedPrompt(
  expected: QueuedPrompt,
  namespace: string,
  isCurrent: () => boolean,
  transfer: (entry: QueuedPrompt, images: readonly QueuedImage[], recoveryId: string) => Promise<void>,
): Promise<boolean> {
  if (expected.state !== "saved" || !isCurrent()) return false;
  let reservation: { editToken: string; entry: QueuedPrompt; images: QueuedImage[] } | null;
  if (usesNativeOutbox()) {
    reservation = await nativeOutboxRequest("edit_begin", namespace, {
      commandId: expected.commandId, expected,
    });
    if (!reservation) return false;
    await refreshNativeSnapshot(namespace);
  } else {
    await ensureHydrated(namespace);
    reservation = await exclusive(namespace, async () => {
      const mutation = await mutateCurrentIntent(expected, current => {
        if (current.state !== "saved" || current.updatedAt !== expected.updatedAt ||
          current.editToken !== expected.editToken) return null;
        return { put: { ...current, editToken: current.editToken ?? makeId() } };
      }, namespace, isCurrent);
      if (!mutation || !("put" in mutation) || !mutation.put.editToken) return null;
      const reserved = mutation.put;
      const editToken = mutation.put.editToken;
      if (namespace === activeNamespace) refreshSnapshot(await readAllRecords(namespace));
      announce(namespace);
      return { editToken, entry: toPublic(reserved), images: reserved.images };
    });
    if (!reservation) return false;
  }
  const captured = reservation;
  if (captured.images.length !== captured.entry.imageCount || captured.entry.droppedImages)
    throw new QueueStorageError("The original photos are unavailable. The saved message has been kept.");
  const recoveryId = JSON.stringify(["outbox-edit", expected.commandId, expected.createdAt, captured.editToken]);
  await transfer(captured.entry, captured.images, recoveryId);
  // Do not roll back on error: the draft may already contain some/all bytes.
  if (usesNativeOutbox()) {
    const result = await nativeOutboxRequest<{ finished: boolean }>("edit_finish", namespace, {
      commandId: expected.commandId, editToken: captured.editToken, commit: true,
    });
    if (!result.finished) throw new QueueStorageError("Draft saved, but removal was not confirmed. Edit again to finish.");
    await refreshNativeSnapshot(namespace);
  } else {
    const finished = await exclusive(namespace, async () => {
      const mutation = await mutateCurrentIntent(expected, current =>
        current.state === "saved" && current.editToken === captured.editToken ? { remove: true } : null,
      namespace, () => true);
      if (!mutation) return await readRecord(expected.commandId, namespace) == null;
      if (namespace === activeNamespace) refreshSnapshot(await readAllRecords(namespace));
      announce(namespace);
      return true;
    });
    if (!finished) throw new QueueStorageError("Draft saved, but removal was not confirmed. Edit again to finish.");
  }
  return true;
}

/** All server status application validates against the latest durable witness. */
export async function applyReceipt(
  expected: QueuedPrompt,
  response: unknown,
  namespace?: string,
  isCurrent = captureQueueScope(scopeOf(namespace)),
): Promise<QueuedPrompt | null> {
  const scope = scopeOf(namespace);
  return mutateIntent(expected, current => {
    const { receipt, receiptBinding } = validateBoundReceiptResponse(response, current);
    return { ...current, state: receipt.state, receipt, receiptBinding,
      error: receipt.error, updatedAt: Date.now() };
  }, scope, isCurrent);
}

/** An action on a painted row cannot delete its replacement or a claim that
 * won while the user was deciding. Reservations are part of that authority. */
export async function removeIntent(
  expected: QueuedPrompt, namespace: string, isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent() || expected.state === "dispatching") return false;
  if (usesNativeOutbox()) {
    const result = await nativeOutboxRequest<{ removed: boolean }>("remove", namespace, {
      commandId: expected.commandId, expected,
    });
    await refreshNativeSnapshot(namespace);
    return result.removed;
  }
  await ensureHydrated(namespace);
  return exclusive(namespace, async () => {
    const mutation = await mutateCurrentIntent(expected, current =>
      current.state === expected.state && current.updatedAt === expected.updatedAt &&
        current.editToken === expected.editToken ? { remove: true } : null,
    namespace, isCurrent);
    if (!mutation) return false;
    if (namespace === activeNamespace) refreshSnapshot(await readAllRecords(namespace));
    announce(namespace);
    return true;
  });
}

export async function removeAsync(
  commandId: string,
  namespace?: string,
): Promise<void> {
  const scope = scopeOf(namespace);
  if (usesNativeOutbox()) {
    await nativeOutboxRequest("remove", scope, { commandId });
    await refreshNativeSnapshot(scope);
    return;
  }
  await ensureHydrated(scope);
  await exclusive(scope, async () => {
    const records = (await readAllRecords(scope)).filter(
      (record) => record.commandId !== commandId,
    );
    await replaceRecords(records, scope);
    if (scope === activeNamespace) refreshSnapshot(records);
    announce(scope);
  });
}
export async function clearAsync(
  sessionPath?: string,
  namespace?: string,
): Promise<void> {
  const scope = scopeOf(namespace);
  if (usesNativeOutbox()) {
    await nativeOutboxRequest("clear", scope, { sessionPath });
    await refreshNativeSnapshot(scope);
    return;
  }
  await ensureHydrated(scope);
  await exclusive(scope, async () => {
    const records = sessionPath
      ? (await readAllRecords(scope)).filter(
          (record) => record.sessionPath !== sessionPath,
        )
      : [];
    await replaceRecords(records, scope);
    if (scope === activeNamespace) refreshSnapshot(records);
    announce(scope);
  });
}

export interface FlushOptions {
  /** Retired transport owners must not claim later rows in an existing drain. */
  isCurrent?: () => boolean;
  isTransient: (error: unknown) => boolean;
  onDropped?: (entry: QueuedPrompt, error: unknown) => void;
  onReceipt?: (entry: QueuedPrompt, receipt: CommandReceipt) => void;
  namespace?: string;
}
/**
 * `send` receives a signal that aborts once the dispatch deadline passes;
 * wire it into the request so the dead socket is released too.
 */
type DispatchSend = (
  entry: QueuedPrompt,
  signal: AbortSignal,
) => Promise<ReceiptResponse | void>;
const DEAD_LINK_EXPIRY_MS = 5_000;
/**
 * One dispatch under its deadline. The drain lock is held for the whole send,
 * so a request that never answers (a dead keep-alive socket, the laptop asleep
 * behind a VPN) used to park every later command until the app restarted.
 * Past the deadline the request is aborted and the command is uncertain: its
 * body may already have reached the daemon, so it is never replayed.
 */
async function dispatchWithinDeadline(
  send: DispatchSend,
  record: StoredCommand,
): Promise<ReceiptResponse | void> {
  const controller = new AbortController();
  let expire: (error: Error) => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    expire = reject;
  });
  const startedAt = Date.now();
  const expireNow = () => {
    // Reject before aborting so the deadline, not the abort, is the outcome.
    expire(
      new UncertainDeliveryError(
        "The daemon did not answer; delivery could not be confirmed.",
      ),
    );
    controller.abort();
  };
  const timer = setTimeout(expireNow, dispatchDeadlineMs(record));
  // A send into a dead link held "Sending…" for the whole lease. Once the link
  // is known unreachable, a dispatch in flight for DEAD_LINK_EXPIRY_MS has no
  // answer coming. The recheck timer covers a link that was already
  // unreachable when this dispatch started, which never notifies.
  const expireIfDead = () => {
    if (getLinkState().kind === "unreachable" && Date.now() - startedAt >= DEAD_LINK_EXPIRY_MS) expireNow();
  };
  const unsubscribe = subscribeLink(expireIfDead);
  const recheck = setTimeout(expireIfDead, DEAD_LINK_EXPIRY_MS);
  try {
    return await Promise.race([
      send(toPublic(record), controller.signal),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(recheck);
    unsubscribe();
  }
}
export async function flush(
  send: DispatchSend,
  options: FlushOptions,
): Promise<void> {
  const scope = scopeOf(options.namespace);
  if (usesNativeOutbox()) {
    await nativeOutboxRequest("wake", scope);
    await refreshNativeSnapshot(scope);
    return;
  }
  const queueCurrent = captureQueueScope(scope);
  const isCurrent = () => queueCurrent() && (options.isCurrent?.() ?? true);
  await ensureHydrated(scope);
  await drainExclusive(scope, async () => {
    const initial = await readAllRecords(scope);
    for (const current of initial
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)) {
      if (!isCurrent()) return;
      if (current.state !== "saved" || current.editToken) continue;
      const claimed = await exclusive(scope, async () => {
        const mutation = await mutateCurrentIntent(current, latest => {
          if (latest.state !== "saved" || latest.editToken) return null;
          return { put: normalizedCommand({ ...latest, state: "dispatching", updatedAt: Date.now() }, scope) };
        }, scope, isCurrent);
        if (!mutation || !("put" in mutation)) return null;
        if (scope === activeNamespace)
          refreshSnapshot(await readAllRecords(scope));
        announce(scope);
        return mutation.put;
      });
      if (!claimed) continue;
      try {
        if (!isCurrent()) throw new UndispatchedError("Send scope changed before handoff");
        const response = await dispatchWithinDeadline(send, claimed);
        const next = await applyReceipt(claimed, response, scope, isCurrent);
        if (next?.receipt) options.onReceipt?.(next, next.receipt);
      } catch (error) {
        if (error instanceof UndispatchedError) {
          await mutateIntent(claimed, current => {
            if (current.state !== "dispatching" || !sameReceiptEvidence(current, claimed)) return null;
            return { ...current, state: "saved", error: error.message, updatedAt: Date.now() };
          }, scope, () => true);
          return;
        }
        if (error instanceof QueueStorageError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const uncertain =
          error instanceof UncertainDeliveryError ||
          error instanceof ReceiptValidationError ||
          options.isTransient(error) ||
          message.toLowerCase().includes("receipt");
        const state: CommandReceiptState = uncertain ? "uncertain" : "failed";
        const next = await mutateIntent(claimed, current => {
          // A concurrent valid observation is stronger than this failed handoff.
          if (!sameReceiptEvidence(current, claimed)) return null;
          const receipt = current.receipt ?? (current.receiptBinding == null ? {
            commandId: current.commandId, sessionPath: current.sessionPath, state,
            createdAt: current.createdAt, updatedAt: Date.now(), error: message,
          } : undefined);
          return { ...current, state, receipt, error: message, updatedAt: Date.now() };
        }, scope, isCurrent);
        if (next) options.onDropped?.(next, error);
        if (uncertain) return;
      }
    }
  });
}

/**
 * Two trays hold the same photos when their payloads match. Names, sizes and
 * preview URLs are display detail and change with every restore.
 */
export function sameDraftAttachments(
  a: readonly DraftAttachment[] | undefined,
  b: readonly DraftAttachment[] | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (
      a[index]?.data !== b[index]?.data ||
      a[index]?.mimeType !== b[index]?.mimeType
    )
      return false;
  }
  return true;
}
/**
 * Save a session's photo tray. `expected` is the tray this view last read or
 * wrote: with it the write happens only while the stored tray still matches,
 * so a send in one view cannot delete photos another view has since attached.
 * Resolves to whether the stored tray now holds `images`.
 */
export async function saveDraftAttachments(
  sessionPath: string,
  images: readonly DraftAttachment[],
  namespace?: string,
  expected?: readonly DraftAttachment[],
): Promise<boolean> {
  const scope = scopeOf(namespace);
  if (!sessionPath) return false;
  const db = await openDb();
  if (!db)
    throw new QueueStorageError("Image drafts require IndexedDB storage");
  const key = draftKey(scope, sessionPath);
  let applied: boolean | undefined;
  await withStore<StoredDraft | undefined>(db, DRAFT_STORE, "readwrite", (store) => {
    const write = () => {
      if (images.length === 0) store.delete(key);
      else store.put({
        sessionPath,
        images: images.map((image) => ({ ...image })),
        updatedAt: Date.now(),
        namespace: scope,
        storageKey: key,
      } satisfies StoredDraft);
      applied = true;
    };
    if (!expected) {
      write();
      return;
    }
    const read = store.get(key);
    read.onsuccess = () => {
      const record = read.result as StoredDraft | undefined;
      const stored = record?.namespace === scope ? record.images : undefined;
      // A restored empty tray and an absent record are the same baseline for
      // the first conditional attachment write (and an already-cleared tray).
      if (sameDraftAttachments(stored ?? [], expected)) write();
      else applied = false;
    };
  });
  return applied === true;
}
export async function loadDraftAttachments(
  sessionPath: string,
  namespace?: string,
): Promise<DraftAttachment[]> {
  const scope = scopeOf(namespace);
  if (!sessionPath) return [];
  const db = await openDb();
  if (!db)
    throw new QueueStorageError("Image drafts require IndexedDB storage");
  const record = await withStore<StoredDraft | undefined>(db, DRAFT_STORE, "readonly", (store) => store.get(draftKey(scope, sessionPath)));
  return record?.namespace === scope && Array.isArray(record.images) ? record.images : [];
}
export async function clearDraftAttachments(
  sessionPath: string,
  namespace?: string,
): Promise<void> {
  await saveDraftAttachments(sessionPath, [], namespace);
}
export async function clearAllDraftAttachments(
  namespace?: string,
): Promise<void> {
  const scope = scopeOf(namespace);
  const db = await openDb();
  if (!db)
    throw new QueueStorageError("Image drafts require IndexedDB storage");
  await withStore(db, DRAFT_STORE, "readwrite", (store) => {
    const request = store.getAll();
    request.onsuccess = () => {
      for (const record of request.result as StoredDraft[])
        if (record?.namespace === scope) store.delete(record.storageKey);
    };
  });
}
export function getOutboxDiagnostics(namespace?: string): OutboxDiagnostics {
  const scope = scopeOf(namespace);
  const entries = scope === activeNamespace ? cachedEntries : [];
  const states: Record<string, number> = {};
  let bytes = 0;
  let oldestAt: number | null = null;
  for (const entry of entries) {
    states[entry.state] = (states[entry.state] ?? 0) + 1;
    bytes += entry.text.length * 2 + entry.imageBytes;
    if (oldestAt === null || entry.createdAt < oldestAt)
      oldestAt = entry.createdAt;
  }
  return {
    count: entries.length,
    pending: entries.filter((entry) => !isTerminal(entry.state)).length,
    bytes,
    oldestAt,
    states,
  };
}

/** Read-only repair manifests never contain credentials or delivery identities. */
export interface PairingRecoveryArchive {
  key: string;
  origin: string;
  savedAt: number;
  captureId: string;
  sources: { id: string; count: number }[];
  browserScopes?: { namespace: string; indexedDb: boolean }[];
  complete: boolean;
  bound?: boolean;
}
export interface PairingRecoveryEntry {
  key: string;
  kind: "draft" | "send";
  sessionPath: string;
  state?: string;
  preview: string;
  textParts: number;
  images: { mimeType: string; parts: number }[];
  browser?: boolean;
  missingImages?: boolean;
}
const REPAIR_FALLBACK = "omp-pairing-recovery:";
// A chunk bound, never a limit on how much existing work can be preserved.
const REPAIR_CHUNK_CHARS = 512 * 1024;
const REPAIR_PAGE_SIZE = 20;
const repairMutations = new Map<string, Promise<void>>();

async function serializePairingRepair<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  const previous = repairMutations.get(scope) ?? Promise.resolve();
  const execute = () => typeof navigator !== "undefined" && navigator.locks?.request
    ? navigator.locks.request(`omp-pulse-pairing-repair:${scope}`, { mode: "exclusive" }, operation)
    : operation();
  const run = previous.then(execute, execute);
  const settled = run.then(() => undefined, () => undefined);
  repairMutations.set(scope, settled);
  try { return await run; }
  finally { if (repairMutations.get(scope) === settled) repairMutations.delete(scope); }
}

async function readRepairValue<T>(store: string, key: string): Promise<T | null> {
  const db = await openDb();
  const value = db
    ? await withStore<T | undefined>(db, store, "readonly", table => table.get(key))
    : JSON.parse(localStorage.getItem(`${REPAIR_FALLBACK}${store}:${key}`) ?? "null") as T | null;
  return value ?? null;
}
async function writeRepairValue<T extends { key: string }>(store: string, value: T): Promise<void> {
  const db = await openDb();
  if (db) await withStore(db, store, "readwrite", table => table.put(value));
  else {
    const key = `${REPAIR_FALLBACK}${store}:${value.key}`, raw = JSON.stringify(value);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new QueueStorageError("Could not preserve saved work. Try again when device storage is available.");
  }
}

/** One exact-scope source row per transaction; no cross-credential photo scan. */
async function nextRepairSource<T>(db: IDBDatabase, name: string, namespace: string, after?: string): Promise<{ key: string; value: T } | null> {
  let row: { key: string; value: T } | null = null;
  await withStore(db, name, "readonly", table => {
    const prefix = `${namespace}:`;
    const request = table.openCursor(IDBKeyRange.bound(after ?? prefix, `${prefix}\uffff`, after !== undefined));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) row = { key: String(cursor.key), value: cursor.value as T };
    };
  });
  return row;
}

async function deleteRepairSource(id: string): Promise<void> {
  const db = await openDb();
  for (const name of [REPAIR_ROWS, REPAIR_CHUNKS]) {
    if (db) await withStore(db, name, "readwrite", table => {
      const request = table.openKeyCursor(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        table.delete(cursor.key);
        cursor.continue();
      };
    });
    else {
      const prefix = `${REPAIR_FALLBACK}${name}:${id}:`;
      for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  }
}

/** Flush first, then snapshot each source independently while native still authorizes it. */
export async function capturePairingRecovery(namespace: string): Promise<PairingRecoveryArchive> {
  return serializePairingRepair(`pending:${namespace}`, () => capturePairingRecoverySnapshot(namespace));
}

function repairDraftText(path: string, raw: string): string {
  try {
    const value = JSON.parse(raw);
    if (value?.format === "omp-recovered-draft-v1" && typeof value.text === "string"
      && Array.isArray(value.recoveries) && value.recoveries.every((id: unknown) => typeof id === "string")) return value.text;
    if (path === "new-session" && typeof value?.text === "string") return value.text;
    if (typeof value?.content === "string") {
      const identity = JSON.parse(path);
      if (Array.isArray(identity) && identity[0] === "file") return value.content;
    }
  } catch { /* Plain-text drafts, including JSON, remain byte-for-byte content. */ }
  return raw;
}

async function capturePairingRecoverySnapshot(namespace: string): Promise<PairingRecoveryArchive> {
  if (namespace === "anonymous") throw new QueueStorageError("Pair this device before preserving its work.");
  const db = await openDb(), origin = window.location.origin;
  const pendingKey = `pending:${namespace}`;
  const abandoned = await readRepairValue<PairingRecoveryArchive>(REPAIR_STORE, pendingKey);
  if (abandoned?.origin === origin && !abandoned.bound) await deleteRepairSource(abandoned.captureId);
  const inherited = await readRepairValue<PairingRecoveryArchive>(REPAIR_STORE, namespace);
  const browserScopes = new Map((inherited?.origin === origin && inherited.complete ? inherited.browserScopes ?? [] : [])
    .map(scope => [scope.namespace, scope]));
  browserScopes.set(namespace, { namespace, indexedDb: Boolean(db) });
  const captureId = makeId();
  let count = 0;
  const archive: PairingRecoveryArchive = {
    key: pendingKey, origin, savedAt: Date.now(), captureId, complete: false,
    sources: inherited?.origin === origin && inherited.complete ? [...inherited.sources] : [],
    browserScopes: [...browserScopes.values()],
  };
  await writeRepairValue(REPAIR_STORE, archive);
  const append = async (kind: "draft" | "send", sessionPath: string, text: string, images: readonly QueuedImage[], state?: string, missingImages?: boolean) => {
    const key = `${captureId}:${String(count).padStart(12, "0")}`;
    const writeParts = async (prefix: string, value: string) => {
      let parts = 0;
      for (let offset = 0; offset < value.length;) {
        let end = Math.min(value.length, offset + REPAIR_CHUNK_CHARS);
        const last = value.charCodeAt(end - 1);
        if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
        await writeRepairValue(REPAIR_CHUNKS, { key: `${prefix}:${parts}`, value: value.slice(offset, end) });
        offset = end;
        parts++;
      }
      return parts;
    };
    const textParts = await writeParts(`${key}:text`, text);
    const photos: PairingRecoveryEntry["images"] = [];
    for (let index = 0; index < images.length; index++)
      photos.push({ mimeType: images[index].mimeType, parts: await writeParts(`${key}:image:${index}`, images[index].data) });
    await writeRepairValue(REPAIR_ROWS, {
      key, kind, sessionPath, state, preview: text.slice(0, 120), textParts, images: photos, missingImages,
    } satisfies PairingRecoveryEntry);
    count++;
  };
  const draftPaths = new Set<string>();
  const prefix = `omp-draft:${namespace}:`;
  const draftKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) draftKeys.push(key);
  }
  for (const key of draftKeys) {
    const raw = localStorage.getItem(key);
    if (raw === null) throw new QueueStorageError("A draft changed while saving. Try again.");
    const path = key.slice(prefix.length);
    const text = repairDraftText(path, raw);
    const images = db ? await loadDraftAttachments(path, namespace) : [];
    await append("draft", path, text, images);
    draftPaths.add(path);
  }
  for (const draft of readExtensionDraftsForPairingRepair(namespace)) {
    await append("draft", draft.path, draft.text, []);
  }
  if (db) {
    let after: string | undefined;
    for (;;) {
      const row = await nextRepairSource<StoredDraft>(db, DRAFT_STORE, namespace, after);
      if (!row) break;
      after = row.key;
      if (row.value.namespace !== namespace) throw new QueueStorageError("Saved photo scope did not match. Try again.");
      if (!draftPaths.has(row.value.sessionPath))
        await append("draft", row.value.sessionPath, "", row.value.images);
    }
  }
  const native = usesNativeOutbox() ? await nativeOutboxRequest<QueuedPrompt[]>("list", namespace) : [];
  const nativeIds = new Set(native.map(row => row.commandId));
  const retain = async (row: StoredCommand) => {
    if (row.namespace !== namespace || nativeIds.has(row.commandId)) return;
    if (!row.droppedImages && row.imageCount > row.images.length)
      throw new QueueStorageError("Some saved send photos could not be read. Retry reading them before pairing.");
    await append("send", row.sessionPath, row.text, row.images, row.state, row.droppedImages || undefined);
    nativeIds.add(row.commandId);
  };
  if (db) {
    let after: string | undefined;
    for (;;) {
      const row = await nextRepairSource<StoredCommand>(db, QUEUE_STORE, namespace, after);
      if (!row) break;
      after = row.key;
      await retain(row.value);
    }
  }
  for (const row of parseFallback(localStorage.getItem(storageKey(namespace)), namespace, true)) await retain(row);
  for (const row of native) {
    const images = await nativeOutboxRequest<QueuedImage[]>("images", namespace, { commandId: row.commandId });
    if (!row.droppedImages && row.imageCount > images.length)
      throw new QueueStorageError("Some saved send photos could not be read. Retry reading them before pairing.");
    await append("send", row.sessionPath, row.text, images, row.state, row.droppedImages || undefined);
  }
  archive.sources.push({ id: captureId, count });
  archive.complete = true;
  await writeRepairValue(REPAIR_STORE, archive);
  return archive;
}

/** A binding grants read access only, never command/retry authority. */
export async function bindPairingRecovery(archive: PairingRecoveryArchive, credential: string): Promise<void> {
  return serializePairingRepair(archive.key, () => bindPairingRecoverySnapshot(archive, credential));
}

async function bindPairingRecoverySnapshot(archive: PairingRecoveryArchive, credential: string): Promise<void> {
  if (!archive.complete || archive.origin !== window.location.origin) throw new QueueStorageError("Saved work is not ready. Retry preservation before pairing.");
  const existing = await readPairingRecovery(credential);
  const sources = new Map((existing?.sources ?? []).map(source => [source.id, source]));
  for (const source of archive.sources) sources.set(source.id, source);
  const browserScopes = new Map((existing?.browserScopes ?? []).map(scope => [scope.namespace, scope]));
  for (const scope of archive.browserScopes ?? []) browserScopes.set(scope.namespace, scope);
  const bound = { ...archive, key: offlineQueueNamespaceForCredential(credential), sources: [...sources.values()], browserScopes: [...browserScopes.values()], bound: true };
  const db = await openDb();
  if (db) await withStore(db, REPAIR_STORE, "readwrite", table => {
    table.put(bound);
    table.delete(archive.key);
  });
  else {
    // Mark immutable before granting access, so even a partial fallback write
    // cannot let a later capture delete an already linked source.
    await writeRepairValue(REPAIR_STORE, { ...archive, bound: true });
    await writeRepairValue(REPAIR_STORE, bound);
    const pendingKey = `${REPAIR_FALLBACK}${REPAIR_STORE}:${archive.key}`;
    localStorage.removeItem(pendingKey);
    if (localStorage.getItem(pendingKey) !== null) throw new QueueStorageError("Could not finish preserving saved work. Try again.");
  }
}

export async function readPairingRecovery(credential: string): Promise<PairingRecoveryArchive | null> {
  if (!credential) return null;
  const key = offlineQueueNamespaceForCredential(credential);
  const archive = await readRepairValue<PairingRecoveryArchive>(REPAIR_STORE, key);
  return archive?.key === key && archive.origin === window.location.origin && archive.complete ? archive : null;
}

type BrowserRepairRef = {
  namespace: string;
  kind: "draft" | "photo" | "extension" | "send";
  sourceKey: string;
  path: string;
  fallback?: boolean;
};
function browserRepairKey(ref: BrowserRepairRef): string {
  return `browser:${offlineQueueNamespaceForCredential(JSON.stringify([ref.namespace, ref.kind, ref.sourceKey]))}`;
}
async function scopedRepairKeys(db: IDBDatabase, name: string, namespace: string): Promise<string[]> {
  const keys: string[] = [];
  await withStore(db, name, "readonly", table => {
    const request = table.openKeyCursor(IDBKeyRange.bound(`${namespace}:`, `${namespace}:\uffff`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      keys.push(String(cursor.key));
      cursor.continue();
    };
  });
  return keys;
}
/** Only compact source keys are enumerated. Photo/send payloads wait for selection. */
async function browserRepairRefs(archive: PairingRecoveryArchive): Promise<BrowserRepairRef[]> {
  const refs: BrowserRepairRef[] = [], db = await openDb();
  for (const scope of archive.browserScopes ?? []) {
    if (scope.indexedDb && !db) throw new QueueStorageError("Saved browser work couldn't be read. Retry when device storage is available.");
    const prefix = `omp-draft:${scope.namespace}:`, paths = new Set<string>();
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      const path = key.slice(prefix.length);
      refs.push({ namespace: scope.namespace, kind: "draft", sourceKey: key, path });
      paths.add(path);
    }
    for (const draft of readExtensionDraftsForPairingRepair(scope.namespace))
      refs.push({ namespace: scope.namespace, kind: "extension", sourceKey: draft.path, path: draft.path });
    if (db) {
      for (const key of await scopedRepairKeys(db, DRAFT_STORE, scope.namespace)) {
        const path = key.slice(scope.namespace.length + 1);
        if (!paths.has(path)) refs.push({ namespace: scope.namespace, kind: "photo", sourceKey: key, path });
      }
      for (const key of await scopedRepairKeys(db, QUEUE_STORE, scope.namespace))
        refs.push({ namespace: scope.namespace, kind: "send", sourceKey: key, path: "Saved browser send" });
    }
    const storedKeys = new Set(refs.filter(ref => ref.namespace === scope.namespace && ref.kind === "send").map(ref => ref.sourceKey));
    for (const row of parseFallback(localStorage.getItem(storageKey(scope.namespace)), scope.namespace, true)) {
      if (!storedKeys.has(row.storageKey))
        refs.push({ namespace: scope.namespace, kind: "send", sourceKey: row.storageKey, path: row.sessionPath, fallback: true });
    }
  }
  return refs;
}
function browserRepairMetadata(ref: BrowserRepairRef): PairingRecoveryEntry {
  return { key: browserRepairKey(ref), browser: true, kind: ref.kind === "send" ? "send" : "draft",
    sessionPath: ref.path, state: ref.kind === "send" ? "delivery not checked" : undefined,
    preview: "Latest saved browser work", textParts: 0, images: [] };
}
function repairTextParts(text: string, requested?: number): { count: number; value?: string } {
  let count = 0, value: string | undefined;
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + REPAIR_CHUNK_CHARS);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    if (count === requested) value = text.slice(offset, end);
    offset = end;
    count++;
  }
  return { count, value };
}
async function readBrowserRepairEntry(archive: PairingRecoveryArchive, key: string): Promise<{ item: PairingRecoveryEntry; text: string; images: readonly QueuedImage[] }> {
  const ref = (await browserRepairRefs(archive)).find(candidate => browserRepairKey(candidate) === key);
  if (!ref) throw new QueueStorageError("This saved work does not belong to the current pairing, or its original was removed.");
  const item = browserRepairMetadata(ref), db = await openDb();
  let text = "", images: readonly QueuedImage[] = [];
  if (ref.kind === "send") {
    const row = !ref.fallback && db
      ? await withStore<StoredCommand | undefined>(db, QUEUE_STORE, "readonly", table => table.get(ref.sourceKey))
      : parseFallback(localStorage.getItem(storageKey(ref.namespace)), ref.namespace, true).find(candidate => candidate.storageKey === ref.sourceKey);
    if (!row || row.namespace !== ref.namespace || !Array.isArray(row.images) || (!row.droppedImages && row.imageCount > row.images.length))
      throw new QueueStorageError("The original saved send couldn't be read completely. Try again.");
    text = row.text;
    images = row.images;
    item.sessionPath = row.sessionPath;
    item.state = row.state;
    item.missingImages = row.droppedImages || undefined;
  } else if (ref.kind === "extension") {
    const draft = readExtensionDraftsForPairingRepair(ref.namespace).find(candidate => candidate.path === ref.path);
    if (!draft) throw new QueueStorageError("The original prepared draft couldn't be read. Try again.");
    text = draft.text;
  } else {
    const raw = ref.kind === "draft" ? localStorage.getItem(ref.sourceKey) : null;
    const photos = db ? await withStore<StoredDraft | undefined>(db, DRAFT_STORE, "readonly", table => table.get(draftKey(ref.namespace, ref.path))) : undefined;
    if (photos && (photos.namespace !== ref.namespace || !Array.isArray(photos.images)))
      throw new QueueStorageError("The original saved photos couldn't be read. Try again.");
    images = photos?.images ?? [];
    if (raw === null && !images.length) throw new QueueStorageError("The original draft couldn't be read. Try again.");
    text = raw === null ? "" : repairDraftText(ref.path, raw);
  }
  item.preview = text.slice(0, 120);
  item.textParts = repairTextParts(text).count;
  item.images = images.map(image => ({ mimeType: image.mimeType, parts: 0 }));
  return { item, text, images };
}

/** Pages contain compact metadata only; text and photos are loaded deliberately. */
export async function readPairingRecoveryEntries(credential: string, offset = 0): Promise<{ items: PairingRecoveryEntry[]; next: number | null }> {
  const archive = await readPairingRecovery(credential);
  if (!archive) return { items: [], next: null };
  const refs = await browserRepairRefs(archive);
  const items = refs.slice(offset, offset + REPAIR_PAGE_SIZE).map(browserRepairMetadata);
  let position = refs.length;
  const total = refs.length + archive.sources.reduce((sum, source) => sum + source.count, 0);
  for (const source of archive.sources) {
    for (let index = Math.max(0, offset - position); index < source.count && items.length < REPAIR_PAGE_SIZE; index++) {
      const key = `${source.id}:${String(index).padStart(12, "0")}`;
      const item = await readRepairValue<PairingRecoveryEntry>(REPAIR_ROWS, key);
      if (!item) throw new QueueStorageError("Saved work could not be read. Try again when device storage is available.");
      items.push(item);
    }
    position += source.count;
    if (items.length === REPAIR_PAGE_SIZE) break;
  }
  return { items, next: offset + items.length < total ? offset + items.length : null };
}

async function authorizedRepairEntry(credential: string, key: string): Promise<{ item: PairingRecoveryEntry; text?: string; images?: readonly QueuedImage[] }> {
  const archive = await readPairingRecovery(credential);
  if (archive && key.startsWith("browser:")) return readBrowserRepairEntry(archive, key);
  if (!archive?.sources.some(source => key.startsWith(`${source.id}:`)))
    throw new QueueStorageError("This saved work does not belong to the current pairing.");
  const item = await readRepairValue<PairingRecoveryEntry>(REPAIR_ROWS, key);
  if (!item) throw new QueueStorageError("Saved work could not be read. Try again.");
  return { item };
}

/** Selection loads one original record, returning metadata without its photo bytes. */
export async function readPairingRecoveryEntry(credential: string, key: string): Promise<PairingRecoveryEntry> {
  return (await authorizedRepairEntry(credential, key)).item;
}

export async function readPairingRecoveryText(credential: string, key: string, part = 0): Promise<string> {
  const { item, text } = await authorizedRepairEntry(credential, key);
  if (!Number.isInteger(part) || part < 0 || part >= item.textParts) {
    if (!item.textParts && part === 0) return "";
    throw new QueueStorageError("This saved text part is not available.");
  }
  if (text !== undefined) return repairTextParts(text, part).value ?? "";
  const chunk = await readRepairValue<{ value: string }>(REPAIR_CHUNKS, `${key}:text:${part}`);
  if (!chunk) throw new QueueStorageError("Saved text could not be read. Try again.");
  return chunk.value;
}

export async function readPairingRecoveryImage(credential: string, key: string, index: number): Promise<QueuedImage> {
  const { item, images } = await authorizedRepairEntry(credential, key), image = item.images[index];
  if (!image) throw new QueueStorageError("This saved attachment is not available.");
  if (images) return { data: images[index].data, mimeType: images[index].mimeType };
  const parts: string[] = [];
  for (let part = 0; part < image.parts; part++) {
    const chunk = await readRepairValue<{ value: string }>(REPAIR_CHUNKS, `${key}:image:${index}:${part}`);
    if (!chunk) throw new QueueStorageError("Saved photo could not be read. Try again.");
    parts.push(chunk.value);
  }
  return { data: parts.join(""), mimeType: image.mimeType };
}

export async function clearPairingRecovery(namespace: string): Promise<void> {
  return serializePairingRepair(`pending:${namespace}`, async () => {
    const db = await openDb(), pendingKey = `pending:${namespace}`, cleanupKey = `cleanup:${namespace}`;
    const linked = await readRepairValue<PairingRecoveryArchive>(REPAIR_STORE, namespace);
    const pending = await readRepairValue<PairingRecoveryArchive>(REPAIR_STORE, pendingKey);
    const interrupted = await readRepairValue<{ ids: string[] }>(REPAIR_STORE, cleanupKey);
    const candidates = new Set(interrupted?.ids ?? []);
    for (const archive of [linked, pending]) {
      if (!archive || archive.origin !== window.location.origin) continue;
      candidates.add(archive.captureId);
      for (const source of archive.sources) candidates.add(source.id);
    }
    // Keep a durable cleanup journal until every unreferenced chunk is removed,
    // so a failed clear can honestly offer Retry instead of hiding orphan bytes.
    const journal = { key: cleanupKey, origin: window.location.origin, ids: [...candidates] };
    if (db) await withStore(db, REPAIR_STORE, "readwrite", store => {
      store.put(journal);
      store.delete(namespace);
      store.delete(pendingKey);
    });
    else {
      await writeRepairValue(REPAIR_STORE, journal);
      for (const key of [namespace, pendingKey]) {
        const storage = `${REPAIR_FALLBACK}${REPAIR_STORE}:${key}`;
        localStorage.removeItem(storage);
        if (localStorage.getItem(storage) !== null) throw new QueueStorageError("Could not remove saved work. Try again.");
      }
    }
    const manifests = db
      ? await withStore<PairingRecoveryArchive[]>(db, REPAIR_STORE, "readonly", store => store.getAll())
      : Object.keys(localStorage).filter(key => key.startsWith(`${REPAIR_FALLBACK}${REPAIR_STORE}:`))
        .map(key => JSON.parse(localStorage.getItem(key) ?? "null") as PairingRecoveryArchive | null);
    const referenced = new Set<string>();
    for (const archive of manifests) {
      if (!archive || archive.origin !== window.location.origin || !Array.isArray(archive.sources)) continue;
      referenced.add(archive.captureId);
      for (const source of archive.sources) referenced.add(source.id);
    }
    for (const id of candidates) if (!referenced.has(id)) await deleteRepairSource(id);
    if (db) await withStore(db, REPAIR_STORE, "readwrite", store => store.delete(cleanupKey));
    else {
      const storage = `${REPAIR_FALLBACK}${REPAIR_STORE}:${cleanupKey}`;
      localStorage.removeItem(storage);
      if (localStorage.getItem(storage) !== null) throw new QueueStorageError("Could not confirm saved-work removal. Try again.");
    }
  });
}

/** Only the explicitly selected attachment is decoded for saving/sharing. */
export async function savePairingRecoveryAttachment(credential: string, key: string, index: number): Promise<boolean> {
  const image = await readPairingRecoveryImage(credential, key, index);
  const bytes = Uint8Array.from(atob(image.data), value => value.charCodeAt(0));
  const subtype = /^image\/([a-z0-9]+)(?:\+xml)?$/i.exec(image.mimeType)?.[1].toLowerCase();
  const extension = subtype === "jpeg" ? "jpg" : subtype ?? "bin";
  return saveBlob(new Blob([bytes], { type: image.mimeType }), `saved-attachment-${index + 1}.${extension}`);
}
