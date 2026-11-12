import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MoreHorizontalIcon, XIcon } from "lucide-react";
import { Notice } from "./ui/Notice";
import {
  flashTarget,
  readTargets,
  scrollToTarget,
} from "./chat/message-navigation";

import { useTranscriptViewport, type TranscriptViewport } from "@/components/ai-elements/transcript-viewport";
import { useAppearance } from "@/platform/appearance";
import { AGENT_THREAD } from "./parts/prose";
import {
  Conversation,
  ConversationContent,
  type ConversationContentProps,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { UiMessage } from "../domain/messages";
import { provisionalTextFromPartial } from "../domain/messages";
import { visibleStreamingMessage } from "../domain/stream-visibility";
import { compactFocus, pluginPromptRefusal, routeComposerText } from "../domain/composer-route";
import { deliveryForSend, sendBlockedReason, type PromptDelivery } from "../domain/send-mode";
import type { OmpSessionSummary } from "../domain/protocol";
import { pluginHost } from "../runtime/plugin-host";
import { setOpenChatSender } from "./plugins/open-chat";
import { toPluginSession } from "./plugins/session-info";
import { recordPromptHistory } from "./composer/prompt-history-store";
import { PartialLine } from "./chat/PartialLine";
import { ConnectionPill } from "./chat/ConnectionPill";
import { HiddenUnderPanels } from "./chat/HiddenUnderPanels";
import { useLinkIndicator } from "./link-hooks";
import { OmpSessionController } from "../runtime/omp-session-controller";
import { SessionHeader } from "./chat/SessionHeader";
import { CloseOnLaptopDialog } from "./CloseOnLaptopDialog";
import { CollabDialog } from "./chat/CollabDialog";
import { ExtensionDialogSheet } from "./chat/ExtensionDialogSheet";
import { ExtensionFeedback } from "./chat/ExtensionFeedback";
import { OpenReveal } from "./chat/OpenReveal";
import { ThumbNav } from "./chat/ThumbNav";
import { ChatMessageRow, foldTurnWork, longTurnRuns, SenderLine, summarizeTurns, TIMELINE_NAMES, turnHeads, useLiveWhileSheetOpen, type TurnSummary, type WorkItem } from "./chat/TranscriptRows";
import { EmptyChatHero } from "./chat/EmptyChatHero";
import { TurnWorkChip } from "./chat/TurnWorkChip";
import { TrackStrip } from "./chat/TrackStrip";
import { CompactPill, useCompactOffer, useCompaction } from "./chat/CompactPill";
import { useLiveTurn } from "./chat/TurnStatus";
import { Composer, type ComposerDraftActions } from "./composer/Composer";
import { useBlurComposerOnScroll } from "./composer/blur-on-scroll";
import { getServerSnapshot as getEmptyOutboxSnapshot, subscribe as subscribeOutbox } from "../runtime/offline-queue";
import { usesNativeOutbox } from "../runtime/native-outbox";
import { projectPendingIntents } from "../runtime/browser-pending-presentation";
import { hideHeldEchoes } from "../runtime/held-echo-presentation";
import { bindUserRowStatus } from "../runtime/user-row-status";
import { deliveryFailed } from "../runtime/receipt-outcome";
import { buildTimeline, isRunMessage, type TimelineItem } from "../domain/timeline";
import { deriveStats, sessionUsageReport } from "../domain/session-stats";
import { formatCost } from "../domain/usage-meter";
import { LoadEarlier } from "./LoadEarlier";
import { LoadLater } from "./LoadLater";
import { LazyMount } from "./ui/LazyMount";
import { retryableLazy as lazy } from "./ui/retryable-lazy";
import { useMessageActions } from "./parts/MessageActions";
import { TranscriptMarkers } from "./parts/TranscriptMarkers";
import { modelFallbackMarker } from "../domain/model-fallback";
import { MessageParts } from "./parts/MessageParts";
import { RefusalNote, RetryNotice, TranscriptActionsContext, type TranscriptActions } from "./parts/TurnNotices";
import { SECTION_CALLS, WorkRun } from "./parts/WorkRail";
import { EditSummary } from "./parts/EditSummary";
import { TurnFooter } from "./parts/TurnFooter";
import { TurnModel } from "./parts/TurnModel";
import { scaledGap, transcriptGap, TURN_FOOTER_GAP } from "./parts/spacing";
import { pendingQuickQuestion, type PendingAsk } from "./parts/run-summary";
import { selectBackgroundWork, selectContextPercent, selectContextTokens, selectSessionAuthority, selectSessionCapability, selectSessionCost, selectSessionTurn } from "../runtime/omp-store";
import type { OmpStore, OmpStoreApi } from "../runtime/omp-store";
import { planToggleTarget, type PlanModeState } from "../runtime/plan-state";
import { ALERT_CANCEL, ALERT_PRIMARY, ConfirmDialog } from "./ui/GroupedList";
import { useStoreValue } from "./store-hooks";
import { InNoticeSlot, showErrorToast, showToast } from "./Notices";
import { UNCERTAIN_SEND_TOAST } from "./send-copy";
import {
  classifyCommand,
  buildComposerCommands,
  requiresArgument,
  resolveDrill,
  PLAN_COMMAND,
  isInternalCommandName,
  type OmpCommand,
  type RpcAvailableSlashCommand,
} from "./commands/command-registry";
import { openPalette, usePaletteOpen, useProvideSlashCommands } from "./commands/palette";
import { projectName } from "../domain/recent-projects";
import type { CommandResult } from "./commands/CommandResultSheet";
import { parseUsageReport } from "./commands/usage-report";
import { closePanels, openNewSession, openSwitcher, openWorkspace } from "./nav/panels";
import { SessionPager } from "./nav/SessionPager";
import { modelChipLabel } from "./sessions/thinking-levels";
import { requestTerminalRun, useProvideWorkspaceHost, type WorkspaceHost } from "./tools/workspace-host";
import {
  getCtxPercent,
  isOnLaptop,
  laptopOpenedText,
  markInterruptionHandled,
  projectLabel,
  sessionInterruption,
  sessionTitle,
  sessionStatus,
  shortModel,
} from "./session-format";
import { rowUsage } from "./sessions/RowUsage";
import { useKeyboardInset } from "./hooks/use-keyboard-inset";
import type { MutableRefObject, ReactNode } from "react";
import { retainMinHeight } from "./chat/retain-min-height";
import { SendAnchor } from "./chat/SendAnchor";
import { NotificationNudge } from "./chat/NotificationNudge";
import { InterruptedBanner } from "./chat/InterruptedBanner";
import { turnTokenRate } from "../domain/token-rate";
import { DaemonApi, isOwnershipError } from "../runtime/rpc-client";
import { haptic } from "../platform/haptic"
import { copyText } from "../platform/clipboard";
import { isPhoneMode } from "../platform/local-mode";
import { fileSaveMode, saveBlob } from "../platform/native-shell";
const LazyCollabConnectSheet = lazy(async () => {
  const module = await import("./chat/CollabConnectSheet");
  return { default: module.CollabConnectSheet };
});
const LazyAnswerSheet = lazy(async () => {
  const module = await import("./sessions/AnswerSheet");
  return { default: module.AnswerSheet };
});
const LazySessionSettingsSheet = lazy(async () => {
  const module = await import("./tools/SessionSettingsSheet");
  return { default: module.SessionSettingsSheet };
});
const LazyFileViewer = lazy(async () => {
  const module = await import("./tools/FileViewer");
  return { default: module.FileViewer };
});

// Dynamic on purpose: sheets are code-split so the first load stays inside the
// perf budget (scripts/deploy/verify-perf.mjs); a static import would pull this in eagerly.
const LazyCommandInputSheet = lazy(async () => {
  const module = await import("./commands/CommandInputSheet");
  return { default: module.CommandInputSheet };
});
const LazyCommandResultSheet = lazy(async () => {
  const module = await import("./commands/CommandResultSheet");
  return { default: module.CommandResultSheet };
});
const LazyModelPicker = lazy(async () => {
  const module = await import("./sessions/ModelPicker");
  return { default: module.ModelPicker };
});
const LazyBtwSheet = lazy(async () => {
  const module = await import("./chat/BtwSheet");
  return { default: module.BtwSheet };
});
const LazyGoalSheet = lazy(async () => {
  const module = await import("./chat/GoalSheet");
  return { default: module.GoalSheet };
});
import { readPairingToken } from "../platform/browser-storage";
import { getDraftNamespace, readDraft, restoredDraftText, seedDraft } from "./composer/use-draft";
import { restoreWithdrawnDraft } from "./composer/withdrawn-draft";
import { GoalChip } from "./chat/GoalChip";
import { PlanChip } from "./chat/PlanChip";
import { daemonErrorCause, humanizeDaemonError } from "./ui/OwnedBySession";
import { errorRecoveryAction } from "./ui/error-recovery";
import { failedTurnToRetry } from "../domain/failed-turn";
import { editPlacementProblem, planRedo, redoKind } from "../domain/turn-redo";
import { redoTurn } from "../runtime/turn-redo";
import { loadMessageImages } from "../runtime/message-images";
import { canCancelRetry } from "../domain/run-status";
// For chat-chunk.ts: warming the chat chunk also warms its rich markdown layer.
export { preloadMarkdown } from "@/components/markdown";

// The daemon names a dead agent process "agent process <why>" (exited, open
// failure, terminated…). That is the one signal the child is gone, whatever
// the turn state still says.
const CHILD_DIED = "agent process ";



// Slice helper that keeps a stable reference via shallow equality.
// `useStoreValue` subscribes per-selector, so 12 selectors run per streaming
// token even when only `streamingMessage` changed. Combining related slices into
// one subscription and returning the previous object when all fields are
// `Object.is` equal reduces selector invocations from ~12 to 3 per token.
function useStoreSlice<T>(
  store: OmpStoreApi,
  selector: (state: OmpStore) => T,
  equal: (a: T, b: T) => boolean,
): T {
  const prevRef = useRef<T | null>(null);
  const hasPrev = useRef(false);
  return useSyncExternalStore(
    store.subscribe,
    () => {
      const next = selector(store.getState());
      if (hasPrev.current && equal(prevRef.current as T, next))
        return prevRef.current as T;
      prevRef.current = next;
      hasPrev.current = true;
      return next;
    },
    () => {
      const next = selector(store.getState());
      if (hasPrev.current && equal(prevRef.current as T, next))
        return prevRef.current as T;
      prevRef.current = next;
      hasPrev.current = true;
      return next;
    },
  );
}



/**
 * The message being written while it is still a run step: thinking and calls,
 * no prose yet. Its reasoning streams inside the run's timeline instead of as
 * a second bubble. The history-echo projection is reused, so the reference is
 * stable for an unchanged frame.
 */
function selectLiveRunMessage(s: OmpStore): UiMessage | null {
  const live = s.streamingMessage;
  if (!live || live.parts.length === 0 || !isRunMessage(live)) return null;
  return visibleStreamingMessage(s.messages, live);
}

interface RunHostProps {
  sessionPath: string | null;
  pendingAsk?: PendingAsk;
  onOtherQuestion: () => void;
  onAnswerSent: () => void;
  /** The run's turn is long: its rail is sections even when the run alone is short. */
  sectioned?: boolean;
}

/**
 * The live run at the transcript tail. The model's in-progress step joins it
 * here, so the thought streams once, in the timeline. Like StreamingMessage it
 * subscribes to the live message, so a streamed frame repaints only this run.
 */
const LiveRunSummary = memo(function LiveRunSummary({
  store,
  messages,
  liveMessageId,
  ...host
}: RunHostProps & {
  store: OmpStoreApi;
  messages: readonly UiMessage[];
  liveMessageId: string | null;
}) {
  const live = useStoreValue(store, selectLiveRunMessage);
  // The answer has begun: the group stops previewing and folds into its title (DeepSeek: no longer the latest block).
  const answering = useStoreValue(store, (s) => !!visibleStreamingMessage(s.messages, s.streamingMessage)?.text.trim());
  const steps = useMemo(() => {
    if (!live) return messages;
    // A response history already holds (an echo before its stream end) is
    // shown from history; its fresh details land with the commit.
    const echoed = messages.some((message) => message.id === live.id || (!!live.responseKey && message.responseKey === live.responseKey));
    return echoed ? messages : [...messages, live];
  }, [messages, live]);
  return (
    <WorkRun
      messages={steps}
      toolsLive
      latestThought
      group={answering ? "done" : "live"}
      // Calls in the message being written are the ones that can be running.
      liveMessageId={live ? live.id : liveMessageId}
      {...host}
    />
  );
});

/**
 * The live assistant bubble. It and LiveRunSummary are the ONLY components
 * that subscribe to `streamingMessage`, which changes every animation frame
 * while a reply streams (see the INVARIANT on ChatScreen's transcript slice).
 */
const StreamingMessage = memo(function StreamingMessage({
  store,
  onOpenPath,
  runHosted,
  opensTurn,
  previousModel,
  ...host
}: RunHostProps & {
  store: OmpStoreApi;
  onOpenPath?: (path: string) => void;
  /** A live run at the tail already shows the in-progress step. */
  runHosted: boolean;
  /** Nothing of this turn is in the timeline yet: the live reply names its model, if it changed. */
  opensTurn: boolean;
  /** The newest assistant model already in the timeline. */
  previousModel: string | undefined;
}) {
  const streaming = useStoreValue(store, (s) =>
    visibleStreamingMessage(s.messages, s.streamingMessage),
  );
  const runStep = useStoreValue(store, selectLiveRunMessage);
  const runMessages = useMemo(() => (runStep ? [runStep] : null), [runStep]);
  const bubbles = useAppearance().messageStyle === "bubbles";
  if (!streaming || (!streaming.text && streaming.parts.length === 0 && !streaming.errorMessage))
    return null;
  const head = bubbles
    ? (opensTurn ? <SenderLine model={streaming.model ?? previousModel} /> : null)
    : opensTurn && streaming.model && previousModel !== undefined && streaming.model !== previousModel ? <TurnModel model={streaming.model} /> : null;
  if (runMessages) {
    // A step with nothing before it in this run opens the run's timeline itself.
    return runHosted ? null : (
      <div data-testid="chat-message" className="min-w-0">
        {head}
        <div className={bubbles ? AGENT_THREAD : undefined}>
          <WorkRun messages={runMessages} toolsLive latestThought group="live" liveMessageId={runMessages[0]!.id} {...host} />
        </div>
      </div>
    );
  }
  return (
    <>
      {head}
      <RetainedHeight>
        <Message className="max-w-full" from="assistant">
          <MessageContent>
            <MessageParts
              isStreaming
              latestThought
              message={streaming}
              sessionPath={host.sessionPath}
              onOpenPath={onOpenPath}
            />
          </MessageContent>
        </Message>
      </RetainedHeight>
    </>
  );
});

/** Mounted only while the reply streams, so the settled message releases the minimum in its own commit. */
function RetainedHeight({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => retainMinHeight(ref.current!), []);
  return <div ref={ref} className="min-w-0">{children}</div>;
}

function ThinkingLine({ label }: { label: string }) {
  return (
    <p className="w-fit text-ui tabular-nums text-muted-foreground">
      {label}
    </p>
  );
}

/**
 * The transcript's bottom clearance exists for the jump-to-latest button,
 * which shows only away from the bottom (it floats at bottom-3: 44px + 12px).
 * Always padding it made a short chat at 150% text a little taller than the
 * screen, so it opened scrolled with its first message under the header above
 * a blank band. At the bottom, a short chat now fits and stays pinned to the top.
 */
/**
 * Appearance → Auto-scroll "Stay put": when a reply starts streaming, release
 * the stick-to-bottom lock so the reply grows below the view. Scrolling back
 * to the bottom re-locks it, as the library does for any reader.
 */
function StreamFollow({ store }: { store: OmpStoreApi }) {
  const { release } = useTranscriptViewport();
  const stay = useAppearance().autoScroll === "stay";
  const streaming = useStoreValue(store, (s) => s.streamingMessage !== null);
  useEffect(() => {
    if (stay && streaming) release("program");
  }, [stay, streaming, release]);
  return null;
}

/** Hands the transcript viewport to code outside the Conversation (the jump handler). */
function ViewportBridge({ target }: { target: MutableRefObject<TranscriptViewport | null> }) {
  const viewport = useTranscriptViewport();
  useLayoutEffect(() => {
    target.current = viewport;
    return () => { target.current = null; };
  }, [target, viewport]);
  return null;
}

function TranscriptContent({ className, ...props }: ConversationContentProps) {
  // --composer-height is the floating composer's own height (Composer writes it on <html>). Constant: the Down button now
  // appears only far from the end, where nothing needs the extra room, and a padding that toggled with it shifted the layout.
  // `relative`: SendAnchor's end marker is positioned against the transcript content.
  return <ConversationContent {...props} className={cn(className, "relative pb-[calc(var(--composer-height,7rem)+1rem)]")} />;
}

function normalizeRawCommands(list: unknown[]): RpcAvailableSlashCommand[] {
  const out: RpcAvailableSlashCommand[] = [];
  let hasSessionPin = false;
  // First pass to detect if session pin exists for dedup (PARITY-12).
  for (const entry of list) {
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const n =
        typeof rec.name === "string"
          ? rec.name.replace(/^\/+/, "").toLowerCase()
          : "";
      if (n === "session") hasSessionPin = true;
    }
  }
  for (const entry of list) {
    if (typeof entry === "string") {
      if (isInternalCommandName(entry)) continue;
      if (entry.replace(/^\/+/, "").toLowerCase() === "pin" && hasSessionPin)
        continue;
      out.push({ name: entry, source: "builtin" });
      continue;
    }
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : "";
      if (!name || isInternalCommandName(name)) continue;
      const lower = name.replace(/^\/+/, "").toLowerCase();
      // PARITY-12: standalone /pin duplicates /session pin — hide the legacy alias.
      if (lower === "pin" && hasSessionPin) continue;
      out.push({
        name,
        aliases: Array.isArray(rec.aliases)
          ? (rec.aliases as unknown[]).filter(
              (a): a is string => typeof a === "string",
            )
          : undefined,
        description:
          typeof rec.description === "string" ? rec.description : undefined,
        input:
          rec.input &&
          typeof rec.input === "object" &&
          typeof (rec.input as Record<string, unknown>).hint === "string"
            ? { hint: (rec.input as Record<string, unknown>).hint as string }
            : undefined,
        subcommands: Array.isArray(rec.subcommands)
          ? (rec.subcommands as unknown[])
              .map(
                (
                  s,
                ): {
                  name: string;
                  description?: string;
                  usage?: string;
                } | null => {
                  if (!s || typeof s !== "object") return null;
                  const sr = s as Record<string, unknown>;
                  const sn = typeof sr.name === "string" ? sr.name : "";
                  if (!sn) return null;
                  return {
                    name: sn,
                    description:
                      typeof sr.description === "string"
                        ? sr.description
                        : undefined,
                    usage: typeof sr.usage === "string" ? sr.usage : undefined,
                  };
                },
              )
              .filter(
                (
                  x,
                ): x is {
                  name: string;
                  description?: string;
                  usage?: string;
                } => x !== null,
              )
          : undefined,
        source: typeof rec.source === "string" ? rec.source : "builtin",
      });
    }
  }
  return out;
}

