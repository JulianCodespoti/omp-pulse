import { useEffect, useState, type JSX } from "react";

import { useTranscriptViewport } from "@/components/ai-elements/transcript-viewport";
import { markdownReady } from "@/components/markdown";

/** The longest a chat stays hidden behind its opening: a slow open shows what it has. */
export const REVEAL_MAX_MS = 800;
/** Opens faster than this show nothing in between: a skeleton that flashes away reads as flicker. */
const SKELETON_AFTER_MS = 150;
/** "Pinned" for the reveal: the newest message is on screen to within this. */
const PINNED_PX = 16;

/**
 * Hides a chat's transcript until its newest screenful is ready, then shows it
 * at once, so an opened chat is never seen being assembled (plain text swapped
 * for rich markdown, rows arriving, the view travelling to the end). The scroll
 * target is not discovered here: the viewport opens at the end inside its first
 * measurement (transcript-viewport.tsx). This only decides when to show it.
 *
 * Revealed when the rows have arrived, the markdown layer is loaded and the view
 * is at the end, or after REVEAL_MAX_MS whatever is missing (an unreachable
 * computer must show "Opening session…" and the pill, not a skeleton forever).
 * Once revealed for a conversation it stays revealed.
 */
export function OpenReveal({
  rowsReady,
  revealed,
  onReveal,
}: {
  /** The history read has answered: rows exist, or the chat is known to be empty. */
  rowsReady: boolean;
  revealed: boolean;
  onReveal: () => void;
}): JSX.Element | null {
  const viewport = useTranscriptViewport();
  const [markdown, setMarkdown] = useState(false);
  const [skeleton, setSkeleton] = useState(false);

  useEffect(() => {
    if (revealed) return;
    let live = true;
    void markdownReady().then(() => { if (live) setMarkdown(true); });
    const cap = window.setTimeout(onReveal, REVEAL_MAX_MS);
    const skeletonTimer = window.setTimeout(() => setSkeleton(true), SKELETON_AFTER_MS);
    return () => {
      live = false;
      window.clearTimeout(cap);
      window.clearTimeout(skeletonTimer);
    };
  }, [revealed, onReveal]);

  useEffect(() => {
    if (revealed || !rowsReady || !markdown) return;
    // Two frames: the rows' layout and the viewport's pin land inside them.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(function check() {
        if (viewport.distanceFromBottom() <= PINNED_PX || !viewport.isFollowing()) onReveal();
        else frame = requestAnimationFrame(check);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [revealed, rowsReady, markdown, viewport, onReveal]);

  if (revealed || !skeleton) return null;
  return (
    <div
      aria-hidden
      data-testid="chat-opening-skeleton"
      className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--composer-height,7rem)+1rem)] mx-auto flex w-full max-w-[48rem] flex-col gap-4 px-4"
    >
      <span className="ml-auto h-9 w-3/5 rounded-2xl bg-surface-2" />
      <span className="h-3.5 w-4/5 rounded-sm bg-surface-2" />
      <span className="h-3.5 w-2/3 rounded-sm bg-surface-2" />
      <span className="h-3.5 w-3/4 rounded-sm bg-surface-2" />
      <span className="ml-auto h-9 w-2/5 rounded-2xl bg-surface-2" />
      <span className="h-3.5 w-3/5 rounded-sm bg-surface-2" />
    </div>
  );
}
