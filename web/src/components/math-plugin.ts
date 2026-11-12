import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type { MathPlugin } from "streamdown";

// Maths for assistant replies, loaded only when a reply contains `$$`, `\(` or
// `\[` (markdown.tsx, same dynamic-import pattern as code-plugin.ts). KaTeX and
// its unified plugins are ~590 KB: nothing in the eager chat graph may import
// this file statically.
//
// Why not `@streamdown/math`: its options cannot select KaTeX's `mathml`
// output, and without it the reply needs katex.min.css and its fonts (~19 KB of
// render-blocking CSS plus font files for every load). MathML output is drawn
// natively by Chromium, so no stylesheet is imported anywhere. rehype-katex
// retries a failed formula with `throwOnError: false` itself, so a malformed
// formula shows its source in `errorColor` instead of throwing.
//
// `singleDollarTextMath` MUST stay false: a lone `$` is far more often a shell
// variable (`$HOME`) or a price than maths in a coding transcript, and
// remark-math's default (true) would turn `echo $HOME costs $5` into a formula.
export const math: MathPlugin = {
  name: "katex",
  type: "math",
  remarkPlugin: [remarkMath, { singleDollarTextMath: false }],
  rehypePlugin: [rehypeKatex, { output: "mathml", errorColor: "var(--muted-foreground)" }],
};

// Opening or closing fence line, at any indent, quote depth or list marker: a
// fence nested in a list or quote must stay code too.
const FENCE_LINE = /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/;
const SPECIAL = /[`\\]/g;

/**
 * remark-math knows only `$$…$$`. This rewrites the two LaTeX bracket forms,
 * `\(…\)` and `\[…\]`, to `$$…$$` so the same plugin renders them. Every
 * replacement is two characters for two characters, so source offsets (the
 * magic-keyword highlighter indexes the original message by them) are intact.
 *
 * Code is never touched: fenced blocks and inline code spans are skipped, and a
 * backslash escapes the character after it. A delimiter without its partner in
 * the same paragraph (a reply still streaming) stays as typed.
 */
export function prepareMathSource(source: string): string {
  if (!/\\[([]/.test(source)) return source;
  const lines = source.split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = () => {
    if (paragraph.length) out.push(rewriteParagraph(paragraph.join("\n")));
    paragraph = [];
  };
  for (const line of lines) {
    const mark = FENCE_LINE.exec(line);
    if (fence) {
      out.push(line);
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
      continue;
    }
    // A backtick fence's info string cannot hold a backtick: "```x```" is inline code.
    if (mark && !(mark[1][0] === "`" && mark[2].includes("`"))) {
      flush();
      fence = { char: mark[1][0], length: mark[1].length };
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      out.push(line);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out.join("\n");
}

function rewriteParagraph(text: string): string {
  if (!/\\[([]/.test(text)) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    SPECIAL.lastIndex = i;
    const hit = SPECIAL.exec(text);
    if (!hit) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, hit.index);
    i = hit.index;
    if (text[i] === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      // A code span closes on a backtick run of exactly the opening length.
      const closer = new RegExp("(?<!`)`{" + run + "}(?!`)", "g");
      closer.lastIndex = i + run;
      const close = closer.exec(text);
      const end = close ? close.index + run : i + run;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const open = text[i + 1];
    if (open === "(" || open === "[") {
      const end = text.indexOf(open === "(" ? "\\)" : "\\]", i + 2);
      if (end > i + 2 && convertible(text, i, end)) {
        out += "$$" + text.slice(i + 2, end) + "$$";
        i = end + 2;
        continue;
      }
    }
    // The escaped pair is consumed whole, so `\\(` is not a delimiter.
    out += text.slice(i, i + 2);
    i += 2;
  }
  return out;
}

/**
 * Whether `$$` written over the delimiters at [start, end] parses as maths.
 * A `$$` that opens a line starts a display block in remark-math, and that
 * block ends only at a line holding nothing but `$$`: if the closer shares its
 * line with other text, the block would swallow the rest of the reply. So a
 * multi-line formula that opens a line is converted only when both delimiters
 * stand alone on their lines; a one-line formula (its `$$` closer on the same
 * line makes remark-math read it as inline maths) and one that opens mid-line
 * are always safe.
 */
function convertible(text: string, start: number, end: number): boolean {
  const body = text.slice(start + 2, end);
  if (!body.trim() || body.includes("$$")) return false;
  if (!body.includes("\n")) return true;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (text.slice(lineStart, start).trim()) return true;
  const lineEnd = text.indexOf("\n", end + 2);
  const after = text.slice(end + 2, lineEnd < 0 ? text.length : lineEnd);
  return /^[ \t]*\n/.test(body) && /\n[ \t]*$/.test(body) && !after.trim();
}
