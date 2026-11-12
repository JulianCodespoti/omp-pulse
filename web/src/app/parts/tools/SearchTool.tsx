"use client";

import { useMemo } from "react";

import { toolSummary } from "../tool-summary";
import { ArgsDetails, DetailNote, OutputBlock } from "./OutputBlock";
import type { ToolUiPart } from "./describe";

/** Legacy results without native counts: only a whole empty-result notice is empty. */
function legacyMatchCount(output: string): number | null {
  const trimmed = output.trim();
  if (!trimmed || /^(?:no matches|no match|no matches found)$/i.test(trimmed)) return 0;
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]")) && !(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return trimmed.split("\n").filter((line) => line.trim().length > 0).length;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const hits = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? (() => {
            const rec = parsed as Record<string, unknown>;
            const list = rec.hits ?? rec.results ?? rec.matches ?? rec.files;
            return Array.isArray(list) ? list : null;
          })()
        : null;
    if (!hits) return null;
    return hits.filter((hit) => typeof hit !== "string" || hit.trim().length > 0).length;
  } catch {
    return trimmed.split("\n").filter((line) => line.trim().length > 0).length;
  }
}

/** Native coverage labels are separate from the unmodified, copyable output. */
export function SearchTool({ part }: { part: ToolUiPart }) {
  const output = part.output ?? "";
  const failed = part.state === "error" || !!part.search?.error;
  const web = part.name.toLowerCase().split(/[.:/]/).at(-1) === "web_search";
  const query = toolSummary(part.name, part.args);
  const settled = !failed && part.state !== "running";
  const count = useMemo(() => !settled ? null : web ? part.search?.sourceCount ?? null
    : part.search?.matchCount ?? legacyMatchCount(output), [settled, web, part.search, output]);
  const empty = !web && count === 0;
  const coverage = part.search;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {failed ? (
        <OutputBlock text={output} failed copyLabel="Copy error" />
      ) : empty ? (
        <>
          <DetailNote>{query ? `No matches for “${query}”.` : "No matches."}</DetailNote>
          {coverage && output.trim() && !/^(?:no matches|no match|no matches found)$/i.test(output.trim())
            ? <OutputBlock text={output} copyLabel="Copy results" /> : null}
        </>
      ) : output ? (
        <OutputBlock
          text={output}
          sourceLinks={web}
          copyLabel="Copy results"
          status={count !== null ? <span className="tabular-nums" data-testid="search-result-summary">{`${count.toLocaleString()} ${web ? (count === 1 ? "source" : "sources") : (count === 1 ? "match" : "matches")}${coverage?.truncated ? " shown" : ""}`}</span> : undefined}
        />
      ) : null}
      {coverage?.truncated ? (
        <DetailNote>
          Results are incomplete; more matches may have been omitted.
          {coverage.perFileLimitReached !== undefined ? ` Match limit reached (${coverage.perFileLimitReached.toLocaleString()}; per-file or total cap).` : ""}
          {coverage.fileLimitReached !== undefined ? ` File limit reached (${coverage.fileLimitReached.toLocaleString()}).` : ""}
          {coverage.linesTruncated ? " Matching lines were shortened." : ""}
          {coverage.outputTruncated ? " Returned output was truncated." : ""}
        </DetailNote>
      ) : null}
      {part.pruned ? <DetailNote>Output removed from the transcript to save space.</DetailNote> : null}
      <ArgsDetails args={part.args} />
    </div>
  );
}
