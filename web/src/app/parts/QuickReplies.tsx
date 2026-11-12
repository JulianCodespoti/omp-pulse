"use client";

import { CircleIcon, PencilLineIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import { Row } from "@/app/ui/Row";
import { Notice } from "@/app/ui/Notice";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { answerPane } from "@/runtime/rpc-client";

import type { QuickQuestion } from "./run-summary";

/**
 * The agent's single-choice question, answered in place: the question in
 * plain foreground text, the options as a radio list in one quiet card, and
 * "Other…" for a free answer. A tap sends; the chosen row shows the send.
 */
export function QuickReplies({ question, sessionPath, onOther, onSent }: {
  question: QuickQuestion;
  sessionPath: string;
  onOther: () => void;
  onSent: () => void;
}) {
  const [sending, setSending] = useState<number | null>(null);
  const [phase, setPhase] = useState<"sending" | "handoff" | "uncertain" | "stale" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifetimeRef = useRef<{ sending: boolean } | null>(null);
  useLayoutEffect(() => {
    lifetimeRef.current = { sending: false };
    setSending(null);
    setPhase(null);
    setError(null);
    // A completion from another question/session must not change this one's
    // status or invoke its catalogue refresh callback.
    return () => { lifetimeRef.current = null; };
  }, [sessionPath, question.callId]);

  async function send(index: number): Promise<void> {
    const lifetime = lifetimeRef.current;
    if (!lifetime || lifetime.sending) return;
    lifetime.sending = true;
    setSending(index);
    setPhase("sending");
    setError(null);
    try {
      await answerPane(sessionPath, question.options[index]!, { id: question.callId, index: 0, optionIndex: index });
      if (lifetimeRef.current !== lifetime) return;
      setPhase("handoff");
      onSent();
    } catch (err: unknown) {
      if (lifetimeRef.current !== lifetime) return;
      const status = typeof err === "object" && err !== null && "status" in err ? err.status : undefined;
      const uncertain = typeof status !== "number" || status >= 500;
      setError(`${uncertain ? "Delivery is unknown. Your answer is kept. " : ""}${humanizeDaemonError(err)}`);
      if (uncertain || status === 409) {
        setPhase(status === 409 ? "stale" : "uncertain");
      } else {
        lifetime.sending = false;
        setSending(null);
        setPhase(null);
      }
    }
  }
  const busy = sending !== null;
  return (
    <div className="overflow-hidden rounded-lg bg-surface-1" data-testid="quick-replies" aria-busy={busy}>
      <p className="px-4 pb-1 pt-3 text-body text-foreground [overflow-wrap:anywhere]" id={`question-${question.callId}`}>{question.question}</p>
      <div role="radiogroup" aria-labelledby={`question-${question.callId}`}>
        {question.options.map((option, index) => (
          <Row
            key={index}
            role="radio"
            aria-checked={sending === index}
            leading={sending === index && phase === "sending" ? <Spinner size={16} label={null} /> : <CircleIcon aria-hidden className="size-4" />}
            title={option}
            disabled={busy}
            onClick={() => void send(index)}
            testId="quick-reply-option"
          />
        ))}
        <Row
          leading={<PencilLineIcon aria-hidden className="size-4" />}
          title={<span className="text-muted-foreground">Other…</span>}
          disabled={busy}
          onClick={onOther}
          testId="quick-reply-other"
        />
      </div>
      {error ? <Notice tone="danger" className="mx-3 mb-3">{error}</Notice> : null}
      {phase === "handoff" ? <p role="status" className="px-4 pb-3 text-meta text-muted-foreground">Handed to the session. Waiting for the question to close.</p> : null}
    </div>
  );
}
