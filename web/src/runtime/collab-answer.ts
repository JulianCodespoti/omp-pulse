import type { CollabQuestionIdentity } from "./collab-question-lifecycle";

// A transport acknowledgement is not a receipt from OMP's question callback.
// Keep typed and submitted values until the host ends this particular request.
export type CollabAnswerPhase = "draft" | "sending" | "held" | "queued" | "handoff" | "uncertain" | "rejected" | "unavailable";

export interface CollabAnswerState {
  sessionPath: string;
  reqId: number;
  value: string | null;
  phase: CollabAnswerPhase;
  reason?: string;
  /** Only exact generation/token identity permits snapshot settlement. */
  question: CollabQuestionIdentity;
}

export function collabAnswerMatches(answer: CollabAnswerState | null, sessionPath: string | null, reqId: number | undefined): boolean {
  return answer !== null && answer.sessionPath === sessionPath && answer.reqId === reqId;
}

export function collabAnswerCanRetry(answer: CollabAnswerState | null, sessionPath: string | null, reqId: number | undefined): boolean {
  return collabAnswerMatches(answer, sessionPath, reqId) && answer?.phase === "rejected";
}

export function acknowledgeCollabAnswer(answer: CollabAnswerState | null, sessionPath: string, event: { reqId?: unknown; pulseQuestionToken?: unknown; ok?: unknown; queued?: unknown; error?: unknown; actionable?: unknown }): CollabAnswerState | null {
  if (!answer || answer.phase === "draft" || !collabAnswerMatches(answer, sessionPath, event.reqId as number) || event.pulseQuestionToken !== answer.question.token) return answer;
  if (event.ok === true) return { ...answer, phase: event.queued === true ? "queued" : "handoff", reason: undefined };
  if (event.ok === false) return { ...answer, phase: event.actionable === false ? "unavailable" : "rejected", reason: typeof event.error === "string" ? event.error : "The answer was not handed to the desktop." };
  return answer;
}

export function interruptCollabAnswer(answer: CollabAnswerState | null): CollabAnswerState | null {
  // Held answers have never left this client. Sending ones may have: never
  // automatically replay them after reconnect and accidentally answer twice.
  return answer?.phase === "sending" ? { ...answer, phase: "uncertain" } : answer;
}

export function collabAnswerStatus(answer: CollabAnswerState): string {
  switch (answer.phase) {
    case "draft": return "Answer not sent.";
    case "sending": return "Sending answer…";
    case "held": return "Waiting for your connection. Your answer is kept.";
    case "queued": return "Waiting for the desktop. Your answer is kept.";
    case "handoff": return "Handed to the desktop connection. Waiting for the question to close.";
    case "uncertain": return "Delivery is unknown. Your answer is kept; check the desktop before sending again.";
    case "rejected": return answer.reason ?? "The answer was refused.";
    case "unavailable": return answer.reason ?? "This question is no longer waiting.";
  }
}
