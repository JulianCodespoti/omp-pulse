import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useTranscriptViewport } from "@/components/ai-elements/transcript-viewport";

import { Spinner } from "@/components/ui/spinner";
import { useNavigationOwnership } from "@/components/ai-elements/navigation-ownership";

/** How far above the viewport the next page starts loading, in CSS pixels. Large enough that a page is usually there before the reader reaches the top. */
const PRELOAD_PX = 2400;
/**
 * Pages fetched back to back without the reader touching the screen. A
 * conversation that is tool entries for thousands of rows in a row would
 * otherwise chain forever; a gesture resets the budget.
 */
const MAX_UNATTENDED_PAGES = 40;

/** Treated as "pinned to the newest message". */
const BOTTOM_EPSILON_PX = 8;
/** How long a freshly opened thread has to lay out before it can arm without reaching the bottom. */
const SETTLE_MS = 1_200;
/** The loading and offline pills show only this close to the top; further up the reader cannot see them. */
const NEAR_TOP_PX = 160;

/**
 * Scroll-up pagination for the transcript. It is automatic: the reader never
 * presses anything, and the only visible state is "Loading earlier messages".
 *
 * Four things make this correct rather than merely functional:
 *
 * 1. A SENTINEL, NOT A SCROLL LISTENER. The loader watches a one-pixel element
 *    at the top of the thread with an IntersectionObserver. A scroll listener
 *    never fires when the thread does not overflow the viewport, and in a
 *    tool-heavy conversation the newest page is often a single collapsed run
 *    that fits on one screen: the reader sat on a dead "Load earlier" button
 *    with nothing to scroll. The observer reports the sentinel as visible
 *    right away, so pages keep arriving until the thread fills the screen and
 *    the sentinel is far enough above to stop.
 *
 * 2. IT CHAINS BY RE-OBSERVING. An IntersectionObserver only reports changes,
 *    so after each page the effect re-runs (it depends on `loading` and the
 *    row count) and observes again; a still-visible sentinel fires again.
 *
 * 3. ANCHORING IS NOT THIS FILE'S JOB. A page prepended above the view pushes the
 *    content down by its height, which would read as the conversation leaping
 *    away. The viewport keeps a free reader's place itself, every frame, from
 *    the one transcript row it measures (`placeTick` in transcript-viewport.tsx),
 *    so a page lands under the reader's finger whatever the row count does. This
 *    file used to snapshot the first row in the commit that grew the row count,
 *    which missed the page that arrives together with a bottom trim (the window
 *    is capped, so the count stays the same): from the ninth page of a long chat
 *    each one moved the reader a whole page. Before that it recorded the offset
 *    when the fetch STARTED and re-asserted it for 24 frames, pulling a reader
 *    who kept scrolling up back DOWN by 236-964 px.
 *
 * 4. PAUSED, NOT HIDDEN. Offline the loader requests nothing but says so near
 *    the top, instead of leaving a silent dead end.
 *
 * A failed page stops the chain and offers one retry; it never loops on errors.
 */
