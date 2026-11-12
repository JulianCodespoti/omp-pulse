import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { linkIndicator, linkIndicatorChangesAt, type LinkIndicator } from "../runtime/link-indicator";
import { getChatSocketDownSince, getLinkState, subscribeLink, type LinkState } from "../runtime/link-state";

/** The shared link verdict (runtime/link-state.ts), re-rendering on change only. */
export function useLinkState(): LinkState {
  return useSyncExternalStore(subscribeLink, getLinkState, getLinkState);
}

function subscribePlatformOffline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}
const platformOfflineNow = () => navigator.onLine === false;

/**
 * The one connection verdict (runtime/link-indicator.ts) for every surface.
 * Re-renders when the link, the chat socket's down time or the platform's
 * network hint changes, and once more when the grace ends by time alone.
 */
export function useLinkIndicator(): LinkIndicator {
  const link = useLinkState();
  const socketDownSince = useSyncExternalStore(subscribeLink, getChatSocketDownSince, getChatSocketDownSince);
  const platformOffline = useSyncExternalStore(subscribePlatformOffline, platformOfflineNow, () => false);
  const [now, setNow] = useState(() => Date.now());
  const input = { link, socketDownSince, platformOffline, now: Date.now() };
  const changesAt = linkIndicatorChangesAt(input);
  useEffect(() => {
    if (changesAt === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, changesAt - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [changesAt]);
  // `now` only forces the re-render; the verdict is computed from the clock.
  void now;
  return linkIndicator(input);
}

/**
 * Runs `onRecovered` when the link comes back after being down. Surfaces that
 * showed stale rows or a failure re-read then, with no tap and no polling of
 * their own: the first answer from any socket or request is the trigger.
 */
export function useOnLinkRecovered(onRecovered: () => void): void {
  const { kind } = useLinkState();
  const previous = useRef(kind);
  const latest = useRef(onRecovered);
  latest.current = onRecovered;
  useEffect(() => {
    const was = previous.current;
    previous.current = kind;
    if (was !== "live" && kind === "live") latest.current();
  }, [kind]);
}
