import { isReviewNote, type ReviewNote } from "../domain/review-notes";

export interface ReviewNotesScope { namespace: string; sessionPath: string }
export const REVIEW_NOTES_MAX_RECORDS = 100;
export const REVIEW_NOTES_MAX_BYTES = 2 * 1024 * 1024;
const STORAGE_PREFIX = "omp-review-notes-v1:";
type StoredEntry = { sessionPath: string; note: ReviewNote };
type StoredNotes = { version: 1; entries: StoredEntry[] };

function storageKey(namespace: string): string {
  if (!namespace || namespace.length > 16_384)
    throw new Error("Review notes require a valid device credential scope.");
  return STORAGE_PREFIX + namespace;
}
function validateScope(scope: ReviewNotesScope): void {
  storageKey(scope.namespace);
  if (!scope.sessionPath || scope.sessionPath.length > 16_384)
    throw new Error("Review notes require a valid conversation path.");
}
function readEntries(namespace: string): StoredEntry[] {
  const key = storageKey(namespace);
  let raw: string | null;
  try { raw = localStorage.getItem(key); }
  catch (cause) { throw new Error("Could not read saved review notes. Device storage is unavailable.", { cause }); }
  if (raw === null) return [];
  if (new TextEncoder().encode(raw).byteLength > REVIEW_NOTES_MAX_BYTES)
    throw new Error("Saved review notes exceed the 2 MiB storage limit. Clear this device's offline data to remove them.");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (cause) { throw new Error("Saved review notes are malformed. They were not overwritten. Clear this device's offline data to remove them.", { cause }); }
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1
    || !("entries" in value) || !Array.isArray(value.entries) || value.entries.length > REVIEW_NOTES_MAX_RECORDS)
    throw new Error("Saved review notes are malformed. They were not overwritten. Clear this device's offline data to remove them.");
  const entries: StoredEntry[] = [];
  const ids = new Map<string, Set<string>>();
  for (const entry of value.entries) {
    if (typeof entry !== "object" || entry === null || !("sessionPath" in entry)
      || typeof entry.sessionPath !== "string" || !entry.sessionPath || entry.sessionPath.length > 16_384
      || !("note" in entry) || !isReviewNote(entry.note))
      throw new Error("Saved review notes are malformed. They were not overwritten. Clear this device's offline data to remove them.");
    const sessionIds = ids.get(entry.sessionPath) ?? new Set<string>();
    if (sessionIds.has(entry.note.id))
      throw new Error("Saved review notes contain duplicate IDs. They were not overwritten. Clear this device's offline data to remove them.");
    sessionIds.add(entry.note.id); ids.set(entry.sessionPath, sessionIds);
    entries.push({ sessionPath: entry.sessionPath, note: entry.note });
  }
  return entries;
}
function persistEntries(namespace: string, entries: StoredEntry[]): void {
  if (entries.length > REVIEW_NOTES_MAX_RECORDS)
    throw new Error("This device has 100 review notes for this credential. Remove a note before saving another.");
  let raw: string;
  try { raw = JSON.stringify({ version: 1, entries } satisfies StoredNotes); }
  catch (cause) { throw new Error("Could not encode this review note. The previous saved notes are unchanged.", { cause }); }
  if (new TextEncoder().encode(raw).byteLength > REVIEW_NOTES_MAX_BYTES)
    throw new Error("Review notes and captured patches exceed the 2 MiB storage limit for this credential. Remove notes or use smaller changes; nothing was truncated.");
  try { localStorage.setItem(storageKey(namespace), raw); }
  catch (cause) { throw new Error("Could not save review notes. Device storage may be full or unavailable; the previous saved notes are unchanged.", { cause }); }
}

/** No memory cache: a remount, reload, or another view reads durable state. */
export function readReviewNotes(scope: ReviewNotesScope): ReviewNote[] {
  validateScope(scope);
  return readEntries(scope.namespace).filter(entry => entry.sessionPath === scope.sessionPath).map(entry => entry.note);
}
export function saveReviewNote(scope: ReviewNotesScope, note: ReviewNote): ReviewNote[] {
  validateScope(scope);
  if (!isReviewNote(note))
    throw new Error("The review note or captured line is invalid. Notes must contain text (at most 32,768 characters) and an exact captured change.");
  const entries = readEntries(scope.namespace);
  const index = entries.findIndex(entry => entry.sessionPath === scope.sessionPath && entry.note.id === note.id);
  if (index < 0) entries.push({ sessionPath: scope.sessionPath, note });
  else entries[index] = { sessionPath: scope.sessionPath, note };
  persistEntries(scope.namespace, entries);
  return readReviewNotes(scope);
}
export function removeReviewNote(scope: ReviewNotesScope, id: string): ReviewNote[] {
  validateScope(scope);
  const entries = readEntries(scope.namespace);
  const kept = entries.filter(entry => entry.sessionPath !== scope.sessionPath || entry.note.id !== id);
  if (kept.length !== entries.length) persistEntries(scope.namespace, kept);
  return readReviewNotes(scope);
}
export function clearReviewNotes(namespace: string): void {
  const key = storageKey(namespace);
  try {
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error("Storage retained review notes.");
  } catch (cause) { throw new Error("Could not clear this device credential's saved review notes.", { cause }); }
}
