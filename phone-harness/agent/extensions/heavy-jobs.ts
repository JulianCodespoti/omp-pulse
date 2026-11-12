// phone-harness: route heavy bash tool calls through the machine-wide job broker.
//
// Every agent (main and subagents, every project) shares one phone. When a bash
// call matches a rule in agent/heavy-jobs.json (builds, test suites, typecheck,
// e2e), it runs as `bin/heavy run -- bash -c '<command>'` instead:
//   * the broker admits it when memory and CPU allow (learned per command),
//     fairly across agents and short jobs first, instead of everyone piling into
//     one flock or all running at once and swapping;
//   * the tool's timeout is handed to the broker and counts from admission, so a
//     queued job is never killed for waiting (the tool's own deadline is lifted);
//   * identical cacheable runs on the same tree attach or replay instead of rerunning.
// Python (bin/heavy) and this file implement the same matching; keep them in step
// (tests/test_heavy.py checks both against the same cases).
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const HARNESS = "/root/projects/phone-harness";
const HEAVY = join(HARNESS, "bin/heavy");
const CONFIG = join(HARNESS, "agent/heavy-jobs.json");
const DEFAULT_TIMEOUT_S = 300; // bash tool default
const WRAPPERS: Record<string, true> = { env: true, nice: true, time: true, timeout: true, command: true, flock: true };

interface Rule { id?: string; class?: string; cache?: boolean; re: string }
interface Resources { mem_mb?: number; cpu?: number }
interface Config { classes?: Record<string, Resources>; rules?: Rule[] }
interface Match extends Resources { id: string; class: string; cache: boolean }

const jsonCache = new Map<string, { mtime: number; data: Config | undefined }>();

function loadConfig(path: string): Config | undefined {
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = jsonCache.get(path);
  if (hit && hit.mtime === mtime) return hit.data;
  let data: Config | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // Shape is ours (agent/heavy-jobs.json or a repo's .omp/heavy-jobs.json); rules are checked per use below.
    data = parsed && typeof parsed === "object" ? (parsed as Config) : undefined;
  } catch {
    data = undefined;
  }
  jsonCache.set(path, { mtime, data });
  return data;
}

function gitRoot(cwd: string): string | undefined {
  let d = resolve(cwd);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

// Heredoc bodies dropped, quoted strings emptied: prose in commit messages, PR bodies
// or notes ("make it faster", "pytest is flaky") is not a command.
export function blankQuotes(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    out.push(lines[i]);
    const delims = [...lines[i].matchAll(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g)].map(m => m[1]);
    i++;
    for (const delim of delims) {
      while (i < lines.length && lines[i].trim() !== delim) i++;
      i++;
    }
  }
  return out.join("\n").replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
}

export function simpleCommands(text: string): string[][] {
  const out: string[][] = [];
  for (const seg of blankQuotes(text).split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().replace(/^[({ ]+/, "").replace(/[)} ]+$/, "").split(/\s+/).filter(Boolean);
    while (words.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
        words.shift();
      } else if (WRAPPERS[basename(words[0])]) {
        const lockfile = basename(words.shift() ?? "") === "flock";
        while (words.length && /^(-\S*|\d+[smhd]?|[A-Za-z_][A-Za-z0-9_]*=.*)$/.test(words[0])) words.shift();
        if (lockfile && words.length) words.shift();
      } else {
        break;
      }
    }
    if (words.length) out.push(words);
  }
  return out;
}

export function classify(text: string, cwd?: string, config: Config | undefined = loadConfig(CONFIG)): Match | undefined {
  const classes = config?.classes ?? {};
  const root = cwd ? gitRoot(cwd) : undefined;
  const local = root ? loadConfig(join(root, ".omp", "heavy-jobs.json")) : undefined;
  const rules = [...(local?.rules ?? []), ...(config?.rules ?? [])];
  const found: Match[] = [];
  for (const words of simpleCommands(text)) {
    const seg = words.join(" ");
    for (const rule of rules) {
      if (typeof rule?.re !== "string") continue;
      let re: RegExp;
      try {
        re = new RegExp(`^(\\S*/)?(?:${rule.re})`);
      } catch {
        continue;
      }
      if (re.test(seg)) {
        const cls = rule.class ?? "none";
        found.push({ id: rule.id ?? "?", class: cls, cache: !!rule.cache, ...(classes[cls] ?? {}) });
        break;
      }
    }
  }
  if (!found.length) return undefined;
  const none = found.find(m => m.class === "none");
  if (none) return none;
  const best = found.reduce((a, b) => ((b.mem_mb ?? 0) > (a.mem_mb ?? 0) ? b : a));
  return { ...best, cache: found.every(m => m.cache) };
}

// POSIX single-quote: close, escaped quote, reopen.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export default function heavyJobs(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || process.env.HEAVY === "off") return;
    const input = event.input as Record<string, unknown>;
    const command = typeof input.command === "string" ? input.command : "";
    // Services and terminals never finish on their own; explicit broker calls are already routed.
    if (!command || input.name || input.ready || input.pty) return;
    if (/\bbin\/heavy\b|(^|\s)HEAVY=off\b/.test(command) || !existsSync(HEAVY)) return;
    const cwd = typeof input.cwd === "string" && input.cwd ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
    const rule = classify(command, cwd);
    if (!rule || rule.class === "none") return;
    const timeout = typeof input.timeout === "number" ? input.timeout : DEFAULT_TIMEOUT_S;
    const agent = ctx.agent;
    const owner = agent && agent.kind === "sub" ? String(agent.name || agent.id) : "main";
    const session = String(ctx.sessionManager?.getSessionId?.() ?? "").slice(-6);
    const tag = session ? `${owner}@${session}` : owner;
    const wrapped = `${HEAVY} run --owner ${shq(tag)} --timeout ${timeout} -- bash -c ${shq(command)}`;
    return { input: { ...input, command: wrapped, timeout: 0 } };
  });
}
