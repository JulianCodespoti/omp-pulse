"use client";

import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";

import { useAppearance } from "@/platform/appearance";

import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { showErrorToast, showToast } from "@/app/Notices";
import { UNCERTAIN_SEND_TOAST } from "@/app/send-copy";
import { Notice } from "@/app/ui/Notice";
import { daemonErrorCause, humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import type { QueuedPrompt } from "@/runtime/offline-queue";
import { isPendingIntent } from "@/runtime/browser-pending-presentation";
import type { UiMessage } from "@/domain/messages";
import { turnStoppedByUser } from "@/domain/failed-turn";
import { classifyTurnError, providerErrorSummary, type TurnErrorView } from "@/domain/turn-errors";
import { localPendingActions, pendingIntentActions } from "@/runtime/browser-pending-actions";
import type { CommandReceipt } from "@/runtime/api-types";
import type { UserRowStatus } from "@/runtime/user-row-status";
import { deliveryFailed } from "@/runtime/receipt-outcome";
import { usePromptKeywords } from "@/runtime/prompt-config";
import type { MagicKeyword } from "@/domain/magic-keywords";
import { MagicKeywordProvider } from "./MagicKeywordText";
import { SessionResources } from "./SessionResources";

import { ImagePart } from "./ImagePart";
import { AgentBubble } from "./Bubble";
import { AGENT_THREAD, PROSE } from "./prose";
import { editFailedSend, QueuedMessage } from "./QueuedMessage";
import { Thought } from "./Thought";
import { SwitchModelButton, TranscriptActionsContext } from "./TurnNotices";
import { ToolPart } from "./ToolPart";
import { WorkRail } from "./WorkRail";
import { hasShownWork, RunGroup } from "../chat/TurnWorkChip";
import type { PluginRenderContext } from "@/domain/plugins";
import { PluginBackButton, PluginCard, usePluginClaims } from "../plugins/PluginCard";
import { usePluginKey } from "../plugins/use-plugin-host";
import { RunSummary } from "./RunSummary";


// Keep the existing 15k markdown budget: truncating at the visual collapse
// threshold would break a single long diff. Historical previews still bound
// parsed text (500 turns × 15k = 7.5 MB, not 500 × 60k); the six-line crop is
// CSS only, leaving normal replies selectable and full-reply copy untouched.
const CLAMP = 15000;
const REPLY_COLLAPSE = 1500;

function truncateOnLineBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const nl = slice.lastIndexOf("\n");
  // Only snap to newline if it retains ≥60% of the budget — otherwise a
  // single 12k line (e.g. minified JSON) would collapse to empty.
  if (nl > limit * 0.6) return slice.slice(0, nl);
  return slice;
}

