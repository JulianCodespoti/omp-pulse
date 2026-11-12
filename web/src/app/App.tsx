import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeftIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { NativeHandoff, PairSplash } from "./PairSplash";

import {
  clearPairingCode,
  clearPairingToken,
  readPairingAutoConnect,
  readPairingCode,
  readPairingToken,
} from "../platform/browser-storage";
import {
  onOpenMessage,
  registerServiceWorker,
} from "../platform/service-worker";
import {
  clearNativeNotificationToken,
  clearNativeNotifications,
  requiresNativeNotificationSync,
  setForegroundConversation,
  syncNativeNotificationToken,
} from "../platform/native-notifications";
import { onSpeechFailure, stopSpeaking } from "../platform/speech";
import { OmpSessionController } from "../runtime/omp-session-controller";
import { createOmpStore, selectSessionTurn } from "../runtime/omp-store";
import { DaemonApi, sendPromptDurably } from "../runtime/rpc-client";
import { launchTarget } from "../domain/launch-target";
import { pluginPromptRefusal } from "../domain/composer-route";
import { getNewSessionDraft } from "../runtime/new-session-draft";
import { consumeNewChatLink, readDeepLink, readNewChatLink } from "./deep-link";
import { Notices, showToast } from "./Notices";
import { updateClientNow } from "./update-client";
import { importChatScreen, preloadChat } from "./chat-chunk";
import { useStoreValue } from "./store-hooks";
import { useOpenChatReadState } from "./read-state";
import { NativeUpgradeBoundary } from "./NativeUpgradeBoundary";
import { useBackLayer } from "./back-layer";
import { activeTime, sessionTitle } from "./session-format";
import { detectReplyReady, replyPreview, replyRow } from "./reply-ready";
import type { ReplyWatch } from "./reply-ready";
import { sessionStatus } from "./session-status";
import { closePalette, usePaletteOpen } from "./commands/palette";
import { navigate } from "./nav/navigate";
import { setOpenConversation } from "./nav/open-conversation";
import {
  closePanels,
  closePluginPage,
  closeProjects,
  closeSettings,
  openPluginPage,
  openSettingsPage,
  openSwitcher,
  openSwitcherProject,
  resetPanels,
  setNewChatHandler,
  setPanelsSession,
  usePanels,
} from "./nav/panels";
import { PushedScreen, previewBack, resetBackPreview } from "./nav/PushedScreen";
import { ProjectsScreen } from "./nav/ProjectsScreen";
import { pluginHost } from "../runtime/plugin-host";
import { openChatSender } from "./plugins/open-chat";
import { ScreenActivityContext } from "./nav/screen-activity";
import { SessionSwitcher } from "./nav/SessionSwitcher";
import { SidePanel } from "./nav/SidePanel";
import { LazyMount } from "./ui/LazyMount";
import { retryableLazy as lazy } from "./ui/retryable-lazy";
import { ScreenBoundary } from "./ui/RecoveryBoundary";

const ChatScreen = lazy(() =>
  importChatScreen().then((module) => ({ default: module.ChatScreen })),
);

const PairScreen = lazy(() =>
  import("./PairScreen").then((module) => ({ default: module.PairScreen })),
);
const importSettingsScreen = () => import("./SettingsScreen");
const importNewSessionScreen = () => import("./sessions/NewSessionScreen");
const SettingsScreen = lazy(importSettingsScreen);
const PluginPage = lazy(() => import("./plugins/PluginPage").then((module) => ({ default: module.PluginPage })));
const NewSessionScreen = lazy(importNewSessionScreen);
// The chat's workspace pages (SessionPager) are their own chunk.
const importWorkspacePages = () => import("./tools");
const GlobalPalette = lazy(() =>
  import("./commands/GlobalPalette").then((module) => ({ default: module.GlobalPalette })),
);

// Opacity only: a transform here would become the containing block for the
// screens' `fixed` headers and composer. Used only where a view transition
// cannot run (reduced motion, no API): the push/pop in nav/navigate.ts is the
// real motion.
const SCREEN_FADE = "animate-[fade-in_var(--dur-base)_var(--ease-smooth)_both]";

// The switcher's close starts before the chat remounts on the new session,
// so the exit reads as motion rather than an 811 ms dead gap.
const SWITCH_DELAY_MS = 80;

// A cold start with no cached listing holds a quiet frame until the first
// listing says whether to reopen the last chat. A daemon slower than this
// lands on home instead; the listing arriving later never moves the user off
// the screen they are on.
const LAUNCH_WAIT_MS = 2500;

// The outlines of the new-chat screen's header control and composer, so the
// wait reads as the app arriving rather than a black page (it used to be an
// empty <main>). It fades in after 150 ms, so a fast start shows nothing, and
// has no shimmer: a loading animation would promise content that may never come.
function LaunchFrame() {
  return (
    <main
      aria-busy="true"
      aria-label="Opening omp"
      className="flex h-dvh flex-col bg-background animate-[fade-in_var(--dur-base)_var(--ease-smooth)_150ms_both]"
    >
      <div aria-hidden className="box-content flex h-14 shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top)]">
        <div className="size-11 rounded-full bg-surface-1" />
        <div className="flex-1" />
        <div className="size-11 rounded-full bg-surface-1" />
      </div>
      <div className="flex-1" />
      <div aria-hidden className="mx-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] h-14 shrink-0 rounded-xl bg-surface-1" />
    </main>
  );
}

