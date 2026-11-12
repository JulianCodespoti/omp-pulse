import type { UiMessage } from "./messages";

export type AgentOutcome = "done" | "failed" | "stopped";

/**
 * What an agent's own transcript says happened, from its newest assistant
 * message. `null` when the transcript cannot tell (still mid-turn, empty):
 * callers keep the roster's state then.
 */
export function agentOutcome(messages: readonly UiMessage[]): AgentOutcome | null {
  const last = messages.findLast((message) => message.role === "assistant");
  if (!last) return null;
  if (last.stopReason === "aborted") return "stopped";
  if (last.errorMessage || last.stopReason === "error") return "failed";
  const submitted = last.parts.some((part) =>
    part.kind === "tool" && part.name === "yield" && part.state !== "running");
  if (submitted) return "done";
  // A "toolUse" turn is a step in a longer run, not the end of it.
  return last.text.trim() !== "" && last.stopReason !== "toolUse" ? "done" : null;
}
