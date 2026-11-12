import { isRecoveredResponse, ResponseItemRecovery } from "../domain/response-item-provenance";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { OmpActivity, OmpProjectSummary, OmpSessionAuthority, OmpSessionSummary, OmpTurnState } from "../domain/protocol";
import { onPhoneClock, parseOmpActivity, parseSessionAuthority, sessionTurn } from "../domain/protocol";
import { applyToolResults, mergeToolParts, type UiAgentStatus, type UiContextBoundary, type UiMessage, type UiToolResult } from "../domain/messages";
import { contextPercent, sessionCost } from "../domain/usage-meter";
import type { CompactingStatus, RetryStatus } from "../domain/run-status";
import { parseModelFallback, type ModelFallback } from "../domain/model-fallback";
import { DEFAULT_SEND_MODE, parseSendMode, type SendMode } from "../domain/send-mode";
import { EMPTY_EXTENSION_DIALOGS, type ExtensionDialogState } from "./extension-dialogs";
import { EMPTY_EXTENSION_FEEDBACK, type ExtensionFeedback } from "./extension-feedback";
import type { CollabAnswerState } from "./collab-answer";
import type { GoalSnapshot } from "./goal-state";
import type { PlanModeState } from "./plan-state";

/** Carry presentation ownership only while its message is held in this session.
 * Positional fallback ids and equal prose cannot identify a response. Incoming
 * history hints are ignored unless a current owner supplies reliable identity.
 */
function inheritLiveMarkdown(messages: readonly UiMessage[], owners: readonly (UiMessage | null)[]): UiMessage[] {
  const ids = new Set<string>();
  const responses = new Set<string>();
  for (const owner of owners) {
    if (owner?.role !== "assistant" || !owner.eagerMarkdown) continue;
    if (owner.id?.trim() && !/^entry:\d+$/.test(owner.id)) ids.add(owner.id);
    if (owner.responseKey?.trim()) responses.add(owner.responseKey);
  }
  return messages.map((message) => {
    const eager = message.role === "assistant" && (
      ids.has(message.id) || (!!message.responseKey && responses.has(message.responseKey))
    );
    if (eager) return message.eagerMarkdown ? message : { ...message, eagerMarkdown: true };
    if (message.eagerMarkdown === undefined) return message;
    const { eagerMarkdown: _eagerMarkdown, ...history } = message;
    return history;
  });
}

export type ConnectionState =
  | "closed"
  | "connecting"
  | "open"
  | "reconnecting"
  | "offline"
  | "error";
export interface CollabRequest {
  reqId: number;
  pulseQuestionToken: string;
  kind: "text" | "editor" | "choice" | "confirm";
  prompt: string;
  options?: { value: string; label: string; description?: string }[];
  placeholder?: string;
  initialValue?: string;
  selectionMarker?: "radio" | "checkbox";
  checkedIndices?: number[];
  markableCount?: number;
  helpText?: string;
}

export interface SessionModel {
  model?: string;
  provider?: string;
  /** The configured selector, including Auto; never a per-turn resolution. */
  thinkingLevel?: string;
  effectiveThinkingLevel?: string;
  modelFallback?: ModelFallback | null;
  ctxPercent?: number | null;
  contextMeasuredAfter?: number;
  /** The model's context window in tokens, when `get_state` reports one. */
  contextWindow?: number;
  fastMode?: boolean;
  /** What omp actually applies to this model; can be false while `fastMode` is true (provider fell back). */
  fastModeActive?: boolean;
}

const CONFIGURATION_FIELDS = ["thinkingLevel", "effectiveThinkingLevel", "modelFallback", "ctxPercent"] as const;
export type SessionModelSource = "file" | "live";
/** Per-control ownership, retired by canonical owner release/replacement or a session/branch reset. */
export type SessionModelProvenance = Partial<Record<typeof CONFIGURATION_FIELDS[number], SessionModelSource>>;

function sameModelBinding(a: OmpSessionAuthority, b: OmpSessionAuthority): boolean {
  return a.daemonInstanceId === b.daemonInstanceId && a.bindingEpoch === b.bindingEpoch
    && a.owner.kind === b.owner.kind && a.owner.pid === b.owner.pid
    && a.owner.processStart === b.owner.processStart && a.owner.peerId === b.owner.peerId
    && a.owner.roomId === b.owner.roomId;
}

/** Missing peek fields must not erase the last model during offline/idle viewing. */
export function parseSessionModel(source: unknown): Partial<SessionModel> {
  if (!source || typeof source !== "object") return {};
  const data = source as Record<string, unknown>;
  const out: Partial<SessionModel> = {};
  if (typeof data.model === "string" && data.model.trim()) {
    out.model = data.model.trim();
    // A bare name ("claude-opus-5-5") says nothing about the provider. Leaving
    // it unset (not "") lets a provider learned elsewhere survive the merge;
    // "" used to erase it, so the sheet could not tell which of several
    // providers' identical models was the one in use.
    const slash = out.model.indexOf("/");
    if (slash > 0) out.provider = out.model.slice(0, slash);
  }
  else if (data.model && typeof data.model === "object") {
    const model = data.model as Record<string, unknown>;
    const id = model.id ?? model.modelId ?? model.name;
    if (typeof id === "string" && id.trim()) out.model = id.trim();
    if (typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0) out.contextWindow = model.contextWindow;
    if (out.model) out.provider = typeof model.provider === "string" ? model.provider : "";
  }
  if (typeof data.thinkingLevel === "string") {
    out.effectiveThinkingLevel = data.thinkingLevel;
    out.thinkingLevel = data.thinkingLevel;
  }
  if (typeof data.configuredThinkingLevel === "string") out.thinkingLevel = data.configuredThinkingLevel;
  // A pending whole-file fold has not resolved the active branch. Neither its
  // configured nor effective tail effort is authoritative yet.
  if (data.source === "file" && data.sessionModelPending === true) {
    delete out.thinkingLevel;
    delete out.effectiveThinkingLevel;
  }
  const fallback = parseModelFallback(data.modelFallback);
  if (fallback || data.modelFallback === null) out.modelFallback = fallback;
  if (data.source === "file" && data.sessionModelPending === true) delete out.modelFallback;
  const context = data.contextUsage;
  const percent = context && typeof context === "object" ? (context as Record<string, unknown>).percent : undefined;
  if (typeof percent === "number" && Number.isFinite(percent)) {
    out.ctxPercent = percent;
    if (typeof data.contextMeasuredAfter === "number" && Number.isFinite(data.contextMeasuredAfter))
      out.contextMeasuredAfter = data.contextMeasuredAfter;
  } else if (data.source === "file" && data.sessionModelPending !== true) {
    out.ctxPercent = null;
  }
  if (typeof data.fastModeEnabled === "boolean") out.fastMode = data.fastModeEnabled;
  if (typeof data.fastModeActive === "boolean") out.fastModeActive = data.fastModeActive;
  return out;
}

/**
 * Passive native reads update effective effort without pinning Auto.
 * Completed file metadata may refresh file-owned controls (including known
 * null fallback), but cannot replace a newer live receipt. Callers pass the
 * store's provenance and commit the result with its actual file/live source.
 * Omitted provenance conservatively treats already-known controls as live.
 */
export function parsePassiveSessionModel(
  source: unknown,
  known: SessionModel | null | undefined,
  provenance: SessionModelProvenance = {},
): Partial<SessionModel> {
  const parsed = parseSessionModel(source);
  if (!known || !source || typeof source !== "object") return parsed;
  // Native RPC state reports effective effort only. A refresh cannot pin Auto;
  // explicit thinking_level_changed receipts remain responsible for leaving it.
  if (known.thinkingLevel === "auto" && !("configuredThinkingLevel" in source)) delete parsed.thinkingLevel;
  if (!("source" in source) || source.source !== "file") return parsed;
  if (known.model !== undefined) {
    delete parsed.model;
    delete parsed.provider;
  }
  for (const field of CONFIGURATION_FIELDS) {
    if (known[field] !== undefined && provenance[field] !== "file") delete parsed[field];
  }
  if (!("ctxPercent" in parsed)) delete parsed.contextMeasuredAfter;
  return parsed;
}

const WINDOW_KEY = "omp-model-context-windows";
let windowCache: Map<string, number> | null = null;
function windowKey(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1).toLowerCase();
}
function windows(): Map<string, number> {
  if (windowCache) return windowCache;
  windowCache = new Map();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(WINDOW_KEY) ?? "{}");
    if (stored && typeof stored === "object") {
      for (const [key, value] of Object.entries(stored)) if (typeof value === "number" && value > 0) windowCache.set(key, value);
    }
  } catch {
    // Private WebViews can refuse storage; the cache then lives for the session.
  }
  return windowCache;
}
/**
 * A model's context window, learned once and kept: an idle session's state
 * carries only the model NAME, and the window is what turns a turn's prompt
 * size into "how full is this conversation". Learned from get_state's model
 * object or the model catalogue, whichever the phone sees first.
 */
