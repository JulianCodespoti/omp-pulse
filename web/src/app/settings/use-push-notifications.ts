import { useCallback, useEffect, useRef, useState } from "react";

import {
  isPushSupported,
  pushStatus,
  pushSubscriptionStatus,
  subscribePush,
  unsubscribePush,
} from "../../platform/push";
import type { PushPermissionState } from "../../platform/push";
import { humanizeDaemonError } from "../ui/OwnedBySession";

export type PushNotifications = {
  supported: boolean;
  denied: boolean;
  checked: boolean;
  busy: boolean;
  error: string | null;
  /** Short value for a row: "On", "Off", "Blocked", "Not available" or "Checking…". */
  label: string;
  subtitle: string;
  toggle: (checked: boolean) => Promise<void>;
  refresh: () => Promise<void>;
};

// The device's subscribe/unsubscribe in flight, settled either way. Module
// scope, not component state: closing Settings unmounts it, and a reopened
// Settings must stay locked until the platform work it cannot cancel ends.
let pendingPushMutation: Promise<void> | null = null;

/** The subscribe, unsubscribe or unpair work still running, or null. Await it before starting opposite work. */
export function pushMutationInFlight(): Promise<void> | null {
  return pendingPushMutation;
}

/**
 * Register `job` as the one push mutation in flight until it settles, so a
 * reopened page stays locked while it runs. Resolves or rejects like `job`.
 */
export async function trackPushMutation<T>(job: Promise<T>): Promise<T> {
  const settled = job.then(
    () => undefined,
    () => undefined,
  );
  pendingPushMutation = settled;
  try {
    return await job;
  } finally {
    if (pendingPushMutation === settled) pendingPushMutation = null;
  }
}

/**
 * Subscribe this device, tracked as the one push mutation in flight. Settings
 * and the in-chat ask share it so both end in the same enabled state; false
 * means the browser or the computer refused, with nothing subscribed.
 */
export async function turnOnPush(): Promise<boolean> {
  return (await trackPushMutation(subscribePush())) !== null;
}

/**
 * Web Push for this device. Browser permission is local; whether the
 * computer holds a subscription for this device is a second, authoritative
 * read (false after a 404/410). One mutation at a time: platform
 * subscribe/unsubscribe cannot be cancelled, and an opposite one started
 * meanwhile would race its side effects. `active` false does nothing, so a
 * caller that only needs the Android variant never reads the browser's.
 */
export function usePushNotifications(active = true): PushNotifications {
  const [permission, setPermission] = useState<PushPermissionState>(pushStatus);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(() => pendingPushMutation !== null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Each read is numbered; a mutation or a newer read supersedes older ones.
  const read = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++read.current;
    setPermission(pushStatus());
    try {
      const status = await pushSubscriptionStatus();
      if (mounted.current && read.current === current) setSubscribed(status);
    } catch (cause) {
      if (mounted.current && read.current === current) {
        setSubscribed(null);
        setError(humanizeDaemonError(cause));
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!active) return undefined;
    void refresh();
    // Reopened while an earlier visit's mutation runs: read again once it
    // settles, then unlock.
    const inflight = pendingPushMutation;
    if (inflight) {
      setBusy(true);
      void inflight.then(async () => {
        if (!mounted.current) return;
        await refresh();
        if (mounted.current) setBusy(false);
      });
    }
    return () => {
      mounted.current = false;
    };
  }, [refresh, active]);

  const toggle = async (checked: boolean) => {
    if (pendingPushMutation) return;
    read.current += 1;
    setBusy(true);
    setError(null);
    // Device scope is intentional: one endpoint receives completion
    // notifications for every session, including ones never opened here.
    try {
      await (checked ? turnOnPush() : trackPushMutation(unsubscribePush()));
    } catch (cause) {
      if (mounted.current) setError(humanizeDaemonError(cause));
    } finally {
      // A closed Settings reads nothing; the next opening reads for itself.
      if (mounted.current) {
        await refresh();
        if (mounted.current) setBusy(false);
      }
    }
  };

  const supported = isPushSupported();
  const denied = permission === "denied";
  const on = permission === "granted" && subscribed === true;
  return {
    supported,
    denied,
    checked: on,
    busy,
    error,
    toggle,
    refresh: async () => {
      setError(null);
      await refresh();
    },
    label: !supported ? "Not available" : denied ? "Blocked" : subscribed === null ? "Checking\u2026" : on ? "On" : "Off",
    subtitle: !supported
      ? "Needs a secure connection and a browser that supports notifications."
      : denied
        ? "Blocked for this site."
        : on
          ? "When an agent finishes or needs you."
          : "Get told when an agent finishes or needs you.",
  };
}
