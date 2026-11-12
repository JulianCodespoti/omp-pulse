import { BotIcon, FolderIcon, GitCompareArrowsIcon, ListChecksIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, JSX, KeyboardEvent, ReactNode, RefObject } from "react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { useSessionTracking, type SessionTracking } from "../chat/session-tracking";
import { openWorkspace, selectSessionTab, usePanels, type WorkspaceTab } from "./panels";
import { SidePanel, type PanelSize } from "./SidePanel";
import { LinkBanner } from "../ui/LinkBanner";
import { retryableLazy as lazy } from "../ui/retryable-lazy";
import { ScreenBoundary } from "../ui/RecoveryBoundary";
import { prefersReducedMotion } from "../../platform/appearance";

type PageProps = {
  sessionPath: string;
  /** Data is live: the page is shown, next to it, or being swiped into view. */
  active: boolean;
  /** The page on screen: back layers and anything else that answers the user. */
  focused: boolean;
};

// The workspace pages are their own chunk: the chat opens without them and
// App fetches them while the phone is idle.
const tools = () => import("../tools");
// Order is reach: Agents and Tasks are the pages people check mid-turn, so
// they come first; the code pages follow.
const WORKSPACE: readonly { value: WorkspaceTab; label: string; Icon: LucideIcon; Content: ComponentType<PageProps> }[] = [
  { value: "agents", label: "Agents", Icon: BotIcon, Content: lazy(() => tools().then((m) => ({ default: m.AgentsTab }))) },
  { value: "tasks", label: "Tasks", Icon: ListChecksIcon, Content: lazy(() => tools().then((m) => ({ default: m.TasksTab }))) },
  { value: "changes", label: "Changes", Icon: GitCompareArrowsIcon, Content: lazy(() => tools().then((m) => ({ default: m.ChangesTab }))) },
  { value: "files", label: "Files", Icon: FolderIcon, Content: lazy(() => tools().then((m) => ({ default: m.FilesTab }))) },
  { value: "terminal", label: "Terminal", Icon: SquareTerminalIcon, Content: lazy(() => tools().then((m) => ({ default: m.TerminalTab }))) },
];

// Wide, but a strip of the chat (~15%) stays visible behind the scrim, as
// ChatGPT's drawer leaves its chat in view.
const DRAWER_SIZE: PanelSize = { vw: 0.86, max: 520 };

// Past the pager's settle, so neighbour reads start after the motion.
const WARM_MS = 260;
// A chat's cheap pages (not Changes, which runs a git diff on the computer, nor
// the Terminal, which has nothing to read) are read once while the drawer is
// closed, so the first swipe lands on rows instead of a skeleton. The window
// is long enough for those reads to finish and short enough that Agents'
// polling, which runs only while a page is active, never settles in.
const PREFETCH_PAGES: readonly WorkspaceTab[] = ["agents", "tasks", "files"];
const PREFETCH_AFTER_MS = 2500;
const PREFETCH_WINDOW_MS = 4000;
// The dock's indicator can ride the pager's scroll timeline (styles.css .ws-pill).
const SCROLL_TIMELINE = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timeline: scroll()");

const indexOf = (tab: WorkspaceTab) => WORKSPACE.findIndex((t) => t.value === tab);

/** Workspace pages within one step of `tab`: the pages a swipe reveals next. */
function neighbours(tab: WorkspaceTab): WorkspaceTab[] {
  const at = indexOf(tab);
  return WORKSPACE.filter((w) => Math.abs(indexOf(w.value) - at) <= 1).map((w) => w.value);
}