export function rememberContextWindows(models: readonly { id: string; contextWindow?: number }[]): void {
  const known = windows();
  let changed = false;
  for (const model of models) {
    if (typeof model.contextWindow !== "number" || !(model.contextWindow > 0)) continue;
    const key = windowKey(model.id);
    if (known.get(key) !== model.contextWindow) {
      known.set(key, model.contextWindow);
      changed = true;
    }
  }
  if (!changed) return;
  try {
    localStorage.setItem(WINDOW_KEY, JSON.stringify(Object.fromEntries(known)));
  } catch {
    // Convenience cache only.
  }
}
export function contextWindowFor(model: string | undefined): number | undefined {
  return model ? windows().get(windowKey(model)) : undefined;
}

const SEND_MODE_KEY = "omp-send-mode";
/** The last Steer/Queue choice, kept across reloads like the TUI's habit is. */
function storedSendMode(): SendMode {
  try {
    return parseSendMode(localStorage.getItem(SEND_MODE_KEY));
  } catch {
    // Private WebViews can refuse storage; the default (steer) still works.
    return DEFAULT_SEND_MODE;
  }
}

export interface OmpSessionState {
  sessions: OmpSessionSummary[];
  /** Accepted daemon records, fenced by daemon namespace and per-session revision. */
  sessionAuthorities: Record<string, OmpSessionAuthority>;
  /** Legacy projections used only when no canonical record exists. */
  legacySessionTurns: Record<string, { turn: OmpTurnState; activity: OmpActivity | null; sequence: number }>;
  sessionProjects: OmpProjectSummary[];
  sessionsNextCursor: string | null;
  sessionsScope: string;
  sessionsLoadingMore: boolean;
  /** Wall time of the last successful listing fetch. Drives the "updated Xs
   * ago" freshness note: when the poll stalls, the list must SAY so instead
   * of silently showing yesterday's running flags. */
  sessionsUpdatedAt: number | null;
  /** Composer choice for a message sent while a turn runs. Device-wide, not per session. */
  sendMode: SendMode;
  sessionPath: string | null;
  sessionModel: SessionModel | null;
  sessionModelProvenance: SessionModelProvenance;
  /** Binding that supplied live controls; canonical release/replacement retires their protection. */
  sessionModelAuthority: OmpSessionAuthority | null;
  contextBoundary: UiContextBoundary | null;
  messages: UiMessage[];
  /** Metadata-only transcript entries must repaint without inventing a message. */
  timelineRevision: number;
  streamingMessage: UiMessage | null;
  agentWorking: boolean;
  connection: ConnectionState;
  collabAttached: boolean;
  /**
   * Queue texts reported by omp (`queue_update` / `get_state`), including any
   * already live-steered prefix. This metadata is not action authority; the
   * phone does not infer queue contents from the transcript.
   */
  queuedMessages: QueuedMessages;
  isOpening: boolean;
  error: string | null;
  /** The daemon rejected our pairing token (401/403); the app must re-pair. */
  authRejected: boolean;
  /**
   * Live state pushed by the desktop host over the collab link, relayed by the
   * daemon as `collab_state` / `collab_agents`. Present only while a session is
   * collab-attached; everything else derives from the transcript instead.
   */
  collabState: Record<string, unknown> | null;
  collabAgents: unknown[];
  /** Latest complete host-reported running subagent count; null is unknown. */
  runningAgentCount: number | null;
  /**
   * Subagents an `async-result` notice reported finished, id → status. The
   * notice is not a message, so this is the only trace the chat keeps of it.
   */
  settledAgents: Readonly<Record<string, string>>;
  /**
   * `nextBefore` from the last backward history page: the byte offset to pass
   * as `before` for the page above this one. `null` means the file start has
   * been reached, so there is nothing earlier to load (src/sessions/jsonl.rs:628-639).
   */
  historyCursor: number | null;
  /**
   * Bytes of the session file already accounted for. Forward catch-up asks for
   * `?after=<endOffset>`, which returns only what arrived since — far cheaper
   * and lossless compared with refetching the tail.
   */
  endOffset: number;
  loadingEarlier: boolean;
  pendingToolResults: UiToolResult[];
  offline: boolean;
  queuedCount: number;
  /**
   * omp's auto-retry backoff for the open session (`auto_retry_start`);
   * cleared by its end event, a terminal turn end, resync, Cancel or switch.
   */
  autoRetry: RetryStatus | null;
  /** omp goal mode for this session (`get_state.goal`, `goal_updated`); null when none. */
  goal: GoalSnapshot | null;
  /**
   * Plan mode for this session: the newest `mode_change` the phone has read
   * on the current branch, or the latest `plan_mode` reply (plan-state.ts).
   * `{enabled:false}` once the whole branch was read without one. null while
   * unknown (the entry may sit in unread history): shows as off, and a bare
   * `/plan` asks rather than guessing.
   */
  planMode: PlanModeState | null;
  /** Slash-command catalogue omp pushed (`available_commands_update`); null until it does. */
  availableCommands: readonly unknown[] | null;
  staleHistory: { savedAt: number } | null;
  collabRequest: CollabRequest | null;
  /** Unterminated tail the daemon is still writing (`partial` frame). Cleared when superseded. */
  partialLine: { text: string; offset: number } | null;
  /** Answer the user sent while the socket was down; flushed on reconnect. */
  heldCollabResponse: { reqId: number; value: string | null; pulseQuestionToken: string } | null;
  collabAnswer: CollabAnswerState | null;
  /** Dialogs this session's own omp child is waiting on (extension-dialogs.ts). */
  extensionDialogs: ExtensionDialogState;
  extensionFeedback: ExtensionFeedback;
  /** The open conversation's turn activity from the daemon; `undefined` until first heard. See `selectActivity`. */
  activity: OmpActivity | null | undefined;
  /**
   * Page ledger for the transcript window, oldest page first. Each record is
   * one fetched page: the `before` cursor that loads it again, the
   * `nextBefore` cursor for what sits older still, the boundary message ids
   * so eviction drops exactly that page even if a live merge interleaved,
   * and the message count it added (reload batch sizing).
   * The phone holds a WINDOW into the session file, not the file: pages far
   * from the viewport are evicted and refetched by cursor on demand.
   */
  historyPages: { before: number | null; nextBefore: number | null; firstId: string; lastId: string; count: number }[];
  /**
   * Evicted span, reloadable via `before` (the next cursor to fetch, advanced
   * even when a reload page contains only metadata or duplicate rows).
   * Older entries are append-only on the daemon. Null when nothing evicted
   * or the span is only reachable by trimming (see `trimmedTop`).
   */
  evictedTop: { before: number; count: number } | null;
  /** Oldest messages trimmed with no reload cursor (partial-page cut). The
   * session file is intact; only the phone's view dropped them. */
  trimmedTop: number;
  /** Newest messages dropped from below while scrolled up. Folded into the
   * jump-to-latest pill; tapping it reseeds from the tail. */
  evictedBottom: number;
  /**
   * Byte offset where reading forward resumes across the dropped bottom span
   * (`/api/history?after=`). Null while nothing is dropped, or when the
   * offset is unknown and only the jump button's tail reseed can come back.
   */
  evictedBottomAfter: number | null;
  /** omp is auto-compacting the open session's context; same lifetime as `autoRetry`. */
  compacting: CompactingStatus | null;
}

export type SessionStateEvidence = { readonly path: string; readonly evidence: Record<string, unknown> };

