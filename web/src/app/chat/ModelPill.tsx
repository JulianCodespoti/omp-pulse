/**
 * The words for a thinking level, shared by the composer's model chip, the
 * model picker and the transcript's `Switched to …` divider. Inherit has no
 * words: the model's default needs no label.
 */
export function thinkingLabel(level?: string): string {
  if (!level || level === "inherit") return "";
  const labels: Record<string, string> = { off: "Off", auto: "Auto", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
  return labels[level] ?? "";
}
