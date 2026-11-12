import { CheckIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";

import { cn } from "@/lib/utils";

import { readPairingToken } from "../../platform/browser-storage";
import { DaemonApi } from "../../runtime/rpc-client";
import { startVisibleInterval } from "../../runtime/visible-interval";
import { parsePassiveSessionModel, selectContextPercent, type OmpStore, type OmpStoreApi } from "../../runtime/omp-store";
import { compactionPending, getCompactionOperation, type CompactOutcome, type CompactPhase } from "../../runtime/compaction";
export type { CompactPhase } from "../../runtime/compaction";
import { useStoreValue } from "../store-hooks";
import { contextFill } from "../ui/ContextMeter";

/** Fill at which the offer appears: early enough that compacting is a choice, not a rescue. */
const OFFER_AT = 40;
/** How long the result stays before the row folds away. */
const RESULT_MS = 4_000;

// Per app run, by session. A dismissed offer returns only once the window has
// filled another ten points; offering again at the same fill was nagging.
const dismissedBand = new Map<string, number>();
// A compaction that ended without a live reading leaves the newest reply's
// prompt size as the only figure, and that predates the summary: it would
// re-offer at the old fill until the next reply replaced it.
const staleReply = new Map<string, string>();

function newestReplyId(state: OmpStore): string | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i];
    if (message?.role === "assistant") return message.id;
  }
  return null;
}

/** All entry points share a credential/session-owned mutation and outcome.
 * The view may disappear; an uncertain operation remains read-only on reopen. */
