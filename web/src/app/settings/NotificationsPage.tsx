import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { BellIcon, BellOffIcon, TriangleAlertIcon } from "lucide-react";

import { Switch } from "@/components/ui/switch";

import {
  hasNativeNotificationControls,
  openNativeSettings,
  readNativeNotificationPrefs,
  readNativeNotificationStatus,
  requestNativeNotificationPermission,
  writeNativeNotificationPrefs,
} from "../../platform/native-notifications";
import type { NativeNotificationPrefs, NativeNotificationStatus } from "../../platform/native-notifications";
import { showToast } from "../Notices";
import { Notice } from "../ui/Notice";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { Row, RowGroup, RowSkeleton } from "../ui/Row";
import { usePushNotifications } from "./use-push-notifications";

type NativeState = { prefs: NativeNotificationPrefs; status: NativeNotificationStatus };
type Fix = "permission" | "settings" | "background" | "battery";
type Summary = { reaching: boolean; text: string; fix?: { label: string; run: Fix } };

/**
 * Whether alerts reach this phone and, when they don't, the single thing to
 * fix first. Ordered by what blocks delivery outright, then what only delays it.
 */
export function summarizeNativeNotifications({ prefs, status }: NativeState): Summary {
  if (!status.paired) return { reaching: false, text: "Pair this phone to get notifications." };
  if (status.permission === "ask") {
    return { reaching: false, text: "Android hasn\u2019t been allowed to show them yet.", fix: { label: "Allow notifications", run: "permission" } };
  }
  if (status.permission === "blocked") {
    return { reaching: false, text: "Android is blocking them for this app.", fix: { label: "Open Android settings", run: "settings" } };
  }
  if (!prefs.enabled) return { reaching: false, text: "Turned off. Nothing will alert you." };
  if (!prefs.background) {
    return {
      reaching: false,
      text: "Background delivery is off, so alerts only arrive while the app is open.",
      fix: { label: "Turn on background delivery", run: "background" },
    };
  }
  if (status.batteryUnrestricted === false) {
    return { reaching: false, text: "Android may delay them to save battery.", fix: { label: "Change battery usage", run: "battery" } };
  }
  if (status.listener !== "connected") {
    return { reaching: false, text: "Can\u2019t reach your computer right now. Alerts resume when it\u2019s back." };
  }
  return { reaching: true, text: "Reaching this phone. Connected to your computer." };
}