function ClampedTextPart({
  text,
  isStreaming,
  collapseReply,
  keepOpen,
  eagerMarkdown,
  finalReply,
  userClamp,
  onOpenPath,
  keywords,
}: {
  text: string;
  isStreaming?: boolean;
  collapseReply?: boolean;
  keepOpen?: boolean;
  eagerMarkdown?: boolean;
  /** The newest reply in the conversation: always shown in full. */
  finalReply?: boolean;
  /**
   * A user message: past eight lines it folds to eight behind a chevron, whatever
   * Long replies says, because a pasted log or diff would otherwise push the
   * conversation off screen. Measured, not guessed from the text: wrapped lines count.
   */
  userClamp?: boolean;
  onOpenPath?: (path: string) => void;
  keywords?: readonly MagicKeyword[] | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const preview = useAppearance().longReplies === "preview" && collapseReply;
  // A user text over the markdown budget is certainly over eight lines, so it
  // folds (and truncates) on first paint instead of parsing 15k+ unclipped.
  const needsClamp = userClamp ? overflows || text.length > CLAMP : text.length > (preview ? REPLY_COLLAPSE : CLAMP);
  // A live reply must never disappear behind a preview, including the newest
  // settled text while tools continue working in its turn. The final reply of
  // the conversation is the answer being read, so it is never previewed;
  // only earlier replies fold away to keep the transcript scannable.
  const canCollapse = userClamp ? needsClamp : needsClamp && !isStreaming && !keepOpen && !finalReply;
  const collapsed = canCollapse && !expanded;
  const display = useMemo(
    () => collapsed && text.length > CLAMP
      ? truncateOnLineBoundary(text, CLAMP)
      : text,
    [collapsed, text],
  );

  // Only a folded user message can be over its eight lines, so unfolding ends
  // measuring. Width and late markdown both change the height: watch the box
  // and its content, since the box alone stops resizing once it is at the cap.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!userClamp || expanded || !body) return;
    const measure = () => setOverflows(body.scrollHeight > body.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    if (body.firstElementChild) observer.observe(body.firstElementChild);
    return () => observer.disconnect();
  }, [userClamp, expanded, display]);

  // A user message is always cropped until opened (the crop is what is measured);
  // a reply only when it is folded into a preview.
  const cropped = userClamp ? !expanded : collapsed && preview;

  return (
    <div
      className={cn("min-w-0 max-w-full", collapseReply && "assistant-code-reader")}
      data-testid="reply-text"
    >
      <div
        ref={bodyRef}
        className={cn(
          cropped && "overflow-hidden",
          // What the user typed keeps its line breaks: markdown joins single newlines into one
          // paragraph, which turned every pasted log or list into a wall of text.
          userClamp && "[&_p]:whitespace-pre-line",
          // Eight lines at the body line height; replies keep their 6.4-line peek.
          cropped && (userClamp ? "max-h-[8lh]" : "max-h-[9.6em]"),
          collapsed && (userClamp || preview) && "[mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]",
        )}
        // Keyboard navigation must reveal links/chips below the visual crop.
        onFocusCapture={() => { if (collapsed) setExpanded(true); }}
      >
        <MagicKeywordProvider text={display} keywords={keywords ?? null}>
        <MessageResponse
          isAnimating={!!isStreaming}
          readableTables={collapseReply}
          onOpenPath={onOpenPath}
          progressive={(expanded || finalReply) && text.length > 16000}
          eager={eagerMarkdown}
        >
          {display}
        </MessageResponse>
        </MagicKeywordProvider>
      </div>
      {canCollapse && userClamp ? (
        <button
          // 24px of chevron inside the bubble; the pseudo-element makes the 44px target.
          className="relative mx-auto mt-1 flex h-6 w-11 items-center justify-center rounded-full text-muted-foreground outline-none after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Show less" : "Show full message"}
          data-testid="reply-expand"
          type="button"
        >
          <ChevronDownIcon aria-hidden className={cn("size-5 transition-transform duration-[var(--dur-base)] motion-reduce:transition-none", expanded && "rotate-180")} />
        </button>
      ) : canCollapse ? (
        <button
          // Link-sized ink, but an actual 44px target, not a filled control.
          className="inline-flex min-h-11 items-center py-2 text-ui text-primary-text hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid="reply-expand"
          type="button"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      ) : null}
    </div>
  );
}

export function MessageParts(props: Parameters<typeof MessagePartsContent>[0]) {
  const content = <SessionResources sessionPath={props.sessionPath}>
    <MessagePartsContent {...props} />
  </SessionResources>;
  // Only extension messages pay for the plugin lookup; every other message is drawn exactly as before.
  return props.message.customType !== undefined
    ? <CustomMessageCard message={props.message}>{content}</CustomMessageCard>
    : content;
}