/**
 * A chat and its workspace: the chat is always on screen, and the workspace
 * (Agents · Tasks · Changes · Files · Terminal) is a drawer over it from the
 * right, the mirror of the session switcher (SidePanel). A leftward swipe on
 * the chat or the header's workspace button opens it; a scrim tap, Escape,
 * Back or a rightward swipe on Agents closes it. (The chat used to slide off
 * screen as the first page of one pager, which read as losing the
 * conversation.)
 *
 * Inside the drawer: the page's title and a close button on top, the pages
 * as one native scroll-snap pager, and a bottom tab dock (icon over label,
 * five equal cells, so it never scrolls). The dock's indicator follows the
 * pager's scroll position every frame, and the title follows the page
 * nearest the finger. (The tabs used to be a scrolling pill row at the top
 * that only scrolled a far tab such as Terminal into view once the swipe had
 * settled, so the bar lagged and then flicked.) The dock hides while a field
 * in the drawer has focus, so the keyboard does not stack on top of it. A
 * rightward swipe on Agents cannot scroll the pager, so it falls through to
 * closing the drawer. `panels.workspace` stays the state: null is closed, a
 * tab is open on that page.
 *
 * Pages mount when shown or next to the shown page; shortly after the drawer
 * opens the rest mount too, idle, so a swipe never has to build a page
 * mid-gesture. They stay mounted through closing (scroll position, open
 * folder, terminal output survive). Their data is live (`active`) only while
 * the drawer is open and the page is shown, next to the shown page, or being
 * uncovered by a swipe. The one exception is a single quiet read of Agents,
 * Tasks and Files per chat while the drawer is closed (PREFETCH_PAGES).
 */