// Memoized: App re-renders on every drawer state change (opening the sessions
// drawer by swipe), and re-rendering the whole chat inside that touchmove froze
// the drag for ~190ms at 4x CPU (measured) before the panel could move.
export const ChatScreen = memo(function ChatScreen({
  controller,
  onBack,
}: {
  controller: OmpSessionController;
  onBack: () => void;
}) {
  const store = controller.getStore();
  const chatVisit = useRef(0);
  const navigationRequest = useRef(0);
  useLayoutEffect(() => {
    let path = store.getState().sessionPath;
    const unsubscribe = store.subscribe(() => {
      const next = store.getState().sessionPath;
      if (next !== path) {
        path = next;
        chatVisit.current++;
      }
    });
    return () => {
      chatVisit.current++;
      unsubscribe();
    };
  }, [store]);
  const captureVisit = useCallback(() => {
    const visit = chatVisit.current;
    const path = store.getState().sessionPath;
    const credential = readPairingToken();
    // Path equality alone accepts a late response after leaving and returning.
    return () => visit === chatVisit.current &&
      store.getState().sessionPath === path && readPairingToken() === credential;
  }, [store]);
  // Combined slices: 3 subscriptions instead of 12, so a streaming token that
  // only touches `streamingMessage` no longer re-runs 10 unrelated selectors.
  //
  // INVARIANT: this screen subscribes to FACTS about the streaming message
  // (present / has text / visible), never to the message itself. Every
  // streamed frame publishes a new `streamingMessage`; subscribing to it here
  // re-rendered the whole screen at frame rate — header, composer, ThumbNav,
  // every sheet — to repaint one bubble. `StreamingMessage` and the tail's
  // `LiveRunSummary` own that subscription instead, so only the live bubble
  // or live run renders per token.
  const transcriptSlice = useStoreSlice(
    store,
    (s) => {
      const live = s.streamingMessage;
      const visibleLive = visibleStreamingMessage(s.messages, live);
      return {
        messages: s.messages,
        streamingPresent: live !== null,
        streamingVisible: !!visibleLive && (!!visibleLive.text || visibleLive.parts.length > 0 || !!visibleLive.errorMessage),
        agentWorking: selectSessionTurn(s, s.sessionPath ?? "") === "running",
        sendAllowed: selectSessionCapability(s, s.sessionPath ?? "", "send") !== false,
        stopAllowed: selectSessionCapability(s, s.sessionPath ?? "", "stop") !== false,
        partialText: s.partialLine?.text ?? null,
        isOpening: s.isOpening,
      };
    },
    (a, b) =>
      a.messages === b.messages &&
      a.streamingPresent === b.streamingPresent &&
      a.streamingVisible === b.streamingVisible &&
      a.agentWorking === b.agentWorking &&
      a.sendAllowed === b.sendAllowed &&
      a.stopAllowed === b.stopAllowed &&
      a.isOpening === b.isOpening &&
      a.partialText === b.partialText,
  );
  const {
    messages,
    streamingPresent,
    streamingVisible,
    agentWorking,
    sendAllowed,
    stopAllowed,
    partialText,
    isOpening,
  } = transcriptSlice;
  // Primitive subscriptions: they change on owner switches and taps, never
  // with stream frames, so they stay out of the transcript slice.
  const sendMode = useStoreValue(store, (s) => s.sendMode);
  const extensionFeedback = useStoreValue(store, (s) => s.extensionFeedback);
  const canQueue = useStoreValue(store, (s) => selectSessionCapability(s, s.sessionPath ?? "", "queue"));
  const canInterrupt = useStoreValue(store, (s) => selectSessionCapability(s, s.sessionPath ?? "", "interrupt"));
  const sessionSlice = useStoreSlice(
    store,
    (s) => ({
      sessionPath: s.sessionPath,
      sessions: s.sessions,
      historyCursor: s.historyCursor,
      loadingEarlier: s.loadingEarlier,
      evictedTop: s.evictedTop,
      evictedBottomAfter: s.evictedBottomAfter,
      trimmedTop: s.trimmedTop,
      staleHistory: s.staleHistory,
    }),
    (a, b) =>
      a.sessionPath === b.sessionPath &&
      a.sessions === b.sessions &&
      a.historyCursor === b.historyCursor &&
      a.loadingEarlier === b.loadingEarlier &&
      a.evictedTop === b.evictedTop &&
      a.evictedBottomAfter === b.evictedBottomAfter &&
      a.trimmedTop === b.trimmedTop &&
      a.staleHistory === b.staleHistory,
  );
  const {
    sessionPath,
    sessions,
    historyCursor,
    loadingEarlier,
    evictedTop,
    evictedBottomAfter,
    trimmedTop,
    staleHistory,
  } = sessionSlice;

  const readOutboxScope = useCallback(() => controller.getReceiptScope(), [controller]);
  const outboxScope = useSyncExternalStore(subscribeOutbox, readOutboxScope, () => "");
  const readOutbox = useCallback(() => controller.getReceiptScope()
    ? controller.getSavedPrompts() : getEmptyOutboxSnapshot(), [controller]);
  const outbox = useSyncExternalStore(subscribeOutbox, readOutbox, getEmptyOutboxSnapshot);
  const browserPending = !usesNativeOutbox();
  // Held follow-ups belong to their queued chip, including native outbox rows.
  const queuedMessages = useStoreValue(store, (s) => s.queuedMessages);
  const pendingPresentation = useMemo(() => projectPendingIntents(
    messages, outbox, sessionPath, outboxScope, controller, browserPending ? "browser" : "native", queuedMessages,
  ), [messages, outbox, sessionPath, outboxScope, controller, browserPending, queuedMessages]);
  const pendingSends = pendingPresentation.pending;
  const shownMessages = useMemo(
    () => hideHeldEchoes(pendingPresentation.messages, queuedMessages, outbox),
    [pendingPresentation.messages, queuedMessages, outbox],
  );

  const chromeSlice = useStoreSlice(
    store,
    (s) => ({
      connection: s.connection,
      error: s.error,
      hasHeld: s.heldCollabResponse !== null,
    }),
    (a, b) =>
      a.connection === b.connection &&
      a.error === b.error &&
      a.hasHeld === b.hasHeld,
  );
  const { connection, error, hasHeld } = chromeSlice;
  // One verdict for every surface (runtime/link-indicator.ts): the socket's
  // own state flipped on every retry and made the pill flicker.
  const link = useLinkIndicator();
  const unreachable = link.kind === "unreachable" || link.kind === "offline" || link.kind === "daemon-down";
  const sessionModel = useStoreSlice(store, (state) => state.sessionModel, Object.is);
  const contextPercent = useStoreSlice(store, selectContextPercent, Object.is);
  const contextTokens = useStoreSlice(store, selectContextTokens, (a, b) => a?.used === b?.used && a?.window === b?.window);
  // Whole-session spend (row tally + turns after it), formatted once here.
  const sessionCost = useStoreSlice(store, (state) => formatCost(selectSessionCost(state)), Object.is);
  const compaction = useCompaction(store, sessionPath);
  // Compacting aborts a running turn, so the offer waits for an idle one.
  const compactOffer = useCompactOffer(store, sessionPath, agentWorking || compaction.phase !== null);
  const autoRetry = useStoreValue(store, (state) => state.autoRetry);
  const backgroundWork = useStoreValue(store, selectBackgroundWork);
  const retryCancellable = useStoreValue(store, (state) => canCancelRetry(selectSessionAuthority(state, state.sessionPath ?? "")?.owner.kind));
  const cancelRetry = useCallback(async () => {
    try {
      const refusal = await controller.abortRetry();
      if (refusal) showToast(refusal, "error");
    } catch {
      showToast("Couldn't cancel the retry", "error");
    }
  }, [controller]);
  // The sheet shows the derived figure when the live one is not reported.
  const pickerModelHint = useMemo(
    () => (sessionModel || contextPercent !== undefined ? { ...sessionModel, ctxPercent: sessionModel?.ctxPercent ?? contextPercent } : sessionModel),
    [sessionModel, contextPercent],
  );

  const [rawCommands, setRawCommands] = useState<RpcAvailableSlashCommand[]>(
    [],
  );
  // Keep unchanged runs memoized while the streaming tail changes every token.
  const previousTimeline = useRef<ReturnType<typeof buildTimeline>>([]);
  const timelineRevision = useStoreValue(store, (state) => state.timelineRevision);
  const { timeline, lastAssistantId, lastTextAssistantId, latestThoughtId } = useMemo(() => {
    const tl = buildTimeline(shownMessages, previousTimeline.current, TIMELINE_NAMES);
    previousTimeline.current = tl;
    let lastId: string | null = null;
    let lastTextId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "assistant") continue;
      lastId ??= message.id;
      if (message.text.trim()) {
        lastTextId = message.id;
        break;
      }
    }
    // Thinking → "latest": the one message holding the newest thought of the
    // newest turn. Only that thought stays open; earlier ones fold.
    let latestThoughtId: string | null = null;
    for (let i = shownMessages.length - 1; i >= 0 && shownMessages[i]!.role !== "user"; i--) {
      if (shownMessages[i]!.parts.some((part) => part.kind === "thinking")) {
        latestThoughtId = shownMessages[i]!.id;
        break;
      }
    }
    return { timeline: tl, lastAssistantId: lastId, lastTextAssistantId: lastTextId, latestThoughtId };
  }, [messages, shownMessages, timelineRevision]);
  // Only the newest failed turn offers Retry, and only until something newer
  // (including the retry's own echo) lands after it.
  const failedTurn = useMemo(() => failedTurnToRetry(shownMessages), [shownMessages]);
  const retryingRef = useRef(false);
  const handleRetry = useCallback(async () => {
    // One tap, one re-run: the echo removes the action, but not before the
    // durable save resolves, so a quick second tap must not send again.
    if (!failedTurn || !sessionPath || retryingRef.current) return;
    retryingRef.current = true;
    haptic("light");
    try {
      const receipt = await controller.retryFailedTurn(failedTurn.prompt, sessionPath);
      if (receipt?.state === "uncertain") showToast(UNCERTAIN_SEND_TOAST, "warn");
      else if (receipt && deliveryFailed(receipt)) showErrorToast(receipt.error);
    } catch (e) {
      showErrorToast(e);
    } finally {
      retryingRef.current = false;
    }
  }, [controller, failedTurn, sessionPath]);
  const openQuestionSheet = useCallback(() => setAnswerOpen(true), []);
  const refreshQuestions = useCallback(() => {
    // Where active, question polling owns background errors. An accepted answer's
    // opportunistic refresh must not leak a rejection from a void callback.
    void controller.loadSessions().catch(() => undefined);
  }, [controller]);
  // Transcript path taps open here, not in FilesSheet: chips render inside
  // message rows, far from the Files menu, and deserve the same viewer.
  const [transcriptViewerPath, setTranscriptViewerPath] = useState<
    string | null
  >(null);
  const [transcriptViewerOpen, setTranscriptViewerOpen] = useState(false);
  const handleOpenTranscriptPath = useCallback((raw: string) => {
    // Transcript prose appends :line / :line:col (docs/foo.md:42). The daemon
    // resolves the file part under the session cwd; the viewer shows the file.
    const file = raw.replace(/:\d+(?::\d+)?$/, "");
    setTranscriptViewerPath(file.length > 0 ? file : raw);
    setTranscriptViewerOpen(true);
  }, []);
  // Outbox status binds to user rows by command id where the row is our own
  // echo, and pairs newest-first by text (or image count) otherwise.
  const userRowStatus = useMemo(
    () => bindUserRowStatus(messages, outbox, sessionPath, browserPending),
    [messages, outbox, sessionPath, browserPending],
  );
  const composerDraftActions = useRef<ComposerDraftActions | null>(null);
  // Side question sheet; `question` prefills (and asks) a typed `/btw …`.
  const [btwSeed, setBtwSeed] = useState<{ question: string } | null>(null);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [hasCollabRoom, setHasCollab] = useState(false);
  const [hasExtensionDialog, setHasExtensionDialog] = useState(false);
  // Either in-chat question surface: a collab room's or this session's own
  // omp child's (ExtensionDialogSheet). Both supersede the answer sheet.
  const hasCollab = hasCollabRoom || hasExtensionDialog;
  // The daemon's own child asks through ExtensionDialogSheet (its dialogs are
  // replayed on attach); the answer sheet is for questions asked on a laptop.
  const childOwned = useStoreValue(store, (s) => s.sessionPath !== null && selectSessionAuthority(s, s.sessionPath)?.owner.kind === "child");
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [openingOnLaptop, setOpeningOnLaptop] = useState(false);
  const [closeOnLaptopOpen, setCloseOnLaptopOpen] = useState(false);
  const [closedOnLaptop, setClosedOnLaptop] = useState<string | null>(null);
  // The move is answered once omp is up on your computer, but this screen's
  // listing is served stale-while-revalidate and nothing nudges it in a chat
  // (measured: still "not on the laptop" 8 s later), so "Open on computer"
  // stayed offered for a conversation already there. Trust the move until
  // the listing agrees.
  const [movedToLaptop, setMovedToLaptop] = useState<string | null>(null);
  const paletteOpen = usePaletteOpen();
  const [slashOpen, setSlashOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [inputCmd, setInputCmd] = useState<OmpCommand | null>(null);
  const [inputSub, setInputSub] = useState<{
    name: string;
    description?: string;
    usage?: string;
  } | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Each conversation's transcript stays hidden until its opening has settled (OpenReveal).
  const revealKey = sessionPath ?? "none";
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const revealed = revealedKey === revealKey;
  const revealNow = useCallback(() => setRevealedKey(revealKey), [revealKey]);
  // A transcript scroller per session (the Conversation remounts on switch).
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // The composer's Stop, also offered by a running agent command (BashTool):
  // queued messages omp withdraws come back to this chat's composer.
  const [stopping, setStopping] = useState(false);
  const stopTurn = useCallback(async () => {
    if (!sessionPath) return;
    haptic("medium");
    stoppedByUser.current = true;
    setStopping(true);
    try {
      await controller.abortTurn(sessionPath, async (withdrawn, destination) => {
        const notice = await restoreWithdrawnDraft(destination.sessionPath, withdrawn, destination.namespace);
        if (notice && controller.getStore().getState().sessionPath === destination.sessionPath
          && getDraftNamespace() === destination.namespace) showToast(notice);
      });
    } catch (error) {
      setStopping(false);
      throw error;
    }
  }, [controller, sessionPath]);
  // The composer's Stop owns a `stopping` state: a tap used to give only a
  // haptic, the button looked unchanged until the turn ended, and a failed
  // stop was swallowed.
  const runStopRef = useRef<() => void>(() => undefined);
  const runStop = useCallback(() => {
    if (stopping) return;
    stopTurn().catch(() => {
      showToast("Couldn’t stop the agent.", "error", { label: "Try again", onClick: () => runStopRef.current() });
    });
  }, [stopTurn, stopping]);
  runStopRef.current = runStop;
  useEffect(() => {
    if (!agentWorking) setStopping(false);
  }, [agentWorking]);
  useEffect(() => setStopping(false), [sessionPath]);
  const ownerKind = useStoreValue(store, (s) => selectSessionAuthority(s, s.sessionPath ?? "")?.owner.kind);
  const sendBlockedMessage = sendBlockedReason(sendAllowed, ownerKind);
  // Screen-reader turn announcement. The store has no aborted flag, so Stop (this
  // callback) is the source for "stopped". Only a running->idle edge on the SAME
  // session announces, so opening or switching a chat stays silent.
  const [turnAnnouncement, setTurnAnnouncement] = useState("");
  const stoppedByUser = useRef(false);
  const turnSeen = useRef({ path: sessionPath, working: agentWorking });
  useEffect(() => {
    const prev = turnSeen.current;
    turnSeen.current = { path: sessionPath, working: agentWorking };
    if (prev.path !== sessionPath || (!prev.working && agentWorking)) {
      stoppedByUser.current = false;
      setTurnAnnouncement("");
    } else if (prev.working && !agentWorking) {
      setTurnAnnouncement(stoppedByUser.current ? "Response stopped" : "Response complete");
      stoppedByUser.current = false;
    }
  }, [sessionPath, agentWorking]);
  const transcriptActions = useMemo<TranscriptActions>(() => ({
    switchModel: () => setModelPickerOpen(true),
    editPrompt: (text) => {
      const problem = sessionPath
        ? editPlacementProblem(composerDraftActions.current, sessionPath, text)
        : "Open the conversation to edit this message.";
      if (problem) showToast(problem, "error");
    },
    stopTurn,
  }), [sessionPath, stopTurn]);
  // `/plan`, its palette row and the settings switch all land here: plan mode
  // toggles through the daemon's `plan_mode`, never as text the model reads.
  // The tap-time session is captured so a reply cannot land on another chat.
  const setPlanMode = useCallback(async (enabled: boolean): Promise<PlanModeState> => {
    if (!sessionPath) throw new Error("Open the conversation first.");
    const target = sessionPath;
    const state = await new DaemonApi(readPairingToken() ?? "").setPlanMode(target, enabled);
    controller.applyPlanModeReply(target, state);
    return state;
  }, [controller, sessionPath]);
  // The session a bare `/plan` is asking about, while plan mode is unknown.
  const [planAskPath, setPlanAskPath] = useState<string | null>(null);
  const togglePlanMode = useCallback(async (enabled?: boolean): Promise<void> => {
    if (!sessionPath) {
      showToast("No session open", "error");
      return;
    }
    const target = planToggleTarget(store.getState().planMode, enabled);
    if (target === null) {
      setPlanAskPath(sessionPath);
      return;
    }
    try {
      const state = await setPlanMode(target);
      showToast(state.enabled ? "Plan mode on" : "Plan mode off");
    } catch (e) {
      showErrorToast(e);
    }
  }, [sessionPath, setPlanMode, store]);
  const planOn = useStoreValue(store, (s) => s.planMode?.enabled === true);
  // Goal sheet; `objective` prefills from a typed `/goal …`.
  const [goalSeed, setGoalSeed] = useState<{ objective: string } | null>(null);
  const [commandResult, setCommandResult] = useState<CommandResult | null>(
    null,
  );
  const [answerOpen, setAnswerOpen] = useState(false);
  // A slash command that prints (omp runs it locally) opens a sheet. It is NOT
  // sent as a chat message: through /api/prompt `/usage` was echoed into the
  // conversation as if the user had typed it, and its output went nowhere.
  const runPrintingCommand = useCallback(
    async (text: string): Promise<void> => {
      if (!sessionPath) return;
      const command = text.trim().split(/\s+/)[0] ?? text;
      const api = new DaemonApi(readPairingToken() ?? "");
      const current = captureVisit();
      try {
        const run = await api.runCommand(sessionPath, text.trim());
        if (!current()) return;
        if (run.output.trim()) setCommandResult({ command, title: command, ok: true, output: run.output });
        // Native background handlers acknowledge admission before printing a
        // result. Their late output is retained in this session's feedback.
        else showToast(run.agentInvoked ? "Sent to the agent" : `${command} started. Results appear in this conversation.`);
      } catch (e) {
        if (!current()) return;
        // The breakdown only prints in the daemon's own agent. A desktop
        // owner still answers get_state over its bridge: the total, at least.
        if (command === "/context" && isOwnershipError(e)) {
          try {
            const data = await api.rpc(sessionPath, "get_state", {});
            if (!current()) return;
            setCommandResult({ command, title: "Context", ok: true, data, provenance: "live" });
            return;
          } catch {
            // Fall through to the original refusal, which says why.
          }
        }
        if (!current()) return;
        setCommandResult({ command, title: command, ok: false, message: humanizeDaemonError(e), recoveryError: e });
      }
    },
    [sessionPath, captureVisit],
  );
  // /usage: the session's own figures open instantly; omp's provider quota
  // (account-wide, so it works even while the desktop owns this session) fills
  // in under them.
  const showUsageResult = useCallback(async (result: CommandResult): Promise<void> => {
    if (!sessionPath) return;
    // The pending result owns this request. Closing or replacing the sheet must
    // prevent an older quota response from patching a newer Usage visit.
    const pending: CommandResult = { ...result, limits: "loading" };
    setCommandResult(pending);
    const patch = (limits: NonNullable<CommandResult["limits"]>): void =>
      setCommandResult((previous) => (previous === pending ? { ...previous, limits } : previous));
    try {
      const run = await new DaemonApi(readPairingToken() ?? "").runCommand(sessionPath, "/usage");
      patch({ providers: parseUsageReport(run.output), raw: run.output });
    } catch (e) {
      patch({ error: humanizeDaemonError(e), recoveryError: e });
    }
  }, [sessionPath]);
  const inset = useKeyboardInset();

  useEffect(() => {
    if (error === null) setDismissedError(null);
  }, [error]);
  // "Open on computer" stops the phone's own agent for this conversation first,
  // and its exit notice arrives while omp is still booting on your computer. It
  // is the move working, so it stays hidden until the move settles: success
  // clears it, a failed move leaves it (the phone agent really did stop).
  const handoffNotice = openingOnLaptop && error?.startsWith(CHILD_DIED) === true;
  // A dead child outranks whatever turn state was last reported: no footer
  // or strip may go on saying the agent is working.
  const childDied = !handoffNotice && error !== null && (error.startsWith(CHILD_DIED) || error.includes(`(${CHILD_DIED}terminated)`));
  // While the link is known down, a timeout or "can't reach" error is the
  // connection pill's to say; the red notice repeated it beside it.
  const linkDown = link.kind !== "ok";
  const visibleError = error && dismissedError !== error && !handoffNotice && !(linkDown && daemonErrorCause(error) === "connection") ? error : null;
  // The banner is where a REFUSED SEND lands (the store carries the daemon's
  // receipt text), so it goes through the same humanizer as the toasts: the raw
  // refusal names a pid and a command line, and the half worth reading is the
  // reason automatic sharing failed, not the boilerplate that says "open it on
  // your computer" to someone who just did.
  const visibleErrorText = visibleError ? humanizeDaemonError(visibleError) : null;
  useEffect(() => {
    if (!sessionPath) return;
    let cancelled = false;
    void controller.loadCommands().then((list) => {
      if (!cancelled) setRawCommands(normalizeRawCommands(list as unknown[]));
    });
    return () => {
      cancelled = true;
    };
  }, [controller, sessionPath]);
  // omp pushes the catalogue when its commands change (a reloaded plugin or
  // skill); the fetch above only runs when the session does.
  const pushedCommands = useStoreValue(store, (s) => s.availableCommands);
  useEffect(() => {
    if (pushedCommands) setRawCommands(normalizeRawCommands([...pushedCommands]));
  }, [pushedCommands]);
  // Viewport edge for transcript windowing: eviction always drops the FAR end
  // (oldest pages at the live edge, newest while scrolled up), so the
  // controller must know which edge the reader sits at. Passive listener,
  // same 48px epsilon the send path uses — no layout reads beyond what the
  // scroll event already dirties.
  useEffect(() => {
    const el = document.querySelector(".chat-scroll");
    if (!(el instanceof HTMLElement)) return;
    const report = () => {
      const fromTop = el.scrollTop + el.clientHeight;
      controller.setAtBottom(
        fromTop >= el.scrollHeight - 48,
        // Lower half of what is held: the oldest end is the far one.
        fromTop - el.clientHeight / 2 >= el.scrollHeight / 2,
      );
    };
    report();
    el.addEventListener("scroll", report, { passive: true });
    return () => el.removeEventListener("scroll", report);
  }, [controller, sessionPath]);
  // The scroller remounts per session (Conversation's key); the viewport owns its resizes.
  useLayoutEffect(() => {
    setScroller(document.querySelector<HTMLElement>(".chat-scroll"));
  }, [sessionPath]);
  // A downward drag of the transcript (reading back) drops the keyboard.
  useBlurComposerOnScroll(scroller);

  // Native command names and aliases take precedence over project templates.
  const commands = useMemo(() => buildComposerCommands(rawCommands, planOn), [rawCommands, planOn]);

  // Android WebView scrolls the whole document when a node inside an overflow
  // container takes focus, so the shell claims focus once when a session
  // opens. It MUST NOT claim it back afterwards: doing so ripped focus out of
  // the command palette and the composer, closing the keyboard mid-tap and
  // making commands unusable on a phone.
  const shellFocusedFor = useRef<string | null>(null);
  const shellRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !sessionPath) return;
      if (shellFocusedFor.current === sessionPath) return;
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable ||
          active.closest("[role='dialog']") !== null);
      if (typing) return;
      shellFocusedFor.current = sessionPath;
      node.focus({ preventScroll: true });
    },
    [sessionPath],
  );

  // The open conversation's listing row. `sessions` is the Sessions screen's
  // scoped page (search, project, pins), so a chat opened outside that view —
  // a search hit, another project's notification, an older paged row — had no
  // summary, and the laptop-question answer, header model, interruption
  // notice and `/new` all quietly did nothing. Fetch the row itself then.
  const listedSummary = useMemo(
    () => sessions.find((session) => session.path === sessionPath) ?? null,
    [sessions, sessionPath],
  );
  const [ownRow, setOwnRow] = useState<OmpSessionSummary | null>(null);
  useEffect(() => {
    if (!sessionPath || listedSummary) return;
    let cancelled = false;
    // Re-fetched whenever the list reloads (`sessions`), so it ages with it.
    void new DaemonApi(readPairingToken() ?? "").sessionRow(sessionPath).then(
      (row) => { if (!cancelled) setOwnRow(row); },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sessionPath, listedSummary, sessions]);
  const summary = listedSummary ?? (ownRow?.path === sessionPath ? ownRow : null);
  // A turn a kill cut off: offered back (Continue) until the user acts on it
  // or a new turn starts. Acting is remembered locally so the cached list
  // cannot bring the notice back for a few seconds.
  const [, setInterruptionHandledTick] = useState(0);
  const interruption = sessionInterruption(summary);
  const continueInterrupted = useCallback(async () => {
    if (!sessionPath || !interruption) return;
    try {
      const receipt = await controller.sendPrompt("Continue", [], sessionPath);
      if (receipt?.state === "failed") {
        showErrorToast(receipt.error);
        return;
      }
      if (receipt?.state === "uncertain")
        showToast(UNCERTAIN_SEND_TOAST, "warn");
      markInterruptionHandled(sessionPath, interruption);
      setInterruptionHandledTick((n) => n + 1);
    } catch (e) {
      showErrorToast(e);
    }
  }, [controller, interruption, sessionPath]);
  const dismissInterrupted = useCallback(async () => {
    if (!sessionPath || !interruption) return;
    try {
      await controller.dismissInterruption(sessionPath);
      markInterruptionHandled(sessionPath, interruption);
      setInterruptionHandledTick((n) => n + 1);
    } catch (e) {
      showErrorToast(e);
    }
  }, [controller, interruption, sessionPath]);
  const onLaptop = summary
    ? closedOnLaptop === summary.path
      ? false
      : isOnLaptop(summary) || movedToLaptop === summary.path
    : true;
  useEffect(() => {
    if (summary && movedToLaptop === summary.path && isOnLaptop(summary)) setMovedToLaptop(null);
  }, [summary, movedToLaptop]);
  useEffect(() => {
    if (summary && closedOnLaptop === summary.path && !isOnLaptop(summary)) setClosedOnLaptop(null);
  }, [summary, closedOnLaptop]);

  const openOnLaptop = useCallback(async () => {
    if (!sessionPath) return;
    setOpeningOnLaptop(true);
    try {
      const opened = await new DaemonApi(readPairingToken()).openOnLaptop(sessionPath);
      // The move stops the phone's own agent for this conversation, and its
      // exit notice ("agent process terminated (session adopted by a
      // terminal)") lands in the chat as an error. It is the requested
      // outcome, not a failure.
      if (store.getState().error?.startsWith(CHILD_DIED)) store.getState().setError(null);
      showToast(laptopOpenedText(opened));
      setMovedToLaptop(sessionPath);
      void controller.loadSessions().catch(() => undefined);
    } catch (e: unknown) {
      showErrorToast(e);
    } finally {
      setOpeningOnLaptop(false);
    }
  }, [sessionPath, store, controller]);

  const live = useMemo(() => {
    const model = summary
      ? (shortModel(summary.model as string | null | undefined) ?? undefined)
      : undefined;
    const ctx = summary ? getCtxPercent(summary) : null;
    return {
      model,
      contextPercent: typeof ctx === "number" ? ctx : undefined,
      agentWorking,
    };
  }, [summary, agentWorking]);

  // A single-select question is answered by the quick-reply chips in the chat
  // flow itself; opening the modal sheet on top would hide them.
  const quickAskVisible = pendingQuickQuestion(messages, summary?.pendingAsk) !== null;

  // Auto-open answer sheet when arriving via a needs_input notification tap with pendingAsk present.
  // A phone-driven session's question opens its own dialog sheet instead.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const state = window.history.state as Record<string, unknown> | null;
    const isNeedsInputTap = state?.notificationKind === "needs_input";
    if (isNeedsInputTap && (childOwned || summary?.pendingAsk)) {
      if (childOwned) window.dispatchEvent(new CustomEvent("extension-dialog:show"));
      else if (!quickAskVisible) setAnswerOpen(true);
      // Clear notificationKind so back/forth nav does not re-trigger
      try {
        const nextState = { ...state };
        delete nextState.notificationKind;
        window.history.replaceState(nextState, "", window.location.href);
      } catch {}
    }
  }, [summary, quickAskVisible, childOwned]);

  // A question asked on the LAPTOP (the desktop omp's `ask`, seen by the
  // daemon as a blocked pane) has no in-chat dialog: CollabDialog only renders
  // a daemon child's or a collab room's request. The list said "Answer" and
  // the chat then showed nothing at all. The answer sheet is the one surface
  // that can reply to a laptop pane, so the track strip's question pill opens it, and it
  // opens by itself once per question when the chat is entered.
  const laptopAsk = !hasCollab && !childOwned && summary !== null && sessionStatus(summary) === "waiting";
  const laptopAskKey = laptopAsk && summary.pendingAsk
    ? `${summary.path}\u0000${summary.pendingAsk?.id ?? summary.pendingAsk?.question ?? ""}\u0000${summary.pendingAsk?.index ?? 0}`
    : null;
  const shownLaptopAskRef = useRef<string | null>(null);
  useEffect(() => {
    if (!laptopAsk) {
      setAnswerOpen(false);
      return;
    }
    if (laptopAskKey === null || shownLaptopAskRef.current === laptopAskKey) return;
    shownLaptopAskRef.current = laptopAskKey;
    if (!quickAskVisible) setAnswerOpen(true);
  }, [laptopAsk, laptopAskKey, quickAskVisible]);

  useEffect(() => {
    if (!answerOpen && !laptopAsk && !summary?.bridge) return;
    // Laptop Ask progress lives in the listing, not the chat stream. A single
    // post-answer fetch can hit the SWR cache before the next question lands.
    controller.startSessionsPolling();
    void controller.loadSessions().catch(() => undefined);
    return () => controller.stopSessionsPolling();
  }, [answerOpen, laptopAsk, summary?.bridge, controller]);

  // INVARIANT: arrivingIds tracks ids that ARRIVED at the live tail, never
  // during render. The previous implementation mutated a ref inside useMemo,
  // which is a render side effect: StrictMode double-invoke adds ids twice and
  // React may discard/recompute a memo at will. Bookkeeping now lives in a
  // layout effect so the render stays pure; the effect walks backwards from the
  // tail and stops at the first already-seen id, so a prepended history page
  // (head insert) yields an empty fresh set and mounts silently. That is
  // required for scroll anchoring: rows that start at opacity 0 are invisible
  // and the browser skips them when choosing an anchor, so the viewport would
  // jump by the height of the inserted page.
  const seenMessageIdsRef = useRef<Set<string> | null>(null);
  const prevSessionPathRef = useRef<string | null>(null);
  const [arrivingIds, setArrivingIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  useLayoutEffect(() => {
    // Session switch: the store clears messages to [] before the history fetch,
    // so the first non-empty page (empty -> 50) must NOT animate. Invalidate
    // seen so the next effect treats that page as pre-existing. If messages is
    // already populated at switch time (rare), snapshot it directly.
    if (prevSessionPathRef.current !== sessionPath) {
      prevSessionPathRef.current = sessionPath;
      if (messages.length === 0) {
        seenMessageIdsRef.current = null;
      } else {
        seenMessageIdsRef.current = new Set(messages.map((m) => m.id));
      }
      setArrivingIds((prev) => (prev.size === 0 ? prev : new Set<string>()));
      // When we invalidated (empty case) the next invocation will populate
      // seen; otherwise we already did. Either way nothing animates this frame.
      if (messages.length === 0) return;
      if (seenMessageIdsRef.current !== null) return;
    }
    if (seenMessageIdsRef.current === null) {
      seenMessageIdsRef.current = new Set(messages.map((m) => m.id));
      return;
    }
    const ids = messages.map((m) => m.id);
    const seen = seenMessageIdsRef.current;
    const fresh = new Set<string>();
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      if (seen.has(id)) break;
      fresh.add(id);
    }
    for (const id of ids) seen.add(id);
    // Entrance must fire exactly once per newly-arrived message and never
    // replay. fresh holds only tail arrivals since last commit; update state
    // only when it differs to avoid an extra render per token when messages
    // is unchanged (the effect does not run then anyway, but guards the
    // prepend case where fresh is empty yet prev already is).
    setArrivingIds((prev) => {
      if (fresh.size === 0) return prev.size === 0 ? prev : new Set<string>();
      if (prev.size === fresh.size) {
        let same = true;
        for (const id of fresh)
          if (!prev.has(id)) {
            same = false;
            break;
          }
        if (same) return prev;
      }
      return fresh;
    });
  }, [messages, sessionPath]);
  // No landing effect here on purpose. The scroller remounts per session
  // (key below), so every switch — sessions list, recents drawer, branch —
  // takes the same mount path with StickToBottom's own initial animation.
  // A previous pass imposed a delayed scrollTop jump instead; on slow devices
  // it fired mid-flight, desynced the library's bottom tracking, and the
  // first Up presses walked 119,118,119,118 (verify-nav-paging caught it).

  // Provisional live edge for turns the daemon only sees as file growth
  // (foreign-driven: laptop TUI, where tokens live in that process's memory
  // and the file gets commits). The token flow owns the edge when present;
  // otherwise the partial tail is the only live signal, and it beats silence.
  const provisional = useMemo(
    () =>
      streamingPresent || !partialText
        ? null
        : provisionalTextFromPartial(partialText),
    [streamingPresent, partialText],
  );

  // The transcript edge shows exactly ONE state. The settled marker
  // (`data-edge="settled"` on the newest reply) derives from committed turns
  // only, so without this gate it claims completion while a turn is mid-flight
  // (foreign-driven especially: no child or collab event stream exists, hence
  // no agentWorking) and then visibly streams more.
  // A dead child has no live edge, whatever the last reported turn state says.
  const liveEdge = !childDied && (agentWorking || streamingPresent || partialText !== null);
  // The optimistic echo of a message the reader just sent: the send scroll's trigger.
  const tailMessage = shownMessages.at(-1);
  const tailEchoId = tailMessage?.role === "user" && tailMessage.id.startsWith("local:") ? tailMessage.id : null;
  // The live run at the transcript tail hosts the step being written; any
  // other position (a marker or a queued prompt below it) keeps them apart.
  const tailItem = timeline.at(-1);
  const liveRunKey = liveEdge && tailItem?.kind === "run" && tailItem.messages.at(-1)?.id === lastAssistantId ? tailItem.key : null;

  // The transcript's viewport, for jumps made from outside the Conversation (ViewportBridge fills it).
  const viewportRef = useRef<TranscriptViewport | null>(null);
  const jumpRequest = useRef(0);
  const handleJump = useCallback((entryId: string) => {
    closePanels();
    const request = ++jumpRequest.current;
    const currentVisit = captureVisit();
    const isCurrent = () => currentVisit() && request === jumpRequest.current;
    // Keep the target protected until React lays it out and scrolling settles.
    window.setTimeout(async () => {
      if (!isCurrent()) return;
      const viewport = viewportRef.current;
      const scroller = viewport?.scrollRef.current;
      if (!viewport || !scroller) return;
      try {
        let [target] = readTargets(scroller, [entryId]);
        if (!target) {
          const revealed = await controller.revealEntry(entryId, isCurrent);
          if (!isCurrent()) return;
          if (revealed !== "revealed") {
            showToast(revealed === "off-branch"
              ? "That turn is on another branch. Use ⋯ → Go here to continue from it."
              : "That turn is too far back to load here");
            return;
          }
          // Two frames: React commits the loaded rows, then they lay out.
          const { promise: painted, resolve } = Promise.withResolvers<void>();
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
          await painted;
          if (!isCurrent()) return;
          [target] = readTargets(scroller, [entryId]);
          if (!target) return;
        }
        const { element } = target;
        await scrollToTarget(viewport, element);
        if (isCurrent()) flashTarget(element);
      } finally {
        controller.releaseRevealedEntry(entryId, isCurrent);
      }
    }, 200);
  }, [controller, captureVisit]);

  // A Messages search hit opens the chat AT the matched message: App leaves
  // its entry id in the history entry, consumed once the first page lands.
  const jumpedTo = useRef<string | null>(null);
  useEffect(() => {
    if (isOpening || !sessionPath || messages.length === 0) return;
    const state = window.history.state as Record<string, unknown> | null;
    const entryId = state?.jumpToEntry;
    if (typeof entryId !== "string" || state?.path !== sessionPath) return;
    const key = `${sessionPath}\u0000${entryId}`;
    if (jumpedTo.current === key) return;
    jumpedTo.current = key;
    try {
      const nextState = { ...state };
      delete nextState.jumpToEntry;
      window.history.replaceState(nextState, "", window.location.href);
    } catch {}
    handleJump(entryId);
  }, [isOpening, sessionPath, messages.length, handleJump]);

  // Try again / Edit on the newest turn: rewind in place, or branch when the
  // desktop owns the session (domain/turn-redo.ts, runtime/turn-redo.ts).
  const canWriteInPlace = useStoreValue(store, (s) => selectSessionCapability(s, s.sessionPath ?? "", "settings") !== false);
  const redoPlan = useMemo(
    () => planRedo(shownMessages, { running: liveEdge, sendAllowed, offline: link.kind !== "ok", canWriteInPlace }),
    [shownMessages, liveEdge, sendAllowed, link.kind, canWriteInPlace],
  );
  const [edit, setEdit] = useState<{ sessionPath: string; entryId: string; prompt: UiMessage } | null>(null);
  // The chip belongs to one conversation and one newest message.
  useEffect(() => {
    if (edit && (edit.sessionPath !== sessionPath || redoPlan?.entryId !== edit.entryId)) setEdit(null);
  }, [edit, sessionPath, redoPlan?.entryId]);
  const redoBusy = useRef(false);
  const tryAgain = useCallback(async () => {
    if (!redoPlan || redoPlan.disabled || !sessionPath || redoBusy.current) return;
    redoBusy.current = true;
    haptic("light");
    try {
      const authed = readPairingToken() ?? "";
      // Recover the photos before cutting anything: a missing one must abort, not lose the turn.
      const images = await loadMessageImages(redoPlan.prompt, (path) => fetch(path, { headers: authed ? { Authorization: `Bearer ${authed}` } : {} }));
      const branch = await redoTurn(new DaemonApi(authed), controller, {
        kind: redoPlan.kind,
        entryId: redoPlan.entryId,
        sessionPath,
        text: redoPlan.prompt.text,
        images,
      });
      if (branch) showToast("Opened a branch to try again");
    } catch (e) {
      showErrorToast(e);
    } finally {
      redoBusy.current = false;
    }
  }, [controller, redoPlan, sessionPath]);
  // "Try with another model…": the picker's next successful switch runs the redo.
  const redoAfterModel = useRef(false);
  const tryWithAnotherModel = useCallback(() => {
    if (!redoPlan || redoPlan.disabled) return;
    redoAfterModel.current = true;
    setModelPickerOpen(true);
  }, [redoPlan]);
  const startEdit = useCallback(() => {
    if (!redoPlan || redoPlan.disabled || !sessionPath) return;
    const composer = composerDraftActions.current;
    const problem = composer ? composer.beginEdit(sessionPath, redoPlan.prompt.text) : "The composer isn’t ready yet. Try again.";
    if (problem) showToast(problem, "error");
    else setEdit({ sessionPath, entryId: redoPlan.entryId, prompt: redoPlan.prompt });
  }, [redoPlan, sessionPath]);
  const messageActions = useMessageActions({
    messages,
    sessionPath,
    edit: redoPlan ? { messageId: redoPlan.prompt.id, disabled: redoPlan.disabled, onEdit: startEdit } : undefined,
    onBranched: (newPath: string) => {
      showToast("Branched, opening new session");
      void controller.openSession(newPath);
    },
  });
  const handleBranched = useCallback(
    (newPath: string) => {
      // Sentence case, no em dash.
      showToast("Branched, opening new session");
      void controller.openSession(newPath);
    },
    [controller],
  );
  // A tree move reloads only this conversation. Prepared text uses the same
  // review inbox as native extensions, preserving any draft already being typed.
  const handleMovedHere = useCallback(
    (target: string, editorText?: string, askReanswerCommitted = false) => {
      if (controller.getStore().getState().sessionPath !== target) return;
      showToast(askReanswerCommitted ? "Answer updated, continuing" : "Moved back here");
      void controller.reloadBranch();
      if (editorText) {
        try { controller.prepareEditorDraft(target, editorText); }
        catch { showToast("History changed, but prepared text could not be saved", "error"); }
      }
    },
    [controller],
  );
  // `/export` from the phone: omp renders the HTML, the phone saves it (a
  // download in a browser, the share sheet in the app).
  const [exporting, setExporting] = useState(false);
  const exportConversation = useCallback(async () => {
    if (!sessionPath) return;
    setExporting(true);
    try {
      const { blob, fileName } = await new DaemonApi(readPairingToken() ?? "").exportHtml(sessionPath);
      if (!fileSaveMode(fileName, blob.type)) {
        showToast("This device can't save files from the app", "warn");
        return;
      }
      await saveBlob(blob, fileName);
    } catch (e) {
      showErrorToast(e);
    } finally {
      setExporting(false);
    }
  }, [sessionPath]);
  // New chat goes home with this folder preselected (still changeable), so no chat is created in a folder the person did not see.
  const cwd = summary?.cwd;
  const handleOpenPicker = useCallback(
    (picker: NonNullable<OmpCommand["picker"]>) => {
      if (picker === "model") setModelPickerOpen(true);
      else if (picker === "agents") openWorkspace("agents");
      else if (picker === "timeline" || picker === "todo") openWorkspace("tasks");
      else if (picker === "btw") setBtwSeed({ question: "" });
      else if (picker === "goal") setGoalSeed({ objective: "" });
      else if (picker === "plan") void togglePlanMode();
      else if (picker === "files") openWorkspace("files");
      else if (picker === "export") void exportConversation();
      // omp's /settings is the session's own settings, not the app's.
      else if (picker === "settings") setSessionSettingsOpen(true);
      else if (picker === "new-session") openNewSession(cwd);
      // The recents drawer became the session switcher.
      else if (picker === "recent") openSwitcher();
    },
    [togglePlanMode, exportConversation, cwd],
  );
  // The workspace tabs live outside this screen (App mounts the panel) but
  // act on this chat: jumping, opening a branch, moving back in place,
  // drafting an agent reply.
  const workspaceHost = useMemo<WorkspaceHost>(() => ({
    controller,
    jumpTo: handleJump,
    onBranched: handleBranched,
    onMovedHere: handleMovedHere,
    prepareAgentResponse: (target, context) => {
      if (controller.getStore().getState().sessionPath !== target) return "The main session changed. Reopen this agent and try again.";
      const composer = composerDraftActions.current;
      return composer ? composer.prepareAgentResponse(target, context) : "The composer isn’t available. Close the workspace and try again.";
    },
  }), [controller, handleJump, handleBranched, handleMovedHere]);
  useProvideWorkspaceHost(workspaceHost);

  // omp's `compact` RPC: bare, or with the focus a typed `/compact <focus>`
  // carries. The RPC answers when compaction is done (or refused, e.g. too
  // small), so the outcome is shown; omp's text handler compacts in the
  // background under RPC and prints only after the reply, which nothing saw.
  const compactNow = useCallback(async (focus: string) => {
    if (!sessionPath) {
      showToast("No session open", "error");
      return;
    }
    const current = captureVisit();
    const outcome = await compaction.run(focus.trim() || undefined);
    if (!current()) return;
    // The shared pill owns progress and uncertain outcomes for every entry point.
    if (outcome.kind === "failed") showErrorToast(outcome.error);
  }, [sessionPath, compaction.run, captureVisit]);

  const handlePaletteRun = useCallback(
    async (cmd: OmpCommand, subName?: string) => {
      // Sweep: subcommands were parsed but then dropped for fast/compact/usage.
      // Resolve via resolveDrill for ANY shape that carries subcommands, not
      // just drill — rpc commands like fast and compact have subcommands too.
      let effective: OmpCommand = cmd;
      if (subName) {
        const resolved = resolveDrill(cmd, subName);
        if (resolved) {
          effective = resolved;
        } else if (cmd.subcommands?.some((s) => s.name === subName)) {
          showToast("Unknown subcommand", "error");
          return;
        } else {
          // Fallback: treat as prompt with the subcommand appended, preserving
          // the terminal's parsing (e.g. /compact soft with focus).
          effective = {
            ...cmd,
            name: `${cmd.name} ${subName}`,
            shape: "prompt" as const,
          };
        }
      } else if (cmd.shape === "drill") {
        // Drill without a sub selection is incomplete — the full palette
        // already handles this, but direct calls should be no-ops.
        return;
      }

      if (effective.shape === "pick" && effective.picker) {
        handleOpenPicker(effective.picker);
        return;
      }
      if (effective.shape === "compose") {
        setInputCmd(effective);
        setInputSub(null);
        setInputOpen(true);
        return;
      }
      if (effective.shape === "rpc" && effective.rpc) {
        if (!sessionPath) {
          // Two words say nothing — tell the user what is missing.
          showToast("No session open", "error");
          return;
        }
        const rpcName = effective.rpc;
        const commandTitle = `/${effective.name.replace(/^\/+/, "")}`;
        const changesSession = rpcName === "fork" || rpcName === "branch";
        const currentVisit = captureVisit();
        const request = changesSession ? ++navigationRequest.current : null;
        const currentNavigation = () => currentVisit() && request === navigationRequest.current;
        try {
          const token = readPairingToken() ?? "";
          const api = new DaemonApi(token);
          if (rpcName === "fork") {
            const res = await api.fork(sessionPath);
            if (!res.cancelled && (readPairingToken() ?? "") === token) void controller.loadSessions();
            if (!currentNavigation()) return;
            if (res.cancelled) {
              setCommandResult({
                command: commandTitle,
                title: commandTitle,
                ok: false,
                message: "Fork cancelled",
              });
              return;
            }
            setCommandResult({
              command: commandTitle,
              title: "Forked",
              ok: true,
              data: res,
              message: `Opened ${res.sessionPath}`,
            });
            showToast("Forked, opening the copy");
            void controller.openSession(res.sessionPath);
            return;
          }
          if (rpcName === "branch") {
            const msgs = await api.getBranchMessages(sessionPath);
            if (!currentNavigation()) return;
            if (!msgs.length) {
              setCommandResult({
                command: commandTitle,
                title: commandTitle,
                ok: false,
                message: "No user message to branch from",
              });
              return;
            }
            const entryId = msgs[msgs.length - 1]?.entryId ?? msgs[0]?.entryId;
            if (!entryId) {
              setCommandResult({
                command: commandTitle,
                title: commandTitle,
                ok: false,
                message: "No branch point",
              });
              return;
            }
            const res = await api.branch(sessionPath, entryId);
            if (!currentNavigation()) return;
            // omp hands back the text of the message you branched at so the
            // editor can restore it. Seed it as the new session's draft.
            seedDraft(res.sessionPath, res.text);
            setCommandResult({
              command: commandTitle,
              title: "Branched",
              ok: true,
              data: res,
              message: `Opened ${res.sessionPath}`,
            });
            showToast("Branched, opening new session");
            void controller.openSession(res.sessionPath);
            return;
          }
          if (rpcName === "set_fast_mode") {
            // /fast status uses OMP's printing command so Ultrafast is not
            // collapsed into the boolean used by on/off/toggle.
            const verb = subName?.toLowerCase();
            if (verb === "on") {
              const data = await api.rpc(sessionPath, rpcName, {
                enabled: true,
              });
              setCommandResult({
                command: "/fast on",
                title: "Fast mode on",
                ok: true,
                data,
                message: "Fast mode enabled",
              });
              showToast("Fast mode enabled");
              return;
            }
            if (verb === "off") {
              const data = await api.rpc(sessionPath, rpcName, {
                enabled: false,
              });
              setCommandResult({
                command: "/fast off",
                title: "Fast mode off",
                ok: true,
                data,
                message: "Fast mode disabled",
              });
              showToast("Fast mode disabled");
              return;
            }
            // Bare /fast or /fast toggle — toggle from current state.
            let current = false;
            try {
              const st = await api.getState(sessionPath);
              current = Boolean(
                (st as unknown as Record<string, unknown>).fastModeEnabled,
              );
            } catch {
              current = false;
            }
            const next = !current;
            const data = await api.rpc(sessionPath, rpcName, { enabled: next });
            setCommandResult({
              command: commandTitle,
              title: next ? "Fast mode on" : "Fast mode off",
              ok: true,
              data,
              message: next ? "Fast mode enabled" : "Fast mode disabled",
            });
            showToast(next ? "Fast mode enabled" : "Fast mode disabled");
            return;
          }
          if (rpcName === "compact") {
            // The pill above the composer shows it running and what it freed;
            // a failure still lands in the catch below like any command.
            await compaction.run();
            return;
          }
          const data = await api.rpc(sessionPath, rpcName, {});
          if (!currentVisit()) return;
          const titleMap: Record<string, string> = {
            get_session_stats: "Usage",
            get_state: "Context",
          };
          const title = titleMap[rpcName] ?? commandTitle;
          const isStatsOrContext =
            rpcName === "get_session_stats" || rpcName === "get_state";
          const result: CommandResult = {
            command: commandTitle,
            title,
            ok: true,
            data: rpcName === "get_session_stats"
              ? sessionUsageReport(data, selectSessionCost(store.getState())) : data,
            ...(isStatsOrContext ? { provenance: "live" as const } : {}),
          };
          if (commandTitle === "/usage") void showUsageResult(result);
          else setCommandResult(result);
          return;
        } catch (e) {
          if (changesSession && !currentNavigation()) return;
          // /usage, /stats and /context must never surface an ownership error — fall back to local derived stats.
          const rpcFallsBack =
            rpcName === "get_session_stats" || rpcName === "get_state";
          if (rpcFallsBack && isOwnershipError(e)) {
            if (!currentVisit()) return;
            const derived = deriveStats(messages);
            const stats = rpcName === "get_session_stats"
              ? sessionUsageReport(derived, selectSessionCost(store.getState())) : derived;
            const derivedTitle = rpcName === "get_state" ? "Context" : "Usage";
            const result: CommandResult = {
              command: commandTitle,
              title: derivedTitle,
              ok: true,
              data: stats,
              provenance: "derived",
            };
            if (commandTitle === "/usage") void showUsageResult(result);
            else setCommandResult(result);
            return;
          }
          setCommandResult({
            command: `/${effective.name.replace(/^\/+/, "")}`,
            title: `/${effective.name.replace(/^\/+/, "")}`,
            ok: false,
            message: humanizeDaemonError(e),
            recoveryError: e,
          });
          return;
        }
      }
      if (effective.shape === "prompt") {
        // No source gate: the RPC prompt path runs skills AND builtin slash
        // commands (rpc-mode tries tryRunRpcSkillCommand, then
        // executeAcpBuiltinSlashCommand). Refusing non-skills here bounced a
        // pile of working builtins to "Runs in the desktop TUI".
        if (!sessionPath) return;
        const promptText = `/${effective.name.replace(/^\/+/, "")}`;
        // A builtin prints into a sheet; only a skill is a message to the agent.
        if (effective.source === "builtin") {
          await runPrintingCommand(promptText);
          return;
        }
        try {
          // A picked skill is a message like a typed one: it honours Steer |
          // Queue mid-turn (without a delivery the daemon steered, so Queue
          // was ignored) and joins Up-recall once accepted.
          const receipt = await controller.sendPrompt(
            promptText,
            [],
            sessionPath,
            () => recordPromptHistory(promptText),
            deliveryForSend(agentWorking, sendMode, canQueue),
          );
          if (receipt?.state === "uncertain")
            showToast(UNCERTAIN_SEND_TOAST, "warn");
          else if (receipt && deliveryFailed(receipt))
            showErrorToast(receipt.error);
        } catch (e) {
          showErrorToast(e);
        }
        return;
      }
    },
    [sessionPath, controller, store, captureVisit, handleOpenPicker, messages, showUsageResult, compaction.run, agentWorking, sendMode, canQueue],
  );
  // The ⋯ menu and the composer's context ring open the same Usage surface as /usage.
  const openUsage = (): void => void handlePaletteRun(classifyCommand({ name: "usage", source: "builtin" }));

  const handleRunCommand = useCallback(
    (cmd: OmpCommand, subName?: string) => {
      // The inline slash palette lists top-level commands only and has no
      // subcommand UI, so a drill command arrives here with no subName and
      // handlePaletteRun returns immediately. Tapping /todo, /mcp, /memory,
      // /security, /marketplace, /ssh, /plugins and eight others did nothing at
      // all — no sheet, no toast, no feedback. Hand them to the full palette,
      // already drilled in, which is where the subcommand list lives.
      if (cmd.shape === "drill" && !subName) {
        openPalette(cmd);
        return;
      }
      void handlePaletteRun(cmd, subName);
    },
    [handlePaletteRun],
  );

  const handleInputSubmit = useCallback(
    async (text: string) => {
      if (!inputCmd) return;
      const trimmed = text.trim();
      // An empty submit is legitimate when every argument is optional — the
      // sheet only allows it in that case, and refusing here would silently
      // swallow /advisor dump and /todo done.
      if (!trimmed && requiresArgument(inputCmd.hint)) return;
      if (inputCmd.rpc) {
        if (!sessionPath) return;
        const rpcName = inputCmd.rpc;
        const commandTitle = `/${inputCmd.name.replace(/^\/+/, "")}`;
        try {
          const api = new DaemonApi(readPairingToken() ?? "");
          if (rpcName === "set_session_name") {
            await api.rpc(sessionPath, rpcName, { name: trimmed });
            // The header follows at once; the listing catches up on its own
            // refresh (and the transcript's title_change entry agrees).
            store.getState().setSessionTitle(sessionPath, trimmed);
            showToast(`Renamed to “${trimmed}”`, "success");
          } else {
            const data = await api.rpc(sessionPath, rpcName, { name: trimmed });
            setCommandResult({
              command: commandTitle,
              title: commandTitle,
              ok: true,
              data,
            });
          }
        } catch (e) {
          // Never the raw daemon text: an ownership refusal carries a pid and
          // a command line.
          setCommandResult({
            command: commandTitle,
            title: commandTitle,
            ok: false,
            message: humanizeDaemonError(e),
            recoveryError: e,
          });
        }
        return;
      }
      // Same as the prompt branch: builtins with a hint reach the model through
      // the RPC prompt path too, so there is no source to gate on. /review,
      // /handoff and /export used to collect your text and then refuse to send.
      if (!sessionPath) return;
      const full = `/${inputCmd.name.replace(/^\/+/, "")} ${trimmed}`.trim();
      // A builtin prints into a sheet; only a skill is a message to the agent.
      if (inputCmd.source === "builtin") {
        await runPrintingCommand(full);
        return;
      }
      try {
        // Same delivery and history as the prompt branch above.
        const receipt = await controller.sendPrompt(
          full,
          [],
          sessionPath,
          () => recordPromptHistory(full),
          deliveryForSend(agentWorking, sendMode, canQueue),
        );
        if (receipt?.state === "uncertain")
          showToast(UNCERTAIN_SEND_TOAST, "warn");
        else if (receipt && deliveryFailed(receipt))
          showErrorToast(receipt.error);
      } catch (e) {
        showErrorToast(e);
      }
    },
    [inputCmd, sessionPath, controller, store, agentWorking, sendMode, canQueue],
  );
  const handleRename = useCallback(() => {
    setInputCmd(classifyCommand({ name: "rename", source: "builtin", input: { hint: "New name" } }));
    setInputSub(null);
    setInputOpen(true);
  }, []);

  // The palette is mounted by App; this chat contributes its commands.
  const slashSource = useMemo(
    () => ({ commands, live, onRun: (cmd: OmpCommand, sub?: string) => void handlePaletteRun(cmd, sub) }),
    [commands, live, handlePaletteRun],
  );
  useProvideSlashCommands(slashSource);

  const liveTurn = useLiveTurn(controller);
  // The newest turn's footer is live while anything about it is reported in
  // flight: a running turn, a file-growth tail, a retry wait, a compaction.
  // Uncertain state (offline, a dead child) is never reported as working.
  const tailLive = !childDied && liveTurn !== null;
  const turnSummaries = useMemo(() => summarizeTurns(timeline), [timeline]);
  const appearance = useAppearance();
  const bubbles = appearance.messageStyle === "bubbles";
  const { turnModels, turnStarts, tailOpen, tailModel } = useMemo(() => turnHeads(timeline), [timeline]);
  // Every Tool calls mode folds each settled turn's work into its groups (the mode picks what a group holds);
  // the live turn keeps its groups inline, the newest one previewing.
  const foldLive = useLiveWhileSheetOpen(liveEdge);
  const { folded: workFolded, workHidden, steps: workSteps, worked: workedTurns } = useMemo(
    () => foldTurnWork(timeline, turnSummaries, foldLive, !hasCollab ? summary?.pendingAsk : undefined),
    [timeline, turnSummaries, foldLive, hasCollab, summary?.pendingAsk],
  );
  const longRuns = useMemo(() => longTurnRuns(timeline, SECTION_CALLS), [timeline]);
  // The newest turn's footer: inline after its last item, unless that turn
  // is still open. A user message after it means the open turn is a new one
  // with nothing to show yet.
  const { tailTurnIndex, tailIsUser } = useMemo(() => {
    let lastTurn = -1;
    for (const index of turnSummaries.keys()) lastTurn = Math.max(lastTurn, index);
    let lastUser = -1;
    timeline.forEach((item, index) => {
      if (item.kind === "message" && item.message.role === "user") lastUser = index;
    });
    return { tailTurnIndex: lastTurn > lastUser ? lastTurn : -1, tailIsUser: lastUser === timeline.length - 1 && lastUser >= 0 };
  }, [turnSummaries, timeline]);
  // Mid-flight with the state unknown (offline, child gone): the footer keeps
  // its actions but claims neither a duration nor a stop.
  // A child that died after its turn finished leaves that turn settled: only
  // a turn that was still open when it died loses its duration.
  const tailUnsettled = liveEdge || (childDied && liveTurn !== null);

  const messageCountForJump = messages.length + (streamingVisible ? 1 : 0);
  const fallback = sessionModel?.modelFallback;
  // Native events can precede their journal receipt. Keep their reason visible
  // until that exact durable entry is painted, without guessing an event identity.
  const fallbackNotice = fallback && !timeline.some(item => item.kind === "marker" && item.key === `marker:fallback:${fallback.entryId}`)
    ? { kind: "marker" as const, ...modelFallbackMarker(fallback, "live-model-fallback", fallback.at ?? 0) }
    : null;
  const chatEmpty = timeline.length === 0 && !fallbackNotice && messages.length === 0 && pendingSends.length === 0 && !streamingPresent && !isOpening;

  // durationShown: the turn's work groups already say how long it worked.
  const renderFooter = (summary: TurnSummary, settled: boolean, durationShown: boolean) => {
    const reply = summary.reply;
    const redoable = settled && !failedTurn && redoPlan?.replyId != null && reply?.id === redoPlan.replyId;
    return (
      <TurnFooter
        running={false}
        startedAt={settled ? summary.startedAt : undefined}
        endedAt={settled ? summary.endedAt : undefined}
        stopped={settled && summary.stopped}
        error={settled && summary.error}
        onCopy={reply ? () => copyText(reply.text) : undefined}
        speakText={reply?.text}
        onTryAgain={redoable ? tryAgain : undefined}
        onTryAnotherModel={redoable ? tryWithAnotherModel : undefined}
        tryAgainDisabled={redoPlan?.disabled}
        durationShown={durationShown}
        tokensPerSecond={settled && reply?.id === lastTextAssistantId ? turnTokenRate(messages) : null}
        menu={reply ? (
          // INVARIANT: assistant prose is entirely selectable text, so a
          // long-press never finds a blank point to open the sheet on once tool
          // cards collapse into a run. This button is the reliable way in.
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More actions"
            data-testid="message-more"
            className="text-muted-foreground"
            onClick={() => messageActions.open(reply)}
          >
            <MoreHorizontalIcon aria-hidden className="size-4" />
          </Button>
        ) : undefined}
      />
    );
  };

  // grouped: a run still in the flow (not folded into a settled group) draws as its own work group.
  const renderRun = (item: Pick<Extract<WorkItem, { kind: "run" }>, "messages" | "continued" | "reply">, expanded = false, sectioned = false, grouped = false) => (
    <WorkRun
      group={grouped ? (liveEdge && item.messages.at(-1)?.id === lastAssistantId ? "live" : "done") : undefined}
      messages={item.messages}
      sessionPath={sessionPath}
      toolsLive={liveEdge && item.messages.at(-1)?.id === lastAssistantId}
      latestThought={latestThoughtId !== null && item.messages.some((message) => message.id === latestThoughtId)}
      continued={item.continued}
      reply={item.reply}
      liveMessageId={lastAssistantId}
      pendingAsk={!hasCollab ? summary?.pendingAsk : undefined}
      onOtherQuestion={openQuestionSheet}
      onAnswerSent={refreshQuestions}
      defaultExpanded={expanded}
      sectioned={sectioned}
    />
  );
  // The turn-work sheet: every run open, edits as in the flow.
  const renderWork = (item: WorkItem, sectioned: boolean) => (item.kind === "edits" ? <EditSummary messages={item.messages} /> : renderRun(item, true, sectioned));

  // The composer's Send path for this conversation. Extracted so a plugin's
  // prompt takes the same route (slash-command routing, receipts, outbox).
  const sendFromComposer = async (
    text: string,
    images: { data: string; mimeType: string }[],
    target: string | null,
    onSaved: () => Promise<boolean> | void,
    delivery?: PromptDelivery,
    agentReference?: boolean,
    // A plugin's prompt: a message or a slash command only. It never takes
    // the Edit path (which rewinds a turn) and never runs a shell command.
    fromPlugin = false,
  ): Promise<void> => {
    // The TUI's leading shapes, decided against the live catalogue
    // (domain/composer-route.ts): a typed builtin prints into a sheet,
    // `!cmd` runs in the Terminal tab, `/btw` and `/goal` open theirs.
    // A draft carrying an agent reference is always a message.
    const route = routeComposerText(text, commands, images.length > 0, agentReference);
    // One rule for both plugin send routes (domain/composer-route.ts): a plugin
    // never runs a shell command or a builtin, and never opens a sheet or an app
    // screen on the person's phone.
    const pluginRefusal = fromPlugin ? pluginPromptRefusal(text, { kind: "open", commands }) : null;
    if (pluginRefusal !== null) throw new Error(pluginRefusal);
    if (route.kind === "side-question") {
      void onSaved();
      setBtwSeed({ question: route.question });
      return;
    }
    if (route.kind === "goal") {
      void onSaved();
      setGoalSeed({ objective: route.objective });
      return;
    }
    // `/plan` toggles; `/plan on` and `/plan off` are explicit. Never
    // text: omp's `/plan` is TUI-only and the model would read it.
    if (!agentReference && /^\/plan(?:\s|$)/i.test(text.trim()) && images.length === 0) {
      void onSaved();
      const arg = text.trim().replace(/^\/plan\b\s*/i, "").toLowerCase();
      if (arg === "" || arg === "on" || arg === "off") void togglePlanMode(arg === "" ? undefined : arg === "on");
      else showToast("Use /plan, /plan on or /plan off", "error");
      return;
    }
    if (route.kind === "native") {
      // Phone rows for omp's TUI-only commands run the phone's action;
      // arguments have nowhere to go, as in the palette.
      const native = commands.find((c) => c.native && c.name === route.name);
      void onSaved();
      if (native) void handlePaletteRun(native);
      return;
    }
    if (route.kind === "command") {
      void onSaved();
      const compact = route.name === "compact" ? commands.find((c) => c.name.toLowerCase() === "compact") : undefined;
      const focus = compact ? compactFocus(text, (compact.subcommands ?? []).map((s) => s.name)) : null;
      if (focus !== null) void compactNow(focus);
      else void runPrintingCommand(text);
      return;
    }
    if (route.kind === "shell") {
      const shellPath = target ?? sessionPath;
      if (!shellPath) return;
      const current = captureVisit();
      // Workspace pages stay lazy: a static import would parse every tool
      // at chat boot. A failed chunk load must leave this draft intact.
      await import("./tools");
      if (!current()) throw new Error("The conversation changed before the command started.");
      const accepted = requestTerminalRun({
        id: Date.now(), sessionPath: shellPath, command: route.command,
        excludeFromContext: route.excludeFromContext, isCurrent: current,
      });
      openWorkspace("terminal");
      try { await accepted; }
      catch (error) {
        if (current()) showErrorToast(error);
        throw error;
      }
      await onSaved();
      return;
    }
    // A pending Edit replaces its turn (rewind, then send); photos stay with the message.
    if (!fromPlugin && edit && (target ?? sessionPath) === edit.sessionPath) {
      const authed = readPairingToken() ?? "";
      const kept = await loadMessageImages(edit.prompt, (path) => fetch(path, { headers: authed ? { Authorization: `Bearer ${authed}` } : {} }));
      const branch = await redoTurn(new DaemonApi(authed), controller, {
        kind: redoKind(canWriteInPlace),
        entryId: edit.entryId,
        sessionPath: edit.sessionPath,
        text,
        images: [...kept, ...images],
        onSaved: () => { setEdit(null); return onSaved(); },
      });
      if (branch) showToast("Opened a branch with your edit");
      return;
    }
    await controller.sendPrompt(
      text,
      images,
      target ?? sessionPath,
      onSaved,
      delivery,
    );
  };
  // Plugins send through the identical path, with the composer's current
  // delivery mode and no draft to clear (the user's draft is left alone).
  const pluginSend = useRef({ send: sendFromComposer, delivery: undefined as PromptDelivery | undefined });
  pluginSend.current = { send: sendFromComposer, delivery: deliveryForSend(agentWorking, sendMode, canQueue) };
  useEffect(() => {
    if (!sessionPath) return;
    return setOpenChatSender(sessionPath, (text) => pluginSend.current.send(text, [], sessionPath, async () => true, pluginSend.current.delivery, false, true));
  }, [sessionPath]);
  // The open conversation, as the plugin host describes it; only a change in
  // what toPluginSession reads re-publishes it.
  const pluginSessionJson = useMemo(() => (summary ? JSON.stringify(toPluginSession(summary)) : null), [summary]);
  useEffect(() => {
    pluginHost.setOpenSession(pluginSessionJson ? JSON.parse(pluginSessionJson) : null);
  }, [pluginSessionJson]);
  useEffect(() => () => pluginHost.setOpenSession(null), []);

  return (
    <main
      className="relative flex h-[calc(100dvh-var(--kb,0px))] flex-col overflow-hidden bg-background outline-none"
      style={{ "--kb": `${inset}px` } as React.CSSProperties}
      ref={shellRef}
      tabIndex={-1}
    >
      {sessionPath && summary ? (
        <CloseOnLaptopDialog
          open={closeOnLaptopOpen}
          onOpenChange={setCloseOnLaptopOpen}
          sessionPath={sessionPath}
          title={sessionTitle(summary)}
          project={projectLabel(summary)}
          onClosed={() => {
            setClosedOnLaptop(sessionPath);
            setMovedToLaptop(null);
            void controller.loadSessions().catch(() => undefined);
            void controller.reloadHistory();
          }}
        />
      ) : null}

      {/* Turn end for a screen reader: the transcript updates silently
          otherwise. Visually hidden; only a running-to-idle edge fills it. */}
      <span role="status" aria-live="polite" data-testid="turn-announcement" className="sr-only">{turnAnnouncement}</span>
      <SessionPager
        sessionPath={sessionPath}
        controller={controller}
        // The header renders inside the pager, which owns the tracking and
        // panel reads: a badge or page change repaints the bar, not this whole
        // screen. Re-rendering the chat then raced its first pin to the bottom
        // and left the newest message 65px above the edge (verify-sync,
        // verify-switch-landing).
        header={(tracking) => (<>
      <SessionHeader
        store={store}
        sessionPath={sessionPath}
        summary={summary}
        connection={connection}
        controller={controller}
        onRename={handleRename}
        onOpenModelPicker={() => setModelPickerOpen(true)}
        onOpenSessionSettings={() => setSessionSettingsOpen(true)}
        onOpenOnComputer={onLaptop || isPhoneMode() ? undefined : () => void openOnLaptop()}
        openOnComputerDisabled={openingOnLaptop || agentWorking}
        onCloseOnComputer={onLaptop && summary ? () => setCloseOnLaptopOpen(true) : undefined}
        closeOnComputerDisabled={agentWorking}
        onReload={() => void controller.reloadHistory()}
        modelLabel={(() => {
          // The held state names the model first; the listing row covers a cold open.
          const model = sessionModel?.model ?? (typeof summary?.model === "string" ? summary.model : null);
          return model ? modelChipLabel(model, sessionModel?.thinkingLevel) : "";
        })()}
        // The held transcript gives the freshest figure; the listing row
        // covers a view whose newest page carries no assistant turn.
        contextPercent={contextPercent ?? (summary ? getCtxPercent(summary) : null)}
        contextTokens={contextTokens?.used ?? (summary ? rowUsage(summary)?.usedTokens : undefined)}
        contextWindow={contextTokens?.window ?? (summary ? rowUsage(summary)?.windowTokens : undefined)}
        cost={sessionCost}
        onOpenUsage={openUsage}
        tracking={tracking}
        onOpenWorkspace={() => openWorkspace()}
        onNewChat={() => openNewSession(cwd)}
        project={cwd ? projectName(cwd) : null}
      >
      <GoalChip store={store} onOpen={() => setGoalSeed({ objective: "" })} />
      <PlanChip store={store} onOpen={() => setSessionSettingsOpen(true)} />
      </SessionHeader>
        </>)}
      >
      <TranscriptActionsContext.Provider value={transcriptActions}>
      <Conversation
        key={sessionPath ?? "none"}
        className="relative min-h-0 flex-1"
      >
        {/* Floating notices: the chat's error, then the ONE offline
            indicator, stacked over the top of the transcript instead of
            pushing it down. In flow, an error arriving after a chat opened
            shrank the scroller mid-pin and left the newest message 64px above
            the edge (verify-switch-landing). The error steps aside while the
            slash palette is open, so at 150% text the palette, the field and
            its send button all stay on screen. The header and the turn footer
            stay quiet about connection state. */}
          <InNoticeSlot>
          <HiddenUnderPanels>
          <div className="pointer-events-none flex w-full flex-col items-center gap-2 empty:hidden">
            {visibleErrorText && !slashOpen ? (
              <div className="pointer-events-auto w-full rounded-xl shadow-[var(--shadow-float)] motion-safe:animate-[fade-in_var(--dur-slow)_var(--ease-smooth)]">
                <Notice
                  tone="danger"
                  testId="chat-error"
                  // Setup and access failures need their exact destination, not a
                  // history reload that cannot repair credentials or select a model.
                  action={errorRecoveryAction(visibleError, () => setModelPickerOpen(true)) ?? {
                    label: "Reload",
                    onClick: () => {
                      setDismissedError(visibleError);
                      void controller.reloadHistory();
                    },
                  }}
                  onDismiss={() => setDismissedError(visibleError)}
                >
                  {visibleErrorText}
                </Notice>
              </div>
            ) : null}
            {exporting ? (
              <div className="pointer-events-auto w-full rounded-xl shadow-[var(--shadow-float)]">
                <Notice tone="info" testId="chat-exporting">Preparing export…</Notice>
              </div>
            ) : null}
              <ConnectionPill
                indicator={link}
                staleHistory={staleHistory !== null}
                onRetry={() => void controller.reloadHistory()}
              />
          </div>
          </HiddenUnderPanels>
          </InNoticeSlot>
        <TranscriptContent
          // The transcript is the app's output surface: without a live region a
          // screen reader never hears the agent reply. `polite` so it does not
          // interrupt, `aria-busy` while a turn is still streaming.
          aria-busy={liveEdge}
          aria-live="polite"
          // No gap: each item carries its own top margin (parts/spacing.ts).
          // Bottom clearance for the jump-to-latest button comes and goes with
          // the button (TranscriptContent).
          className={cn(
            // Clears the floating header pills (SessionHeader): 56px row + safe area.
            "mx-auto flex w-full max-w-[48rem] flex-col justify-start pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[calc(env(safe-area-inset-top)+4.5rem)]",
            // An empty chat centres its hero in the whole transcript area.
            chatEmpty && "min-h-full",
          )}
          // Both pan axes: a sideways swipe on the transcript pages to the
          // next tab (SessionPager); pan-y alone pinned it to the chat.
          scrollClassName={cn("chat-scroll no-scrollbar [touch-action:pan-x_pan-y]", !revealed && "opacity-0")}
        >
          {chatEmpty ? (
            <EmptyChatHero
              project={summary?.cwd ? projectLabel(summary) : null}
              onPick={(text) => {
                const problem = sessionPath ? editPlacementProblem(composerDraftActions.current, sessionPath, text) : "Open the conversation first.";
                if (problem) showToast(problem, "error");
              }}
            />
          ) : (
            <>
              {trimmedTop > 0 && !evictedTop ? (
                <p className="mx-auto max-w-[30ch] text-balance py-2 text-center text-meta text-muted-foreground">
                  {`${trimmedTop} oldest message${trimmedTop === 1 ? "" : "s"} trimmed to save memory`}
                </p>
              ) : null}
              {/* Earlier history loads by itself as the reader approaches the top,
                  including a span dropped to save memory: nothing to press. */}
              <LoadEarlier
                hasEarlier={historyCursor !== null || evictedTop !== null}
                paused={unreachable}
                loading={loadingEarlier}
                messageCount={messages.length}
                onLoadEarlier={() => (evictedTop ? controller.reloadEvictedTop() : controller.loadEarlier())}
              />
              {timeline.map((item, index) => {
                const gap = { marginTop: scaledGap(transcriptGap(index > 0 ? timeline[index - 1]! : null, item)) };
                const summaryForTurn = turnSummaries.get(index);
                const footer = summaryForTurn && !(tailLive && index === tailTurnIndex) ? (
                  <div key={`footer:${index}`} style={{ marginTop: scaledGap(TURN_FOOTER_GAP) }}>
                    {renderFooter(summaryForTurn, !(index === tailTurnIndex && tailUnsettled), workedTurns.has(index))}
                  </div>
                ) : null;
                const turnModel = turnModels.get(index);
                const head = bubbles
                  ? (turnStarts.has(index) ? <SenderLine model={turnStarts.get(index)} /> : null)
                  : turnModel ? <TurnModel model={turnModel} /> : null;
                const stepsHere = workSteps.get(index);
                // A group after a message's text sits below it; a run's group stands in the run's place.
                const steps = stepsHere ? (
                  <div className={cn(item.kind === "message" && "mt-2", bubbles && AGENT_THREAD)}>
                    <TurnWorkChip work={stepsHere} render={renderWork} sessionPath={sessionPath} />
                  </div>
                ) : null;
                const row = item.kind === "message" ? (
                  // A flex column: the user bubble aligns itself to the end.
                  <div key={item.message.id} className="flex flex-col" style={gap} data-user-turn={item.message.role === "user" ? "" : undefined}>
                    {head}
                    <ChatMessageRow
                      animate={arrivingIds.has(item.message.id)}
                      bindings={messageActions.bind(item.message)}
                      message={item.message}
                      sessionPath={sessionPath}
                      rowStatus={userRowStatus.get(item.message.id)}
                      localPendingEntry={pendingPresentation.localEntries.get(item.message)}
                      onOpenPath={handleOpenTranscriptPath}
                      toolsLive={liveEdge && item.message.id === lastAssistantId}
                      finalReply={item.message.role === "assistant" && item.message.id === lastTextAssistantId}
                      latestThought={item.message.id === latestThoughtId}
                      hideWork={workHidden.has(index)}
                      onRetry={item.message.id === failedTurn?.failedId ? handleRetry : undefined}
                      retryDisabled={item.message.id === failedTurn?.failedId && (liveEdge || !sendAllowed)}
                    />
                    {steps}
                    {userRowStatus.get(item.message.id)?.refused ? (
                      <div className="mt-4">
                        <RefusalNote text={userRowStatus.get(item.message.id)!.refused!.text} />
                      </div>
                    ) : null}
                  </div>
                ) : item.kind === "run" ? (
                  workFolded.has(index) ? (
                    // Summary mode: the run's work lives in its stretch's group, drawn here when the stretch starts here.
                    steps ? <div key={item.key} data-testid="chat-message" className="min-w-0" style={gap}>{head}{steps}</div> : null
                  ) : (
                  <div key={item.key} data-testid="chat-message" className="min-w-0" style={gap}>
                    {head}
                    <div className={bubbles ? AGENT_THREAD : undefined}>
                    {item.key === liveRunKey ? (
                      <LiveRunSummary
                        store={store}
                        messages={item.messages}
                        sessionPath={sessionPath}
                        liveMessageId={lastAssistantId}
                        pendingAsk={!hasCollab ? summary?.pendingAsk : undefined}
                        onOtherQuestion={openQuestionSheet}
                        onAnswerSent={refreshQuestions}
                        sectioned={longRuns.has(item.key)}
                      />
                    ) : renderRun(item, false, longRuns.has(item.key), true)}
                    </div>
                  </div>
                  )
                ) : item.kind === "edits" ? (
                  workFolded.has(index) ? (
                    steps ? <div key={item.key} style={gap}>{head}{steps}</div> : null
                  ) : liveEdge && item.messages.at(-1)?.id === lastAssistantId ? null : (
                    <div key={item.key} style={gap}>
                      {head}
                      <EditSummary messages={item.messages} />
                    </div>
                  )
                ) : item.kind === "retry" ? (
                  <div key={item.key} style={gap}>
                    <RetryNotice
                      messages={item.messages}
                      recovered={item.recovered}
                      live={autoRetry && item.messages.at(-1)?.id === lastAssistantId ? autoRetry : null}
                      onCancel={retryCancellable ? cancelRetry : undefined}
                    />
                  </div>
                ) : item.kind === "marker" && item.icon === "model" && !item.detail && turnModels.has(index + 1) ? (
                  // Only a generic switch duplicates the turn's model label; fallback explanations must remain readable.
                  null
                ) : (
                  <div key={item.key} style={gap}>
                    <TranscriptMarkers item={item} />
                  </div>
                );
                // A keyed Fragment, not `footer ? [row, footer] : row`: the footer
                // appearing when a turn settles swapped the row between a keyed
                // child and an index-keyed array, remounting the reply that had
                // just finished streaming (reparse, a one-frame height jump).
                return <Fragment key={item.kind === "message" ? item.message.id : item.key}>{row}{footer}</Fragment>;
              })}
              {/* The mirror of LoadEarlier: a window that dropped its newest rows
                  reads them back by cursor as the reader nears the end. */}
              <LoadLater
                hasLater={evictedBottomAfter !== null}
                cursor={evictedBottomAfter}
                paused={unreachable}
                onLoadLater={() => controller.advanceToLive()}
              />
              {fallbackNotice ? (
                <div className="mt-4" role="status">
                  <TranscriptMarkers item={fallbackNotice} />
                </div>
              ) : null}

              {streamingVisible ? (
                // The reply opens under its prompt, or joins its own turn.
                <div style={{ marginTop: scaledGap(tailIsUser ? 16 : 4) }}>
                  <StreamingMessage
                    store={store}
                    sessionPath={sessionPath}
                    onOpenPath={handleOpenTranscriptPath}
                    runHosted={liveRunKey !== null}
                    opensTurn={tailOpen}
                    previousModel={tailModel}
                    pendingAsk={!hasCollab ? summary?.pendingAsk : undefined}
                    onOtherQuestion={openQuestionSheet}
                    onAnswerSent={refreshQuestions}
                  />
                </div>
              ) : null}

              {isOpening && !agentWorking ? (
                <div className="mt-4">
                  <ThinkingLine label="Opening session…" />
                </div>
              ) : null}

              {provisional && !streamingPresent ? (
                <div style={{ marginTop: scaledGap(tailIsUser ? 16 : 12) }}>
                  <PartialLine text={provisional} />
                </div>
              ) : null}

              {tailLive && liveTurn ? (
                // The live turn's footer closes the transcript: the step being
                // run and the clock sit where the eye already waits.
                <div style={{ marginTop: scaledGap(tailIsUser && !streamingVisible && !provisional ? 16 : TURN_FOOTER_GAP) }}>
                  <TurnFooter
                    running
                    startedAt={liveTurn.startedAt}
                    currentStep={liveTurn.currentStep}
                    // The live work group's title is the one voice for the step (DeepSeek has no
                    // second status line); a retry's wait and its Cancel still speak here.
                    stepShown={liveTurn.state === "running"}
                    action={liveTurn.action}
                    activityAt={liveTurn.activityAt}
                  />
                </div>
              ) : null}
            </>
          )}
          {/* After the rows, inside the transcript: the send scroll (chat/SendAnchor.tsx). */}
          <SendAnchor
            sentId={tailEchoId}
          />
        </TranscriptContent>
        <StreamFollow store={store} />
        <OpenReveal
          rowsReady={!isOpening}
          revealed={revealed}
          onReveal={revealNow}
        />
        <ViewportBridge target={viewportRef} />
        <ThumbNav
          controller={controller}
          messageCount={messageCountForJump}
          hidden={
            isOpening ||
            messages.length === 0 ||
            hasCollab ||
            collabOpen ||
            answerOpen ||
            paletteOpen ||
            inputOpen ||
            commandResult !== null ||
            modelPickerOpen ||
            transcriptViewerOpen ||
            sessionSettingsOpen ||
            slashOpen
          }
        />
      </Conversation>
      </TranscriptActionsContext.Provider>

      {messageActions.sheet}

      {/* pan-y: a sideways drag in the composer edits text, never pages. */}
      <div className="shrink-0 touch-pan-y">
      <Composer
        draftActionsRef={composerDraftActions}
        extensionDraft={extensionFeedback.editorDraft}
        onConsumeExtensionDraft={(id) => { if (sessionPath) controller.consumeEditorDraft(sessionPath, id); }}
        controller={controller}
        pendingSends={pendingSends}
        busy={agentWorking}
        sendAllowed={sendAllowed}
        stopAllowed={stopAllowed}
        commands={commands}
        canQueue={canQueue}
        canInterrupt={canInterrupt}
        onOpenModelPicker={() => setModelPickerOpen(true)}
        onModelChanged={() => void controller.reloadHistory()}
        // A turn a kill cut off, a waiting question and extension notices sit
        // on the composer, where the eye already is, and float with it.
        above={<>
          <NotificationNudge store={store} />
          {edit ? (
            <div role="status" data-testid="edit-chip" className="mx-3 mb-1 flex shrink-0 items-center gap-2 rounded-xl bg-surface-1 py-1 pl-4 pr-1 text-meta text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">Editing message{edit.prompt.parts.some((part) => part.kind === "image") ? " · photos kept" : ""}</span>
              <button type="button" aria-label="Cancel edit" data-testid="edit-chip-cancel" onClick={() => { composerDraftActions.current?.cancelEdit(edit.sessionPath); setEdit(null); }} className="relative flex size-8 shrink-0 items-center justify-center rounded-full after:absolute after:-inset-1.5 after:content-[''] active:bg-surface-3">
                <XIcon aria-hidden className="size-4" />
              </button>
            </div>
          ) : null}
          {interruption && !agentWorking ? (
            <InterruptedBanner
              interruption={interruption}
              canSend={sendAllowed}
              onContinue={continueInterrupted}
              onDismiss={dismissInterrupted}
            />
          ) : null}
          {!agentWorking && backgroundWork ? (
            <div role="status" data-testid="background-work" data-state={backgroundWork} className="mx-3 mb-1 shrink-0 rounded-xl bg-surface-1 px-4 py-1 text-meta text-muted-foreground">
              {backgroundWork === "pending"
                ? "Background work is pending. This conversation may resume."
                : "Background work was pending. Its current status is unconfirmed."}
            </div>
          ) : null}
          <TrackStrip
            sessionPath={sessionPath}
            question={
              hasCollab || laptopAsk
                ? {
                    held: hasHeld,
                    onOpen: () => {
                      // A question asked on your computer has no in-chat sheet;
                      // the answer sheet is the one surface that can reply to it.
                      if (!hasCollab) setAnswerOpen(true);
                      else window.dispatchEvent(new CustomEvent("collab:show"));
                    },
                  }
                : hasHeld ? { held: true } : null
            }
            compact={
              compaction.phase || compactOffer ? (
                <CompactPill
                  phase={compaction.phase}
                  offer={compactOffer}
                  onCompact={() => void compaction.run().catch((e: unknown) => showErrorToast(e))}
                />
              ) : null
            }
          />

          <ExtensionFeedback feedback={extensionFeedback} placement="aboveEditor" />
        </>}
        store={store}
        fallbackModel={typeof summary?.model === "string" ? summary.model : null}
        contextPercent={contextPercent ?? (summary ? getCtxPercent(summary) : null)}
        onOpenUsage={openUsage}
        onPrewarm={() => void controller.prewarm()}
        // Forward the composer's tap-time session: the POST/abort must hit the
        // conversation the user was looking at, not whatever is active when the
        // async body runs (identical titles hide a mid-flight switch).
        onSend={sendFromComposer}
        onStop={runStop}
        sessionPath={sessionPath}
        onRunCommand={handleRunCommand}
        onOpenPicker={handleOpenPicker}
        sendMode={sendMode}
        stopping={stopping}
        sendBlockedReason={sendBlockedMessage}
        onSendModeChange={(mode) => store.getState().setSendMode(mode)}
        onSlashOpenChange={setSlashOpen}
      />
      </div>
      <ExtensionFeedback feedback={extensionFeedback} placement="belowEditor" />
      </SessionPager>

      <ConfirmDialog
        open={planAskPath !== null && planAskPath === sessionPath}
        onOpenChange={(open) => { if (!open) setPlanAskPath(null); }}
        title="Plan mode"
        description="The phone hasn't read far enough back in this conversation to know whether plan mode is on."
        actions={
          <>
            <button type="button" className={ALERT_PRIMARY} data-testid="plan-ask-on" onClick={() => { setPlanAskPath(null); void togglePlanMode(true); }}>
              Turn plan mode on
            </button>
            <button type="button" className={ALERT_CANCEL} data-testid="plan-ask-off" onClick={() => { setPlanAskPath(null); void togglePlanMode(false); }}>
              Turn plan mode off
            </button>
            <button type="button" className={ALERT_CANCEL} onClick={() => setPlanAskPath(null)}>
              Cancel
            </button>
          </>
        }
      />
      <LazyMount open={transcriptViewerOpen} onClose={() => setTranscriptViewerOpen(false)}>
        <LazyFileViewer
          open={transcriptViewerOpen}
          onOpenChange={setTranscriptViewerOpen}
          path={transcriptViewerPath}
          sessionPath={sessionPath}
        />
      </LazyMount>
      <CollabDialog controller={controller} onPendingChange={setHasCollab} />
      <ExtensionDialogSheet controller={controller} onPendingChange={setHasExtensionDialog} />
      <LazyMount open={inputOpen} onClose={() => setInputOpen(false)}>
        <LazyCommandInputSheet
          open={inputOpen}
          onOpenChange={setInputOpen}
          command={inputCmd}
          subcommand={inputSub}
          // Rename starts from the current title so a small fix is one edit, not a retype.
          initialValue={inputCmd?.name === "rename" && !inputSub && summary ? sessionTitle(summary) : undefined}
          onSubmit={handleInputSubmit}
        />
      </LazyMount>
      <LazyMount open={modelPickerOpen} onClose={() => setModelPickerOpen(false)}>
        <LazyModelPicker
          sessionModelHint={pickerModelHint}
          onStateChanged={store.getState().setSessionModel}
          open={modelPickerOpen}
          onOpenChange={(open) => {
            // Dismissing the picker abandons a pending "try with another model".
            if (!open) redoAfterModel.current = false;
            setModelPickerOpen(open);
          }}
          sessionPath={sessionPath}
          currentModelHint={
            typeof summary?.model === "string" ? summary.model : null
          }
          onChanged={() => {
            if (!redoAfterModel.current) {
              void controller.reloadHistory();
              return;
            }
            // The redo reloads the branch itself, so it replaces the plain reload.
            redoAfterModel.current = false;
            setModelPickerOpen(false);
            void tryAgain();
          }}
        />
      </LazyMount>
      <LazyMount open={sessionSettingsOpen} onClose={() => setSessionSettingsOpen(false)}>
        <LazySessionSettingsSheet
          onStateChanged={store.getState().setSessionModel}
          onNeedCollab={() => {
            setSessionSettingsOpen(false);
            setCollabOpen(true);
          }}
          onOpenChange={setSessionSettingsOpen}
          open={sessionSettingsOpen}
          sessionPath={sessionPath}
          project={summary ? projectLabel(summary) : null}
          planMode={planOn}
          onSetPlanMode={setPlanMode}
          onOpenModelPicker={() => {
            setSessionSettingsOpen(false);
            setModelPickerOpen(true);
          }}
        />
      </LazyMount>
      <LazyMount open={collabOpen} onClose={() => setCollabOpen(false)}>
        <LazyCollabConnectSheet
          onOpenChange={setCollabOpen}
          open={collabOpen}
          sessionPath={sessionPath}
        />
      </LazyMount>
      <LazyMount open={commandResult !== null} onClose={() => setCommandResult(null)}>
        <LazyCommandResultSheet
          result={commandResult}
          onOpenChange={(v) => {
            if (!v) setCommandResult(null);
          }}
          // Only Usage has provider limits to re-ask; its pending state replaces the failed one.
          onRetryLimits={commandResult?.command === "/usage" ? () => void showUsageResult(commandResult) : undefined}
        />
      </LazyMount>
      <LazyMount open={answerOpen} onClose={() => setAnswerOpen(false)}>
        <LazyAnswerSheet
          session={summary}
          open={answerOpen}
          onOpenChange={setAnswerOpen}
          onSent={refreshQuestions}
          onOpenSession={() => {
            setAnswerOpen(false);
            window.dispatchEvent(new CustomEvent("collab:show"));
          }}
        />
      </LazyMount>
      <LazyMount open={btwSeed !== null} onClose={() => setBtwSeed(null)}>
        <LazyBtwSheet
          open={btwSeed !== null}
          onOpenChange={(v) => {
            if (!v) setBtwSeed(null);
          }}
          seed={btwSeed}
          sessionPath={sessionPath}
          controller={controller}
        />
      </LazyMount>
      <LazyMount open={goalSeed !== null} onClose={() => setGoalSeed(null)}>
        <LazyGoalSheet
          open={goalSeed !== null}
          onOpenChange={(v) => {
            if (!v) setGoalSeed(null);
          }}
          controller={controller}
          seed={goalSeed?.objective ?? ""}
        />
      </LazyMount>
    </main>
  );
});
