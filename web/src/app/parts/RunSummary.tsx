"use client";

import {
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
  FilePenLineIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  ListChecksIcon,
  SearchIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import type { UiMessage } from "@/domain/messages";
import { cn } from "@/lib/utils";
import { prefersReducedMotion, useAppearance } from "@/platform/appearance";

import { ImagePart } from "./ImagePart";
import { QuickReplies } from "./QuickReplies";
import { Thought } from "./Thought";
import { ToolPart } from "./ToolPart";
import { groupRunSteps, pendingQuickQuestion, summarizeRun, type PendingAsk, type RunKind, type RunStep } from "./run-summary";

const KIND_ICON: Record<RunKind, LucideIcon> = {
  read: FileTextIcon,
  commands: TerminalIcon,
  edited: FilePenLineIcon,
  searched: SearchIcon,
  web: GlobeIcon,
  delegated: BotIcon,
  planned: ListChecksIcon,
  used: WrenchIcon,
  steps: WrenchIcon,
};

/** The quiet line a run folds into: icon, one-line summary, chevron. A tap opens its steps in place. */
function RunRow({ icon: Icon, danger, children, expanded, onToggle, label, testId }: {
  icon: LucideIcon;
  danger?: boolean;
  children: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      onClick={onToggle}
      data-testid={testId}
      className="relative flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg text-left text-ui text-muted-foreground outline-none transition-colors duration-[var(--dur-fast)] after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] press-bounce focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", danger && "text-danger")} />
      {children}
      <ChevronRightIcon aria-hidden className={cn("size-4 shrink-0 text-tertiary transition-transform duration-[var(--dur-disclosure)] ease-in-out", expanded && "rotate-90")} />
    </button>
  );
}

interface StepProps {
  step: RunStep;
  /** This is the newest step of a live run. */
  current: boolean;
  /** The run is still in flight. */
  live: boolean;
  liveMessageId?: string | null;
  sessionPath?: string | null;
  /** A pending quick question renders below the run instead of as a row. */
  hiddenCallId?: string;
  /** The failed call the turn ended on; every other failure in the run is routine. */
  finalFailureId: string | null;
  /** Calls whose screenshots are already in the chat flow. */
  inlineCalls: ReadonlySet<string>;
  /** A passive transcript cannot prove that a missing tool result means interruption. */
  toolResultUnknown?: boolean;
  latestThought?: boolean;
  /** Off inside a work group, whose live title is the one shimmering voice. */
  shimmer: boolean;
}

/**
 * A streaming thought folds to a one-line row the moment its first call starts,
 * which dropped the whole transcript tail by the thought's height in one frame.
 * Tween that shrink instead. The last settled height comes from a
 * ResizeObserver (post-layout, so no extra forced layout per streamed frame).
 */
function useSettleTween(ref: RefObject<HTMLElement | null>, live: boolean) {
  const last = useRef(0);
  const was = useRef(live);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => { last.current = el.offsetHeight; });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && was.current && !live && typeof el.animate === "function" && !prefersReducedMotion()) {
      const from = last.current;
      const to = el.offsetHeight;
      if (from - to > 8) {
        el.style.overflow = "hidden";
        const done = () => { el.style.overflow = ""; };
        const tween = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 220, easing: "cubic-bezier(0.4, 0, 0.2, 1)" });
        tween.onfinish = done;
        tween.oncancel = done;
      }
    }
    was.current = live;
  });
}

