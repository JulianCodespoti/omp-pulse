import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  CloudOffIcon,
  FolderIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { OmpSessionSummary } from "../../domain/protocol";
import { projectName, recentProjects } from "../../domain/recent-projects";
import { readPairingToken } from "../../platform/browser-storage";
import { probeLink } from "../../runtime/link-state";
import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { DaemonApi, type MessageSearch, type SearchHit } from "../../runtime/rpc-client";
import { useBackLayer } from "../back-layer";
import { useLinkState, useOnLinkRecovered } from "../link-hooks";
import {
  activeTime,
  duplicateTitles,
  getLocalStateVersion,
  getPinnedSet,
  isUnsentChat,
  matchesQuery,
  sessionTitle,
  subscribeLocalState,
} from "../session-format";
import { sessionStatus } from "../session-status";
import { resolveAnswerSession } from "../sessions/answer-session";
import { useDeletedPaths } from "../sessions/pending-delete";
import { sessionSearchPresentation } from "../sessions/search-presentation";
import { TranscriptSearch } from "../sessions/transcript-search";
import { EmptyState } from "../ui/EmptyState";
import { errorRecoveryAction } from "../ui/error-recovery";
import { LazyMount } from "../ui/LazyMount";
import { LinkBanner } from "../ui/LinkBanner";
import { Notice } from "../ui/Notice";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { retryableLazy as lazy } from "../ui/retryable-lazy";
import { DrawerComputerRow } from "./DrawerComputerRow";
import { DrawerRowActions, type RowActionsTarget } from "./DrawerRowActions";
import { DrawerSessionRow, markMatches } from "./DrawerSessionRow";
import { openNewSession, openProjects, openSettings, openSwitcherProject, usePanels } from "./panels";
import { PluginSlot } from "../plugins/PluginSlot";

// Code-split: AnswerSheet loads only when a session with a pending question is tapped.
const LazyAnswerSheet = lazy(async () => {
  const module = await import("../sessions/AnswerSheet");
  return { default: module.AnswerSheet };
});

const RECENT_LIMIT = 12;
const NO_SESSIONS: OmpSessionSummary[] = [];
const NO_AWAITING: ReadonlySet<string> = new Set();

interface MessageHitRow {
  path: string;
  title: string;
  line: string;
  entryId?: string;
}

const navRow =
  "pressable mx-3 my-0.5 flex min-h-12 w-[calc(100%-1.5rem)] items-center gap-4 rounded-xl px-4 text-left text-body outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-surface-2 [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";

/**
 * The app's left drawer, the sole session list and search surface:
 * computer status, Settings, recent projects, inline search (titles + messages),
 * project scoping, older-session pagination, Needs you, Pinned, and Recent.
 */
