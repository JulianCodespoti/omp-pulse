import { ChevronRightIcon } from "lucide-react";
import type { JSX, MouseEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";

type RowOwnProps = {
  /** 20px slot; an icon or a status glyph. Icons are sized to 20 here. */
  leading?: ReactNode;
  /** `tile`: 36px leading tile (agent/provider rows); `sm-tile`: 32px tile (sheet rows). */
  leadingSize?: "icon" | "tile" | "sm-tile";
  title: ReactNode;
  subtitle?: ReactNode;
  /** Value text or a control (switch, select, button). */
  trailing?: ReactNode;
  chevron?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Danger-tinted title and leading icon, for an action that destroys. */
  destructive?: boolean;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  testId?: string;
};

/**
 * Rounded leading icon/logo container used inside bordered cards so provider
 * marks, command icons, and action glyphs sit in a crisp framed badge.
 */
export function RowTile({
  size = "sm",
  tone = "sheet",
  className,
  children,
}: {
  size?: "sm" | "md";
  /** `sheet` sits inside a surface-2 card; `page` sits inside a surface-1 card. */
  tone?: "sheet" | "page";
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border border-hairline",
        size === "md" ? "size-9" : "size-8 [&_svg:not([class*='size-'])]:size-4",
        tone === "page" ? "bg-surface-2" : "bg-surface-3/70",
        className,
      )}
    >
      {children}
    </span>
  );
}

// Everything else an element accepts (aria-*, data-*, pointer handlers for
// long-press rows) passes through to the row element.
type PassThrough = Omit<JSX.IntrinsicElements["button"], keyof RowOwnProps | "children" | "type">;
export type RowProps = RowOwnProps & PassThrough;

/**
 * The one list row. A row is text on the canvas, never a box: 16px inset,
 * 12px gap, 48px tall (56 with a subtitle), and a surface fill on press
 * rather than a scale (scaling a full-width row reads as the page wobbling).
 * With `onClick` the whole row is the button; otherwise it is static and
 * `trailing` carries its own control.
 *
 * The divider lives on the text column (`data-slot=row-body`), so inside a
 * RowGroup hairlines start where the title starts, past the leading icon.
 */
export function Row({
  leading,
  leadingSize = "icon",
  title,
  subtitle,
  trailing,
  chevron,
  onClick,
  destructive,
  selected,
  disabled,
  className,
  testId,
  ...rest
}: RowProps): JSX.Element {
  const body = (
    <>
      {/* No leading, no slot: an empty 20px gutter pushed every title 32px
          off the 16px line the headers sit on. On rows with a subtitle the
          glyph sits level with the title's first line, not the row's centre. */}
      {leading !== undefined && leading !== null && leading !== false ? (
        <span
          data-slot="row-leading"
          className={cn(
            "flex shrink-0 items-center justify-center",
            leadingSize === "tile"
              ? "size-9 self-center"
              : leadingSize === "sm-tile"
                ? "size-8 self-center"
                : cn("size-5 [&_svg:not([class*='size-'])]:size-5", subtitle ? "mt-2.5 self-start" : "self-center"),
            destructive ? "text-danger" : "text-muted-foreground",
          )}
        >
          {leading}
        </span>
      ) : null}
      <span
        data-slot="row-body"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3 self-stretch border-hairline py-2.5 pr-4",
          subtitle ? "min-h-14" : "min-h-12",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "line-clamp-2 min-w-0 break-words text-ui [overflow-wrap:anywhere]",
              destructive ? "text-danger" : "text-foreground",
            )}
          >
            {title}
          </span>
          {subtitle ? (
            <span className="line-clamp-2 min-w-0 break-words text-meta text-muted-foreground [overflow-wrap:anywhere]">
              {subtitle}
            </span>
          ) : null}
        </span>
        {trailing !== undefined && trailing !== null && trailing !== false ? (
          <span
            data-slot="row-trailing"
            className="flex min-w-0 max-w-[60%] shrink-0 items-center justify-end gap-1 text-right text-meta text-muted-foreground"
          >
            {trailing}
          </span>
        ) : null}
        {chevron ? (
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-tertiary" />
        ) : null}
      </span>
    </>
  );
  const cls = cn(
    "relative flex w-full min-w-0 items-center gap-3 pl-4 text-left outline-none [-webkit-tap-highlight-color:transparent]",
    selected && "bg-surface-3",
    disabled && "opacity-50",
    className,
  );
  if (onClick) {
    return (
      <button
        type="button"
        data-slot="row"
        data-testid={testId}
        aria-current={selected ? "true" : undefined}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          cls,
          "pressable focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none",
        )}
        {...rest}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      data-slot="row"
      data-testid={testId}
      aria-disabled={disabled || undefined}
      className={cls}
      {...(rest as JSX.IntrinsicElements["div"])}
    >
      {body}
    </div>
  );
}

