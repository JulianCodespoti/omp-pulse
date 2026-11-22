import type { SessionState } from "./api-types";
import { parsePassiveSessionModel, type SessionModel } from "./omp-store";

/**
 * What to show once omp has acknowledged a model, thinking or fast-mode change.
 *
 * An acknowledgement proves that omp took the request, not what it ended up
 * with: a model-only switch can clear or clamp the effort, and a requested
 * effort can be clamped to a nearby one. Writing the request (or a prediction
 * of omp's rule) into the store showed a level that the next poll or event then
 * took back, which read as the thinking level snapping back. So `proven` is only
 * what the acknowledgement certainly established, and the owner's own
 * `get_state` answer, asked straight after, overrides it wherever it reports
 * a value. Used by every surface that changes these settings (the composer
 * chip and the model picker), so they cannot disagree about the outcome.
 *
 * `known` is the store's current model: it keeps a configured Auto selector,
 * which a native `get_state` cannot report (it carries only the effective effort).
 */
export async function settleSessionChange(
  api: { getState(path: string, options?: { peek?: boolean }): Promise<SessionState> },
  path: string,
  proven: Partial<SessionModel>,
  known: SessionModel | null | undefined,
): Promise<Partial<SessionModel>> {
  const state = await api.getState(path, { peek: true }).catch(() => null);
  // A file snapshot of an idle session is read from a file omp has not flushed
  // this change into: it can only revert the change, never confirm it.
  if (!state || typeof state !== "object" || state.source === "file") return proven;
  const owner = parsePassiveSessionModel(state, {
    ...known,
    ...(proven.thinkingLevel !== undefined ? { thinkingLevel: proven.thinkingLevel } : {}),
  });
  return { ...proven, ...owner };
}
