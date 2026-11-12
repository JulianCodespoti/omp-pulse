/**
 * `@path` mentions. omp inlines a mentioned file into the prompt server-side
 * (`extractFileMentions` in `AgentSession.prompt`), so the phone only has to
 * help write the token. The grammar mirrors omp's:
 *
 *   /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/   preceded by start or [\s([{<"'`]
 *
 * and omp strips trailing punctuation from a bare token, so a path containing
 * whitespace or ending in punctuation is inserted quoted.
 */

export type MentionToken = {
  /** Index of the `@`. */
  start: number;
  /** End of the token (exclusive): the caret may sit mid-token. */
  end: number;
  /** Directory part, relative to the session cwd, without a trailing slash. */
  dir: string;
  /** What is being typed after the last `/`. */
  leaf: string;
};

const BOUNDARY = /[\s([{<"'`]/;

/** The `@token` the caret is in, or null. Quoted tokens are finished. */
export function mentionAtCaret(text: string, caret: number): MentionToken | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !BOUNDARY.test(before[at - 1] ?? "")) return null;
  const typed = before.slice(at + 1);
  if (/[\s@"']/.test(typed)) return null;
  const rest = /^[^\s@]*/.exec(text.slice(caret))?.[0] ?? "";
  const slash = typed.lastIndexOf("/");
  return {
    start: at,
    end: caret + rest.length,
    dir: slash >= 0 ? typed.slice(0, slash).replace(/\/+$/, "") : "",
    leaf: slash >= 0 ? typed.slice(slash + 1) : typed,
  };
}

/**
 * Subsequence match score, lower is better; null when `query` is not a
 * subsequence of `name`. Prefix beats word-start beats scattered, so `rea`
 * ranks README above `thread.ts`.
 */
export function fuzzyScore(name: string, query: string): number | null {
  if (!query) return 0;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n.startsWith(q)) return 0;
  const contained = n.indexOf(q);
  if (contained >= 0) return /[\W_]/.test(n[contained - 1] ?? "") ? 1 : 2;
  let score = 3;
  let from = 0;
  let last = -1;
  for (const ch of q) {
    const found = n.indexOf(ch, from);
    if (found < 0) return null;
    // Gaps cost: "cmp" in "composer" is weaker than in "compile".
    if (last >= 0) score += Math.min(found - last - 1, 5);
    last = found;
    from = found + 1;
  }
  return score;
}

export type MentionEntry = { name: string; path: string; type: "dir" | "file" };

/** Best matches first; directories win ties because they lead somewhere. */
export function rankMentionEntries(entries: readonly MentionEntry[], leaf: string, limit = 8): MentionEntry[] {
  // A dotfile shows only when asked for, like a shell's completion.
  const showHidden = leaf.startsWith(".");
  const scored: { entry: MentionEntry; score: number }[] = [];
  for (const entry of entries) {
    if (!showHidden && entry.name.startsWith(".")) continue;
    const score = fuzzyScore(entry.name, leaf);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      (a.entry.type === b.entry.type ? 0 : a.entry.type === "dir" ? -1 : 1) ||
      a.entry.name.localeCompare(b.entry.name),
  );
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * Replace the token with the chosen entry. A file ends the mention with a
 * space; a directory keeps it open (`@src/`) so the next level can be picked.
 */
export function applyMention(
  text: string,
  token: MentionToken,
  entry: Pick<MentionEntry, "path" | "type">,
): { text: string; caret: number } {
  const path = entry.type === "dir" ? `${entry.path.replace(/\/+$/, "")}/` : entry.path;
  const quoted = entry.type === "file" && (/\s/.test(path) || /[)\]}>.,;:!?"'`]$/.test(path));
  const inserted = quoted ? `@"${path}"` : `@${path}`;
  const tail = text.slice(token.end);
  const spacer = entry.type === "dir" || /^\s/.test(tail) ? "" : " ";
  const head = `${text.slice(0, token.start)}${inserted}${spacer}`;
  return { text: `${head}${tail}`, caret: head.length + (spacer || entry.type === "dir" ? 0 : 1) };
}