export interface OmpSessionActions {
  setSessions(sessions: OmpSessionSummary[]): void;
  setSessionProjects(projects: OmpProjectSummary[]): void;
  setSessionScope(scope: string): void;
  setSessionPage(sessions: OmpSessionSummary[], nextCursor: string | null, scope: string): void;
  reconcileSessionState(path: string, evidence: Record<string, unknown>, ingressSequence: number): boolean;
  reconcileSessionStates(entries: Iterable<SessionStateEvidence>, ingressSequence: number): boolean[];
  appendSessionPage(sessions: OmpSessionSummary[], nextCursor: string | null, scope: string): void;
  setSessionsLoadingMore(loading: boolean): void;
  touchSessionsUpdatedAt(): void;
  /** Remember the composer's Steer/Queue choice (persisted on this device). */
  setSendMode(mode: SendMode): void;
  patchActivity(path: string, now: OmpActivity | null, ingressSequence?: number): void;
  beginSession(path: string): void;
  setOpening(isOpening: boolean): void;
  setHistory(messages: UiMessage[]): void;
  beginResponseLifecycle(): void;
  preflightResponseItems(messages: readonly UiMessage[]): void;
  /** Append/replace by id, preserving existing order. Used by live entries. */
  mergeMessages(messages: readonly UiMessage[]): void;
  /** Insert an older page above the current transcript, dropping duplicates. */
  prependMessages(messages: readonly UiMessage[]): void;
  appendMessage(message: UiMessage): void;
  setStreamingMessage(message: UiMessage | null): void;
  commitStreamingMessage(): void;
  setAgentWorking(working: boolean, ingressSequence?: number): void;
  setConnection(connection: ConnectionState): void;
  setCollabAttached(attached: boolean): void;
  /** File commits refresh only file-owned controls; live commits acquire ownership. */
  setSessionModel(patch: Partial<SessionModel>, source?: SessionModelSource): void;
  setContextBoundary(boundary: UiContextBoundary | null): void;
  setQueuedMessages(queued: QueuedMessages): void;
  setGoal(goal: GoalSnapshot | null): void;
  setPlanMode(planMode: PlanModeState | null): void;
  /**
   * Remove the optimistic `local:` echoes of messages Stop withdrew from
   * omp's queue (one per text, oldest first). Their text went back to the
   * composer, and the echo would otherwise reappear as a sent bubble once
   * the queue chips cleared.
   */
  dropOptimisticEchoes(texts: readonly string[]): void;
  setError(error: string | null): void;
  setAuthRejected(rejected: boolean): void;
  setCollabState(state: Record<string, unknown>): void;
  setCollabAgents(agents: unknown[]): void;
  settleAgents(agents: readonly UiAgentStatus[]): void;
  setHistoryCursor(cursor: number | null): void;
  setEndOffset(offset: number): void;
  setLoadingEarlier(loading: boolean): void;
  clearSession(): void;
  applyResults(results: readonly UiToolResult[]): void;
  setOffline(offline: boolean): void;
  setQueuedCount(count: number): void;
  setAutoRetry(retry: RetryStatus | null): void;
  setAvailableCommands(commands: readonly unknown[]): void;
  /** A title omp reported for `path` (`session_info_update`) or /rename confirmed, shown before the listing catches up. */
  setSessionTitle(path: string, title: string): void;
  setStaleHistory(stale: { savedAt: number } | null): void;
  setCollabRequest(request: CollabRequest): void;
  clearCollabRequest(): void;
  setPartialLine(partial: { text: string; offset: number } | null): void;
  clearPartialLine(): void;
  setHeldCollabResponse(held: { reqId: number; value: string | null; pulseQuestionToken: string } | null): void;
  clearHeldCollabResponse(): void;
  setCollabAnswer(answer: CollabAnswerState | null): void;
  setExtensionDialogs(update: (current: ExtensionDialogState) => ExtensionDialogState): void;
  setExtensionFeedback(update: (current: ExtensionFeedback) => ExtensionFeedback): void;
  /** Record an older page at the TOP (oldest position): prepended scrollback
   * pages and reloaded evicted spans alike sit older than everything held. */
  unshiftPage(page: { before: number | null; nextBefore: number | null; firstId: string; lastId: string; count: number }): void;
  /** Replace the ledger wholesale (tail reseed on jump-to-latest). Clears eviction state. */
  resetPages(pages: { before: number | null; nextBefore: number | null; firstId: string; lastId: string; count: number }[]): void;
  /**
   * Bound the in-memory transcript to `max` messages. Evicts whole oldest
   * pages from the top when the reader is at the bottom (reloadable via
   * `evictedTop`), newest messages from the bottom when scrolled up (counted
   * in `evictedBottom` for the jump pill), or a trimmed prefix when only a
   * partial page can go. Optimistic (`local:`) echoes are never evicted.
   */
  trimWindow(max: number, atBottom: boolean): void;
  /** Drop live rows held past the newest ledger page (they sit beyond a span that is not held). Returns how many. */
  dropStrayBottom(): number;
  /**
   * A page read forward from `evictedBottomAfter` has been merged: record it
   * in the ledger and move the cursor. `after` null = it reached the live edge.
   */
  advanceEvictedBottom(page: OmpSessionState["historyPages"][number] | null, loaded: number, after: number | null): void;
  /** Shrink the reloadable top gap and retain progress across metadata-only pages. */
  advanceEvictedTop(reloaded: number, before: number): void;
  clearEvictedTop(): void;
  setCompacting(compacting: CompactingStatus | null): void;
}

export type OmpStore = OmpSessionState & OmpSessionActions;
export type OmpStoreApi = StoreApi<OmpStore>;
/**
 * Primitive per-row subscription target: unrelated activity retains its
 * reference. The open conversation reads its own copy first: its row may be
 * missing from the listing (deep link, paged list) or frozen (the listing
 * socket closes when the phone leaves the list), and the header must show
 * the live turn either way. `undefined` means "not heard yet", so the row is
 * the fallback; `null` means the daemon said idle.
 */
// Session paths are arbitrary wire strings. Inherited members such as
// constructor are not stored authority or turn evidence for those paths.
function ownSessionRecord<T>(records: Record<string, T>, path: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(records, path) ? records[path] : undefined;
}

export function selectSessionAuthority(state: OmpStore, path: string): OmpSessionAuthority | null {
  return ownSessionRecord(state.sessionAuthorities, path) ?? null;
}
/** Per-method write capability; null preserves existing-route behavior when unreported. */
export function selectSessionCapability(
  state: OmpStore,
  path: string,
  method: "send" | "stop" | "answer" | "settings" | "bash" | "queue" | "interrupt",
): boolean | null {
  const authority = selectSessionAuthority(state, path);
  if (authority?.confidence === "confirmed") {
    const specific = authority.capabilities[method];
    if (typeof specific === "boolean") return specific;
    if (authority.capabilities.control === false) return false;
  }
  // Inferred owner/capability evidence never narrows an existing write route.
  if (!authority) {
    const legacy = state.sessions.find((session) => session.path === path)?.capabilities;
    if (legacy?.control === false) return false;
  }
  return null;
}

/** Promotion exists only on the child RPC route, not the desktop/collab bridge. */
export function selectCanPromoteQueuedMessage(state: OmpStore, path: string): boolean {
  const authority = selectSessionAuthority(state, path);
  return authority?.confidence === "confirmed" && authority.owner.kind === "child"
    && selectSessionCapability(state, path, "queue") !== false;
}

/** Only a confirmed collab owner supports plain abort but not queue withdrawal.
 * Unknown ownership keeps the safe withdrawal request; never guess plain abort. */
export function selectAbortRestoresQueue(state: OmpStore, path: string): boolean {
  const authority = selectSessionAuthority(state, path);
  return authority?.confidence !== "confirmed" || authority.owner.kind !== "collab";
}

/** Background work is separate from the main turn and never disables sending.
 * Retained evidence on a disconnected socket is a last-known state, not live proof. */
export function selectBackgroundWork(state: OmpStore): "pending" | "unconfirmed" | null {
  if (!state.sessionPath) return null;
  const authority = selectSessionAuthority(state, state.sessionPath);
  if (authority?.backgroundWork !== true) return null;
  return state.connection === "open" && !state.offline
    && authority.connection === "connected" && authority.confidence === "confirmed"
    && authority.activity?.stale !== true ? "pending" : "unconfirmed";
}

/**
 * How full the context window is, as a whole percent, or undefined when it
 * cannot be known.
 *
 * `get_state.contextUsage` is only answered by a child omp the daemon hosts; a
 * desktop-owned session's state carries just the model, so the sheet read
 * "Not reported" for most real conversations. Every assistant turn records its
 * own prompt size (`contextSnapshot.promptTokens` = input + cache read + cache
 * write, i.e. the whole prompt) and `get_state.model.contextWindow` gives the
 * denominator, so the figure is derivable from what the phone already holds.
 * The live value wins when present.
 */
export function selectContextPercent(state: OmpStore): number | undefined {
  const live = state.sessionModel?.ctxPercent;
  if (live != null) return live;
  const tokens = selectContextTokens(state);
  return tokens ? contextPercent(tokens.used, tokens.window) : undefined;
}

/**
 * The context fill as tokens, matching `selectContextPercent`: the newest
 * assistant's own prompt size, or the live percentage's share of the window
 * (omp reports only the percent live, so the count follows it).
 */
export function selectContextTokens(state: OmpStore): { used: number; window: number } | undefined {
  const window = state.sessionModel?.contextWindow ?? contextWindowFor(state.sessionModel?.model);
  if (!window) return undefined;
  const live = state.sessionModel?.ctxPercent;
  if (live != null) return { used: Math.round((live / 100) * window), window };
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i];
    if (message?.role !== "assistant") continue;
    if (state.contextBoundary && !((message.createdAt?.getTime() ?? NaN) > state.contextBoundary.at)) break;
    const tokens = message.contextSnapshot?.promptTokens;
    return typeof tokens === "number" && Number.isFinite(tokens) ? { used: tokens, window } : undefined;
  }
  return state.contextBoundary?.tokens !== undefined ? { used: state.contextBoundary.tokens, window } : undefined;
}

