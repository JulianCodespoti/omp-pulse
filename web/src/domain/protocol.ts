export type JsonObject = Record<string, unknown>;

export type OmpTurnState = "running" | "idle" | "unknown";
export type OmpSessionConfidence = "confirmed" | "inferred";
export type OmpConnectionState = "connected" | "reconnecting" | "unavailable";
export type OmpSessionOwnerKind = "none" | "child" | "bridge" | "collab" | "foreign" | "ambiguous";
export type OmpSessionCapability = "read" | "stream" | "control" | "send" | "stop" | "answer" | "settings" | "bash" | "queue" | "interrupt";

export interface OmpSessionOwner extends JsonObject {
  kind: OmpSessionOwnerKind;
  pid?: number;
  processStart?: number;
  peerId?: string;
  roomId?: string;
}

export interface OmpAuthorityActivity extends JsonObject {
  source: string;
  kind: string;
  label?: string;
  observedAt: number;
  stale: boolean;
}

/** Canonical daemon-owned state. Revisions compare only within daemonInstanceId. */
export interface OmpSessionAuthority extends JsonObject {
  daemonInstanceId: string;
  revision: number;
  owner: OmpSessionOwner;
  bindingEpoch: number;
  turn: OmpTurnState;
  confidence: OmpSessionConfidence;
  connection: OmpConnectionState;
  observedAt: number;
  activity: OmpAuthorityActivity | null;
  pendingInput?: JsonObject | null;
  /** omp reported a background job that can still wake the session (daemon `backgroundWork`). */
  backgroundWork?: boolean;
  capabilities: Partial<Record<OmpSessionCapability, boolean>>;
}

// Enum checks must not coerce JSON objects: a toString:null member can throw
// after an earlier listing row has already updated accepted authority.
export function parseSessionAuthority(value: unknown): OmpSessionAuthority | null {
  if (!isJsonObject(value) || !isJsonObject(value.owner) || !isJsonObject(value.capabilities)) return null;
  const ownerKinds: readonly string[] = ["none", "child", "bridge", "collab", "foreign", "ambiguous"];
  const turns: readonly string[] = ["running", "idle", "unknown"];
  const confidences: readonly string[] = ["confirmed", "inferred"];
  const connections: readonly string[] = ["connected", "reconnecting", "unavailable"];
  const owner = value.owner;
  if (typeof value.daemonInstanceId !== "string" || value.daemonInstanceId.length === 0
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !Number.isSafeInteger(value.bindingEpoch) || (value.bindingEpoch as number) < 0
    || !Number.isFinite(value.observedAt)
    || typeof owner.kind !== "string" || !ownerKinds.includes(owner.kind)
    || typeof value.turn !== "string" || !turns.includes(value.turn)
    || typeof value.confidence !== "string" || !confidences.includes(value.confidence)
    || typeof value.connection !== "string" || !connections.includes(value.connection)) return null;
  for (const key of ["pid", "processStart"] as const) {
    if (owner[key] !== undefined && (typeof owner[key] !== "number" || !Number.isFinite(owner[key]))) return null;
  }
  for (const key of ["peerId", "roomId"] as const) {
    if (owner[key] !== undefined && typeof owner[key] !== "string") return null;
  }
  const activity = value.activity;
  if (activity !== null && (!isJsonObject(activity)
    || typeof activity.source !== "string"
    || typeof activity.kind !== "string"
    || !Number.isFinite(activity.observedAt)
    || typeof activity.stale !== "boolean"
    || (activity.label !== undefined && typeof activity.label !== "string"))) return null;
  const capabilityKeys: readonly OmpSessionCapability[] = ["read", "stream", "control", "send", "stop", "answer", "settings", "bash", "queue", "interrupt"];
  for (const key of capabilityKeys) {
    if (value.capabilities[key] !== undefined && typeof value.capabilities[key] !== "boolean") return null;
  }
  return value as unknown as OmpSessionAuthority;
}

export type OmpRole = "user" | "assistant" | "toolResult" | "developer" | string;

export type OmpContentPart =
  | { type: "text"; text?: string }
  | { type: "thinking"; thinking?: string; thinkingSignature?: string }
  | { type: "toolCall"; id?: string; name?: string; arguments?: unknown; intent?: string }
  | { type: "tool_use"; tool_use_id?: string; name?: string; input?: unknown }
  | { type: "image"; data?: string; mimeType?: string }
  | JsonObject;

export interface OmpMessage extends JsonObject {
  id?: string;
  responseId?: string;
  role?: OmpRole;
  content?: OmpContentPart[] | string;
  timestamp?: number | string;
  stopReason?: string | null;
  completedAt?: number | string;
}

export interface OmpEntry extends JsonObject {
  id?: string;
  type?: string;
  timestamp?: number | string;
  completedAt?: number | string;
  message?: OmpMessage;
  content?: string | OmpContentPart[];
  customType?: string;
}

