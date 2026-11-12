import { useCallback, useEffect, useRef, useState } from "react";
import { readPairingToken } from "../../platform/browser-storage";
import { offlineQueueNamespaceForCredential } from "../../runtime/offline-queue";
import { submittedDraftCleanup } from "./draft-cleanup";
import { editedImageReferences, updateDraftImageReferences, type DraftImageReference } from "../../domain/image-references";

const draftFlushers = new Set<() => void>();
const DRAFT_PREFIX = "omp-draft:";
const DEBOUNCE_MS = 300;
export function getDraftNamespace(): string {
  return offlineQueueNamespaceForCredential(readPairingToken() ?? "");
}
function keyFor(
  sessionPath: string | null,
  namespace = getDraftNamespace(),
): string | null {
  return sessionPath ? `${DRAFT_PREFIX}${namespace}:${sessionPath}` : null;
}
type SavedTextDraft = {
  format: "omp-recovered-draft-v1"; text: string; recoveries: string[];
  references: readonly DraftImageReference[]; removedImages: string[];
};
function readTextDraft(sessionPath: string | null, namespace: string, tolerateUnavailable = false): SavedTextDraft {
  const key = keyFor(sessionPath, namespace);
  let raw = "";
  try { raw = key ? localStorage.getItem(key) ?? "" : ""; }
  catch (error) { if (!tolerateUnavailable) throw error; }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const value = parsed as Partial<SavedTextDraft>;
      if (value.format === "omp-recovered-draft-v1" && typeof value.text === "string"
        && Array.isArray(value.recoveries) && value.recoveries.every(id => typeof id === "string"))
        return { format: value.format, text: value.text, recoveries: value.recoveries,
          references: Array.isArray(value.references) ? value.references.filter(reference =>
            reference && Number.isInteger(reference.start) && Number.isInteger(reference.end)
            && reference.start >= 0 && reference.end > reference.start && reference.end <= value.text!.length
            && typeof reference.imageId === "string") : [],
          removedImages: Array.isArray(value.removedImages) ? value.removedImages.filter(id => typeof id === "string") : [] };
    }
  } catch { /* Legacy drafts are plain text. */ }
  return { format: "omp-recovered-draft-v1", text: raw, recoveries: [], references: [], removedImages: [] };
}
function readDraft(
  sessionPath: string | null,
  namespace = getDraftNamespace(),
): string {
  const key = keyFor(sessionPath, namespace);
  if (!key) return "";
  try {
    return readTextDraft(sessionPath, namespace).text;
  } catch {
    return "";
  }
}
function writeDraft(
  sessionPath: string | null,
  value: string,
  namespace = getDraftNamespace(),
  recoveries: readonly string[] = [],
  references?: readonly DraftImageReference[],
  removedImages: readonly string[] = [],
): boolean {
  const key = keyFor(sessionPath, namespace);
  if (!key) return false;
  try {
    const saved = readTextDraft(sessionPath, namespace);
    const ids = [...new Set([...saved.recoveries, ...recoveries])];
    const owned = references ?? editedImageReferences(saved.text, value, saved.references);
    const removed = [...new Set([...saved.removedImages, ...removedImages])];
    if (value === "" && !ids.length && !removed.length) localStorage.removeItem(key);
    else localStorage.setItem(key, ids.length || owned.length || removed.length
      ? JSON.stringify({ format: "omp-recovered-draft-v1", text: value, recoveries: ids, references: owned, removedImages: removed } satisfies SavedTextDraft)
      : value);
    return true;
  } catch {
    return false;
  }
}
/** Upgrade imports must fail visibly rather than lose unsent native text. */
export function recoverDraft(sessionPath: string, text: string, namespace: string): void {
  if (!text) return;
  const existing = readTextDraft(sessionPath, namespace).text;
  if (existing === text || existing.endsWith(`\n\n${text}`)) return;
  if (!writeDraft(sessionPath, existing ? `${existing}\n\n${text}` : text, namespace))
    throw new Error("Could not save the recovered draft.");
}

export function seedDraft(
  sessionPath: string,
  text: string,
  namespace = getDraftNamespace(),
): boolean {
  if (!sessionPath) return false;
  return writeDraft(sessionPath, text, namespace);
}
/**
 * Drop a saved draft. `expected` is the snapshot the caller acted on: send
 * cleanup passes the text it submitted, so a draft written since — here or in
 * another view — survives.
 */