export function LoadEarlier({
  hasEarlier,
  paused,
  loading,
  messageCount,
  onLoadEarlier,
}: {
  hasEarlier: boolean;
  /** The computer is unreachable: nothing is requested, and the top says why. */
  paused: boolean;
  loading: boolean;
  messageCount: number;
  /** Resolves false when the page could not be loaded. */
  onLoadEarlier: () => Promise<boolean> | void;
}) {
  const viewport = useTranscriptViewport();
  const { scrollRef } = viewport;
  const { active: navigating, isActive: navigationActive } = useNavigationOwnership();
  const sentinel = useRef<HTMLDivElement>(null);
  const unattended = useRef(0);
  const [failed, setFailed] = useState(false);
  /** Any page requested on this thread yet (sentinel, idle prefetch). */
  const requestedAny = useRef(false);

  const request = useCallback(() => {
    const element = scrollRef.current;
    if (!element || loading || paused || !hasEarlier || navigationActive()) return;
    requestedAny.current = true;
    unattended.current += 1;
    const markFailed = () => {
      // Latest may have taken over while the request waited. Its false result
      // must not put a stale retry notice over the new tail.
      if (navigationActive()) return;
      setFailed(true);
    };
    void Promise.resolve(onLoadEarlier()).then(
      (ok) => { if (ok === false) markFailed(); },
      markFailed,
    );
  }, [hasEarlier, loading, paused, onLoadEarlier, scrollRef, navigationActive]);

  // ARMING. On open the scroller is briefly at scrollTop 0 while the thread is
  // still being laid out and pinned to the newest message, so the sentinel
  // reads as visible and a naive loader fires at once: a page prepended there
  // moved the reader off the newest message (measured: scrollTop 1299 of 13406
  // right after open). It arms only once the thread has been AT THE BOTTOM (a
  // thread that does not overflow is trivially at the bottom, which is exactly
  // the case a scroll listener cannot serve) or the reader has touched it
  // (a restored scroll position or a jump from search never reaches the bottom).
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = () => element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_EPSILON_PX;
    const onScroll = () => { if (atBottom()) setArmed(true); };
    // A gesture means someone is reading: refill the page budget, allow a retry,
    // and arm even if the bottom was never reached.
    const onGesture = () => {
      unattended.current = 0;
      setFailed(false);
      setArmed(true);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("touchstart", onGesture, { passive: true });
    element.addEventListener("wheel", onGesture, { passive: true });
    if (messageCount > 0 && atBottom()) setArmed(true);
    // A thread opened away from the bottom (a jump from search, a restored
    // position) never pins there. Once it has had time to lay out and settle,
    // arm anyway: the opening race this guards against lasts a few frames.
    const settle = messageCount > 0 ? window.setTimeout(() => setArmed(true), SETTLE_MS) : undefined;
    return () => {
      if (settle !== undefined) window.clearTimeout(settle);
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("touchstart", onGesture);
      element.removeEventListener("wheel", onGesture);
    };
  }, [messageCount, scrollRef]);

  // IDLE PREFETCH. A chat opens on a short first page (the controller's
  // FIRST_HISTORY_PAGE) so its first rows render sooner. The page above is
  // fetched once the thread is armed and the main thread is idle, through
  // `request()`, so it lands anchored like any scroll-up page and the reader
  // who scrolls up right away finds history already there. Once per thread:
  // if the sentinel already paged, there is nothing to prefetch.
  useEffect(() => {
    if (requestedAny.current || !armed || !hasEarlier || paused || loading || failed || navigating) return;
    const run = () => { if (!requestedAny.current) request(); };
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof w.requestIdleCallback === "function") {
      const handle = w.requestIdleCallback(run, { timeout: 1_000 });
      return () => w.cancelIdleCallback?.(handle);
    }
    // Safari has no requestIdleCallback; a short timer is close enough.
    const timer = window.setTimeout(run, 200);
    return () => window.clearTimeout(timer);
  }, [armed, failed, hasEarlier, loading, navigating, paused, request]);

  useEffect(() => {
    const root = scrollRef.current;
    const node = sentinel.current;
    if (!root || !node || !armed || !hasEarlier || paused || loading || failed || navigating) return;
    if (unattended.current >= MAX_UNATTENDED_PAGES) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) request();
      },
      { root, rootMargin: `${PRELOAD_PX}px 0px 0px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // messageCount: re-observe after the rows change so a still-visible
    // sentinel reports again (an observer only reports transitions).
  }, [armed, failed, hasEarlier, loading, messageCount, paused, request, scrollRef, navigating]);

  // Within the pill distance of the top: a page loading far above the view is silent.
  const [nearTop, setNearTop] = useState(false);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setNearTop(element.scrollTop <= NEAR_TOP_PX);
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, [messageCount, scrollRef]);

  const pill = "absolute left-1/2 top-2 z-raised -translate-x-1/2 whitespace-nowrap rounded-full border border-hairline bg-surface-1 px-3 py-1.5 text-meta text-muted-foreground shadow-[var(--shadow-float)]";
  // Zero-height host: the spinner and the retry pill float over the top edge
  // instead of pushing the thread down, so loading never shifts what is read.
  return (
    <>
      {hasEarlier ? (
        <div className="relative h-0 w-full">
          {/* The observed edge: at the very top of the thread. Kept while loading so
              the element (and its observer) stays stable. */}
          <div ref={sentinel} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
          {paused ? (
            nearTop ? (
              <span role="status" className={cn(pill, "inline-flex items-center")}>
                Earlier messages load when you’re back online
              </span>
            ) : null
          ) : loading ? (
            nearTop ? (
              <span role="status" className={cn(pill, "inline-flex items-center gap-2")}>
                <Spinner size={14} label={null} />
                Loading earlier messages…
              </span>
            ) : null
          ) : failed ? (
            <button
              className={cn(pill, "after:absolute after:inset-x-0 after:-inset-y-[9px] after:content-[''] press-bounce")}
              onClick={() => {
                setFailed(false);
                unattended.current = 0;
              }}
              type="button"
            >
              Couldn’t load earlier messages. Tap to retry.
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