/**
 * The open session's whole spend, or undefined until the daemon has totalled
 * its file. History arrives in pages, so a sum over held messages undercounts;
 * the listing row carries the file total and held turns newer than it are
 * added exactly once (see `sessionCost`).
 */
export function selectSessionCost(state: OmpStore): number | undefined {
  const row = state.sessions.find((session) => session.path === state.sessionPath);
  if (!row) return undefined;
  return sessionCost(row.costTotal, typeof row.usageThrough === "string" ? row.usageThrough : undefined, state.messages);
}

/** One turn selector shared by the list, chat, Stop and safety surfaces. */
export function selectSessionTurn(state: OmpStore, path: string): OmpTurnState {
  const authority = selectSessionAuthority(state, path);
  if (authority) return authority.turn;
  const legacy = ownSessionRecord(state.legacySessionTurns, path);
  if (legacy && legacy.turn !== "unknown") return legacy.turn;
  if (path !== "" && path === state.sessionPath) {
    if (state.agentWorking) return "running";
    if (state.activity !== undefined) return state.activity === null ? "idle" : "running";
  }
  const session = state.sessions.find((row) => row.path === path);
  return session ? sessionTurn(session) : "unknown";
}

export function selectActivity(state: OmpStore, path: string): OmpActivity | null {
  const authority = selectSessionAuthority(state, path);
  const legacy = ownSessionRecord(state.legacySessionTurns, path);
  if (authority) {
    if (authority.turn === "idle" || authority.activity === null || authority.activity.stale) return null;
    return legacy?.activity ?? null;
  }
  if (path !== "" && path === state.sessionPath && state.activity !== undefined) return state.activity;
  return legacy?.activity ?? state.sessions.find((session) => session.path === path)?.now ?? null;
}

function withoutSessionAuthority(session: OmpSessionSummary): OmpSessionSummary {
  const { sessionState: _ignored, ...rest } = session;
  return rest;
}

function projectSessionSummary(
  session: OmpSessionSummary,
  authorities: Record<string, OmpSessionAuthority>,
  legacyTurns: OmpStore["legacySessionTurns"],
): OmpSessionSummary {
  const authority = ownSessionRecord(authorities, session.path);
  const legacy = ownSessionRecord(legacyTurns, session.path);
  if (authority) {
    const now = authority.turn === "idle" || authority.activity === null || authority.activity.stale
      ? null
      : legacy?.activity ?? null;
    const running = authority.turn === "running" ? true : authority.turn === "idle" ? false : undefined;
    const capabilities = authority.capabilities;
    return {
      ...withoutSessionAuthority(session),
      sessionState: authority,
      ...(running === undefined ? { running: undefined, streaming: undefined } : { running, streaming: running }),
      now,
      capabilities: { read: capabilities.read, stream: capabilities.stream, control: capabilities.control },
    };
  }
  const base = withoutSessionAuthority(session);
  if (!legacy || legacy.turn === "unknown") return base;
  const running = legacy.turn === "running";
  return { ...base, running, streaming: running, now: legacy.activity };
}


function syncAppBadge(count: number): void {
  try {
    const nav = navigator as unknown as {
      setAppBadge?: (n: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (count > 0) nav.setAppBadge?.(count);
    else nav.clearAppBadge?.() ?? nav.setAppBadge?.(0);
  } catch {
    // Guard: not universally supported or may throw.
  }
}

/** Ids minted locally by `createUserMessage` before the daemon writes them. */
function isOptimistic(message: UiMessage): boolean {
  return message.id.startsWith("local:");
}

export type QueuedMessages = {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  /** Known live-steered prefix length, or null for a present invalid marker. */
  readonly liveSteered: number | null;
  readonly steeringIds?: readonly string[];
  readonly followUpIds?: readonly string[];
};
export const NO_QUEUED_MESSAGES: QueuedMessages = { steering: [], followUp: [], liveSteered: 0 };
function sameQueue(a: QueuedMessages, b: QueuedMessages): boolean {
  const sameItems = (left: readonly string[] | undefined, right: readonly string[] | undefined) =>
    left === right || (left !== undefined && right !== undefined
      && left.length === right.length && left.every((id, index) => id === right[index]));
  return (
    a.liveSteered === b.liveSteered &&
    sameItems(a.steeringIds, b.steeringIds) && sameItems(a.followUpIds, b.followUpIds) &&
    sameItems(a.steering, b.steering) && sameItems(a.followUp, b.followUp)
  );
}

/** Normalize omp's queue metadata from a `queue_update` frame or `get_state` data. */
export function parseQueuedMessages(source: unknown): QueuedMessages | null {
  if (typeof source !== "object" || source === null) return null;
  const raw = source as { queuedMessages?: unknown; steering?: unknown; followUp?: unknown; liveSteered?: unknown; steeringIds?: unknown; followUpIds?: unknown };
  const lists =
    typeof raw.queuedMessages === "object" && raw.queuedMessages !== null
      ? (raw.queuedMessages as Omit<typeof raw, "queuedMessages">)
      : raw;
  const strings = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    const copied: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) return null;
      const item: unknown = value[i];
      if (typeof item !== "string") return null;
      copied.push(item);
    }
    return copied;
  };
  const steering = strings(lists.steering);
  const followUp = strings(lists.followUp);
  if (!steering || !followUp) return null;
  let liveSteered: number | null = 0;
  if (Object.prototype.hasOwnProperty.call(lists, "liveSteered")) {
    const marker = lists.liveSteered;
    liveSteered = typeof marker === "number" && Number.isSafeInteger(marker)
      && marker >= 0 && marker <= steering.length ? (marker === 0 ? 0 : marker) : null;
  }
  const identities = (value: unknown, count: number): string[] | null => {
    const ids = strings(value);
    return ids && ids.length === count && ids.every(Boolean) && new Set(ids).size === ids.length ? ids : null;
  };
  const steeringIds = identities(lists.steeringIds, steering.length);
  const followUpIds = identities(lists.followUpIds, followUp.length);
  return { steering, followUp, liveSteered,
    ...(steeringIds ? { steeringIds } : {}),
    ...(followUpIds ? { followUpIds } : {}),
  };
}

type SessionScopedState = Omit<OmpSessionState, "sessions" | "sessionProjects" | "sessionsNextCursor" | "sessionsScope" | "sessionsLoadingMore" | "sessionsUpdatedAt" | "sendMode" | "sessionAuthorities" | "legacySessionTurns" | "connection" | "authRejected">;

const EMPTY_SESSION: SessionScopedState = {
  collabState: null,
  collabAgents: [],
  runningAgentCount: null,
  settledAgents: {},
  sessionPath: null,
  sessionModel: null,
  sessionModelProvenance: {},
  sessionModelAuthority: null,
  contextBoundary: null,
  messages: [],
  timelineRevision: 0,
  historyPages: [],
  evictedTop: null,
  trimmedTop: 0,
  evictedBottom: 0,
  evictedBottomAfter: null,
  compacting: null,
  streamingMessage: null,
  agentWorking: false,
  collabAttached: false,
  queuedMessages: NO_QUEUED_MESSAGES,
  isOpening: false,
  error: null,
  historyCursor: null,
  endOffset: 0,
  loadingEarlier: false,
  pendingToolResults: [],
  offline: false,
  queuedCount: 0,
  autoRetry: null,
  goal: null,
  planMode: null,
  availableCommands: null,
  staleHistory: null,
  collabRequest: null,
  partialLine: null,
  heldCollabResponse: null,
  collabAnswer: null,
  extensionDialogs: EMPTY_EXTENSION_DIALOGS,
  extensionFeedback: EMPTY_EXTENSION_FEEDBACK,
  activity: undefined,
};

