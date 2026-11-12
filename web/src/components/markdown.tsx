"use client";

import * as React from "react";
import { lazy, memo, Suspense } from "react";

import { CheckIcon, CopyIcon } from "lucide-react";

import { showToast } from "@/app/Notices";
import { cn } from "@/lib/utils";
import { ClipboardAttempt } from "@/platform/clipboard";
import { prefersReducedMotion, useAppearance } from "@/platform/appearance";
import { groupMarkdownBlocks } from "./markdown-blocks";
import { createLiveMarkdownBuffer, type OpenFence } from "./markdown-stream-buffer";
import { PathChip } from "@/app/parts/PathChip";
import { ImagePart } from "@/app/parts/ImagePart";
import { MagicKeywordText, useMagicKeywordSource } from "@/app/parts/MagicKeywordText";
import { isSessionResource, SessionResourceLink } from "@/app/parts/SessionResources";
import type { CodeHighlighterPlugin as CodePlugin } from "@streamdown/code";
import type * as MathModule from "./math-plugin";
import type { Element as HastElement, Root, RootContent } from "hast";

// ── BUNDLE REGRESSION GUARD ──────────────────────────────────────────────
// 2026-08: The eager chat chunk regressed from 786 KB (246 KB gzip) to
// 1 433 KB (452 KB gzip) — +647 KB raw / +206 KB gzip on every phone load.
// Root cause: two eager imports landed back in the chat graph:
//   • streamdown math plugin → rehype-katex  ≈ 590 KB
//   • streamdown mermaid plugin → mermaid     ≈ 187 KB  (+ cytoscape)
//   • motion in Shimmer → motion-dom + framer motion ≈ 439 KB
// All three are now banned from the eager graph. This file is the ONE
// place that may import `streamdown`. Do NOT add `mermaid` or `cjk` here, and
// never import `./math-plugin` statically — syntax a coding transcript almost
// never contains. The code plugin is also dynamic: it loads only when a fenced
// block appears, while Shiki grammars lazy-load per language. The maths plugin
// (KaTeX, ≈ 590 KB) loads only when the text holds `$$`, `\(` or `\[`; a single
// `$` never counts. Any new heavy plugin MUST be dynamically imported behind a
// user interaction or matching content, never eager.
// 2026-08-29: ChatScreen was 1 036.8 KB raw / 310.6 KB gzip because this
// gateway eagerly imported `streamdown` + `@streamdown/code` (which pulls
// `shiki`). The transcript now paints from plain text immediately; the
// heavy layer (Streamdown + Shiki) loads in a separate chunk via
// `React.lazy` + `import()`. Code fences render as monospaced `<pre>`
// instantly and gain colour when the highlighter lands.
// ────────────────────────────────────────────────────────────────────────

function isPathLike(token: string): boolean {
  if (!token.includes("/")) return false;
  if (token.includes("://")) return false;
  if (token === "/" || token === "//" || token === "./" || token === "../")
    return false;
  if (token.startsWith("./") || token.startsWith("../") || token.startsWith("~/"))
    return token.length > 2;
  const withoutLine = token.split(":")[0] ?? token;
  if (/\.[A-Za-z0-9]{1,10}$/.test(withoutLine)) return true;
  // Absolute tokens without an extension are usually API routes (`/charges`,
  // `/api/v1/users`), so only well-known filesystem roots count as paths.
  return /^\/(?:home|Users|tmp|etc|usr|var|opt|mnt|srv|root|private|Volumes)\//.test(withoutLine);
}