/**
 * A titled run of rows. Flat by default: the group bleeds out of the 16px
 * content gutter it sits in (sheet body, screen content) so the press fill
 * reaches both edges while titles and row text stay on the gutter line.
 * `inset` draws a rounded bordered card: `true` uses surface-1 (for groups on
 * the page background), `"sheet"` uses surface-2 (for elevated cards inside a
 * surface-1 BottomSheet).
 *
 * Hairlines separate rows only (no inner top/bottom rule). A child that is not
 * a Row gets a full-width hairline instead.
 */
export function RowGroup({
  title,
  footer,
  inset = false,
  headingId,
  children,
  className,
  testId,
  ...rest
}: {
  title?: ReactNode;
  footer?: ReactNode;
  inset?: boolean | "sheet";
  headingId?: string;
  children: ReactNode;
  className?: string;
  testId?: string;
} & Omit<JSX.IntrinsicElements["section"], "title" | "children">): JSX.Element {
  const isCard = inset === true || inset === "sheet";
  return (
    <section
      data-slot="row-group"
      // A group that scrolls out of its container skips style, layout and
      // paint entirely (content-visibility), which is what makes a 40-row
      // sheet or a long Settings page cost only its visible part to mount.
      // `auto` in contain-intrinsic-size remembers the real height after the
      // first layout, so the scrollbar is right once a group has been seen.
      className={cn(
        "flex min-w-0 flex-col [content-visibility:auto] [contain-intrinsic-size:auto_240px]",
        isCard ? "mx-0" : "-mx-4",
        className,
      )}
      {...rest}
    >
      {title ? (
        <h2
          id={headingId}
          className={cn(
            "pb-1.5 text-meta font-medium text-muted-foreground",
            isCard ? "px-1" : "px-4",
          )}
        >
          {title}
        </h2>
      ) : null}
      <div
        data-testid={testId}
        className={cn(
          "flex min-w-0 flex-col",
          "[&>[data-slot=row]:not(:last-child)>[data-slot=row-body]]:border-b",
          "[&>:not([data-slot=row]):not(:last-child)]:border-b [&>:not([data-slot=row])]:border-hairline",
          inset === true && "overflow-hidden rounded-lg border border-hairline bg-surface-1",
          inset === "sheet" && "overflow-hidden rounded-lg border border-hairline bg-surface-2",
        )}
      >
        {children}
      </div>
      {footer ? (
        <div className={cn("pt-1.5 text-meta text-muted-foreground", isCard ? "px-1" : "px-4")}>{footer}</div>
      ) : null}
    </section>
  );
}

/** Placeholder for a row whose data is loading. Static: no pulse. */
export function RowSkeleton({
  leading = false,
  subtitle = false,
}: {
  leading?: boolean | "tile";
  subtitle?: boolean;
}): JSX.Element {
  return (
    <div data-slot="row" aria-hidden className="flex w-full items-center gap-3 pl-4">
      {leading === "tile" ? (
        <span className="size-9 shrink-0 rounded-md bg-surface-2" />
      ) : leading ? (
        <span className="size-5 shrink-0 rounded-full bg-surface-2" />
      ) : null}
      <span
        data-slot="row-body"
        className={cn(
          "flex min-w-0 flex-1 flex-col justify-center gap-1.5 border-hairline py-2.5 pr-4",
          subtitle ? "min-h-14" : "min-h-12",
        )}
      >
        <span className="h-3.5 w-2/5 rounded-sm bg-surface-2" />
        {subtitle ? <span className="h-3 w-3/5 rounded-sm bg-surface-2" /> : null}
      </span>
    </div>
  );
}
