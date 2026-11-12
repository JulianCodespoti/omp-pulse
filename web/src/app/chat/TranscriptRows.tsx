/**
 * The transcript's row vocabulary, shared by the chat and an agent's own
 * conversation (tools/AgentConversation) so both read as the same kind of
 * thread: one message row, the Bubbles sender line, and the turn grouping the
 * footer follows.
 */
import { memo, useRef, useSyncExternalStore } from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/platform/appearance";
import { hasReplyActions } from "@/domain/reply-actions";
import type { UiMessage } from "@/domain/messages";
import type { TimelineItem } from "@/domain/timeline";
import type { QueuedPrompt } from "@/runtime/offline-queue";
import type { UserRowStatus } from "@/runtime/user-row-status";
import { BubbleInfo, messageInfo, useBubbleInfo } from "../parts/Bubble";
import { MessageParts } from "../parts/MessageParts";
import { USER_BUBBLE } from "../parts/prose";
import { pendingQuickQuestion, summarizeRun, type PendingAsk } from "../parts/run-summary";
import { shortModel } from "../session-format";
import { thinkingLabel } from "./ModelPill";

// The transcript's `Switched to …` divider names models exactly as the composer's chip does.
export const TIMELINE_NAMES = { model: shortModel, thinking: thinkingLabel };

/** A finished turn's footer: how long it took, and its reply's Copy and ⋯. */
export interface TurnSummary {
  startedAt?: number;
  endedAt?: number;
  stopped: boolean;
  error: boolean;
  /** The turn's final prose reply, which Copy and ⋯ act on. */
  reply: UiMessage | null;
}

/**
 * Group the timeline into turns (a user message up to the next one) and key
 * each turn's summary by its LAST assistant-side item, which the footer
 * follows. A turn with no assistant activity yet has no footer.
 */
export function summarizeTurns(timeline: readonly TimelineItem[]): Map<number, TurnSummary> {
  const out = new Map<number, TurnSummary>();
  let startedAt: number | undefined;
  let lastIndex = -1;
  let last: UiMessage | null = null;
  let reply: UiMessage | null = null;
  const close = (): void => {
    if (lastIndex < 0 || !last) return;
    const ended = (last.completedAt ?? last.createdAt)?.getTime();
    out.set(lastIndex, {
      startedAt,
      endedAt: ended !== undefined && Number.isFinite(ended) ? ended : undefined,
      stopped: last.stopReason === "aborted",
      error: last.stopReason === "error" || !!last.errorMessage,
      reply,
    });
  };
  timeline.forEach((item, index) => {
    if (item.kind === "message" && item.message.role === "user") {
      close();
      const at = item.message.createdAt?.getTime();
      startedAt = at !== undefined && Number.isFinite(at) ? at : undefined;
      lastIndex = -1;
      last = null;
      reply = null;
      return;
    }
    const messages = item.kind === "message" ? [item.message] : item.kind === "run" || item.kind === "edits" ? item.messages : null;
    if (!messages || messages.length === 0) return;
    lastIndex = index;
    last = messages.at(-1)!;
    for (const message of messages) if (hasReplyActions(message)) reply = message;
  });
  close();
  return out;
}

/**
 * An assistant message's own thoughts and tool calls, projected out of a
 * message that also carries prose: that prose-bearing message stays in the
 * flow, its work goes to the chip's sheet as a run of its own. `reply` and
 * `continued` mirror a run's, for RunSummary's failure tone.
 */
export interface MessageWork {
  kind: "message-work";
  key: string;
  messages: UiMessage[];
  continued: boolean;
  reply: string;
}

export type WorkItem = Extract<TimelineItem, { kind: "run" | "edits" }> | MessageWork;

/** One settled turn's tool work, folded into the single chip that heads its assistant side. */
export interface TurnWork {
  items: WorkItem[];
  summary: TurnSummary | undefined;
  /** The turn ended on a failure (it errored, or its last call failed with nothing after). */
  failed: boolean;
}

