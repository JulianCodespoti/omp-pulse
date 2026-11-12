import type { OmpSessionState, OmpStoreApi } from "./omp-store";

/** Only full-source server counts are exact; filtered display rows are not. */
export function parseRunningAgentCount(value: unknown): { count: number | null; connectionId: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.ok !== true || !Array.isArray(v.agents) || typeof v.connectionId !== "string" || !v.connectionId.trim()) return null;
  const count = v.runningCount;
  if (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 4096)) return null;
  return { count: count as number | null, connectionId: v.connectionId };
}

function scope(state: OmpSessionState): string | null {
  const path = state.sessionPath;
  const authority = path ? state.sessionAuthorities[path] : undefined;
  if (!path || state.connection !== "open" || state.authRejected || !authority ||
    authority.confidence !== "confirmed" || authority.connection !== "connected" ||
    !["bridge", "collab"].includes(authority.owner.kind)) return null;
  return JSON.stringify([path, authority.daemonInstanceId, authority.bindingEpoch, authority.owner]);
}

/** Latest host-reported count, with bounded local freshness, not process liveness.
 * Untagged events are refresh hints only: their payload may precede a new lease.
 */
export class RunningAgentCountTracker {
  private unsubscribe: (() => void) | null = null;
  private timer: number | null = null;
  private key: string | null = null;
  private epoch = 0;
  private pending: { abort: AbortController; epoch: number } | null = null;
  private dirty = false;
  private connectionId: string | null = null;
  private readonly visibility = () => this.reconcile();

  constructor(
    private readonly store: OmpStoreApi,
    private readonly read: (path: string, signal: AbortSignal) => Promise<unknown>,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.store.subscribe(() => this.reconcile());
    document.addEventListener("visibilitychange", this.visibility);
    this.reconcile();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    document.removeEventListener("visibilitychange", this.visibility);
    this.reset(null);
  }

  /** Every roster/link/resync ingress obsoletes prior HTTP, even same-state attached. */
  invalidate(): void {
    if (!this.unsubscribe) return;
    ++this.epoch;
    this.publish(null);
    this.dirty = true;
    this.refresh();
  }

  private publish(count: number | null): void {
    if (this.store.getState().runningAgentCount !== count) this.store.setState({ runningAgentCount: count });
  }

  private reset(key: string | null): void {
    this.key = key;
    ++this.epoch;
    this.pending?.abort.abort();
    this.pending = null;
    this.dirty = false;
    this.connectionId = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.publish(null);
  }

  private reconcile(): void {
    const key = document.visibilityState === "visible" ? scope(this.store.getState()) : null;
    if (key === this.key) return;
    this.reset(key);
    if (!key) return;
    // The read lease can disappear without a socket event while the bridge
    // remains connected. Expire independently of a potentially hung request.
    this.timer = window.setInterval(() => {
      // Abort also releases our slot if a transport ignores cancellation. Its
      // eventual completion stays fenced by object identity and epoch.
      this.pending?.abort.abort();
      this.pending = null;
      this.invalidate();
    }, 10_000);
    this.refresh();
  }

  private refresh(): void {
    if (!this.key || this.pending || !this.unsubscribe) return;
    const path = this.store.getState().sessionPath!;
    const request = { abort: new AbortController(), epoch: this.epoch };
    this.pending = request;
    this.dirty = false;
    void this.read(path, request.abort.signal).then((value) => {
      if (this.pending !== request || request.epoch !== this.epoch) return;
      const result = parseRunningAgentCount(value);
      if (!result) { this.publish(null); return; }
      if (this.connectionId !== result.connectionId) this.publish(null);
      this.connectionId = result.connectionId;
      this.publish(result.count);
    }, () => {
      if (this.pending === request && request.epoch === this.epoch) this.publish(null);
    }).finally(() => {
      if (this.pending !== request) return;
      this.pending = null;
      if (this.dirty) this.refresh();
    });
  }
}
