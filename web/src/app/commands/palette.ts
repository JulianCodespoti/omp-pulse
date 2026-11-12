import { useEffect, useSyncExternalStore } from "react";

import type { OmpCommand } from "./command-registry";

// The global palette is mounted once by App.tsx. It opens from the chat
// composer, the session switcher and anywhere else that calls `openPalette`.
// The open chat contributes its slash commands (and how to run them) through
// `useProvideSlashCommands`; outside a chat the palette simply has no
// Slash commands group.

export interface SlashCommandSource {
  commands: OmpCommand[];
  live: { model?: string; contextPercent?: number; agentWorking: boolean };
  onRun: (cmd: OmpCommand, subcommandName?: string) => void;
}

interface PaletteState {
  open: boolean;
  /** Open already drilled into this command's subcommands. */
  drill: OmpCommand | null;
  /** Text the search field starts with (the switcher hands its query over). */
  query: string;
  slash: SlashCommandSource | null;
}

let state: PaletteState = { open: false, drill: null, query: "", slash: null };
const listeners = new Set<() => void>();

function set(next: PaletteState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): PaletteState {
  return state;
}

export function openPalette(drill: OmpCommand | null = null, query = ""): void {
  set({ ...state, open: true, drill, query });
}

export function closePalette(): void {
  if (state.open) set({ ...state, open: false, drill: null, query: "" });
}

export function usePalette(): PaletteState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, () => state.open, () => state.open);
}

/**
 * Publish the open chat's slash commands while it is mounted. The source is
 * re-published whenever its identity changes so the palette always runs the
 * latest handler; unmounting the chat withdraws it.
 */
export function useProvideSlashCommands(source: SlashCommandSource | null): void {
  useEffect(() => {
    set({ ...state, slash: source });
    return () => {
      if (state.slash === source) set({ ...state, slash: null });
    };
  }, [source]);
}
