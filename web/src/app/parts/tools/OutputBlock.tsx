"use client";

import { ChevronDownIcon, WrapTextIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { getAppearance } from "@/platform/appearance";
import { Row, RowGroup } from "@/app/ui/Row";
import { cn } from "@/lib/utils";

import { CopyButton } from "../CopyButton";
import { truncateOnLineBoundary } from "../tool-summary";
import { BashOutputText } from "./BashOutput";
import { bashChunks, parseBashOutput, type BashOutput } from "./bash-output";
import { searchSourceLinks, type SearchSourceLink } from "./search-output";

// 60 000 chars / 500 lines: on a phone a sheet shows ~40 lines at once, so
// this keeps the first paint cheap while `content-visibility:auto` skips
// offscreen chunks after "Show all". Cut on a newline so a clamped diff stays
// syntactically valid and copy-pasteable.
const CHAR_LIMIT = 60000;
const LINE_LIMIT = 500;
const EXPANDED_CHUNK = 8000;

/**
 * True while `ref` overflows horizontally and is not scrolled to its right
 * end, so a clipped long line can fade out and read as scrollable.
 */
function useRightClip(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || !active) {
      setClipped(false);
      return;
    }
    const update = () => setClipped(node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", update);
    };
  }, [ref, active]);
  return clipped;
}

export const SHOW_ALL =
  "relative mt-1 flex min-h-8 items-center self-start text-meta tabular-nums text-primary-text outline-none after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring";

function ExpandedChunks({ output, wrap, links }: { output: BashOutput; wrap: boolean; links: readonly SearchSourceLink[] }) {
  const chunks = useMemo(() => bashChunks(output.text, EXPANDED_CHUNK), [output]);
  const [progress, setProgress] = useState({ output, visible: output.text.length > 32000 ? 1 : chunks.length });
  // A replacement snapshot starts fresh even when it has the same chunk count.
  const visible = progress.output === output ? progress.visible : (output.text.length > 32000 ? 1 : chunks.length);
  useEffect(() => {
    if (visible >= chunks.length) return;
    const frame = requestAnimationFrame(() => setProgress({ output, visible: Math.min(visible + 2, chunks.length) }));
    return () => cancelAnimationFrame(frame);
  }, [chunks.length, output, visible]);
  return (
    <>
      {chunks.slice(0, visible).map((range) => (
        <div key={range.start} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 400px" }}>
          <BashOutputText output={output} {...range} wrap={wrap} links={links} />
        </div>
      ))}
    </>
  );
}

/** A 32px row above a block: state on the left, Wrap and Copy on the right. One per block. */
export function DetailToolbar({ children, wrap, onWrap, copyText, copyLabel, className }: {
  children?: ReactNode;
  wrap?: boolean;
  onWrap?: () => void;
  copyText?: string;
  copyLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-9 min-w-0 items-center gap-2 text-meta text-muted-foreground", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {onWrap ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Wrap lines"
          aria-pressed={wrap}
          onClick={onWrap}
          className={cn("text-muted-foreground", wrap && "bg-surface-3 text-foreground")}
        >
          <WrapTextIcon aria-hidden className="size-4" />
        </Button>
      ) : null}
      {copyText ? <CopyButton text={copyText} label={copyLabel} size="icon-sm" className="-mr-1.5 text-muted-foreground" /> : null}
    </div>
  );
}

/**
 * Command or tool output as ONE mono surface: an optional `$ command` head,
 * then the output, with Wrap/Copy in a single toolbar above it. ANSI colour
 * is kept (never terminal control). Huge output is clamped with "Show all".
 */
