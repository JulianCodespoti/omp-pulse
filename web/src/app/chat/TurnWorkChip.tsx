import { ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import type { UiMessage } from "@/domain/messages";
import { prefersReducedMotion, useAppearance } from "@/platform/appearance";
import { spokenDuration } from "../parts/duration";
import { ShimmerText } from "../parts/ShimmerText";
import { liveStepLabel, SECTION_CALLS } from "../parts/WorkRail";
import { PluginFlowCards } from "../plugins/PluginFlowCards";
import { ToolCardsSuppressed } from "../plugins/PluginCard";
import type { TurnWork, WorkItem } from "./TranscriptRows";

/** Tool calls in some messages, each message counted once (edits repeat the run's own messages). */
function toolsIn(messages: Iterable<UiMessage>): number {
  const seen = new Set<string>();
  let used = 0;
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    used += message.parts.filter((part) => part.kind === "tool").length;
  }
  return used;
}

const workMessages = ({ items }: TurnWork): UiMessage[] => items.flatMap((item) => item.messages);

/**
 * A settled group's title, DeepSeek's "thought for N s" in our words:
 * "Worked for 42s" (or "Thought for 3s" when no tool ran), "Stopped after …";
 * without a clock, a count of the tools used.
 */
function workLabel(work: TurnWork): string {
  const { summary, failed } = work;
  const ms = summary?.startedAt !== undefined && summary.endedAt !== undefined ? summary.endedAt - summary.startedAt : Number.NaN;
  const spoken = spokenDuration(ms);
  const used = toolsIn(workMessages(work));
  const tail = failed ? " · failed" : "";
  if (spoken) {
    if (summary?.stopped) return `Stopped after ${spoken}`;
    return `${used ? "Worked" : "Thought"} for ${spoken}${tail}`;
  }
  return `${used ? `Used ${used} ${used === 1 ? "tool" : "tools"}` : "Thought"}${tail}`;
}

/**
 * The live title: the running call ("Reading retry.ts…") or "Thinking…" while
 * words stream. Null when this stretch has nothing in flight — then its title
 * is its elapsed label, because a group whose newest step has finished claiming
 * "Working…" reads as work that never stops.
 */
export function liveWorkTitle(messages: readonly UiMessage[]): string | null {
  const newest = messages.at(-1);
  const running = newest?.parts.findLast((part) => part.kind === "tool" && part.state === "running");
  if (running?.kind === "tool") return `${liveStepLabel(running).replace(/[.…]+$/, "")}…`;
  return newest?.parts.at(-1)?.kind === "thinking" ? "Thinking…" : null;
}

/** A live group the answer has moved past: how long its work took so far, from its own calls and messages. */
export function liveWorkLabel(messages: readonly UiMessage[]): string {
  let start: number | undefined;
  let end: number | undefined;
  for (const message of messages) {
    const created = message.createdAt?.getTime();
    for (const part of message.parts) {
      if (part.kind !== "tool") continue;
      start ??= part.startedAt ?? created;
      if (part.endedAt !== undefined) end = Math.max(end ?? 0, part.endedAt);
    }
    start ??= created;
  }
  const spoken = start !== undefined && end !== undefined ? spokenDuration(end - start) : null;
  const used = toolsIn(messages);
  if (spoken) return `${used ? "Worked" : "Thought"} for ${spoken}`;
  return used ? `Used ${used} ${used === 1 ? "tool" : "tools"}` : "Thought";
}

/**
 * A critically damped spring (DeepSeek's `spring(stiffness)`, damping ratio 1,
 * no bounce) as a CSS `linear()` easing and the time it takes to settle.
 */
function spring(stiffness: number): { ms: number; easing: string } {
  const w = Math.sqrt(stiffness);
  const settle = 9.23 / w; // 1 - (1 + wt)e^-wt reaches 0.999 at wt ≈ 9.23
  const points = Array.from({ length: 21 }, (_, i) => {
    const t = (settle * i) / 20;
    return (1 - (1 + w * t) * Math.exp(-w * t)).toFixed(3);
  });
  points[20] = "1";
  return { ms: Math.round(settle * 1000), easing: `linear(${points.join(", ")})` };
}
const SIZE = spring(1400);
const FADE_IN = spring(1600);
const FADE_OUT = spring(3800);
const DECELERATE = "cubic-bezier(0, 0, 0.2, 1)";

type Mode = "preview" | "collapsed" | "expanded";

type Timing = { ms: number; easing: string; delay?: number };

