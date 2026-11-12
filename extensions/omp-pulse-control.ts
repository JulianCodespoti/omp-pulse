// omp-pulse managed extension
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { OwnerQueueAccess, type QueueOwner } from "./pulse-queue.ts";

/**
 * Desktop bridge for omp-pulse: settings, live events and prompt delivery.
 *
 * This file runs INSIDE the user's own omp process, which is the only process
 * allowed to write its session file. So instead of the daemon reconstructing
 * what the desktop is doing from the file tail, a collab relay and a pty
 * scrape, the owner itself streams its agent events (`GET /events`, NDJSON,
 * the same `AgentSessionEvent` shapes `omp --mode rpc` prints) and accepts
 * prompts/steers/aborts (`POST /control`), which it executes through omp's own
 * API. The phone therefore never becomes a second writer.
 *
 * The launcher replaces the embedded state-directory expression with a JSON
 * string literal containing Config.state_dir before passing the file to omp.
 */
const EMBEDDED_STATE_DIR = __OMP_PULSE_STATE_DIR_JSON__;

const CONTROL_PATH = "/control";
const EVENTS_PATH = "/events";
const DESCRIPTOR_VERSION = 1;
const MAX_BODY_BYTES = 64 * 1024;
/** A prompt carries up to 8 images of <=5 MiB base64 each (daemon limits). */
const MAX_PROMPT_BODY_BYTES = 48 * 1024 * 1024;
/** Queue recovery shares the native RPC reassembled-frame ceiling. */
const MAX_QUEUE_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_IMAGES = 8;
const MAX_STRING_BYTES = 16 * 1024;
const DESKTOP_CONTROL_DIR = "desktop-controls";
/**
 * Events queued for one slow reader before it is dropped. The daemon
 * reconnects and the phone resyncs from the session file, so dropping is
 * safe; buffering without bound inside the user's omp is not.
 */
const MAX_QUEUED_EVENTS = 4096;
/**
 * Keepalive for the event stream. Must stay well under any idle timeout on
 * the socket: Bun.serve closes a connection after 10 s of silence by default,
 * and the old 15 s ping meant every quiet stream (an idle desktop, or one
 * blocked on an `ask`) was torn down and reconnected every ~12 s. Each drop
 * made the daemon end and restart the turn on the phone and left a window in
 * which writes found no bridge and were refused as "open on the desktop".
 * The events route also disables the idle timeout (see startServer).
 */
const EVENT_PING_MS = 5_000;
/**
 * OMP extension events otherwise match RPC events. agent_end is projected
 * separately: extensions receive the owner's willContinue, RPC isTerminal.
 */
const FORWARDED_EVENTS = [
  "agent_start",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_compaction_start",
  "auto_compaction_end",
  "auto_retry_start",
  "auto_retry_end",
] as const;
/** Advertised in the descriptor so the daemon knows which paths exist. */
const LIVE_CAPABILITIES = ["control", "events", "prompt", "abort", "abort_and_restore_queue", "remove_queued_message", "rename", "close_if_idle"];

const THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type ThinkingEffort = (typeof THINKING_LEVELS)[number];
type ThinkingSelector = "off" | "auto" | ThinkingEffort;
type ApiThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

interface BunControlServer {
  port: number;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}
/** The per-request handle Bun passes to `fetch`; `timeout(req, 0)` disables idle close. */
interface BunRequestServer {
  timeout?(request: Request, seconds: number): void;
}

interface ControlRequest {
  sessionPath: string;
  method:
    | "get_state"
    | "get_prompt_config"
    | "get_model_mention_choices"
    | "set_model"
    | "set_thinking_level"
    | "set_session_name"
    | "compact"
    | "prompt"
    | "abort"
    | "abort_and_restore_queue"
    | "remove_queued_message"
    | "close_if_idle";
  params: Record<string, unknown>;
}


type QueuedImage = { type?: "image"; data: string; mimeType: string };
type QueuedMessage = { text: string; images?: QueuedImage[] };
type OwnerQueue = { steering: QueuedMessage[]; followUp: QueuedMessage[]; imagesDropped?: boolean; truncated?: boolean };
type QueueState = { steering: readonly string[]; followUp: readonly string[]; liveSteered?: number; steeringIds?: readonly string[]; followUpIds?: readonly string[] };

type OwnerSession = QueueOwner & {
  prompt?: (text: string, options: Record<string, unknown>) => Promise<boolean>;
  promptCustomMessage?: (message: Record<string, unknown>, options: Record<string, unknown>) => Promise<boolean>;
  clearQueue?: (options: { forInterrupt: true }) => OwnerQueue;
  abort?: (options: { reason: string }) => Promise<void>;
  getQueuedMessages?: () => QueueState;
  readonly steeringMode?: "all" | "one-at-a-time";
  readonly followUpMode?: "all" | "one-at-a-time";
  readonly interruptMode?: "immediate" | "wait";
  subscribe?: (listener: (event: unknown) => void) => () => void;
  configuredThinkingLevel?: () => string | undefined;
  isFastModeEnabled?: () => boolean;
  isUltrafastModeEnabled?: () => boolean;
  extensionRunner?: {
    hasHandlers: (event: string) => boolean;
    emitInput: (text: string, images: QueuedImage[] | undefined, source: "rpc") => Promise<{ handled?: boolean; text?: string; images?: QueuedImage[] }>;
  };
  setThinkingLevel?: (level: string | undefined) => void;
  settings?: { rawValue?: (setting: { segments: string[]; definition: object }) => unknown };
  getEnabledToolNames?: () => string[];
  scopedModels?: Array<{ model: { provider: string; id: string; name?: string } }>;
  modelRegistry?: { getAvailable?: () => Array<{ provider: string; id: string; name?: string }> };
  findMentionableModel?: (selector: string) => unknown;
  skillsSettings?: { enableSkillCommands?: boolean };
  skills?: Array<{ name: string }>;
};
type OwnerHost = {
  AgentRegistry?: { global?: () => { get?: (id: string) => { session?: OwnerSession } | undefined } };
  parseSkillInvocation?: (text: string) => { name: string; args: string; prompt: string } | undefined;
  buildSkillPromptMessage?: (skill: unknown, invocation: unknown, attribution: "user") => Promise<{ message: string; details: unknown }>;
  SKILL_PROMPT_MESSAGE_TYPE?: string;
};

function ownerHost(state: BridgeState): OwnerHost | undefined {
  const api = state.api as unknown as { pi?: OwnerHost };
  return api.pi;
}

function ownerSession(state: BridgeState): OwnerSession {
  let session: OwnerSession | undefined;
  try {
    session = ownerHost(state)?.AgentRegistry?.global?.()?.get?.(state.agentId ?? "Main")?.session;
  } catch {}
  if (!session || typeof session !== "object") {
    throw new BridgeError("This omp version cannot expose the desktop prompt owner; update omp and reload the desktop-control extension.", {
      status: 502, code: "unsupported_owner_api",
    });
  }
  return session;
}

