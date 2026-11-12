import {
  parsePluginInfo,
  parsePluginSourceReading,
  type PluginActionResult,
  type PluginInfo,
  type PluginOptionValues,
  type PluginSourceReading,
} from "../domain/plugins";
import { ReceiptValidationError, RECEIPT_BINDING_CAPABILITY, validateBoundReceiptResponse, validateCommandReceipt, retainedReceiptBinding } from "./command-receipt";
import { acknowledgeNativeSave, usesNativeOutbox } from "./native-outbox";
import { deliveryFailed } from "./receipt-outcome";
import { fetchWithDeadline, readJsonResponse, readRequestSignal } from "./request";
import { parsePlanModeReply, type PlanModeState } from "./plan-state";
/**
 * Typed daemon API client — dependency-free, framework-free.
 *
 * Every route/method/body is copied from `src/server/http.rs` router and handlers.
 * See comments quoting the exact `json!` / `.route()` line.
 */

import type {
  AvailableCommand,
  BranchMessage,
  BrowseResult,
  CommandReceipt,
  FileContent,
  FileEntry,
  FileWriteRequest,
  ModelInfo,
  PromptRequest,
  PromptResponse,
  ReceiptResponse,
  ReceiptIntent,
  ReceiptsResponse,
  VersionResponse,
  SearchHit,
  SearchResponse,
  MessageSearch,
  SessionState,
  WorkspaceChanges,
  WorkspaceChangesSummary,
} from "./api-types";
import { readPairingToken } from "../platform/browser-storage";
import type { PromptDelivery } from "../domain/send-mode";
import type { OmpSessionSummary } from "../domain/protocol";
import {
  UndispatchedError,
  enqueue,
  flush,
  getImages,
  getQueued,
  offlineQueueNamespaceForCredential,
  applyReceipt,
  assertDispatchCurrent,
  assertNoPendingEdit,
  captureQueueScope,
  type QueuedPrompt,
} from "./offline-queue";

// The daemon protocol this client speaks. It comes from the repository-root
// protocol-version.json via the web/vite.config.ts define, so there is no
// literal here to drift out of step with the daemon, Gradle or the deploy
// manifest. `omp-session-controller.ts` reads the same define.
const CLIENT_PROTOCOL_VERSION: number = import.meta.env.VITE_PROTOCOL_VERSION;

export interface PromptConfig {
  magicKeywords: Array<{ id: string; word: string; hue: [number, number] }>;
}

export interface ModelMentionChoice {
  selector: string;
  name: string;
  provider: string;
}

export interface TreeGotoOptions {
  summarize: boolean;
  customInstructions?: string;
}

export interface TreeGotoResult {
  cancelled: boolean;
  aborted: boolean;
  askReanswerCommitted: boolean;
  editorText?: string;
  error?: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────

export class AuthError extends Error {
  override name = "AuthError";
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class ForbiddenError extends Error {
  override name = "ForbiddenError";
  status = 403;

  constructor(
    message = "This device is not allowed to perform that operation",
  ) {
    super(message);
  }
}
export class ReceiptProtocolError extends Error {
  override name = "ReceiptProtocolError";
  readonly protocolVersion: number | null;
  readonly minClientProtocolVersion: number | null;

  constructor(
    protocolVersion: number | null,
    minClientProtocolVersion: number | null,
  ) {
    super("Daemon does not support command receipts safely");
    this.protocolVersion = protocolVersion;
    this.minClientProtocolVersion = minClientProtocolVersion;
  }
}

export class OwnershipError extends Error {
  override name = "OwnershipError";
  code = "session_owned_by_terminal" as const;

  constructor(message = "session_owned_by_terminal") {
    super(message);
  }
}

/** A refused conditional file save; callers must retain the unsaved draft. */
export class FileConflictError extends Error {
  override name = "FileConflictError";
  readonly code = "file_conflict";

  constructor() {
    super("This file changed on disk. Your draft is kept. Copy it before discarding it to load the latest version.");
  }
}

export function isOwnershipError(error: unknown): boolean {
  if (error instanceof OwnershipError) return true;
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as Record<string, unknown>).code;
    if (code === "session_owned_by_terminal") return true;
  }
  if (error !== null && typeof error === "object" && "message" in error) {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.includes("session_owned_by_terminal"))
      return true;
  }
  return false;
}
function makeCommandId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// Also exported under the exact name the contract lists.
// Re-exported types for importers that mirror the contract's flat surface.
export type {
  BrowseResult,
  FileContent,
  FileEntry,
  ModelInfo,
  SearchHit,
  MessageSearch,
  SessionState,
};

/** A one-shot read-lease snapshot; connectionId is opaque and never a path. */
export type DesktopAgentRosterPage = {
  ok: true;
  /** Exact count from full source roster; absent on older servers. */
  runningCount?: number | null;
  agents: unknown[];
  connectionId: string;
};

/** GET /api/agents/transcript: passive, current-host, exact-registry read. */
export type DesktopAgentTranscriptPage = {
  ok: true;
  connectionId: string;
  agentId: string;
  fromByte: number;
  nextByte: number;
  text: string;
  reset: boolean;
};

export type DesktopAgentFollowUpTarget = {
  agentId: string;
  expectedCreatedAt: number;
  expectedConnectionId: string;
  daemonInstanceId: string;
  bindingEpoch: number;
};

export type DesktopAgentFollowUpAvailability = { available: boolean; reason?: string };

export type ProviderInfo = { id: string; label: string; signedIn: boolean };
/** The live `omp login`: `provider` names whose sign-in a reloaded page found. */
export type ProviderLoginState = { provider?: string; running: boolean; exitCode: number | null; output: string };

/** The `/api/changes` fields both modes share, with absent fields normalised. */
function changesEnvelope(data: Partial<WorkspaceChangesSummary>): Omit<WorkspaceChangesSummary, "files"> {
  const totals = data.totals;
  return {
    cwd: data.cwd ?? "",
    repoRoot: data.repoRoot ?? null,
    branch: data.branch ?? null,
    notRepo: Boolean(data.notRepo),
    totals: {
      files: Number(totals?.files ?? 0),
      additions: Number(totals?.additions ?? 0),
      deletions: Number(totals?.deletions ?? 0),
    },
    truncated: Boolean(data.truncated),
  };
}

// ─── DaemonApi ─────────────────────────────────────────────────────────

export class DaemonApi {
  private token: string;
  private baseUrl: string;
  /** Deduplicates concurrent identical GETs (same URL) — src/server/http.rs sessions/awaiting poll. */
  private inflight = new Map<string, Promise<unknown>>();

  constructor(token: string, baseUrl?: string) {
    this.token = token;
    // Normalised without trailing slash; empty → relative to current origin.
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : "";
  }

  // ── URL helper ─────────────────────────────────────────────────────

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private authHeaders(init: RequestInit): Headers {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body !== undefined && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    return headers;
  }

