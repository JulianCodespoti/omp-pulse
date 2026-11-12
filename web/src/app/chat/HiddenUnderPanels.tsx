import { useContext } from "react";
import type { JSX, ReactNode } from "react";

import { usePanels } from "../nav/panels";
import { ScreenActivityContext } from "../nav/screen-activity";

/**
 * The chat's floating notices sit in a portal above everything, so with a
 * drawer open they drew over it: the connection pill and an error landed on
 * top of the drawer's own banner for the same outage. A drawer covers the chat
 * and carries its own notice, so the chat's stand down while one is open.
 * Pushed pages also cover the chat. Its portal sits outside the inert chat
 * surface, so it must honour the screen context to avoid a second Retry
 * floating over the Chats page's own connection banner.
 * Reading the panels here keeps the chat itself from re-rendering on every
 * drawer swipe.
 */
export function HiddenUnderPanels({ children }: { children: ReactNode }): JSX.Element | null {
  const panels = usePanels();
  const active = useContext(ScreenActivityContext);
  return !active || panels.switcher || panels.workspace !== null ? null : <>{children}</>;
}
