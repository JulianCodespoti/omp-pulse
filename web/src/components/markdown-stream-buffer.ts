/**
 * Live (still-streaming) Markdown presentation policy. Pure and framework-free.
 *
 * Streamdown's incomplete-Markdown repair cannot cope with three shapes that a
 * growing reply produces constantly: a table whose header or last row is half
 * written, a fenced block whose body contains `**`, and a dangling `**` / `__`
 * / backtick at the very end of the text. Rather than repair them, the live
 * view WITHHOLDS the unfinished tail until it is unambiguous. This is a
 * presentation filter only: it never alters the source text, copy payloads or
 * the settled render, and everything it withholds reappears on the next frame
 * that completes it, or immediately when the caller stops passing `live`.
 *
 * Cost: fence/blank-line state is folded incrementally over newly arrived
 * complete lines, so a frame scans only the appended text plus the last block
 * (the lines after the last blank line), never the whole message.
 */

/** An unterminated top-level fenced block, shown as one stable plain block. */
export interface OpenFence {
  /** Opening marker, e.g. "```" or "~~~~". */
  marker: string;
  /** Info string after the marker, trimmed (language, title, ...). */
  info: string;
  /** Raw body so far. A trailing partial closing-fence line is excluded. */
  code: string;
}

export interface LiveMarkdown {
  /** Markdown for the renderer: a prefix of the source, minus any open fence. */
  text: string;
  /** Present only while the text ends inside an unterminated fence. */
  fence: OpenFence | null;
}

export type LiveMarkdownBuffer = (text: string, live?: boolean) => LiveMarkdown;

interface ActiveFence {
  char: string;
  len: number;
  /** Offset of the opening line. */
  start: number;
  /** Offset just after the opening line's newline. */
  bodyStart: number;
  info: string;
}

interface Scan {
  /** Last text folded; only text[0, pos) is trusted as scanned. */
  text: string;
  /** Offset of the first line not yet folded (always a line start). */
  pos: number;
  /** Start of the current block: after the last blank line or closed fence. */
  blockStart: number;
  fence: ActiveFence | null;
}

// Top-level fences only (column 0). An indented fence may belong to a list or
// quote container; those stay with the renderer rather than being lifted out.
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const BLANK = /^[ \t]*$/;
const TABLE_HEADER = /^ {0,3}\|/;
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const DELIMITER_PREFIX = /^ {0,3}[|:\- \t]+$/;
const BARE_LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]*$/;
const CLOSER_PREFIX = /^ {0,3}(?:`+|~+)[ \t]*$/;

const stripCr = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);

function isFenceCloser(line: string, fence: ActiveFence): boolean {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  let j = i;
  while (line[j] === fence.char) j++;
  return j - i >= fence.len && BLANK.test(line.slice(j));
}

function fold(scan: Scan, text: string): void {
  // Reset unless the new text extends what was already folded. Comparing two
  // slices is a flat memcmp (String#startsWith is several times slower on a
  // freshly concatenated string); the per-line work below is what stays
  // proportional to the appended text.
  if (scan.pos > 0 && text.slice(0, scan.pos) !== scan.text.slice(0, scan.pos)) {
    scan.pos = 0;
    scan.blockStart = 0;
    scan.fence = null;
  }
  scan.text = text;
  for (;;) {
    const nl = text.indexOf("\n", scan.pos);
    if (nl < 0) return;
    const line = stripCr(text.slice(scan.pos, nl));
    const fence = scan.fence;
    if (fence) {
      if (isFenceCloser(line, fence)) {
        scan.fence = null;
        scan.blockStart = nl + 1;
      }
    } else {
      const open = FENCE_OPEN.exec(line);
      if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
        scan.fence = {
          char: open[1]![0]!,
          len: open[1]!.length,
          start: scan.pos,
          bodyStart: nl + 1,
          info: open[2]!.trim(),
        };
      } else if (BLANK.test(line)) {
        scan.blockStart = nl + 1;
      }
    }
    scan.pos = nl + 1;
  }
}

/**
 * Offset in `line` where a dangling emphasis/code marker begins, or -1. Only a
 * marker that ends the text and has no partner earlier on the line qualifies:
 * `**bold**` and `` `code` `` closers are left alone, and `**bold` (marker plus
 * content) is left to the renderer's closing repair, which reads better than
 * flashing the words unstyled.
 */
function danglingMarker(line: string): number {
  const c = line[line.length - 1];
  if (c !== "*" && c !== "_" && c !== "`") return -1;
  let j = line.length;
  while (j > 0 && line[j - 1] === c) j--;
  const run = line.length - j;
  if (c === "`" ? run > 2 : run !== 2) return -1;
  const prior = line.slice(0, j);
  let partners = 0;
  let ticks = 0;
  for (let k = 0; k < prior.length; ) {
    const ch = prior[k];
    let e = k + 1;
    if (ch === c || ch === "`") {
      while (e < prior.length && prior[e] === ch) e++;
      if (ch === c && e - k === run) partners++;
      if (ch === "`") ticks++;
    }
    k = e;
  }
  // Inside an open code span `**` is literal text, not a dangling marker.
  if (c !== "`" && ticks % 2 === 1) return -1;
  return partners % 2 === 0 ? j : -1;
}