export function removeDraft(
  sessionPath: string | null,
  namespace = getDraftNamespace(),
  expected?: string,
): boolean {
  const key = keyFor(sessionPath, namespace);
  if (!key) return false;
  try {
    if (expected !== undefined && readTextDraft(sessionPath, namespace).text !== expected)
      return false;
    localStorage.removeItem(key);
    return localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}
/**
 * Text a refused send must put back. The payload stays first and anything
 * written while it was in flight is kept after it. A draft that already ends
 * with the payload is returned unchanged, so a retry cannot duplicate it.
 */
export function restoredDraftText(payloadText: string, kept: string): string {
  if (!kept || kept === payloadText || kept.endsWith(`\n\n${payloadText}`))
    return kept || payloadText;
  return `${payloadText}\n\n${kept}`;
}

/** Recovery identity, not equal words, determines replay. Identical unsent
 * drafts and queued messages are still two distinct pieces of user input. */
export function recoveredDraftText(payload: string, kept: string): string {
  return payload && kept ? `${payload}\n\n${kept}` : payload || kept;
}

/** Text and the exact recovery identity commit in one localStorage write. */
export function restoreSavedDraft(sessionPath: string, payload: string, namespace: string, recoveryId: string, references: readonly DraftImageReference[] = []): void {
  const saved = readTextDraft(sessionPath, namespace);
  if (saved.recoveries.includes(recoveryId)) return;
  const offset = payload ? payload.length + (saved.text ? 2 : 0) : 0;
  if (!writeDraft(sessionPath, recoveredDraftText(payload, saved.text), namespace, [recoveryId],
    [...references, ...saved.references.map(reference => ({ ...reference, start: reference.start + offset, end: reference.end + offset }))]))
    throw new Error("Could not save the recovered text. Keep this conversation open and try again.");
}
export function removedDraftImages(sessionPath: string, namespace: string): string[] {
  return readTextDraft(sessionPath, namespace, true).removedImages;
}
/** Remove only the drafts belonging to this device credential. Legacy unscoped keys are intentionally retained. */
export function clearAllDrafts(namespace = getDraftNamespace()): void {
  const prefix = `${DRAFT_PREFIX}${namespace}:`;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) {
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null)
      throw new Error("Could not clear this device's drafts.");
  }
}
export function flushAllDraftWrites(): void {
  for (const flush of draftFlushers) flush();
}

type DraftState = {
  path: string | null;
  /** Text in the editor. */
  value: string;
  /** Last value known to be saved for `path`. */
  observed: string;
  /** This view has edits that are not yet durable. */
  dirty: boolean;
  /** Text another view saved while this one held edits of its own. */
  foreign: string | null;
  recoveries: string[];
  references: readonly DraftImageReference[];
  removedImages: string[];
};

