// Design review screen: replays real recorded turns through the app's own
// transcript components, on the phone, in the installed app, so a change to
// how a turn reads can be judged against real work. Opened by
// `#dev=live-turn&turn=<session>@<byte offset>` (an agent's question links
// here; ui/LinkedText); each turn is read through /api/history.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { appendAgentEntries, emptyAgentTranscript } from "@/domain/agent-transcript";
import { buildTimeline, type TimelineItem, type TimelineMarkerInput } from "@/domain/timeline";
import type { UiMessage } from "@/domain/messages";
import { ChatMessageRow, foldTurnWork, longTurnRuns, summarizeTurns, TIMELINE_NAMES, type WorkItem } from "@/app/chat/TranscriptRows";
import { TurnWorkChip } from "@/app/chat/TurnWorkChip";
import { SECTION_CALLS, WorkRun } from "@/app/parts/WorkRail";
import { EditSummary } from "@/app/parts/EditSummary";
import { TurnFooter } from "@/app/parts/TurnFooter";
import { scaledGap, transcriptGap, TURN_FOOTER_GAP } from "@/app/parts/spacing";
import { cn } from "@/lib/utils";
import { DaemonApi } from "@/runtime/rpc-client";
import { readPairingToken } from "@/platform/browser-storage";

type Entry = { timestamp: string; message: { role: string; content: unknown; toolCallId?: string; toolName?: string; isError?: boolean } };
type Turn = { label: string; entries: Entry[] };

/** One turn: from the user message at `offset` up to (not including) the next one. */
async function loadTurn(api: DaemonApi, session: string, offset: number): Promise<Turn> {
  const entries: Entry[] = [];
  let after = offset;
  for (let page = 0; page < 40; page++) {
    const data = await api.fetchJson<{ entries?: unknown[]; endOffset?: number }>(`/api/history?${new URLSearchParams({ session, after: String(after) })}`);
    const rows = (data.entries ?? []).filter((e): e is Entry & { type: string } => typeof e === "object" && e !== null && (e as { type?: unknown }).type === "message");
    for (const e of rows) {
      if (e.message.role === "user" && entries.length) return finish(entries);
      entries.push(e);
    }
    if (!data.entries?.length || typeof data.endOffset !== "number" || data.endOffset <= after) break;
    after = data.endOffset;
  }
  return finish(entries);
}
function finish(entries: Entry[]): Turn {
  if (!entries.length || entries[0]!.message.role !== "user") throw new Error("No user message starts at that offset");
  const c = entries[0]!.message.content;
  const text = typeof c === "string" ? c : (c as { text?: string }[]).map((x) => x.text ?? "").join(" ");
  return { label: text.replace(/\s+/g, " ").slice(0, 60), entries };
}
const at = (e: Entry) => Date.parse(e.timestamp);
const NO_MARKERS: readonly TimelineMarkerInput[] = [];
const NO_ACTIONS = {};

