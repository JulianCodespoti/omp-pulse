import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import {
  PaletteIcon,
  ArchiveIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BellIcon,
  CopyIcon,
  CpuIcon,
  DownloadIcon,
  FileTextIcon,
  ImageIcon,
  InfoIcon,
  KeyRoundIcon,
  LogOutIcon,
  MessageSquareIcon,
  MonitorIcon,
  PowerIcon,
  ShieldCheckIcon,
  StethoscopeIcon,
  SquarePenIcon,
  SmartphoneIcon,
  PuzzleIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";

import { bindPairingRecovery, readPairingRecovery, readPairingRecoveryEntries, readPairingRecoveryEntry, readPairingRecoveryText, readPairingRecoveryImage, savePairingRecoveryAttachment, type PairingRecoveryArchive, type PairingRecoveryEntry } from "../runtime/offline-queue";
import { AppearanceSettings } from "./AppearanceSettings";
import { CopyButton } from "./parts/CopyButton";
import { clearPairingToken, readPairingToken } from "../platform/browser-storage";
import { ClipboardAttempt } from "../platform/clipboard";
import { clearNativeNotificationToken } from "../platform/native-notifications";
import { unsubscribePush } from "../platform/push";
import { updateClientNow } from "./update-client";
import type { OmpSessionController } from "../runtime/omp-session-controller";
import { DaemonApi } from "../runtime/rpc-client";
import { leaveComputer } from "../platform/local-mode";
import { useBackLayer } from "./back-layer";
import { ConnectComputer } from "./ConnectComputer";
import { DeviceAccess, PairAnotherDevice } from "./DeviceAccess";
import { HealthDetails, HealthPanel } from "./HealthPanel";
import {
  PhoneAccessSettings,
  RunOnSettings,
  useLocalMode,
} from "./LocalModeSettings";
import type { LocalRuntime } from "./LocalModeSettings";
import { openNewSession, openSettingsPage, type SettingsPage as Page, type SettingsRequest } from "./nav/panels";
import { ScreenActivityContext } from "./nav/screen-activity";
import { PairScreen } from "./PairScreen";
import { NotificationsPage, useNotificationsStatus } from "./settings/NotificationsPage";
import { PluginsSettings } from "./plugins/PluginsSettings";
import { ProvidersPage } from "./settings/ProvidersPage";
import { pushMutationInFlight, trackPushMutation } from "./settings/use-push-notifications";
import { showToast } from "./Notices";
import { computerName as nameComputer, sessionTitle } from "./session-format";
import { useStoreValue } from "./store-hooks";
import { Notice } from "./ui/Notice";
import { daemonErrorCause, humanizeDaemonError } from "./ui/OwnedBySession";
import { ErrorNotice } from "./ui/ErrorNotice";
import { Row, RowGroup, RowSkeleton } from "./ui/Row";
import { ScreenHeader } from "./ui/ScreenHeader";
import { ConfirmSheet } from "./ui/Sheet";
import { EmptyState } from "./ui/EmptyState";
import { StatusDot } from "./ui/Status";

const TITLE: Record<Page, string> = {
  root: "Settings",
  "run-on": "Run on",
  "phone-access": "Phone access",
  appearance: "Appearance",
  computer: "Computer",
  pair: "Pair another device",
  providers: "Model providers",
  "repair-pairing": "Repair pairing",
  "saved-work": "Saved work",
  "connect-computer": "Connect your computer",
  notifications: "Notifications",
  diagnostics: "Diagnostics",
  technical: "Technical details",
  plugins: "Plugins",
  about: "About",
};

/**
 * How a page in the stack is moving. The same push/pop the app uses between
 * screens (styles.css nav-* keyframes), played on the page elements: the new
 * page slides in over the old one, which parallaxes left under a dim.
 */
type Motion = "in-right" | "in-left" | "out-left" | "out-right" | null;
const MOTION: Record<Exclude<Motion, null>, string> = {
  "in-right": "nav-in-from-right",
  "in-left": "nav-in-from-left",
  "out-left": "nav-out-to-left",
  "out-right": "nav-out-to-right",
};
// Matches the screen transition in styles.css (::view-transition-*).
const NAV_MS = 380;

type Entry = { id: number; page: Page; motion: Motion; leaving: boolean };

type Connection = "checking" | "connected" | "unreachable";
const CONNECTION_LABEL: Record<Connection, string> = {
  checking: "Checking\u2026",
  connected: "Connected",
  unreachable: "Can\u2019t reach",
};

/**
 * Settings as a full-screen stack: a list of rows that push detail pages.
 * Back pops a detail page before it leaves Settings. Mounted by App as a
 * layer; `onClose` leaves it.
 */
export function SettingsScreen({
  onClose,
  controller,
  request,
  onConnected,
  onOpenSession,
  onRepairStart,
}: {
  onClose: () => void;
  controller: OmpSessionController;
  request?: SettingsRequest | null;
  onConnected: (credential: string, activeRepair?: boolean) => void;
  onOpenSession: (path: string) => void;
  onRepairStart?: () => void | (() => void);
}): JSX.Element {
  const active = useContext(ScreenActivityContext);
  const nextId = useRef(1);
  const [stack, setStack] = useState<Entry[]>([{ id: 0, page: request?.page ?? "root", motion: null, leaving: false }]);
  const lastRequest = useRef(request);
  useLayoutEffect(() => {
    if (!request || request === lastRequest.current) return;
    lastRequest.current = request;
    setStack((entries) => {
      const current = entries.filter((entry) => !entry.leaving);
      if (current.at(-1)?.page === request.page) return entries;
      const existing = current.findIndex((entry) => entry.page === request.page);
      if (existing >= 0) return current.slice(0, existing + 1).map((entry, index) => ({
        ...entry, motion: index === existing ? "in-left" : null,
      }));
      return [
        ...current.map((entry) => ({ ...entry, motion: "out-left" as const })),
        { id: nextId.current++, page: request.page, motion: "in-right", leaving: false },
      ];
    });
  }, [request]);
  const visible = stack.filter((entry) => !entry.leaving);
  const depth = visible.length;

  const push = useCallback((page: Page) => {
    setStack((entries) => [
      ...entries.map((entry) => (entry.leaving ? entry : { ...entry, motion: "out-left" as const })),
      { id: nextId.current++, page, motion: "in-right", leaving: false },
    ]);
  }, []);
  const pop = useCallback(() => {
    setStack((entries) => {
      const live = entries.filter((entry) => !entry.leaving);
      if (live.length < 2) return entries;
      const top = live[live.length - 1];
      const below = live[live.length - 2];
      return entries.map((entry) =>
        entry.id === top.id
          ? { ...entry, motion: "out-right" as const, leaving: true }
          : entry.id === below.id
            ? { ...entry, motion: "in-left" as const }
            : entry,
      );
    });
  }, []);
  // A popped page plays its exit, then unmounts. A timer rather than
  // animationend, which never fires when animations are disabled.
  const hasLeaving = stack.some((entry) => entry.leaving);
  useEffect(() => {
    if (!hasLeaving) return;
    const timer = window.setTimeout(
      () => setStack((entries) => entries.filter((entry) => !entry.leaving)),
      NAV_MS,
    );
    return () => window.clearTimeout(timer);
  }, [hasLeaving]);
  // App's layer closes Settings itself; this one only exists while a detail
  // page is open, and sits above it.
  useBackLayer(active && depth > 1, { onBack: pop });

  // ── Shared state the root and detail pages both read ────────────────────
  const local = useLocalMode(() => push("connect-computer"));
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("checking");
  const [unpaired, setUnpaired] = useState(false);
  const buildId = import.meta.env.VITE_RELEASE_ID || "dev";
  const isStale = daemonVersion !== null && buildId !== "dev" && daemonVersion !== buildId;

  const refreshVersion = useCallback(async () => {
    setConnection("checking");
    try {
      const body = await new DaemonApi(readPairingToken()).fetchJson<{ releaseId: string }>(
        "/api/version",
        { signal: AbortSignal.timeout(10_000) },
      );
      setDaemonVersion(typeof body.releaseId === "string" ? body.releaseId : null);
      setConnection("connected");
      setUnpaired(false);
    } catch (cause) {
      setConnection("unreachable");
      // A refused credential is the one failure repair can fix; an unreachable
      // computer is not a pairing problem.
      setUnpaired(daemonErrorCause(cause) === "pairing");
    }
  }, []);
  useEffect(() => {
    void refreshVersion();
  }, [refreshVersion]);

  // Whether earlier pairing repairs kept work: it stays reachable from the root.
  const [savedWorkKept, setSavedWorkKept] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => readPairingRecovery(readPairingToken()))
      .then((archive) => { if (live) setSavedWorkKept(hasSavedWork(archive)); }, () => undefined);
    return () => { live = false; };
  }, []);

  const notifications = useNotificationsStatus();

  /**
   * Unpair: the computer stops honouring this phone's credential, not just
   * this phone forgetting it. Signing out locally used to leave the device
   * listed and its token live on the computer. True once the computer has
   * revoked it (or no longer knows it); false when it could not be reached.
   */
  async function revokeOnComputer(): Promise<boolean> {
    const api = new DaemonApi(readPairingToken());
    try {
      const me = await api.fetchJson<{ device?: { id?: string } }>("/api/device", { signal: AbortSignal.timeout(10_000) });
      const id = me.device?.id;
      // The owner credential is the computer's own, never a paired device.
      if (!id || id === "owner") return true;
      await api.fetchJson(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
      return true;
    } catch (cause) {
      // Already revoked (e.g. removed from Devices first): nothing left to undo.
      return cause instanceof Error && cause.name === "AuthError";
    }
  }

  async function forgetLocalPairing() {
    // Wait for an in-flight enable before removing its endpoint, and keep
    // reopened Settings from starting another enable during sign-out.
    const previous = pushMutationInFlight();
    let revoked = true;
    const job = (async () => {
      await previous;
      await unsubscribePush();
      revoked = await revokeOnComputer();
      await controller.clearOfflineData();
      await clearNativeNotificationToken();
      clearPairingToken();
      controller.closeSession();
      controller.getStore().getState().setSessions([]);
      controller.getStore().getState().setAuthRejected(true);
    })();
    await trackPushMutation(job);
    if (!revoked) showToast("This phone is unpaired, but your computer couldn\u2019t be reached. Remove it there in Settings \u203a Devices.", "warn");
    // In the Android app, also drop the computer itself: nothing keeps
    // connecting to it or runs its notification service in the background.
    const bridge = local?.bridge;
    const laptopUrl = local?.state.mode === "laptop" ? local.state.laptopUrl : null;
    if (bridge && laptopUrl) {
      bridge.forgetComputer(laptopUrl);
      leaveComputer(bridge);
    }
  }

  // The machine's name as this phone reaches it ("studio" from
  // studio.tail1234.ts.net), or "This phone" when the daemon runs here.
  const computerName = nameComputer(window.location.hostname, local?.onPhone === true);

  function renderPage(page: Page): ReactNode {
    switch (page) {
      case "root":
        return (
          <RootPage
            controller={controller}
            push={push}
            notifications={notifications}
            local={local}
            computerName={computerName}
            connection={connection}
            unpaired={unpaired}
            savedWorkKept={savedWorkKept}
            isStale={isStale}
            versionKnown={daemonVersion !== null}
            onForget={forgetLocalPairing}
          />
        );
      case "run-on":
        return local ? <RunOnSettings local={local} /> : null;
      case "connect-computer":
        return local ? <ConnectComputer bridge={local.bridge} /> : null;
      case "phone-access":
        return local ? <PhoneAccessSettings local={local} /> : null;
      case "providers":
        return <ProvidersPage controller={controller} />;
      case "notifications":
        return <NotificationsPage />;
      case "appearance":
        return <AppearanceSettings />;
      case "plugins":
        return <PluginsSettings />;
      case "computer":
        return <DeviceAccess onPairAnother={() => push("pair")} />;
      case "pair":
        return <PairAnotherDevice />;
      case "repair-pairing":
        return <RepairPairing controller={controller} onConnected={onConnected} onRepairStart={onRepairStart} onOpenSession={onOpenSession} />;
      case "saved-work":
        return <SavedWorkPage controller={controller} onOpenSession={onOpenSession} />;
      case "diagnostics":
        return (
          <HealthPanel
            controller={controller}
            notifications={notifications}
            onNotifications={() => push("notifications")}
            onTechnicalDetails={() => push("technical")}
            onOpenSession={onOpenSession}
          />
        );
      case "technical":
        return <HealthDetails controller={controller} />;
      case "about":
        return (
          <AboutPage
            controller={controller}
            buildId={buildId}
            daemonVersion={daemonVersion}
            connection={connection}
            isStale={isStale}
            onViewPending={() => {
              const path = controller.getUpdateSafety().pendingSessionPath
                ?? controller.getStore().getState().sessionPath;
              if (path) onOpenSession(path);
              else onClose();
            }}
          />
        );
    }
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="settings-screen">
      {stack.map((entry) => {
        const top = !entry.leaving && entry.id === visible[visible.length - 1]?.id;
        // The device list is the PC's paired devices, or the devices that can reach this phone.
        const title = entry.page === "computer" && local?.onPhone ? "Device access" : TITLE[entry.page];
        const style: CSSProperties | undefined = entry.motion
          ? { animation: `${MOTION[entry.motion]} ${NAV_MS}ms var(--ease-sheet) both` }
          : undefined;
        return (
          <section
            key={entry.id}
            aria-label={title}
            aria-hidden={top ? undefined : true}
            inert={!top}
            data-settings-page={entry.page}
            className="absolute inset-0 flex flex-col bg-background"
            style={style}
          >
            <ScreenHeader
              title={title}
              backLabel={depth === 1 ? "Close settings" : "Back"}
              onBack={depth === 1 ? onClose : pop}
            />
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-2">
              <ScreenActivityContext.Provider value={active && top}>
                {renderPage(entry.page)}
              </ScreenActivityContext.Provider>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The repair page: only reachable while the computer refuses this phone (or
 * from the error action that says so). Saved work retained by earlier repairs
 * sits above the pairing form.
 */
function RepairPairing({ controller, onConnected, onRepairStart, onOpenSession }: {
  controller: OmpSessionController;
  onConnected: (credential: string, activeRepair?: boolean) => void;
  onRepairStart?: () => void | (() => void);
  onOpenSession: (path: string) => void;
}): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [archive, setArchive] = useState<PairingRecoveryArchive | null>(null);
  const pending = useRef<PairingRecoveryArchive | null>(null);
  const activeRepair = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    activeRepair.current = true;
    const finishRepair = controller.beginPairingRepair();
    const cancelOrigin = onRepairStart?.();
    setError(null);
    void (async () => {
      const retained = await readPairingRecovery(readPairingToken());
      if (!current) return;
      setArchive(retained);
      setReady(true);
    })().catch(() => {
      if (current) setError("Couldn't read saved work from pairing repair. Pairing hasn't changed. Retry when device storage is available.");
    });
    return () => {
      current = false;
      activeRepair.current = false;
      finishRepair();
      if (typeof cancelOrigin === "function") cancelOrigin();
    };
  }, [controller, attempt, onRepairStart]);
  if (error) return <ErrorNotice message="Couldn't read saved work. Pairing hasn't changed." details={error} onRetry={() => setAttempt(value => value + 1)} />;
  if (!ready) return <RowGroup inset><RowSkeleton leading subtitle /></RowGroup>;
  return <div className="flex flex-col gap-6">
    {hasSavedWork(archive)
      ? <SavedPairingWork controller={controller} credential={readPairingToken()} onOpenSession={onOpenSession} /> : null}
    <PairScreen repair initialCode="" beforePair={async () => {
      pending.current = await controller.preparePairingRepair();
    }} retainCredential={async credential => {
      if (!pending.current) throw new Error("Your work must be preserved before pairing.");
      await bindPairingRecovery(pending.current, credential);
    }} onConnected={credential => {
      showToast("Pairing repaired. Your previous work is retained.", "success", {
        label: "View saved work", onClick: () => openSettingsPage("saved-work"),
      });
      onConnected(credential, activeRepair.current);
    }} />
  </div>;
}

/** The archive holds something to recover: any retained source or any browser scope. */
function hasSavedWork(archive: PairingRecoveryArchive | null): boolean {
  return Boolean(archive && (archive.sources.some(source => source.count > 0) || archive.browserScopes?.length));
}

/** Settings › Saved work: what earlier pairing repairs kept, readable while pairing is fine. */
function SavedWorkPage({ controller, onOpenSession }: { controller: OmpSessionController; onOpenSession: (path: string) => void }): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [archive, setArchive] = useState<PairingRecoveryArchive | null | undefined>(undefined);
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    setError(false);
    void readPairingRecovery(readPairingToken()).then(
      value => { if (current) setArchive(value); },
      () => { if (current) setError(true); },
    );
    return () => { current = false; };
  }, [attempt]);
  if (error) return <ErrorNotice message="Couldn't read saved work." onRetry={() => setAttempt(value => value + 1)} />;
  if (archive === undefined) return <RowGroup inset><RowSkeleton leading subtitle /></RowGroup>;
  return hasSavedWork(archive)
    ? <SavedPairingWork controller={controller} credential={readPairingToken()} onOpenSession={onOpenSession} />
    : <EmptyState icon={<ArchiveIcon />} title="No saved work" description="Work kept by a pairing repair appears here." />;
}

