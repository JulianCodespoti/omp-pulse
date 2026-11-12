import {
  KEYED_SLOTS,
  PLUGIN_SLOTS,
  boundContext,
  claimMatches,
  isKeyedSlot,
  validatePluginView,
  type KeyedSlotId,
  type PluginActionResult,
  type PluginInfo,
  type PluginNode,
  type PluginOptionValues,
  type PluginRenderContext,
  type PluginSessionInfo,
  type PluginSlotId,
  type PluginSourceInfo,
  type PluginSourceReading,
  type UnkeyedSlotId,
} from "../domain/plugins";
import { readBrowserPreference, readPairingToken, writeBrowserPreference } from "../platform/browser-storage";
import { createPluginSandbox, type PluginSandbox, type PluginSandboxOptions } from "./plugin-sandbox";
import { DaemonApi } from "./rpc-client";

/**
 * Runs every enabled plugin's script in its own sandbox and keeps the views
 * they draw. The daemon decides WHAT may run (review, hash, on/off); this
 * module decides WHEN: a plugin runs only while it is enabled and something it
 * can draw is on screen, and its sources are polled only while the page is
 * visible. Everything a worker says is hostile input: unknown message types and
 * wrong shapes are ignored, views go through `validatePluginView`, and a plugin
 * that is slow, noisy or keeps drawing nonsense is stopped.
 *
 * A render TARGET is a slot plus a key: unkeyed slots (drawer, page, ...) have
 * the key "", keyed ones (a conversation row, a tool-call card) one key per
 * thing drawn. Every brake (one render in flight, the 250 ms gap, nothing while
 * hidden, the 2000 ms budget, three invalid views) applies per target.
 *
 * A plugin acts on the world only through a TAP: every `dispatchAction` opens a
 * short grant, and the next single call to one of the five action methods spends
 * it. A plugin can never name the conversation it acts on; the host decides.
 * Before a tapped call runs, the host asks the daemon again whether the plugin is
 * still enabled with the hash it started with: `/api/bash`, `/api/rpc` and the
 * send path know nothing about plugins, so this is the only place a plugin turned
 * off (on the computer or another device) or edited since approval is stopped.
 */

export interface PluginSlotView {
  pluginId: string;
  pluginName: string;
  view: PluginNode;
}
export interface PluginRuntimeInfo {
  state: "idle" | "starting" | "running" | "failed";
  error?: string;
}
export interface PluginHostState {
  /** null until the first catalog request settles. */
  catalog: PluginInfo[] | null;
  catalogError: string | null;
  /** Validated views per slot, ordered by plugin id. Arrays keep identity while unchanged. Keyed slots are always empty here; see `keyed`. */
  views: Record<PluginSlotId, PluginSlotView[]>;
  /** Keyed slot views: per slot, per key, ordered by plugin id. Arrays keep identity while unchanged. transcript.* hold at most one view per key (the claiming plugin). */
  keyed: Record<KeyedSlotId, Record<string, PluginSlotView[]>>;
  /** Sandbox state per plugin id (only enabled plugins appear). */
  runtimes: Record<string, PluginRuntimeInfo>;
  /** True when plugins were not started this launch because the last start never finished (crash guard). */
  haltedAfterCrash: boolean;
}
export interface PluginHost {
  subscribe(listener: () => void): () => void;
  getState(): PluginHostState;
  /** Load the catalog and start or stop sandboxes to match. Coalesces concurrent calls. Never rejects. */
  refresh(): Promise<void>;
  /**
   * A mounted slot keeps its plugins running and their sources polled. With a
   * `pluginId` only that plugin is kept running for the slot (its own page); without
   * one, every enabled plugin declaring the slot is. A plugin whose last slot is
   * released stops 10 s later unless one is retained again. Returns the release function.
   */
  retainSlot(slot: UnkeyedSlotId, pluginId?: string): () => void;
  /**
   * A mounted keyed surface (a row, a menu, a card) asks for views for `key` with this
   * context. The latest context per key wins; a context whose JSON changed re-renders that
   * key. Caps per slot: session.row 100 keys, session.menu 4, transcript.tool 64,
   * transcript.message 64; a key over the cap gets no views and a no-op release.
   */
  retainKey(slot: KeyedSlotId, key: string, context: PluginRenderContext): () => void;
  /** The conversation open on screen (null on the home screen). Unkeyed renders receive it as ctx.session; a change re-renders unkeyed slots. */
  setOpenSession(session: PluginSessionInfo | null): void;
  /** A tap on something a plugin drew. `action` is the node's `actions.click`. */
  dispatchAction(pluginId: string, slot: PluginSlotId, action: string, item?: string, key?: string): void;
  /** POST the decision, then refresh. Rejects with an Error whose message is fit to show. */
  setEnabled(pluginId: string, enabled: boolean, hash?: string): Promise<void>;
  /** POST the option values, then refresh. Rejects with an Error whose message is fit to show. */
  setOptions(pluginId: string, values: PluginOptionValues): Promise<void>;
  /** Start plugins again after `haltedAfterCrash`. */
  resume(): void;
  /** Start a plugin that failed again, with the same approved script. Does nothing for one that did not fail. */
  restart(pluginId: string): void;
  /** App wiring, called once at start-up. */
  configure(handlers: {
    openPage(pluginId: string): void;
    toast(message: string): void;
    /** Put text in the composer of conversation `sessionId`. */
    compose(sessionId: string, text: string): Promise<void>;
    /** Send text to conversation `sessionId` exactly as the composer's Send would. */
    prompt(sessionId: string, text: string): Promise<void>;
  }): void;
}

