import { readPairingToken } from "../platform/browser-storage";
import type { SessionState } from "./api-types";
import { AuthError, DaemonApi, ForbiddenError, isOwnershipError } from "./rpc-client";

export type CompactPhase =
  | { kind: "running"; path: string; startedAt: number; before: number | null }
  | { kind: "uncertain"; path: string; startedAt: number; before: number | null }
  | { kind: "done"; path: string; before: number | null; after: number | null; reply?: unknown }
  | { kind: "refused"; path: string; text: string }
  | { kind: "failed"; path: string; error: unknown };
export type CompactOutcome = Exclude<CompactPhase, { kind: "running" }>;
export type CompactSnapshot = { phase: CompactPhase | null; state?: SessionState };
export const compactionPending = (phase: CompactPhase | null): boolean => phase?.kind === "running" || phase?.kind === "uncertain";
const POLL_MS = 4_000;
const operations = new Map<string, Map<string, CompactionOperation>>();

/** A mutation belongs to a credential and session, not to the surface that started it.
 * Lost acknowledgements are reconciled by reads only, including after a sheet reopens. */
export class CompactionOperation {
  private snapshot: CompactSnapshot = { phase: null };
  private listeners = new Set<() => void>();
  private request: Promise<CompactOutcome> | null = null;
  private timer: number | null = null;
  private reading: object | null = null;
  private observation = 0;
  private generation = 0;
  private sawCompacting = false;
  private beforePercent: number | null = null;
  private beforeTokens: number | undefined;
  constructor(private token: string, private path: string) {}
  getSnapshot = (): CompactSnapshot => this.snapshot;
  private authorized = () => (readPairingToken() ?? "") === this.token;
  private publish(snapshot: CompactSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const phase = this.snapshot.phase;
    if (phase?.kind === "running" && !this.request) this.publish({ phase: { ...phase, kind: "uncertain" } });
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.observation++;
        this.reading = null;
      }
      if (!this.listeners.size && this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
    };
  };
  private schedule() {
    if (!this.listeners.size || !this.authorized() || this.snapshot.phase?.kind !== "uncertain" || this.timer !== null || this.reading) return;
    this.timer = window.setTimeout(() => { this.timer = null; void this.refresh(); }, POLL_MS);
  }
  observe = (state: SessionState) => {
    const phase = this.snapshot.phase;
    if (!this.authorized() || !compactionPending(phase)) return;
    const percent = state.contextUsage?.percent;
    const tokens = state.contextUsage?.tokens;
    const dropped = this.beforePercent !== null && typeof percent === "number" && percent < this.beforePercent - 5;
    const tokensDropped = this.beforeTokens !== undefined && typeof tokens === "number" && tokens < this.beforeTokens;
    const ended = this.sawCompacting && state.isCompacting === false;
    this.sawCompacting ||= state.isCompacting === true;
    if (state.isCompacting !== true && (dropped || tokensDropped || ended) && phase && "before" in phase) {
      this.publish({ phase: { kind: "done", path: this.path, before: phase.before, after: percent ?? null }, state });
    }
    if (this.beforePercent === null && typeof percent === "number") this.beforePercent = percent;
    if (this.beforeTokens === undefined && typeof tokens === "number") this.beforeTokens = tokens;
  };
  private async refresh() {
    if (!this.authorized() || !this.listeners.size) return;
    const generation = this.generation;
    const observation = this.observation;
    const attempt = {};
    this.reading = attempt;
    try {
      const state = await new DaemonApi(this.token).getState(this.path, { peek: true });
      if (generation !== this.generation || observation !== this.observation || !this.authorized() || !this.listeners.size) return;
      this.observe(state);
    } catch {
      // An unavailable reading cannot prove that the mutation failed.
    } finally {
      if (this.reading === attempt) {
        this.reading = null;
        this.schedule();
      }
    }
  }
  run = (before: number | null, customInstructions?: string, baseline?: SessionState): Promise<CompactOutcome> => {
    if (!this.path || !this.authorized()) return Promise.resolve({ kind: "failed", path: this.path, error: new Error("The session changed before compaction started.") });
    if (this.request) return this.request;
    if (this.snapshot.phase?.kind === "uncertain") return Promise.resolve(this.snapshot.phase);
    const generation = ++this.generation;
    this.beforeTokens = baseline?.contextUsage?.tokens;
    this.beforePercent = before;
    this.sawCompacting = baseline?.isCompacting === true;
    const startedAt = Date.now();
    this.publish({ phase: { kind: "running", path: this.path, startedAt, before } });
    // Defer transport until request is installed: even same-event callers share it.
    const request = Promise.resolve().then(async (): Promise<CompactOutcome> => {
      const current = () => generation === this.generation && this.authorized();
      try {
        if (!current()) return { kind: "failed", path: this.path, error: new Error("The credential changed before compaction started.") };
        const reply = await new DaemonApi(this.token).compact(this.path, customInstructions);
        const phase: CompactOutcome = { kind: "done", path: this.path, before, after: null, reply };
        if (current()) {
          this.publish({ phase });
          // Acknowledgement settles the mutation even if this optional read
          // hangs. A newer generation owns any later refresh.
          const observation = this.observation;
          if (this.listeners.size) void new DaemonApi(this.token).getState(this.path, { peek: true }).then((state) => {
            if (current() && observation === this.observation && this.listeners.size) this.publish({ phase: { ...phase, after: state.contextUsage?.percent ?? null }, state });
          }).catch(() => {});
        }
        return phase;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        const refused = isOwnershipError(error) || error instanceof AuthError || error instanceof ForbiddenError;
        const phase: CompactOutcome = refused ? { kind: "failed", path: this.path, error }
          : /nothing to compact|too small/i.test(text) ? { kind: "refused", path: this.path, text }
            : /timed? ?out|timeout|network|failed to fetch|load failed|connection/i.test(text) || (error instanceof Error && error.name === "AbortError")
              ? { kind: "uncertain", path: this.path, before, startedAt }
              : { kind: "failed", path: this.path, error };
        // A concurrent authoritative observation wins over a late transport error.
        if (current() && this.snapshot.phase?.kind !== "done") this.publish({ phase });
        const outcome = this.snapshot.phase;
        return current() && outcome && outcome.kind !== "running" ? outcome : phase;
      } finally {
        if (this.request === request) this.request = null;
        this.schedule();
      }
    });
    this.request = request;
    return request;
  };
}

export function getCompactionOperation(token: string, path: string): CompactionOperation {
  let sessions = operations.get(token);
  if (!sessions) operations.set(token, sessions = new Map());
  let operation = sessions.get(path);
  if (!operation) sessions.set(path, operation = new CompactionOperation(token, path));
  return operation;
}