function SavedPairingWork({ controller, credential, onOpenSession }: { controller: OmpSessionController; credential: string; onOpenSession: (path: string) => void }): JSX.Element {
  const sessions = useStoreValue(controller.getStore(), state => state.sessions);
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<{ items: PairingRecoveryEntry[]; next: number | null } | null>(null);
  const [selected, setSelected] = useState<PairingRecoveryEntry | null>(null);
  const [error, setError] = useState(false);
  const sourceTitle = (path: string): string => {
    if (path === "new-session") return "New session";
    const session = sessions.find(candidate => candidate.path === path);
    if (session) return sessionTitle(session);
    const filename = path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? path;
    return `Conversation · ${filename.slice(-8)}`;
  };
  useEffect(() => {
    let current = true;
    setError(false);
    setPage(null);
    void readPairingRecoveryEntries(credential, offset).then(
      value => { if (current) setPage(value); },
      () => { if (current) setError(true); },
    );
    return () => { current = false; };
  }, [credential, offset, attempt]);
  return <section aria-label="Saved work from pairing repair" className="flex min-w-0 flex-col gap-4">
    <h2 className="text-headline font-semibold">Saved work</h2>
    <p className="text-meta text-muted-foreground">Read-only copies. Nothing is sent automatically, and messages may already have been sent, so check before reusing them. Later draft changes are included; earlier copies are listed separately.</p>
    {error ? <ErrorNotice message="Couldn't read saved work." details="Retry when device storage is available." onRetry={() => setAttempt(value => value + 1)} /> : null}
    {!page && !error ? <RowGroup><RowSkeleton leading subtitle /><RowSkeleton leading subtitle /></RowGroup> : null}
    {page?.items.map(item => <article key={item.key} className="flex min-w-0 flex-col gap-2 border-b border-hairline pb-2">
      <RowGroup>
        <Row
          leading={item.kind === "draft" ? <FileTextIcon /> : <MessageSquareIcon />}
          title={sourceTitle(item.sessionPath)}
          subtitle={item.kind === "draft" ? item.browser ? "Latest draft" : "Saved draft" : "Saved message"}
          chevron
          aria-expanded={selected?.key === item.key}
          onClick={() => setSelected(selected?.key === item.key ? null : item)}
        />
      </RowGroup>
      {selected?.key === item.key ? <>
        <SavedPairingEntry key={item.key} credential={credential} item={item} />
        <p className="select-text break-words text-meta text-muted-foreground [overflow-wrap:anywhere]">
          {item.sessionPath === "new-session" ? "New session" : item.sessionPath}
          {item.kind !== "draft" && item.state ? ` · Saved status: ${item.state}` : null}
        </p>
        <RowGroup>
          <Row
            leading={item.sessionPath === "new-session" ? <SquarePenIcon /> : <MessageSquareIcon />}
            title={item.sessionPath === "new-session" ? "Open new draft" : "Open conversation"}
            chevron
            onClick={() => item.sessionPath === "new-session" ? openNewSession() : onOpenSession(item.sessionPath)}
          />
        </RowGroup>
      </> : null}
    </article>)}
    {offset > 0 || page?.next !== null && page?.next !== undefined ? <RowGroup>
      {offset > 0 ? <Row leading={<ArrowLeftIcon />} title="Previous saved work" onClick={() => { setSelected(null); setOffset(Math.max(0, offset - 20)); }} /> : null}
      {page?.next !== null && page?.next !== undefined ? <Row leading={<ArrowRightIcon />} title="More saved work" onClick={() => { setSelected(null); setOffset(page.next ?? offset); }} /> : null}
    </RowGroup> : null}
  </section>;
}

