import { sessionTurn, type OmpSessionSummary } from "../domain/protocol";
import { hasUnread, inboxState } from "./session-format";

/**
 * The one session status vocabulary. Rows, headers, counts and aria labels
 * all say the same five things; a session never reads "Running" in one place
 * and "Live" in another.
 *
 * Precedence is the order a person acts on: a question waiting on them beats
 * a turn in progress, which beats unread output, which beats "your computer
 * has it open". Idle shows nothing.
 */
export type SessionState = "needs-you" | "working" | "unread" | "on-computer" | "idle";

export const STATUS_LABEL: Record<SessionState, string> = {
  "needs-you": "Needs you",
  working: "Working",
  unread: "Unread",
  "on-computer": "On computer",
  idle: "Idle",
};

const NO_AWAITING: ReadonlySet<string> = new Set();

/**
 * `awaiting` is the set of session paths with an open ask_user question
 * (SessionSwitcher's live set); without it a pending question is still caught
 * by the daemon's `status === "waiting"`.
 *
 * INVARIANT: running and on-computer are orthogonal (see session-format.ts
 * `sessionStatus`). Working comes from turn evidence only, never from the
 * `live` ownership flag, which once marked every open session busy. A session
 * whose authority is reconnecting ("unknown") and not open on the computer is
 * Idle: a sixth "Reconnecting" label is exactly the vocabulary drift this
 * module exists to stop.
 */
export function sessionStatus(
  summary: OmpSessionSummary,
  awaiting: ReadonlySet<string> = NO_AWAITING,
): SessionState {
  const inbox = inboxState(summary, awaiting);
  if (inbox === "asking" || inbox === "needs") return "needs-you";
  if (sessionTurn(summary) === "running") return "working";
  if (hasUnread(summary)) return "unread";
  if (summary.live === true || inbox === "live") return "on-computer";
  return "idle";
}
