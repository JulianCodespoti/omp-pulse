"use client";

import { useContext, useMemo, useState } from "react";

import type { PluginRenderContext } from "../../domain/plugins";
import { PluginBackButton, PluginCard, ToolCardsSuppressed, usePluginClaims } from "../plugins/PluginCard";
import { usePluginKey } from "../plugins/use-plugin-host";
import { ImagePart } from "./ImagePart";
import { callState, ToolSheet } from "./ToolSheet";
import { LiveTail } from "./tools/BashOutput";
import { ToolRow } from "./tools/ToolRow";
import { parseBashOutput } from "./tools/bash-output";
import { toolFace, toolKind, type ToolUiPart } from "./tools/describe";
import { countLines, firstErrorLine } from "./tool-summary";

/**
 * One call in the transcript: its quiet row, a live tail while a command
 * prints, its photos. Every tool looks the same here; a tap opens the call's
 * whole detail (command, arguments, output, diff, exit, duration) in a sheet,
 * so output never grows the transcript.
 */
export function ToolPart({
  part,
  sessionPath,
  live,
  resultUnknown = false,
  showImages = true,
  routineFailure = false,
  shimmer = true,
}: {
  part: ToolUiPart;
  sessionPath?: string | null;
  /** Whether this call's turn is still in flight. */
  live: boolean;
  /** A passive transcript has no authoritative live/ended state for missing results. */
  resultUnknown?: boolean;
  /** Runs hoist photos once into the chat flow, outside the rows. */
  showImages?: boolean;
  /** A failure the agent went on past (see summarizeRun): shown, but not in danger colour. */
  routineFailure?: boolean;
  /** Off inside a work group, whose live title is the one shimmering voice. */
  shimmer?: boolean;
}) {
  // null until first opened: hundreds of rows must not mount hundreds of sheets.
  const [open, setOpen] = useState<boolean | null>(null);
  const { interrupted, state } = callState(part, live, resultUnknown);
  const face = useMemo(() => toolFace(part, state !== part.state), [part, state]);
  const kind = toolKind(part.name);
  const raw = part.output ?? "";
  // The live tail follows printing commands; parsing the snapshot each frame
  // is bounded by the daemon's output cap.
  const tail = useMemo(
    () => (state === "running" && raw && (kind === "bash" || kind === "generic") ? parseBashOutput(raw) : null),
    [state, raw, kind],
  );
  const lines = useMemo(() => {
    if (kind !== "bash" || state === "running" || !raw.trim()) return 0;
    return countLines(raw.replace(/\n+$/, ""));
  }, [kind, state, raw]);
  const error = useMemo(() => (state === "error" ? firstErrorLine(raw) : ""), [state, raw]);
  // A transcript plugin that claims this tool draws its card under the row. Nothing is
  // retained for an unclaimed call: the claim check is a cheap boolean, the key stays null.
  // Inside a work group the flow card beside the group stands in (PluginFlowCards), so not twice.
  const suppressed = useContext(ToolCardsSuppressed);
  const claimed = usePluginClaims("transcript.tool", suppressed ? null : part.name);
  const [original, setOriginal] = useState(false);
  const pluginContext = useMemo<PluginRenderContext | null>(
    () => claimed
      ? { session: null, call: { id: part.callId, name: part.name, args: part.args, output: raw, state: state === "ok" ? "done" : state, truncated: false } }
      : null,
    [claimed, part.callId, part.name, part.args, raw, state],
  );
  const { views, onAction } = usePluginKey("transcript.tool", claimed ? part.callId : null, pluginContext);
  const entry = claimed ? views[0] : undefined;
  const showCard = entry !== undefined && !original;
  return (
    <div className="flex min-w-0 flex-col" data-testid="tool-part">
      {/* The stock row stays above a plugin's card: a card adds to what the call says it did and
          never replaces it (a lab plugin drew "ls -la (read-only listing)" over a real command). */}
      <ToolRow
        face={face}
        state={state}
        interrupted={interrupted}
        startedAt={part.startedAt}
        meta={lines > 0 ? `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}` : null}
        error={error}
        mono={kind === "bash"}
        onOpen={() => setOpen(true)}
        routineFailure={routineFailure}
        shimmer={shimmer}
      />
      {showCard ? (
        <PluginCard
          pluginName={entry.pluginName}
          view={entry.view}
          onAction={(action, item) => onAction(entry.pluginId, action, item)}
          testId="plugin-tool-card"
          dataAttrs={{ "data-plugin": entry.pluginId, "data-call": part.callId }}
          onShowOriginal={() => setOriginal(true)}
        />
      ) : null}
      {entry && !showCard ? <PluginBackButton pluginName={entry.pluginName} onClick={() => setOriginal(false)} className="self-start" /> : null}
      {tail && !showCard ? <LiveTail output={tail} /> : null}
      {showImages && part.images?.length ? (
        <div className="flex flex-col gap-2 pt-1">
          {part.images.map((image, index) => (
            // Never a raw <img>: daemon blob refs (`blob:sha256:…`) are not
            // browser URLs. ImagePart resolves them through the authenticated fetch.
            <ImagePart key={`${part.callId}:${index}`} src={image.src} mimeType={image.mimeType} />
          ))}
        </div>
      ) : null}
      {open !== null ? (
        <ToolSheet open={open} onOpenChange={setOpen} part={part} live={live} sessionPath={sessionPath} resultUnknown={resultUnknown} />
      ) : null}
    </div>
  );
}
