export interface MagicKeyword {
  id: string;
  word: string;
  hue: [number, number];
}
export interface MagicKeywordMatch { start: number; end: number; keyword: MagicKeyword }

// OMP 18.8.6: packages/tui/src/prompt/markdown-prose.ts and magic-keywords.ts.
// Preserve UTF-16 offsets and newlines while masking code and XML/HTML content.
export function maskKeywordNonProse(text: string): string {
  if (!text.includes("`") && !text.includes("<") && !text.includes("~~~")) return text;
  const masked = new Uint8Array(text.length);
  const hide = (start: number, end: number) => masked.fill(1, start, end);
  let fence = "", fenceLength = 0;
  for (let start = 0; start <= text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end);
    const match = /^( {0,3})([`~]{3,})/.exec(line);
    if (fence) {
      hide(start, end);
      if (match && match[2]![0] === fence && match[2]!.length >= fenceLength
        && line.slice(match[1]!.length + match[2]!.length).trim() === "") fence = "";
    } else if (match && !(match[2]![0] === "`" && line.slice(match[1]!.length + match[2]!.length).includes("`"))) {
      fence = match[2]![0]!;
      fenceLength = match[2]!.length;
      hide(start, end);
    }
    if (end === text.length) break;
    start = end + 1;
  }
  const tickEnd = (start: number) => {
    while (text[start] === "`") start++;
    return start;
  };
  const tagEnd = (start: number) => {
    let quote = "";
    for (let index = start; index < text.length; index++) {
      const ch = text[index]!;
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") return index;
      else if (ch === "<") return -1;
    }
    return -1;
  };
  const tagName = /[A-Za-z][A-Za-z0-9-]*/y;
  for (let index = 0; index < text.length;) {
    if (masked[index]) { index++; continue; }
    if (text[index] === "`") {
      const runEnd = tickEnd(index);
      let closing = -1;
      for (let cursor = runEnd; cursor < text.length;) {
        if (masked[cursor] || text[cursor] !== "`") { cursor++; continue; }
        const end = tickEnd(cursor);
        if (end - cursor === runEnd - index) { closing = end; break; }
        cursor = end;
      }
      if (closing >= 0) { hide(index, closing); index = closing; }
      else index = runEnd;
      continue;
    }
    if (text[index] !== "<") { index++; continue; }
    if (text.startsWith("<!--", index)) {
      const closing = text.indexOf("-->", index + 4);
      const end = closing < 0 ? text.length : closing + 3;
      hide(index, end); index = end; continue;
    }
    const isClosing = text[index + 1] === "/";
    tagName.lastIndex = index + (isClosing ? 2 : 1);
    const name = tagName.exec(text);
    if (!name) { index++; continue; }
    const end = tagEnd(tagName.lastIndex);
    if (end < 0) { index++; continue; }
    hide(index, end + 1);
    if (isClosing || text[end - 1] === "/") { index = end + 1; continue; }
    let depth = 1, closing = -1;
    for (let cursor = end + 1; cursor < text.length;) {
      if (masked[cursor] || text[cursor] !== "<") { cursor++; continue; }
      const close = text[cursor + 1] === "/";
      tagName.lastIndex = cursor + (close ? 2 : 1);
      const nested = tagName.exec(text);
      const nestedEnd = nested ? tagEnd(tagName.lastIndex) : -1;
      if (!nested || nestedEnd < 0) { cursor++; continue; }
      if (nested[0].toLowerCase() === name[0].toLowerCase()) {
        if (close) { if (--depth === 0) { closing = nestedEnd + 1; break; } }
        else if (text[nestedEnd - 1] !== "/") depth++;
      }
      cursor = nestedEnd + 1;
    }
    if (closing >= 0) { hide(end + 1, closing); index = closing; }
    else index = end + 1;
  }
  return text.split("").map((ch, index) => masked[index] && ch !== "\n" ? " " : ch).join("");
}

export function magicKeywordMatches(text: string, keywords: readonly MagicKeyword[]): MagicKeywordMatch[] {
  let prose: string | undefined;
  const matches: MagicKeywordMatch[] = [];
  for (const keyword of keywords) {
    if (!keyword.word || !text.includes(keyword.word)) continue;
    prose ??= maskKeywordNonProse(text);
    const word = keyword.word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)${word}(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`, "gu");
    for (const match of prose.matchAll(pattern)) {
      matches.push({ start: match.index, end: match.index + match[0].length, keyword });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}
