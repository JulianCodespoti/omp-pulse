import type { WithdrawnQueue } from "../../runtime/withdrawn-queue";
import { getAttachmentDraft } from "../../runtime/attachment-draft";
import { getDraftNamespace, removedDraftImages, restoreSavedDraft } from "./use-draft";

/** Route through the session owner, not whichever Composer happens to be mounted
 * when an asynchronous queue withdrawal finishes. Persistence errors propagate;
 * the owner keeps unsaved bytes and exposes the failure in its tray. */
export async function restoreWithdrawnDraft(
  sessionPath: string,
  withdrawn: WithdrawnQueue,
  namespace = getDraftNamespace(),
  recoveryId = withdrawn.recoveryId,
): Promise<string | null> {
  if (!withdrawn.messages.length && !withdrawn.imagesDropped && !withdrawn.truncated) return null;
  await getAttachmentDraft(namespace, sessionPath).restoreContent(
    withdrawn.messages,
    (text, id, references) => restoreSavedDraft(sessionPath, text, namespace, id, references),
    recoveryId, removedDraftImages(sessionPath, namespace),
  );
  const notes = ["Your queued content is back in the draft."];
  if (withdrawn.imagesDropped) notes.push("Some attached photos could not be recovered.");
  if (withdrawn.truncated) notes.push("Some queued content was too large to bring back.");
  return notes.join(" ");
}
