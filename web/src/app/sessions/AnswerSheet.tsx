import { useState, useCallback, useEffect, useRef } from "react";
import { ArrowUpIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { OmpSessionSummary } from "../../domain/protocol";
import { answerPane } from "../../runtime/rpc-client";
import { readPairingToken } from "../../platform/browser-storage";
import { sessionTitle } from "../session-format";
import { BottomSheet } from "../ui/Sheet";
import { LinkedText } from "../ui/LinkedText";
import { Notice } from "../ui/Notice";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { answerQuestionKey } from "./answer-session";

export interface AnswerSheetProps {
  session: OmpSessionSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
  /** From the list, where tapping a row answered in place: the way into the conversation itself. */
  onOpenSession?: () => void;
}

type Attempt = { phase: "sending" | "handoff" | "held" | "rejected" | "uncertain" | "stale"; answer: string; reason?: string };
type RetainedQuestion = { ticket: symbol; path: string; askId: string; index: number };
type TerminalSubmission = { ticket: symbol; epoch: number; path: string; text: string; phase: "draft" | "sending" | "handoff" | "rejected" | "uncertain"; reason?: string };

function terminalResponseStatus(submission: TerminalSubmission): string {
  if (submission.phase === "sending") return "Sending terminal response…";
  if (submission.phase === "handoff") return "Sent to the terminal; the question may still be open.";
  if (submission.phase === "uncertain") return "Delivery unconfirmed. Another response may reach the same prompt.";
  if (submission.phase === "rejected") return submission.reason ?? "The terminal response was refused.";
  return "Terminal responses are typed into the current blocked prompt.";
}

export function AnswerSheet({ session, open, onOpenChange, onSent, onOpenSession }: AnswerSheetProps) {
  // Hiding is not abandoning an answer. Keep drafts and in-flight locks by the
  // session/question, independently of sheet visibility and catalogue churn.
  const credential = readPairingToken();
  const owner = useRef(credential);
  const ownerEpoch = useRef(0);
  if (owner.current !== credential) { owner.current = credential; ownerEpoch.current += 1; }
  const questionKey = JSON.stringify([ownerEpoch.current, answerQuestionKey(session)]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});
  const inFlight = useRef(new Set<string>());
  const retained = useRef(new Map<string, RetainedQuestion>());
  // These keys identify user-created submissions, NOT inferred terminal
  // questions. Only an explicit action creates another; visibility never does.
  const terminalRetained = useRef(new Map<string, TerminalSubmission>());
  const nextTerminalSubmission = useRef(0);
  const [terminalSubmissions, setTerminalSubmissions] = useState<Record<string, TerminalSubmission>>({});
  const [terminalCurrent, setTerminalCurrent] = useState<Record<string, string>>({});
  const terminalCurrentRef = useRef(terminalCurrent);
  terminalCurrentRef.current = terminalCurrent;
  const currentQuestion = useRef(questionKey);
  currentQuestion.current = questionKey;
  const text = drafts[questionKey] ?? "";
  const attempt = attempts[questionKey];
  const capacityBlocked = !retained.current.has(questionKey) && retained.current.size + terminalRetained.current.size >= 64;
  const busy = capacityBlocked || !session?.pendingAsk?.id || (attempt !== undefined && attempt.phase !== "rejected");
  const pending = session?.pendingAsk;
  const askId = typeof pending?.id === "string" ? pending.id : null;
  const index = typeof pending?.index === "number" ? pending.index : 0;
  const total = typeof pending?.total === "number" ? pending.total : 1;
  const previousQuestion = useRef<{ path?: string; identified: boolean } | null>(null);
  useEffect(() => {
    setDrafts({}); setAttempts({}); inFlight.current.clear(); retained.current.clear();
    previousQuestion.current = null;
    terminalRetained.current.clear(); setTerminalSubmissions({}); setTerminalCurrent({});
    terminalCurrentRef.current = {};
  }, [credential]);

  useEffect(() => {
    if (!session) return; // Closing or navigation is not settlement.
    const retired = new Set<string>();
    for (const [key, entry] of retained.current) {
      if (entry.path === session.path &&
          (!pending || entry.askId !== askId || entry.index < index)) retired.add(key);
    }
    if (!retired.size) return;
    for (const key of retired) { retained.current.delete(key); inFlight.current.delete(key); }
    const discard = <T,>(all: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(all).filter(([key]) => !retired.has(key)));
    setDrafts(discard); setAttempts(discard);
  }, [session, askId, index, pending, credential]);

  const retain = useCallback((): symbol | undefined => {
    const existing = retained.current.get(questionKey);
    if (existing) return existing.ticket;
    if (!session || !askId || retained.current.size + terminalRetained.current.size >= 64) return undefined;
    const ticket = Symbol();
    retained.current.set(questionKey, { ticket, path: session.path, askId, index });
    return ticket;
  }, [questionKey, session, askId, index]);
  useEffect(() => {
    const previous = previousQuestion.current;
    previousQuestion.current = { path: session?.path, identified: Boolean(askId) };
    if (open && previous && previous.path === session?.path && previous.identified && !pending) onOpenChange(false);
  }, [open, session?.path, askId, pending, onOpenChange]);

  const handleSend = useCallback(async (answerText: string, optionIndex?: number) => {
    if (!open || !session || !askId || busy || inFlight.current.has(questionKey)) return;
    const trimmed = answerText.trim();
    if (!trimmed) return;
    if (readPairingToken() !== credential) return;
    const ticket = retain();
    if (!ticket) return;
    inFlight.current.add(questionKey);
    // Preserve an option answer too: refusal must not strand a tap-only value.
    setDrafts((all) => ({ ...all, [questionKey]: answerText }));
    setAttempts((all) => ({ ...all, [questionKey]: { phase: "sending", answer: trimmed } }));
    try {
      const result = await answerPane(session.path, trimmed, { id: askId, index, optionIndex });
      if (readPairingToken() !== credential || retained.current.get(questionKey)?.ticket !== ticket) return;
      setAttempts((all) => ({ ...all, [questionKey]: { phase: result?.delivery === "held" ? "held" : "handoff", answer: trimmed } }));
      if (currentQuestion.current === questionKey) onSent?.();
    } catch (error: unknown) {
      if (readPairingToken() !== credential || retained.current.get(questionKey)?.ticket !== ticket) return;
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      // A missing HTTP reply cannot prove the answer was not sent. Do not
      // turn an uncertain handoff into a second submission on reopening.
      const refused = typeof status === "number" && status < 500 && code !== "answer_delivery_uncertain";
      setAttempts((all) => ({ ...all, [questionKey]: { phase: status === 409 ? "stale" : refused ? "rejected" : "uncertain", answer: trimmed, reason: humanizeDaemonError(error) } }));
    } finally {
      if (retained.current.get(questionKey)?.ticket === ticket) inFlight.current.delete(questionKey);
    }
  }, [open, session, busy, questionKey, askId, index, onSent, credential, retain]);

  const rememberTerminal = useCallback((key: string, submission: TerminalSubmission) => {
    terminalRetained.current.set(key, submission);
    setTerminalSubmissions(all => ({ ...all, [key]: submission }));
  }, []);
  const startTerminalResponse = useCallback(() => {
    if (!session || askId || readPairingToken() !== credential) return;
    const previous = terminalRetained.current.get(terminalCurrentRef.current[session.path] ?? "");
    if (previous?.epoch === ownerEpoch.current && (previous.phase === "draft" || previous.phase === "rejected" || previous.phase === "sending")) return;
    if (retained.current.size + terminalRetained.current.size >= 64) return;
    const key = JSON.stringify([ownerEpoch.current, session.path, ++nextTerminalSubmission.current]);
    rememberTerminal(key, { ticket: Symbol(), epoch: ownerEpoch.current, path: session.path, text: "", phase: "draft" });
    terminalCurrentRef.current = { ...terminalCurrentRef.current, [session.path]: key };
    setTerminalCurrent(terminalCurrentRef.current);
  }, [session, askId, credential, rememberTerminal]);
  const sendTerminalResponse = useCallback(async (key: string) => {
    const entry = terminalRetained.current.get(key);
    if (!open || !session || askId || !entry || entry.epoch !== ownerEpoch.current || entry.path !== session.path ||
        (entry.phase !== "draft" && entry.phase !== "rejected") ||
        !entry.text.trim() || readPairingToken() !== credential) return;
    rememberTerminal(key, { ...entry, phase: "sending", reason: undefined });
    try {
      await answerPane(entry.path, entry.text.trim(), { terminalOnly: true });
      if (readPairingToken() !== credential || terminalRetained.current.get(key)?.ticket !== entry.ticket) return;
      rememberTerminal(key, { ...entry, phase: "handoff" });
      if (terminalCurrentRef.current[entry.path] === key) onSent?.();
    } catch (error: unknown) {
      if (readPairingToken() !== credential || terminalRetained.current.get(key)?.ticket !== entry.ticket) return;
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      const refused = typeof status === "number" && status < 500 && code !== "answer_delivery_uncertain";
      rememberTerminal(key, { ...entry, phase: refused ? "rejected" : "uncertain", reason: humanizeDaemonError(error) });
    }
  }, [open, session, askId, credential, rememberTerminal, onSent]);
  const discardTerminalResponse = useCallback((key: string) => {
    const entry = terminalRetained.current.get(key);
    if (!entry || entry.phase === "sending") return;
    terminalRetained.current.delete(key);
    setTerminalSubmissions(all => Object.fromEntries(Object.entries(all).filter(([id]) => id !== key)));
    if (terminalCurrentRef.current[entry.path] === key) {
      terminalCurrentRef.current = Object.fromEntries(Object.entries(terminalCurrentRef.current).filter(([, id]) => id !== key));
      setTerminalCurrent(terminalCurrentRef.current);
    }
  }, []);
  const terminalKey = session ? terminalCurrent[session.path] : undefined;
  const terminal = terminalKey && terminalSubmissions[terminalKey]?.epoch === ownerEpoch.current ? terminalSubmissions[terminalKey] : undefined;
  const terminalBusy = terminal?.phase !== "draft" && terminal?.phase !== "rejected";
  const terminalHistory = Object.entries(terminalSubmissions).filter(([key, entry]) => key !== terminalKey && entry.path === session?.path && entry.epoch === ownerEpoch.current);

  const options = Array.isArray(pending?.options) ? pending.options : [];
  const recommended = typeof pending?.recommended === "number" ? pending.recommended : null;
  const status = capacityBlocked ? "64 answers are already saved. Finish a question or remove a saved terminal response before adding another; no drafts were removed."
    : attempt?.phase === "sending" ? "Sending answer…"
    : attempt?.phase === "held" ? "Answer kept. Waiting for the remaining questions."
    : attempt?.phase === "handoff" ? "Handed to the session. Waiting for the question to close."
    : attempt?.phase === "uncertain" ? "Delivery is unknown. Your answer is kept; check the session before sending again."
    : attempt?.reason;

  return (
    <BottomSheet open={open && !!session} onOpenChange={onOpenChange} title="Answer question" description={session ? sessionTitle(session) : undefined} testId="answer-sheet">
      <div className="space-y-4 pb-2">
        {status ? <Notice tone={attempt?.phase === "rejected" ? "danger" : "warning"} testId="answer-error"><span role="status">{status}</span>{attempt?.phase === "uncertain" && attempt.reason ? <p className="mt-1">{attempt.reason}</p> : null}</Notice> : null}
        {!askId ? <Notice tone="warning" testId="answer-unidentified">Open the session for its question, or answer a terminal prompt below.</Notice> : null}
        {total > 1 ? <p className="text-meta text-muted-foreground" data-testid="answer-progress">{busy && index + 1 < total ? `Waiting for question ${index + 2} of ${total}…` : `Question ${index + 1} of ${total}`}</p> : null}
        <p className="whitespace-pre-wrap text-title font-medium text-foreground break-words [overflow-wrap:anywhere]">{pending?.question?.trim() ? <LinkedText text={pending.question.trim()} /> : "Waiting for input"}</p>
        {askId && options.length > 0 ? (
          <div className="flex flex-col gap-2" role="group" aria-label="Answer options" data-testid="answer-options">
            {options.map((option, idx) => (
              <button
                key={idx}
                type="button"
                data-testid={`answer-option-${idx + 1}`}
                disabled={busy}
                onClick={() => void handleSend(option, idx)}
                className={`pressable flex min-h-14 w-full items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 text-left text-body text-foreground outline-none transition-colors active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none ${idx === recommended ? "ring-1 ring-primary/60" : ""}`}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-meta tabular-nums text-muted-foreground">{idx + 1}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span data-testid="answer-option-label" className="break-words [overflow-wrap:anywhere]">{option}</span>
                  {idx === recommended ? <span className="text-meta font-medium text-primary-text">Recommended</span> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {askId ? <form className="pt-1" onSubmit={(e) => { e.preventDefault(); void handleSend(text); }}>
          <div className="flex items-center gap-2">
            <Input className="h-12 flex-1 rounded-lg border border-transparent bg-surface-2 px-4 text-body focus-visible:border-control focus-visible:ring-0 md:text-body dark:bg-surface-2" data-testid="answer-text-input" aria-label="Your answer" value={text} disabled={busy} onChange={(e) => { const value = e.currentTarget.value; if (retain()) setDrafts((all) => ({ ...all, [questionKey]: value })); }} placeholder={options.length > 0 ? "Or type an answer…" : "Type your answer…"} />
            <Button aria-label={attempt?.phase === "sending" ? "Sending answer" : attempt?.phase === "rejected" ? "Retry answer" : "Send answer"} data-testid="answer-send-button" variant="primary" size="icon" type="submit" disabled={busy || !text.trim()}><ArrowUpIcon className="size-5" /></Button>
          </div>
        </form> : null}
        {!askId ? <div className="space-y-3">
          {terminal && terminalKey ? <>
            <p role="status" className="text-meta text-muted-foreground" data-testid="terminal-response-status">{terminalResponseStatus(terminal)}</p>
            <form onSubmit={event => { event.preventDefault(); void sendTerminalResponse(terminalKey); }} className="flex items-center gap-2">
              <Input data-testid="terminal-response-input" aria-label="Terminal response" value={terminal.text} disabled={terminalBusy} onChange={event => {
                const entry = terminalRetained.current.get(terminalKey);
                if (entry && (entry.phase === "draft" || entry.phase === "rejected")) rememberTerminal(terminalKey, { ...entry, text: event.currentTarget.value });
              }} />
              <Button data-testid="terminal-response-send" aria-label="Send terminal response" variant="primary" size="icon" type="submit" disabled={terminalBusy || !terminal.text.trim()}><ArrowUpIcon className="size-5" /></Button>
            </form>
            {terminal.phase === "handoff" || terminal.phase === "uncertain" ? <Button type="button" variant="ghost" data-testid="terminal-response-new" disabled={capacityBlocked} onClick={startTerminalResponse}>Write another response</Button> : null}
            <Button type="button" variant="ghost" data-testid="terminal-response-discard" disabled={terminal.phase === "sending"} onClick={() => discardTerminalResponse(terminalKey)}>Remove saved response</Button>
          </> : <Button type="button" variant="ghost" data-testid="terminal-response-start" disabled={capacityBlocked} onClick={startTerminalResponse}>Answer terminal prompt</Button>}
          {terminalHistory.map(([key, entry]) => <div key={key} data-testid="terminal-response-saved" className="space-y-1 text-meta">
            <p className="whitespace-pre-wrap break-words">{entry.text}</p>
            <p className="text-muted-foreground">{terminalResponseStatus(entry)}</p>
            <Button type="button" variant="ghost" disabled={entry.phase === "sending"} onClick={() => discardTerminalResponse(key)}>Remove saved response</Button>
          </div>)}
        </div> : null}
        {onOpenSession ? <Button type="button" variant="ghost" className="w-full" data-testid="answer-open-session" onClick={onOpenSession}>Open session</Button> : null}
      </div>
    </BottomSheet>
  );
}
