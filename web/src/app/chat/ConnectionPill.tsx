import { WifiOffIcon, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { isPhoneMode } from "../../platform/local-mode";
import type { LinkIndicator } from "../../runtime/link-indicator";
import { probeLink } from "../../runtime/link-state";
import { openSettingsPage } from "../nav/panels";
import { computerName } from "../session-format";
import { NoticePill } from "../ui/NoticePill";

/** An outage must have been on screen this long before its end says "Back online". */
const OUTAGE_SHOWN_MS = 3_000;
/** How long "Back online" stays. */
const BACK_ONLINE_MS = 1_500;

export interface PillContent {
  tone: "info" | "success" | "warn";
  icon?: LucideIcon | "spinner";
  text: string;
  /** Show the Retry action. */
  retry: boolean;
  /** A tap on the text opens Settings › Computer, where the advice lives. */
  opensSettings: boolean;
}

/**
 * What the pill says for a verdict. `null` means nothing to show. Pure so the
 * wording table is testable; the pill itself never branches on copy.
 */
export function pillContent(
  indicator: LinkIndicator,
  staleHistory: boolean,
  backOnline: boolean,
  host: string,
  onPhone: boolean,
): PillContent | null {
  const saved = staleHistory ? " · saved copy" : "";
  switch (indicator.kind) {
    case "connecting":
      return { tone: "info", icon: "spinner", text: `Connecting…${saved}`, retry: false, opensSettings: false };
    case "unreachable":
      return {
        tone: "warn",
        icon: WifiOffIcon,
        text: `Can’t reach ${onPhone ? "omp on " : ""}${computerName(host, onPhone, "inline")}${saved}`,
        retry: true,
        opensSettings: true,
      };
    case "offline":
      return { tone: "warn", icon: WifiOffIcon, text: `You’re offline${saved}`, retry: true, opensSettings: true };
    case "daemon-down":
      return {
        tone: "warn",
        text: `${computerName(host, onPhone, "start")} is on, but omp-pulse isn’t running${saved}`,
        retry: true,
        opensSettings: true,
      };
    case "ok":
      if (backOnline) return { tone: "success", text: `Back online${saved}`, retry: false, opensSettings: false };
      if (staleHistory) return { tone: "info", text: "Showing a saved copy", retry: true, opensSettings: false };
      return null;
  }
}

/**
 * Whether the pill is up, and whether it is saying "Back online". An outage
 * that the pill showed for 3 s or more ends with that line for 1.5 s; a
 * `connecting` blip, or an outage shorter than 3 s, ends silently.
 */
function useConnectionPill(indicator: LinkIndicator, staleHistory: boolean): PillContent | null {
  const kind = indicator.kind;
  const outageSince = useRef<number | null>(null);
  const [backOnline, setBackOnline] = useState(false);
  // Keep the recovery render in this same pill before the effect arms its
  // expiry; returning null first would remount it and replay its entrance.
  const recovering = kind === "ok" && outageSince.current !== null &&
    Date.now() - outageSince.current >= OUTAGE_SHOWN_MS;
  // Count from the committed visible pill, not a deferred passive effect:
  // under load that delay could discount part of an already-shown outage.
  useLayoutEffect(() => {
    if (kind === "ok") {
      const since = outageSince.current;
      if (since === null || Date.now() - since < OUTAGE_SHOWN_MS) {
        outageSince.current = null;
        return;
      }
      setBackOnline(true);
      // A reconnect can briefly be ok before its socket drops back to
      // connecting. Consume recovery only once its whole visible interval
      // finishes, not on that first ok frame.
      const timer = window.setTimeout(() => {
        outageSince.current = null;
        setBackOnline(false);
      }, BACK_ONLINE_MS);
      return () => window.clearTimeout(timer);
    }
    setBackOnline(false);
    // `connecting` is a socket blip with the computer answering: it neither
    // starts an outage nor ends one.
    if (kind !== "connecting") outageSince.current ??= Date.now();
    return undefined;
  }, [kind]);
  return pillContent(indicator, staleHistory, backOnline || recovering, window.location.hostname, isPhoneMode());
}

/**
 * The chat's one connection indicator. It stays mounted and changes its text
 * in place: a pill that left and re-entered on every socket retry flickered
 * nine times in forty seconds on a dead link.
 */
export function ConnectionPill({
  indicator,
  staleHistory,
  onRetry,
}: {
  indicator: LinkIndicator;
  staleHistory: boolean;
  onRetry: () => void;
}): JSX.Element | null {
  const content = useConnectionPill(indicator, staleHistory);
  const [retrying, setRetrying] = useState(false);
  const retryInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const retry = () => {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    void probeLink(true)
      .then(onRetry)
      .finally(() => {
        retryInFlight.current = false;
        if (mounted.current) setRetrying(false);
      });
  };
  if (!content) return null;
  return (
    <NoticePill
      tone={content.tone}
      icon={content.icon}
      testId="chat-offline-hint"
      data={{ "data-link": indicator.kind }}
      className="pointer-events-auto"
      role="status"
      action={content.retry ? { label: retrying ? "Retrying…" : "Retry", onClick: retry, testId: "chat-offline-retry" } : undefined}
      onBodyClick={content.opensSettings ? () => openSettingsPage("computer") : undefined}
    >
      {content.text}
    </NoticePill>
  );
}
