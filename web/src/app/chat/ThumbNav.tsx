import { ArrowDownIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { NEAR_BOTTOM_PX, useTranscriptViewport } from "@/components/ai-elements/transcript-viewport";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { isAtBottom as navIsAtBottom } from "./message-navigation";
import { OmpSessionController } from "../../runtime/omp-session-controller";
import { useLongPress } from "../hooks/use-long-press";
import { useStoreValue } from "../store-hooks";
import { showToast } from "../Notices";
import { reachLatest, waitForLatestRender } from "./latest-navigation";
import { useNavigationOwnership } from "@/components/ai-elements/navigation-ownership";

export interface ThumbNavProps {
  controller: OmpSessionController;
  messageCount: number;
  /** A sheet, palette or question owns the screen, or the chat is empty. */
  hidden: boolean;
}

/**
 * ChatGPT's scroll-to-bottom: one round Down button centred above the composer
 * while the reader is away from the live edge; a tap goes to the latest
 * message, with a count of what arrived meanwhile beside it. Stepping between
 * messages (an Up button, Down stepping to the next prompt) was removed: the
 * pair read as clutter over the reply, and the Timeline goes back further.
 * Down itself must stay: rows the window dropped from the bottom while the
 * reader was up are only reachable through its tail reload.
 */
export function ThumbNav({ controller, messageCount, hidden }: ThumbNavProps): JSX.Element | null {
  const store = controller.getStore();
  const messages = useStoreValue(store, (s) => s.messages);
  const renderedMessages = useRef(messages);
  useLayoutEffect(() => { renderedMessages.current = messages; }, [messages]);
  const { isActive: navigationActive, setActive: setNavigationActive } = useNavigationOwnership();
  // Bottom-evicted messages are newest arrivals the window dropped while the
  // reader was up: they join the count, and tapping reseeds the window from
  // the tail (a plain scroll could never reach dropped rows).
  const evictedBottom = useStoreValue(store, (s) => s.evictedBottom);
  const { following, nearBottom, follow, release, scrollRef } = useTranscriptViewport();
  // Following, or within the viewport's near-end distance: the reader has seen the newest rows.
  const atEnd = following || nearBottom;
  // ChatGPT shows Down only past half a viewport plus the composer from the end:
  // nearer than that the end is a flick away and the button just covers text.
  const [far, setFar] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const composer = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--composer-height")) || 112;
      setFar(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight / 2 + composer);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, [scrollRef]);

  const prevCountRef = useRef(messageCount);
  const prevFirstIdRef = useRef<string | undefined>(messages[0]?.id);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const delta = messageCount - prevCountRef.current;
    const firstId = messages[0]?.id;
    // Growth from a prepend is scrollback the reader asked for, not news:
    // only edge growth (top unchanged) counts. A changed top with no growth
    // is a top eviction at the live edge, where the button is hidden anyway.
    if (navigationActive()) {
      // Replacing the window during Latest is not acknowledgement of arrivals.
    } else if (delta > 0 && firstId === prevFirstIdRef.current) {
      if (!atEnd) setPending((p) => p + delta);
      else setPending(0);
    } else if (delta < 0) {
      setPending(0);
    }
    prevCountRef.current = messageCount;
    prevFirstIdRef.current = firstId;
  }, [messageCount, messages, atEnd, navigationActive]);
  // Reset with the viewport's own notion of "back at the live edge" (NEAR_BOTTOM_PX), not a
  // tighter one: a reader who has seen the newest rows has nothing unseen, and a
  // stale count would reappear the moment they scrolled up again.
  useEffect(() => {
    const el = document.querySelector(".chat-scroll") as HTMLElement | null;
    if (!navigationActive() && atEnd && el && navIsAtBottom(el, NEAR_BOTTOM_PX) && evictedBottom === 0) setPending(0);
  }, [atEnd, evictedBottom, navigationActive]);

  const count = atEnd ? 0 : pending + evictedBottom;

  const busyRef = useRef(false);
  const [jumping, setJumping] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleLatest = useCallback(async () => {
    if (busyRef.current) return;
    const path = store.getState().sessionPath;
    const el = document.querySelector(".chat-scroll") as HTMLElement | null;
    if (!path || !el) return;
    busyRef.current = true;
    setNavigationActive(true);
    setJumping(true);
    setPending((p) => Math.max(p, store.getState().evictedBottom));
    release("program");
    let cancelled = false;
    const isCurrent = () => !cancelled && mountedRef.current && store.getState().sessionPath === path;
    const cancel = () => { cancelled = true; if (mountedRef.current) release("program"); };
    const keyCancel = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Escape"].includes(event.key)) cancel();
    };
    el.addEventListener("wheel", cancel, { passive: true });
    el.addEventListener("touchstart", cancel, { passive: true });
    document.addEventListener("keydown", keyCancel);
    try {
      const result = await reachLatest({
        isCurrent,
        needsTailReload: () => store.getState().evictedBottom > 0,
        reloadTail: () => controller.jumpToLatest(isCurrent),
        waitForRender: () => waitForLatestRender({
          isCurrent,
          isRendered: () => renderedMessages.current === store.getState().messages,
          nextFrame: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
          now: () => performance.now(),
        }),
        scrollToBottom: () => follow(),
        isAtBottom: () => navIsAtBottom(el) && store.getState().evictedBottom === 0,
      });
      if (result === "arrived") {
        setPending(0);
      } else if (result === "failed") {
        release("program");
        showToast("Couldn't reach the latest messages. Try again.", "warn");
      }
    } finally {
      el.removeEventListener("wheel", cancel);
      el.removeEventListener("touchstart", cancel);
      document.removeEventListener("keydown", keyCancel);
      busyRef.current = false;
      if (mountedRef.current) {
        setJumping(false);
        setNavigationActive(false);
      }
    }
  }, [controller, store, follow, release, setNavigationActive]);

  // A hold is a tap too (older habit, and the e2e helper holds).
  const downPress = useLongPress(() => void handleLatest());

  // `hidden` covers the slash palette too (Composer reports it through
  // ChatScreen). It used to be detected with a body-wide MutationObserver,
  // which ran on every DOM change of a streaming reply.
  if (hidden) return null;

  // Always mounted while allowed, so it can fade both ways instead of popping.
  // Hidden while following: on open the scroller reads far from the end for a frame before the
  // viewport has placed it there, and the button flashed on every open.
  const shown = (far && !following) || jumping;
  const round = "pointer-events-none flex items-center justify-center rounded-full bg-surface-2 text-foreground shadow-[var(--shadow-float)] ring-1 ring-inset ring-white/10 outline-none active:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
  return (
    <div
      data-testid="jump-nav"
      aria-hidden={!shown}
      className={cn(
        // Above the floating composer, which covers the transcript's bottom edge.
        // Right-aligned, not centred: centred it sat over a message's own action row (copy, read aloud,
// retry) and hid the controls it was floating above.
        "pointer-events-none absolute inset-x-0 bottom-[calc(var(--composer-height,7rem)+0.75rem)] z-raised flex justify-end pr-4 transition-[opacity,transform] duration-[var(--dur-slow)] ease-[var(--ease-spring)] motion-reduce:transition-none",
        shown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
    >
      <div role="group" aria-label="Message navigation" className="relative">
        <button
          type="button"
          data-testid="jump-next"
          aria-label={`Jump to latest${count > 0 ? `, ${count} new` : ""}`}
          aria-busy={jumping}
          // Mirrors the container so a reader of this one control (the e2e
          // suites, assistive tech probing the button) sees its visibility.
          aria-hidden={!shown}
          tabIndex={shown ? 0 : -1}
          disabled={jumping}
          onPointerDown={(event) => downPress.onPointerDown(event)}
          onPointerMove={downPress.onPointerMove}
          onPointerUp={downPress.onPointerUp}
          onPointerCancel={downPress.onPointerCancel}
          onPointerLeave={downPress.onPointerLeave}
          onContextMenu={(event) => event.preventDefault()}
          onClick={() => {
            if (downPress.shouldSuppressClick()) {
              downPress.consumeFired();
              return;
            }
            void handleLatest();
          }}
          className={cn(round, "size-11", shown && "pointer-events-auto")}
        >
          {jumping ? <Spinner size={16} label={null} /> : <ArrowDownIcon className="size-5" aria-hidden />}
        </button>
        {count > 0 ? (
          // The count belongs to Down: it is what Down reaches.
          <span
            data-testid="latest-messages-count"
            aria-hidden
            className="absolute right-full top-3 mr-3 flex h-6 items-center whitespace-nowrap rounded-full bg-surface-2 px-2.5 text-meta tabular-nums text-primary-text shadow-[var(--shadow-float)]"
          >
            {count > 99 ? "99+" : count} new
          </span>
        ) : null}
      </div>
    </div>
  );
}