export function useDraft(sessionPath: string | null) {
  const namespaceRef = useRef(getDraftNamespace());
  const namespace = namespaceRef.current;
  const [initialDraft] = useState(() => readTextDraft(sessionPath, namespace, true));
  const [text, setTextState] = useState(initialDraft.text);
  // A requested path is not yet a committed editor lifetime. In particular,
  // feedback can arrive during the first attachment hydration/mount commit.
  // Do not let automatic placement race the initialization effect below.
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const stateRef = useRef<DraftState>({
    path: sessionPath,
    value: text,
    observed: text,
    dirty: false,
    foreign: null,
    recoveries: [],
    references: initialDraft.references,
    removedImages: initialDraft.removedImages,
  });
  const timerRef = useRef<number | null>(null);
  const cancelTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  /**
   * Follow what another view saved. A view that has not edited anything adopts
   * the saved draft. A view with edits of its own keeps them — and remembers
   * the other view's text, so the next write keeps both instead of dropping
   * words the user typed in the other window.
   */
  const syncFromStorage = useCallback(() => {
    const state = stateRef.current;
    if (state.path == null) return;
    const saved = readTextDraft(state.path, namespace, true);
    const stored = saved.text;
    if (stored === state.observed) return;
    state.observed = stored;
    if (!state.dirty) {
      state.value = stored;
      state.references = saved.references;
      state.removedImages = saved.removedImages;
      state.foreign = null;
      setTextState(stored);
      return;
    }
    state.foreign = stored;
  }, [namespace]);

  /**
   * Save this view's pending edit and return what is now durable. A view that
   * never edited holds no snapshot of its own, so it writes nothing: flushing
   * one used to overwrite a draft another view had just saved.
   */
  const writePending = useCallback((): string => {
    const state = stateRef.current;
    if (state.path == null || !state.dirty) return "";
    syncFromStorage();
    if (state.foreign !== null && state.foreign !== state.value) {
      // Two views typed into one conversation. Both texts are unsent work.
      const previous = state.value;
      const saved = readTextDraft(state.path, namespace, true);
      state.value = restoredDraftText(previous, state.foreign);
      const foreignReferences = saved.text === state.foreign ? saved.references : [];
      state.references = state.value === state.foreign ? foreignReferences : [
        ...state.references,
        ...foreignReferences.map(reference => ({ ...reference, start: reference.start + previous.length + 2, end: reference.end + previous.length + 2 })),
      ];
      setTextState(state.value);
    }
    state.foreign = null;
    if (writeDraft(state.path, state.value, namespace, state.recoveries, state.references, state.removedImages)) {
      state.observed = state.value;
      state.dirty = false;
    }
    return state.value;
  }, [namespace, syncFromStorage]);

  const flush = useCallback(() => {
    const state = stateRef.current;
    if (state.path == null) return;
    cancelTimer();
    if (!state.dirty) {
      syncFromStorage();
      return;
    }
    const saved = writePending();
    const key = keyFor(state.path, namespace);
    // An explicit update may reload only after the current text is durable.
    // The convenience autosave path can fail, but this barrier cannot hide it.
    if (key && readTextDraft(state.path, namespace).text !== saved) {
      throw new Error(
        "Could not save the current draft. The app was not reloaded.",
      );
    }
  }, [cancelTimer, namespace, syncFromStorage, writePending]);

  useEffect(() => {
    draftFlushers.add(flush);
    return () => {
      draftFlushers.delete(flush);
    };
  }, [flush]);

  useEffect(() => {
    cancelTimer();
    const state = stateRef.current;
    // Edits made here belong to the session they were made in. A view that
    // never edited carries nothing across, so it cannot rewrite the draft of
    // the session it is leaving.
    if (state.dirty) writePending();
    const saved = readTextDraft(sessionPath, namespace, true);
    const value = saved.text;
    stateRef.current = {
      path: sessionPath,
      value,
      observed: value,
      dirty: false,
      foreign: null,
      recoveries: [],
      references: saved.references,
      removedImages: saved.removedImages,
    };
    setTextState(value);
    setDraftPath(sessionPath);
  }, [cancelTimer, namespace, sessionPath, writePending]);

  useEffect(() => {
    const persist = () => {
      try {
        flush();
      } catch {
        /* keep the live draft; explicit updates report the failure */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") persist();
      else syncFromStorage();
    };
    // Another document on this origin saved a draft. localStorage reports it
    // here, and the same read covers a view that was hidden or unfocused.
    const onStorage = (event: StorageEvent) => {
      const key = keyFor(stateRef.current.path, namespace);
      if (event.key === null || event.key === key) syncFromStorage();
    };
    window.addEventListener("pagehide", persist);
    window.addEventListener("beforeunload", persist);
    window.addEventListener("blur", persist);
    window.addEventListener("focus", syncFromStorage);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pagehide", persist);
      window.removeEventListener("beforeunload", persist);
      window.removeEventListener("blur", persist);
      window.removeEventListener("focus", syncFromStorage);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
      persist();
      cancelTimer();
    };
  }, [cancelTimer, flush, namespace, syncFromStorage]);

  const setText = useCallback(
    (value: string) => {
      const state = stateRef.current;
      state.references = editedImageReferences(state.value, value, state.references);
      state.value = value;
      state.dirty = true;
      setTextState(value);
      cancelTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        writePending();
      }, DEBOUNCE_MS);
    },
    [cancelTimer, writePending],
  );

  const restoreText = useCallback((payload: string, recoveryId: string, current: string, references: readonly DraftImageReference[] = []) => {
    const state = stateRef.current;
    if (!state.path) throw new Error("Open the conversation to restore this message.");
    let saved: SavedTextDraft;
    try { saved = readTextDraft(state.path, namespace); }
    catch { saved = { format: "omp-recovered-draft-v1", text: "", recoveries: [], references: [], removedImages: [] }; }
    if (!saved.recoveries.includes(recoveryId) && !state.recoveries.includes(recoveryId)) {
      const previous = editedImageReferences(state.value, current, state.references);
      const offset = payload ? payload.length + (current ? 2 : 0) : 0;
      setText(recoveredDraftText(payload, current));
      state.references = [...references, ...previous.map(reference => ({ ...reference, start: reference.start + offset, end: reference.end + offset }))];
      state.recoveries.push(recoveryId);
    }
    flush();
    return state.value;
  }, [flush, namespace, setText]);

  const remapReferences = useCallback((imageIds: readonly (string | undefined)[], removedId?: string) => {
    const state = stateRef.current;
    const updated = updateDraftImageReferences(state.value, state.references, imageIds);
    setText(updated.text);
    state.references = updated.references;
    if (removedId && !state.removedImages.includes(removedId)) state.removedImages.push(removedId);
    flush();
    return state.value;
  }, [flush, setText]);
  /**
   * Clear the draft a send submitted. `expected` is the text that was sent:
   * text written since survives, and the text this view should now show is
   * returned.
   */
  const clearDraft = useCallback(
    (expected: string) => {
      const state = stateRef.current;
      if (state.path == null) return state.value;
      const stored = readDraft(state.path, namespace);
      const cleanup = submittedDraftCleanup(state, expected, stored);
      // A storage event may have adopted a newer draft without changing the
      // composer's local edit revision. Keep its storage AND pending autosave.
      if (cleanup === "keep-current") return state.value;
      cancelTimer();
      // Send inside the 300ms autosave window can leave "hello" saved while
      // "hello!" was submitted. Clear that older autosave only when no foreign
      // draft was observed; a newly observed value is not proof of ownership.
      if (cleanup === "remove-submitted")
        removeDraft(state.path, namespace, stored);
      const saved = readTextDraft(state.path, namespace, true);
      const remaining = saved.text;
      stateRef.current = {
        path: state.path,
        value: remaining,
        observed: remaining,
        dirty: false,
        foreign: null,
        recoveries: [],
        references: saved.references,
        removedImages: saved.removedImages,
      };
      setTextState(remaining);
      return remaining;
    },
    [cancelTimer, namespace],
  );

  return { text, setText, clearDraft, draftPath, flush, restoreText, remapReferences };
}

export { readDraft };
