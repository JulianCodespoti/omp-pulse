import { useEffect, useMemo, useRef, useState } from "react";

import type { OmpSessionController } from "@/runtime/omp-session-controller";
import { selectActivity, selectSessionAuthority, selectSessionTurn } from "@/runtime/omp-store";
import { startVisibleInterval } from "@/runtime/visible-interval";
import { useStoreValue } from "@/app/store-hooks";
import { runningStepTitle } from "../parts/run-summary";
import { createLastUserMessageAtSelector } from "./turn-status-selectors";
import { humanizeProviderError, retryLabel } from "@/domain/run-status";
import { showToast } from "../Notices";

/** What the newest turn's footer shows while that turn is live. */
export interface LiveTurn {
  /** Epoch ms the turn began; omitted when it is not known. */
  startedAt?: number;
  currentStep: string;
  /** Cancel during omp's retry backoff. */
  action?: { label: string; onClick: () => void };
  /**
   * Epoch ms of the last token, tool event or step change; read per render
   * because it moves with every token and must not re-render the hook. Absent
   * while a retry wait owns the footer: the countdown outranks "taking longer".
   */
  activityAt?: () => number;
  /** Which live state this is, for the footer's data-state and tests. */
  state: "running" | "retrying";
}

/**
 * The live state of the newest turn, or null when nothing is in flight.
 *
 * During omp's retry backoff the footer says so instead, so the phone never
 * looks frozen while omp is deliberately waiting. Compaction is shown by the
 * pill above the composer (CompactPill), one voice for it rather than two.
 * A turn whose state is uncertain (the link to your computer is down, or the turn
 * is unknown) is NOT reported as live: one offline notice owns that moment,
 * and a footer claiming "Working" over stale state was a second, wrong voice.
 */
export function useLiveTurn(controller: OmpSessionController): LiveTurn | null {
  const store = controller.getStore();
  const turn = useStoreValue(store, (s) => selectSessionTurn(s, s.sessionPath ?? ""));
  const authority = useStoreValue(store, (s) => selectSessionAuthority(s, s.sessionPath ?? ""));
  const connection = useStoreValue(store, (s) => s.connection);
  // Unknown turn state is only uncertainty for a session we hold a record of;
  // a file-only desktop chat is always "unknown" and its partial line is real.
  const uncertain = connection !== "open" || (authority !== null && (authority.connection !== "connected" || turn === "unknown"));
  const activity = useStoreValue(store, (s) => selectActivity(s, s.sessionPath ?? ""));
  // A desktop turn with no control link reaches the phone only as file
  // growth (a partial line), never as a running turn or activity.
  const foreign = useStoreValue(store, (s) => !selectSessionAuthority(s, s.sessionPath ?? "") && s.partialLine !== null && selectSessionTurn(s, s.sessionPath ?? "") !== "running");
  const lastUserMessageAt = useMemo(createLastUserMessageAtSelector, []);
  const userAt = useStoreValue(store, lastUserMessageAt);
  const step = useStoreValue(store, (s) => runningStepTitle(s.messages, s.streamingMessage));
  const thinking = useStoreValue(store, (s) => s.streamingMessage?.parts.some((part) => part.kind === "thinking") ?? false);
  const retry = useStoreValue(store, (s) => s.autoRetry);
  const [cancelling, setCancelling] = useState(false);

  const lastActivity = useRef(Date.now());
  useEffect(() => {
    // Compared by value, not identity, where the store may re-issue an equal object.
    const snapshot = () => {
      const s = store.getState();
      const a = selectActivity(s, s.sessionPath ?? "");
      return { streaming: s.streamingMessage, messages: s.messages, partial: s.partialLine, activity: a ? `${a.state}|${a.tool}|${a.label}|${a.since}` : null };
    };
    let seen = snapshot();
    lastActivity.current = Date.now();
    return store.subscribe(() => {
      const next = snapshot();
      if (next.streaming === seen.streaming && next.messages === seen.messages && next.partial === seen.partial && next.activity === seen.activity) return;
      seen = next;
      lastActivity.current = Date.now();
    });
  }, [store]);

  // The retry countdown is the only figure here that needs a clock; the
  // footer keeps its own elapsed time. It ticks only until it reaches zero:
  // an elapsed countdown is not shown.
  const [now, setNow] = useState(() => Date.now());
  const countingDown = retry !== null && retry.resumeAt !== null && now < retry.resumeAt;
  useEffect(() => {
    if (!countingDown) return;
    // A hidden page renders nothing, so it arms no clock; showing it re-reads
    // the wall clock at once.
    return startVisibleInterval(() => setNow(Date.now()), 1000, { tickOnShow: true });
  }, [countingDown]);

  const startedAt = activity?.turnStartedAt ?? userAt ?? undefined;
  // A start more than 12h back is a stale timestamp, not a live turn.
  const freshStart = startedAt !== undefined && startedAt <= Date.now() + 5_000 && Date.now() - startedAt < 12 * 60 * 60 * 1000 ? startedAt : undefined;

  // `now` is stale while nothing ticks; a retry arriving then must not flash
  // a countdown measured from the last tick.
  const retryLine = retry ? retryLabel(retry, Math.max(now, Date.now())) : null;
  if (retry && retryLine) {
    const detail = humanizeProviderError(retry.error);
    // Only a daemon child can be cancelled from here; a desktop owner refuses
    // abort_retry at the ownership gate and its Stop already cancels the retry.
    const canCancel = !authority || authority.owner.kind === "child";
    const cancel = async (): Promise<void> => {
      if (cancelling) return;
      setCancelling(true);
      try {
        const refusal = await controller.abortRetry();
        if (refusal) showToast(refusal, "error");
      } catch {
        showToast("Couldn't cancel the retry.", "error");
      } finally {
        setCancelling(false);
      }
    };
    return {
      state: "retrying",
      startedAt: freshStart,
      currentStep: detail ? `${retryLine} · ${detail}` : retryLine,
      action: canCancel ? { label: "Cancel", onClick: () => void cancel() } : undefined,
    };
  }
  if (uncertain) return null;
  if (activity === null && turn !== "running" && !foreign) return null;
  const currentStep = activity?.state === "tool" ? step || activity.label : step;
  return {
    state: "running",
    startedAt: freshStart,
    activityAt: () => lastActivity.current,
    currentStep: currentStep?.trim()
      ? `${currentStep.trim().replace(/[.…]+$/, "")}…`
      : activity?.state === "thinking" || thinking ? "Thinking…" : "Working…",
  };
}
