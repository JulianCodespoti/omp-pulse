import { createContext, useContext, useMemo, type ReactNode } from "react";
import { magicKeywordMatches, type MagicKeyword, type MagicKeywordMatch } from "../../domain/magic-keywords";

const KeywordContext = createContext<{ source: string; matches: MagicKeywordMatch[] } | null>(null);

export function MagicKeywordProvider({ text, keywords, children }: {
  text: string; keywords: readonly MagicKeyword[] | null; children: ReactNode;
}) {
  const value = useMemo(() => keywords?.length ? { source: text, matches: magicKeywordMatches(text, keywords) } : null, [text, keywords]);
  return <KeywordContext.Provider value={value}>{children}</KeywordContext.Provider>;
}

/** Raw source offsets keep markdown's decoded/fragmented text from inventing matches. */
export function MagicKeywordText({ text, sourceStart, keywords }: {
  text: string; sourceStart?: number; keywords?: readonly MagicKeyword[];
}) {
  const context = useContext(KeywordContext);
  const matches = useMemo(() => {
    if (keywords) return magicKeywordMatches(text, keywords);
    if (!context || sourceStart === undefined || sourceStart < 0) return [];
    const end = sourceStart + text.length;
    return context.matches.filter(match => match.start >= sourceStart && match.end <= end)
      .map(match => ({ ...match, start: match.start - sourceStart, end: match.end - sourceStart }));
  }, [context, keywords, sourceStart, text]);
  if (!matches.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (cursor < match.start) parts.push(text.slice(cursor, match.start));
    const [from, to] = match.keyword.hue;
    const colors = Array.from({ length: 14 }, (_, index) => `hsl(${Math.round(from + index / 14 * (to - from)) % 360} 90% 62%)`);
    parts.push(<span key={match.start} data-magic-keyword={match.keyword.id} style={{
      backgroundImage: `linear-gradient(90deg, ${colors.join(", ")})`,
      backgroundClip: "text", WebkitBackgroundClip: "text", color: "transparent",
    }}>{text.slice(match.start, match.end)}</span>);
    cursor = match.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function useMagicKeywordSource(): string | undefined {
  return useContext(KeywordContext)?.source;
}
