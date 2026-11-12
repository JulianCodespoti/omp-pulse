import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type PillTone = "info" | "success" | "warn" | "error";

// The tone lives in the chip, never in the pill: a solid red or amber slab
// shouted over the transcript for what is usually a transient hiccup. The
// chip is the status colour at about 15% with the glyph in full colour.
const TONE: Record<PillTone, { Icon: LucideIcon; chip: string }> = {
  info: { Icon: InfoIcon, chip: "bg-foreground/10 text-muted-foreground" },
  success: { Icon: CircleCheckIcon, chip: "bg-success/15 text-success" },
  warn: { Icon: TriangleAlertIcon, chip: "bg-warning/15 text-warning" },
  error: { Icon: CircleAlertIcon, chip: "bg-danger/15 text-danger" },
};

const FOCUS = "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/**
 * A line along the bottom edge that drains over the notice's real lifetime
 * (how long an Undo remains). Driven by one linear transition from where the
 * clock already is, so a re-render or a remount mid-window does not restart it.
 */
function DrainLine({ startedAt, durationMs }: { startedAt: number; durationMs: number }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const left = Math.max(0, durationMs - (performance.now() - startedAt));
    el.style.transition = "none";
    el.style.transform = `scaleX(${durationMs > 0 ? left / durationMs : 0})`;
    void el.offsetWidth; // commit the start value so the transition has something to run from
    el.style.transition = `transform ${left}ms linear`;
    el.style.transform = "scaleX(0)";
  }, [startedAt, durationMs]);
  return <span ref={ref} aria-hidden data-slot="notice-progress" className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-foreground/25" />;
}

/**
 * The one floating notice: toasts, the banner and the chat's connection
 * indicator all render it. Anatomy, left to right: a 28px tone chip, the text
 * (optional title line, body clamped at two lines), an optional action and an
 * optional dismiss. Fully opaque: a translucent blur let the transcript show
 * through the text.
 */
export function NoticePill({
  tone,
  icon,
  title,
  children,
  action,
  actionStyle = "text",
  onDismiss,
  onBodyClick,
  progress,
  role,
  className,
  testId,
  data,
}: {
  tone: PillTone;
  /** Default: the tone's glyph. "spinner" shows the shared Spinner. */
  icon?: LucideIcon | "spinner";
  title?: ReactNode;
  children: ReactNode;
  action?: { label: string; onClick: () => void; icon?: LucideIcon; testId?: string };
  /** "text" (default) is an accent text button; "filled" is the small primary Button (banners). */
  actionStyle?: "text" | "filled";
  /** Renders a dismiss button. Only for notices that do not expire by themselves. */
  onDismiss?: () => void;
  /** With an `action` it runs on a tap anywhere on the pill; without one, a clamped body expands first. */
  onBodyClick?: () => void;
  /** A draining line along the bottom edge: how long an Undo remains. `startedAt` is a `performance.now()` time. */
  progress?: { startedAt: number; durationMs: number };
  role?: "status" | "alert";
  className?: string;
  testId?: string;
  /** Extra data-* attributes on the pill, for tests and styling hooks. */
  data?: Record<`data-${string}`, string>;
}): JSX.Element {
  const { Icon: ToneGlyph, chip } = TONE[tone];
  const Glyph = icon === undefined ? ToneGlyph : icon;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // The clamp hides the rest of a long message, and `title=` is unreachable by
  // touch, so a tap on a clamped body expands it in place (and it stays open).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, expanded]);

  const tap = () => {
    if (action && onBodyClick) { onBodyClick(); return; }
    if (clamped && !expanded) { setExpanded(true); return; }
    onBodyClick?.();
  };
  const interactive = Boolean(onBodyClick) || (clamped && !expanded);

  return (
    <div
      role={role ?? (tone === "warn" || tone === "error" ? "alert" : "status")}
      data-slot="notice-pill"
      data-tone={tone}
      data-testid={testId}
      {...data}
      onClick={tap}
      className={cn(
        "relative flex min-h-12 w-fit max-w-full min-w-0 items-center gap-3 overflow-hidden rounded-xl bg-surface-2 py-2 pl-2.5 text-foreground shadow-[var(--shadow-float)]",
        action || onDismiss ? "pr-2" : "pr-3",
        interactive && "cursor-pointer",
        className,
      )}
    >
      <span aria-hidden className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", chip)}>
        {Glyph === "spinner" ? <Spinner size={16} label={null} /> : <Glyph className="size-4" strokeWidth={2} />}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <div className="truncate text-ui font-medium text-foreground">{title}</div> : null}
        <div
          ref={bodyRef}
          className={cn(
            "break-words [overflow-wrap:anywhere]",
            title ? "text-meta text-muted-foreground" : "text-ui text-foreground",
            !expanded && "line-clamp-2",
          )}
        >
          {children}
        </div>
      </div>
      {action ? (
        actionStyle === "filled" ? (
          <Button
            variant="primary"
            size="sm"
            data-testid={action.testId}
            className="max-w-[45%] shrink-0 truncate"
            onClick={(event) => { event.stopPropagation(); action.onClick(); }}
          >
            {action.icon ? <action.icon aria-hidden /> : null}
            {action.label}
          </Button>
        ) : (
          <button
            type="button"
            data-testid={action.testId}
            className={cn("-my-2 flex min-h-11 max-w-[50%] shrink-0 items-center gap-2 rounded-full px-3 text-ui font-medium text-primary-text active:bg-surface-3", FOCUS)}
            onClick={(event) => { event.stopPropagation(); action.onClick(); }}
          >
            {action.icon ? <action.icon aria-hidden className="size-4 shrink-0" /> : null}
            <span className="truncate">{action.label}</span>
          </button>
        )
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss notification"
          className={cn("-my-2 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground", FOCUS)}
          onClick={(event) => { event.stopPropagation(); onDismiss(); }}
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      ) : null}
      {progress ? <DrainLine key={progress.startedAt} startedAt={progress.startedAt} durationMs={progress.durationMs} /> : null}
    </div>
  );
}
