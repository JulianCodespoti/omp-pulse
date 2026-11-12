import { MAX_BASH_RUNS } from "./bash-output";

export interface SearchSourceLink {
  start: number;
  end: number;
  url: string;
}

/** OMP 18.10.4 formatForLLM puts source/citation URLs on four-space lines. */
export function searchSourceLinks(text: string): SearchSourceLink[] {
  const links: SearchSourceLink[] = [];
  for (const match of text.matchAll(/^ {4}(https?:\/\/[^\s]+)[\t ]*\r?$/gmi)) {
    const url = match[1]!;
    // URL() accepts controls and backslashes by normalising them. Sources must
    // be ordinary absolute HTTP(S) URLs, never credentials or executable URIs.
    if (/[\u0000-\u0020\u007f-\u009f\\]/.test(url)) continue;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) continue;
    } catch {
      continue;
    }
    const start = match.index! + 4;
    links.push({ start, end: start + url.length, url });
    // Share the terminal projection's DOM budget; the rest remains literal.
    if (links.length >= MAX_BASH_RUNS) break;
  }
  return links;
}
