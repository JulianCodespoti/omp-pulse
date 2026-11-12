// omp-pulse child helper extension
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { OwnerQueueAccess, type QueueOwner } from "./pulse-queue.ts";

/**
 * Phone-only TUI parity for omp children the omp-pulse daemon drives.
 *
 * omp's RPC protocol has no plan mode, no in-place tree navigation, no entry
 * labels and no `!!` (bash kept out of the model's context). The TUI does all
 * four through internals it owns. This file is passed with `-e` ONLY to the
 * daemon's own `--mode rpc-ui` children (src/omp/child.rs), never to the user's
 * terminal omp, and exposes each capability as a slash command the daemon
 * sends as an RPC `prompt`:
 *
 *   /pulse-plan  <reqId> {"enabled":bool}
 *   /pulse-goto  <reqId> {"entryId":string}
 *   /pulse-label <reqId> {"entryId":string,"label":string|null}
 *   /pulse-bash  <reqId> {"command":string,"excludeFromContext"?:bool,"stream"?:string}
 *
 * Extension commands produce no RPC output of their own, so every reply goes
 * back as a fire-and-forget `setStatus` UI frame keyed `omp-pulse:<reqId>`;
 * the daemon intercepts those frames and never forwards them to the phone.
 * A running `/pulse-bash` with a `stream` also sends its output, throttled,
 * as `setStatus` frames keyed `omp-pulse-out:<stream>` (RPC `bash` has no
 * output stream); the daemon re-sends those as `bash_output` events.
 *
 * What is official and what is not (omp 18.8.6):
 * - official: `ctx.navigateTree`, `ctx.sessionManager` (the live
 *   SessionManager: appendLabelChange/appendModeChange/appendCustomEntry),
 *   `ctx.ui.select`, session lifecycle events.
 * - UNOFFICIAL: plan mode and `!!` need the live AgentSession, which no
 *   extension API exposes. It is reached through the host's own module
 *   namespace (`pi.pi.AgentRegistry.global().get(agentId).session`), the
 *   same singleton omp registers every session in. Every access is
 *   feature-detected; a missing method fails that one command with a
 *   sentence the phone shows, never a crash of the agent.
 */

const REPLY_KEY_PREFIX = "omp-pulse:";
const OUTPUT_KEY_PREFIX = "omp-pulse-out:";
/** One live-output frame per interval at most. */
const OUTPUT_INTERVAL_MS = 100;
/** Unsent output kept between frames; older text is dropped first. */
const OUTPUT_MAX_PENDING = 64 * 1024;
const DEFAULT_PLAN_FILE = "local://PLAN.md";
/** Custom entry appended after an in-place move; see `goto` below. */
const GOTO_MARKER = "omp-pulse-goto";
const APPROVE = "Approve and run";
const APPROVE_COMPACT = "Approve and compact context";
const APPROVE_FRESH = "Approve with fresh context";
const KEEP_PLANNING = "Keep planning";
const DISCARD = "Discard";
const PLAN_PREVIEW_LINES = 8;

/**
 * omp's plan-mode compaction guidance (prompts/system/plan-mode-compact-instructions.md,
 * 18.8.6), which the TUI's "Approve and compact context" hands the summarizer.
 */
export function planCompactGuidance(planFilePath: string): string {
  return [
    "Prepare to execute approved plan.",
    "",
    "MUST distill plan-mode discussion.",
    "Preserve:",
    "- Plan rationale; explicitly rejected alternatives.",
    "- Key decisions; driving constraints.",
    "- Discovered files, symbols, code paths executor needs.",
    "- User preferences expressed during planning.",
    "",
    "Drop:",
    "- Tool-call noise (file reads, searches) if result captured in plan or plan-mode discussion.",
    "- Superseded plan drafts.",
    "- Context restated in plan file.",
    "",
    `Approved plan file: \`${planFilePath}\`; authoritative source of truth. MUST preserve this durable path; the plan body is re-inlined for the executor after compaction, so NEVER restate it in the summary.`,
  ].join("\n");
}

/** A running command's live-output batcher (see `liveOutput`). */
export type LiveOutput = { push: (chunk: string) => void; stop: () => void };

/**
 * Batches a running command's output chunks into at most one `emit` per
 * `intervalMs`, keeping only the newest `maxPending` characters a slow
 * interval collects. `stop()` drops what is unsent and emits nothing more:
 * the command's reply carries the whole output.
 */
export function liveOutput(
  emit: (text: string) => void,
  intervalMs = OUTPUT_INTERVAL_MS,
  maxPending = OUTPUT_MAX_PENDING,
): LiveOutput {
  let pending = "";
  let scheduled = false;
  let stopped = false;
  const flush = () => {
    scheduled = false;
    if (stopped || !pending) return;
    const text = pending;
    pending = "";
    emit(text);
  };
  return {
    push(chunk) {
      if (stopped || !chunk) return;
      pending += chunk;
      if (pending.length > maxPending) pending = pending.slice(pending.length - maxPending);
      if (scheduled) return;
      scheduled = true;
      setTimeout(flush, intervalMs);
    },
    stop() {
      stopped = true;
      pending = "";
    },
  };
}

type Reply = Record<string, unknown>;
type Ui = ExtensionContext["ui"];

type PlanState = { enabled: boolean; planFilePath: string; workflow?: string; reentry?: boolean };
type ToolPresentation = { enabled: string[]; mounted: string[] };


type AskResult = { content: unknown[]; details?: Record<string, unknown>; isError?: boolean };
type TreeOptions = {
  summarize: boolean;
  customInstructions?: string;
  allowAskReopen?: boolean;
  reanswerAskResult?: AskResult;
};
type TreeResult = {
  cancelled: boolean;
  aborted?: boolean;
  editorText?: string;
  reopenAsk?: { toolCallId: string; questions: unknown[] };
  askReanswerCommitted?: boolean;
};
/** The AgentSession surface this file uses. All of it is internal. */
type LiveSession = QueueOwner & {
  isStreaming?: boolean;
  queuedMessageCount?: number;
  subscribe?: (listener: (event: { type: string }) => void) => () => void;
  newSession?: (options?: { parentSession?: string; sessionDir?: string }) => Promise<boolean>;
  switchSession?: (path: string) => Promise<boolean>;
  prompt?: (text: string, options: { synthetic: true }) => Promise<void>;
  markPlanReferenceSent?: () => void;
  markPlanInternalAbortPending?: () => void;
  clearPlanInternalAbortPending?: () => void;
  model?: PlanModel;
  configuredThinkingLevel?: () => string | undefined;
  isFastModeEnabled?: () => boolean;
  isUltrafastModeEnabled?: () => boolean;
  resolveRoleModelWithThinking?: (role: string) => { model?: PlanModel; thinkingLevel?: string; explicitThinkingLevel?: boolean };
  setModelTemporary?: (model: PlanModel, thinkingLevel?: string) => Promise<void>;
  setThinkingLevel?: (level: string | undefined) => unknown;
  getRoleModelCycle?: (roles: string[]) => { models: PlanRoleModel[]; currentIndex: number } | undefined;
  applyRoleModel?: (choice: PlanRoleModel) => Promise<void>;
  setActiveToolPresentation?: (enabled: string[], mounted: string[]) => Promise<void>;
  settings?: { rawValue?: (setting: { segments: string[]; definition: object }) => unknown };
  scopedModels?: Array<{ model: { provider: string; id: string; name?: string } }>;
  modelRegistry?: { getAvailable?: () => Array<{ provider: string; id: string; name?: string }> };
  findMentionableModel?: (selector: string) => unknown;
  navigateTree?: (entryId: string, options: TreeOptions) => Promise<TreeResult>;
  abortBranchSummary?: () => void;
  buildAskReanswerContext?: (ui: Ui) => unknown;
  resumeAfterAskReanswer?: () => void;
  getPlanModeState?: () => PlanState | undefined;
  setPlanModeState?: (state: PlanState | undefined) => void;
  setPlanProposalHandler?: (handler: ((title: string) => Promise<unknown>) | null) => void;
  preparePlanForReview?: (title: string) => Promise<{ details?: { planFilePath?: string; title?: string } }>;
  getPlanReferencePath?: () => string;
  setPlanReferencePath?: (path: string) => void;
  getEnabledToolNames?: () => string[];
  getMountedXdevToolNames?: () => string[];
  hasBuiltInTool?: (name: string) => boolean;
  setActiveToolsByName?: (names: string[]) => Promise<void>;
  restoreNonMCPToolPresentation?: (enabled: string[], mounted: string[]) => Promise<void>;
  sendPlanModeContext?: (options: { deliverAs: "steer" }) => Promise<void>;
  runModeExitTeardown?: (teardown: () => Promise<void>) => Promise<void>;
  abort?: (options?: { reason?: string }) => Promise<void>;
  getGoalModeState?: () => { enabled?: boolean } | undefined;
  promptTemplates?: ReadonlyArray<{ name: string; description?: string }>;
  executeBash?: (
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean; useUserShell?: boolean },
  ) => Promise<unknown>;
};

