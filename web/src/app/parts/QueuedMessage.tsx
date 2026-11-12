"use client";

import { useCallback, useContext, useEffect, useReducer, useRef, useState } from "react";
import { CircleAlertIcon, ClockIcon, PencilIcon, RotateCwIcon, SearchIcon, XIcon } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { showErrorToast, showToast } from "@/app/Notices";
import { useLinkIndicator } from "@/app/link-hooks";
import { UNCERTAIN_HINT, UNCERTAIN_LABEL, failedSendHint } from "@/app/send-copy";
import { humanizeReceiptError } from "@/app/ui/OwnedBySession";
import { ConfirmSheet } from "@/app/ui/Sheet";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { haptic } from "@/platform/haptic";
import { getImages, getOfflineQueueNamespace, type QueuedPrompt } from "@/runtime/offline-queue";
import { turnOutcome } from "@/runtime/receipt-outcome";
import { restoreWithdrawnDraft } from "../composer/withdrawn-draft";
import { TranscriptActionsContext } from "./TurnNotices";

// A saved command is not an offline one: it is durably owned by the outbox and
// delivery starts within moments, so it reads as ordinary sending first and
// only admits it has not gone once it has been pending long enough to be a
// real delay. The age runs from `createdAt`: the outbox re-dispatches a saved
// command every few seconds and each attempt bumps `updatedAt`, so measuring
// from the last state change kept a message sent into a dead link reading
// "Sending…" with a spinner for as long as the link stayed down.
const SLOW_SAVED_MS = 6_000;

/** How long a discard can be undone before the local copy is really removed. */
export const UNDO_MS = 5_000;

const textButton =
  "inline-flex min-h-[48px] max-w-full items-center gap-2 whitespace-normal break-words rounded-lg px-2 py-2 text-left font-medium text-primary-text outline-none active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]";

/** The link states in which no send can reach the computer. */
export function useSendLinkDown(): boolean {
  const { kind } = useLinkIndicator();
  return kind === "unreachable" || kind === "offline" || kind === "daemon-down";
}

/**
 * Re-renders when an unsettled send crosses SLOW_SAVED_MS, and returns the
 * test for "older than that". Time alone changes the answer, so a timer must
 * wake the caller; it is armed for the soonest crossing only.
 */