/** One thought and the calls it led to, flush: a run reads as one block of activity. */
const RunStepRows = memo(function RunStepRows({ step, current, live, liveMessageId, sessionPath, hiddenCallId, finalFailureId, inlineCalls, toolResultUnknown, latestThought, shimmer }: StepProps) {
  const ref = useRef<HTMLDivElement>(null);
  const thoughtLive = current && step.tools.length === 0;
  useSettleTween(ref, thoughtLive);
  // The model keeps appending to its thinking part while the calls that part already issued run and
  // report, so part order shows reasoning ABOVE work that came after it (owner's screenshot: four
  // running reads under a thought still streaming). While the run is live the newest thought is the
  // last line, as DeepSeek draws its current block: work already done above it, reasoning at the end.
  // A settled run keeps the true order (thought, then what it led to).
  const thoughtRow = step.thought ? <Thought thought={step.thought} live={thoughtLive} ms={step.thoughtMs} latest={latestThought} /> : null;
  const thoughtLast = current && live && !!step.thought;
  return (
    <div ref={ref} className="flex min-w-0 flex-col" data-testid="run-step" data-current={current ? "true" : undefined}>
      {thoughtLast ? null : thoughtRow}
      {step.tools.map(({ part, messageId }) => part.callId === hiddenCallId ? null : (
        <ToolPart key={part.callId} part={part} sessionPath={sessionPath} live={live && (!liveMessageId || messageId === liveMessageId)} resultUnknown={toolResultUnknown && part.state === "running"} showImages={!!part.images?.length && !inlineCalls.has(part.callId)} routineFailure={part.callId !== finalFailureId} shimmer={shimmer} />
      ))}
      {thoughtLast ? thoughtRow : null}
    </div>
  );
}, (a, b) => {
  if (a.current !== b.current || a.live !== b.live || a.liveMessageId !== b.liveMessageId || a.sessionPath !== b.sessionPath || a.hiddenCallId !== b.hiddenCallId || a.finalFailureId !== b.finalFailureId || a.inlineCalls !== b.inlineCalls || a.toolResultUnknown !== b.toolResultUnknown || a.latestThought !== b.latestThought || a.shimmer !== b.shimmer) return false;
  // Steps are regrouped every frame; a step whose parts are the same objects has not changed.
  if (a.step.thought !== b.step.thought || a.step.thoughtMs !== b.step.thoughtMs || a.step.tools.length !== b.step.tools.length) return false;
  return a.step.tools.every((tool, index) => tool.part === b.step.tools[index]!.part && tool.messageId === b.step.tools[index]!.messageId);
});


/**
 * Thinking-and-tool messages, as one run, folded behind one quiet summary
 * row ("Read 3 files, ran 5 commands"). While the agent works the row stays
 * and the newest steps show under it, so the work can be followed as it
 * happens and nothing moves when the run settles. A tap opens every step in
 * place; a run that ended on a failure opens itself.
 */
