import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronRightIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Flat sections share the sheet canvas. Headings and row content align with
 * the shell gutter; hairlines separate rows without nested card surfaces.
 */
export function ListSection({
  title,
  footer,
  headingId,
  children,
  className,
  groupClassName,
  ...rest
}: {
  title?: ReactNode;
  footer?: ReactNode;
  headingId?: string;
  children: ReactNode;
  className?: string;
  groupClassName?: string;
} & Omit<JSX.IntrinsicElements["section"], "title" | "children">): JSX.Element {
  return (
    <section className={cn("flex min-w-0 flex-col", className)} {...rest}>
      {title ? (
        <h2 id={headingId} className="pb-2 text-caption font-medium text-muted-foreground">
          {title}
        </h2>
      ) : null}
      {/* No border-y: rows already carry inset hairline dividers, and a rule
          under every section label plus one closing each group read as a
          ruled table with an empty band between sections. */}
      <div className={cn("flex min-w-0 flex-col divide-y divide-hairline", groupClassName)}>
        {children}
      </div>
      {footer ? (
        <div className="pt-2 text-caption leading-relaxed text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

// `@container`: the label/value pair measures the row itself, so it can stack
// when the row is narrow in rem terms (i.e. at large system text).
const ROW =
  "@container flex min-h-14 w-full min-w-0 items-center gap-4 py-3 text-left text-body";

/**
 * One row of a grouped list. With `onClick` the whole row is the button
 * (pressable, surface-3 press fill); otherwise it is static and `trailing`
 * carries its own control.
 */
export function ListRow({
  icon,
  label,
  detail,
  value,
  trailing,
  chevron,
  onClick,
  className,
  labelClassName,
  ...rest
}: {
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  value?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  className?: string;
  labelClassName?: string;
} & Record<`data-${string}` | `aria-${string}`, unknown>): JSX.Element {
  const body = (
    <>
      {icon ? (
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-5">
          {icon}
        </span>
      ) : null}
      {/* Label and value share one line while the row is wider than 20rem.
          Below that (a 360px phone at ~150% text) the value moves UNDER the
          label instead of squeezing it: side by side, a truncating value
          still left "Version" broken into "Ver/si/o/n". */}
      <span className="flex min-w-0 flex-1 items-center gap-3 @max-[20rem]:flex-col @max-[20rem]:items-start @max-[20rem]:gap-0.5">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 @max-[20rem]:w-full">
          <span className={cn("min-w-0 break-words leading-snug", labelClassName)}>
            {label}
          </span>
          {detail ? (
            <span className="min-w-0 break-words text-meta text-muted-foreground">
              {detail}
            </span>
          ) : null}
        </span>
        {/* Truncate, never overflow: at 150% text a long value ran past the
            sheet padding to the screen edge. */}
        {value !== undefined && value !== null ? (
          <span className="min-w-0 max-w-[50%] shrink truncate text-right text-meta text-muted-foreground @max-[20rem]:max-w-full @max-[20rem]:text-left">
            {value}
          </span>
        ) : null}
      </span>
      {trailing}
      {chevron ? (
        <ChevronRightIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={cn(ROW, "pressable active:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", className)}
        onClick={onClick}
        {...(rest as JSX.IntrinsicElements["button"])}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={cn(ROW, className)} {...(rest as JSX.IntrinsicElements["div"])}>
      {body}
    </div>
  );
}

/**
 * Centred alert for destructive confirmations. Replaces the shadcn dialog
 * card that sat over the sheet's rows at a 10% scrim, so the rows behind
 * read through and it looked like one more card in the list. Portalled after
 * the sheet, so at the same z-50 it (and its forced scrim) paints above it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  variant = "alert",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** "panel" = a left-aligned focused task (forms), not a yes/no alert. */
  variant?: "alert" | "panel";
}): JSX.Element {
  const panel = variant === "panel";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* forceRender: base-ui skips the backdrop of a dialog nested in
            another (the sheet), which left the sheet rows undimmed. */}
        <DialogPrimitive.Backdrop forceRender className="fixed inset-0 z-50 bg-black/60 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
        <DialogPrimitive.Popup
          role={panel ? "dialog" : "alertdialog"}
          // M3 basic dialog: 28dp corners, 24dp padding, start-aligned
          // headline and supporting text. Centred text read as an iOS alert.
          // Buttons stay stacked full-width so long labels survive 150% text.
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-y-auto rounded-[calc(1.75rem*var(--radius-scale,1))] bg-surface-2 p-6 text-left text-foreground shadow-[var(--shadow-float)] outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none",
            panel ? "w-[min(22rem,calc(100vw-2rem))]" : "w-[min(20rem,calc(100vw-3rem))]",
          )}
        >
          <div className="flex flex-col gap-2">
            <DialogPrimitive.Title className="text-title font-semibold break-words">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-meta leading-relaxed text-muted-foreground">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          {children}
          {actions ? <div className="flex flex-col gap-2">{actions}</div> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}

/** Stacked full-width alert buttons. */
const ALERT_BUTTON =
  "pressable press-bounce inline-flex h-12 w-full items-center justify-center gap-2 rounded-full text-ui font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_svg]:size-4";
export const ALERT_DESTRUCTIVE = `${ALERT_BUTTON} bg-danger text-danger-foreground`;
export const ALERT_CANCEL = `${ALERT_BUTTON} bg-surface-3 text-foreground`;
export const ALERT_PRIMARY = `${ALERT_BUTTON} bg-primary text-primary-foreground`;