export interface OmpSessionCapabilities {
  read?: boolean;
  stream?: boolean;
  control?: boolean;
}

export type SessionActivitySource = "herdr" | "daemon" | "collab" | string;

/** Current turn, not a transcript event. Null on the wire ends the activity. */
export interface OmpActivity {
  state: "thinking" | "writing" | "tool";
  tool?: string;
  label?: string;
  since: number;
  turnStartedAt: number;
  tools: number;
  title?: string;
}

/**
 * Move an activity's daemon-clock times onto this device's clock. `since`
 * and `turnStartedAt` are stamped by the daemon; the phone compared them
 * against its OWN `Date.now()`. A phone even a second behind the laptop saw
 * every new command start in its future and read "0:00" (the elapsed clamps
 * at zero), then trailed by the skew for the whole run. `sentAt` is the
 * daemon's clock when the frame was built, so `receivedAt - sentAt` is the
 * skew plus network latency (tens of ms). Without `sentAt` (an older daemon)
 * the times are used as they are.
 */
/** Validate the legacy activity projection; malformed data is not idle. */
export function parseOmpActivity(raw: unknown): OmpActivity | null {
  if (!isJsonObject(raw) || typeof raw.state !== "string"
    || !["thinking", "writing", "tool"].includes(raw.state)) return null;
  if (typeof raw.since !== "number" || !Number.isFinite(raw.since)
    || typeof raw.turnStartedAt !== "number" || !Number.isFinite(raw.turnStartedAt)
    || typeof raw.tools !== "number" || !Number.isFinite(raw.tools)) return null;
  return {
    state: raw.state as OmpActivity["state"],
    since: raw.since,
    turnStartedAt: raw.turnStartedAt,
    tools: raw.tools,
    tool: typeof raw.tool === "string" ? raw.tool : undefined,
    label: typeof raw.label === "string" ? raw.label : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
  };
}

export function onPhoneClock(now: OmpActivity, sentAt: number | undefined, receivedAt: number): OmpActivity {
  if (sentAt === undefined || !Number.isFinite(sentAt)) return now;
  const shift = receivedAt - sentAt;
  if (shift === 0) return now;
  return { ...now, since: now.since + shift, turnStartedAt: now.turnStartedAt + shift };
}

/** Resolve a list-row turn from the canonical record or explicit legacy fields. */
export function sessionTurn(session: Pick<OmpSessionSummary, "sessionState" | "running" | "status" | "streaming" | "now">): OmpTurnState {
  const authority = parseSessionAuthority(session.sessionState);
  if (authority) return authority.turn;
  if (typeof session.running === "boolean") return session.running ? "running" : "idle";
  if (session.streaming === true || session.status === "streaming") return "running";
  if (session.now !== undefined) {
    if (session.now === null) return "idle";
    return parseOmpActivity(session.now) ? "running" : "unknown";
  }
  if (session.status === "idle" || session.status === "waiting") return "idle";
  return "unknown";
}

export interface OmpSessionSummary extends JsonObject {
  path: string;
  sessionState?: OmpSessionAuthority;
  now?: OmpActivity | null;
  bridge?: boolean;
  id?: string;
  title?: string;
  cwd?: string;
  model?: string;
  /** File modification time; bumped by bookkeeping, so never rank by it. */
  mtime?: number;
  /** Epoch ms of the newest real message: what the list ranks and labels by. */
  activeAt?: number;
  /** Retained for compatibility with older daemons; unread never uses size. */
  size?: number;
  status?: string;
  live?: boolean;
  ownerPid?: number | null;
  /** Writable collab attachment held by the daemon (writes route via host). Absent on old payloads. */
  shared?: boolean;
  streaming?: boolean;
  /** Stable content revision of the newest visible entry: a u64 sent as a
   * decimal string, because a JSON number above 2^53 arrives rounded. */
  revision?: string;
  latestEntryId?: string | null;
  activitySource?: SessionActivitySource;
  activityObservedAt?: number;
  activityStale?: boolean;
  lastTurnOutcome?: "completed" | "failed" | string;
  capabilities?: OmpSessionCapabilities;
  /** Last entry preview the daemon attaches to every listing row (src/sessions/index.rs). */
  snippet?: { role?: string; text?: string } | null;
  messageCount?: number;
  /** Exact context percent; only daemon-hosted live children report it. */
  ctxPercent?: number;
  /** Whole-file spend in USD (src/sessions/jsonl/usage.rs); absent until the daemon has folded the file. */
  costTotal?: number;
  /** Prompt tokens of the newest completed assistant turn. */
  ctxTokens?: number;
  /** Entry id of the newest assistant turn `costTotal` includes. */
  usageThrough?: string;
  running?: boolean;
  /** The question the laptop is on now; `index`/`total` span a multi-question ask. */
  pendingAsk?: {
    id?: string;
    index?: number;
    total?: number;
    question?: string;
    options?: string[];
    recommended?: number | null;
  } | null;
  /** A turn a kill or a dead agent cut off (src/authority/interrupted.rs); absent otherwise. */
  interrupted?: OmpInterruption | null;
}

