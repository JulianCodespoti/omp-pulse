import { useCallback, useSyncExternalStore } from "react";
import { readPairingToken } from "../platform/browser-storage";
import type { MagicKeyword } from "../domain/magic-keywords";
import { DaemonApi } from "./rpc-client";
import { startVisibleInterval } from "./visible-interval";

interface PromptConfigOwner {
  keywords: readonly MagicKeyword[] | null;
  listeners: Set<() => void>;
  stop: () => void;
}
const owners = new Map<string, PromptConfigOwner>();
const unavailable = () => null;

/** One read-only metadata owner per credential/session, shared by editor and transcript. */
export function usePromptKeywords(sessionPath: string | null | undefined): readonly MagicKeyword[] | null {
  const token = readPairingToken() ?? "";
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const key = JSON.stringify([origin, token, sessionPath]);
  const subscribe = useCallback((listener: () => void) => {
    if (!sessionPath || !token) return () => {};
    let owner = owners.get(key);
    if (!owner) {
      let generation = 0, stopped = false;
      const api = new DaemonApi(token, origin);
      owner = { keywords: null, listeners: new Set(), stop: () => {} };
      const current = owner;
      const publish = (keywords: readonly MagicKeyword[] | null) => {
        current.keywords = keywords;
        for (const notify of current.listeners) notify();
      };
      const refresh = () => {
        const request = ++generation;
        // A previous successful read is not proof after settings/tools change.
        publish(null);
        void Promise.resolve().then(() => {
          if (stopped || request !== generation || readPairingToken() !== token) return null;
          return api.getPromptConfig(sessionPath);
        }).then(config => {
          if (config && !stopped && request === generation && readPairingToken() === token) publish(config.magicKeywords);
        }, () => {
          if (!stopped && request === generation) publish(null);
        });
      };
      const focus = () => { if (document.visibilityState !== "hidden") refresh(); };
      // Visible-only: the 15 s re-read used to tick (and skip) while hidden.
      const stopPolling = startVisibleInterval(refresh, 15_000);
      window.addEventListener("focus", focus);
      document.addEventListener("visibilitychange", focus);
      current.stop = () => {
        stopped = true;
        generation++;
        stopPolling();
        window.removeEventListener("focus", focus);
        document.removeEventListener("visibilitychange", focus);
      };
      owners.set(key, current);
      refresh();
    }
    owner.listeners.add(listener);
    return () => {
      owner.listeners.delete(listener);
      if (owner.listeners.size === 0) {
        owner.stop();
        if (owners.get(key) === owner) owners.delete(key);
      }
    };
  }, [key, origin, sessionPath, token]);
  const snapshot = useCallback(() => sessionPath && readPairingToken() === token ? owners.get(key)?.keywords ?? null : null, [key, sessionPath, token]);
  return useSyncExternalStore(subscribe, snapshot, unavailable);
}
