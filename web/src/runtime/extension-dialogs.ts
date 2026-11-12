// Dialogs a phone-driven omp child raises mid-turn (`extension_ui_request`):
// hook and extension prompts, tool approvals, and the agent's `ask` tool.
//
// The daemon keeps the authoritative list and replays every still-pending
// request when a socket attaches, so this reducer only has to be idempotent:
// a request id seen again replaces itself, and an id the phone already
// answered (or omp cancelled) never comes back, even when a replay raced the
// answer. Pure and import-free so a plain Node test can exercise it.

export type ExtensionDialogMethod = "select" | "confirm" | "input" | "editor" | "ask";

export interface ExtensionDialogOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface ExtensionAskQuestion {
  id: string;
  question: string;
  header?: string;
  options: ExtensionDialogOption[];
  multi: boolean;
  /** Index into `options` the agent recommends. */
  recommended?: number;
}

export interface ExtensionDialog {
  id: string;
  method: ExtensionDialogMethod;
  /** Heading for select/confirm/input/editor; empty for `ask`. */
  title: string;
  /** Confirm body. */
  message?: string;
  /** Select options, labels exactly as omp expects them back. */
  options?: ExtensionDialogOption[];
  placeholder?: string;
  prefill?: string;
  questions?: ExtensionAskQuestion[];
  /** Daemon transport evidence only; OMP does not acknowledge callback acceptance. */
  delivery?: "sending" | "handoff" | "uncertain";
  /** Local epoch ms after which omp gives up on the dialog; null when untimed. */
  expiresAt: number | null;
}

export interface ExtensionDialogState {
  /** Open dialogs, oldest first. */
  pending: readonly ExtensionDialog[];
  /** Ids answered here or cancelled by omp: never shown again. Bounded. */
  closed: readonly string[];
}

export const EMPTY_EXTENSION_DIALOGS: ExtensionDialogState = { pending: [], closed: [] };

/** How many closed ids are remembered: far more than can be in flight. */
const CLOSED_CAP = 64;

/** One reply body for `/api/panes/answer` (`response`): the field omp reads. */
export type ExtensionDialogResponse =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true }
  | { answers: ExtensionAskAnswer[] };

export interface ExtensionAskAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseOptions(raw: unknown, details?: unknown): ExtensionDialogOption[] {
  if (!Array.isArray(raw)) return [];
  const extra = Array.isArray(details) ? details : [];
  const out: ExtensionDialogOption[] = [];
  raw.forEach((entry, index) => {
    const obj = record(entry);
    const label = typeof entry === "string" ? entry : text(obj?.label);
    if (label === undefined) return;
    const detail = record(extra[index]);
    const description = text(obj?.description) ?? text(detail?.description);
    const preview = text(obj?.preview) ?? text(detail?.preview);
    out.push({ label, ...(description?.trim() ? { description: description.trim() } : {}), ...(preview ? { preview } : {}) });
  });
  return out;
}

function parseQuestions(raw: unknown): ExtensionAskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtensionAskQuestion[] = [];
  for (const entry of raw) {
    const obj = record(entry);
    const id = text(obj?.id);
    const question = text(obj?.question);
    if (!obj || id === undefined || question === undefined) return [];
    const options = parseOptions(obj.options);
    const recommended = typeof obj.recommended === "number" && Number.isInteger(obj.recommended)
      && obj.recommended >= 0 && obj.recommended < options.length ? obj.recommended : undefined;
    const header = text(obj.header)?.trim();
    out.push({
      id,
      question,
      ...(header ? { header } : {}),
      options,
      multi: obj.multi === true,
      ...(recommended !== undefined ? { recommended } : {}),
    });
  }
  return out;
}

/**
 * The dialog a blocking request describes, or null for anything else
 * (fire-and-forget methods, `cancel`, malformed frames, or a request whose
 * time ran out before it reached the phone).
 */
export function parseExtensionDialog(raw: unknown, now: number): ExtensionDialog | null {
  const obj = record(raw);
  const id = text(obj?.id);
  const method = text(obj?.method);
  if (!obj || !id || !method) return null;
  const timeout = typeof obj.timeout === "number" && Number.isFinite(obj.timeout) ? obj.timeout : null;
  // A replay reports the time left; nothing left means omp is cancelling it.
  if (timeout !== null && timeout <= 0) return null;
  const delivery: ExtensionDialog["delivery"] = obj.pulseDelivery === "sending" || obj.pulseDelivery === "handoff" || obj.pulseDelivery === "uncertain" ? obj.pulseDelivery : undefined;
  const base = { id, title: text(obj.title)?.trim() ?? "", expiresAt: timeout === null ? null : now + timeout, ...(delivery ? { delivery } : {}) };
  switch (method) {
    case "select": {
      const options = parseOptions(obj.options, obj.optionDetails);
      return options.length ? { ...base, method, options } : null;
    }
    case "confirm":
      return { ...base, method, message: text(obj.message)?.trim() || undefined };
    case "input":
      return { ...base, method, placeholder: text(obj.placeholder) || undefined };
    case "editor":
      return { ...base, method, prefill: text(obj.prefill) ?? "" };
    case "ask": {
      const questions = parseQuestions(obj.questions);
      return questions.length ? { ...base, method, questions } : null;
    }
    default:
      return null;
  }
}

function withClosed(closed: readonly string[], id: string): readonly string[] {
  if (closed.includes(id)) return closed;
  const next = [...closed, id];
  return next.length > CLOSED_CAP ? next.slice(next.length - CLOSED_CAP) : next;
}

