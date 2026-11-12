import { memo, useId, useMemo } from "react";
import type { JSX, ReactNode } from "react";
import { MonitorIcon, PinIcon } from "lucide-react";

import { useAppearance } from "@/platform/appearance";
import { cn } from "@/lib/utils";

import type { OmpSessionSummary } from "../../domain/protocol";
import { clockTime } from "../clock-time";
import { ROW_ACTIONS_HINT, useLongPress, useRowActionsTrigger } from "../hooks/use-long-press";
import { activeTime, identityHint, markSeen, relativeTime, sessionInterruption, sessionTitle } from "../session-format";
import { STATUS_LABEL, sessionStatus } from "../session-status";
import { PluginNodeView } from "../plugins/NodeView";
import { toPluginSession } from "../plugins/session-info";
import { usePluginKey } from "../plugins/use-plugin-host";
/** A 10px state dot: amber for a question waiting, the accent for unread. */
const DOT = "size-2.5 shrink-0 rounded-full";

/** Marks every case-insensitive occurrence of `query` in `text`. */
export function markMatches(text: string, query: string | undefined): ReactNode {
  const needle = query?.trim().toLowerCase();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark key={at} className="bg-transparent font-semibold text-foreground">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (out.length === 0) return text;
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/**
 * One conversation in the session drawer: a plain 48px title row on an inset
 * rounded pill, the open one filled. Live state is a trailing indicator.
 * Holding the row asks the drawer for its actions menu, anchored on this row.
 */
export const DrawerSessionRow = memo(function DrawerSessionRow({
  session,
  awaiting,
  selected,
  pinned,
  ambiguousTitle,
  highlight,
  raised,
  onOpen,
  onActions,
}: {
  session: OmpSessionSummary;
  awaiting?: ReadonlySet<string>;
  selected: boolean;
  pinned: boolean;
  /** Another loaded session has the same title: show a short identity hint. */
  ambiguousTitle: boolean;
  /** Active search query to mark inside the title. */
  highlight?: string;
  /** This row's actions menu is open: it lifts above the scrim instead of dimming with it. */
  raised: boolean;
  onOpen: (path: string) => void;
  onActions: (session: OmpSessionSummary, row: HTMLElement) => void;
}): JSX.Element {
  const { sessionTime } = useAppearance();
  const longPress = useLongPress();
  const rowMenu = useRowActionsTrigger(longPress, (row) => onActions(session, row));
  const hintId = useId();
  const state = sessionStatus(session, awaiting);
  const title = sessionTitle(session);
  const interrupted = state !== "needs-you" && sessionInterruption(session) !== null;
  const at = activeTime(session);
  const showsMeta = state !== "working" && state !== "needs-you";
  const pluginContext = useMemo(() => ({ session: toPluginSession(session) }), [session]);
  const pluginChips = usePluginKey("session.row", showsMeta ? session.path : null, pluginContext);
  const hasPluginChips = showsMeta && pluginChips.views.length > 0;
  const rowButton = (
    <button
      type="button"
      data-testid="session-row"
      data-session-path={session.path}
      data-state={state}
      aria-current={selected ? "true" : undefined}
      aria-label={[title, state === "idle" ? null : STATUS_LABEL[state], interrupted ? "Interrupted" : null].filter(Boolean).join(", ")}
      aria-haspopup="menu"
      aria-describedby={hintId}
      onContextMenu={rowMenu.onContextMenu}
      onKeyDown={rowMenu.onKeyDown}
      onPointerDown={(event) => {
        const row = hasPluginChips ? (event.currentTarget.parentElement ?? event.currentTarget) : event.currentTarget;
        longPress.onPointerDown(event, () => onActions(session, row));
      }}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onPointerLeave={longPress.onPointerLeave}
      onClick={() => {
        if (longPress.shouldSuppressClick()) {
          longPress.consumeFired();
          return;
        }
        markSeen(session.path, session.revision);
        onOpen(session.path);
      }}
      className={
        hasPluginChips
          ? "min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
          : cn(
              "pressable mx-3 my-0.5 flex min-h-12 w-[calc(100%-1.5rem)] items-center gap-3 rounded-xl px-4 text-left outline-none transition-colors duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              selected ? "bg-surface-3" : "active:bg-surface-2",
              raised && "relative z-20 bg-surface-2",
            )
      }
    >
      <span id={hintId} className="sr-only">{ROW_ACTIONS_HINT}</span>
      <span data-testid="session-title" className="min-w-0 flex-1 truncate text-body text-foreground">
        {markMatches(title, highlight)}
      </span>
      {!hasPluginChips ? (
        <>
          {ambiguousTitle ? (
            <span data-testid="session-identity" title={session.path} className="shrink-0 text-caption text-muted-foreground">{identityHint(session)}</span>
          ) : null}
          {sessionTime !== "hidden" && at > 0 ? (
            <span data-testid="session-time" className="shrink-0 text-caption tabular-nums text-muted-foreground">
              {sessionTime === "clock" ? clockTime(at) : relativeTime(at)}
            </span>
          ) : null}
          {pinned ? <PinIcon aria-hidden data-testid="pin-glyph" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
          {state === "working" ? (
            <span data-testid="running-ring" data-slot="session-status" data-state="working" className="size-4 shrink-0 rounded-full border-2 border-running/25 border-t-running motion-safe:animate-[spin_0.9s_linear_infinite] motion-reduce:border-running" />
          ) : state === "needs-you" ? (
            <span aria-hidden data-slot="session-status" data-state="needs-you" className={cn(DOT, "bg-dot-warning")} />
          ) : state === "unread" ? (
            <span aria-hidden data-slot="session-status" data-state="unread" className={cn(DOT, "bg-primary")} />
          ) : state === "idle" ? null : (
            <MonitorIcon aria-hidden data-testid="session-on-computer" data-slot="session-status" data-state="on-computer" className="size-4 shrink-0 text-muted-foreground" />
          )}
        </>
      ) : null}
    </button>
  );
  if (!hasPluginChips) return rowButton;
  return (
    <div
      className={cn(
        "pressable relative mx-3 my-0.5 flex min-h-12 w-[calc(100%-1.5rem)] items-center gap-3 rounded-xl px-4 text-left transition-colors duration-[var(--dur-fast)]",
        selected ? "bg-surface-3" : "active:bg-surface-2",
        raised && "z-20 bg-surface-2",
      )}
    >
      {rowButton}
      <span
        data-testid="plugin-row-badges"
        data-session={session.path}
        className="pointer-events-none relative z-10 flex max-w-[8rem] shrink-0 items-center gap-1 overflow-x-clip [&_[data-testid=plugin-chip]]:h-5 [&_[data-testid=plugin-chip]]:px-2 [&_button]:pointer-events-auto"
      >
        {pluginChips.views.map((entry) => (
          <span key={entry.pluginId} data-plugin={entry.pluginId} className="flex min-w-0 shrink items-center gap-1 overflow-x-clip">
            <PluginNodeView node={entry.view} onAction={(action, item) => pluginChips.onAction(entry.pluginId, action, item)} />
          </span>
        ))}
      </span>
      {ambiguousTitle ? (
        <span data-testid="session-identity" title={session.path} className="shrink-0 text-caption text-muted-foreground">{identityHint(session)}</span>
      ) : null}
      {sessionTime !== "hidden" && at > 0 ? (
        <span data-testid="session-time" className="shrink-0 text-caption tabular-nums text-muted-foreground">
          {sessionTime === "clock" ? clockTime(at) : relativeTime(at)}
        </span>
      ) : null}
      {pinned ? <PinIcon aria-hidden data-testid="pin-glyph" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      {state === "unread" ? (
        <span aria-hidden data-slot="session-status" data-state="unread" className={cn(DOT, "bg-primary")} />
      ) : state === "idle" ? null : (
        <MonitorIcon aria-hidden data-testid="session-on-computer" data-slot="session-status" data-state="on-computer" className="size-4 shrink-0 text-muted-foreground" />
      )}
    </div>
  );
});
