"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { PencilIcon, Settings2Icon } from "lucide-react";
import type { UiMessage } from "@/domain/messages";
import { isNetworkError, NETWORK_HINT, REFUSAL_NOTE, retryCaption } from "@/domain/turn-errors";
import { humanizeProviderError, retryCountdown, type RetryStatus } from "@/domain/run-status";
import { startVisibleInterval } from "@/runtime/visible-interval";

/**
 * What the transcript may offer: switching model and editing only change
 * local UI, and a declined prompt goes back to the composer for the user to
 * send. `stopTurn` is the composer's Stop (same abort, same queued-message
 * restore), for a running agent command that cannot be stopped on its own.
 */
export interface TranscriptActions {
  switchModel(): void;
  editPrompt(text: string): void;
  stopTurn(): Promise<unknown>;
}

export const TranscriptActionsContext = createContext<TranscriptActions | null>(null);

const noticeAction =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-meta font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function SwitchModelButton() {
  const actions = useContext(TranscriptActionsContext);
  if (!actions) return null;
  return (
    <button type="button" className={noticeAction} onClick={actions.switchModel}>
      <Settings2Icon aria-hidden className="size-3.5 shrink-0" />
      Switch model
    </button>
  );
}

/**
 * A refusal is never written to the transcript, so after a reload the prompt
 * would sit unanswered. This stands where the reply would be.
 */
export function RefusalNote({ text }: { text: string }) {
  const actions = useContext(TranscriptActionsContext);
  return (
    <div className="flex min-w-0 flex-col gap-1 text-meta text-muted-foreground" data-testid="refusal-note" role="status">
      <p className="min-h-6">{REFUSAL_NOTE}</p>
      {actions ? (
        <div className="-ml-2 flex flex-wrap items-center gap-1">
          <SwitchModelButton />
          {text ? (
            <button type="button" className={noticeAction} onClick={() => actions.editPrompt(text)}>
              <PencilIcon aria-hidden className="size-3.5 shrink-0" />
              Edit
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The attempts omp's auto-retry replaced, as one quiet line: they are omp
 * handling the problem, not failures to act on. Only the error a turn ends
 * on (e.g. "Retry budget exhausted") renders red, as its own message.
 *
 * While omp waits out the backoff (`live`) the line counts down once a second
 * (`retrying in 8s (2/5)`, the countdown dropped once it elapses), the
 * provider error is one tap deep, and `onCancel` (given only when the daemon's
 * own child runs the session) ends the wait.
 */
export function RetryNotice({ messages, recovered, live, onCancel }: {
  messages: readonly UiMessage[];
  recovered: boolean;
  live: RetryStatus | null;
  onCancel?: () => Promise<void>;
}) {
  const network = messages.some((message) => isNetworkError(message.errorMessage));
  const [now, setNow] = useState(() => Date.now());
  const [errorOpenFor, setErrorOpenFor] = useState<RetryStatus | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const resumeAt = live?.resumeAt ?? null;
  // Ticks only while a countdown is pending and the page is visible.
  useEffect(() => {
    if (resumeAt === null || resumeAt <= Date.now()) return;
    setNow(Date.now());
    const stop = startVisibleInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= resumeAt) stop();
    }, 1000, { tickOnShow: true });
    return stop;
  }, [resumeAt]);
  // `now` is stale until the first tick; a new backoff must not flash a
  // countdown measured from an older render.
  const countdown = live ? retryCountdown(live, Math.max(now, Date.now())) : null;
  const caption = retryCaption(messages.length, network, { live, countdown, recovered });
  const detail = live ? humanizeProviderError(live.error) : null;
  const errorOpen = detail !== null && errorOpenFor === live;
  const cancel = async (): Promise<void> => {
    if (!onCancel) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };
  return (
    <div className="flex min-h-11 min-w-0 flex-col justify-center text-meta tabular-nums text-muted-foreground" data-testid="retry-notice" role="status">
      <div className="flex min-w-0 items-center gap-3">
        {detail ? (
          <button type="button" aria-expanded={errorOpen} data-testid="retry-error-toggle" onClick={() => setErrorOpenFor(errorOpen ? null : live)}
            className="pressable relative min-w-0 text-left after:absolute after:inset-x-0 after:-inset-y-3 after:content-[''] focus-visible:outline-2 focus-visible:outline-ring">
            {caption}
          </button>
        ) : <p className="min-w-0">{caption}</p>}
        {live && onCancel ? (
          <button type="button" disabled={cancelling} onClick={() => void cancel()} data-testid="retry-cancel"
            className="pressable relative ml-auto shrink-0 font-medium text-primary-text disabled:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-3 after:content-[''] focus-visible:outline-2 focus-visible:outline-ring">
            Cancel
          </button>
        ) : null}
      </div>
      {errorOpen ? <p className="min-w-0 text-caption" data-testid="retry-error">{detail}</p> : null}
      {live && network ? <p className="text-caption">{NETWORK_HINT}</p> : null}
    </div>
  );
}
