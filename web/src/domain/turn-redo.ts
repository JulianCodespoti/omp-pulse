/**
 * "Try again" and "Edit" on the newest turn: which message, and which mechanism.
 *
 * Only the LAST user message qualifies, and only once the daemon has echoed it
 * with its session-file entry id (a `local:` echo has none, and a rewind needs
 * a real entry). A session the daemon's own omp writes is rewound IN PLACE
 * (`tree_goto`: the conversation ends just before that message, so the re-run
 * replaces the turn). A session someone else writes (the desktop) must not be
 * written, so the same cut is made on a copy (`branch`) and the work continues
 * there; the caller says so, never silently duplicating the prompt in a thread.
 */
import type { UiMessage } from "./messages";

export type RedoKind = "in-place" | "branch";

export interface RedoPlan {
  kind: RedoKind;
  /** Session-file entry of the user message the turn starts at. */
  entryId: string;
  prompt: UiMessage;
  /** The newest assistant message with text after the prompt: the reply Try again sits under. */
  replyId: string | null;
  /** A turn is running, the session cannot be written from here, or the daemon is unreachable. */
  disabled: boolean;
}

export function redoKind(canWriteInPlace: boolean): RedoKind {
  return canWriteInPlace ? "in-place" : "branch";
}

export function planRedo(
  messages: readonly UiMessage[],
  ctx: { running: boolean; sendAllowed: boolean; offline: boolean; canWriteInPlace: boolean },
): RedoPlan | null {
  let at = messages.length - 1;
  while (at >= 0 && messages[at]!.role !== "user") at--;
  const prompt = messages[at];
  const entryId = prompt?.sourceEntryId;
  if (!prompt || !entryId) return null;
  const hasImages = prompt.parts.some((part) => part.kind === "image") || (prompt.localAttachmentCount ?? 0) > 0;
  if (!prompt.text.trim() && !hasImages) return null;
  let replyId: string | null = null;
  for (let i = messages.length - 1; i > at && !replyId; i--) {
    if (messages[i]!.role === "assistant" && messages[i]!.text.trim()) replyId = messages[i]!.id;
  }
  return {
    kind: redoKind(ctx.canWriteInPlace),
    entryId,
    prompt,
    replyId,
    disabled: ctx.running || !ctx.sendAllowed || ctx.offline,
  };
}

/**
 * The problem placing a prompt in the composer, or null once it is there.
 * `placeForEdit` reports SUCCESS as null, so an absent composer must be told
 * apart from it explicitly: `placeForEdit(...) ?? fallback` turned every
 * success into the fallback message.
 */
export function editPlacementProblem(
  composer: { placeForEdit(sessionPath: string, text: string): string | null } | null | undefined,
  sessionPath: string,
  text: string,
): string | null {
  if (!composer) return "The composer isn’t ready yet. Try again.";
  return composer.placeForEdit(sessionPath, text);
}

/**
 * Holds the draft an Edit displaced so cancelling can put it back exactly.
 * `take` is one-shot and path-checked: a stash from another conversation, or
 * one already used, restores nothing.
 */
export function createEditStash<D>() {
  let held: { sessionPath: string; draft: D } | null = null;
  return {
    hold(sessionPath: string, draft: D): void { held = { sessionPath, draft }; },
    take(sessionPath: string): D | null {
      const hit = held && held.sessionPath === sessionPath ? held.draft : null;
      held = null;
      return hit;
    },
  };
}