export function createOmpStore(): OmpStoreApi {
  const mergeRecoveredDetails = (canonical: UiMessage, provisional: UiMessage): UiMessage => {
    const merged = mergeToolParts(canonical, provisional);
    const covered = new Set(merged.parts.filter((part) => part.kind !== "text").map((part) => JSON.stringify(part)));
    const fresh = provisional.parts.filter((part) => part.kind !== "text" && part.kind !== "tool" && !covered.has(JSON.stringify(part)));
    return { ...merged, parts: fresh.length ? [...merged.parts, ...fresh] : merged.parts,
      errorMessage: merged.errorMessage ?? provisional.errorMessage,
      ...(merged.eagerMarkdown || provisional.eagerMarkdown ? { eagerMarkdown: true } : {}),
    };
  };
  const responseRecovery = new ResponseItemRecovery(mergeRecoveredDetails);
  let daemonInstanceId: string | null = null;
  let daemonIngressSequence = 0;
  const retiredDaemonIds = new Set<string>();
  // A page keeps ordered authority acceptance, but passive rows need not copy
  // every previously accepted record again. This draft is never published until
  // the whole batch is reduced; single-row callers use exactly the same rules.
  const reduceSessionStates = (state: OmpStore, entries: Iterable<SessionStateEvidence>, ingressSequence: number, indexed = false) => {
    let sessionAuthorities = state.sessionAuthorities;
    let legacySessionTurns = state.legacySessionTurns;
    let sessions = state.sessions;
    let activity = state.activity;
    let agentWorking = state.agentWorking;
    let sessionModel = state.sessionModel;
    let sessionModelProvenance = state.sessionModelProvenance;
    let sessionModelAuthority = state.sessionModelAuthority;
    let positions: Map<string, number> | undefined;
    const accepted: boolean[] = [];
    const setLegacyTurn = (path: string, turn: OmpTurnState, detail: OmpActivity | null) => {
      if (legacySessionTurns === state.legacySessionTurns) legacySessionTurns = { ...legacySessionTurns };
      // Computed-key spreads used to define own data properties. Assignment to
      // __proto__ on a plain object would instead change its prototype.
      Object.defineProperty(legacySessionTurns, path, {
        value: { turn, activity: detail, sequence: ingressSequence }, enumerable: true, configurable: true, writable: true,
      });
    };
    const projectRow = (path: string) => {
      let index: number;
      if (!indexed) index = sessions.findIndex((row) => row.path === path);
      else {
        if (!positions) {
          positions = new Map();
          sessions.forEach((row, i) => { if (!positions!.has(row.path)) positions!.set(row.path, i); });
        }
        // Preserve findIndex's first occurrence when retained rows repeat a path.
        index = positions.get(path) ?? -1;
      }
      if (index < 0) return;
      if (sessions === state.sessions) sessions = sessions.slice();
      sessions[index] = projectSessionSummary(sessions[index], sessionAuthorities, legacySessionTurns);
    };
    for (const { path, evidence } of entries) {
      accepted.push(false);
      const rawAuthority = evidence.sessionState;
      const authority = rawAuthority === undefined || rawAuthority === null ? null : parseSessionAuthority(rawAuthority);
      if (rawAuthority !== undefined && rawAuthority !== null && !authority) continue;
      if (authority) {
        if (retiredDaemonIds.has(authority.daemonInstanceId)) continue;
        const changedDaemon = daemonInstanceId !== null && daemonInstanceId !== authority.daemonInstanceId;
        if (changedDaemon && ingressSequence < daemonIngressSequence) continue;
        const previous = changedDaemon ? undefined : ownSessionRecord(sessionAuthorities, path);
        if (previous && (authority.revision <= previous.revision || authority.bindingEpoch < previous.bindingEpoch)) continue;
        if (path === state.sessionPath && authority.owner.kind !== "ambiguous") {
          const confirmed = authority.confidence === "confirmed";
          // The registry also releases a retired source after an owner scan:
          // its turn is file-inferred, but the advanced binding is authoritative.
          const scannedRelease = authority.owner.kind === "none" && authority.turn === "idle"
            && authority.connection === "connected" && sessionModelAuthority !== null
            && (sessionModelAuthority.daemonInstanceId !== authority.daemonInstanceId
              || authority.bindingEpoch > sessionModelAuthority.bindingEpoch);
          const released = authority.owner.kind === "none" && (confirmed || scannedRelease);
          const replaced = confirmed && sessionModelAuthority !== null && !sameModelBinding(sessionModelAuthority, authority);
          if (released || replaced) {
            const provenanceBefore = sessionModelProvenance;
            for (const field of CONFIGURATION_FIELDS) {
              if (sessionModelProvenance[field] !== "live") continue;
              if (sessionModelProvenance === state.sessionModelProvenance) sessionModelProvenance = { ...sessionModelProvenance };
              sessionModelProvenance[field] = "file";
            }
            if (sessionModelProvenance !== provenanceBefore) {
              // Passive RPC callers fence on model identity. An old binding's
              // in-flight reply must not reacquire ownership after its release.
              sessionModel = sessionModel && { ...sessionModel };
            }
            sessionModelAuthority = null;
          } else if (confirmed && sessionModelAuthority === null && CONFIGURATION_FIELDS.some((field) => sessionModelProvenance[field] === "live")) {
            sessionModelAuthority = authority;
          }
        }
        if (changedDaemon && daemonInstanceId) retiredDaemonIds.add(daemonInstanceId);
        daemonInstanceId = authority.daemonInstanceId;
        daemonIngressSequence = Math.max(daemonIngressSequence, ingressSequence);
        if (changedDaemon || (path === state.sessionPath && (!previous || previous.bindingEpoch !== authority.bindingEpoch || JSON.stringify(previous.owner) !== JSON.stringify(authority.owner)))) responseRecovery.reset();
        if (changedDaemon) {
          sessionAuthorities = {};
          legacySessionTurns = {};
          sessions = sessions.map((row) => {
            const { status: _status, running: _running, streaming: _streaming, now: _now, sessionState: _sessionState, capabilities: _capabilities, ...rest } = row;
            return rest;
          });
          activity = undefined;
          agentWorking = false;
        } else if (sessionAuthorities === state.sessionAuthorities) sessionAuthorities = { ...sessionAuthorities };
        Object.defineProperty(sessionAuthorities, path, { value: authority, enumerable: true, configurable: true, writable: true });
        const detail = authority.activity;
        // The daemon stamps since/turnStartedAt on every running activity and
        // defaults both to observedAt (session_state.rs); mirror that default
        // so a record without them still drives the live footer's clock
        // instead of being dropped as unparseable.
        const parsedActivity = detail && parseOmpActivity({ since: detail.observedAt, turnStartedAt: detail.observedAt, tools: 0, ...detail, state: detail.kind });
        const nextActivity = authority.turn !== "running" || detail === null || detail.stale || !parsedActivity
          ? null
          : onPhoneClock(parsedActivity, typeof evidence.at === "number" ? evidence.at : undefined, Date.now());
        setLegacyTurn(path, authority.turn, nextActivity);
        projectRow(path);
        if (path === state.sessionPath) { activity = nextActivity; agentWorking = authority.turn === "running"; }
      } else {
        if (ownSessionRecord(sessionAuthorities, path)) continue;
        const hasNow = Object.prototype.hasOwnProperty.call(evidence, "now");
        const parsedNow = evidence.now === null ? null : parseOmpActivity(evidence.now);
        if (hasNow && evidence.now !== null && !parsedNow) continue;
        let turn = sessionTurn(evidence as unknown as OmpSessionSummary);
        if (turn === "unknown" && hasNow) turn = evidence.now === null ? "idle" : "running";
        if (turn === "unknown") continue;
        const previous = ownSessionRecord(legacySessionTurns, path);
        if (previous && ingressSequence <= previous.sequence) continue;
        const nextActivity = turn === "idle" || (hasNow && evidence.now === null) ? null : parsedNow ?? previous?.activity ?? null;
        setLegacyTurn(path, turn, nextActivity);
        projectRow(path);
        if (path === state.sessionPath) { activity = nextActivity; agentWorking = turn === "running"; }
      }
      accepted[accepted.length - 1] = true;
    }
    return {
      accepted,
      state: accepted.some(Boolean) ? { sessionAuthorities, legacySessionTurns, sessions, activity, agentWorking, sessionModel, sessionModelProvenance, sessionModelAuthority } : state,
    };
  };
  return createStore<OmpStore>()((set) => ({
    sessions: [],
    sessionAuthorities: {},
    legacySessionTurns: {},
    sessionProjects: [],
    sessionsUpdatedAt: null,
    sessionsNextCursor: null,
    sessionsScope: "",
    sessionsLoadingMore: false,
    ...EMPTY_SESSION,
    connection: "closed",
    authRejected: false,
    sendMode: storedSendMode(),
    setSendMode: (sendMode) => {
      set({ sendMode });
      try {
        localStorage.setItem(SEND_MODE_KEY, sendMode);
      } catch {
        // The choice still holds for this session.
      }
    },

    setSessions: (sessions) => set((state) => ({ sessions: sessions.map((row) => projectSessionSummary(row, state.sessionAuthorities, state.legacySessionTurns)), sessionsUpdatedAt: Date.now(), sessionsNextCursor: null, sessionsScope: "", sessionsLoadingMore: false })),
    setSessionProjects: (sessionProjects) => set({ sessionProjects }),
    setSessionScope: (scope) => set((state) => state.sessionsScope === scope ? state : {
      sessions: [],
      sessionsScope: scope,
      sessionsNextCursor: null,
      sessionsLoadingMore: false,
    }),
    setSessionPage: (sessions, nextCursor, scope) => set((state) => ({ sessions: sessions.map((row) => projectSessionSummary(row, state.sessionAuthorities, state.legacySessionTurns)), sessionsUpdatedAt: Date.now(), sessionsNextCursor: nextCursor, sessionsScope: scope, sessionsLoadingMore: false })),
    reconcileSessionState: (path, evidence, ingressSequence) => {
      let accepted = false;
      set((state) => {
        const result = reduceSessionStates(state, [{ path, evidence }], ingressSequence);
        accepted = result.accepted[0];
        return result.state;
      });
      return accepted;
    },
    reconcileSessionStates: (entries, ingressSequence) => {
      let accepted: boolean[] = [];
      set((state) => {
        const result = reduceSessionStates(state, entries, ingressSequence, true);
        accepted = result.accepted;
        return result.state;
      });
      return accepted;
    },
    appendSessionPage: (sessions, nextCursor, scope) => set((state) => {
      if (state.sessionsScope !== scope) return { sessionsLoadingMore: false };
      const merged = state.sessions.slice();
      const positions = new Map(merged.map((session, index) => [session.path, index]));
      for (const session of sessions) {
        const index = positions.get(session.path);
        if (index === undefined) {
          positions.set(session.path, merged.length);
          merged.push(session);
        } else {
          merged[index] = session;
        }
      }
      return { sessions: merged.map((row) => projectSessionSummary(row, state.sessionAuthorities, state.legacySessionTurns)), sessionsUpdatedAt: Date.now(), sessionsNextCursor: nextCursor, sessionsLoadingMore: false };
    }),
    setSessionsLoadingMore: (loading) => set({ sessionsLoadingMore: loading }),
    touchSessionsUpdatedAt: () => set({ sessionsUpdatedAt: Date.now() }),
    setSessionTitle: (path, title) => set((state) => {
      const index = state.sessions.findIndex((row) => row.path === path);
      if (index < 0 || state.sessions[index]!.title === title) return state;
      const sessions = state.sessions.slice();
      sessions[index] = { ...sessions[index]!, title };
      return { sessions };
    }),
    patchActivity: (path, now, ingressSequence) => set((state) => {
      if (ownSessionRecord(state.sessionAuthorities, path)) return state;
      const previous = ownSessionRecord(state.legacySessionTurns, path);
      const sequence = ingressSequence ?? (previous?.sequence ?? 0) + 1;
      if (previous && sequence <= previous.sequence) return state;
      const legacySessionTurns = { ...state.legacySessionTurns, [path]: { turn: now === null ? "idle" as const : "running" as const, activity: now, sequence } };
      const index = state.sessions.findIndex((session) => session.path === path);
      const sessions = index < 0 ? state.sessions : state.sessions.slice();
      if (index >= 0) sessions[index] = projectSessionSummary(sessions[index], state.sessionAuthorities, legacySessionTurns);
      return { ...(path === state.sessionPath ? { activity: now, agentWorking: now !== null } : {}), legacySessionTurns, sessions };
    }),
    beginSession: (sessionPath) => {
      responseRecovery.reset();
      set({ ...EMPTY_SESSION, sessionPath, connection: "connecting", isOpening: true });
    },
    beginResponseLifecycle: () => responseRecovery.start(),
    preflightResponseItems: (messages) => set((state) => {
      responseRecovery.preflight([...state.messages, ...messages], state.streamingMessage);
      return state;
    }),
    setOpening: (isOpening) => set({ isOpening }),
    setHistory: (messages) => set((state) => {
      const incoming = inheritLiveMarkdown(messages, [...state.messages, state.streamingMessage]);
      responseRecovery.preflight([...state.messages, ...incoming], state.streamingMessage);
      return responseRecovery.reconcile(incoming, state.streamingMessage, state.messages);
    }),

    applyResults: (results) =>
      set((state) => {
        if (results.length === 0) return state;
        // The live message holds calls too. Results used to settle only the
        // committed transcript, so a call still in the streaming message
        // stayed "running" until the stream committed, however long ago its
        // result had arrived.
        const live = state.streamingMessage
          ? applyToolResults([state.streamingMessage], results)
          : null;
        const liveMatched = new Set(
          live ? results.filter((r) => !live.unmatched.includes(r)).map((r) => r.callId) : [],
        );
        const { messages, unmatched: stillUnmatched } = applyToolResults(state.messages, results);
        const unmatched = stillUnmatched.filter((r) => !liveMatched.has(r.callId));
        const messagesChanged = messages !== state.messages;
        const streamingMessage = live ? live.messages[0] : state.streamingMessage;
        const streamingChanged = streamingMessage !== state.streamingMessage;
        let nextPending: UiToolResult[];
        if (unmatched.length === 0) {
          nextPending = state.pendingToolResults;
        } else {
          const combined = [...state.pendingToolResults, ...unmatched];
          const map = new Map<string, UiToolResult>();
          for (const result of combined) {
            if (map.has(result.callId)) map.delete(result.callId);
            map.set(result.callId, result);
          }
          let deduped = [...map.values()];
          if (deduped.length > 500) deduped = deduped.slice(deduped.length - 500);
          nextPending = deduped;
        }
        const pendingChanged = nextPending !== state.pendingToolResults;
        if (!messagesChanged && !pendingChanged && !streamingChanged) return state;
        return {
          ...(messagesChanged ? { messages } : {}),
          ...(pendingChanged ? { pendingToolResults: nextPending } : {}),
          ...(streamingChanged ? { streamingMessage } : {}),
        };
      }),

    mergeMessages: (messages) =>
      set((state) => {
        if (messages.length === 0) return state;
        const incoming = inheritLiveMarkdown(messages, [...state.messages, state.streamingMessage]);
        responseRecovery.preflight([...state.messages, ...incoming], state.streamingMessage);
        const known = new Set(state.messages.map((message) => message.id));
        const pending = state.messages.filter(isOptimistic);
        const claimed = new Set<string>();
        const settled = new Map<string, UiMessage>();
        if (pending.length > 0) {
          for (const message of incoming) {
            if (message.role !== "user") continue;
            const echo = pending.find(
              (candidate) =>
                !claimed.has(candidate.id) && candidate.text.trim() === message.text.trim(),
            );
            if (!echo) continue;
            claimed.add(echo.id);
            settled.set(echo.id, message);
          }
        }
        // A streamed assistant message and its persisted entry are one
        // response under two ids (stream events carry no entry id). The
        // persisted copy takes the live one's place, keeping live tool state,
        // instead of rendering the reply twice.
        const byResponse = new Map<string, UiMessage>();
        for (const message of state.messages) {
          if (message.responseKey) byResponse.set(message.responseKey, message);
        }
        for (const message of incoming) {
          const live = message.responseKey ? byResponse.get(message.responseKey) : undefined;
          if (!live || live.id === message.id) continue;
          claimed.add(live.id);
          settled.set(live.id, mergeToolParts(message, live));
        }

        let baseMessages: UiMessage[];
        if (claimed.size === 0 && incoming.every((message) => !known.has(message.id))) {
          baseMessages = [...state.messages, ...incoming];
        } else {
          const byId = new Map<string, UiMessage>();
          for (const message of state.messages) {
            const replacement = settled.get(message.id);
            if (replacement) byId.set(replacement.id, replacement);
            else byId.set(message.id, message);
          }
          for (const message of incoming) byId.set(message.id, mergeToolParts(message, byId.get(message.id) ?? null));
          baseMessages = [...byId.values()];
        }

        const recovered = responseRecovery.reconcile(baseMessages, state.streamingMessage, state.messages);
        baseMessages = recovered.messages;
        const streamingMessage = recovered.streamingMessage;
        if (state.pendingToolResults.length === 0) {
          return { messages: baseMessages, streamingMessage };
        }
        const applied = applyToolResults(baseMessages, state.pendingToolResults);
        if (applied.messages === baseMessages && applied.unmatched.length === state.pendingToolResults.length) {
          let same = true;
          for (let i = 0; i < applied.unmatched.length; i++) {
            if (applied.unmatched[i] !== state.pendingToolResults[i]) {
              same = false;
              break;
            }
          }
          if (same) {
            return { messages: baseMessages, streamingMessage };
          }
        }
        const nextPending = applied.unmatched;
        if (applied.messages === baseMessages) {
          return { messages: baseMessages, streamingMessage, pendingToolResults: nextPending };
        }
        return { messages: applied.messages, streamingMessage, pendingToolResults: nextPending };
      }),

    prependMessages: (older) =>
      set((state) => {
        if (older.length === 0) return state;
        responseRecovery.preflight([...state.messages, ...older], state.streamingMessage);
        const known = new Set(state.messages.map((message) => message.id));
        const fresh = inheritLiveMarkdown(older.filter((message) => !known.has(message.id)), [...state.messages, state.streamingMessage]);
        if (fresh.length === 0) return state;
        responseRecovery.preflight([...fresh, ...state.messages], state.streamingMessage);
        const recovered = responseRecovery.reconcile([...fresh, ...state.messages], state.streamingMessage, state.messages);
        const baseMessages = recovered.messages;
        const streamingMessage = recovered.streamingMessage;
        if (state.pendingToolResults.length === 0) {
          return { messages: baseMessages, streamingMessage };
        }
        const applied = applyToolResults(baseMessages, state.pendingToolResults);
        if (applied.messages === baseMessages && applied.unmatched.length === state.pendingToolResults.length) {
          let same = true;
          for (let i = 0; i < applied.unmatched.length; i++) {
            if (applied.unmatched[i] !== state.pendingToolResults[i]) {
              same = false;
              break;
            }
          }
          if (same) {
            return { messages: baseMessages, streamingMessage };
          }
        }
        return { messages: applied.messages, streamingMessage, pendingToolResults: applied.unmatched };
      }),

    appendMessage: (message) => set((state) => ({
      messages: [...state.messages, ...inheritLiveMarkdown([message], [...state.messages, state.streamingMessage])],
    })),
    setStreamingMessage: (message) => set((state) => {
      if (!message || message.role !== "assistant") return { streamingMessage: message };
      const observed = responseRecovery.observe({ ...message, eagerMarkdown: true });
      const recovered = responseRecovery.needsReconcile
        ? responseRecovery.reconcile(state.messages, observed)
        : { messages: state.messages, streamingMessage: observed };
      const streamingMessage = recovered.streamingMessage;
      if (recovered.messages !== state.messages) return { messages: recovered.messages, streamingMessage };
      const previous = state.streamingMessage;
      // Token updates keep touching only the live object. History ingress
      // already transfers ownership for any rows arriving during this stream.
      if (previous?.eagerMarkdown && previous.id === message.id && previous.responseKey === message.responseKey) {
        return { streamingMessage };
      }
      // A history row can arrive before the first live event for the response.
      const messages = inheritLiveMarkdown(state.messages, [...state.messages, streamingMessage]);
      return { streamingMessage, ...(messages.some((item, i) => item !== state.messages[i]) ? { messages } : {}) };
    }),
    commitStreamingMessage: () => set((state) => {
      const streaming = state.streamingMessage;
      if (!streaming) return state;
      const recoveredIndex = state.messages.findIndex((message) => isRecoveredResponse(message, streaming));
      const index = state.messages.findIndex((message) => message.id === streaming.id);
      // The file can beat the stream: the persisted copy of this response is
      // already listed, so keep it (it owns the entry id) with live tool state.
      const persisted = index < 0 && streaming.responseKey
        ? state.messages.findIndex((message) => message.responseKey === streaming.responseKey)
        : -1;
      const messages = state.messages.slice();
      if (recoveredIndex >= 0) messages[recoveredIndex] = mergeRecoveredDetails(messages[recoveredIndex], streaming);
      else if (persisted >= 0) messages[persisted] = mergeToolParts(messages[persisted], streaming);
      else if (index < 0) messages.push(streaming);
      else messages[index] = mergeToolParts(streaming, messages[index]);
      const recovered = responseRecovery.reconcile(messages, null);
      return { messages: inheritLiveMarkdown(recovered.messages, [...state.messages, streaming]), streamingMessage: null };
    }),
    setAgentWorking: (agentWorking, ingressSequence) => set((state) => {
      const path = state.sessionPath;
      if (!path) return state.agentWorking === agentWorking ? state : { agentWorking };
      const authority = ownSessionRecord(state.sessionAuthorities, path);
      if (authority) return state.agentWorking === agentWorking ? state : { agentWorking: authority.turn === "running" };
      const previous = ownSessionRecord(state.legacySessionTurns, path);
      const sequence = ingressSequence ?? (previous?.sequence ?? 0) + 1;
      if (previous && sequence <= previous.sequence) return state;
      const turn = agentWorking ? "running" as const : "idle" as const;
      const activity = agentWorking ? previous?.activity ?? state.activity ?? null : null;
      const legacySessionTurns = { ...state.legacySessionTurns, [path]: { turn, activity, sequence } };
      const index = state.sessions.findIndex((row) => row.path === path);
      const sessions = index < 0 ? state.sessions : state.sessions.slice();
      if (index >= 0) sessions[index] = projectSessionSummary(sessions[index], state.sessionAuthorities, legacySessionTurns);
      return { agentWorking, activity, legacySessionTurns, sessions };
    }),
    setConnection: (connection) => set({ connection }),
    setCollabAttached: (collabAttached) => set({ collabAttached }),
    setSessionModel: (patch, source = "live") => set((state) => {
      const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<SessionModel>;
      if (typeof defined.ctxPercent === "number" && state.contextBoundary
        && !(defined.contextMeasuredAfter !== undefined && defined.contextMeasuredAfter > state.contextBoundary.at)) {
        delete defined.ctxPercent;
        delete defined.contextMeasuredAfter;
      }
      let provenance = state.sessionModelProvenance;
      for (const field of CONFIGURATION_FIELDS) {
        if (defined[field] === undefined) continue;
        if (source === "file" && state.sessionModel?.[field] !== undefined && provenance[field] !== "file") {
          delete defined[field];
        } else if (provenance[field] !== source) {
          if (provenance === state.sessionModelProvenance) provenance = { ...provenance };
          provenance[field] = source;
        }
      }
      if (!("ctxPercent" in defined)) delete defined.contextMeasuredAfter;
      if (Object.keys(defined).length === 0) return state;
      let modelAuthority = state.sessionModelAuthority;
      if (source === "live" && state.sessionPath && CONFIGURATION_FIELDS.some((field) => defined[field] !== undefined)) {
        const current = ownSessionRecord(state.sessionAuthorities, state.sessionPath);
        if (current && (!modelAuthority || !sameModelBinding(modelAuthority, current))) modelAuthority = current;
      }
      // INVARIANT: window and live percent belong to ONE model. A switch that
      // does not carry its own would keep the previous model's window and show
      // a context percentage that no longer describes this conversation.
      const switched = defined.model !== undefined && state.sessionModel?.model !== undefined
        && windowKey(defined.model) !== windowKey(state.sessionModel.model);
      const base = switched
        ? { ...state.sessionModel, contextWindow: undefined, ctxPercent: undefined, contextMeasuredAfter: undefined, fastModeActive: undefined }
        : defined.ctxPercent !== undefined ? { ...state.sessionModel, contextMeasuredAfter: undefined } : state.sessionModel;
      const sessionModel = { ...base, ...defined };
      if (sessionModel.model && sessionModel.contextWindow) rememberContextWindows([{ id: sessionModel.model, contextWindow: sessionModel.contextWindow }]);
      if (!switched && Object.entries(defined).every(([key, value]) => state.sessionModel?.[key as keyof SessionModel] === value)
        && state.sessionModel?.contextMeasuredAfter === sessionModel.contextMeasuredAfter
        && provenance === state.sessionModelProvenance && modelAuthority === state.sessionModelAuthority) return state;
      return { sessionModel, sessionModelProvenance: provenance, sessionModelAuthority: modelAuthority };
    }),
    setContextBoundary: (boundary) => set((state) => {
      if (boundary === state.contextBoundary || (boundary && state.contextBoundary && boundary.at <= state.contextBoundary.at)) return state;
      const measuredAfter = state.sessionModel?.contextMeasuredAfter;
      const freshLive = boundary && state.sessionModelProvenance.ctxPercent === "live"
        && measuredAfter !== undefined && measuredAfter > boundary.at;
      if (freshLive) return { contextBoundary: boundary };
      const provenance = { ...state.sessionModelProvenance };
      delete provenance.ctxPercent;
      return {
        contextBoundary: boundary,
        sessionModel: state.sessionModel && { ...state.sessionModel, ctxPercent: undefined, contextMeasuredAfter: undefined },
        sessionModelProvenance: provenance,
      };
    }),
    setQueuedMessages: (queuedMessages) =>
      set((state) =>
        sameQueue(state.queuedMessages, queuedMessages) ? state : { queuedMessages },
      ),
    setGoal: (goal) => set((state) => (state.goal === goal ? state : { goal })),
    setPlanMode: (planMode) =>
      set((state) =>
        state.planMode === planMode ||
        (state.planMode !== null && planMode !== null &&
          state.planMode.enabled === planMode.enabled && state.planMode.planFilePath === planMode.planFilePath)
          ? state
          : { planMode }),
    dropOptimisticEchoes: (texts) =>
      set((state) => {
        const left = new Map<string, number>();
        for (const text of texts) {
          const key = text.trim();
          if (key) left.set(key, (left.get(key) ?? 0) + 1);
        }
        if (left.size === 0) return state;
        const messages = state.messages.filter((message) => {
          if (message.role !== "user" || !isOptimistic(message)) return true;
          const key = message.text.trim();
          const count = left.get(key) ?? 0;
          if (count === 0) return true;
          left.set(key, count - 1);
          return false;
        });
        return messages.length === state.messages.length ? state : { messages };
      }),
    setError: (error) => set({ error }),
    setAuthRejected: (authRejected) => set(authRejected
      ? { authRejected, extensionFeedback: EMPTY_EXTENSION_FEEDBACK }
      : { authRejected }),
    setCollabState: (collabState) => set({ collabState }),
    setCollabAgents: (collabAgents) => set({ collabAgents }),
    settleAgents: (agents) => set((state) => {
      const fresh = agents.filter((agent) => state.settledAgents[agent.id] !== agent.status);
      if (fresh.length === 0) return state;
      const settledAgents = { ...state.settledAgents };
      for (const agent of fresh) settledAgents[agent.id] = agent.status;
      return { settledAgents };
    }),
    setHistoryCursor: (historyCursor) => set({ historyCursor }),
    setEndOffset: (endOffset) => set({ endOffset }),
    setLoadingEarlier: (loadingEarlier) => set({ loadingEarlier }),
    clearSession: () => { responseRecovery.reset(); set({ ...EMPTY_SESSION, connection: "closed" }); },
    setOffline: (offline) => set({ offline }),
    setQueuedCount: (queuedCount) => set({ queuedCount }),
    setAutoRetry: (autoRetry) => set((state) => (state.autoRetry === autoRetry ? state : { autoRetry })),
    setAvailableCommands: (availableCommands) => set({ availableCommands }),
    setStaleHistory: (staleHistory) => set({ staleHistory }),
    setCollabRequest: (collabRequest) =>
      set(() => {
        syncAppBadge(collabRequest ? 1 : 0);
        return { collabRequest };
      }),
    clearCollabRequest: () =>
      set((state) => {
        // Keep badge cleared even if a held answer is about to be flushed.
        syncAppBadge(0);
        if (state.collabRequest === null && state.heldCollabResponse === null) return state;
        // If we have a held response for the same req, keep clearing both via controller; store just clears request here.
        return { collabRequest: null };
      }),
    setPartialLine: (partialLine) => set({ partialLine }),
    clearPartialLine: () => set({ partialLine: null }),
    setHeldCollabResponse: (heldCollabResponse) => set({ heldCollabResponse }),
    clearHeldCollabResponse: () => set({ heldCollabResponse: null }),
    setCollabAnswer: (collabAnswer) => set({ collabAnswer }),
    setExtensionDialogs: (update) =>
      set((state) => {
        const extensionDialogs = update(state.extensionDialogs);
        return extensionDialogs === state.extensionDialogs ? state : { extensionDialogs };
      }),
    setExtensionFeedback: (update) =>
      set((state) => ({ extensionFeedback: update(state.extensionFeedback) })),
    unshiftPage: (page) =>
      set((state) => ({ historyPages: [page, ...state.historyPages] })),
    resetPages: (pages) =>
      set({
        historyPages: pages,
        evictedTop: null,
        trimmedTop: 0,
        evictedBottom: 0,
        evictedBottomAfter: null,
      }),
    advanceEvictedTop: (reloaded, before) =>
      set((state) => {
        if (!state.evictedTop) return state;
        const remaining = state.evictedTop.count - reloaded;
        return remaining > 0 ? { evictedTop: { before, count: remaining } } : { evictedTop: null };
      }),
    clearEvictedTop: () => set({ evictedTop: null }),
    setCompacting: (compacting) => set((state) => (state.compacting === compacting ? state : { compacting })),
    dropStrayBottom: () => {
      let dropped = 0;
      set((state) => {
        // Rows past the newest ledger page are live appends that landed while
        // the span between them and the window was not held. Joining the
        // window to them would put them in the wrong place.
        const newest = state.historyPages[state.historyPages.length - 1];
        if (!newest) return state;
        const at = state.messages.findIndex((message) => message.id === newest.lastId);
        if (at < 0) return state;
        const after = state.messages.slice(at + 1);
        const strays = after.filter((message) => !isOptimistic(message));
        if (strays.length === 0) return state;
        dropped = strays.length;
        return {
          messages: [...state.messages.slice(0, at + 1), ...after.filter(isOptimistic)],
          evictedBottom: state.evictedBottom + dropped,
        };
      });
      return dropped;
    },
    advanceEvictedBottom: (page, loaded, after) =>
      set((state) => {
        const historyPages = page ? [...state.historyPages, page] : state.historyPages;
        if (after === null) return { historyPages, evictedBottom: 0, evictedBottomAfter: null };
        // Counting is by message, the cursor by byte: keep the pill up until
        // the cursor says the live edge is reached.
        return { historyPages, evictedBottom: Math.max(1, state.evictedBottom - loaded), evictedBottomAfter: after };
      }),
    trimWindow: (max, atBottom) =>
      set((state) => {
        let { messages, historyPages, historyCursor, evictedTop, trimmedTop, evictedBottom, evictedBottomAfter } = state;
        let changed = false;
        // Drop whole oldest pages while over budget and more than one page is
        // held: page-granular eviction keeps the reload cursor exact (each
        // page's own `before` refetches exactly that page).
        while (atBottom && messages.length > max && historyPages.length > 1) {
          const [evicted, ...rest] = historyPages;
          // Locate the page's newest boundary by id: live merges only ever
          // append newer ids at the bottom, so the boundary sits within the
          // first (page count + slack) rows. Missing boundary = ledger stale;
          // stop rather than drop messages we cannot refetch.
          const idx = messages.findIndex((m) => m.id === evicted.lastId);
          if (idx < 0 || idx > evicted.count + 8) break;
          const reloadBefore = evicted.before ?? evicted.nextBefore;
          if (reloadBefore == null) {
            // Oldest page was the tail seed (unfetchable once the file grew):
            // count it as trimmed, not evicted.
            messages = messages.slice(idx + 1);
            historyPages = rest;
            historyCursor = evicted.nextBefore;
            trimmedTop += idx + 1;
            changed = true;
            continue;
          }
          messages = messages.slice(idx + 1);
          historyPages = rest;
          historyCursor = evicted.nextBefore;
          evictedTop = {
            before: reloadBefore,
            count: (evictedTop?.count ?? 0) + (idx + 1),
          };
          changed = true;
        }
        if (messages.length > max) {
          const overBy = messages.length - max;
          if (atBottom) {
            // Only a partial page can go (single page held): trim the prefix
            // with no reload cursor. The file is intact; Load Earlier still
            // pages everything older than `historyCursor`. Never trim an
            // optimistic echo (they live at the bottom, so stopping at the
            // first one is near-free).
            let drop = 0;
            while (drop < overBy && drop < messages.length && !isOptimistic(messages[drop])) drop++;
            if (drop > 0) {
              messages = messages.slice(drop);
              if (historyPages.length === 1) {
                const [only] = historyPages;
                historyPages = [{ ...only, firstId: messages[0].id, count: Math.max(0, only.count - drop) }];
              }
              trimmedTop += drop;
              changed = true;
            }
          } else {
            // Scrolled up: the far end is the live tail the reader left.
            // Never drop optimistic echoes; count the rest for the jump pill.
            let drop = 0;
            for (let i = messages.length - 1; i >= 0 && drop < overBy; i--) {
              if (isOptimistic(messages[i])) break;
              drop++;
            }
            if (drop > 0) {
              messages = messages.slice(0, messages.length - drop);
              // A backward page can displace several newer pages, not just
              // the last one. Remove their records and clip the held boundary.
              const held = historyPages;
              let affected: (typeof held)[number] | undefined;
              historyPages = held.flatMap((page) => {
                const first = messages.findIndex((message) => message.id === page.firstId);
                if (first < 0) {
                  affected ??= page;
                  return [];
                }
                const heldLast = messages.findIndex((message) => message.id === page.lastId);
                if (heldLast >= 0) return [page];
                affected ??= page;
                return [{ ...page, lastId: messages[messages.length - 1].id, count: Math.min(page.count, messages.length - first) }];
              });
              // Where reading forward resumes. The oldest page that lost rows
              // starts at its `nextBefore`, and refetching from there (rows
              // already held dedupe by id) leaves no hole. Rows beyond every
              // page (live appends) resume from the newest page's start. A
              // gap that is already open keeps its older cursor unless this
              // drop reached further back. Null = unknown: the jump button's
              // tail reseed is then the only way back, as before.
              if (affected) evictedBottomAfter = affected.nextBefore;
              else if (evictedBottom === 0) evictedBottomAfter = held.length > 0 ? held[held.length - 1].nextBefore : null;
              evictedBottom += drop;
              changed = true;
            }
          }
        }
        if (!changed) return state;
        return { messages, historyPages, historyCursor, evictedTop, trimmedTop, evictedBottom, evictedBottomAfter };
      }),
  }));
}
