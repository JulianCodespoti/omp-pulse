import { readPairingToken } from "../platform/browser-storage";
import { capturePairingRecovery, clearPairingRecovery } from "./offline-queue";
import { withLocalSendOwner } from "../domain/local-send-provenance";
import { withResponseItem } from "../domain/response-item-provenance";
import { ReceiptValidationError, RECEIPT_BINDING_CAPABILITY, validateBoundReceiptResponse, retainedReceiptBinding } from "./command-receipt";
import { RunningAgentCountTracker } from "./running-agent-count";
import { noteDaemonReachable } from "./daemon-reachability";
import { getLinkState, probeLink, reportChatSocket, reportLinkOk, setLinkOrigin, subscribeLink } from "./link-state";
import { clearAttachmentDrafts } from "./attachment-draft";
import { clearFileDraftMemory } from "./file-draft";
import { clearNewSessionDraftMemory } from "./new-session-draft";
import { prepareForReload } from "./prepare-for-reload";
import { mergeStreamText } from "../domain/stream-text";
import { appendStreamDisplay, replaceStreamDisplay, streamDisplaySnapshot, type StreamDisplay } from "../domain/stream-display";
import { getAssistantDisplayBoundaries, getRawAssistantText, withRawAssistantText } from "../domain/message-provenance";
import { acknowledgeNativeSave, usesNativeOutbox } from "./native-outbox";
import { startVisibleInterval } from "./visible-interval";
import { deliveryFailed } from "./receipt-outcome";
import {
  createUserMessage,
  entriesToTranscript,
  customMessageToTranscript,
  entryToUiMessage,
  mergeToolParts,
  recordedEdits,
  parseToolImages,
  parseToolSearch,
  parseTodoPhases,
  parseShellOutcome,
  newestCompactionBoundary,
  parseAgentStatuses,
  withAgents,
  type UiMessage,
  type UiPart,
} from "../domain/messages";
import { addTimelineMarkers, clearTimelineMarkers } from "../domain/timeline";
import { fetchWithDeadline, readJsonResponse } from "./request";
import { consumeReceiptAbsenceBody } from "./receipt-absence-body";
import {
  decodeBinaryFrame,
  eventMessage,
  isJsonObject,
  parseTextFrame,
  type JsonObject,
  type OmpActivity,
  type OmpEntry,
  type OmpEventFrame,
  type OmpFrame,
  type OmpHistoryPage,
  type OmpMessage,
  type OmpSessionSummary,
  type OmpSessionListingPage,
  onPhoneClock,
  parseOmpActivity,
  parseSessionAuthority,
} from "../domain/protocol";
import { clearAllDrafts } from "../app/composer/use-draft";
import { clearPromptHistory } from "../app/composer/prompt-history-store";
import { restoreWithdrawnDraft } from "../app/composer/withdrawn-draft";
import { showBanner, showToast } from "../app/Notices";
import { shortModel } from "../app/session-format";
import { UNCERTAIN_SEND_TOAST } from "../app/send-copy";
import { isPhoneMode } from "../platform/local-mode";
import { parseRetryStart } from "../domain/run-status";
import type { CommandReceipt, ReceiptResponse } from "./api-types";
import type { CachedTail } from "./offline-cache";
import {
  clearAllCachedHistory,
  clearOfflineHistory,
  loadSessionList,
  loadTail,
  saveSessionList,
  saveTail,
  setOfflineCacheNamespace,
} from "./offline-cache";
import {
  UndispatchedError,
  clearAsync as clearOutboxAsync,
  enqueue,
  flush,
  getImages,
  getOutboxDiagnostics,
  getOfflineQueueNamespace,
  getQueued,
  getSnapshot as getOutboxSnapshot,
  offlineQueueNamespaceForCredential,
  pending,
  pendingAll,
  queuedCount,
  setOfflineQueueNamespace,
  applyReceipt,
  assertDispatchCurrent,
  captureQueueScope,
  sameQueuedIntent,
  maintainPendingSends,
} from "./offline-queue";
import { NO_QUEUED_MESSAGES, parsePassiveSessionModel, parseQueuedMessages, parseSessionModel, selectActivity, selectSessionCapability, selectSessionTurn, selectAbortRestoresQueue, selectCanPromoteQueuedMessage } from "./omp-store";
import type { CollabRequest, OmpStoreApi, SessionStateEvidence } from "./omp-store";
import type { OutboxDiagnostics, QueuedPrompt } from "./offline-queue";
import type { PromptDelivery } from "../domain/send-mode";
import { loadMessageImages } from "./message-images";
import { reduceStateEvent } from "./omp-state-events";
import { createBtwStore, reduceBtwFrame, type BtwStore } from "./btw";
import { clearExtensionDialogs, closeExtensionDialog, markExtensionDialogDelivery, reduceExtensionDialogSnapshot, reduceExtensionUiRequest, type ExtensionDialogResponse } from "./extension-dialogs";
import { clearExtensionDrafts, consumeExtensionDraft, prepareExtensionDraft, readExtensionDraft, recoverExtensionNotices, reduceExtensionFeedback } from "./extension-feedback";
import { acknowledgeCollabAnswer, collabAnswerCanRetry, interruptCollabAnswer, type CollabAnswerState } from "./collab-answer";
import { collabSelectionMetadata } from "./collab-selection";
import { readCollabQuestionFrame, collabQuestionIdentity, collabQuestionKey, collabQuestionSettled, type CollabQuestionCursor, type CollabQuestionIdentity } from "./collab-question-lifecycle";
import { modelFallbackMarker, parseModelFallback, type ModelFallback } from "../domain/model-fallback";
import { clearReviewNotes } from "./review-notes";
import { goalFromState, reduceGoal, type GoalSnapshot } from "./goal-state";
import { newestPlanMode, type PlanModeState } from "./plan-state";
import { branchMoved, filterAbandoned, type BranchFilterResult, type BranchFrontier } from "./branch-view";
import { parseQueueImages, parseWithdrawnQueue, type WithdrawnQueue } from "./withdrawn-queue";

// Markers use the same humane alias as the header pill ("Opus 4.1"), so the
// transcript and the pill never name one model two different ways.
function shortAlias(model: unknown): string {
  return typeof model === "string" ? shortModel(model) : "";
}

function dateMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

type SessionMarker = import("../domain/timeline").TimelineMarkerInput;

/** What the transcript needs to stay on the current branch across pages (branch-view.ts). */
type BranchViewState = {
  /** What the oldest loaded page continues with; the next older page keeps only that chain. */
  frontier: BranchFrontier;
  /** Ids a move abandoned that the phone has read: an evicted span reloaded by cursor drops them again. */
  dropped: Set<string>;
  /** The leaf the transcript was built to; an append that does not continue it means a tree move happened. */
  leaf: string | null;
};


/** The summary text the model carries forward, for the tap-to-read detail. Capped: it is prose, not a transcript. */
function withDetail(marker: SessionMarker, summary: unknown): SessionMarker {
  return typeof summary === "string" && summary.trim() ? { ...marker, detail: summary.trim().slice(0, 20_000) } : marker;
}

function markerFromEntry(entry: OmpEntry, thinking: string): SessionMarker | null {
  const at = dateMs(entry.timestamp);
  // INVARIANT: ids (or entry metadata), never page-relative indexes, key events.
  const id = entry.id || JSON.stringify([entry.type, entry.customType, entry.timestamp, entry.parentId]);
  const marker = (kind: string, label: string, icon: SessionMarker["icon"]): SessionMarker => ({
    key: `marker:${kind}:${id}`, label, at, icon, tone: "muted",
  });
  // Newest 200 sessions (2026-10-03): compaction has tokensBefore/tokensAfter
  // and summary; branch_summary has summary/fromId. Neither summary is chat copy.
  // Thinking-level and mode changes make no marker: the composer's model chip
  // shows that state, and a line per toggle crowded the transcript.
  switch (entry.type) {
    case "compaction":
      return withDetail(marker("compaction", "Context compacted", "compaction"), entry.summary);
    case "reset_boundary":
      return withDetail(marker("context-clear", "Context cleared", "compaction"),
        "Earlier messages remain in saved history but are no longer included in the model’s context. No session history or files were deleted.");
    case "branch_summary":
      return withDetail(marker("branch", "Branch summary added", "branch"), entry.summary);
    // model_change has model/optional role, not thinkingLevel; thinking changes
    // carry thinkingLevel and configured separately. Reuse the adjacent level.
    case "model_change": {
      const alias = shortAlias(entry.model);
      if (!alias) return null;
      const level = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : thinking;
      return { ...marker("model", `Switched to ${alias}${level ? ` · ${level[0]!.toUpperCase()}${level.slice(1)}` : ""}`, "model"), ...(level ? { thinkingLevel: level } : {}) };
    }
    case "custom": {
      if (entry.customType !== "omp-pulse-model-fallback") return null;
      const fallback = parseModelFallback(entry.data);
      return fallback ? modelFallbackMarker(fallback, `marker:fallback:${id}`, at) : null;
    }
    case "title_change":
      return typeof entry.title === "string" && entry.title ? marker("title", `Renamed to “${entry.title}”`, "rename") : null;
    default:
      return null;
  }
}

function collectMarkers(entries: readonly OmpEntry[]): SessionMarker[] {
  const out: SessionMarker[] = [];
  const transitions = new Map<SessionMarker["icon"], string>();
  let thinking = "";
  const shortName = (value: unknown): string => {
    if (typeof value !== "string") return "";
    const line = value.replace(/\s+/g, " ").trim();
    return line.length > 44 ? `${line.slice(0, 43)}…` : line;
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!isJsonObject(entry)) continue;
    const next = entries[i + 1];
    if (entry.type === "thinking_level_change") {
      thinking = typeof entry.configured === "string" ? entry.configured
        : typeof entry.thinkingLevel === "string" ? entry.thinkingLevel
        : typeof entry.thinking_level === "string" ? entry.thinking_level : "";
    }
    const nextThinking = next?.type === "thinking_level_change"
      ? typeof next.configured === "string" ? next.configured : typeof next.thinkingLevel === "string" ? next.thinkingLevel : thinking
      : thinking;
    const m = markerFromEntry(entry, nextThinking);
    if (m) {
      const transition = !m.detail && (m.icon === "model" || m.icon === "rename");
      if (transition && transitions.get(m.icon) === m.label) continue;
      if (transition) transitions.set(m.icon, m.label);
      out.push(m);
      continue;
    }
    if (entry.type !== "custom_message") continue;
    const details = isJsonObject(entry.details) ? entry.details : {};
    const at = dateMs(entry.timestamp);
    const id = entry.id || JSON.stringify([entry.customType, entry.timestamp, entry.parentId]);
    // 1,009 irc:incoming entries: details.from/id/message (+ optional replyTo).
    // Only the peer name belongs in the timeline, never the message body.
    if (entry.customType === "irc:incoming") {
      out.push({ key: `marker:agent:${id}`, label: `${shortName(details.from) || "Agent"} messaged`, at, icon: "agent" });
      continue;
    }
    // INVARIANT: custom messages are allowlisted. Todo nudges, TTSR/goal
    // injections, exits, credential pins, service tiers and title duplicates
    // remain hidden; display:true alone does not make an event chat furniture.
    if (entry.customType !== "async-result" && entry.customType !== "launch-completion") continue;
    const launched = entry.customType === "launch-completion";
    // Measured: 1,624 async-result entries have details.jobs[{jobId,type,label,
    // durationMs}], without status; 131 launch-completion entries instead have
    // details.daemons[{id,name,state,exitCode?,exitReason?,...}]. Batches need
    // one keyed line per job. Async status lives only in the content envelope.
    const values = launched ? details.daemons : details.jobs;
    const jobs = Array.isArray(values) && values.length ? values : [details];
    const content = typeof entry.content === "string" ? entry.content : "";
    // The producer separates batched results with “── Job <id> (...) ──”.
    // Parse only the envelope, not arbitrary occurrences of "failed" in output.
    const sections = content.split(/^── Job .* ──\s*$/m).slice(1);
    for (let j = 0; j < jobs.length; j++) {
      const job: unknown = jobs[j];
      if (!isJsonObject(job)) continue;
      const rawJobId = launched ? job.id : job.jobId;
      const jobId = shortName(rawJobId);
      const name = shortName(launched ? job.name : job.label) || jobId;
      const result = sections.length === jobs.length ? sections[j]! : jobs.length === 1 ? content : "";
      const status = /<task-result\b[^>]*\bstatus="([^"]*)"/.exec(result)?.[1];
      const exit = /^Command exited with code (-?\d+)\s*$/m.exec(result)?.[1];
      const failed = launched
        ? typeof job.exitCode === "number" && job.exitCode !== 0 || typeof job.exitReason === "string" && !!job.exitReason
        : typeof job.exitCode === "number" && job.exitCode !== 0
          || !!status && /^(?:failed|error|cancelled|aborted|timed[- ]?out)/i.test(status)
          || exit !== undefined && Number(exit) !== 0;
      out.push({
        key: `marker:${launched ? "launch" : "job"}:${id}:${typeof rawJobId === "string" ? rawJobId : j}`,
        label: `Background job ${failed ? "failed" : "finished"}${name ? ` · ${name}` : ""}`,
        at, icon: "job", tone: failed ? "warn" : "muted",
      });
    }
  }
  return out;
}

/**
 * Identity of a painted transcript tail: last message id, message count, and
 * the number of unfinished tool calls.
 *
 * This is the content latch's key. Session files are append-only and ids come
 * from them, so an equal last id AND an equal count means a tail page holds
 * the messages already on screen — which is the one case where the list must
 * NOT be rewritten, because handing React a fresh array costs the reader his
 * scroll anchor for no change in content. The unfinished-call count is there
 * because ids alone are not content: a cached tail once carried phantom
 * "running" tool rows under the right ids, and the latch kept them on screen
 * against a page that had every result.
 */
function tailKey(messages: readonly UiMessage[]): string {
  if (messages.length === 0) return "";
  let running = 0;
  for (const message of messages) {
    for (const part of message.parts) if (part.kind === "tool" && part.state === "running") running += 1;
  }
  return `${messages[messages.length - 1].id}:${messages.length}:${running}`;
}

interface HistoryResponse extends JsonObject {
  entries?: OmpEntry[];
  endOffset?: number;
  nextBefore?: number | string | null;
  running?: boolean;
  now?: OmpActivity | null;
  at?: number;
}

interface SessionListingOptions {
  query?: string;
  pinned?: readonly string[];
  includeLive?: boolean;
  project?: string | null;
}

interface SessionListingScope {
  query: string;
  pinned: string[];
  includeLive: boolean;
  project: string | null;
  key: string;
}

interface CachedSessionListingPage {
  etag: string | null;
  page: OmpSessionListingPage;
}

const SESSION_PAGE_SIZE = 50;
const MAX_CACHED_SESSION_PAGES = 8;

function normalizeSessionListingScope(options: SessionListingOptions): SessionListingScope {
  const query = (options.query ?? "").trim().toLowerCase();
  const pinned = [...new Set(options.pinned ?? [])]
    .filter((path) => path.length > 0 && path.length <= 4096)
    .sort()
    .slice(0, 50);
  const includeLive = options.includeLive !== false;
  const project = typeof options.project === "string" && options.project.length > 0 ? options.project : null;
  return { query, pinned, includeLive, project, key: JSON.stringify([query, pinned, includeLive, project]) };
}

function sessionListingPageKey(scope: SessionListingScope, cursor: string | null, limit = SESSION_PAGE_SIZE): string {
  return JSON.stringify([scope.key, cursor, limit]);
}
/** One latch arbitrates the cache paint, first bundle, and HTTP fallback. */
interface OpeningHistoryPage {
  generation: number;
  path: string;
  cachedTail: Promise<CachedTail | null>;
  painted: { source: "none" | "cache" | "network"; key: string };
  pageApplied: boolean;
  bundleSeen: boolean;
  fallbackStarted: boolean;
  settled: boolean;
  warmTimer: number | null;
  fallbackTimer: number | null;
  resolve: () => void;
}

interface PendingDelta {
  keep: number | null;
  text: string;
  generated: number | undefined;
}

/** Backward page size. The daemon defaults to 50 and hard-caps at 200. */
const HISTORY_PAGE = 50;
/**
 * Entries in the FIRST page of an open (the `/ws` bundle or its HTTP
 * fallback). Every row costs React render plus a markdown parse even under
 * `content-visibility: auto`, and only the last 6-10 are on screen: profiled
 * at 306 ms of JS for a 50-row open on the phone. The page above follows at
 * once from LoadEarlier's idle prefetch, anchored like any scroll-up page.
 */
const FIRST_HISTORY_PAGE = 20;
/** A backward page showing fewer readable rows than this is "thin": see loadEarlier. */
const EARLIER_THIN_PAGE = 4;
/**
 * How long to let the history request run before painting the cached tail.
 *
 * Chosen to be longer than a healthy round trip (measured ~28ms on loopback,
 * and the daemon does no child spawn on this path) and shorter than the point
 * at which an empty screen reads as broken. Under it the authoritative page
 * wins and the transcript is written exactly once; over it the user sees the
 * conversation they were just in instead of nothing.
 *
 * The timer is a HINT, never the guard: `openSession` clears it the instant
 * the fetch settles and latches WHAT is on screen, so a throttled, starved or
 * already-fired timer can never write over fresh data.
 */
const OPTIMISTIC_TAIL_DELAY_MS = 150;
/**
 * In-memory transcript cap. The phone holds a WINDOW into the session file,
 * not the file: past this many messages the far end is evicted (reloadable
 * top pages via cursor, counted bottom drops for the jump pill) and refetched
 * on demand. 400 turns × the 15k render clamp ≈ 6 MB text worst case; the
 * daemon pages any evicted span back in ~1 ms (docs/internals/performance.md F4).
 */
const MAX_WINDOW_MESSAGES = 400;
/**
 * The cap when omp runs on this phone (`isPhoneMode`): the WebView then shares
 * RAM with the proot guest and its omp children, and the low-memory killer
 * takes the whole app. Every held message stays MOUNTED (rows are
 * `content-visibility:auto`, not virtualized), so DOM, fibers and markdown
 * trees scale with this number; their text alone measured 0.8-2.4 MB for the
 * worst 400-message window of real phone-harness sessions vs 0.4-1.6 MB for
 * 200. 200 messages is still four 50-entry history pages of scrollback; the
 * rest pages back in by cursor exactly as above.
 */
const PHONE_MODE_WINDOW_MESSAGES = 200;
const HISTORY_MAX_PAGE = 200;
/** Pages a Timeline tap may load to reach an older turn (thin pages widen to HISTORY_MAX_PAGE entries). */
const REVEAL_MAX_PAGES = 20;
/** Outcome of `revealEntry`. */
export type RevealResult = "revealed" | "off-branch" | "unreachable";
/** Floor between forward catch-ups, so bursts of poll frames cost one fetch. */
const CATCH_UP_COOLDOWN_MS = 1_500;
/** Heartbeat is 20s; treat three missed beats as a dead socket. */
const STALE_SOCKET_MS = 45_000;
const WATCHDOG_TICK_MS = 15_000;
/**
 * Flush cadence when the tab is hidden and animation frames stop firing.
 * Nothing is painted while hidden, yet every flush still publishes the live
 * message and re-renders/re-parses its markdown. 64 ms kept a backgrounded
 * WebView rendering ~15 times a second for a whole turn; once a second keeps
 * state reasonably fresh, terminal events drain synchronously, and `onVisible`
 * flushes the remainder at once.
 */
const HIDDEN_FLUSH_MS = 1_000;
/** Visible but without requestAnimationFrame (non-browser hosts): one frame. */
const FRAME_FALLBACK_FLUSH_MS = 64;
/**
 * Visible-only liveness probe for a socket stuck in a state the watchdog
 * skips. It used to run while hidden too and reopened sockets from the
 * background every 30 s; visible resume already reconnects, so a hidden page
 * now reconnects nothing.
 */
const LIVENESS_PROBE_MS = 30_000;
/**
 * A socket still CONNECTING after this long is closed and retried. A hung
 * handshake (packets dropped, nothing refused) used to sit in "connecting"
 * for 75 s with no sign of trouble anywhere on screen.
 */
const HANDSHAKE_TIMEOUT_MS = 8_000;
/** The heartbeat is 20 s; a frame later than this is a reason to ask the link. */
const SUSPICIOUS_SILENCE_MS = 25_000;
const SUSPICION_TICK_MS = 5_000;
/** A person acting on a chat that has been silent this long makes the app check the link first. */
const ACTIVITY_SILENCE_MS = 8_000;
/**
 * Listing poll cadence while `/ws/sessions` is open and hearing heartbeats:
 * the socket pushes changes, so HTTP is only the fallback for lost discovery
 * events. Down or stale, the short cadence (`sessionsPollIntervalMs`) applies.
 */
const SESSIONS_FALLBACK_POLL_MS = 30_000;
/** 5-strike ejection threshold. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Give the initial bundle one cellular RTT before falling back to HTTP. */
const BUNDLE_HISTORY_FALLBACK_MS = 1_500;
/** A real background suspend can leave Android's OPEN socket half-alive. */
const FOREGROUND_REVALIDATE_MS = 3_000;

/** The wire carries byte offsets as numbers or numeric strings. */
function normalizeOffset(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isNetworkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  const lower = msg.toLowerCase();
  return (
    lower.includes("network") ||
    lower.includes("failed to fetch") ||
    lower.includes("load failed") ||
    lower.includes("fetch failed") ||
    msg.includes("TypeError") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  );
}
/** Hears one `bash_output` frame: a run's id and its new output. */
export type BashOutputListener = (runId: string, text: string) => void;
export interface ClientDiagnostics {
  releaseId: string;
  protocolVersion: number;
  serverProtocolVersion: number | null;
  serverMinClientProtocolVersion: number | null;
  connection: string;
  offline: boolean;
  session: { present: boolean; id: string | null };
  lastFrameAt: number | null;
  heartbeatAt: number | null;
  serverReleaseId: string | null;
  authRejected: boolean;
  outbox: OutboxDiagnostics;
  receipts: { count: number; states: Record<string, number> };
}

export interface UpdateSafetyStatus {
  loadedReleaseId: string;
  serverReleaseId: string | null;
  protocolVersion: number;
  serverProtocolVersion: number | null;
  serverMinClientProtocolVersion: number | null;
  compatible: boolean;
  updateAvailable: boolean;
  pendingWork: boolean;
  pendingSessionPath: string | null;
}

const CLIENT_PROTOCOL_VERSION: number = import.meta.env.VITE_PROTOCOL_VERSION;
const LOADED_RELEASE_ID =
  typeof import.meta !== "undefined" &&
  typeof import.meta.env?.VITE_RELEASE_ID === "string" &&
  import.meta.env.VITE_RELEASE_ID.trim()
    ? import.meta.env.VITE_RELEASE_ID.trim()
    : "dev";