/** How the body moves entering `to` from `from`, with DeepSeek's values (xm9.b / xm9.c). */
function motionFor(from: Mode, to: Mode): { height: Timing | null; fade: Timing } {
  if (to === "collapsed") {
    // The answer started: the open body shrinks away (125ms after 50ms) and fades (150ms).
    if (from === "preview") return { height: { ms: 125, easing: DECELERATE, delay: 50 }, fade: { ms: 150, easing: DECELERATE } };
    return { height: SIZE, fade: FADE_OUT };
  }
  // The newest group fades open where it stands; its height follows the steps as they stream.
  if (to === "preview" && from === "collapsed") return { height: null, fade: { ms: 200, easing: DECELERATE } };
  return { height: SIZE, fade: FADE_IN };
}

// Groups that want to preview. Only the last of them in document order, per transcript (the chat, or a sheet's),
// previews: each place a group renders decides "live" on its own, and a step that had started streaming left the
// stretch before it still counted as the newest work, so two groups previewed at once.
const previewing = new Set<HTMLElement>();
const previewListeners = new Set<() => void>();
let previewVersion = 0;
const subscribePreview = (listener: () => void) => {
  previewListeners.add(listener);
  return () => previewListeners.delete(listener);
};
const readPreviewVersion = () => previewVersion;
function notifyPreview(): void {
  previewVersion++;
  for (const listener of previewListeners) listener();
}

