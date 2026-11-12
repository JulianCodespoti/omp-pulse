import type { OmpSessionSummary, OmpTurnState } from "../domain/protocol";

/** What the "reply ready" toast needs from one listing row. */
export interface ReplyRow {
  path: string;
  turn: OmpTurnState;
  /** The daemon's `lastTurnOutcome`: "completed", "failed" or "interrupted". */
  outcome?: string;
  interrupted: boolean;
  /** Plain reply text, only when the listing's newest entry is the assistant's. */
  text?: string;
}

/** Sessions seen running in this app run -> the reply text the listing held back then. */
export type ReplyWatch = ReadonlyMap<string, string | undefined>;

export function replyRow(session: OmpSessionSummary, turn: OmpTurnState): ReplyRow {
  const snippet = session.snippet;
  return {
    path: session.path,
    turn,
    outcome: session.lastTurnOutcome,
    interrupted: Boolean(session.interrupted),
    text: snippet?.role === "assistant" ? snippet.text : undefined,
  };
}

/**
 * Which sessions just finished a turn the user has not seen. Only a session
 * watched RUNNING earlier in this app run can fire, so a first load (every
 * row already idle) is silent; the open session never fires (its transcript is
 * on screen); a stopped or failed turn is not a reply; "unknown" is
 * uncertainty, not an end, and keeps its watch. A session missing from the
 * rows (a search view, a later page) loses its watch instead of firing late.
 */
export function detectReplyReady(
  watch: ReplyWatch,
  rows: readonly ReplyRow[],
  currentPath: string | null,
): { watch: Map<string, string | undefined>; ready: { path: string; text?: string }[] } {
  const next = new Map<string, string | undefined>();
  const ready: { path: string; text?: string }[] = [];
  for (const row of rows) {
    if (row.path === currentPath) continue;
    if (row.turn === "running") {
      next.set(row.path, watch.has(row.path) ? watch.get(row.path) : row.text);
    } else if (!watch.has(row.path)) {
      continue;
    } else if (row.turn === "unknown") {
      next.set(row.path, watch.get(row.path));
    } else if (!row.interrupted && (row.outcome === undefined || row.outcome === "completed")) {
      // The same text as when the turn began means the listing has not caught up yet.
      ready.push({ path: row.path, text: row.text === watch.get(row.path) ? undefined : row.text });
    }
  }
  return { watch: next, ready };
}

const PREVIEW_CHARS = 120;

/** Crude markdown strip, then the first 120 characters with "…" when cut. */
export function replyPreview(text: string | undefined): string {
  const plain = (text ?? "")
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[`*~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(plain);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("").trimEnd()}…` : plain;
}