function promptConfig(session: OwnerSession) {
  if (typeof session.settings?.rawValue !== "function" || typeof session.getEnabledToolNames !== "function") {
    throw new BridgeError("The desktop prompt configuration is unavailable in this omp version.", {
      status: 502, code: "prompt_config_unavailable",
    });
  }
  // OMP 18.8.6 modes/magic-keywords.ts and modes/settings.ts. rawValue
  // resolves the live session's runtime/project/global layers; these keyword
  // settings have registered true defaults, including invalid-value fallback.
  const enabled = (id: string) => {
    const value = session.settings!.rawValue!({ segments: ["magicKeywords", id], definition: {} });
    return typeof value === "boolean" ? value : true;
  };
  if (!enabled("enabled")) return { magicKeywords: [] };
  const tools = session.getEnabledToolNames();
  const definitions = [
    { id: "ultrathink", word: "ultrathink", hue: [0, 330], requires: [] },
    { id: "orchestrate", word: "orchestrate", hue: [150, 280], requires: ["task"] },
    { id: "workflow", word: "workflowz", hue: [30, 150], requires: ["task", "eval"] },
    { id: "jevify", word: "jevify", hue: [300, 420], requires: ["eval"] },
  ];
  return { magicKeywords: definitions
    .filter((keyword) => enabled(keyword.id) && keyword.requires.every((tool) => tools.includes(tool)))
    .map(({ id, word, hue }) => ({ id, word, hue })) };
}

function modelMentionChoices(session: OwnerSession) {
  if (!Array.isArray(session.scopedModels) || typeof session.modelRegistry?.getAvailable !== "function" ||
      typeof session.findMentionableModel !== "function") {
    throw new BridgeError("Model mention choices are unavailable in this omp version.", {
      status: 502, code: "model_mentions_unavailable",
    });
  }
  const models = session.scopedModels.length
    ? session.scopedModels.map(({ model }) => model) : session.modelRegistry.getAvailable();
  return models.flatMap((model) => {
    const selector = `${model.provider}/${model.id}`;
    return session.findMentionableModel!(selector)
      ? [{ selector, name: model.name || model.id, provider: model.provider }] : [];
  });
}

interface EventSubscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  timer: Timer | undefined;
  closed: boolean;
}

interface StateData {
  model: unknown;
  thinkingLevel: string | null;
  /** Pulse bridge field: native get_state exposes only the effective effort. */
  configuredThinkingLevel?: string;
  /** Pulse bridge field: native get_state has a boolean that cannot tell ultrafast from fast. */
  fastModeTier?: "off" | "fast" | "ultrafast";
  modelFallback?: Record<string, unknown> | null;
  isStreaming: boolean;
  contextMeasuredAfter: number;
  queuedMessages?: QueueState;
  steeringMode: "all" | "one-at-a-time" | null;
  followUpMode: "all" | "one-at-a-time" | null;
  interruptMode: "immediate" | "wait" | null;
  settingsReadOnly: true;
}

interface Descriptor {
  version: typeof DESCRIPTOR_VERSION;
  pid: number;
  agentId?: string;
  sessionPath: string;
  port: number;
  token: string;
  capabilities: string[];
}

interface BridgeErrorOptions {
  status?: number;
  code?: string;
  data?: StateData;
}

class BridgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly data: StateData | undefined;

  constructor(message: string, options: BridgeErrorOptions = {}) {
    super(message);
    this.name = "BridgeError";
    this.status = options.status ?? 400;
    this.code = options.code ?? "bad_request";
    this.data = options.data;
  }
}

type FeedbackFrame = Record<string, unknown> & {
  type: "extension_ui_request";
  id: string;
  method: string;
};
interface RetainedFeedback {
  frame: FeedbackFrame;
  bytes: number;
  received: number;
  notice: boolean;
}

interface BridgeState {
  api: ExtensionAPI;
  context: ExtensionContext | undefined;
  server: BunControlServer | undefined;
  starting: Promise<void> | undefined;
  descriptorPath: string | undefined;
  descriptorSessionPath: string | undefined;
  token: string;
  closed: boolean;
  applyingSettings: boolean;
  operationTail: Promise<unknown>;
  shutdownPromise: Promise<void> | undefined;
  subscribers: Set<EventSubscriber>;
  agentId: string | undefined;
  /** Logical turn state survives owner compaction/retry/continuation pauses. */
  turnRunning: boolean;
  feedback: Map<string, RetainedFeedback>;
  feedbackBytes: number;
  feedbackSessionPath: string | undefined;
  feedbackInstance: string;
  feedbackSequence: number;
  feedbackUI: ExtensionContext["ui"] | undefined;
  restoreFeedbackUI: (() => void) | undefined;
  unsubscribeQueue: (() => void) | undefined;
  queueAccess: OwnerQueueAccess;
}

function envStateDir(): string {
  const pulse = process.env.OMP_PULSE_STATE_DIR?.trim();
  if (pulse) return pulse;
  const legacy = process.env.OMP_REMOTE_STATE_DIR?.trim();
  if (legacy) return legacy;
  return EMBEDDED_STATE_DIR.trim();
}

function descriptorPathFor(stateDir: string): string {
  return join(stateDir, DESKTOP_CONTROL_DIR, `${process.pid}.json`);
}

function isUnix(): boolean {
  return process.platform !== "win32";
}

async function setMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (isUnix()) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  field: string,
  maxBytes = MAX_STRING_BYTES,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError(`${field} must be a non-empty string`, {
      code: "invalid_request",
    });
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new BridgeError(`${field} is too large`, {
      status: 413,
      code: "request_too_large",
    });
  }
  return value;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof BridgeError) {
    const body: { ok: false; error: string; code: string; data?: StateData } = {
      ok: false,
      error: error.message,
      code: error.code,
    };
    if (error.data !== undefined) body.data = error.data;
    return jsonResponse(body, error.status);
  }
  return jsonResponse(
    {
      ok: false,
      error: "desktop control operation failed",
      code: "operation_failed",
    },
    500,
  );
}