/** A cut-off turn as the daemon projects it (src/authority/interrupted.rs `Interruption`). */
export interface OmpInterruption {
  startedAt: number;
  detectedAt: number;
  /** `restart`: the daemon (app) stopped mid-turn; `exited`: the agent process did. */
  cause: "restart" | "exited";
}

export function parseInterruption(raw: unknown): OmpInterruption | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const startedAt = value.startedAt;
  const detectedAt = value.detectedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (typeof detectedAt !== "number" || !Number.isFinite(detectedAt)) return null;
  return { startedAt, detectedAt, cause: value.cause === "exited" ? "exited" : "restart" };
}

export interface OmpSessionListingPage extends JsonObject {
  sessions: OmpSessionSummary[];
  nextCursor: string | null;
  projects?: OmpProjectSummary[];
}

export interface OmpProjectSummary {
  cwd: string;
  label: string;
  activeSessions: number;
}

export interface OmpHistoryPage extends JsonObject {
  entries: OmpEntry[];
  endOffset?: number;
  fileSize?: number;
  nextBefore?: number | string | null;
  /** `/api/history` only: the daemon's word on the turn (src/server/http.rs `turn_state`). */
  running?: boolean;
  now?: OmpActivity | null;
  /** Daemon clock `now` is on. */
  at?: number;
  sessionState?: OmpSessionAuthority;
  /** Requested by catch-up, using the same nonblocking replay as socket attach. */
  extensionFeedback?: JsonObject;
  /** Active-branch configuration from the completed, bounded session usage fold. */
  sessionModel?: JsonObject;
  sessionModelPending?: boolean;
}

export interface OmpBundleFrame extends JsonObject {
  type: "bundle";
  history: OmpHistoryPage;
  state?: JsonObject | null;
  etag?: string | null;
  /** The daemon's view of the running turn (src/authority/activity.rs); null when idle. Absent on old daemons. */
  now?: OmpActivity | null;
  sessionState?: OmpSessionAuthority;
}

export interface OmpEventFrame extends JsonObject {
  type: "event";
  event: JsonObject;
}

export interface OmpDeltaFrame extends JsonObject {
  type: "md";
  id: string;
  a: string;
  k?: number;
  /** Bytes generated so far across text, thinking and tool-call args (src/server/delta.rs `generated_len`). */
  g?: number;
}

export interface OmpEntriesFrame extends JsonObject {
  type: "entries";
  entries: OmpEntry[];
}

export interface OmpPartialFrame extends JsonObject {
  type: "partial";
  offset: number;
  text: string;
}

export interface OmpResyncFrame extends JsonObject {
  type: "resync";
  reason?: string;
}

export interface OmpErrorFrame extends JsonObject {
  type: "error";
  message?: string;
}

export interface OmpBashResultFrame extends JsonObject {
  type: "bash_result";
  id?: string;
  command?: string;
  result?: JsonObject;
}

/** New output from a running Terminal-sheet command, keyed by its `runId`. */
export interface OmpBashOutputFrame extends JsonObject {
  type: "bash_output";
  id: string;
  text: string;
}

export interface OmpPollFrame extends JsonObject {
  type: "poll";
}

export interface OmpHeartbeatFrame extends JsonObject {
  type: "hb";
  v?: string;
}

/** Turn activity change (src/authority/activity.rs), on both the listing and the conversation socket. */
export interface OmpActivityFrame extends JsonObject {
  type: "activity";
  path: string;
  now: OmpActivity | null;
  sessionState?: OmpSessionAuthority;
}

export type OmpFrame =
  | OmpBundleFrame
  | OmpEventFrame
  | OmpDeltaFrame
  | OmpEntriesFrame
  | OmpPartialFrame
  | OmpResyncFrame
  | OmpErrorFrame
  | OmpBashResultFrame
  | OmpBashOutputFrame
  | OmpPollFrame
  | OmpHeartbeatFrame
  | OmpActivityFrame;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOmpFrame(value: unknown): value is OmpFrame {
  return isJsonObject(value) && typeof value.type === "string";
}

export function parseTextFrame(text: string): OmpFrame | null {
  try {
    const value: unknown = JSON.parse(text);
    return isOmpFrame(value) ? value : null;
  } catch {
    return null;
  }
}

export async function decodeBinaryFrame(data: ArrayBuffer): Promise<OmpFrame | null> {
  if (!("DecompressionStream" in globalThis)) return null;
  try {
    const stream = new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return parseTextFrame(await new Response(stream).text());
  } catch {
    return null;
  }
}

export function eventMessage(event: JsonObject): OmpMessage | null {
  const direct = event.message;
  if (isJsonObject(direct)) return direct as OmpMessage;
  const nested = event.assistantMessageEvent;
  if (isJsonObject(nested) && isJsonObject(nested.message)) {
    return nested.message as OmpMessage;
  }
  return null;
}
