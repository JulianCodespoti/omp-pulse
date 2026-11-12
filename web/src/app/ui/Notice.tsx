import { ChevronDownIcon, CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon, type LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { RecoveryAction } from "./error-recovery";

export type NoticeTone = "info" | "success" | "warning" | "danger";

const TONE: Record<NoticeTone, { icon: string; Icon: LucideIcon }> = {
  info: { icon: "text-muted-foreground", Icon: InfoIcon },
  success: { icon: "text-success", Icon: CircleCheckIcon },
  warning: { icon: "text-warning", Icon: TriangleAlertIcon },
  danger: { icon: "text-muted-foreground", Icon: CircleAlertIcon },
};

/**
 * The one in-context notice. Every flow with something to say where the
 * person is looking (a search that failed, a folder that will not list, a
 * save that worked) renders this, so it looks and reads the same everywhere.
 * Transient messages that belong to no place use `showToast` instead.
 *
 * Copy must already be human: pass daemon or exception text through
 * `humanizeDaemonError` first. One action at most ("Couldn't <verb>
 * <object>." + one way out).
 */
export function Notice({
  tone,
  title,
  children,
  action,
  icon,
  details,
  onDismiss,
  className,
  testId,
}: {
  tone: NoticeTone;
  title?: ReactNode;
  children: ReactNode;
  action?: RecoveryAction;
  icon?: LucideIcon;
  details?: ReactNode;
  onDismiss?: () => void;
  className?: string;
  testId?: string;
}): JSX.Element {
  const t = TONE[tone];
  const urgent = tone === "danger" || tone === "warning";
  const Icon = icon ?? t.Icon;
  const ActionIcon = action?.icon;
  return (
    <div
      role={urgent ? "alert" : "status"}
      data-slot="notice"
      data-tone={tone}
      data-testid={testId}
      className={cn("flex min-w-0 items-start gap-2.5 rounded-xl bg-surface-2 py-2 pl-3 text-left text-meta text-foreground", onDismiss ? "pr-0" : "pr-3", className)}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-[20px] shrink-0", t.icon)} strokeWidth={1.5} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title ? <p className="text-ui font-medium">{title}</p> : null}
        <div className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</div>
        {action || details ? <div className="flex min-w-0 flex-wrap items-start gap-x-3">
          {action ? (
            <button
              type="button"
              onClick={action.onClick}
              className="-ml-2 inline-flex min-h-[48px] max-w-full items-center gap-2 self-start whitespace-normal break-words rounded-lg px-2 py-2 text-left font-medium text-primary-text outline-none active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
            >
              {ActionIcon ? <ActionIcon aria-hidden className="size-4 shrink-0" strokeWidth={1.5} /> : null}
              {action.label}
            </button>
          ) : null}
          {details ? <NoticeDetails className="open:basis-full">{details}</NoticeDetails> : null}
        </div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-my-2 flex size-[48px] shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** Keep causes and safety consequences visible; disclose only supporting detail. */
export function NoticeDetails({ children, summary = "Details", className }: { children: ReactNode; summary?: string; className?: string }): JSX.Element {
  return (
    <details className={cn("group/notice-details min-w-0 text-meta text-muted-foreground", className)}>
      <summary className="flex min-h-[48px] w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded-md py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon aria-hidden className="size-4 shrink-0 transition-transform group-open/notice-details:rotate-180" strokeWidth={1.5} />
        <span className="min-w-0 break-words">{summary}</span>
      </summary>
      <div className="min-w-0 space-y-2 pb-2 [overflow-wrap:anywhere]">{children}</div>
    </details>
  );
}