/**
 * Visible length of `text` outside any open fence. `pos` is the start of the
 * final (newline-less) line; text[blockStart, pos) holds the complete lines of
 * the last block.
 */
function liveCut(text: string, scan: Scan): number {
  const { pos, blockStart } = scan;
  const partial = text.slice(pos);
  // A fence opener typed so far but not yet terminated: info string unknown.
  if (partial.startsWith("```") || partial.startsWith("~~~")) return pos;

  let lastLine = -1;
  let previous = "";
  let established = false;
  for (let i = blockStart; i < pos; ) {
    const nl = text.indexOf("\n", i);
    const line = stripCr(text.slice(i, nl));
    if (previous.includes("|") && line.includes("|") && DELIMITER_ROW.test(line)) {
      established = true;
      break;
    }
    previous = line;
    lastLine = i;
    i = nl + 1;
  }
  if (established) return partial ? pos : text.length; // complete rows only

  const header = lastLine >= 0 && TABLE_HEADER.test(previous);
  if (header) {
    if (!partial) return lastLine; // header awaiting its delimiter row
    if (DELIMITER_PREFIX.test(partial)) return lastLine; // delimiter in flight
  }
  if (partial && TABLE_HEADER.test(partial)) return pos; // header being typed

  const marker = danglingMarker(partial);
  if (marker < 0) return text.length;
  return BARE_LIST_MARKER.test(partial.slice(0, marker)) ? pos : pos + marker;
}

export function createLiveMarkdownBuffer(): LiveMarkdownBuffer {
  const scan: Scan = { text: "", pos: 0, blockStart: 0, fence: null };
  let lastText: string | null = null;
  let lastView: LiveMarkdown | null = null;
  return (text, live = true) => {
    if (!live) return { text, fence: null };
    if (text === lastText && lastView) return lastView;
    fold(scan, text);
    let view: LiveMarkdown;
    const fence = scan.fence;
    if (fence) {
      let code = text.slice(fence.bodyStart);
      // A bare run of fence characters may be the closing fence mid-typing.
      const lastBreak = code.lastIndexOf("\n") + 1;
      if (CLOSER_PREFIX.test(code.slice(lastBreak))) {
        code = code.slice(0, lastBreak);
      }
      view = {
        text: text.slice(0, fence.start),
        fence: { marker: fence.char.repeat(fence.len), info: fence.info, code },
      };
    } else {
      const cut = liveCut(text, scan);
      view = { text: cut === text.length ? text : text.slice(0, cut), fence: null };
    }
    lastText = text;
    lastView = view;
    return view;
  };
}