async function readBoundedBody(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) {
      throw new BridgeError("invalid content length", {
        code: "invalid_request",
      });
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_PROMPT_BODY_BYTES) {
      throw new BridgeError("request body is too large", {
        status: 413,
        code: "request_too_large",
      });
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > MAX_PROMPT_BODY_BYTES) {
        await reader.cancel();
        throw new BridgeError("request body is too large", {
          status: 413,
          code: "request_too_large",
        });
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseControlRequest(raw: string): ControlRequest {
  if (Buffer.byteLength(raw, "utf8") === 0) {
    throw new BridgeError("request body is required", {
      code: "invalid_request",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeError("request body must be valid JSON", {
      code: "invalid_json",
    });
  }
  if (!isRecord(parsed)) {
    throw new BridgeError("request body must be a JSON object", {
      code: "invalid_request",
    });
  }

  const sessionPath = boundedString(parsed.sessionPath, "sessionPath");
  const method = boundedString(parsed.method, "method");
  if (
    method !== "get_state" &&
    method !== "get_prompt_config" &&
    method !== "get_model_mention_choices" &&
    method !== "set_model" &&
    method !== "set_thinking_level" &&
    method !== "set_session_name" &&
    method !== "compact" &&
    method !== "prompt" &&
    method !== "abort" &&
    method !== "abort_and_restore_queue" &&
    method !== "remove_queued_message" &&
    method !== "close_if_idle"
  ) {
    throw new BridgeError("unsupported desktop control method; reload the desktop-control extension to update it", {
      code: "unsupported_method",
      status: 404,
    });
  }
  // The body ceiling is sized for image prompts (the bearer check runs
  // before the body is read); every other method keeps the settings limit.
  if (method !== "prompt" && Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new BridgeError("request body is too large", {
      status: 413,
      code: "request_too_large",
    });
  }
  const paramsValue = parsed.params;
  const params = paramsValue === undefined ? {} : paramsValue;
  if (!isRecord(params)) {
    throw new BridgeError("params must be a JSON object", {
      code: "invalid_request",
    });
  }
  return { sessionPath, method, params } as ControlRequest;
}

function bearerMatches(request: Request, token: string): boolean {
  const supplied = request.headers.get("authorization");
  if (supplied === null) return false;
  const expectedBytes = Buffer.from(`Bearer ${token}`, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  if (expectedBytes.byteLength !== suppliedBytes.byteLength) return false;
  return timingSafeEqual(expectedBytes, suppliedBytes);
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return (
    normalized === "headers" ||
    normalized === "apikey" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.endsWith("token")
  );
}

function sanitizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKey(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "[redacted]";
  }
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return value;
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, 128).map((item) => sanitizeValue(item, depth + 1));
  if (!isRecord(value)) return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (sensitiveKey(key)) continue;
    output[key] =
      key === "baseUrl" && typeof nested === "string"
        ? sanitizeBaseUrl(nested)
        : sanitizeValue(nested, depth + 1);
  }
  return output;
}

function sanitizeModel(model: unknown): unknown {
  if (!isRecord(model)) return null;
  return sanitizeValue(model);
}

function currentSessionPath(context: ExtensionContext): string | undefined {
  const manager = context.sessionManager as
    | { getSessionFile?: () => string | undefined }
    | undefined;
  return typeof manager?.getSessionFile === "function"
    ? manager.getSessionFile()
    : undefined;
}

function currentState(state: BridgeState): StateData {
  const contextMeasuredAfter = Date.now();
  const context = state.context;
  if (!context) {
    throw new BridgeError("desktop session is not initialized", {
      status: 503,
      code: "no_session",
    });
  }
  const level = state.api.getThinkingLevel();
  let queuedMessages: QueueState | undefined;
  let configuredThinkingLevel: string | undefined;
  let fastModeTier: StateData["fastModeTier"];
  let steeringMode: StateData["steeringMode"] = null;
  let followUpMode: StateData["followUpMode"] = null;
  let interruptMode: StateData["interruptMode"] = null;
  try {
    const session = ownerSession(state);
    queuedMessages = state.queueAccess.snapshot(session) ?? session.getQueuedMessages?.();
    if (session.configuredThinkingLevel) configuredThinkingLevel = session.configuredThinkingLevel() ?? "";
    if (typeof session.isFastModeEnabled === "function" && typeof session.isUltrafastModeEnabled === "function") {
      fastModeTier = session.isUltrafastModeEnabled() ? "ultrafast" : session.isFastModeEnabled() ? "fast" : "off";
    }
    steeringMode = session.steeringMode === "all" || session.steeringMode === "one-at-a-time" ? session.steeringMode : null;
    followUpMode = session.followUpMode === "all" || session.followUpMode === "one-at-a-time" ? session.followUpMode : null;
    interruptMode = session.interruptMode === "immediate" || session.interruptMode === "wait" ? session.interruptMode : null;
  } catch {
    // Settings and plain Stop remain available on older owner APIs.
  }
  let modelFallback: Record<string, unknown> | null | undefined;
  const branch = context.sessionManager.getBranch?.();
  if (branch) {
    modelFallback = null;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "custom" || entry.customType !== "omp-pulse-model-fallback" || !isRecord(entry.data)) continue;
      const at = Date.parse(entry.timestamp);
      modelFallback = { ...entry.data, entryId: entry.id, ...(Number.isFinite(at) ? { at } : {}) };
      break;
    }
  }
  return {
    model: sanitizeModel(context.model),
    thinkingLevel: typeof level === "string" ? level : null,
    ...(configuredThinkingLevel !== undefined ? { configuredThinkingLevel } : {}),
    ...(fastModeTier !== undefined ? { fastModeTier } : {}),
    ...(modelFallback !== undefined ? { modelFallback } : {}),
    isStreaming: state.turnRunning || !context.isIdle(),
    contextMeasuredAfter,
    steeringMode,
    followUpMode,
    interruptMode,
    settingsReadOnly: true,
    ...(queuedMessages ? { queuedMessages } : {}),
  };
}

function sameModel(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return left.provider === right.provider && left.id === right.id;
}

function modelLevels(model: unknown): Set<string> {
  if (!isRecord(model)) return new Set();
  if (model.reasoning === false) return new Set();
  const thinking = isRecord(model.thinking) ? model.thinking : undefined;
  const explicit = thinking?.efforts ?? thinking?.levels;
  if (Array.isArray(explicit)) {
    return new Set(
      explicit.filter(
        (level): level is string =>
          typeof level === "string" &&
          THINKING_LEVELS.includes(level as ThinkingEffort),
      ),
    );
  }

  const min =
    typeof thinking?.minLevel === "string" ? thinking.minLevel : undefined;
  const max =
    typeof thinking?.maxLevel === "string" ? thinking.maxLevel : undefined;
  const minIndex = min ? THINKING_LEVELS.indexOf(min as ThinkingEffort) : -1;
  const maxIndex = max ? THINKING_LEVELS.indexOf(max as ThinkingEffort) : -1;
  if (minIndex < 0 || maxIndex < minIndex) return new Set();
  return new Set(THINKING_LEVELS.slice(minIndex, maxIndex + 1));
}

function validateThinkingLevel(
  value: unknown,
  model: unknown,
): ThinkingSelector {
  const level = boundedString(value, "level", 128);
  if (level === "auto") {
    if (!isRecord(model) || model.reasoning !== true || (isRecord(model.thinking) && model.thinking.unverified === true)) {
      throw new BridgeError("automatic thinking is not supported by the selected model", { code: "unsupported_level" });
    }
    return "auto";
  }
  if (level === "off") return level;
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new BridgeError("unsupported thinking level", {
      code: "unsupported_level",
    });
  }
  if (!modelLevels(model).has(level)) {
    throw new BridgeError(
      "thinking level is not supported by the selected model",
      {
        code: "unsupported_level",
      },
    );
  }
  return level as ThinkingEffort;
}

function parseModelParams(params: Record<string, unknown>): {
  provider: string;
  modelId: string;
  thinkingLevel: unknown;
  hasThinkingLevel: boolean;
} {
  const provider = boundedString(params.provider, "provider");
  const modelId = boundedString(params.modelId, "modelId");
  const hasThinkingLevel = Object.prototype.hasOwnProperty.call(
    params,
    "thinkingLevel",
  );
  const thinkingLevel = params.thinkingLevel;
  if (hasThinkingLevel && typeof thinkingLevel !== "string") {
    throw new BridgeError("thinkingLevel must be a string", {
      code: "invalid_request",
    });
  }
  return { provider, modelId, thinkingLevel, hasThinkingLevel };
}

function findModel(state: BridgeState, provider: string, modelId: string) {
  return state.context?.modelRegistry.find(provider, modelId);
}

function assertIdle(state: BridgeState, context: ExtensionContext): void {
  if (state.turnRunning || !context.isIdle()) {
    throw new BridgeError("desktop session is busy", {
      status: 409,
      code: "session_busy",
    });
  }
}

function assertBoundSession(
  state: BridgeState,
  requestedPath: string,
): ExtensionContext {
  const context = state.context;
  if (!context) {
    throw new BridgeError("desktop session is not initialized", {
      status: 503,
      code: "no_session",
    });
  }
  const actualPath = currentSessionPath(context);
  if (actualPath === undefined) {
    throw new BridgeError("desktop session has no session file", {
      status: 503,
      code: "no_session",
    });
  }
  if (actualPath !== requestedPath) {
    throw new BridgeError(
      "session path does not match the active desktop session",
      {
        status: 409,
        code: "session_mismatch",
      },
    );
  }
  return context;
}

function actualStateOrUndefined(state: BridgeState): StateData | undefined {
  try {
    return currentState(state);
  } catch {
    return undefined;
  }
}

function parseCompactParams(params: Record<string, unknown>): string | undefined {
  const raw = params.customInstructions;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new BridgeError("customInstructions must be a string", {
      status: 400,
      code: "invalid_request",
    });
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (Buffer.byteLength(trimmed, "utf8") > MAX_STRING_BYTES) {
    throw new BridgeError("customInstructions is too large", {
      status: 400,
      code: "invalid_request",
    });
  }
  return trimmed;
}

