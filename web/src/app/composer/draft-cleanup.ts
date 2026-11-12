export type DraftCleanup = "keep-current" | "remove-submitted" | "keep-foreign";

/** A newly observed draft is not necessarily owned by the submitted send. */
export function submittedDraftCleanup(
  state: { value: string; observed: string; foreign: string | null },
  expected: string,
  stored: string,
): DraftCleanup {
  if (state.value !== expected) return "keep-current";
  if (stored === expected || (state.foreign === null && stored === state.observed))
    return "remove-submitted";
  return "keep-foreign";
}
