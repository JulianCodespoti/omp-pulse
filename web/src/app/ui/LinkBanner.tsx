import { useState } from "react";
import type { JSX } from "react";

import { isPhoneMode } from "../../platform/local-mode";
import { probeLink } from "../../runtime/link-state";
import { useLinkState } from "../link-hooks";
import { computerName, linkAdvice, relativeTime } from "../session-format";
import { Notice } from "./Notice";

/**
 * Says why the rows below may be old, once the link is known to be down: the
 * drawers keep what they last read and show this above it, instead of a
 * skeleton that never resolves. Nothing renders while the link is live.
 *
 * Causes the phone can tell apart are the only ones named. "Can't reach" covers
 * Tailscale off on this phone, the computer asleep or off, and a dead network,
 * because all of them look the same from here: no answer.
 */
export function LinkBanner({
  onRetry,
  className,
}: {
  /** Runs once a retry proves the link is back, to re-read what the surface shows. */
  onRetry?: () => void;
  className?: string;
}): JSX.Element | null {
  const link = useLinkState();
  const [retrying, setRetrying] = useState(false);
  if (link.kind === "live") return null;

  const onPhone = isPhoneMode();
  const host = window.location.hostname;
  const name = computerName(host, onPhone, "start");
  // The phone's own omp cannot be "asleep"; the shell can only restart it.
  const ago = link.lastLiveAt ? relativeTime(link.lastLiveAt) : "";
  const lastSeen = ago ? ` Last heard ${ago === "now" ? "just now" : `${ago} ago`}.` : "";
  const [title, body] = link.kind === "daemon-down"
    ? [onPhone ? "omp on this phone isn’t running" : `${name} is on, but omp-pulse isn’t running`, onPhone ? linkAdvice(host, true) : "Start it on the computer, then retry."]
    : onPhone
      ? ["Can’t reach omp on this phone", linkAdvice(host, true)]
      : [`Can’t reach ${computerName(host, false, "inline")}`, linkAdvice(host)];

  return (
    <Notice
      tone="warning"
      title={title}
      className={className}
      testId="link-banner"
      action={{
        label: retrying ? "Retrying…" : "Retry",
        onClick: () => {
          if (retrying) return;
          setRetrying(true);
          void probeLink(true).then((kind) => {
            if (kind === "live") onRetry?.();
          }).finally(() => setRetrying(false));
        },
      }}
    >
      {body}
      {lastSeen}
    </Notice>
  );
}