/** The daemon calls the host makes; the real implementation adapts `DaemonApi`. */
export interface PluginHostApi {
  listPlugins(): Promise<PluginInfo[]>;
  getPluginScript(id: string): Promise<string>;
  setPluginState(id: string, enabled: boolean, hash?: string): Promise<PluginInfo>;
  getPluginSource(id: string, source: string): Promise<PluginSourceReading>;
  setPluginOptions(id: string, values: PluginOptionValues): Promise<PluginInfo>;
  runPluginAction(id: string, action: string, hash: string, arg?: string): Promise<PluginActionResult>;
  bash(sessionId: string, command: string, excludeFromContext: boolean): Promise<{ ok: boolean; output: string; exitCode: number | null; error?: string }>;
  rpc(sessionId: string, command: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

/** Everything outside the logic, injected so tests need no browser. */
export interface PluginHostDeps {
  /** A client for the stored credential, or null when this device is not paired. Asked per call so a re-pair is picked up. */
  api(): PluginHostApi | null;
  createSandbox(options: PluginSandboxOptions): PluginSandbox;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  isVisible(): boolean;
  /** Called when the document is shown or hidden. Returns the unsubscribe. */
  onVisibilityChange(listener: () => void): () => void;
  /** Called when the page is being left (reload, navigation, close). Returns the unsubscribe. */
  onPageHide(listener: () => void): () => void;
  /** The crash-guard marker: set before sandboxes start, cleared once they are up. */
  guard: { isSet(): boolean; set(on: boolean): void };
}

type Handlers = Parameters<PluginHost["configure"]>[0];

/** A render request not answered within this fails the plugin. */
const RENDER_TIMEOUT_MS = 2000;
/** A script that has not finished its top-level code by now is treated as hung. */
const START_TIMEOUT_MS = 5000;
/** The crash marker is cleared this long after the last sandbox finished starting. */
const GUARD_CLEAR_MS = 5000;
/** A plugin whose last slot was released keeps running this long, in case the slot comes back. */
const RELEASE_GRACE_MS = 10000;
/** Least time between two renders of one target of one plugin. */
const MIN_RENDER_GAP_MS = 250;
/** `pulse.openPage()` counts only this soon after a tap on something the plugin drew. */
const OPEN_PAGE_WINDOW_MS = 1000;
/** A tap entitles the plugin to ONE action call this soon after it. */
const GRANT_WINDOW_MS = 3000;
/** Added to a source's interval so a poll never lands just inside the daemon's cache window. */
const POLL_MARGIN_MS = 1000;
const INVALID_VIEWS_BEFORE_FAILURE = 3;
const TOAST_MAX_CHARS = 200;
/**
 * A toast that does not answer a tap shows at most once in this long per plugin. Each tap
 * also earns one toast, so "Started foo" after a tapped action always shows.
 */
const UNTAPPED_TOAST_GAP_MS = 30000;
const ERROR_MAX_CHARS = 500;
const CALL_TEXT_MAX_CHARS = 20000;
const CALL_BASH_MAX_CHARS = 4000;
const CALL_RPC_NAME_MAX_CHARS = 64;
const CALL_RPC_PARAMS_MAX_CHARS = 16384;
/**
 * More worker messages than this inside one window fails the plugin: a runaway loop
 * must not flood the page. A hundred conversation rows each answering a render (and
 * asking for a source) is legitimate, so the limit sits well above that burst.
 */
const MESSAGE_BURST_LIMIT = 600;
const MESSAGE_BURST_WINDOW_MS = 1000;
const GUARD_KEY = "omp-pulse-plugin-start-guard";
/** Most keys one keyed slot may have on screen at once. */
const KEY_CAPS: Record<KeyedSlotId, number> = {
  "session.row": 100,
  "session.menu": 4,
  "transcript.tool": 64,
  "transcript.message": 64,
};
const CALL_PERMISSIONS = {
  compose: "session.compose",
  prompt: "session.prompt",
  bash: "session.bash",
  rpc: "session.rpc",
} as const;

interface PendingRender {
  id: number;
  /** null while the budget is paused (the host is fetching a reading the plugin asked for). */
  timer: unknown;
}

interface Grant {
  at: number;
  sessionId: string | null;
  /** The conversation the tap targets, as the plugin sees it in the action event. */
  session: PluginSessionInfo | null;
}

interface KeyRetain {
  count: number;
  context: PluginRenderContext;
  json: string;
}

/** One running (or starting) plugin. Dead runs ignore every late callback. */
interface Run {
  info: PluginInfo;
  declared: PluginSlotId[];
  sources: Map<string, PluginSourceInfo>;
  dead: boolean;
  ready: boolean;
  sandbox: PluginSandbox | null;
  startTimer: unknown;
  /** Pending stop after the last needed target was released. */
  stopTimer: unknown;
  guardOpen: boolean;
  /** Target ids this plugin should be drawing right now. */
  wanted: Set<string>;
  /** A target appears once rendered; a null view means "draw nothing". */
  views: Map<string, PluginNode | null>;
  invalidStreak: Map<string, number>;
  rendering: Map<string, PendingRender>;
  /** Render ids in flight, to the target they were for. */
  pendingIds: Map<number, string>;
  /** Targets asked to render again while a render was in flight. */
  dirty: Set<string>;
  /** Targets whose render was held back (page hidden, or not wanted) until it can go. */
  deferred: Set<string>;
  lastRenderAt: Map<string, number>;
  gapTimers: Map<string, unknown>;
  /** Source fetches the plugin is waiting on; render budgets are paused while above zero. */
  sourceWaits: number;
  readings: Map<string, PluginSourceReading>;
  fetching: Map<string, Promise<PluginSourceReading>>;
  pollTimers: Map<string, unknown>;
  lastError: string | undefined;
  /** When the last action was dispatched to this plugin: only a tap entitles it to open its page. */
  lastActionAt: number | null;
  /** The unspent tap, if any. */
  grant: Grant | null;
  /** JSON of the option values last sent to the worker. */
  optionsJson: string;
  burstStart: number;
  burstCount: number;
  /** One toast earned by the last tap, not yet shown. */
  toastEarned: boolean;
  /** When the last toast that did not answer a tap was shown. */
  lastUntappedToastAt: number | null;
}

const targetId = (slot: PluginSlotId, key: string) => `${slot}\u0000${key}`;
const slotOfTarget = (id: string) => id.slice(0, id.indexOf("\u0000")) as PluginSlotId;
const keyOfTarget = (id: string) => id.slice(id.indexOf("\u0000") + 1);

const isSlot = (value: unknown): value is PluginSlotId =>
  typeof value === "string" && (PLUGIN_SLOTS as readonly string[]).includes(value);

const declaredSlots = (info: PluginInfo): PluginSlotId[] => PLUGIN_SLOTS.filter((slot) => info.slots.includes(slot));

const errorText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return text.trim() || "Something went wrong";
};

const jsonOf = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
};

const emptyViews = (): Record<PluginSlotId, PluginSlotView[]> =>
  Object.fromEntries(PLUGIN_SLOTS.map((slot) => [slot, []])) as unknown as Record<PluginSlotId, PluginSlotView[]>;

const emptyKeyed = (): Record<KeyedSlotId, Record<string, PluginSlotView[]>> =>
  Object.fromEntries(KEYED_SLOTS.map((slot) => [slot, {}])) as unknown as Record<KeyedSlotId, Record<string, PluginSlotView[]>>;

