"use client";

import { useMemo } from "react";

import { DiffPart, looksLikeDiff } from "../DiffPart";
import { ArgsDetails, DetailNote, OutputBlock } from "./OutputBlock";
import { filePathsForTool, type ToolUiPart } from "./describe";

/** A read, write or edit: the change as a diff when there is one, otherwise what the tool returned. */
export function FileTool({ part }: { part: ToolUiPart }) {
  const output = part.output ?? "";
  const failed = part.state === "error";
  // A failed single edit records nothing; a failed batch keeps each file's own result.
  const edits = part.edits;
  const read = part.name.toLowerCase().split(/[.:/]/).at(-1) === "read";
  // A read's provenance, not its bytes, decides that this is content. Raw
  // reads can contain complete patches or +/- lines without recording edits.
  const outputIsDiff = useMemo(() => !read && !failed && !edits && !!output && looksLikeDiff(output), [read, failed, edits, output]);
  const paths = filePathsForTool(part);
  const path = paths.length === 1 ? paths[0] : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* The row shows a short dir/file label (or the agent's intent); the exact path lives here. */}
      {!edits?.length ? paths.map((file) => (
        <p key={file} className="whitespace-pre-wrap break-words text-meta text-muted-foreground [overflow-wrap:anywhere]" title={file} data-testid="tool-path">{file}</p>
      )) : null}
      {edits?.length ? edits.map((edit, index) => (
        <section key={`${edit.path}:${index}`} className="flex min-w-0 flex-col gap-1" aria-label={edit.path}>
          {edit.sourcePath ? <DetailNote>Moved from {edit.sourcePath}</DetailNote> : null}
          {edit.diff ? (
            <DiffPart
              text={edit.diff}
              path={edit.path}
              added={edit.added}
              removed={edit.removed}
              note={edit.truncated ? "Diff shortened; the counts cover the whole change." : undefined}
            />
          ) : (
            <>
              <p className="whitespace-pre-wrap break-words text-meta text-foreground [overflow-wrap:anywhere]" data-testid="tool-path">{edit.path}</p>
              {edit.error ? <OutputBlock text={edit.error} failed copyLabel="Copy error" /> : <DetailNote>No diff was recorded for this change.</DetailNote>}
            </>
          )}
        </section>
      )) : outputIsDiff ? (
        <DiffPart text={output} path={path || undefined} />
      ) : output ? (
        <OutputBlock text={output} failed={failed} copyLabel={failed ? "Copy error" : "Copy output"} />
      ) : null}
      {part.pruned ? <DetailNote>Output removed from the transcript to save space.</DetailNote> : null}
      <ArgsDetails args={part.args} />
    </div>
  );
}
