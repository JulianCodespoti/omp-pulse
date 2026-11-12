import { useContext, useEffect, useLayoutEffect, useRef } from "react";

import { pushBackLayer, type BackLayer } from "../platform/native-back";
import { ScreenActivityContext } from "./nav/screen-activity";

/**
 * Keep a layer on the back stack while `active`.
 *
 * Back order, top first: an open sheet (the palette included) → a side
 * panel (switcher, workspace) → a pushed screen (Settings, New session) →
 * the chat → the list (no layer: Back there leaves the app). Sheets and side
 * panels are Base UI dialogs, ordinary layers stacked in the order they
 * opened; pushed screens and the chat are `base` layers, so any dialog
 * closes before them. Opening a pushed screen closes the side panels, and a
 * chat opened while a pushed screen is up (a notification tap, a new
 * session) closes the screen first (nav/panels.ts `resetPanels`), so a
 * pushed screen is always the newest base layer.
 *
 * INVARIANT: registration depends on `active` alone. Stack order is
 * registration order, so re-registering whenever a handler identity changed
 * would lift a parent sheet above the child opened on top of it. Handlers are
 * read through a ref instead, always the latest render's.
 */
export function useBackLayer(requestedActive: boolean, layer: BackLayer): void {
  const screenActive = useContext(ScreenActivityContext);
  const active = requestedActive && screenActive;
  const latest = useRef(layer);
  useLayoutEffect(() => {
    latest.current = layer;
  });
  const base = layer.base === true;
  useEffect(() => {
    if (!active) return;
    return pushBackLayer({
      base,
      onBack: () => latest.current.onBack(),
      onProgress: (progress, edge) => latest.current.onProgress?.(progress, edge),
      onCancel: () => latest.current.onCancel?.(),
    });
  }, [active, base]);
}
