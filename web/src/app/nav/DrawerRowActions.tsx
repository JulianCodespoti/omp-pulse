import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useScrimDismiss } from "@/app/hooks/use-scrim-dismiss";
import type { JSX } from "react";
import { CopyPlusIcon, EllipsisIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";

import { sessionTurn, type OmpSessionSummary } from "../../domain/protocol";
import { readPairingToken } from "../../platform/browser-storage";
import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { selectSessionCapability } from "../../runtime/omp-store";
import { DaemonApi } from "../../runtime/rpc-client";
import { useBackLayer } from "../back-layer";
import { getDraftNamespace } from "../composer/use-draft";
import { restoreWithdrawnDraft } from "../composer/withdrawn-draft";
import { showToast } from "../Notices";
import { deleteSessionWithUndo } from "../sessions/delete-session";
import { isOnLaptop, isPinned, sessionTitle, togglePin } from "../session-format";
import { LazyMount } from "../ui/LazyMount";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { retryableLazy as lazy } from "../ui/retryable-lazy";
// Code-split like the Sessions list: the full action sheet loads on first use.
const LazySessionActionsSheet = lazy(async () => {
  const module = await import("../sessions/SessionActionsSheet");
  return { default: module.SessionActionsSheet };
});

const EDGE = 8;
const GAP = 4;

export interface RowActionsTarget {
  session: OmpSessionSummary;
  row: HTMLElement;
}

const item =
  "flex min-h-12 w-full items-center gap-3 px-4 py-1 text-left text-body outline-none active:bg-surface-3 focus-visible:bg-surface-3 disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/**
 * A held drawer row's floating menu (the message menu's look: a card with
 * 48px rows over a scrim) and what its items open. Rename, Pin, Duplicate and
 * Delete (hide now, Undo for a few seconds) use the words and relative order
 * of the Sessions list's action sheet and the chat's ⋯ menu; More opens that
 * sheet, so every session action stays reachable and behaves exactly as there.
 *
 * Rendered inside the drawer rather than portalled: the drawer is a modal
 * dialog, and a layer outside it would be inert.
 */
