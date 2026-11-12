/**
 * Prompts this device sent, newest first, for Up-arrow recall and the History
 * sheet. omp keeps its own history in `~/.omp/agent/history.db`, which RPC
 * cannot reach, so the phone keeps a device-local list.
 *
 * Bounded twice: by count, because the list is parsed whole on every read, and
 * by entry size, because one pasted log must not evict the quota other
 * device-local state (drafts, the outbox mirror) shares.
 */

export const PROMPT_HISTORY_LIMIT = 200;
export const PROMPT_HISTORY_MAX_CHARS = 8_000;

export type PromptHistoryEntry = { text: string; at: number };

/**
 * Add a sent prompt. Re-sending an earlier prompt moves it to the front rather
 * than listing it twice, which is what makes Up-arrow recall of "the thing I
 * keep running" one key press.
 */
export function addPromptHistory(
  list: readonly PromptHistoryEntry[],
  text: string,
  at: number,
  limit = PROMPT_HISTORY_LIMIT,
): PromptHistoryEntry[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > PROMPT_HISTORY_MAX_CHARS) return list.slice(0, limit);
  return [{ text: trimmed, at }, ...list.filter((e) => e.text !== trimmed)].slice(0, limit);
}

/** Accept only well-formed entries from storage; anything else is dropped. */
export function parsePromptHistory(raw: string | null, limit = PROMPT_HISTORY_LIMIT): PromptHistoryEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: PromptHistoryEntry[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const { text, at } = item as { text?: unknown; at?: unknown };
      if (typeof text !== "string" || !text.trim() || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, at: typeof at === "number" && Number.isFinite(at) ? at : 0 });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Case-insensitive substring filter; an empty query keeps everything. */
export function filterPromptHistory(list: readonly PromptHistoryEntry[], query: string): PromptHistoryEntry[] {
  const q = query.trim().toLowerCase();
  return q ? list.filter((e) => e.text.toLowerCase().includes(q)) : list.slice();
}

export type HistoryItem = {
  text: string;
  /** Local entries are complete; transcript hits may be cut at 200 chars. */
  origin: "device" | "transcript";
  /** Transcript hits: where the full message lives, to fetch it on insert. */
  session?: { path: string; offset: number; title?: string; entryId?: string };
  truncated?: boolean;
};

/** A transcript search hit, as `/api/search` returns it. */
export type TranscriptHit = { path: string; title?: string; line: string; role?: string; offset?: number; entryId?: string };

/** The server counts Unicode characters, not UTF-16 code units. */
export function isTruncatedSearchLine(line: string): boolean {
  return [...line].length >= 198 && line.endsWith("…");
}

/**
 * Device prompts first (they are what this person typed here, newest first),
 * then the user's own messages from transcripts. Assistant text is not a
 * prompt and never appears. Only an exact, unabridged line can establish a
 * duplicate: two different full prompts can share an abbreviated prefix.
 */
export function mergePromptHistory(
  local: readonly PromptHistoryEntry[],
  hits: readonly TranscriptHit[],
  limit = 100,
): HistoryItem[] {
  const out: HistoryItem[] = local.map((e) => ({ text: e.text, origin: "device" as const }));
  for (const hit of hits) {
    if (hit.role !== "user" || !hit.line.trim()) continue;
    const truncated = isTruncatedSearchLine(hit.line);
    const duplicate = !truncated && out.some(item => item.text === hit.line);
    if (duplicate) continue;
    out.push({
      text: hit.line,
      origin: "transcript",
      truncated,
      session: typeof hit.offset === "number" && Number.isSafeInteger(hit.offset) && hit.offset >= 0
        ? { path: hit.path, offset: hit.offset, title: hit.title, ...(hit.entryId ? { entryId: hit.entryId } : {}) }
        : undefined,
    });
  }
  return out.slice(0, limit);
}
/**
 * Search lines are previews (even a short line has whitespace collapsed).
 * Never use one as the recovered prompt or as a fallback for an expired anchor.
 */
export async function resolveHistoryText(
  item: HistoryItem,
  read: (path: string, offset: number, entryId?: string) => Promise<string | null>,
): Promise<string> {
  if (item.origin === "device") return item.text;
  const anchor = item.session;
  if (!anchor) throw new Error("The original prompt is unavailable. Search again; the preview was not inserted.");
  const full = await read(anchor.path, anchor.offset, anchor.entryId);
  const normalized = full?.replace(/\s+/gu, " ").trim();
  const prefix = item.truncated ? item.text.slice(0, -1) : item.text;
  if (!full || !(item.truncated ? normalized?.startsWith(prefix) : normalized === item.text)) {
    throw new Error("The original prompt could not be retrieved. Search again; the preview was not inserted.");
  }
  return full;
}


/**
 * One Up/Down step through history. `index` -1 is the live draft. Returns the
 * new index, or null when the key should do nothing (already at an end).
 */
export function stepPromptHistory(index: number, length: number, direction: "older" | "newer"): number | null {
  if (direction === "older") return index + 1 < length ? index + 1 : null;
  return index >= 0 ? index - 1 : null;
}
