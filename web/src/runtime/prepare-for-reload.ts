import { flushAllDraftWrites } from "../app/composer/use-draft";
import { flushFileDraftWrites } from "./file-draft";
import { flushNewSessionDraftWrites } from "./new-session-draft";
import { flushDraftAttachmentWrites } from "./offline-queue";

/** A reload or conversation handoff must not abandon any in-memory draft owner. */
export async function prepareForReload(): Promise<void> {
  flushAllDraftWrites();
  flushFileDraftWrites();
  flushNewSessionDraftWrites();
  await flushDraftAttachmentWrites();
}