export function DrawerRowActions({
  target,
  root,
  sessions,
  controller,
  onClose,
  onChanged,
  onOpen,
}: {
  target: RowActionsTarget | null;
  /** The drawer's positioned root: the menu and scrim live in it. */
  root: HTMLElement | null;
  sessions: readonly OmpSessionSummary[];
  controller?: OmpSessionController;
  onClose: () => void;
  /** A session changed on the computer: refresh the listing. */
  onChanged: () => void;
  /** Open a session the way a row tap does (a fresh duplicate). */
  onOpen: (path: string) => void;
}): JSX.Element {
  const [sheet, setSheet] = useState<{ session: OmpSessionSummary; rename: boolean } | null>(null);
  const [top, setTop] = useState<number | null>(null);
  // The position lands in a layout effect, i.e. in the same paint it mounts in;
  // a CSS transition needs one frame at the start state to run at all.
  const [shown, setShown] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = target !== null;

  // System Back and Escape close the menu before the drawer behind it.
  useBackLayer(open, { onBack: onClose });

  // Under the pressed row, above it near the bottom; always inside the drawer.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!target || !root || !menu) { setTop(null); return; }
    const bounds = root.getBoundingClientRect();
    const rect = target.row.getBoundingClientRect();
    const below = rect.bottom - bounds.top + GAP;
    const fits = below + menu.offsetHeight <= bounds.height - EDGE;
    setTop(Math.max(EDGE, fits ? below : rect.top - bounds.top - GAP - menu.offsetHeight));
  }, [target, root]);

  useLayoutEffect(() => {
    if (!open || top === null) { setShown(false); return; }
    const frame = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(frame);
  }, [open, top]);

  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [open]);

  const session = target?.session ?? null;
  const pinned = session ? isPinned(session.path) : false;
  const working = session ? sessionTurn(session) === "running" : false;

  const duplicate = async (source: OmpSessionSummary): Promise<void> => {
    // The menu has already closed: without this a slow fork looks like a dead tap.
    showToast("Duplicating…");
    try {
      const result = await new DaemonApi(readPairingToken() ?? "").fork(source.path);
      if (result.cancelled) showToast("omp kept this conversation as it was.");
      else {
        showToast("Duplicated, opening the copy");
        onChanged();
        onOpen(result.sessionPath);
      }
    } catch (error: unknown) {
      showToast(humanizeDaemonError(error), "error");
    }
  };

  const scrim = useScrimDismiss(onClose);
  const items = session ? [
    { key: "rename", testId: "drawer-action-rename", icon: <PencilIcon aria-hidden />, label: "Rename", run: () => setSheet({ session, rename: true }) },
    {
      key: "pin",
      testId: "drawer-action-pin",
      icon: pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />,
      label: pinned ? "Unpin" : "Pin",
      // The row moving is the feedback; a toast only repeated it.
      run: () => togglePin(session.path),
    },
    { key: "duplicate", testId: "drawer-action-duplicate", icon: <CopyPlusIcon aria-hidden />, label: "Duplicate", run: () => void duplicate(session) },
    // A session open on the computer is closed there first (the sheet explains); a working one cannot be deleted.
    ...(isOnLaptop(session) ? [] : [{
      key: "delete", testId: "drawer-action-delete", icon: <Trash2Icon aria-hidden />, label: "Delete", disabled: working, hint: working ? "Available when the reply finishes" : undefined, run: () => deleteSessionWithUndo({ path: session.path, title: sessionTitle(session) }, onChanged),
    }]),
    { key: "more", testId: "drawer-action-more", icon: <EllipsisIcon aria-hidden />, label: "More…", run: () => setSheet({ session, rename: false }) },
  ] : [];

  const sheetSession = sheet ? sessions.find((candidate) => candidate.path === sheet.session.path) ?? sheet.session : null;
  const store = controller?.getStore();
  const stopCapability = useSyncExternalStore(
    store ? store.subscribe : () => () => {},
    () => (store && sheetSession ? selectSessionCapability(store.getState(), sheetSession.path, "stop") : null),
    () => (store && sheetSession ? selectSessionCapability(store.getState(), sheetSession.path, "stop") : null),
  );
  const stopAction = controller
    ? {
        run: (path: string) =>
          controller.abortTurn(path, async (withdrawn, destination) => {
            const notice = await restoreWithdrawnDraft(destination.sessionPath, withdrawn, destination.namespace);
            if (notice && getDraftNamespace() === destination.namespace) showToast(notice);
          }),
        capability: stopCapability,
      }
    : undefined;
  return (
    <>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            data-testid="drawer-actions-scrim"
            {...scrim}
            className="absolute inset-0 z-10 cursor-default touch-none bg-black/50 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none"
          />
          <div
            ref={menuRef}
            data-testid="drawer-actions"
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
            className={cn(
              // The message menu's own numbers: it pops from the row at 0.95 with a fast fade,
              // so the same gesture feels the same everywhere.
              "absolute left-4 z-10 w-64 max-w-[calc(100%-2rem)] origin-top overflow-hidden rounded-xl bg-surface-2 text-foreground shadow-[var(--shadow-float)] ring-1 ring-white/10 transition-[opacity,transform] duration-150 motion-reduce:transition-none",
              top === null ? "invisible" : shown ? "scale-100 opacity-100" : "scale-95 opacity-0",
            )}
            style={{ top: top ?? 0 }}
          >
            {session ? <p className="truncate px-4 pb-1 pt-3 text-caption text-muted-foreground">{sessionTitle(session)}</p> : null}
            <div role="menu" aria-label="Session actions" className="py-1">
              {items.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="menuitem"
                  data-testid={entry.testId}
                  disabled={"disabled" in entry ? entry.disabled : false}
                  onClick={() => { onClose(); entry.run(); }}
                  className={item}
                >
                  {entry.icon}
                  <span className="min-w-0">
                    <span className="block truncate">{entry.label}</span>
                    {"hint" in entry && entry.hint ? <span className="block truncate text-caption text-muted-foreground">{entry.hint}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
      <LazyMount open={sheet !== null} onClose={() => setSheet(null)}>
        <LazySessionActionsSheet
          session={sheetSession}
          startRenaming={sheet?.rename ?? false}
          onOpenChange={(next) => { if (!next) setSheet(null); }}
          onChanged={onChanged}
          onOpenSession={onOpen}
          stop={stopAction}
        />
      </LazyMount>
    </>
  );
}