/** A journal entry, reduced to the fields `draftOf` reads. */
type Entry = {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: { role?: string; content?: unknown; toolName?: string; toolCallId?: string };
  content?: unknown;
};

/** The SessionManager surface this file uses (typed read-only upstream). */
type Manager = {
  getEntry?: (id: string) => Entry | undefined;
  appendLabelChange?: (targetId: string, label: string | undefined) => string;
  appendModeChange?: (mode: string, data?: Record<string, unknown>) => string;
  appendCustomEntry?: (customType: string, data?: unknown) => string;
  buildSessionContext?: () => { mode?: string; modeData?: Record<string, unknown>; models?: Record<string, unknown> };
  getArtifactsDir?: () => string | undefined;
  getCwd?: () => string;
  getSessionFile?: () => string | undefined;
  flush?: () => Promise<void>;
};

class PhoneError extends Error {}

type PlanModel = { provider: string; id: string; name?: string };
type PlanModelState = { model: PlanModel; thinkingLevel: string | undefined };
type PlanRoleModel = { role: string; model: PlanModel; thinkingLevel?: string; explicitThinkingLevel?: boolean };
/** An own thinkingLevel restores even undefined; an absent property does not override reasoning. */
type PendingPlanModel = { model: PlanModel; thinkingLevel?: string | undefined; role?: PlanRoleModel; restoreBeforeRole?: PlanModelState };

/** Per-session plan bookkeeping the session itself does not keep. */
type PlanMemory = {
  saved?: ToolPresentation;
  original?: PlanModelState;
  pending?: PendingPlanModel;
  entered: boolean;
};

/** The members of the host's module namespace (`pi.pi`) this file reads. */
type HostNamespace = {
  AgentRegistry?: { global?: () => { get?: (id: string) => { session?: unknown } | undefined } };
  USER_INTERRUPT_LABEL?: string;
  recoverAskQuestions?: (args: unknown) => unknown[] | undefined;
  AskTool?: new (session: {
    cwd: string;
    hasUI: true;
    settings: NonNullable<LiveSession["settings"]>;
    getSessionFile: () => string | null;
    getSessionSpawns: () => null;
    getPlanModeState: () => PlanState | undefined;
  }) => {
    execute: (id: string, args: { questions: unknown[] }, signal: AbortSignal | undefined, update: undefined, context: unknown) => Promise<AskResult>;
  };
};

/**
 * Native AgentSession expands the first template with a matching name.
 * Keep discovery metadata only; template bodies remain with OMP.
 */
export function commandTemplates(session: Pick<LiveSession, "promptTemplates">): Reply[] {
  if (!Array.isArray(session.promptTemplates)) {
    throw new PhoneError("This omp version can't list prompt templates from the phone.");
  }
  const seen = new Set<string>();
  return session.promptTemplates.filter(template => {
    if (!template.name || seen.has(template.name)) return false;
    seen.add(template.name);
    return true;
  }).map(template => ({
    name: template.name,
    description: template.description,
    input: { hint: "arguments" },
    source: "prompt",
  }));
}

/** Removal is already committed: fit its receipt without losing recovered text. */
export function fitQueueRemovalReply(reply: Reply, reqId: string, maxBytes = 64 * 1024 * 1024): Reply {
  if (!Array.isArray(reply.images) || reply.images.length === 0) return reply;
  // setStatus JSON-encodes the reply string again. Account for that outer
  // envelope and conservatively reserve a 64-character native event id.
  const envelope = JSON.stringify({
    type: "extension_ui_request", id: "9".repeat(64), method: "setStatus",
    statusKey: `${REPLY_KEY_PREFIX}${reqId}`, statusText: JSON.stringify(reply),
  });
  if (Buffer.byteLength(envelope, "utf8") <= maxBytes) return reply;
  const { images: _images, ...textReply } = reply;
  return { ...textReply, imagesDropped: true };
}

const READ_ONLY_CONTROLS: Record<string, true> = {
  "pulse-prompt-config": true,
  "pulse-model-mention-choices": true,
  "pulse-command-templates": true,
  "pulse-queue-state": true,
};

