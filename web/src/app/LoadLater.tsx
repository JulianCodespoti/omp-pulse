import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useTranscriptViewport } from "@/components/ai-elements/transcript-viewport";
import { Spinner } from "@/components/ui/spinner";
import { useNavigationOwnership } from "@/components/ai-elements/navigation-ownership";

/** How far below the viewport the next page starts loading. As far as LoadEarlier looks upward, so neither direction waits. */
const PRELOAD_PX = 2400;

/**
 * Scroll-down pagination: the other half of LoadEarlier. A long scroll up
 * drops the newest rows from the window; reading back down loads them again
 * by cursor as the reader approaches, so the transcript slides in both
 * directions. Without this the return trip reseeded the window from the
 * tail, replacing every row under the reader, which read as the bottom
 * loading in again.
 *
 * Same rules as LoadEarlier: a sentinel observed with an IntersectionObserver
 * (no scroll listener), re-observed after each page so a still-visible
 * sentinel chains, no layout shift (rows land below the view, so nothing needs
 * anchoring), and a failed page stops the chain and offers one retry.
 */
export function LoadLater({
  hasLater,
  cursor,
  paused,
  onLoadLater,
}: {
  hasLater: boolean;
  /** Where the next read starts; a new value re-arms the observer after a page lands. */
  cursor: number | null;
  paused: boolean;
  /** Resolves false when the page could not be loaded. */
  onLoadLater: () => Promise<boolean> | void;
}) {
  const { scrollRef } = useTranscriptViewport();
  const { active: navigating, isActive: navigationActive } = useNavigationOwnership();
  const sentinel = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const request = useCallback(() => {
    if (paused || !hasLater || navigationActive()) return;
    setLoading(true);
    void Promise.resolve(onLoadLater()).then(
      (ok) => {
        setLoading(false);
        if (ok === false && !navigationActive()) setFailed(true);
      },
      () => {
        setLoading(false);
        if (!navigationActive()) setFailed(true);
      },
    );
  }, [hasLater, navigationActive, onLoadLater, paused]);

  // A reader who gestures again after a failure gets a fresh attempt.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !failed) return;
    const retry = () => setFailed(false);
    root.addEventListener("touchstart", retry, { passive: true, once: true });
    root.addEventListener("wheel", retry, { passive: true, once: true });
    return () => {
      root.removeEventListener("touchstart", retry);
      root.removeEventListener("wheel", retry);
    };
  }, [failed, scrollRef]);

  useEffect(() => {
    const root = scrollRef.current;
    const node = sentinel.current;
    if (!root || !node || !hasLater || paused || loading || failed || navigating) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) request();
      },
      { root, rootMargin: `0px 0px ${PRELOAD_PX}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // cursor: re-observe after a page lands so a still-visible sentinel reports again.
  }, [cursor, failed, hasLater, loading, navigating, paused, request, scrollRef]);

  if (!hasLater) return null;
  const pill = "absolute bottom-2 left-1/2 z-raised -translate-x-1/2 whitespace-nowrap rounded-full border border-hairline bg-surface-1 px-3 py-1.5 text-meta text-muted-foreground shadow-[var(--shadow-float)]";
  return (
    <div className="relative h-0 w-full">
      <div ref={sentinel} aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px" />
      {paused ? null : loading ? (
        <span role="status" className={cn(pill, "inline-flex items-center gap-2")}>
          <Spinner size={14} label={null} />
          Loading newer messages…
        </span>
      ) : failed ? (
        <button
          className={cn(pill, "after:absolute after:inset-x-0 after:-inset-y-[9px] after:content-[''] press-bounce")}
          onClick={() => setFailed(false)}
          type="button"
        >
          Couldn’t load newer messages. Tap to retry.
        </button>
      ) : null}
    </div>
  );
}
