import type { QueuedPrompt } from "./offline-queue";

type MessageBridge = {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
};
type NativeWindow = Window & {
  OmpOutbox?: MessageBridge;
  OmpNative?: { senderRequired(): boolean };
};
const REQUEST_WAIT_MS = 10_000;
const pending = new Map<string, {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: number;
}>();
let installed: MessageBridge | undefined;
const changeListeners = new Set<() => void>();
let changeEvents = false;

// One channel carries request replies and native change hints. Install before
// the first request so a change racing its reply cannot fall through a gap.
function install(bridge: MessageBridge): void {
  if (installed === bridge) return;
  installed = bridge;
  changeEvents = false;
  bridge.onmessage = (event) => {
    let result: { id?: string; ok?: boolean; value?: unknown; error?: string; code?: string; event?: string; changeEvents?: boolean } | null;
    try { result = JSON.parse(event.data); } catch { return; }
    if (!result) return;
    if (result.event === "outbox-changed") {
      if (installed === bridge) for (const listener of changeListeners) listener();
      return;
    }
    if (installed === bridge && typeof result.changeEvents === "boolean")
      changeEvents = result.changeEvents;
    const call = result.id ? pending.get(result.id) : undefined;
    if (!call) return;
    pending.delete(result.id!);
    window.clearTimeout(call.timer);
    if (result.ok) call.resolve(result.value);
    else call.reject(new NativeOutboxError(result.error || "Native storage could not save the change.", result.code || "storage"));
  };
}

/** Native delivery and notification replies can change rows behind this page. */
export function subscribeNativeOutboxChanges(listener: () => void): () => void {
  const bridge = typeof window === "undefined" ? undefined : (window as NativeWindow).OmpOutbox;
  if (bridge) install(bridge);
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

/** Capability belongs to this page's bridge, never a previously installed APK. */
export function nativeChangeEventsSupported(): boolean {
  return typeof window !== "undefined" &&
    (window as NativeWindow).OmpOutbox === installed && changeEvents;
}

export class NativeOutboxError extends Error {
  override name = "NativeOutboxError";
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export function usesNativeOutbox(): boolean {
  if (typeof window === "undefined") return false;
  const native = window as NativeWindow;
  // A new APK without WebMessage support must fail visibly, not fall back
  // to the suspended-WebView delivery ownership this cutover removes.
  return !!native.OmpOutbox || native.OmpNative?.senderRequired() === true;
}

/** Only persistence/status crosses this bridge. Native delivery never awaits a WebView. */
export function nativeOutboxRequest<T>(
  op: "enqueue" | "import" | "list" | "get" | "images" | "remove" | "clear" | "wake" | "edit_begin" | "edit_finish",
  namespace: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const bridge = typeof window === "undefined" ? undefined : (window as NativeWindow).OmpOutbox;
  if (!bridge) return Promise.reject(new NativeOutboxError("Native delivery is unavailable. Reopen the app.", "unavailable"));
  install(bridge);
  const id = crypto.randomUUID();
  const deadlineAt = Date.now() + REQUEST_WAIT_MS;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = window.setTimeout(() => {
    pending.delete(id);
    // A save may have committed while its acknowledgement was delayed. The
    // caller retains its draft-attempt ID; a retry cannot create another send.
    reject(new NativeOutboxError("Native storage did not confirm the change. Your draft was kept; retry checks the same message.", "unconfirmed"));
  }, REQUEST_WAIT_MS);
  pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
  try { bridge.postMessage(JSON.stringify({ ...args, id, op, namespace, deadlineAt })); }
  catch (error) {
    pending.delete(id);
    window.clearTimeout(timer);
    reject(error);
  }
  return promise;
}

const ATTEMPT_PREFIX = "omp-native-save-attempt:";

/** Bind retries (including after process death) to the original durable command. */
export function nativeSaveAttempt(namespace: string, sessionPath: string, fingerprint: string): string {
  const key = `${ATTEMPT_PREFIX}${namespace}:${sessionPath}:${fingerprint}`;
  const previous = localStorage.getItem(key);
  if (previous) return previous;
  const commandId = crypto.randomUUID();
  localStorage.setItem(key, commandId);
  if (localStorage.getItem(key) !== commandId)
    throw new NativeOutboxError("Could not preserve the send identity. Your draft was kept.", "storage");
  return commandId;
}

/** Release the retry identity only after both text and photo drafts are cleared. */
export function acknowledgeNativeSave(
  entry: Pick<QueuedPrompt, "commandId" | "sessionPath">,
  namespace: string,
): void {
  if (!usesNativeOutbox()) return;
  const prefix = `${ATTEMPT_PREFIX}${namespace}:${entry.sessionPath}:`;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix) && localStorage.getItem(key) === entry.commandId)
        localStorage.removeItem(key);
    }
  } catch {
    // Keeping the identity is conservative: another attempt checks the saved
    // command rather than duplicating it if convenience storage is unavailable.
  }
}
