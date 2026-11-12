/**
 * Typed mirrors of the daemon HTTP wire (`src/server/http.rs`).
 *
 * Every interface field name is taken verbatim from the `json!` macro in its
 * handler — see the quoted line above each type. The daemon's global
 * convention: success → HTTP 200 with the value directly, error → HTTP 200
 * with `{ ok: false, error: string, code?: string }` unless noted (auth).
 */

import type { PromptDelivery } from "../domain/send-mode";
import type { ModelFallback } from "../domain/model-fallback";

// ─── Search ───────────────────────────────────────────────────────────────

// src/server/http.rs:2591  ok(json!({ "ok": true, "hits": hits }))
// src/server/http.rs search_file  json!({ "path", "title", "line", "role", "offset", "entryId"? })
export interface SearchHit {
  path: string;
  title?: string;
  line: string;
  role?: string;
  offset?: number;
  /** The matched journal entry's id; opening the hit lands on it. */
  entryId?: string;
}

// src/server/http.rs search — wrapper. `truncated`: the daemon's caps (newest 200
// sessions, last 512 KiB of each) left text unsearched, so "no match" is not
// proof of absence; `scannedFiles` is how many sessions were opened.
export interface SearchResponse {
  ok: boolean;
  hits?: SearchHit[];
  scannedFiles?: number;
  truncated?: boolean;
  error?: string;
}

/** One message search as the sessions screen shows it. */
export interface MessageSearch {
  hits: SearchHit[];
  truncated: boolean;
  scannedFiles: number;
}

// ─── Browse (home directory picker) ────────────────────────────────────

// src/server/http.rs:1057  ok(json!({ "ok": true, "path": dir.to_string_lossy(), "parent": parent, "dirs": dirs }))
// src/server/http.rs:1040  json!({ "name": name, "path": ent.path().to_string_lossy() })
export interface BrowseDirEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: BrowseDirEntry[];
}

export interface BrowseResponse {
  ok: boolean;
  path?: string;
  parent?: string | null;
  dirs?: BrowseDirEntry[];
  error?: string;
}

// ─── Model catalogue ───────────────────────────────────────────────────

// RPC `get_available_models` returns `{ models: [{provider,id,name,thinking}] }` or bare `[...]`
// — `DaemonApi.getAvailableModels` tolerates both.
export interface ModelThinkingInfo {
  /** Provider transport; informational to the picker. */
  mode?: string;
  /** Exact user-facing reasoning efforts supported by this model. */
  efforts?: string[];
  /** Model's configured default effort, when one is reported. */
  defaultLevel?: string;
  /** Reasoning cannot be switched off upstream; omp's `off` uses the lowest effort. */
  requiresEffort?: boolean;
  /** Auto is not offered until OMP has verified a model's reasoning surface. */
  unverified?: boolean;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  /** Context window in tokens (omp's model catalogue). */
  contextWindow?: number;
  /** Family and version of the model ("opus", "5.5.0"); the best release-order signal the catalogue has. */
  identity?: { class?: string; family?: string; revision?: string };
  reasoning?: boolean;
  thinking?: ModelThinkingInfo;
}

export interface ModelsData {
  models?: ModelInfo[];
}

// ─── Session state (RPC `get_state`) ───────────────────────────────────

