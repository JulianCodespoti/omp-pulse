import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import { getDraftNamespace, readDraft, removeDraft, seedDraft } from "../app/composer/use-draft";
import { makeCommandId } from "./offline-queue";

export interface FileDraft {
  /** One edit lifetime; a late save must not clear a discarded/replaced draft. */
  id: string;
  content: string;
  /** Exact original bytes as text, sent as POST's required expectedContent.
   * Fresh reads and conflicts must never silently advance this precondition.
   */
  baseline: string;
}

let lastKnownNamespace: string | null = null;
const acknowledgements = new Map<string, { id: string; content: string }>();
const subscribers = new Map<string, number>();
/** Only failed writes live here; durable drafts remain in the shared draft store. */
const volatileDrafts = new Map<string, { path: string; namespace: string; raw: string; observed: string; error: string }>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
function subscribe(scope: string, listener: () => void): () => void {
  listeners.add(listener);
  subscribers.set(scope, (subscribers.get(scope) ?? 0) + 1);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
    const remaining = (subscribers.get(scope) ?? 1) - 1;
    if (remaining) subscribers.set(scope, remaining);
    else {
      subscribers.delete(scope);
      // No mounted reader can be raced now. Late saves still clean their scoped
      // durable draft but do not retain an acknowledgement cache indefinitely.
      acknowledgements.delete(scope);
    }
  };
}
function decode(value: string): FileDraft | null {
  try {
    const draft: unknown = JSON.parse(value);
    return draft && typeof draft === "object" && "id" in draft && typeof draft.id === "string"
      && "content" in draft && typeof draft.content === "string" && "baseline" in draft && typeof draft.baseline === "string"
      ? { id: draft.id, content: draft.content, baseline: draft.baseline } : null;
  } catch {
    return null;
  }
}

function persist(path: string, namespace: string, scope: string, raw: string, expected?: string): void {
  const observed = expected ?? readDraft(path, namespace);
  let saved: boolean;
  if (!raw) saved = removeDraft(path, namespace, expected ?? observed);
  else {
    seedDraft(path, raw, namespace);
    saved = readDraft(path, namespace) === raw;
  }
  if (saved) volatileDrafts.delete(scope);
  else volatileDrafts.set(scope, {
    path, namespace, raw, observed,
    error: "Couldn’t preserve this file draft on this device. Keep this window open until storage is available.",
  });
}

/** Called only after the credential's durable draft clearing succeeds. */
export function clearFileDraftMemory(namespace: string): void {
  const prefix = JSON.stringify([namespace]).slice(0, -1) + ",";
  for (const scope of volatileDrafts.keys()) if (scope.startsWith(prefix)) volatileDrafts.delete(scope);
  for (const scope of acknowledgements.keys()) if (scope.startsWith(prefix)) acknowledgements.delete(scope);
  notify();
}

/** The app may not reload for an update while a file edit exists only in memory. */
export function flushFileDraftWrites(): void {
  for (const [scope, draft] of volatileDrafts) persist(draft.path, draft.namespace, scope, draft.raw, draft.observed);
  notify();
  if (volatileDrafts.size) throw new Error("Could not save the current file draft. The app was not reloaded.");
}

/** File text uses the existing credential-scoped draft store, including offline-data clearing.
 * Session paths resolve the workspace on the daemon; origin separates computers even
 * when they use the same credential and relative file names. Empty edits are records too.
 */
export function useFileDraft(sessionPath: string | null, filePath: string) {
  const namespaceRef = useRef(lastKnownNamespace ?? getDraftNamespace());
  try {
    // readPairingToken deliberately treats denied storage as unpaired. A live
    // file edit must not migrate to the anonymous scope because of that failure.
    localStorage.getItem("");
    namespaceRef.current = getDraftNamespace();
    lastKnownNamespace = namespaceRef.current;
  } catch {
    // Keep the last known credential while storage is unavailable.
  }
  const namespace = namespaceRef.current;
  const path = sessionPath && filePath ? JSON.stringify(["file", window.location.origin, sessionPath, filePath]) : null;
  const scope = JSON.stringify([namespace, path]);
  const getSnapshot = useCallback(() => {
    const fallback = volatileDrafts.get(scope);
    return JSON.stringify([fallback?.raw ?? readDraft(path, namespace), acknowledgements.get(scope) ?? null, fallback?.error ?? null]);
  }, [path, namespace, scope]);
  const subscribeScope = useCallback((listener: () => void) => subscribe(scope, listener), [scope]);
  const snapshot = useSyncExternalStore(subscribeScope, getSnapshot, () => '["",null,null]');
  // This tuple is serialized by getSnapshot above, not supplied externally.
  const [raw, acknowledged, storageError] = useMemo(() => JSON.parse(snapshot) as [string, { id: string; content: string } | null, string | null], [snapshot]);
  const draft = useMemo(() => decode(raw), [raw]);
  const update = useCallback((content: string, baseline: string): FileDraft | null => {
    if (!path) return null;
    const fallback = volatileDrafts.get(scope);
    const previous = decode(fallback?.raw ?? raw);
    const next = { id: previous?.id ?? makeCommandId(), content, baseline: previous?.baseline ?? baseline };
    persist(path, namespace, scope, JSON.stringify(next), fallback?.observed ?? raw);
    notify();
    return next;
  }, [path, namespace, scope, raw]);
  const discard = useCallback(() => {
    if (!path) return;
    const fallback = volatileDrafts.get(scope);
    // Compare the rendered snapshot, not a later edit made by another view.
    if ((fallback?.raw ?? readDraft(path, namespace)) !== raw) return;
    persist(path, namespace, scope, "", fallback?.observed ?? raw);
    notify();
  }, [path, namespace, scope, raw]);
  const acknowledge = useCallback((submitted: FileDraft | null) => {
    if (!path || !submitted) return;
    const stored = volatileDrafts.get(scope)?.raw ?? readDraft(path, namespace);
    const current = decode(stored);
    if (!current || current.id !== submitted.id || current.baseline !== submitted.baseline) return;
    persist(path, namespace, scope, current.content === submitted.content ? "" : JSON.stringify({ ...current, baseline: submitted.content }), volatileDrafts.get(scope)?.observed ?? stored);
    if (subscribers.has(scope)) acknowledgements.set(scope, { id: submitted.id, content: submitted.content });
    notify();
  }, [path, namespace, scope]);
  const beginRead = useCallback(() => {
    const before = acknowledgements.get(scope);
    return (diskContent: string) => {
      const after = acknowledgements.get(scope);
      // A read started before a confirmed write can still return the old bytes.
      const content = after && after !== before ? after.content : diskContent;
      return { content, draft: decode(volatileDrafts.get(scope)?.raw ?? readDraft(path, namespace)) };
    };
  }, [path, namespace, scope]);
  return { draft, update, discard, acknowledge, acknowledged, acknowledgementKey: JSON.stringify(acknowledged), beginRead, storageError };
}
