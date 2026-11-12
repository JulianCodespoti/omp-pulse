import type { ModelInfo } from "../../runtime/api-types";

/** "5.5.0" -> [5, 5, 0]; anything without a numeric revision is unknown. */
function revision(model: ModelInfo): number[] | null {
  const raw = model.identity?.revision;
  if (typeof raw !== "string") return null;
  const parts = raw.split(".").map((part) => Number.parseInt(part, 10));
  return parts.length > 0 && parts.every(Number.isFinite) ? parts : null;
}

/** A dated release id ("…-20241022" or "…-2025-06-17") as a sortable number, else 0. */
function stamp(model: ModelInfo): number {
  const compact = /(?:^|[-_])(20\d{2})(\d{2})(\d{2})$/.exec(model.id);
  if (compact) return Number(`${compact[1]}${compact[2]}${compact[3]}`);
  const dashed = /(?:^|[-_])(20\d{2})-(\d{2})-(\d{2})$/.exec(model.id);
  return dashed ? Number(`${dashed[1]}${dashed[2]}${dashed[3]}`) : 0;
}

/**
 * Newest release first. omp's catalogue has no release date, but most models
 * carry `identity.revision` ("5.5.0" for Opus 5.5, "3.5.0" for the 2024
 * Sonnet), and dated ids break ties between releases of one revision. Models
 * with no revision sort after those with one, then by name, so the order is
 * total and stable.
 */
export function compareByRelease(a: ModelInfo, b: ModelInfo): number {
  const ra = revision(a);
  const rb = revision(b);
  if (ra && rb) {
    for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
      const diff = (rb[i] ?? 0) - (ra[i] ?? 0);
      if (diff !== 0) return diff;
    }
  } else if (ra || rb) {
    return ra ? -1 : 1;
  }
  const dated = stamp(b) - stamp(a);
  if (dated !== 0) return dated;
  return (a.name || a.id).localeCompare(b.name || b.id) || a.provider.localeCompare(b.provider);
}
