"use client";

import { PuzzleIcon } from "lucide-react";
import { createContext, useCallback, useSyncExternalStore } from "react";
import type { JSX } from "react";

import { cn } from "@/lib/utils";

import { claimMatches, type PluginNode } from "../../domain/plugins";
import { pluginHost } from "../../runtime/plugin-host";
import { PluginNodeView } from "./NodeView";

const QUIET_BUTTON =
  "relative inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-meta font-medium text-muted-foreground outline-none hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * True inside a work group (the rail or rows a "Worked for" chip folds). The group's calls are
 * answered by the flow cards drawn beside the group, so a `ToolPart` in here keeps its stock row
 * and the same card never shows twice.
 */
export const ToolCardsSuppressed = createContext(false);

/** Whether any enabled plugin declares `slot`: a boolean snapshot, so a conversation with no transcript plugin pays one cheap loop. */
export function usePluginDeclares(slot: "transcript.tool" | "transcript.message"): boolean {
  const snapshot = useCallback((): boolean => {
    const catalog = pluginHost.getState().catalog;
    if (!catalog) return false;
    for (const info of catalog) if (info.status === "enabled" && info.slots.includes(slot)) return true;
    return false;
  }, [slot]);
  return useSyncExternalStore(pluginHost.subscribe, snapshot, snapshot);
}

/**
 * Whether some enabled plugin that declares `slot` claims `value` (a tool name
 * or a custom message type). The snapshot is a boolean, so a transcript part
 * re-renders only when its own answer changes, not on every host publication;
 * with no catalogue or no transcript plugin the check is a short loop.
 */
export function usePluginClaims(slot: "transcript.tool" | "transcript.message", value: string | null): boolean {
  const snapshot = useCallback((): boolean => {
    if (value === null) return false;
    const catalog = pluginHost.getState().catalog;
    if (!catalog) return false;
    for (const info of catalog) {
      if (info.status !== "enabled" || !info.slots.includes(slot)) continue;
      if (claimMatches(slot === "transcript.tool" ? info.tools : info.messages, value)) return true;
    }
    return false;
  }, [slot, value]);
  return useSyncExternalStore(pluginHost.subscribe, snapshot, snapshot);
}

/** The card frame of a plugin's transcript view: a header naming the plugin, the view, and a way back to the original. */
export function PluginCard({
  pluginName,
  view,
  onAction,
  testId,
  dataAttrs,
  onShowOriginal,
}: {
  pluginName: string;
  view: PluginNode;
  onAction: (action: string, item?: string) => void;
  testId: string;
  /** Extra `data-*` attributes for the frame, e.g. `{ "data-plugin": id }`. */
  dataAttrs?: Record<string, string>;
  onShowOriginal: () => void;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      {...dataAttrs}
      className="not-prose my-1 flex min-w-0 flex-col rounded-xl border border-hairline bg-surface-1 px-3 pt-2"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-tertiary">
        <PuzzleIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{pluginName}</span>
      </div>
      <div className="min-w-0 py-2">
        <PluginNodeView node={view} onAction={onAction} />
      </div>
      <div className="-mx-2 flex justify-end">
        <button
          type="button"
          data-testid="plugin-show-original"
          aria-pressed={false}
          onClick={onShowOriginal}
          className={QUIET_BUTTON}
        >
          Show original
        </button>
      </div>
    </div>
  );
}

/** Shown beside the original while a plugin card is available: one tap returns to the card. */
export function PluginBackButton({ pluginName, onClick, className }: { pluginName: string; onClick: () => void; className?: string }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="plugin-show-original"
      aria-pressed
      onClick={onClick}
      className={cn(QUIET_BUTTON, "px-0", className)}
    >
      Show {pluginName} card
    </button>
  );
}
