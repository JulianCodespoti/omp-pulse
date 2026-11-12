"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ChatMessageRow, foldTurnWork, longTurnRuns, SenderLine, summarizeTurns, TIMELINE_NAMES, turnHeads, useLiveWhileSheetOpen, type WorkItem } from "@/app/chat/TranscriptRows";
import { TurnWorkChip } from "@/app/chat/TurnWorkChip";
import { SECTION_CALLS, WorkRun } from "@/app/parts/WorkRail";
import { EditSummary } from "@/app/parts/EditSummary";
import { RetryNotice } from "@/app/parts/TurnNotices";
import { TranscriptMarkers } from "@/app/parts/TranscriptMarkers";
import { TurnFooter } from "@/app/parts/TurnFooter";
import { TurnModel } from "@/app/parts/TurnModel";
import { AGENT_THREAD } from "@/app/parts/prose";
import { scaledGap, transcriptGap, TURN_FOOTER_GAP } from "@/app/parts/spacing";
import { buildTimeline, type TimelineItem, type TimelineMarkerInput } from "@/domain/timeline";
import { useAppearance } from "@/platform/appearance";
import { cn } from "@/lib/utils";
import { copyText } from "@/platform/clipboard";
import { ArrowLeftIcon, MessageSquareIcon, RotateCwIcon } from "lucide-react";
import { SheetLoading } from "@/app/ui/Sheet";
import { Notice } from "@/app/ui/Notice";
import { EmptyState } from "@/app/ui/EmptyState";
import { ContextMeter, formatTokens } from "@/app/ui/ContextMeter";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { daemonErrorCause } from "@/app/ui/OwnedBySession";
import { shortModel } from "@/app/session-format";
import { thinkingLabel } from "@/app/chat/ModelPill";
import { contextPercent } from "@/domain/usage-meter";
import { contextWindowFor } from "@/runtime/omp-store";
import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi } from "@/runtime/rpc-client";
import { startVisibleInterval } from "@/runtime/visible-interval";
import { AgentTranscriptReader, emptyAgentTranscriptSnapshot, type AgentTranscriptSelection, type AgentTranscriptSnapshot } from "@/runtime/agent-transcript-reader";
import type { UiMessage } from "@/domain/messages";

const NO_ROW_ACTIONS = {};
const NO_MARKERS: readonly TimelineMarkerInput[] = [];

/**
 * The agent's conversation drawn as the chat draws its own: the same rows,
 * runs, sender lines, gaps and turn footers, so a subagent reads like the
 * main thread. Read-only: no session path (no queue, Bash Stop, file opener,
 * prompt, approval or ask action can be emitted) and no row actions.
 * Unchanged records keep their identity in the transcript buffer, and the
 * previous plan is passed back, so a poll that adds one record re-renders
 * only what changed.
 */
