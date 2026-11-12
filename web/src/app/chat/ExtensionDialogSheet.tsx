"use client";

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { CheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { haptic } from "@/platform/haptic";

import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { startVisibleInterval } from "../../runtime/visible-interval";
import {
  askDraftComplete,
  askResponse,
  expireExtensionDialogs,
  setAskCustom,
  toggleAskOption,
  type AskDraft,
  type ExtensionDialog,
  type ExtensionDialogResponse,
} from "../../runtime/extension-dialogs";
import { useStoreValue } from "../store-hooks";
import { BottomSheet } from "../ui/Sheet";
import { ErrorNotice } from "../ui/ErrorNotice";
import { LinkedText } from "../ui/LinkedText";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { ALERT_CANCEL, ALERT_DESTRUCTIVE, ConfirmDialog } from "../ui/GroupedList";

// Closing hides a question without answering it. Only an OMP ask cancellation
// stops the turn (so it says "Stop turn" and asks twice); other extension
// callbacks define their own cancellation, which only declines the question
// ("Skip question"). Collab's dialog uses the same two words.

const EMPTY_ASK: AskDraft = { selected: {}, custom: {} };

const SHEET_TITLE: Record<ExtensionDialog["method"], string> = {
  select: "Choose an option",
  confirm: "Confirm",
  input: "Answer needed",
  editor: "Edit text",
  ask: "Question",
};

const fieldClass =
  "rounded-lg border-0 bg-surface-2 px-4 text-body shadow-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40";

// Option cards: a separate decision, so a tinted 56dp card per choice with a
// 24px indicator; the chosen one gains a primary ring.
const rowClass =
  "pressable flex min-h-14 w-full items-center gap-4 rounded-xl bg-surface-2 px-4 py-3 text-left text-body text-foreground transition-colors active:bg-surface-3 aria-checked:bg-surface-3 aria-checked:ring-1 aria-checked:ring-primary/60 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none";

/** Radio (one) or checkbox (many) indicator; filled when chosen. */
function ChoiceMark({ multi, checked }: { multi: boolean; checked: boolean }): JSX.Element {
  return (
    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
      <span
        className={cn(
          "flex size-5 items-center justify-center border-2 transition-colors",
          multi ? "rounded-[0.25rem]" : "rounded-full",
          checked ? "border-primary" : "border-muted-foreground/60",
          checked && multi && "bg-primary text-primary-foreground",
        )}
      >
        {checked ? (multi ? <CheckIcon className="size-3.5" strokeWidth={3} /> : <span className="size-2.5 rounded-full bg-primary" />) : null}
      </span>
    </span>
  );
}

/** A separate disclosure, never nested in a choice or submission control. */
function OptionPreview({ preview }: { preview?: string }): JSX.Element | null {
  return preview ? (
    <details className="pb-2 pl-10" data-testid="extension-option-preview">
      <summary className="min-h-12 cursor-pointer py-3 text-meta font-medium text-primary-text">Inspect preview</summary>
      <pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-meta break-words [overflow-wrap:anywhere]">{preview}</pre>
    </details>
  ) : null;
}

export interface ExtensionDialogSheetProps {
  controller: OmpSessionController;
  onPendingChange?: (hasPending: boolean) => void;
}

export function ExtensionDialogSheet({ controller, onPendingChange }: ExtensionDialogSheetProps): JSX.Element | null {
  const store = controller.getStore();
  const pending = useStoreValue(store, (s) => s.extensionDialogs.pending);
  const closed = useStoreValue(store, (s) => s.extensionDialogs.closed);
  const sessionPath = useStoreValue(store, (s) => s.sessionPath);
  const owner = useRef(controller);
  const ownerEpoch = useRef(0);
  if (owner.current !== controller) { owner.current = controller; ownerEpoch.current += 1; }
  const questionKey = (requestId: string): string => JSON.stringify([ownerEpoch.current, sessionPath, requestId]);
  const [handoffs, setHandoffs] = useState<Record<string, "handoff" | "uncertain" | "stale">>({});
  const dialog = pending.find((entry) => !entry.delivery && !handoffs[questionKey(entry.id)]) ?? pending[0] ?? null;
  const hasPending = dialog !== null;

  // Include the owner in every draft/attempt key: request ids may be reused by
  // another session, and a late completion must never clear its draft or lock.
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [asks, setAsks] = useState<Record<string, AskDraft>>({});
  const [hiddenId, setHiddenId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const retained = useRef(new Map<string, symbol>());
  const [chosen, setChosen] = useState<{ id: string; index: number } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Which question's Stop turn confirmation is open; one tap ended the whole turn.
  const [confirmStopId, setConfirmStopId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setTexts({}); setAsks({}); setHandoffs({}); setErrors({});
    setHiddenId(null); setSendingId(null); setChosen(null);
    inFlight.current.clear();
    retained.current.clear();
  }, [controller]);

  useEffect(() => {
    // Absence during reconnect/navigation is not settlement. Only explicit
    // closed IDs for this session release retained values and attempt locks.
    const retired = new Set(closed.map((requestId) => JSON.stringify([ownerEpoch.current, sessionPath, requestId])).filter((key) => retained.current.has(key)));
    if (!retired.size) return;
    for (const key of retired) { retained.current.delete(key); inFlight.current.delete(key); }
    const discard = <T,>(all: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(all).filter(([key]) => !retired.has(key)));
    setTexts(discard); setAsks(discard); setHandoffs(discard); setErrors(discard);
    setSendingId((key) => key && retired.has(key) ? null : key);
    setChosen((value) => value && retired.has(value.id) ? null : value);
    setHiddenId((key) => key && retired.has(key) ? null : key);
  }, [closed, sessionPath, controller]);

  useEffect(() => {
    onPendingChange?.(hasPending);
  }, [hasPending, onPendingChange]);

  // omp answers a timed dialog itself when time runs out (and says so with a
  // cancel); drop it locally too, and tick the countdown once a second.
  const expiresAt = dialog?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return;
    // Visible-only; showing the page ticks (and expires) at once.
    return startVisibleInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= expiresAt) store.getState().setExtensionDialogs((state) => expireExtensionDialogs(state, at));
    }, 1000, { tickOnShow: true });
  }, [expiresAt, store]);

  // Header banner and notification taps reopen a hidden question.
  useEffect(() => {
    const show = (): void => setHiddenId(null);
    window.addEventListener("collab:show", show);
    window.addEventListener("extension-dialog:show", show);
    return () => {
      window.removeEventListener("collab:show", show);
      window.removeEventListener("extension-dialog:show", show);
    };
  }, []);

  if (!dialog) return null;
  const id = questionKey(dialog.id);
  const capacityBlocked = !retained.current.has(id) && retained.current.size >= 64;
  const busy = capacityBlocked || sendingId === id || inFlight.current.has(id) || handoffs[id] !== undefined || dialog.delivery !== undefined;
  const open = hiddenId !== id;
  const text = texts[id] ?? (dialog.method === "editor" ? dialog.prefill ?? "" : "");
  const ask = asks[id] ?? EMPTY_ASK;
  const secondsLeft = expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const questions = dialog.questions ?? [];

  const retain = (): symbol | undefined => {
    const existing = retained.current.get(id);
    if (existing) return existing;
    if (retained.current.size >= 64) return undefined;
    const ticket = Symbol();
    retained.current.set(id, ticket);
    return ticket;
  };

  const send = async (response: ExtensionDialogResponse): Promise<void> => {
    if (busy || inFlight.current.has(id)) return;
    const ticket = retain();
    if (!ticket) return;
    inFlight.current.add(id);
    setSendingId(id);
    setErrors((all) => ({ ...all, [id]: "" }));
    try {
      await controller.answerExtensionDialog(dialog.id, response, sessionPath);
      if (owner.current !== controller || retained.current.get(id) !== ticket) return;
      setHandoffs((all) => ({ ...all, [id]: "handoff" }));
    } catch (e: unknown) {
      if (owner.current !== controller || retained.current.get(id) !== ticket) return;
      const status = typeof e === "object" && e !== null && "status" in e ? e.status : undefined;
      const uncertain = typeof status !== "number" || status >= 500;
      if (uncertain || status === 409) setHandoffs((all) => ({ ...all, [id]: status === 409 ? "stale" : "uncertain" }));
      setErrors((all) => ({ ...all, [id]: `${uncertain ? "Delivery is unknown. Your answer is kept. " : ""}${humanizeDaemonError(e)}` }));
    } finally {
      if (owner.current === controller && retained.current.get(id) === ticket) {
        inFlight.current.delete(id);
        setSendingId((current) => (current === id ? null : current));
      }
    }
  };

  // Footers: tonal secondary sized to its label + one filled CTA taking the
  // rest, so the pair never overflows the edge at 150% text.
  const footer = (() => {
    const skip = dialog.method === "ask" ? (
      // Quiet on purpose: it ends the agent's turn, so it must never sit beside
      // Submit at the same weight. A second, confirming tap follows.
      <button
        type="button"
        disabled={busy}
        data-testid="extension-dialog-stop"
        onClick={() => setConfirmStopId(id)}
        className="pressable h-11 shrink-0 rounded-lg px-3 text-ui font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
      >
        Stop turn
      </button>
    ) : (
      <button
        type="button"
        disabled={busy}
        data-testid="extension-dialog-skip"
        onClick={() => void send({ cancelled: true })}
        className="pressable h-11 shrink-0 rounded-lg bg-surface-3 px-5 text-ui font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
      >
        Skip question
      </button>
    );
    // `shrink` undoes Button's base shrink-0 so the CTA yields width (and
    // wraps) instead of pushing past the edge.
    const cta = "pressable h-auto min-h-11 min-w-0 flex-1 shrink whitespace-normal rounded-lg px-4 py-2 text-ui font-semibold leading-tight";
    switch (dialog.method) {
      case "confirm":
        return (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="pressable h-11 shrink-0 rounded-lg bg-surface-3 px-5 text-ui font-medium"
              disabled={busy}
              data-testid="extension-dialog-no"
              onClick={() => void send({ confirmed: false })}
            >
              No
            </Button>
            <Button
              className={cta}
              disabled={busy}
              data-testid="extension-dialog-yes"
              onClick={() => void send({ confirmed: true })}
            >
              Yes
            </Button>
          </div>
        );
      case "select":
        return <div className="flex justify-end">{skip}</div>;
      case "input":
      case "editor":
        return (
          <div className="flex gap-2">
            {skip}
            <Button
              className={cta}
              disabled={busy || (dialog.method === "input" && !text.trim())}
              data-testid="extension-dialog-send"
              onClick={() => void send({ value: text })}
            >
              Send
            </Button>
          </div>
        );
      case "ask":
        return (
          <div className="flex gap-2">
            {skip}
            <Button
              className={cta}
              disabled={busy || !askDraftComplete(dialog, ask)}
              data-testid="extension-dialog-submit"
              onClick={() => void send(askResponse(dialog, ask))}
            >
              Submit
            </Button>
          </div>
        );
    }
  })();

  return (
    <>
      <BottomSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) setHiddenId(id);
        }}
        title={dialog.method === "ask" && questions.length > 1 ? `${questions.length} questions` : SHEET_TITLE[dialog.method]}
        testId="extension-dialog"
        footer={footer}
      >
        <div className="space-y-4 pb-2" data-method={dialog.method}>
          {errors[id] ? <ErrorNotice message={errors[id]} testId="extension-dialog-error" /> : null}
          {capacityBlocked ? <ErrorNotice message="64 questions already have retained answers. Finish one before answering another; none of your drafts were removed." testId="extension-dialog-capacity" /> : null}
          {!errors[id] && (sendingId === id || handoffs[id] || dialog.delivery) ? <p role="status" className="text-meta text-muted-foreground">{handoffs[id] === "uncertain" || dialog.delivery === "uncertain" ? "Delivery is unknown. Your answer is kept." : sendingId === id || dialog.delivery === "sending" ? "Sending answer…" : "Handed to the session. Awaiting a session update."}</p> : null}
          {dialog.method === "ask" ? <p className="text-meta text-muted-foreground">Stop turn ends this turn. Close to answer later.</p> : null}
          {pending.length > 1 || secondsLeft !== null ? (
            <p className="text-caption font-medium tabular-nums text-muted-foreground">
              {[
                pending.length > 1 ? `1 of ${pending.length} waiting` : null,
                secondsLeft !== null ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")} left to answer` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}

          {/* The question is the content, not a heading: text-body medium.
              text-title (22) shouted a sentence that is often two lines. */}
          {dialog.method !== "ask" && dialog.title ? (
            <p className="whitespace-pre-wrap text-body font-medium text-foreground break-words [overflow-wrap:anywhere]">
              <LinkedText text={dialog.title} />
            </p>
          ) : null}
          {dialog.method === "confirm" && dialog.message ? (
            <p className="whitespace-pre-wrap text-meta text-muted-foreground break-words [overflow-wrap:anywhere]">
              <LinkedText text={dialog.message} />
            </p>
          ) : null}

          {dialog.method === "select" ? (
            <div className="flex flex-col gap-2" role="group" aria-label={dialog.title || SHEET_TITLE.select}>
              {(dialog.options ?? []).map((option, index) => (
                <div key={`${id}-${index}`}>
                <button
                  type="button"
                  disabled={busy}
                  className={rowClass}
                  data-testid="extension-dialog-option"
                  onClick={() => {
                    if (busy) return;
                    setChosen({ id, index });
                    void send({ value: option.label });
                  }}
                >
                  <ChoiceMark multi={false} checked={chosen?.id === id && chosen.index === index} />
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                    <span className="break-words [overflow-wrap:anywhere]">{option.label}</span>
                    {option.description ? (
                      <span className="text-meta text-muted-foreground break-words [overflow-wrap:anywhere]">{option.description}</span>
                    ) : null}
                  </span>
                </button>
                <OptionPreview preview={option.preview} />
                </div>
              ))}
            </div>
          ) : null}

          {dialog.method === "input" ? (
            <Input
              value={text}
              disabled={busy}
              onChange={(e) => { const value = e.currentTarget.value; if (retain()) setTexts((all) => ({ ...all, [id]: value })); }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.repeat || e.nativeEvent.isComposing || !text.trim()) return;
                e.preventDefault();
                void send({ value: text });
              }}
              placeholder={dialog.placeholder ?? "Type your answer"}
              aria-label={dialog.title || "Your answer"}
              className={`h-12 ${fieldClass}`}
              enterKeyHint="send"
              data-testid="extension-dialog-input"
            />
          ) : null}

          {dialog.method === "editor" ? (
            <Textarea
              value={text}
              disabled={busy}
              onChange={(e) => { const value = e.currentTarget.value; if (retain()) setTexts((all) => ({ ...all, [id]: value })); }}
              aria-label={dialog.title || "Text"}
              rows={6}
              className={`min-h-40 resize-none py-3 ${fieldClass}`}
              data-testid="extension-dialog-editor"
            />
          ) : null}

          {dialog.method === "ask"
            ? questions.map((question) => {
                const picked = ask.selected[question.id] ?? [];
                return (
                  <section key={question.id} className="space-y-2" data-testid="extension-dialog-question">
                    {question.header ? (
                      <p className="text-caption font-medium text-muted-foreground">{question.header}</p>
                    ) : null}
                    <p className="whitespace-pre-wrap text-body font-medium text-foreground break-words [overflow-wrap:anywhere]">
                      <LinkedText text={question.question} />
                    </p>
                    {question.multi ? (
                      <p className="text-meta text-muted-foreground">Pick any, or submit none</p>
                    ) : null}
                    <div
                      className="flex flex-col gap-2"
                      role={question.multi ? "group" : "radiogroup"}
                      aria-label={question.question}
                    >
                      {question.options.map((option, index) => {
                        const checked = picked.includes(option.label);
                        return (
                          <div key={`${question.id}-${index}`}>
                          <button
                            type="button"
                            role={question.multi ? "checkbox" : "radio"}
                            aria-checked={checked}
                            disabled={busy}
                            className={rowClass}
                            data-testid="extension-dialog-ask-option"
                            onClick={() => { if (retain()) setAsks((all) => ({ ...all, [id]: toggleAskOption(all[id] ?? EMPTY_ASK, question, option.label) })); }}
                          >
                            <ChoiceMark multi={Boolean(question.multi)} checked={checked} />
                            <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                              <span className="break-words [overflow-wrap:anywhere]">{option.label}</span>
                              {index === question.recommended ? (
                                <span className="text-caption font-medium text-primary-text">Recommended</span>
                              ) : null}
                              {option.description ? (
                                <span className="text-meta text-muted-foreground break-words [overflow-wrap:anywhere]">{option.description}</span>
                              ) : null}
                            </span>
                          </button>
                          <OptionPreview preview={option.preview} />
                          </div>
                        );
                      })}
                    </div>
                    <Input
                      value={ask.custom[question.id] ?? ""}
                      disabled={busy}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        if (retain()) setAsks((all) => ({ ...all, [id]: setAskCustom(all[id] ?? EMPTY_ASK, question, value) }));
                      }}
                      placeholder={question.options.length ? "Or write your own answer" : "Your answer"}
                      aria-label={`Your own answer: ${question.question}`}
                      className={`h-12 ${fieldClass}`}
                      data-testid="extension-dialog-ask-custom"
                    />
                  </section>
                );
              })
            : null}
        </div>
      </BottomSheet>
      <ConfirmDialog
        open={confirmStopId === id}
        onOpenChange={(next) => { if (!next) setConfirmStopId(null); }}
        title="Stop the agent's turn?"
        description="Declining this question ends the turn the agent is working on. To answer later, close this sheet instead."
        actions={
          <>
            <button
              type="button"
              className={ALERT_DESTRUCTIVE}
              disabled={busy}
              data-testid="extension-dialog-stop-confirm"
              onClick={() => {
                setConfirmStopId(null);
                haptic("medium");
                void send({ cancelled: true });
              }}
            >
              Stop turn
            </button>
            <button type="button" className={ALERT_CANCEL} onClick={() => setConfirmStopId(null)}>
              Keep question
            </button>
          </>
        }
      />
      {!open ? (
        <button
          type="button"
          data-testid="extension-dialog-reopen"
          onClick={() => setHiddenId(null)}
          className="fixed bottom-20 left-1/2 z-40 min-h-12 -translate-x-1/2 rounded-full bg-surface-3 px-5 text-ui font-medium tabular-nums text-foreground shadow-[var(--shadow-float)] press-bounce"
        >
          Question waiting, tap to answer
        </button>
      ) : null}
    </>
  );
}
