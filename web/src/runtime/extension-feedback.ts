import { isJsonObject } from "../domain/protocol";

export interface ExtensionEditorDraft { id: string; text: string }
export interface ExtensionNotice { id: string; message: string; severity: "info" | "warning" | "error" }
export interface ExtensionWidget { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }
export interface ExtensionFeedback {
  notices: ExtensionNotice[];
  statuses: { key: string; text: string }[];
  widgets: ExtensionWidget[];
  editorDraft: ExtensionEditorDraft | null;
}
export const EMPTY_EXTENSION_FEEDBACK: ExtensionFeedback = { notices: [], statuses: [], widgets: [], editorDraft: null };
const INTERNAL = /^(?:omp-pulse:|omp-pulse-out:)/;
const MAX_TEXT = 32_768;
const MAX_NOTICES = 24;
const MAX_DRAFT = 65_536;
const STORAGE_PREFIX = "omp-extension-drafts:";
type DraftInbox = { path: string; pending: ExtensionEditorDraft | null; seen: string[] };
// A single bounded record per credential, including consumed IDs. Keeping the
// latest consumed ID prevents an authoritative replay resurrecting sent text.
const memory = new Map<string, DraftInbox[]>();
function inboxes(namespace: string): DraftInbox[] {
  const cached = memory.get(namespace);
  if (cached) return cached;
  let rows: DraftInbox[] = [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + namespace) ?? "[]");
    if (Array.isArray(raw)) rows = raw.filter(isJsonObject).filter(row => typeof row.path === "string").slice(-32).map(row => ({
      path: String(row.path),
      pending: isJsonObject(row.pending) && typeof row.pending.id === "string" && typeof row.pending.text === "string" && row.pending.text.length <= MAX_DRAFT
        ? { id: row.pending.id, text: row.pending.text } : null,
      seen: Array.isArray(row.seen) ? row.seen.filter((id): id is string => typeof id === "string").slice(-128) : [],
    }));
  } catch { /* storage can be unavailable; retain this view's inbox */ }
  memory.set(namespace, rows);
  if (memory.size > 4) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  return rows;
}
function save(namespace: string, row: DraftInbox, durable = false): void {
  const rows = [...inboxes(namespace).filter(item => item.path !== row.path), row].slice(-32);
  try { localStorage.setItem(STORAGE_PREFIX + namespace, JSON.stringify(rows)); }
  catch (error) { if (durable) throw error; }
  memory.set(namespace, rows);
}
export function readExtensionDraft(namespace: string, path: string): ExtensionEditorDraft | null {
  return inboxes(namespace).find(row => row.path === path)?.pending ?? null;
}
/** Repair exports content only, never editor IDs or consumed/replay authority. */
export function readExtensionDraftsForPairingRepair(namespace: string): { path: string; text: string }[] {
  const cached = memory.get(namespace);
  const rows: unknown = cached ?? JSON.parse(localStorage.getItem(STORAGE_PREFIX + namespace) ?? "[]");
  if (!Array.isArray(rows)) throw new Error("Saved prepared drafts couldn't be read. Try again.");
  const drafts: { path: string; text: string }[] = [];
  for (const row of rows) {
    if (!isJsonObject(row) || typeof row.path !== "string") {
      throw new Error("Saved prepared drafts couldn't be read. Try again.");
    }
    if (row.pending === null) continue;
    if (!isJsonObject(row.pending) || typeof row.pending.text !== "string") {
      throw new Error("Saved prepared drafts couldn't be read. Try again.");
    }
    drafts.push({ path: row.path, text: row.pending.text });
  }
  return drafts;
}
export function consumeExtensionDraft(namespace: string, path: string, id: string): void {
  const row = inboxes(namespace).find(item => item.path === path);
  if (row?.pending?.id === id) save(namespace, { ...row, pending: null }, true);
}
export function clearExtensionDrafts(namespace: string): void {
  memory.delete(namespace);
  localStorage.removeItem(STORAGE_PREFIX + namespace);
}
function receiveDraft(namespace: string, path: string, draft: ExtensionEditorDraft, durable = false): ExtensionEditorDraft | null {
  const row = inboxes(namespace).find(item => item.path === path) ?? { path, pending: null, seen: [] };
  if (row.seen.includes(draft.id)) return row.pending;
  save(namespace, { path, pending: draft, seen: [...row.seen, draft.id].slice(-128) }, durable);
  return draft;
}
/** Explicit local preparation must not claim success after a failed durable write. */
export function prepareExtensionDraft(namespace: string, path: string, text: string): ExtensionEditorDraft {
  if (text.length > MAX_DRAFT) throw new Error("Prepared text is too large. Use fewer notes.");
  const draft = { id: crypto.randomUUID(), text };
  receiveDraft(namespace, path, draft, true);
  return draft;
}
function plain(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(0, MAX_TEXT);
}
export function reduceExtensionFeedback(state: ExtensionFeedback, raw: unknown, namespace: string, path: string): ExtensionFeedback {
  if (!isJsonObject(raw)) return state;
  if (raw.type === "extension_error" || raw.type === "command_output") {
    // New daemons retain the same notice for reconnect/catch-up. Old ones
    // still report the native fields; rendering them must not stop the turn.
    const message = raw.type === "command_output" ? raw.text
      : typeof raw.extensionPath === "string" && typeof raw.error === "string"
        ? `Extension ${raw.extensionPath}${typeof raw.event === "string" && raw.event ? ` (${raw.event})` : ""}: ${raw.error}`
        : undefined;
    if (typeof message !== "string") return state;
    return reduceExtensionFeedback(state, {
      type: "extension_ui_request", method: "notify", id: typeof raw.feedbackId === "string" ? raw.feedbackId : crypto.randomUUID(),
      message, notifyType: raw.type === "extension_error" ? "error" : "info",
    }, namespace, path);
  }
  if (raw.type === "extension_ui_snapshot") {
    if (!Array.isArray(raw.requests)) return state;
    return raw.requests.slice(-128).reduce<ExtensionFeedback>((next, request) => reduceExtensionFeedback(next, request, namespace, path), {
      ...EMPTY_EXTENSION_FEEDBACK, editorDraft: readExtensionDraft(namespace, path),
    });
  }
  if (raw.type !== "extension_ui_request") return state;
  const id = typeof raw.id === "string" ? raw.id : typeof raw.id === "number" ? String(raw.id) : "";
  switch (raw.method) {
    case "notify": {
      if (!id || typeof raw.message !== "string" || INTERNAL.test(raw.message)) return state;
      const notice: ExtensionNotice = { id, message: plain(raw.message), severity: raw.notifyType === "warning" || raw.notifyType === "error" ? raw.notifyType : "info" };
      return { ...state, notices: [...state.notices.filter(item => item.id !== id), notice].slice(-MAX_NOTICES) };
    }
    case "setStatus": {
      if (typeof raw.statusKey !== "string" || INTERNAL.test(raw.statusKey)) return state;
      const statuses = state.statuses.filter(item => item.key !== raw.statusKey);
      if (typeof raw.statusText === "string" && raw.statusText) statuses.push({ key: raw.statusKey, text: plain(raw.statusText) });
      return { ...state, statuses: statuses.slice(-24) };
    }
    case "setWidget": {
      if (typeof raw.widgetKey !== "string" || INTERNAL.test(raw.widgetKey)) return state;
      const widgets = state.widgets.filter(item => item.key !== raw.widgetKey);
      if (Array.isArray(raw.widgetLines) && raw.widgetLines.every(line => typeof line === "string")) {
        const lines: string[] = [];
        let remaining = MAX_TEXT;
        for (const line of raw.widgetLines.slice(0, 256)) {
          const text = plain(String(line)).slice(0, remaining);
          lines.push(text); remaining -= text.length;
          if (remaining <= 0) break;
        }
        if (lines.length) widgets.push({ key: raw.widgetKey, lines, placement: raw.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor" });
      }
      return { ...state, widgets: widgets.slice(-16) };
    }
    case "set_editor_text":
      if (!id || typeof raw.text !== "string" || raw.text.length > MAX_DRAFT) return state;
      return { ...state, editorDraft: receiveDraft(namespace, path, { id, text: raw.text }) };
    default: return state;
  }
}

/** Recover missed immutable notices without rolling back newer live surfaces. */
export function recoverExtensionNotices(state: ExtensionFeedback, raw: unknown, before: ExtensionFeedback, namespace: string, path: string): ExtensionFeedback {
  if (!isJsonObject(raw) || raw.type !== "extension_ui_snapshot" || !Array.isArray(raw.requests)) return state;
  const previous = new Map(before.notices.map(notice => [notice.id, notice]));
  const currentIds = new Set(state.notices.map(notice => notice.id));
  const newer = state.notices.filter(notice => previous.get(notice.id) !== notice);
  const protectedIds = new Set(newer.map(notice => notice.id));
  // Preserve both live arrivals and removals made while the snapshot waited.
  for (const notice of before.notices) if (!currentIds.has(notice.id)) protectedIds.add(notice.id);
  const requests = raw.requests.slice(-128).filter(request => isJsonObject(request)
    && request.type === "extension_ui_request" && request.method === "notify"
    && (typeof request.id === "string" || typeof request.id === "number")
    && !protectedIds.has(String(request.id)));
  const recovered = reduceExtensionFeedback(EMPTY_EXTENSION_FEEDBACK, { type: "extension_ui_snapshot", requests }, namespace, path);
  // Snapshot order precedes concurrent arrivals. Prepending only missed IDs
  // would discard the recovered failure whenever the old inbox was already full.
  return { ...state, notices: [...recovered.notices, ...newer].slice(-MAX_NOTICES) };
}
