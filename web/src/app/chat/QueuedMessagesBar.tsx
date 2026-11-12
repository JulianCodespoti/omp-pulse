"use client";

import { ArrowUpIcon, CircleAlertIcon, ClockIcon, CornerDownRightIcon, PencilIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import { useLayoutEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useStoreValue } from "@/app/store-hooks";
import { showErrorToast, showToast } from "@/app/Notices";
import { UNCERTAIN_HINT, UNCERTAIN_LABEL, UNCERTAIN_SEND_TOAST, failedSendHint } from "@/app/send-copy";
import { ConfirmSheet } from "@/app/ui/Sheet";
import { humanizeReceiptError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { haptic } from "@/platform/haptic";
import { pendingIntentActions } from "@/runtime/browser-pending-actions";
import type { QueuedPrompt } from "@/runtime/offline-queue";
import type { OmpSessionController } from "@/runtime/omp-session-controller";
import { selectCanPromoteQueuedMessage } from "@/runtime/omp-store";
import { turnOutcome } from "@/runtime/receipt-outcome";
import { PendingQueueActions } from "./pending-queue-actions";
import { restoreWithdrawnDraft } from "../composer/withdrawn-draft";
import { editFailedSend, sendPhase, useSendLinkDown, useSlowSend, useUndoableDiscard, type SendPhase } from "../parts/QueuedMessage";
import { getDraftNamespace } from "../composer/use-draft";

type QueueRow =
  | { kind: "steering" | "followUp"; text: string; key: string; taken: boolean; itemId?: string }
  | { kind: "outbox"; text: string; key: string; entry: QueuedPrompt };

const KIND_LABEL = { steering: "Steering", followUp: "Queued" } as const;

/**
 * The one queue surface, directly above the composer card: messages omp is
 * holding or has taken into the active response (its own `queue_update`
 * snapshot), and durable sends with no transcript bubble yet. Only held rows
 * offer Edit/Remove: being taken into the response is not evidence that the
 * provider has acted on the instruction.
 *
 * Discarding a durable send may lose images and is the device's sole record
 * of the message, so it is undoable for a few seconds (saved/refused) or asks
 * first (unconfirmed: it may already have arrived). A queued omp message is
 * one tap, as in the terminal; Edit keeps its original text and photos.
 */
export function QueuedMessagesBar({ controller, pending, onChooseModel }: {
  controller: OmpSessionController;
  /** Retained sends for this credential/session with no transcript bubble. */
  pending: readonly QueuedPrompt[];
  onChooseModel?: () => void;
}) {
  const store = controller.getStore();
  const queued = useStoreValue(store, (s) => s.queuedMessages);
  const sessionPath = useStoreValue(store, state => state.sessionPath);
  const canPromote = useStoreValue(store, state => state.sessionPath !== null
    && selectCanPromoteQueuedMessage(state, state.sessionPath));
  const [inflight] = useState(() => new PendingQueueActions());
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [discard, setDiscard] = useState<QueuedPrompt | null>(null);
  const undo = useUndoableDiscard();
  const isOld = useSlowSend(pending);
  const linkDown = useSendLinkDown();
  useLayoutEffect(() => {
    inflight.reset();
    setBusyKeys(new Set());
    setDiscard(null);
    return () => inflight.reset();
  }, [inflight, sessionPath, controller]);

  const counts = new Map<string, number>();
  const rows: QueueRow[] = [
    ...pending.filter(entry => !undo.hidden.has(entry.commandId)).map((entry) => ({ kind: "outbox" as const, text: entry.text, key: `outbox\u0000${entry.commandId}`, entry })),
    ...[
      ...queued.steering.map((text, index) => ({ kind: "steering" as const, text, taken: queued.liveSteered === null || index < queued.liveSteered, itemId: queued.steeringIds?.[index] })),
      ...queued.followUp.map((text, index) => ({ kind: "followUp" as const, text, taken: false, itemId: queued.followUpIds?.[index] })),
    ].map((row) => {
      // Exact owner IDs survive duplicate neighbours leaving the queue.
      const id = `${row.kind}\u0000${row.taken ? "taken" : "held"}\u0000${row.itemId ?? row.text}`;
      const n = counts.get(id) ?? 0;
      counts.set(id, n + 1);
      return { ...row, key: `${id}\u0000${n}` };
    }),
  ];

  async function act(key: string, run: () => Promise<void>): Promise<void> {
    if (!sessionPath || store.getState().sessionPath !== sessionPath) return;
    const token = inflight.begin(key);
    if (token === null) return;
    setBusyKeys(keys => new Set([...keys, key]));
    const isCurrent = () => inflight.isCurrent(key, token) && store.getState().sessionPath === sessionPath;
    try {
      await run();
    } catch (error) {
      if (isCurrent()) {
        haptic("error");
        showErrorToast(error);
      }
    } finally {
      if (inflight.finish(key, token)) {
        setBusyKeys(keys => {
          const next = new Set(keys);
          next.delete(key);
          return next;
        });
      }
    }
  }

  // omp declined: the message was delivered before the tap landed.
  const delivered = () => showToast("This message is no longer held in the queue.", "info");

  const queueActions = (row: Extract<QueueRow, { kind: "steering" | "followUp" }>) => row.taken || !row.itemId ? {
    edit: undefined, sendNow: undefined, remove: undefined, removeLabel: "Remove queued message",
  } : ({
    edit: () => act(row.key, async () => {
      const result = await controller.removeQueuedMessage(row.kind, row.text, row.itemId!);
      if (result.removed && result.sessionPath) {
        const notice = await restoreWithdrawnDraft(result.sessionPath, result.withdrawn, result.namespace);
        // Only now is the text safe on this device; before this the daemon's
        // journal is the sole copy and must survive a failed save.
        await controller.acknowledgeQueueRecovery(result.sessionPath, result.withdrawn.recoveryId, result.namespace);
        if (notice && store.getState().sessionPath === result.sessionPath
          && getDraftNamespace() === result.namespace) showToast(notice);
      } else delivered();
    }),
    // A steer already lands at the next step; only a follow-up can move up.
    sendNow: row.kind === "followUp" && canPromote ? () => act(row.key, async () => {
      if (!await controller.promoteQueuedMessage(row.text, row.itemId!)) delivered();
    }) : undefined,
    remove: () => act(row.key, async () => {
      const result = await controller.removeQueuedMessage(row.kind, row.text, row.itemId!, false);
      if (!result.removed) delivered();
      else if (result.sessionPath) await controller.acknowledgeQueueRecovery(result.sessionPath, result.withdrawn.recoveryId, result.namespace);
    }),
    removeLabel: "Remove queued message",
  });

  const outboxActions = (entry: QueuedPrompt, key: string) => {
    const actions = pendingIntentActions(entry);
    // A reserved saved row resumes the same transfer after reload/ack loss.
    // Uncertain and dispatching sends never gain edit authority.
    const settled = entry.state !== "dispatching" && entry.state !== "accepted"
      && entry.state !== "received" && entry.state !== "running";
    return {
      edit: entry.state === "saved" ? () => act(key, async () => {
        const restored = await actions.edit(async (withdrawn, namespace, recoveryId) => {
          await restoreWithdrawnDraft(entry.sessionPath, withdrawn, namespace, recoveryId);
        });
        if (!restored) showToast("This saved message has moved on.", "info");
      }) : entry.state === "failed" ? () => act(key, () => editFailedSend(entry, actions.cancel)) : undefined,
      sendNow: (entry.state === "saved" || entry.state === "uncertain") && !entry.editToken ? () => act(key, async () => {
        const receipt = await actions.retry();
        if (receipt?.state === "failed" || receipt?.state === "uncertain") {
          haptic("error");
          if (receipt.state === "uncertain") showToast(UNCERTAIN_SEND_TOAST, "warn");
          else showErrorToast(receipt.error ?? "Couldn’t send the message.");
        }
      }) : undefined,
      remove: settled ? () => entry.state === "uncertain" ? setDiscard(entry) : undo.discard(entry.commandId, () => actions.cancel()) : undefined,
      removeLabel: "Discard message",
    };
  };

  if (rows.length === 0 && !discard) return null;

  return (
    <>
      {rows.length > 0 ? (
        <ul
          data-testid="queued-messages"
          aria-label="Message delivery"
          className="mb-1.5 flex flex-col divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-surface-1"
        >
          {rows.map((row) => {
            const actions = row.kind === "outbox" ? outboxActions(row.entry, row.key) : queueActions(row);
            const busy = busyKeys.has(row.key);
            const outcome = row.kind === "outbox" ? turnOutcome(row.entry) : null;
            const recovery = row.kind === "outbox" && row.entry.state === "failed"
              ? errorRecoveryAction({ message: row.entry.error ?? row.entry.receipt?.error, code: row.entry.receipt?.code }, onChooseModel)
              : undefined;
            const RecoveryIcon = recovery?.icon;
            const phase = row.kind === "outbox" ? sendPhase(row.entry, isOld(row.entry), linkDown) : null;
            const why = row.kind === "outbox" && row.entry.state === "failed" && row.entry.error ? humanizeReceiptError(row.entry.error) : "";
            // The pill stays short; the hint says what to do. A failed outbox
            // row has no Retry (the command ID is spent): Edit puts it back in
            // the composer and Discard can be undone.
            const hint = row.kind !== "outbox" || outcome ? undefined
              : row.entry.state === "uncertain" ? UNCERTAIN_HINT
              : row.entry.state === "failed" ? failedSendHint(why)
              : undefined;
            return (
              <li
                key={row.key}
                data-testid="queued-message"
                data-kind={row.kind}
                data-command-id={row.kind === "outbox" ? row.entry.commandId : undefined}
                className="flex min-h-11 flex-wrap items-center gap-2 pl-3 pr-1"
              >
                <RowGlyph row={row} phase={phase} />
                <span className="min-w-0 flex-1 truncate text-ui text-foreground">{row.text}</span>
                {row.kind === "outbox" && row.entry.imageCount > 0 ? (
                  <span className="shrink-0 text-meta tabular-nums text-muted-foreground">
                    {row.entry.imageCount} image{row.entry.imageCount === 1 ? "" : "s"}
                  </span>
                ) : null}
                {row.kind !== "outbox" && (row.taken || !row.itemId) ? (
                  <span role="status" title={row.taken && queued.liveSteered !== null ? "OMP has taken this instruction into the active response. This does not confirm the provider has acted on it." : undefined} className="shrink-0 text-meta text-muted-foreground">
                    {queued.liveSteered === null ? "Queue state unavailable" : row.taken ? "Taken into response" : "Queue actions unavailable"}
                  </span>
                ) : null}
                {row.kind === "outbox" ? (
                  <span role="status" aria-description={hint} className="shrink-0 text-meta text-muted-foreground">
                    {outcome === "refused" ? "Refused"
                      : outcome === "errored" ? "Turn failed"
                      : outcome === "stopped" ? "Stopped"
                      : outcome === "interrupted" ? "Interrupted"
                      : row.entry.state === "uncertain" ? UNCERTAIN_LABEL
                      : row.entry.state === "failed" ? "Not sent"
                      : phase === "waiting" ? "Waiting for connection"
                      : phase === "retrying" ? "Trying again…"
                      : phase === "stalled" ? "Not sent"
                      : row.entry.state === "saved" ? "Saved on device" : "Sending…"}
                  </span>
                ) : null}
                {recovery ? (
                  <button type="button" onClick={recovery.onClick} className="pressable flex min-h-[48px] max-w-full items-center gap-2 whitespace-normal break-words rounded-lg px-2 py-2 text-left text-ui font-medium text-primary-text [overflow-wrap:anywhere]">
                    {RecoveryIcon ? <RecoveryIcon aria-hidden className="size-4 shrink-0" strokeWidth={1.5} /> : null}
                    {recovery.label}
                  </button>
                ) : null}
                {actions.edit ? <IconAction label="Edit" disabled={busy} onClick={actions.edit}><PencilIcon aria-hidden /></IconAction> : null}
                {actions.sendNow ? row.kind === "outbox" ? (
                  <Button variant="ghost" aria-label={row.entry.state === "uncertain" ? "Check" : "Try again"} disabled={busy} onClick={actions.sendNow} className="h-auto min-h-[48px] max-w-full whitespace-normal text-primary-text">
                    {row.entry.state === "uncertain" ? <SearchIcon aria-hidden /> : <RefreshCwIcon aria-hidden />}
                    {row.entry.state === "uncertain" ? "Check" : "Try again"}
                  </Button>
                ) : <IconAction label="Send now" disabled={busy} onClick={actions.sendNow}><ArrowUpIcon aria-hidden /></IconAction> : null}
                {actions.remove ? <IconAction label={actions.removeLabel} disabled={busy} onClick={actions.remove}><XIcon aria-hidden /></IconAction> : null}
                {row.kind === "outbox" && outcome && why ? (
                  <p className="basis-full break-words pb-2 pr-2 text-meta text-muted-foreground">{why}</p>
                ) : null}
                {hint ? <p className="basis-full pb-2 pr-2 text-meta text-muted-foreground">{hint}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <ConfirmSheet
        open={discard !== null}
        onOpenChange={(open) => { if (!open) setDiscard(null); }}
        title="Discard message?"
        description="Delivery is unconfirmed. Removing this device’s copy cannot recall a message already received."
        confirmLabel="Discard"
        testId="discard-queued-sheet"
        onConfirm={() => {
          const entry = discard;
          setDiscard(null);
          if (entry) void act(`outbox\u0000${entry.commandId}`, async () => { await pendingIntentActions(entry).cancel(); });
        }}
      />
    </>
  );
}

function RowGlyph({ row, phase }: { row: QueueRow; phase: SendPhase | null }) {
  if (row.kind !== "outbox") {
    const Icon = row.kind === "steering" ? CornerDownRightIcon : ClockIcon;
    return <Icon role="img" aria-label={KIND_LABEL[row.kind]} className="size-4 shrink-0 text-muted-foreground" />;
  }
  if (phase === "waiting") return <ClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
  if (phase === "stalled" || row.entry.state === "uncertain" || row.entry.state === "failed" || turnOutcome(row.entry) === "refused")
    return <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
  return <Spinner size={16} label={null} className="shrink-0 text-muted-foreground" />;
}

function IconAction({ label, disabled, onClick, children }: {
  label: string; disabled: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick} className="size-[48px] text-muted-foreground">
      {children}
    </Button>
  );
}
