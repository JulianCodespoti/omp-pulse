import { PuzzleIcon } from "lucide-react";
import type { JSX } from "react";

import { EmptyState } from "../ui/EmptyState";
import { ErrorNotice } from "../ui/ErrorNotice";
import { RowGroup, RowSkeleton } from "../ui/Row";
import { PluginNodeView } from "./NodeView";
import { PluginsHaltedNotice } from "./PluginsSettings";
import { usePluginHost, usePluginSlot } from "./use-plugin-host";

/**
 * One plugin's view in a surface of its own (its page, its workspace tab), or
 * why there is none. Keeps only that plugin running for `slot` while `active`.
 */
export function PluginBody({ slot, pluginId, active }: { slot: "page" | "workspace"; pluginId: string; active: boolean }): JSX.Element {
  const { catalog, runtimes, haltedAfterCrash } = usePluginHost();
  const { views, onAction } = usePluginSlot(slot, active, pluginId);
  const plugin = catalog?.find((entry) => entry.id === pluginId);
  const runtime = runtimes[pluginId];
  const view = views.find((entry) => entry.pluginId === pluginId);

  if (catalog !== null && plugin?.status !== "enabled") {
    return (
      <EmptyState
        className="pt-16"
        icon={<PuzzleIcon />}
        title="This plugin is off"
        description="Turn it on in Settings › Plugins"
      />
    );
  }
  if (runtime?.state === "failed") return <ErrorNotice message={runtime.error ?? "The plugin stopped working."} />;
  if (view) return <PluginNodeView node={view.view} onAction={(action, item) => onAction(pluginId, action, item)} />;
  if (haltedAfterCrash) return <PluginsHaltedNotice />;
  return (
    <RowGroup inset>
      <RowSkeleton />
      <RowSkeleton />
    </RowGroup>
  );
}
