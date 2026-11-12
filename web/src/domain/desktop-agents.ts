/** Last-received registry rows, without any claim about freshness or completeness. */
// Registry lifecycle only: `parked` means an idle worker was retained on disk.
// It carries no evidence of pending input.
export type DesktopAgentStatus = "running" | "idle" | "parked" | "aborted" | "unknown";

export type DesktopAgent = {
  id: string;
  displayName?: string;
  status: DesktopAgentStatus;
  parentId?: string;
  createdAt?: number;
  lastActivity?: number;
  hasSessionFile?: boolean;
};

export const DESKTOP_AGENT_STATUSES: readonly DesktopAgentStatus[] = [
  "running", "idle", "parked", "aborted", "unknown",
];

export const DESKTOP_AGENT_STATUS_LABELS: Record<DesktopAgentStatus, string> = {
  running: "Running",
  idle: "Idle",
  parked: "Parked",
  aborted: "Aborted",
  unknown: "Status unknown",
};

function nonblankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    Number.isFinite(new Date(value).getTime()) ? value : undefined;
}

export function desktopAgentsFromSnapshot(input: unknown): DesktopAgent[] {
  if (!Array.isArray(input)) return [];
  const rows: DesktopAgent[] = [];
  const counts = new Map<string, number>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const a = raw as Record<string, unknown>;
    const id = nonblankString(a.id);
    if (!id || a.kind === "main") continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    const status = a.status === "running" || a.status === "idle" ||
      a.status === "parked" || a.status === "aborted" ? a.status : "unknown";
    rows.push({
      id,
      displayName: nonblankString(a.displayName),
      status,
      parentId: nonblankString(a.parentId),
      createdAt: timestamp(a.createdAt),
      lastActivity: timestamp(a.lastActivity),
      hasSessionFile: typeof a.hasSessionFile === "boolean" ? a.hasSessionFile : undefined,
    });
  }
  // Conflicting identities cannot safely own a disclosure or a task jump.
  return rows.filter((row) => counts.get(row.id) === 1);
}