export function SessionSwitcher({
  controller,
  active,
  currentPath,
  onSwitch,
}: {
  controller: OmpSessionController;
  active: boolean;
  currentPath: string | null;
  onSwitch: (path: string, entryId?: string) => void;
}): JSX.Element {
  const panels = usePanels();
  const project = panels.switcherProject;
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [attempt, setAttempt] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 260);
    return () => window.clearTimeout(t);
  }, [query]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    setSearchOpen(false);
  }, []);

  // Back inside the drawer exits search or clears a project filter before closing the drawer itself.
  useBackLayer(active && (searchOpen || project !== null), {
    onBack: () => {
      if (searchOpen) clearSearch();
      else openSwitcherProject(null);
    },
  });

  const activeQuery = searchOpen ? debouncedQuery.trim() : "";
  const request = useMemo(
    () => ({ controller, currentPath, active, visible, attempt, query: activeQuery, project }),
    [controller, currentPath, active, visible, attempt, activeQuery, project],
  );
  const latestRequest = useRef(request);
  latestRequest.current = request;

  const [result, setResult] = useState<{
    request: typeof request;
    sessions: OmpSessionSummary[];
    nextCursor: string | null;
    error: string | null;
  } | null>(null);
  const [good, setGood] = useState<{
    scopeKey: string;
    sessions: OmpSessionSummary[];
    nextCursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [moreSentinel, setMoreSentinel] = useState<HTMLElement | null>(null);

  const scopeKey = `${activeQuery}\u0000${project ?? ""}`;
  const publish = useCallback(
    (from: typeof request, sessions: OmpSessionSummary[], nextCursor: string | null) => {
      const key = `${from.query}\u0000${from.project ?? ""}`;
      setGood({ scopeKey: key, sessions, nextCursor });
      setResult({ request: from, sessions, nextCursor, error: null });
    },
    [],
  );

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Subscribe to the live /ws/sessions stream while the drawer is open so
  // activity updates and new conversations appear immediately, and close the
  // list socket cleanly as soon as a chat opens or the drawer closes.
  useEffect(() => {
    if (!active || !visible || typeof controller.startSessionsPolling !== "function") return;
    controller.startSessionsPolling();
    return () => controller.stopSessionsPolling?.();
  }, [active, visible, controller]);

  useEffect(() => {
    if (!active || !visible) return;
    const abort = new AbortController();
    const isCurrent = () =>
      !abort.signal.aborted && latestRequest.current === request && document.visibilityState !== "hidden";
    const run =
      typeof controller.querySwitcherSessionsPage === "function"
        ? controller.querySwitcherSessionsPage({
            query: request.query,
            project: request.project,
            cursor: null,
            currentPath,
            signal: abort.signal,
            isCurrent,
          })
        : controller
            .querySwitcherSessions({
              query: request.query,
              project: request.project,
              currentPath,
              signal: abort.signal,
              isCurrent,
            })
            .then((sessions) => ({ sessions, nextCursor: null }));
    void run.then(
      (page) => {
        if (isCurrent()) publish(request, page.sessions, page.nextCursor ?? null);
      },
      (error: unknown) => {
        if (isCurrent()) {
          setResult({
            request,
            sessions: [],
            nextCursor: null,
            error: humanizeDaemonError(error),
          });
        }
      },
    );
    return () => abort.abort();
  }, [request, controller, currentPath, active, visible, publish]);

  // Warm the default unscoped drawer once while closed so the first swipe shows rows immediately.
  const warmedFor = useRef<{ controller: OmpSessionController; path: string | null } | null>(null);
  useEffect(() => {
    if (active || !visible || activeQuery || project) return;
    const done = warmedFor.current;
    if (done && done.controller === controller && done.path === currentPath) return;
    const abort = new AbortController();
    const isCurrent = () => !abort.signal.aborted && document.visibilityState !== "hidden";
    const timer = window.setTimeout(() => {
      warmedFor.current = { controller, path: currentPath };
      const run =
        typeof controller.querySwitcherSessionsPage === "function"
          ? controller.querySwitcherSessionsPage({ query: "", project: null, cursor: null, currentPath, signal: abort.signal, isCurrent })
          : controller.querySwitcherSessions({ query: "", currentPath, signal: abort.signal, isCurrent }).then((sessions) => ({ sessions, nextCursor: null }));
      void run.then(
        (page) => {
          if (isCurrent() && latestRequest.current.query === "" && latestRequest.current.project === null) {
            publish(latestRequest.current, page.sessions, page.nextCursor ?? null);
          }
        },
        () => {
          warmedFor.current = null;
        },
      );
    }, 800);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [active, visible, activeQuery, project, controller, currentPath, publish]);

  // Re-read while open so chats started on the computer appear automatically.
  useEffect(() => {
    if (!active || !visible || activeQuery) return;
    let abort: AbortController | null = null;
    const timer = window.setInterval(() => {
      if (abort) return;
      const pending = new AbortController();
      abort = pending;
      const isCurrent = () =>
        !pending.signal.aborted && latestRequest.current === request && document.visibilityState !== "hidden";
      const run =
        typeof controller.querySwitcherSessionsPage === "function"
          ? controller.querySwitcherSessionsPage({
              query: "",
              project: request.project,
              cursor: null,
              currentPath,
              signal: pending.signal,
              isCurrent,
            })
          : controller.querySwitcherSessions({ query: "", project: request.project, currentPath, signal: pending.signal, isCurrent }).then((sessions) => ({ sessions, nextCursor: null }));
      void run
        .then(
          (page) => {
            if (isCurrent()) publish(request, page.sessions, page.nextCursor ?? null);
          },
          () => undefined,
        )
        .finally(() => {
          if (abort === pending) abort = null;
        });
    }, 5_000);
    return () => {
      window.clearInterval(timer);
      abort?.abort();
    };
  }, [request, activeQuery, controller, currentPath, active, visible, publish]);

  // Poll awaiting ask_user questions while the drawer is open.
  const [awaiting, setAwaiting] = useState<ReadonlySet<string>>(NO_AWAITING);
  const fetchAwaiting = useCallback(async () => {
    const token = readPairingToken();
    if (!token || typeof DaemonApi.prototype.awaiting !== "function") return;
    try {
      const paths = await new DaemonApi(token).awaiting();
      setAwaiting((prev) => {
        const next = new Set(paths);
        if (next.size === prev.size && [...next].every((p) => prev.has(p))) return prev;
        return next;
      });
    } catch {
      // ignore transient poll failures
    }
  }, []);
  useEffect(() => {
    if (!active || !visible) return;
    void fetchAwaiting();
    const timer = window.setInterval(() => void fetchAwaiting(), 5_000);
    return () => window.clearInterval(timer);
  }, [active, visible, fetchAwaiting]);

  // Message search across transcripts when searching inside the drawer.
  const [transcriptRequest] = useState(() => new TranscriptSearch<MessageSearch>());
  const [transcript, setTranscript] = useState<({ q: string; project: string | null } & MessageSearch) | null>(null);
  const [searchingTranscripts, setSearchingTranscripts] = useState(false);
  const [messageSearchFailed, setMessageSearchFailed] = useState(false);
  const [messageSearchError, setMessageSearchError] = useState<unknown>(null);
  const [messageNonce, setMessageNonce] = useState(0);

  useLayoutEffect(() => () => transcriptRequest.reset(), [transcriptRequest]);
  useEffect(() => {
    if (!active || !searchOpen || activeQuery.length < 2 || typeof DaemonApi.prototype.searchMessages !== "function") {
      transcriptRequest.reset();
      setSearchingTranscripts(false);
      setMessageSearchFailed(false);
      setTranscript(null);
      return;
    }
    setSearchingTranscripts(true);
    setMessageSearchFailed(false);
    void transcriptRequest
      .run(activeQuery, async () => {
        const token = readPairingToken();
        if (!token) throw new Error("Not paired");
        return new DaemonApi(token).searchMessages(activeQuery, 40, project);
      })
      .then((res) => {
        if (!res) return;
        if (res.ok) setTranscript({ q: res.query, project, ...res.value });
        else {
          setMessageSearchError(res.error);
          setMessageSearchFailed(true);
        }
        setSearchingTranscripts(false);
      });
  }, [active, searchOpen, activeQuery, project, messageNonce, transcriptRequest]);

  const loadMore = useCallback(() => {
    if (!good || good.scopeKey !== scopeKey || !good.nextCursor || loadingMore || typeof controller.querySwitcherSessionsPage !== "function") return;
    const cursor = good.nextCursor;
    const req = latestRequest.current;
    const abort = new AbortController();
    const isCurrent = () =>
      !abort.signal.aborted && latestRequest.current === req && document.visibilityState !== "hidden";
    setLoadingMore(true);
    void controller
      .querySwitcherSessionsPage({
        query: req.query,
        project: req.project,
        cursor,
        currentPath,
        signal: abort.signal,
        isCurrent,
      })
      .then(
        (page) => {
          if (!isCurrent()) return;
          setFailedCursor(null);
          setGood((prev) => {
            if (!prev || prev.scopeKey !== scopeKey) return prev;
            const seen = new Set(prev.sessions.map((s) => s.path));
            const merged = [...prev.sessions, ...page.sessions.filter((s) => !seen.has(s.path))];
            return { scopeKey, sessions: merged, nextCursor: page.nextCursor ?? null };
          });
        },
        () => {
          if (isCurrent()) setFailedCursor(cursor);
        },
      )
      .finally(() => setLoadingMore(false));
  }, [good, scopeKey, loadingMore, controller, currentPath]);

  const scopedGood = good?.scopeKey === scopeKey ? good : null;
  const nextCursor = scopedGood?.nextCursor ?? null;

  useEffect(() => {
    if (
      !active ||
      !moreSentinel ||
      !nextCursor ||
      loadingMore ||
      failedCursor === nextCursor ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(moreSentinel);
    return () => observer.disconnect();
  }, [active, moreSentinel, nextCursor, loadingMore, failedCursor, loadMore]);

  const currentResult = result?.request === request ? result : null;
  const loaded = scopedGood !== null;
  const error = currentResult?.error ?? null;
  const deleted = useDeletedPaths();
  const listed = scopedGood?.sessions ?? NO_SESSIONS;
  const sessions = useMemo(
    () => (deleted.size ? listed.filter((session) => !deleted.has(session.path)) : listed),
    [listed, deleted],
  );
  const pinnedVersion = useSyncExternalStore(subscribeLocalState, getLocalStateVersion, getLocalStateVersion);
  const pinnedSet = useMemo(() => getPinnedSet(), [pinnedVersion]);

  const trimmedQuery = searchOpen ? query.trim() : "";
  const searching = trimmedQuery !== "";
  const hasMoreLoaded = listed.length > RECENT_LIMIT;

  const shown = useMemo(() => {
    const base = [...sessions]
      .sort((a, b) => activeTime(b) - activeTime(a))
      .filter(
        (session) =>
          (!searching || matchesQuery(session, trimmedQuery)) &&
          (!isUnsentChat(session) ||
            session.path === currentPath ||
            pinnedSet.has(session.path) ||
            sessionStatus(session, awaiting) !== "idle"),
      );
    if (searching || project !== null || hasMoreLoaded) return base;
    return base.filter(
      (session, index) =>
        index < RECENT_LIMIT ||
        session.path === currentPath ||
        pinnedSet.has(session.path) ||
        sessionStatus(session, awaiting) === "needs-you",
    );
  }, [sessions, searching, trimmedQuery, currentPath, pinnedSet, awaiting, project, hasMoreLoaded]);

  const dupTitles = useMemo(() => duplicateTitles(sessions), [sessions]);

  const sections = useMemo(() => {
    if (searching) {
      return shown.length > 0 ? [{ label: "Chats", sessions: shown }] : [];
    }
    const needs: OmpSessionSummary[] = [];
    const pinned: OmpSessionSummary[] = [];
    const recent: OmpSessionSummary[] = [];
    for (const session of shown) {
      if (sessionStatus(session, awaiting) === "needs-you") needs.push(session);
      else if (pinnedSet.has(session.path)) pinned.push(session);
      else recent.push(session);
    }
    return [
      { label: "Needs you", sessions: needs },
      { label: "Pinned", sessions: pinned },
      { label: project ? projectName(project) : "Recent", sessions: recent },
    ].filter((section) => section.sessions.length > 0);
  }, [searching, shown, awaiting, pinnedSet, project]);

  const messageRows = useMemo((): MessageHitRow[] => {
    if (!searching || !transcript || transcript.q !== activeQuery || transcript.project !== project) return [];
    const byPath = new Map(sessions.map((s) => [s.path, s] as const));
    const grouped = new Map<string, { hit: SearchHit; count: number }>();
    for (const hit of transcript.hits) {
      if (deleted.has(hit.path)) continue;
      const entry = grouped.get(hit.path);
      if (entry) entry.count += 1;
      else grouped.set(hit.path, { hit, count: 1 });
    }
    return [...grouped.values()].map(({ hit, count }) => {
      const known = byPath.get(hit.path);
      return {
        path: hit.path,
        title: hit.title || (known ? sessionTitle(known) : "Untitled session"),
        line: count > 1 ? `${count} matches · ${hit.line}` : hit.line,
        entryId: hit.entryId,
      };
    });
  }, [searching, transcript, activeQuery, project, sessions, deleted]);

  const messagesPending =
    searchingTranscripts ||
    (activeQuery.length >= 2 &&
      (transcript?.q !== activeQuery || transcript?.project !== project) &&
      !messageSearchFailed);
  const searchState = sessionSearchPresentation({
    query: searchOpen ? query : "",
    debouncedQuery: activeQuery,
    titleCount: shown.length,
    messageCount: messageRows.length,
    listingPending: !loaded && !error,
    moreAvailable: Boolean(nextCursor) || loadingMore,
    messagesPending,
    failed: Boolean(error) || messageSearchFailed,
  });

  const projects = useMemo(
    () => (!searching && project === null ? recentProjects(sessions, 4) : []),
    [searching, project, sessions],
  );
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [actionTarget, setActionTarget] = useState<RowActionsTarget | null>(null);
  const [answerSession, setAnswerSession] = useState<OmpSessionSummary | null>(null);
  const openActions = useCallback(
    (session: OmpSessionSummary, row: HTMLElement) => setActionTarget({ session, row }),
    [],
  );
  const closeActions = useCallback(() => setActionTarget(null), []);
  useEffect(() => {
    if (!active) {
      setActionTarget(null);
      setAnswerSession(null);
    }
  }, [active]);

  const refresh = useCallback(() => {
    setAttempt((value) => value + 1);
    void controller.loadSessions().catch(() => undefined);
  }, [controller]);
  const link = useLinkState();
  useOnLinkRecovered(refresh);
  const retry = useCallback(() => {
    void probeLink(true);
    refresh();
  }, [refresh]);

  const [waitedLong, setWaitedLong] = useState(false);
  useEffect(() => {
    setWaitedLong(false);
    if (!active || loaded) return;
    const timer = window.setTimeout(() => setWaitedLong(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [active, loaded, attempt]);

  return (
    <div ref={setRoot} className="relative flex min-h-0 flex-1 flex-col bg-surface-1">
      <header className="flex h-16 shrink-0 items-center gap-1 pl-7 pr-3">
        {project !== null && !searchOpen ? (
          <>
            <Button
              aria-label="All chats"
              data-testid="switcher-clear-project"
              variant="ghost"
              className="-ml-3 size-11 rounded-full text-foreground"
              onClick={() => openSwitcherProject(null)}
            >
              <ArrowLeftIcon className="size-5" />
            </Button>
            <h2 className="min-w-0 flex-1 truncate text-title font-semibold">{projectName(project)}</h2>
          </>
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-title font-semibold">omp</h2>
        )}
        <Button
          aria-label={searchOpen ? "Close search" : "Search chats"}
          aria-expanded={searchOpen}
          data-testid="switcher-search-toggle"
          variant="ghost"
          className="size-12 rounded-full text-foreground"
          onClick={() => {
            if (searchOpen) {
              clearSearch();
            } else {
              setSearchOpen(true);
              window.requestAnimationFrame(() => searchInputRef.current?.focus());
            }
          }}
        >
          {searchOpen ? <XIcon className="size-5" /> : <SearchIcon className="size-5" />}
        </Button>
      </header>

      {searchOpen ? (
        <div className="px-3 pb-2" data-testid="session-search-toolbar">
          <InputGroup className="h-11 min-w-0 rounded-full border-0 bg-surface-2 px-4 !ring-0">
            <InputGroupAddon>
              <SearchIcon className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchInputRef}
              aria-label="Search chats and messages"
              autoCapitalize="none"
              autoCorrect="off"
              className="h-11 min-w-0 text-body md:text-body placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
              data-testid="session-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={project ? `Search in ${projectName(project)}` : "Search chats and messages"}
              spellCheck={false}
              type="search"
              value={query}
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <Button
                  aria-label="Clear search"
                  className="text-muted-foreground"
                  data-testid="clear-search"
                  onClick={() => {
                    setQuery("");
                    setDebouncedQuery("");
                    searchInputRef.current?.focus();
                  }}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <XIcon className="size-4" />
                </Button>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24">
        {!searchOpen && project === null ? (
          <>
            <nav aria-label="Shortcuts">
              <DrawerComputerRow className={navRow} />
              <button type="button" data-testid="switcher-settings" className={navRow} onClick={openSettings}>
                <SettingsIcon aria-hidden />
                Settings
              </button>
            </nav>
            <PluginSlot slot="drawer" active={active} className="mb-1 mt-2 px-7" />
          </>
        ) : null}

        <LinkBanner onRetry={refresh} className="mx-3 my-2" />
        {error && shown.length > 0 && link.kind === "live" ? (
          <Notice tone="warning" className="mx-3 my-2" action={{ label: "Retry", onClick: retry }}>
            Couldn’t refresh chats.
          </Notice>
        ) : null}
        {projects.length > 0 ? (
          <section aria-label="Projects">
            <h3 className="m-0 mt-2 flex min-h-11 items-center px-7 text-meta font-semibold text-muted-foreground">
              Projects
            </h3>
            {projects.map((item) => (
              <button
                key={item.cwd}
                type="button"
                data-testid="switcher-project"
                data-cwd={item.cwd}
                className={navRow}
                onClick={() => openSwitcherProject(item.cwd)}
              >
                <FolderIcon aria-hidden />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            ))}
            <button
              type="button"
              data-testid="switcher-projects"
              className={cn(navRow, "text-muted-foreground")}
              onClick={openProjects}
            >
              <FolderIcon aria-hidden />
              All projects…
            </button>
          </section>
        ) : null}

        {!searchOpen && project === null ? <hr className="mx-7 my-3 border-hairline" /> : null}

        {!loaded && shown.length === 0 && !error ? (
          link.kind !== "live" || waitedLong ? (
            <EmptyState
              icon={<CloudOffIcon />}
              title={link.kind !== "live" ? "Chats unavailable" : "Taking longer than usual"}
              description={
                link.kind !== "live" ? "They load once your computer answers." : "Your computer is slow to respond."
              }
              action={{ label: "Retry", onClick: retry }}
              testId="switcher-slow"
            />
          ) : (
            <div aria-busy="true" aria-label="Loading sessions" className="flex flex-col gap-1 px-3">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-2/60 motion-reduce:animate-none" />
              ))}
            </div>
          )
        ) : error && shown.length === 0 ? (
          <EmptyState
            icon={<CloudOffIcon />}
            title={searching ? "Couldn’t search chats" : "Couldn’t load chats"}
            description={error}
            action={{ label: "Retry", onClick: retry }}
            testId={searching ? "search-error" : "switcher-error"}
          />
        ) : searchState.empty ? (
          <EmptyState
            icon={<SearchIcon />}
            title="No sessions match"
            description={<>Nothing found for &ldquo;{trimmedQuery}&rdquo;.</>}
            action={{
              label: "Clear search",
              onClick: () => {
                setQuery("");
                setDebouncedQuery("");
              },
            }}
            testId="empty-no-search"
          />
        ) : shown.length === 0 && !searching ? (
          <EmptyState
            icon={<MessageSquarePlusIcon />}
            title={project ? `No chats in ${projectName(project)} yet` : "No chats yet"}
            description="Start one here, or on your computer."
            testId="switcher-empty"
          />
        ) : (
          <div data-testid="switcher-sessions" role="group" aria-label="Sessions">
            {searchState.titlesPending ? (
              <p className="flex min-h-11 items-center gap-2 px-7 text-meta text-muted-foreground" data-testid="search-loading" role="status">
                <Spinner size={14} label={null} />
                Searching…
              </p>
            ) : null}
            {sections.map((section) => {
              const heading = "m-0 mt-2 flex min-h-11 items-center px-7 text-meta font-semibold text-muted-foreground";
              const collapsible = section.label === "Pinned" && section.sessions.length > 10;
              const open = !collapsible || pinnedOpen;
              return (
                <section key={section.label} aria-label={section.label}>
                  {collapsible ? (
                    <button
                      type="button"
                      data-testid="switcher-pinned-toggle"
                      aria-expanded={pinnedOpen}
                      className={cn(
                        heading,
                        "w-full justify-between gap-2 pr-7 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      )}
                      onClick={() => setPinnedOpen((value) => !value)}
                    >
                      Pinned ({section.sessions.length})
                      <ChevronDownIcon
                        aria-hidden
                        className={cn(
                          "size-4 shrink-0 transition-transform duration-[var(--dur-fast)] motion-reduce:transition-none",
                          pinnedOpen && "rotate-180",
                        )}
                      />
                    </button>
                  ) : (
                    <h3 className={heading}>{section.label}</h3>
                  )}
                  {open
                    ? section.sessions.map((session) => (
                        <DrawerSessionRow
                          key={session.path}
                          session={session}
                          awaiting={awaiting}
                          selected={session.path === currentPath}
                          pinned={section.label !== "Pinned" && pinnedSet.has(session.path)}
                          ambiguousTitle={dupTitles.has(sessionTitle(session))}
                          highlight={searching ? trimmedQuery : undefined}
                          raised={actionTarget?.session.path === session.path}
                          onOpen={(path) => {
                            if (sessionStatus(session, awaiting) === "needs-you" && session.pendingAsk) {
                              setAnswerSession(session);
                              return;
                            }
                            onSwitch(path);
                          }}
                          onActions={openActions}
                        />
                      ))
                    : null}
                </section>
              );
            })}

            {searchState.showMessages ? (
              <section aria-label="Messages" data-testid="message-results">
                <h3 className="m-0 mt-4 flex min-h-11 items-center px-7 text-meta font-semibold text-muted-foreground">
                  Messages
                </h3>
                {messageSearchFailed ? (
                  <div className="px-3 py-2">
                    <Notice
                      tone="danger"
                      action={
                        errorRecoveryAction(messageSearchError) ?? {
                          label: "Retry",
                          onClick: () => setMessageNonce((n) => n + 1),
                        }
                      }
                      testId="message-search-error"
                    >
                      Couldn’t search messages.
                    </Notice>
                  </div>
                ) : messagesPending && messageRows.length === 0 ? (
                  <p
                    className="flex min-h-12 items-center gap-2 px-7 text-meta text-muted-foreground"
                    data-testid="message-search-loading"
                    role="status"
                  >
                    <Spinner size={14} label={null} />
                    Searching messages…
                  </p>
                ) : messageRows.length === 0 ? (
                  <p className="flex min-h-12 items-center px-7 text-meta text-muted-foreground" data-testid="message-search-empty">
                    No messages match
                  </p>
                ) : (
                  messageRows.map((hit) => (
                    <button
                      key={hit.path}
                      type="button"
                      data-testid="message-hit"
                      data-session-path={hit.path}
                      onClick={() => onSwitch(hit.path, hit.entryId)}
                      className="pressable mx-3 my-0.5 flex min-h-14 w-[calc(100%-1.5rem)] items-start gap-3 rounded-xl px-4 py-2.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-surface-2"
                    >
                      <MessageSquareTextIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-foreground">
                          {markMatches(hit.title, trimmedQuery)}
                        </span>
                        <span className="line-clamp-2 text-meta text-muted-foreground">
                          {markMatches(hit.line, trimmedQuery)}
                        </span>
                      </span>
                    </button>
                  ))
                )}
                {transcript?.truncated && !messageSearchFailed && !messagesPending ? (
                  <p className="px-7 pt-1 text-caption text-muted-foreground" data-testid="message-search-truncated">
                    Recent messages only
                  </p>
                ) : null}
              </section>
            ) : null}

            {nextCursor ? (
              <div className="flex justify-center pt-3" ref={setMoreSentinel}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="session-load-more"
                  aria-busy={loadingMore}
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? "Loading…" : "Load older chats"}
                </Button>
              </div>
            ) : null}
          </div>
        )}

      </div>

      <Button
        type="button"
        data-testid={project ? "project-new-chat" : "switcher-new-chat"}
        className="absolute bottom-5 left-6 h-12 rounded-full bg-primary px-5 text-body font-semibold text-primary-foreground shadow-lg"
        onClick={() => openNewSession(project ?? undefined)}
      >
        <SquarePenIcon aria-hidden className="size-5" />
        New chat
      </Button>

      <DrawerRowActions
        target={actionTarget}
        root={root}
        sessions={sessions}
        controller={controller}
        onClose={closeActions}
        onChanged={refresh}
        onOpen={onSwitch}
      />

      <LazyMount open={answerSession !== null} onClose={() => setAnswerSession(null)}>
        <LazyAnswerSheet
          session={resolveAnswerSession(answerSession, sessions)}
          open={Boolean(answerSession)}
          onOpenChange={(open) => {
            if (!open) setAnswerSession(null);
          }}
          onSent={refresh}
          onOpenSession={() => {
            const path = answerSession?.path;
            setAnswerSession(null);
            if (path) onSwitch(path);
          }}
        />
      </LazyMount>
    </div>
  );
}