// ChildManager caches these from the child's `get_state` response; the daemon
// re-exposes them verbatim under `data` (src/server/http.rs:1695 `ok(json!({ "ok": true, "data": d }))`).
export interface SessionState {
  /** "file" when the daemon answered from a passive read of the session file (no live child or owner). */
  source?: string;
  sessionName?: string;
  sessionFile?: string;
  sessionId?: string;
  // Mirrors RpcSessionState from packages/coding-agent/src/modes/rpc/rpc-types.ts
  //
  // `model` is an OBJECT here (rpc-mode.ts:1077 `model: session.model`), not a
  // string. Typing it as a string made every `typeof x === "string"` guard fall
  // through: the model picker marked nothing as current and the header showed
  // no model at all. Kept as a union because session LISTING rows do carry a
  // plain string.
  model?: string | { provider?: string; id?: string; name?: string };
  thinkingLevel?: string;
  /** Pulse file/desktop bridge metadata; not a native OMP get_state field. */
  configuredThinkingLevel?: string;
  modelFallback?: ModelFallback | null;
  isStreaming?: boolean;
  streaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: "all" | "one-at-a-time" | null;
  followUpMode?: "all" | "one-at-a-time" | null;
  interruptMode?: "immediate" | "wait" | null;
  settingsReadOnly?: boolean;
  autoCompactionEnabled?: boolean;
  // Not emitted by current daemon get_state but accepted via set_auto_retry;
  // kept optional so missing value renders as "not reported".
  autoRetryEnabled?: boolean;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  collabAttached?: boolean;
  // omp's ContextUsage is {tokens, contextWindow, percent}
  // (extensibility/extensions/types.ts:370). `usedTokens`/`maxTokens` were
  // invented here and are permanently undefined.
  contextUsage?: {
    percent?: number;
    tokens?: number;
    contextWindow?: number;
  };
  /** Native-clock lower bound for the context snapshot, not its HTTP delivery time. */
  contextMeasuredAfter?: number;
  messageCount?: number;
  queuedMessageCount?: number;
  // omp 18.8.6 RpcSessionState (rpc-types.ts). `/slow` applies to the active
  // model only when `slowModeSupported`; `slowModeEnabled` is false otherwise.
  slowModeSupported?: boolean;
  slowModeEnabled?: boolean;
  /** Where `/slow` lives: `global` persists to config shared by every chat. */
  slowModeScope?: "session" | "global";
  /** A background job or delivery can still wake the session. */
  hasPendingAsyncWork?: boolean;
  /** The whole todo board, including `/todo` edits (`TodoPhase[]`). */
  todoPhases?: unknown;
}

// ─── File browser (session cwd) ────────────────────────────────────────

// src/server/http.rs:1000  ok(json!({ "ok": true, "cwd": target.to_string_lossy(), "entries": entries }))
// src/server/http.rs:982   json!({ "name": name, "path": entry_rel, "type": etype, "size": size, "mtime": mtime })
export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
}

export interface FilesResponse {
  ok: boolean;
  cwd?: string;
  entries?: FileEntry[];
  error?: string;
}

