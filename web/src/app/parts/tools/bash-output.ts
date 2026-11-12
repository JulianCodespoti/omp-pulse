/** Read-only projection of one received snapshot. Raw output stays with Copy. */
export const BASH_PALETTE = [
  "#a5a5b0", "#ef8787", "#87d7a0", "#e5ca80",
  "#8bb8ef", "#caa1ef", "#83cdd3", "#d9d9e3",
  "#babac7", "#ff9b9b", "#a0e5b4", "#f0da9a",
  "#a6caff", "#dbb8ff", "#a0e1e5", "#f4f4fa",
] as const;
export const MAX_BASH_RUNS = 2048;
const CSI_LIMIT = 128;
const OSC_LIMIT = 2048;

type Foreground = number | null;
export type BashRun = { start: number; end: number; foreground: Foreground };
export type BashOutput = { text: string; runs: BashRun[]; hasControls: boolean };
export type BashRange = { start: number; end: number };

function sgr(parameters: string, previous: Foreground): Foreground {
  const parts = parameters.split(";");
  if (parameters.split(/[;:]/).length > 32 || !/^[\d;:]*$/.test(parameters)) return null;
  let foreground = previous;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.includes(":")) {
      // Colon operands belong to this group, never to subsequent SGR commands.
      const [kindText, modeText, ...operands] = part.split(":");
      const kind = Number(kindText), mode = modeText ? Number(modeText) : -1;
      if (kind === 38 || kind === 48 || kind === 58) {
        // ISO colour-space slot is optional for RGB. Only the default space is
        // accepted, and unsupported colours remain neutral rather than guessed.
        const channels = mode === 2 && operands.length === 4 && (operands[0] === "" || operands[0] === "0")
          ? operands.slice(1) : operands;
        const count = mode === 2 ? 3 : mode === 5 ? 1 : 0;
        if (!count || channels.length !== count ||
            channels.some(value => !/^\d{1,3}$/.test(value) || Number(value) > 255)) return null;
        if (kind === 38) foreground = null;
      }
      continue;
    }
    const n = Number(part);
    if (n === 38 || n === 48 || n === 58) {
      const modeText = parts[++i];
      const mode = modeText ? Number(modeText) : -1;
      const count = mode === 2 ? 3 : mode === 5 ? 1 : 0;
      if (!count || i + count >= parts.length) return null;
      for (let channel = 0; channel < count; channel++) {
        const operand = parts[++i];
        if (!/^\d{1,3}$/.test(operand) || Number(operand) > 255) return null;
      }
      if (n === 38) foreground = null;
    } else if (n === 0 || n === 39) foreground = null;
    else if (n >= 30 && n <= 37) foreground = n - 30;
    else if (n >= 90 && n <= 97) foreground = n - 90 + 8;
  }
  return foreground;
}

export function parseBashOutput(raw: string): BashOutput {
  const pieces: string[] = [];
  const runs: BashRun[] = [];
  let length = 0, foreground: Foreground = null, hasControls = false;
  let runLimit = false;
  const append = (start: number, end: number) => {
    if (end <= start) return;
    const size = end - start;
    let color = runLimit ? null : foreground;
    const previous = runs[runs.length - 1];
    // Reserve the last run for a neutral remainder, bounding DOM work too.
    if (previous?.foreground !== color && runs.length >= MAX_BASH_RUNS - 1) {
      runLimit = true;
      color = null;
    }
    if (previous?.foreground === color) previous.end += size;
    else runs.push({ start: length, end: length + size, foreground: color });
    pieces.push(raw.slice(start, end));
    length += size;
  };
  let cursor = 0, textStart = 0;
  while (cursor < raw.length) {
    const code = raw.charCodeAt(cursor);
    if (!(code < 32 && code !== 9 && code !== 10 && code !== 13) &&
        !(code >= 127 && code <= 159)) { cursor++; continue; }
    append(textStart, cursor);
    hasControls = true;
    const escape = code === 27;
    const next = escape ? raw[cursor + 1] : "";
    if ((escape && next === "[") || code === 155) {
      const start = cursor + (escape ? 2 : 1);
      let end = start;
      while (end < raw.length && end - start < CSI_LIMIT &&
             raw.charCodeAt(end) >= 32 && raw.charCodeAt(end) <= 63) end++;
      const final = raw.charCodeAt(end);
      if (end - start < CSI_LIMIT && final >= 64 && final <= 126) {
        if (raw[end] === "m") foreground = sgr(raw.slice(start, end), foreground);
        cursor = end + 1;
      } else {
        foreground = null;
        // Without a complete envelope its printable bytes may be diagnostics.
        cursor = start;
      }
    } else if ((escape && next === "]") || code === 157) {
      const start = cursor + (escape ? 2 : 1);
      let end = start;
      while (end < raw.length && end - start < OSC_LIMIT && raw[end] !== "\n" && raw[end] !== "\r") {
        if (raw[end] === "\x07" || raw[end] === "\x9c") break;
        if (raw[end] === "\x1b" || raw[end] === "\x9d") break;
        end++;
      }
      const terminated = raw[end] === "\x07" || raw[end] === "\x9c" ||
        (raw[end] === "\x1b" && raw[end + 1] === "\\");
      cursor = terminated ? end + (raw[end] === "\x1b" ? 2 : 1) : start;
      if (!terminated) foreground = null;
    } else if (escape) {
      let end = cursor + 1;
      while (end < raw.length && end - cursor < CSI_LIMIT &&
             raw.charCodeAt(end) >= 32 && raw.charCodeAt(end) <= 47) end++;
      cursor = end + (raw.charCodeAt(end) >= 48 && raw.charCodeAt(end) <= 126 ? 1 : 0);
    } else cursor++;
    textStart = cursor;
  }
  append(textStart, raw.length);
  return { text: pieces.join(""), runs, hasControls };
}

/** Offsets refer to projected text, so a control cannot be cut by a local limit. */
export function bashChunks(text: string, size: number): BashRange[] {
  const ranges: BashRange[] = [];
  let start = 0;
  while (text.length - start > size) {
    const before = text.lastIndexOf("\n", start + size);
    const end = before >= start ? before : text.indexOf("\n", start + size);
    if (end < 0) break; // Keep an unbroken logical line horizontally scrollable.
    ranges.push({ start, end });
    start = end + 1;
  }
  ranges.push({ start, end: text.length });
  return ranges;
}

export function bashTailStart(text: string, lines: number): number {
  let start = text.length;
  for (let i = 0; i < lines; i++) {
    if (start === 0) return 0;
    start = text.lastIndexOf("\n", start - 1);
    if (start < 0) return 0;
  }
  return start + 1;
}