async function compactSession(
  state: BridgeState,
  context: ExtensionContext,
  params: Record<string, unknown>,
): Promise<Response> {
  const instructions = parseCompactParams(params);
  const usageBefore = context.getContextUsage()?.tokens ?? null;
  let completed: unknown;
  try {
    if (instructions === undefined) {
      await context.compact({
        onComplete: (result) => {
          completed = result;
        },
      });
    } else {
      await context.compact(instructions);
    }
  } catch {
    throw new BridgeError("failed to compact desktop session", {
      status: 502,
      code: "compact_failed",
      data: actualStateOrUndefined(state),
    });
  }
  const tokensBefore =
    isRecord(completed) && typeof completed.tokensBefore === "number"
      ? completed.tokensBefore
      : usageBefore;
  // The phone reports "Compacted — N tokens before" when the key is present
  // and falls back to "Compaction requested" without it; never send null.
  return jsonResponse({
    ok: true,
    data: typeof tokensBefore === "number" ? { tokensBefore } : {},
  });
}

/**
 * Normalise a phone prompt into omp's content shape. Images arrive as the
 * daemon forwards them (`{data, mimeType}`; older clients sent `mime`).
 */
function parsePromptParams(params: Record<string, unknown>): {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  deliverAs: "steer" | "followUp" | undefined;
} {
  const text = typeof params.text === "string" ? params.text : "";
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_TEXT_BYTES) {
    throw new BridgeError("prompt text is too large", {
      status: 413,
      code: "request_too_large",
    });
  }
  const rawImages = Array.isArray(params.images) ? params.images : [];
  if (rawImages.length > MAX_PROMPT_IMAGES) {
    throw new BridgeError("too many images", {
      status: 413,
      code: "request_too_large",
    });
  }
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const image of rawImages) {
    if (!isRecord(image) || typeof image.data !== "string" || !image.data) {
      throw new BridgeError("image must carry base64 data", {
        code: "invalid_request",
      });
    }
    const mimeType =
      typeof image.mimeType === "string"
        ? image.mimeType
        : typeof image.mime === "string"
          ? image.mime
          : "image/png";
    images.push({ type: "image", data: image.data, mimeType });
  }
  if (!text && images.length === 0) {
    throw new BridgeError("text or images required", {
      code: "invalid_request",
    });
  }
  const deliverAs =
    params.deliverAs === "steer" || params.deliverAs === "followUp"
      ? params.deliverAs
      : undefined;
  return { text, images, deliverAs };
}

/**
 * Deliver a phone prompt through omp's own prompt flow. Idle: starts a turn,
 * exactly as if typed. Streaming: omp queues it as a steer (or the requested
 * follow-up) into the running turn — the phone never needs to wait.
 */