/**
 * DeepSeek's grouping: each stretch of a turn's work (its thoughts, calls and
 * edits between two pieces of prose) is ONE group, keyed where it happened (a
 * prose message: after its text; a run or edit: in its place) in `steps`.
 * `folded`: every run/edits index whose row moved into a group; `workHidden`:
 * message rows that stay but show prose only (their thoughts and calls moved
 * into the group after them). A stretch carries its own duration (first call
 * to the next prose). `worked`: the turns (keyed like `summarizeTurns`) that
 * have a group, whose footers leave the duration to it.
 */
export interface FoldedTurnWork {
  folded: Set<number>;
  workHidden: Set<number>;
  steps: Map<number, TurnWork>;
  worked: Set<number>;
}

/**
 * Keys of the runs in turns with more than `limit` tool calls. A turn's work
 * arrives as many runs (markers split them) most of them short; the ones that
 * share a long turn are drawn as sections too, so the turn reads as one list.
 */
export function longTurnRuns(timeline: readonly TimelineItem[], limit: number): Set<string> {
  const out = new Set<string>();
  let keys: string[] = [];
  let calls = 0;
  const close = () => {
    if (calls > limit) for (const key of keys) out.add(key);
    keys = [];
    calls = 0;
  };
  for (const item of timeline) {
    if (item.kind === "message" && item.message.role === "user") close();
    else if (item.kind === "run") {
      keys.push(item.key);
      for (const message of item.messages) calls += message.parts.filter((part) => part.kind === "tool").length;
    } else if (item.kind === "message") calls += item.message.parts.filter((part) => part.kind === "tool").length;
  }
  close();
  return out;
}

const itemsFailed = (items: readonly WorkItem[]): boolean =>
  items.some((item) => (item.kind === "run" || item.kind === "message-work") && summarizeRun(item.messages, { continued: item.continued, reply: item.reply }).finalFailureId !== null);

const timeOf = (date: Date | undefined): number | undefined => {
  const at = date?.getTime();
  return at !== undefined && Number.isFinite(at) ? at : undefined;
};

/**
 * How long one stretch of work took, as a summary the chip labels like a turn's.
 * It starts at its first call (else its first message) and ends where the next
 * prose began (`endedAt`), else at its last call's end. Undefined when no
 * clock is known, so the chip falls back to counting tools.
 */
function stretchSummary(items: readonly WorkItem[], endedAt: number | undefined): TurnSummary | undefined {
  let startedAt: number | undefined;
  let lastEnd: number | undefined;
  for (const item of items) for (const message of item.messages) {
    const tools = message.parts.filter((part) => part.kind === "tool");
    startedAt ??= tools.find((part) => part.startedAt !== undefined)?.startedAt ?? timeOf(message.createdAt);
    for (const part of tools) if (part.endedAt !== undefined) lastEnd = Math.max(lastEnd ?? 0, part.endedAt);
  }
  const end = endedAt ?? lastEnd;
  return startedAt !== undefined && end !== undefined ? { startedAt, endedAt: end, stopped: false, error: false, reply: null } : undefined;
}

// One projection per message, so an open sheet keeps its rows' identity across re-folds.
const WORK_OF = new WeakMap<UiMessage, UiMessage | null>();

function workOf(message: UiMessage): UiMessage | null {
  if (message.role !== "assistant") return null;
  let work = WORK_OF.get(message);
  if (work === undefined) {
    const parts = message.parts.filter((part) => part.kind === "thinking" || part.kind === "tool");
    work = parts.length ? { ...message, parts, text: "", errorMessage: undefined } : null;
    WORK_OF.set(message, work);
  }
  return work;
}

/**
 * The Summary tool-call mode: each turn's `run` and `edits` items leave the
 * flow (`folded`) and reappear in their stretch's group (`steps`); a prose
 * message's own thoughts and calls move to the group after its text
 * (`workHidden`). `live`: the newest turn is in flight, so it keeps its live
 * groups inline and folds only when it settles. `pendingAsk`: the run (or
 * message) holding that open question is never folded.
 */