/** Keep history in step with a chat that closed: pop its entry, or clear the state. */
function dropChatEntry(): void {
  try {
    const st = window.history.state as Record<string, unknown> | null;
    if (st && st.ompChat) window.history.back();
    else window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch {
    // history unavailable in some embedded contexts — ignore
  }
}

export function App() {
  // Capture notification targets before removing a single-use enrollment code.
  const [initialDeepLink] = useState(() => readDeepLink());
  const [pairCode, setPairCode] = useState(readPairingCode);
  const [pairAutoConnect, setPairAutoConnect] = useState(readPairingAutoConnect);
  const [token, setToken] = useState(() => readPairingToken());
  // A captured boot destination never owns a temporary sessions subscription.
  // Readiness and the cancellable effect below still own opening its transport.
  const [screen, setScreen] = useState<"home" | "chat">(initialDeepLink ? "chat" : "home");
  // Home is the new-chat screen, never a list. Without a notification target
  // the first listing decides between it and the most recent chat.
  const [launching, setLaunching] = useState(!initialDeepLink);
  const store = useMemo(() => createOmpStore(), []);
  const [pairingGeneration, setPairingGeneration] = useState(0);
  const controller = useMemo(
    () => new OmpSessionController(store, token),
    [store, token],
  );
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const pendingSwitch = useRef<{ controller: OmpSessionController; path: string } | null>(null);
  const authRejected = useStoreValue(store, (state) => state.authRejected);
  const agentWorking = useStoreValue(store, (state) => state.sessionPath !== null && selectSessionTurn(state, state.sessionPath) !== "idle");
  const isStreaming = useStoreValue(
    store,
    (state) => state.streamingMessage !== null,
  );
  const queuedCount = useStoreValue(store, (state) => state.queuedCount);
  const panels = usePanels();
  // Back in a chat opens the drawer once; the Back after it leaves the app.
  const [leftChatByBack, setLeftChatByBack] = useState(false);
  const backOpening = useRef(false);
  const paletteOpen = usePaletteOpen();

  // The native shell keeps its own durable credential for background delivery,
  // so a paired UI is not usable until that hand-off is acknowledged. A browser
  // build has no native side to wait for and is ready as soon as it is paired.
  const nativeRequired = requiresNativeNotificationSync();
  const [acknowledged, setAcknowledged] = useState("");
  const [nativeSyncFailed, setNativeSyncFailed] = useState(false);
  const [nativeSyncing, setNativeSyncing] = useState(false);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const nativeReady = Boolean(token) && (!nativeRequired || acknowledged === token);
  const repairOrigin = useRef<{ path: string | null; url: string } | null>(null);
  const repairRestore = useRef<{ credential: string; path: string; url: string } | null>(null);
  const beginRepair = useCallback(() => {
    const origin = {
      path: screenRef.current === "chat" ? store.getState().sessionPath : null,
      url: window.location.href,
    };
    repairOrigin.current = origin;
    return () => {
      if (repairOrigin.current !== origin) return;
      repairOrigin.current = null;
      // Cancelling the UI cannot discard a credential whose one-use code was
      // already spent. The app takes over acknowledgement without navigation.
      window.dispatchEvent(new Event("app:pairing-stored"));
    };
  }, [store]);

  useEffect(() => {
    clearPairingCode();
    const receivePairingCode = () => {
      const code = readPairingCode();
      if (!code) return;
      setPairCode(code);
      setPairAutoConnect(readPairingAutoConnect());
      clearPairingCode();
    };
    // Android can deliver the intent after React has already mounted.
    window.addEventListener("hashchange", receivePairingCode);
    return () => window.removeEventListener("hashchange", receivePairingCode);
  }, []);

  useEffect(() => {
    const updateNow = () => { void updateClientNow(controller); };
    window.addEventListener("app:update-now", updateNow);
    return () => window.removeEventListener("app:update-now", updateNow);
  }, [controller]);

  useEffect(() => {
    const openNativeRecovery = (event: Event) => {
      const page = (event as CustomEvent<{ page?: string }>).detail?.page;
      if (page !== "computer" && page !== "diagnostics" && page !== "repair-pairing") return;
      if (!token) {
        if (page !== "repair-pairing") return;
        const pairing = document.querySelector<HTMLElement>('[data-testid="pair-screen"]');
        if (!pairing) return;
        pairing.querySelector<HTMLElement>("input,button")?.focus();
        event.preventDefault();
        return;
      }
      if (!nativeReady || store.getState().authRejected || readPairingToken() !== token) return;
      openSettingsPage(page);
      event.preventDefault();
    };
    window.addEventListener("app:open-settings", openNativeRecovery);
    return () => {
      window.removeEventListener("app:open-settings", openNativeRecovery);
    };
  }, [nativeReady, store, token]);

  // The pushed screens are their own chunks. Fetch them while the phone is
  // idle so the push slides in a rendered screen, not a blank page that
  // fills in a frame later.
  useEffect(() => {
    if (!nativeReady) return;
    const preload = () => {
      void SettingsScreen.preload().catch(() => undefined);
      void NewSessionScreen.preload().catch(() => undefined);
      void importWorkspacePages().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preload, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preload, 1500);
    return () => window.clearTimeout(id);
  }, [nativeReady]);

  // Plugins: wire the host's callbacks once, then keep its catalog current
  // whenever the app is paired and whenever the page comes back into view.
  useEffect(() => {
    pluginHost.configure({
      openPage: openPluginPage,
      toast: (message) => showToast(message),
      compose: async (sessionId, text) => {
        // False when that conversation is not the open one.
        if (!controllerRef.current.prepareEditorDraft(sessionId, text)) {
          throw new Error("Open the conversation to put text in its message box");
        }
      },
      prompt: async (sessionId, text) => {
        // The open conversation: the composer's own Send path, identical to pressing Send.
        const send = openChatSender(sessionId);
        if (send) return send(text);
        // The same rule as the open conversation's path (domain/composer-route.ts).
        const refusal = pluginPromptRefusal(text, { kind: "not-open" });
        if (refusal !== null) throw new Error(refusal);
        await sendPromptDurably(sessionId, text, [], { token: readPairingToken() ?? "" });
      },
    });
  }, []);
  useEffect(() => {
    if (!token) return;
    void pluginHost.refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void pluginHost.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [token]);

  // Unsaved-work guard: warn on reload/navigate while the agent is working,
  // a stream is in flight, or prompts are queued. Active only when needed.
  useEffect(() => {
    const shouldGuard = agentWorking || isStreaming || queuedCount > 0;
    if (!shouldGuard) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [agentWorking, isStreaming, queuedCount]);

  const screenRef = useRef(screen);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  useEffect(() => {
    const adoptStoredPairing = () => {
      const credential = readPairingToken();
      controllerRef.current.fencePairingReplacement(credential);
      if (!tokenRef.current || !credential || credential === tokenRef.current || repairOrigin.current) return;
      const path = pendingSwitch.current?.path ?? store.getState().sessionPath;
      if (screenRef.current === "chat" && path)
        repairRestore.current = { credential, path, url: window.location.href };
      tokenRef.current = credential;
      setAcknowledged("");
      setToken(credential);
      setPairingGeneration(value => value + 1);
    };
    window.addEventListener("app:pairing-stored", adoptStoredPairing);
    adoptStoredPairing();
    return () => window.removeEventListener("app:pairing-stored", adoptStoredPairing);
  }, [panels.settings, store]);
  // Pairing already waited for this hand-off before it reported success, so a
  // credential arriving any other way — the stored one on a cold start, or one
  // migrated from the native app — is what this covers. A failure leaves the
  // credential untouched and holds the paired UI back until it is retried.
  useEffect(() => {
    if (!token || acknowledged === token) return;
    let cancelled = false;
    setNativeSyncing(true);
    setNativeSyncFailed(false);
    void syncNativeNotificationToken(token).then(
      () => {
        if (cancelled) return;
        setAcknowledged(token);
        setNativeSyncing(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.warn("Could not pair the native notification listener", error);
        setAcknowledged("");
        setNativeSyncFailed(true);
        setNativeSyncing(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [acknowledged, syncAttempt, token]);

  const deepLinkHandledRef = useRef(false);
  const pendingDeepLink = useRef(initialDeepLink);

  // Every controller must be disposed, including the tokenless one built for
  // the pair screen: its constructor binds visibility/online listeners, and an
  // undisposed one kept calling refreshSessions() with an empty bearer after
  // pairing. The first app resume drew a 401, set authRejected on the shared
  // store, and wiped the freshly paired credential (phone back on the pair
  // screen after one trip to the home screen).
  // Declared before the listing effect so StrictMode's second setup resumes
  // the instance before loadSessions runs (see controller.resume()).
  useEffect(() => {
    controller.resume();
    return () => controller.dispose();
  }, [controller]);

  // This effect runs only after the retired controller's cleanup has cleared
  // its session. A newer Back/notification/chat destination always wins.
  useEffect(() => {
    const restore = repairRestore.current;
    if (!restore || !nativeReady || restore.credential !== token) return;
    repairRestore.current = null;
    if (screenRef.current !== "chat" || window.location.href !== restore.url) return;
    pendingSwitch.current = null;
    void controller.openSession(restore.path);
  }, [controller, nativeReady, token]);

  // Nothing is listed or opened until the native listener holds the same
  // credential, so nothing can be requested with a hand-off that never landed.
  useEffect(() => {
    // SessionSwitcher owns its scope-aware error and Retry state. This startup
    // observer primes the launch listing and must consume its own rejection.
    if (nativeReady) void controller.loadSessions().catch(() => undefined);
  }, [controller, nativeReady]);

  // A re-paired daemon invalidates the saved token. Drop it and show pairing
  // rather than leaving the phone on a list it can never load.
  useEffect(() => {
    if (!authRejected) return;
    const rejected = token;
    store.getState().setAuthRejected(false);
    const saved = readPairingToken();
    // Explicit Forget pairing has already cleared browser/native storage.
    // Otherwise only this controller's exact rejected credential may revoke it.
    if (saved) {
      if (!controller.rejectedCurrentCredential(rejected) || saved !== rejected) return;
      void clearNativeNotificationToken(rejected).catch((error: unknown) => {
        console.warn("Could not clear native notification pairing", error);
      });
      clearPairingToken();
    }
    resetPanels();
    // Re-pairing must not mount a list before a still-pending boot destination.
    setScreen(pendingDeepLink.current && !deepLinkHandledRef.current ? "chat" : "home");
    setToken("");
  }, [authRejected, controller, store, token]);

  // A notification names the conversation the user wants, so it lands on
  // that chat with nothing left over it: a pushed screen or the palette from
  // before would otherwise sit on top of the chat, and Back would close it
  // before ever reaching the chat (see back-layer.ts).
  const landOnChat = useCallback((sessionPath: string, notificationKind?: string) => {
    screenRef.current = "chat";
    // Arriving here skips the launch decision, so its idle preload never ran.
    repairRestore.current = null;
    pendingSwitch.current = null;
    // Start the chunk before the navigation rather than after, or the user
    // waits out a cold 527 KB parse having already told us exactly where they
    // want to be.
    preloadChat();
    void controller.openSession(sessionPath);
    resetPanels();
    closePalette();
    setLaunching(false);
    setScreen("chat");
    try {
      // Already on a chat entry: replace it. Pushing stacked a second chat
      // entry, so after Back to the list the next Back popped a dead entry
      // and visibly did nothing. A cold boot has no chat entry, so it pushes
      // and Back still has the list entry to return to.
      const onChatEntry = (window.history.state as Record<string, unknown> | null)?.ompChat === true;
      window.history[onChatEntry ? "replaceState" : "pushState"](
        { ompChat: true, path: sessionPath, notificationKind },
        "",
        `${window.location.pathname}${window.location.search}#s=${encodeURIComponent(sessionPath)}`,
      );
    } catch {
      // history unavailable in some embedded contexts — ignore
    }
  }, [controller]);

  const receiveDeepLink = useCallback((link: { sessionPath: string; kind?: string } | null) => {
    if (!link?.sessionPath) return;
    repairRestore.current = null;
    pendingSwitch.current = null;
    // Retain the newest intent even during pairing/native credential hand-off.
    pendingDeepLink.current = link;
    deepLinkHandledRef.current = false;
    setScreen("chat");
    if (!nativeReady) return;
    deepLinkHandledRef.current = true;
    pendingDeepLink.current = null;
    landOnChat(link.sessionPath, link.kind);
  }, [landOnChat, nativeReady]);

  // Service worker: register once (no-ops in dev) and wire notification taps.
  useEffect(() => {
    void registerServiceWorker();
    return onOpenMessage((msg) => {
      if (msg.sessionPath) receiveDeepLink({ sessionPath: msg.sessionPath, kind: msg.kind });
    });
  }, [receiveDeepLink]);

  // Deep-link boot: `#s=<path>` means a notification tap, so jump straight into
  // that conversation instead of home.
  //
  // It is read TWICE, and both reads are load-bearing. `initialDeepLink` is
  // captured in a state initialiser because the pairing-token parser wipes the
  // hash, so a link present at first paint would otherwise be destroyed before
  // this effect ran. On a cold start the Android shell injects its pending
  // link after the document finishes loading, possibly after App mounts.
  // Listening for
  // `hashchange` catches that later arrival and subsequent notification taps.
  // Only the captured boot link is one-shot; warm intents must keep working.
  useEffect(() => {
    // Listen while readiness is pending too; a newer notification replaces the
    // captured boot destination instead of disappearing before this effect runs.
    const onHashChange = () => receiveDeepLink(readDeepLink());
    window.addEventListener("hashchange", onHashChange);
    let cancelled = false;
    if (nativeReady) queueMicrotask(() => {
      // StrictMode disposes the controller between setups; only the surviving
      // setup may consume a destination. Warm events and Back supersede it.
      if (cancelled || deepLinkHandledRef.current) return;
      const link = pendingDeepLink.current;
      deepLinkHandledRef.current = true;
      pendingDeepLink.current = null;
      if (link) landOnChat(link.sessionPath, link.kind);
    });
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [landOnChat, nativeReady, receiveDeepLink]);

  // Cold start without a notification target: the most recent chat if the user
  // is plausibly still in it (domain/launch-target.ts), else the new-chat home.
  // The cached listing decides first: loadSessions hydrates it into the store
  // before the network answers, and waiting out the network held a blank page
  // for up to LAUNCH_WAIT_MS on every cold start. Only a start with no cached
  // rows waits for the network listing.
  useEffect(() => {
    if (!nativeReady || !launching) return;
    if (pendingDeepLink.current || screenRef.current === "chat") {
      setLaunching(false);
      return;
    }
    let settled = false;
    let listed = false;
    const startedAt = Date.now();
    const finish = (target: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      if (target && screenRef.current === "home") landOnChat(target);
      else setLaunching(false);
    };
    const decide = (awaiting: ReadonlySet<string>) => {
      const chats = store.getState().sessions.map((session) => {
        const state = sessionStatus(session, awaiting);
        return { path: session.path, activeAt: activeTime(session), running: state === "working", needsYou: state === "needs-you" };
      });
      return launchTarget(chats, Date.now());
    };
    const timer = window.setTimeout(() => finish(null), LAUNCH_WAIT_MS);
    // Cached rows carry the savedAt of an earlier run; a network page is stamped
    // now, so a stamp before this start tells the two apart and the network
    // answer keeps its needs-you read below.
    const unsubscribe = store.subscribe((state) => {
      if (listed || state.sessions.length === 0) return;
      if (state.sessionsUpdatedAt === null || state.sessionsUpdatedAt >= startedAt) return;
      finish(decide(new Set()));
    });
    void (async () => {
      try {
        await controller.loadSessions();
      } catch {
        finish(null);
        return;
      }
      listed = true;
      // A missed awaiting read only loses the needs-you signal; the rest still decides.
      const awaiting = await new DaemonApi(token).awaiting().then((paths) => new Set(paths), () => new Set<string>());
      finish(decide(awaiting));
    })();
    return () => {
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [controller, landOnChat, launching, nativeReady, store, token]);

  // Leaving the chat for home. The side panels belong to the chat and unmount
  // with it inside the pop update, and every pushed layer goes with them, so
  // home arrives clean.
  const popToHome = useCallback(() => {
    deepLinkHandledRef.current = true;
    repairRestore.current = null;
    pendingSwitch.current = null;
    pendingDeepLink.current = null;
    // Set now, not in the effect: the transition runs its update a frame
    // later, and a second back (or dropChatEntry's own history.back) in that
    // gap must not pop the stack twice.
    screenRef.current = "home";
    navigate("pop", () => {
      controller.closeSession();
      resetPanels();
      setScreen("home");
    });
  }, [controller]);

  // "New chat" from anywhere: leave the chat for home, or just clear what is
  // over home (the drawer, Chats, Projects, Settings). A chat's own "New
  // chat" names its folder, so home arrives with that project already chosen
  // and still changeable: one tap to a sibling chat, never a silent session
  // in a folder the person did not pick.
  const goHome = useCallback((project?: string) => {
    if (project) getNewSessionDraft().update({ project });
    if (screenRef.current !== "chat") {
      resetPanels();
      return;
    }
    popToHome();
    dropChatEntry();
  }, [popToHome]);
  useEffect(() => {
    setNewChatHandler(goHome);
    return () => setNewChatHandler(null);
  }, [goHome]);

  // The widget's "New chat" (`#new=1`), whether it was the boot URL or arrives
  // as a hashchange. Consumed at once so the next tap changes the hash again,
  // and it ends the launch decision: that would otherwise reopen the last chat.
  useEffect(() => {
    const open = () => {
      if (!consumeNewChatLink()) return;
      setLaunching(false);
      goHome();
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [goHome]);

  // Back from a chat lands on the drawer, the way a chat app's Back lands on
  // its chat list. The chat's back layer then stands down, so the Back after
  // the drawer leaves the app, until the user opens the drawer themselves or
  // switches chat.
  const backFromChat = useCallback(() => {
    // A boot link that Back just cancelled leaves a chat screen with nothing
    // open: there is no chat to keep under a drawer, so go home.
    if (store.getState().sessionPath === null) {
      popToHome();
      dropChatEntry();
      return;
    }
    backOpening.current = true;
    setLeftChatByBack(true);
    resetPanels();
    openSwitcher();
  }, [popToHome, store]);
  useEffect(() => {
    if (!panels.switcher) return;
    if (backOpening.current) backOpening.current = false;
    else setLeftChatByBack(false);
  }, [panels.switcher]);

  // Browser back (and the shell's history pop): the entry the chat pushed is
  // gone, so only the drawer remains to show. The popstate listener is the
  // single source of truth so JS state cannot desync from the history stack.
  useEffect(() => {
    const onPopState = () => {
      // A fragment change fires popstate first. Clearing the hash below would
      // erase `#new=1` before its hashchange, and Back would open the drawer.
      if (readNewChatLink()) return;
      deepLinkHandledRef.current = true;
      repairRestore.current = null;
      pendingSwitch.current = null;
      pendingDeepLink.current = null;
      try {
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );
      } catch {}
      if (!nativeReady) { setScreen("home"); return; }
      if (screenRef.current !== "chat") return;
      backFromChat();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [backFromChat, nativeReady]);

  // Android back from a chat, via the shell's predictive back. A screen-level
  // (base) layer, so any sheet or side panel over the chat closes first.
  // While the swipe is in progress the chat surface shrinks toward the swipe,
  // as a native screen does; the transform lives only for the gesture. On
  // commit the drawer slides over the chat, so the surface returns to rest.
  const chatSurfaceRef = useRef<HTMLDivElement | null>(null);
  // The home screen, which the session switcher pushes aside as it does the chat.
  const homeSurfaceRef = useRef<HTMLDivElement | null>(null);
  useBackLayer(nativeReady && screen === "chat" && !leftChatByBack, {
    base: true,
    onProgress: (progress, edge) => {
      if (chatSurfaceRef.current) previewBack(chatSurfaceRef.current, progress, edge);
    },
    onCancel: () => resetBackPreview(chatSurfaceRef.current, true),
    onBack: () => {
      if (screenRef.current !== "chat") return;
      resetBackPreview(chatSurfaceRef.current, false);
      backFromChat();
    },
  });

  // Open a chat from anywhere: home, the All chats page, the drawer on home,
  // a new session just started. One push removes whatever was on top. From
  // inside a chat it replaces the open conversation (the URL effect below
  // keeps the hash on it); from home it pushes a chat entry.
  const handleOpen = useCallback(
    (path: string, entryId?: string) => {
      repairRestore.current = null;
      pendingSwitch.current = null;
      void controller.openSession(path);
      const fromChat = screenRef.current === "chat";
      screenRef.current = "chat";
      navigate(fromChat ? "pop" : "push", () => {
        resetPanels();
        setScreen("chat");
      });
      try {
        // `jumpToEntry`: ChatScreen scrolls to that message once it loads
        // (a Messages search hit), then drops it from the entry.
        window.history[fromChat ? "replaceState" : "pushState"](
          { ompChat: true, path, ...(entryId ? { jumpToEntry: entryId } : {}) },
          "",
          `${window.location.pathname}${window.location.search}#s=${encodeURIComponent(path)}`,
        );
      } catch {
        // ignore
      }
    },
    [controller],
  );

  // Keep the URL on the conversation actually open. Switches made INSIDE a
  // chat (rewind/branch, fork, the session switcher) call openSession
  // directly, so the hash kept naming the conversation you left, and a reload
  // (or the Android shell restoring the WebView) reopened the original
  // instead of the branch. replaceState, not push: Back still opens the drawer.
  const openPath = useStoreValue(store, (s) => s.sessionPath);
  // Another chat re-arms Back opening the drawer.
  useEffect(() => {
    setLeftChatByBack(false);
  }, [openPath]);
  useOpenChatReadState(store, screen === "chat");
  useEffect(() => {
    setPanelsSession(screen === "chat" ? openPath : null);
  }, [screen, openPath]);
  useEffect(() => {
    if (screen !== "chat" || !openPath) return;
    const clearVisibleConversation = () => {
      if (document.visibilityState === "visible") {
        // Clearing is best-effort housekeeping; a bridge failure must not
        // surface as an unhandled rejection on every focus/visibility change.
        clearNativeNotifications(openPath).catch(() => undefined);
      }
    };
    clearVisibleConversation();
    document.addEventListener("visibilitychange", clearVisibleConversation);
    window.addEventListener("focus", clearVisibleConversation);
    window.addEventListener("pageshow", clearVisibleConversation);
    return () => {
      document.removeEventListener("visibilitychange", clearVisibleConversation);
      window.removeEventListener("focus", clearVisibleConversation);
      window.removeEventListener("pageshow", clearVisibleConversation);
    };
  }, [screen, openPath]);
  // The shade entry for the conversation on screen leaves by itself. The
  // daemon notifies every finished turn even while the app is open (recorded
  // INVARIANT, so the buzz stays reliable), which left that entry sitting in
  // the shade until the next focus event. The shell and the service worker
  // need to know which conversation is actually in view, and that it is gone
  // the moment the app is backgrounded.
  useEffect(() => {
    const report = () => {
      const foreground =
        screen === "chat" && openPath && document.visibilityState === "visible" ? openPath : null;
      void setForegroundConversation(foreground);
    };
    report();
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    window.addEventListener("pageshow", report);
    window.addEventListener("pagehide", report);
    return () => {
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      window.removeEventListener("pageshow", report);
      window.removeEventListener("pagehide", report);
    };
  }, [screen, openPath]);
  useEffect(() => () => void setForegroundConversation(null), []);
  // A reading belongs to the conversation it started in: leaving the chat or
  // switching chats must not keep talking over the next screen.
  useEffect(() => {
    stopSpeaking();
  }, [screen, openPath]);
  useEffect(
    () =>
      onSpeechFailure((reason) => {
        showToast(
          reason === "no-voice"
            ? "Couldn’t read this aloud. No voice is installed on this device."
            : "Couldn’t read this aloud.",
          "warn",
        );
      }),
    [],
  );
  useEffect(() => {
    if (screen !== "chat" || !openPath) return;
    const target = `#s=${encodeURIComponent(openPath)}`;
    if (window.location.hash.startsWith(target)) return;
    try {
      const state = (window.history.state as Record<string, unknown> | null) ?? {};
      window.history.replaceState(
        { ...state, ompChat: true, path: openPath },
        "",
        `${window.location.pathname}${window.location.search}${target}`,
      );
    } catch {
      // history unavailable in some embedded contexts — ignore
    }
  }, [screen, openPath]);

  // Leave a failed or unavailable chat for home.
  const handleBack = useCallback(() => {
    popToHome();
    dropChatEntry();
  }, [popToHome]);

  const handleSwitch = useCallback(
    (path: string, entryId?: string) => {
      // On home or with an entryId jump, open/update the chat with history state.
      if (screenRef.current !== "chat" || entryId) {
        handleOpen(path, entryId);
        return;
      }
      closePanels();
      repairRestore.current = null;
      if (path === controller.getStore().getState().sessionPath) return;
      const intent = { controller, path };
      pendingSwitch.current = intent;
      window.setTimeout(() => {
        if (pendingSwitch.current !== intent || controllerRef.current !== controller) return;
        pendingSwitch.current = null;
        void controller.openSession(path);
      }, SWITCH_DELAY_MS);
    },
    [controller, handleOpen],
  );

  // The delete flow leaves the open conversation before deleting it and calls
  // reopen on Undo (nav/open-conversation.ts), so it needs no props from here.
  useEffect(() => {
    if (screen !== "chat" || !openPath) {
      setOpenConversation(null);
      return;
    }
    setOpenConversation({ path: openPath, leave: handleBack, reopen: handleSwitch });
    return () => setOpenConversation(null);
  }, [screen, openPath, handleBack, handleSwitch]);

  // The palette's session rows: inside a chat a jump switches the open
  // conversation in place; from home it opens one.
  const handlePaletteSession = useCallback(
    (path: string) => {
      repairRestore.current = null;
      pendingSwitch.current = null;
      if (screenRef.current === "chat") {
        if (path !== controller.getStore().getState().sessionPath) void controller.openSession(path);
        return;
      }
      handleOpen(path);
    },
    [controller, handleOpen],
  );

  // "Reply ready": the listing is the only place the store learns that ANOTHER
  // session's turn ended (OS push covers a hidden app), so each listing update
  // is diffed for a running -> idle edge. The open chat's own transcript shows
  // its reply; a stopped or failed turn is not one.
  const switchRef = useRef(handleSwitch);
  switchRef.current = handleSwitch;
  useEffect(() => {
    let watch: ReplyWatch = new Map();
    const check = () => {
      const state = store.getState();
      const current = screenRef.current === "chat" ? state.sessionPath : null;
      const result = detectReplyReady(watch, state.sessions.map((row) => replyRow(row, selectSessionTurn(state, row.path))), current);
      watch = result.watch;
      // A batch is one toast: a reply per toast let the stack's second slot
      // drop the rest of two replies finishing together. The group lets the
      // next batch update it in place.
      const finished = result.ready.flatMap((done) => {
        const row = state.sessions.find((session) => session.path === done.path);
        return row ? [{ done, row }] : [];
      });
      if (finished.length === 0 || document.visibilityState === "hidden") return;
      const options = { group: "reply-ready", durationMs: 10_000 };
      if (finished.length === 1) {
        const { done, row } = finished[0]!;
        showToast(
          replyPreview(done.text) || "Reply ready",
          "success",
          { label: "Open", onClick: () => switchRef.current(done.path) },
          { ...options, title: sessionTitle(row) },
        );
        return;
      }
      const newest = finished.reduce((latest, next) => (activeTime(next.row) > activeTime(latest.row) ? next : latest));
      showToast(
        `${finished.length} replies ready`,
        "success",
        { label: "Open", onClick: () => switchRef.current(newest.done.path) },
        options,
      );
    };
    check();
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.sessions !== previous.sessions || state.sessionPath !== previous.sessionPath) check();
    });
    // An open chat does not poll the listing, so while another session is
    // known to be running, look for its end every 10 s (a 304 when nothing moved).
    const timer = window.setInterval(() => {
      if (watch.size > 0 && screenRef.current === "chat" && document.visibilityState === "visible") {
        void controllerRef.current.loadSessions().catch(() => undefined);
      }
    }, 10_000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, [store]);

  if (!token) {
    return (
      <>
        <Notices />
        <ScreenBoundary title="Pair device" loading={<PairSplash />}>
          <PairScreen
            key={pairCode}
            initialCode={pairCode}
            autoConnect={pairAutoConnect}
            onConnected={(credential) => {
              const replacing = tokenRef.current !== credential;
              tokenRef.current = credential;
              setPairCode("");
              // PairScreen only reports success once the native side has the
              // credential, so the paired UI opens without a second hand-off.
              setAcknowledged(credential);
              setToken(credential);
              if (replacing) setPairingGeneration(value => value + 1);
            }}
          />
        </ScreenBoundary>
      </>
    );
  }

  // Paired, but the phone has not taken the credential that delivers its
  // notifications. Nothing below this point may run: the credential is kept,
  // and the same pairing screen retried until the hand-off lands.
  if (!nativeReady) {
    return (
      <>
        <Notices />
        <NativeHandoff
          failed={nativeSyncFailed}
          retrying={nativeSyncing}
          onRetry={() => setSyncAttempt((attempt) => attempt + 1)}
        />
      </>
    );
  }

  // Held for one listing: home must not flash before the last chat replaces it.
  if (launching) {
    return (
      <>
        <Notices />
        <LaunchFrame />
      </>
    );
  }

  // The fade fallback, unless a push/pop transition is already animating.
  const entrance = document.documentElement.dataset.nav ? undefined : SCREEN_FADE;
  const inChat = screen === "chat";
  // A pushed screen covers everything beneath it; the screen under it keeps
  // its state (scroll, draft) but must not take focus or announce itself.
  const covered = panels.settings || panels.projects || panels.pluginPage !== null;
  const swipeOpen = !covered && !paletteOpen;

  // Every layer above the current screen, in back order (back-layer.ts):
  // sheets (the palette) over side panels over pushed screens.
  const layers = (
    <>
      <PushedScreen
        open={panels.projects}
        covered={panels.settings || panels.pluginPage !== null}
        onClose={closeProjects}
        title="Projects"
        testId="projects-layer"
      >
        <ProjectsScreen controller={controller} onOpen={openSwitcherProject} onClose={closeProjects} />
      </PushedScreen>
      <PushedScreen open={panels.settings} covered={panels.pluginPage !== null} onClose={closeSettings} title="Settings" testId="settings-layer">
        <SettingsScreen
          onClose={closeSettings}
          controller={controller}
          request={panels.settingsRequest}
          onRepairStart={beginRepair}
          onConnected={(credential, activeRepair = true) => {
            if (readPairingToken() !== credential) return;
            if (controllerRef.current !== controller) {
              // A cancelled screen may finish the current credential's ack,
              // but no retired callback may navigate or replace a controller.
              if (tokenRef.current === credential) setAcknowledged(credential);
              return;
            }
            const replacing = tokenRef.current !== credential;
            tokenRef.current = credential;
            const origin = repairOrigin.current;
            const path = pendingSwitch.current?.path ?? store.getState().sessionPath;
            // Preserve the current intent as well if the user deliberately
            // switched chats while the hand-off was pending.
            if (screenRef.current === "chat" && path) {
              repairRestore.current = {
                credential,
                path: origin?.url === window.location.href && origin.path === path ? origin.path : path,
                url: window.location.href,
              };
            }
            repairOrigin.current = null;
            if (activeRepair) closeSettings();
            setPairCode("");
            setAcknowledged(credential);
            setToken(credential);
            if (replacing) setPairingGeneration(value => value + 1);
          }}
          onOpenSession={(path) => {
            resetPanels();
            handlePaletteSession(path);
          }}
        />
      </PushedScreen>
      <PushedScreen open={panels.pluginPage !== null} onClose={closePluginPage} title="Plugin" testId="plugin-layer">
        {panels.pluginPage !== null ? <PluginPage pluginId={panels.pluginPage} onClose={closePluginPage} /> : null}
      </PushedScreen>
      <LazyMount open={paletteOpen} onClose={closePalette}>
        <GlobalPalette store={store} inChat={inChat} onOpenSession={handlePaletteSession} />
      </LazyMount>
    </>
  );

  // The way to every chat, over home as well as over a chat.
  const switcher = (
    <SidePanel
      label="Sessions"
      testId="session-switcher"
      // Mounted while closed (hidden), so a swipe never builds the list mid-gesture;
      // SessionSwitcher fetches only while `active`, so this adds no requests.
      keepMounted
      open={panels.switcher}
      onOpenChange={(open) => (open ? openSwitcher() : closePanels())}
      swipeOpen={swipeOpen && panels.workspace === null}
      push={inChat ? chatSurfaceRef : homeSurfaceRef}
    >
      <SessionSwitcher
        controller={controller}
        active={panels.switcher && !covered && !paletteOpen}
        currentPath={inChat ? openPath : null}
        onSwitch={handleSwitch}
      />
    </SidePanel>
  );

  if (inChat) {
    return (
      <>
        <Notices />
        <ScreenBoundary title="Conversation" onBack={backFromChat}
          loading={
            // The chat's frame without its content: header and composer
            // outline hold their places, so the chunk landing fills the
            // middle instead of the whole screen popping in from black. No
            // mock transcript: a skeleton that flashes away reads as flicker.
            <main
              aria-busy="true"
              aria-label="Loading conversation"
              className="flex h-dvh flex-col bg-background"
            >
              <div className="flex h-14 shrink-0 items-center border-b border-hairline px-1 pt-[env(safe-area-inset-top)] box-content">
                <Button aria-label="Back" size="icon" variant="ghost" onClick={handleBack}>
                  <ChevronLeftIcon className="size-6" />
                </Button>
              </div>
              <div className="flex-1" />
              <div aria-hidden className="mx-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] h-12 shrink-0 rounded-xl border border-hairline bg-surface-1" />
            </main>
          }
        >
          {/* Keyed so the fade replays on every home <-> chat switch. A
              running push/pop already moves the whole screen; fading it too
              would dissolve the page as it slides. */}
          <ScreenActivityContext.Provider value={!covered}>
          <div key="chat" ref={chatSurfaceRef} data-screen="chat" className={entrance} inert={covered}>
            <NativeUpgradeBoundary key={`${pairingGeneration}:${openPath}`} token={token} sessionPath={openPath} onBack={handleBack}>
              <ChatScreen controller={controller} onBack={handleBack} />
            </NativeUpgradeBoundary>
          </div>
          </ScreenActivityContext.Provider>
        </ScreenBoundary>
        {switcher}
        {layers}
      </>
    );
  }

  return (
    <>
      <Notices />
      <ScreenActivityContext.Provider value={!covered}>
      <div key="home" ref={homeSurfaceRef} data-screen="home" className={cn("h-dvh", entrance)} inert={covered}>
        <ScreenBoundary title="New chat">
          <NewSessionScreen key={pairingGeneration} controller={controller} onStarted={handleOpen} onOpenSession={handleOpen} />
        </ScreenBoundary>
      </div>
      </ScreenActivityContext.Provider>
      {switcher}
      {layers}
    </>
  );
}