// The chat's rendering of a turn: its runs (WorkRun) while live, folded into "Worked for" when settled.
function TodayView({ messages, live }: { messages: UiMessage[]; live: boolean }) {
  const previous = useRef<TimelineItem[]>([]);
  const timeline = useMemo(() => (previous.current = buildTimeline(messages, previous.current, TIMELINE_NAMES, NO_MARKERS)), [messages]);
  const lastAssistantId = messages.findLast((m) => m.role === "assistant")?.id ?? null;
  const lastText = messages.findLast((m) => m.role === "assistant" && m.text.trim())?.id ?? null;
  const summaries = useMemo(() => summarizeTurns(timeline), [timeline]);
  const { folded, workHidden, steps, worked } = useMemo(() => foldTurnWork(timeline, summaries, live), [timeline, summaries, live]);
  const longRuns = useMemo(() => longTurnRuns(timeline, SECTION_CALLS), [timeline]);
  const run = (item: Pick<Extract<WorkItem, { kind: "run" }>, "messages" | "continued" | "reply">, expanded = false, sectioned = false, grouped = false) => (
    <WorkRun group={grouped ? (live && item.messages.at(-1)?.id === lastAssistantId ? "live" : "done") : undefined} messages={item.messages} sessionPath={null} toolsLive={live && item.messages.at(-1)?.id === lastAssistantId}
      latestThought={false} continued={item.continued} reply={item.reply} liveMessageId={live ? lastAssistantId : null} defaultExpanded={expanded} sectioned={sectioned} />
  );
  return (
    <div className="flex flex-col">
      {timeline.map((item, i) => {
        const gap = { marginTop: scaledGap(transcriptGap(i > 0 ? timeline[i - 1]! : null, item)) };
        const work = steps.get(i);
        const chip = work ? <div className={item.kind === "message" ? "mt-2" : undefined}><TurnWorkChip work={work} render={(w, sectioned) => (w.kind === "edits" ? <EditSummary messages={w.messages} /> : run(w, true, sectioned))} /></div> : null;
        const summary = summaries.get(i);
        const row = item.kind === "message" ? (
          <div style={gap}><ChatMessageRow animate={false} bindings={NO_ACTIONS} message={item.message} sessionPath={null}
            toolsLive={live && item.message.id === lastAssistantId} finalReply={item.message.id === lastText} latestThought={false} hideWork={workHidden.has(i)} />{chip}</div>
        ) : item.kind === "run" ? (folded.has(i) ? (chip ? <div style={gap}>{chip}</div> : null) : <div style={gap}>{run(item, false, longRuns.has(item.key), true)}</div>)
          : item.kind === "edits" ? (folded.has(i) ? (chip ? <div style={gap}>{chip}</div> : null) : <div style={gap}><EditSummary messages={item.messages} /></div>) : null;
        const footer = summary && !live ? <div style={{ marginTop: scaledGap(TURN_FOOTER_GAP) }}><TurnFooter running={false} startedAt={summary.startedAt} endedAt={summary.endedAt}
          durationShown={worked.has(i)} /></div> : null;
        return <Fragment key={item.kind === "message" ? item.message.id : item.key}>{row}{footer}</Fragment>;
      })}
      {live ? <div style={{ marginTop: scaledGap(TURN_FOOTER_GAP) }}><TurnFooter running /></div> : null}
    </div>
  );
}

/** The moments worth seeing in a turn, as offsets from its start. */
function moments(entries: Entry[]): { label: string; at: number }[] {
  const start = at(entries[0]!), end = at(entries.at(-1)!);
  const out: { label: string; at: number }[] = [];
  const started = new Map<string, number>();
  let thought = false, failed = false, agents = false, long = false;
  for (const e of entries) {
    const t = at(e) - start;
    const m = e.message;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as Record<string, unknown>[]) {
        if (!thought && b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) { thought = true; out.push({ label: "First thought", at: t + 300 }); }
        if (b.type === "toolCall") {
          started.set(String(b.id), t);
          if (!agents && b.name === "task") { agents = true; out.push({ label: "Agents", at: t + 1500 }); }
        }
      }
    }
    if (m.role === "toolResult" && m.toolCallId) {
      const s0 = started.get(m.toolCallId);
      if (!long && s0 !== undefined && t - s0 >= 8000) { long = true; out.push({ label: "Long step", at: s0 + Math.min(6000, (t - s0) / 2) }); }
      if (!failed && m.isError) { failed = true; out.push({ label: "Failure", at: t + 300 }); }
    }
  }
  out.push({ label: "Ending", at: end - start });
  return out.sort((a, b) => a.at - b.at);
}

/** The replayed transcript scrolls; a still composer sits at the bottom like the app's. */
function Screen({ children, scrollKey, framed }: { children: ReactNode; scrollKey: unknown; framed: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [scrollKey]);
  return (
    <div className={cn("relative overflow-hidden bg-background", framed ? "h-[780px] w-[390px] rounded-[36px] ring-1 ring-white/15" : "h-full w-full")}>
      <div ref={ref} className="h-full overflow-y-auto px-4 pb-36 pt-4">{children}</div>
      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex h-[104px] flex-col justify-between rounded-[28px] bg-surface-2 p-4 text-muted-foreground">
        <span className="text-body">Message</span><span className="text-meta">+   Opus 5.5 · Medium ⌄</span>
      </div>
    </div>
  );
}

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const LOOP_HOLD_MS = 4000;

