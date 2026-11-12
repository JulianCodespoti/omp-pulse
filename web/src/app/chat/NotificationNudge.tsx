import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { BellIcon } from "lucide-react";

import { selectActivity, selectSessionTurn } from "@/runtime/omp-store";
import type { OmpStoreApi } from "@/runtime/omp-store";
import { startVisibleInterval } from "@/runtime/visible-interval";
import { useStoreValue } from "@/app/store-hooks";

import {
  NO_DECLINES,
  readNudgeDeclines,
  recordNudgeDecline,
  shouldShowNotificationNudge,
} from "../../platform/notification-nudge";
import {
  hasNativeNotificationControls,
  readNativeNotificationPrefs,
  readNativeNotificationStatus,
  requestNativeNotificationPermission,
  writeNativeNotificationPrefs,
} from "../../platform/native-notifications";
import { isPushSupported, pushStatus, pushSubscriptionStatus } from "../../platform/push";
import { pushMutationInFlight, turnOnPush } from "../settings/use-push-notifications";
import { showToast } from "../Notices";
import { humanizeDaemonError } from "../ui/OwnedBySession";

type Access = { available: boolean; on: boolean; blocked: boolean };

const UNAVAILABLE: Access = { available: false, on: false, blocked: false };

/**
 * Where notifications stand on this device. Native shell: the permission is
 * askable, or granted with the switch off. Browser: push is supported and the
 * permission is still undecided. A read that fails counts as unavailable, so
 * the ask never shows on a guess.
 */
async function readAccess(): Promise<Access> {
  try {
    if (hasNativeNotificationControls()) {
      const [prefs, status] = await Promise.all([readNativeNotificationPrefs(), readNativeNotificationStatus()]);
      if (!status.paired) return UNAVAILABLE;
      if (status.permission === "blocked") return { available: false, on: false, blocked: true };
      const on = status.permission === "granted" && prefs.enabled;
      return { available: !on, on, blocked: false };
    }
    if (!isPushSupported()) return UNAVAILABLE;
    const permission = pushStatus();
    if (permission === "denied") return { available: false, on: false, blocked: true };
    if (permission === "granted") return { available: false, on: (await pushSubscriptionStatus()) === true, blocked: false };
    return { available: true, on: false, blocked: false };
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * The same enabling Settings › Notifications performs: the system prompt when
 * Android still asks, then the master switch; in a browser, the push subscribe.
 * False means the user or the system refused.
 */
async function turnOn(): Promise<boolean> {
  if (!hasNativeNotificationControls()) return turnOnPush();
  const [prefs, status] = await Promise.all([readNativeNotificationPrefs(), readNativeNotificationStatus()]);
  if (status.permission !== "granted" && !(await requestNativeNotificationPermission())) return false;
  if (!prefs.enabled) await writeNativeNotificationPrefs({ enabled: true });
  return true;
}

// The Android 13+ prompt and the browser's never appear unless someone finds
// Settings, so most people never got notifications. This asks once a turn is
// long enough that being told when it finishes is worth having.
export function NotificationNudge({ store }: { store: OmpStoreApi }): JSX.Element | null {
  const sessionPath = useStoreValue(store, (s) => s.sessionPath ?? "");
  const running = useStoreValue(store, (s) => selectSessionTurn(s, s.sessionPath ?? "") === "running");
  const turnStartedAt = useStoreValue(store, (s) => selectActivity(s, s.sessionPath ?? "")?.turnStartedAt);
  const [access, setAccess] = useState<Access>(UNAVAILABLE);
  const [declines, setDeclines] = useState(() => (typeof window === "undefined" ? NO_DECLINES : readNudgeDeclines()));
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const observedAt = useRef(Date.now());

  // Read the device's state once per running turn, not on a clock: the
  // answer only changes when the user acts, here or in Settings.
  useEffect(() => {
    if (!running) {
      setAccess(UNAVAILABLE);
      return undefined;
    }
    observedAt.current = Date.now();
    setNow(Date.now());
    let current = true;
    void readAccess().then((read) => {
      if (current) setAccess(read);
    });
    return () => {
      current = false;
    };
  }, [running, sessionPath]);

  const waiting = running && access.available && !access.on && !access.blocked;
  // A once-a-second clock, only while a turn runs and the ask could still show.
  useEffect(() => {
    if (!waiting) return undefined;
    return startVisibleInterval(() => setNow(Date.now()), 1000, { tickOnShow: true });
  }, [waiting]);

  if (!waiting) return null;
  // A start in the future or over 12h back is a stale timestamp, not this turn.
  const startedAt =
    turnStartedAt !== undefined && turnStartedAt <= now + 5_000 && now - turnStartedAt < 12 * 60 * 60 * 1000
      ? turnStartedAt
      : observedAt.current;
  const visible = shouldShowNotificationNudge({ ...access, runningMs: now - startedAt, declines, now });
  if (!visible) return null;

  const decline = (): void => setDeclines(recordNudgeDecline(Date.now()));
  const accept = async (): Promise<void> => {
    if (busy || pushMutationInFlight()) return;
    setBusy(true);
    try {
      if (await turnOn()) {
        setAccess({ available: false, on: true, blocked: false });
        showToast("Notifications on", "success");
      } else {
        decline();
      }
    } catch (cause) {
      decline();
      showToast(humanizeDaemonError(cause), "error");
    } finally {
      setBusy(false);
    }
  };
  const action = "relative flex h-8 shrink-0 items-center rounded-full px-3 after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-3";

  return (
    <div role="status" data-testid="notification-nudge" className="mx-3 mb-1 flex shrink-0 items-center gap-2 rounded-xl bg-surface-1 py-1 pl-4 pr-1 text-meta text-muted-foreground">
      <BellIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">Get notified when this finishes?</span>
      <button type="button" disabled={busy} onClick={() => void accept()} className={`${action} text-primary-text`}>
        Turn on
      </button>
      <button type="button" disabled={busy} onClick={decline} className={action}>
        Not now
      </button>
    </div>
  );
}