// src/server/http.rs:1091  json!({ "ok": true, "name": ..., "path": rel, "size": meta.len(), "mtime": ..., "binary": binary, "truncated": meta.len() > MAX_FILE_READ })
// src/server/http.rs:1101  out["content"] = json!(String::from_utf8_lossy(&buf))  — only when !binary
export interface FileContent {
  name?: string;
  path?: string;
  size: number;
  mtime?: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

export interface FileResponse {
  ok: boolean;
  name?: string;
  path?: string;
  size?: number;
  mtime?: number;
  binary?: boolean;
  truncated?: boolean;
  content?: string;
  error?: string;
}

/** POST /api/file: omission is refused; null is an explicit create-only save. */
export interface FileWriteRequest {
  sessionPath: string;
  path: string;
  content: string;
  expectedContent: string | null;
}

// ─── Workspace changes (git, session cwd) ───────────────────────────────

// GET /api/changes?session=[&summary=1]  src/server/http.rs `changes` → src/server/git_changes.rs `Changes`
export type WorkspaceChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
export type WorkspaceUnmergedStatus = "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU";

/** One changed file without its patch (`summary=1`). */
export interface WorkspaceFileSummary {
  /** Relative to `repoRoot`, `/`-separated, as git reports it. */
  path: string;
  /** Only on `renamed`. */
  oldPath?: string;
  status: WorkspaceChangeStatus;
  /** Git's unresolved index status, independent of conflict markers in the file. */
  unmerged?: WorkspaceUnmergedStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface WorkspaceChangedFile extends WorkspaceFileSummary {
  /** Unified diff including its `diff --git` header; may be cut (see `patchTruncated`). */
  patch: string;
  /** The per-file or total cap cut this patch at a line boundary, or dropped it. */
  patchTruncated: boolean;
}

/** Sums over every changed file git reported, including files past the list cap. */
export interface WorkspaceChangeTotals {
  files: number;
  additions: number;
  deletions: number;
}

export interface WorkspaceChangesSummary {
  cwd: string;
  repoRoot: string | null;
  /** null on a detached HEAD or outside a repository. */
  branch: string | null;
  notRepo: boolean;
  files: WorkspaceFileSummary[];
  totals: WorkspaceChangeTotals;
  /** Some cap bit: the file list, a patch or an untracked line count (then a lower bound) is incomplete. */
  truncated: boolean;
}

export interface WorkspaceChanges extends WorkspaceChangesSummary {
  files: WorkspaceChangedFile[];
}

// ─── Awaiting ───────────────────────────────────────────────────────────

// src/server/http.rs:2378  ok(json!({ "ok": true, "sessions": sessions }))
export interface AwaitingResponse {
  ok: boolean;
  sessions?: string[];
  error?: string;
}

// ─── New session ────────────────────────────────────────────────────────

// src/server/http.rs:1539  ok(json!({ "ok": true, "sessionPath": session_path }))
export interface NewSessionResponse {
  ok: boolean;
  sessionPath?: string;
  error?: string;
}

export interface NewSessionRequest {
  cwd: string;
}

// ─── RPC ────────────────────────────────────────────────────────────────

// src/server/http.rs:1695  ok(json!({ "ok": true, "data": d }))
// src/server/http.rs:1699  ok(json!({ "ok": false, "error": e, "code": "session_owned_by_terminal" }))
export interface RpcRequest {
  sessionPath: string;
  command: string;
  params?: Record<string, unknown>;
}

export interface RpcSuccessResponse<T = unknown> {
  ok: true;
  data: T;
}

export interface RpcErrorResponse {
  ok: false;
  error: string;
  code?: string;
}

export type RpcResponse<T = unknown> = RpcSuccessResponse<T> | RpcErrorResponse;
// ─── Command receipts / durable prompt delivery ─────────────────────────

export type CommandReceiptState =
  | "saved"
  | "accepted"
  | "dispatching"
  | "forwarded"
  | "received"
  | "running"
  | "completed"
  | "failed"
  | "uncertain";

export interface CommandReceipt {
  commandId: string;
  sessionPath: string;
  state: CommandReceiptState;
  createdAt: number;
  updatedAt: number;
  code?: string;
  error?: string;
}

export interface PromptRequest {
  commandId: string;
  sessionPath: string;
  text: string;
  images?: { data: string; mimeType: string }[];
  /** How a send joins a running turn; absent = steer (src/omp/child.rs `PromptDelivery`). */
  delivery?: PromptDelivery;
}

export interface ReceiptBinding {
  version: 1;
  requestedSessionPath: string;
  canonicalSessionPath: string;
}

/** Untrusted persisted evidence is validated together with the retained intent. */
export interface ReceiptIntent {
  commandId: string;
  sessionPath: string;
  receipt?: CommandReceipt;
  receiptBinding?: unknown;
}

export interface PromptResponse {
  ok: true;
  receipt: CommandReceipt;
  receiptBinding: ReceiptBinding;
}

export interface ReceiptsResponse {
  ok: true;
  receipts: CommandReceipt[];
}

export interface ReceiptResponse extends PromptResponse {}

// ─── Branch / timeline ─────────────────────────────────────────────────

export interface BranchMessage {
  entryId: string;
  text: string;
}

export interface AvailableCommand {
  name: string;
  description?: string;
}

// GET /api/commands?session=
// src/server/http.rs:738  ok(json!({ "ok": true, "commands": cmds }))
export interface CommandsResponse {
  ok: boolean;
  commands?: AvailableCommand[];
  error?: string;
}

// ─── Version / VAPID ───────────────────────────────────────────────────

// src/server/http.rs:2352  ok(json!({ "ok": true, "version": assets::build_id() }))
export interface VersionResponse {
  capabilities?: string[];
  ok: boolean;
  version?: string;
  protocolVersion?: number;
  minClientProtocolVersion?: number;
  error?: string;
}

// src/server/http.rs:1743  ok(json!({ "ok": true, "publicKey": state.push.vapid_public_key() }))
export interface VapidResponse {
  ok: boolean;
  publicKey?: string;
  error?: string;
}

// ─── Push subscribe ────────────────────────────────────────────────────

export interface PushSubscribeRequest {
  sessionPath: string;
  subscription: unknown;
}

export interface PushUnsubscribeRequest {
  sessionPath: string;
  endpoint: string;
}

// ─── Generic error ─────────────────────────────────────────────────────

export interface ErrorResponse {
  ok: false;
  error: string;
  code?: string;
}
