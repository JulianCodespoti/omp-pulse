/**
 * Side questions (omp's `/btw`): one ephemeral model turn over the session's
 * context that never enters the transcript and never waits for, queues into or
 * interrupts the main turn. omp streams them as `btw_delta` (text appended to
 * the record's latest turn) and `btw_record` (the full record at every
 * lifecycle change; the last one for an id wins), and lists them, newest
 * first, with `get_btw_history`. Shapes: omp 18.8.6 `wire/frames.ts`,
 * `docs/rpc.md` "Side questions". Pure state; no React and no transport.
 */
import { createStore, type StoreApi } from "zustand/vanilla";

export type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";

export interface BtwTurn {
  question: string;
  answer: string;
  status: BtwStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface BtwRecord extends BtwTurn {
  id: string;
  leafId: string | null;
  followUps?: BtwTurn[];
}

/** Records for ONE session, newest first. A frame for another path resets it. */
export interface BtwState {
  path: string | null;
  records: readonly BtwRecord[];
}

export const EMPTY_BTW: BtwState = { path: null, records: [] };

const STATUSES: Record<string, BtwStatus> = {
  running: "running",
  complete: "complete",
  cancelled: "cancelled",
  error: "error",
  interrupted: "interrupted",
};

function parseTurn(raw: unknown): BtwTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.question !== "string") return null;
  const status = typeof data.status === "string" ? STATUSES[data.status] : undefined;
  return {
    question: data.question,
    answer: typeof data.answer === "string" ? data.answer : "",
    status: status ?? "error",
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
    ...(typeof data.error === "string" && data.error ? { error: data.error } : {}),
  };
}

export function parseBtwRecord(raw: unknown): BtwRecord | null {
  const turn = parseTurn(raw);
  if (!turn) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id) return null;
  const followUps = Array.isArray(data.followUps)
    ? data.followUps.map(parseTurn).filter((entry): entry is BtwTurn => entry !== null)
    : [];
  return {
    ...turn,
    id: data.id,
    leafId: typeof data.leafId === "string" ? data.leafId : null,
    ...(followUps.length ? { followUps } : {}),
  };
}

/** omp: "A record's latest turn is its last follow-up, else the record itself." */
export function latestBtwTurn(record: BtwRecord): BtwTurn {
  return record.followUps?.at(-1) ?? record;
}

/** Every turn of a topic, oldest first. */
export function btwTurns(record: BtwRecord): BtwTurn[] {
  return [record, ...(record.followUps ?? [])];
}

export function runningBtw(state: BtwState): BtwRecord | null {
  return state.records.find((record) => latestBtwTurn(record).status === "running") ?? null;
}

function forPath(state: BtwState, path: string): BtwState {
  return state.path === path ? state : { path, records: [] };
}

function upsert(records: readonly BtwRecord[], record: BtwRecord): BtwRecord[] {
  const rest = records.filter((entry) => entry.id !== record.id);
  // A follow-up brings its topic back to the top, like omp's own history.
  return [record, ...rest];
}

function appendDelta(record: BtwRecord, delta: string): BtwRecord {
  const followUps = record.followUps;
  if (followUps?.length) {
    const last = followUps[followUps.length - 1];
    return { ...record, followUps: [...followUps.slice(0, -1), { ...last, answer: last.answer + delta }] };
  }
  return { ...record, answer: record.answer + delta };
}

/**
 * Apply one `btw_record` / `btw_delta` frame. A delta for a record this view
 * has not seen is dropped: the next `btw_record` carries the whole answer.
 */
export function reduceBtwFrame(state: BtwState, path: string, frame: Record<string, unknown>): BtwState {
  if (frame.type === "btw_record") {
    const record = parseBtwRecord(frame.record);
    if (!record) return state;
    const base = forPath(state, path);
    return { path, records: upsert(base.records, record) };
  }
  if (frame.type === "btw_delta") {
    if (state.path !== path || typeof frame.recordId !== "string" || typeof frame.delta !== "string" || !frame.delta) return state;
    const index = state.records.findIndex((record) => record.id === frame.recordId);
    if (index < 0 || latestBtwTurn(state.records[index]).status !== "running") return state;
    const records = state.records.slice();
    records[index] = appendDelta(records[index], frame.delta);
    return { path, records };
  }
  return state;
}

/**
 * Replace the list with `get_btw_history` (newest first). Frames that arrived
 * while the request was in flight are newer than the snapshot: a running
 * record here can be LONGER than its snapshot copy, or missing from it
 * altogether, and both are kept so streamed text never jumps backwards.
 */
export function mergeBtwHistory(state: BtwState, path: string, raw: unknown): BtwState {
  if (!Array.isArray(raw)) return forPath(state, path);
  const local = forPath(state, path).records;
  const known = new Map(local.map((record) => [record.id, record]));
  const records = raw
    .map(parseBtwRecord)
    .filter((record): record is BtwRecord => record !== null)
    .map((record) => {
      const mine = known.get(record.id);
      if (!mine) return record;
      const theirs = latestBtwTurn(record);
      const mineTurns = (mine.followUps?.length ?? 0) + 1;
      const theirTurns = (record.followUps?.length ?? 0) + 1;
      // A follow-up may have started (or finished) since this history read.
      if (mineTurns > theirTurns) return mine;
      const latest = latestBtwTurn(mine);
      return mineTurns === theirTurns && theirs.status === "running" &&
        (latest.status !== "running" || latest.answer.length > theirs.answer.length) ? mine : record;
    });
  const listed = new Set(records.map((record) => record.id));
  const newer = local.filter((record) => !listed.has(record.id) && latestBtwTurn(record).status === "running");
  return { path, records: [...newer, ...records] };
}

/**
 * The `btw` response's record: the turn as it started. It travels over HTTP
 * while deltas travel over the socket, so streamed text may already be here;
 * a copy that knows this turn wins over the empty start.
 */
export function adoptBtwRecord(state: BtwState, path: string, raw: unknown): BtwState {
  const record = parseBtwRecord(raw);
  if (!record) return state;
  const base = forPath(state, path);
  const known = base.records.find((entry) => entry.id === record.id);
  if (known && btwTurns(known).length >= btwTurns(record).length) return base;
  return { path, records: upsert(base.records, record) };
}

export type BtwStore = StoreApi<BtwState>;

export function createBtwStore(): BtwStore {
  return createStore<BtwState>(() => EMPTY_BTW);
}
