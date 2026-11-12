import {
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { readPairingToken, readBrowserPreference as readStorage, writeBrowserPreference as writeStorage } from "../../platform/browser-storage";
import { haptic } from "../../platform/haptic";
import { recentProjects, type RecentProject } from "../../domain/recent-projects";
import type { OmpSessionSummary } from "../../domain/protocol";
import type { BrowseResult } from "../../runtime/api-types";
import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { DaemonApi, startSession, StartSessionError } from "../../runtime/rpc-client";
import { getAttachmentDraft } from "../../runtime/attachment-draft";
import { getNewSessionDraft, NEW_SESSION_DRAFT_PATH, readLastSessionChoice, rememberLastSessionChoice } from "../../runtime/new-session-draft";
import { useBackLayer } from "../back-layer";
import { AttachmentStrip } from "../composer/AttachmentStrip";
import { DictationBar } from "../composer/DictationBar";
import { VoiceButton } from "../composer/VoiceButton";
import { useDictation } from "../composer/use-dictation";
import { intakeFiles, MAX_IMAGES } from "../composer/image-intake";
import { activeTime, relativeTime, sessionTitle } from "../session-format";
import { useStoreValue } from "../store-hooks";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { LinkBanner } from "../ui/LinkBanner";
import { Notice } from "../ui/Notice";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { errorRecoveryAction } from "../ui/error-recovery";
import { DictationNotice } from "../composer/DictationNotice";
import { Row, RowGroup, RowSkeleton } from "../ui/Row";
import { SUGGESTIONS } from "../chat/EmptyChatHero";
import { openSwitcher } from "../nav/panels";
import { NeedsYouDot } from "./NeedsYouDot";
import { BottomSheet, SheetSearch } from "../ui/Sheet";
import { ModelPicker, modelKey, rememberRecentModel, useModelCatalogue, type ModelChoice } from "./ModelPicker";
import { levelAfterModelSwitch, modelChipLabel, thinkingChoices } from "./thinking-levels";
import { ProviderLogo } from "../ui/ProviderLogo";

/** The folder the browser last showed (and the one last chosen from it). */
const DIRP_LAST_KEY = "omp-dirp-last";
/** The computer's home folder, learnt from the browse answer that has no parent. */
const DIRP_HOME_KEY = "omp-dirp-home";


/** Windows daemons answer with backslash paths; everything else uses `/`. */
function separatorOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function baseName(path: string): string {
  const sep = separatorOf(path);
  const trimmed = path.length > 1 ? path.replace(sep === "/" ? /\/+$/ : /\\+$/, "") : path;
  return trimmed.slice(trimmed.lastIndexOf(sep) + 1) || trimmed;
}

/** The last three segments of a project path, for telling equally named projects apart. */
function pathTail(path: string): string {
  const sep = separatorOf(path);
  const segments = path.split(sep).filter(Boolean);
  return segments.length > 3 ? `…${sep}${segments.slice(-3).join(sep)}` : path;
}

type Crumb = { label: string; path: string };

/**
 * Breadcrumbs from the home folder down to `path`. The daemon only browses
 * under home, so ancestors above it are never offered. Before home is known
 * (an old install that remembered a deep folder) the parent the daemon
 * reported is the one safe step up.
 */
function crumbsFor(path: string, home: string | null, parent: string | null): Crumb[] {
  const sep = separatorOf(path);
  if (home && (path === home || path.startsWith(home.endsWith(sep) ? home : home + sep))) {
    const crumbs: Crumb[] = [{ label: "Home", path: home }];
    let at = home;
    for (const segment of path.slice(home.length).split(sep).filter(Boolean)) {
      at = at.endsWith(sep) ? at + segment : at + sep + segment;
      crumbs.push({ label: segment, path: at });
    }
    return crumbs;
  }
  const own = { label: baseName(path), path };
  return parent ? [{ label: baseName(parent), path: parent }, own] : [own];
}

function folderError(e: unknown): string {
  // The breadcrumbs already say which folder; drop a trailing path from the
  // daemon wording instead of repeating it.
  return humanizeDaemonError(e).replace(/\s+(?:reading\s+)?[\\/]\S*$/, "").replace(/([^.])$/, "$1.");
}

function sessionCountLabel(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`;
}

/**
 * Folder browser: the "Other folder…" step of the project sheet, as the parts
 * the sheet slots into its header, body and footer. Every browse bumps a
 * generation so a slower answer can never replace a newer folder, the
 * remembered destination, or the "Use this folder" state; closing and
 * unmounting bump it too.
 */
function useFolderBrowser({ active, onUse, onBack }: { active: boolean; onUse: (path: string) => void; onBack: (() => void) | null }) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The folder that failed to list, so the error state can still retry it and
  // offer its breadcrumbs.
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [home, setHome] = useState<string | null>(() => readStorage(DIRP_HOME_KEY));
  const generation = useRef(0);
  const crumbRail = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    generation.current++;
    return () => { generation.current++; };
  }, [active]);

  const load = useCallback(async (path: string | null, isRememberedFallback: boolean) => {
    const current = ++generation.current;
    const isCurrent = () => current === generation.current;
    const accept = (res: BrowseResult) => {
      writeStorage(DIRP_LAST_KEY, res.path || null);
      if (res.parent === null && res.path) {
        writeStorage(DIRP_HOME_KEY, res.path);
        setHome(res.path);
      }
      setData(res);
      setFilter("");
    };
    setLoading(true);
    setError(null);
    setFailedPath(null);
    const api = new DaemonApi(readPairingToken());
    try {
      const res = await api.browse(path ?? undefined);
      if (isCurrent()) accept(res);
    } catch (e: unknown) {
      if (!isCurrent()) return;
      if (!isRememberedFallback) {
        setError(e);
        setFailedPath(path);
        return;
      }
      // The remembered folder is gone or unreadable: start over at home.
      writeStorage(DIRP_LAST_KEY, null);
      try {
        const res = await api.browse(undefined);
        if (isCurrent()) accept(res);
      } catch (e2: unknown) {
        if (isCurrent()) setError(e2);
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    setData(null);
    setError(null);
    setFilter("");
    const stored = readStorage(DIRP_LAST_KEY);
    void load(stored, !!stored);
  }, [active, load]);

  useEffect(() => {
    // Keep the current folder (the last crumb) in view on deep paths.
    const rail = crumbRail.current;
    if (rail) rail.scrollLeft = rail.scrollWidth;
  }, [data?.path, failedPath]);

  const dirs = useMemo(() => {
    const all = data?.dirs ?? [];
    const query = filter.trim().toLowerCase();
    return query ? all.filter((dir) => dir.name.toLowerCase().includes(query)) : all;
  }, [data?.dirs, filter]);

  const shownPath = failedPath ?? data?.path ?? null;
  const crumbs = shownPath ? crumbsFor(shownPath, home, failedPath ? null : data?.parent ?? null) : [];

  // The crumb rail and filter keep their place while a folder loads (a
  // skeleton crumb, a disabled field), so the rows never jump when it lands.
  const subHeader = (
    <div className="space-y-2 px-4 pb-3">
      <div ref={crumbRail} className="no-scrollbar -mx-2 flex items-center overflow-x-auto" aria-label="Folder path">
        {crumbs.length === 0 ? (
          <span aria-hidden className="flex min-h-11 items-center px-2"><span className="h-3 w-24 rounded-sm bg-surface-2" /></span>
        ) : null}
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={crumb.path}>
              {index > 0 ? <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-tertiary" /> : null}
              {last ? (
                <span data-testid="folder-crumb-current" aria-current="location" className="flex min-h-11 shrink-0 items-center px-2 text-meta font-medium text-foreground">{crumb.label}</span>
              ) : (
                <button
                  type="button"
                  data-testid="folder-crumb"
                  aria-label={`Open ${crumb.path}`}
                  onClick={() => void load(crumb.path, false)}
                  className="flex min-h-11 shrink-0 items-center rounded-md px-2 text-meta text-muted-foreground outline-none pressable focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {crumb.label}
                </button>
              )}
            </Fragment>
          );
        })}
      </div>
      {failedPath === null ? (
        <fieldset disabled={!data || loading || (data.dirs.length === 0 && !filter)} className="min-w-0 disabled:opacity-50">
          <SheetSearch value={filter} onChange={setFilter} placeholder="Filter folders" testId="folder-filter" />
        </fieldset>
      ) : null}
    </div>
  );

  let body: ReactNode;
  if (error && (failedPath !== null || !data)) {
    body = (
      <Notice tone="danger" title="Couldn’t open this folder." action={errorRecoveryAction(error) ?? { label: "Try again", onClick: () => void load(failedPath, false) }}>
        {folderError(error)}
      </Notice>
    );
  } else if (!data) {
    body = <RowGroup>{[0, 1, 2, 3].map((index) => <RowSkeleton key={index} leading />)}</RowGroup>;
  } else if (dirs.length > 0) {
    body = (
      <RowGroup>
        {dirs.map((dir) => (
          <Row
            key={dir.path}
            testId="dir-row"
            onClick={() => void load(dir.path, false)}
            leading={<FolderIcon />}
            title={dir.name}
            aria-label={`Open ${dir.path}`}
            chevron
          />
        ))}
      </RowGroup>
    );
  } else if (filter.trim()) {
    body = (
      <EmptyState
        icon={<SearchIcon />}
        title={`No folders match “${filter.trim()}”`}
        action={{ label: "Clear filter", onClick: () => setFilter("") }}
      />
    );
  } else {
    body = <EmptyState icon={<FolderIcon />} title="No folders here" description="You can still start the session in this one." />;
  }

  return {
    title: "Choose folder",
    leading: onBack ? (
      <Button variant="ghost" size="icon" aria-label="Back to projects" onClick={onBack} className="-ml-3 text-muted-foreground">
        <ArrowLeftIcon aria-hidden className="size-5" />
      </Button>
    ) : undefined,
    subHeader,
    body,
    footer: (
      <Button
        variant="primary"
        className="w-full"
        data-testid="folder-use"
        disabled={!data || loading || failedPath !== null}
        onClick={() => {
          if (!data) return;
          writeStorage(DIRP_LAST_KEY, data.path);
          onUse(data.path);
        }}
      >
        Use this folder
      </Button>
    ),
  };
}

/**
 * Where the new session runs: recent projects first, then any folder under
 * home. Opens straight into the folder browser when there is no history.
 */
export function ProjectSheet({
  open,
  onOpenChange,
  projects,
  selected,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly RecentProject[];
  selected: string | null;
  onSelect: (cwd: string) => void;
}) {
  const hasRecent = projects.length > 0 || selected !== null;
  const hasRecentRef = useRef(hasRecent);
  hasRecentRef.current = hasRecent;
  const [browsing, setBrowsing] = useState(!hasRecent);
  // A sheet lifetime starts on open; history arriving later must not flip the view.
  useEffect(() => { if (open) setBrowsing(!hasRecentRef.current); }, [open]);
  // Back from the browser returns to the recent list before it closes the sheet.
  useBackLayer(open && browsing && hasRecent, { onBack: () => setBrowsing(false) });
  const choose = (cwd: string) => {
    onSelect(cwd);
    onOpenChange(false);
  };
  const browser = useFolderBrowser({ active: open && browsing, onUse: choose, onBack: hasRecent ? () => setBrowsing(false) : null });

  const now = Date.now();
  const rows: RecentProject[] = selected && !projects.some((project) => project.cwd === selected)
    ? [{ cwd: selected, label: baseName(selected), lastActiveAt: 0, sessionCount: 0 }, ...projects]
    : [...projects];

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={browsing ? browser.title : "Project"}
      leading={browsing ? browser.leading : undefined}
      subHeader={browsing ? browser.subHeader : undefined}
      footer={browsing ? browser.footer : undefined}
      testId="project-sheet"
    >
      {browsing ? browser.body : (
        <div className="space-y-4">
          <RowGroup title="Recent" testId="project-recent">
            {rows.map((project) => {
              const isSelected = project.cwd === selected;
              const time = project.lastActiveAt ? relativeTime(project.lastActiveAt, now) : "";
              return (
                <Row
                  key={project.cwd}
                  testId="project-row"
                  data-cwd={project.cwd}
                  aria-pressed={isSelected}
                  onClick={() => choose(project.cwd)}
                  leading={<FolderGit2Icon />}
                  title={project.label}
                  subtitle={project.sessionCount ? `${pathTail(project.cwd)} · ${sessionCountLabel(project.sessionCount)}` : pathTail(project.cwd)}
                  trailing={isSelected ? <CheckIcon aria-label="Selected" className="size-5 text-primary-text" /> : time || null}
                />
              );
            })}
          </RowGroup>
          <RowGroup>
            <Row testId="project-other-folder" onClick={() => setBrowsing(true)} leading={<FolderOpenIcon />} title="Other folder…" chevron />
          </RowGroup>
        </div>
      )}
    </BottomSheet>
  );
}

const SUGGESTION_CHIP = "min-h-11 rounded-full bg-surface-2 px-4 py-2 text-ui text-foreground outline-none active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The app's home: a new chat, ChatGPT-style. Floating ≡ and project pill over
 * a hero with starting points, and the chat composer's card at the bottom. The
 * project and model default to what was used last, so the common case is type
 * and send.
 */
export function NewSessionScreen({
  controller,
  onStarted,
  onOpenSession,
}: {
  controller: OmpSessionController;
  onStarted: (sessionPath: string) => void;
  /** An existing chat, from the "Continue" suggestion. */
  onOpenSession: (sessionPath: string) => void;
}) {
  const store = controller.getStore();
  const needsYouHint = useId();
  const sessions = useStoreValue(store, (state) => state.sessions);
  // Home is a long-lived screen now: keep "Continue" on the newest chat (one
  // started on the computer, or a listing that was empty at a cold start).
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") void controller.loadSessions().catch(() => undefined); };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [controller]);
  const continueChat = useMemo(
    () => sessions.reduce<OmpSessionSummary | null>((latest, session) => (latest === null || activeTime(session) > activeTime(latest) ? session : latest), null),
    [sessions],
  );
  const projects = useMemo(() => recentProjects(sessions), [sessions]);
  const [draft] = useState(() => getNewSessionDraft());
  const draftState = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const [attachments] = useState(() => getAttachmentDraft(draft.namespace, NEW_SESSION_DRAFT_PATH));
  const attachmentState = useSyncExternalStore(attachments.subscribe, attachments.getSnapshot);
  const { project: chosenProject, choice, text, createdSessionPath, transferredSessionPath } = draftState.value;
  const setChosenProject = (project: string) => draft.update({ project });
  const setChoice = (choice: ModelChoice) => draft.update({ choice });
  const setText = (text: string) => draft.update({ text });
  const [home, setHome] = useState<string | null>(() => readStorage(DIRP_HOME_KEY));
  const choiceTouched = useRef(choice !== null);
  const textRef = useRef(text);
  textRef.current = text;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const images = attachmentState.images;
  const intakePending = attachmentState.loading || attachmentState.pending > 0;
  const sending = attachmentState.sending;
  const attachError = attachmentState.error;
  const [error, setError] = useState<unknown>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const lastEmpty = useRef(false);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);

  // Default project: the reader's pick, else the most recently used project,
  // else home (a fresh install, where starting there is what "new session"
  // always did).
  const project = chosenProject ?? projects[0]?.cwd ?? home;
  const needHome = project === null;
  useEffect(() => {
    if (project !== null && draft.getSnapshot().value.project === null) draft.update({ project });
  }, [project, draft]);
  useEffect(() => {
    if (!needHome) return;
    let cancelled = false;
    new DaemonApi(readPairingToken()).browse(undefined).then((res) => {
      if (cancelled || !res.path) return;
      writeStorage(DIRP_HOME_KEY, res.path);
      setHome(res.path);
    }, () => { /* The chip then reads "Choose project" and the sheet offers folders. */ });
    return () => { cancelled = true; };
  }, [needHome]);

  // Any listed session can answer the model catalogue; one in the chosen
  // project also sees that project's own model config.
  const catalogueSession = (project !== null ? sessions.find((session) => session.cwd === project)?.path : undefined) ?? sessions[0]?.path ?? null;
  const catalogue = useModelCatalogue(catalogueSession, true);

  // Default model: the one the last new session used, else omp's most
  // recently used. Without either the computer's default applies.
  useEffect(() => {
    if (choiceTouched.current || catalogue.models.length === 0) return;
    const stored = readLastSessionChoice(draft.namespace);
    const find = (key: string) => catalogue.models.find((model) => modelKey(model) === key);
    const model = (stored ? find(stored.key) : undefined) ?? catalogue.recent.map(find).find((match) => match !== undefined);
    if (!model) return;
    const level = stored && stored.key === modelKey(model) && thinkingChoices(model).includes(stored.thinkingLevel)
      ? stored.thinkingLevel
      : levelAfterModelSwitch(model, undefined);
    setChoice({ model, thinkingLevel: level });
    choiceTouched.current = true;
  }, [catalogue]);

  const voiceSend = useRef(false);
  const startRef = useRef<(empty: boolean, transcript?: string) => Promise<void>>(async () => {});
  const dictation = useDictation({
    onTranscribed: (words) => {
      // A finished recording can outlive this screen, but must never create
      // a session after Back or append to a later new-session draft.
      if (!mounted.current) return;
      const draft = textRef.current;
      const next = draft + (draft && !/\s$/.test(draft) ? " " : "") + words;
      textRef.current = next;
      setText(next);
      const send = voiceSend.current;
      voiceSend.current = false;
      if (send) void startRef.current(false, next);
      else inputRef.current?.focus();
    },
    onError: () => { voiceSend.current = false; },
  });
  const dictating = dictation.status === "requesting" || dictation.status === "recording" || dictation.status === "transcribing";
  const stopDictation = (send: boolean) => {
    voiceSend.current = send;
    dictation.stop();
  };
  const cancelDictation = () => {
    voiceSend.current = false;
    dictation.cancel();
  };
  const [dismissedDictationError, setDismissedDictationError] = useState<string | null>(null);
  useEffect(() => {
    if (dictating) setDismissedDictationError(null);
  }, [dictating]);
  const dictationError = (dictation.status === "error" || dictation.status === "denied") &&
    dictation.lastError !== dismissedDictationError ? dictation.lastError : null;
  const dictationNotice = dictationError ??
    (dictation.status === "idle" && dictation.canRetry ? "Transcription cancelled." : null);

  const prompt = text.trim();
  const canSend = project !== null && attachmentState.restored && !sending && !transferredSessionPath && !dictating && !intakePending && (prompt.length > 0 || images.length > 0);

  const start = async (empty: boolean, transcript?: string) => {
    if (project === null || !attachmentState.restored || pending.current || intakePending || (dictating && transcript === undefined)) return;
    const current = ++generation.current;
    const isCurrent = () => current === generation.current && mounted.current;
    const submitted = draft.getSnapshot().value;
    if (submitted.transferredSessionPath) {
      pending.current = true;
      try {
        const retry = attachments.retryCleanup();
        let cleanup = retry;
        if (!cleanup) {
          const cleanupLease = attachments.beginSend(() => draft.clearConsumed(submitted.revision));
          if (!cleanupLease) return;
          const committed = cleanupLease.commit();
          cleanup = attachments.retryCleanup() ?? committed;
        }
        const cleared = await cleanup;
        if (cleared && isCurrent()) onStarted(submitted.transferredSessionPath);
      } finally { pending.current = false; }
      return;
    }
    const lease = attachments.beginSend(() => draft.clearConsumed(submitted.revision));
    if (!lease) return;
    const message = empty ? "" : (transcript ?? textRef.current).trim();
    pending.current = true;
    lastEmpty.current = empty;
    setError(null);
    dictation.discardRetry();
    haptic("light");
    const transfer = async (path: string) => {
      if (empty && (submitted.text || lease.images.length)) {
        // Starting an empty session did not consume the prompt left here.
        lease.fail("");
      } else {
        draft.markTransferred(submitted.revision, path);
        const committed = lease.commit();
        // commit's lifetime promise survives failed cleanup. Await this attempt
        // instead, so a storage failure releases the guard for cleanup-only Retry.
        if (!await (attachments.retryCleanup() ?? committed)) return;
      }
      if (isCurrent()) onStarted(path);
    };
    try {
      // Only this branch creates/enqueues. A transferred draft retries cleanup
      // above, including after reload, without duplicating its prompt.
      const result = await startSession({
        cwd: project,
        sessionPath: createdSessionPath ?? undefined,
        model: choice ? { provider: choice.model.provider, id: choice.model.id } : undefined,
        thinkingLevel: choice?.thinkingLevel || undefined,
        prompt: message,
        attachments: (empty ? [] : lease.images).map(({ data, mimeType }) => ({ data, mimeType })),
      });
      if (choice) {
        rememberLastSessionChoice(draft.namespace, modelKey(choice.model), choice.thinkingLevel);
        rememberRecentModel(modelKey(choice.model));
      }
      await transfer(result.sessionPath);
    } catch (e: unknown) {
      if (e instanceof StartSessionError && e.stage === "prompt") {
        await transfer(e.sessionPath);
        return;
      }
      lease.fail("");
      if (e instanceof StartSessionError) {
        // The recovery target must survive Back/reload too, even when the
        // asynchronous failure belongs to an unmounted screen.
        draft.rememberCreated(submitted.revision, e.sessionPath, project);
      }
      if (isCurrent()) {
        haptic("error");
        setError(e);
      }
    } finally {
      pending.current = false;
    }
  };
  startRef.current = start;

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (!files.length || pending.current) return;
    await attachments.addFiles(files, intakeFiles, MAX_IMAGES);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter is a newline on a phone keyboard; Ctrl/Cmd+Enter sends.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && canSend) {
      event.preventDefault();
      void start(false);
    }
  };

  const projectLabel = project !== null ? baseName(project) : "Choose project";
  const modelLabel = choice ? modelChipLabel(choice.model.name || choice.model.id, choice.thinkingLevel) : "Default";

  return (
    <div data-testid="new-session-screen" className="flex h-full min-h-0 flex-col bg-background">
      {/* The chat header's floating chrome: only the round ≡. The project sits
          in the composer beside the model: both are "where this message goes",
          and a pill at the top read as a title, not a control. */}
      <header className="box-content flex h-14 shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top)]">
        <Button
          aria-label="Open sessions"
          aria-describedby={needsYouHint}
          data-testid="new-session-menu"
          className="relative size-12 shrink-0 rounded-full bg-surface-2 text-foreground ring-1 ring-inset ring-white/10 transition-transform duration-[var(--dur-fast)] active:scale-[0.94] motion-reduce:transition-none"
          onClick={openSwitcher}
          size="icon"
          type="button"
          variant="ghost"
        >
          <MenuIcon className="size-[22px]" strokeWidth={1.9} aria-hidden />
          <NeedsYouDot controller={controller} currentPath={null} hintId={needsYouHint} />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 text-center">
        {/* In the scrolling part, not above the card: a cold start with the
            computer unreachable said nothing, and a banner beside the composer
            would move it (and the keyboard layout) when the link drops. */}
        <LinkBanner className="w-full shrink-0 text-left" onRetry={() => void controller.loadSessions().catch(() => undefined)} />
        <div className="flex min-w-0 flex-col items-center gap-1">
          <h1 className="max-w-[16ch] text-balance text-large-title font-semibold text-foreground">What should we work on?</h1>
          <Button
            variant="ghost"
            size="sm"
            data-testid="new-session-start-empty"
            className="text-primary-text"
            disabled={project === null || !attachmentState.restored || sending || transferredSessionPath !== null || dictating || intakePending}
            onClick={() => void start(true)}
          >
            Start without a message
          </Button>
        </div>
        {/* Typing replaces the starting points, as in ChatGPT; a chip never
            has to merge with a draft. */}
        {prompt === "" && images.length === 0 ? (
          <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Suggestions">
            {continueChat ? (
              <button
                type="button"
                data-testid="new-session-continue"
                onClick={() => onOpenSession(continueChat.path)}
                className={cn(SUGGESTION_CHIP, "max-w-full truncate")}
              >
                Continue: {sessionTitle(continueChat)}
              </button>
            ) : null}
            {SUGGESTIONS.slice(0, continueChat ? 3 : 4).map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                data-testid="new-session-suggestion"
                onClick={() => {
                  textRef.current = suggestion;
                  setText(suggestion);
                  inputRef.current?.focus();
                }}
                className={SUGGESTION_CHIP}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Notices float above the card instead of joining the flow, so an error
          never shoves the centred hint up the screen. */}
      <div className="relative shrink-0 px-3 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-1">
        {error || attachError || draftState.error || transferredSessionPath || dictationNotice ? (
          // Opaque page fill behind the tinted notices: the hint may sit under them.
          <div className="absolute inset-x-3 bottom-full z-raised space-y-2 bg-background pb-2">
            {error ? (
              <Notice
                tone="danger"
                title={createdSessionPath ? "Couldn’t finish starting the session." : "Couldn’t start the session."}
                testId="new-session-error"
                action={errorRecoveryAction(error, () => setModelOpen(true)) ?? { label: "Try again", onClick: () => void start(lastEmpty.current) }}
                onDismiss={() => setError(null)}
              >
                {humanizeDaemonError(error)}
              </Notice>
            ) : null}
            {draftState.error ? (
              <Notice tone="danger" testId="new-session-storage-error" action={{ label: "Try again", onClick: () => { draft.retry(); } }}>
                {draftState.error}
              </Notice>
            ) : null}
            {transferredSessionPath ? (
              <Notice tone="warning" testId="new-session-cleanup-error" action={{ label: "Try again", onClick: () => void start(false) }}>
                Message saved. Retry to finish updating its draft without sending it again.
              </Notice>
            ) : null}
            {attachError ? (
              <Notice tone="warning" testId="new-session-attachment-error" action={/no images found|try a jpeg or png/i.test(attachError) && !intakePending
                ? { label: "Choose image", onClick: () => fileRef.current?.click() }
                : /fewer photos|remove one to add another/i.test(attachError) && images.length
                  ? { label: "Review images", onClick: () => inputRef.current?.closest("fieldset")?.querySelector<HTMLButtonElement>('[data-testid="attachment-remove"]')?.focus() }
                  : errorRecoveryAction(attachError) ?? { label: "Try again", onClick: () => {
                if (transferredSessionPath) { void start(false); return; }
                void (attachmentState.restored ? attachments.flush() : attachments.sync()).then(
                  () => { if (attachments.getSnapshot().restored) attachments.setError(null); },
                  (error: unknown) => attachments.setError(humanizeDaemonError(error)),
                );
              } }}>{attachError}</Notice>
            ) : null}
            {dictationNotice ? (
              <DictationNotice
                dictation={dictation}
                message={dictationNotice}
                onRetry={() => {
                  voiceSend.current = false;
                  dictation.retry();
                }}
                onDismiss={() => {
                  setDismissedDictationError(dictationNotice);
                  dictation.discardRetry();
                }}
              />
            ) : null}
          </div>
        ) : null}
        {/* The chat composer's card (Composer.tsx): one rounded surface, no
            border, two rows. Starting a chat should feel like sending in one. */}
        <fieldset
          disabled={sending || transferredSessionPath !== null}
          data-testid="new-session-card"
          className="@container flex min-w-0 flex-col rounded-[calc(28px*var(--radius-scale,1))] bg-surface-2 shadow-[var(--shadow-float)]"
        >
          {images.length > 0 ? (
            <div className="px-3 pt-3">
              <AttachmentStrip images={images} onRemove={(index) => attachments.removeImage(index)} max={MAX_IMAGES} />
            </div>
          ) : null}
          <div className="px-2 pt-1.5">
            <textarea
              ref={inputRef}
              data-testid="new-session-input"
              aria-label="Message"
              placeholder={project === null ? "Describe a task" : `Describe a task in ${projectLabel}`}
              value={text}
              onChange={(event) => {
                textRef.current = event.target.value;
                setText(event.target.value);
              }}
              onKeyDown={onKeyDown}
              rows={1}
              className="field-sizing-content block max-h-40 min-h-11 w-full resize-none bg-transparent px-2 py-[0.6875rem] text-body caret-primary outline-none placeholder:text-tertiary"
            />
          </div>
          <div className="flex min-h-12 items-center gap-1 px-1.5 pb-1.5">
            {dictating ? (
              <div className="min-w-0 flex-1">
                <DictationBar
                  dictation={{ ...dictation, cancel: cancelDictation }}
                  onInsert={() => stopDictation(false)}
                  onInsertAndSend={() => stopDictation(true)}
                  sendDisabled={project === null || !attachmentState.restored || intakePending}
                />
              </div>
            ) : (
              <>
                <Button variant="ghost" size="icon" aria-label="Add image" data-testid="new-session-attach" disabled={!attachmentState.restored || images.length >= MAX_IMAGES || intakePending} onClick={() => fileRef.current?.click()} className="shrink-0 rounded-full text-foreground">
                  <PlusIcon aria-hidden className="size-6" strokeWidth={1.75} />
                </Button>
                <Chip
                  testId="new-session-project"
                  leading={<FolderIcon aria-hidden className="size-3.5 shrink-0" />}
                  trailing={<ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                  aria-label={project !== null ? `Project ${projectLabel}. Change project` : "Choose project"}
                  disabled={createdSessionPath !== null}
                  onClick={() => setProjectOpen(true)}
                  className="min-w-0 max-w-[9rem] shrink-0 bg-transparent px-1.5 text-foreground"
                >
                  {projectLabel}
                </Chip>
                <Chip
                  testId="new-session-model"
                  leading={choice ? <ProviderLogo model={choice.model.id} provider={choice.model.provider} className="size-3.5" /> : undefined}
                  trailing={<ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                  aria-label={`Model ${modelLabel}. Change model`}
                  onClick={() => setModelOpen(true)}
                  className="min-w-0 shrink bg-transparent px-1.5 text-muted-foreground"
                >
                  {modelLabel}
                </Chip>
                <span className="flex-1" />
                <VoiceButton dictation={dictation} />
                <Button variant={canSend ? "primary" : "secondary"} size="icon" aria-label={intakePending ? "Preparing images" : "Start session"} aria-busy={sending || intakePending} data-testid="new-session-send" disabled={!canSend} onClick={() => void start(false)} className="rounded-full">
                  {sending || intakePending ? <Spinner size={20} label={intakePending ? "Preparing images" : "Starting"} /> : <ArrowUpIcon aria-hidden className="size-5" />}
                </Button>
              </>
            )}
          </div>
        </fieldset>
      </div>

      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => void addFiles(event)} />

      <ProjectSheet
        open={projectOpen}
        onOpenChange={setProjectOpen}
        projects={projects}
        selected={project}
        onSelect={setChosenProject}
      />
      <ModelPicker
        open={modelOpen}
        onOpenChange={setModelOpen}
        draft={{
          catalogue,
          value: choice,
          onChange: (next) => {
            choiceTouched.current = true;
            setChoice(next);
          },
        }}
      />
    </div>
  );
}

export default NewSessionScreen;