export const RunSummary = memo(function RunSummary({
  messages,
  sessionPath,
  toolsLive,
  continued = false,
  reply = "",
  liveMessageId,
  pendingAsk,
  onOtherQuestion,
  onAnswerSent,
  toolResultUnknown,
  latestThought,
  defaultExpanded = false,
  extrasOnly = false,
  rowsOnly = false,
}: {
  messages: readonly UiMessage[];
  sessionPath?: string | null;
  toolsLive: boolean;
  /** The agent went on after this run (see summarizeRun's failure tone). */
  continued?: boolean;
  /** The message that continued the run; screenshots it names stay in view. */
  reply?: string;
  liveMessageId?: string | null;
  pendingAsk?: PendingAsk;
  onOtherQuestion?: () => void;
  onAnswerSent?: () => void;
  /** Agent transcripts: a call without a recorded result is neither running nor interrupted. */
  toolResultUnknown?: boolean;
  /** The run holds the newest thought (Thinking → "latest"): only its last thought opens. */
  latestThought?: boolean;
  /** Open until the reader chooses otherwise (the turn-work sheet shows every step). */
  defaultExpanded?: boolean;
  /** Only what sits around the rows (screenshots, a pending quick question): WorkRail draws the steps. */
  extrasOnly?: boolean;
  /** Only the rows: a work group holds them, and a sibling `extrasOnly` keeps the extras in the chat flow. */
  rowsOnly?: boolean;
}) {
  // null: the reader has not chosen, so a run that ended on a failure shows it.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const { toolCalls } = useAppearance();
  const summary = useMemo(() => summarizeRun(messages, { continued, live: toolsLive, reply }), [messages, continued, toolsLive, reply]);
  const inlinePhotos = useMemo(() => summary.photos.filter((photo) => photo.inline), [summary]);
  const inlineCalls = useMemo(
    () => new Set(inlinePhotos.flatMap((photo) => (photo.callId === null ? [] : [photo.callId]))),
    [inlinePhotos],
  );
  // Failures the agent went on past are counted, not alarmed: only the one
  // the turn ended on earns the danger icon and colour.
  const endedOnFailure = summary.finalFailureId !== null;
  const failedText = summary.failed ? (endedOnFailure ? `${summary.failed} failed` : `${summary.failed} ${summary.failed === 1 ? "error" : "errors"}`) : "";
  const expanded = chosen ?? (defaultExpanded || toolCalls === "expanded" || endedOnFailure);
  const open = !extrasOnly && (toolsLive || expanded);
  const steps = useMemo(() => (open ? groupRunSteps(messages) : null), [messages, open]);
  const lastThoughtStep = steps ? steps.findLastIndex((step) => !!step.thought) : -1;
  const pendingQuestion = useMemo(() => pendingQuickQuestion(messages, pendingAsk), [messages, pendingAsk]);
  const question = sessionPath && onOtherQuestion ? pendingQuestion : null;
  const KindIcon = endedOnFailure ? TriangleAlertIcon : summary.kind ? KIND_ICON[summary.kind] : summary.photos.length ? ImageIcon : BrainIcon;
  const outcome = [failedText, summary.interrupted ? (summary.interrupted === 1 ? "interrupted" : `${summary.interrupted} interrupted`) : ""].filter(Boolean).join(", ");
  if (extrasOnly && !inlinePhotos.length && !question) return null;
  return (
    <div className="flex min-w-0 flex-col" data-testid={extrasOnly ? "run-extras" : "run-summary"} data-live={toolsLive ? "true" : undefined} data-entry-id={extrasOnly ? undefined : messages[0]?.sourceEntryId}>
      {extrasOnly ? null : <RunRow
        icon={KindIcon}
        danger={endedOnFailure}
        expanded={expanded}
        onToggle={() => setChosen(!expanded)}
        label={`${expanded ? "Hide" : "Show"} steps: ${summary.label}${outcome ? ` · ${outcome}` : ""}`}
        testId="run-summary-toggle"
      >
        <span className="flex min-w-0 flex-1 items-baseline" data-testid="run-summary-label">
          <span className="min-w-0 truncate">{summary.label}</span>
          {failedText ? <span className={cn("shrink-0 whitespace-pre", endedOnFailure && "text-danger")}> · {failedText}</span> : null}
          {summary.interrupted ? <span className="shrink-0 whitespace-pre text-tertiary"> · {summary.interrupted === 1 ? "interrupted" : `${summary.interrupted} interrupted`}</span> : null}
        </span>
      </RunRow>}
      {steps ? (
        <div className={cn("ml-2 flex min-w-0 flex-col border-l border-hairline pl-3", expanded && "disclosure")} data-testid="run-steps-inline">
          {steps.map((step, index) => {
            // Steps only ever append, so position is the stable identity: it
            // survives the live message being renamed when it is committed.
            return (
              <RunStepRows
                key={index}
                step={step}
                current={toolsLive && index === steps.length - 1}
                live={toolsLive}
                liveMessageId={liveMessageId}
                sessionPath={sessionPath}
                hiddenCallId={question?.callId}
                finalFailureId={summary.finalFailureId}
                inlineCalls={inlineCalls}
                toolResultUnknown={toolResultUnknown}
                latestThought={!!latestThought && index === lastThoughtStep}
                shimmer={!rowsOnly}
              />
            );
          })}
        </div>
      ) : null}
      {/* INVARIANT: every photo renders exactly once. The newest screenshot (and
          any the reply names) sit in the chat flow; the others with their steps. */}
      {rowsOnly ? null : inlinePhotos.map((photo) => (
        <figure key={photo.key} className="m-0 max-w-[85%] pt-1" data-testid="run-photo">
          <ImagePart src={photo.src} mimeType={photo.mimeType} alt={photo.caption || "Agent screenshot"} />
          {photo.caption ? <figcaption className="text-meta text-muted-foreground [overflow-wrap:anywhere]">{photo.caption}</figcaption> : null}
        </figure>
      ))}
      {!rowsOnly && question && sessionPath && onOtherQuestion ? (
        <div className="pt-3">
          <QuickReplies key={question.callId} question={question} sessionPath={sessionPath} onOther={onOtherQuestion} onSent={() => onAnswerSent?.()} />
        </div>
      ) : null}
    </div>
  );
});
