import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi } from "@/runtime/rpc-client";
import { showToast } from "../Notices";
import { getOpenConversation } from "../nav/open-conversation";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { pendingDeletes, UNDO_WINDOW_MS } from "./pending-delete";

/**
 * Delete through omp's own `/session delete` after a short Undo window. The
 * daemon refuses (and nothing is touched) while the desktop or any other
 * process may write the conversation, or while the agent is still working in
 * it; the row then comes back with that reason.
 */
export function deleteSessionWithUndo(session: { path: string; title: string }, onDeleted: () => void): void {
  const { path, title } = session;
  // Leave first: a chat left open on a conversation that is about to vanish
  // would keep sending into a file the delete then removes.
  const open = getOpenConversation();
  const wasOpen = open?.path === path;
  if (wasOpen) open.leave();
  pendingDeletes.schedule(
    path,
    async () => {
      await new DaemonApi(readPairingToken() ?? "").deleteSession(path);
      onDeleted();
    },
    // Name the conversation: the row comes back, and a bare reason does not say which.
    (cause) => showToast(`${title}: ${humanizeDaemonError(cause)}`, "error"),
  );
  showToast(
    "Conversation deleted",
    "info",
    {
      label: "Undo",
      onClick: () => {
        // A closed window means the delete already ran; silence read as a broken button.
        if (!pendingDeletes.undo(path)) showToast("Already deleted", "info");
        else if (wasOpen) open.reopen(path);
      },
    },
    { kind: "undo", durationMs: UNDO_WINDOW_MS },
  );
}