function AgentTimeline({ messages, live }: { messages: UiMessage[]; live: boolean }) {
  const previous = useRef<TimelineItem[]>([]);
  const bubbles = useAppearance().messageStyle === "bubbles";
  const { timeline, lastAssistantId, lastTextAssistantId, latestThoughtId } = useMemo(() => {
    const tl = buildTimeline(messages, previous.current, TIMELINE_NAMES, NO_MARKERS);
    previous.current = tl;
    const lastAssistant = messages.findLast((message) => message.role === "assistant");
    const lastText = messages.findLast((message) => message.role === "assistant" && Boolean(message.text.trim()));
    // Thinking → "latest": only the newest turn's newest thought stays open.
    let thought: string | null = null;
    for (let i = messages.length - 1; i >= 0 && messages[i]!.role !== "user"; i--) {
      if (messages[i]!.parts.some((part) => part.kind === "thinking")) { thought = messages[i]!.id; break; }
    }
    return { timeline: tl, lastAssistantId: lastAssistant?.id ?? null, lastTextAssistantId: lastText?.id ?? null, latestThoughtId: thought };
  }, [messages]);
  const summaries = useMemo(() => summarizeTurns(timeline), [timeline]);
  const { turnModels, turnStarts } = useMemo(() => turnHeads(timeline), [timeline]);
  const tailTurnIndex = useMemo(() => Math.max(-1, ...summaries.keys()), [summaries]);
  const foldLive = useLiveWhileSheetOpen(live);
  const { folded, workHidden, steps: workSteps, worked } = useMemo(() => foldTurnWork(timeline, summaries, foldLive), [timeline, summaries, foldLive]);
  const longRuns = useMemo(() => longTurnRuns(timeline, SECTION_CALLS), [timeline]);
  const renderRun = (item: Pick<Extract<WorkItem, { kind: "run" }>, "messages" | "continued" | "reply">, expanded = false, sectioned = false, grouped = false) => (
    <WorkRun
      group={grouped ? (live && item.messages.at(-1)?.id === lastAssistantId ? "live" : "done") : undefined}
      messages={item.messages}
      sessionPath={null}
      toolsLive={false}
      latestThought={latestThoughtId !== null && item.messages.some((message) => message.id === latestThoughtId)}
      continued={item.continued}
      reply={item.reply}
      liveMessageId={lastAssistantId}
      toolResultUnknown
      defaultExpanded={expanded}
      sectioned={sectioned}
    />
  );
  const renderWork = (item: WorkItem, sectioned: boolean) => (item.kind === "edits" ? <EditSummary messages={item.messages} /> : renderRun(item, true, sectioned));
  return (
    <div className="flex min-w-0 flex-col">
      {timeline.map((item, index) => {
        const gap = { marginTop: scaledGap(transcriptGap(index > 0 ? timeline[index - 1]! : null, item)) };
        const summary = summaries.get(index);
        // The working agent's newest turn is still open: the live footer below stands for it.
        const footer = summary && !(live && index === tailTurnIndex) ? (
          <div style={{ marginTop: scaledGap(TURN_FOOTER_GAP) }}>
            <TurnFooter
              running={false}
              startedAt={summary.startedAt}
              endedAt={summary.endedAt}
              stopped={summary.stopped}
              error={summary.error}
              onCopy={summary.reply ? () => copyText(summary.reply!.text) : undefined}
              speakText={summary.reply?.text}
              durationShown={worked.has(index)}
            />
          </div>
        ) : null;
        const head = bubbles
          ? (turnStarts.has(index) ? <SenderLine model={turnStarts.get(index)} /> : null)
          : turnModels.has(index) ? <TurnModel model={turnModels.get(index)!} /> : null;
        const stepsHere = workSteps.get(index);
        // A group after a message's text sits below it; a run's group stands in the run's place.
        const steps = stepsHere ? (
          <div className={cn(item.kind === "message" && "mt-2", bubbles && AGENT_THREAD)}>
            <TurnWorkChip work={stepsHere} render={renderWork} />
          </div>
        ) : null;
        const row = item.kind === "message" ? (
          <div className="flex flex-col" style={gap} data-agent-message={item.message.id} data-agent-role={item.message.role}>
            {head}
            <ChatMessageRow
              animate={false}
              bindings={NO_ROW_ACTIONS}
              message={item.message}
              sessionPath={null}
              toolsLive={false}
              finalReply={item.message.id === lastTextAssistantId}
              latestThought={item.message.id === latestThoughtId}
              hideWork={workHidden.has(index)}
              toolResultUnknown
            />
            {steps}
          </div>
        ) : item.kind === "run" ? (
          folded.has(index) ? (
            steps ? <div className="min-w-0" style={gap} data-agent-run={item.key}>{head}{steps}</div> : null
          ) : (
          <div className="min-w-0" style={gap} data-agent-run={item.key}>
            {head}
            <div className={bubbles ? AGENT_THREAD : undefined}>
              {renderRun(item, false, longRuns.has(item.key), true)}
            </div>
          </div>
          )
        ) : item.kind === "edits" ? (
          folded.has(index) ? (steps ? <div style={gap}>{head}{steps}</div> : null) : <div style={gap}>{head}<EditSummary messages={item.messages} /></div>
        ) : item.kind === "retry" ? (
          <div style={gap}><RetryNotice messages={item.messages} recovered={item.recovered} live={null} /></div>
        ) : (
          <div style={gap}><TranscriptMarkers item={item} /></div>
        );
        return <Fragment key={item.kind === "message" ? item.message.id : item.key}>{row}{footer}</Fragment>;
      })}
      {live ? <div style={{ marginTop: scaledGap(TURN_FOOTER_GAP) }}><TurnFooter running /></div> : null}
    </div>
  );
}

