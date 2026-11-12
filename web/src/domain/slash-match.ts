/**
 * Ranking for the inline slash list, kept free of React so it is testable on
 * its own. Lower scores are better: 0 exact name/alias, 1 name/alias prefix,
 * 2 name/alias substring, 3 description only.
 */

export type SlashMatchCommand = { name: string; description?: string; aliases?: readonly string[] };

export interface SlashMatches<T> {
  items: T[];
  /**
   * Whether Enter may take the top row without the arrow keys. Only a name or
   * alias that STARTS with what was typed counts. A substring or description
   * hit is a suggestion, not what was asked for: `/tree` reached `/wt`
   * through its alias "worktree", `/new` through "Move this session into a
   * new worktree", and Enter opened that command's sheet instead.
   */
  autoPick: boolean;
}

const MAX_ROWS = 40;

function nameScore(value: string, q: string): number {
  const v = value.replace(/^\/+/, "").toLowerCase();
  if (v === q) return 0;
  if (v.startsWith(q)) return 1;
  if (v.includes(q)) return 2;
  return -1;
}

/** Rank `commands` for a NON-EMPTY typed query (without the leading `/`). */
export function rankSlashMatches<T extends SlashMatchCommand>(commands: readonly T[], query: string): SlashMatches<T> {
  const q = query.toLowerCase();
  const scored: { item: T; score: number }[] = [];
  for (const c of commands) {
    let s = nameScore(c.name, q);
    if (s !== 0) {
      for (const alias of c.aliases ?? []) {
        const a = nameScore(alias, q);
        if (a >= 0 && (s < 0 || a < s)) s = a;
        if (s === 0) break;
      }
    }
    // PARITY-06: match what the command does, not just its name.
    if (s < 0 && c.description?.toLowerCase().includes(q)) s = 3;
    if (s >= 0) scored.push({ item: c, score: s });
  }
  // Stable: equal scores keep catalogue order.
  scored.sort((a, b) => a.score - b.score);
  return {
    items: scored.slice(0, MAX_ROWS).map((x) => x.item),
    autoPick: scored.length > 0 && scored[0]!.score <= 1,
  };
}
