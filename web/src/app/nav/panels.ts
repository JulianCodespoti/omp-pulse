import { useSyncExternalStore } from "react";

import { navigate } from "./navigate";

// Spatial navigation state: the workspace drawer over the chat (null is
// closed, a tab is open on that page), the session switcher drawer (the sole
// session list, search, and project filter surface), and the pushed Settings
// and Projects screens. Any surface may call the openers; App.tsx mounts the
// switcher and the pushed layers, ChatScreen's SessionPager mounts the
// workspace drawer.

export type WorkspaceTab = "changes" | "files" | "agents" | "tasks" | "terminal";
/** A page of the workspace drawer's pager. */
export type SessionTab = "chat" | WorkspaceTab;

export type SettingsPage =
  | "root"
  | "run-on"
  | "phone-access"
  | "appearance"
  | "notifications"
  | "computer"
  | "pair"
  | "providers"
  | "repair-pairing"
  | "saved-work"
  | "connect-computer"
  | "diagnostics"
  | "technical"
  | "plugins"
  | "about";

/** A fresh request can revisit a page after navigation within Settings. */
export interface SettingsRequest {
  page: SettingsPage;
}

export interface PanelsState {
  switcher: boolean;
  /** Optional project filter applied inside the session switcher drawer. */
  switcherProject: string | null;
  workspace: WorkspaceTab | null;
  settings: boolean;
  settingsRequest: SettingsRequest | null;
  /** The pushed project list; false while closed. */
  projects: boolean;
  /** The pushed plugin page (a plugin id); null while closed. */
  pluginPage: string | null;
}

const CLOSED: PanelsState = {
  switcher: false,
  switcherProject: null,
  workspace: null,
  settings: false,
  settingsRequest: null,
  projects: false,
  pluginPage: null,
};

let state: PanelsState = CLOSED;
const listeners = new Set<() => void>();

let activeSession: string | null = null;

function set(patch: Partial<PanelsState>): void {
  const next: PanelsState = { ...state, ...patch };
  if (
    next.switcher === state.switcher &&
    next.switcherProject === state.switcherProject &&
    next.workspace === state.workspace &&
    next.settings === state.settings &&
    next.settingsRequest === state.settingsRequest &&
    next.projects === state.projects &&
    next.pluginPage === state.pluginPage
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

// The drawer slides over whatever tab is shown; closing it returns there.
export function openSwitcher(): void {
  set({ switcher: true, workspace: null });
}

/** Open the session drawer scoped to one project's chats (from All projects or a drawer project row). */
export function openSwitcherProject(project: string | null): void {
  if (state.projects) {
    navigate("pop", () => set({ projects: false, switcher: true, switcherProject: project, workspace: null }));
    return;
  }
  set({ switcher: true, switcherProject: project, workspace: null });
}

// No per-chat memory of the last page: a bare open lands on Agents, the
// first page, every time.
export function openWorkspace(tab: WorkspaceTab = "agents"): void {
  set({ switcher: false, workspace: tab });
}

export function selectSessionTab(tab: SessionTab): void {
  set({ workspace: tab === "chat" ? null : tab });
}

/** Back to the chat: the drawers close. */
export function closePanels(): void {
  set({ switcher: false, workspace: null });
}

// Recovery covers the current editor rather than replacing it. In particular,
// the home screen's draft and its sheets remain mounted beneath Settings.
export function openSettings(): void {
  if (state.settings) return;
  openSettingsPage("root");
}

/** Open the remedy itself, without navigating away from the current chat. */
export function openSettingsPage(page: SettingsPage): void {
  const settingsRequest = { page };
  if (state.settings) {
    set({ settingsRequest });
    return;
  }
  navigate("push", () => set({ switcher: false, settings: true, settingsRequest }));
}

/** The project list: choosing a folder opens its chats inside the drawer. */
export function openProjects(): void {
  if (state.projects) return;
  navigate("push", () => set({ switcher: false, workspace: null, projects: true }));
}

/** A plugin's own page, pushed over whatever is open (Settings included); the drawers close behind it. */
export function openPluginPage(pluginId: string): void {
  if (state.pluginPage === pluginId) return;
  navigate("push", () => set({ switcher: false, workspace: null, pluginPage: pluginId }));
}

// "New chat" means going home, which App.tsx owns: it leaves an open chat,
// drops every layer and shows the new-chat screen, with `project` already
// chosen when the caller knows the folder (a chat's own "New chat"). Without
// an App (tests) there is nowhere to go.
let newChatHandler: ((project?: string) => void) | null = null;
export function setNewChatHandler(handler: ((project?: string) => void) | null): void {
  newChatHandler = handler;
}
export function openNewSession(project?: string): void {
  newChatHandler?.(project);
}

export function closeSettings(): void {
  if (!state.settings) return;
  navigate("pop", () => set({ settings: false, settingsRequest: null }));
}

export function closeProjects(): void {
  if (!state.projects) return;
  navigate("pop", () => set({ projects: false, switcher: true }));
}

export function closePluginPage(): void {
  if (state.pluginPage === null) return;
  navigate("pop", () => set({ pluginPage: null }));
}

/**
 * Close everything without motion, for a caller already inside its own
 * transition (such as App's handleOpen / popToHome).
 */
export function resetPanels(): void {
  set(CLOSED);
}

// App.tsx reports the open chat; switching or leaving it closes the drawer
// and returns to Chat, so another conversation always opens on its chat.
export function setPanelsSession(sessionPath: string | null): void {
  if (sessionPath === activeSession) return;
  activeSession = sessionPath;
  set({ switcher: false, workspace: null });
}

function snapshot(): PanelsState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePanels(): PanelsState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
