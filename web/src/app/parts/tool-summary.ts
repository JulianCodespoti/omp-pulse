/**
 * Count output lines without allocating an array of one string per line; collapsed
 * tool rows only need this number to decide whether the output preview is clamped.
 * When `stopAfter` is set, scanning stops as soon as that many lines are found.
 */
export function countLines(text: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let lines = 1;
  let index = 0;
  while (lines < stopAfter) {
    index = text.indexOf("\n", index);
    if (index === -1) break;
    lines += 1;
    index += 1;
  }
  return lines;
}

/**
 * Clamp previews without splitting huge outputs into temporary line arrays;
 * the collapsed card only needs the first `lineLimit` lines.
 */
export function truncateOnLineBoundary(text: string, charLimit: number, lineLimit: number): string {
  const needsChar = text.length > charLimit;
  const needsLine = countLines(text, lineLimit + 1) > lineLimit;
  if (!needsChar && !needsLine) return text;
  let charTrunc = text;
  if (needsChar) {
    // Never cut between a surrogate pair: half an emoji renders as U+FFFD.
    const end = /[\uD800-\uDBFF]/.test(text[charLimit - 1] ?? "") ? charLimit - 1 : charLimit;
    const slice = text.slice(0, end);
    const nl = slice.lastIndexOf("\n");
    charTrunc = nl > charLimit * 0.6 ? slice.slice(0, nl) : slice;
  }
  let lineTrunc = text;
  if (needsLine) {
    let nl = -1;
    for (let line = 0; line < lineLimit; line++) {
      nl = text.indexOf("\n", nl + 1);
    }
    lineTrunc = text.slice(0, nl);
  }
  if (needsChar && needsLine) return charTrunc.length < lineTrunc.length ? charTrunc : lineTrunc;
  return needsChar ? charTrunc : lineTrunc;
}

export function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

const ERROR_WORDS = /\b(error|fatal|failed|failure|exception|panic|denied|not found|no such|cannot|can't|unable)\b/i;
// eslint-disable-next-line no-control-regex -- SGR colour codes only
const ANSI = /\u001b\[[0-9;]*m/g;

/** The line that says why a call failed: the first error-looking line near the top, else the first non-empty one. */
export function firstErrorLine(output: string, max = 160): string {
  const clip = (line: string) => (line.length > max ? `${line.slice(0, max - 1)}…` : line);
  let first = "";
  let index = 0;
  for (let n = 0; n < 60 && index <= output.length; n++) {
    const end = output.indexOf("\n", index);
    const line = output.slice(index, end === -1 ? undefined : end).replace(ANSI, "").trim();
    if (line) {
      if (ERROR_WORDS.test(line)) return clip(line);
      first ||= line;
    }
    if (end === -1) break;
    index = end + 1;
  }
  return clip(first);
}

/**
 * Human-readable one-line summary for a tool call header.
 * Never returns raw JSON — always a short human sentence that fits 390px.
 */
export function toolSummary(name: string, args: unknown, intent?: string): string {
  if (intent?.trim()) return firstLine(intent.trim());
  const lower = name.toLowerCase().split(/[.:/]/).at(-1) ?? name.toLowerCase();
  const a = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  let s = "";

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  if (str(a.title).trim()) return firstLine(str(a.title).trim());
  if (lower === "eval" || lower === "js" || lower === "python") return "Running code";
  if (lower === "hub") return str(a.action) || str(a.name) || "Managing background work";
  if (lower === "todo") return "Updating tasks";

  if (
    lower === "read" ||
    lower === "write" ||
    lower === "edit" ||
    lower === "hashline" ||
    lower === "apply_patch"
  ) {
    const rawPath = str(a.path) || str(a.file) || str(a.file_path) || str(a.filename);
    const patch = str(a.input) || str(a.content) || str(a.patch);
    const patchPath = /^\s*\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]/m.exec(patch)?.[1] ?? "";
    const raw = rawPath || patchPath;
    if (raw) {
      const separator = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
      const base = raw.slice(separator + 1);
      const parentSeparator =
        separator > 0
          ? Math.max(raw.lastIndexOf("/", separator - 1), raw.lastIndexOf("\\", separator - 1))
          : -1;
      const parent = separator > 0 ? raw.slice(parentSeparator + 1, separator) : "";
      s = base ? (parent ? `${parent}/${base}` : base) : raw;
    }
  } else if (
    lower === "bash" ||
    lower === "shell" ||
    lower === "run" ||
    lower.includes("bash") ||
    lower.includes("shell")
  ) {
    const raw = str(a.command) || str(a.cmd) || str(a.code) || str(a.run) || str(a.script);
    // Agents almost always prefix with `cd <repo> && …`, which made every bash
    // card read identically as `$ cd /home/…`. Show what the command actually
    // DOES: drop leading `cd …&&` hops and any `set -e` preamble.
    if (raw) {
      let line = firstLine(raw).trim();
      for (;;) {
        const stripped = line.replace(/^(?:cd\s+[^&;|]+|set\s+-\w+)\s*(?:&&|;)\s*/, "").trim();
        if (stripped === line || stripped === "") break;
        line = stripped;
      }
      s = line || firstLine(raw).trim();
    }
  } else if (
    lower === "grep" ||
    lower === "search" ||
    lower.includes("grep") ||
    (lower.includes("search") && !lower.includes("web"))
  ) {
    s = str(a.pattern) || str(a.query) || str(a.regex) || str(a.text);
  } else if (
    lower === "glob" ||
    lower === "find" ||
    lower.includes("glob")
  ) {
    s = str(a.pattern) || str(a.path) || str(a.query) || str(a.glob) || "";
  } else if (
    lower === "web_search" ||
    lower === "websearch" ||
    lower.includes("web_search") ||
    (lower.includes("web") && lower.includes("search"))
  ) {
    s = str(a.query) || str(a.q) || str(a.search) || "";
  } else if (lower === "task" || lower.includes("task") || lower === "agent") {
    s =
      str(a.description) ||
      str(a.prompt) ||
      str(a.task) ||
      str(a.agent) ||
      str(a.name) ||
      str(a.subagent_type) ||
      "Delegating work";
    // agent name variants: prefer description over raw prompt
    if (!s && typeof a.subagent_type === "string") s = a.subagent_type as string;
  } else if (lower === "ask" || lower.includes("ask")) {
    if (typeof a.question === "string") s = a.question;
    else if (Array.isArray(a.question) && typeof a.question[0] === "string")
      s = a.question[0] as string;
    else if (typeof a.questions === "string") s = a.questions as string;
    else if (
      Array.isArray(a.questions) &&
      a.questions.length > 0 &&
      typeof a.questions[0] === "string"
    )
      s = a.questions[0] as string;
    else if (typeof a.prompt === "string") s = a.prompt as string;
    if (!s) s = "Asking a question";
  }

  if (!s) {
    // Fallback: first short string-valued arg, else first string arg at all
    for (const v of Object.values(a)) {
      if (typeof v === "string" && v.trim().length > 0 && v.trim().length < 200) {
        s = v;
        break;
      }
    }
    if (!s) {
      for (const v of Object.values(a)) {
        if (typeof v === "string" && v.trim().length > 0) {
          s = v;
          break;
        }
      }
    }
  }

  if (!s) return "";

  s = firstLine(s.trim()).trim();
  if (!s) return "";

  if (s.length > 64) return `${s.slice(0, 64).trimEnd()}…`;
  return s;
}