/** An extension message a transcript plugin claims: its card replaces the stock body until "Show original". */
function CustomMessageCard({ message, children }: { message: UiMessage; children: ReactNode }) {
  const claimed = usePluginClaims("transcript.message", message.customType ?? null);
  const [original, setOriginal] = useState(false);
  const pluginContext = useMemo<PluginRenderContext | null>(
    () => claimed && message.customType !== undefined
      ? { session: null, message: { id: message.id, customType: message.customType, text: message.text, details: message.customDetails, truncated: false } }
      : null,
    [claimed, message.id, message.customType, message.text, message.customDetails],
  );
  const { views, onAction } = usePluginKey("transcript.message", claimed ? message.id : null, pluginContext);
  const entry = claimed ? views[0] : undefined;
  if (!entry) return <>{children}</>;
  if (original) {
    return (
      <>
        {children}
        <PluginBackButton pluginName={entry.pluginName} onClick={() => setOriginal(false)} className="self-start" />
      </>
    );
  }
  return (
    <PluginCard
      pluginName={entry.pluginName}
      view={entry.view}
      onAction={(action, item) => onAction(entry.pluginId, action, item)}
      testId="plugin-message-card"
      dataAttrs={{ "data-plugin": entry.pluginId, "data-message": message.id }}
      onShowOriginal={() => setOriginal(true)}
    />
  );
}

