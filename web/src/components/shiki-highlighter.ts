import {
  createHighlighter,
  createJavaScriptRegexEngine,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
  type RegexEngine,
} from "shiki";
import type { ThemeInput } from "@streamdown/code";

// The ONE place the app creates Shiki highlighters. Markdown fences
// (code-plugin.ts) and tool/file code blocks (ai-elements/code-block.tsx) both
// come here, so a language highlighted in both places is compiled once.
//
// WHY ONE ENGINE: the JS regex engine caches every pattern it compiles, and
// that cache is most of a highlighter's memory. Measured in Node/V8 after one
// tokenize: a TypeScript highlighter with its own engine retains ~16 MB; a
// second TypeScript highlighter on the SAME engine retains ~0.5 MB.
// TypeScript + TSX + JavaScript cost 45 MB on separate engines and 22.5 MB on
// one, because the grammars share most patterns. code-block.tsx used to build
// a fresh engine per language, beside code-plugin's own, so every grammar used
// in both a fence and a tool block was compiled twice.
//
// `forgiving` skips a pattern the JS engine cannot translate instead of
// failing the whole highlight; the fence plugin already relied on it.

export type Highlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

let engine: RegexEngine | null = null;
const highlighters = new Map<string, Promise<Highlighter>>();

export const themeName = (theme: ThemeInput) =>
  typeof theme === "string" ? theme : (theme.name ?? "custom");

/** One highlighter per language and theme pair, created on first use and kept for the page's life. */
export function highlighterFor(language: string, themes: readonly [ThemeInput, ThemeInput]): Promise<Highlighter> {
  const key = `${language}-${themeName(themes[0])}-${themeName(themes[1])}`;
  let highlighter = highlighters.get(key);
  if (!highlighter) {
    engine ??= createJavaScriptRegexEngine({ forgiving: true });
    highlighter = createHighlighter({ themes: [themes[0], themes[1]], langs: [language as BundledLanguage], engine });
    highlighters.set(key, highlighter);
  }
  return highlighter;
}