function renderTextWithChips(
  text: string,
  onOpenPath?: (path: string) => void,
  sourceStart?: number,
  resourceLinks = true,
): React.ReactNode[] {
  if (!text.includes("/")) return [sourceStart === undefined ? text : <MagicKeywordText key="text" text={text} sourceStart={sourceStart} />];
  const out: React.ReactNode[] = [];
  // Scan each delimiter-separated token once. Requiring a slash in the
  // regex retries a failed slash-ended token at every character (quadratic).
  const re = /[^\s"'`<>|]+/g;
  let lastIdx = 0;
  const inlineCodeRanges = text.includes("`")
    ? [...text.matchAll(/(`+)[\s\S]*?\1/g)].map(match => [match.index, match.index + match[0].length] as const)
    : [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const candidate = match[0];
    const slash = candidate.indexOf("/");
    if (slash < 0 || slash === candidate.length - 1) continue;
    const start = match.index;
    const end = start + candidate.length;
    let core = candidate;
    let punct = "";
    const trail = core.match(/[.,;:!?)\]}'"]+$/);
    if (trail) {
      const tail = trail[0]!;
      const without = core.slice(0, -tail.length);
      if (without.length > 0 && (isPathLike(without) || isSessionResource(without))) {
        core = without;
        punct = tail;
      }
    }
    if (!isPathLike(core) && !isSessionResource(core)) continue;
    if (!resourceLinks && isSessionResource(core)) continue;
    if (isSessionResource(core) && inlineCodeRanges.some(([from, to]) => start >= from && start < to)) continue;
    const before = text.slice(Math.max(0, start - 8), start);
    if (before.includes("://")) continue;
    if (start > lastIdx) out.push(sourceStart === undefined ? text.slice(lastIdx, start) : <MagicKeywordText key={`text-${lastIdx}`} text={text.slice(lastIdx, start)} sourceStart={sourceStart + lastIdx} />);
    out.push(
      isSessionResource(core)
        ? <SessionResourceLink key={`${start}-${core}`} uri={core}>{core}</SessionResourceLink>
        : <PathChip key={`${start}-${core}`} path={core} onOpen={onOpenPath} />,
    );
    if (punct) out.push(punct);
    lastIdx = end;
    if (punct) {
      // candidate included punct, but we already advanced to end which includes it; no extra step needed
    }
  }
  if (lastIdx < text.length) out.push(sourceStart === undefined ? text.slice(lastIdx) : <MagicKeywordText key={`text-${lastIdx}`} text={text.slice(lastIdx)} sourceStart={sourceStart + lastIdx} />);
  if (out.length === 0) return [sourceStart === undefined ? text : <MagicKeywordText key="text" text={text} sourceStart={sourceStart} />];
  return out;
}

function processChildren(
  children: React.ReactNode,
  onOpenPath?: (path: string) => void,
  source?: string,
  sourceStart = 0,
  resourceLinks = true,
): React.ReactNode {
  let cursor = sourceStart;
  return React.Children.map(children, (child) => {
    if (typeof child === "string") {
      const offset = source?.indexOf(child, cursor);
      if (offset !== undefined && offset >= 0) cursor = offset + child.length;
      return renderTextWithChips(child, onOpenPath, offset !== undefined && offset >= 0 ? offset : undefined, resourceLinks);
    }
    if (React.isValidElement(child)) {
      const type = (child as unknown as { type: unknown }).type;
      if (type === "code" || type === "a" || type === "pre") return child;
      const props = (
        child as unknown as {
          props: { children?: React.ReactNode; node?: { tagName?: string; position?: { start?: { offset?: number } } } };
        }
      ).props;
      // Streamdown supplies wrapped components rather than literal <pre>.
      // Cloning their child into an array loses the single code element that
      // its pre wrapper marks as a block, turning nested fences into inline code.
      if (["pre", "code", "a"].includes(props?.node?.tagName ?? "")) return child;
      if (props && props.children) {
        const processed = processChildren(props.children, onOpenPath, source, props.node?.position?.start?.offset ?? cursor, resourceLinks);
        return React.cloneElement(
          child as React.ReactElement<{ children?: React.ReactNode }>,
          undefined,
          processed,
        );
      }
    }
    return child;
  });
}

function chipWrapper(tag: string, onOpenPath?: (path: string) => void, readableTableCell = false) {
  // Annotated as ReactNode rather than inferred: `createElement` narrows to
  // `DOMElement`, which does not satisfy the markdown renderer's `Components`
  // map and fails the build once the component object is passed across the
  // lazy chunk boundary.
  const Comp = (props: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }): React.ReactNode => {
    // `node` is the mdast node the markdown renderer passes to every custom
    // component. It is not a DOM attribute, so spreading it emitted a literal
    // `node="[object Object]"` onto every paragraph, list item and table cell.
    const { children, node: _node, ...rest } = props;
    const source = useMagicKeywordSource();
    const start = (_node as { position?: { start?: { offset?: number } } } | undefined)?.position?.start?.offset;
    const content = processChildren(children, onOpenPath, source, start);
    return React.createElement(
      tag,
      { ...rest, ...(readableTableCell && tag === "th" ? { scope: "col" } : {}) },
      // A cell's max-width does not constrain an auto-layout table reliably.
      // A flow-safe child supplies the bound without changing native cells.
      readableTableCell ? <div className="assistant-table-cell">{content}</div> : content,
    );
  };
  Comp.displayName = `Chip${tag}`;
  return Comp;
}
/**
 * Tab-separated, so a spreadsheet pastes it as cells. Whitespace inside a cell
 * is flattened: a newline or tab there would break the row and column grid.
 */
export function tableToTsv(table: HTMLTableElement): string {
  return Array.from(table.rows, (row) =>
    Array.from(row.cells, (cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()).join("\t"),
  ).join("\n");
}

/** The reply is still arriving: a table copied now would be missing rows. */
const TableStreaming = React.createContext(false);

function TableCopy({ scroller, disabled }: { scroller: React.RefObject<HTMLDivElement | null>; disabled: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const [attempt] = React.useState(() => new ClipboardAttempt());
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => {
    attempt.cancel();
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, [attempt]);
  const copy = async () => {
    // Read the live DOM at the tap: the cells carry chips and formatting that no source text can reproduce.
    const table = scroller.current?.querySelector("table");
    if (!table) return;
    const ok = await attempt.run(tableToTsv(table));
    if (ok === null) return;
    if (!ok) {
      showToast("Couldn’t copy the table. Try again.", "warn");
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    // Same 1.2s check as CopyButton.
    timer.current = window.setTimeout(() => { setCopied(false); timer.current = null; }, 1200);
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void copy()}
      aria-label={copied ? "Copied" : "Copy table"}
      data-testid="table-copy"
      className="press-bounce relative flex h-8 items-center gap-1.5 rounded-md px-2 text-meta outline-none after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
    >
      {copied ? <CheckIcon aria-hidden className="size-4 text-success" /> : <CopyIcon aria-hidden className="size-4" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// A wide table owns its horizontal scroll; min-w-0 throughout the markdown
// chain prevents its intrinsic width from widening the message or page.
// The header strip sits OUTSIDE the scroll region: the region must keep no
// control inside it, and the strip must not scroll away with a wide table.
function TableWrapper(props: {
  children?: React.ReactNode;
  [key: string]: unknown;
}): React.ReactNode {
  const { children, node: _node, ...rest } = props;
  const scroller = React.useRef<HTMLDivElement>(null);
  const streaming = React.useContext(TableStreaming);
  return (
    <div className="my-3 w-full min-w-0 max-w-full">
      <div className="flex h-8 items-center justify-between text-meta text-muted-foreground">
        <span>Table</span>
        <TableCopy scroller={scroller} disabled={streaming} />
      </div>
      <div ref={scroller} role="region" aria-label="Table" tabIndex={0} className="markdown-table-scroll edge-fade-x w-full min-w-0 max-w-full overflow-x-auto [scrollbar-width:thin] touch-auto [overscroll-behavior-x:contain] focus-visible:outline-2 focus-visible:outline-ring">
        <table
          className="w-max min-w-full border-collapse text-ui"
          {...(rest as Record<string, unknown>)}
        >
          {processChildren(children) as React.ReactNode}
        </table>
      </div>
    </div>
  );
}
TableWrapper.displayName = "TableWrapper";
// Wide bash lines need a horizontal scroll cue, and an earlier pass
// added a `pre` component override that wrapped the block in a scroll box with
// a fade. That override REPLACED streamdown's own <pre>, which is where shiki
// attaches highlighting, so every fenced block silently lost its syntax
// colours (verify-markdown counts styled token spans: it went to 0). The
// overflow is handled in the PROSE `[&_pre]` rules instead, which scrolls
// without displacing the renderer. The one `pre` override that remains (in
// the heavy layer) only diverts unified diffs; every other fence goes through
// streamdown's own `pre` behaviour verbatim. Do not wrap it.

// ── Unified diffs in fences ─────────────────────────────────────────────
// A ```diff fence highlighted as code showed git bookkeeping, line numbers
// counting diff text, no add/remove rows and a Download action. Diff fences
// (and unlabelled fences that are unmistakably unified diffs) render as rows
// with the tool DiffPart's tints instead.
const DIFF_LANGUAGE_RE = /^(?:diff|patch|udiff)$/i;
const UNLABELLED_LANGUAGE_RE = /^(?:|text|txt|plain|plaintext)$/i;

function isUnifiedDiff(language: string, code: string): boolean {
  if (DIFF_LANGUAGE_RE.test(language)) return true;
  if (!UNLABELLED_LANGUAGE_RE.test(language)) return false;
  return (
    /^diff --git /m.test(code) ||
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(code) ||
    /^--- \S.*\n\+\+\+ \S/m.test(code)
  );
}

// Git bookkeeping a reader never needs; the file row carries the path.
const DIFF_NOISE_RE =
  /^(?:diff --git |index [0-9a-f]+\.\.|(?:old|new|deleted file|new file) mode |(?:dis)?similarity index )/;

type DiffRowKind = "file" | "hunk" | "add" | "del" | "context" | "meta";
interface DiffRow {
  kind: DiffRowKind;
  text: string;
}

function diffHeaderPath(header: string): string {
  const path = header.slice(4).split("\t")[0].trim();
  return path === "/dev/null" ? "" : path.replace(/^[ab]\//, "");
}

function parseUnifiedDiff(code: string): DiffRow[] {
  const lines = code.replace(/\n$/, "").split("\n");
  const rows: DiffRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (DIFF_NOISE_RE.test(line)) continue;
    // `---` alone can be a removed `-- comment` line; a file header is always
    // a `---`/`+++` pair. Deleted files name their path on the `---` side.
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      rows.push({ kind: "file", text: diffHeaderPath(lines[i + 1]) || diffHeaderPath(line) });
      i++;
    } else if (line.startsWith("@@")) rows.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "context", text: line.slice(1) });
    // Editors strip the lone space of an empty context line.
    else if (line === "") rows.push({ kind: "context", text: "" });
    else rows.push({ kind: "meta", text: line });
  }
  return rows;
}

// Same tokens as parts/DiffPart.tsx so chat and tool diffs read alike. Every
// row carries a 2px start border so the tinted rows' accent keeps text aligned.
const DIFF_ROW_CLASS: Record<DiffRowKind, string> = {
  file: "border-l-2 border-l-transparent font-medium text-muted-foreground",
  hunk: "border-l-2 border-l-transparent bg-surface-2 text-muted-foreground",
  add: "border-l-2 border-l-success/60 bg-success/[0.08] text-foreground",
  del: "border-l-2 border-l-danger/50 bg-danger/[0.07] text-foreground",
  context: "border-l-2 border-l-transparent text-foreground",
  meta: "border-l-2 border-l-transparent text-muted-foreground",
};
const DIFF_GUTTER: Record<DiffRowKind, string> = { file: " ", hunk: " ", add: "+", del: "−", context: " ", meta: " " };
const DIFF_GUTTER_CLASS: Partial<Record<DiffRowKind, string>> = {
  add: "font-medium text-success",
  del: "font-medium text-danger-text",
};

function renderDiffRows(rows: DiffRow[]): React.ReactNode[] {
  return rows.map((row, idx) => (
    <span
      key={idx}
      data-diff-row={row.kind}
      className={cn("flex", DIFF_ROW_CLASS[row.kind], row.kind === "file" && idx > 0 && "mt-2")}
    >
      <span className={cn("w-6 shrink-0 select-none text-center", DIFF_GUTTER_CLASS[row.kind] ?? "text-muted-foreground")}>
        {DIFF_GUTTER[row.kind]}
      </span>
      <span className="flex-1 pr-3">{row.text}</span>
    </span>
  ));
}

// Long URLs rendered as tall stacked buttons (153px) breaking rhythm.
// Keep them as inline <a> with break-all so they flow with the sentence.
// Every link that leaves the app opens in its own browsing context: a plain
// <a href> in the PWA or a browser tab replaced the whole chat, and the way
// back lost the scroll position. Same-document fragments stay in place.
function LinkWrapper(props: {
  children?: React.ReactNode;
  href?: string;
  [key: string]: unknown;
}): React.ReactNode {
  const { children, node: _node, href, ...rest } = props;
  const source = useMagicKeywordSource();
  const start = (_node as { position?: { start?: { offset?: number } } } | undefined)?.position?.start?.offset;
  if (href && isSessionResource(href)) {
    return <SessionResourceLink uri={href}>{children}</SessionResourceLink>;
  }
  const external = !!href && !href.startsWith("#");
  return (
    <a
      href={href}
      className="break-all underline decoration-primary/30 underline-offset-2"
      {...(rest as Record<string, unknown>)}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {processChildren(children, undefined, source, start, false) as React.ReactNode}
    </a>
  );
}
LinkWrapper.displayName = "LinkWrapper";
// Assistant/tool text can carry `blob:sha256:…` image refs. Without an img
// override those hit the browser as literal URLs and fail as "Not allowed to
// load local resource" console/network errors. Route them through the same
// authenticated daemon blob fetch protocol image parts use. Every image goes
// through ImagePart so markdown images open in the same zoomable viewer.
function MarkdownImage(props: {
  src?: string;
  alt?: string;
  node?: unknown;
  [key: string]: unknown;
}): React.ReactNode {
  const { src, alt } = props;
  if (typeof src !== "string" || src === "") return null;
  return <ImagePart src={src} alt={alt} mimeType="" />;
}
MarkdownImage.displayName = "MarkdownImage";
function makePathChipComponents(onOpenPath?: (path: string) => void, readableTables = false) {
  return {
    p: chipWrapper("p", onOpenPath),
    li: chipWrapper("li", onOpenPath),
    td: chipWrapper("td", onOpenPath, readableTables),
    th: chipWrapper("th", onOpenPath, readableTables),
    blockquote: chipWrapper("blockquote", onOpenPath),
    h1: chipWrapper("h1", onOpenPath),
    h2: chipWrapper("h2", onOpenPath),
    h3: chipWrapper("h3", onOpenPath),
    h4: chipWrapper("h4", onOpenPath),
    table: TableWrapper,
    a: LinkWrapper,
    img: MarkdownImage,
  };
}
// Inline code and in-prose paths share one look: text-code on surface-2,
// radius 6 (PathChip matches it). Inline tokens may wrap at any character;
// fenced code keeps whitespace and horizontal scroll. Keeping these resets
// separate avoids breaking Shiki.
const inlineCodeFix =
  "[&_code]:!rounded-sm [&_code]:!border-0 [&_code]:!bg-surface-2 [&_code]:!px-1 [&_code]:!py-0.5 [&_code]:!font-mono [&_code]:!text-code [&_code]:!font-normal [&_code]:!text-inherit [&_code]:!box-decoration-clone [&_code]:!whitespace-pre-wrap [&_code]:![overflow-wrap:anywhere] [&_pre_code]:!bg-transparent [&_pre_code]:!border-0 [&_pre_code]:!p-0 [&_pre_code]:!text-code [&_pre_code]:!whitespace-pre [&_pre_code]:![overflow-wrap:normal]";
// ```diff fences: the highlighter colours the signs; whole-line tints make a
// change readable at a glance. `data-diff` is set by the patch in MarkdownInner.
const diffFenceTint =
  "[&_[data-diff=add]]:bg-success/15 [&_[data-diff=del]]:bg-danger/10";
// Code blocks offer Copy only: a Download of a snippet is a desktop habit and
// a second 44px target in a 32px header. Streamdown's own table controls stay
// off for the same reason; TableWrapper draws its own slim header with Copy.
const CONTROLS = { code: { copy: true, download: false }, table: false } as const;
// ── Plain-text fallback ─────────────────────────────────────────────────
// Paints immediately — no markdown parse, no shiki. Code fences show as
// monospaced `<pre>` so the layout is stable; the heavy layer replaces this
// once `streamdown` + `@streamdown/code` land.
// INVARIANT: the same box as Streamdown's settled code block: same container,
// header row (language label, Copy), body height cap, line-number gutter and
// row height, so the swap to the highlighted block changes colours only. While
// a fence was still open this was a bare bordered <pre>; when it closed it
// grew a header and extra top padding, and every line below it jumped. The
// markup and classes mirror streamdown's CodeBlock (node_modules/streamdown),
// so the shared code-block CSS in styles.css applies to both alike. Also the
// live open-fence block: it must not flip between plain and highlighted on
// every frame.
const FENCE_LANGUAGE_RE = /^\S+/;
function fenceLanguage(info: string): string {
  return FENCE_LANGUAGE_RE.exec(info.trim())?.[0] ?? "";
}

const PLAIN_LINE_CLASS =
  "block before:content-[counter(line)] before:inline-block before:[counter-increment:line] before:w-6 before:mr-4 before:text-[13px] before:text-right before:text-muted-foreground/50 before:font-mono before:select-none";

// One row per source line, memoised: a streaming fence re-renders only its
// growing last row, not every row above it.
const PlainCodeLine = React.memo(function PlainCodeLine({ text }: { text: string }) {
  return <span className={PLAIN_LINE_CLASS}>{text === "" ? "\n" : text}</span>;
});

function PlainCodeCopy({ code, disabled }: { code: string; disabled: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const [attempt] = React.useState(() => new ClipboardAttempt());
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => {
    attempt.cancel();
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, [attempt]);
  const copy = async () => {
    const ok = await attempt.run(code);
    if (ok === null) return;
    if (!ok) {
      showToast("Couldn’t copy the code. Try again.", "warn");
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    // Same 1.2s check as TableCopy.
    timer.current = window.setTimeout(() => { setCopied(false); timer.current = null; }, 1200);
  };
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void copy()}
        aria-label="Copy Code"
        title="Copy Code"
        data-streamdown="code-block-copy-button"
        className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {copied ? <CheckIcon aria-hidden size={14} /> : <CopyIcon aria-hidden size={14} />}
      </button>
      {copied && <output aria-live="polite" className="sr-only">Copied</output>}
    </>
  );
}

/** `live`: the fence is still open, so Copy waits (it would copy a partial block). */
function PlainCodeBlock({ code, language, live = false }: { code: string; language: string; live?: boolean }) {
  const lines = React.useMemo(() => code.replace(/\n+$/, "").split("\n"), [code]);
  const body = React.useRef<HTMLDivElement>(null);
  const following = React.useRef(true);
  // The body is height-capped like the settled block, so a growing fence
  // scrolls inside it. Follow the tail until the reader scrolls up.
  React.useLayoutEffect(() => {
    const el = body.current;
    if (live && el && following.current) el.scrollTop = el.scrollHeight;
  }, [code, live]);
  return (
    <div
      dir="ltr"
      className="my-4 flex w-full flex-col gap-2 rounded-xl border border-border bg-sidebar p-2"
      data-language={language}
      data-streamdown="code-block"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
    >
      <div className="flex h-8 items-center text-muted-foreground text-xs" data-language={language} data-streamdown="code-block-header">
        <span className="ml-1 font-mono lowercase">{language}</span>
      </div>
      <div className="pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end">
        <div
          className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur"
          data-streamdown="code-block-actions"
        >
          <PlainCodeCopy code={code} disabled={live} />
        </div>
      </div>
      <div
        ref={body}
        onScroll={(event) => {
          const el = event.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
        className="overflow-y-auto overflow-x-auto rounded-md border border-border bg-background p-4 text-sm"
        data-language={language}
        data-streamdown="code-block-body"
        style={{ maxHeight: 400 }}
      >
        <pre className="bg-[var(--sdm-bg,inherit)] dark:bg-[var(--shiki-dark-bg,var(--sdm-bg,inherit))]" style={{ "--sdm-bg": "transparent", "--sdm-fg": "inherit" } as React.CSSProperties}>
          <code className="[counter-increment:line_0] [counter-reset:line]">
            {lines.map((text, idx) => <PlainCodeLine key={idx} text={text} />)}
          </code>
        </pre>
      </div>
    </div>
  );
}

function PlainFallback({
  children,
  className,
  onOpenPath,
  fence,
}: {
  children: string;
  className?: string;
  onOpenPath?: (path: string) => void;
  fence?: OpenFence | null;
}) {
  const keywordSource = useMagicKeywordSource();
  const source = keywordSource ?? children;
  let sourceCursor = Math.max(0, source.indexOf(children));
  const fenceRe = /(```[\s\S]*?```)/g;
  const parts = children.split(fenceRe);
  return (
    <div className={className}>
      {parts.map((part, idx) => {
        const partStart = source.indexOf(part, sourceCursor);
        sourceCursor = Math.max(sourceCursor, partStart + part.length);
        let lineCursor = partStart;
        if (part.startsWith("```")) {
          const inner = part.slice(3, -3);
          const nl = inner.indexOf("\n");
          return (
            <PlainCodeBlock
              key={idx}
              code={nl !== -1 ? inner.slice(nl + 1) : inner}
              language={nl !== -1 ? fenceLanguage(inner.slice(0, nl)) : ""}
            />
          );
        }
        if (!part.trim()) return null;
        // Keep the prose rhythm without a markdown parser.
        return part.split(/\n{2,}/).map((para, j) => {
          if (!para.trim()) return null;
          const lines = para.split("\n");
          return (
            <p key={`${idx}-${j}`} className="my-3">
              {lines.map((line, k) => {
                const offset = source.indexOf(line, Math.max(0, lineCursor));
                lineCursor = offset + line.length;
                return <React.Fragment key={k}>
                  {k > 0 && <br />}
                  {renderTextWithChips(line, onOpenPath, keywordSource !== undefined && offset >= 0 ? offset : undefined).map((node, n) => (
                    <React.Fragment key={n}>{node}</React.Fragment>
                  ))}
                </React.Fragment>;
              })}
            </p>
          );
        });
      })}
      {fence ? <PlainCodeBlock code={fence.code} language={fenceLanguage(fence.info)} live /> : null}
    </div>
  );
}

// ── Heavy layer (lazy) ──────────────────────────────────────────────────
// Streamdown loads after the plain fallback paints unless `preloadMarkdown`
// already loaded it. Its code plugin is a
// separate request, started only for fenced markdown; prose never pays for it.
// The plugin is the local token-cache-bounded equivalent of `@streamdown/code`.

// Import hint, not a Markdown parser: nested list/quote fences need Shiki too.
const FENCED_CODE_RE = /`{3,}|~{3,}/;

let cachedCodePlugin: CodePlugin | null = null;
let codePluginPromise: Promise<CodePlugin> | null = null;

function loadCodePlugin() {
  if (!codePluginPromise) {
    codePluginPromise = import("./code-plugin").then(({ code }) => {
      cachedCodePlugin = code;
      return code;
    });
  }
  return codePluginPromise;
}

// Hint, not a parser: only `$$` and the LaTeX bracket forms are maths. A lone
// `$` is a shell variable or a price far more often than a formula, and must
// never load or trigger the maths plugin.
const MATH_HINT_RE = /\$\$|\\[([]/;

type MathSupport = typeof MathModule;
let cachedMathPlugin: MathSupport | null = null;
let mathPluginPromise: Promise<MathSupport> | null = null;

function loadMathPlugin() {
  if (!mathPluginPromise) {
    mathPluginPromise = import("./math-plugin").then((plugin) => {
      cachedMathPlugin = plugin;
      return plugin;
    });
  }
  return mathPluginPromise;
}

// One load for the heavy layer, shared by the lazy boundary and by
// `preloadMarkdown` (the sessions list warms it with the chat chunk, so the
// first chat opened pays neither the ~440 KB fetch/compile nor a plain-text
// paint followed by a full rich re-render). A failed preload is forgotten, so
// the lazy boundary's own first load retries instead of inheriting it.
let heavyLoad: Promise<{ default: React.ComponentType<HeavyProps> }> | null = null;
/** Set once the layer has loaded; mounts after that render it synchronously. */
let loadedHeavy: React.ComponentType<HeavyProps> | null = null;

function loadHeavyMarkdown() {
  heavyLoad ??= buildHeavyMarkdown().then(
    (module) => {
      loadedHeavy = module.default;
      return module;
    },
    (error: unknown) => {
      heavyLoad = null;
      throw error;
    },
  );
  return heavyLoad;
}

/** Fetch and evaluate the rich markdown layer ahead of the first chat. */
export function preloadMarkdown(): void {
  loadHeavyMarkdown().catch(() => {});
}

/**
 * Resolves once the rich markdown layer is usable (or has failed to load: the
 * plain fallback is then what the reader gets). The chat's opening reveal
 * waits on this so replies never paint as plain text and swap to rich text in
 * front of the reader.
 */
export function markdownReady(): Promise<void> {
  return loadHeavyMarkdown().then(() => undefined, () => undefined);
}

const HeavyStreamdown = lazy(loadHeavyMarkdown);

interface HeavyProps {
  children: string;
  className?: string;
  codePlugin: CodePlugin | null;
  hasFencedCode: boolean;
  mathPlugin: MathSupport | null;
  hasMath: boolean;
  isAnimating?: boolean;
  progressive?: boolean;
  eager?: boolean;
  readableTables?: boolean;
  onOpenPath?: (path: string) => void;
  /** Unterminated live fence, shown plain until it closes or the reply settles. */
  fence: OpenFence | null;
}

/**
 * DeepSeek's reply animation (StreamingTextFadeRange): everything that arrived
 * together fades in together, 300ms on cubic-bezier(0,0,0.2,1), no per-word
 * cascade. stagger 0 makes Streamdown's timeline take() return a zero step and
 * zero baseDelay, so the 320ms maxBacklog cap never adds delays. Module-level
 * so Streamdown's memo comparison sees one stable object.
 */
const FADE_IN = { animation: "fadeIn", duration: 300, stagger: 0, easing: "cubic-bezier(0,0,0.2,1)", sep: "word" } as const;

async function buildHeavyMarkdown() {
  const { Streamdown, Block, CodeBlockContainer, CodeBlockCopyButton, parseMarkdownIntoBlocks, defaultRehypePlugins } =
    await import("streamdown");
  const parseGroups = (text: string) => groupMarkdownBlocks(text, parseMarkdownIntoBlocks);
  // Streamdown's sanitize schema only admits http(s) image sources, so an
  // agent's `![shot](blob:sha256:…)` reached the page as "[Image blocked]".
  // Those refs never load directly: MarkdownImage routes them through the
  // authenticated daemon blob fetch. Admit only that protocol for `src`.
  const sanitizeEntry = defaultRehypePlugins?.sanitize as [unknown, { protocols?: Record<string, string[]> }] | undefined;
  // No `defaultRehypePlugins.raw`: raw HTML in a reply shows as literal text,
  // as it does in the omp TUI. With `rehype-raw` absent from this list,
  // streamdown itself turns mdast `html` nodes into text. rehype-raw +
  // sanitize used to silently STRIP unknown tags (`<Button>` written outside
  // backticks vanished from prose), and it pulled parse5 + entities (~150 KB
  // of the markdown chunk; vite.config.ts stubs the module) plus ~15% of the
  // per-message parse cost onto every chat open.
  const hardenEntry = defaultRehypePlugins?.harden as [(options: unknown) => (tree: Root) => void, unknown];
  function hardenWebResources() {
    const harden = hardenEntry[0](hardenEntry[1]);
    return (tree: Root) => {
      const internalLinks: HastElement[] = [];
      const protect = (node: Root | RootContent | null | undefined) => {
        if (!node) return;
        if (node.type === "element" && node.tagName === "a"
          && typeof node.properties.href === "string" && isSessionResource(node.properties.href)) {
          // Native selectors use colons in the authority (artifact://0:2-3).
          // WHATWG URL rejects them as invalid ports. These sanitized links
          // never navigate: keep their URI bytes for our in-app reader.
          node.tagName = "span";
          internalLinks.push(node);
        }
        if ("children" in node) node.children.forEach(protect);
      };
      protect(tree);
      try {
        // Still harden every ordinary anchor and every image, including any
        // descendants inside the temporarily protected resource anchors.
        harden(tree);
      } finally {
        for (const link of internalLinks) link.tagName = "a";
      }
    };
  }
  const rehypePlugins = sanitizeEntry
    ? ([
        [sanitizeEntry[0], { ...sanitizeEntry[1], protocols: {
          ...sanitizeEntry[1].protocols,
          src: [...(sanitizeEntry[1].protocols?.src ?? []), "blob"],
          // Only our non-navigating link renderer consumes these protocols.
          href: [...(sanitizeEntry[1].protocols?.href ?? []), "local", "artifact"],
        } }],
        hardenWebResources,
      ] as React.ComponentProps<typeof Streamdown>["rehypePlugins"])
    : undefined;
  type Reveal = (index: number, show: () => void) => () => void;
  const RevealContext = React.createContext<Reveal | null>(null);

  // Streamdown's code-block shell, header and actions markup (so the shared
  // code-block CSS and the 44px action sizing apply), with diff rows for a
  // body: no line numbers, no Download, Copy keeps the original patch text.
  function DiffCodeBlock({ code }: { code: string }) {
    const rows = React.useMemo(() => parseUnifiedDiff(code), [code]);
    // One file: its path is the header. Several: each gets a muted file row.
    const single = rows[0]?.kind === "file" && rows.every((row, idx) => idx === 0 || row.kind !== "file");
    const label = single ? rows[0].text : "diff";
    return (
      <CodeBlockContainer dir="ltr" language="diff">
        <div
          className="flex h-8 min-w-0 items-center pr-14 text-muted-foreground text-xs"
          data-language="diff"
          data-streamdown="code-block-header"
        >
          <span className="ml-1 min-w-0 truncate font-mono" title={single ? label : undefined}>{label}</span>
        </div>
        <div className="pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end">
          <div
            className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur"
            data-streamdown="code-block-actions"
          >
            <CodeBlockCopyButton code={code} />
          </div>
        </div>
        <div
          className="overflow-x-auto rounded-md border border-border bg-background p-4 text-sm"
          data-language="diff"
          data-streamdown="code-block-body"
        >
          <pre>
            <code className="block w-max min-w-full">{renderDiffRows(single ? rows.slice(1) : rows)}</code>
          </pre>
        </div>
      </CodeBlockContainer>
    );
  }

  // Streamdown's default `pre` only marks its code child as a block. Keep
  // exactly that for every fence except unified diffs (see the wide-line note above).
  function MarkdownPre({ children }: { children?: React.ReactNode; node?: unknown }) {
    if (!React.isValidElement<{ className?: unknown; children?: unknown }>(children)) return children;
    const { className, children: code } = children.props;
    const language = typeof className === "string" ? (/language-(\S+)/.exec(className)?.[1] ?? "") : "";
    if (typeof code === "string" && isUnifiedDiff(language, code)) return <DiffCodeBlock code={code} />;
    return React.cloneElement(children as React.ReactElement<Record<string, unknown>>, { "data-block": "true" });
  }

  function ProgressiveBlock(props: React.ComponentProps<typeof Block>) {
    const schedule = React.useContext(RevealContext);
    const [visible, setVisible] = React.useState(() => props.index === 0);
    React.useEffect(() => {
      // Once shown (including during streaming), never hide a block merely
      // because the reply settled and progressive mounting became enabled.
      if (!schedule) {
        setVisible(true);
        return;
      }
      if (visible) return;
      return schedule(props.index, () => setVisible(true));
    }, [schedule, visible, props.index]);
    if (schedule && !visible) return null;
    return (
      <div style={{ contentVisibility: "auto", containIntrinsicSize: "auto 400px" }}>
        <Block {...props} />
      </div>
    );
  }

  function useBlockReveal() {
    const pending = React.useRef(new Map<number, () => void>());
    const frame = React.useRef<number | null>(null);
    React.useEffect(() => () => {
      pending.current.clear();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    }, []);
    return React.useCallback<Reveal>((index, show) => {
      const queue = pending.current;
      queue.set(index, show);
      const tick = () => {
        frame.current = null;
        // An indivisible parser block can exceed the soft 8k target. Never
        // split its source merely to meet a per-frame character budget.
        for (const key of [...queue.keys()].sort((a, b) => a - b).slice(0, 2)) {
          const reveal = queue.get(key);
          queue.delete(key);
          reveal?.();
        }
        if (queue.size) frame.current = requestAnimationFrame(tick);
      };
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
      return () => {
        if (queue.get(index) === show) queue.delete(index);
        if (!queue.size && frame.current !== null) {
          cancelAnimationFrame(frame.current);
          frame.current = null;
        }
      };
    }, []);
  }
  function Heavy({
    children,
    className,
    codePlugin,
    hasFencedCode,
    mathPlugin,
    hasMath,
    isAnimating,
    progressive,
    eager,
    readableTables,
    onOpenPath,
    fence,
  }: HeavyProps) {
    const schedule = useBlockReveal();
    const { streaming } = useAppearance();
    // Visual only: `isAnimating` itself also drives the live buffer and parser repair.
    const animated = isAnimating && streaming === "fade" && !prefersReducedMotion() ? FADE_IN : undefined;
    // New components object per handler identity only: the transcript passes
    // one stable callback, so this memoizes to a constant in practice.
    const components = React.useMemo(
      () =>
        ({ ...makePathChipComponents(onOpenPath, readableTables), pre: MarkdownPre }) as React.ComponentProps<
          typeof Streamdown
        >["components"],
      [onOpenPath, readableTables],
    );
    // `$$…$$` stays visible as source until the maths plugin has loaded.
    const source = React.useMemo(
      () => (hasMath && mathPlugin ? mathPlugin.prepareMathSource(children) : children),
      [hasMath, mathPlugin, children],
    );
    const pluginOptions = React.useMemo(() => {
      const code = hasFencedCode ? codePlugin : null;
      const math = hasMath ? mathPlugin : null;
      return code || math ? { ...(code ? { code } : {}), ...(math ? { math: math.math } : {}) } : undefined;
    }, [hasFencedCode, codePlugin, hasMath, mathPlugin]);
    // Keep fenced code in the plain renderer until its syntax plugin arrives;
    // streaming responses can reveal an opening fence after prose has rendered.
    if (hasFencedCode && !codePlugin) {
      return (
        <PlainFallback className={className} onOpenPath={onOpenPath} fence={fence}>
          {children}
        </PlainFallback>
      );
    }
    return (
      <TableStreaming.Provider value={!!isAnimating}>
        <RevealContext.Provider
          // Eager presentation changes scheduling only. Flipping parser/key mode
          // here would remount visible code and lose focus/Copy state on replay.
          value={progressive && children.length > 32000 && !isAnimating && !eager ? schedule : null}
        >
          <Streamdown
            // Streamdown 2.6's memo comparison omits the parser/BlockComponent
            // props. Changing modes must invalidate it even for identical text.
            key={progressive ? "progressive" : "default"}
            BlockComponent={progressive ? ProgressiveBlock : undefined}
            parseMarkdownIntoBlocksFn={progressive ? parseGroups : undefined}
            // Settled fences must parse exactly: incomplete-text repair can add
            // stray delimiters after valid four-backtick examples. Keep the
            // renderer's existing inline-repair behavior while text is streaming.
            parseIncompleteMarkdown={hasFencedCode && !isAnimating ? false : undefined}
            className={className}
            components={components}
            rehypePlugins={rehypePlugins}
            isAnimating={isAnimating}
            animated={animated}
            caret={isAnimating && streaming === "caret" ? "block" : undefined}
            controls={CONTROLS}
            plugins={pluginOptions}
          >
            {source}
          </Streamdown>
        </RevealContext.Provider>
        {fence ? <PlainCodeBlock code={fence.code} language={fenceLanguage(fence.info)} live /> : null}
      </TableStreaming.Provider>
    );
  }
  return { default: Heavy };
}

// Suspense handles pending imports, not rejected chunks or render errors.
// Keep failure local to one rich block so the surrounding chat stays usable.
class MarkdownBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function MarkdownInner({
  children,
  className,
  isAnimating,
  progressive,
  eager,
  readableTables,
  onOpenPath,
}: {
  children: string;
  className?: string;
  isAnimating?: boolean;
  progressive?: boolean;
  /** Bypass reveal scheduling while preserving parser and block identity. */
  eager?: boolean;
  readableTables?: boolean;
  onOpenPath?: (path: string) => void;
}) {
  // `md-body` is a styling hook, not decoration: streamdown renders its own
  // code-block Copy control at 24px, under the 44px touch floor, and it is not
  // reachable through props. styles.css sizes it through this class. See the
  // rule next to `.md-body`.
  const proseFix = cn(
    "md-body min-w-0 max-w-full [&_pre]:max-w-full",
    inlineCodeFix,
    diffFenceTint,
    readableTables && "assistant-table-reader",
    className,
  );
  const hasFencedCode = FENCED_CODE_RE.test(children);
  const [codePlugin, setCodePlugin] = React.useState<CodePlugin | null>(
    () => cachedCodePlugin,
  );
  React.useEffect(() => {
    if (!hasFencedCode || codePlugin) return;
    let cancelled = false;
    void loadCodePlugin()
      .then((plugin) => {
        if (!cancelled) setCodePlugin(plugin);
      })
      .catch((error: unknown) => {
        console.error("Failed to load fenced-code markdown plugin:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [hasFencedCode, codePlugin]);
  const hasMath = MATH_HINT_RE.test(children);
  const [mathPlugin, setMathPlugin] = React.useState<MathSupport | null>(
    () => cachedMathPlugin,
  );
  React.useEffect(() => {
    if (!hasMath || mathPlugin) return;
    let cancelled = false;
    void loadMathPlugin()
      .then((plugin) => {
        if (!cancelled) setMathPlugin(plugin);
      })
      .catch((error: unknown) => {
        console.error("Failed to load maths markdown plugin:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [hasMath, mathPlugin]);
  const rootRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const patchButton = (btn: Element) => {
      // A11Y-03: streamdown's code buttons carry title but no aria-label
      const t = btn.getAttribute("title");
      if (t && !btn.hasAttribute("aria-label")) btn.setAttribute("aria-label", t);
    };
    // Only ```diff fences are tinted, by their own unified-diff signs; the
    // `+++`/`---` file lines are headers, not changes.
    const DIFF_LINE = '[data-streamdown="code-block"][data-language="diff"] pre > code > span';
    const patchLine = (line: Element) => {
      const text = line.textContent ?? "";
      const kind = text.startsWith("+") && !text.startsWith("+++") ? "add"
        : text.startsWith("-") && !text.startsWith("---") ? "del" : null;
      if (kind === null) line.removeAttribute("data-diff");
      else if (line.getAttribute("data-diff") !== kind) line.setAttribute("data-diff", kind);
    };
    const patchScope = (scope: Element) => {
      if (scope.matches(DIFF_LINE)) patchLine(scope);
      scope.querySelectorAll(DIFF_LINE).forEach(patchLine);
    };
    const patch = (scope: Element) => {
      if (scope.tagName === "BUTTON") patchButton(scope);
      scope.querySelectorAll("button").forEach(patchButton);
      patchScope(scope);
    };
    patch(root);
    // HeavyStreamdown loads async; buttons appear after patch. Observe.
    // Mount-once on purpose: the observer already sees every later change.
    // Keyed on `children` it tore down and rebuilt the observer, and re-ran
    // two document queries, on every streamed frame of a live reply.
    // Only the added subtrees (and title/aria-label edits) are patched: two
    // whole-root queries per mutation batch grew with the reply's length on
    // every streamed frame, in every mounted reply.
    const obs = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          const target = record.target as Element;
          if (target.tagName === "BUTTON") patchButton(target);
          continue;
        }
        record.addedNodes.forEach((node) => {
          if (node.nodeType === 1) patch(node as Element);
        });
      }
    });
    obs.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["title", "aria-label"],
    });
    return () => obs.disconnect();
  }, []);
  // Live text is presented through the stream buffer: unfinished tables and
  // dangling markers are withheld, an open fence becomes one plain block.
  // Settled text (isAnimating false) always renders in full.
  const liveBuffer = React.useMemo(createLiveMarkdownBuffer, []);
  const view = liveBuffer(children, !!isAnimating);
  // Fixed per mount: swapping the lazy wrapper for the loaded component on a
  // later render would remount the rendered reply and lose its local state.
  const [RichMarkdown] = React.useState(() => loadedHeavy ?? HeavyStreamdown);
  const fallback = (
    <PlainFallback className={proseFix} onOpenPath={onOpenPath} fence={view.fence}>
      {view.text}
    </PlainFallback>
  );
  return (
    <div ref={rootRef} className={proseFix}>
      <MarkdownBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <RichMarkdown
            className={proseFix}
            codePlugin={codePlugin}
            hasFencedCode={hasFencedCode}
            mathPlugin={mathPlugin}
            hasMath={hasMath}
            isAnimating={isAnimating}
            progressive={progressive}
            eager={eager}
            readableTables={readableTables}
            onOpenPath={onOpenPath}
            fence={view.fence}
          >
            {view.text}
          </RichMarkdown>
        </Suspense>
      </MarkdownBoundary>
    </div>
  );
}

export const Markdown = memo(
  MarkdownInner,
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.isAnimating === nextProps.isAnimating &&
    prevProps.progressive === nextProps.progressive &&
    prevProps.eager === nextProps.eager &&
    prevProps.readableTables === nextProps.readableTables &&
    prevProps.onOpenPath === nextProps.onOpenPath,
);
