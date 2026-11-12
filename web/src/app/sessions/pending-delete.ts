import { useSyncExternalStore } from "react";

export const UNDO_WINDOW_MS = 5000;

export interface DeleteTimers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: DeleteTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Entry {
  timer: unknown;
  remove: () => Promise<unknown>;
  onFail: (cause: unknown) => void;
}

/**
 * Deletes the owner can still take back. The daemon delete cannot be undone,
 * so it is held back for the undo window and the lists hide the row meanwhile.
 * A path stays hidden after the delete succeeds: the listing a list holds may
 * still carry it until its next refresh, and a deleted file never comes back.
 */
export function createPendingDeletes(delayMs = UNDO_WINDOW_MS, timers: DeleteTimers = realTimers) {
  const entries = new Map<string, Entry>();
  let hidden: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();

  const setHidden = (next: Set<string>): void => {
    hidden = next;
    for (const listener of listeners) listener();
  };
  const unhide = (path: string): void => {
    const next = new Set(hidden);
    next.delete(path);
    setHidden(next);
  };

  const expire = (path: string): void => {
    const entry = entries.get(path);
    if (!entry) return;
    entries.delete(path);
    timers.clear(entry.timer);
    // A refused delete (the computer still owns the session) puts the row back.
    entry.remove().catch((cause: unknown) => {
      unhide(path);
      entry.onFail(cause);
    });
  };

  return {
    /** Hide `path` now and run `remove` after the undo window. */
    schedule(path: string, remove: () => Promise<unknown>, onFail: (cause: unknown) => void): void {
      if (hidden.has(path)) return;
      setHidden(new Set(hidden).add(path));
      entries.set(path, { timer: timers.set(() => expire(path), delayMs), remove, onFail });
    },
    /** Take the delete back. False once the window has closed. */
    undo(path: string): boolean {
      const entry = entries.get(path);
      if (!entry) return false;
      timers.clear(entry.timer);
      entries.delete(path);
      unhide(path);
      return true;
    },
    /** Run every waiting delete now (the page is going away). */
    flush(): void {
      for (const path of [...entries.keys()]) expire(path);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    hiddenPaths: (): ReadonlySet<string> => hidden,
  };
}

export const pendingDeletes = createPendingDeletes();

// Best effort: a closed app may not finish the request, but a reply that
// already left the page is more likely to land than one still on a timer.
// A swiped-away Android WebView often never fires pagehide, so the delete
// never ran and the row came back on the next launch; hidden fires first.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => pendingDeletes.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") pendingDeletes.flush();
  });
}

/** Paths of sessions the owner deleted that every list must leave out. */
export function useDeletedPaths(): ReadonlySet<string> {
  return useSyncExternalStore(pendingDeletes.subscribe, pendingDeletes.hiddenPaths, pendingDeletes.hiddenPaths);
}