function SavedPairingEntry({ credential, item }: { credential: string; item: PairingRecoveryEntry }): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [details, setDetails] = useState<PairingRecoveryEntry | null>(item.browser ? null : item);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!item.browser) return;
    let current = true;
    setFailed(false);
    setDetails(null);
    void readPairingRecoveryEntry(credential, item.key).then(
      value => { if (current) setDetails(value); },
      () => { if (current) setFailed(true); },
    );
    return () => { current = false; };
  }, [credential, item.browser, item.key, attempt]);
  if (failed) return <ErrorNotice message="Couldn't read this saved draft or send." details="Retry when device storage is available. Earlier copies, if any, are listed separately." onRetry={() => setAttempt(value => value + 1)} />;
  if (!details) return <Notice tone="info">Reading selected saved work…</Notice>;
  return <SavedPairingEntryContent credential={credential} item={details} />;
}

function SavedPairingEntryContent({ credential, item }: { credential: string; item: PairingRecoveryEntry }): JSX.Element {
  const [part, setPart] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [imageIndex, setImageIndex] = useState<number | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ index: number; message: string } | null>(null);
  function saveAttachment(index: number): void {
    setSaveError(null);
    void savePairingRecoveryAttachment(credential, item.key, index).then(
      saved => { if (!saved) setSaveError({ index, message: "Attachment wasn't saved. Your copy is still retained." }); },
      () => setSaveError({ index, message: "Couldn't save the attachment. Your copy is still retained." }),
    );
  }
  useEffect(() => {
    let current = true;
    setText(null);
    setError(null);
    void readPairingRecoveryText(credential, item.key, part).then(
      value => { if (current) setText(value); },
      () => { if (current) setError("Couldn't read saved text. Your copy is still retained; try again."); },
    );
    return () => { current = false; };
  }, [credential, item.key, part, attempt]);
  useEffect(() => {
    let current = true;
    setPhoto(null);
    if (imageIndex !== null) void readPairingRecoveryImage(credential, item.key, imageIndex).then(
      image => { if (current) setPhoto(`data:${image.mimeType};base64,${image.data}`); },
      () => { if (current) setError("Couldn't read the saved photo. Your copy is still retained; try again."); },
    );
    return () => { current = false; };
  }, [credential, item.key, imageIndex, attempt]);
  return <div className="flex min-w-0 flex-col gap-3">
    {item.kind === "send" ? <p className="text-meta">Retained send · {item.state}</p> : null}
    {item.missingImages ? <Notice tone="info">Some photos were unavailable before repair. Only the remaining text and photos can be recovered.</Notice> : null}
    {!item.textParts && !item.images.length ? <p className="text-meta text-muted-foreground">This saved draft has no text or photos.</p> : null}
    {saveError ? <ErrorNotice message={saveError.message} action={{ label: "Save attachment again", icon: DownloadIcon, onClick: () => saveAttachment(saveError.index) }} /> : null}
    {error ? <ErrorNotice message={error} onRetry={() => setAttempt(value => value + 1)} /> : null}
    {text !== null && item.textParts ? <>
      {item.textParts > 1 ? <p className="text-meta">Text part {part + 1} of {item.textParts} · copy each part in order.</p> : null}
      <pre className="min-w-0 whitespace-pre-wrap text-body select-text [overflow-wrap:anywhere]">{text}</pre>
      <CopyButton text={text} label={item.textParts > 1 ? "Copy this text part" : "Copy text"} showLabel className="h-auto min-h-12 max-w-full self-start whitespace-normal text-left after:hidden" />
      {part > 0 || part + 1 < item.textParts ? <RowGroup>
        {part > 0 ? <Row leading={<ArrowLeftIcon />} title="Previous text part" onClick={() => setPart(value => value - 1)} /> : null}
        {part + 1 < item.textParts ? <Row leading={<ArrowRightIcon />} title="Next text part" onClick={() => setPart(value => value + 1)} /> : null}
      </RowGroup> : null}
    </> : null}
    {item.images.length ? <RowGroup>
      {item.images.map((_, index) => <div key={index}>
        <Row leading={<ImageIcon />} title={`View attachment ${index + 1}`} chevron onClick={() => setImageIndex(index)} />
        <Row leading={<DownloadIcon />} title={`Save attachment ${index + 1}`} onClick={() => saveAttachment(index)} />
      </div>)}
    </RowGroup> : null}
    {photo ? <img className="max-h-72 max-w-full rounded-md object-contain" src={photo} alt={`Saved attachment ${(imageIndex ?? 0) + 1}`} /> : null}
  </div>;
}

