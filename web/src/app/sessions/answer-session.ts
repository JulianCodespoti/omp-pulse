import type { OmpSessionSummary } from "@/domain/protocol";

// A selected object is only a fallback for catalogue pagination. Its stable
// path, not the captured pendingAsk object, identifies the current question.
export function resolveAnswerSession(selected: OmpSessionSummary | null, sessions: readonly OmpSessionSummary[]): OmpSessionSummary | null {
  return selected ? sessions.find(session => session.path === selected.path) ?? selected : null;
}

// Only persisted ask calls have a question-position identity in the catalogue.
// Generic native/collab dialogs must use their exact-ID UI in the conversation;
// terminal-only prompts have no safe remote lifecycle identity.
export function answerQuestionKey(session: OmpSessionSummary | null): string | null {
  const ask = session?.pendingAsk;
  if (!session || !ask?.id) return null;
  return JSON.stringify([session.path, ask.id, ask.index]);
}

