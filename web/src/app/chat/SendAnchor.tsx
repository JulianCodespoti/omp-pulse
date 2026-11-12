import { useEffect, useLayoutEffect, useRef } from "react";

import { useTranscriptViewport } from "@/components/ai-elements/transcript-viewport";

/**
 * ChatGPT's send: your message scrolls to the top of the view and the reply
 * streams into the room below it. The view never chases the stream; once the
 * reply outgrows that room the reader scrolls, or taps the Down button.
 *
 * The room is NOT given back when the turn ends. Removing the marker clamps
 * `scrollTop` to the shorter content, which moved every row in a single frame:
 * a short reply visibly jumped the moment it finished. The marker stays until
 * taking it away cannot move the view (see `SendAnchor`), or until the next
 * send re-places it.
 *
 * `endMarkerTop` is where a 1px marker must sit (in transcript coordinates) so
 * the scrollable area ends exactly one viewport below `scrollTop`. The room
 * is therefore exact: it shrinks to nothing as the reply grows, and a short
 * reply leaves no scrollable blank beyond it.
 */
export function sendAnchorLayout({ anchorTop, gap, viewport }: { anchorTop: number; gap: number; viewport: number }): { scrollTop: number; endMarkerTop: number } {
  const scrollTop = Math.max(0, anchorTop - gap);
  return { scrollTop, endMarkerTop: scrollTop + viewport };
}

/**
 * Renders the marker and owns the send's room. It is an absolutely positioned
 * 1px box, not a spacer element: a spacer would resize the transcript content,
 * which the viewport observes, and writing to it from our own observers
 * would raise "ResizeObserver loop" errors. `sentId` is the optimistic echo at
 * the tail (null otherwise). The scroll position itself belongs to the
 * viewport: the send is a persistent hold on the sent message.
 */
export function SendAnchor({ sentId }: { sentId: string | null }) {
  const viewport = useTranscriptViewport();
  const { scrollRef } = viewport;
  const marker = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const shown = useRef(false);
  // Opening a chat whose newest message is still an echo is not a send.
  const seen = useRef(sentId);

  /** Places and shows the marker; returns the clearance the sent message keeps under the header, or null when there is no turn to anchor. */
  const place = (): number | null => {
    const el = marker.current;
    const scroller = scrollRef.current;
    const content = el?.parentElement;
    if (!el || !scroller || !content) return null;
    // Cached: re-querying the transcript on every streamed frame is O(rows).
    if (!anchor.current?.isConnected) {
      const turns = content.querySelectorAll<HTMLElement>("[data-user-turn]");
      anchor.current = turns[turns.length - 1] ?? null;
    }
    if (!anchor.current) return null;
    // The clearance the first message gets under the header pills.
    const gap = parseFloat(getComputedStyle(content).paddingTop) || 0;
    const { endMarkerTop } = sendAnchorLayout({ anchorTop: anchor.current.offsetTop, gap, viewport: scroller.clientHeight });
    el.style.top = `${endMarkerTop}px`;
    el.style.display = "block";
    shown.current = true;
    return gap;
  };

  // Gives the room back only when that cannot move the view: the view ends
  // within the content proper (the reply outgrew the room, or the reader
  // scrolled up), so the marker's removal leaves `scrollTop` unclamped.
  const releaseIfHarmless = () => {
    const el = marker.current;
    const scroller = scrollRef.current;
    const content = el?.parentElement;
    if (!shown.current || !el || !scroller || !content) return;
    const contentBottom = content.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (scroller.scrollTop + scroller.clientHeight > contentBottom) return;
    el.style.display = "none";
    anchor.current = null;
    shown.current = false;
  };

  useLayoutEffect(() => {
    if (!sentId || sentId === seen.current) return;
    seen.current = sentId;
    anchor.current = null;
    // Leave the follow lock before the view moves, so the reply grows below the
    // view instead of dragging it, and a "program" release is not undone by
    // the hold's own scroll.
    viewport.release("program");
    const gap = place();
    if (gap === null || !anchor.current) return;
    viewport.hold(anchor.current, gap, { persistent: true });
    // `place` closes over refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentId]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = marker.current?.parentElement;
    if (!scroller || !content) return;
    // A viewport change (keyboard, rotation) moves where the room must end.
    const resized = new ResizeObserver(() => {
      if (shown.current) place();
    });
    resized.observe(scroller);
    // Growth of the reply is what lets the room go; the marker does not resize the content.
    const grown = new ResizeObserver(releaseIfHarmless);
    grown.observe(content);
    scroller.addEventListener("scroll", releaseIfHarmless, { passive: true });
    return () => {
      resized.disconnect();
      grown.disconnect();
      scroller.removeEventListener("scroll", releaseIfHarmless);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef]);

  return <div ref={marker} aria-hidden data-testid="send-anchor-marker" className="pointer-events-none absolute left-0 h-px w-px" style={{ display: "none" }} />;
}