export function foldTurnWork(timeline: readonly TimelineItem[], summaries: ReadonlyMap<number, TurnSummary>, live: boolean, pendingAsk?: PendingAsk): FoldedTurnWork {
  const folded = new Set<number>();
  const workHidden = new Set<number>();
  const steps = new Map<number, TurnWork>();
  const worked = new Set<number>();
  let last = -1;
  let items: WorkItem[] = [];
  let indexes: number[] = [];
  let hidden: number[] = [];
  // The turn's stretches: [key index, the items that stretch spans, when the prose that ended it began].
  let stretches: [number, WorkItem[], number?][] = [];
  const close = (newest: boolean): void => {
    if (items.length && !(live && newest)) {
      // Only the turn's final item can be the one it ended on; any earlier message's work was continued past.
      const tail = items.at(-1)!;
      if (tail.kind === "message-work" && hidden.at(-1) === last) {
        const ended = { ...tail, continued: false };
        items[items.length - 1] = ended;
        const stretch = stretches.at(-1)?.[1];
        if (stretch?.at(-1) === tail) stretch[stretch.length - 1] = ended;
      }
      const summary = summaries.get(last);
      for (const index of indexes) folded.add(index);
      for (const index of hidden) workHidden.add(index);
      const groups = stretches.filter(([, stretch]) => stretch.length > 0);
      if (groups.length) worked.add(last);
      for (const [key, stretch, endedAt] of groups) {
        const final = stretches.at(-1)?.[1] === stretch;
        const timed = stretchSummary(stretch, endedAt ?? (final ? summary?.endedAt : undefined));
        // The turn's own stop or failure belongs to the stretch it ended in.
        steps.set(key, {
          items: stretch,
          summary: timed && final ? { ...timed, stopped: !!summary?.stopped } : timed,
          failed: itemsFailed(stretch) || (final && !!summary?.error),
        });
      }
    }
    last = -1;
    items = [];
    indexes = [];
    hidden = [];
    stretches = [];
    splitNext = false;
  };
  // A marker (compaction, a background job, a retry, a day) ends the stretch before it too: the work after it
  // is the next group in sequence, so a long run of tools reads as groups that finish one after another.
  let splitNext = false;
  const stretchAt = (index: number): WorkItem[] => {
    if (!stretches.length || (splitNext && stretches.at(-1)![1].length)) stretches.push([index, []]);
    splitNext = false;
    return stretches.at(-1)![1];
  };
  timeline.forEach((item, index) => {
    if (item.kind === "message" && item.message.role === "user") {
      close(false);
      return;
    }
    const messages = item.kind === "message" ? [item.message] : item.kind === "run" || item.kind === "edits" ? item.messages : null;
    if (!messages || messages.length === 0) {
      if (stretches.length) splitNext = true;
      return;
    }
    last = index;
    if (item.kind === "message") {
      // Prose ends the stretch before it; the message's own calls (written after its text) open the next.
      if (item.message.text.trim()) {
        const open = stretches.at(-1);
        if (open) open[2] = timeOf(item.message.createdAt);
        stretches.push([index, []]);
      }
      const work = workOf(item.message);
      // A message holding the pending question keeps its calls inline.
      if (!work || pendingQuickQuestion([item.message], pendingAsk) !== null) return;
      const own: MessageWork = { kind: "message-work", key: `work:${item.message.id}`, messages: [work], continued: true, reply: "" };
      items.push(own);
      stretchAt(index).push(own);
      hidden.push(index);
    } else if (item.kind === "run" || item.kind === "edits") {
      // The run holding the pending question stays in the flow: its quick replies render only inline.
      if (item.kind === "run" && pendingQuickQuestion(item.messages, pendingAsk) !== null) return;
      items.push(item);
      stretchAt(index).push(item);
      indexes.push(index);
    }
  });
  close(true);
  return { folded, workHidden, steps, worked };
}

