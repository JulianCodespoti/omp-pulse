import { XIcon } from "lucide-react";
import { useState } from "react";

import type { OmpInterruption } from "@/domain/protocol";
import { interruptionText } from "@/app/session-format";

const iconButton =
  "pressable flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 active:bg-surface-3 disabled:opacity-50";

/**
 * A turn the app (or the agent) was cut off in the middle of. Says so once,
 * calmly, above the composer, and offers to pick it up. Continue sends the
 * word "Continue" only when tapped; nothing is ever resent on its own.
 * Dismiss forgets the notice for this turn. Same calm row as ErrorNotice:
 * no card, Continue as a trailing text button on the 16dp gutter.
 */
export function InterruptedBanner({
  interruption,
  canSend,
  onContinue,
  onDismiss,
}: {
  interruption: OmpInterruption;
  /** False on a read-only device or while the session cannot take a prompt. */
  canSend: boolean;
  onContinue: () => Promise<void> | void;
  onDismiss: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-testid="interrupted-banner"
      role="status"
      className="mb-1 flex items-center gap-1 pl-4 pr-2"
    >
      <p className="min-w-0 flex-1 py-2.5 text-meta text-muted-foreground">{interruptionText(interruption)}</p>
      {canSend ? (
        <button
          type="button"
          data-testid="interrupted-continue"
          disabled={busy}
          onClick={() => void run(onContinue)}
          className="pressable min-h-11 shrink-0 rounded-full px-3 text-ui font-medium text-primary-text hover:bg-surface-2 active:bg-surface-3 disabled:opacity-50"
        >
          Continue
        </button>
      ) : null}
      <button
        type="button"
        data-testid="interrupted-dismiss"
        aria-label="Dismiss"
        disabled={busy}
        onClick={() => void run(onDismiss)}
        className={iconButton}
      >
        <XIcon aria-hidden className="size-5" />
      </button>
    </div>
  );
}