/** Whether this group, wanting to preview, is the newest that does in its transcript. */
function useNewestPreview(root: RefObject<HTMLElement | null>, wants: boolean): boolean {
  useSyncExternalStore(subscribePreview, readPreviewVersion, readPreviewVersion);
  useLayoutEffect(() => {
    const el = root.current;
    if (!wants || !el) return;
    previewing.add(el);
    notifyPreview();
    return () => {
      previewing.delete(el);
      notifyPreview();
    };
  }, [root, wants]);
  const el = root.current;
  if (!wants || !el) return wants;
  const scope = el.closest('[role="dialog"]');
  for (const other of previewing) {
    if (other !== el && other.closest('[role="dialog"]') === scope && el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return false;
  }
  return true;
}

/**
 * DeepSeek's thinking group: one title line over a turn's stretch of work.
 * Live it is the newest group: the title shimmers the step in hand and the
 * body is fully open, growing downward as steps arrive, so the reader can see
 * the whole thing without scrolling inside it. When the stretch ends (the
 * answer starts, or the next group begins) the body shrinks into the title,
 * which then reads like a settled one ("Worked for 42s"). A tap opens the
 * whole timeline in place (never a sheet: the reader keeps their place).
 */
export function WorkGroup({ title, liveTitle, shimmer = true, failed = false, children, testId = "work-group" }: {
  /** The settled title ("Worked for 42s"): every group but the newest live one reads this. */
  title: string;
  /** Set while the group is the newest open one: its body is expanded and grows as steps arrive. */
  liveTitle?: string;
  /** False when the live title already reads like a settled one (nothing in flight): no shimmer. */
  shimmer?: boolean;
  failed?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const newest = useNewestPreview(root, liveTitle !== undefined);
  const live = liveTitle !== undefined && newest;
  const mode: Mode = expanded ? "expanded" : live ? "preview" : "collapsed";
  const body = useRef<HTMLDivElement>(null);
  const previous = useRef(mode);
  // A collapse keeps the body mounted until its exit has played. Set during render, so the body is still
  // in the DOM when the layout effect measures it.
  const [closing, setClosing] = useState(false);
  if (previous.current !== "collapsed" && mode === "collapsed" && !closing && !prefersReducedMotion()) setClosing(true);
  // The height it had before this change, read before React swaps the content (preview window → full body).
  const fromHeight = useRef(0);
  if (previous.current !== mode) fromHeight.current = body.current?.getBoundingClientRect().height ?? 0;
  const running = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const from = previous.current;
    if (from === mode) return;
    previous.current = mode;
    for (const animation of running.current) animation.cancel();
    running.current = [];
    const el = body.current;
    // Without Web Animations (or with reduced motion) the change is a snap: nothing left to wait for.
    if (!el || prefersReducedMotion() || typeof el.animate !== "function") { setClosing(false); return; }
    // Web Animations, not a grid-rows transition: Chromium never interpolated 1fr → 0fr, so collapsing jumped.
    const { height, fade } = motionFor(from, mode);
    const start = from === "collapsed" ? 0 : fromHeight.current;
    const end = mode === "collapsed" ? 0 : el.getBoundingClientRect().height;
    const opacity = mode === "collapsed" ? [1, 0] : from === "collapsed" ? [0, 1] : null;
    if (height && start !== end) running.current.push(el.animate([{ height: `${start}px` }, { height: `${end}px` }], { duration: height.ms, delay: height.delay ?? 0, easing: height.easing, fill: mode === "collapsed" ? "forwards" : "none" }));
    if (opacity) running.current.push(el.animate([{ opacity: opacity[0] }, { opacity: opacity[1] }], { duration: fade.ms, easing: fade.easing, fill: mode === "collapsed" ? "forwards" : "none" }));
    if (mode !== "collapsed") return;
    const finished = running.current;
    if (!finished.length) { setClosing(false); return; }
    void Promise.all(finished.map((animation) => animation.finished)).then(() => setClosing(false), () => { /* cancelled by a newer change */ });
  }, [mode]);
  const mounted = mode !== "collapsed" || closing;
  return (
    <div ref={root} className="min-w-0" data-testid={testId} data-mode={mode}>
      <button
        type="button"
        data-testid={`${testId}-title`}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        // The visual is 28px tall; the pseudo-element extends the hit area to 44px. No press fill (DeepSeek: indication alpha 0).
        className={cn(
          "relative inline-flex h-7 max-w-full items-center gap-1 rounded-md text-ui outline-none after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring",
          failed ? "text-danger" : "text-muted-foreground active:text-foreground",
        )}
      >
        <span className="min-w-0 truncate" aria-live="off">{live ? (shimmer ? <ShimmerText>{liveTitle}</ShimmerText> : liveTitle) : title}</span>
        <ChevronRightIcon aria-hidden className={cn("size-4 shrink-0 transition-transform duration-[var(--dur-disclosure)] motion-reduce:transition-none", expanded && "rotate-90")} />
      </button>
      {mounted ? (
        <div ref={body} className="min-w-0 overflow-hidden">
          {/* The newest group is fully open: it grows downward as steps arrive, and the transcript follows its end.
              A capped inner scroll window was readable only by scrolling inside ~5 lines (owner report). */}
          <div className="pt-3">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

/** Anything a settled group would show: a call, or a thought unless Thinking is Hidden (empty thinking never). */
export function hasShownWork(messages: readonly UiMessage[], thinking: string): boolean {
  return messages.some((message) => message.parts.some((part) => part.kind === "tool" || (part.kind === "thinking" && thinking !== "hidden" && (part.text.trim() !== "" || !!part.redacted))));
}

/**
 * A run that is not folded yet (the live turn's) as its group, in every
 * Tool calls mode (the mode picks the body, not whether it folds). `live`: it is the turn's newest
 * work and nothing of the answer has arrived after it, so it previews.
 */
export function RunGroup({ messages, live, toolsLive = live, sessionPath, children }: {
  messages: readonly UiMessage[];
  live: boolean;
  /** A call without a result may still be running (the turn is in flight); defaults to `live`. */
  toolsLive?: boolean;
  sessionPath?: string | null;
  children: ReactNode;
}) {
  const { thinking } = useAppearance();
  if (!live && !hasShownWork(messages, thinking)) return null;
  const current = live ? liveWorkTitle(messages) : null;
  return (
    <>
      <WorkGroup title={liveWorkLabel(messages)} liveTitle={live ? current ?? liveWorkLabel(messages) : undefined} shimmer={current !== null} testId="turn-work">
        <ToolCardsSuppressed.Provider value>{children}</ToolCardsSuppressed.Provider>
      </WorkGroup>
      {/* A claimed call's plugin card stays in the flow, beside the group, whatever the Tool calls mode. */}
      <PluginFlowCards messages={messages} live={toolsLive} sessionPath={sessionPath} />
    </>
  );
}

/** A settled stretch of a turn's work as its group, drawn where it happened. */
export function TurnWorkChip({ work, render, sessionPath }: { work: TurnWork; render: (item: WorkItem, sectioned: boolean) => ReactNode; sessionPath?: string | null }) {
  // Past a dozen calls the work reads as section rows; stretches split by markers would otherwise each draw their own small rail.
  const long = toolsIn(workMessages(work)) > SECTION_CALLS;
  const messages = useMemo(() => workMessages(work), [work]);
  return (
    <>
      <WorkGroup title={workLabel(work)} failed={work.failed} testId="turn-work">
        <ToolCardsSuppressed.Provider value>
          <div className="flex min-w-0 flex-col gap-3">{work.items.map((item) => <div key={item.key} className="min-w-0">{render(item, long)}</div>)}</div>
        </ToolCardsSuppressed.Provider>
      </WorkGroup>
      {/* The stretch's claimed calls: plugin cards in the flow under the chip (a settled turn has no running call). */}
      <PluginFlowCards messages={messages} live={false} sessionPath={sessionPath} />
    </>
  );
}