export function SessionPager({
  sessionPath,
  controller,
  header,
  children,
}: {
  sessionPath: string | null;
  controller: OmpSessionController;
  /** The chat's bar, given the tracking it badges (read here, once). */
  header: (tracking: SessionTracking) => ReactNode;
  /** The chat. */
  children: ReactNode;
}): JSX.Element {
  const tracking = useSessionTracking(controller, sessionPath);
  // This pager re-renders on every drawer change (usePanels); the header must not, it is the costliest
  // thing on screen and nothing in it depends on the drawers.
  const headerEl = useMemo(() => header(tracking), [header, tracking]);
  const panels = usePanels();
  const tab = panels.workspace;
  const open = tab !== null;
  const [shown, setShown] = useState<WorkspaceTab>(tab ?? "agents");
  const [mounted, setMounted] = useState<ReadonlySet<WorkspaceTab>>(() => new Set());
  const [live, setLive] = useState<ReadonlySet<WorkspaceTab>>(() => new Set());
  const [prefetching, setPrefetching] = useState<ReadonlySet<WorkspaceTab>>(() => new Set());
  const prefetchedFor = useRef<string | null>(null);
  const pagerNode = useRef<HTMLDivElement | null>(null);
  // The portal mounts after the first render, so effects wait for the element.
  const [pagerEl, setPagerEl] = useState<HTMLDivElement | null>(null);
  const pagerRef = useCallback((el: HTMLDivElement | null) => {
    pagerNode.current = el;
    setPagerEl(el);
  }, []);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  // The page nearest the finger, for the title; follows the swipe, not its end.
  const [near, setNear] = useState(indexOf(shown));
  // The drawer was already open on the previous selection: a page change
  // glides; the first selection of an opening drawer cuts straight there.
  const wasOpen = useRef(false);

  const mount = useCallback((pages: readonly WorkspaceTab[]) => {
    setMounted((prev) => (pages.every((p) => prev.has(p)) ? prev : new Set([...prev, ...pages])));
  }, []);
  const goLive = useCallback((page: WorkspaceTab) => {
    setLive((prev) => (prev.has(page) ? prev : new Set(prev).add(page)));
  }, []);

  // Another conversation starts closed with nothing mounted.
  useLayoutEffect(() => {
    setMounted(new Set());
    setLive(new Set());
    setShown("agents");
  }, [sessionPath]);

  // Neighbours of a workspace page read once the pager has settled there, so
  // their requests never compete with the landing; closing the drawer drops
  // every page's live data (Agents and Tasks re-read when it reopens).
  useEffect(() => {
    if (!open) {
      setLive(new Set());
      return;
    }
    const near = neighbours(shown);
    setLive((prev) => new Set([...prev].filter((v) => near.includes(v))));
    const timer = window.setTimeout(() => setLive(new Set(near)), WARM_MS);
    return () => window.clearTimeout(timer);
  }, [shown, open]);

  // One quiet read per chat, once it has settled. Opening the drawer, a hidden
  // tab or a chat switch ends the window; the open drawer's own live set takes
  // over, and the pages keep what they read (see their retained rows).
  useEffect(() => {
    if (open || !sessionPath || prefetchedFor.current === sessionPath) {
      setPrefetching((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    let stop: number | undefined;
    const start = window.setTimeout(() => {
      if (document.visibilityState === "hidden") return;
      prefetchedFor.current = sessionPath;
      mount(PREFETCH_PAGES);
      setPrefetching(new Set(PREFETCH_PAGES));
      stop = window.setTimeout(() => setPrefetching(new Set()), PREFETCH_WINDOW_MS);
    }, PREFETCH_AFTER_MS);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(stop);
      setPrefetching((prev) => (prev.size === 0 ? prev : new Set()));
    };
  }, [open, sessionPath, mount]);

  // Once the drawer has opened and settled, build every page (idle, without
  // data), so swiping or tapping to a far page never mounts it mid-motion.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => mount(WORKSPACE.map((w) => w.value)), WARM_MS * 2);
    return () => window.clearTimeout(timer);
  }, [open, mount]);

  // The dock's indicator follows the pager: at 1.4 pages it sits 40% of the
  // way from the second cell to the third. Cells are equal, so this is one
  // translate with no layout reads. `glide` springs it there (a cut jump);
  // otherwise the scroll itself is the animation.
  const placed = useRef(-1);
  const placePill = useCallback((position: number, glide = false) => {
    const clamped = Math.min(Math.max(position, 0), WORKSPACE.length - 1);
    placed.current = clamped;
    const pill = pillRef.current;
    // With scroll-driven animations the pager's timeline moves the pill (styles.css).
    if (pill && !SCROLL_TIMELINE) {
      pill.style.transition = glide ? "translate var(--dur-panel) var(--ease-spring)" : "none";
      pill.style.translate = `${clamped * 100}% 0`;
    }
    const at = Math.round(clamped);
    setNear(at);
    tabsRef.current?.querySelectorAll<HTMLElement>("[role=tab]").forEach((button, i) => button.toggleAttribute("data-near", i === at));
  }, []);

  const jumpTo = useCallback(
    (target: WorkspaceTab) => {
      const pager = pagerNode.current;
      if (!pager) return;
      pager.scrollLeft = indexOf(target) * pager.clientWidth;
      placePill(indexOf(target), true);
    },
    [placePill],
  );

  // A tab chosen elsewhere (a tab tap, a slash command, the header button)
  // moves the pager. While open, a page that is already built glides there,
  // however far; an unbuilt one (the first moments after opening) cuts there,
  // since sliding past pages not drawn yet would flash blanks, and the
  // arriving page slides a short way in from its side so it still reads as
  // movement rather than a swap.
  useLayoutEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (tab === null) return;
    const pager = pagerNode.current;
    const from = shownRef.current;
    setShown(tab);
    mount(neighbours(tab));
    goLive(tab);
    if (!pager) return;
    const at = indexOf(tab);
    if (Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth)) === at) {
      placePill(at);
      return;
    }
    const step = at - indexOf(from);
    const drawn = WORKSPACE.slice(Math.min(at, indexOf(from)), Math.max(at, indexOf(from)) + 1).every((w) => mountedRef.current.has(w.value));
    if (was && pager.clientWidth > 0 && (Math.abs(step) === 1 || drawn)) {
      pager.scrollTo({ left: at * pager.clientWidth, behavior: "smooth" });
      return;
    }
    jumpTo(tab);
    const page = pager.children[at];
    // `animate` is absent from jsdom, where the component tests run.
    const motion = typeof page?.animate === "function" && !prefersReducedMotion();
    if (was && page instanceof HTMLElement && step !== 0 && motion) {
      page.animate(
        [
          { opacity: 0, transform: `translateX(${Math.sign(step) * 32}px)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  }, [tab, open, jumpTo, placePill, mount, goLive]);

  // A swipe ends on a page: select it once the scroll settles. A resize
  // (rotation, the drawer unhiding) re-pins the pager to the shown page.
  useEffect(() => {
    const pager = pagerEl;
    if (!pager) return;
    let idle: number | undefined;
    // WebViews before Chrome 114 have no scrollend; settle on a quiet scroll.
    const nativeScrollEnd: boolean = "onscrollend" in pager;
    const settle = () => {
      if (pager.clientWidth === 0) return;
      const at = Math.round(pager.scrollLeft / pager.clientWidth);
      const next = WORKSPACE[at]?.value;
      if (!next) return;
      mount(neighbours(next));
      if (next !== shownRef.current) {
        setShown(next);
        selectSessionTab(next);
      }
    };
    const onScroll = () => {
      if (pager.clientWidth === 0) return;
      const position = pager.scrollLeft / pager.clientWidth;
      // A programmatic jump already placed (and is springing) the indicator.
      if (Math.abs(position - placed.current) > 0.001) placePill(position);
      // Draw and start reading whatever page the finger is uncovering.
      const reveal = WORKSPACE[position > indexOf(shownRef.current) ? Math.ceil(position) : Math.floor(position)]?.value;
      if (reveal) {
        mount([reveal]);
        goLive(reveal);
      }
      if (!nativeScrollEnd) {
        window.clearTimeout(idle);
        idle = window.setTimeout(settle, 120);
      }
    };
    const resize = new ResizeObserver(() => {
      if (pager.clientWidth > 0) jumpTo(shownRef.current);
    });
    resize.observe(pager);
    // The tabs only have a width once the drawer first shows.
    if (tabsRef.current) resize.observe(tabsRef.current);
    pager.addEventListener("scroll", onScroll, { passive: true });
    pager.addEventListener("scrollend", settle);
    return () => {
      window.clearTimeout(idle);
      resize.disconnect();
      pager.removeEventListener("scroll", onScroll);
      pager.removeEventListener("scrollend", settle);
    };
  }, [pagerEl, jumpTo, placePill, mount, goLive]);

  // A pushed screen over the chat owns every touch; so does the switcher.
  const swipeOpen = sessionPath !== null && !panels.switcher && !panels.settings && !panels.projects;
  // The whole screen the drawer pushes aside, header included: the same surface the switcher pushes.
  const screenRef = useRef<HTMLElement | null>(null);
  const setBody = useCallback((el: HTMLDivElement | null) => {
    screenRef.current = el?.closest<HTMLElement>("[data-screen]") ?? null;
  }, []);

  return (
    <>
      {headerEl}
      <div ref={setBody} className="flex min-h-0 flex-1 flex-col">{children}</div>
      <SidePanel
        side="right"
        size={DRAWER_SIZE}
        keepMounted
        label="Workspace"
        testId="workspace-drawer"
        open={open}
        onOpenChange={(next) => (next ? openWorkspace() : selectSessionTab("chat"))}
        swipeOpen={swipeOpen}
        push={screenRef}
      >
        <div className="ws-scope group/ws flex min-h-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-2 pl-5 pr-2">
          <h2 data-testid="workspace-title" className="min-w-0 flex-1 truncate text-title font-semibold">
            {WORKSPACE[near]?.label}
          </h2>
          <Button
            aria-label="Close workspace"
            data-testid="workspace-close"
            className="text-muted-foreground"
            onClick={() => selectSessionTab("chat")}
            size="icon"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-5" strokeWidth={1.9} aria-hidden />
          </Button>
        </div>
        <LinkBanner className="mx-4 mb-2 shrink-0" />
        <div
          ref={pagerRef}
          data-testid="session-pager"
          data-session-pager=""
          className="ws-pager flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {WORKSPACE.map(({ value, label, Content }) => (
            <section
              key={`${sessionPath}:${value}`}
              id={`session-page-${value}`}
              role="tabpanel"
              aria-labelledby={`session-tab-${value}`}
              inert={value !== shown}
              data-testid={`workspace-tab-${value}`}
              className="flex min-h-0 w-full shrink-0 snap-start snap-always flex-col"
            >
              {sessionPath && mounted.has(value) ? (
                <ScreenBoundary title={label} onBack={() => selectSessionTab("chat")} loading={null}>
                  <Content sessionPath={sessionPath} active={(open && (value === shown || live.has(value))) || prefetching.has(value)} focused={open && value === shown} />
                </ScreenBoundary>
              ) : null}
            </section>
          ))}
        </div>
        <WorkspaceTabs value={shown} tracking={tracking} listRef={tabsRef} pillRef={pillRef} />
        </div>
      </SidePanel>
    </>
  );
}

type Badge = { text: string; tone: "neutral" | "running" | "warning"; words: string } | null;

function badgeFor(tab: WorkspaceTab, tracking: SessionTracking): Badge {
  if (tab === "changes" && tracking.changes) {
    const n = tracking.changes.files;
    return { text: String(n), tone: "neutral", words: `${n} ${n === 1 ? "file" : "files"} changed` };
  }
  if (tab === "agents") {
    const { working, needsYou } = tracking.agents;
    if (working + needsYou === 0) return null;
    const parts = [working > 0 ? `${working} working` : "", needsYou > 0 ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you` : ""].filter(Boolean);
    return { text: String(working + needsYou), tone: needsYou > 0 ? "warning" : "running", words: parts.join(", ") };
  }
  if (tab === "tasks" && tracking.tasksLeft > 0) {
    return { text: String(tracking.tasksLeft), tone: "neutral", words: `${tracking.tasksDone} of ${tracking.tasksTotal} done` };
  }
  return null;
}

const BADGE_TONE = {
  neutral: "bg-surface-3 text-foreground",
  running: "bg-running text-background",
  warning: "bg-warning text-warning-foreground",
} as const;

/**
 * The workspace's bottom tab dock: five equal cells, an icon over a short
 * label, so every tab is always in view and in thumb reach. Counts are a
 * small badge on the icon in the state's colour. The selected indicator is
 * one pill behind the icons that the pager slides between cells.
 */
function WorkspaceTabs({
  value,
  tracking,
  listRef,
  pillRef,
}: {
  value: WorkspaceTab;
  tracking: SessionTracking;
  listRef: RefObject<HTMLDivElement | null>;
  pillRef: RefObject<HTMLSpanElement | null>;
}): JSX.Element {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = indexOf(value);
    const target =
      event.key === "ArrowRight" ? (at + 1) % WORKSPACE.length
      : event.key === "ArrowLeft" ? (at - 1 + WORKSPACE.length) % WORKSPACE.length
      : event.key === "Home" ? 0
      : event.key === "End" ? WORKSPACE.length - 1
      : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = WORKSPACE[target].value;
    selectSessionTab(next);
    const list = event.currentTarget;
    requestAnimationFrame(() => list.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus());
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Workspace sections"
      data-testid="workspace-tabs"
      onKeyDown={onKeyDown}
      // Hidden while a field in the drawer has focus: the keyboard is up.
      className="relative grid shrink-0 grid-cols-5 px-2 pb-1.5 pt-1 group-has-[:is(input,textarea):focus]/ws:hidden"
    >
      <span
        aria-hidden
        data-testid="workspace-tab-bar"
        ref={pillRef}
        className="ws-pill pointer-events-none absolute left-2 top-1 flex h-8 w-[calc((100%-1rem)/5)] justify-center"
      >
        <span className="h-full w-14 rounded-full bg-surface-2" />
      </span>
      {WORKSPACE.map((t) => {
        const selected = t.value === value;
        const badge = badgeFor(t.value, tracking);
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`session-tab-${t.value}`}
            aria-controls={`session-page-${t.value}`}
            aria-selected={selected}
            aria-label={`${t.label}${badge ? `, ${badge.words}` : ""}`}
            data-value={t.value}
            tabIndex={selected ? 0 : -1}
            onClick={() => selectSessionTab(t.value)}
            className={cn(
              "press-bounce relative flex min-w-0 flex-col items-center gap-0.5 rounded-xl pb-1 text-meta font-medium outline-none transition-colors duration-[var(--dur-fast)] [-webkit-tap-highlight-color:transparent] focus-visible:outline-2 focus-visible:outline-ring",
              // The pager marks the cell nearest the finger (data-near) as it
              // moves; aria-selected follows once a page lands.
              "text-muted-foreground data-[near]:text-foreground",
            )}
          >
            <span className="relative grid h-8 w-14 place-items-center">
              <t.Icon aria-hidden className="size-5" strokeWidth={1.9} />
              {badge ? (
                <span
                  aria-hidden
                  data-testid={`tab-badge-${t.value}`}
                  data-tone={badge.tone}
                  className={cn(
                    "absolute -top-0.5 left-[calc(50%+0.375rem)] flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6875rem] font-semibold leading-none tabular-nums",
                    BADGE_TONE[badge.tone],
                  )}
                >
                  {badge.text}
                </span>
              ) : null}
            </span>
            <span className="max-w-full truncate">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