function MessagePartsContent({
  message,
  isStreaming,
  toolsLive,
  latestThought,
  finalReply,
  toolResultUnknown,
  sessionPath,
  rowStatus,
  localPendingEntry,
  onOpenPath,
  onRetry,
  retryDisabled,
  hideWork,
}: {
  message: UiMessage;
  isStreaming?: boolean;
  /**
   * The turn this message belongs to is still in flight, so a tool without a
   * result may genuinely be running. False for every settled message.
   */
  toolsLive?: boolean;
  /** This is the newest assistant message with text: its reply is never collapsed. */
  finalReply?: boolean;
  /** The message holds the newest thought (Thinking → "latest"): its last thought opens. */
  latestThought?: boolean;
  /** A passive transcript cannot prove that a missing tool result means interruption. */
  toolResultUnknown?: boolean;
  sessionPath?: string | null;
  /** Outbox entries bound to this user row (see bindUserRowStatus). */
  rowStatus?: UserRowStatus;
  /** Projection supplies proven current local ownership only. */
  localPendingEntry?: QueuedPrompt;
  onOpenPath?: (path: string) => void;
  /** Offered only on the newest failed turn; re-sends the prompt that started it. */
  onRetry?: () => void;
  /** A turn is running (or sending is not allowed): Retry shows but waits. */
  retryDisabled?: boolean;
  /** Summary mode: thoughts and tool calls are shown by the turn's "Worked for" chip instead. */
  hideWork?: boolean;
}) {
  const transcriptActions = useContext(TranscriptActionsContext);
  const { thinking, messageStyle, toolCalls } = useAppearance();
  const bubbles = message.role === "assistant" && messageStyle === "bubbles";
  const workWrap = cn("not-prose", bubbles ? cn(AGENT_THREAD, "py-1") : "my-1");
  const lastThinkingIndex = message.parts.findLastIndex((part) => part.kind === "thinking");
  const keywords = usePromptKeywords(message.role === "user" ? sessionPath : null);
  let toolCount = 0;
  for (let i = 0; i < message.parts.length; i++) {
    if (message.parts[i]?.kind === "tool") toolCount++;
  }
  const soleCall = toolCount === 1;
  // Each unbroken stretch of thoughts and calls is one work group, drawn where it starts; its parts render
  // nothing on their own. Every Tool calls mode groups: the mode picks the body (the rail, or tool rows).
  const railGroups = useMemo(() => {
    if (hideWork || message.role !== "assistant") return null;
    const groups = new Map<number, UiMessage>();
    let start = -1;
    let parts: UiMessage["parts"] = [];
    const flush = (): void => {
      if (start >= 0 && parts.length) groups.set(start, { ...message, parts, text: "", errorMessage: undefined });
      start = -1;
      parts = [];
    };
    message.parts.forEach((part, idx) => {
      if (part.kind !== "thinking" && part.kind !== "tool") { flush(); return; }
      if (start < 0) start = idx;
      parts.push(part.kind === "tool" && part.startedAt === undefined && message.createdAt && soleCall ? { ...part, startedAt: message.createdAt.getTime() } : part);
    });
    flush();
    return groups;
  }, [hideWork, message, soleCall]);

  const handleCancelQueued = useCallback(async (cancel: () => Promise<unknown>) => {
    try {
      await cancel();
    } catch (error) {
      showToast(`Couldn't remove the message. ${humanizeDaemonError(error)}`, "error", errorRecoveryAction(error));
    }
  }, []);

  const handleRetryQueued = useCallback(
    async (retry: () => Promise<CommandReceipt | null>, checking = false) => {
      try {
        const receipt = await retry();
        if (!receipt) return;
        if (receipt.state === "uncertain") {
          showToast(UNCERTAIN_SEND_TOAST, "warn");
        } else if (deliveryFailed(receipt)) {
          showErrorToast(receipt.error);
        }
      } catch (error) {
        showToast(`${checking ? "Couldn't check." : "Couldn't send."} ${humanizeDaemonError(error)}`, "error", errorRecoveryAction(error));
      }
    },
    [],
  );
  // A failed message's ID is spent, so Edit restores it to the composer from
  // the row's own text and photos and only then removes the row.
  const handleEditFailed = useCallback(async (entry: QueuedPrompt, cancel: () => Promise<boolean>) => {
    try {
      await editFailedSend(entry, cancel);
    } catch (error) {
      showToast(`Couldn't bring the message back. ${humanizeDaemonError(error)}`, "error", errorRecoveryAction(error));
    }
  }, []);
  const queuedPill = useMemo(() => {
    if (message.role !== "user" || !sessionPath) return null;
    if (localPendingEntry && isPendingIntent(localPendingEntry)) {
      const actions = localPendingActions(message, localPendingEntry);
      return <QueuedMessage entry={localPendingEntry}
        onCancel={() => handleCancelQueued(actions.cancel)}
        onEdit={() => handleEditFailed(localPendingEntry, actions.cancel)}
        onRetry={() => void handleRetryQueued(actions.retry, localPendingEntry.state === "uncertain")} />;
    }
    const pills = rowStatus?.pills;
    if (!pills?.length) return null;
    return (
      <div className="space-y-2">
        {pills.map((entry) => {
          const actions = pendingIntentActions(entry);
          return (
            <QueuedMessage
              key={entry.id}
              entry={entry}
              onCancel={() => handleCancelQueued(actions.cancel)}
              onEdit={() => handleEditFailed(entry, actions.cancel)}
              onRetry={() => void handleRetryQueued(actions.retry, entry.state === "uncertain")}
            />
          );
        })}
      </div>
    );
  }, [
    message,
    message.role,
    sessionPath,
    rowStatus,
    localPendingEntry,
    handleCancelQueued,
    handleEditFailed,
    handleRetryQueued,
  ]);

  // One classification for every assistant error (domain/turn-errors). A
  // user's own stop is not an error: the turn footer says "Stopped after 41s"
  // in muted text, so it gets no notice here.
  const errorView = message.role === "assistant" && !turnStoppedByUser(message) ? classifyTurnError(message) : null;
  const turnError = errorView && !errorView.hidden
    ? <TurnError view={errorView} raw={message.errorMessage ?? ""} onRetry={onRetry} retryDisabled={retryDisabled} />
    : null;
  const otherError = message.errorMessage && message.role !== "assistant"
    ? <Notice tone="danger" className="mt-3" action={errorRecoveryAction(message.errorMessage, transcriptActions?.switchModel)}>{humanizeDaemonError(message.errorMessage)}</Notice>
    : null;

  // This local composition survives outbox cleanup, but never stands in for
  // canonical image content or claims delivery/storage on the daemon.
  const count = message.localAttachmentCount;
  const attachmentSummary = message.role === "user" && message.id.startsWith("local:")
    && typeof count === "number" && Number.isSafeInteger(count) && count > 0
    && !message.parts.some(part => part.kind === "image") ? (
      <div className="not-prose mt-2 text-meta" data-testid="message-attachment-count">
        {count} {count === 1 ? "image" : "images"} attached
      </div>
    ) : null;

  if (message.parts.length === 0) {
    if (!message.text && !turnError && !otherError && !queuedPill && !attachmentSummary) return null;
    return (
      <div className={cn(PROSE, message.role === "user" && "[word-break:break-word]")}>
        {message.text ? (
          <BubbleWrap bubbles={bubbles} message={message}>
          <ClampedTextPart
            text={message.text}
            keywords={keywords}
            isStreaming={isStreaming}
            collapseReply={message.role === "assistant"}
            keepOpen={!!isStreaming || !!toolsLive}
            eagerMarkdown={message.role === "assistant" && message.eagerMarkdown}
            finalReply={!!finalReply && message.role === "assistant"}
            userClamp={message.role === "user"}
            onOpenPath={onOpenPath}
          />
          </BubbleWrap>
        ) : null}
        {attachmentSummary}
        {queuedPill}
        {turnError}
        {otherError}
      </div>
    );
  }

  return (
    <div className={cn(PROSE, message.role === "user" && "[word-break:break-word]")}>
      {message.parts.map((part, idx) => {
        if (railGroups && (part.kind === "thinking" || part.kind === "tool")) {
          const group = railGroups.get(idx);
          if (!group) return null;
          const working = !!isStreaming || !!toolsLive;
          // Previewing while it is the message's tail: anything written after it means the answer moved on.
          const tail = idx + group.parts.length === message.parts.length;
          // Settled with nothing to show (only thoughts, Thinking → Hidden): no group and no gap where it would be.
          if (!(working && tail) && !hasShownWork([group], thinking)) return null;
          return (
            <div key={`rail-${idx}`} className={workWrap}>
              <RunGroup messages={[group]} live={working && tail} toolsLive={working} sessionPath={sessionPath}>
                {toolCalls === "summary" ? (
                  <WorkRail messages={[group]} toolsLive={working} liveMessageId={message.id} sessionPath={sessionPath} toolResultUnknown={toolResultUnknown} />
                ) : (
                  <RunSummary messages={[group]} toolsLive={working} liveMessageId={message.id} sessionPath={sessionPath} toolResultUnknown={toolResultUnknown} latestThought={latestThought} defaultExpanded rowsOnly />
                )}
              </RunGroup>
            </div>
          );
        }
        if (part.kind === "text") {
          // Live-only presentation (withheld table rows, open fence) applies
          // only while this text is the streaming tail. Once a tool or other
          // part follows, the text is finished and must show in full.
          const animating = !!isStreaming && idx === message.parts.length - 1;
          return (
            <BubbleWrap key={"text-" + idx} bubbles={bubbles} message={message}>
            <ClampedTextPart
              text={part.text}
              keywords={keywords}
              isStreaming={animating}
              collapseReply={message.role === "assistant"}
              keepOpen={!!isStreaming || !!toolsLive}
              eagerMarkdown={message.role === "assistant" && message.eagerMarkdown}
              finalReply={!!finalReply && message.role === "assistant"}
              userClamp={message.role === "user"}
              onOpenPath={onOpenPath}
            />
            </BubbleWrap>
          );
        }
        if (part.kind === "thinking") {
          if (hideWork) return null;
          const live = !!isStreaming && idx === message.parts.length - 1;
          // A settled thought renders nothing when hidden; its wrapper margin would leave a gap.
          if (thinking === "hidden" && !live) return null;
          return (
            <div key={`thinking-${idx}`} className={workWrap}>
              <Thought thought={part} live={live} latest={!!latestThought && idx === lastThinkingIndex} />
            </div>
          );
        }
        if (part.kind === "tool") {
          if (hideWork) return null;
          const live = !!isStreaming || !!toolsLive;
          // The message timestamp stands in for a missing start ONLY where it
          // is the tool's start: a live call seen mid-flight, or the sole call
          // in its message (the entry is written as the call is issued). With
          // several calls a later one's real start is unknown, and dating it
          // from the message would pad its duration with its siblings' time.
          const toolPart =
            part.startedAt === undefined && message.createdAt && ((live && part.state === "running") || soleCall)
              ? { ...part, startedAt: message.createdAt.getTime() }
              : part;
          return (
            <div key={`tool-${part.callId}-${idx}`} className={workWrap}>
              <ToolPart
                part={toolPart}
                sessionPath={sessionPath}
                live={live}
                resultUnknown={toolResultUnknown && part.state === "running"}
              />
            </div>
          );
        }
        if (part.kind === "image") {
          return (
            <ImagePart
              key={`image-${idx}`}
              src={part.src}
              mimeType={part.mimeType}
            />
          );
        }
        return null;
      })}
      {attachmentSummary}
      {queuedPill}
      {turnError}
      {otherError}
    </div>
  );
}