  public async fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = this.authHeaders(init);
    const res = await fetchWithDeadline(this.url(path), { ...init, headers });
    return this.readDaemonJson<T>(res, path);
  }

  /** The daemon's reply as JSON, with its error conventions turned into typed throws. */
  private async readDaemonJson<T>(res: Response, path: string): Promise<T> {
    // 401 means the credential is invalid or revoked. A 403 is a valid,
    // authenticated read-role device being refused a control operation.
    if (res.status === 401) {
      throw new AuthError("Authentication failed", res.status);
    }

    // Daemon error convention: `{ ok:false, error:string, code?:string }` at
    // HTTP 200 as well as on non-OK HTTP statuses.
    const body = await readJsonResponse(res);
    const detail = () => {
      if (body !== null && typeof body === "object" && "error" in body) {
        const error = (body as Record<string, unknown>).error;
        if (typeof error === "string" && error.trim()) return error;
      }
      return `HTTP ${res.status}`;
    };

    if (!res.ok) {
      const code =
        body !== null && typeof body === "object" && "code" in body
          ? (body as Record<string, unknown>).code
          : undefined;
      const msg = detail();
      if (code === "session_owned_by_terminal") {
        const err = new OwnershipError(msg);
        (err as unknown as Record<string, unknown>).code = code;
        throw err;
      }
      if (res.status === 403) throw new ForbiddenError(msg);
      throw Object.assign(new Error(msg), { status: res.status, code });
    }

    // HTTP 200 — every endpoint, including prompt, must reject an explicit
    // `{ok:false}` instead of treating the transport status as success.
    if (body !== null && typeof body === "object" && "ok" in body) {
      const rec = body as Record<string, unknown>;
      if (rec.ok === false) {
        if (path === "/api/prompt" && ("receipt" in rec || "receiptBinding" in rec))
          throw new ReceiptValidationError();
        const msg = detail();
        if (rec.code === "session_owned_by_terminal") {
          const err = new OwnershipError(msg);
          (err as unknown as Record<string, unknown>).code = rec.code;
          throw err;
        }
        throw Object.assign(new Error(msg), { code: rec.code });
      }
    }

    return body as T;
  }

  private dedupedFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET") return this.fetchJson<T>(path, init);

    const key = `${method} ${path}`;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const p = this.fetchJson<T>(path, init).finally(() => {
      // Only delete if we are still the owner — a second concurrent caller that
      // raced ahead after the first settled will have re-inserted its own.
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  // ── Awaiting ─────────────────────────────────────────────────────────
  // GET /api/awaiting  src/server/http.rs:2759 .route("/awaiting", get(awaiting))
  //                handler src/server/http.rs:2378 ok(json!({ "ok": true, "sessions": sessions }))
  async awaiting(): Promise<string[]> {
    const data = await this.dedupedFetch<{ ok: boolean; sessions?: string[] }>(
      "/api/awaiting",
    );
    return Array.isArray(data.sessions) ? data.sessions : [];
  }

  // ── Search ───────────────────────────────────────────────────────────
  // GET /api/search  src/server/http.rs .route("/search", get(search))
  //              handler ok(json!({ "ok": true, "hits": hits, "scannedFiles": n, "truncated": bool }))
  async search(q: string, limit?: number): Promise<SearchHit[]> {
    return (await this.searchMessages(q, limit)).hits;
  }

  /** `search` plus whether the daemon's scan caps left older text unsearched. */
  async searchMessages(q: string, limit?: number, project?: string | null): Promise<MessageSearch> {
    const params = new URLSearchParams({ q });
    if (limit !== undefined) params.set("limit", String(limit));
    if (project) params.set("project", project);
    const data = await this.dedupedFetch<SearchResponse>(`/api/search?${params}`);
    return {
      hits: Array.isArray(data.hits) ? data.hits : [],
      truncated: data.truncated === true,
      scannedFiles: typeof data.scannedFiles === "number" ? data.scannedFiles : 0,
    };
  }

  /**
   * One session's listing row, whatever the Sessions screen is filtered to.
   * A pinned path is served on the first page of an unfiltered listing
   * (src/sessions/index.rs select_page), so a one-row page plus the pin carries it.
   * Null when the daemon no longer lists the file.
   */
  async sessionRow(sessionPath: string): Promise<OmpSessionSummary | null> {
    const params = new URLSearchParams({ limit: "1", live: "false", pinned: sessionPath });
    const data = await this.fetchJson<{ sessions?: unknown }>(`/api/sessions?${params}`);
    const rows: unknown[] = Array.isArray(data.sessions) ? data.sessions : [];
    const row = rows.find((r): r is OmpSessionSummary =>
      typeof r === "object" && r !== null && "path" in r && r.path === sessionPath);
    return row ?? null;
  }

  /** Server-side listing search: the best matches across the whole archive, not just loaded rows. */
  async searchSessions(q: string, limit: number, signal?: AbortSignal): Promise<OmpSessionSummary[]> {
    const params = new URLSearchParams({ q, limit: String(limit), live: "false" });
    const data = await this.fetchJson<{ sessions?: unknown }>(`/api/sessions?${params}`, { signal });
    return Array.isArray(data.sessions) ? data.sessions as OmpSessionSummary[] : [];
  }

  /**
   * The full text of the user message whose JSONL line starts at `offset`
   * (a search hit's anchor; `/api/search` cuts lines at 200 characters).
   * A forward history read from that byte returns that line first. Null when
   * the file changed underneath and the anchor no longer starts a user message.
   */
  async readUserMessageAt(sessionPath: string, offset: number, entryId?: string): Promise<string | null> {
    const params = new URLSearchParams({ session: sessionPath, after: String(offset) });
    const data = await this.fetchJson<{ entries?: unknown[] }>(`/api/history?${params}`);
    const entry: unknown = Array.isArray(data.entries) ? data.entries[0] : null;
    if (!entry || typeof entry !== "object" || !("message" in entry)) return null;
    if (entryId && (!("id" in entry) || entry.id !== entryId)) return null;
    const message: unknown = entry.message;
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user" || !("content" in message)) return null;
    const content: unknown = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    const text: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") text.push(part.text);
    }
    return text.join("\n") || null;
  }

  // ── Browse (home directory picker) ─────────────────────────────────
  // GET /api/browse  src/server/http.rs:2769 .route("/browse", get(browse))
  //              handler src/server/http.rs:1057 ok(json!({ "ok": true, "path": ..., "parent": ..., "dirs": dirs }))
  async browse(path?: string): Promise<BrowseResult> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    const data = await this.dedupedFetch<{
      ok: boolean;
      path?: string;
      parent?: string | null;
      dirs?: { name: string; path: string }[];
    }>(`/api/browse${qs}`);
    return {
      path: data.path ?? path ?? "",
      parent: data.parent ?? null,
      dirs: Array.isArray(data.dirs) ? data.dirs : [],
    };
  }

  // ── New session ──────────────────────────────────────────────────────
  // POST /api/new  src/server/http.rs:2778 .route("/new", post(new_session))
  //            handler src/server/http.rs:1539 ok(json!({ "ok": true, "sessionPath": session_path }))
  async newSession(cwd: string): Promise<{ sessionPath: string }> {
    const data = await this.fetchJson<{ ok: boolean; sessionPath?: string }>(
      "/api/new",
      { method: "POST", body: JSON.stringify({ cwd }) },
    );
    if (!data.sessionPath) throw new Error("missing sessionPath");
    return { sessionPath: data.sessionPath };
  }

  // ── Prewarm ──────────────────────────────────────────────────────────
  // POST /api/prewarm  src/server/http.rs:2773 .route("/prewarm", post(prewarm))
  //                handler src/server/http.rs:1366 ok(json!({ "ok": true }))
  async prewarm(sessionPath: string): Promise<void> {
    await this.fetchJson("/api/prewarm", {
      method: "POST",
      body: JSON.stringify({ sessionPath }),
    });
  }
  async ensureReceiptProtocol(): Promise<void> {
    const data = await this.dedupedFetch<VersionResponse>("/api/version");
    const protocolVersion =
      typeof data?.protocolVersion === "number" ? data.protocolVersion : null;
    const minClientProtocolVersion =
      typeof data?.minClientProtocolVersion === "number"
        ? data.minClientProtocolVersion
        : null;
    if (
      protocolVersion === null ||
      minClientProtocolVersion === null ||
      protocolVersion < CLIENT_PROTOCOL_VERSION ||
      minClientProtocolVersion > CLIENT_PROTOCOL_VERSION ||
      !Array.isArray(data.capabilities) ||
      !data.capabilities.every(capability => typeof capability === "string") ||
      !data.capabilities.includes(RECEIPT_BINDING_CAPABILITY)
    ) {
      throw new ReceiptProtocolError(protocolVersion, minClientProtocolVersion);
    }
  }

  async prompt(
    sessionPath: string,
    text: string,
    images: readonly { data: string; mimeType: string }[] = [],
    commandId = makeCommandId(),
    signal?: AbortSignal,
    beforePost?: () => Promise<void>,
    delivery?: PromptDelivery,
  ): Promise<PromptResponse> {
    try {
      await this.ensureReceiptProtocol();
      await beforePost?.();
    } catch (error) {
      throw new UndispatchedError(error);
    }
    const body: PromptRequest = { commandId, sessionPath, text };
    if (images.length > 0) body.images = images.map((image) => ({ ...image }));
    if (delivery) body.delivery = delivery;
    const data = await this.fetchJson<PromptResponse>("/api/prompt", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });
    return validateBoundReceiptResponse(data, { commandId, sessionPath });
  }

  async getReceipts(sessionPath?: string): Promise<CommandReceipt[]> {
    const qs = sessionPath ? `?session=${encodeURIComponent(sessionPath)}` : "";
    const data = await this.dedupedFetch<ReceiptsResponse>(
      `/api/receipts${qs}`,
    );
    return Array.isArray(data.receipts)
      ? data.receipts.map((receipt) => validateCommandReceipt(receipt))
      : [];
  }

  async getReceipt(intent: ReceiptIntent): Promise<ReceiptResponse | null> {
    retainedReceiptBinding(intent);
    try {
      const data = await this.dedupedFetch<ReceiptResponse>(
        `/api/receipts/${encodeURIComponent(intent.commandId)}?session=${encodeURIComponent(intent.sessionPath)}`,
      );
      return validateBoundReceiptResponse(data, intent);
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 404)
        return null;
      throw error;
    }
  }

  // ── Generic RPC ──────────────────────────────────────────────────────
  async rpc<T>(
    sessionPath: string,
    command: string,
    params?: Record<string, unknown>,
    extra?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const body: Record<string, unknown> = { ...extra, sessionPath, command };
    body.params = params ?? {};
    const data = await this.fetchJson<{ ok: boolean; data?: T } | T>(
      "/api/rpc",
      {
        method: "POST",
        ...(command.startsWith("get_") ? { signal: readRequestSignal(signal) } : {}),
        body: JSON.stringify(body),
      },
    );
    if (
      data !== null &&
      typeof data === "object" &&
      "ok" in (data as Record<string, unknown>) &&
      "data" in (data as Record<string, unknown>)
    ) {
      return (data as { data: T }).data;
    }
    return data as T;
  }

  // ── getState ─────────────────────────────────────────────────────────
  // `peek` is for passive displays: the daemon answers from the session file
  // instead of booting a child when nothing live holds the session.
  async getState(sessionPath: string, options?: { peek?: boolean }): Promise<SessionState> {
    const data = await this.rpc<SessionState>(
      sessionPath,
      "get_state",
      {},
      options?.peek ? { peek: true } : undefined,
    );
    return (data ?? {}) as SessionState;
  }

  async getPromptConfig(sessionPath: string): Promise<PromptConfig> {
    const data = await this.rpc<unknown>(sessionPath, "get_prompt_config", {});
    if (!data || typeof data !== "object" || !("magicKeywords" in data) || !Array.isArray(data.magicKeywords)) {
      throw new Error("Prompt configuration is unavailable");
    }
    const magicKeywords: PromptConfig["magicKeywords"] = [];
    for (const keyword of data.magicKeywords) {
      if (!keyword || typeof keyword !== "object" ||
          typeof keyword.id !== "string" || typeof keyword.word !== "string" ||
          !Array.isArray(keyword.hue) || keyword.hue.length !== 2 ||
          !keyword.hue.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error("Prompt configuration is unavailable");
      }
      magicKeywords.push({ id: keyword.id, word: keyword.word, hue: [keyword.hue[0], keyword.hue[1]] });
    }
    return { magicKeywords };
  }

  async getModelMentionChoices(sessionPath: string): Promise<ModelMentionChoice[]> {
    const data = await this.rpc<unknown>(sessionPath, "get_model_mention_choices", {});
    if (!data || typeof data !== "object" || !("choices" in data) || !Array.isArray(data.choices)) {
      throw new Error("Model mention choices are unavailable");
    }
    return data.choices.map((choice: unknown) => {
      if (!choice || typeof choice !== "object" || !("selector" in choice) || typeof choice.selector !== "string" ||
          !("name" in choice) || typeof choice.name !== "string" || !("provider" in choice) || typeof choice.provider !== "string") {
        throw new Error("Model mention choices are unavailable");
      }
      return { selector: choice.selector, name: choice.name, provider: choice.provider };
    });
  }

  // ── getAvailableModels ───────────────────────────────────────────────
  // Tolerates both { models:[...] } and bare [...]
  async getAvailableModels(sessionPath: string): Promise<ModelInfo[]> {
    const data = await this.rpc<unknown>(
      sessionPath,
      "get_available_models",
      {},
    );
    if (Array.isArray(data)) return data as ModelInfo[];
    if (
      data !== null &&
      typeof data === "object" &&
      "models" in (data as Record<string, unknown>) &&
      Array.isArray((data as { models: unknown }).models)
    ) {
      return (data as { models: ModelInfo[] }).models;
    }
    return [];
  }
  // GET /api/model-usage  src/server/http.rs router
  // Read-only MRU history from omp's agent.db. An empty response means the
  // client should use its local fallback list.
  async getRecentModels(): Promise<string[]> {
    const data = await this.dedupedFetch<{ ok: boolean; models?: unknown[] }>(
      "/api/model-usage",
    );
    return Array.isArray(data.models)
      ? data.models.filter(
          (key): key is string => typeof key === "string" && key.length > 0,
        )
      : [];
  }

  // ── Plugins (src/server/http/plugins.rs) ────────────────────────────────
  // GET /api/plugins  src/server/http/plugins.rs `plugin_list`: the catalog, one entry per folder.
  async listPlugins(): Promise<PluginInfo[]> {
    const data = await this.dedupedFetch<{ plugins?: unknown }>("/api/plugins");
    if (!Array.isArray(data.plugins)) return [];
    return data.plugins.flatMap((raw): PluginInfo[] => {
      const info = parsePluginInfo(raw);
      return info ? [info] : [];
    });
  }

  // GET /api/plugins/{id}/client.js  src/server/http/plugins.rs `plugin_client_script`: the script text
  // of an enabled plugin. A refusal is the usual JSON error body.
  async getPluginScript(id: string): Promise<string> {
    const path = `/api/plugins/${encodeURIComponent(id)}/client.js`;
    const res = await fetchWithDeadline(this.url(path), { headers: this.authHeaders({}) });
    if (!res.ok) {
      await this.readDaemonJson(res, path);
      throw new Error(`HTTP ${res.status}`);
    }
    return res.text();
  }

  // POST /api/plugins/{id}/state  src/server/http/plugins.rs `plugin_set_state`: Control role.
  // `hash` is the reviewed hash and is required to turn a plugin on.
  async setPluginState(id: string, enabled: boolean, hash?: string): Promise<PluginInfo> {
    const body: Record<string, unknown> = { enabled };
    if (hash !== undefined) body.hash = hash;
    let data: { plugin?: unknown };
    try {
      data = await this.fetchJson<{ plugin?: unknown }>(`/api/plugins/${encodeURIComponent(id)}/state`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error) {
      // A read-only device is refused with a 403 whose text is meant for logs.
      if (error instanceof ForbiddenError) {
        throw new Error("This device is read-only, so it cannot switch plugins on or off.");
      }
      throw error;
    }
    const info = parsePluginInfo(data.plugin);
    if (!info) throw new Error("The computer sent back a plugin entry this app cannot read.");
    return info;
  }

  // GET /api/plugins/{id}/sources/{source}  src/server/http/plugins.rs `plugin_source`: the latest
  // reading of a source the plugin declared; the daemon runs the command only when its cache expired.
  async getPluginSource(id: string, source: string): Promise<PluginSourceReading> {
    const data = await this.fetchJson<{ reading?: unknown }>(
      `/api/plugins/${encodeURIComponent(id)}/sources/${encodeURIComponent(source)}`,
    );
    const reading = parsePluginSourceReading(data.reading);
    if (!reading) throw new Error("The computer sent back a source reading this app cannot read.");
    return reading;
  }

  // POST /api/plugins/{id}/options  src/server/http/plugins.rs `plugin_set_options`: Control role.
  // Option values live on the daemon and are shared by every device.
  async setPluginOptions(id: string, values: PluginOptionValues): Promise<PluginInfo> {
    let data: { plugin?: unknown };
    try {
      data = await this.fetchJson<{ plugin?: unknown }>(`/api/plugins/${encodeURIComponent(id)}/options`, {
        method: "POST",
        body: JSON.stringify({ values }),
      });
    } catch (error) {
      if (error instanceof ForbiddenError) {
        throw new Error("This device is read-only, so it cannot change plugin options.");
      }
      throw error;
    }
    const info = parsePluginInfo(data.plugin);
    if (!info) throw new Error("The computer sent back a plugin entry this app cannot read.");
    return info;
  }

  // POST /api/plugins/{id}/actions/{action}  src/server/http/plugins.rs `plugin_run_action`: runs one
  // declared action of an enabled plugin. `hash` is the hash the caller was started with; the daemon
  // refuses when the plugin has changed since. A command that failed is still a result (`ok: false`).
  async runPluginAction(id: string, action: string, hash: string, arg?: string): Promise<PluginActionResult> {
    const body: Record<string, unknown> = { hash };
    if (arg !== undefined) body.arg = arg;
    const data = await this.fetchJson<{ result?: unknown }>(
      `/api/plugins/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const result = parsePluginSourceReading(data.result);
    if (!result) throw new Error("The computer sent back an action result this app cannot read.");
    return result;
  }

  // ── Model providers (Admin only; src/server/http/providers.rs) ──────────
  /** This device's own access role: only an administrator may add a provider. */
  async deviceRole(): Promise<"admin" | "control" | "read" | null> {
    const data = await this.fetchJson<{ device?: { role?: unknown } }>("/api/device");
    const role = data.device?.role;
    return role === "admin" || role === "control" || role === "read" ? role : null;
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const data = await this.fetchJson<{ providers?: unknown }>("/api/providers");
    if (!Array.isArray(data.providers)) return [];
    return data.providers.flatMap((value): ProviderInfo[] => {
      const p = value as Partial<ProviderInfo> | null;
      return p && typeof p.id === "string" && p.id
        ? [{ id: p.id, label: typeof p.label === "string" && p.label ? p.label : p.id, signedIn: p.signedIn === true }]
        : [];
    });
  }

  async startProviderLogin(provider: string): Promise<void> {
    await this.fetchJson("/api/providers/login", { method: "POST", body: JSON.stringify({ provider }) });
  }

  async providerLoginState(): Promise<ProviderLoginState> {
    const data = await this.fetchJson<Partial<ProviderLoginState>>("/api/providers/login");
    return {
      running: data.running === true,
      exitCode: typeof data.exitCode === "number" ? data.exitCode : null,
      output: typeof data.output === "string" ? data.output : "",
      ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
    };
  }

  /** A pasted code, redirect URL or API key for the running sign-in; never logged. */
  async sendProviderLoginInput(text: string): Promise<void> {
    await this.fetchJson("/api/providers/login/input", { method: "POST", body: JSON.stringify({ text }) });
  }

  async cancelProviderLogin(): Promise<void> {
    await this.fetchJson("/api/providers/login/cancel", { method: "POST", body: "{}" });
  }

  // ── setModel ─────────────────────────────────────────────────────────
  async setModel(
    sessionPath: string,
    provider: string,
    modelId: string,
    thinkingLevel?: string,
  ): Promise<void> {
    const params: Record<string, unknown> = { provider, modelId };
    if (thinkingLevel !== undefined) params.thinkingLevel = thinkingLevel;
    await this.rpc(sessionPath, "set_model", params);
  }

  // ── setSessionName ───────────────────────────────────────────────────
  async setSessionName(sessionPath: string, name: string): Promise<void> {
    await this.rpc(sessionPath, "set_session_name", { name });
  }

  // ── Branch / timeline ────────────────────────────────────────────────
  async getBranchMessages(
    sessionPath: string,
  ): Promise<{ entryId: string; text: string }[]> {
    const data = await this.rpc<unknown>(
      sessionPath,
      "get_branch_messages",
      {},
    );
    // Daemon returns { messages:[{entryId|id, text}] } or bare array.
    const arr: unknown[] = Array.isArray(data)
      ? data
      : data !== null &&
          typeof data === "object" &&
          "messages" in (data as Record<string, unknown>) &&
          Array.isArray((data as { messages: unknown }).messages)
        ? (data as { messages: unknown[] }).messages
        : [];
    return arr
      .map((m) => {
        if (m === null || typeof m !== "object") return null;
        const o = m as Record<string, unknown>;
        const entryId =
          (o.entryId as string) ??
          (o.id as string) ??
          (o.entry_id as string) ??
          "";
        const text = (o.text as string) ?? "";
        if (!entryId) return null;
        return { entryId, text };
      })
      .filter((x): x is { entryId: string; text: string } => x !== null);
  }

  /**
   * Branch the conversation at a user message. The daemon builds the branch
   * from the session file (src/sessions/branch.rs) and returns the new `sessionPath`
   * plus the text of the message branched at, so the editor can restore it.
   * It works whoever owns the source, the desktop included, because the
   * source is only read.
   */
  async branch(
    sessionPath: string,
    entryId: string,
  ): Promise<{ sessionPath: string; text: string; cancelled: boolean }> {
    const data = await this.rpc<Record<string, unknown>>(
      sessionPath,
      "branch",
      {
        entryId,
      },
    );
    const text = typeof data?.text === "string" ? data.text : "";
    if (data?.cancelled === true) return { sessionPath, text, cancelled: true };
    const next = typeof data?.sessionPath === "string" ? data.sessionPath : "";
    if (!next) throw new Error("branch: the daemon did not report the new session");
    return { sessionPath: next, text, cancelled: false };
  }

  /**
   * omp's `/fork`: copy the WHOLE conversation into a new session and return
   * its `sessionPath`; nothing is rewound. A session the daemon's own agent
   * writes is forked by that agent, which then continues in the copy; any
   * other (the desktop's included) is copied from its file, never written.
   */
  async fork(sessionPath: string): Promise<{ sessionPath: string; cancelled: boolean }> {
    const data = await this.rpc<Record<string, unknown>>(sessionPath, "fork", {});
    if (data?.cancelled === true) return { sessionPath, cancelled: true };
    const next = typeof data?.sessionPath === "string" ? data.sessionPath : "";
    if (!next) throw new Error("fork: the daemon did not report the new session");
    return { sessionPath: next, cancelled: false };
  }

  /**
   * Turn plan mode on or off (the daemon's helper; omp's `/plan` is TUI-only).
   * Refusals such as an active goal arrive as human error strings.
   */
  async setPlanMode(sessionPath: string, enabled: boolean): Promise<PlanModeState> {
    const data = await this.rpc<unknown>(sessionPath, "plan_mode", { enabled });
    const state = parsePlanModeReply(data);
    if (!state) throw new Error("plan_mode: the daemon did not report the new state");
    return state;
  }

  /**
   * Move the conversation back to `entryId` IN THIS session file; nothing
   * new is created. For a user turn the conversation then ends just before
   * it, and `editorText` is that message, to amend and resend.
   */
  async treeGoto(sessionPath: string, entryId: string, options: TreeGotoOptions): Promise<TreeGotoResult> {
    const data = await this.rpc<Record<string, unknown> | null>(sessionPath, "tree_goto", { entryId, ...options });
    if (!data || typeof data.cancelled !== "boolean") throw new Error("tree_goto: the daemon did not report the outcome");
    return {
      cancelled: data.cancelled,
      aborted: data.aborted === true,
      askReanswerCommitted: data.askReanswerCommitted === true,
      ...(typeof data.editorText === "string" && data.editorText ? { editorText: data.editorText } : {}),
      ...(typeof data.error === "string" && data.error ? { error: data.error } : {}),
    };
  }

  /** Set (or with null/empty, clear) the label on a timeline entry; resolves to the label now held. */
  async treeLabel(sessionPath: string, entryId: string, label: string | null): Promise<string | null> {
    const trimmed = label?.trim() ?? "";
    const data = await this.rpc<Record<string, unknown> | null>(sessionPath, "tree_label", { entryId, label: trimmed || null });
    return typeof data?.label === "string" && data.label ? data.label : null;
  }

  /**
   * Branch at a user turn identified by its TEXT (and position as a fallback).
   *
   * `get_branch_messages` and `branch` share the session file's entry ids.
   * They used to come from an omp child, which re-mints ids on load, so a
   * transcript or `/api/tree` id could not be passed straight in; resolving
   * against `get_branch_messages` stays the one supported way in.
   */
  async branchAt(
    sessionPath: string,
    at: { text?: string; index?: number },
  ): Promise<{ sessionPath: string; text: string; cancelled: boolean }> {
    const messages = await this.getBranchMessages(sessionPath);
    if (messages.length === 0)
      throw new Error("branch: no user message to branch from");
    let pick = -1;
    if (
      typeof at.index === "number" &&
      at.index >= 0 &&
      at.index < messages.length
    )
      pick = at.index;
    if (typeof at.text === "string" && at.text.trim()) {
      const wanted = at.text.trim();
      const exact = messages.findIndex((m) => m.text.trim() === wanted);
      // Rows elide long text, so fall back to a prefix match before giving up.
      const prefix =
        exact === -1
          ? messages.findIndex((m) => m.text.trim().startsWith(wanted))
          : exact;
      if (prefix !== -1) pick = prefix;
    }
    if (pick < 0) throw new Error("branch: could not find that turn");
    return this.branch(sessionPath, messages[pick].entryId);
  }

  // ── Thinking / fast mode ─────────────────────────────────────────────
  async setThinkingLevel(sessionPath: string, level: string): Promise<void> {
    await this.rpc(sessionPath, "set_thinking_level", { level });
  }

  /** omp's `{levels}` for the session's live model (`off` included); see thinking-choices.ts. */
  async getAvailableThinkingLevels(sessionPath: string, signal?: AbortSignal): Promise<unknown> {
    return this.rpc<unknown>(sessionPath, "get_available_thinking_levels", {}, undefined, signal);
  }

  async setFastMode(sessionPath: string, enabled: boolean): Promise<void> {
    await this.rpc(sessionPath, "set_fast_mode", { enabled });
  }

  // ── User shell command abort ─────────────────────────────────────────
  /**
   * Cancel the session's running USER shell command (`/api/bash`, `!cmd`).
   * omp's `abort_bash` takes no params and never touches the agent's own
   * bash tool calls; those stop only with the turn (`/api/abort`).
   */
  async abortBash(sessionPath: string): Promise<void> {
    await this.rpc(sessionPath, "abort_bash", {});
  }

  // ── Subagents ─────────────────────────────────────────────────────────────
  async getSubagents(sessionPath: string): Promise<unknown> {
    return this.rpc(sessionPath, "get_subagents", {});
  }
  async steerSubagent(sessionPath: string, id: string, message: string): Promise<void> {
    await this.rpc(sessionPath, "steer_subagent", { subagentId: id, message });
  }
  async cancelSubagent(sessionPath: string, id: string): Promise<{ cancelled: boolean }> {
    return this.rpc(sessionPath, "cancel_subagent", { subagentId: id });
  }
  async getSubagentMessages(
    sessionPath: string,
    sel: { subagentId?: string; sessionFile?: string; fromByte?: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const params: Record<string, unknown> = {};
    if (sel.subagentId) params.subagentId = sel.subagentId;
    if (sel.sessionFile) params.sessionFile = sel.sessionFile;
    if (typeof sel.fromByte === "number") params.fromByte = sel.fromByte;
    return this.rpc(sessionPath, "get_subagent_messages", params, undefined, signal);
  }

  /** One-shot passive discovery, including bridge-owned desktop read leases. */
  async getDesktopAgentRoster(sessionPath: string, signal?: AbortSignal): Promise<DesktopAgentRosterPage> {
    const query = new URLSearchParams({ session: sessionPath });
    return this.fetchJson(`/api/agents/roster?${query}`, { signal });
  }

  /** Passive desktop read: never RPC/attach and never accepts an arbitrary file. */
  async getDesktopAgentTranscript(
    sessionPath: string,
    agentId: string,
    fromByte = 0,
    signal?: AbortSignal,
    expectedCreatedAt?: number,
    expectedConnectionId?: string,
  ): Promise<DesktopAgentTranscriptPage> {
    const query = new URLSearchParams({ session: sessionPath, agentId, fromByte: String(fromByte) });
    if (expectedCreatedAt !== undefined) query.set("expectedCreatedAt", String(expectedCreatedAt));
    if (expectedConnectionId !== undefined) query.set("expectedConnectionId", expectedConnectionId);
    return this.fetchJson(`/api/agents/transcript?${query}`, { signal });
  }

  /** A retained agent file beside the parent session: any agent, live or finished, with no host. */
  async getAgentFileTranscript(sessionPath: string, agentId: string, fromByte = 0, signal?: AbortSignal): Promise<DesktopAgentTranscriptPage> {
    const query = new URLSearchParams({ session: sessionPath, agentId, fromByte: String(fromByte) });
    return this.fetchJson(`/api/agents/file?${query}`, { signal });
  }

  async getDesktopAgentFollowUp(sessionPath: string, target: DesktopAgentFollowUpTarget, signal?: AbortSignal): Promise<DesktopAgentFollowUpAvailability> {
    return this.rpc(sessionPath, "get_desktop_agent_follow_up", target, undefined, signal);
  }

  /** Native collab chat; a socket handoff is not a callback acceptance receipt. */
  async sendDesktopAgentFollowUp(sessionPath: string, target: DesktopAgentFollowUpTarget, text: string): Promise<{ delivery: "handoff" }> {
    return this.rpc(sessionPath, "desktop_agent_follow_up", { ...target, text });
  }

  // ── Available commands ───────────────────────────────────────────────
  // GET /api/commands?session=  src/server/http.rs:2758 .route("/commands", get(commands))
  //                         handler src/server/http.rs:738 ok(json!({ "ok": true, "commands": cmds }))
  // Also available via RPC get_available_commands; the GET path stays available
  // when a terminal owns the session (see large doc-comment at 709-720).
  async getAvailableCommands(
    sessionPath: string,
  ): Promise<{ name: string; description?: string }[]> {
    const qs = `?session=${encodeURIComponent(sessionPath)}`;
    const data = await this.dedupedFetch<{
      ok: boolean;
      commands?: { name: string; description?: string }[];
    }>(`/api/commands${qs}`);
    return Array.isArray(data.commands) ? data.commands : [];
  }

  // ── File browser (session cwd) ───────────────────────────────────────
  // GET /api/files?session=&path=  src/server/http.rs:2768 .route("/files", get(files))
  //                            handler src/server/http.rs:1000 ok(json!({ "ok": true, "cwd": ..., "entries": entries }))
  // Contract signature is listFiles(path: string) where `path` is the sessionPath;
  // we also accept an optional second arg (relative path inside cwd) so callers
  // that already split session+rel keep working.
  async listFiles(
    path: string,
    relPath?: string,
  ): Promise<
    {
      name: string;
      path: string;
      type: "dir" | "file";
      size: number;
      mtime: number;
    }[]
  > {
    // Heuristic: if caller passed two args, first is sessionPath, second is rel.
    // If caller passed single arg containing no slash outside HOME, treat as sessionPath
    // with empty rel. We always send ?session=; optional &path= is the cwd-relative dir.
    const sessionPath = path;
    const rel = relPath ?? "";
    const qs = new URLSearchParams({ session: sessionPath });
    if (rel) qs.set("path", rel);
    const data = await this.dedupedFetch<{
      ok: boolean;
      entries?: FileEntry[];
    }>(`/api/files?${qs}`);
    return Array.isArray(data.entries) ? (data.entries as FileEntry[]) : [];
  }

  async searchFiles(
    sessionPath: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<{ entries: Pick<FileEntry, "name" | "path" | "type">[]; truncated: boolean }> {
    const qs = new URLSearchParams({ session: sessionPath, search: query });
    const data = await this.fetchJson<unknown>(`/api/files?${qs}`, { signal: readRequestSignal(signal) });
    if (!data || typeof data !== "object" || !("entries" in data) || !Array.isArray(data.entries) ||
        !("truncated" in data) || typeof data.truncated !== "boolean") {
      throw new Error("File search is unavailable");
    }
    const entries = data.entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string" ||
          !("path" in entry) || typeof entry.path !== "string" || !("type" in entry) || entry.type !== "file") {
        throw new Error("File search is unavailable");
      }
      return { name: entry.name, path: entry.path, type: "file" as const };
    });
    return { entries, truncated: data.truncated };
  }

  // GET /api/file?session=&path=  src/server/http.rs:2770 .route("/file", get(file)...)
  //                           handler src/server/http.rs:1091 json!({ "ok": true, "name":..., "path":rel, "size":..., "mtime":..., "binary":..., "truncated":..., "content":... })
  // Must surface binary/truncated/size rather than hiding them.
  async readFile(
    path: string,
    relPath?: string,
  ): Promise<FileContent> {
    const sessionPath = path;
    // Support readFile(sessionPath, fileRel) and readFile(sessionPath+":rel") styles.
    // If relPath is undefined, treat `path` as sessionPath and read cwd-root (empty file path);
    // callers that pass a combined string should instead pass two args. Single-arg with
    // "/"-separated session path still maps to ?session=<path>&path=  (empty rel = root).
    const rel = relPath ?? "";
    const qs = new URLSearchParams({ session: sessionPath });
    if (rel) qs.set("path", rel);
    const data = await this.dedupedFetch<{
      ok: boolean;
      name?: string;
      content?: string;
      binary?: boolean;
      truncated?: boolean;
      size?: number;
    }>(`/api/file?${qs}`);
    const preview: FileContent = {
      content: data.content ?? "",
      binary: Boolean(data.binary),
      truncated: Boolean(data.truncated),
      size: Number(data.size ?? 0),
    };
    if (typeof data.name === "string") preview.name = data.name;
    return preview;
  }

  /** Optional early feedback only: writeFile's server precondition is authoritative. */
  async verifyFileBaseline(sessionPath: string, path: string, expectedContent: string): Promise<void> {
    const qs = new URLSearchParams({ session: sessionPath, path });
    const response = await fetchWithDeadline(this.url(`/api/file?${qs}`), {
      headers: this.authHeaders({}),
    });
    if (response.status === 401 || response.status === 403) throw new Error("Authentication failed");
    const body = await readJsonResponse(response) as {
      ok?: boolean; content?: string; binary?: boolean; truncated?: boolean; error?: string;
    } | null;
    if (!response.ok || body?.ok === false) {
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    if (body?.binary || body?.truncated) throw new FileConflictError();
    if (typeof body?.content !== "string") {
      throw new Error("Couldn’t verify the latest file contents. Reload and try again.");
    }
    if (body.content !== expectedContent) throw new FileConflictError();
  }

  /** Mandatory compare-content precondition; null explicitly requests create-only. */
  async writeFile(sessionPath: string, path: string, content: string, expectedContent: string | null): Promise<void> {
    const request: FileWriteRequest = { sessionPath, path, content, expectedContent };
    const response = await fetch(this.url("/api/file"), {
      method: "POST",
      headers: this.authHeaders({ body: "" }),
      body: JSON.stringify(request),
    }).catch(() => {
      // Once dispatched, transport failure cannot prove the file was not saved.
      throw new Error("Couldn’t confirm the save. The file may have been saved; check it before trying again.");
    });
    if (response.status === 401 || response.status === 403) throw new Error("Authentication failed");
    const body = await response.json().catch(() => null) as { ok?: boolean; code?: string; error?: string } | null;
    if (response.status === 409 && body?.code === "file_conflict") throw new FileConflictError();
    if (!response.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${response.status}`);
    if (body?.ok !== true) {
      throw new Error("Couldn’t confirm the save. The file may have been saved; check it before trying again.");
    }
  }

  // ── Workspace changes (git) ──────────────────────────────────────────
  // GET /api/changes?session=[&summary=1]  src/server/http.rs .route("/changes", get(changes))
  //   handler src/server/http.rs `changes` → src/server/git_changes.rs `Changes` plus "ok": true
  // Not deduped: a caller refreshing after an edit must not join a stale
  // in-flight read. GET already carries the 20 s read deadline; the daemon
  // bounds its own git work at 15 s (10 s for a summary).
  async getChanges(sessionPath: string, signal?: AbortSignal): Promise<WorkspaceChanges> {
    const data = await this.fetchChanges<WorkspaceChanges>(sessionPath, false, signal);
    return { ...changesEnvelope(data), files: Array.isArray(data.files) ? data.files : [] };
  }

  /** Paths, status and line counts without patches: for counts such as the chat's `+a −r`. */
  async getChangesSummary(sessionPath: string, signal?: AbortSignal): Promise<WorkspaceChangesSummary> {
    const data = await this.fetchChanges<WorkspaceChangesSummary>(sessionPath, true, signal);
    return { ...changesEnvelope(data), files: Array.isArray(data.files) ? data.files : [] };
  }

  private fetchChanges<T>(sessionPath: string, summary: boolean, signal?: AbortSignal): Promise<Partial<T> & { ok: boolean }> {
    const qs = new URLSearchParams({ session: sessionPath });
    if (summary) qs.set("summary", "1");
    return this.fetchJson(`/api/changes?${qs}`, signal ? { signal } : {});
  }

  // ── Bash (ad-hoc shell) ───────────────────────────────────────────────
  // POST /api/bash  src/server/http.rs:2772 .route("/bash", post(bash))
  //             handler src/server/http.rs:1450 ok(json!({ "ok": true, "id": id, "result": result }))
  //             refusal src/server/http.rs:XXXX ok(json!({ "ok": false, "error": e, "code": "session_owned_by_terminal" }))
  async bash(
    sessionPath: string,
    command: string,
    /**
     * `excludeFromContext`: `!!cmd`, the output stays out of the
     * conversation's context. `runId`: names the run's live `bash_output`
     * frames (1-64 of `[A-Za-z0-9_-]`).
     */
    options: { excludeFromContext?: boolean; runId?: string } = {},
  ): Promise<{
    id?: string;
    result: {
      output: string;
      exitCode: number;
      truncated?: boolean;
      cancelled?: boolean;
    };
    ok?: boolean;
  }> {
    const data = await this.fetchJson<Record<string, unknown>>("/api/bash", {
      method: "POST",
      body: JSON.stringify({
        sessionPath,
        command,
        ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
      }),
    });
    // Daemon shapes: { ok:true, id, result:{output,exitCode,truncated,cancelled} } or { ok:true, result } or { ok:true, data }
    const rec = data as Record<string, unknown>;
    if ("result" in rec && rec.result !== undefined) {
      return {
        id: typeof rec.id === "string" ? rec.id : undefined,
        result: rec.result as {
          output: string;
          exitCode: number;
          truncated?: boolean;
          cancelled?: boolean;
        },
        ok: rec.ok === true,
      };
    }
    if ("data" in rec && rec.data !== undefined) {
      const inner = rec.data as Record<string, unknown>;
      if ("result" in inner)
        return {
          id: typeof inner.id === "string" ? inner.id : undefined,
          result: inner.result as never,
          ok: true,
        };
      return { result: inner as never, ok: true };
    }
    return { result: rec as never, ok: true };
  }

  // ── Slash command (prints text; never a chat message) ─────────────────
  // POST /api/command  src/server/http.rs `command`. Runs the builtin locally in omp
  // and returns what it printed. Nothing is queued, so no user bubble and no
  // transcript entry (POST /api/prompt would write the text into the chat).
  async runCommand(sessionPath: string, text: string): Promise<{ output: string; agentInvoked: boolean }> {
    const data = await this.fetchJson<{ output?: unknown; agentInvoked?: unknown }>("/api/command", {
      method: "POST",
      body: JSON.stringify({ sessionPath, text }),
    });
    return { output: typeof data.output === "string" ? data.output : "", agentInvoked: data.agentInvoked === true };
  }

  // ── Export (HTML download) ────────────────────────────────────────────
  // POST /api/export  src/server/http.rs `export_session`. omp renders the export
  // into the daemon's state dir; the bytes come back as an attachment and the
  // file is deleted. A refusal is the usual JSON error body.
  async exportHtml(sessionPath: string): Promise<{ blob: Blob; fileName: string }> {
    const init: RequestInit = { method: "POST", body: JSON.stringify({ sessionPath }) };
    const res = await fetchWithDeadline(this.url("/api/export"), { ...init, headers: this.authHeaders(init) });
    // Anything but the HTML is the daemon's JSON refusal or error.
    if (!res.ok || !(res.headers.get("Content-Type") ?? "").startsWith("text/html")) {
      await this.readDaemonJson(res, "/api/export");
      throw new Error(`HTTP ${res.status}`);
    }
    const fileName = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "conversation.html";
    return { blob: await res.blob(), fileName };
  }

  // ── Delete a conversation ─────────────────────────────────────────────
  // POST /api/session/delete  src/server/http.rs `delete_session`: omp's own
  // `/session delete`, refused while anyone else may write the session.
  async deleteSession(sessionPath: string): Promise<void> {
    await this.fetchJson("/api/session/delete", { method: "POST", body: JSON.stringify({ sessionPath }) });
  }

  // ── Collab attach / detach ────────────────────────────────────────────
  // POST /api/collab/attach  src/server/http.rs:2783 .route("/collab/attach", post(collab_attach))
  //                      handler src/server/http.rs:XXXX ok(json!({ "ok": true })) or ok(json!({ "ok": false, "error": e }))
  // POST /api/collab/detach  src/server/http.rs:2784 .route("/collab/detach", post(collab_detach))
  async collabAttach(sessionPath: string, link?: string): Promise<void> {
    const body: Record<string, unknown> = { sessionPath };
    if (link !== undefined) body.link = link;
    await this.fetchJson("/api/collab/attach", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async collabDetach(sessionPath: string): Promise<void> {
    await this.fetchJson("/api/collab/detach", {
      method: "POST",
      body: JSON.stringify({ sessionPath }),
    });
  }

  // ── Open on laptop (herdr handoff) ────────────────────────────────────
  // POST /api/desktop/open  src/server/http.rs .route("/desktop/open", post(desktop_open))
  //                     handler src/terminal/handoff.rs `Opened::to_json`; refusals are
  //                     {ok:false, error:<sentence>, code} and throw here.
  // Slow by nature: it waits for omp to boot in the new tab (~3 s measured).
  async openOnLaptop(sessionPath: string): Promise<LaptopOpened> {
    return this.fetchJson<LaptopOpened>("/api/desktop/open", {
      method: "POST",
      body: JSON.stringify({ sessionPath }),
    });
  }
  // Close only the verified laptop omp owner; refusals stay typed for the
  // confirmation dialog, while HTTP errors are surfaced by fetchJson.
  async closeOnLaptop(sessionPath: string): Promise<{
    ok: boolean;
    closed?: boolean;
    processExited?: boolean;
    historyPreserved?: boolean;
    error?: string;
    code?: string;
  }> {
    return this.fetchJson("/api/desktop/close", {
      method: "POST",
      body: JSON.stringify({ sessionPath }),
    });
  }

  // ── Per-session settings RPCs (ownership-gated) ───────────────────────
  // Each mirrors packages/coding-agent/src/modes/rpc/rpc-types.ts parameter shapes exactly.
  // set_steering_mode { mode: "all" | "one-at-a-time" }
  async setSteeringMode(
    sessionPath: string,
    mode: "all" | "one-at-a-time",
  ): Promise<void> {
    await this.rpc(sessionPath, "set_steering_mode", { mode });
  }
  // set_follow_up_mode { mode: "all" | "one-at-a-time" }
  async setFollowUpMode(
    sessionPath: string,
    mode: "all" | "one-at-a-time",
  ): Promise<void> {
    await this.rpc(sessionPath, "set_follow_up_mode", { mode });
  }
  // set_interrupt_mode { mode: "immediate" | "wait" }
  async setInterruptMode(
    sessionPath: string,
    mode: "immediate" | "wait",
  ): Promise<void> {
    await this.rpc(sessionPath, "set_interrupt_mode", { mode });
  }
  // set_auto_compaction { enabled: boolean }
  async setAutoCompaction(
    sessionPath: string,
    enabled: boolean,
  ): Promise<void> {
    await this.rpc(sessionPath, "set_auto_compaction", { enabled });
  }
  // set_auto_retry { enabled: boolean }
  async setAutoRetry(sessionPath: string, enabled: boolean): Promise<void> {
    await this.rpc(sessionPath, "set_auto_retry", { enabled });
  }
  // compact { customInstructions?: string }
  async compact(
    sessionPath: string,
    customInstructions?: string,
  ): Promise<unknown> {
    const params: Record<string, unknown> = {};
    if (customInstructions) params.customInstructions = customInstructions;
    return this.rpc(sessionPath, "compact", params);
  }

  // ── Transcribe (voice dictation) ───────────────────────────────────────
  // POST /api/transcribe  src/server/http.rs:1715-1740 async fn transcribe(...)
  //   let Some(b64) = body.get("audio").and_then(|v| v.as_str()) else { BAD_REQUEST "audio (base64) required" };
  //   let mime = body.get("mime").and_then(|v| v.as_str()).unwrap_or("audio/webm");
  //   let audio = STANDARD.decode(b64) => 400 "bad base64 audio: {e}";
  //   match state.asr.transcribe(&audio, mime).await {
  //     Ok(t) => ok(json!({"ok":true,"text":t.text,"ms":t.decode_ms,"audioMs":t.audio_ms,"model":t.model})),
  //     Err(e) => ok(json!({"ok":false,"error":e})),
  //   }
  // Request shape is JSON { audio: base64(STANDARD), mime: string } — NOT
  // multipart nor raw body. Response is { ok:true, text, ms, audioMs, model }
  // or { ok:false, error }. See src/server/http.rs:1715-1740.
  private blobToBase64(blob: Blob): Promise<string> {
    let resolve!: (value: string) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the recording."));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const comma = dataUrl.indexOf(",");
      if (comma < 0) reject(new Error("Could not encode the recording."));
      else resolve(dataUrl.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
    return promise;
  }

  /**
   * Transcribe a recorded audio blob.
   * The blob's own type is sent as `mime`; audio is base64(STANDARD) in JSON
   * field `audio` — matching src/server/http.rs:1717 `body.get("audio")` exactly.
   */
  async transcribe(blob: Blob, signal?: AbortSignal): Promise<string> {
    if (blob.size === 0) throw new Error("No audio captured — try again.");
    // Build { audio, mime } per src/server/http.rs:1717-1723 — do not guess multipart.
    // Send the blob's real mimeType (Chrome Android: audio/webm;codecs=opus), not a hardcoded string.
    const audio = await this.blobToBase64(blob);
    const mime = blob.type || "audio/webm";
    const data = await this.fetchJson<{
      ok: boolean;
      text?: string;
      error?: string;
    }>("/api/transcribe", {
      method: "POST",
      body: JSON.stringify({ audio, mime }),
      signal,
    });
    if (data.ok !== true) {
      const msg =
        typeof data.error === "string" && data.error.trim()
          ? data.error.trim()
          : "Transcription failed.";
      throw new Error(msg);
    }
    if (typeof data.text === "string") return data.text;
    return "";
  }

  // POST /api/transcribe/warm  src/server/http.rs transcribe_warm → { ok:true, ready }
  // Starts the daemon's speech model loading while the user is still speaking;
  // the daemon keeps it only briefly after dictation because it costs ~1.3 GiB.
  // Best-effort: a failure only means the transcription pays the load itself.
  async warmTranscriber(): Promise<void> {
    try {
      await this.fetchJson("/api/transcribe/warm", { method: "POST" });
    } catch {
      // ignored: /api/transcribe reports any real problem
    }
  }

  // ── Version ──────────────────────────────────────────────────────────
  // GET /api/version  src/server/http.rs:2760 .route("/version", get(version))
  //               handler src/server/http.rs:2352 ok(json!({ "ok": true, "version": assets::build_id() }))
  // Exposed for completeness; not in the minimal contract but harmless.

  // ── VAPID / Push ─────────────────────────────────────────────────────
  // GET /api/push/vapid-public-key  src/server/http.rs:2780 .route("/push/vapid-public-key", get(vapid_public_key))
  //                             handler src/server/http.rs:1743 ok(json!({ "ok": true, "publicKey": ... }))
  async vapidPublicKey(): Promise<string> {
    const data = await this.dedupedFetch<{ ok: boolean; publicKey?: string }>(
      "/api/push/vapid-public-key",
    );
    return data.publicKey ?? "";
  }

  // POST /api/push/subscribe  src/server/http.rs:2781 .route("/push/subscribe", post(push_subscribe))
  //                       handler expects { subscription:{ endpoint, keys:{p256dh,auth} } }
  async pushSubscribe(subscription: unknown): Promise<void> {
    await this.fetchJson("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription }),
    });
  }

  // POST /api/push/unsubscribe  src/server/http.rs:2782 .route("/push/unsubscribe", post(push_unsubscribe))
  //                         handler expects { endpoint }
  async pushUnsubscribe(endpoint: string): Promise<void> {
    await this.fetchJson("/api/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    });
  }

  // The position rejects a question that already moved on. A complete handoff
  // is transport evidence only, never a receipt from OMP's question callback.
  async answerPane(sessionPath: string, text: string, position?: AskPosition | { terminalOnly: true }): Promise<{ delivery?: "handoff" | "held"; answered?: number }> {
    return this.fetchJson<{ delivery?: "handoff" | "held"; answered?: number }>("/api/panes/answer", {
      method: "POST",
      body: JSON.stringify({
        sessionPath,
        text,
        ...(position && "terminalOnly" in position ? { terminalOnly: true } : position ? { askId: position.id, questionIndex: position.index, optionIndex: position.optionIndex } : {}),
      }),
    });
  }
}
export class CommandDeliveryError extends Error {
  override name = "CommandDeliveryError";
  readonly receipt: CommandReceipt;

  constructor(receipt: CommandReceipt) {
    super(receipt.error ?? "The command was rejected");
    this.receipt = receipt;
  }
}

function transientDeliveryError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("network") ||
    message.includes("failed to fetch") ||
    message.includes("load failed") ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

/**
 * Durable convenience path for secondary send surfaces (edit/resend,
 * message-actions and model commands). The command is persisted before the
 * first HTTP attempt and retries retain its original commandId.
 */
export async function sendPromptDurably(
  sessionPath: string,
  text: string,
  images: readonly { data: string; mimeType: string }[] = [],
  options: { token?: string; baseUrl?: string; commandId?: string; onSaved?: () => void } = {},
): Promise<CommandReceipt> {
  const token = options.token ?? readPairingToken() ?? "";
  const namespace = offlineQueueNamespaceForCredential(token);
  const api = new DaemonApi(token, options.baseUrl);
  let dispatchSessionPath = sessionPath;
  if (options.commandId) {
    const existing = await getQueued(options.commandId, namespace);
    if (!existing)
      throw new Error("This saved command is no longer available.");
    dispatchSessionPath = existing.sessionPath;
    if (!usesNativeOutbox() && existing.state !== "saved") {
      // A missing receipt after handoff is not permission to dispatch again.
      // Status checks never turn an uncertain command back into new work.
      const isCurrent = captureQueueScope(namespace);
      const response = await api.getReceipt(existing);
      if (!response) throw new Error("The server has no receipt. Delivery remains uncertain; nothing was resent.");
      const applied = await applyReceipt(existing, response, namespace, isCurrent);
      if (!applied?.receipt) throw new Error("This saved command is no longer available.");
      const receipt = applied.receipt;
      if (deliveryFailed(receipt)) throw new CommandDeliveryError(receipt);
      return receipt;
    }
  }
  await assertNoPendingEdit(dispatchSessionPath, namespace);
  const retainedImages = options.commandId
    ? await getImages(options.commandId, namespace)
    : [];
  const entry = await enqueue({
    sessionPath,
    text,
    images: options.commandId ? retainedImages : images,
    commandId: options.commandId,
    namespace,
  });
  options.onSaved?.();
  if (usesNativeOutbox()) {
    // Native enqueue has already scheduled delivery. Do not make a saved
    // secondary-surface send look unsaved if a later status request times out.
    const receipt = entry.receipt ?? {
      commandId: entry.commandId, sessionPath, state: entry.state,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, error: entry.error,
    };
    // A retry of an existing command is not a draft send, so it has no
    // standing to release the composer's save-attempt identity: the composer
    // may still hold this very payload, and a fresh UUID for it would run
    // the message twice. Only the composer, once its drafts are verified
    // cleared, acknowledges the save.
    if (!options.commandId) acknowledgeNativeSave(entry, namespace);
    if (deliveryFailed(receipt)) throw new CommandDeliveryError(receipt);
    return receipt;
  }
  const isCurrent = captureQueueScope(namespace);
  await flush(
    async (queued: QueuedPrompt, signal: AbortSignal) => {
      const queuedImages = await getImages(queued.commandId, namespace);
      return api.prompt(
        queued.sessionPath,
        queued.text,
        queuedImages,
        queued.commandId,
        signal,
        () => assertDispatchCurrent(queued, namespace, isCurrent),
        queued.delivery,
      );
    },
    { isTransient: transientDeliveryError, namespace },
  );
  const updated = await getQueued(entry.commandId, namespace);
  if (updated?.receipt) {
    if (deliveryFailed(updated))
      throw new CommandDeliveryError(updated.receipt);
    return updated.receipt;
  }
  return {
    commandId: entry.commandId,
    sessionPath,
    state: updated?.state === "saved" ? "saved" : "uncertain",
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
    error:
      updated?.state === "saved"
        ? undefined
        : "Delivery could not be confirmed.",
  };
}

export interface StartSessionOptions {
  /** Absolute directory on the computer; must exist (`/api/new` answers 400 "invalid cwd"). */
  cwd: string;
  /** Resume a failed first-message attempt without creating another session. */
  sessionPath?: string;
  /** Applied before the first prompt; omit to keep the computer's default model. */
  model?: { provider: string; id: string };
  /** With `model`: applied and verified together. Alone: `set_thinking_level`. */
  thinkingLevel?: string;
  /** First message; omit to only create (and configure) the session. */
  prompt?: string;
  attachments?: readonly { data: string; mimeType: string }[];
  token?: string;
  baseUrl?: string;
}

export interface StartSessionResult {
  sessionPath: string;
  /** Present when a prompt or attachments were sent; same contract as `sendPromptDurably`. */
  receipt?: CommandReceipt;
}

/**
 * The session exists, but a later step failed. Settings/save failures still
 * belong to the input surface: keep its text and images and retry this same
 * session. A prompt-stage failure happened after durable enqueue; the outbox
 * owns it and the draft must not be resent as a new command.
 */
export class StartSessionError extends Error {
  override name = "StartSessionError";
  readonly sessionPath: string;
  readonly stage: "settings" | "save" | "prompt";

  constructor(sessionPath: string, stage: "settings" | "save" | "prompt", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.sessionPath = sessionPath;
    this.stage = stage;
  }
}

/**
 * New session from the composer: create in `cwd`, apply model/thinking, then
 * send the first message. Chained over the existing endpoints because the
 * daemon keeps the child that `/api/new` booted registered under the new
 * session path, so `set_model` and the prompt land on that same process —
 * the order the session settings sheet already relies on after "New session".
 * Settings go first so the first turn runs on the chosen model. The prompt
 * goes through the durable outbox like every secondary send surface.
 */
export async function startSession(options: StartSessionOptions): Promise<StartSessionResult> {
  const token = options.token ?? readPairingToken() ?? "";
  const api = new DaemonApi(token, options.baseUrl);
  const sessionPath = options.sessionPath ?? (await api.newSession(options.cwd)).sessionPath;
  try {
    if (options.model) {
      await api.setModel(sessionPath, options.model.provider, options.model.id, options.thinkingLevel);
    } else if (options.thinkingLevel !== undefined) {
      await api.setThinkingLevel(sessionPath, options.thinkingLevel);
    }
  } catch (error) {
    throw new StartSessionError(sessionPath, "settings", error);
  }
  const text = options.prompt ?? "";
  const attachments = options.attachments ?? [];
  if (!text && attachments.length === 0) return { sessionPath };
  let saved = false;
  try {
    const receipt = await sendPromptDurably(sessionPath, text, attachments, {
      token,
      baseUrl: options.baseUrl,
      onSaved: () => { saved = true; },
    });
    return { sessionPath, receipt };
  } catch (error) {
    throw new StartSessionError(sessionPath, saved ? "prompt" : "save", error);
  }
}

/** Where `POST /api/desktop/open` put a conversation (src/terminal/handoff.rs `Opened::to_json`). */
export interface LaptopOpened {
  ok: true;
  workspace: { id: string; label: string; created: boolean };
  tab: { id: string; label: string; number?: number | null };
  pane: string;
  /** omp reached its prompt; false while it boots or waits on a dialog there. */
  ready: boolean;
  /** The laptop's extension connected back, so sends go through the laptop. */
  bridged: boolean;
}

/** Which question of a multi-question `ask` an answer is for. */
export interface AskPosition {
  id: string;
  index: number;
  optionIndex?: number;
}

export async function answerPane(
  sessionPath: string,
  text: string,
  position?: AskPosition | { terminalOnly: true },
): Promise<{ delivery?: "handoff" | "held"; answered?: number }> {
  const token = readPairingToken() ?? "";
  const api = new DaemonApi(token);
  return api.answerPane(sessionPath, text, position);
}