/** What the agent itself runs with; empty strings and undefined mean not recorded. */
interface AgentRunInfo {
  model: string;
  /** `provider/id`, for the full name on hover and the window lookup. */
  modelId: string | undefined;
  reasoning: string;
  tokens: number | undefined;
  contextWindow: number | undefined;
}

/**
 * Model and context come from the agent's own newest turn, not the parent
 * session; the host-measured prompt size is the fallback before one is read.
 */
function runInfo(snapshot: AgentTranscriptSnapshot, hostTokens: number | undefined): AgentRunInfo {
  const newest = snapshot.messages.findLast((message) => message.role === "assistant");
  // The routing suffix names a gateway path, not a model.
  const modelId = (newest?.model ?? snapshot.model)?.replace(/@[^/]*$/, "");
  const tokens = newest?.contextSnapshot?.promptTokens ?? hostTokens;
  return {
    model: shortModel(modelId),
    modelId,
    reasoning: thinkingLabel(snapshot.thinkingLevel),
    tokens: typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined,
    contextWindow: contextWindowFor(modelId),
  };
}

/**
 * Label/value facts above the messages, the value right-aligned like a
 * settings row so a 150% label column never squeezes it; a hairline
 * separates them from the messages. Nothing recorded, nothing shown.
 */