// INVARIANT: helper for content-visibility intrinsic size.
// `contain-intrinsic-size: auto <len>` uses <len> ONLY before the element has
// ever been laid out; after layout `auto` remembers the real height. An
// underestimate (80px vs 500px) makes scrollHeight report too small while rows
// are off-screen, so prepending or jumping converges late and needs a
// multi-frame settle loop (342px drift measured on a 50-row prepend). A
// representative fallback keeps scrollHeight close to truth while still
// benefits from `content-visibility:auto` skipping layout/paint.
function intrinsicSizeForMessage(message: UiMessage): string {
  const isUser = message.role === "user";
  if (isUser) {
    // User bubbles are short at 390px width; 100px covers a one-liner plus
    // padding at the 16px body size.
    const len = message.text.length;
    if (len > 600) return "auto 240px";
    if (len > 240) return "auto 170px";
    return "auto 100px";
  }
  // Assistant turns are typically 420-850px (16px markdown, tool cards, code
  // blocks, gap-6 rhythm) at this 390px viewport. Vary cheaply by part count /
  // text length so a one-line ack does not pay a tool-heavy report's estimate.
  const parts = message.parts.length;
  const len = message.text.length;
  if (parts > 5 || len > 1600) return "auto 760px";
  if (parts > 3 || len > 900) return "auto 600px";
  return "auto 440px";
}

export const ChatMessageRow = memo(
  function ChatMessageRow({
    message,
    animate,
    bindings,
    sessionPath,
    rowStatus,
    localPendingEntry,
    onOpenPath,
    toolsLive,
    finalReply,
    latestThought,
    onRetry,
    retryDisabled,
    toolResultUnknown,
    hideWork,
  }: {
    message: UiMessage;
    animate: boolean;
    sessionPath: string | null;
    bindings: {
      onTouchStart?: (e: React.TouchEvent) => void;
      onTouchEnd?: (e: React.TouchEvent) => void;
      onMouseDown?: (e: React.MouseEvent) => void;
      onContextMenu?: (e: React.MouseEvent) => void;
      [k: string]: unknown;
    };
    rowStatus?: UserRowStatus;
    localPendingEntry?: QueuedPrompt;
    onOpenPath?: (path: string) => void;
    /** This is the newest assistant turn and that turn is still in flight. */
    toolsLive: boolean;
    /** The newest assistant message with text: its reply is never collapsed. */
    finalReply: boolean;
    latestThought: boolean;
    /** Set only on the newest failed turn (src/domain/failed-turn.ts). */
    onRetry?: () => void;
    retryDisabled?: boolean;
    /** Agent transcripts: a call without a recorded result is neither running nor interrupted. */
    toolResultUnknown?: boolean;
    /** Summary mode: this settled turn's thoughts and tool calls live in its "Worked for" chip, so only the prose shows here. */
    hideWork?: boolean;
  }) {
    const isUser = message.role === "user";
    const intrinsic = intrinsicSizeForMessage(message);
    const bubbles = useAppearance().messageStyle === "bubbles";
    const info = useBubbleInfo();
    return (
      <Message
        {...bindings}
        style={{ containIntrinsicSize: intrinsic } as React.CSSProperties}
        className={cn(
          // Message owns the bubble widths (user 85%, assistant full).
          "[content-visibility:auto]",
          // Entrance is reserved for turns that ARRIVE at the live edge.
          // Animating on every mount broke history paging: a prepended page
          // mounts 50 rows at opacity 0, and scroll anchoring skips invisible
          // elements when picking an anchor, so the viewport jumped by the full
          // height of the page just inserted. pop-in for the user's own bubble
          // (it should feel sent), fade-up for the assistant.
          animate &&
            (isUser
              ? "origin-bottom-right motion-safe:animate-[pop-in_var(--dur-spring)_var(--ease-spring)] motion-reduce:animate-none"
              : "motion-safe:animate-[fade-up_var(--dur-base)_var(--ease-smooth)] motion-reduce:animate-none"),
        )}
        data-entry-id={message.sourceEntryId ?? undefined}
        data-testid="chat-message"
        from={message.role}
      >
        <MessageContent
          className={cn(
            // Variant-matched so these beat MessageContent's own
            // `group-[.is-user]:` rules instead of losing on specificity.
            // Assistant turns are full-bleed prose; MessageContent defaults to
            // `w-fit`, which made a tool card narrower than the text above it.
            "group-[.is-assistant]:w-full",
            bubbles && USER_BUBBLE,
          )}
          onClick={bubbles && isUser ? info.onClick : undefined}
          data-bubble-tap={bubbles && isUser ? "" : undefined}
        >
          <MessageParts
            message={message}
            toolsLive={toolsLive}
            finalReply={finalReply}
            latestThought={latestThought}
            sessionPath={sessionPath}
            rowStatus={rowStatus}
            localPendingEntry={localPendingEntry}
            onOpenPath={onOpenPath}
            onRetry={onRetry}
            retryDisabled={retryDisabled}
            toolResultUnknown={toolResultUnknown}
            hideWork={hideWork}
          />
        </MessageContent>
        {bubbles && isUser ? <BubbleInfo text={messageInfo(message)} open={info.open} className="self-end" /> : null}
      </Message>
    );
  },
  (previous, next) =>
    previous.message === next.message &&
    previous.bindings === next.bindings &&
    previous.sessionPath === next.sessionPath &&
    previous.rowStatus === next.rowStatus &&
    previous.localPendingEntry === next.localPendingEntry &&
    previous.onOpenPath === next.onOpenPath &&
    previous.toolsLive === next.toolsLive &&
    previous.finalReply === next.finalReply &&
    previous.latestThought === next.latestThought &&
    previous.onRetry === next.onRetry &&
    previous.retryDisabled === next.retryDisabled &&
    previous.toolResultUnknown === next.toolResultUnknown &&
    previous.hideWork === next.hideWork,
);

