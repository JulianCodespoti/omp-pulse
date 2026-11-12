import { flushSync } from "react-dom";
import { prefersReducedMotion } from "../../platform/appearance";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

/**
 * Change screens as a native stack does: a screen slides in over the one
 * below (push) and back out to reveal it (pop). The list -> chat step and the
 * pushed Settings / New session screens share this motion. The View
 * Transitions API snapshots both states, so the live DOM never carries a
 * transform (a transform would become the containing block for the screens'
 * fixed headers and composer). `flushSync` is load-bearing: the API captures
 * the new state when the callback returns, and a batched React update would
 * not have rendered yet, so the "new" snapshot would be the old screen
 * sliding over itself.
 */
export function navigate(direction: "push" | "pop", update: () => void): void {
  if (typeof document === "undefined") {
    update();
    return;
  }
  const doc = document as ViewTransitionDocument;
  if (
    typeof doc.startViewTransition !== "function" ||
    document.visibilityState !== "visible" ||
    prefersReducedMotion()
  ) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.nav = direction;
  let applied = false;
  const apply = () => {
    if (applied) return;
    applied = true;
    update();
  };
  try {
    const transition = doc.startViewTransition(() => {
      if (applied) return;
      applied = true;
      flushSync(update);
    });
    // The callback runs at the next rendering opportunity, and a tab that is
    // producing no frames (headless, occluded, or a capture still running over
    // a huge transcript) never gets one: the screen then never changed and the
    // marker below never cleared, so every later navigation queued behind it.
    // Apply anyway after a frame's worth of time; set() dedupes the late one.
    window.setTimeout(() => {
      if (applied) return;
      apply();
      if (root.dataset.nav === direction) delete root.dataset.nav;
    }, 300);
    // A transition skipped for a newer one rejects `ready` (AbortError) while the update still ran: not a
    // failure, and unhandled it surfaced as a page error ("Transition was skipped", verify-nav-paging).
    transition.ready.catch(() => {});
    transition.finished.catch(() => {}).finally(() => {
      if (root.dataset.nav === direction) delete root.dataset.nav;
    });
  } catch {
    delete root.dataset.nav;
    update();
  }
}
