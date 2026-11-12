import {
  bundledLanguages,
  bundledLanguagesInfo,
  type BundledLanguage,
  type TokensResult,
} from "shiki";
import type { CodeHighlighterPlugin, ThemeInput } from "@streamdown/code";
import { highlighterFor, themeName } from "./shiki-highlighter";

// Streamdown's fenced-code highlighter, equivalent to `@streamdown/code`'s
// `code` plugin (same alias resolution, forgiving JS regex engine, per-language
// highlighter, themes and cache key) with two differences. First, highlighters
// come from shiki-highlighter.ts, shared with tool and file code blocks.
// Second, its token cache is bounded. The upstream plugin keeps every
// highlighted block's token tree in a module-level Map for the life of the
// page. Each token carries both themes' styles, so a long-lived WebView
// retained tens of MB of trees for blocks long since scrolled out, evicted or
// left behind in other sessions. Mounted blocks
// keep their own tokens; the cache only spares a remount from re-highlighting.

// A Map, not an object: a fence tagged `constructor` must not hit the prototype.
const aliases = new Map(
  bundledLanguagesInfo.flatMap((info) => (info.aliases ?? []).map((alias) => [alias, info.id] as const)),
);
const supported = new Set(Object.keys(bundledLanguages));
const resolveLanguage = (language: string) => {
  const key = language.trim().toLowerCase();
  return aliases.get(key) ?? key;
};

// Token trees cost far more than their source; bound by both count and source.
const TOKENS_MAX_ENTRIES = 64;
const TOKENS_MAX_SOURCE_CHARS = 256 * 1024;
const tokens = new Map<string, { result: TokensResult; chars: number }>();
let tokenChars = 0;
const waiting = new Map<string, Set<(result: TokensResult) => void>>();

function cachedTokens(key: string): TokensResult | null {
  const hit = tokens.get(key);
  if (!hit) return null;
  // Map order is insertion order: reinserting a hit makes it the newest.
  tokens.delete(key);
  tokens.set(key, hit);
  return hit.result;
}

function cacheTokens(key: string, result: TokensResult, chars: number): void {
  const previous = tokens.get(key);
  if (previous) {
    tokens.delete(key);
    tokenChars -= previous.chars;
  }
  if (chars > TOKENS_MAX_SOURCE_CHARS) return;
  tokens.set(key, { result, chars });
  tokenChars += chars;
  while (tokens.size > TOKENS_MAX_ENTRIES || tokenChars > TOKENS_MAX_SOURCE_CHARS) {
    const oldest = tokens.entries().next().value;
    if (!oldest) break;
    tokens.delete(oldest[0]);
    tokenChars -= oldest[1].chars;
  }
}

function createBoundedCodePlugin(
  themes: [ThemeInput, ThemeInput] = ["github-light", "github-dark"],
): CodeHighlighterPlugin {
  return {
    name: "shiki",
    type: "code-highlighter",
    supportsLanguage: (language) => supported.has(resolveLanguage(language)),
    getSupportedLanguages: () => Array.from(supported) as BundledLanguage[],
    getThemes: () => themes,
    highlight({ code, language, themes: requested }, callback) {
      const resolved = resolveLanguage(language);
      const names = [themeName(requested[0]), themeName(requested[1])] as const;
      const head = code.slice(0, 100);
      const tail = code.length > 100 ? code.slice(-100) : "";
      const key = `${resolved}:${names[0]}:${names[1]}:${code.length}:${head}:${tail}`;
      const hit = cachedTokens(key);
      if (hit) return hit;
      // One tokenize per key: a block re-rendering while its first highlight
      // is in flight joins that job instead of starting a second identical one.
      const inFlight = waiting.get(key);
      if (inFlight) {
        if (callback) inFlight.add(callback);
        return null;
      }
      waiting.set(key, new Set(callback ? [callback] : []));
      const grammar = supported.has(resolved) ? resolved : "text";
      highlighterFor(grammar, requested)
        .then((highlighter) => {
          const lang = highlighter.getLoadedLanguages().includes(resolved) ? resolved : "text";
          const result = highlighter.codeToTokens(code, {
            lang: lang as BundledLanguage,
            themes: { light: names[0], dark: names[1] },
          });
          cacheTokens(key, result, code.length);
          const listeners = waiting.get(key);
          waiting.delete(key);
          if (listeners) for (const listener of listeners) listener(result);
        })
        .catch((error: unknown) => {
          console.error("[Streamdown Code] Failed to highlight code:", error);
          waiting.delete(key);
        });
      return null;
    },
  };
}

export const code = createBoundedCodePlugin();
