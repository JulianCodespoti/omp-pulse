/**
 * Plan mode as the phone shows it. omp persists every mode switch as a
 * `mode_change` entry (`{mode:"plan", data:{planFilePath}}` on enter,
 * `{mode:"none"}` on exit; `plan_paused`, `goal`, `goal_paused` and `vibe`
 * also exist), and the daemon keeps the live agent in step with the latest one
 * on the current branch. So the transcript is the source of truth, and the
 * `plan_mode` reply only fills the gap until its entry reaches the phone.
 */
export interface PlanModeState {
  readonly enabled: boolean;
  readonly planFilePath?: string;
}

/** The newest `mode_change` in a batch and its timestamp (epoch ms). */
export interface PlanModeScan {
  readonly state: PlanModeState;
  readonly at: number;
}

function epochMs(value: unknown): number | null {
  // omp writes ISO strings; a seconds-resolution number is tolerated the same
  // way the controller's model tracking reads it.
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stateFromModeChange(entry: Record<string, unknown>): PlanModeState | null {
  if (entry.type !== "mode_change" || typeof entry.mode !== "string" || !entry.mode) return null;
  // Only "plan" is plan mode: "plan_paused" means the agent is free to act.
  if (entry.mode !== "plan") return { enabled: false };
  const data = entry.data;
  const path = data !== null && typeof data === "object" ? (data as Record<string, unknown>).planFilePath : undefined;
  return typeof path === "string" && path ? { enabled: true, planFilePath: path } : { enabled: true };
}

/**
 * The newest `mode_change` among `entries` that is strictly newer than
 * `after`, or null when the batch says nothing newer.
 *
 * INVARIANT: strictly newer. Backward pages and re-sent tails carry entries
 * already seen; an equal timestamp must not roll a later `plan_mode` reply
 * back to what that same old entry said.
 */
export function newestPlanMode(entries: readonly unknown[], after: number): PlanModeScan | null {
  let best: PlanModeScan | null = null;
  for (const raw of entries) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const state = stateFromModeChange(entry);
    if (!state) continue;
    const at = epochMs(entry.timestamp);
    if (at === null || at <= after) continue;
    // Equal stamps inside one batch: file order decides, later wins.
    if (best === null || at >= best.at) best = { state, at };
  }
  return best;
}

/** A `plan_mode` reply (`{enabled, planFilePath?}`); null when malformed. */
export function parsePlanModeReply(raw: unknown): PlanModeState | null {
  if (raw === null || typeof raw !== "object") return null;
  const reply = raw as Record<string, unknown>;
  if (typeof reply.enabled !== "boolean") return null;
  if (!reply.enabled) return { enabled: false };
  return typeof reply.planFilePath === "string" && reply.planFilePath
    ? { enabled: true, planFilePath: reply.planFilePath }
    : { enabled: true };
}

/**
 * What `/plan` (or its palette row) asks the daemon for. An explicit on/off
 * wins; a bare toggle flips the known state. While plan mode is unknown (null:
 * its `mode_change` may sit in history the phone has not read) a bare toggle
 * returns null and the caller must ask: guessing "off" turned a session that
 * was really planning "on" again and reported the wrong state.
 */
export function planToggleTarget(state: PlanModeState | null, requested?: boolean): boolean | null {
  if (requested !== undefined) return requested;
  return state === null ? null : !state.enabled;
}
