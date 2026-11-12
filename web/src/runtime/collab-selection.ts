import type { CollabRequest } from "./omp-store";

/** Native CollabUiRequest select metadata, never inferred from option labels. */
export function collabSelectionMetadata(request: Record<string, unknown>, optionCount: number): Pick<CollabRequest, "selectionMarker" | "checkedIndices" | "markableCount" | "helpText"> {
  const marker = request.selectionMarker;
  if (marker !== "radio" && marker !== "checkbox") return {};
  const count = request.markableCount === undefined ? optionCount : request.markableCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > optionCount) return {};
  const checked = request.checkedIndices;
  if (checked !== undefined && (!Array.isArray(checked) || !checked.every(index => typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < count))) return {};
  return {
    selectionMarker: marker,
    checkedIndices: Array.isArray(checked) ? [...new Set(checked as number[])] : [],
    markableCount: count,
    ...(typeof request.helpText === "string" ? { helpText: request.helpText } : {}),
  };
}
