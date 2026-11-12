/** File sizes for the Files list and the file viewer, in one style. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`;
  return `${(n / 1_073_741_824).toFixed(1)} GB`;
}

/** Compact age for workspace rows: now, 4m, 2h, 3d. */
export function formatAge(at: number | Date, now = Date.now()): string {
  const diff = now - (typeof at === "number" ? at : at.getTime());
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/**
 * An age that cannot be mistaken for a run time: "21m ago" beside rows whose
 * other times are durations ("4m 12s").
 */
export function formatAgo(at: number | Date, now = Date.now()): string {
  const age = formatAge(at, now);
  return age === "now" ? "now" : `${age} ago`;
}

/** Elapsed time as a Metric figure: 12s, 1m 04s, 2h 05m. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
