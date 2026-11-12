import type { JSX } from "react";

import { readPairingToken } from "../../platform/browser-storage";
import type { OmpStoreApi } from "../../runtime/omp-store";
import { DaemonApi } from "../../runtime/rpc-client";
import { useStoreValue } from "../store-hooks";
import { CommandPalette } from "./CommandPalette";
import type { OmpCommand } from "./command-registry";
import { closePalette, usePalette } from "./palette";

const NO_COMMANDS: OmpCommand[] = [];
const NOT_WORKING = { agentWorking: false };

// Loaded rows are only the newest pages; the daemon searches the whole archive.
const searchSessions = (q: string, limit: number, signal: AbortSignal) => {
  const token = readPairingToken();
  return token ? new DaemonApi(token).searchSessions(q, limit, signal) : Promise.resolve([]);
};

/** App's one palette mount, fed by the palette store and the open chat. */
export function GlobalPalette({
  store,
  inChat,
  onOpenSession,
}: {
  store: OmpStoreApi;
  inChat: boolean;
  onOpenSession: (path: string) => void;
}): JSX.Element {
  const { open, drill, query, slash } = usePalette();
  const sessions = useStoreValue(store, (state) => state.sessions);
  const sessionsLoaded = useStoreValue(store, (state) => state.sessionsUpdatedAt !== null);
  const currentPath = useStoreValue(store, (state) => state.sessionPath);
  return (
    <CommandPalette
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette();
      }}
      commands={slash?.commands ?? NO_COMMANDS}
      live={slash?.live ?? NOT_WORKING}
      onRun={(cmd, sub) => slash?.onRun(cmd, sub)}
      initialDrill={drill}
      initialQuery={query}
      sessions={sessions}
      searchSessions={searchSessions}
      sessionsLoaded={sessionsLoaded}
      currentPath={inChat ? currentPath : null}
      inChat={inChat}
      onOpenSession={onOpenSession}
    />
  );
}
