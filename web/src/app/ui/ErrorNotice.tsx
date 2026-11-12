import { CircleAlertIcon, RotateCwIcon, XIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { NoticeDetails } from "./Notice";
import type { RecoveryAction } from "./error-recovery";

/**
 * The one in-context error surface. Every flow that has an error to show
 * where the user is looking (a failed search, a directory that will not
 * list, a dictation that heard nothing) renders this, so errors look and
 * read the same everywhere. Transient errors that belong to no place use
 * `showToast(message, "error")` instead.
 *
 * `message` must already be human wording: pass raw daemon or exception
 * text through `humanizeDaemonError` first.
 *
 * One calm row, not a red slab. Recoverable errors use a neutral icon and
 * one labelled action; destructive confirmations keep their danger styling.
 * Fixed-pixel 48px targets avoid inflating the chrome with larger text, while
 * both the message and action can wrap. Supporting detail is opt-in so a
 * safety consequence can never disappear merely because its copy is long.
 */
export function ErrorNotice({
  message,
  onRetry,
  action,
  details,
  onDismiss,
  className,
  testId,
}: {
  message: string;
  onRetry?: () => void;
  action?: RecoveryAction;
  details?: ReactNode;
  onDismiss?: () => void;
  className?: string;
  testId?: string;
}): JSX.Element {
  const ActionIcon = action?.icon ?? (!action && onRetry ? RotateCwIcon : undefined);
  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn("flex min-h-[48px] flex-wrap items-start gap-x-3 text-meta text-foreground", className)}
    >
      <CircleAlertIcon aria-hidden className="mt-3 size-[20px] shrink-0 text-muted-foreground" strokeWidth={1.5} />
      {/* At a large font on a narrow phone the message wraps beside the
          actions; only below 120px of room do they drop to their own line,
          end-aligned, rather than squeezing the message to one syllable per
          line. */}
      <p className={cn("min-w-[120px] flex-1 py-2.5 [overflow-wrap:anywhere]", !action && !onRetry && !onDismiss && "pr-2")}>{message}</p>
      {action || onRetry || onDismiss ? (
        <div className="ml-auto flex max-w-full items-center">
          {action || onRetry ? (
            <button
              type="button"
              aria-label={action?.label ?? "Retry"}
              onClick={action?.onClick ?? onRetry}
              className="pressable flex min-h-[48px] min-w-0 max-w-full items-center gap-2 whitespace-normal break-words rounded-full px-[12px] py-2 text-left text-ui font-medium text-primary-text transition-colors hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
            >
              {ActionIcon ? <ActionIcon aria-hidden className="size-4 shrink-0" strokeWidth={1.5} /> : null}
              {action?.label ?? "Retry"}
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismiss}
              className="pressable flex size-[48px] shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <XIcon aria-hidden className="size-[20px]" />
            </button>
          ) : null}
        </div>
      ) : null}
      {details ? <div className="min-w-0 basis-full pl-[32px]"><NoticeDetails>{details}</NoticeDetails></div> : null}
    </div>
  );
}