export function useCompaction(store: OmpStoreApi, sessionPath: string | null) {
  const token = readPairingToken() ?? "";
  const operation = useMemo(() => getCompactionOperation(token, sessionPath ?? ""), [token, sessionPath]);
  const snapshot = useSyncExternalStore(operation.subscribe, operation.getSnapshot);
  const auto = useStoreValue(store, (state) => state.compacting !== null);
  const [autoPhase, setAutoPhase] = useState<CompactPhase | null>(null);
  const [hidden, setHidden] = useState<CompactPhase | null>(null);
  const scope = useMemo(() => ({ path: sessionPath, token }), [sessionPath, token]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const autoStart = useRef<{ scope: typeof scope; before: number | null } | null>(null);

  useEffect(() => {
    if (!sessionPath || !snapshot.state || store.getState().sessionPath !== sessionPath || (readPairingToken() ?? "") !== token) return;
    const current = store.getState();
    current.setSessionModel(
      parsePassiveSessionModel(snapshot.state, current.sessionModel, current.sessionModelProvenance),
      snapshot.state.source === "file" ? "file" : "live",
    );
  }, [snapshot, sessionPath, token, store]);

  useEffect(() => { setAutoPhase(null); }, [scope]);
  useEffect(() => {
    if (compactionPending(snapshot.phase)) setAutoPhase(null);
  }, [snapshot.phase]);

  const run = useCallback((customInstructions?: string) => {
    const current = store.getState();
    if (!sessionPath || current.sessionPath !== sessionPath || currentScope.current !== scope) {
      return Promise.resolve<CompactOutcome>({ kind: "failed", path: sessionPath ?? "", error: new Error("The session changed before compaction started.") });
    }
    setAutoPhase(null);
    return operation.run(selectContextPercent(current) ?? null, customInstructions);
  }, [operation, sessionPath, scope, store]);

  // Automatic compaction has its own authoritative start/end events. Keep
  // its passive refresh fenced to the actual visit, including A → B → A.
  useEffect(() => {
    if (!sessionPath) return;
    if (auto) {
      operation.observe({ isCompacting: true });
      const before = selectContextPercent(store.getState()) ?? null;
      autoStart.current = { scope, before };
      setAutoPhase({ kind: "running", path: sessionPath, startedAt: Date.now(), before });
      return;
    }
    const started = autoStart.current;
    autoStart.current = null;
    if (!started || started.scope !== scope) return;
    operation.observe({ isCompacting: false });
    let cancelled = false;
    void (async () => {
      let after: number | null = null;
      const ownsView = () => !cancelled && currentScope.current === scope &&
        store.getState().sessionPath === sessionPath && (readPairingToken() ?? "") === token;
      try {
        const state = await new DaemonApi(token).getState(sessionPath, { peek: true });
        if (!ownsView()) return;
        const current = store.getState();
        const parsed = parsePassiveSessionModel(state, current.sessionModel, current.sessionModelProvenance);
        after = parsed.ctxPercent ?? null;
        current.setSessionModel(parsed, state.source === "file" ? "file" : "live");
      } catch { /* The end event already acknowledged completion. */ }
      if (ownsView()) setAutoPhase({ kind: "done", path: sessionPath, before: started.before, after });
    })();
    return () => { cancelled = true; };
  }, [auto, scope, sessionPath, token, store, operation]);

  const phase = autoPhase?.path === sessionPath ? autoPhase : snapshot.phase;
  useEffect(() => {
    if (!phase || compactionPending(phase)) return;
    if (phase.kind === "done" && sessionPath) {
      if (phase.after === null) {
        const id = newestReplyId(store.getState());
        if (id) staleReply.set(sessionPath, id);
      } else staleReply.delete(sessionPath);
    }
    const id = window.setTimeout(() => setHidden(phase), RESULT_MS);
    return () => window.clearTimeout(id);
  }, [phase, sessionPath, store]);
  return { phase: phase === hidden ? null : phase, run };
}

/** Whether the open session should be offered a compaction right now. */
export function useCompactOffer(store: OmpStoreApi, sessionPath: string | null, busy: boolean): { percent: number; dismiss: () => void } | null {
  const percent = useStoreValue(store, selectContextPercent);
  const reply = useStoreValue(store, newestReplyId);
  const [, rerender] = useState(0);
  if (!sessionPath || busy || percent === undefined || percent < OFFER_AT) return null;
  const stale = staleReply.get(sessionPath);
  if (stale !== undefined) {
    if (stale === reply) return null;
    staleReply.delete(sessionPath);
  }
  const band = Math.floor(percent / 10);
  if ((dismissedBand.get(sessionPath) ?? -1) >= band) return null;
  return {
    percent,
    dismiss: () => {
      dismissedBand.set(sessionPath, band);
      rerender((n) => n + 1);
    },
  };
}

function seconds(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A 28px track whose fill eases to its new width, so the drop after a compaction is seen, not just read. */
function Gauge({ percent }: { percent: number }): JSX.Element {
  const { fill } = contextFill(percent);
  return (
    <span aria-hidden className="h-1 w-7 shrink-0 overflow-hidden rounded-full bg-surface-3">
      <span className={cn("block h-full w-full origin-left rounded-full transition-[scale] duration-700 ease-[var(--ease-position)]", fill)} style={{ scale: String(Math.min(100, percent) / 100) }} />
    </span>
  );
}

/**
 * Three lines folding into one: the summary taking the history's place.
 * Reduced motion keeps the lines still; the ring and the words still say it.
 */
function Condense(): JSX.Element {
  return (
    // Ragged widths read as lines of text; equal ones read as a menu icon.
    <span aria-hidden className="flex w-4 shrink-0 flex-col items-start gap-[3px]">
      {["w-4", "w-3", "w-2.5"].map((width, i) => (
        <span
          key={width}
          className={cn("h-[2px] origin-left rounded-full bg-primary-text motion-safe:animate-[condense_1.4s_var(--ease-smooth)_infinite]", width)}
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * The compaction row above the composer: an offer once the window is 40%
 * full, then the compaction itself while it runs, then what it freed.
 *
 * It sits beside the composer's context meter rather than at the top of the
 * chat: it is about the next message you send, the thumb is already there,
 * and the header and tab row above the transcript are navigation.
 */
export function CompactPill({
  phase,
  offer,
  onCompact,
}: {
  phase: CompactPhase | null;
  offer: { percent: number; dismiss: () => void } | null;
  onCompact: () => void;
}): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  const running = compactionPending(phase);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    return startVisibleInterval(() => setNow(Date.now()), 1000, { tickOnShow: true });
  }, [running]);

  const shell = "relative flex h-9 min-w-0 items-center gap-2.5 rounded-full bg-surface-1 text-meta tabular-nums";
  let body: JSX.Element | null = null;
  if (phase?.kind === "running" || phase?.kind === "uncertain") {
    body = (
      <div role="status" aria-live="polite" className={cn(shell, "live-ring px-3.5")} data-testid="compact-pill" data-state="compacting">
        <Condense />
        <span className="compact-shimmer font-medium">{phase.kind === "uncertain" ? "Checking compaction" : "Compacting context"}</span>
        {/* `now` is stale until the first tick; a fresh start must read 0s. */}
        <span className="text-muted-foreground">{seconds(Math.max(now, Date.now()) - phase.startedAt)}</span>
      </div>
    );
  } else if (phase?.kind === "done") {
    const { before, after } = phase;
    body = (
      <div role="status" aria-live="polite" className={cn(shell, "px-3.5")} data-testid="compact-pill" data-state="done">
        <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />
        {after !== null ? <Gauge percent={after} /> : null}
        <span className="font-medium text-foreground">Compacted</span>
        {before !== null && after !== null ? (
          <span className="text-muted-foreground">
            {Math.round(before)}% → <span className="text-foreground">{Math.round(after)}%</span>
          </span>
        ) : null}
      </div>
    );
  } else if (phase?.kind === "refused") {
    body = (
      <div role="status" aria-live="polite" className={cn(shell, "px-3.5 text-muted-foreground")} data-testid="compact-pill" data-state="refused">
        {phase.text}
      </div>
    );
  } else if (phase?.kind === "failed") {
    body = (
      <div role="status" className={cn(shell, "px-3.5 text-muted-foreground")} data-testid="compact-pill" data-state="failed">
        Couldn’t compact context
      </div>
    );
  } else if (offer) {
    const { tone } = contextFill(offer.percent);
    body = (
      <div className={cn(shell, "pr-0.5")} data-testid="compact-pill" data-state="offer">
        <button
          type="button"
          onClick={onCompact}
          className="relative flex h-full min-w-0 items-center gap-2.5 rounded-l-full pl-3.5 pr-1 outline-none [-webkit-tap-highlight-color:transparent] after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] active:opacity-85 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Context ${Math.round(offer.percent)}% full. Compact it`}
          data-testid="compact-pill-run"
        >
          <span className={tone}>Context {Math.round(offer.percent)}% full</span>
          <span aria-hidden className="text-tertiary">·</span>
          <span className="font-medium text-primary-text">Compact</span>
        </button>
        <button
          type="button"
          onClick={offer.dismiss}
          // `relative` anchors the 44px hit area to this button; unanchored it
          // covered the whole pill and every tap on Compact dismissed it.
          className="relative flex size-9 shrink-0 items-center justify-center rounded-full text-tertiary outline-none after:absolute after:-inset-1 after:content-[''] press-bounce focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Not now"
          data-testid="compact-pill-dismiss"
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      </div>
    );
  }
  if (!body) return null;
  return <div className="flex min-w-0 motion-safe:animate-[pop-in_var(--dur-slow)_var(--ease-spring)]">{body}</div>;
}
