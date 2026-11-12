import { FileTextIcon, ListTodoIcon, PlugIcon, SparklesIcon, SquareSlashIcon, type LucideIcon } from "lucide-react";

import { FREQUENT_BUILTINS } from "./command-registry";

/**
 * The one ordering for command lists. The inline slash palette and the
 * Commands sheet used to sort independently, so muscle memory built in one
 * did not carry to the other. Both now group and order through here.
 */

interface Orderable {
  name: string;
  source?: string;
}

function sourceRank(source: string): number {
  const lower = source.toLowerCase();
  if (lower === "builtin") return 0;
  if (lower === "tasks" || lower.includes("skill")) return 1;
  if (lower.includes("file") || lower === "prompt") return 2;
  if (lower.includes("mcp")) return 3;
  return 4;
}

export function sourceLabel(source: string): string {
  const lower = source.toLowerCase();
  if (lower === "builtin") return "Built-in";
  if (lower === "tasks") return "Tasks";
  if (lower === "skill" || lower === "skills") return "Skills";
  if (lower === "file") return "Files";
  if (lower === "prompt") return "Prompt templates";
  if (lower === "mcp") return "MCP";
  return source;
}

/** The leading icon of a command row: where the command comes from. */
export function sourceIcon(source: string | undefined): LucideIcon {
  const lower = (source ?? "builtin").toLowerCase();
  if (lower === "tasks") return ListTodoIcon;
  if (lower.includes("skill")) return SparklesIcon;
  if (lower.includes("file") || lower === "prompt") return FileTextIcon;
  if (lower.includes("mcp")) return PlugIcon;
  return SquareSlashIcon;
}

const FREQUENT_RANK: Record<string, number> = Object.fromEntries(FREQUENT_BUILTINS.map((name, i) => [name.toLowerCase(), i]));

/** Frequent built-ins first in a fixed order, then the daemon's order. */
function compareWithinGroup(a: Orderable, b: Orderable): number {
  const ra = FREQUENT_RANK[a.name.replace(/^\/+/, "").toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
  const rb = FREQUENT_RANK[b.name.replace(/^\/+/, "").toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
  return ra - rb;
}

/** Group by source (built-in, tasks/skills, files, MCP), each group ordered. */
export function groupCommands<T extends Orderable>(commands: readonly T[]): [source: string, items: T[]][] {
  const map = new Map<string, T[]>();
  for (const cmd of commands) {
    const key = (cmd.source ?? "builtin").toLowerCase();
    const list = map.get(key);
    if (list) list.push(cmd);
    else map.set(key, [cmd]);
  }
  const entries = Array.from(map.entries());
  // Array.prototype.sort is stable, so ties keep the daemon's order.
  entries.sort((a, b) => sourceRank(a[0]) - sourceRank(b[0]));
  for (const [, list] of entries) list.sort(compareWithinGroup);
  return entries;
}

/** Flat list in the same order the Commands sheet shows. */
export function orderCommands<T extends Orderable>(commands: readonly T[]): T[] {
  return groupCommands(commands).flatMap(([, list]) => list);
}
