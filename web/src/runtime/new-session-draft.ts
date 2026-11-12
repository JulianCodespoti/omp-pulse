import type { ModelInfo } from "./api-types";
import { makeCommandId, offlineQueueNamespaceForCredential } from "./offline-queue";
import { readPairingToken } from "../platform/browser-storage";

// Both text/configuration and photos participate in the existing scoped draft
// clearing paths. Photo bytes live only in the outbox's IndexedDB draft store.
export const NEW_SESSION_DRAFT_PATH = "new-session";
export interface NewSessionDraftValue {
  revision: string;
  text: string;
  project: string | null;
  choice: { model: ModelInfo; thinkingLevel: string } | null;
  createdSessionPath: string | null;
  transferredSessionPath: string | null;
}
interface Snapshot { value: NewSessionDraftValue; error: string | null }
const owners = new Map<string, NewSessionDraft>();
let lastKnownNamespace: string | null = null;
const empty = (): NewSessionDraftValue => ({ revision: makeCommandId(), text: "", project: null, choice: null, createdSessionPath: null, transferredSessionPath: null });
const failure = "Couldn’t preserve this new-session draft on this device. Keep this window open and retry when storage is available.";

export class NewSessionDraft {
  private snapshot: Snapshot;
  private observed: string | null = null;
  private dirty = false;
  private listeners = new Set<() => void>();
  private key: string;
  constructor(readonly namespace: string) {
    this.key = `omp-draft:${namespace}:${NEW_SESSION_DRAFT_PATH}`;
    this.snapshot = { value: empty(), error: null };
    try {
      this.observed = localStorage.getItem(this.key);
      if (this.observed) {
        const value = JSON.parse(this.observed) as NewSessionDraftValue;
        if (typeof value.revision !== "string" || typeof value.text !== "string"
          || !(value.transferredSessionPath === null || typeof value.transferredSessionPath === "string")
          || !(value.project === null || typeof value.project === "string")
          || !(value.createdSessionPath === null || typeof value.createdSessionPath === "string")
          || !(value.choice === null || (typeof value.choice?.model?.provider === "string"
            && typeof value.choice.model.id === "string" && typeof value.choice.thinkingLevel === "string")))
          throw new Error("Invalid saved draft");
        this.snapshot = { value, error: null };
      }
    } catch { this.snapshot = { ...this.snapshot, error: failure }; }
  }
  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(value: NewSessionDraftValue, error: string | null): void {
    this.snapshot = { value, error };
    for (const listener of this.listeners) listener();
  }
  update(patch: Partial<Omit<NewSessionDraftValue, "revision">>): void {
    this.dirty = true;
    this.publish({ ...this.snapshot.value, ...patch, revision: makeCommandId() }, this.snapshot.error);
    this.persist();
  }
  private persist(): boolean {
    if (!this.dirty) return !this.snapshot.error;
    try {
      if (localStorage.getItem(this.key) !== this.observed)
        throw new Error("Draft changed in another window");
      const raw = JSON.stringify(this.snapshot.value);
      localStorage.setItem(this.key, raw);
      if (localStorage.getItem(this.key) !== raw) throw new Error("Draft write failed");
      this.observed = raw;
      this.dirty = false;
      this.publish(this.snapshot.value, null);
      return true;
    } catch { this.publish(this.snapshot.value, failure); return false; }
  }
  retry(): boolean {
    if (!this.dirty && this.snapshot.error) {
      const restored = new NewSessionDraft(this.namespace);
      if (!restored.snapshot.error) {
        this.observed = restored.observed;
        this.publish(restored.snapshot.value, null);
        return true;
      }
    }
    return this.persist();
  }
  rememberCreated(expected: string, path: string, project: string): void {
    if (this.snapshot.value.revision === expected) this.update({ createdSessionPath: path, project });
  }
  markTransferred(expected: string, path: string): void {
    if (this.snapshot.value.revision !== expected) return;
    this.dirty = true;
    this.publish({ ...this.snapshot.value, transferredSessionPath: path }, this.snapshot.error);
    this.persist();
  }
  clearConsumed(expected: string): boolean {
    // Late send completions own only their exact submitted revision.
    if (this.snapshot.value.revision !== expected) return true;
    try {
      if (localStorage.getItem(this.key) !== this.observed) {
        // A different window replaced the consumed draft. Adopt its metadata
        // without touching its durable record or replaying our submitted text.
        const newer = new NewSessionDraft(this.namespace);
        this.observed = newer.observed;
        this.dirty = false;
        this.publish(newer.snapshot.value, newer.snapshot.error);
        return true;
      }
      localStorage.removeItem(this.key);
      if (localStorage.getItem(this.key) !== null) throw new Error("Draft removal failed");
      this.observed = null;
      this.dirty = false;
      this.publish(empty(), null);
      return true;
    } catch { this.publish(this.snapshot.value, failure); return false; }
  }
  clearMemory(): void {
    this.observed = null;
    this.dirty = false;
    this.publish(empty(), null);
  }
  flush(): void {
    if (!this.persist()) throw new Error(failure);
  }
}
export function getNewSessionDraft(namespace?: string): NewSessionDraft {
  if (namespace === undefined) {
    try {
      // A temporary storage denial must not switch an existing device draft
      // into the anonymous pairing scope on the next navigation.
      localStorage.getItem("omp-remote-token");
      namespace = offlineQueueNamespaceForCredential(readPairingToken());
      lastKnownNamespace = namespace;
    } catch { namespace = lastKnownNamespace ?? "anonymous"; }
  }
  let owner = owners.get(namespace);
  if (!owner) { owner = new NewSessionDraft(namespace); owners.set(namespace, owner); }
  return owner;
}
export function clearNewSessionDraftMemory(namespace: string): void { owners.get(namespace)?.clearMemory(); }
export function flushNewSessionDraftWrites(): void { for (const owner of owners.values()) owner.flush(); }

export function readLastSessionChoice(namespace: string): { key: string; thinkingLevel: string } | null {
  try {
    const value = JSON.parse(localStorage.getItem(`omp-new-session-model:${namespace}`) ?? "null");
    return value && typeof value.key === "string" && typeof value.thinkingLevel === "string" ? value : null;
  } catch { return null; }
}
export function rememberLastSessionChoice(namespace: string, key: string, thinkingLevel: string): void {
  try { localStorage.setItem(`omp-new-session-model:${namespace}`, JSON.stringify({ key, thinkingLevel })); }
  catch { /* The complete choice remains in the recoverable draft until transfer. */ }
}