export default SettingsScreen;

function RootPage({
  controller,
  push,
  notifications,
  local,
  computerName,
  connection,
  unpaired,
  savedWorkKept,
  isStale,
  versionKnown,
  onForget,
}: {
  controller: OmpSessionController;
  push: (page: Page) => void;
  /** The Notifications row's value ("On", "Off", "Blocked", …). */
  notifications: string;
  local: LocalRuntime | null;
  computerName: string;
  connection: Connection;
  /** The computer refused this phone's credential: the only time repair is offered. */
  unpaired: boolean;
  savedWorkKept: boolean;
  isStale: boolean;
  versionKnown: boolean;
  onForget: () => Promise<void>;
}): JSX.Element {
  const [confirm, setConfirm] = useState<"history" | "pairing" | "stop-phone" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Where omp runs decides which endpoint-specific controls exist: a phone
  // has no computer to pair with, a computer has no phone to stop.
  const onPhone = local?.onPhone === true;

  async function confirmDanger() {
    setBusy(true);
    setError(null);
    try {
      if (confirm === "pairing") {
        await onForget();
      } else if (confirm === "stop-phone") {
        // The one existing path to the first-run chooser: it persists phone
        // mode as off and restarts the app. Nothing is deleted.
        local?.bridge.setMode("unset");
      } else {
        await controller.clearCachedHistory();
        showToast("Cleared cached conversations", "success");
      }
      setConfirm(null);
    } catch (cause) {
      setError(humanizeDaemonError(cause));
    } finally {
      setBusy(false);
    }
  }

  const confirmCopy = {
    pairing: {
      title: "Unpair this phone?",
      description: "Your computer stops accepting this phone, notifications stop, and this phone clears its saved conversations, drafts and unsent messages. Your computer keeps every conversation. Pair again any time with a new code.",
      label: "Unpair",
      busyLabel: "Unpairing\u2026",
    },
    "stop-phone": {
      title: "Stop phone mode?",
      description: "Anything running on this phone ends now. Your files, conversations and sign-ins stay. Choose Run on this phone whenever you want to start again.",
      label: "Stop",
      busyLabel: "Stopping\u2026",
    },
    history: {
      title: "Clear cached conversations?",
      description: onPhone
        ? "Offline copies leave this app; unsent messages, drafts and the conversations kept on this phone stay."
        : "Offline copies leave this phone; unsent messages, drafts and your computer\u2019s conversations stay.",
      label: "Clear",
      busyLabel: "Clearing\u2026",
    },
  }[confirm ?? "history"];

  const providersRow = (
    <Row
      leading={<KeyRoundIcon />}
      title="Model providers"
      chevron
      onClick={() => push("providers")}
      testId="settings-providers"
    />
  );
  const runOnRow = local ? (
    <Row
      leading={<CpuIcon />}
      title="Run on"
      trailing={local.summary}
      chevron
      onClick={() => push("run-on")}
      testId="settings-run-on"
    />
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      {onPhone && local ? (
        <RowGroup title="Run on this phone" inset testId="settings-phone-group">
          <Row
            leading={<SmartphoneIcon />}
            title="Device access"
            subtitle="Devices that can use this phone"
            chevron
            onClick={() => push("computer")}
            testId="settings-device-access"
          />
          {runOnRow}
          <Row
            leading={<ShieldCheckIcon />}
            title="Phone access"
            chevron
            onClick={() => push("phone-access")}
            testId="settings-phone-access"
          />
          {providersRow}
          {local.switching ? null : (
            <Row
              leading={<PowerIcon />}
              title="Stop phone mode"
              subtitle="Ends running work and frees this phone"
              destructive
              testId="settings-stop-phone"
              onClick={() => {
                setError(null);
                setConfirm("stop-phone");
              }}
            />
          )}
        </RowGroup>
      ) : (
        <RowGroup title="Run on PC" inset testId="settings-pc-group">
          <Row
            leading={<MonitorIcon />}
            title={computerName}
            subtitle={
              <span className="flex items-center gap-1.5">
                {connection === "checking" ? null : (
                  <StatusDot tone={connection === "connected" ? "success" : "danger"} />
                )}
                {unpaired ? "Pairing needed" : CONNECTION_LABEL[connection]}
              </span>
            }
            chevron
            onClick={() => push("computer")}
            testId="settings-computer"
          />
          {/* Only a refused credential needs repair; while pairing works the row
              would offer a fix for nothing. */}
          {unpaired ? (
            <Row
              leading={<KeyRoundIcon />}
              title="Repair pairing"
              subtitle="Your computer no longer accepts this phone"
              chevron
              onClick={() => push("repair-pairing")}
              testId="settings-repair-pairing"
            />
          ) : null}
          {savedWorkKept && !unpaired ? (
            <Row
              leading={<ArchiveIcon />}
              title="Saved work"
              subtitle="Kept from before pairing was repaired"
              chevron
              onClick={() => push("saved-work")}
              testId="settings-saved-work"
            />
          ) : null}
          {runOnRow}
          {providersRow}
          <Row
            leading={<LogOutIcon />}
            title="Unpair this phone"
            destructive
            testId="settings-unpair"
            onClick={() => {
              setError(null);
              setConfirm("pairing");
            }}
          />
        </RowGroup>
      )}

      <RowGroup title="Preferences" inset>
        <Row
          leading={<BellIcon />}
          title="Notifications"
          trailing={notifications}
          chevron
          onClick={() => push("notifications")}
          testId="settings-notifications"
        />
        <Row
          leading={<PaletteIcon />}
          title="Appearance"
          chevron
          onClick={() => push("appearance")}
          testId="settings-appearance"
        />
        <Row
          leading={<PuzzleIcon />}
          title="Plugins"
          chevron
          onClick={() => push("plugins")}
          testId="settings-plugins"
        />
      </RowGroup>

      <RowGroup title="About" inset>
        <Row
          leading={<InfoIcon />}
          title="Version"
          trailing={
            isStale ? (
              <span className="text-primary-text">Update available</span>
            ) : versionKnown ? (
              "Up to date"
            ) : connection === "unreachable" ? (
              "Can\u2019t check"
            ) : (
              "Checking\u2026"
            )
          }
          chevron
          onClick={() => push("about")}
          testId="settings-about"
        />
        <Row
          leading={<StethoscopeIcon />}
          title="Diagnostics"
          chevron
          onClick={() => push("diagnostics")}
          testId="settings-diagnostics"
        />
      </RowGroup>

      <RowGroup inset>
        <Row
          leading={<Trash2Icon />}
          title="Clear cached conversations"
          destructive
          testId="settings-clear-cache"
          onClick={() => {
            setError(null);
            setConfirm("history");
          }}
        />
      </RowGroup>

      <ConfirmSheet
        open={confirm !== null}
        onOpenChange={(value) => {
          if (!value && !busy) setConfirm(null);
        }}
        title={confirmCopy.title}
        description={confirmCopy.description}
        confirmLabel={confirmCopy.label}
        onConfirm={() => void confirmDanger()}
        busy={busy}
        busyLabel={confirmCopy.busyLabel}
      >
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </ConfirmSheet>
    </div>
  );
}

