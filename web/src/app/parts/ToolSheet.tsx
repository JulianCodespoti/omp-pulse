"use client";

import { BottomSheet } from "@/app/ui/Sheet";

import { spokenDuration } from "./duration";
import { ImagePart } from "./ImagePart";
import { BashTool } from "./tools/BashTool";
import { FileTool } from "./tools/FileTool";
import { GenericTool } from "./tools/GenericTool";
import { DetailNote } from "./tools/OutputBlock";
import { SearchTool } from "./tools/SearchTool";
import { filePathFromArgs, toolFace, toolKind, type ToolUiPart } from "./tools/describe";

/**
 * A call without a result is only RUNNING while its turn is live; once the
 * turn is over (aborted, killed session, crashed child) no result is coming,
 * and a shimmering "Running" there was the most visible lie in the transcript.
 */
export function callState(part: ToolUiPart, live: boolean, resultUnknown: boolean) {
  const interrupted = part.state === "running" && !live && !resultUnknown;
  const state = part.state === "running" && (interrupted || resultUnknown) ? ("ok" as const) : part.state;
  return { interrupted, state };
}

/** Everything one call did: command, arguments, output or diff, duration, exit. */
export function ToolDetail({ part, sessionPath, live, resultUnknown = false, images = true }: {
  part: ToolUiPart;
  sessionPath?: string | null;
  live: boolean;
  resultUnknown?: boolean;
  /** Off where the caller already shows the call's photos. */
  images?: boolean;
}) {
  const { interrupted, state } = callState(part, live, resultUnknown);
  const took = state !== "running" && !interrupted && part.startedAt !== undefined && part.endedAt !== undefined
    ? spokenDuration(part.endedAt - part.startedAt)
    : null;
  const kind = toolKind(part.name);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="tool-detail">
      {interrupted ? <DetailNote>Stopped before it finished.</DetailNote> : null}
      {resultUnknown && part.state === "running" ? <DetailNote>This transcript has no result for this call.</DetailNote> : null}
      {kind === "bash" ? (
        <BashTool part={part} sessionPath={sessionPath} live={live && !resultUnknown} />
      ) : kind === "file" ? (
        <FileTool part={part} />
      ) : kind === "search" ? (
        <SearchTool part={part} />
      ) : (
        <GenericTool part={part} />
      )}
      {took ? <DetailNote>Took {took}</DetailNote> : null}
      {images ? part.images?.map((image, index) => (
        <ImagePart key={`${part.callId}:${index}`} src={image.src} mimeType={image.mimeType} />
      )) : null}
    </div>
  );
}

/** A tapped call's detail: the one place a tool's output, arguments and diff are read in full. */
export function ToolSheet({ open, onOpenChange, part, live, sessionPath, resultUnknown = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  part: ToolUiPart;
  live: boolean;
  sessionPath?: string | null;
  resultUnknown?: boolean;
}) {
  const { state } = callState(part, live, resultUnknown);
  const face = toolFace(part, state !== part.state);
  const title = `${face.label}${face.target ? ` · ${face.target}` : ""}`;
  const path = toolKind(part.name) === "file" ? filePathFromArgs(part.args) : "";
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title.length > 80 ? `${title.slice(0, 79)}…` : title}
      description={path || undefined}
      testId="tool-sheet"
    >
      <ToolDetail part={part} sessionPath={sessionPath} live={live} resultUnknown={resultUnknown} />
    </BottomSheet>
  );
}
