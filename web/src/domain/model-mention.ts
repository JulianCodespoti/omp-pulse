import { fuzzyScore } from "./file-mention";

/** OMP 18.8.6 model-mention-syntax.ts: /(^|\s)\^([^\s^]+)(?=\s|$)/g.
 * Selectors are exact, case-sensitive provider/id strings, not shell words:
 * quotes, routing suffixes, slashes and punctuation are literal identifier bytes.
 */
export type ModelMentionToken = {
  start: number;
  end: number;
  query: string;
};

export type ModelMentionEntry = {
  selector: string;
  name: string;
  provider: string;
};

export function isModelMentionSelector(selector: string): boolean {
  return selector.length > 0 && !/[\s^]/.test(selector);
}

/** Completion uses OMP's start/whitespace boundary, never the file @ boundary. */
export function modelMentionAtCaret(text: string, caret: number): ModelMentionToken | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  if (caret > 0 && /\s/.test(text[caret - 1])) return null;
  const match = /(?:^|\s)(\^[^\s]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const prefix = match[1];
  const start = caret - prefix.length;
  const rest = /^\S*/.exec(text.slice(caret))?.[0] ?? "";
  // A second caret cannot be part of an OMP model selector.
  if (prefix.slice(1).includes("^") || rest.includes("^")) return null;
  return { start, end: caret + rest.length, query: prefix.slice(1) };
}

/** Filter only authoritative choices; case-insensitive search never rewrites an id. */
export function rankModelMentionEntries(
  entries: readonly ModelMentionEntry[],
  query: string,
  limit = 20,
): ModelMentionEntry[] {
  const seen = new Set<string>();
  const ranked: { entry: ModelMentionEntry; score: number }[] = [];
  for (const entry of entries) {
    if (!isModelMentionSelector(entry.selector) || seen.has(entry.selector)) continue;
    seen.add(entry.selector);
    const scores = [entry.selector, entry.name, entry.provider]
      .map((value) => fuzzyScore(value, query))
      .filter((score): score is number => score !== null);
    if (scores.length) ranked.push({ entry, score: Math.min(...scores) });
  }
  // Keep the owner's order for ties (including the empty query).
  ranked.sort((a, b) => a.score - b.score);
  return ranked.slice(0, limit).map(({ entry }) => entry);
}

/** Replace the entire token at the caret, preserving all following prompt text. */
export function applyModelMention(
  text: string,
  token: ModelMentionToken,
  entry: Pick<ModelMentionEntry, "selector">,
): { text: string; caret: number } {
  if (!isModelMentionSelector(entry.selector)) {
    return { text, caret: token.start + 1 + token.query.length };
  }
  const tail = text.slice(token.end);
  const spacer = /^\s/.test(tail) ? "" : " ";
  const head = `${text.slice(0, token.start)}^${entry.selector}${spacer}`;
  return { text: `${head}${tail}`, caret: head.length + (spacer ? 0 : 1) };
}