export function useSlowSend(entries: readonly QueuedPrompt[]): (entry: QueuedPrompt) => boolean {
  const [ticks, tick] = useReducer((n: number) => n + 1, 0);
  let nextDue = Infinity;
  for (const entry of entries) {
    if (entry.state !== "saved" && entry.state !== "dispatching") continue;
    const due = entry.createdAt + SLOW_SAVED_MS;
    if (due > Date.now() && due < nextDue) nextDue = due;
  }
  useEffect(() => {
    if (nextDue === Infinity) return;
    const timer = window.setTimeout(tick, Math.max(0, nextDue - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextDue, ticks]);
  return (entry) => Date.now() - entry.createdAt >= SLOW_SAVED_MS;
}

export type SendPhase = "waiting" | "sending" | "retrying" | "stalled";

/**
 * What an unsettled send is waiting for, or null when it is in no such state.
 * With the link down nothing is being attempted that can succeed, so it says
 * so; an old message never goes back to reading "Sending…".
 */
export function sendPhase(entry: QueuedPrompt, old: boolean, linkDown: boolean): SendPhase | null {
  if (entry.state !== "saved" && entry.state !== "dispatching") return null;
  if (linkDown) return "waiting";
  if (entry.state === "dispatching") return old ? "retrying" : "sending";
  return old ? "stalled" : "sending";
}

/**
 * Discards that can be taken back. The item is hidden at once and only really
 * cancelled when the grace period ends, so Undo restores it with its photos
 * and receipt intact; re-queueing or restoring to the composer could not keep
 * both. A discard already made must not be lost when the owner unmounts.
 */
export function useUndoableDiscard(): {
  hidden: ReadonlySet<string>;
  discard: (id: string, cancel: () => Promise<unknown>) => void;
} {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Map<string, { timer: number; fire: () => void }>());
  useEffect(() => () => {
    for (const { timer, fire } of timers.current.values()) { window.clearTimeout(timer); fire(); }
  }, []);
  const discard = useCallback((id: string, cancel: () => Promise<unknown>) => {
    const unhide = () => setHidden((ids) => { const next = new Set(ids); next.delete(id); return next; });
    const fire = () => {
      timers.current.delete(id);
      cancel()
        .catch((error) => { haptic("error"); showErrorToast(error); })
        .finally(unhide);
    };
    setHidden((ids) => new Set([...ids, id]));
    timers.current.set(id, { timer: window.setTimeout(fire, UNDO_MS), fire });
    showToast("Message discarded", "info", {
      label: "Undo",
      onClick: () => {
        const held = timers.current.get(id);
        if (!held) return;
        window.clearTimeout(held.timer);
        timers.current.delete(id);
        unhide();
      },
    }, { kind: "undo", durationMs: UNDO_MS });
  }, []);
  return { hidden, discard };
}

/**
 * Put a failed send's text and photos back in the composer, then drop the row.
 * A failed command's ID is spent, so the saved-message edit path (which
 * reserves and transfers a `saved` command) refuses it; this builds the same
 * restore from the row's own retained bytes. The draft is saved first and the
 * row removed only after, so a failed save loses nothing. Photos that were not
 * retained refuse the edit rather than silently coming back without them.
 */
export async function editFailedSend(entry: QueuedPrompt, cancel: () => Promise<boolean>): Promise<void> {
  const namespace = getOfflineQueueNamespace();
  const images = entry.imageCount > 0 ? await getImages(entry.commandId, namespace) : [];
  if (entry.droppedImages || images.length !== entry.imageCount)
    throw new Error("The original photos are unavailable. The message has been kept.");
  const recoveryId = JSON.stringify(["outbox-edit", entry.commandId, entry.createdAt, "failed"]);
  const notice = await restoreWithdrawnDraft(
    entry.sessionPath, { messages: [{ text: entry.text, images }], imagesDropped: false, truncated: false }, namespace, recoveryId,
  );
  await cancel();
  if (notice) showToast(notice);
}

/**
 * Delivery under a user bubble: saved, sending, or unconfirmed. An uncertain
 * handoff may already have reached the agent, so checking it must never look
 * like a fresh send and removing the local copy must not imply cancellation.
 */
export function QueuedMessage({
  entry,
  onCancel,
  onRetry,
  onEdit,
  reason,
}: {
  entry: QueuedPrompt;
  /** Resolves when the row is really gone, so a discard can hide it until then. */
  onCancel: () => unknown;
  onRetry: () => void;
  /** Puts a failed message back in the composer. */
  onEdit: () => unknown;
  reason?: string;
}) {
  const transcriptActions = useContext(TranscriptActionsContext);
  const [discard, setDiscard] = useState<{ cancel: () => void } | null>(null);
  useEffect(() => setDiscard(null), [entry.commandId, entry.state, entry.updatedAt]);
  const undoable = useUndoableDiscard();
  const isOld = useSlowSend([entry]);
  const linkDown = useSendLinkDown();
  const old = isOld(entry);
  // The daemon holds an accepted prompt until an agent frees up, then sends it
  // itself: the user still waits, but there is nothing to retry or cancel.
  const busy = entry.state === "accepted" && entry.receipt?.code === "agents_busy";
  // The agent received a failed prompt and only the turn ended early: the
  // transcript is the receipt, and "Not sent" would read as a lost message.
  if (entry.state === "failed" && turnOutcome(entry)) return null;
  if (!busy && entry.state !== "saved" && entry.state !== "dispatching" && entry.state !== "uncertain" && entry.state !== "failed") return null;
  if (undoable.hidden.has(entry.commandId)) return null;
  const phase = sendPhase(entry, old, linkDown);
  const sending = phase === "sending" || phase === "retrying";
  const waiting = phase === "waiting";
  // Only a send older than the grace period admits it has not gone.
  const slow = entry.state === "saved" && old;
  // A failed command is terminal: reusing its ID cannot start another
  // attempt, so only saved and uncertain delivery offer Try again.
  const retryable = entry.state === "uncertain" || slow;
  // `entry.error` is the daemon's own refusal text, humanized like every
  // other receipt surface; a caller-supplied `reason` is already human copy.
  const why =
    entry.state === "failed"
      ? (reason ?? (entry.error ? humanizeReceiptError(entry.error) : ""))
      : busy && entry.error
      ? humanizeReceiptError(entry.error)
      : "";
  const recovery = entry.state === "failed"
    ? errorRecoveryAction({ message: entry.error ?? entry.receipt?.error, code: entry.receipt?.code }, transcriptActions?.switchModel)
    : undefined;
  const RecoveryIcon = recovery?.icon;
  // Pill labels stay short; the hint says what to do about them. Failed rows
  // offer no Try again (the command ID is spent): Edit puts the message back in
  // the composer, Remove can be undone. The reason is the computer's own, and
  // follows the plain statement that the message was not sent. While the link
  // is down the label already says what is happening, so no hint competes.
  const hint = entry.state === "uncertain" ? UNCERTAIN_HINT
    : entry.state === "failed" ? failedSendHint(why)
    : waiting ? undefined
    : slow ? "This message wasn’t sent. Try again, or remove it."
    : undefined;
  return (
    <div
      className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-meta"
      role="status"
      aria-live="polite"
      aria-description={hint ?? (why || undefined)}
      title={why || undefined}
      data-testid="send-status"
      data-state={entry.state}
      data-slow={slow ? "true" : undefined}
    >
      {sending || busy ? (
        <Spinner size={14} label={null} className="text-muted-foreground" />
      ) : waiting ? (
        <ClockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="text-muted-foreground">
        {busy ? "Waiting for a free agent"
          : waiting ? "Waiting for connection"
          : phase === "retrying" ? "Trying again…"
          : sending ? "Sending…"
          : entry.state === "uncertain" ? UNCERTAIN_LABEL
          : "Not sent"}
      </span>
      {entry.state === "failed" ? (
        <button type="button" className={textButton} aria-label="Edit" onClick={() => void onEdit()}>
          <PencilIcon aria-hidden className="size-4 shrink-0" />
          Edit
        </button>
      ) : null}
      {retryable ? (
        // An uncertain send asks the computer whether it arrived and resends
        // nothing; only a saved one sends again. The label says which.
        <button type="button" className={textButton} aria-label={entry.state === "uncertain" ? "Check" : "Try again"} onClick={onRetry}>
          {entry.state === "uncertain" ? <SearchIcon aria-hidden className="size-4 shrink-0" /> : <RotateCwIcon aria-hidden className="size-4 shrink-0" />}
          {entry.state === "uncertain" ? "Check" : "Try again"}
        </button>
      ) : null}
      {recovery ? (
        <button type="button" className={textButton} aria-label={recovery.label} onClick={recovery.onClick}>
          {RecoveryIcon ? <RecoveryIcon aria-hidden className="size-4 shrink-0" strokeWidth={1.5} /> : null}
          {recovery.label}
        </button>
      ) : null}
      {entry.state !== "dispatching" && !busy ? (
        <button
          type="button"
          aria-label="Remove"
          onClick={() => entry.state === "uncertain" ? setDiscard({ cancel: onCancel })
            : entry.state === "failed" ? undoable.discard(entry.commandId, async () => { await onCancel(); })
            : onCancel()}
          className="relative -my-3 -mr-2 ml-auto flex size-[48px] shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      ) : null}
      {hint ? <p className="basis-full break-words text-muted-foreground">{hint}</p> : null}
      <ConfirmSheet
        open={discard !== null}
        onOpenChange={(open) => { if (!open) setDiscard(null); }}
        title="Remove unconfirmed message?"
        description="Delivery is unconfirmed. Removing this device’s copy does not cancel work already accepted by the computer."
        confirmLabel="Remove"
        onConfirm={() => { const held = discard; setDiscard(null); held?.cancel(); }}
      />
    </div>
  );
}