const byId = (a: { info: PluginInfo }, b: { info: PluginInfo }) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0);

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  let state: PluginHostState = {
    catalog: null,
    catalogError: null,
    views: emptyViews(),
    keyed: emptyKeyed(),
    runtimes: {},
    haltedAfterCrash: false,
  };
  const listeners = new Set<() => void>();
  const retained = new Map<PluginSlotId, number>();
  /** Retains made for one plugin only (its own page), by plugin id. */
  const pluginRetains = new Map<string, Map<PluginSlotId, number>>();
  /** Mounted keyed surfaces: slot, then key. */
  const keyRetains = new Map<KeyedSlotId, Map<string, KeyRetain>>();
  const runs = new Map<string, Run>();
  /** Plugins stopped for failing, by id; kept until the catalog shows a different hash or the plugin is switched off. */
  const failures = new Map<string, { hash: string; error: string }>();
  const unavailable = () => Promise.reject(new Error("This is not available yet"));
  let handlers: Handlers = { openPage: () => {}, toast: () => {}, compose: unavailable, prompt: unavailable };
  let openSession: PluginSessionInfo | null = null;
  let halted = false;
  let guardChecked = false;
  let guardOpenRuns = 0;
  let guardTimer: unknown = null;
  let unsubscribeVisibility: (() => void) | null = null;
  let unsubscribePageHide: (() => void) | null = null;
  let renderSeq = 0;
  let inflight: Promise<void> | null = null;
  /** Set when the catalog (not derivable from runs) changed, so the next publish notifies. */
  let catalogChanged = false;
  /** Enabled plugins by id, for the claim rule; rebuilt when the catalog changes. */
  let enabledSorted: PluginInfo[] | null = null;

  // ── What should be drawn ─────────────────────────────────────────────

  const retainedFor = (slot: PluginSlotId, pluginId: string) =>
    (retained.get(slot) ?? 0) > 0 || (pluginRetains.get(pluginId)?.get(slot) ?? 0) > 0;

  function enabledPlugins(): PluginInfo[] {
    enabledSorted ??= (state.catalog ?? []).filter((info) => info.status === "enabled").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return enabledSorted;
  }

  /** The claim a keyed context makes: what a transcript plugin's patterns are matched against. */
  function claimedValue(slot: KeyedSlotId, context: PluginRenderContext): string | null {
    const value = slot === "transcript.tool" ? context.call?.name : slot === "transcript.message" ? context.message?.customType : undefined;
    return typeof value === "string" ? value : null;
  }

  const claimsOf = (info: PluginInfo, slot: KeyedSlotId) => (slot === "transcript.tool" ? info.tools : info.messages);

  /**
   * Whether `info` draws this key. Rows and menus: every enabled plugin declaring the slot.
   * Transcript cards replace what the app would draw, so exactly one plugin gets a card: the
   * first enabled one, by id, that declares the slot and whose claims match.
   */
  function draws(info: PluginInfo, slot: KeyedSlotId, context: PluginRenderContext): boolean {
    if (info.status !== "enabled" || !info.slots.includes(slot)) return false;
    if (slot === "session.row" || slot === "session.menu") return true;
    const value = claimedValue(slot, context);
    if (value === null) return false;
    for (const other of enabledPlugins()) {
      if (!other.slots.includes(slot) || !claimMatches(claimsOf(other, slot), value)) continue;
      return other.id === info.id;
    }
    return false;
  }

  /** Every target this plugin should be drawing for what is on screen. */
  function targetsFor(info: PluginInfo): Array<[PluginSlotId, string]> {
    const out: Array<[PluginSlotId, string]> = [];
    for (const slot of declaredSlots(info)) {
      if (!isKeyedSlot(slot)) {
        if (retainedFor(slot, info.id)) out.push([slot, ""]);
        continue;
      }
      for (const [key, entry] of keyRetains.get(slot) ?? []) {
        if (draws(info, slot, entry.context)) out.push([slot, key]);
      }
    }
    return out;
  }

  const wantsRun = (info: PluginInfo) => targetsFor(info).length > 0;

  /** What a worker is handed to draw a target. Always bounded. */
  function contextFor(run: Run, slot: PluginSlotId, key: string): PluginRenderContext {
    // Without session.read the plugin does not learn which conversation is open.
    const session = run.info.permissions.includes("session.read") ? openSession : null;
    if (!isKeyedSlot(slot)) return boundContext({ session });
    const base = keyRetains.get(slot)?.get(key)?.context ?? { session: null };
    // A row or menu is about the conversation it names, which those slots already disclose.
    return boundContext(slot === "transcript.tool" || slot === "transcript.message" ? { ...base, session } : base);
  }

  // ── State publication ────────────────────────────────────────────────

  function computeRuntimes(): Record<string, PluginRuntimeInfo> {
    const out: Record<string, PluginRuntimeInfo> = {};
    for (const info of state.catalog ?? []) {
      if (info.status !== "enabled") continue;
      const failure = failures.get(info.id);
      const run = runs.get(info.id);
      if (failure) out[info.id] = { state: "failed", error: failure.error };
      else if (run?.ready) out[info.id] = run.lastError ? { state: "running", error: run.lastError } : { state: "running" };
      else if (run) out[info.id] = { state: "starting" };
      else out[info.id] = { state: "idle" };
    }
    return out;
  }

  function computeViews(): { views: Record<PluginSlotId, PluginSlotView[]>; keyed: Record<KeyedSlotId, Record<string, PluginSlotView[]>> } {
    const views = emptyViews();
    const keyed = emptyKeyed();
    for (const run of [...runs.values()].sort(byId)) {
      for (const [target, view] of run.views) {
        if (!view) continue;
        const slot = slotOfTarget(target);
        const entry: PluginSlotView = { pluginId: run.info.id, pluginName: run.info.name, view };
        if (isKeyedSlot(slot)) (keyed[slot][keyOfTarget(target)] ??= []).push(entry);
        else views[slot].push(entry);
      }
    }
    return { views, keyed };
  }

  /** Recompute everything derived and notify only when something visibly changed. */
  function publish(): void {
    const runtimes = computeRuntimes();
    const next = computeViews();
    const views = emptyViews();
    for (const slot of PLUGIN_SLOTS) {
      // Compare the normalised JSON so an unchanged slot keeps its array identity.
      views[slot] = JSON.stringify(next.views[slot]) === JSON.stringify(state.views[slot]) ? state.views[slot] : next.views[slot];
    }
    const sameViews = PLUGIN_SLOTS.every((slot) => views[slot] === state.views[slot]);

    const keyed = emptyKeyed();
    let sameKeyed = true;
    for (const slot of KEYED_SLOTS) {
      const before = state.keyed[slot];
      const record: Record<string, PluginSlotView[]> = {};
      for (const [key, list] of Object.entries(next.keyed[slot])) {
        record[key] = before[key] && JSON.stringify(before[key]) === JSON.stringify(list) ? before[key] : list;
      }
      const keys = Object.keys(record);
      const same = keys.length === Object.keys(before).length && keys.every((key) => record[key] === before[key]);
      keyed[slot] = same ? before : record;
      if (!same) sameKeyed = false;
    }

    const sameRuntimes = JSON.stringify(runtimes) === JSON.stringify(state.runtimes);
    if (sameViews && sameKeyed && sameRuntimes && state.haltedAfterCrash === halted && !catalogChanged) return;
    catalogChanged = false;
    state = {
      ...state,
      views: sameViews ? state.views : views,
      keyed: sameKeyed ? state.keyed : keyed,
      runtimes: sameRuntimes ? state.runtimes : runtimes,
      haltedAfterCrash: halted,
    };
    notify();
  }

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  // ── Crash guard ──────────────────────────────────────────────────────

  function guardBegin(run: Run): void {
    if (run.guardOpen) return;
    run.guardOpen = true;
    guardOpenRuns++;
    if (guardTimer !== null) {
      deps.clearTimer(guardTimer);
      guardTimer = null;
    }
    deps.guard.set(true);
  }

  function guardEnd(run: Run): void {
    if (!run.guardOpen) return;
    run.guardOpen = false;
    guardOpenRuns--;
    if (guardOpenRuns > 0) return;
    // Wait a little after the last start: a crash right after the sandbox came up still counts.
    guardTimer = deps.setTimer(() => {
      guardTimer = null;
      if (guardOpenRuns === 0) deps.guard.set(false);
    }, GUARD_CLEAR_MS);
  }

  // ── Run lifecycle ────────────────────────────────────────────────────

  function startRun(info: PluginInfo): void {
    const api = deps.api();
    if (!api) return;
    const run: Run = {
      info,
      declared: declaredSlots(info),
      sources: new Map(info.sources.map((source) => [source.id, source])),
      dead: false,
      ready: false,
      sandbox: null,
      startTimer: null,
      stopTimer: null,
      guardOpen: false,
      wanted: new Set(),
      views: new Map(),
      invalidStreak: new Map(),
      rendering: new Map(),
      pendingIds: new Map(),
      dirty: new Set(),
      deferred: new Set(),
      lastRenderAt: new Map(),
      gapTimers: new Map(),
      sourceWaits: 0,
      readings: new Map(),
      fetching: new Map(),
      pollTimers: new Map(),
      lastError: undefined,
      lastActionAt: null,
      grant: null,
      optionsJson: "",
      burstStart: 0,
      burstCount: 0,
      toastEarned: false,
      lastUntappedToastAt: null,
    };
    runs.set(info.id, run);
    guardBegin(run);
    ensureVisibilitySubscription();
    api.getPluginScript(info.id).then(
      (script) => {
        if (run.dead) return;
        // The budget is for the plugin's own load, so it starts when the script is in hand.
        run.startTimer = deps.setTimer(() => {
          run.startTimer = null;
          if (!run.dead && !run.ready) failRun(run, "The plugin did not finish loading");
        }, START_TIMEOUT_MS);
        try {
          const sandbox = deps.createSandbox({
            script,
            onMessage: (message) => onWorkerMessage(run, message),
            onFailure: (reason) => failRun(run, reason),
          });
          // A failure raised while the sandbox was still being built has already stopped the run.
          if (run.dead) sandbox.dispose();
          else run.sandbox = sandbox;
        } catch (error) {
          failRun(run, errorText(error));
        }
      },
      () => {
        // A download failure (network, daemon) is not the plugin's fault: stop without
        // recording a failure, so the next refresh or retain tries again.
        if (run.dead) return;
        stopRun(run);
        publish();
      },
    );
  }

  function clearRunTimers(run: Run): void {
    for (const timer of [run.startTimer, run.stopTimer, ...run.gapTimers.values(), ...run.pollTimers.values()]) {
      if (timer !== null) deps.clearTimer(timer);
    }
    run.startTimer = null;
    run.stopTimer = null;
    run.gapTimers.clear();
    run.pollTimers.clear();
    for (const pending of run.rendering.values()) {
      if (pending.timer !== null) deps.clearTimer(pending.timer);
    }
    run.rendering.clear();
    run.pendingIds.clear();
  }

  /** Stop a run and drop its views. Does not publish. */
  function stopRun(run: Run): void {
    if (run.dead) return;
    run.dead = true;
    clearRunTimers(run);
    run.views.clear();
    run.grant = null;
    guardEnd(run);
    const sandbox = run.sandbox;
    run.sandbox = null;
    try {
      sandbox?.dispose();
    } catch {
      // A sandbox that cannot be torn down cleanly is already unreachable from here.
    }
    if (runs.get(run.info.id) === run) runs.delete(run.info.id);
  }

  function failRun(run: Run, reason: string): void {
    if (run.dead) return;
    stopRun(run);
    failures.set(run.info.id, { hash: run.info.hash, error: reason.trim().slice(0, ERROR_MAX_CHARS) || "The plugin failed" });
    publish();
  }

  /** Make the running set match the catalog and what is on screen. */
  function reconcile(): void {
    const infoById = new Map((state.catalog ?? []).map((info) => [info.id, info]));
    for (const run of [...runs.values()]) {
      const info = infoById.get(run.info.id);
      if (!info || info.status !== "enabled" || info.hash !== run.info.hash) {
        stopRun(run);
        continue;
      }
      run.info = info;
      if (wantsRun(info)) cancelRelease(run);
      else scheduleRelease(run);
      // Option values are not in the hash: a change reaches the worker without a restart.
      if (run.ready && jsonOf(info.optionValues ?? {}) !== run.optionsJson) {
        sendOptions(run);
        renderTargets(run);
      }
    }
    for (const [id, failure] of [...failures]) {
      const info = infoById.get(id);
      if (!info || info.status !== "enabled" || info.hash !== failure.hash) failures.delete(id);
    }
    if (!halted && state.catalog !== null) {
      for (const info of state.catalog) {
        if (info.status === "enabled" && wantsRun(info) && !runs.has(info.id) && !failures.has(info.id)) startRun(info);
      }
    }
    for (const run of runs.values()) syncRunTargets(run);
    publish();
  }

  function cancelRelease(run: Run): void {
    if (run.stopTimer !== null) deps.clearTimer(run.stopTimer);
    run.stopTimer = null;
  }

  /**
   * Releasing the last target a plugin needs stops it only after a grace period:
   * the drawer opens and closes often and restarting a sandbox each time flickers.
   * Disabling, a new hash and a failure still stop it at once.
   */
  function scheduleRelease(run: Run): void {
    if (run.stopTimer !== null) return;
    run.stopTimer = deps.setTimer(() => {
      run.stopTimer = null;
      if (run.dead || wantsRun(run.info)) return;
      stopRun(run);
      publish();
    }, RELEASE_GRACE_MS);
  }

  /** Render targets that just appeared; forget targets that are gone (unless the whole plugin is in its grace period). */
  function syncRunTargets(run: Run): void {
    const list = targetsFor(run.info);
    run.wanted = new Set(list.map(([slot, key]) => targetId(slot, key)));
    for (const [slot, key] of list) {
      const target = targetId(slot, key);
      const busy = run.rendering.has(target) || run.gapTimers.has(target);
      if (run.ready && !busy && (!run.views.has(target) || run.deferred.has(target))) requestRender(run, slot, key);
    }
    if (run.wanted.size === 0) return;
    const known = new Set([
      ...run.views.keys(),
      ...run.invalidStreak.keys(),
      ...run.rendering.keys(),
      ...run.gapTimers.keys(),
      ...run.dirty,
      ...run.deferred,
    ]);
    for (const target of known) {
      if (run.wanted.has(target)) continue;
      run.views.delete(target);
      run.invalidStreak.delete(target);
      run.dirty.delete(target);
      run.deferred.delete(target);
      const gap = run.gapTimers.get(target);
      if (gap !== undefined) deps.clearTimer(gap);
      run.gapTimers.delete(target);
      const pending = run.rendering.get(target);
      if (pending) {
        if (pending.timer !== null) deps.clearTimer(pending.timer);
        run.rendering.delete(target);
        run.pendingIds.delete(pending.id);
      }
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────

  function armRenderTimer(run: Run, target: string, pending: PendingRender): void {
    pending.timer = deps.setTimer(() => {
      if (run.rendering.get(target) === pending) {
        failRun(run, `The plugin did not draw its ${slotOfTarget(target)} view within ${RENDER_TIMEOUT_MS / 1000} seconds`);
      }
    }, RENDER_TIMEOUT_MS);
  }

  /**
   * Ask the worker to draw a target, subject to three brakes: one render in flight
   * per target (a request meanwhile marks it dirty), none while the page is hidden,
   * and at least MIN_RENDER_GAP_MS between two renders of a target (a plugin that
   * refreshes itself in a loop must not cost a validate-and-redraw cycle per
   * message). A held-back request is deferred, never dropped.
   */
  function requestRender(run: Run, slot: PluginSlotId, key: string): void {
    if (run.dead || !run.ready || !run.sandbox || !run.declared.includes(slot)) return;
    const target = targetId(slot, key);
    if (!run.wanted.has(target)) {
      // Kept through the release grace period: redraw it if the target comes back.
      if (run.views.has(target)) run.deferred.add(target);
      return;
    }
    if (run.rendering.has(target)) {
      run.dirty.add(target);
      return;
    }
    if (!deps.isVisible()) {
      run.deferred.add(target);
      return;
    }
    const wait = (run.lastRenderAt.get(target) ?? -Infinity) + MIN_RENDER_GAP_MS - deps.now();
    if (wait > 0) {
      if (!run.gapTimers.has(target)) {
        run.gapTimers.set(
          target,
          deps.setTimer(() => {
            run.gapTimers.delete(target);
            requestRender(run, slot, key);
          }, wait),
        );
      }
      return;
    }
    const pending: PendingRender = { id: ++renderSeq, timer: null };
    run.deferred.delete(target);
    run.rendering.set(target, pending);
    run.pendingIds.set(pending.id, target);
    run.lastRenderAt.set(target, deps.now());
    if (run.sourceWaits === 0) armRenderTimer(run, target, pending);
    const message: Record<string, unknown> = { t: "render", id: pending.id, slot, ctx: contextFor(run, slot, key) };
    if (isKeyedSlot(slot)) message.key = key;
    run.sandbox.post(message);
  }

  /** Render every wanted target of the run, or only those of one slot. */
  function renderTargets(run: Run, slot?: PluginSlotId): void {
    for (const target of [...run.wanted]) {
      if (slot === undefined || slotOfTarget(target) === slot) requestRender(run, slotOfTarget(target), keyOfTarget(target));
    }
  }

  /** The answer to a render arrived (valid or not): free the target and go again if asked meanwhile. */
  function settleRender(run: Run, target: string): void {
    const pending = run.rendering.get(target);
    if (pending) {
      if (pending.timer !== null) deps.clearTimer(pending.timer);
      run.pendingIds.delete(pending.id);
    }
    run.rendering.delete(target);
    if (run.dirty.delete(target)) requestRender(run, slotOfTarget(target), keyOfTarget(target));
  }

  function countInvalid(run: Run, target: string, error: string): void {
    const streak = (run.invalidStreak.get(target) ?? 0) + 1;
    run.invalidStreak.set(target, streak);
    if (streak >= INVALID_VIEWS_BEFORE_FAILURE) failRun(run, error);
    else settleRender(run, target);
  }

  function onView(run: Run, target: string, raw: unknown): void {
    const result = validatePluginView(slotOfTarget(target), raw);
    if (!result.ok) {
      countInvalid(run, target, result.error);
      return;
    }
    run.invalidStreak.set(target, 0);
    run.views.set(target, result.view);
    settleRender(run, target);
    publish();
  }

  // ── Options ──────────────────────────────────────────────────────────

  /** Always sent before the renders it causes: a renderer reads `pulse.options` synchronously. */
  function sendOptions(run: Run): void {
    const values = run.info.optionValues ?? {};
    run.optionsJson = jsonOf(values);
    run.sandbox?.post({ t: "options", values });
  }

  // ── Sources ──────────────────────────────────────────────────────────

  function errorReading(message: string): PluginSourceReading {
    return { ok: false, text: "", exitCode: null, fetchedAtMs: deps.now(), truncated: false, error: message };
  }

  function fetchReading(run: Run, sourceId: string): Promise<PluginSourceReading> {
    const existing = run.fetching.get(sourceId);
    if (existing) return existing;
    const api = deps.api();
    if (!api) return Promise.reject(new Error("This device is not paired with a computer"));
    const request: Promise<PluginSourceReading> = api.getPluginSource(run.info.id, sourceId).finally(() => {
      if (run.fetching.get(sourceId) === request) run.fetching.delete(sourceId);
    });
    run.fetching.set(sourceId, request);
    return request;
  }

  /** Keep a reading; true when it is newer than the one held. */
  function storeReading(run: Run, sourceId: string, reading: PluginSourceReading): boolean {
    const previous = run.readings.get(sourceId);
    if (previous && previous.fetchedAtMs === reading.fetchedAtMs) return false;
    run.readings.set(sourceId, reading);
    return true;
  }

  /** A source reading the plugin asked for is being fetched: the plugin cannot be blamed for the wait, so pause its render budgets. */
  function beginSourceWait(run: Run): void {
    if (++run.sourceWaits !== 1) return;
    for (const pending of run.rendering.values()) {
      if (pending.timer !== null) deps.clearTimer(pending.timer);
      pending.timer = null;
    }
  }

  /** The reading has been handed to the worker: every pending render gets its full budget again. */
  function endSourceWait(run: Run): void {
    if (run.dead || --run.sourceWaits > 0) return;
    for (const [target, pending] of run.rendering) armRenderTimer(run, target, pending);
  }

  function answerSource(run: Run, requestId: number, sourceId: string): void {
    const reply = (reading: PluginSourceReading) => {
      if (!run.dead) run.sandbox?.post({ t: "source", id: requestId, reading });
    };
    if (!run.sources.has(sourceId)) {
      reply(errorReading(`This plugin does not declare a source called "${sourceId.slice(0, 64)}"`));
      return;
    }
    const known = run.readings.get(sourceId);
    if (known) {
      reply(known);
      return;
    }
    beginSourceWait(run);
    const finish = (reading: PluginSourceReading) => {
      reply(reading);
      endSourceWait(run);
    };
    fetchReading(run, sourceId).then(
      (reading) => {
        // The renderer that asked is already waiting on this reading: no extra render for it.
        if (!run.dead) {
          storeReading(run, sourceId, reading);
          schedulePoll(run, sourceId);
        }
        finish(reading);
      },
      (error: unknown) => finish(errorReading(errorText(error))),
    );
  }

  function pollNow(run: Run, sourceId: string): void {
    const timer = run.pollTimers.get(sourceId);
    if (timer !== undefined) deps.clearTimer(timer);
    run.pollTimers.delete(sourceId);
    fetchReading(run, sourceId)
      .then((reading) => {
        if (!run.dead && storeReading(run, sourceId, reading)) renderTargets(run);
      })
      .catch(() => {
        // Keep the last reading; the next tick tries again.
      })
      .finally(() => schedulePoll(run, sourceId));
  }

  /**
   * The next poll comes a second AFTER the daemon's cache window closes, counted
   * from when the last reading arrived: landing just inside the window got the
   * cached reading back and doubled the effective interval.
   */
  function schedulePoll(run: Run, sourceId: string): void {
    const source = run.sources.get(sourceId);
    if (run.dead || !run.ready || !source || !deps.isVisible()) return;
    const existing = run.pollTimers.get(sourceId);
    if (existing !== undefined) deps.clearTimer(existing);
    run.pollTimers.set(
      sourceId,
      deps.setTimer(() => {
        run.pollTimers.delete(sourceId);
        if (!run.dead && deps.isVisible()) pollNow(run, sourceId);
      }, source.intervalS * 1000 + POLL_MARGIN_MS),
    );
  }

  function onVisibilityChanged(): void {
    const visible = deps.isVisible();
    for (const run of [...runs.values()]) {
      if (!run.ready) continue;
      for (const sourceId of run.sources.keys()) {
        if (visible) {
          // Catch up at once: the daemon answers from its cache unless the reading expired.
          if (!run.pollTimers.has(sourceId)) pollNow(run, sourceId);
        } else {
          const timer = run.pollTimers.get(sourceId);
          if (timer !== undefined) deps.clearTimer(timer);
          run.pollTimers.delete(sourceId);
        }
      }
      if (visible) {
        for (const target of [...run.deferred]) {
          run.deferred.delete(target);
          requestRender(run, slotOfTarget(target), keyOfTarget(target));
        }
      }
    }
  }

  function ensureVisibilitySubscription(): void {
    unsubscribeVisibility ??= deps.onVisibilityChange(onVisibilityChanged);
    // An ordinary reload or navigation is not a crash: do not leave the marker behind.
    unsubscribePageHide ??= deps.onPageHide(() => deps.guard.set(false));
  }

  // ── Action calls (what a tap entitles a plugin to do) ────────────────

  function replyCall(run: Run, id: number, result: Record<string, unknown>): void {
    if (!run.dead) run.sandbox?.post({ t: "callResult", id, result });
  }

  const refusal = (error: string) => ({ ok: false, error });

  /** Check a call's shape and size. Returns the reason it is refused, or null. */
  function callProblem(op: string, m: Record<string, unknown>): string | null {
    if (op === "compose" || op === "prompt") {
      if (typeof m.text !== "string") return "The text must be a string";
      if (m.text.length > CALL_TEXT_MAX_CHARS) return `The text is longer than ${CALL_TEXT_MAX_CHARS} characters`;
    } else if (op === "bash") {
      if (typeof m.command !== "string") return "The command must be a string";
      if (m.command.length > CALL_BASH_MAX_CHARS) return `The command is longer than ${CALL_BASH_MAX_CHARS} characters`;
    } else if (op === "rpc") {
      if (typeof m.command !== "string" || !m.command) return "The command name must be a string";
      if (m.command.length > CALL_RPC_NAME_MAX_CHARS) return `The command name is longer than ${CALL_RPC_NAME_MAX_CHARS} characters`;
      if (m.params === null || typeof m.params !== "object" || Array.isArray(m.params)) return "The parameters must be an object";
      if (jsonOf(m.params).length > CALL_RPC_PARAMS_MAX_CHARS) return `The parameters are larger than ${CALL_RPC_PARAMS_MAX_CHARS} characters`;
    } else if (op === "hostRun") {
      if (typeof m.action !== "string" || !m.action) return "The action id must be a string";
      if (m.arg !== undefined && typeof m.arg !== "string") return "The argument must be a string";
    }
    return null;
  }

  function onCall(run: Run, m: Record<string, unknown>): void {
    if (typeof m.id !== "number" || typeof m.op !== "string") return;
    const id = m.id;
    const op = m.op;
    if (op !== "compose" && op !== "prompt" && op !== "bash" && op !== "rpc" && op !== "hostRun") {
      replyCall(run, id, refusal("The plugin asked for something that does not exist"));
      return;
    }
    // Refusals before the grant is touched: a mistake must not cost the plugin its tap.
    if (op === "hostRun") {
      if (typeof m.action === "string" && !run.info.actions.some((action) => action.id === m.action)) {
        replyCall(run, id, refusal(`This plugin declares no action called "${m.action.slice(0, 64)}"`));
        return;
      }
    } else if (!run.info.permissions.includes(CALL_PERMISSIONS[op])) {
      replyCall(run, id, refusal(`This plugin did not declare the "${CALL_PERMISSIONS[op]}" permission`));
      return;
    }
    const problem = callProblem(op, m);
    if (problem) {
      replyCall(run, id, refusal(problem));
      return;
    }
    const grant = run.grant;
    if (!grant || deps.now() - grant.at > GRANT_WINDOW_MS) {
      replyCall(run, id, refusal("The plugin needs a tap on something it drew before it can do that"));
      return;
    }
    if (op !== "hostRun" && grant.sessionId === null) {
      replyCall(run, id, refusal("There is nothing to act on: no conversation is open"));
      return;
    }
    // One tap, one call.
    run.grant = null;
    void executeCall(run, id, op, m, grant.sessionId);
  }

  async function executeCall(
    run: Run,
    id: number,
    op: "compose" | "prompt" | "bash" | "rpc" | "hostRun",
    m: Record<string, unknown>,
    sessionId: string | null,
  ): Promise<void> {
    let result: Record<string, unknown>;
    try {
      const api = deps.api();
      if (!api) {
        result = refusal("This device is not paired with a computer");
      } else if (op !== "hostRun" && !(await stillApproved(run, api))) {
        // hostRun is not re-checked here: the daemon refuses an action of a plugin that is off or changed.
        result = refusal("This plugin was turned off or changed on the computer since it was approved");
      } else if (op === "compose" && sessionId !== null) {
        await handlers.compose(sessionId, m.text as string);
        result = { ok: true };
      } else if (op === "prompt" && sessionId !== null) {
        await handlers.prompt(sessionId, m.text as string);
        result = { ok: true };
      } else if (op === "bash" && sessionId !== null) {
        result = { ...(await api.bash(sessionId, m.command as string, m.excludeFromContext === true)) };
      } else if (op === "rpc" && sessionId !== null) {
        result = { ...(await api.rpc(sessionId, m.command as string, m.params as Record<string, unknown>)) };
      } else if (op === "hostRun") {
        // The hash this run was started with, never one the plugin names: a plugin changed on disk
        // since approval is refused by the daemon.
        const done = await api.runPluginAction(run.info.id, m.action as string, run.info.hash, m.arg as string | undefined);
        result = { ...done };
      } else {
        result = refusal("There is nothing to act on: no conversation is open");
      }
    } catch (error) {
      result = refusal(errorText(error));
    }
    replyCall(run, id, result);
  }

  /**
   * Reloads the catalog and answers whether `run`'s plugin is still enabled with the hash it was
   * started with. A plugin that is not is stopped by the reload. Rejects when the daemon cannot be
   * asked: a call the daemon cannot confirm does not run.
   */
  async function stillApproved(run: Run, api: PluginHostApi): Promise<boolean> {
    const list = await api.listPlugins();
    applyCatalog(list);
    const current = list.find((plugin) => plugin.id === run.info.id);
    return !run.dead && current !== undefined && current.status === "enabled" && current.hash === run.info.hash;
  }

  // ── Worker messages ──────────────────────────────────────────────────

  function onReady(run: Run): void {
    if (run.ready) return;
    run.ready = true;
    if (run.startTimer !== null) deps.clearTimer(run.startTimer);
    run.startTimer = null;
    guardEnd(run);
    for (const sourceId of run.sources.keys()) schedulePoll(run, sourceId);
    // Options first: a renderer reads pulse.options synchronously.
    sendOptions(run);
    syncRunTargets(run);
    publish();
  }

  function onWorkerMessage(run: Run, raw: unknown): void {
    if (run.dead) return;
    const now = deps.now();
    if (now - run.burstStart >= MESSAGE_BURST_WINDOW_MS) {
      run.burstStart = now;
      run.burstCount = 0;
    }
    if (++run.burstCount > MESSAGE_BURST_LIMIT) {
      failRun(run, "The plugin sent too many messages");
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    const m = raw as Record<string, unknown>;
    switch (m.t) {
      case "ready":
        onReady(run);
        return;
      case "view": {
        // Only the answer to a render in flight counts, and it is judged by the target the
        // host asked about, whatever slot or key the worker claims.
        const target = typeof m.id === "number" ? run.pendingIds.get(m.id) : undefined;
        if (target === undefined) return;
        onView(run, target, m.view);
        return;
      }
      case "error": {
        if (typeof m.message !== "string") return;
        const text = m.message.slice(0, ERROR_MAX_CHARS);
        // A renderer that threw counts like an invalid view; the worker names the render it was answering.
        const target = typeof m.id === "number" ? run.pendingIds.get(m.id) : undefined;
        if (target !== undefined) {
          countInvalid(run, target, text);
          return;
        }
        run.lastError = text;
        publish();
        return;
      }
      case "source":
        if (typeof m.id === "number" && typeof m.sourceId === "string") answerSource(run, m.id, m.sourceId);
        return;
      case "call":
        onCall(run, m);
        return;
      case "refresh":
        if (m.slot === undefined) renderTargets(run);
        else if (isSlot(m.slot)) renderTargets(run, m.slot);
        return;
      case "openPage":
        if (run.declared.includes("page") && run.lastActionAt !== null && deps.now() - run.lastActionAt <= OPEN_PAGE_WINDOW_MS) {
          handlers.openPage(run.info.id);
        }
        return;
      case "toast":
        if (typeof m.text === "string") showToastFrom(run, m.text.slice(0, TOAST_MAX_CHARS));
        return;
      default:
        return;
    }
  }

  /**
   * A plugin's toast always carries the plugin's name, so it cannot pass for the app's own
   * notice, and one that does not answer a tap is limited to one per UNTAPPED_TOAST_GAP_MS,
   * so it cannot keep the screen covered.
   */
  function showToastFrom(run: Run, text: string): void {
    const now = deps.now();
    if (run.toastEarned) {
      run.toastEarned = false;
    } else if (run.lastUntappedToastAt === null || now - run.lastUntappedToastAt >= UNTAPPED_TOAST_GAP_MS) {
      run.lastUntappedToastAt = now;
    } else {
      return;
    }
    handlers.toast(`${run.info.name}: ${text}`);
  }

  // ── Catalog ──────────────────────────────────────────────────────────

  function applyCatalog(list: PluginInfo[]): void {
    if (!guardChecked) {
      guardChecked = true;
      // The last launch never finished starting its plugins: do not repeat it unasked.
      if (deps.guard.isSet()) halted = true;
    }
    const same = state.catalog !== null && JSON.stringify(state.catalog) === JSON.stringify(list);
    // The catalog is not derived, so publish() cannot see its change: say so.
    catalogChanged ||= !same || state.catalogError !== null;
    state = { ...state, catalog: same ? state.catalog : list, catalogError: null };
    enabledSorted = null;
    reconcile();
  }

  async function loadCatalog(): Promise<void> {
    const api = deps.api();
    // Not paired yet: there is nothing to ask and nothing to report.
    if (!api) return;
    try {
      applyCatalog(await api.listPlugins());
    } catch (error) {
      state = { ...state, catalogError: errorText(error) };
      notify();
    }
  }

  function refresh(): Promise<void> {
    inflight ??= loadCatalog().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** The changed decision or values were posted: wait out a load that may predate them, then load afresh. */
  async function reloadAfterChange(): Promise<void> {
    await inflight;
    await refresh();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    refresh,
    retainSlot(slot, pluginId) {
      const counts =
        pluginId === undefined ? retained : (pluginRetains.get(pluginId) ?? new Map<PluginSlotId, number>());
      if (pluginId !== undefined) pluginRetains.set(pluginId, counts);
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
      reconcile();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (counts.get(slot) ?? 1) - 1;
        if (left > 0) counts.set(slot, left);
        else counts.delete(slot);
        if (pluginId !== undefined && counts.size === 0 && pluginRetains.get(pluginId) === counts) pluginRetains.delete(pluginId);
        reconcile();
      };
    },
    retainKey(slot, key, context) {
      if (!isKeyedSlot(slot) || typeof key !== "string" || key === "") return () => {};
      let keys = keyRetains.get(slot);
      if (!keys) {
        keys = new Map();
        keyRetains.set(slot, keys);
      }
      const json = jsonOf(context);
      let entry = keys.get(key);
      const existed = entry !== undefined;
      if (entry) {
        // Insertion order is recency: a key retained again is the newest.
        keys.delete(key);
      } else {
        // Over the cap, the oldest key makes room. Refusing the new one instead would let the first
        // calls of a long transcript hold every place while the live ones never get a card.
        if (keys.size >= KEY_CAPS[slot]) {
          const oldest = keys.keys().next();
          if (!oldest.done) keys.delete(oldest.value);
        }
        entry = { count: 0, context, json };
      }
      keys.set(key, entry);
      entry.count++;
      const changed = existed && entry.json !== json;
      if (changed) {
        // The latest context wins, wherever it came from.
        entry.context = context;
        entry.json = json;
      }
      reconcile();
      if (changed) {
        for (const run of runs.values()) requestRender(run, slot, key);
      }
      const owner = entry;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // An evicted handle, or one for a key since retained afresh, no longer owns anything.
        if (keyRetains.get(slot)?.get(key) !== owner) return;
        if (--owner.count <= 0) keyRetains.get(slot)?.delete(key);
        reconcile();
      };
    },
    setOpenSession(session) {
      if (jsonOf(session) === jsonOf(openSession)) return;
      openSession = session;
      // Only a plugin that may see the conversation has anything new to draw; rows and menus name their own.
      for (const run of runs.values()) {
        if (!run.info.permissions.includes("session.read")) continue;
        for (const target of [...run.wanted]) {
          const slot = slotOfTarget(target);
          if (slot !== "session.row" && slot !== "session.menu") requestRender(run, slot, keyOfTarget(target));
        }
      }
    },
    dispatchAction(pluginId, slot, action, item, key) {
      const run = runs.get(pluginId);
      if (!run || !run.ready || !run.sandbox || !run.declared.includes(slot)) return;
      // A row or menu names the conversation it is about; everything else acts on the open one.
      const named = slot === "session.row" || slot === "session.menu";
      const rowSession = named ? keyRetains.get(slot)?.get(key ?? "")?.context.session ?? null : null;
      // What the plugin SEES is gated on session.read; what a grant TARGETS is not (the host acts, the plugin only asks).
      const session = named ? rowSession : run.info.permissions.includes("session.read") ? openSession : null;
      const sessionId = named ? (rowSession?.id ?? key ?? null) : (openSession?.id ?? null);
      // A tap is the only thing that entitles the plugin to open its page or to act.
      run.lastActionAt = deps.now();
      run.grant = { at: run.lastActionAt, sessionId, session };
      run.toastEarned = true;
      const message: Record<string, unknown> = { t: "action", slot, action, session };
      if (item !== undefined) message.item = item;
      if (key !== undefined) message.key = key;
      run.sandbox.post(message);
      // The handler has run by the time the worker reaches this request, so it draws the result: the
      // tapped target and the unkeyed ones, not every row of a long list.
      requestRender(run, slot, key ?? "");
      for (const target of [...run.wanted]) {
        const other = slotOfTarget(target);
        if (!isKeyedSlot(other)) requestRender(run, other, "");
      }
    },
    async setEnabled(pluginId, enabled, hash) {
      const api = deps.api();
      if (!api) throw new Error("Pair this device with a computer before changing plugins.");
      await api.setPluginState(pluginId, enabled, hash);
      await reloadAfterChange();
    },
    async setOptions(pluginId, values) {
      const api = deps.api();
      if (!api) throw new Error("Pair this device with a computer before changing plugin options.");
      await api.setPluginOptions(pluginId, values);
      await reloadAfterChange();
    },
    resume() {
      if (!halted) return;
      halted = false;
      deps.guard.set(false);
      reconcile();
    },
    restart(pluginId) {
      if (!failures.delete(pluginId)) return;
      reconcile();
    },
    configure(next) {
      handlers = next;
    },
  };
}

/**
 * The real client behind the host: the daemon calls, with the existing `bash` and `rpc`
 * methods adapted to the plain result shapes a plugin is handed (a failure is a result,
 * never a throw).
 */
function hostApi(daemon: DaemonApi): PluginHostApi {
  return {
    listPlugins: () => daemon.listPlugins(),
    getPluginScript: (id) => daemon.getPluginScript(id),
    setPluginState: (id, enabled, hash) => daemon.setPluginState(id, enabled, hash),
    getPluginSource: (id, source) => daemon.getPluginSource(id, source),
    setPluginOptions: (id, values) => daemon.setPluginOptions(id, values),
    runPluginAction: (id, action, hash, arg) => daemon.runPluginAction(id, action, hash, arg),
    async bash(sessionId, command, excludeFromContext) {
      try {
        const reply = await daemon.bash(sessionId, command, { excludeFromContext });
        const exitCode = typeof reply.result?.exitCode === "number" ? reply.result.exitCode : null;
        return { ok: reply.ok !== false && exitCode === 0, output: String(reply.result?.output ?? ""), exitCode };
      } catch (error) {
        return { ok: false, output: "", exitCode: null, error: errorText(error) };
      }
    },
    async rpc(sessionId, command, params) {
      try {
        return { ok: true, data: await daemon.rpc<unknown>(sessionId, command, params) };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
  };
}

/** The real thing: the stored credential, the real sandbox, window timers. Browser APIs are touched only when called. */
export const pluginHost: PluginHost = createPluginHost({
  api: () => {
    // Built per call so a re-pair picks up the new token.
    const token = readPairingToken();
    return token ? hostApi(new DaemonApi(token)) : null;
  },
  createSandbox: createPluginSandbox,
  setTimer: (callback, ms) => window.setTimeout(callback, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
  now: () => Date.now(),
  isVisible: () => document.visibilityState !== "hidden",
  onVisibilityChange: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  onPageHide: (listener) => {
    window.addEventListener("pagehide", listener);
    return () => window.removeEventListener("pagehide", listener);
  },
  guard: {
    isSet: () => readBrowserPreference(GUARD_KEY) !== null,
    set: (on) => writeBrowserPreference(GUARD_KEY, on ? "1" : null),
  },
});