/** The Android shell's switches and health, re-read whenever the app returns from Android settings. */
function useNativeNotifications(active: boolean) {
  const [state, setState] = useState<NativeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // A newer read or a local edit supersedes reads still in flight.
  const read = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++read.current;
    try {
      const [prefs, status] = await Promise.all([readNativeNotificationPrefs(), readNativeNotificationStatus()]);
      if (!mounted.current || read.current !== current) return;
      setState({ prefs, status });
      setError(null);
    } catch (cause) {
      if (mounted.current && read.current === current) setError(humanizeDaemonError(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!active) return undefined;
    void refresh();
    const onReturn = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [active, refresh]);

  // The edit shows at once; the shell is the source of truth only when it refuses.
  const update = useCallback(
    async (changes: Partial<NativeNotificationPrefs>) => {
      read.current += 1;
      setState((s) => (s ? { ...s, prefs: { ...s.prefs, ...changes } } : s));
      try {
        await writeNativeNotificationPrefs(changes);
        // Background delivery starts or stops the listener, which status reports.
        if ("background" in changes) await refresh();
      } catch {
        showToast("Couldn\u2019t save that change.", "error");
        await refresh();
      }
    },
    [refresh],
  );

  return { state, error, refresh, update };
}

/**
 * Short value for the Settings root and Diagnostics rows: "On", "Off",
 * "Blocked", "Not available" or "Checking…". One read, no polling.
 */
export function useNotificationsStatus(): string {
  const native = hasNativeNotificationControls();
  const nativeState = useNativeNotifications(native);
  const push = usePushNotifications(!native);
  if (!native) return push.label;
  if (nativeState.state) {
    const { prefs, status } = nativeState.state;
    return status.permission !== "granted" ? "Blocked" : prefs.enabled ? "On" : "Off";
  }
  return nativeState.error ? "Not available" : "Checking\u2026";
}

function SwitchRow({
  title,
  subtitle,
  leading,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  subtitle?: ReactNode;
  leading?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <Row
      leading={leading}
      title={title}
      subtitle={subtitle}
      disabled={disabled}
      trailing={
        <span className="-mr-1 flex size-12 shrink-0 items-center justify-center">
          <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={title} />
        </span>
      }
    />
  );
}

const toInputValue = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const showTime = (minutes: number) =>
  new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * The value is text; a transparent native time input covers the row, so a tap
 * opens the system picker with no sheet of our own in between.
 */
function TimeRow({
  title,
  label,
  minutes,
  onChange,
}: {
  title: string;
  label: string;
  minutes: number;
  onChange: (minutes: number) => void;
}): JSX.Element {
  return (
    <Row
      title={title}
      chevron
      className="focus-within:bg-surface-2"
      trailing={
        <>
          {showTime(minutes)}
          <input
            type="time"
            aria-label={label}
            value={toInputValue(minutes)}
            onChange={(event) => {
              // A cleared field has no time to save.
              const [hour, minute] = event.target.value.split(":").map(Number);
              if (Number.isFinite(hour) && Number.isFinite(minute)) onChange(hour * 60 + minute);
            }}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </>
      }
    />
  );
}

const failedToOpen = () => showToast("Couldn\u2019t open Android settings.", "error");

function AndroidNotifications(): JSX.Element {
  const { state, error, refresh, update } = useNativeNotifications(true);

  if (!state) {
    return error ? (
      <Notice tone="danger" action={{ label: "Retry", onClick: () => void refresh() }}>{error}</Notice>
    ) : (
      <div className="flex flex-col gap-6" aria-busy>
        {[1, 3, 2, 4].map((rows, group) => (
          <RowGroup key={group} inset>
            {Array.from({ length: rows }, (_, row) => <RowSkeleton key={row} subtitle />)}
          </RowGroup>
        ))}
      </div>
    );
  }

  const { prefs, status } = state;
  const summary = summarizeNativeNotifications(state);
  const open = (screen: "notifications" | "bubbles" | "battery") => () => void openNativeSettings(screen).catch(failedToOpen);
  const fix = async (run: Fix) => {
    try {
      if (run === "permission") {
        await requestNativeNotificationPermission();
        await refresh();
      } else if (run === "background") {
        await update({ background: true });
      } else {
        await openNativeSettings(run === "battery" ? "battery" : "notifications");
      }
    } catch {
      failedToOpen();
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <RowGroup inset>
        <SwitchRow
          leading={summary.reaching ? <BellIcon /> : <BellOffIcon />}
          title="Notifications"
          subtitle={summary.text}
          checked={prefs.enabled}
          onChange={(enabled) => void update({ enabled })}
        />
        {summary.fix ? (
          <Row leading={<TriangleAlertIcon />} title={summary.fix.label} chevron onClick={() => void fix(summary.fix!.run)} />
        ) : null}
      </RowGroup>

      <RowGroup title="Notify me when" inset>
        <SwitchRow
          title="An agent finishes"
          checked={prefs.agentEnd}
          disabled={!prefs.enabled}
          onChange={(agentEnd) => void update({ agentEnd })}
        />
        <SwitchRow
          title="An agent needs you"
          subtitle="A question, or something waiting for your approval."
          checked={prefs.needsInput}
          disabled={!prefs.enabled}
          onChange={(needsInput) => void update({ needsInput })}
        />
        <SwitchRow
          title="Something goes wrong"
          checked={prefs.alerts}
          disabled={!prefs.enabled}
          onChange={(alerts) => void update({ alerts })}
        />
      </RowGroup>

      <RowGroup
        title="Quiet hours"
        inset
        footer={
          prefs.quietEnabled && prefs.quietStart === prefs.quietEnd
            ? "Start and end are the same time, so nothing is silenced."
            : undefined
        }
      >
        <SwitchRow
          title="Quiet hours"
          subtitle="Silences sound and vibration. Notifications still arrive."
          checked={prefs.quietEnabled}
          onChange={(quietEnabled) => void update({ quietEnabled })}
        />
        {prefs.quietEnabled ? (
          <>
            <TimeRow title="From" label="Quiet hours start" minutes={prefs.quietStart} onChange={(quietStart) => void update({ quietStart })} />
            <TimeRow title="Until" label="Quiet hours end" minutes={prefs.quietEnd} onChange={(quietEnd) => void update({ quietEnd })} />
          </>
        ) : null}
      </RowGroup>

      <RowGroup
        title="Delivery"
        inset
        footer="Alerts come straight from your computer, so this phone needs to reach it. If you force-stop the app, open it again to get alerts."
      >
        <SwitchRow
          title="Background delivery"
          subtitle="Keeps notifications arriving when the app is closed."
          checked={prefs.background}
          onChange={(background) => void update({ background })}
        />
        {status.bubbles === "unsupported" ? null : (
          <Row
            title="Bubbles"
            subtitle="Open a chat from a floating bubble."
            trailing={status.bubbles === "on" ? "On" : "Off"}
            chevron
            onClick={open("bubbles")}
          />
        )}
        <Row
          title="Battery"
          trailing={status.batteryUnrestricted === undefined ? undefined : status.batteryUnrestricted ? "Unrestricted" : "Restricted"}
          chevron
          onClick={open("battery")}
        />
        <Row title="Sound and vibration" chevron onClick={open("notifications")} />
      </RowGroup>
    </div>
  );
}

function BrowserNotifications(): JSX.Element {
  const push = usePushNotifications();
  const canToggle = push.supported && !push.denied;
  return (
    <div className="flex flex-col gap-6">
      <RowGroup inset footer="Choosing which events notify you, and quiet hours, are in the Android app.">
        <Row
          leading={push.checked ? <BellIcon /> : <BellOffIcon />}
          title="Notifications"
          subtitle={push.subtitle}
          trailing={
            // No switch when it cannot do anything: a disabled toggle beside
            // "blocked" reads as a control to try. The subtitle says why.
            canToggle ? (
              <span className="-mr-1 flex size-12 shrink-0 items-center justify-center">
                <Switch
                  checked={push.checked}
                  disabled={push.busy}
                  onCheckedChange={(checked) => void push.toggle(checked)}
                  aria-label="Notifications"
                />
              </span>
            ) : undefined
          }
        />
        {push.denied ? (
          <Notice tone="warning" action={{ label: "Check again", onClick: () => void push.refresh() }}>
            Allow notifications for this site in your browser’s settings, then check again.
          </Notice>
        ) : null}
        {push.error ? (
          <Notice tone="danger" action={{ label: "Check again", onClick: () => void push.refresh() }}>
            {push.error}
          </Notice>
        ) : null}
      </RowGroup>
    </div>
  );
}

/** Settings › Notifications: the Android shell's own switches there, web push in a browser. */
export function NotificationsPage(): JSX.Element {
  return hasNativeNotificationControls() ? <AndroidNotifications /> : <BrowserNotifications />;
}
