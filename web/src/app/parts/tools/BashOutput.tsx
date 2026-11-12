"use client";

import type { ReactNode } from "react";

import { BASH_PALETTE, bashTailStart, type BashOutput, type BashRange } from "./bash-output";
import type { SearchSourceLink } from "./search-output";

/** No terminal actions: fixed palette values, text and explicitly safe source links. */
export function BashOutputText({ output, start = 0, end = output.text.length, wrap = false, className, links = [] }: {
  output: BashOutput;
  wrap?: boolean;
  className?: string;
  links?: readonly SearchSourceLink[];
} & Partial<BashRange>) {
  const text = output.text.slice(start, end);
  let linkIndex = 0;
  return (
    <pre data-bash-output className={`m-0 min-h-[1lh] font-mono text-code ${className ?? "text-foreground"} ${wrap ? "min-w-0 whitespace-pre-wrap break-all" : "min-w-max whitespace-pre"}`}>
      <code>{output.runs.filter(run => run.end > start && run.start < end).map(run => {
        const runEnd = Math.min(end, run.end);
        let cursor = Math.max(start, run.start);
        if (!links.length) return (
          <span key={run.start} data-bash-color={run.foreground ?? undefined}
            style={run.foreground === null ? undefined : { color: BASH_PALETTE[run.foreground] }}>
            {output.text.slice(cursor, runEnd)}
          </span>
        );
        const children: ReactNode[] = [];
        while (linkIndex < links.length && links[linkIndex]!.end <= cursor) linkIndex++;
        while (cursor < runEnd && linkIndex < links.length) {
          const link = links[linkIndex]!;
          if (link.start >= runEnd) break;
          if (link.start > cursor) children.push(output.text.slice(cursor, link.start));
          const linkEnd = Math.min(runEnd, link.end);
          children.push(
            <a key={cursor} href={link.url} target="_blank" rel="noopener noreferrer"
              className="break-all underline decoration-primary/30 underline-offset-2">
              {output.text.slice(Math.max(cursor, link.start), linkEnd)}
            </a>,
          );
          cursor = linkEnd;
          if (cursor >= link.end) linkIndex++;
        }
        children.push(output.text.slice(cursor, runEnd));
        return (
          <span key={run.start} data-bash-color={run.foreground ?? undefined}
            style={run.foreground === null ? undefined : { color: BASH_PALETTE[run.foreground] }}>
            {children}
          </span>
        );
      })}</code>
      {text.endsWith("\n") ? <span aria-hidden className="block h-[1lh]" /> : null}
    </pre>
  );
}

/**
 * The newest lines of a call that is still printing, under its row. Not a
 * box and not a scroll area: four clipped lines whose top edge fades, so the
 * transcript keeps one scroll and the full output lives in the detail sheet.
 * It sits past the row's icon.
 */
export function LiveTail({ output }: { output: BashOutput }) {
  if (!output.text.trim()) return null;
  const start = bashTailStart(output.text.replace(/\n+$/, ""), 4);
  return (
    <div
      data-testid="live-tool-output"
      aria-hidden
      className="ml-6 flex max-h-[4lh] min-w-0 flex-col justify-end overflow-hidden text-code [mask-image:linear-gradient(to_bottom,transparent,black_1lh)]"
    >
      <BashOutputText output={output} start={start} wrap className="text-muted-foreground" />
    </div>
  );
}