/** Apply one `extension_ui_request` frame (live or replayed). */
export function reduceExtensionUiRequest(
  state: ExtensionDialogState,
  raw: unknown,
  now: number,
): ExtensionDialogState {
  const obj = record(raw);
  if (obj?.method === "cancel") {
    const target = text(obj.targetId);
    return target ? closeExtensionDialog(state, target) : state;
  }
  const dialog = parseExtensionDialog(raw, now);
  if (!dialog || state.closed.includes(dialog.id)) return state;
  const index = state.pending.findIndex((entry) => entry.id === dialog.id);
  if (index < 0) return { ...state, pending: [...state.pending, dialog] };
  const pending = state.pending.slice();
  pending[index] = dialog;
  return { ...state, pending };
}

/**
 * Replace the daemon's pending set, except ids changed while the read was in
 * flight. Keep surviving ids stable: the sheet's retained answers belong to
 * their question, not to a snapshot arrival. Only authoritative absence closes
 * a question; reconnect's temporary empty list does not.
 */
export function reduceExtensionDialogSnapshot(
  state: ExtensionDialogState,
  raw: unknown,
  now: number,
  before: ExtensionDialogState = state,
): ExtensionDialogState {
  const snapshot = record(raw);
  if (snapshot?.type !== "extension_dialog_snapshot" || !Array.isArray(snapshot.requests)) return state;
  const previous = new Map(before.pending.map((dialog) => [dialog.id, dialog]));
  const changed = state.pending.filter((dialog) => previous.get(dialog.id) !== dialog);
  const changedIds = new Set(changed.map((dialog) => dialog.id));
  let next: ExtensionDialogState = { pending: [], closed: state.closed };
  for (const request of snapshot.requests) next = reduceExtensionUiRequest(next, request, now);
  const present = new Set(next.pending.map((dialog) => dialog.id));
  for (const dialog of before.pending) {
    if (!present.has(dialog.id) && !changedIds.has(dialog.id)) next = closeExtensionDialog(next, dialog.id);
  }
  return {
    closed: next.closed,
    pending: [
      ...next.pending.map((dialog) => {
        const current = state.pending.find((entry) => entry.id === dialog.id);
        return changedIds.has(dialog.id) && current ? current : dialog;
      }),
      ...changed.filter((dialog) => !present.has(dialog.id)),
    ],
  };
}

/** Apply a daemon pipe-write acknowledgement without closing the question. */
export function markExtensionDialogDelivery(state: ExtensionDialogState, id: string, delivery: ExtensionDialog["delivery"]): ExtensionDialogState {
  if (!delivery || !state.pending.some((entry) => entry.id === id)) return state;
  return { ...state, pending: state.pending.map((entry) => entry.id === id ? { ...entry, delivery } : entry) };
}

/** OMP cancelled the request, its ask tool ended, or the turn ended. */
export function closeExtensionDialog(state: ExtensionDialogState, id: string): ExtensionDialogState {
  const pending = state.pending.filter((entry) => entry.id !== id);
  const closed = withClosed(state.closed, id);
  if (pending.length === state.pending.length && closed === state.closed) return state;
  return { pending, closed };
}

/**
 * Forget every open dialog (the turn ended, or the socket dropped and the
 * daemon will replay what is still open). Closed ids are kept so a stale
 * replay cannot resurrect an answered dialog.
 */
export function clearExtensionDialogs(state: ExtensionDialogState): ExtensionDialogState {
  return state.pending.length ? { ...state, pending: [] } : state;
}

/** Drop dialogs whose time ran out; omp has already answered them itself. */
export function expireExtensionDialogs(state: ExtensionDialogState, now: number): ExtensionDialogState {
  let next = state;
  for (const dialog of state.pending) {
    if (dialog.expiresAt !== null && dialog.expiresAt <= now) next = closeExtensionDialog(next, dialog.id);
  }
  return next;
}

/** What the phone picked for each question of an `ask`, keyed by question id. */
export interface AskDraft {
  selected: Readonly<Record<string, readonly string[]>>;
  custom: Readonly<Record<string, string>>;
}

/** Toggle one option: single-select replaces the pick and clears typed text. */
export function toggleAskOption(draft: AskDraft, question: ExtensionAskQuestion, label: string): AskDraft {
  const current = draft.selected[question.id] ?? [];
  if (!question.multi) {
    const nextSelected = current.length === 1 && current[0] === label ? [] : [label];
    return { selected: { ...draft.selected, [question.id]: nextSelected }, custom: { ...draft.custom, [question.id]: "" } };
  }
  const next = current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label];
  return { ...draft, selected: { ...draft.selected, [question.id]: next } };
}

/** Typed text: on a single-select question it replaces the picked option. */
export function setAskCustom(draft: AskDraft, question: ExtensionAskQuestion, value: string): AskDraft {
  const selected = !question.multi && value.trim() ? { ...draft.selected, [question.id]: [] } : draft.selected;
  return { selected, custom: { ...draft.custom, [question.id]: value } };
}

/** Multi-select explicitly permits none; single-choice still needs an answer. */
export function askDraftComplete(dialog: ExtensionDialog, draft: AskDraft): boolean {
  return (dialog.questions ?? []).every(
    (question) => question.multi || (draft.selected[question.id]?.length ?? 0) > 0 || Boolean(draft.custom[question.id]?.trim()),
  );
}

/** The `answers` reply omp validates: every question, in order. */
export function askResponse(dialog: ExtensionDialog, draft: AskDraft): ExtensionDialogResponse {
  return {
    answers: (dialog.questions ?? []).map((question) => {
      const labels = new Set(question.options.map((option) => option.label));
      const custom = draft.custom[question.id]?.trim();
      const selected = (draft.selected[question.id] ?? []).filter((label) => labels.has(label));
      const selectedOptions = question.multi ? selected : custom ? [] : selected.slice(0, 1);
      return custom ? { id: question.id, selectedOptions, customInput: custom } : { id: question.id, selectedOptions };
    }),
  };
}