function opaqueSessionId(path: string | null): string | null {
  if (!path) return null;
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
const MAX_RETAINED_COLLAB_ANSWERS = 64;

export class OmpSessionController {
  private readonly store: OmpStoreApi;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly queueNamespace: string;
  private readonly cacheNamespace: string;
  private socket: WebSocket | null = null;
  private activeSession: string | null = null;
  /** Sessions whose journal replay is running; one loop per namespace and session. */
  private readonly queueRecoveryInFlight = new Set<string>();
  /** Viewport edge the reader sits at. Eviction always drops the FAR end:
   * oldest pages while at the live edge, newest while scrolled up. Reported
   * by the chat scroll listener; defaults true (open lands at the bottom). */
  private atBottom = true;
  /** The reader is in the lower half of the held window: the oldest end is the far one. */
  private lowerHalf = true;
  /** A forward read across the dropped bottom span is running (loadLater). */
  private laterInFlight = false;
  /** Transcript window cap, fixed per controller (see PHONE_MODE_WINDOW_MESSAGES). */
  private readonly windowMessages = isPhoneMode() ? PHONE_MODE_WINDOW_MESSAGES : MAX_WINDOW_MESSAGES;
  /** Last text-only prompt per the double-tap backstop (session, text, ms). */
  private lastSend: { sessionPath: string; text: string; at: number } | null =
    null;
  private generation = 0;
  private queueSeedTicket: object | null = null;
  /** Live feedback can advance without changing the session authority revision. */
  private feedbackIngressSequence = 0;
  private feedbackResetSequence = 0;
  /** A terminal boundary also closes questions this client never saw. */
  private dialogLifecycleSequence = 0;
  private modelEntryAt = 0;
  private thinkingEntryAt = 0;
  private fallbackEntryAt = 0;
  private configurationPending = false;
  private titleEntryAt = 0;
  // Branch view after an in-place move (branch-view.ts). Created on first
  // use rather than by a field initializer: controllers built from the
  // prototype (the unit fixtures) skip initializers, and every history ingest
  // path reads this.
  private branchViewState: BranchViewState | undefined;
  private get branchView(): BranchViewState {
    return (this.branchViewState ??= { frontier: null, dropped: new Set(), leaf: null });
  }
  /** Timestamp of the newest `mode_change` adopted (plan-state.ts); same rule as `modelEntryAt`. */
  private planEntryAt = 0;
  /** A `plan_mode` reply is newer than anything above the tail, so backward pages cannot override it. */
  private planFromReply = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private responseChain: string | null = null;
  private streamText = "";
  private streamDisplay: StreamDisplay | null = null;
  // Exact comparison proof; raw coordinates and display boundaries live together.
  private streamRawText: string | null = null;
  private pendingDeltas: PendingDelta[] = [];
  private flushHandle: number | null = null;
  private flushKind: "raf" | "timer" | null = null;
  private disposed = false;
  private readonly runningAgentCount: RunningAgentCountTracker;

  private sessionsListingScope = normalizeSessionListingScope({});
  private sessionsListingGeneration = 0;
  private sessionsListingLifetime = 0;
  private readonly sessionsPageCache = new Map<string, CachedSessionListingPage>();
  // Drawer searches must not evict the main list's page/cursor retention proof.
  private readonly switcherPageCache = new Map<string, CachedSessionListingPage>();
  private sessionsTimer: number | null = null;
  /** The pending poll is the 30 s socket-backed one, not the short cadence. */
  private sessionsPollRelaxed = false;
  private sessionsSocket: WebSocket | null = null;
  private sessionsLastFrameAt = 0;
  private sessionsLive = false;
  /**
   * This device's clock minus the daemon's, from the newest stamped activity
   * frame (0 until one arrives). Transcript timestamps are written on the
   * laptop; add this to compare them with the phone's `Date.now()`.
   */
  private clockShift = 0;
  private sessionsReconnectTimer: number | null = null;
  /** Consecutive sessions-socket closes without a frame; drives the backoff. */
  private sessionsReconnectAttempt = 0;
  private sessionsRefreshGeneration = 0;
  private readonly sessionsInFlight = new Map<string, { generation: number; promise: Promise<void> }>();
  private sessionsCacheHydrated = false;
  private sessionsPollIntervalMs = 3_000;
  private earlierInFlight = false;
  /** A second reveal can share the backward read already in flight. */
  private earlierFinished: Promise<void> | null = null;
  /** Temporary oldest-preserving window, released by the caller after landing. */
  private revealWindow: {
    entryId: string;
    sessionPath: string;
    generation: number;
    epoch: number;
    shouldApply: () => boolean;
  } | null = null;
  // A tail replacement invalidates reads started against the previous window.
  private earlierEpoch = 0;
  /** Entries per backward page; widens while pages come back thin (see loadEarlier). */
  private earlierLimit = HISTORY_PAGE;
  private catchUpInFlight = false;
  private historyAbort = new AbortController();
  private lastCatchUpAt = 0;
  /**
   * A `resync` or `poll` that could not run yet: another catch-up was in
   * flight (its page may predate what the frame reports) or the cooldown was
   * on. Both frames mean the socket lost something only a fetch restores, and
   * refusing one used to DROP it: a resync that met an in-flight catch-up left
   * that older page's "running" standing after the turn had ended, and a poll
   * inside the cooldown left the jumped-over entries missing until some
   * unrelated catch-up happened to run. Deferred now, never dropped.
   */
  private catchUpOwed: "resync" | "poll" | null = null;
  private catchUpTimer: number | null = null;
  /** Monotonic ingress ordering for old daemons without revisioned authority. */
  private stateIngressSequence = 0;
  /**
   * Tail of the in-order inbound frame queue; null when nothing is decoding.
   *
   * INVARIANT: socket frames are handled in ARRIVAL order. Frames at or above
   * the daemon's `ws_deflate_min` (4 KB) arrive as raw-deflate binary and
   * decode asynchronously, while small frames are text and parse at once.
   * Handling each as it became ready meant a text frame always overtook the
   * binary frame before it (measured in Chromium: the decode finishes after
   * the next message task, every time). The open or reconnect bundle, a
   * snapshot saying the turn runs, was applied AFTER the `agent_end` and idle
   * `activity` queued behind it; a lagging client's full message snapshot was
   * applied after the delta built on it, and that text was gone from the live
   * reply. Decodes still run concurrently; only their handling waits its
   * turn, and a text frame with nothing queued ahead keeps the direct path.
   */
  private inbound: Promise<void> | null = null;
  private lastFrameAt = 0;
  // Disposers from `startVisibleInterval`: a hidden page arms none of these.
  private watchdogTimer: (() => void) | null = null;
  private livenessProbe: (() => void) | null = null;
  private suspicionTimer: (() => void) | null = null;
  /** The `lastFrameAt` value already probed, so one silence costs one probe. */
  private probedSilenceAt = 0;
  private unsubscribeLink: (() => void) | null = null;
  private offlineTicker: (() => void) | null = null;
  private reconcilingReceipts = false;
  // Drafts and submissions share one bounded cache per auth scope. Never evict
  // an outstanding value to make room for another question.
  private collabAnswers = new Map<string, CollabAnswerState>();
  private collabQuestionCursor: CollabQuestionCursor | null = null;
  private currentCollabQuestion: CollabQuestionIdentity | null = null;
  private maintainingPendingSends = false;
  private visibilityBound = false;
  private consecutiveFailures = 0;
  private serverReleaseId: string | null = null;
  private serverProtocolVersion: number | null = null;
  private serverMinClientProtocolVersion: number | null = null;
  private heartbeatAt: number | null = null;
  private updateBannerShown = false;
  private openingHistory: OpeningHistoryPage | null = null;
  private hiddenAt: number | null = null;
  private networkChangedWhileHidden = false;
  private revalidatedWhileHidden = false;
  // Missed history remains pending until a successful read covers its version:
  // healthy socket heartbeats do not prove a failed resync recovered anything.
  private resyncPending = false;
  private resyncVersion = 0;
  /** One automatic retry per recovery burst; exhaustion keeps the error/debt. */
  private resyncRetryUsed = false;
  private readonly onVisible = () => {
    if (document.visibilityState === "hidden") {
      if (this.hiddenAt === null) {
        this.hiddenAt = Date.now();
        this.networkChangedWhileHidden = false;
        this.revalidatedWhileHidden = false;
      }
      this.reportVisibility();
      if (this.activeSession) {
        this.resyncPending = true;
        this.resyncVersion++;
      }
      this.pauseSessionsPoll();
      if (this.sessionsReconnectTimer !== null) window.clearTimeout(this.sessionsReconnectTimer);
      this.sessionsReconnectTimer = null;
      if (this.catchUpTimer !== null) window.clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
      return;
    }
    this.resyncRetryUsed = false;
    void this.maintainLocalPendingSends();
    const hiddenAt = this.hiddenAt;
    const hiddenForMs = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    const networkChanged = this.networkChangedWhileHidden;
    const revalidatedWhileHidden = this.revalidatedWhileHidden;
    this.hiddenAt = null;
    this.networkChangedWhileHidden = false;
    this.revalidatedWhileHidden = false;

    this.reportVisibility();
    this.syncOffline();
    this.flushHiddenStreamNow();
    void this.flushQueue();
    void this.refreshSessions();

    const stale =
      this.activeSession !== null &&
      Date.now() - this.lastFrameAt >= STALE_SOCKET_MS;
    const forceReconnect =
      stale ||
      (!revalidatedWhileHidden &&
        (hiddenForMs >= FOREGROUND_REVALIDATE_MS || networkChanged));
    if (this.sessionsLive)
      this.connectSessionsSocket(forceReconnect || Date.now() - this.sessionsLastFrameAt >= STALE_SOCKET_MS);
    this.scheduleSessionsPoll();
    if (forceReconnect) {
      this.cancelReconnect();
      this.lastCatchUpAt = 0;
    }
    // A short app switch is harmless; longer hides and network changes can
    // leave a readyState-OPEN socket that will never deliver another frame.
    // Foreground recovery gets one attempt even after the five-failure gate.
    this.reviveSocket(forceReconnect, true);
    void this.catchUpWithResult(
      this.resyncPending ? "resync" : forceReconnect ? "visible-resume" : "visible",
    ).then((recovered) => {
      if (recovered) this.reviveSocket(false, true);
    });
  };
  private readonly onOnline = () => {
    this.resyncRetryUsed = false;
    if (document.visibilityState === "hidden")
      this.revalidatedWhileHidden = true;
    this.syncOffline();
    void this.flushQueue();
    this.cancelReconnect();
    this.lastCatchUpAt = 0;
    this.reviveSocket(true, true);
    void this.catchUpWithResult("online").then((recovered) => {
      if (recovered) this.reviveSocket(false, true);
    });
    void this.refreshSessions();
    if (this.sessionsLive) this.connectSessionsSocket(true);
  };
  private readonly onOffline = () => {
    if (document.visibilityState === "hidden")
      this.networkChangedWhileHidden = true;
    this.syncOffline();
    const opening = this.openingHistory;
    if (opening && !opening.pageApplied)
      this.startInitialHistoryFallback(opening);
  };
  constructor(
    store: OmpStoreApi,
    token: string,
    baseUrl = window.location.origin,
  ) {
    this.store = store;
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    setLinkOrigin(this.baseUrl);
    this.runningAgentCount = new RunningAgentCountTracker(store, (path, signal) =>
      this.request(`/api/agents/roster?${new URLSearchParams({ session: path })}`, { signal }));
    this.runningAgentCount.start();
    this.queueNamespace = offlineQueueNamespaceForCredential(token);
    this.cacheNamespace = this.queueNamespace;
    setOfflineQueueNamespace(this.queueNamespace);
    setOfflineCacheNamespace(this.cacheNamespace);
    this.bindVisibility();
    this.syncOffline();
    this.syncQueuedCount();
    this.startOfflineTicker();
  }

  private checkHeartbeatVersion(
    served: string,
    protocolVersion?: number,
    minClientProtocolVersion?: number,
  ): void {
    const trimmed = served.trim();
    if (trimmed) this.serverReleaseId = trimmed;
    this.serverProtocolVersion = protocolVersion ?? null;
    this.serverMinClientProtocolVersion = minClientProtocolVersion ?? null;
    // Two different faults share the banner. `min > CLIENT`: THIS app is older
    // than the computer allows, so the computer is fine and the app updates.
    // Anything else out of range (or no protocol fields at all): the computer
    // is older than this app. Telling someone to update their computer for the
    // first sent them to fix the wrong machine.
    const appTooOld = minClientProtocolVersion !== undefined && minClientProtocolVersion > CLIENT_PROTOCOL_VERSION;
    const computerTooOld = protocolVersion === undefined || minClientProtocolVersion === undefined || protocolVersion < CLIENT_PROTOCOL_VERSION;
    if (appTooOld && !isPhoneMode()) {
      this.updateBannerShown = true;
      showBanner("This app needs an update to keep sending safely.", "warn", {
        label: "Update",
        onClick: () => { window.dispatchEvent(new Event("app:update-now")); },
      });
      return;
    }
    if (appTooOld || computerTooOld) {
      this.updateBannerShown = true;
      showBanner(appTooOld
        ? "Update the Android app to keep sending safely."
        : "Update omp-pulse on your computer to keep sending safely.", "warn", {
        label: "Update guide",
        onClick: () => {
          window.open(appTooOld
            ? "https://github.com/JulianCodespoti/omp-pulse/blob/main/docs/user/phone-mode.md#getting-the-app-and-updates"
            : "https://github.com/JulianCodespoti/omp-pulse#on-your-computer", "_blank", "noopener,noreferrer");
        },
      });
      return;
    }
    if (trimmed && trimmed !== LOADED_RELEASE_ID && !this.updateBannerShown) {
      this.updateBannerShown = true;
      showBanner("A new version is ready.", "info", {
        // Applies the new build here and now; Settings › About calls the same function.
        label: "Update",
        onClick: () => { window.dispatchEvent(new Event("app:update-now")); },
      });
    }
  }

  getDiagnostics(): ClientDiagnostics {
    const outbox = getOutboxDiagnostics(this.queueNamespace);
    return {
      releaseId: LOADED_RELEASE_ID,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      serverProtocolVersion: this.serverProtocolVersion,
      serverMinClientProtocolVersion: this.serverMinClientProtocolVersion,
      connection: this.store.getState().connection,
      offline: this.store.getState().offline,
      session: {
        present: this.activeSession !== null,
        id: opaqueSessionId(this.activeSession),
      },
      lastFrameAt: this.lastFrameAt || null,
      heartbeatAt: this.heartbeatAt,
      serverReleaseId: this.serverReleaseId,
      authRejected: this.store.getState().authRejected,
      outbox,
      receipts: { count: outbox.count, states: outbox.states },
    };
  }
  getUpdateSafety(): UpdateSafetyStatus {
    const pendingSessionPath = pendingAll(this.queueNamespace)[0]?.sessionPath ?? null;
    return {
      loadedReleaseId: LOADED_RELEASE_ID,
      serverReleaseId: this.serverReleaseId,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      serverProtocolVersion: this.serverProtocolVersion,
      serverMinClientProtocolVersion: this.serverMinClientProtocolVersion,
      compatible:
        this.serverProtocolVersion !== null &&
        this.serverProtocolVersion >= CLIENT_PROTOCOL_VERSION &&
        this.serverMinClientProtocolVersion !== null &&
        this.serverMinClientProtocolVersion <= CLIENT_PROTOCOL_VERSION,
      updateAvailable: this.updateBannerShown,
      pendingWork: pendingSessionPath !== null,
      pendingSessionPath,
    };
  }

  async clearCachedHistory(): Promise<void> {
    await clearAllCachedHistory(this.cacheNamespace);
  }
  /** Durably flush local editor state before a client update can reload the page. */
  async prepareForUpdate(): Promise<void> {
    await prepareForReload();
  }
  async preparePairingRepair() {
    await prepareForReload();
    return capturePairingRecovery(this.queueNamespace);
  }
  fencePairingReplacement(credential: string): void {
    if (credential && credential !== this.token && readPairingToken() === credential) {
      // This is the replacement's actual scope, never an alias for old work.
      // It also invalidates old background/composer delivery while native acks.
      setOfflineQueueNamespace(offlineQueueNamespaceForCredential(credential));
    }
  }
  private authenticationGeneration = 0;
  private rejectedGeneration: number | null = null;
  private pairingRepair = false;
  beginPairingRepair(): () => void {
    this.pairingRepair = true;
    ++this.authenticationGeneration;
    this.rejectedGeneration = null;
    this.store.getState().setAuthRejected(false);
    return () => {
      this.pairingRepair = false;
      ++this.authenticationGeneration;
      this.rejectedGeneration = null;
    };
  }
  rejectedCurrentCredential(credential: string): boolean {
    return credential === this.token && this.rejectedGeneration === this.authenticationGeneration;
  }

  async clearOutbox(): Promise<void> {
    await clearOutboxAsync(undefined, this.queueNamespace);
    this.syncQueuedCount();
  }
  /** Clear all phone-only state without touching desktop session files. */
  async clearOfflineData(): Promise<void> {
    clearAllDrafts(this.queueNamespace);
    clearNewSessionDraftMemory(this.queueNamespace);
    clearExtensionDrafts(this.queueNamespace);
    clearReviewNotes(this.queueNamespace);
    clearFileDraftMemory(this.queueNamespace);
    clearPromptHistory(this.queueNamespace);
    await Promise.all([
      clearOfflineHistory(this.cacheNamespace),
      clearOutboxAsync(undefined, this.queueNamespace),
      clearAttachmentDrafts(this.queueNamespace),
      clearPairingRecovery(this.queueNamespace),
    ]);
    this.syncQueuedCount();
  }

  getStore(): OmpStoreApi {
    return this.store;
  }

  /** Terminal-sheet live output listeners; see `onBashOutput`. */
  private readonly bashOutputListeners = new Set<BashOutputListener>();

  /**
   * Hear the open session's `bash_output` frames: new output from a running
   * Terminal-sheet command, keyed by the `runId` it was started with. Live
   * only; the command's reply carries the whole output. Returns unsubscribe.
   */
  readonly onBashOutput = (listener: BashOutputListener): (() => void) => {
    this.bashOutputListeners.add(listener);
    return () => {
      this.bashOutputListeners.delete(listener);
    };
  };

  /** Side questions (`/btw`) for the open session; see runtime/btw.ts. */
  private readonly btwStore: BtwStore = createBtwStore();

  getBtwStore(): BtwStore {
    return this.btwStore;
  }

  /**
   * The platform's connectivity HINT. Never a gate: Android WebView reports
   * `navigator.onLine === false` whenever Android has no validated internet
   * route, which says nothing about a daemon reached over the tailnet or the
   * LAN. Treating it as the truth refused to open any socket, overrode a
   * socket that had just opened, and parked every prompt in the outbox, so
   * every conversation read "offline" while the list and history loaded fine
   * over HTTP (the daemon logged `clients=0` for chats the user was in).
   * Connection state comes from what actually happened on the wire.
   */
  private platformOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  private socketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private syncOffline(): void {
    // Offline only when the hint says so AND nothing is actually connected.
    const offline = this.platformOffline() && !this.socketOpen();
    const state = this.store.getState();
    state.setOffline(offline);
    if (offline) {
      if (this.activeSession) state.setConnection("offline");
    } else if (state.connection === "offline") {
      state.setConnection(
        this.socketOpen() ? "open" : this.activeSession ? "reconnecting" : "closed",
      );
    }
  }
  private async ensureReceiptProtocol(): Promise<void> {
    const data = await this.request<JsonObject>("/api/version");
    const protocolVersion =
      typeof data.protocolVersion === "number" ? data.protocolVersion : null;
    const minClientProtocolVersion =
      typeof data.minClientProtocolVersion === "number"
        ? data.minClientProtocolVersion
        : null;
    this.checkHeartbeatVersion(
      typeof data.releaseId === "string" ? data.releaseId : "",
      protocolVersion ?? undefined,
      minClientProtocolVersion ?? undefined,
    );
    if (
      protocolVersion === null ||
      minClientProtocolVersion === null ||
      protocolVersion < CLIENT_PROTOCOL_VERSION ||
      minClientProtocolVersion > CLIENT_PROTOCOL_VERSION ||
      !Array.isArray(data.capabilities) ||
      !data.capabilities.every(capability => typeof capability === "string") ||
      !data.capabilities.includes(RECEIPT_BINDING_CAPABILITY)
    ) {
      throw new Error("Daemon does not support command receipts safely");
    }
  }

  private syncQueuedCount(): void {
    const path = this.activeSession;
    const count = path
      ? pending(path, this.queueNamespace).length
      : queuedCount(undefined, this.queueNamespace);
    this.store.getState().setQueuedCount(count);
  }

  private async flushQueue(): Promise<void> {
    const namespace = this.queueNamespace;
    const scope = this.getReceiptScope();
    const queueCurrent = captureQueueScope(namespace);
    const isCurrent = () => Boolean(scope) && queueCurrent() && scope === this.getReceiptScope();
    await flush(
      async (entry: QueuedPrompt, signal: AbortSignal) => {
        try {
          await this.ensureReceiptProtocol();
        } catch (error) {
          throw new UndispatchedError(error);
        }
        const images = await getImages(entry.commandId, namespace);
        await assertDispatchCurrent(entry, namespace, isCurrent);
        const data = await this.request<JsonObject>("/api/prompt", {
          method: "POST",
          signal,
          body: JSON.stringify({
            commandId: entry.commandId,
            sessionPath: entry.sessionPath,
            text: entry.text,
            ...(images.length > 0 ? { images } : {}),
            ...(entry.delivery ? { delivery: entry.delivery } : {}),
          }),
        });
        return validateBoundReceiptResponse(data, entry);
      },
      {
        namespace,
        isCurrent,
        isTransient: (error) => isNetworkError(error),
        onDropped: (entry) => {
          // A failed send is shown once, by its "Not sent" bubble; only an
          // unconfirmed delivery (no failure to retry) needs the banner too.
          if (entry.state === "uncertain") {
            this.store.getState().setError(UNCERTAIN_SEND_TOAST);
          }
          this.syncQueuedCount();
        },
      },
    );
    this.syncQueuedCount();
  }

  private async maintainLocalPendingSends(): Promise<void> {
    if (this.maintainingPendingSends || usesNativeOutbox()) return;
    const namespace = this.queueNamespace;
    const scope = this.getReceiptScope();
    const generation = this.generation;
    const queueCurrent = captureQueueScope(namespace);
    const isCurrent = () => Boolean(scope) && queueCurrent() && scope === this.getReceiptScope() && generation === this.generation;
    if (!isCurrent()) return;
    this.maintainingPendingSends = true;
    try {
      await maintainPendingSends(namespace, isCurrent);
      if (isCurrent()) this.syncQueuedCount();
    } catch {
      if (isCurrent()) this.store.getState().setError("Local send status couldn't be updated. Your saved prompt was kept.");
    } finally {
      this.maintainingPendingSends = false;
    }
  }

  private async reconcileReceipts(sessionPath?: string): Promise<void> {
    if (usesNativeOutbox()) {
      await this.flushQueue();
      return;
    }
    if (this.reconcilingReceipts) return;
    const candidates = getOutboxSnapshot(this.queueNamespace).filter(
      (entry) =>
        (!sessionPath || entry.sessionPath === sessionPath) &&
        (entry.state === "uncertain" ||
          entry.state === "dispatching" ||
          entry.state === "accepted" ||
          entry.state === "received" ||
          entry.state === "running"),
    );
    if (candidates.length === 0) return;
    this.reconcilingReceipts = true;
    const namespace = this.queueNamespace;
    const scope = this.getReceiptScope();
    const generation = this.generation;
    const queueCurrent = captureQueueScope(namespace);
    const isCurrent = () => Boolean(scope) && queueCurrent() && scope === this.getReceiptScope() && generation === this.generation;
    try {
      for (const entry of candidates) {
        try {
          if (!isCurrent()) break;
          const response = await this.getReceipt(entry);
          if (response) await applyReceipt(entry, response, namespace, isCurrent);
        } catch {
          // Keep the existing state. An unavailable reconciliation route is not
          // evidence that the command failed or should be replayed.
        }
      }
      this.syncQueuedCount();
    } finally {
      this.reconcilingReceipts = false;
    }
  }

  /** Stable local intent snapshot; presentation must not infer IDs from transcript text. */
  getSavedPrompts(): readonly QueuedPrompt[] {
    return getOutboxSnapshot(this.queueNamespace);
  }

  getReceiptScope(): string {
    return !this.disposed && this.queueNamespace === getOfflineQueueNamespace()
      ? JSON.stringify([this.baseUrl, this.queueNamespace]) : "";
  }

  /** On-demand observation only, including native mode: never wake or mutate delivery. */
  async inspectCommandReceipt(intent: QueuedPrompt, previous?: ReceiptResponse): Promise<ReceiptResponse | null> {
    const scope = this.getReceiptScope();
    const generation = this.generation;
    const isCurrent = captureQueueScope(this.queueNamespace);
    const retained = () => this.getSavedPrompts().find(entry => sameQueuedIntent(entry, intent));
    if (!scope || !retained()) throw new Error("Send details are no longer in the current scope");
    const response = await this.getReceipt(intent);
    const current = retained();
    if (!isCurrent() || scope !== this.getReceiptScope() || generation !== this.generation || !current)
      throw new Error("Send details scope changed");
    if (!response) return null;
    // Observation is read-only, but must respect evidence established during its GET.
    validateBoundReceiptResponse(response, current);
    if (previous) validateBoundReceiptResponse(response, {
      ...current, receipt: previous.receipt, receiptBinding: previous.receiptBinding,
    });
    return response;
  }

  private async getReceipt(intent: QueuedPrompt): Promise<ReceiptResponse | null> {
    retainedReceiptBinding(intent);
    const response = await this.fetchAuthed(
      `/api/receipts/${encodeURIComponent(intent.commandId)}?session=${encodeURIComponent(intent.sessionPath)}`,
      { method: "GET", cache: "no-store" },
    );
    if (response.status === 404) {
      await consumeReceiptAbsenceBody(response);
      return null;
    }
    if (!response.ok) throw new Error(await this.failureDetail(response));
    return validateBoundReceiptResponse(await response.json(), intent);
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private recordFailure(): boolean {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.store
        .getState()
        .setError("Connection lost — session no longer available");
      // An open socket is still delivering frames; only a dead one is an
      // error, and it stays armed (scheduleReconnect slows down past the gate
      // instead of giving up).
      if (!this.socketOpen()) {
        this.store.getState().setConnection("error");
        if (!this.socket && this.activeSession)
          this.scheduleReconnect(this.generation, this.activeSession);
      }
      return true;
    }
    return false;
  }

  /**
   * Read one credential-scoped snapshot before the first network revalidation,
   * so a cold sessions screen can paint rows while the daemon is still in flight.
   */
  private async hydrateSessionListFromCache(): Promise<void> {
    if (this.sessionsCacheHydrated) return;
    this.sessionsCacheHydrated = true;
    const lifetime = this.sessionsListingLifetime;
    const snapshot = await loadSessionList(this.cacheNamespace);
    if (!snapshot || !this.isSessionListingLifetimeCurrent(lifetime)) return;
    const state = this.store.getState();
    if (state.sessionsUpdatedAt !== null) return;
    this.store.setState({
      sessions: snapshot.sessions,
      sessionProjects: snapshot.projects ?? [],
      sessionsUpdatedAt: snapshot.savedAt,
    });
  }

  /**
   * A drawer read has its own scope and never installs a main-list page.
   * Disable live overlays to bound the response to one page plus the current
   * conversation; search still runs against the server's entire catalogue.
   */
  async querySwitcherSessions({
    query,
    project = null,
    currentPath,
    signal,
    isCurrent,
  }: {
    query: string;
    project?: string | null;
    currentPath: string | null;
    signal: AbortSignal;
    isCurrent: () => boolean;
  }): Promise<OmpSessionSummary[]> {
    const page = await this.querySwitcherSessionsPage({ query, project, cursor: null, currentPath, signal, isCurrent });
    return page.sessions;
  }

  async querySwitcherSessionsPage({
    query,
    project = null,
    cursor = null,
    currentPath,
    signal,
    isCurrent,
  }: {
    query: string;
    project?: string | null;
    cursor?: string | null;
    currentPath: string | null;
    signal: AbortSignal;
    isCurrent: () => boolean;
  }): Promise<OmpSessionListingPage> {
    const lifetime = this.sessionsListingLifetime;
    const current = () => this.isSessionListingLifetimeCurrent(lifetime)
      && !signal.aborted && isCurrent();
    if (!current()) throw new Error("Session listing request is no longer active");
    const scope = normalizeSessionListingScope({
      query,
      project,
      pinned: !query.trim() && !cursor && currentPath ? [currentPath] : [],
      includeLive: false,
    });
    const result = await this.fetchSessionListingPage(scope, cursor, {
      limit: scope.query || scope.project || cursor ? 30 : 12,
      cache: this.switcherPageCache,
      signal,
      isCurrent: current,
    });
    if (!current()) throw new Error("Session listing request is no longer active");
    return result.page;
  }

  /**
   * Fetch and install the first bounded page for a listing scope. ETags and
   * cached bodies are paired per exact query/pins/cursor key; an old search
   * response can never replace a newer scope.
   */
  async loadSessions(options?: SessionListingOptions): Promise<void> {
    const lifetime = this.sessionsListingLifetime;
    if (!this.isSessionListingLifetimeCurrent(lifetime)) return;
    const requested = options === undefined
      ? this.sessionsListingScope
      : normalizeSessionListingScope(options);
    if (requested.key !== this.sessionsListingScope.key) {
      this.sessionsListingScope = requested;
    }
    const scope = this.sessionsListingScope;
    this.store.getState().setSessionScope(scope.key);
    if (!this.isSessionListingLifetimeCurrent(lifetime)) return;

    const pageKey = sessionListingPageKey(scope, null);
    const existing = this.sessionsInFlight.get(pageKey);
    if (existing && existing.generation === this.sessionsListingGeneration) {
      return existing.promise;
    }
    const state = this.store.getState();
    if (state.sessionsLoadingMore && state.sessionsScope === scope.key && state.sessionsNextCursor) {
      const older = this.sessionsInFlight.get(sessionListingPageKey(scope, state.sessionsNextCursor));
      if (older?.generation === this.sessionsListingGeneration) return older.promise;
    }

    const generation = ++this.sessionsListingGeneration;
    const isCurrent = () => this.isSessionListingLifetimeCurrent(lifetime)
      && this.sessionsListingGeneration === generation && this.sessionsListingScope.key === scope.key;
    const run = (async () => {
      if (!scope.query) await this.hydrateSessionListFromCache();
      if (!isCurrent()) return;

      const previousPage = this.sessionsPageCache.get(pageKey);
      const modelBefore = this.store.getState().sessionModel;
      const modelGeneration = this.generation;
      const branchEpoch = this.earlierEpoch;
      const result = await this.fetchSessionListingPage(scope, null);
      if (!isCurrent()) return;

      // A copy, never the page itself: `result` is the object cached for the
      // next revalidation's `previousPage`. Appending the loaded archive to it
      // made every older row count as "on the previous first page", so the
      // second changed first page after a "Load more" dropped them all while
      // keeping the deeper cursor — those rows were unreachable until reload.
      const sessions = [...result.page.sessions];
      if (result === previousPage && this.store.getState().sessionsUpdatedAt !== null && this.store.getState().sessions.length > 0) {
        this.store.getState().touchSessionsUpdatedAt();
      } else {
        const current = this.store.getState();
        const hasOlder = previousPage && current.sessions.length > 0
          && current.sessionsNextCursor !== previousPage.page.nextCursor;
        if (hasOlder) {
          const replaced = new Set([...previousPage.page.sessions, ...sessions].map((row) => row.path));
          sessions.push(...current.sessions.filter((row) => !replaced.has(row.path)));
        }
        current.setSessionPage(sessions, hasOlder ? current.sessionsNextCursor : result.page.nextCursor, scope.key);
      }
      if (!isCurrent()) return;
      if (result !== previousPage && modelGeneration === this.generation && branchEpoch === this.earlierEpoch
        && this.store.getState().sessionModel === modelBefore) {
        this.adoptSessionConfiguration(result.page.sessions.find(row => row.path === this.activeSession)?.sessionModel);
      }
      if (result.page.projects) this.store.getState().setSessionProjects(result.page.projects);
      if (!isCurrent()) return;
      this.store.getState().setError(null);
      if (!isCurrent()) return;
      if (!scope.query && scope.pinned.length === 0 && scope.includeLive && !scope.project) {
        void saveSessionList(result.page.sessions, this.cacheNamespace, result.page.projects);
      }
    })();
    this.sessionsInFlight.set(pageKey, { generation, promise: run });
    try {
      await run;
    } finally {
      if (this.sessionsInFlight.get(pageKey)?.promise === run) {
        this.sessionsInFlight.delete(pageKey);
      }
    }
  }

  /** Load one older page, appending by path to avoid repeats from pinned/live inclusions. */
  async loadMoreSessions(): Promise<void> {
    const lifetime = this.sessionsListingLifetime;
    if (!this.isSessionListingLifetimeCurrent(lifetime)) return;
    const scope = this.sessionsListingScope;
    const state = this.store.getState();
    const cursor = state.sessionsNextCursor;
    if (!cursor || state.sessionsScope !== scope.key || state.sessionsLoadingMore) return;

    const pageKey = sessionListingPageKey(scope, cursor);
    const generation = this.sessionsListingGeneration;
    const isCurrent = () => this.isSessionListingLifetimeCurrent(lifetime)
      && this.sessionsListingGeneration === generation && this.sessionsListingScope.key === scope.key;
    this.store.getState().setSessionsLoadingMore(true);
    if (!isCurrent()) return;
    const run = (async () => {
      try {
        const modelBefore = this.store.getState().sessionModel;
        const modelGeneration = this.generation;
        const branchEpoch = this.earlierEpoch;
        const result = await this.fetchSessionListingPage(scope, cursor);
        const current = this.store.getState();
        if (!isCurrent()
          || current.sessionsScope !== scope.key
          || current.sessionsNextCursor !== cursor) return;
        const sessions = result.page.sessions;
        current.appendSessionPage(sessions, result.page.nextCursor, scope.key);
        if (!isCurrent()) return;
        if (modelGeneration === this.generation && branchEpoch === this.earlierEpoch && current.sessionModel === modelBefore) {
          this.adoptSessionConfiguration(sessions.find(row => row.path === this.activeSession)?.sessionModel);
        }
        if (result.page.projects) current.setSessionProjects(result.page.projects);
        if (!isCurrent()) return;
        this.store.getState().setError(null);
      } finally {
        const current = this.store.getState();
        if (isCurrent() && current.sessionsScope === scope.key
          && current.sessionsNextCursor === cursor
          && current.sessionsLoadingMore) {
          current.setSessionsLoadingMore(false);
        }
      }
    })();
    this.sessionsInFlight.set(pageKey, { generation, promise: run });
    try {
      await run;
    } finally {
      if (this.sessionsInFlight.get(pageKey)?.promise === run) {
        this.sessionsInFlight.delete(pageKey);
      }
    }
  }

  private async fetchSessionListingPage(
    scope: SessionListingScope,
    cursor: string | null,
    options: {
      limit?: number;
      signal?: AbortSignal;
      isCurrent?: () => boolean;
      cache?: Map<string, CachedSessionListingPage>;
    } = {},
  ): Promise<CachedSessionListingPage> {
    const lifetime = this.sessionsListingLifetime;
    const isCurrent = () => this.isSessionListingLifetimeCurrent(lifetime)
      && !options.signal?.aborted && (options.isCurrent?.() ?? true);
    const limit = options.limit ?? SESSION_PAGE_SIZE;
    const key = sessionListingPageKey(scope, cursor, limit);
    const cache = options.cache ?? this.sessionsPageCache;
    const cached = cache.get(key);
    const ingressSequence = this.nextStateIngressSequence();
    const query = new URLSearchParams({ limit: String(limit), live: String(scope.includeLive) });
    if (scope.query) query.set("q", scope.query);
    if (scope.project) query.set("project", scope.project);
    for (const path of scope.pinned) query.append("pinned", path);
    if (cursor) query.set("cursor", cursor);
    const headers = new Headers();
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    const response = await this.fetchAuthed("/api/sessions?" + query.toString(), { headers, signal: options.signal });
    if (response.status === 304) {
      if (!cached) throw new Error("Session listing returned 304 without a cached page");
      if (isCurrent()) this.rememberSessionPage(key, cached, cache);
      return cached;
    }
    const body = await readJsonResponse(response);
    if (!response.ok) {
      const message = isJsonObject(body) && typeof body.error === "string" ? body.error : "HTTP " + response.status;
      throw new Error(message);
    }
    if (isJsonObject(body) && body.ok === false) {
      throw new Error(typeof body.error === "string" ? body.error : "Session listing failed");
    }
    // A malformed successful response is not evidence of an empty archive or
    // the last page. Check every row identity before any authority ingestion:
    // a bad later row must not leave earlier rows partially reconciled.
    if (!isJsonObject(body) || !Array.isArray(body.sessions)
      || !body.sessions.every((row) => isJsonObject(row) && typeof row.path === "string")
      || (body.nextCursor !== undefined && body.nextCursor !== null
        && typeof body.nextCursor !== "string")) {
      throw new Error("Invalid session listing response");
    }
    const data = body;
    const page: OmpSessionListingPage = {
      sessions: Array.isArray(data.sessions) ? data.sessions as OmpSessionSummary[] : [],
      nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
      projects: Array.isArray(data.projects) ? data.projects as OmpSessionListingPage["projects"] : undefined,
    };
    const result = { etag: response.headers.get("ETag"), page };
    if (isCurrent()) {
      this.ingestSessionSummaries(page.sessions, ingressSequence, lifetime, isCurrent);
      if (isCurrent()) this.rememberSessionPage(key, result, cache);
    }
    return result;
  }

  private isSessionListingLifetimeCurrent(lifetime: number): boolean {
    return !this.disposed && this.sessionsListingLifetime === lifetime;
  }

  private ingestSessionSummaries(
    sessions: readonly OmpSessionSummary[],
    ingressSequence: number,
    lifetime = this.sessionsListingLifetime,
    requestIsCurrent: () => boolean = () => true,
  ): void {
    const isCurrent = () => this.isSessionListingLifetimeCurrent(lifetime) && requestIsCurrent();
    let pending: OmpSessionSummary[] = [];
    let namespace: unknown = Symbol();
    const prepare = (session: OmpSessionSummary): SessionStateEvidence => ({
      path: session.path, evidence: this.sessionStateEvidence(session),
    });
    const flush = () => {
      if (pending.length === 0 || !isCurrent()) return;
      // Normalize immediately before each reducer step, preserving the order of
      // receipt/authority clock reads even when this passive run is large.
      const entries = function* () { for (const session of pending) yield prepare(session); };
      this.store.getState().reconcileSessionStates(entries(), ingressSequence);
      pending = [];
    };
    for (const session of sessions) {
      if (!isCurrent()) return;
      const nextNamespace = isJsonObject(session.sessionState) ? session.sessionState.daemonInstanceId : null;
      // Active idle rows commit streaming output immediately. Namespace changes
      // can invalidate the active source in imperative store subscribers. Keep
      // those boundaries observable; only same-namespace passive rows batch.
      if (session.path === this.activeSession || session.path === this.store.getState().sessionPath
        || nextNamespace !== namespace) {
        flush();
        if (!isCurrent()) return;
        this.reconcileSessionState(session.path, session, ingressSequence, isCurrent);
      } else {
        pending.push(session);
      }
      namespace = nextNamespace;
    }
    flush();
  }

  private rememberSessionPage(
    key: string,
    page: CachedSessionListingPage,
    cache = this.sessionsPageCache,
  ): void {
    cache.delete(key);
    cache.set(key, page);
    while (cache.size > MAX_CACHED_SESSION_PAGES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  /** Poll the active listing while the sessions screen is visible. */
  startSessionsPolling(intervalMs = 3_000): void {
    this.resume();
    this.stopSessionsPolling();
    this.sessionsPollIntervalMs = intervalMs;
    this.startSessionsLive();
    this.scheduleSessionsPoll();
  }
  stopSessionsPolling(): void {
    ++this.sessionsRefreshGeneration;
    this.pauseSessionsPoll();
    this.stopSessionsLive();
  }

  private scheduleSessionsPoll(): void {
    // HTTP backs up the listing socket: filesystem watches can fail or lose
    // events, mobile sockets can die silently, and polls refresh ownership
    // that has no file event. A fixed 3 s poll ran even with a healthy socket
    // pushing every change, and kept rescheduling while the page was hidden,
    // so a backgrounded phone listed sessions every 3 s for nobody. Now: no
    // poll while hidden (the visible resume reschedules), 30 s while the socket
    // is open and heard from, the short cadence only while it is down or stale.
    // (Slowing every poll to 30 s once hid new sessions for up to 30 s; while
    // the socket is healthy its push covers that now.)
    if (!this.sessionsLive || this.disposed) return;
    this.pauseSessionsPoll();
    if (document.visibilityState === "hidden") return;
    const delay = this.sessionsPollDelay();
    this.sessionsPollRelaxed = delay > this.sessionsPollIntervalMs;
    const timer = window.setTimeout(() => {
      if (this.sessionsTimer !== timer) return;
      this.sessionsTimer = null;
      if (this.disposed || !this.sessionsLive || document.visibilityState === "hidden") return;
      void this.refreshSessions();
      // An existing backoff owns the next dial; polling must not defeat it.
      if (this.sessionsReconnectTimer === null)
        this.connectSessionsSocket(Date.now() - this.sessionsLastFrameAt >= STALE_SOCKET_MS);
      this.scheduleSessionsPoll();
    }, delay);
    this.sessionsTimer = timer;
  }

  private sessionsPollDelay(): number {
    const socket = this.sessionsSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return this.sessionsPollIntervalMs;
    const untilStale = STALE_SOCKET_MS - (Date.now() - this.sessionsLastFrameAt);
    // Wake no later than the first evidence that an OPEN socket died silently.
    return Math.max(this.sessionsPollIntervalMs, Math.min(SESSIONS_FALLBACK_POLL_MS, untilStale));
  }

  private pauseSessionsPoll(): void {
    if (this.sessionsTimer !== null) window.clearTimeout(this.sessionsTimer);
    this.sessionsTimer = null;
    this.sessionsPollRelaxed = false;
  }
  private startSessionsLive(): void {
    if (this.sessionsLive) return;
    this.sessionsLive = true;
    this.connectSessionsSocket();
  }
  private stopSessionsLive(): void {
    this.sessionsLive = false;
    this.closeSessionsSocket();
    if (this.sessionsReconnectTimer !== null) {
      window.clearTimeout(this.sessionsReconnectTimer);
      this.sessionsReconnectTimer = null;
    }
    this.sessionsReconnectAttempt = 0;
  }
  private sessionsWsUrl(): string {
    const url = new URL("/ws/sessions", `${this.baseUrl}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", this.token);
    url.searchParams.set("releaseId", LOADED_RELEASE_ID);
    url.searchParams.set("protocolVersion", String(CLIENT_PROTOCOL_VERSION));
    return url.toString();
  }
  private parseActivity(raw: unknown): OmpActivity | null {
    return parseOmpActivity(raw);
  }

  private nextStateIngressSequence(): number {
    return ++this.stateIngressSequence;
  }

  private sessionStateEvidence(source: JsonObject): JsonObject {
    const evidence: JsonObject = { ...source };
    if (Object.prototype.hasOwnProperty.call(source, "now")) {
      const parsed = source.now === null ? null : this.parseActivity(source.now);
      if (source.now !== null && parsed === null) delete evidence.now;
      else evidence.now = parsed && onPhoneClock(parsed, typeof source.at === "number" ? source.at : undefined, Date.now());
    }
    const receivedAt = Date.now();
    if (typeof source.at === "number" && Number.isFinite(source.at)) this.clockShift = receivedAt - source.at;
    if (source.at === undefined) evidence.at = receivedAt - this.clockShift;
    return evidence;
  }

  private reconcileSessionState(path: string, source: JsonObject, ingressSequence = this.nextStateIngressSequence(), isCurrent = () => true): boolean {
    const evidence = this.sessionStateEvidence(source);
    const provenanceBefore = this.store.getState().sessionModelProvenance;
    const accepted = this.store.getState().reconcileSessionState(path, evidence, ingressSequence);
    if (accepted && isCurrent() && path === this.activeSession
      && this.store.getState().sessionModelProvenance !== provenanceBefore) {
      // A proven owner retirement made the old live controls file-refreshable.
      // Reuse metadata catch-up if a listing carried the release without a fold.
      this.configurationPending = true;
    }
    if (accepted && isCurrent() && path === this.activeSession && selectSessionTurn(this.store.getState(), path) === "idle") this.commitStreamingMessage(undefined, isCurrent);
    return accepted;
  }

  private applyActivity(path: string, raw: unknown, sentAt?: unknown, sessionState?: unknown): void {
    const parsed = this.parseActivity(raw);
    if (raw !== null && parsed === null) return;
    const now = parsed;
    const evidence: JsonObject = { now, at: sentAt };
    if (sessionState !== undefined) evidence.sessionState = sessionState;
    const receivedAt = Date.now();
    if (typeof sentAt === "number" && Number.isFinite(sentAt)) this.clockShift = receivedAt - sentAt;
    this.reconcileSessionState(path, evidence);
  }

  private setActivity(path: string, now: OmpActivity | null): void {
    this.store.getState().patchActivity(path, now, this.nextStateIngressSequence());
  }

  private setWorking(working: boolean): void {
    this.store.getState().setAgentWorking(working, this.nextStateIngressSequence());
  }

  private applyTurnState(path: string, source: JsonObject, ingressSequence = this.nextStateIngressSequence()): void {
    this.reconcileSessionState(path, source, ingressSequence);
  }

  private connectSessionsSocket(forceReconnect = false): void {
    if (!this.sessionsLive || this.disposed || document.visibilityState === "hidden") return;
    if (forceReconnect) this.closeSessionsSocket();
    if (this.sessionsSocket && this.sessionsSocket.readyState <= WebSocket.OPEN)
      return;
    try {
      const socket = new WebSocket(this.sessionsWsUrl());
      socket.binaryType = "arraybuffer";
      this.sessionsSocket = socket;
      this.sessionsLastFrameAt = Date.now();
      // Silence is not an idle snapshot. The following HTTP refresh and
      // stamped activity frames reconcile only state the daemon observed.
      socket.onopen = () => {
        if (this.sessionsSocket !== socket) return;
        this.sessionsLastFrameAt = Date.now();
      };
      socket.onmessage = (event) => {
        if (this.sessionsSocket !== socket) return;
        reportLinkOk();
        this.sessionsLastFrameAt = Date.now();
        this.sessionsReconnectAttempt = 0;
        try {
          const data = typeof event.data === "string" ? event.data : "";
          const obj = data
            ? (JSON.parse(data) as Record<string, unknown>)
            : null;
          if (obj && obj.type === "hb") {
            const release =
              typeof obj.v === "string"
                ? obj.v
                : typeof obj.releaseId === "string"
                  ? obj.releaseId
                  : "";
            const protocol =
              typeof obj.protocolVersion === "number"
                ? obj.protocolVersion
                : undefined;
            const minimum =
              typeof obj.minClientProtocolVersion === "number"
                ? obj.minClientProtocolVersion
                : undefined;
            this.heartbeatAt = Date.now();
            this.checkHeartbeatVersion(release, protocol, minimum);
          } else if (obj && obj.type === "activity" && typeof obj.path === "string") {
            this.applyActivity(obj.path, obj.now, obj.at, obj.sessionState);
          } else if (obj && obj.type === "resync") {
            // The daemon cleared this socket's queue, idle `activity` frames
            // included, so a finished turn kept its "Writing…" card in Now.
            // Reconnect requests authoritative state; silence never proves idle.
            void this.refreshSessions();
            this.closeSessionsSocket();
            this.connectSessionsSocket();
          } else if (obj && obj.type === "sessions") {
            void this.refreshSessions();
          } else if (data.includes('"sessions"')) {
            void this.refreshSessions();
          }
        } catch {
          void this.refreshSessions();
        }
      };
      socket.onclose = () => {
        if (this.sessionsSocket !== socket) return;
        this.sessionsSocket = null;
        if (this.sessionsLive && !this.disposed) {
          void probeLink();
          this.scheduleSessionsReconnect(1000);
          // A pending 30 s poll assumed this socket; return to the short cadence.
          // Only then: a socket failing every second must not keep resetting it.
          if (this.sessionsPollRelaxed) this.scheduleSessionsPoll();
        }
      };
      socket.onerror = () => {
        try {
          socket.close();
        } catch {}
      };
    } catch {
      this.scheduleSessionsReconnect(2000);
    }
  }
  // A fixed 1 s retry, also while hidden, opened a WebSocket per second for as
  // long as the daemon stayed unreachable. Back off exponentially (reset by
  // any received frame) and leave hidden pages to `onVisible`, which reconnects
  // the listing socket on resume.
  private scheduleSessionsReconnect(baseDelayMs: number): void {
    if (!this.sessionsLive || this.disposed) return;
    if (this.sessionsReconnectTimer !== null) return;
    if (document.visibilityState === "hidden") return;
    const attempt = Math.min(this.sessionsReconnectAttempt++, 5);
    const delayMs = Math.min(30_000, baseDelayMs * 2 ** attempt);
    this.sessionsReconnectTimer = window.setTimeout(() => {
      this.sessionsReconnectTimer = null;
      this.connectSessionsSocket();
    }, delayMs);
  }
  private closeSessionsSocket(): void {
    if (this.sessionsSocket) {
      try {
        this.sessionsSocket.close();
      } catch {}
      this.sessionsSocket = null;
    }
  }

  async openSession(path: string): Promise<void> {
    this.resume();
    this.cancelOpeningHistoryPage();
    const generation = ++this.generation;
    this.historyAbort.abort();
    this.historyAbort = new AbortController();
    this.earlierInFlight = false;
    this.earlierFinished = null;
    this.revealWindow = null;
    this.earlierLimit = HISTORY_PAGE;
    this.cancelReconnect();
    this.closeSocket();
    this.cancelStreamFlush();
    this.activeSession = path;
    this.collabQuestionCursor = null;
    this.currentCollabQuestion = null;
    void this.maintainLocalPendingSends();
    // A fresh window opens at the live edge; the scroller reports again on mount.
    this.atBottom = true;
    this.lowerHalf = true;
    this.laterInFlight = false;
    this.responseChain = null;
    this.streamText = "";
    this.streamRawText = null;
    this.streamDisplay = null;
    this.pendingDeltas = [];
    // A queued frame or owed fetch belongs to the previous conversation; its
    // frames would be discarded by generation anyway.
    this.inbound = null;
    this.cancelOwedCatchUp();
    // Recovery belongs to a conversation, not the lifetime of the controller.
    // A hung request from the previous chat must not block this one.
    this.catchUpInFlight = false;
    this.lastCatchUpAt = 0;
    this.consecutiveFailures = 0;
    clearTimelineMarkers();
    this.store.getState().beginSession(path);
    this.store.getState().setExtensionFeedback((state) => ({ ...state, editorDraft: readExtensionDraft(this.queueNamespace, path) }));
    this.runningAgentCount.start();
    this.modelEntryAt = 0;
    this.thinkingEntryAt = 0;
    this.fallbackEntryAt = 0;
    this.configurationPending = false;
    this.titleEntryAt = 0;
    this.resetBranchView();
    this.syncOffline();
    this.syncQueuedCount();
    this.store.getState().setStaleHistory(null);
    this.startOfflineTicker();
    this.startLivenessProbe();

    // ONE cached-tail read for the whole open. The warm paint and offline
    // fallback await THIS promise: two independent `loadTail` calls raced the
    // same IndexedDB record, and which one the fallback observed decided
    // whether the store was written once or twice.
    const cachedTail = loadTail(path, this.cacheNamespace).catch(() => null);
    // Paint the cached tail WHILE the first bundle is in flight, rather than
    // only after the network fails.
    //
    // The IndexedDB tail was already being written on every load; it was just
    // reserved for the offline path. Locally the bundle has no child-spawn
    // work, but the phone reaches the daemon over Tailscale, where that round
    // trip is the difference between the conversation being there and an
    // empty screen. Reopening a session the user was just in is the common
    // case, and for that case the correct content is already on the device.
    //
    // INVARIANT: the initial bundle (or its HTTP fallback) is authoritative.
    // The warm paint only fills the gap, and it deliberately does NOT set
    // staleHistory: the banner means "we could not reach the daemon", which
    // is not the case yet.
    //
    // WHY A CONTENT LATCH AND NOT A TIMER. Painting the cache and then
    // replacing the list with the authoritative page costs the reader his
    // place: verify-nav-paging caught the up-walk going 119, 118, 119, 118 as
    // the second write reset the anchor. Blocking the warm paint behind a
    // delay only makes that rare, and a delay long enough to make it never
    // also killed the warm paint outright. So track WHAT is on screen
    // (`painted.source`) and exactly WHICH content (`painted.key`): when the
    // authoritative page turns out to be that same tail, its cursors, ledger
    // and markers are still adopted and only the pointless list write is
    // skipped. Every arm below then writes at most once, in any order, which
    // is what makes a late or throttled timer harmless rather than a bug.
    //
    // One object rather than two `let`s on purpose: the timer callback is the
    // other writer, and TypeScript's flow analysis cannot see a closure's
    // assignment — it narrows a plain `let` to its initial value and then
    // rejects the comparison below as impossible.
    const painted: { source: "none" | "cache" | "network"; key: string } = {
      source: "none",
      key: "",
    };
    let resolveFirstPage = () => {};
    const firstPageReady = new Promise<void>((resolve) => {
      resolveFirstPage = resolve;
    });
    const opening: OpeningHistoryPage = {
      generation,
      path,
      cachedTail,
      painted,
      pageApplied: false,
      bundleSeen: false,
      fallbackStarted: false,
      settled: false,
      warmTimer: null,
      fallbackTimer: null,
      resolve: resolveFirstPage,
    };
    this.openingHistory = opening;
    opening.warmTimer = window.setTimeout(() => {
      void (async () => {
        const cached = await cachedTail;
        // Re-checked AFTER the await: the read is the slow part, and the
        // authoritative page may have landed while it was in flight.
        if (
          opening.painted.source !== "none" ||
          opening.pageApplied ||
          !this.isCurrent(generation, path)
        )
          return;
        if (!cached || cached.messages.length === 0) return;
        if (cached.contextBoundary !== undefined) this.store.getState().setContextBoundary(cached.contextBoundary);
        this.store.getState().setHistory(cached.messages);
        this.store.getState().setOpening(false);
        opening.painted.source = "cache";
        opening.painted.key = tailKey(cached.messages);
      })();
    }, OPTIMISTIC_TAIL_DELAY_MS);
    opening.fallbackTimer = window.setTimeout(() => {
      opening.fallbackTimer = null;
      this.startInitialHistoryFallback(opening);
    }, BUNDLE_HISTORY_FALLBACK_MS);

    // /ws sends the same tail page as /api/history (FIRST_HISTORY_PAGE
    // entries), so its first frame replaces the old HTTP-then-socket
    // two-round-trip open.
    try {
      this.connectSocket(generation, path);
    } catch {
      this.startInitialHistoryFallback(opening);
    }
    if (this.platformOffline())
      this.startInitialHistoryFallback(opening);
    await firstPageReady;
  }

  private finishOpeningHistoryPage(opening: OpeningHistoryPage): void {
    if (opening.warmTimer !== null) {
      window.clearTimeout(opening.warmTimer);
      opening.warmTimer = null;
    }
    if (opening.fallbackTimer !== null) {
      window.clearTimeout(opening.fallbackTimer);
      opening.fallbackTimer = null;
    }
    if (opening.settled) return;
    opening.settled = true;
    opening.resolve();
  }

  private cancelOpeningHistoryPage(): void {
    const opening = this.openingHistory;
    if (!opening) return;
    this.openingHistory = null;
    this.finishOpeningHistoryPage(opening);
  }

  private applyOpeningHistoryPage(
    opening: OpeningHistoryPage,
    page: OmpHistoryPage,
  ): boolean {
    if (
      opening.pageApplied ||
      !this.isCurrent(opening.generation, opening.path) ||
      this.store.getState().authRejected
    )
      return false;
    const alreadyPainted =
      opening.painted.source === "cache" ? opening.painted.key : undefined;
    opening.pageApplied = true;
    opening.painted.source = "network";
    this.applyTailPage(page, alreadyPainted);
    this.store.getState().setOpening(false);
    this.store.getState().setStaleHistory(null);
    this.store.getState().setError(null);
    if (this.socket?.readyState === WebSocket.OPEN)
      this.store.getState().setConnection("open");
    this.recordSuccess();
    void saveTail(
      opening.path,
      this.store.getState().messages,
      this.cacheNamespace,
      this.store.getState().contextBoundary,
    );
    void this.reconcileReceipts(opening.path);
    void this.flushQueue();
    this.finishOpeningHistoryPage(opening);
    // A resync/restore can arrive before this older initial snapshot. Defer
    // until the bundle's remaining state/cursors have also been applied.
    void Promise.resolve().then(() => {
      if (!this.isCurrent(opening.generation, opening.path)) return;
      const owed = this.catchUpOwed;
      this.catchUpOwed = null;
      if (owed) void this.catchUp(owed);
    });
    return true;
  }

  private startInitialHistoryFallback(opening: OpeningHistoryPage): void {
    if (
      opening.fallbackStarted ||
      opening.pageApplied ||
      !this.isCurrent(opening.generation, opening.path)
    )
      return;
    opening.fallbackStarted = true;
    if (opening.fallbackTimer !== null) {
      window.clearTimeout(opening.fallbackTimer);
      opening.fallbackTimer = null;
    }
    void (async () => {
      let error: unknown;
      try {
        const page = await this.fetchHistory(opening.path, {
          limit: FIRST_HISTORY_PAGE,
        });
        if (
          !this.isCurrent(opening.generation, opening.path) ||
          opening.pageApplied
        )
          return;
        const applied = this.applyOpeningHistoryPage(opening, page);
        if (!applied && !opening.pageApplied) {
          if (this.store.getState().authRejected) {
            this.cancelReconnect();
            this.closeSocket();
            this.store.getState().setOpening(false);
            this.store
              .getState()
              .setConnection(
                this.platformOffline()
                  ? "offline"
                  : "error",
              );
            this.store.getState().setError("Authentication failed");
          }
          this.finishOpeningHistoryPage(opening);
        }
        return;
      } catch (cause) {
        error = cause;
      }
      if (
        !this.isCurrent(opening.generation, opening.path) ||
        opening.pageApplied
      )
        return;

      let cached: CachedTail | null = null;
      if (!this.store.getState().authRejected) {
        // The same read the warm paint used, so this can never race it: the
        // latch, not a settle-wait, is what keeps the store written once.
        cached = await opening.cachedTail;
        if (
          !this.isCurrent(opening.generation, opening.path) ||
          opening.pageApplied
        )
          return;
      }
      if (this.store.getState().authRejected) {
        this.cancelReconnect();
        this.closeSocket();
        this.store.getState().setOpening(false);
        this.store
          .getState()
          .setConnection(
            this.platformOffline()
              ? "offline"
              : "error",
          );
        this.store
          .getState()
          .setError(this.errorMessage(error, "Could not open session"));
        this.finishOpeningHistoryPage(opening);
        return;
      }
      if (cached && cached.messages.length > 0) {
        if (opening.painted.source === "none") {
          if (cached.contextBoundary !== undefined) this.store.getState().setContextBoundary(cached.contextBoundary);
          this.store.getState().setHistory(cached.messages);
          opening.painted.source = "cache";
          opening.painted.key = tailKey(cached.messages);
        }
        // The warm paint deliberately leaves the banner and connection alone:
        // only this failed network path knows the cached tail is stale.
        this.store.getState().setStaleHistory({ savedAt: cached.savedAt });
        this.store.getState().setOpening(false);
        this.store.getState().setError(null);
        // Try the socket even when the platform claims offline: that claim is
        // routinely wrong on Android while the tailnet path works.
        this.reviveSocket(false, true);
        this.finishOpeningHistoryPage(opening);
        return;
      }
      this.store.getState().setOpening(false);
      this.store
        .getState()
        .setConnection(
          this.platformOffline()
            ? "offline"
            : "error",
        );
      this.store
        .getState()
        .setError(this.errorMessage(error, "Could not open session"));
      this.finishOpeningHistoryPage(opening);
    })();
  }
  closeSession(): void {
    ++this.generation;
    this.historyAbort.abort();
    this.earlierInFlight = false;
    this.earlierFinished = null;
    this.revealWindow = null;
    this.cancelOpeningHistoryPage();
    this.cancelReconnect();
    this.stopWatchdog();
    this.stopLivenessProbe();
    this.closeSocket();
    reportChatSocket("none");
    this.cancelStreamFlush();
    this.activeSession = null;
    this.collabQuestionCursor = null;
    this.currentCollabQuestion = null;
    this.atBottom = true;
    this.responseChain = null;
    this.streamText = "";
    this.streamRawText = null;
    this.streamDisplay = null;
    this.pendingDeltas = [];
    this.inbound = null;
    this.cancelOwedCatchUp();
    this.catchUpInFlight = false;
    this.lastCatchUpAt = 0;
    this.consecutiveFailures = 0;
    clearTimelineMarkers();
    this.store.getState().clearSession();
    this.syncQueuedCount();
  }

  /**
   * Send a prompt to `target` (default: the active session).
   *
   * WHY the explicit target: the composer used to call this with no session
   * at all, so the POST went to whatever `activeSession` happened to be when
   * the async body ran. A fast session switch between tap and send retargeted
   * the message into the newly-opened session — and with two identically
   * named rows nothing on screen revealed the switch. The tap-time path wins;
   * `activeSession` is only the fallback.
   *
   * `onSaved` fires the moment the outbox durably owns the prompt, BEFORE any
   * network work. The composer clears on it: waiting for the delivery receipt
   * left the text sitting in the input for a full round trip after its bubble
   * had already appeared, which is the opposite of how sending should feel.
   *
   * `delivery` is how the message joins a turn already running (steer, queue
   * or stop-and-send). It is stored with the durable intent, so a replay
   * keeps it; idle sends pass none.
   */
  async sendPrompt(
    text: string,
    images: readonly { data: string; mimeType: string }[] = [],
    target?: string | null,
    onSaved?: () => Promise<boolean> | void,
    delivery?: PromptDelivery,
  ): Promise<CommandReceipt | null> {
    const sessionPath = target ?? this.activeSession;
    const gen = this.generation;
    const trimmed = text.trim();
    if (!sessionPath || (!trimmed && images.length === 0)) return null;
    if (getOfflineQueueNamespace() !== this.queueNamespace)
      throw new Error("Pairing changed. This message wasn't sent and your draft was kept.");
    if (selectSessionCapability(this.store.getState(), sessionPath, "send") === false)
      throw new Error("This session does not currently allow sending.");

    // Always attempt delivery. The outbox already owns the prompt durably, and
    // a transient failure keeps it queued; short-circuiting on the platform's
    // offline hint parked every message as "Saved offline" on a phone whose
    // WebView misreported connectivity while the daemon answered fine.
    // Persist the complete intent, including image bytes, before painting an
    // optimistic message or allowing Composer to clear its draft. Capacity or
    // storage failures therefore leave both text and attachments recoverable.
    const namespace = this.queueNamespace;
    const echoScope = this.getReceiptScope();
    const echoQueueCurrent = captureQueueScope(namespace);
    const echoCurrent = () => echoQueueCurrent() && this.isCurrent(gen, sessionPath) && echoScope === this.getReceiptScope();
    const entry = await enqueue({
      sessionPath,
      text: trimmed,
      images,
      namespace,
      ...(delivery ? { delivery } : {}),
    });
    const savedAt = entry.createdAt;
    const savedReceipt: CommandReceipt = {
      commandId: entry.commandId,
      sessionPath,
      state: "saved",
      createdAt: savedAt,
      updatedAt: savedAt,
      error: "Saved locally; delivery has not started.",
    };
    const current = this.store.getState();
    // A recovered draft can acknowledge a command already in the transcript.
    // Only locally saved work needs an echo, keyed by the durable command ID
    // so an offline retry cannot append the same optimistic bubble twice.
    if (current.sessionPath === sessionPath && entry.state === "saved"
      && !current.messages.some(message => message.id === `local:${entry.commandId}`)) {
      const echo = createUserMessage(trimmed, entry.commandId, savedAt, entry.imageCount);
      current.appendMessage(echoCurrent()
        ? withLocalSendOwner(echo, entry, echoScope, this, echoCurrent) : echo);
    }
    const draftCommit = onSaved?.();
    if (draftCommit) {
      // Keep retry identity until photo-draft clearing also commits. A process
      // death between native save and that IDB write must not resend a photo.
      void draftCommit.then((cleared) => {
        if (cleared) acknowledgeNativeSave(entry, namespace);
      }).catch(() => undefined);
    } else acknowledgeNativeSave(entry, namespace);
    await this.flushQueue();
    const delivered = await getQueued(entry.commandId, namespace);
    if (!delivered?.receipt) return savedReceipt;
    if (this.isCurrent(gen, sessionPath)) {
      if (delivered.state === "uncertain") {
        this.store.getState().setError(UNCERTAIN_SEND_TOAST);
      } else if (deliveryFailed(delivered)) {
        // The failed bubble already carries the reason, Retry and Remove.
        this.store.getState().setError(null);
      } else {
        this.store.getState().setError(null);
        this.recordSuccess();
      }
    }
    return delivered.receipt;
  }

  /**
   * Re-run a failed turn by sending its user message again, text and images,
   * through the same durable path as every other send. omp's `/retry` builtin
   * would avoid repeating the user bubble, but it only runs through
   * `/api/command`, which refuses a conversation open on the desktop (bridge
   * or collab). One mechanism that works for every owner beats two that
   * behave differently depending on where the session happens to live.
   *
   * An image that cannot be recovered aborts the retry: sending the text
   * alone would quietly ask a different question.
   */
  async retryFailedTurn(prompt: UiMessage, target?: string | null): Promise<CommandReceipt | null> {
    const images = await loadMessageImages(prompt, (path) => this.fetchAuthed(path));
    return this.sendPrompt(prompt.text, images, target);
  }

  /** Viewport edge reporter for the chat scroll listener. Returning to the
   * bottom immediately sheds scrollback the reader left behind. When the
   * tail itself was dropped (bottom eviction) the window reads on from the
   * dropped span by cursor, so it slides rather than reseeds. `lowerHalf`:
   * the reader is in the lower half of what is held, which is when the
   * oldest end is the far one even short of the exact bottom. */
  setAtBottom(atBottom: boolean, lowerHalf = atBottom): void {
    const was = this.atBottom;
    this.atBottom = atBottom;
    this.lowerHalf = lowerHalf || atBottom;
    if (!atBottom || was) return;
    this.enforceWindow();
    if (this.store.getState().evictedBottom > 0 && !this.activeRevealWindow()) void this.advanceToLive();
  }
  private activeRevealWindow(): boolean {
    const reveal = this.revealWindow;
    return !!reveal && this.isCurrent(reveal.generation, reveal.sessionPath)
      && reveal.epoch === this.earlierEpoch && reveal.shouldApply();
  }
  private enforceWindow(): void {
    // Live rows cannot join a window that stops short of the live edge.
    if (this.store.getState().evictedBottom > 0) this.store.getState().dropStrayBottom();
    this.store.getState().trimWindow(this.windowMessages, (this.atBottom || this.lowerHalf) && !this.activeRevealWindow());
  }

  /**
   * Boot the daemon child while the user is still typing (src/server/http.rs
   * /api/prewarm). Fire-and-forget: a failure here only costs latency.
   */
  async prewarm(): Promise<void> {
    const sessionPath = this.activeSession;
    if (!sessionPath) return;
    try {
      await this.request<JsonObject>("/api/prewarm", {
        method: "POST",
        body: JSON.stringify({ sessionPath }),
      });
    } catch {
      // Prewarming is an optimisation; the prompt still works without it.
    }
  }

  /**
   * Forget a cut-off turn's notice (src/server/http.rs /api/interrupted/dismiss),
   * then refresh the list so its row loses the badge. Throws on failure so
   * the caller can say so; nothing is sent to the agent.
   */
  async dismissInterruption(sessionPath: string): Promise<void> {
    await this.request<JsonObject>("/api/interrupted/dismiss", {
      method: "POST",
      body: JSON.stringify({ sessionPath }),
    });
    void this.refreshSessions();
  }

  /** Slash-command catalogue for the composer palette. */
  async loadCommands(): Promise<unknown[]> {
    const sessionPath = this.activeSession;
    if (!sessionPath) return [];
    try {
      const data = await this.request<JsonObject>("/api/rpc", {
        method: "POST",
        body: JSON.stringify({
          sessionPath,
          command: "get_available_commands",
          params: {},
        }),
      });
      const payload = (data.data ?? data.result ?? data) as JsonObject;
      const list = Array.isArray(payload)
        ? payload
        : (payload.commands as unknown);
      if (!Array.isArray(list)) return [];
      // Return raw entries preserving aliases, input, subcommands, source for classifyCommand.
      return list.filter((entry) => entry !== null && entry !== undefined);
    } catch {
      return [];
    }
  }

  async execRpc(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const sessionPath = this.activeSession;
    if (!sessionPath) throw new Error("no session");
    const result = await this.request<JsonObject>("/api/rpc", {
      method: "POST",
      body: JSON.stringify({ sessionPath, command, params }),
    });
    if (result.ok !== false && ["set_model", "set_thinking_level", "set_fast_mode"].includes(command) && sessionPath === this.activeSession) {
      await this.seedQueuedMessages(this.generation, sessionPath);
    }
    return result;
  }

  private addFallbackMarker(fallback: ModelFallback | null | undefined): void {
    if (fallback?.entryId && typeof fallback.at === "number") {
      this.addMarkers([modelFallbackMarker(fallback, `marker:fallback:${fallback.entryId}`, fallback.at)]);
    }
  }

  private adoptHistoryConfiguration(page: OmpHistoryPage): void {
    if (typeof page.sessionModelPending === "boolean") this.configurationPending = page.sessionModelPending;
    if (page.sessionModelPending === true) return;
    this.adoptSessionConfiguration(page.sessionModel);
  }

  /** Complete active-branch folds refresh file-owned controls, never live-owned ones. */
  private adoptSessionConfiguration(source: unknown): void {
    if (!this.activeSession || !isJsonObject(source)) return;
    this.configurationPending = false;
    const state = this.store.getState();
    const patch = parsePassiveSessionModel({ ...source, source: "file" }, state.sessionModel, state.sessionModelProvenance);
    state.setSessionModel(patch, "file");
    if ((patch.thinkingLevel !== undefined || patch.effectiveThinkingLevel !== undefined)
      && typeof source.thinkingAt === "number" && Number.isFinite(source.thinkingAt)) {
      this.thinkingEntryAt = Math.max(this.thinkingEntryAt, source.thinkingAt);
    }
    if (patch.modelFallback?.at !== undefined) this.fallbackEntryAt = Math.max(this.fallbackEntryAt ?? 0, patch.modelFallback.at);
    this.addFallbackMarker(this.store.getState().sessionModel?.modelFallback);
  }

  /**
   * Restore the latest model/effort (and the newest rename) from history when
   * passive state is unavailable.
   * `fillOnly` is for BACKWARD pages: they can only supply what nothing newer has
   * (a long session's last thinking change is often pages above the tail), and
   * must never replace a value the daemon reported.
   */
  private adoptSessionModelEntries(entries: readonly OmpEntry[], fillOnly = false, hasBranchConfiguration = false): void {
    // Until the whole-file fold resolves the active leaf, even an apparently
    // filtered bounded tail can be an abandoned branch.
    const deferConfiguration = hasBranchConfiguration || this.configurationPending;
    const patch: import("./omp-store").SessionModel = {};
    for (const entry of entries) {
      const at = dateMs(entry.timestamp);
      // INVARIANT: backwards history and duplicate tails cannot roll back the header model.
      if (entry.type === "model_change" && at > this.modelEntryAt) {
        const model = parseSessionModel({ model: entry.model });
        if (model.model) {
          this.modelEntryAt = at;
          patch.model = model.model;
          patch.provider = model.provider ?? "";
        }
      } else if (!deferConfiguration && entry.type === "thinking_level_change" && at > this.thinkingEntryAt) {
        const level = entry.configured ?? entry.thinkingLevel ?? entry.thinking_level;
        const effective = entry.thinkingLevel ?? entry.thinking_level;
        if (typeof level === "string" || typeof effective === "string") {
          this.thinkingEntryAt = at;
          if (typeof level === "string") patch.thinkingLevel = level;
          if (typeof effective === "string") patch.effectiveThinkingLevel = effective;
        }
      } else if (!deferConfiguration && entry.type === "custom" && entry.customType === "omp-pulse-model-fallback" && at > (this.fallbackEntryAt ?? 0)) {
        const fallback = parseModelFallback(entry.data);
        if (fallback) {
          this.fallbackEntryAt = at;
          patch.modelFallback = { ...fallback, entryId: entry.id, at };
        }
      }
    }
    if (fillOnly) {
      const known = this.store.getState().sessionModel;
      if (known?.model !== undefined) {
        delete patch.model;
        delete patch.provider;
      }
      if (known?.thinkingLevel !== undefined) delete patch.thinkingLevel;
      if (known?.effectiveThinkingLevel !== undefined) delete patch.effectiveThinkingLevel;
      if (known?.modelFallback !== undefined) delete patch.modelFallback;
    }
    this.store.getState().setSessionModel(patch, "file");
    // A rename lands in the file as a `title_change` entry; the listing only
    // learns it on its next refresh, so the header adopts it from the tail.
    // Backward pages never do: the listing already names the file's newest
    // title, and an older page can only hold an older one.
    if (fillOnly || !this.activeSession) return;
    let title: string | null = null;
    for (const entry of entries) {
      const at = dateMs(entry.timestamp);
      if (entry.type === "title_change" && typeof entry.title === "string" && entry.title.trim() && at >= this.titleEntryAt) {
        this.titleEntryAt = at;
        title = entry.title.trim();
      }
    }
    if (title !== null) this.store.getState().setSessionTitle(this.activeSession, title);
  }

  /**
   * Plan mode from `mode_change` entries on the current branch, newest wins.
   * `older` marks a backward page: it only says what nothing newer has, and
   * never overrides a `plan_mode` reply.
   *
   * `reachedStart` (pages only; live appends omit it): the page ends at the
   * file's first line. With no `mode_change` adopted and no reply, plan mode
   * is then known off; until then it stays unknown (null), because the entry
   * may sit in history the phone has not read, and a bare `/plan` asks
   * instead of guessing.
   */
  private adoptPlanEntries(entries: readonly OmpEntry[], older = false, reachedStart?: boolean): void {
    if (older && this.planFromReply) return;
    const found = newestPlanMode(entries, this.planEntryAt);
    if (found) {
      this.planEntryAt = found.at;
      this.store.getState().setPlanMode(found.state);
      return;
    }
    if (this.planEntryAt !== 0 || this.planFromReply) return;
    // A tail reseed that stops short of the start may have skipped a gap, so a
    // known "off" from an earlier full read no longer holds.
    if (reachedStart === true) this.store.getState().setPlanMode({ enabled: false });
    else if (reachedStart === false && !older) this.store.getState().setPlanMode(null);
  }

  /**
   * Show a `plan_mode` reply at once. Its `mode_change` entry follows and
   * agrees; on a brand-new chat the entry is not on disk until the first
   * reply, so until then this is the only evidence and must survive pages
   * that say nothing about plan mode.
   */
  applyPlanModeReply(sessionPath: string, state: PlanModeState): void {
    if (sessionPath !== this.activeSession || this.store.getState().sessionPath !== sessionPath) return;
    this.planFromReply = true;
    this.store.getState().setPlanMode(state);
  }

  private resetBranchView(): void {
    this.branchView.frontier = null;
    this.branchView.dropped.clear();
    this.branchView.leaf = null;
    this.planEntryAt = 0;
    this.planFromReply = false;
  }

  /** Record what `filterAbandoned` decided for later pages and appends. */
  private noteBranch(result: BranchFilterResult<OmpEntry>): void {
    for (const id of result.dropped) this.branchView.dropped.add(id);
    if (result.leaf !== null) this.branchView.leaf = result.leaf;
  }

  /** Peek seeds both model and pending queues on socket open without booting an idle child. */
  private async seedQueuedMessages(generation: number, path: string): Promise<void> {
    try {
      const queueBefore = this.store.getState().queuedMessages;
      const ticket = this.isCurrent(generation, path) && this.store.getState().sessionPath === path
        ? {} : null;
      if (ticket !== null) this.queueSeedTicket = ticket;
      const before = this.store.getState().sessionModel;
      const data = await this.request<JsonObject>("/api/rpc", {
        method: "POST",
        body: JSON.stringify({ sessionPath: path, command: "get_state", params: {}, peek: true }),
      });
      if (generation !== this.generation || path !== this.activeSession) return;
      const queued = parseQueuedMessages(data.data ?? data);
      if (queued && ticket !== null && this.queueSeedTicket === ticket
        && this.store.getState().queuedMessages === queueBefore
        && this.isCurrent(generation, path) && this.store.getState().sessionPath === path) {
        this.store.getState().setQueuedMessages(queued);
      }
      if (this.store.getState().sessionModel === before) {
        const snapshot = data.data ?? data;
        if (isJsonObject(snapshot)) {
          if (typeof snapshot.sessionModelPending === "boolean") this.configurationPending = snapshot.sessionModelPending;
          else if (typeof snapshot.configuredThinkingLevel === "string") this.configurationPending = false;
        }
        const current = this.store.getState();
        current.setSessionModel(
          parsePassiveSessionModel(snapshot, before, current.sessionModelProvenance),
          isJsonObject(snapshot) && snapshot.source === "file" ? "file" : "live",
        );
        this.addFallbackMarker(this.store.getState().sessionModel?.modelFallback);
      }
      // Only a live child's state speaks for goals; the file-only peek has no
      // `goal` key and leaves what `goal_updated` reported alone.
      const goal = goalFromState(data.data ?? data);
      if (goal !== undefined && this.isCurrent(generation, path) && this.store.getState().sessionPath === path) {
        this.store.getState().setGoal(goal);
      }
    } catch {
      // A passive snapshot: the next queue_update corrects it.
    }
  }

  /** Restore one journal record at a time; acknowledge only durable local drafts. */
  private async recoverWithdrawnQueue(path: string, namespace = this.queueNamespace): Promise<void> {
    const key = `${namespace}\0${path}`;
    if (this.queueRecoveryInFlight.has(key)) return;
    this.queueRecoveryInFlight.add(key);
    try {
      while (this.activeSession === path && this.queueNamespace === namespace) {
        const reply = await this.request<JsonObject>("/api/rpc", {
          method: "POST", body: JSON.stringify({ sessionPath: path, command: "get_queue_recovery", params: {} }),
        });
        const data = reply.data as JsonObject | undefined;
        if (!Array.isArray(data?.recoveries) || !data.recoveries.length) return;
        for (const record of data.recoveries) {
          if (this.queueNamespace !== namespace || getOfflineQueueNamespace() !== namespace) return;
          if (!isJsonObject(record) || record.sessionPath !== path || typeof record.id !== "string") throw new Error("Invalid queued-content recovery record");
          const withdrawn = parseWithdrawnQueue(record.data);
          if (!withdrawn || withdrawn.recoveryPending) throw new Error("Queued content is not ready to recover");
          const notice = await restoreWithdrawnDraft(path, withdrawn, namespace, record.id);
          await this.acknowledgeQueueRecovery(path, record.id, namespace);
          if (notice && this.activeSession === path && this.queueNamespace === namespace) showToast(notice);
        }
        if (data.hasMore !== true) return;
      }
    } catch (error) {
      // A read-only device cannot withdraw anything, and /api/rpc refuses it (403).
      const refused = error instanceof Error && "status" in error && error.status === 403;
      if (!refused && this.activeSession === path && this.queueNamespace === namespace)
        this.store.getState().setError(this.errorMessage(error, "Queued content remains saved on its owner; reconnect to retry recovery"));
    } finally {
      this.queueRecoveryInFlight.delete(key);
    }
  }

  /** Idempotent: the daemon treats an already-acknowledged record as done. */
  async acknowledgeQueueRecovery(sessionPath: string, recoveryId?: string, namespace = this.queueNamespace): Promise<void> {
    if (!recoveryId) return;
    if (this.queueNamespace !== namespace || getOfflineQueueNamespace() !== namespace)
      throw new Error("Connection changed; recovered content is saved and its owner retains the recovery record");
    await this.request("/api/rpc", {
      method: "POST", body: JSON.stringify({ sessionPath, command: "acknowledge_queue_recovery", params: { recoveryId } }),
    });
  }

  /**
   * Cancel omp's pending auto-retry (the turn then ends with the provider
   * error). Resolves to a refusal to show, or null once cancelled. The line is
   * cleared at once because omp's own end event for a cancelled backoff is not
   * guaranteed, and a countdown left running after Cancel reads as ignored.
   */
  async abortRetry(): Promise<string | null> {
    const path = this.activeSession;
    const result = (await this.execRpc("abort_retry")) as JsonObject;
    if (result.ok === false) return typeof result.error === "string" ? result.error : "Couldn't cancel the retry";
    if (path === this.activeSession) this.store.getState().setAutoRetry(null);
    return null;
  }

  /**
   * Drop the exact held occurrence selected from the owner's snapshot. The
   * chip list re-arrives as a `queue_update`; matching text is never identity.
   * With `restore` false the caller discards the content, so a journalled
   * record that was too large to return inline is acknowledged at once.
   */
  async removeQueuedMessage(queue: "steering" | "followUp", message: string, itemId: string, restore = true): Promise<{
    removed: boolean; withdrawn: WithdrawnQueue; namespace: string; sessionPath: string | null;
  }> {
    const namespace = this.queueNamespace;
    const sessionPath = this.activeSession;
    const result = (await this.execRpc("remove_queued_message", { itemId, queue })) as JsonObject;
    const data = result.data as JsonObject | undefined;
    if (data?.recoveryPending === true && sessionPath) {
      if (restore) await this.recoverWithdrawnQueue(sessionPath, namespace);
      else await this.acknowledgeQueueRecovery(sessionPath, typeof data.recoveryId === "string" ? data.recoveryId : undefined, namespace);
      return { removed: true, namespace, sessionPath, withdrawn: { messages: [], imagesDropped: false, truncated: false } };
    }
    return {
      removed: data?.removed === true, namespace, sessionPath,
      withdrawn: {
        messages: [{ text: typeof data?.text === "string" ? data.text : message, images: parseQueueImages(data?.images) }],
        imagesDropped: data?.imagesDropped === true, truncated: data?.truncated === true,
        recoveryId: typeof data?.recoveryId === "string" ? data.recoveryId : undefined,
      },
    };
  }

  /**
   * Move a held follow-up to the steering queue so it lands at the next
   * opportunity. Never falls back to `steer`: that would enqueue a duplicate.
   */
  async promoteQueuedMessage(_message: string, itemId: string): Promise<boolean> {
    if (!this.activeSession || !selectCanPromoteQueuedMessage(this.store.getState(), this.activeSession))
      throw new Error("This session owner cannot send queued messages now.");
    const result = (await this.execRpc("promote_queued_message", { itemId })) as JsonObject;
    return (result.data as JsonObject | undefined)?.promoted === true;
  }

  /**
   * Run a `goal` op (get/create/resume/pause/drop) on the active session and
   * show its result at once; the `goal_updated` that follows agrees with it.
   */
  async runGoal(op: "get" | "create" | "resume" | "pause" | "drop", params: { objective?: string; token_budget?: number } = {}): Promise<GoalSnapshot | null> {
    const sessionPath = this.activeSession;
    const gen = this.generation;
    const result = (await this.execRpc("goal", { op, ...params })) as JsonObject;
    if (sessionPath && this.isCurrent(gen, sessionPath) && this.store.getState().sessionPath === sessionPath) {
      const state = this.store.getState();
      state.setGoal(reduceGoal(state.goal, result.data));
    }
    return this.store.getState().goal;
  }

  /**
   * Abort `target` (default: the active session). Same tap-time capture as
   * sendPrompt: stopping session A must never abort session B just because a
   * switch landed in between.
   *
   * Resolves `false` only when the daemon says no agent was running (its
   * process had already exited; the daemon settles the stale turn and pushes
   * the idle state itself), `true` otherwise.
   *
   * Messages omp was still holding are withdrawn rather than run after the
   * stop (`restoreQueue`). Their chips and optimistic echoes go, and
   * `onWithdrawn` receives their original text and photos for the composer; their receipts settle
   * as stopped, so the outbox never re-sends them.
   */
  async abortTurn(target?: string | null, onWithdrawn?: (
    withdrawn: WithdrawnQueue, destination: { namespace: string; sessionPath: string },
  ) => void | Promise<void>): Promise<boolean> {
    const sessionPath = target ?? this.activeSession;
    const namespace = this.queueNamespace;
    const gen = this.generation;
    if (!sessionPath) return true;
    try {
      if (selectSessionCapability(this.store.getState(), sessionPath, "stop") === false)
        throw new Error("This session owner does not allow stopping the agent.");
      const result = await this.request<JsonObject>("/api/abort", {
        method: "POST",
        body: JSON.stringify({ sessionPath, restoreQueue: selectAbortRestoresQueue(this.store.getState(), sessionPath) }),
      });
      const withdrawn = parseWithdrawnQueue(result?.withdrawn);
      if (withdrawn) {
        const state = this.store.getState();
        if (this.isCurrent(gen, sessionPath) && state.sessionPath === sessionPath) {
          // omp's queue is empty now; an older passive seed must not refill it.
          this.queueSeedTicket = null;
          state.setQueuedMessages(NO_QUEUED_MESSAGES);
          state.dropOptimisticEchoes(withdrawn.messages.map((message) => message.text));
        }
        if (withdrawn.recoveryPending) await this.recoverWithdrawnQueue(sessionPath, namespace);
        else {
          if (withdrawn.messages.length || withdrawn.imagesDropped || withdrawn.truncated) {
            if (onWithdrawn) await onWithdrawn(withdrawn, { namespace, sessionPath });
            else await restoreWithdrawnDraft(sessionPath, withdrawn, namespace);
          }
          // Stop already succeeded; a failed acknowledgement only means the
          // journal replays this record, which the draft de-duplicates.
          await this.acknowledgeQueueRecovery(sessionPath, withdrawn.recoveryId, namespace).catch(() => undefined);
        }
      }
      return result?.stopped !== false;
    } catch (error) {
      if (!this.isCurrent(gen, sessionPath)) throw error;
      this.store
        .getState()
        .setError(this.errorMessage(error, "Could not stop the agent"));
      throw error;
    }
  }

  /** Prepare text for explicit review without replacing the user's composer. */
  prepareEditorDraft(path: string, text: string): boolean {
    if (this.activeSession !== path || this.store.getState().authRejected
      || this.queueNamespace !== getOfflineQueueNamespace()) return false;
    const draft = prepareExtensionDraft(this.queueNamespace, path, text);
    this.store.getState().setExtensionFeedback((state) => ({ ...state, editorDraft: draft }));
    return true;
  }

  consumeEditorDraft(path: string, id: string): void {
    if (this.activeSession !== path || this.store.getState().authRejected
      || this.queueNamespace !== getOfflineQueueNamespace()) return;
    consumeExtensionDraft(this.queueNamespace, path, id);
    this.store.getState().setExtensionFeedback((state) =>
      state.editorDraft?.id === id ? { ...state, editorDraft: null } : state);
  }

  /**
   * HTTP success proves a child pipe handoff, not callback acceptance. Fence
   * completion by generation as well as path: switch-away/back can reuse ids.
   */
  async answerExtensionDialog(id: string, response: ExtensionDialogResponse, expectedSession = this.activeSession): Promise<void> {
    const sessionPath = this.activeSession;
    const generation = this.generation;
    if (!sessionPath || sessionPath !== expectedSession) throw new Error("That question belongs to another session.");
    const close = (): void => {
      if (this.isCurrent(generation, sessionPath))
        this.store.getState().setExtensionDialogs((state) => closeExtensionDialog(state, id));
    };
    try {
      await this.request("/api/panes/answer", {
        method: "POST",
        body: JSON.stringify({ sessionPath, requestId: id, response }),
      });
      if (this.isCurrent(generation, sessionPath))
        this.store.getState().setExtensionDialogs((state) => markExtensionDialogDelivery(state, id, "handoff"));
    } catch (error) {
      if (error instanceof Error && error.message === "that question is no longer waiting") close();
      throw error;
    }
  }

  private rememberCollabAnswer(answer: CollabAnswerState): void {
    const key = collabQuestionKey(answer.question);
    this.collabAnswers.set(key, answer);
    if (this.currentCollabQuestion && collabQuestionKey(this.currentCollabQuestion) === key
      && this.store.getState().sessionPath === answer.sessionPath)
      this.store.getState().setCollabAnswer(answer);
  }

  canRetainCollabAnswer(): boolean {
    const question = this.currentCollabQuestion;
    return question !== null && (this.collabAnswers.has(collabQuestionKey(question)) || this.collabAnswers.size < MAX_RETAINED_COLLAB_ANSWERS);
  }

  setCollabAnswerDraft(reqId: number, value: string, pulseQuestionToken: string): void {
    const state = this.store.getState();
    const question = this.currentCollabQuestion;
    if (!question || question.sessionPath !== state.sessionPath || question.reqId !== reqId
      || question.token !== pulseQuestionToken || state.collabRequest?.pulseQuestionToken !== pulseQuestionToken
      || this.disposed || state.authRejected) return;
    const key = collabQuestionKey(question);
    const previous = this.collabAnswers.get(key);
    if (previous && previous.phase !== "draft" && !collabAnswerCanRetry(previous, question.sessionPath, reqId)) return;
    // An empty editor draft is an intentional edit, not permission to restore its prefill.
    if (value === "" && state.collabRequest?.kind !== "editor") {
      this.collabAnswers.delete(key);
      state.setCollabAnswer(null);
      return;
    }
    if (!previous && this.collabAnswers.size >= MAX_RETAINED_COLLAB_ANSWERS) return;
    this.rememberCollabAnswer({ sessionPath: question.sessionPath, reqId, value, question, phase: "draft" });
  }

  sendCollabUiResponse(reqId: number, value: string | null, pulseQuestionToken: string): void {
    const state = this.store.getState();
    const sessionPath = state.sessionPath;
    if (!sessionPath || state.collabRequest?.reqId !== reqId || this.disposed || state.authRejected) return;
    const question = this.currentCollabQuestion;
    if (!question || question.sessionPath !== sessionPath || question.reqId !== reqId
      || question.token !== pulseQuestionToken || state.collabRequest?.pulseQuestionToken !== pulseQuestionToken) return;
    const previous = this.collabAnswers.get(collabQuestionKey(question));
    if (previous && previous.phase !== "draft" && !collabAnswerCanRetry(previous, sessionPath, reqId)) return;
    if (!previous && this.collabAnswers.size >= MAX_RETAINED_COLLAB_ANSWERS) {
      state.setCollabAnswer({ sessionPath, reqId, value, question, phase: "rejected", reason: "Earlier answers are still waiting. Check those questions before sending another." });
      return;
    }
    const socket = this.socket;
    const open = socket !== null && socket.readyState === WebSocket.OPEN;
    const answer: CollabAnswerState = { sessionPath, reqId, value, question, phase: open ? "sending" : "held" };
    this.rememberCollabAnswer(answer);
    if (!open) {
      state.setHeldCollabResponse({ reqId, value, pulseQuestionToken: question.token });
      return;
    }
    try {
      socket.send(JSON.stringify({ type: "collab-ui-response", reqId, value, pulseQuestionToken: question.token }));
    } catch {
      this.rememberCollabAnswer({ ...answer, phase: "uncertain" });
    }
  }

  sendAgentCommand(command: string, agentId = "", text?: string): void {
    this.sendSocketFrame({ type: "agent-cmd", cmd: command, agentId, text });
  }

  /**
   * Load the page above the current transcript. `historyCursor` is the byte
   * offset of the oldest line we hold; the daemon returns the entries that end
   * strictly before it, so pages never overlap and never skip
   * (src/sessions/jsonl.rs:628-639).
   */
  async loadEarlier(): Promise<boolean> {
    const sessionPath = this.activeSession;
    const cursor = this.store.getState().historyCursor;
    if (!sessionPath || cursor === null || this.earlierInFlight) return true;
    const reveal = this.revealWindow;
    // Auto-prefetch must not move the freshly revealed span during paint/scroll.
    if (reveal && this.activeRevealWindow() && this.store.getState().messages.some((message) => message.sourceEntryId === reveal.entryId)) return true;
    const gen = this.generation;
    const epoch = this.earlierEpoch;
    this.earlierInFlight = true;
    let finish!: () => void;
    this.earlierFinished = new Promise<void>((resolve) => { finish = resolve; });
    this.store.getState().setLoadingEarlier(true);
    let ok = true;
    try {
      const page = await this.fetchHistory(sessionPath, {
        before: cursor,
        limit: this.activeRevealWindow() ? Math.min(this.earlierLimit, this.windowMessages) : this.earlierLimit,
      });
      if (!this.isCurrent(gen, sessionPath) || epoch !== this.earlierEpoch) return true;
      this.adoptHistoryConfiguration(page);
      const branch = filterAbandoned(page.entries ?? [], this.branchView.frontier);
      this.noteBranch(branch);
      this.branchView.frontier = branch.frontier;
      const entries = branch.kept;
      this.adoptSessionModelEntries(entries, true, page.sessionModel !== undefined);
      this.adoptPlanEntries(entries, true, normalizeOffset(page.nextBefore) === null);
      this.adoptContextBoundary(entries);
      const markers = collectMarkers(entries);
      this.addMarkers(markers);
      const transcript = entriesToTranscript(entries);
      this.store.getState().preflightResponseItems(transcript.messages);
      // Record the page BEFORE prepending so the fresh boundary is exact
      // (prepend dedupes by id; only new rows extend the window).
      const known = new Set(this.store.getState().messages.map((m) => m.id));
      const fresh = transcript.messages.filter((m) => !known.has(m.id));
      // A page is a fixed number of ENTRIES, and a tool-heavy conversation is
      // mostly tool entries that fold into one collapsed run: on a real 2,586
      // entry session a page added a single row. Widen the next page while pages
      // keep coming back thin, so auto-loading reaches readable history in a few
      // requests instead of dozens; reset as soon as a page is substantial.
      // Count what the reader would SEE: user turns and replies with prose. Tool
      // and thinking turns fold into one collapsed run, so counting them made a
      // page of 50 tool calls look substantial.
      const visible = fresh.filter((m) => m.role === "user" || m.parts.some((p) => p.kind === "text") || (m.parts.length === 0 && m.text !== "")).length;
      this.earlierLimit = visible < EARLIER_THIN_PAGE ? Math.min(this.earlierLimit * 2, HISTORY_MAX_PAGE) : HISTORY_PAGE;
      this.store.getState().prependMessages(transcript.messages);
      if (fresh.length > 0) {
        this.store.getState().unshiftPage({
          before: cursor,
          nextBefore: normalizeOffset(page.nextBefore),
          firstId: fresh[0].id,
          lastId: fresh[fresh.length - 1].id,
          count: fresh.length,
        });
      }
      if (transcript.orphanResults.length > 0) {
        this.store.getState().applyResults(transcript.orphanResults);
      }
      if (transcript.settledAgents.length > 0) this.store.getState().settleAgents(transcript.settledAgents);
      this.handleToolExecutionStarts(entries);
      this.store.getState().setHistoryCursor(normalizeOffset(page.nextBefore));
      this.enforceWindow();
    } catch (error) {
      ok = false;
      if (this.isCurrent(gen, sessionPath) && epoch === this.earlierEpoch)
        this.store.getState().setError(this.errorMessage(error, "Could not load earlier messages"));
    } finally {
      if (this.isCurrent(gen, sessionPath)) {
        this.earlierInFlight = false;
        this.store.getState().setLoadingEarlier(false);
      }
      finish();
    }
    return ok;
  }

  /**
   * Load history until the transcript holds `entryId`: a Timeline tap on a
   * turn older than the loaded window used to search the DOM and do nothing.
   * Restores an evicted bottom or top first, then pages back, bounded by
   * REVEAL_MAX_PAGES. "off-branch" as soon as the turn is known to sit on a
   * branch the chat does not show (the branch filter dropped it);
   * "unreachable" when it stays out of reach otherwise.
   */
  async revealEntry(entryId: string, shouldApply: () => boolean = () => true): Promise<RevealResult> {
    const sessionPath = this.activeSession;
    if (!sessionPath || !shouldApply()) return "unreachable";
    const reveal = {
      entryId, sessionPath, generation: this.generation, epoch: this.earlierEpoch, shouldApply,
    };
    this.revealWindow = reveal;
    const current = () => this.revealWindow === reveal && this.activeRevealWindow();
    const settled = (): RevealResult | null => {
      if (!current()) return "unreachable";
      return this.store.getState().messages.some((m) => m.sourceEntryId === entryId)
        ? "revealed" : this.branchView.dropped.has(entryId) ? "off-branch" : null;
    };
    let result: RevealResult = "unreachable";
    try {
      let known = settled();
      if (known) return (result = known);
      if (this.store.getState().evictedBottom > 0) {
        // This reveal owns this one tail replacement, not any later replacement.
        reveal.epoch++;
        await this.jumpToLatest(current);
      }
      if (!current()) return result;
      if (this.earlierInFlight) {
        if (!this.earlierFinished) return result;
        await this.earlierFinished;
      }
      for (let page = 0; page < REVEAL_MAX_PAGES; page++) {
        if ((known = settled())) return (result = known);
        if (this.earlierInFlight) return result;
        const gap = this.store.getState().evictedTop;
        if (gap) {
          const reloaded = await this.reloadEvictedTop();
          if (!reloaded && this.store.getState().evictedTop?.before === gap.before)
            return (result = settled() ?? "unreachable");
        } else {
          if (this.store.getState().historyCursor === null || !(await this.loadEarlier())) return result;
        }
      }
      return (result = settled() ?? "unreachable");
    } finally {
      // A successful reveal must survive React's paint and the scroll settle.
      // Its caller releases the pin; failure cannot leave a viewport override.
      if (result !== "revealed") this.releaseRevealedEntry(entryId, shouldApply);
    }
  }

  /** End a reveal's paint/scroll handoff without releasing a newer same-id jump. */
  releaseRevealedEntry(entryId: string, shouldApply?: () => boolean): void {
    const reveal = this.revealWindow;
    if (!reveal || reveal.entryId !== entryId || (shouldApply && reveal.shouldApply !== shouldApply)) return;
    this.revealWindow = null;
    if (this.isCurrent(reveal.generation, reveal.sessionPath) && reveal.epoch === this.earlierEpoch)
      this.enforceWindow();
  }

  /**
   * Reload an evicted top span (the "earlier messages unloaded" placeholder).
   * Refetches by cursor in bounded batches; the daemon's older region is
   * append-only so each page's `before` cursor stays valid. Reloaded pages
   * re-enter the ledger at the top, so a later eviction can drop them again.
   * Returns false when offline or with nothing to reload.
   */
  async reloadEvictedTop(): Promise<boolean> {
    const sessionPath = this.activeSession;
    const gap = this.store.getState().evictedTop;
    if (!sessionPath || !gap || this.earlierInFlight) return false;
    const reveal = this.revealWindow;
    if (reveal && this.activeRevealWindow() && this.store.getState().messages.some((message) => message.sourceEntryId === reveal.entryId)) return false;
    const gen = this.generation;
    const epoch = this.earlierEpoch;
    this.earlierInFlight = true;
    let finish!: () => void;
    this.earlierFinished = new Promise<void>((resolve) => { finish = resolve; });
    this.store.getState().setLoadingEarlier(true);
    try {
      let remaining = gap.count;
      let before = gap.before;
      let guard = 0;
      let reloaded = false;
      // Reveal checks for its target after every request, before an older page
      // could push that target out of the bounded window.
      const maxPages = this.activeRevealWindow() ? 1 : 5;
      while (remaining > 0 && guard++ < maxPages) {
        if (!this.isCurrent(gen, sessionPath) || epoch !== this.earlierEpoch) return false;
        const page = await this.fetchHistory(sessionPath, {
          before,
          limit: Math.min(100, remaining, this.windowMessages),
        });
        if (!this.isCurrent(gen, sessionPath) || epoch !== this.earlierEpoch) return false;
        const raw = page.entries ?? [];
        if (raw.length === 0) break;
        const dropped = this.branchView.dropped;
        const entries = raw.filter((entry) => typeof entry.id !== "string" || !dropped.has(entry.id));
        const known = new Set(this.store.getState().messages.map((m) => m.id));
        const transcript = entriesToTranscript(entries);
        this.store.getState().preflightResponseItems(transcript.messages);
        const fresh = transcript.messages.filter((m) => !known.has(m.id));
        this.store.getState().prependMessages(transcript.messages);
        if (transcript.orphanResults.length > 0) {
          this.store.getState().applyResults(transcript.orphanResults);
        }
        if (transcript.settledAgents.length > 0) this.store.getState().settleAgents(transcript.settledAgents);
        const next = normalizeOffset(page.nextBefore);
        if (fresh.length > 0) {
          this.store.getState().unshiftPage({
            before,
            nextBefore: next,
            firstId: fresh[0].id,
            lastId: fresh[fresh.length - 1].id,
            count: fresh.length,
          });
          reloaded = true;
        }
        // Only a strictly older cursor is progress. Empty/error/stalled reads
        // leave the unresolved gap intact, including its remaining row count.
        const progressed = next !== null && next < before;
        this.store.getState().advanceEvictedTop(fresh.length, progressed ? next : before);
        remaining -= fresh.length;
        this.enforceWindow();
        if (!progressed) break;
        before = next;
      }
      this.enforceWindow();
      return reloaded;
    } catch (error) {
      if (!this.isCurrent(gen, sessionPath) || epoch !== this.earlierEpoch) return false;
      this.store
        .getState()
        .setError(
          this.errorMessage(error, "Could not reload earlier messages"),
        );
      return false;
    } finally {
      if (this.isCurrent(gen, sessionPath)) {
        this.earlierInFlight = false;
        this.store.getState().setLoadingEarlier(false);
      }
      finish();
    }
  }

  /**
   * Jump-to-latest after bottom eviction: reseed the window from the tail so
   * no middle gap can form (merging a tail page over a trimmed bottom would
   * strand the span between them, unreachable by cursor). Only a dropped tail
   * needs this: top gaps keep the bottom intact, so plain scrolling suffices
   * there. Returns false when nothing was dropped and the caller should just
   * scroll.
   */
  async jumpToLatest(shouldApply: () => boolean = () => true): Promise<boolean> {
    const sessionPath = this.activeSession;
    const st = this.store.getState();
    if (!sessionPath || st.evictedBottom === 0) return false;
    const gen = this.generation;
    const epoch = ++this.earlierEpoch;
    try {
      const page = await this.fetchHistory(sessionPath, {
        limit: HISTORY_PAGE,
      });
      if (!this.isCurrent(gen, sessionPath) || epoch !== this.earlierEpoch) return false;
      if (!shouldApply()) return false;
      this.applyTailPage(page);
      this.store.getState().setError(null);
      this.recordSuccess();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the span below the window by cursor, as the reader nears it: the
   * mirror of `reloadEvictedTop`. Scrolling down through a long chat slides
   * the window the way scrolling up does. Reseeding from the tail instead
   * swapped every row under the reader, which read as the bottom loading in
   * again. Returns false when the read failed or was superseded.
   */
  async loadLater(): Promise<boolean> {
    const sessionPath = this.activeSession;
    const start = this.store.getState();
    const cursor = start.evictedBottomAfter;
    if (!sessionPath || start.evictedBottom === 0 || cursor === null) return false;
    // One read at a time; the one running will report the next cursor.
    if (this.laterInFlight || this.activeRevealWindow()) return true;
    const gen = this.generation;
    const epoch = this.earlierEpoch;
    this.laterInFlight = true;
    try {
      const page = await this.fetchHistory(sessionPath, { after: cursor });
      if (!this.isCurrent(gen, sessionPath) || epoch !== this.earlierEpoch) return false;
      const end = normalizeOffset(page.endOffset);
      const closed = end !== null && end >= this.store.getState().endOffset;
      if (!closed && (end === null || end <= cursor)) return false;
      const dropped = this.branchView.dropped;
      const entries = (page.entries ?? []).filter((entry) => typeof entry.id !== "string" || !dropped.has(entry.id));
      // Live rows held past the window belong after what this page returns.
      this.store.getState().dropStrayBottom();
      const known = new Set(this.store.getState().messages.map((message) => message.id));
      const transcript = entriesToTranscript(entries);
      this.store.getState().preflightResponseItems(transcript.messages);
      const fresh = transcript.messages.filter((message) => !known.has(message.id));
      this.store.getState().mergeMessages(fresh);
      if (transcript.orphanResults.length > 0) this.store.getState().applyResults(transcript.orphanResults);
      if (transcript.settledAgents.length > 0) this.store.getState().settleAgents(transcript.settledAgents);
      this.store.getState().advanceEvictedBottom(
        fresh.length > 0 && end !== null
          ? { before: end, nextBefore: cursor, firstId: fresh[0].id, lastId: fresh[fresh.length - 1].id, count: fresh.length }
          : null,
        fresh.length,
        closed ? null : end,
      );
      // The reader is at this end: the far end to shed is the oldest.
      this.store.getState().trimWindow(this.windowMessages, true);
      return true;
    } catch (error) {
      if (this.isCurrent(gen, sessionPath) && epoch === this.earlierEpoch)
        this.store.getState().setError(this.errorMessage(error, "Could not load newer messages"));
      return false;
    } finally {
      if (this.isCurrent(gen, sessionPath)) this.laterInFlight = false;
    }
  }

  /**
   * The reader is near the live edge of a window whose bottom span was
   * dropped. Read on by cursor; reseed from the tail only when the cursor is
   * unknown or the reader has just sent something (the echo sits at the live
   * edge, so the window must too).
   */
  advanceToLive(): Promise<boolean> {
    const state = this.store.getState();
    if (state.evictedBottom === 0 || this.activeRevealWindow()) return Promise.resolve(true);
    if (state.evictedBottomAfter === null || state.messages.some((message) => message.id.startsWith("local:")))
      return this.jumpToLatest();
    return this.loadLater();
  }

  /**
   * Re-seed the transcript from the tail after an in-place tree move. The
   * daemon serves every branch in the file, and a move rewrites nothing (at
   * most a marker), so what is on screen below the move's target is abandoned: a
   * forward catch-up would only add to it. Same seed as `jumpToLatest`, and
   * the same epoch fence, so a later call supersedes an earlier one.
   */
  async reloadBranch(): Promise<boolean> {
    const sessionPath = this.activeSession;
    if (!sessionPath) return false;
    const gen = this.generation;
    const epoch = ++this.earlierEpoch;
    const modelBefore = this.store.getState().sessionModel;
    try {
      const page = await this.fetchHistory(sessionPath, { limit: HISTORY_PAGE });
      if (!this.isCurrent(gen, sessionPath) || epoch !== this.earlierEpoch) return false;
      this.resetBranchView();
      if (this.store.getState().sessionModel === modelBefore) {
        const model = { ...modelBefore };
        delete model.thinkingLevel;
        delete model.effectiveThinkingLevel;
        delete model.modelFallback;
        delete model.ctxPercent;
        delete model.contextMeasuredAfter;
        this.store.setState({ sessionModel: model, sessionModelProvenance: {}, sessionModelAuthority: null });
        this.modelEntryAt = 0;
        this.thinkingEntryAt = 0;
        this.fallbackEntryAt = 0;
      }
      this.store.getState().setContextBoundary(null);
      // The move may have left plan mode behind with the turns it abandoned;
      // the new tail says what holds now.
      this.store.getState().setPlanMode(null);
      clearTimelineMarkers();
      this.applyTailPage(page);
      this.store.getState().setError(null);
      this.recordSuccess();
      void saveTail(sessionPath, this.store.getState().messages, this.cacheNamespace, this.store.getState().contextBoundary);
      void this.seedQueuedMessages(gen, sessionPath);
      return true;
    } catch (error) {
      if (this.isCurrent(gen, sessionPath) && epoch === this.earlierEpoch)
        this.store.getState().setError(this.errorMessage(error, "Could not refresh conversation"));
      return false;
    }
  }

  /**
   * Forward catch-up: ask only for what landed after the bytes we already have
   * (src/server/http.rs:758-803, `after` branch). Used on reconnect, on `poll`, on
   * `resync` and when the tab becomes visible — all the cases where the socket
   * may have missed appends. Refetching the tail instead would re-download
   * what we hold and would clobber pages the user scrolled up to.
   */
  async catchUp(reason: string): Promise<void> {
    await this.catchUpWithResult(reason);
  }

  private async catchUpWithResult(reason: string): Promise<boolean> {
    const sessionPath = this.activeSession;
    if (!sessionPath) return false;
    const owes = reason === "resync" || reason === "poll" ? reason : null;
    if (owes) {
      this.resyncPending = true;
      this.resyncVersion++;
    }
    if (document.visibilityState === "hidden") return false;
    if (this.catchUpInFlight) {
      // The running fetch may predate what this frame reports: run once more
      // when it lands. A resync outranks a poll.
      if (owes && this.catchUpOwed !== "resync") this.catchUpOwed = owes;
      return false;
    }
    const opening = this.openingHistory;
    if (opening && opening.generation === this.generation && !opening.pageApplied) {
      if (owes && this.catchUpOwed !== "resync") this.catchUpOwed = owes;
      return false;
    }
    const now = Date.now();
    const cooldown = CATCH_UP_COOLDOWN_MS - (now - this.lastCatchUpAt);
    if (cooldown > 0) {
      // Coalesce a burst into this trailing fetch; never drop it.
      if (owes && this.catchUpTimer === null) {
        const timer = window.setTimeout(() => {
          if (this.catchUpTimer !== timer) return;
          this.catchUpTimer = null;
          void this.catchUpWithResult(owes);
        }, cooldown);
        this.catchUpTimer = timer;
      }
      return false;
    }
    // Cancel scheduling, not the recovery debt. Only a successful page can
    // settle it, and a hint arriving during this read belongs to a newer version.
    if (this.catchUpTimer !== null) window.clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.catchUpOwed = null;
    const recovering = this.resyncPending;
    const resyncVersion = this.resyncVersion;
    const gen = this.generation;
    const epoch = this.earlierEpoch;
    this.lastCatchUpAt = now;
    this.catchUpInFlight = true;
    try {
      const offset = this.store.getState().endOffset;
      const feedbackSequence = this.feedbackIngressSequence;
      const feedbackReset = this.feedbackResetSequence;
      const feedbackBefore = this.store.getState().extensionFeedback;
      const dialogsBefore = this.store.getState().extensionDialogs;
      const dialogLifecycle = this.dialogLifecycleSequence;
      const authorityBefore = this.store.getState().sessionAuthorities[sessionPath];
      const draftBefore = feedbackBefore.editorDraft;
      const page =
        offset > 0
          ? await this.fetchHistory(sessionPath, { after: offset, feedback: true })
          : await this.fetchHistory(sessionPath, { limit: HISTORY_PAGE, feedback: true });
      if (!this.isCurrent(gen, sessionPath) || epoch !== this.earlierEpoch) return false;
      const authority = parseSessionAuthority(page.sessionState);
      const current = this.store.getState().sessionAuthorities[sessionPath];
      const feedback = page.extensionFeedback;
      if (feedback && authority && current
        && authority.daemonInstanceId === current.daemonInstanceId
        && authority.bindingEpoch === current.bindingEpoch
        && feedbackReset === this.feedbackResetSequence
        && (!authorityBefore || authority.daemonInstanceId !== authorityBefore.daemonInstanceId
          || authority.bindingEpoch !== authorityBefore.bindingEpoch
          || authority.revision >= authorityBefore.revision)
        && !this.store.getState().authRejected) {
        this.store.getState().setExtensionFeedback((state) => {
          // A live question/status or authority update must not suppress an
          // unrelated missed failure. Only stable notices can cross that race;
          // mutable surfaces still require the complete freshness fence.
          if (authority.revision < current.revision || feedbackSequence !== this.feedbackIngressSequence)
            return recoverExtensionNotices(state, feedback, feedbackBefore, this.queueNamespace, sessionPath);
          // A local preparation/consumption made while HTTP was in flight is
          // newer than its replay. Keep it without retaining stale surfaces.
          const snapshot = state.editorDraft === draftBefore ? feedback : {
            ...feedback,
            requests: Array.isArray(feedback.requests)
              ? feedback.requests.filter((request) => !isJsonObject(request) || request.method !== "set_editor_text")
              : undefined,
          };
          return reduceExtensionFeedback(state, snapshot, this.queueNamespace, sessionPath);
        });
      }
      const dialogs = page.extensionDialogs;
      if (isJsonObject(dialogs) && authority && current
        && authority.owner.kind === "child" && current.owner.kind === "child"
        && authority.daemonInstanceId === current.daemonInstanceId
        && authority.bindingEpoch === current.bindingEpoch
        && dialogLifecycle === this.dialogLifecycleSequence
        && (!authorityBefore || authority.daemonInstanceId !== authorityBefore.daemonInstanceId
          || authority.bindingEpoch !== authorityBefore.bindingEpoch
          || authority.revision >= authorityBefore.revision)
        && !this.store.getState().authRejected) {
        this.store.getState().setExtensionDialogs((state) =>
          reduceExtensionDialogSnapshot(state, dialogs, Date.now(), dialogsBefore));
      }
      // Set the pending/complete branch contract before inspecting page receipts.
      this.adoptHistoryConfiguration(page);
      this.mergeHistory(page.entries ?? [], false, page.sessionModel !== undefined);
      // A `resync` lands here, and it discarded the turn's `agent_end` and
      // idle `activity` frames along with everything else queued: without the
      // `fetchHistory` reconciles the page snapshot at request-generation time;
      // do not reapply a delayed response as fresh evidence here.
      const end = normalizeOffset(page.endOffset);
      if (end !== null && end > this.store.getState().endOffset) {
        this.store.getState().setEndOffset(end);
      }
      if (offset === 0)
        this.store
          .getState()
          .setHistoryCursor(normalizeOffset(page.nextBefore));
      if (offset === 0) this.noteSeedPage(normalizeOffset(page.nextBefore));
      this.store.getState().setError(null);
      this.store.getState().setStaleHistory(null);
      if (resyncVersion === this.resyncVersion) this.resyncPending = false;
      this.resyncRetryUsed = false;
      this.recordSuccess();
      if ((page.entries ?? []).length > 0 || offset === 0) {
        void saveTail(
          sessionPath,
          this.store.getState().messages,
          this.cacheNamespace,
          this.store.getState().contextBoundary,
        );
      }
      return true;
    } catch (error) {
      if (!this.isCurrent(gen, sessionPath)) return false;
      const ejected = this.recordFailure();
      if (ejected) return false;
      this.store
        .getState()
        .setError(this.errorMessage(error, "Could not refresh conversation"));
      // A healthy OPEN socket may keep heartbeating forever after this failed
      // read. Retry actual missing-history recovery once, not generic requests.
      // The same timer is canceled on hide/close/dispose, leaving truthful debt
      // for an explicit restore, fresh daemon hint or manual retry after exhaustion.
      // The page can hide while fetchHistory is awaited; TS retains the earlier
      // visibility narrowing across that await, so re-read the full state type.
      if (recovering && this.resyncPending && !this.resyncRetryUsed &&
        !this.store.getState().authRejected && (document.visibilityState as DocumentVisibilityState) !== "hidden" &&
        this.catchUpTimer === null) {
        this.resyncRetryUsed = true;
        const timer = window.setTimeout(() => {
          if (this.catchUpTimer !== timer) return;
          this.catchUpTimer = null;
          if (!this.isCurrent(gen, sessionPath) || epoch !== this.earlierEpoch) return;
          void this.catchUpWithResult("resync");
        }, CATCH_UP_COOLDOWN_MS);
        this.catchUpTimer = timer;
      }
      return false;
    } finally {
      if (this.isCurrent(gen, sessionPath)) {
        this.catchUpInFlight = false;
        const owed = this.catchUpOwed;
        this.catchUpOwed = null;
        if (owed) void this.catchUpWithResult(owed);
      }
    }
  }

  private cancelOwedCatchUp(): void {
    if (this.catchUpTimer !== null) window.clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.catchUpOwed = null;
    this.resyncPending = false;
    this.resyncVersion++;
    this.resyncRetryUsed = false;
  }

  async reloadHistory(): Promise<void> {
    this.resyncRetryUsed = false;
    this.lastCatchUpAt = 0;
    await this.catchUp("manual");
  }
  /**
   * Undo dispose() for the component that owns this instance. StrictMode runs
   * App's dispose cleanup between its two effect setups; a chat booted from a
   * deep link never starts polling or opens a listing on its own, so without
   * an explicit resume its listing was never fetched (empty switcher, header
   * reading "Session"). Listing entry points stay inert while disposed (a
   * retired credential's controller must not fetch), and dispose() already
   * advanced the lifetime, so reads begun before it stay fenced.
   */
  resume(): void {
    this.disposed = false;
    this.bindVisibility();
    this.startOfflineTicker();
  }
  dispose(): void {
    this.disposed = true;
    ++this.authenticationGeneration;
    this.rejectedGeneration = null;
    // The shared store outlives credential-dependent controllers. A later
    // start/open can resume this instance, but must never revive its old reads.
    ++this.sessionsListingLifetime;
    ++this.sessionsListingGeneration;
    this.sessionsCacheHydrated = false;
    this.runningAgentCount.stop();
    this.stopSessionsPolling();
    this.stopOfflineTicker();
    this.stopLivenessProbe();
    this.stopWatchdog();
    this.unbindVisibility();
    this.closeSession();
    this.collabAnswers.clear();
  }

  private async fetchHistory(
    path: string,
    cursor: { before?: number; after?: number; limit?: number; feedback?: boolean },
  ): Promise<OmpHistoryPage> {
    const params = new URLSearchParams({ session: path });
    if (cursor.feedback) params.set("feedback", "true");
    if (cursor.after !== undefined) params.set("after", String(cursor.after));
    else {
      if (cursor.before !== undefined) params.set("before", String(cursor.before));
      params.set("limit", String(Math.min(cursor.limit ?? HISTORY_PAGE, HISTORY_MAX_PAGE)));
    }
    const ingressSequence = this.nextStateIngressSequence();
    const data = await this.request<HistoryResponse>(`/api/history?${params}`, { signal: this.historyAbort.signal });
    const page: OmpHistoryPage = {
      entries: Array.isArray(data.entries) ? data.entries : [],
      endOffset: data.endOffset,
      nextBefore: data.nextBefore,
      running: data.running,
      now: data.now,
      at: data.at,
      sessionState: isJsonObject(data.sessionState) ? data.sessionState as OmpHistoryPage["sessionState"] : undefined,
      extensionFeedback: isJsonObject(data.extensionFeedback) ? data.extensionFeedback : undefined,
      extensionDialogs: isJsonObject(data.extensionDialogs) ? data.extensionDialogs : undefined,
      sessionModel: isJsonObject(data.sessionModel) ? data.sessionModel : undefined,
      sessionModelPending: data.sessionModelPending === true,
    };
    this.reconcileSessionState(path, page, ingressSequence);
    return page;
  }

  /**
   * Seed the transcript and both cursors from a tail page or a bundle frame.
   *
   * `keepListIfKey` is the content latch (see `openSession`): pass the
   * `tailKey` of a transcript already on screen and, when this page holds
   * exactly that, the list write is skipped. The cursors, ledger, markers and
   * orphan results still adopt the authoritative page — only the array swap
   * that would reset the reader's scroll anchor is dropped. Omitting it keeps
   * the unconditional seed every other caller wants.
   */
  private applyTailPage(page: OmpHistoryPage, keepListIfKey?: string): void {
    this.adoptHistoryConfiguration(page);
    const branch = filterAbandoned(page.entries ?? [], null);
    this.noteBranch(branch);
    this.branchView.frontier = branch.frontier;
    const entries = branch.kept;
    // A bounded page can omit model_usage.activeLeafId's target and retain an
    // abandoned tail. Its receipts cannot override whole-file branch metadata.
    this.adoptSessionModelEntries(entries, false, page.sessionModel !== undefined);
    this.adoptPlanEntries(entries, false, normalizeOffset(page.nextBefore) === null);
    this.adoptContextBoundary(entries);
    const markers = collectMarkers(entries);
    this.addMarkers(markers);
    const transcript = entriesToTranscript(entries);
    this.store.getState().preflightResponseItems(transcript.messages);
    if (
      keepListIfKey === undefined ||
      keepListIfKey !== tailKey(transcript.messages)
    ) {
      this.store.getState().setHistory(transcript.messages);
    }
    // A tail seed replaces the window wholesale: one ledger page covering it.
    const seeded = this.store.getState().messages;
    this.store.getState().resetPages(
      seeded.length > 0
        ? [
            {
              before: null,
              nextBefore: normalizeOffset(page.nextBefore),
              firstId: seeded[0].id,
              lastId: seeded[seeded.length - 1].id,
              count: seeded.length,
            },
          ]
        : [],
    );
    if (transcript.orphanResults.length > 0) {
      this.store.getState().applyResults(transcript.orphanResults);
    }
    if (transcript.settledAgents.length > 0) this.store.getState().settleAgents(transcript.settledAgents);
    this.handleToolExecutionStarts(entries);
    this.store.getState().setHistoryCursor(normalizeOffset(page.nextBefore));
    this.store.getState().setEndOffset(normalizeOffset(page.endOffset) ?? 0);
  }

  private async fetchAuthed(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const generation = this.authenticationGeneration;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    const response = await fetchWithDeadline(new URL(path, `${this.baseUrl}/`), {
      ...init,
      headers,
    });
    if (response.status === 401) {
      // A repair can save a replacement before this controller is torn down.
      // Neither that old credential nor a previous lifetime may reject it.
      if (!this.disposed && !this.pairingRepair && generation === this.authenticationGeneration && readPairingToken() === this.token) {
        this.rejectedGeneration = generation;
        this.store.getState().setAuthRejected(true);
      }
      throw new Error("Authentication failed");
    }
    return response;
  }

  private async failureDetail(response: Response): Promise<string> {
    try {
      const body: unknown = await response.json();
      if (isJsonObject(body) && typeof body.error === "string")
        return body.error;
    } catch {
      // Keep the status as the actionable error when the body is not JSON.
    }
    return `HTTP ${response.status}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchAuthed(path, init);
    const body = await readJsonResponse(response);
    if (!response.ok) {
      const message = isJsonObject(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw Object.assign(new Error(message), { status: response.status, code: isJsonObject(body) ? body.code : undefined });
    }
    if (isJsonObject(body) && body.ok === false) {
      if (path === "/api/prompt" && ("receipt" in body || "receiptBinding" in body))
        throw new ReceiptValidationError();
      const message =
        typeof body.error === "string" ? body.error : "request failed";
      throw Object.assign(new Error(message), { status: response.status, code: body.code });
    }
    return body as T;
  }

  /** Listing refresh that reports failures without throwing at every caller. */
  private async refreshSessions(): Promise<void> {
    const sessionGeneration = this.generation;
    const refreshGeneration = this.sessionsRefreshGeneration;
    const request = this.loadSessions();
    // loadSessions advances its generation synchronously, or reuses the current
    // request. Capture after invoking it so both observers share the same owner.
    const listingGeneration = this.sessionsListingGeneration;
    try {
      await request;
    } catch (error) {
      // Polling/reconnect reads can reject after navigation, disposal or a
      // newer listing has succeeded. Retiring their observer must not turn that
      // old failure into the new screen's error. Direct callers still reject.
      if (this.disposed || this.generation !== sessionGeneration
        || this.sessionsRefreshGeneration !== refreshGeneration
        || this.sessionsListingGeneration !== listingGeneration) return;
      this.store
        .getState()
        .setError(this.errorMessage(error, "Could not load sessions"));
    }
  }

  private bindVisibility(): void {
    if (this.visibilityBound) return;
    this.visibilityBound = true;
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("focus", this.onVisible);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    // The computer answering again is the moment to dial, not the end of a
    // backoff that can run to 30 s. Only the turn to `live` counts:
    // `reportChatSocket` notifies listeners too.
    let previousKind = getLinkState().kind;
    this.unsubscribeLink = subscribeLink(() => {
      const kind = getLinkState().kind;
      const was = previousKind;
      previousKind = kind;
      if (was !== "live" && kind === "live" && this.activeSession && !this.socketOpen())
        this.reviveSocket(false, true);
    });
  }

  private unbindVisibility(): void {
    if (!this.visibilityBound) return;
    this.visibilityBound = false;
    this.unsubscribeLink?.();
    this.unsubscribeLink = null;
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("focus", this.onVisible);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
  }

  /**
   * A person is about to act on this chat (the composer calls it on focus). If
   * the socket is down or has been quiet, ask the link now, so by the time a
   * message is typed the indicator already knows.
   */
  noteUserActivity(): void {
    if (!this.activeSession || this.disposed) return;
    if (!this.socketOpen() || Date.now() - this.lastFrameAt >= ACTIVITY_SILENCE_MS) void probeLink();
  }

  /** Reconnect immediately instead of waiting out the backoff after a resume. */
  private reviveSocket(
    forceReconnect = false,
    bypassFailureGate = false,
  ): void {
    const path = this.activeSession;
    if (!path || this.disposed || this.store.getState().authRejected) return;
    if (this.socket?.readyState === WebSocket.CONNECTING && !forceReconnect) return;
    if (this.socket?.readyState === WebSocket.OPEN && !forceReconnect) return;
    if (this.socket) {
      this.closeSocket();
      this.store.getState().setConnection("reconnecting");
    }
    if (
      this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
      !bypassFailureGate
    )
      return;
    this.cancelReconnect();
    this.connectSocket(this.generation, path, bypassFailureGate);
  }

  private connectSocket(
    generation: number,
    path: string,
    bypassFailureGate = false,
  ): void {
    if (
      this.disposed ||
      !this.isCurrent(generation, path) ||
      this.store.getState().authRejected
    )
      return;
    if (
      this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
      !bypassFailureGate
    )
      return;
    const url = new URL("/ws", `${this.baseUrl}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("session", path);
    url.searchParams.set("token", this.token);
    url.searchParams.set("releaseId", LOADED_RELEASE_ID);
    url.searchParams.set("protocolVersion", String(CLIENT_PROTOCOL_VERSION));
    const caps = ["delta", "bundle"];
    if ("DecompressionStream" in globalThis) caps.splice(1, 0, "defl");
    url.searchParams.set("caps", caps.join(","));
    // Only the opening socket asks for the short first page; a reconnect's
    // bundle is a catch-up merge and keeps the daemon's default depth.
    const opening = this.openingHistory;
    if (opening?.generation === generation && opening.path === path && !opening.pageApplied)
      url.searchParams.set("limit", String(FIRST_HISTORY_PAGE));

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    // A handshake gets its own liveness window, even before onopen. Pending
    // decompression from the retired socket must not hold this queue hostage.
    this.lastFrameAt = Date.now();
    this.inbound = null;
    this.startWatchdog();
    reportChatSocket("down");
    this.store.getState().setConnection("connecting");

    socket.onopen = () => {
      if (!this.isCurrent(generation, path) || this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.lastFrameAt = Date.now();
      this.startLivenessProbe();
      // The daemon counts a new socket as visible, so only a hidden page has
      // to say otherwise on (re)open. Unsaid, a reconnect made while
      // backgrounded re-pinned the child, and the daemon kept tailing the
      // session file for a viewer nobody could see.
      if (document.visibilityState === "hidden") this.reportVisibility(socket);
      // The socket opening is proof of connectivity, whatever the hint says.
      reportChatSocket("open");
      this.store.getState().setConnection("open");
      this.store.getState().setOffline(false);
      noteDaemonReachable();
      reportLinkOk();
      void this.reconcileReceipts(path);
      void this.flushQueue();
      void this.seedQueuedMessages(generation, path);
      void this.recoverWithdrawnQueue(path);
      const opening = this.openingHistory;
      if (
        !opening ||
        opening.generation !== generation ||
        opening.path !== path ||
        opening.pageApplied
      )
        void this.catchUp("ws-open");
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(generation, path) || this.socket !== socket) return;
      this.lastFrameAt = Date.now();
      reportLinkOk();
      this.receiveSocketData(event.data, generation, path, socket);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      reportChatSocket("down");
      void probeLink();
      const opening = this.openingHistory;
      if (
        opening?.generation === generation &&
        opening.path === path &&
        !opening.pageApplied
      )
        this.startInitialHistoryFallback(opening);
      if (this.platformOffline()) {
        this.store.getState().setConnection("offline");
      } else {
        this.store.getState().setConnection("reconnecting");
      }
    };
    const handleClose = () => {
      if (!this.isCurrent(generation, path) || this.socket !== socket) return;
      this.socket = null;
      reportChatSocket("down");
      void probeLink();
      const opening = this.openingHistory;
      if (
        opening?.generation === generation &&
        opening.path === path &&
        !opening.pageApplied
      )
        this.startInitialHistoryFallback(opening);
      // Keep question/value through reconnect. Loss after dispatch is
      // uncertain, never permission to replay an answer automatically.
      const answer = this.store.getState().collabAnswer;
      const interrupted = interruptCollabAnswer(answer);
      if (interrupted && interrupted !== answer) this.rememberCollabAnswer(interrupted);
      // Child dialogs: the daemon replays every one still open on attach.
      this.store.getState().setExtensionDialogs(clearExtensionDialogs);
      // Keep retrying under an offline hint: the `online` event never fires
      // when the hint is wrong, so waiting for it waited forever.
      this.store
        .getState()
        .setConnection(this.platformOffline() ? "offline" : "reconnecting");
      this.scheduleReconnect(generation, path);
    };
    socket.onclose = handleClose;
    // Closing a CONNECTING socket by hand: its close event can be slow to
    // arrive on a dead link, so run the close path directly.
    window.setTimeout(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {}
      handleClose();
    }, HANDSHAKE_TIMEOUT_MS);
  }

  /** Hand one socket message to `handleFrame` in arrival order; see `inbound`. */
  private receiveSocketData(data: unknown, generation: number, path: string, socket: WebSocket): void {
    if (typeof data === "string" && this.inbound === null) {
      const frame = parseTextFrame(data);
      if (frame) this.handleFrame(frame, generation, path);
      return;
    }
    // Start decoding now so decodes overlap; only handling is serialized.
    const decoded = this.decodeSocketData(data).catch(() => null);
    const link = (this.inbound ?? Promise.resolve()).then(async () => {
      const frame = await decoded;
      if (!frame || !this.isCurrent(generation, path) || this.socket !== socket) return;
      try {
        this.handleFrame(frame, generation, path);
      } catch (error) {
        // Still an uncaught error, but one bad frame must not stall the queue.
        queueMicrotask(() => {
          throw error;
        });
      }
    });
    this.inbound = link;
    void link.then(() => {
      if (this.inbound === link) this.inbound = null;
    });
  }

  private async decodeSocketData(data: unknown): Promise<OmpFrame | null> {
    if (typeof data === "string") return parseTextFrame(data);
    if (data instanceof ArrayBuffer) return decodeBinaryFrame(data);
    if (data instanceof Blob) return decodeBinaryFrame(await data.arrayBuffer());
    return null;
  }

  private handleFrame(frame: OmpFrame, generation: number, path: string): void {
    if (frame.sessionState !== undefined) {
      const incoming = parseSessionAuthority(frame.sessionState);
      if (!incoming) return;
      this.reconcileSessionState(path, frame);
      const current = this.store.getState().sessionAuthorities[path];
      if (!current || current.daemonInstanceId !== incoming.daemonInstanceId || current.bindingEpoch !== incoming.bindingEpoch) return;
      // A stale snapshot can carry valid-looking owner events (including starts
      // and tool updates), so fence every side effect, not just terminal commits.
      if (incoming.revision < current.revision) return;
    }
    switch (frame.type) {
      case "bundle": {
        const opening = this.openingHistory;
        const firstBundle =
          opening !== null &&
          opening.generation === generation &&
          opening.path === path &&
          !opening.bundleSeen;
        if (firstBundle && this.store.getState().authRejected) {
          opening.bundleSeen = true;
          this.finishOpeningHistoryPage(opening);
          this.cancelReconnect();
          this.closeSocket();
          this.openingHistory = null;
          return;
        }
        this.adoptHistoryConfiguration(frame.history);

        if (firstBundle) {
          opening.bundleSeen = true;
          if (opening.pageApplied) {
            // HTTP won the initial-page race; merge only unseen ids so the
            // late bundle cannot reset the reader's cursor or transcript.
            this.mergeHistory(frame.history.entries ?? [], true, frame.history.sessionModel !== undefined);
            this.adoptBundleCursors(frame);
            this.noteSeedPage(normalizeOffset(frame.history.nextBefore));
            this.store.getState().setOpening(false);
            this.recordSuccess();
            void saveTail(
              path,
              this.store.getState().messages,
              this.cacheNamespace,
              this.store.getState().contextBoundary,
            );
          } else {
            if (!this.applyOpeningHistoryPage(opening, frame.history)) {
              this.finishOpeningHistoryPage(opening);
              this.openingHistory = null;
              return;
            }
            this.adoptBundleCursors(frame);
            this.noteSeedPage(normalizeOffset(frame.history.nextBefore));
          }
          this.store.getState().setStaleHistory(null);
          this.openingHistory = null;
        } else {
          this.mergeHistory(frame.history.entries ?? [], false, frame.history.sessionModel !== undefined);
          this.store.getState().setOpening(false);
          this.adoptBundleCursors(frame);
          this.noteSeedPage(normalizeOffset(frame.history.nextBefore));
          this.recordSuccess();
          void saveTail(
            path,
            this.store.getState().messages,
            this.cacheNamespace,
            this.store.getState().contextBoundary,
          );
          this.store.getState().setStaleHistory(null);
        }
        this.applyTurnState(path, { ...frame, ...frame.history, sessionState: frame.sessionState ?? frame.history.sessionState });
        if (frame.state?.collabAttached === true)
          this.store.getState().setCollabAttached(true);
        this.store.getState().clearPartialLine();
        return;
      }
      case "event":
        this.handleEventFrame(frame, generation, path);
        return;
      case "md":
        this.handleDeltaFrame(frame, generation, path);
        this.store.getState().clearPartialLine();
        return;
      case "entries":
        this.mergeHistory(frame.entries);
        this.store.getState().clearPartialLine();
        void saveTail(
          path,
          this.store.getState().messages,
          this.cacheNamespace,
          this.store.getState().contextBoundary,
        );
        return;
      case "resync":
        this.resyncRetryUsed = false;
        this.runningAgentCount.invalidate();
        this.lastCatchUpAt = 0;
        void this.catchUp("resync");
        // Events (including the matching retry/compaction end) were dropped
        // with the rest; a stale "Retrying in 3s" must not outlive them.
        this.store.getState().setAutoRetry(null);
        this.store.getState().setCompacting(null);
        return;
      case "poll":
        this.resyncRetryUsed = false;
        void this.catchUp("poll");
        return;
      case "error":
        this.store.getState().setError(frame.message ?? "Connection error");
        return;
      case "bash_result": {
        const id =
          typeof (frame as JsonObject).id === "string"
            ? ((frame as JsonObject).id as string)
            : "";
        if (id) {
          const raw = (frame as JsonObject).result;
          let output: string;
          if (typeof raw === "string") output = raw;
          else if (raw === null || raw === undefined) output = "";
          else {
            try {
              output = JSON.stringify(raw, null, 2);
            } catch {
              output = String(raw);
            }
          }
          this.store.getState().applyResults([
            {
              callId: id,
              name: "bash",
              output,
              isError: false,
              pruned: false,
            },
          ]);
        }
        return;
      }
      case "bash_output":
        if (typeof frame.id === "string" && typeof frame.text === "string") {
          for (const listener of this.bashOutputListeners) listener(frame.id, frame.text);
        }
        return;
      case "hb": {
        const raw = frame as JsonObject;
        const served =
          typeof raw.v === "string"
            ? raw.v
            : typeof raw.releaseId === "string"
              ? raw.releaseId
              : "";
        const protocol =
          typeof raw.protocolVersion === "number"
            ? raw.protocolVersion
            : undefined;
        const minimum =
          typeof raw.minClientProtocolVersion === "number"
            ? raw.minClientProtocolVersion
            : undefined;
        this.heartbeatAt = Date.now();
        this.checkHeartbeatVersion(served, protocol, minimum);
        return;
      }
      case "partial":
        this.handlePartialFrame(frame as JsonObject, generation, path);
        return;
      case "activity":
        // Only this conversation's frames reach this socket; the path check
        // guards a stale socket from a previous session painting over it.
        if (frame.path === path) this.applyActivity(path, frame.now, "at" in frame ? frame.at : undefined, frame.sessionState);
        return;
    }
  }

  private handlePartialFrame(
    frame: JsonObject,
    generation: number,
    path: string,
  ): void {
    if (!this.isCurrent(generation, path)) return;
    const offset = normalizeOffset(frame.offset);
    const text = typeof frame.text === "string" ? (frame.text as string) : "";
    if (offset === null) return;
    // Keyed by offset: replace latest; empty text still counts as provisional.
    this.store.getState().setPartialLine({ text, offset });
  }
  private flushHeldCollabResponse(): void {
    const state = this.store.getState();
    const held = state.heldCollabResponse;
    const path = state.sessionPath;
    if (!held || !path || state.collabRequest?.reqId !== held.reqId) return;
    const question = this.currentCollabQuestion;
    if (!question || question.sessionPath !== path || question.reqId !== held.reqId || question.token !== held.pulseQuestionToken) return;
    const answer = this.collabAnswers.get(collabQuestionKey(question));
    const socket = this.socket;
    if (!answer || answer.phase !== "held" || !socket || socket.readyState !== WebSocket.OPEN) return;
    this.rememberCollabAnswer({ ...answer, phase: "sending" });
    state.clearHeldCollabResponse();
    try {
      socket.send(JSON.stringify({ type: "collab-ui-response", reqId: answer.reqId, value: answer.value, pulseQuestionToken: question.token }));
    } catch {
      this.rememberCollabAnswer({ ...answer, phase: "uncertain" });
    }
  }

  private toolOutput(raw: unknown): string {
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) return raw.map((block) => this.toolOutput(block)).filter(Boolean).join("\n");
    if (isJsonObject(raw)) {
      if (raw.type === "image") return "";
      if (typeof raw.text === "string") return raw.text;
      if (raw.content !== undefined) return this.toolOutput(raw.content);
    }
    return raw == null ? "" : JSON.stringify(raw);
  }

  private reduceToolExecution(event: JsonObject): void {
    const callId = typeof event.toolCallId === "string" ? event.toolCallId
      : typeof event.tool_call_id === "string" ? event.tool_call_id : "";
    if (!callId) return;
    const store = this.store.getState();
    const streaming = store.streamingMessage;
    // Find the call WHEREVER it already lives. Checking only the streaming
    // message whenever one existed missed every call already committed to the
    // transcript, so each replayed start (every `entries` frame carries the
    // tail's tool_execution_start entries) appended a fresh "running" copy to
    // the live message: the phone showed a column of duplicate tools, all
    // "running", each clocked from the moment of the replay.
    const committed = streaming?.parts.some((part) => part.kind === "tool" && part.callId === callId)
      ? null
      : [...store.messages].reverse().find((message) =>
        message.role === "assistant" && message.parts.some((part) => part.kind === "tool" && part.callId === callId)) ?? null;
    const previous = committed ?? streaming;
    const base: UiMessage = previous ?? { id: `live-tool:${this.activeSession ?? "session"}`, role: "assistant", text: "", parts: [] };
    const existing = base.parts.find((part): part is Extract<UiPart, { kind: "tool" }> =>
      part.kind === "tool" && part.callId === callId);
    const type = event.type;
    const name = typeof event.toolName === "string" ? event.toolName
      : typeof event.name === "string" ? event.name : existing?.name ?? "tool";
    const rawOutput = type === "tool_execution_update" ? event.partialResult : event.result;
    const fullOutput = rawOutput === undefined ? existing?.output : this.toolOutput(rawOutput);
    const output = fullOutput?.slice(-4096);
    const details = isJsonObject(rawOutput) ? rawOutput.details : undefined;
    const content = isJsonObject(rawOutput) ? rawOutput.content : undefined;
    const search = type === "tool_execution_end" ? parseToolSearch(name, details) ?? existing?.search : existing?.search;
    // A replayed start entry records when omp started the tool, on the
    // laptop's clock: move it onto this device's. A live start without one
    // started now.
    const recorded = typeof event.startedAt === "string" ? Date.parse(event.startedAt)
      : typeof event.startedAt === "number" ? event.startedAt : NaN;
    const startStamp = Number.isFinite(recorded) ? recorded + this.clockShift : Date.now();
    const part: Extract<UiPart, { kind: "tool" }> = {
      kind: "tool", callId, name,
      args: event.args ?? event.arguments ?? event.input ?? existing?.args ?? null,
      intent: typeof event.intent === "string" ? event.intent : existing?.intent,
      // Only a start event means "it started now". An update or end for a
      // call the phone never saw start (the chat opened mid-tool) takes the
      // daemon's own tool clock when it is on this tool, else stays unknown
      // and the card falls back to its message time: stamping Date.now()
      // here reset every running timer to 0:00 on each reopen.
      startedAt: existing?.startedAt
        ?? (type === "tool_execution_start" ? startStamp : this.activeToolSince(name)),
      state: type === "tool_execution_end" ? (event.isError === true || search?.error ? "error" : "ok") : existing?.state ?? "running",
      // The end event IS the moment it finished; nothing later is closer.
      endedAt: existing?.endedAt ?? (type === "tool_execution_end" ? Date.now() : undefined),
      output,
      search,
      images: parseToolImages(name, content, details) ?? existing?.images,
      todo: parseTodoPhases(name, details) ?? existing?.todo,
      shell: type === "tool_execution_end"
        ? parseShellOutcome(name, details, fullOutput ?? "", event.isError === true)
        : existing?.shell,
      // Diff stats arrive with the result, so a live "Edited N files" row
      // matches what the transcript rebuilds from the file afterwards. A
      // failed single edit is never counted; a failed batch keeps its files.
      edits: existing?.edits
        ?? (type === "tool_execution_end" && isJsonObject(event.result)
          ? recordedEdits(name, event.result.details, event.isError === true)
          : undefined),
      // A `task` reports each agent's status (async: all pending at spawn;
      // sync: progress updates until they finish); `wait` reports the jobs it
      // saw finish. Both drive the running-agents count.
      ...withAgents((type === "tool_execution_end" || type === "tool_execution_update") && isJsonObject(rawOutput)
        ? parseAgentStatuses(name, rawOutput.details) ?? existing?.agents
        : existing?.agents),
    };
    const parts = existing ? base.parts.map((item) => item === existing ? part : item) : [...base.parts, part];
    const updated = { ...base, parts };
    if (committed) store.mergeMessages([updated]);
    else store.setStreamingMessage(updated);
  }

  /** When the daemon says the open session is running `tool`, the moment it started. */
  private activeToolSince(tool: string): number | undefined {
    const state = this.store.getState();
    const now = selectActivity(state, state.sessionPath ?? "");
    return now?.state === "tool" && now.tool === tool ? now.since : undefined;
  }

  /**
   * Optimistic activity from the open conversation's own event stream, so a
   * tool start shows the instant it happens. The daemon's `activity` frames
   * on this same socket (throttled to ~700ms) are authoritative and replace
   * whatever this guessed, including the thinking/writing split that token
   * deltas never carry here.
   *
   * A turn start is never invented from "now": when nothing better is known
   * it is the newest user message's own timestamp. Starting the clock at the
   * first event the phone happened to see is what made a turn opened
   * mid-flight read "12s" when it had been running for minutes.
   */
  private noteLocalActivity(path: string, event: JsonObject): void {
    const type = event.type;
    const at = Date.now();
    const previous = selectActivity(this.store.getState(), path);
    const turnStartedAt = previous?.turnStartedAt ?? this.lastUserMessageAt() ?? at;
    let next: OmpActivity | null | undefined;
    if (type === "agent_start") {
      next = { state: "thinking", since: at, turnStartedAt: at, tools: 0, title: previous?.title };
    } else if (type === "agent_end") {
      if (event.isTerminal === false || event.bridgeLost === true) return;
      next = null;
    } else if (type === "tool_execution_start") {
      const args = isJsonObject(event.args) ? event.args : {};
      const label = [event.intent, args.command, args.path, args.pattern, args.query]
        .find((value): value is string => typeof value === "string" && value.trim() !== "");
      next = {
        state: "tool",
        tool: typeof event.toolName === "string" ? event.toolName : "tool",
        label: label?.split("\n")[0].slice(0, 80),
        since: at,
        turnStartedAt,
        tools: previous?.tools ?? 0,
        title: previous?.title,
      };
    } else if (type === "tool_execution_end") {
      next = {
        state: "thinking",
        since: at,
        turnStartedAt,
        tools: (previous?.tools ?? 0) + 1,
        title: previous?.title,
      };
    }
    if (next === undefined) return;
    this.setActivity(path, next);
  }

  /** Epoch ms of the newest user message in the loaded window, if any. */
  private lastUserMessageAt(): number | null {
    const messages = this.store.getState().messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const ms = message.createdAt?.getTime();
      return ms !== undefined && Number.isFinite(ms) ? ms : null;
    }
    return null;
  }

  private handleEventFrame(
    frame: OmpEventFrame,
    generation: number,
    path: string,
  ): void {
    const event = frame.event;
    if (!this.isCurrent(generation, path) || this.store.getState().sessionPath !== path
      || this.store.getState().authRejected || this.queueNamespace !== getOfflineQueueNamespace()) return;
    const message = eventMessage(event);
    const closesDialogs = event.type === "session_binding_retired" || event.type === "session_settled"
      || event.type === "agent_end" && event.isTerminal !== false && event.bridgeLost !== true
      || event.type === "prompt_result" && event.agentInvoked !== false
        && !(typeof event.id === "string" && (event.id.startsWith("pulse-command:") || event.id.startsWith("pulse-ext:")));
    if (closesDialogs) {
      ++this.dialogLifecycleSequence;
      this.store.getState().setExtensionDialogs(state =>
        state.pending.reduce((next, dialog) => closeExtensionDialog(next, dialog.id), state));
    }
    this.noteLocalActivity(path, event as JsonObject);
    switch (event.type) {
      case "session_follow": {
        const destination = event.sessionPath;
        if (event.reason !== "approved_plan" || typeof destination !== "string" || !destination || destination === path) return;
        // Source + generation fencing prevents a late approval from stealing
        // a different conversation, including while photos are being saved.
        // Keep source-scoped drafts; opening restores the destination's own.
        void (async () => {
          await prepareForReload();
          if (!this.isCurrent(generation, path) || this.store.getState().sessionPath !== path
            || this.store.getState().authRejected || this.queueNamespace !== getOfflineQueueNamespace()) return;
          await this.openSession(destination);
        })().catch((error: unknown) => {
          showToast(`The approved plan started in a new conversation, but this draft could not be saved: ${String(error)}`, "error");
        });
        return;
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.reduceToolExecution(event);
        return;
      case "agent_start":
        this.setWorking(true);
        return;
      case "message_start":
        if (message?.role === "custom" || message?.role === "hookMessage") return;
        if (message?.role === "assistant") this.store.getState().beginResponseLifecycle();
        this.setWorking(true);
        if (message?.role === "assistant") this.setStreamingMessage(message);
        return;
      case "message_update":
        if (message?.role === "custom" || message?.role === "hookMessage") return;
        this.setWorking(true);
        if (message?.role === "assistant") this.setStreamingMessage(message);
        return;
      case "message_end":
        if (message?.role === "assistant") this.commitStreamingMessage(message);
        else if (message) {
          // A mention outcome has no live renderer; the saved row does.
          if (message.role === "fileMention") void this.catchUp("poll");
          const custom = customMessageToTranscript(message);
          if (custom) {
            this.store.getState().settleAgents(custom.settledAgents);
            // Native custom ends carry message timestamps, not persisted entry
            // identity. Read canonical appends instead of inventing duplicates.
            if (custom.messages.length) void this.catchUp("poll");
          }
        }
        return;
      case "agent_end":
        if (event.isTerminal === false || event.bridgeLost === true) return;
        this.commitStreamingMessage();
        this.setWorking(false);
        this.store.getState().setAutoRetry(null);
        this.store.getState().setCompacting(null);
        if (this.activeSession) void this.reconcileReceipts(this.activeSession);
        return;
      // omp is retrying a failed provider call. The attempt that just failed
      // is marked superseded at once (the session file says so only later),
      // so it joins the one muted retry row, which counts down the backoff.
      case "auto_retry_start": {
        if (!this.isCurrent(generation, path) || this.store.getState().sessionPath !== path) return;
        const retry = parseRetryStart(event, Date.now());
        const state = this.store.getState();
        const failed = state.messages.findLast((entry) => entry.role === "assistant");
        if (failed?.errorMessage && !failed.retry && failed.stopReason !== "aborted") {
          state.mergeMessages([{ ...failed, retry: { status: "superseded", attempt: retry.attempt ?? 1 } }]);
        }
        state.setAutoRetry(retry);
        return;
      }
      case "auto_retry_end":
        if (!this.isCurrent(generation, path) || this.store.getState().sessionPath !== path) return;
        this.store.getState().setAutoRetry(null);
        if (event.success === false) {
          // Without this the retry row just vanishes and the turn looks finished.
          const reason = typeof event.finalError === "string" && event.finalError.trim() ? event.finalError : "Automatic recovery stopped without a final reply.";
          this.addMarkers([{ key: `recovery:${path}:${Date.now()}`, label: "Automatic recovery stopped", detail: reason, at: Date.now(), tone: "warn", icon: "job" }]);
          showToast(reason, "error");
        }
        return;
      // An accepted local observation fences older passive seeds, even when
      // normalized queue equality keeps the same store snapshot.
      case "queue_update": {
        if (!this.isCurrent(generation, path) || this.store.getState().sessionPath !== path) return;
        const queued = parseQueuedMessages(event as JsonObject);
        if (queued) {
          this.queueSeedTicket = null;
          this.store.getState().setQueuedMessages(queued);
        }
        return;
      }
      // Goal mode changed: a host `goal` op or the agent's own `goal` tool.
      case "goal_updated": {
        if (!this.isCurrent(generation, path) || this.store.getState().sessionPath !== path) return;
        const state = this.store.getState();
        state.setGoal(reduceGoal(state.goal, event));
        return;
      }
      // A native agent changed state: settle its row and refresh the running
      // count now rather than at the next roster read. The daemon forwards the
      // child's frame as is, with the fields under `payload`.
      case "subagent_lifecycle": {
        if (!this.isCurrent(generation, path) || this.store.getState().sessionPath !== path) return;
        const body = isJsonObject(event.payload) ? event.payload : event;
        const id = typeof body.id === "string" ? body.id : "";
        const status = typeof body.status === "string" ? body.status : "";
        if (id && (status === "completed" || status === "failed" || status === "cancelled")) {
          this.store.getState().settleAgents([{ id, status }]);
        } else if (id && (status === "started" || status === "running")) {
          // A restarted agent is no longer settled.
          this.store.setState((state) => {
            if (!(id in state.settledAgents)) return state;
            const settledAgents = { ...state.settledAgents };
            delete settledAgents[id];
            return { settledAgents };
          });
        }
        this.runningAgentCount.invalidate();
        return;
      }
      case "collab_link_state":
        this.runningAgentCount.invalidate();
        this.store.getState().setCollabAttached(event.state === "attached");
        return;
      // The desktop host pushes live state and agent snapshots over the collab
      // link, and the daemon already relays both (src/omp/collab.rs:2267-2284).
      // These payloads used to be dropped on the floor, which is why a
      // collab-attached session still showed no live agents and no context.
      case "collab_state": {
        this.store.getState().setCollabAttached(true);
        const state = (event as JsonObject).state;
        if (isJsonObject(state)) this.store.getState().setCollabState(state);
        return;
      }
      case "collab_agents": {
        this.runningAgentCount.invalidate();
        this.store.getState().setCollabAttached(true);
        const agents = (event as JsonObject).agents;
        if (Array.isArray(agents))
          this.store.getState().setCollabAgents(agents);
        return;
      }
      case "collab_bus":
        this.store.getState().setCollabAttached(true);
        return;
      // Feedback is presentation only; blocking dialogs keep their separate state.
      case "extension_error":
      case "command_output":
        ++this.feedbackIngressSequence;
        this.store.getState().setExtensionFeedback((state) => reduceExtensionFeedback(state, event, this.queueNamespace, path));
        return;
      case "session_binding_retired":
        ++this.feedbackIngressSequence;
        ++this.feedbackResetSequence;
        this.store.getState().setExtensionFeedback((state) => reduceExtensionFeedback(state, { type: "extension_ui_snapshot", requests: [] }, this.queueNamespace, path));
        return;
      case "extension_ui_snapshot":
        ++this.feedbackIngressSequence;
        ++this.feedbackResetSequence;
        this.store.getState().setExtensionFeedback((state) => reduceExtensionFeedback(state, event, this.queueNamespace, path));
        return;
      case "extension_ui_response_ack": {
        const id = event.id;
        const phase = event.phase;
        if (typeof id === "string" && (phase === "handoff" || phase === "uncertain"))
          this.store.getState().setExtensionDialogs((state) => markExtensionDialogDelivery(state, id, phase));
        return;
      }
      case "extension_ui_request":
        ++this.feedbackIngressSequence;
        this.store.getState().setExtensionFeedback((state) => reduceExtensionFeedback(state, event, this.queueNamespace, path));
        this.store.getState().setExtensionDialogs((state) => reduceExtensionUiRequest(state, event, Date.now()));
        return;
      case "collab_ui_snapshot":
      case "collab_ui_request":
      case "collab_ui_request_end": {
        const frame = readCollabQuestionFrame(this.collabQuestionCursor, event, path);
        if (!frame) return;
        this.collabQuestionCursor = frame.cursor;
        for (const [key, answer] of this.collabAnswers) {
          if (collabQuestionSettled(answer.question, frame)) this.collabAnswers.delete(key);
        }
        const state = this.store.getState();
        const current = this.currentCollabQuestion;
        if (current && collabQuestionSettled(current, frame)) {
          this.currentCollabQuestion = null;
          state.clearCollabRequest();
          state.setCollabAnswer(null);
          state.clearHeldCollabResponse();
        }
        // A pending snapshot proves question identity, not transport attachment.
        if (frame.kind !== "snapshot") state.setCollabAttached(true);
        for (const raw of frame.requests) {
          const req = this.parseCollabRequest(raw);
          const question = req && collabQuestionIdentity(frame, req.reqId);
          if (!req || !question) continue;
          const key = collabQuestionKey(question);
          if (!this.currentCollabQuestion || collabQuestionKey(this.currentCollabQuestion) !== key)
            this.store.getState().clearHeldCollabResponse();
          this.currentCollabQuestion = question;
          this.store.getState().setCollabRequest(req);
          const answer = this.collabAnswers.get(key) ?? null;
          this.store.getState().setCollabAnswer(answer);
          // Only replay of this exact question may release a never-sent answer.
          if (answer?.phase === "held") {
            this.store.getState().setHeldCollabResponse({ reqId: answer.reqId, value: answer.value, pulseQuestionToken: question.token });
            this.flushHeldCollabResponse();
          }
        }
        return;
      }
      case "ui_response_ack": {
        const raw = event as JsonObject;
        if (typeof raw.reqId !== "number" || typeof raw.pulseQuestionToken !== "string") return;
        const key = collabQuestionKey({ sessionPath: path, reqId: raw.reqId, token: raw.pulseQuestionToken });
        const answer = this.collabAnswers.get(key) ?? null;
        const next = acknowledgeCollabAnswer(answer, path, raw);
        if (next && next !== answer) {
          this.collabAnswers.set(key, next);
          if (this.currentCollabQuestion && collabQuestionKey(this.currentCollabQuestion) === key) {
            this.store.getState().setCollabAnswer(next);
            this.store.getState().clearHeldCollabResponse();
          }
        }
        return;
      }
      // State frames (runtime/omp-state-events.ts): header model, thinking
      // level, title, compaction status, omp notices, command catalogue.
      // Native model_changed has no payload; both owner paths refresh their
      // authoritative configured selector independently from effective effort.
      case "model_changed":
      case "config_update":
      case "thinking_level_changed":
      case "retry_fallback_applied":
      case "session_info_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "notice":
      case "available_commands_update": {
        if (!this.isCurrent(generation, path) || this.store.getState().sessionPath !== path) return;
        const follow = reduceStateEvent(this.store.getState(), path, event as JsonObject);
        this.addFallbackMarker(this.store.getState().sessionModel?.modelFallback);
        if (follow?.notice) showToast(follow.notice.message, follow.notice.tone);
        if (follow?.refreshModel) void this.seedQueuedMessages(generation, path);
        return;
      }
      // Side questions run beside the turn and never touch the transcript.
      case "btw_delta":
      case "btw_record":
        if (!this.isCurrent(generation, path)) return;
        this.btwStore.setState(reduceBtwFrame(this.btwStore.getState(), path, event as JsonObject));
        return;
      default:
        if (generation !== this.generation || path !== this.activeSession)
          return;
    }
  }

  private parseCollabRequest(raw: unknown): CollabRequest | null {
    if (!isJsonObject(raw as object)) return null;
    const obj = raw as JsonObject;
    if (typeof obj.pulseQuestionToken !== "string" || !obj.pulseQuestionToken) return null;
    const pulseQuestionToken = obj.pulseQuestionToken;
    let reqId: number | null = null;
    const rawId = obj.reqId;
    if (typeof rawId === "number" && Number.isFinite(rawId)) reqId = rawId;
    else if (typeof rawId === "string" && rawId.trim() !== "") {
      const n = Number(rawId);
      if (Number.isFinite(n)) reqId = n;
    }
    if (reqId === null) return null;
    const rawKind =
      typeof obj.kind === "string" ? (obj.kind as string).toLowerCase() : "";
    const titleRaw =
      typeof obj.title === "string"
        ? (obj.title as string)
        : typeof obj.prompt === "string"
          ? (obj.prompt as string)
          : typeof obj.message === "string"
            ? (obj.message as string)
            : "";
    const prompt = titleRaw.trim() ? titleRaw : "Agent is asking";
    let placeholder: string | undefined;
    if (
      typeof obj.placeholder === "string" &&
      (obj.placeholder as string).trim() !== ""
    )
      placeholder = obj.placeholder as string;
    const initialValue = typeof obj.prefill === "string" ? obj.prefill : undefined;
    const rawOptions = obj.options;
    let options: CollabRequest["options"] | undefined;
    if (Array.isArray(rawOptions) && rawOptions.length > 0) {
      const normalized: {
        value: string;
        label: string;
        description?: string;
      }[] = [];
      for (const opt of rawOptions) {
        if (typeof opt === "string") {
          const label = opt;
          if (label) normalized.push({ value: label, label });
        } else if (isJsonObject(opt as object)) {
          const rec = opt as JsonObject;
          const label =
            typeof rec.label === "string"
              ? (rec.label as string)
              : typeof rec.text === "string"
                ? (rec.text as string)
                : typeof rec.value === "string"
                  ? (rec.value as string)
                  : "";
          if (!label) continue;
          const value =
            typeof rec.value === "string" ? (rec.value as string) : label;
          const description =
            typeof rec.description === "string"
              ? (rec.description as string)
              : undefined;
          normalized.push(
            description ? { value, label, description } : { value, label },
          );
        }
      }
      if (normalized.length > 0) options = normalized;
    }
    let kind: CollabRequest["kind"];
    if (rawKind === "editor") {
      kind = "editor";
    } else if (rawKind === "input" || rawKind === "text") {
      kind = "text";
    } else if (rawKind === "confirm") {
      kind = "confirm";
      if (!options)
        options = [
          { value: "Yes", label: "Yes" },
          { value: "No", label: "No" },
        ];
    } else {
      if (options && options.length === 2) {
        const labels = options.map((o) => o.label.toLowerCase());
        if (
          (labels[0] === "yes" && labels[1] === "no") ||
          (labels[0] === "no" && labels[1] === "yes")
        ) {
          kind = "confirm";
        } else {
          kind = "choice";
        }
      } else {
        kind = "choice";
      }
    }
    if (kind === "text" || kind === "editor") {
      return { reqId, kind, prompt, placeholder, initialValue, pulseQuestionToken };
    }
    return {
      reqId, kind, prompt, options, placeholder, pulseQuestionToken,
      ...(rawKind === "select" && Array.isArray(rawOptions) && options?.length === rawOptions.length
        ? collabSelectionMetadata(obj, options.length) : {}),
    };
  }

  private handleDeltaFrame(
    frame: Extract<OmpFrame, { type: "md" }>,
    generation: number,
    path: string,
  ): void {
    if (
      this.responseChain !== frame.id ||
      !this.store.getState().streamingMessage
    ) {
      this.cancelStreamFlush();
      void this.reloadHistory();
      return;
    }
    this.pendingDeltas.push({
      keep: typeof frame.k === "number" ? frame.k : null,
      text: frame.a,
      generated: typeof frame.g === "number" ? frame.g : undefined,
    });
    this.scheduleStreamFlush(generation, path);
  }

  private setStreamingMessage(message: OmpMessage): void {
    // Stream events carry no entry id. Without a per-response id every live
    // message was `entry:0`, so a second commit in one turn overwrote the
    // first and the persisted copies then appeared beside the survivor.
    const liveId =
      message.id ?? (typeof message.responseId === "string" ? `live:${message.responseId}` : undefined);
    const uiMessage = entryToUiMessage({ type: "message", id: liveId, message }, 0);
    if (!uiMessage || uiMessage.role !== "assistant") return;
    this.streamRawText = getRawAssistantText(uiMessage);
    const boundaries = getAssistantDisplayBoundaries(uiMessage);
    this.streamDisplay = streamDisplaySnapshot(this.streamRawText ?? uiMessage.text, uiMessage.text, boundaries);
    if (!liveId && uiMessage.responseKey) uiMessage.id = `live:${uiMessage.responseKey}`;
    this.responseChain = message.responseId ?? message.id ?? "live";
    this.streamText = uiMessage.text;
    this.pendingDeltas = [];
    this.store.getState().setStreamingMessage(withRawAssistantText(
      withResponseItem(mergeToolParts(uiMessage, this.store.getState().streamingMessage), message, false), this.streamRawText, boundaries,
    ));
  }

  private commitStreamingMessage(message?: OmpMessage, isCurrent = () => true): void {
    if (!isCurrent()) return;
    if (message?.role === "assistant") this.setStreamingMessage(message);
    // A terminal event or authoritative idle state can beat the next frame.
    // Without a final snapshot, queued deltas are the latest received output.
    else this.flushPendingStreamDeltas();
    // Listing-driven idle commits can synchronously notify a subscriber that
    // replaces/resumes the controller. Do not finalize the successor's stream.
    if (!isCurrent()) return;
    this.cancelStreamFlush();
    this.store.getState().commitStreamingMessage();
    // The committed reply lands after the held rows; with a span below the
    // window not held it would sit beyond a hole.
    if (this.store.getState().evictedBottom > 0) this.store.getState().dropStrayBottom();
    if (!isCurrent()) return;
    this.store.getState().clearPartialLine();
    if (!isCurrent()) return;
    this.responseChain = null;
    this.streamText = "";
    this.streamRawText = null;
    this.streamDisplay = null;
    this.pendingDeltas = [];
  }

  private scheduleStreamFlush(generation: number, path: string): void {
    if (this.flushHandle !== null) return;
    const flush = () => {
      this.flushHandle = null;
      this.flushKind = null;
      if (!this.isCurrent(generation, path)) return;
      this.flushPendingStreamDeltas();
    };
    if (
      typeof requestAnimationFrame === "function" &&
      document.visibilityState === "visible"
    ) {
      this.flushKind = "raf";
      this.flushHandle = requestAnimationFrame(flush);
    } else {
      this.flushKind = "timer";
      this.flushHandle = window.setTimeout(
        flush,
        document.visibilityState === "visible" ? FRAME_FALLBACK_FLUSH_MS : HIDDEN_FLUSH_MS,
      );
    }
  }

  /** Resume paints the live reply now instead of waiting out the hidden cadence. */
  private flushHiddenStreamNow(): void {
    if (this.flushHandle === null || this.flushKind !== "timer") return;
    window.clearTimeout(this.flushHandle);
    this.flushHandle = null;
    this.flushKind = null;
    this.flushPendingStreamDeltas();
  }

  private flushPendingStreamDeltas(): void {
    const deltas = this.pendingDeltas;
    this.pendingDeltas = [];
    if (deltas.length === 0) return;
    // INVARIANT: Rejoining the whole prefix for every delta caused quadratic
    // work (an 80KB turn over ~500 flushes copied ~20MB). Batch ordinary
    // appends without re-normalizing the response. Raw-coordinate replacements
    // may reconstruct display boundaries, including cuts into buffered text.
    const initialDisplay = this.streamDisplay;
    const current = this.store.getState().streamingMessage;
    if (!initialDisplay || !current) return;
    let display = initialDisplay;
    // External prose replacement cannot reuse the controller's old proof.
    // The transport accumulator still owns its exact raw coordinate base.
    const hasSource = this.streamRawText !== null && getRawAssistantText(current) === this.streamRawText;
    let buffer: string[] = [];
    const flushBuffer = () => {
      if (buffer.length === 0) return;
      const add = buffer.length === 1 ? buffer[0] : buffer.join("");
      display = appendStreamDisplay(display, add);
      buffer = [];
    };
    let generated: number | undefined;
    for (const delta of deltas) {
      if (delta.generated !== undefined) generated = delta.generated;
      if (delta.keep === null) {
        if (delta.text) buffer.push(delta.text);
      } else {
        flushBuffer();
        display = replaceStreamDisplay(display, delta.keep, delta.text);
        // Fold buffered text before a raw cut, so a later cut in this same
        // flush sees exactly the prefix produced by earlier frames.
      }
    }
    flushBuffer();
    // Publish coherent raw/boundary/display state once per flush, including terminal drain.
    this.streamDisplay = display;
    this.streamText = display.text;
    this.streamRawText = hasSource ? display.raw : null;
    this.store.getState().setStreamingMessage(withRawAssistantText({
        ...current,
        text: this.streamText,
        parts: mergeStreamText(current.parts, this.streamText),
        // Thinking and tool-call args never reach the phone as delta text,
        // so this count is the only sign they are growing (live tokens/s).
        generated: generated ?? current.generated,
      }, this.streamRawText, display.anchors));
  }

  private cancelStreamFlush(): void {
    if (this.flushHandle !== null) {
      if (this.flushKind === "raf") cancelAnimationFrame(this.flushHandle);
      else window.clearTimeout(this.flushHandle);
    }
    this.flushHandle = null;
    this.flushKind = null;
    this.pendingDeltas = [];
  }

  private adoptContextBoundary(entries: readonly OmpEntry[]): void {
    const state = this.store.getState();
    const boundary = newestCompactionBoundary(entries, state.contextBoundary?.at ?? -Infinity);
    if (boundary) state.setContextBoundary(boundary);
  }

  private addMarkers(markers: readonly SessionMarker[]): void {
    if (addTimelineMarkers(markers)) {
      this.store.setState((state) => ({ timelineRevision: state.timelineRevision + 1 }));
    }
  }

  private mergeHistory(
    raw: readonly OmpEntry[],
    onlyUnseenMessages = false,
    hasBranchConfiguration = false,
  ): void {
    // The branch is the chain back from the newest entry (branch-view.ts).
    // When the new entries leave the transcript's leaf behind, a tree move
    // (TUI `/tree`, phone "Go here") abandoned what is on screen, and
    // merging would only append to it.
    const branch = filterAbandoned(raw, null, this.branchView.leaf);
    const onScreen = new Set(this.store.getState().messages.map((m) => m.id));
    if (branchMoved(branch, this.branchView.leaf, onScreen)) {
      void this.reloadBranch();
      return;
    }
    this.noteBranch(branch);
    // A re-sent tail can still carry turns an earlier move abandoned.
    const dropped = this.branchView.dropped;
    const entries = branch.kept.filter((entry) => typeof entry.id !== "string" || !dropped.has(entry.id));
    this.adoptSessionModelEntries(entries, false, hasBranchConfiguration);
    this.adoptPlanEntries(entries);
    this.adoptContextBoundary(entries);
    const markers = collectMarkers(entries);
    this.addMarkers(markers);
    const transcript = entriesToTranscript(entries);
    this.store.getState().preflightResponseItems(transcript.messages);
    if (raw.length > 0) this.store.getState().clearPartialLine();
    let messages = transcript.messages;
    if (onlyUnseenMessages && messages.length > 0) {
      const known = new Set(this.store.getState().messages.map((m) => m.id));
      messages = messages.filter((message) => !known.has(message.id));
    }
    if (messages.length > 0) this.store.getState().mergeMessages(messages);
    if (transcript.orphanResults.length > 0) {
      this.store.getState().applyResults(transcript.orphanResults);
    }
    if (transcript.settledAgents.length > 0) this.store.getState().settleAgents(transcript.settledAgents);
    this.handleToolExecutionStarts(entries);
    this.enforceWindow();
  }

  /**
   * Record the initial tail window once. Bundle frames and full refetches can
   * arrive when the ledger is empty (cache-painted store, reconnect before any
   * paging): the held messages become one tail page so later top evictions
   * keep exact reload cursors.
   */
  private noteSeedPage(nextBefore: number | null): void {
    const st = this.store.getState();
    if (st.historyPages.length > 0) return;
    const msgs = st.messages;
    if (msgs.length === 0) return;
    st.resetPages([
      {
        before: null,
        nextBefore,
        firstId: msgs[0].id,
        lastId: msgs[msgs.length - 1].id,
        count: msgs.length,
      },
    ]);
  }

  private handleToolExecutionStarts(entries: readonly OmpEntry[]): void {
    const state = this.store.getState();
    if (!state.streamingMessage) return;
    // Every frame re-sends the tail, so most of these starts belong to calls
    // the transcript already holds, finished and with their results. Only a
    // call the phone has never seen, with no result waiting for it, is new.
    const known = new Set<string>(state.pendingToolResults.map((result) => result.callId));
    for (const message of [...state.messages, state.streamingMessage]) {
      for (const part of message.parts) if (part.kind === "tool") known.add(part.callId);
    }
    for (const entry of entries) {
      if ((entry.type !== "custom" && entry.type !== "custom_message") || entry.customType !== "tool_execution_start") continue;
      const source = isJsonObject(entry.data) ? entry.data : entry;
      const toolCallId = source.toolCallId ?? source.tool_call_id ?? source.id;
      if (typeof toolCallId !== "string" || known.has(toolCallId)) continue;
      known.add(toolCallId);
      this.reduceToolExecution({ ...source, toolCallId, type: "tool_execution_start" });
    }
  }

  /**
   * The bundle carries the same cursors as a tail fetch. Adopt `endOffset`
   * always (it only moves forward) but adopt `nextBefore` only when we have no
   * cursor yet, so reconnecting mid-scrollback does not reset paging.
   */
  private adoptBundleCursors(
    frame: Extract<OmpFrame, { type: "bundle" }>,
  ): void {
    const state = this.store.getState();
    const end = normalizeOffset(frame.history.endOffset);
    if (end !== null && end > state.endOffset) state.setEndOffset(end);
    if (state.historyCursor === null && state.messages.length === 0) {
      state.setHistoryCursor(normalizeOffset(frame.history.nextBefore));
    }
  }

  /**
   * The daemon heartbeats every 20s (src/server/http.rs:2115-2129). A visible tab
   * that has heard nothing for 45s is on a dead socket the OS never closed —
   * a classic phone-suspend outcome — so force a reconnect. Visible-only: it
   * used to tick (and return early) while hidden too.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.suspicionTimer ??= startVisibleInterval(() => {
      if (!this.activeSession || this.disposed) return;
      if (Date.now() - this.lastFrameAt < SUSPICIOUS_SILENCE_MS) return;
      if (this.probedSilenceAt === this.lastFrameAt) return;
      this.probedSilenceAt = this.lastFrameAt;
      void probeLink();
    }, SUSPICION_TICK_MS);
    this.watchdogTimer = startVisibleInterval(() => {
      if (!this.activeSession) return;
      if (Date.now() - this.lastFrameAt < STALE_SOCKET_MS) return;
      if (!this.socket || this.socket.readyState > WebSocket.OPEN) return;
      void probeLink();
      this.closeSocket();
      this.store.getState().setConnection("reconnecting");
      this.cancelReconnect();
      this.lastCatchUpAt = 0;
      void this.catchUpWithResult("watchdog-stale").then((recovered) => {
        if (recovered) this.reviveSocket(false, true);
      });
      this.reviveSocket(false, true);
    }, WATCHDOG_TICK_MS);
  }

  private stopWatchdog(): void {
    this.watchdogTimer?.();
    this.suspicionTimer?.();
    this.suspicionTimer = null;
    this.watchdogTimer = null;
  }

  // This probe used to keep firing while hidden and reopen a stale socket
  // from the background, so a pocketed phone redialled the daemon every 30 s
  // for frames nobody could see. Now it runs only while visible; showing the
  // page runs `onVisible`, which revalidates and reconnects at once. Visible,
  // it also catches a socket stuck CLOSING, which the watchdog skips.
  private startLivenessProbe(): void {
    if (this.livenessProbe) return;
    this.livenessProbe = startVisibleInterval(() => {
      if (!this.activeSession || this.disposed) return;
      if (Date.now() - this.lastFrameAt < STALE_SOCKET_MS) return;
      void probeLink();
      if (this.socket) {
        this.closeSocket();
        this.store.getState().setConnection("reconnecting");
      }
      this.cancelReconnect();
      this.reviveSocket();
    }, LIVENESS_PROBE_MS);
  }

  private stopLivenessProbe(): void {
    this.livenessProbe?.();
    this.livenessProbe = null;
  }

  private startOfflineTicker(): void {
    if (this.offlineTicker) return;
    let tick = 0;
    this.offlineTicker = startVisibleInterval(() => {
      tick += 1;
      void this.maintainLocalPendingSends();
      const offline = this.platformOffline() && !this.socketOpen();
      // Native reconcile is a `wake` plus a `list` bridge round trip. With
      // nothing pending in the push/fallback-refreshed native snapshot it only woke
      // the native sender every second for an empty outbox.
      if (!offline && (!usesNativeOutbox() || pendingAll(this.queueNamespace).length > 0))
        void this.reconcileReceipts();
      // A prompt whose dispatch hit a transient failure goes back to `saved`
      // and nothing retried it while the socket stayed open: it sat queued
      // until an unrelated resume or the next send. Retry on a slow cadence.
      if (tick % 5 === 0 && this.store.getState().queuedCount > 0)
        void this.flushQueue();
      if (!this.activeSession) return;
      // Continue the daemon's bounded fold even in a quiet chat; the listing
      // is not polled here. Reuse catch-up's single-flight and generation fences.
      if (this.configurationPending && !offline && tick % 5 === 0) void this.catchUp("metadata");
      const conn = this.store.getState().connection;
      if (offline && conn !== "offline") {
        this.store.getState().setConnection("offline");
        this.store.getState().setOffline(true);
      } else if (!offline && conn === "offline") {
        this.store.getState().setOffline(false);
        this.store.getState().setConnection(this.socketOpen() ? "open" : "reconnecting");
        this.reviveSocket();
      }
    }, 1000);
  }

  private stopOfflineTicker(): void {
    this.offlineTicker?.();
    this.offlineTicker = null;
  }

  /**
   * Tell the daemon whether this page is visible on every hide/show and on a
   * hidden socket's open. Hidden pages keep their live events/notifications,
   * but do not pin an idle child or keep its session file tailing. Showing a
   * hidden-only audience restarts the tail with a resync; defer a hidden resync
   * until restore so its history/feedback refresh cannot be lost.
   */
  private reportVisibility(socket: WebSocket | null = this.socket): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(
        JSON.stringify({
          type: "visibility",
          visible: document.visibilityState !== "hidden",
        }),
      );
    } catch {
      // A failed send means the socket is closing; the next open reports.
    }
  }

  private sendSocketFrame(frame: JsonObject): void {
    // A closed socket is the link indicator's to report, not a stored error.
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.store
        .getState()
        .setError(this.errorMessage(error, "Could not send command"));
    }
  }
  private scheduleReconnect(generation: number, path: string): void {
    if (this.reconnectTimer !== null || !this.isCurrent(generation, path))
      return;
    // Past the failure gate a visible chat still retries, slowly: stopping
    // outright left it in "error" until the user happened to background the
    // app, because nothing else re-armed the socket.
    const gated = this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    const attempt = Math.min(this.reconnectAttempt++, 10);
    const base = gated ? 30_000 : Math.min(30_000, 1_000 * 2 ** attempt);
    // Jitter so phones that lost the same laptop do not redial in lockstep.
    const delay = base * (0.8 + Math.random() * 0.4);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isCurrent(generation, path)) return;
      this.connectSocket(generation, path, gated);
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  private closeSocket(): void {
    const answer = this.store.getState().collabAnswer;
    const interrupted = interruptCollabAnswer(answer);
    if (interrupted && interrupted !== answer) this.rememberCollabAnswer(interrupted);
    if (!this.socket) {
      this.store.getState().setExtensionDialogs(clearExtensionDialogs);
      return;
    }
    const socket = this.socket;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
    reportChatSocket("down");
    this.store.getState().setExtensionDialogs(clearExtensionDialogs);
  }

  private isCurrent(generation: number, path: string): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      path === this.activeSession
    );
  }

  private errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }
}