export function OutputBlock({
  text,
  command,
  failed = false,
  status,
  copyLabel = "Copy output",
  actions,
  sourceLinks = false,
}: {
  text: string;
  /** Shown as the block's `$` head. */
  command?: string;
  /** The first output line is the error: it takes the danger colour. */
  failed?: boolean;
  /** Left side of the toolbar, e.g. "exit 1". */
  status?: ReactNode;
  copyLabel?: string;
  /** Extra toolbar controls before Wrap (a Stop button). */
  actions?: ReactNode;
  /** Link only the native web-search source/citation URL lines, never Markdown. */
  sourceLinks?: boolean;
}) {
  const [wrap, setWrap] = useState(() => getAppearance().wrapCode);
  const well = useRef<HTMLDivElement>(null);
  const clipped = useRightClip(well, !wrap && !!(text || command));
  const [showAll, setShowAll] = useState(false);
  const output = useMemo(() => parseBashOutput(text), [text]);
  const links = useMemo(() => sourceLinks ? searchSourceLinks(output.text) : [], [sourceLinks, output]);
  // The sheet is the full reader; only a pathological output is clamped, with "Show all".
  const clamped = useMemo(() => truncateOnLineBoundary(output.text, CHAR_LIMIT, LINE_LIMIT), [output]);
  const needsClamp = clamped.length < output.text.length;
  const shownEnd = needsClamp && !showAll ? clamped.length : output.text.length;
  const chunked = showAll && needsClamp && output.text.length > EXPANDED_CHUNK * 2;
  const errorEnd = failed ? (output.text.indexOf("\n") + 1 || output.text.length) : 0;
  const hiddenLines = needsClamp && !showAll ? output.text.slice(clamped.length).split("\n").length - 1 : 0;
  const hasContent = Boolean(text || command);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surface-1",
        failed ? "border-danger/35" : "border-hairline",
      )}
      data-testid="tool-output"
    >
      <DetailToolbar
        wrap={wrap}
        onWrap={hasContent ? () => setWrap((value) => !value) : undefined}
        copyText={text || command}
        copyLabel={text ? copyLabel : "Copy command"}
        className={cn(
          "bg-surface-2 px-3 py-1",
          hasContent && "border-b border-hairline",
        )}
      >
        {status}
        {actions ? <span className="ml-auto flex items-center gap-1">{actions}</span> : null}
      </DetailToolbar>
      {/* Nothing to read (an empty output): the toolbar alone carries the status. */}
      {!hasContent ? null : (
        <div
          ref={well}
          role="region"
          aria-label="Output"
          tabIndex={0}
          className={cn(
            "min-w-0 max-w-full rounded-lg bg-surface-1 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            !wrap && "overflow-x-auto [overscroll-behavior-x:contain]",
            // A line running past the right edge fades out there, so the clip reads as "scroll for more".
            clipped && "[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]",
          )}
        >
          {command ? (
            <pre className={cn("m-0 font-mono text-code text-foreground", wrap ? "whitespace-pre-wrap break-all" : "min-w-max whitespace-pre", text && "mb-2.5 border-b border-hairline pb-2.5")} data-testid="tool-command">
              <span aria-hidden className="select-none text-tertiary">$ </span>
              {command}
            </pre>
          ) : null}
          {!text ? null : chunked ? (
            <ExpandedChunks output={output} wrap={wrap} links={links} />
          ) : failed ? (
            <>
              <BashOutputText output={output} end={Math.min(errorEnd, shownEnd)} wrap={wrap} className="text-danger" links={links} />
              {errorEnd < shownEnd ? <BashOutputText output={output} start={errorEnd} end={shownEnd} wrap={wrap} links={links} /> : null}
            </>
          ) : (
            <BashOutputText output={output} end={shownEnd} wrap={wrap} links={links} />
          )}
        </div>
      )}
      {needsClamp ? (
        <div className="border-t border-hairline bg-surface-1 px-3 py-1">
          <button
            type="button"
            className={cn(SHOW_ALL, "mt-0")}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show less" : `Show all (${hiddenLines > 0 ? `${hiddenLines.toLocaleString()} more ${hiddenLines === 1 ? "line" : "lines"}` : `${(output.text.length - clamped.length).toLocaleString()} more characters`})`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A quiet sentence in a detail view: why something is missing or how it ended. */
export function DetailNote({ children }: { children: ReactNode }) {
  return <p className="py-1 text-meta text-muted-foreground">{children}</p>;
}

function argValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * The call's raw arguments, closed by default: the detail above already says
 * what the call did, so this is the "show me exactly" escape hatch. Each
 * argument is a labelled value, never one JSON dump.
 */
export function ArgsDetails({ args, omit = [] }: { args: unknown; omit?: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const entries = args && typeof args === "object" && !Array.isArray(args)
    ? Object.entries(args as Record<string, unknown>).filter(([key, value]) => !omit.includes(key) && value !== undefined && value !== null && value !== "")
    : [];
  if (entries.length === 0) return null;
  return (
    <div className="min-w-0" data-testid="tool-args">
      <RowGroup inset="sheet">
        <Row
          title="Details"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          trailing={<ChevronDownIcon aria-hidden className={cn("size-4 transition-transform duration-[var(--dur-base)] motion-reduce:transition-none", open && "rotate-180")} />}
        />
        {open ? (
          <dl className="disclosure flex min-w-0 flex-col gap-3 border-t border-hairline px-4 py-3">
            {entries.map(([key, value]) => (
              <div key={key} className="min-w-0">
                <dt className="text-meta text-muted-foreground">{key}</dt>
                <dd className="m-0 whitespace-pre-wrap break-words font-mono text-code text-foreground [overflow-wrap:anywhere]">{argValue(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </RowGroup>
    </div>
  );
}
