import type { OmpSessionSummary } from "./protocol";

/** Last path segment of a working directory, for a row title. */
export function projectName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
}

export interface RecentProject {
  cwd: string;
  /** Last path segment, for the row title. */
  label: string;
  /** Epoch ms of the newest real message among this directory's sessions; 0 when unknown. */
  lastActiveAt: number;
  /** Sessions in this directory among the rows given. */
  sessionCount: number;
}

/**
 * Recent project directories for the new-session screen, newest first.
 *
 * Derived from the session listing the client already holds rather than a
 * new endpoint: every row carries `cwd` and `activeAt`, and the listing is
 * ranked by `activeAt`, so its first page already holds the most recently
 * used directories. The listing's own `projects` field does not fit: it ranks
 * by session count over seven days and carries no time.
 *
 * Ranked by `activeAt`, never `mtime`, which bookkeeping bumps (see
 * `OmpSessionSummary.mtime`). Pass the unfiltered listing: rows from a
 * search or project scope would narrow the result to that scope.
 */
export function recentProjects(sessions: readonly OmpSessionSummary[], limit = 8): RecentProject[] {
  const byCwd = new Map<string, RecentProject>();
  for (const session of sessions) {
    const cwd = session.cwd;
    if (!cwd) continue;
    const activeAt = typeof session.activeAt === "number" && Number.isFinite(session.activeAt) ? session.activeAt : 0;
    const existing = byCwd.get(cwd);
    if (existing) {
      existing.sessionCount += 1;
      existing.lastActiveAt = Math.max(existing.lastActiveAt, activeAt);
      continue;
    }
    const label = projectName(cwd);
    byCwd.set(cwd, { cwd, label, lastActiveAt: activeAt, sessionCount: 1 });
  }
  return [...byCwd.values()]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.cwd.localeCompare(b.cwd))
    .slice(0, Math.max(0, limit));
}