async function promptSession(
  state: BridgeState,
  context: ExtensionContext,
  params: Record<string, unknown>,
): Promise<Response> {
  let { text, images, deliverAs } = parsePromptParams(params);
  const streaming = state.turnRunning || !context.isIdle();
  const session = ownerSession(state);
  if (typeof session.prompt !== "function") {
    throw new BridgeError("This omp version cannot process desktop prompts normally; update omp and reload the desktop-control extension.", {
      status: 502, code: "unsupported_owner_api",
    });
  }
  try {
    const boundPath = currentSessionPath(context);
    const runner = session.extensionRunner;
    if (runner?.hasHandlers("input")) {
      const result = await runner.emitInput(text, images, "rpc");
      // A handler consumed it (a `fileMention` skip, a local command): omp ran
      // no turn, so the daemon must not wait for one.
      if (result.handled) return jsonResponse({ ok: true, data: { delivery: "local", isStreaming: state.turnRunning || !context.isIdle() } });
      // A native navigation can happen while an async handler runs. Its
      // transformed input must never leak into the newly selected session.
      assertBoundSession(state, boundPath ?? "");
      if (result.text !== undefined) text = result.text;
      if (result.images !== undefined) images = result.images.map((image) => ({ ...image, type: "image" as const }));
    }
    if (!text.trim() && !images.length) {
      return jsonResponse({ ok: true, data: { delivery: "local", isStreaming: streaming } });
    }
    const host = ownerHost(state);
    let custom: Record<string, unknown> | undefined;
    if (session.skillsSettings?.enableSkillCommands) {
      if (typeof host?.parseSkillInvocation !== "function") {
        throw new Error("This omp version cannot resolve skill invocations.");
      }
      const invocation = host.parseSkillInvocation(text);
      const skill = invocation && session.skills?.find((entry) => entry.name === invocation.name);
      if (skill) {
        if (typeof host.buildSkillPromptMessage !== "function" ||
            typeof session.promptCustomMessage !== "function" || typeof host.SKILL_PROMPT_MESSAGE_TYPE !== "string") {
          throw new Error("This omp version cannot process skill prompts.");
        }
        const built = await host.buildSkillPromptMessage(skill, invocation, "user");
        custom = {
          customType: host.SKILL_PROMPT_MESSAGE_TYPE,
          content: images.length ? [{ type: "text", text: built.message }, ...images] : built.message,
          display: true, details: built.details, attribution: "user",
        };
      }
    }
    assertBoundSession(state, boundPath ?? "");
    // AgentSession.prompt resolves after the whole turn. Its admission callback
    // is the owner's queue/start boundary, not a reason to await model output.
    // Defer one task so immediate validation/auth failures still reject delivery.
    await new Promise<void>((resolve, reject) => {
      let admitted = false;
      let timer: NodeJS.Timeout | undefined;
      const onPromptAdmitted = () => {
        timer ??= setTimeout(() => { admitted = true; resolve(); }, 0);
      };
      const options = {
        ...(!custom && images.length ? { images } : {}),
        streamingBehavior: deliverAs ?? "steer",
        onPromptAdmitted,
        throwOnDrop: true,
      };
      const turn = custom
        ? session.promptCustomMessage!(custom, { ...options, queueChipText: text })
        : session.prompt!(text, options);
      Promise.resolve(turn).then(() => {
        // Local extension/custom commands can finish without starting a turn.
        if (timer === undefined) resolve();
      }, (error) => {
        clearTimeout(timer);
        if (!admitted) reject(error);
        else broadcastEvent(state, {
          type: "notice", level: "error", source: "omp-pulse-control",
          message: `Desktop prompt failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    });
  } catch (error) {
    throw new BridgeError(
      error instanceof Error && error.message
        ? `desktop rejected the prompt: ${error.message}` : "desktop rejected the prompt",
      { status: 502, code: "prompt_rejected" },
    );
  }
  return jsonResponse({
    ok: true,
    data: { delivery: streaming ? (deliverAs ?? "steer") : "prompt", isStreaming: streaming },
  });
}

function unsupportedQueueOwner(): never {
  throw new BridgeError("This omp version cannot recover the desktop queue safely; update omp and reload the desktop-control extension.", {
    status: 502, code: "unsupported_owner_api",
  });
}

/** At most this many unacknowledged records per session; the oldest go first. */
const MAX_RECOVERY_RECORDS = 64;

async function recoveryDirectory(sessionPath: string): Promise<string> {
  const directory = join(envStateDir(), "queue-recovery", createHash("sha256").update(sessionPath).digest("hex"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (isUnix()) await chmod(directory, 0o700);
  return directory;
}

/** Same id the daemon derives, so one owner-issued item is one record whoever journals it. */
function itemRecoveryId(itemId: string): string {
  return createHash("sha256").update(`queue-item\0${itemId}`).digest("hex").slice(0, 32);
}

async function pruneRecovery(directory: string): Promise<void> {
  const records: { file: string; modified: number }[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = join(directory, name);
    records.push({ file, modified: (await stat(file)).mtimeMs });
  }
  if (records.length < MAX_RECOVERY_RECORDS) return;
  records.sort((a, b) => a.modified - b.modified || (a.file < b.file ? -1 : 1));
  for (const { file } of records.slice(0, records.length + 1 - MAX_RECOVERY_RECORDS)) await unlink(file).catch(() => undefined);
}

/**
 * The withdrawal is already committed in omp, so the journal write must come
 * before the HTTP reply: a lost connection must not lose the text. A record
 * too large for the bridge frame stays intact on disk and the reply carries
 * only its id; the daemon replays it one record at a time. A journal that
 * cannot be written falls back to the plain reply rather than dropping the
 * content the caller can still receive.
 */
async function retainWithdrawal(
  sessionPath: string,
  kind: "queue" | "message",
  data: Record<string, unknown>,
  itemId?: string,
): Promise<Response> {
  const plain = () => jsonResponse({ ok: true, data });
  const id = itemId ? itemRecoveryId(itemId) : randomBytes(16).toString("hex");
  let directory: string;
  try {
    directory = await recoveryDirectory(sessionPath);
    const final = join(directory, `${id}.json`);
    const known = itemId !== undefined && await stat(final).then(() => true, () => false);
    if (!known) {
      await pruneRecovery(directory);
      const tmp = join(directory, `${id}.tmp`);
      const file = await open(tmp, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify({ id, kind, sessionPath, ...(itemId ? { itemId } : {}), data: { ...data, recoveryId: id } }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, final);
    }
  } catch {
    return plain();
  }
  const body = JSON.stringify({ ok: true, data: { ...data, recoveryId: id } });
  return Buffer.byteLength(body, "utf8") <= MAX_QUEUE_RESPONSE_BYTES
    ? new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } })
    : jsonResponse({ ok: true, data: { recoveryId: id, recoveryPending: true } });
}

async function dispatch(
  state: BridgeState,
  request: ControlRequest,
): Promise<Response> {
  if (state.closed) {
    throw new BridgeError("desktop control bridge is shutting down", {
      status: 503,
      code: "shutting_down",
    });
  }
  const context = assertBoundSession(state, request.sessionPath);

  if (request.method === "get_state") {
    return jsonResponse({ ok: true, data: currentState(state) });
  }
  if (request.method === "get_prompt_config") {
    return jsonResponse({ ok: true, data: promptConfig(ownerSession(state)) });
  }
  if (request.method === "get_model_mention_choices") {
    return jsonResponse({ ok: true, data: { choices: modelMentionChoices(ownerSession(state)) } });
  }

  // Prompts and aborts are the reason a phone exists: they must work while
  // the agent is mid-turn, so they sit above the settings idle gate.
  if (request.method === "prompt") {
    return promptSession(state, context, request.params);
  }
  if (request.method === "abort") {
    context.abort();
    return jsonResponse({ ok: true, data: currentState(state) });
  }
  if (request.method === "abort_and_restore_queue") {
    const session = ownerSession(state);
    // Check both authoritative APIs before withdrawing anything. A boolean
    // remove or text-only queue snapshot cannot recover the user's photos.
    if (typeof session.clearQueue !== "function" || typeof session.abort !== "function") {
      unsupportedQueueOwner();
    }
    const queue = session.clearQueue({ forInterrupt: true });
    // Persist before awaiting abort or replying: losing either connection
    // must not make the withdrawal disappear with its caller.
    const response = queue.steering.length || queue.followUp.length
      ? await retainWithdrawal(request.sessionPath, "queue", { ...queue })
      : jsonResponse({ ok: true, data: queue });
    await session.abort({ reason: "Interrupted by user" });
    return response;
  }
  if (request.method === "remove_queued_message") {
    const { itemId, queue } = request.params;
    if (typeof itemId !== "string" || !itemId || (queue !== "steering" && queue !== "followUp")) {
      throw new BridgeError('itemId must identify a held message and queue must be "steering" or "followUp"');
    }
    const session = ownerSession(state);
    if (!state.queueAccess.snapshot(session)) unsupportedQueueOwner();
    const taken = state.queueAccess.take(session, queue, itemId);
    return taken
      ? retainWithdrawal(request.sessionPath, "message", {
        removed: true, text: taken.text, ...(taken.images?.length ? { images: taken.images } : {}),
      }, itemId)
      : jsonResponse({ ok: true, data: { removed: false } });
  }
  // Renaming writes a title entry through omp's own session API, the same
  // call `/rename` makes on the laptop; it is safe mid-turn, like a prompt.
  if (request.method === "set_session_name") {
    const name = typeof request.params.name === "string" ? request.params.name.trim() : "";
    if (!name || name.length > 200) {
      throw new BridgeError("session name must be 1-200 characters", {
        status: 400,
        code: "invalid_name",
      });
    }
    await state.api.setSessionName(name);
    return jsonResponse({ ok: true, data: { name: state.api.getSessionName() ?? name } });
  }

  if (request.method === "close_if_idle") {
    if (state.turnRunning || !context.isIdle() || context.hasPendingMessages()) {
      return jsonResponse({
        ok: false,
        code: "turn_running",
        error: "A reply is running or waiting for input. Nothing was closed.",
      });
    }
    // The control queue serializes this check against phone prompts. Refuse
    // future bridge calls before asking omp to exit at its next idle boundary.
    state.closed = true;
    setTimeout(() => {
      try {
        const current = assertBoundSession(state, request.sessionPath);
        if (state.turnRunning || !current.isIdle() || current.hasPendingMessages()) {
          state.closed = false;
          return;
        }
        current.shutdown();
      } catch {
        state.closed = false;
      }
    }, 0);
    return jsonResponse({ ok: true, data: { shutdownRequested: true } });
  }

  assertIdle(state, context);

  if (request.method === "compact") {
    return compactSession(state, context, request.params);
  }

  if (request.method === "set_thinking_level") {
    const model = context.model;
    const level = validateThinkingLevel(request.params.level, model);
    try {
      if (level === "auto") {
        const session = ownerSession(state);
        if (!session.setThinkingLevel || !session.configuredThinkingLevel) {
          throw new Error("automatic thinking is unavailable in this owner");
        }
        session.setThinkingLevel(level);
      } else {
        // The concrete selector was validated against the host model.
        state.api.setThinkingLevel(level as ApiThinkingLevel);
      }
    } catch {
      throw new BridgeError("failed to set thinking level", {
        status: 502,
        code: "thinking_level_failed",
        data: actualStateOrUndefined(state),
      });
    }
    const actual = currentState(state);
    const expected = level;
    if ((actual.configuredThinkingLevel ?? actual.thinkingLevel) !== expected) {
      throw new BridgeError("thinking level was not applied", {
        status: 502,
        code: "thinking_level_not_applied",
        data: actual,
      });
    }
    return jsonResponse({ ok: true, data: actual });
  }

  const { provider, modelId, thinkingLevel, hasThinkingLevel } =
    parseModelParams(request.params);
  const model = findModel(state, provider, modelId);
  if (!isRecord(model) || model.provider !== provider || model.id !== modelId) {
    throw new BridgeError("requested model is not available", {
      status: 404,
      code: "model_not_found",
    });
  }
  const level = hasThinkingLevel
    ? validateThinkingLevel(thinkingLevel, model)
    : undefined;

  try {
    const selected = await state.api.setModel(model);
    if (selected === false) {
      throw new BridgeError("requested model has no available credentials", {
        status: 502,
        code: "model_unavailable",
        data: actualStateOrUndefined(state),
      });
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("failed to set model", {
      status: 502,
      code: "model_change_failed",
      data: actualStateOrUndefined(state),
    });
  }

  let actual = currentState(state);
  if (!sameModel(context.model, model)) {
    throw new BridgeError("model change was not applied", {
      status: 502,
      code: "model_not_applied",
      data: actual,
    });
  }

  if (level !== undefined) {
    try {
      if (level === "auto") {
        const session = ownerSession(state);
        if (!session.setThinkingLevel || !session.configuredThinkingLevel) {
          throw new Error("automatic thinking is unavailable in this owner");
        }
        session.setThinkingLevel(level);
      } else {
        state.api.setThinkingLevel(level as ApiThinkingLevel);
      }
    } catch {
      actual = actualStateOrUndefined(state) ?? actual;
      throw new BridgeError("model changed but thinking level failed", {
        status: 502,
        code: "partial_apply",
        data: actual,
      });
    }
    actual = currentState(state);
    const expected = level;
    if ((actual.configuredThinkingLevel ?? actual.thinkingLevel) !== expected) {
      throw new BridgeError(
        "model changed but thinking level was not applied",
        {
          status: 502,
          code: "partial_apply",
          data: actual,
        },
      );
    }
  }

  return jsonResponse({ ok: true, data: actual });
}

function enqueue<T>(
  state: BridgeState,
  operation: () => Promise<T> | T,
): Promise<T> {
  const next = state.operationTail.then(operation, operation) as Promise<T>;
  state.operationTail = next.catch(() => undefined);
  return next;
}

async function publishDescriptor(
  state: BridgeState,
  context: ExtensionContext,
): Promise<void> {
  const stateDir = envStateDir();
  if (!stateDir) {
    throw new Error("omp-pulse state directory is not configured");
  }
  const sessionPath = currentSessionPath(context);
  const server = state.server;
  if (!server || !sessionPath) {
    await removeDescriptor(state);
    return;
  }

  const directory = join(stateDir, DESKTOP_CONTROL_DIR);
  const targetPath = descriptorPathFor(stateDir);
  await mkdir(directory, { recursive: true });
  await setMode(directory, 0o700);

  const descriptor: Descriptor = {
    version: DESCRIPTOR_VERSION,
    pid: process.pid,
    ...(state.agentId ? { agentId: state.agentId } : {}),
    sessionPath,
    port: server.port,
    token: state.token,
    capabilities: LIVE_CAPABILITIES,
  };
  const temporaryPath = join(
    directory,
    `.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let published = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(descriptor)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await setMode(temporaryPath, 0o600);
    await rename(temporaryPath, targetPath);
    published = true;
    state.descriptorPath = targetPath;
    state.descriptorSessionPath = sessionPath;
  } finally {
    if (!published) {
      try {
        await unlink(temporaryPath);
      } catch {
        // Best-effort cleanup of a failed atomic publication.
      }
    }
  }
}

async function removeDescriptor(state: BridgeState): Promise<void> {
  const targetPath =
    state.descriptorPath ??
    (envStateDir() ? descriptorPathFor(envStateDir()) : undefined);
  if (!targetPath) return;

  try {
    const current = JSON.parse(
      await readFile(targetPath, "utf8"),
    ) as Partial<Descriptor>;
    if (current.token !== state.token || current.pid !== process.pid) return;
  } catch (error) {
    const code =
      isRecord(error) && typeof error.code === "string"
        ? error.code
        : undefined;
    if (code !== "ENOENT") return;
  }

  try {
    await unlink(targetPath);
  } catch (error) {
    const code =
      isRecord(error) && typeof error.code === "string"
        ? error.code
        : undefined;
    if (code !== "ENOENT") throw error;
  }
  state.descriptorPath = undefined;
  state.descriptorSessionPath = undefined;
}

const lineEncoder = new TextEncoder();

function closeSubscriber(state: BridgeState, subscriber: EventSubscriber): void {
  if (subscriber.closed) return;
  subscriber.closed = true;
  clearInterval(subscriber.timer);
  state.subscribers.delete(subscriber);
  try {
    subscriber.controller.close();
  } catch {
    // Already closed or errored by the reader going away.
  }
}

function closeAllSubscribers(state: BridgeState): void {
  for (const subscriber of [...state.subscribers]) {
    closeSubscriber(state, subscriber);
  }
}

/**
 * Queue one NDJSON line. A reader that stopped draining is dropped instead of
 * buffered without bound inside the user's omp; the daemon reconnects and the
 * phone catches up from the session file.
 */
function sendLine(
  state: BridgeState,
  subscriber: EventSubscriber,
  line: Uint8Array,
): void {
  if (subscriber.closed) return;
  // desiredSize is highWaterMark minus the queued chunks; the ceiling is
  // counted below zero so it does not depend on how the runtime applies the
  // strategy's highWaterMark.
  const desired = subscriber.controller.desiredSize;
  if (desired !== null && desired < -MAX_QUEUED_EVENTS) {
    closeSubscriber(state, subscriber);
    return;
  }
  try {
    subscriber.controller.enqueue(line);
  } catch {
    closeSubscriber(state, subscriber);
  }
}

/**
 * Fan one agent event out to every daemon reader. Serialised once, and not at
 * all while nobody listens, so an unpaired desktop pays nothing per token.
 */
function broadcastEvent(state: BridgeState, event: unknown): void {
  if (state.subscribers.size === 0) return;
  let line: Uint8Array;
  try {
    line = lineEncoder.encode(`${JSON.stringify(event)}\n`);
  } catch {
    return;
  }
  for (const subscriber of [...state.subscribers]) {
    sendLine(state, subscriber, line);
  }
}

const MAX_FEEDBACK_ENTRIES = 64;
const MAX_FEEDBACK_NOTICES = 32;
const MAX_FEEDBACK_BYTES = 256 * 1024;
const MAX_FEEDBACK_FRAME_BYTES = 64 * 1024;
const FEEDBACK_NOTICE_TTL_MS = 5 * 60 * 1000;

function internalFeedbackText(value: unknown): boolean {
  return typeof value === "string" &&
    (value.startsWith("omp-pulse:") || value.startsWith("omp-pulse-out:"));
}

function removeFeedback(state: BridgeState, key: string): void {
  const previous = state.feedback.get(key);
  if (!previous) return;
  state.feedbackBytes -= previous.bytes;
  state.feedback.delete(key);
}

function feedbackRequests(state: BridgeState): FeedbackFrame[] {
  const now = Date.now();
  for (const [key, entry] of state.feedback) {
    if (entry.notice && now - entry.received >= FEEDBACK_NOTICE_TTL_MS) {
      removeFeedback(state, key);
    }
  }
  return [...state.feedback.values()].map((entry) => entry.frame);
}

function publishFeedback(
  state: BridgeState,
  method: string,
  fields: Record<string, unknown>,
): void {
  const context = state.context;
  if (state.closed || !context || currentSessionPath(context) !== state.feedbackSessionPath) return;
  if (["statusKey", "widgetKey", "message"].some((key) => internalFeedbackText(fields[key]))) return;
  const frame: FeedbackFrame = {
    type: "extension_ui_request",
    id: `pulse-ui:${state.feedbackInstance}:${++state.feedbackSequence}`,
    method,
    ...fields,
  };
  const notice = method === "notify";
  const key = method === "setStatus" ? `status:${fields.statusKey}` :
    method === "setWidget" ? `widget:${fields.widgetKey}` :
    notice ? `notice:${frame.id}` : "editor";
  feedbackRequests(state);
  removeFeedback(state, key);
  const present = method === "setStatus" ? typeof fields.statusText === "string" :
    method === "setWidget" ? Array.isArray(fields.widgetLines) : true;
  const bytes = Buffer.byteLength(JSON.stringify(frame));
  if (present && bytes <= MAX_FEEDBACK_FRAME_BYTES) {
    if (notice) {
      const notices = [...state.feedback].filter(([, entry]) => entry.notice);
      if (notices.length >= MAX_FEEDBACK_NOTICES) removeFeedback(state, notices[0][0]);
    }
    while (state.feedback.size >= MAX_FEEDBACK_ENTRIES || state.feedbackBytes + bytes > MAX_FEEDBACK_BYTES) {
      const oldest = state.feedback.keys().next().value;
      if (oldest === undefined) break;
      removeFeedback(state, oldest);
    }
    state.feedback.set(key, { frame, bytes, received: Date.now(), notice });
    state.feedbackBytes += bytes;
  }
  broadcastEvent(state, frame);
}

/**
 * ExtensionRunner.createContext returns its shared UI object (OMP 18.8.6).
 * Mutate only real methods, call the terminal implementation first, and restore
 * our wrappers on shutdown/object replacement. Never synthesize unsupported UI.
 */
function mirrorFeedbackUI(state: BridgeState, context: ExtensionContext): void {
  const ui = context.ui;
  if (state.feedbackUI === ui) return;
  if (state.feedbackUI !== undefined) {
    state.feedback.clear();
    state.feedbackBytes = 0;
    broadcastEvent(state, { type: "extension_ui_snapshot", requests: [] });
  }
  state.restoreFeedbackUI?.();
  state.feedbackUI = ui;
  if (!ui) return;
  const restores: Array<() => void> = [];
  const forward = (method: string, fields: Record<string, unknown>) => {
    if (state.feedbackUI !== ui) return;
    // Mirroring must never change the result/exception of a terminal UI call.
    try { publishFeedback(state, method, fields); } catch { /* terminal already handled it */ }
  };
  if (typeof ui.notify === "function") {
    const original = ui.notify;
    const wrapped: typeof original = function (...args) {
      const result = original.apply(ui, args);
      forward("notify", { message: args[0], notifyType: args[1] });
      return result;
    };
    ui.notify = wrapped;
    restores.push(() => { if (ui.notify === wrapped) ui.notify = original; });
  }
  if (typeof ui.setStatus === "function") {
    const original = ui.setStatus;
    const wrapped: typeof original = function (...args) {
      const result = original.apply(ui, args);
      forward("setStatus", { statusKey: args[0], statusText: args[1] });
      return result;
    };
    ui.setStatus = wrapped;
    restores.push(() => { if (ui.setStatus === wrapped) ui.setStatus = original; });
  }
  if (typeof ui.setWidget === "function") {
    const original = ui.setWidget;
    const wrapped: typeof original = function (...args) {
      const result = original.apply(ui, args);
      // Like RPC mode, custom component factories remain terminal-only.
      if (args[1] === undefined || (Array.isArray(args[1]) && args[1].every((line) => typeof line === "string"))) {
        forward("setWidget", {
          widgetKey: args[0],
          widgetLines: args[1] === undefined ? undefined : [...args[1]],
          widgetPlacement: args[2]?.placement,
        });
      } else {
        // A terminal component replaces any previously mirrored text widget.
        forward("setWidget", { widgetKey: args[0] });
      }
      return result;
    };
    ui.setWidget = wrapped;
    restores.push(() => { if (ui.setWidget === wrapped) ui.setWidget = original; });
  }
  if (typeof ui.setEditorText === "function") {
    const original = ui.setEditorText;
    const wrapped: typeof original = function (...args) {
      const result = original.apply(ui, args);
      forward("set_editor_text", { text: args[0] });
      return result;
    };
    ui.setEditorText = wrapped;
    restores.push(() => { if (ui.setEditorText === wrapped) ui.setEditorText = original; });
  }
  if (typeof ui.pasteToEditor === "function" && typeof ui.getEditorText === "function") {
    const original = ui.pasteToEditor;
    const wrapped: typeof original = function (...args) {
      const result = original.apply(ui, args);
      // Paste inserts at the terminal cursor; mirror the actual resulting draft.
      try { forward("set_editor_text", { text: ui.getEditorText() }); } catch { /* terminal is authoritative */ }
      return result;
    };
    ui.pasteToEditor = wrapped;
    restores.push(() => { if (ui.pasteToEditor === wrapped) ui.pasteToEditor = original; });
  }
  state.restoreFeedbackUI = () => {
    for (const restore of restores) restore();
    state.feedbackUI = undefined;
    state.restoreFeedbackUI = undefined;
  };
}

/**
 * `GET /events`: a long-lived NDJSON stream. The first line is a
 * `bridge_hello` naming the bound session and whether a turn is running (so
 * a daemon that connects mid-turn shows it at once); then forwarded agent
 * events, with agent_end normalized to RPC terminality and a ping every 5 s
 * so a dead reader is noticed. A session switch closes the stream: the daemon re-reads the
 * descriptor and reconnects bound to the new session.
 */
function openEventStream(state: BridgeState): Response {
  const context = state.context;
  const sessionPath = context ? currentSessionPath(context) : undefined;
  if (!context || !sessionPath) {
    throw new BridgeError("desktop session has no session file", {
      status: 503,
      code: "no_session",
    });
  }
  let subscriber: EventSubscriber | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const created: EventSubscriber = {
          controller,
          timer: undefined,
          closed: false,
        };
        subscriber = created;
        state.subscribers.add(created);
        const hello = {
          type: "bridge_hello",
          sessionPath,
          pid: process.pid,
          isStreaming: state.turnRunning || !context.isIdle(),
          feedbackRequests: feedbackRequests(state),
        };
        sendLine(state, created, lineEncoder.encode(`${JSON.stringify(hello)}\n`));
        const ping = lineEncoder.encode('{"type":"bridge_ping"}\n');
        // A raw timer that throws would crash the whole omp session, so the
        // body is fenced; unref keeps it from holding the process open.
        created.timer = setInterval(() => {
          try {
            sendLine(state, created, ping);
          } catch {
            closeSubscriber(state, created);
          }
        }, EVENT_PING_MS);
        created.timer.unref?.();
      },
      cancel() {
        if (subscriber) closeSubscriber(state, subscriber);
      },
    },
    { highWaterMark: MAX_QUEUED_EVENTS },
  );
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}

async function startServer(state: BridgeState): Promise<void> {
  if (state.server) return;
  if (state.starting) return state.starting;
  state.starting = (async () => {
    if (state.closed) return;
    state.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request: Request, server?: BunRequestServer) => {
        try {
          const url = new URL(request.url);
          const isEvents =
            request.method === "GET" && url.pathname === EVENTS_PATH;
          if (!isEvents && request.method !== "POST") {
            throw new BridgeError("desktop control endpoint requires POST", {
              status: 405,
              code: "method_not_allowed",
            });
          }
          if (!isEvents && url.pathname !== CONTROL_PATH) {
            throw new BridgeError("desktop control endpoint not found", {
              status: 404,
              code: "not_found",
            });
          }
          if (request.headers.has("origin")) {
            throw new BridgeError("browser-origin requests are not accepted", {
              status: 403,
              code: "origin_rejected",
            });
          }
          if (!bearerMatches(request, state.token)) {
            throw new BridgeError("invalid desktop control credentials", {
              status: 401,
              code: "unauthorized",
            });
          }
          if (isEvents) {
            // A long-lived stream: never idle-close it. The ping above keeps
            // it busy anyway; this makes the timeout irrelevant.
            server?.timeout?.(request, 0);
            return openEventStream(state);
          }
          const body = parseControlRequest(await readBoundedBody(request));
          if (body.method === "prompt") {
            // Native input handlers and local commands may await session lifecycle
            // hooks. Do not hold the control queue those hooks must publish through,
            // and do not mark settings as applying: that would cancel their navigation.
            await state.operationTail;
            return await dispatch(state, body);
          }
          return await enqueue(state, async () => {
            state.applyingSettings = body.method !== "get_state";
            try {
              return await dispatch(state, body);
            } finally {
              state.applyingSettings = false;
            }
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    }) as BunControlServer;
    if (!state.server)
      throw new Error("desktop control server failed to start");
  })();
  try {
    await state.starting;
  } finally {
    state.starting = undefined;
  }
}

async function stopServer(state: BridgeState): Promise<void> {
  if (state.shutdownPromise) return state.shutdownPromise;
  state.shutdownPromise = (async () => {
    state.closed = true;
    state.unsubscribeQueue?.();
    state.unsubscribeQueue = undefined;
    state.restoreFeedbackUI?.();
    state.feedback.clear();
    state.feedbackBytes = 0;
    state.feedbackSessionPath = undefined;
    await enqueue(state, async () => {
      closeAllSubscribers(state);
      await removeDescriptor(state);
      const server = state.server;
      state.server = undefined;
      if (server) await server.stop(true);
    });
  })();
  return state.shutdownPromise;
}

export default function ompPulseControl(pi: ExtensionAPI): void {
  const state: BridgeState = {
    api: pi,
    context: undefined,
    server: undefined,
    starting: undefined,
    descriptorPath: undefined,
    descriptorSessionPath: undefined,
    token: randomBytes(32).toString("hex"),
    closed: false,
    applyingSettings: false,
    operationTail: Promise.resolve(),
    shutdownPromise: undefined,
    subscribers: new Set(),
    agentId: undefined,
    turnRunning: false,
    feedback: new Map(),
    feedbackBytes: 0,
    feedbackSessionPath: undefined,
    feedbackInstance: randomBytes(16).toString("hex"),
    feedbackSequence: 0,
    feedbackUI: undefined,
    restoreFeedbackUI: undefined,
    unsubscribeQueue: undefined,
    queueAccess: new OwnerQueueAccess(),
  };

  const onSessionReady = async (
    _event: unknown,
    context: ExtensionContext,
  ): Promise<void> => {
    // Only the interactive desktop session is the phone's counterpart.
    // Subagents are identified explicitly via context.agent (kind "sub",
    // 18.3.2+); older binaries fall back to the hasUI heuristic. Without
    // this, every task call overwrote the pid-keyed descriptor with the
    // child's session (and removed it at the child's shutdown), leaving the
    // real desktop conversation with no bridge at all. The daemon's own RPC
    // children (OMP_PULSE_CHILD) are already driven over their stdio; a
    // bridge there would deliver every event to the phone twice.
    const agent = (
      context as ExtensionContext & {
        agent?: { kind?: string; id?: string };
      }
    ).agent;
    if (agent ? agent.kind !== "main" : !context.hasUI) return;
    if (process.env.OMP_PULSE_CHILD === "1") return;
    // Navigation starts a different owner binding; never carry the old turn
    // into a new conversation. Reconnecting readers retain this latch.
    if (
      state.closed ||
      state.descriptorSessionPath !== currentSessionPath(context)
    ) {
      state.turnRunning = !context.isIdle();
    }
    state.context = context;
    state.agentId = typeof agent?.id === "string" ? agent.id : undefined;
    const feedbackSessionPath = currentSessionPath(context);
    if (state.feedbackSessionPath !== feedbackSessionPath) {
      state.feedback.clear();
      state.feedbackBytes = 0;
      state.feedbackSessionPath = feedbackSessionPath;
    }
    mirrorFeedbackUI(state, context);
    // session_shutdown tears the bridge down for the whole process. Without
    // re-arming here, the next start/switch in the same process would hit the
    // closed early-return in startServer and never republish, leaving the
    // phone's settings path dead until omp restarts.
    if (state.shutdownPromise) {
      try {
        await state.shutdownPromise;
      } catch {
        // Teardown is best-effort; re-arm regardless.
      }
      state.shutdownPromise = undefined;
      state.closed = false;
      state.server = undefined;
      state.token = randomBytes(32).toString("hex");
    }
    await startServer(state);
    await enqueue(state, async () => {
      const previous = state.descriptorSessionPath;
      await publishDescriptor(state, context);
      state.unsubscribeQueue?.();
      state.unsubscribeQueue = undefined;
      try {
        const session = ownerSession(state);
        const binding = state.descriptorSessionPath;
        let active = true;
        const unsubscribe = session.subscribe?.((event) => {
          if (active && !state.closed && state.descriptorSessionPath === binding && isRecord(event) &&
              ["queue_update", "thinking_level_changed", "model_changed"].includes(String(event.type))) {
            const queue = event.type === "queue_update" ? state.queueAccess.snapshot(session) : null;
            broadcastEvent(state, queue ? { ...event, ...queue } : event);
          }
        });
        state.unsubscribeQueue = () => {
          active = false;
          unsubscribe?.();
        };
      } catch {
        // Older owners can still serve settings and plain Stop.
      }
      // Streams are bound to one conversation. After /resume, /new or a
      // branch, readers reconnect and pick the new binding up from the
      // republished descriptor rather than mislabel events.
      if (previous !== undefined && previous !== state.descriptorSessionPath) {
        closeAllSubscribers(state);
      }
    });
  };

  // setModel may await metadata. A native navigation during that await must
  // not redirect the settings write into a different conversation.
  const guardNavigation = () =>
    state.applyingSettings ? { cancel: true } : undefined;
  pi.on("session_before_switch", guardNavigation);
  pi.on("session_before_branch", guardNavigation);
  pi.on("session_before_tree", guardNavigation);

  pi.on("agent_end", (event: unknown) => {
    if (!isRecord(event)) return;
    // The owner has already decided whether maintenance/retry/queued work
    // continues the turn. isIdle() only describes the underlying model call
    // and can be true here even though that logical turn has not finished.
    const isTerminal = event.willContinue !== true && event.isTerminal !== false;
    state.turnRunning = !isTerminal;
    broadcastEvent(state, { ...event, isTerminal });
  });

  pi.on("retry_fallback_applied", (event, context) => {
    // The daemon installs its own child owner hook; globally installed
    // desktop extensions can also load there and must not journal twice.
    if (process.env.OMP_PULSE_CHILD === "1") return;
    // OMP persists only the ephemeral model switch, not its explanation.
    // Append through the sole owner, never from the daemon/file reader.
    pi.appendEntry("omp-pulse-model-fallback", event);
    const receipt = context.sessionManager.getLeafEntry?.();
    const at = receipt ? Date.parse(receipt.timestamp) : NaN;
    broadcastEvent(state, {
      ...event,
      ...(receipt?.type === "custom" && receipt.customType === "omp-pulse-model-fallback"
        ? { entryId: receipt.id, ...(Number.isFinite(at) ? { at } : {}) } : {}),
    });
  });

  for (const name of FORWARDED_EVENTS) {
    pi.on(name, (event: unknown) => {
      if (name === "agent_start") state.turnRunning = true;
      broadcastEvent(state, event);
    });
  }

  pi.on("session_start", onSessionReady);
  pi.on("session_switch", onSessionReady);
  pi.on("session_branch", onSessionReady);
  pi.on("session_tree", onSessionReady);
  pi.on("session_shutdown", async () => {
    await stopServer(state);
  });
}