function BubbleWrap({ bubbles, message, children }: { bubbles: boolean; message: UiMessage; children: ReactNode }) {
  return bubbles ? <AgentBubble message={message}>{children}</AgentBubble> : <>{children}</>;
}

/** Redesign copy for the two labels people hit most; the rest read as classified. */
function turnErrorTitle(view: TurnErrorView): string {
  if (view.label === "Provider error") return "Couldn't get a reply";
  if (view.label === "Context limit") return "Context window full";
  return view.label;
}

const NOTICE_BUTTON =
  "relative rounded-sm font-medium outline-none after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] active:opacity-85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * A failed turn: the provider's own sentence as the summary, its raw text one
 * tap away (mono, inside the notice), and Retry on the newest failed turn.
 * Only a failure the user must act on is danger; restarts, refusals and
 * network blips that retry on their own are an info notice.
 */
function TurnError({ view, raw, onRetry, retryDisabled }: { view: TurnErrorView; raw: string; onRetry?: () => void; retryDisabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const transcriptActions = useContext(TranscriptActionsContext);
  const cause = daemonErrorCause(raw);
  const recovery = cause === "connection" && onRetry ? undefined : errorRecoveryAction(raw, transcriptActions?.switchModel);
  const summary = cause === "model" || cause === "provider-auth"
    ? humanizeDaemonError(raw)
    : view.summary ?? (view.tone === "danger" && raw ? providerErrorSummary(raw) : "");
  // Stops and restarts are fully said by their label; the raw line is noise.
  const expandable = raw.length > 0 && raw !== summary && (view.tone === "danger" || view.summary !== undefined || view.hint !== undefined);
  const danger = view.tone === "danger";
  return (
    <Notice tone={danger ? "danger" : "info"} title={cause === "model" ? "Model needed" : cause === "provider-auth" ? "Provider sign-in required" : turnErrorTitle(view)} className="not-prose mt-3" testId="turn-error">
      {summary ? <span className="block text-meta">{summary}</span> : null}
      {view.hint ? <span className="block text-meta text-muted-foreground">{view.hint}</span> : null}
      {open ? (
        <span className="disclosure mt-2 block whitespace-pre-wrap break-words font-mono text-code text-muted-foreground [overflow-wrap:anywhere]" data-testid="turn-error-raw">{raw}</span>
      ) : null}
      {recovery || onRetry || expandable || view.switchModel ? (
        <span className="mt-2 flex flex-wrap items-center gap-4">
          {recovery ? (
            <button type="button" onClick={recovery.onClick} className={cn(NOTICE_BUTTON, "text-primary-text")}>
              {recovery.label}
            </button>
          ) : onRetry ? (
            <button type="button" data-testid="retry-turn" disabled={retryDisabled} onClick={onRetry} className={cn(NOTICE_BUTTON, danger ? "text-danger" : "text-primary-text")}>
              Retry
            </button>
          ) : null}
          {expandable ? (
            <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={cn(NOTICE_BUTTON, "text-muted-foreground")}>
              {open ? "Hide details" : "Details"}
            </button>
          ) : null}
          {view.switchModel ? <SwitchModelButton /> : null}
        </span>
      ) : null}
    </Notice>
  );
}
