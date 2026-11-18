import type { JSX } from "react";

import { ScreenHeader } from "../ui/ScreenHeader";
import { PluginBody } from "./PluginBody";
import { usePluginHost } from "./use-plugin-host";

/** A plugin's own full-screen page. Keeps the plugin running while it is open. */
export function PluginPage({ pluginId, onClose }: { pluginId: string; onClose: () => void }): JSX.Element {
  const { catalog } = usePluginHost();
  const plugin = catalog?.find((entry) => entry.id === pluginId);

  return (
    <main data-testid="plugin-page" data-plugin={pluginId} className="flex h-full min-h-0 flex-col bg-background">
      <ScreenHeader title={plugin?.name ?? pluginId} onBack={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-3">
        <PluginBody slot="page" pluginId={pluginId} active />
      </div>
    </main>
  );
}
