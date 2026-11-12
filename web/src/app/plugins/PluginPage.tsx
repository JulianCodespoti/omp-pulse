import { PuzzleIcon } from "lucide-react";
import type { JSX } from "react";

import { EmptyState } from "../ui/EmptyState";
import { ErrorNotice } from "../ui/ErrorNotice";
import { RowGroup, RowSkeleton } from "../ui/Row";
import { ScreenHeader } from "../ui/ScreenHeader";
import { PluginNodeView } from "./NodeView";
import { PluginsHaltedNotice } from "./PluginsSettings";
import { usePluginHost, usePluginSlot } from "./use-plugin-host";

/** A plugin's own full-screen page. Keeps the plugin running while it is open. */
export function PluginPage({ pluginId, onClose }: { pluginId: string; onClose: () => void }): JSX.Element {
  const { catalog, runtimes, haltedAfterCrash } = usePluginHost();
  const { views, onAction } = usePluginSlot("page", true, pluginId);
  const plugin = catalog?.find((entry) => entry.id === pluginId);
  const runtime = runtimes[pluginId];
  const view = views.find((entry) => entry.pluginId === pluginId);

  let body: JSX.Element;
  if (catalog !== null && plugin?.status !== "enabled") {
    body = (
      <EmptyState
        className="pt-16"
        icon={<PuzzleIcon />}
        title="This plugin is off"
        description="Turn it on in Settings › Plugins"
      />
    );
  } else if (runtime?.state === "failed") {
    body = <ErrorNotice message={runtime.error ?? "The plugin stopped working."} />;
  } else if (view) {
    body = <PluginNodeView node={view.view} onAction={(action, item) => onAction(pluginId, action, item)} />;
  } else if (haltedAfterCrash) {
    body = <PluginsHaltedNotice />;
  } else {
    body = (
      <RowGroup inset>
        <RowSkeleton />
        <RowSkeleton />
      </RowGroup>
    );
  }

  return (
    <main data-testid="plugin-page" data-plugin={pluginId} className="flex h-full min-h-0 flex-col bg-background">
      <ScreenHeader title={plugin?.name ?? pluginId} onBack={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-3">
        {body}
      </div>
    </main>
  );
}