function RunInfo({ info }: { info: AgentRunInfo }) {
  if (!info.model && !info.reasoning && info.tokens === undefined) return null;
  const percent = contextPercent(info.tokens, info.contextWindow);
  const row = "flex min-w-0 items-center justify-between gap-4";
  return (
    <dl data-testid="agent-run-info" className="mb-4 flex flex-col gap-2 border-b border-hairline pb-4 text-meta">
      {info.model ? (
        <div className={row}>
          <dt className="shrink-0 text-muted-foreground">Model</dt>
          <dd className="min-w-0 truncate text-right" title={info.modelId} data-testid="agent-run-model">{info.model}</dd>
        </div>
      ) : null}
      {info.tokens !== undefined ? (
        <div className={row}>
          <dt className="shrink-0 text-muted-foreground">Context</dt>
          <dd className="flex min-w-0 justify-end tabular-nums" data-testid="agent-run-context">
            {percent !== undefined
              ? <ContextMeter percent={percent} usedTokens={info.tokens} windowTokens={info.contextWindow} tokens />
              : `${formatTokens(info.tokens)} tokens`}
          </dd>
        </div>
      ) : null}
      {info.reasoning ? (
        <div className={row}>
          <dt className="shrink-0 text-muted-foreground">Reasoning</dt>
          <dd className="min-w-0 truncate text-right" data-testid="agent-run-reasoning">{info.reasoning}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function AgentConversation({ sessionPath, selection, readerRef, contextTokens, onBackToAgents, onMessages, live = false }: {
  sessionPath: string;
  /** The agent is still working: its newest turn shows the live footer, not a finished one. */
  live?: boolean;
  selection: AgentTranscriptSelection;
  readerRef: MutableRefObject<AgentTranscriptReader | null>;
  onBackToAgents: () => void;
  /** The last turn's prompt size as the agent's host reported it, until the transcript says. */
  contextTokens?: number;
  /** Called whenever the visible transcript messages change. */
  onMessages?: (messages: UiMessage[]) => void;
}) {
  const [snapshot, setSnapshot] = useState(emptyAgentTranscriptSnapshot);
  const contentRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const following = useRef(true);
  const info = useMemo(() => runInfo(snapshot, contextTokens), [snapshot, contextTokens]);

  // The Agents tab's scroll area remains the only scroller. Opening lands on recent
  // work; a user's upward scroll wins over both polling and markdown/image
  // reflow. Returning to the bottom opts back into following new content.
  useLayoutEffect(() => {
    const viewport = contentRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    viewportRef.current = viewport;
    following.current = true;
    const onScroll = () => { following.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 48; };
    // Inspecting an older tool/reasoning block is also a reading-position
    // choice, even when its collapsed row happened to be at the bottom.
    const onInspect = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('button[aria-expanded]')) following.current = false;
    };
    const resize = new ResizeObserver(() => { if (following.current) viewport.scrollTop = viewport.scrollHeight; });
    viewport.addEventListener("scroll", onScroll, { passive: true });
    const content = contentRef.current;
    content?.addEventListener("click", onInspect, true);
    if (contentRef.current) resize.observe(contentRef.current);
    return () => { resize.disconnect(); viewport.removeEventListener("scroll", onScroll); content?.removeEventListener("click", onInspect, true); viewportRef.current = null; };
  }, [selection]);
  useLayoutEffect(() => {
    if (!snapshot.messages.length) following.current = true;
    if (following.current && viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [snapshot.messages]);
  useLayoutEffect(() => {
    const reader = new AgentTranscriptReader(new DaemonApi(readPairingToken()), sessionPath, selection, setSnapshot);
    readerRef.current = reader;
    setSnapshot(emptyAgentTranscriptSnapshot());
    if (document.visibilityState !== "hidden") void reader.read();
    return () => { reader.dispose(); if (readerRef.current === reader) readerRef.current = null; };
  }, [sessionPath, selection, readerRef]);

  // A ref, so a caller's inline callback does not re-fire this on every render.
  const onMessagesRef = useRef(onMessages);
  onMessagesRef.current = onMessages;
  useEffect(() => { onMessagesRef.current?.(snapshot.messages); }, [snapshot.messages]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") void readerRef.current?.read(); };
    // Visible-only; the listener below reads on show.
    const stopPolling = startVisibleInterval(refresh, 3000);
    document.addEventListener("visibilitychange", refresh);
    return () => { stopPolling(); document.removeEventListener("visibilitychange", refresh); };
  }, [readerRef]);

  const localRecovery = snapshot.retryable
    ? { label: "Retry", icon: RotateCwIcon, onClick: () => void readerRef.current?.read(true) }
    : { label: "Back to agents", icon: ArrowLeftIcon, onClick: onBackToAgents };
  const recovery = daemonErrorCause(snapshot.error) === "connection"
    ? localRecovery
    : errorRecoveryAction(snapshot.error) ?? localRecovery;

  return (
    <section ref={contentRef} data-testid="agent-transcript" aria-label="Agent conversation" className="min-w-0 py-2">
      <RunInfo info={info} />
      {snapshot.limited ? <p data-testid="agent-history-limit" title="Limited to the most recent 200 messages and 8 MiB" className="mb-4 text-meta text-muted-foreground">Recent messages only. Earlier history isn’t shown.</p> : null}
      {snapshot.loading && !snapshot.messages.length ? <SheetLoading label="Loading messages…" /> : null}
      {snapshot.error ? <Notice tone="danger" action={recovery} details={<p className="whitespace-pre-wrap">{snapshot.error}</p>}>
        {snapshot.retryable ? "Couldn’t load this conversation." : "This conversation is unavailable."}
      </Notice> : null}
      {!snapshot.loading && !snapshot.error && !snapshot.messages.length && !snapshot.partial ? <EmptyState icon={<MessageSquareIcon />} title="No messages yet" description="Messages appear as the agent works." /> : null}
      {snapshot.messages.length ? <AgentTimeline messages={snapshot.messages} live={live} /> : null}
      {snapshot.partial ? <p className="mt-4 text-meta text-muted-foreground">Waiting for the rest of a transcript record…</p> : null}
    </section>
  );
}
