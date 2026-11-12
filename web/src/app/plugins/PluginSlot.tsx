import type { JSX } from "react";

import type { UnkeyedSlotId } from "../../domain/plugins";
import { PluginNodeView } from "./NodeView";
import { usePluginSlot } from "./use-plugin-host";

/** Draws every enabled plugin's view for one slot; nothing at all when there are none. */
export function PluginSlot({ slot, className, active = true }: { slot: UnkeyedSlotId; className?: string; active?: boolean }): JSX.Element | null {
  const { views, onAction } = usePluginSlot(slot, active);
  if (!views.length) return null;
  return (
    <div data-testid={`plugin-slot-${slot}`} className={className}>
      {views.map(entry => (
        <div key={entry.pluginId} data-testid="plugin-view" data-plugin={entry.pluginId} className="min-w-0">
          <PluginNodeView node={entry.view} onAction={(action, item) => onAction(entry.pluginId, action, item)} />
        </div>
      ))}
    </div>
  );
}
