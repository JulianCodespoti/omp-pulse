"use client";

import { memo, useMemo, useState } from "react";
import type { JSX } from "react";

import type { UiMessage } from "@/domain/messages";

import type { PluginRenderContext } from "../../domain/plugins";
import { callState, ToolSheet } from "../parts/ToolSheet";
import { ToolRow } from "../parts/tools/ToolRow";
import { toolFace, toolKind, type ToolUiPart } from "../parts/tools/describe";
import { PluginCard, usePluginClaims, usePluginDeclares } from "./PluginCard";
import { usePluginKey } from "./use-plugin-host";

/**
 * One claimed call in the chat flow: its stock row (the truth about what ran, which a card can
 * add to but never replace), the plugin's card under it, and the stock detail sheet from either.
 */
const FlowCall = memo(function FlowCall({ part, live, sessionPath }: { part: ToolUiPart; live: boolean; sessionPath?: string | null }): JSX.Element | null {
  const claimed = usePluginClaims("transcript.tool", part.name);
  // null until first opened, like ToolPart: no sheet per card until one is asked for.
  const [open, setOpen] = useState<boolean | null>(null);
  const state = part.state === "ok" ? "done" : part.state === "running" && !live ? "done" : part.state;
  const output = part.output ?? "";
  const row = callState(part, live, false);
  const face = useMemo(() => toolFace(part, row.state !== part.state), [part, row.state]);
  const context = useMemo<PluginRenderContext | null>(
    () => claimed ? { session: null, call: { id: part.callId, name: part.name, args: part.args, output, state, truncated: false } } : null,
    [claimed, part.callId, part.name, part.args, output, state],
  );
  const { views, onAction } = usePluginKey("transcript.tool", claimed ? part.callId : null, context);
  const entry = claimed ? views[0] : undefined;
  if (!entry) return null;
  return (
    <div className="flex min-w-0 flex-col" data-testid="plugin-flow-call">
      <ToolRow face={face} state={row.state} interrupted={row.interrupted} startedAt={part.startedAt} mono={toolKind(part.name) === "bash"} onOpen={() => setOpen(true)} shimmer={false} />
      <PluginCard
        pluginName={entry.pluginName}
        view={entry.view}
        onAction={(action, item) => onAction(entry.pluginId, action, item)}
        testId="plugin-tool-card"
        dataAttrs={{ "data-plugin": entry.pluginId, "data-call": part.callId }}
        onShowOriginal={() => setOpen(true)}
      />
      {open !== null ? <ToolSheet open={open} onOpenChange={setOpen} part={part} live={live} sessionPath={sessionPath} /> : null}
    </div>
  );
});

function ClaimedCards({ messages, live, sessionPath }: { messages: readonly UiMessage[]; live: boolean; sessionPath?: string | null }): JSX.Element {
  // A call can appear in several of a stretch's items (edits repeat their run's messages): once each.
  const parts = useMemo(() => {
    const seen = new Set<string>();
    const out: ToolUiPart[] = [];
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.kind !== "tool" || seen.has(part.callId)) continue;
        seen.add(part.callId);
        out.push(part);
      }
    }
    return out;
  }, [messages]);
  return <>{parts.map((part) => <FlowCall key={part.callId} part={part} live={live} sessionPath={sessionPath} />)}</>;
}

/**
 * Plugin cards for the claimed calls of work the chat folds into a group (the rail, a settled
 * "Worked for" chip), drawn in the chat flow right beside that group so a card is visible
 * without opening anything. With no enabled `transcript.tool` plugin this is one boolean read.
 */
export function PluginFlowCards({ messages, live, sessionPath }: { messages: readonly UiMessage[]; live: boolean; sessionPath?: string | null }): JSX.Element | null {
  const declared = usePluginDeclares("transcript.tool");
  return declared ? <ClaimedCards messages={messages} live={live} sessionPath={sessionPath} /> : null;
}
