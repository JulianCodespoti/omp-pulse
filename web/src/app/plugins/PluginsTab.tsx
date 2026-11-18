import { useState } from "react";
import type { JSX } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";

import { Chip } from "../ui/Chip";
import { PluginBody } from "./PluginBody";
import { useWorkspacePlugins } from "./use-plugin-host";

/**
 * The chat workspace's Plugins page. Every enabled plugin that declares the
 * `workspace` slot shares this one tab (a tab each would crowd the dock past
 * readable labels). With several, a row of their names picks one; it wraps
 * rather than scrolling sideways, because inside the drawer's pager a sideways
 * drag must turn the page. Only the chosen plugin is kept running, and only
 * while the page is live; the open conversation reaches it as `ctx.session`.
 */
export function PluginsTab({ active }: { sessionPath: string; active: boolean; focused: boolean }): JSX.Element {
  const plugins = useWorkspacePlugins() ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  // The first plugin until one is picked, and again if the picked one goes.
  const current = plugins.find((plugin) => plugin.id === chosen) ?? plugins[0];

  return (
    <div data-testid="plugins-tab" className="flex min-h-0 flex-1 flex-col">
      {plugins.length > 1 ? (
        <div role="group" aria-label="Plugin shown" data-testid="plugins-tab-picker" className="flex shrink-0 flex-wrap gap-2 px-4 pt-3">
          {plugins.map((plugin) => (
            <Chip
              key={plugin.id}
              size="md"
              selected={plugin.id === current?.id}
              onClick={() => setChosen(plugin.id)}
              testId="plugins-tab-choice"
              data-plugin={plugin.id}
            >
              {plugin.name}
            </Chip>
          ))}
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        {current ? (
          <div data-testid="plugin-view" data-plugin={current.id} className="px-4 pb-6 pt-3">
            <PluginBody key={current.id} slot="workspace" pluginId={current.id} active={active} />
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}