function LiveTurnPreview({ turns, onClose }: { turns: Turn[]; onClose: () => void }) {
  const [key, setKey] = useState(0);
  const entries = turns[key]!.entries;
  const start = at(entries[0]!), end = at(entries.at(-1)!);
  const span = end - start;
  const marks = useMemo(() => moments(entries), [entries]);
  const [t, setT] = useState(0);
  const [speed, setSpeed] = useState(4);
  const [playing, setPlaying] = useState(true);
  useEffect(() => { setT(0); }, [key]);
  // Autoplay and loop: hold the ending a few seconds, then start again.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setT((v) => (v >= span + LOOP_HOLD_MS * speed ? 0 : v + 100 * speed)), 100);
    return () => window.clearInterval(id);
  }, [playing, speed, span]);
  const now = start + Math.min(t, span);
  const shown = useMemo(() => entries.filter((e) => at(e) <= now), [entries, now]);
  const messages = useMemo(() => appendAgentEntries(emptyAgentTranscript(), shown).messages, [shown]);
  const jump = (ms: number) => { setPlaying(false); setT(Math.max(0, Math.min(span, ms))); };
  const chip = "shrink-0 rounded-full px-3 py-2 text-meta";
  return (
    <div className="flex h-dvh flex-col pt-[env(safe-area-inset-top)]">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <select className="min-w-0 flex-1 rounded-lg bg-surface-1 px-2 py-3 text-meta" value={key} onChange={(e) => setKey(Number(e.target.value))}>
          {turns.map((v, k) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <button className="h-12 shrink-0 rounded-full bg-primary px-5 text-ui font-semibold text-primary-foreground" onClick={onClose}>Reply</button>
      </div>
      <div className="min-h-0 flex-1"><Screen framed={false} scrollKey={now}><TodayView messages={messages} live={now < end} /></Screen></div>
      <div className="shrink-0 border-t border-hairline px-3 py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
        <div className="flex items-center gap-2">
          <button className={cn(chip, "min-w-16 bg-surface-2")} onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
          {[1, 4, 16].map((s) => <button key={s} className={cn(chip, speed === s ? "bg-foreground text-background" : "bg-surface-2")} onClick={() => setSpeed(s)}>{s}×</button>)}
          <input type="range" className="min-w-0 flex-1" min={0} max={span} step={100} value={Math.min(t, span)} onChange={(e) => jump(Number(e.target.value))} />
          <span className="shrink-0 text-meta tabular-nums text-muted-foreground">{clock(Math.min(t, span))}/{clock(span)}</span>
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto">
          {marks.map((m) => <button key={m.label} className={cn(chip, "bg-surface-1")} onClick={() => jump(m.at)}>{m.label} {clock(m.at)}</button>)}
        </div>
      </div>
    </div>
  );
}

/** Reads `#dev=live-turn&turn=…` and loads each turn; null when the hash isn't a review link. */
export function useReviewTurns(hash: string): { turns: Turn[] | null; error: string | null } | null {
  const specs = useMemo(() => {
    const params = new URLSearchParams(hash.slice(1));
    if (params.get("dev") !== "live-turn") return null;
    return params.getAll("turn").map((t) => { const i = t.lastIndexOf("@"); return { session: t.slice(0, i), offset: Number(t.slice(i + 1)) }; })
      .filter((t) => t.session && Number.isSafeInteger(t.offset) && t.offset >= 0);
  }, [hash]);
  const [state, setState] = useState<{ turns: Turn[] | null; error: string | null }>({ turns: null, error: null });
  useEffect(() => {
    if (!specs) return;
    let cancelled = false;
    setState({ turns: null, error: null });
    const api = new DaemonApi(readPairingToken() ?? "");
    Promise.all(specs.map((t) => loadTurn(api, t.session, t.offset))).then(
      (turns) => { if (!cancelled) setState({ turns, error: turns.length ? null : "The link names no turns." }); },
      (error: unknown) => { if (!cancelled) setState({ turns: null, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { cancelled = true; };
  }, [specs]);
  return specs ? state : null;
}

/** The review screen over the app: the app stays mounted underneath, so closing returns to the question. */
export default function ReviewOverlay({ hash, onClose }: { hash: string; onClose: () => void }) {
  const review = useReviewTurns(hash);
  return (
    <div data-testid="dev-review" className="fixed inset-0 z-[1000] bg-background text-foreground">
      {review?.turns ? <LiveTurnPreview turns={review.turns} onClose={onClose} /> : (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-body text-muted-foreground">{review?.error ?? "Loading the recorded turn…"}</p>
          <button className="h-12 rounded-full bg-surface-2 px-5 text-ui" onClick={onClose}>Back</button>
        </div>
      )}
    </div>
  );
}