export default function ompPulseChild(pi: ExtensionAPI): void {
  pi.on("retry_fallback_applied", (event, ctx) => {
    // Native OMP records the model switch but not the recovery explanation.
    // Keep a non-prompt journal entry so returning readers can explain it.
    pi.appendEntry("omp-pulse-model-fallback", event);
    publishModelState(ctx, liveSession(ctx));
  });

  const planMemory = new WeakMap<object, PlanMemory>();
  const queueAccess = new OwnerQueueAccess();
  let unsubscribeQueue: (() => void) | undefined;
  // The proposal handler runs inside a tool call, long after the command
  // that armed plan mode returned; it asks the phone through the newest UI
  // context any handler has seen (rpc-mode hands every context the same one).
  let ui: Ui | undefined;
  let nextDialogScope = 0;
  const scopedDialog = async <T>(ask: Ui, open: () => Promise<T>): Promise<T> => {
    const scope = String(++nextDialogScope);
    // RPC emits the select request synchronously before its promise yields.
    // These private markers therefore bind its exact native ID, not a later
    // command/turn heuristic, and completion is actual callback settlement.
    ask.setStatus("omp-pulse-dialog-scope", JSON.stringify({ phase: "begin", scope }));
    try { return await open(); }
    finally { ask.setStatus("omp-pulse-dialog-scope", JSON.stringify({ phase: "end", scope })); }
  };
  // "Approve and compact context" approved inside the propose tool call; the
  // compaction must wait until that turn ends (compacting mid-turn would abort
  // the very tool call delivering the approval).
  let compactAfterTurn: { session: LiveSession; path: string; execution?: PlanRoleModel; stopped?: Promise<boolean> } | undefined;
  let runAfterTurn: {
    session: LiveSession; ctx: ExtensionContext; path: string;
    execution?: PlanRoleModel; original?: PlanModelState; stopped?: Promise<boolean>;
  } | undefined;
  let freshAfterTurn: {
    session: LiveSession; ctx: ExtensionContext; path: string; source: string;
    content: string; execution?: PlanRoleModel; original: PlanModelState;
    tools: ToolPresentation; state: PlanState;
    stopped?: Promise<boolean>;
  } | undefined;
  let freshTransition = false;
  let lifecycle = 0;
  let activePlanSession: LiveSession | undefined;
  let treeMovePending = false;

  // `pi.pi` is typed as the whole package namespace; only these members are
  // used, and each is feature-detected before use.
  const api = pi as unknown as { pi?: HostNamespace };
  const host = api.pi;

  const liveSession = (ctx: ExtensionContext): LiveSession => {
    const id = ctx.agent?.id ?? "Main";
    let session: unknown;
    try {
      session = host?.AgentRegistry?.global?.()?.get?.(id)?.session;
    } catch {
      session = undefined;
    }
    if (!session || typeof session !== "object") {
      throw new PhoneError("This omp version can't do that from the phone yet.");
    }
    return session as LiveSession;
  };

  const publishModelState = (ctx: ExtensionContext, session: LiveSession): void => {
    if (!session.configuredThinkingLevel) return;
    const branch = ctx.sessionManager.getBranch?.();
    let modelFallback: Record<string, unknown> | null | undefined;
    if (branch) {
      modelFallback = null;
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "custom" || entry.customType !== "omp-pulse-model-fallback"
            || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
        const at = Date.parse(entry.timestamp);
        modelFallback = { ...entry.data, entryId: entry.id, ...(Number.isFinite(at) ? { at } : {}) };
        break;
      }
    }
    // A restored Auto selector may not emit a thinking change. The owner's
    // branch view also recovers reasons older than a bounded daemon index.
    ctx.ui.setStatus("omp-pulse-thinking", JSON.stringify({
      configuredThinkingLevel: session.configuredThinkingLevel() ?? "",
      ...(modelFallback !== undefined ? { modelFallback } : {}),
    }));
  };
  const publishQueueState = (ctx: ExtensionContext, session: LiveSession): void => {
    const snapshot = queueAccess.snapshot(session);
    if (snapshot) ctx.ui.setStatus("omp-pulse-queue", JSON.stringify(snapshot));
  };


  const requireMethods = <K extends keyof LiveSession>(session: LiveSession, ...names: K[]): void => {
    for (const name of names) {
      if (typeof session[name] !== "function") {
        throw new PhoneError("This omp version can't do that from the phone yet.");
      }
    }
  };

  // abort() stops the native loop synchronously, before its first await.
  // Do not await it inside the proposal tool (it waits for that tool to
  // settle), but do await its cleanup before changing models or prompting.
  const stopForApproval = (session: LiveSession, ask: Ui, cancel: () => void): Promise<boolean> => {
    session.markPlanInternalAbortPending!();
    return session.abort!().then(
      () => true,
      (error: unknown) => {
        cancel();
        ask.notify(`Could not stop planning for approval: ${String(error)}`, "warning");
        return false;
      },
    ).finally(() => session.clearPlanInternalAbortPending!());
  };

  const manager = (ctx: ExtensionContext): Manager => ctx.sessionManager as unknown as Manager;

  const memoryFor = (session: LiveSession): PlanMemory => {
    let memory = planMemory.get(session);
    if (!memory) {
      memory = { entered: false };
      planMemory.set(session, memory);
    }
    return memory;
  };

  const planEnabled = (session: LiveSession): boolean => session.getPlanModeState?.()?.enabled === true;

  /** Read a plan file for the approval preview; best effort, never throws. */
  const readPlan = async (ctx: ExtensionContext, planFilePath: string): Promise<string | null> => {
    const sm = manager(ctx);
    let file: string | undefined;
    if (planFilePath.startsWith("local://")) {
      // omp's local:// root is `<artifacts>/local` (internal-urls
      // resolveLocalRoot); without an artifacts dir the preview is skipped.
      const artifacts = sm.getArtifactsDir?.();
      if (artifacts) file = join(artifacts, "local", planFilePath.slice("local://".length));
    } else if (!planFilePath.includes("://")) {
      file = isAbsolute(planFilePath) ? planFilePath : join(sm.getCwd?.() ?? ctx.cwd, planFilePath);
    }
    if (!file) return null;
    try {
      return await readFile(file, "utf8");
    } catch {
      return null;
    }
  };

  const planPreview = (content: string | null): string => {
    if (!content) return "";
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    const head = lines.slice(0, PLAN_PREVIEW_LINES).join("\n");
    return lines.length > PLAN_PREVIEW_LINES ? `${head}\n…` : head;
  };

  const sameModel = (a: PlanModel | undefined, b: PlanModel): boolean =>
    a?.provider === b.provider && a.id === b.id;

  const modelState = (session: LiveSession): PlanModelState | undefined =>
    session.model ? { model: session.model, thinkingLevel: session.configuredThinkingLevel!() } : undefined;

  const applyModel = async (session: LiveSession, target: PendingPlanModel): Promise<void> => {
    const memory = memoryFor(session);
    if (target.role) {
      if (session.isStreaming) {
        memory.pending = target;
        return;
      }
      if (target.restoreBeforeRole) await applyModel(session, target.restoreBeforeRole);
      await session.applyRoleModel!(target.role);
    } else if (sameModel(session.model, target.model)) {
      if ("thinkingLevel" in target) session.setThinkingLevel!(target.thinkingLevel);
    } else if (session.isStreaming) {
      memory.pending = target;
      return;
    } else {
      await session.setModelTemporary!(target.model, target.thinkingLevel);
      // Native setModelTemporary(undefined) preserves/re-resolves reasoning; only
      // setThinkingLevel(undefined) actually restores the saved unset setting.
      if ("thinkingLevel" in target && target.thinkingLevel === undefined) session.setThinkingLevel!(undefined);
    }
    memory.pending = undefined;
  };

  /** Native exit is transactional: failed tool/model restoration keeps planning usable. */
  const tearDown = async (
    ctx: ExtensionContext,
    session: LiveSession,
    persist: boolean,
    options: { deferModelRestore?: boolean; preserveRestoredModel?: boolean } = {},
  ): Promise<void> => {
    const memory = memoryFor(session);
    const state = session.getPlanModeState?.();
    const currentModel = modelState(session);
    const tools = session.getEnabledToolNames!();
    const mounted = session.getMountedXdevToolNames!();
    const pending = memory.pending;
    session.setPlanModeState!(undefined);
    try {
      if (memory.saved) {
        await session.restoreNonMCPToolPresentation!(memory.saved.enabled, memory.saved.mounted);
      }
      memory.pending = undefined;
      if (memory.original && !options.deferModelRestore && !options.preserveRestoredModel) {
        await applyModel(session, memory.original);
      }
    } catch (error) {
      session.setPlanModeState!(state);
      memory.pending = pending;
      if (currentModel && (!sameModel(session.model, currentModel.model) ||
          session.configuredThinkingLevel!() !== currentModel.thinkingLevel)) {
        try { await applyModel(session, currentModel); } catch (rollbackError) {
          (ui ?? ctx.ui).notify(`Could not restore planning model: ${String(rollbackError)}`, "warning");
        }
      }
      try { await session.setActiveToolPresentation!(tools, mounted); } catch (rollbackError) {
        (ui ?? ctx.ui).notify(`Could not restore planning tools: ${String(rollbackError)}`, "warning");
      }
      throw error;
    }
    session.setPlanProposalHandler!(null);
    memory.saved = undefined;
    if (!options.deferModelRestore) memory.original = undefined;
    if (persist) {
      manager(ctx).appendModeChange?.("none");
      await manager(ctx).flush?.().catch(() => undefined);
    }
  };

  const executionChoices = (session: LiveSession): PlanRoleModel[] => {
    requireMethods(session, "getRoleModelCycle", "applyRoleModel");
    if (typeof session.settings?.rawValue !== "function") {
      throw new PhoneError("Planning model configuration is unavailable in this omp version.");
    }
    // cfgCycleOrder is not exported by the 18.8.6 SDK. Read its actual setting;
    // only the registered role-order default is mirrored, never model choices.
    const configured = session.settings.rawValue({ segments: ["cycleOrder"], definition: {} });
    const roles = configured === undefined ? ["smol", "default", "slow"] : configured;
    if (!Array.isArray(roles) || !roles.every((role): role is string => typeof role === "string")) {
      throw new PhoneError("The configured model cycle order is invalid.");
    }
    const cycle = session.getRoleModelCycle!(roles);
    if (!cycle || cycle.models.length <= 1) return [];
    const preferred = cycle.models.findIndex((choice) => choice.role === "default");
    const index = preferred >= 0 ? preferred : cycle.currentIndex;
    return [...cycle.models.slice(index), ...cycle.models.slice(0, index)];
  };

  const chooseExecution = async (session: LiveSession, ask: Ui): Promise<PlanRoleModel | null | undefined> => {
    const choices = executionChoices(session);
    if (!choices.length) return undefined;
    const labels = choices.map((choice) =>
      `${choice.role}: ${choice.model.name || choice.model.id}${choice.explicitThinkingLevel && choice.thinkingLevel !== undefined ? ` (${choice.thinkingLevel})` : ""}`);
    const selected = await scopedDialog(ask, () => ask.select("Continue with execution model", labels));
    const index = labels.indexOf(selected ?? "");
    if (index < 0) return null;
    const choice = choices[index];
    const original = memoryFor(session).original;
    // The native default-role preference doesn't override the saved reasoning
    // unless that role explicitly configures a different thinking level.
    if (original && sameModel(original.model, choice.model) &&
        (!choice.explicitThinkingLevel || choice.thinkingLevel === original.thinkingLevel)) return undefined;
    return choice;
  };

  const applyExecution = async (session: LiveSession, execution: PlanRoleModel | undefined, ask: Ui): Promise<void> => {
    if (!execution) return;
    try {
      const pending = memoryFor(session).pending;
      await applyModel(session, {
        model: execution.model,
        role: execution,
        restoreBeforeRole: pending && !pending.role && "thinkingLevel" in pending
          ? { model: pending.model, thinkingLevel: pending.thinkingLevel } : undefined,
      });
    } catch (error) {
      ask.notify(`Could not switch to the ${execution.role} model: ${String(error)}`, "warning");
    }
  };

  const exitPlan = async (ctx: ExtensionContext, session: LiveSession, persist: boolean): Promise<void> => {
    if (!planEnabled(session)) return;
    // A mid-turn exit interrupts the turn, as the TUI does: the plan-mode
    // prompt tells the model to keep planning, so a live turn would resume
    // on the stale instructions with write access.
    if (session.isStreaming) {
      requireMethods(session, "runModeExitTeardown", "abort");
      await session.runModeExitTeardown!(async () => {
        await session.abort!({ reason: host?.USER_INTERRUPT_LABEL });
        await tearDown(ctx, session, persist);
      });
      return;
    }
    await tearDown(ctx, session, persist);
  };

  const handleProposal = async (ctx: ExtensionContext, session: LiveSession, title: string): Promise<unknown> => {
    const proposalGeneration = lifecycle;
    const reviewedSource = manager(ctx).getSessionFile?.();
    requireMethods(session, "preparePlanForReview");
    // Validates that the plan file exists and resolves the title; throws the
    // agent-facing ToolError itself when it does not.
    const review = await session.preparePlanForReview!(title);
    const details = review?.details ?? {};
    const state = session.getPlanModeState?.();
    const planFilePath = details.planFilePath || state?.planFilePath || DEFAULT_PLAN_FILE;
    const planTitle = details.title || title;
    if (state?.enabled && state.planFilePath !== planFilePath) {
      // The next planning turn must target the plan just reviewed.
      session.setPlanModeState?.({ ...state, planFilePath });
      manager(ctx).appendModeChange?.("plan", { planFilePath });
    }
    const preview = planPreview(await readPlan(ctx, planFilePath));
    const ask = ui ?? ctx.ui;
    const choice = await scopedDialog(ask, () => ask.select(`Plan ready: ${planTitle}${preview ? `\n\n${preview}` : ""}`, [
      { label: APPROVE, description: "Leave plan mode and start the work" },
      { label: APPROVE_COMPACT, description: "Summarize the planning talk first, then start the work" },
      { label: APPROVE_FRESH, description: "Start a new conversation with only the approved plan; retain this planning conversation" },
      { label: KEEP_PLANNING, description: "Stay in plan mode; reply with changes" },
      { label: DISCARD, description: "Leave plan mode without running it" },
    ]));
    const execution = choice === APPROVE || choice === APPROVE_COMPACT || choice === APPROVE_FRESH
      ? await chooseExecution(session, ask) : undefined;
    if (execution === null) {
      return {
        content: [{ type: "text", text: "Execution model selection cancelled. Stay in plan mode and wait for the user's next message." }],
        details: { planFilePath, title: planTitle, planExists: true },
      };
    }
    if ((choice === APPROVE || choice === APPROVE_COMPACT || choice === APPROVE_FRESH || choice === DISCARD) &&
        (proposalGeneration !== lifecycle || manager(ctx).getSessionFile?.() !== reviewedSource)) {
      throw new PhoneError("The planning session changed while approval was open. Review the plan again.");
    }
    if (choice === APPROVE_FRESH) {
      requireMethods(session, "newSession", "switchSession", "prompt", "markPlanReferenceSent",
        "markPlanInternalAbortPending", "clearPlanInternalAbortPending", "abort", "setPlanReferencePath");
      const sm = manager(ctx);
      const source = sm.getSessionFile?.();
      const original = memoryFor(session).original ?? modelState(session);
      const content = await readPlan(ctx, planFilePath);
      if (!source || !sm.getArtifactsDir?.() || !original || !state || !content || typeof ask.confirm !== "function") {
        throw new PhoneError("Fresh-context approval is unavailable: the original session and durable plan must be accessible.");
      }
      if (typeof session.queuedMessageCount !== "number" || session.queuedMessageCount > 0) {
        throw new PhoneError("Finish or remove queued messages before approving a plan with fresh context.");
      }
      if (proposalGeneration !== lifecycle || source !== reviewedSource || freshAfterTurn) {
        throw new PhoneError("The planning session changed while approval was open. Review the plan again.");
      }
      if (!await ask.confirm("omp-pulse-plan-transition",
        `omp-pulse:${JSON.stringify({ phase: "probe", from: source, to: source })}`, { timeout: 10000 })) {
        throw new PhoneError("This daemon cannot safely follow a fresh planning session. No work was started.");
      }
      if (proposalGeneration !== lifecycle || sm.getSessionFile?.() !== source) {
        throw new PhoneError("The planning session changed while approval was open. Review the plan again.");
      }
      freshAfterTurn = {
        session, ctx, path: planFilePath, source, content, execution, original,
        state: { ...state },
        tools: memoryFor(session).saved ?? {
          enabled: session.getEnabledToolNames!().filter((name) => !name.startsWith("mcp__")),
          mounted: session.getMountedXdevToolNames!().filter((name) => !name.startsWith("mcp__")),
        },
      };
      const pending = freshAfterTurn;
      pending.stopped = stopForApproval(session, ask, () => {
        if (freshAfterTurn === pending) freshAfterTurn = undefined;
      });
      return {
        content: [{ type: "text", text: "Plan approved for a fresh conversation. Stop now; implementation will start there with the approved plan only." }],
        details: { planFilePath, title: planTitle, planExists: true },
      };
    }
    if (choice === APPROVE) {
      requireMethods(session, "prompt", "abort", "markPlanInternalAbortPending", "clearPlanInternalAbortPending", "setPlanReferencePath");
      runAfterTurn = {
        session, ctx, path: planFilePath, execution,
        original: memoryFor(session).original ?? modelState(session),
      };
      const pending = runAfterTurn;
      pending.stopped = stopForApproval(session, ask, () => {
        if (runAfterTurn === pending) runAfterTurn = undefined;
      });
      return {
        content: [{ type: "text", text: `Plan approved at ${planFilePath}. Stop the planning turn now. Implementation starts in a new turn after the selected execution model and reasoning have been applied.` }],
        details: { planFilePath, title: planTitle, planExists: true },
      };
    }
    if (choice === APPROVE_COMPACT) {
      requireMethods(session, "abort", "markPlanInternalAbortPending", "clearPlanInternalAbortPending");
      await tearDown(ctx, session, true, { deferModelRestore: true });
      // Pinned before compaction so the plan is re-inlined on the next prompt
      // (AgentSession's plan reference), as the TUI does.
      session.setPlanReferencePath?.(planFilePath);
      compactAfterTurn = { session, path: planFilePath, execution };
      const pending = compactAfterTurn;
      pending.stopped = stopForApproval(session, ask, () => {
        if (compactAfterTurn === pending) compactAfterTurn = undefined;
      });
      return {
        content: [
          {
            type: "text",
            text: `Plan approved at ${planFilePath}. Plan mode exited. The context is compacted next and execution starts in a new turn: stop now without further tool calls.`,
          },
        ],
        details: { planFilePath, title: planTitle, planExists: true },
      };
    }
    if (choice === DISCARD) {
      await tearDown(ctx, session, true);
      return {
        content: [
          {
            type: "text",
            text: "The user discarded this plan and left plan mode. Do not implement it. Stop here and wait for their next message.",
          },
        ],
        details: { planFilePath, title: planTitle, planExists: true },
      };
    }
    // Keep planning, or the dialog was dismissed: plan mode stays on. The
    // TUI waits for feedback here too; telling the model to stop keeps it
    // from re-proposing the same plan in a loop while the phone is away.
    return {
      content: [
        {
          type: "text",
          text: `The user wants to keep refining the plan. Stop now and wait for their feedback; then update ${planFilePath} and propose again.`,
        },
      ],
      details: { planFilePath, title: planTitle, planExists: true },
    };
  };

  /** Enter with native role resolution and a single saved pre-plan model. */
  const enterPlan = async (
    ctx: ExtensionContext,
    session: LiveSession,
    options: { persist: boolean; planFilePath?: string; preserveRestoredModel?: boolean },
  ): Promise<void> => {
    if (planEnabled(session)) return;
    requireMethods(session, "setPlanModeState", "setPlanProposalHandler", "getEnabledToolNames",
      "getMountedXdevToolNames", "setActiveToolsByName", "setActiveToolPresentation",
      "restoreNonMCPToolPresentation", "configuredThinkingLevel", "resolveRoleModelWithThinking",
      "setModelTemporary", "setThinkingLevel", "getRoleModelCycle", "applyRoleModel");
    if (session.isStreaming) requireMethods(session, "sendPlanModeContext");
    if (session.getGoalModeState?.()?.enabled) {
      throw new PhoneError("Finish or pause the goal first.");
    }
    const memory = memoryFor(session);
    const resolved = options.preserveRestoredModel ? undefined : session.resolveRoleModelWithThinking!("plan");
    const original = resolved?.model ? modelState(session) : undefined;
    const planFilePath = options.planFilePath || session.getPlanReferencePath?.() || DEFAULT_PLAN_FILE;
    const previousTools = session.getEnabledToolNames!();
    const previousMounted = session.getMountedXdevToolNames!();
    // The plan prompt drafts the plan with `write` and approval itself is a
    // `write` to xd://propose; only the BUILT-IN write qualifies (a shadowing
    // extension tool would bypass plan mode's read-only guard).
    const planTools = session.hasBuiltInTool?.("write") ? ["write"] : [];
    const previousState = session.getPlanModeState?.();
    // State before tools: under Code Mode the direct surface keeps `write`
    // only while plan mode says it needs it (TUI ordering).
    session.setPlanModeState!({
      enabled: true,
      planFilePath,
      workflow: "parallel",
      reentry: memory.entered,
    });
    try {
      await session.setActiveToolsByName!([...new Set([...previousTools, ...planTools])]);
    } catch (error) {
      session.setPlanModeState!(previousState);
      throw error;
    }
    memory.saved = {
      enabled: previousTools.filter((name) => !name.startsWith("mcp__")),
      mounted: previousMounted.filter((name) => !name.startsWith("mcp__")),
    };
    session.setPlanProposalHandler!((title) => handleProposal(ctx, session, title));
    activePlanSession = session;
    memory.pending = undefined;
    memory.original = original;
    try {
      if (session.isStreaming) await session.sendPlanModeContext!({ deliverAs: "steer" });
    } catch (error) {
      await tearDown(ctx, session, false);
      throw error;
    }
    if (resolved?.model) {
      try {
        const target: PendingPlanModel = { model: resolved.model };
        if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined) {
          target.thinkingLevel = resolved.thinkingLevel;
        }
        await applyModel(session, target);
      } catch (error) {
        (ui ?? ctx.ui).notify(`Failed to switch to plan model for plan mode: ${String(error)}`, "warning");
      }
    }
    memory.entered = true;
    if (options.persist) {
      manager(ctx).appendModeChange?.("plan", { planFilePath });
      await manager(ctx).flush?.().catch(() => undefined);
    }
  };

  /**
   * RPC never restores plan mode from the journal (the TUI does on resume).
   * The phone derives plan state from the newest mode_change on the current
   * branch, so the live session is made to agree with it whenever the
   * branch or the session changes: a respawned child, a switch, a tree move.
   */
  const reconcile = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
    ui = ctx.ui;
    if (freshTransition) return;
    const agent = ctx.agent;
    if (agent && agent.kind !== "main") return;
    lifecycle++;
    compactAfterTurn = undefined;
    runAfterTurn = undefined;
    freshAfterTurn = undefined;
    try {
      const session = liveSession(ctx);
      publishModelState(ctx, session);
      unsubscribeQueue?.();
      const generation = lifecycle;
      unsubscribeQueue = session.subscribe?.(event => {
        if (event.type === "queue_update" && generation === lifecycle) publishQueueState(ctx, session);
      });
      publishQueueState(ctx, session);
      const context = manager(ctx).buildSessionContext?.();
      if (!context) return;
      // Native lifecycle restoration already selected the destination journal's
      // model. Never replace it with the branch we just left's temporary model.
      const previous = activePlanSession;
      if (previous) {
        memoryFor(previous).pending = undefined;
        if (planEnabled(previous)) {
          await tearDown(ctx, previous, false, {
            preserveRestoredModel: previous !== session || Object.keys(context.models ?? {}).length > 0,
          });
        } else {
          memoryFor(previous).original = undefined;
        }
      }
      activePlanSession = session;
      if (context.mode === "plan") {
        const planFilePath = typeof context.modeData?.planFilePath === "string" ? context.modeData.planFilePath : undefined;
        await enterPlan(ctx, session, { persist: false, planFilePath, preserveRestoredModel: true });
      }
    } catch (error) {
      ctx.ui.notify(`Could not restore plan mode: ${String(error)}`, "warning");
    }
  };

  /** Native fresh approval copies local artifacts, not the planning transcript. */
  const copyLocalFiles = async (source: string, destination: string): Promise<void> => {
    await mkdir(destination, { recursive: true });
    let entries;
    try {
      entries = await readdir(source, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      if (entry.isDirectory()) await copyLocalFiles(from, to);
      else if (entry.isFile()) await copyFile(from, to);
    }
  };

  const startFreshPlan = async (fresh: NonNullable<typeof freshAfterTurn>): Promise<void> => {
    const { session, ctx, source } = fresh;
    const sm = manager(ctx);
    const ask = ui ?? ctx.ui;
    const sourceArtifacts = sm.getArtifactsDir?.();
    if (!sourceArtifacts || sm.getSessionFile?.() !== source || session.isStreaming) return;
    const generation = lifecycle;
    // The daemon must exclusively fence this child BEFORE newSession changes
    // its file. An older daemon cannot acknowledge this private channel.
    const transition = (phase: "begin" | "finish", to = source, follow = false) =>
      ask.confirm("omp-pulse-plan-transition", `omp-pulse:${JSON.stringify({ phase, from: source, to, follow })}`);
    if (!await transition("begin")) {
      ask.notify("Fresh-context approval could not reserve this session. No implementation was started.", "warning");
      return;
    }
    let reserved = true;
    let dispatched = false;
    const planningModel = modelState(session);
    const planningTools = {
      enabled: session.getEnabledToolNames!(),
      mounted: session.getMountedXdevToolNames!(),
    };
    try {
      if (generation !== lifecycle || sm.getSessionFile?.() !== source || session.isStreaming) return;
      if (session.queuedMessageCount !== 0) {
        ask.notify("Fresh-context approval was cancelled because another message is queued. The planning conversation is retained.", "warning");
        return;
      }
      freshTransition = true;
      // A resumed file can live outside SessionManager's default encoded-cwd
      // directory. Native newSession forwards sessionDir to its manager; pin
      // it to this daemon-owned source directory rather than widening routing.
      if (!await session.newSession!({ sessionDir: dirname(source) })) return;
      const destination = sm.getSessionFile?.();
      const artifacts = sm.getArtifactsDir?.();
      if (!destination || destination === source || !artifacts || artifacts === sourceArtifacts) {
        throw new PhoneError("omp did not create a distinct session and artifact directory.");
      }
      await copyLocalFiles(join(sourceArtifacts, "local"), join(artifacts, "local"));
      // Pin the exact approved body after copying, like the native TUI.
      // An external plan gets a local copy so implementation cannot rewrite
      // the original planning artifact through the carried reference.
      const planPath = fresh.path.startsWith("local://") ? fresh.path : DEFAULT_PLAN_FILE;
      const planFile = join(artifacts, "local", planPath.slice("local://".length));
      await mkdir(dirname(planFile), { recursive: true });
      await writeFile(planFile, fresh.content, "utf8");
      session.setPlanModeState!(undefined);
      session.setPlanProposalHandler!(null);
      const tools = fresh.tools.enabled.includes("read") ? fresh.tools.enabled : [...fresh.tools.enabled, "read"];
      await session.restoreNonMCPToolPresentation!(tools, fresh.tools.mounted);
      await applyModel(session, fresh.original);
      // Unlike the keep-context path, a failed executor change MUST NOT
      // dispatch work with a different model.
      if (fresh.execution) await session.applyRoleModel!(fresh.execution);
      session.setPlanReferencePath!(planPath);
      sm.appendCustomEntry?.("omp-pulse-approved-plan", {
        sourceSession: source, sourcePlanPath: fresh.path, planFilePath: planPath,
      });
      await sm.flush?.();
      if (!await transition("finish", destination, true)) {
        throw new PhoneError("The daemon could not follow the new execution session.");
      }
      reserved = false;
      memoryFor(session).pending = undefined;
      memoryFor(session).original = undefined;
      memoryFor(session).saved = undefined;
      activePlanSession = session;
      lifecycle++;
      freshTransition = false;
      session.markPlanReferenceSent!();
      dispatched = true;
      await session.prompt!([
        `Execute the approved plan at ${planPath}.`,
        "The planning conversation was intentionally not carried over. The approved plan below is authoritative.",
        "",
        fresh.content,
      ].join("\n"), { synthetic: true });
    } catch (error) {
      if (!dispatched) {
        try {
          if (!await session.switchSession!(source)) throw new PhoneError("Returning to the planning conversation was cancelled.");
          session.setPlanModeState!({ ...fresh.state });
          await session.setActiveToolPresentation!(planningTools.enabled, planningTools.mounted);
          if (planningModel) await applyModel(session, planningModel);
          session.setPlanProposalHandler!((title) => handleProposal(ctx, session, title));
        } catch (rollbackError) {
          ask.notify(`Could not return to planning: ${String(rollbackError)}`, "warning");
        }
      }
      ask.notify(`Could not start the approved plan with fresh context: ${String(error)}`, "warning");
    } finally {
      freshTransition = false;
      if (reserved) {
        const current = sm.getSessionFile?.();
        if (current && !await transition("finish", current, false)) {
          ask.notify("The session transition could not be acknowledged. Reopen the conversation before sending more work.", "warning");
        }
      }
    }
  };
  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue === true) return;
    const agent = ctx.agent;
    if (agent && agent.kind !== "main") return;
    const session = liveSession(ctx);
    const generation = lifecycle;
    // Dispatch happens before AgentSession fully settles; also fence deferred
    // work against a session/branch change while a dialog or compaction awaits.
    setTimeout(() => {
      void (async () => {
        const stopping = [freshAfterTurn, runAfterTurn, compactAfterTurn]
          .find((approval) => approval?.session === session)?.stopped;
        if (stopping && !await stopping) return;
        if (generation !== lifecycle || session.isStreaming) return;
        const fresh = freshAfterTurn;
        if (fresh?.session === session) {
          freshAfterTurn = undefined;
          await startFreshPlan(fresh);
          return;
        }
        const run = runAfterTurn;
        if (run?.session === session) {
          runAfterTurn = undefined;
          const memory = memoryFor(session);
          await tearDown(run.ctx, session, true, { deferModelRestore: true });
          if (generation !== lifecycle) return;
          if (run.original) await applyModel(session, run.original);
          if (generation !== lifecycle) return;
          if (run.execution) await session.applyRoleModel!(run.execution);
          if (generation !== lifecycle || session.isStreaming) return;
          memory.original = undefined;
          session.setPlanReferencePath!(run.path);
          await session.prompt!(`Plan approved at ${run.path}. Execute it now. The planning discussion has been preserved.`, { synthetic: true });
          return;
        }
        const memory = memoryFor(session);
        const pending = memory.pending;
        if (pending) {
          memory.pending = undefined;
          try {
            await applyModel(session, pending);
          } catch (error) {
            (ui ?? ctx.ui).notify(`Failed to switch model after streaming: ${String(error)}`, "warning");
          }
        }
        const compact = compactAfterTurn;
        if (!compact || compact.session !== session) return;
        compactAfterTurn = undefined;
        let cancelled = false;
        let failed = false;
        try {
          await ctx.compact({ internalGuidance: planCompactGuidance(compact.path), suppressContinuation: true });
        } catch (error) {
          cancelled = error instanceof Error && /cancel|abort/i.test(error.message);
          failed = !cancelled;
        }
        if (generation !== lifecycle) return;
        // Native leaves the planning model on compaction failure; successful
        // and cancelled compaction restore the selected/original executor.
        if (!failed && memory.original) {
          const original = memory.original;
          if (compact.execution) {
            await applyExecution(session, compact.execution, ui ?? ctx.ui);
          } else {
            try { await applyModel(session, original); } catch (error) {
              (ui ?? ctx.ui).notify(`Could not restore pre-plan model: ${String(error)}`, "warning");
              return;
            }
          }
          memory.original = undefined;
        }
        if (cancelled) {
          (ui ?? ctx.ui).notify("Plan approved, but compaction was cancelled. Send a message to start the work.", "warning");
          return;
        }
        pi.sendUserMessage(`Plan approved at ${compact.path}. Execute it now.`);
      })().catch((error: unknown) => ctx.ui.notify(`Could not finalize plan approval: ${String(error)}`, "warning"));
    }, 0);
  });
  pi.on("session_start", reconcile);
  pi.on("session_switch", reconcile);
  pi.on("session_branch", reconcile);
  pi.on("session_tree", reconcile);
  pi.on("session_shutdown", () => {
    ++lifecycle;
    unsubscribeQueue?.();
    unsubscribeQueue = undefined;
  });

  const textOf = (content: unknown): string | undefined => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    return content
      .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  };

  /** The prompt the TUI would put back in the editor for a rewound user turn. */
  const draftOf = (entry: Entry): string | undefined => {
    if (entry?.type === "message" && entry.message?.role === "user") return textOf(entry.message.content);
    if (entry?.type === "custom_message") return textOf(entry.content);
    return undefined;
  };

  const handlers: Record<string, (args: Record<string, unknown>, ctx: ExtensionCommandContext) => Promise<Reply>> = {
    "pulse-queue-state": async (_args, ctx) => {
      const snapshot = queueAccess.snapshot(liveSession(ctx));
      if (!snapshot) throw new PhoneError("Exact queue actions are unavailable in this OMP version.");
      return snapshot;
    },
    "pulse-queue-remove": async (args, ctx) => {
      if ((args.queue !== "steering" && args.queue !== "followUp") || typeof args.itemId !== "string" || !args.itemId) {
        throw new PhoneError("Choose the queued message again.");
      }
      const restored = queueAccess.take(liveSession(ctx), args.queue, args.itemId);
      return restored ? { removed: true, text: restored.text, ...(restored.images ? { images: restored.images } : {}) } : { removed: false };
    },
    "pulse-queue-promote": async (args, ctx) => {
      if (typeof args.itemId !== "string" || !args.itemId) throw new PhoneError("Choose the queued message again.");
      return { promoted: queueAccess.promote(liveSession(ctx), args.itemId) };
    },
    "pulse-prompt-config": async (_args, ctx) => {
      const session = liveSession(ctx);
      requireMethods(session, "getEnabledToolNames");
      if (typeof session.settings?.rawValue !== "function") {
        throw new PhoneError("Prompt configuration is unavailable in this omp version.");
      }
      // OMP 18.8.6 modes/settings.ts: these registered booleans default
      // to true. rawValue includes this session's runtime/project overlays.
      const enabled = (id: string) => {
        const value = session.settings!.rawValue!({ segments: ["magicKeywords", id], definition: {} });
        return typeof value === "boolean" ? value : true;
      };
      // Native get_state has only a boolean; both accessors are needed to tell
      // ultrafast from fast, and one alone is not guessed at.
      const fastModeTier = typeof session.isFastModeEnabled === "function" && typeof session.isUltrafastModeEnabled === "function"
        ? session.isUltrafastModeEnabled() ? "ultrafast" : session.isFastModeEnabled() ? "fast" : "off"
        : undefined;
      if (!enabled("enabled")) return { magicKeywords: [], fastModeTier };
      const tools = session.getEnabledToolNames!();
      const definitions = [
        { id: "ultrathink", word: "ultrathink", hue: [0, 330], requires: [] },
        { id: "orchestrate", word: "orchestrate", hue: [150, 280], requires: ["task"] },
        { id: "workflow", word: "workflowz", hue: [30, 150], requires: ["task", "eval"] },
        { id: "jevify", word: "jevify", hue: [300, 420], requires: ["eval"] },
      ];
      return { fastModeTier, magicKeywords: definitions
        .filter((keyword) => enabled(keyword.id) && keyword.requires.every((tool) => tools.includes(tool)))
        .map(({ id, word, hue }) => ({ id, word, hue })) };
    },
    "pulse-model-mention-choices": async (_args, ctx) => {
      const session = liveSession(ctx);
      if (!Array.isArray(session.scopedModels) || typeof session.modelRegistry?.getAvailable !== "function" ||
          typeof session.findMentionableModel !== "function") {
        throw new PhoneError("Model mention choices are unavailable in this omp version.");
      }
      const models = session.scopedModels.length
        ? session.scopedModels.map(({ model }) => model) : session.modelRegistry.getAvailable();
      return { choices: models.flatMap((model) => {
        const selector = `${model.provider}/${model.id}`;
        return session.findMentionableModel!(selector)
          ? [{ selector, name: model.name || model.id, provider: model.provider }] : [];
      }) };
    },
    "pulse-plan": async (args, ctx) => {
      const session = liveSession(ctx);
      if (args.enabled === true) await enterPlan(ctx, session, { persist: true });
      else if (args.enabled === false) await exitPlan(ctx, session, true);
      const state = session.getPlanModeState?.();
      return state?.enabled ? { enabled: true, planFilePath: state.planFilePath } : { enabled: false };
    },
    "pulse-goto": async (args, ctx) => {
      const entryId = typeof args.entryId === "string" ? args.entryId : "";
      if (args.summarize !== undefined && typeof args.summarize !== "boolean") {
        throw new PhoneError("summarize must be true or false.");
      }
      if (args.customInstructions !== undefined && typeof args.customInstructions !== "string") {
        throw new PhoneError("customInstructions must be a string.");
      }
      const sm = manager(ctx);
      const entry = entryId ? sm.getEntry?.(entryId) : undefined;
      if (!entry) throw new PhoneError("That message is no longer in this conversation.");
      if (!ctx.isIdle()) throw new PhoneError("Stop the agent first.");
      const session = liveSession(ctx);
      requireMethods(session, "navigateTree");
      if (args.summarize === true) requireMethods(session, "abortBranchSummary");
      if (typeof ctx.ui.confirm !== "function") throw new PhoneError("This omp version can't cancel a phone tree move safely.");
      if (typeof sm.appendCustomEntry !== "function" || typeof sm.flush !== "function") {
        throw new PhoneError("This omp version can't persist a tree move from the phone.");
      }
      const isAsk = entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "ask";
      if (isAsk) {
        requireMethods(session, "buildAskReanswerContext", "resumeAfterAskReanswer");
        if (!host?.AskTool || typeof host.recoverAskQuestions !== "function" || !session.settings ||
            typeof sm.getCwd !== "function" || typeof sm.getSessionFile !== "function") {
          throw new PhoneError("Re-answering questions is unavailable in this omp version.");
        }
        // Native navigateTree falls through to an ordinary move if recovery
        // fails. Prove the matching call first, so missing questions never move.
        let parent = entry.parentId;
        const seen = new Set<string>();
        let questions: unknown[] | undefined;
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          const ancestor = sm.getEntry?.(parent);
          if (!ancestor) break;
          if (ancestor.type === "message" && ancestor.message?.role === "user") break;
          if (ancestor.type === "message" && ancestor.message?.role === "assistant") {
            const content = ancestor.message.content;
            if (Array.isArray(content)) {
              const call: unknown = content.find((part: unknown) => {
                if (!part || typeof part !== "object") return false;
                const candidate = part as Record<string, unknown>;
                return candidate.type === "toolCall" && candidate.id === entry.message?.toolCallId && candidate.name === "ask";
              });
              if (call && typeof call === "object" && "arguments" in call) questions = host.recoverAskQuestions(call.arguments);
            }
            break;
          }
          parent = ancestor.parentId;
        }
        if (!questions?.length) throw new PhoneError("The original question is unavailable; no branch was changed.");
      }
      const options: TreeOptions = {
        summarize: args.summarize === true,
        ...(typeof args.customInstructions === "string" ? { customInstructions: args.customInstructions } : {}),
        ...(isAsk ? { allowAskReopen: true } : {}),
      };
      treeMovePending = true;
      const abort = new AbortController();
      const closeCancelChannel = new AbortController();
      let cancelWait: Promise<void> | undefined;
      try {
        // OMP serializes command prompts, so another slash command cannot
        // interrupt this one. Native UI responses bypass that queue. The
        // daemon consumes this private request instead of showing a dialog.
        cancelWait = ctx.ui.confirm("omp-pulse-tree-cancel", "", { signal: closeCancelChannel.signal })
          .then(() => {
            if (!closeCancelChannel.signal.aborted) {
              abort.abort();
              session.abortBranchSummary?.();
            }
          });
        // The public ctx wrapper forwards only summarize in OMP 18.8.6.
        // Use the feature-detected native API for full native tree semantics.
        let result = await session.navigateTree!(entryId, options);
        if (result.reopenAsk && abort.signal.aborted) return { cancelled: true };
        if (result.reopenAsk) {
          let answer: AskResult;
          try {
            const AskTool = host!.AskTool!;
            const tool = new AskTool({
              cwd: sm.getCwd!(), hasUI: true, settings: session.settings!,
              getSessionFile: () => sm.getSessionFile!() ?? null,
              getSessionSpawns: () => null,
              getPlanModeState: () => session.getPlanModeState?.(),
            });
            answer = await tool.execute("tree-reanswer", { questions: result.reopenAsk.questions },
              abort.signal, undefined, session.buildAskReanswerContext!(ctx.ui));
          } catch (error) {
            if (error instanceof Error && (error.name === "ToolAbortError" || error.name === "AbortError")) {
              return { cancelled: true };
            }
            throw error;
          }
          if (answer.details?.chatRedirect) {
            return { cancelled: true, error: "Choose an option or type a custom answer; chat redirect cannot re-answer a historical question." };
          }
          if (abort.signal.aborted) return { cancelled: true };
          if (!ctx.isIdle()) return { cancelled: true, error: "The agent started while the question was open; stop it before re-answering." };
          result = await session.navigateTree!(entryId, { ...options, reanswerAskResult: answer });
        }
        if (result.cancelled || result.aborted) return { cancelled: true, ...(result.aborted ? { aborted: true } : {}) };
        // A physical metadata-only entry keeps the selected leaf on reload.
        sm.appendCustomEntry(GOTO_MARKER, { targetId: entryId });
        await sm.flush();
        if (result.askReanswerCommitted) session.resumeAfterAskReanswer!();
        const editorText = result.editorText ?? (!isAsk ? draftOf(entry) : undefined);
        return {
          cancelled: false,
          ...(result.askReanswerCommitted ? { askReanswerCommitted: true } : {}),
          ...(editorText ? { editorText } : {}),
        };
      } finally {
        closeCancelChannel.abort();
        treeMovePending = false;
        await cancelWait;
      }
    },
    "pulse-label": async (args, ctx) => {
      const entryId = typeof args.entryId === "string" ? args.entryId : "";
      const raw = typeof args.label === "string" ? args.label.trim() : "";
      const sm = manager(ctx);
      if (typeof sm.appendLabelChange !== "function") {
        throw new PhoneError("This omp version can't do that from the phone yet.");
      }
      if (!entryId || !sm.getEntry?.(entryId)) {
        throw new PhoneError("That message is no longer in this conversation.");
      }
      // `pi.setLabel(id, label)` is typed for entry labels but only renames
      // the extension (loader.ts); the session manager is the working route.
      sm.appendLabelChange(entryId, raw || undefined);
      await sm.flush?.();
      return { label: raw || null };
    },
    "pulse-command-templates": async (_args, ctx) => ({
      templates: commandTemplates(liveSession(ctx)),
    }),
    "pulse-bash": async (args, ctx) => {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) throw new PhoneError("Type a command to run.");
      const session = liveSession(ctx);
      requireMethods(session, "executeBash");
      // OMP 18.10.4's terminal requests useUserShell for explicit ! / !!
      // commands, unlike native RPC bash. Pulse uses piped output rather than
      // a terminal PTY; the composer names that difference before execution.
      const excludeFromContext = args.excludeFromContext !== false;
      const stream = typeof args.stream === "string" ? args.stream : "";
      const live = stream
        ? liveOutput((text) => ctx.ui.setStatus(`${OUTPUT_KEY_PREFIX}${stream}`, text))
        : undefined;
      try {
        const result = await session.executeBash!(command, live?.push, { excludeFromContext, useUserShell: true });
        return { result };
      } finally {
        live?.stop();
      }
    },
  };

  for (const [name, run] of Object.entries(handlers)) {
    pi.registerCommand(name, {
      description: "omp-pulse phone control (internal)",
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        ui = ctx.ui;
        const trimmed = rawArgs.trim();
        const space = trimmed.indexOf(" ");
        const reqId = space === -1 ? trimmed : trimmed.slice(0, space);
        let reply: Reply;
        try {
          if (treeMovePending && !Object.hasOwn(READ_ONLY_CONTROLS, name)) {
            throw new PhoneError("Finish or cancel the current tree move first.");
          }
          const payload = space === -1 ? {} : JSON.parse(trimmed.slice(space + 1));
          reply = { ok: true, ...(await run(payload && typeof payload === "object" ? payload : {}, ctx)) };
        } catch (error) {
          const message =
            error instanceof PhoneError
              ? error.message
              : `Couldn't do that: ${error instanceof Error ? error.message : String(error)}`;
          reply = { ok: false, error: message };
        }
        if (reqId) {
          if (name === "pulse-queue-remove") reply = fitQueueRemovalReply(reply, reqId);
          ctx.ui.setStatus(`${REPLY_KEY_PREFIX}${reqId}`, JSON.stringify(reply));
        }
      },
    });
  }
}
