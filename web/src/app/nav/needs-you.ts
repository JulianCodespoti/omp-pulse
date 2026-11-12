import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { sessionStatus } from "../session-status";
import { useStoreValue } from "../store-hooks";

/**
 * How many chats other than the open one are waiting on the user. Counted from
 * the store's session listing with the same status the drawer rows and the
 * Sessions list use, so the ≡ dot and the drawer's "Needs you" never disagree.
 * Returns a number so the selector is a stable primitive for the subscription.
 */
export function useNeedsYouElsewhere(controller: OmpSessionController, currentPath: string | null): number {
  return useStoreValue(controller.getStore(), (state) =>
    state.sessions.reduce((n, session) => n + (session.path !== currentPath && sessionStatus(session) === "needs-you" ? 1 : 0), 0));
}
