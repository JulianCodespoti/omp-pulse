import {
  addPromptHistory,
  parsePromptHistory,
  type PromptHistoryEntry,
} from "../../domain/prompt-history";
import { getDraftNamespace } from "./use-draft";

// Same namespace as drafts: a re-paired device (new credential) starts a new
// history, and two pairings on one browser never read each other's prompts.
const PREFIX = "omp-prompt-history:";

export function readPromptHistory(namespace = getDraftNamespace()): PromptHistoryEntry[] {
  try {
    return parsePromptHistory(localStorage.getItem(`${PREFIX}${namespace}`));
  } catch {
    return [];
  }
}

/** Called once a send is accepted; a failed send is not history. */
export function recordPromptHistory(text: string, namespace = getDraftNamespace()): void {
  try {
    const next = addPromptHistory(readPromptHistory(namespace), text, Date.now());
    localStorage.setItem(`${PREFIX}${namespace}`, JSON.stringify(next));
  } catch {
    // Quota or private mode: recall is a convenience, never a send blocker.
  }
}

/** "Unpair this phone" removes every prompt this credential sent. */
export function clearPromptHistory(namespace = getDraftNamespace()): void {
  const key = `${PREFIX}${namespace}`;
  localStorage.removeItem(key);
  if (localStorage.getItem(key) !== null)
    throw new Error("Could not clear this device's prompt history.");
}
