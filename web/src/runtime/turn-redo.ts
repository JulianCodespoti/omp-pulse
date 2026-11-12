/**
 * Carry out a Try again / Edit decided by `planRedo` (domain/turn-redo.ts).
 *
 * RPC calls, in order: in place `tree_goto {entryId, summarize:false}` then a
 * history reload then the prompt; on a copy `branch {entryId}` then the prompt
 * to the returned session, then opening it. Returns the branch's path when one
 * was opened, so the caller can tell the user.
 */
import type { RedoKind } from "@/domain/turn-redo";
import type { DaemonApi } from "./rpc-client";
import type { OmpSessionController } from "./omp-session-controller";

export interface RedoStep {
  kind: RedoKind;
  entryId: string;
  sessionPath: string;
  text: string;
  images: { data: string; mimeType: string }[];
  /** Forwarded to the send: the composer clears its draft once the prompt is durably saved. */
  onSaved?: () => Promise<boolean> | void;
}

export async function redoTurn(
  api: Pick<DaemonApi, "treeGoto" | "branch">,
  controller: Pick<OmpSessionController, "reloadBranch" | "sendPrompt" | "openSession" | "prepareEditorDraft">,
  step: RedoStep,
): Promise<string | null> {
  const { kind, entryId, sessionPath, text, images, onSaved } = step;
  if (kind === "branch") {
    const copy = await api.branch(sessionPath, entryId);
    if (copy.cancelled) throw new Error("omp kept this conversation as it was.");
    await controller.sendPrompt(text, images, copy.sessionPath, onSaved);
    await controller.openSession(copy.sessionPath);
    return copy.sessionPath;
  }
  const moved = await api.treeGoto(sessionPath, entryId, { summarize: false });
  if (moved.cancelled || moved.aborted) throw new Error(moved.error || "omp kept this conversation as it was.");
  // The old turn is off the branch now; reload before the echo of the new one.
  await controller.reloadBranch();
  try {
    await controller.sendPrompt(text, images, sessionPath, onSaved);
  } catch (error) {
    // The turn is already cut: keep its text where the user can resend it.
    controller.prepareEditorDraft(sessionPath, text);
    throw error;
  }
  return null;
}