/**
 * Message style → Bubbles: who is speaking, once at the start of each agent
 * turn. It names the model too, so it replaces the model-change marker.
 */
export function SenderLine({ model }: { model?: string }) {
  return (
    // Indented to the bubbles: the avatar sits beside each bubble, the name above the first.
    <div className="mb-0.5 min-w-0 truncate pl-8 text-caption text-muted-foreground" data-testid="sender-line">
      {model ? `omp · ${shortModel(model)}` : "omp"}
    </div>
  );
}

// The model that opens an assistant turn, keyed by the turn's first
// assistant-side item: only on the first turn of the loaded transcript and
// where the model differs from the previous assistant turn's, so a session
// on one model names it once. Never on consecutive assistant messages.
// `tailOpen`: the newest turn has no assistant item yet, so the live reply
// opens it; `tailModel`: the model it would have to differ from.
export function turnHeads(timeline: readonly TimelineItem[]): { turnModels: Map<number, string>; turnStarts: Map<number, string | undefined>; tailOpen: boolean; tailModel: string | undefined } {
  const heads = new Map<number, string>();
  // Every turn's first assistant-side item, with that turn's model (sender line).
  const starts = new Map<number, string | undefined>();
  let open = true;
  let previous: string | undefined;
  timeline.forEach((item, index) => {
    if (item.kind === "message" && item.message.role === "user") {
      open = true;
      return;
    }
    const messages = item.kind === "message" ? [item.message] : item.kind === "run" || item.kind === "edits" ? item.messages : null;
    if (!messages || messages.length === 0) return;
    if (open) {
      open = false;
      const model = messages.find((message) => message.model)?.model;
      starts.set(index, model ?? previous);
      // The header names the current model; the transcript marks only a change.
      if (model && previous !== undefined && model !== previous) heads.set(index, model);
    }
    for (const message of messages) if (message.role === "assistant" && message.model) previous = message.model;
  });
  return { turnModels: heads, turnStarts: starts, tailOpen: open, tailModel: previous };
}

function subscribeSheetOpen(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-sheet-open"] });
  return () => observer.disconnect();
}
const sheetOpenNow = () => Boolean(document.documentElement.dataset.sheetOpen);

/**
 * A turn's liveness as the fold sees it: once live, it stays live while any
 * sheet is open. Settling folds the turn's tool rows into its chip, which
 * unmounts them, and a tool sheet opened from the live turn closed under the
 * reader the moment the turn ended.
 */
export function useLiveWhileSheetOpen(live: boolean): boolean {
  const sheetOpen = useSyncExternalStore(subscribeSheetOpen, sheetOpenNow, () => false);
  const held = useRef(false);
  held.current = live || (held.current && sheetOpen);
  return held.current;
}