/**
 * A build id as one short token with a copy affordance. Release ids are long
 * hashes; wrapped in full they dominated the page, while the ends are what a
 * human compares. The full id is one tap away on the clipboard.
 */
function VersionValue({ value }: { value: string }): JSX.Element {
  // One copy at a time, and none reported after the page has gone.
  const [attempt] = useState(() => new ClipboardAttempt());
  useEffect(() => () => attempt.cancel(), [attempt]);
  const short = value.length > 18 ? `${value.slice(0, 8)}\u2026${value.slice(-6)}` : value;
  return (
    <span className="flex min-w-0 items-center justify-end gap-1">
      <span className="truncate tabular-nums" title={value}>
        {short}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="-mr-2 size-12 text-muted-foreground after:hidden"
        aria-label="Copy version"
        onClick={() => {
          void attempt.run(value).then((ok) => {
            if (ok === null) return;
            if (ok) showToast("Copied version", "success");
            else showToast("Couldn\u2019t copy the version.", "error");
          });
        }}
      >
        <CopyIcon />
      </Button>
    </span>
  );
}

function AboutPage({
  controller,
  buildId,
  daemonVersion,
  connection,
  isStale,
  onViewPending,
}: {
  controller: OmpSessionController;
  buildId: string;
  daemonVersion: string | null;
  connection: Connection;
  isStale: boolean;
  onViewPending: () => void;
}): JSX.Element {
  const [updating, setUpdating] = useState(false);

  async function update() {
    setUpdating(true);
    await updateClientNow(controller, { onViewPending });
    setUpdating(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <RowGroup inset>
        <Row
          title="Status"
          trailing={
            isStale ? (
              <span className="text-primary-text">Update available</span>
            ) : daemonVersion !== null ? (
              "Up to date"
            ) : connection === "unreachable" ? (
              "Can\u2019t check"
            ) : (
              "Checking\u2026"
            )
          }
        />
        <Row title="App build" trailing={<VersionValue value={buildId} />} />
        <Row
          title="Computer build"
          trailing={
            daemonVersion !== null ? (
              <VersionValue value={daemonVersion} />
            ) : connection === "unreachable" ? (
              "Unavailable"
            ) : (
              "Checking\u2026"
            )
          }
        />
      </RowGroup>
      {isStale ? (
        <div className="flex flex-col gap-2">
          <Button variant="primary" className="h-auto min-h-12 w-full whitespace-normal" disabled={updating} onClick={() => void update()}>
            <ArrowDownIcon aria-hidden />
            {updating ? "Updating\u2026" : "Update"}
          </Button>
          <p className="text-meta text-muted-foreground">
            Reloads the app with the version your computer is running.
          </p>
        </div>
      ) : null}
    </div>
  );
}
