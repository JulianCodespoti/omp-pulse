import { memo, useMemo, useState } from "react";
import { BotIcon, ChevronDownIcon, ChevronRightIcon, FilePenLineIcon, FileTextIcon, ListChecksIcon, SearchIcon, TerminalIcon, WrenchIcon, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { UiMessage } from "@/domain/messages";

import { RunSummary } from "./RunSummary";
import { spokenDuration } from "./duration";
import { callState, ToolSheet } from "./ToolSheet";
import { filePathLabel, filePathsForTool, toolFace, toolKind, toolSource, type ToolUiPart } from "./tools/describe";
import { useAppearance } from "@/platform/appearance";
import { RunGroup } from "../chat/TurnWorkChip";

/**
 * The Summary mode's view of a turn's work, chosen in a design review against
 * real recorded turns (after ChatGPT's thinking and Perplexity's steps).
 *
 * A rail: each thought reads as a short paragraph (tap for the rest), and
 * consecutive calls of one kind group into a verb with chips for what they
 * touched: file names for reads and edits, the plain-English intent for
 * everything else (a raw regex or shell line reads as noise). A chip opens the
 * call's full detail sheet. The rail is the body of a work group
 * (chat/TurnWorkChip): while the run is live the group's title, not the rail,
 * carries the one shimmering "what it is on now" line. Grouped and Expanded
 * (Settings → Appearance) keep RunSummary.
 */

// The rail is a segment under each marker down to the next: no line runs behind
// an icon, so nothing has to mask it in the surface colour (a chat and a sheet differ).
const RAIL_SEGMENT = "after:absolute after:bottom-0 after:left-[7.5px] after:top-6 after:w-px after:bg-hairline last:after:hidden";
const CHIP_MAX = 3;

type Category = "read" | "edit" | "search" | "bash" | "task" | "todo" | "tool";
const VERB: Record<Category, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  search: ["Searching", "Searched"],
  bash: ["Running", "Ran"],
  task: ["Starting agents", "Started agents"],
  todo: ["Updating tasks", "Updated tasks"],
  tool: ["Using tools", "Used tools"],
};

function categoryOf(part: ToolUiPart): Category {
  // An MCP tool is its server's, whatever its name says: `mcp__workiq_search` is WorkIQ, not a file search.
  if (part.name.startsWith("mcp__")) return "tool";
  const kind = toolKind(part.name);
  if (kind === "file") {
    // A write to a tool device (xd://, agent://…) is a tool call, not a file change.
    if (!filePathsForTool(part).some((path) => !path.includes("://"))) return "tool";
    return part.name.toLowerCase().endsWith("read") ? "read" : "edit";
  }
  if (kind === "bash") return "bash";
  if (kind === "search") return "search";
  if (kind === "task") return "task";
  if (kind === "todo") return "todo";
  return "tool";
}

// A core file tool pointed at a scheme path (`xd://lsp`, `agent://…`) belongs to what the path names, not to "read".
const SCHEME_LABELS: Record<string, string> = { agent: "agents", skill: "skills" };
function sourceOf(part: ToolUiPart): { id: string; label: string } {
  const path = part.name.startsWith("mcp__") ? undefined : filePathsForTool(part).find((candidate) => candidate.includes("://"));
  const scheme = path?.match(/^([a-z]+):\/\//)?.[1];
  if (!path || !scheme) return toolSource(part);
  if (scheme === "xd") return toolSource({ ...part, args: { path } });
  return { id: scheme, label: SCHEME_LABELS[scheme] ?? scheme };
}

type Item =
  | { kind: "thought"; key: string; text: string; redacted: boolean }
  // `source` is set for "tool" acts only: consecutive calls to one MCP server or tool device group, others do not.
  // `thoughts` are the ones between merged calls (see mergeRuns); a rail's own items never carry them.
  | { kind: "act"; key: string; category: Category; source?: { id: string; label: string }; calls: { part: ToolUiPart; messageId: string }[]; thoughts?: ThoughtItem[] };
type ThoughtItem = Extract<Item, { kind: "thought" }>;
type ActItem = Extract<Item, { kind: "act" }>;
type ActCall = ActItem["calls"][number];

function railItems(messages: readonly UiMessage[]): Item[] {
  const items: Item[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    message.parts.forEach((part, index) => {
      if (part.kind === "thinking") {
        if (part.text.trim() || part.redacted) items.push({ kind: "thought", key: `${message.id}:${index}`, text: part.text, redacted: !!part.redacted });
      } else if (part.kind === "tool") {
        const category = categoryOf(part);
        const source = category === "tool" ? sourceOf(part) : undefined;
        const last = items.at(-1);
        if (last?.kind === "act" && last.category === category && last.source?.id === source?.id) last.calls.push({ part, messageId: message.id });
        else items.push({ kind: "act", key: part.callId, category, source, calls: [{ part, messageId: message.id }] });
      }
    });
  }
  return items;
}

/** A thought's own words, without markdown heading marks. */
function plainThought(text: string): string {
  return text.replace(/\*\*(.+?)\*\*\s*/g, "$1. ").replace(/\s+/g, " ").trim();
}

function chipText(part: ToolUiPart, category: Category): string {
  // A started agent's chip read "# Target +1": the first line of its prompt. Its name is what the reader knows it by.
  if (category === "task") {
    const tasks = (part.args as { tasks?: unknown } | undefined)?.tasks;
    const names = Array.isArray(tasks) ? tasks.map((task) => (task as { name?: unknown } | null)?.name).filter((name): name is string => typeof name === "string" && name !== "") : [];
    if (names.length) return names.join(", ");
  }
  if (category === "read" || category === "edit") {
    const paths = filePathsForTool(part);
    if (paths.length > 1) return `${paths.length} files`;
    if (paths[0]) return filePathLabel(paths[0]).basename;
  }
  // toolFace puts the intent in `label` and leaves `target` empty; without an
  // intent `label` is a bare verb ("Ran") and `target` names the command.
  const face = toolFace(part);
  return face.target || face.label || part.name;
}

/** A running call as a live group title says it: the rail's own verb and chip, "Reading retry.ts", "Running npm test". */
export function liveStepLabel(part: ToolUiPart): string {
  const category = categoryOf(part);
  const doing = category === "tool" ? `Using ${sourceOf(part).label}` : VERB[category][0];
  const target = category === "tool" ? "" : chipText(part, category);
  return target && target !== doing ? `${doing} ${target}` : doing;
}

const ThoughtRow = memo(function ThoughtRow({ text, redacted, initiallyOpen, nested }: { text: string; redacted: boolean; initiallyOpen: boolean; nested?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <li className={cn("relative flex gap-3 pb-3", !nested && RAIL_SEGMENT)} data-testid="rail-thought">
      <span aria-hidden className="mx-[5px] mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
      {redacted ? (
        <span className="text-meta text-muted-foreground">Reasoning hidden</span>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn("min-w-0 flex-1 text-left text-meta leading-relaxed text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring", !open && "line-clamp-3")}
        >
          {plainThought(text)}
        </button>
      )}
    </li>
  );
});

const ICON: Record<Category, LucideIcon> = {
  read: FileTextIcon,
  edit: FilePenLineIcon,
  search: SearchIcon,
  bash: TerminalIcon,
  task: BotIcon,
  todo: ListChecksIcon,
  tool: WrenchIcon,
};

function ActRow({ item, live, liveMessageId, sessionPath, toolResultUnknown, newestThought }: { item: ActItem } & RowsContext) {
  const [all, setAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showThoughts, setShowThoughts] = useState(false);
  const callLive = (messageId: string) => live && (!liveMessageId || messageId === liveMessageId);
  const running = item.calls.some(({ part, messageId }) => callState(part, callLive(messageId), !!toolResultUnknown).state === "running");
  const Icon = ICON[item.category];
  const shown = all ? item.calls : item.calls.slice(0, CHIP_MAX);
  const opened = item.calls.find(({ part }) => part.callId === openId);
  const [doing, did] = item.source ? [`Using ${item.source.label}`, `Used ${item.source.label}`] : VERB[item.category];
  const thoughts = item.thoughts ?? [];
  return (
    <li className={cn("relative flex gap-3 pb-3", RAIL_SEGMENT)} data-testid="rail-act" data-category={item.category}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-meta text-muted-foreground">
          {running ? doing : did}
          {item.calls.length > 1 ? ` · ${item.calls.length}` : ""}
        </p>
        {/* DeepSeek's tool steps are plain single-line text (ToolFindText/ToolOpenText: 15sp on 24sp, secondary
            colour, no fill). Filled pills read as chat bubbles, as if the agent had replied. */}
        <div className="mt-0.5 flex flex-col">
          {shown.map(({ part, messageId }) => {
            const state = callState(part, callLive(messageId), !!toolResultUnknown).state;
            const failed = state === "error";
            return (
              <button
                key={part.callId}
                type="button"
                data-testid="rail-chip"
                data-state={state}
                onClick={() => setOpenId(part.callId)}
                className={cn(
                  // `truncate` sits on the label, not the button: overflow-hidden would clip the 44px `after:` hit area.
                  "pressable relative flex min-h-8 max-w-full items-center rounded-md text-left text-meta outline-none after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring",
                  failed ? "text-danger" : "text-foreground/80",
                )}
              >
                <span className="min-w-0 truncate">{chipText(part, item.category)}</span>
              </button>
            );
          })}
          {!all && item.calls.length > CHIP_MAX ? (
            <button type="button" data-testid="rail-more" onClick={() => setAll(true)} className="pressable flex min-h-8 items-center self-start text-meta text-muted-foreground">
              {item.calls.length - CHIP_MAX} more
            </button>
          ) : null}
          {all && item.calls.length > CHIP_MAX ? (
            <button type="button" data-testid="rail-less" onClick={() => setAll(false)} className="pressable flex min-h-8 items-center self-start text-meta text-muted-foreground">
              Show less
            </button>
          ) : null}
        </div>
        {thoughts.length ? (
          <>
            <button type="button" data-testid="rail-thoughts" aria-expanded={showThoughts} onClick={() => setShowThoughts((value) => !value)} className="pressable mt-1.5 block text-meta text-muted-foreground">
              {thoughts.length} {thoughts.length === 1 ? "thought" : "thoughts"}
            </button>
            {showThoughts ? (
              <ol className="m-0 mt-1.5 list-none p-0">
                {thoughts.map((thought) => <ThoughtRow key={thought.key} text={thought.text} redacted={thought.redacted} initiallyOpen={thought.key === newestThought} nested />)}
              </ol>
            ) : null}
          </>
        ) : null}
      </div>
      {opened ? (
        <ToolSheet
          open
          onOpenChange={(open) => { if (!open) setOpenId(null); }}
          part={opened.part}
          live={callLive(opened.messageId)}
          sessionPath={sessionPath}
          resultUnknown={toolResultUnknown}
        />
      ) : null}
    </li>
  );
}

type Section = { key: string; items: Item[]; calls: ActCall[] };

/** A rail is a flat list until it holds more calls than this; then it is cut into sections of about this many. */
export const SECTION_CALLS = 12;
/** "Read 14 files", "5 searches": a section's count of one category, in the words a reader would use. */
function countPhrase(category: Category, n: number): string {
  const plural = (one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  switch (category) {
    case "read": return `Read ${plural("file", "files")}`;
    case "edit": return `Edited ${plural("file", "files")}`;
    case "bash": return `Ran ${plural("command", "commands")}`;
    case "search": return plural("search", "searches");
    case "task": return plural("agent", "agents");
    case "todo": return "Updated tasks";
    case "tool": return `Used ${plural("tool", "tools")}`;
  }
}

const sameRun = (a: ActItem, b: ActItem) => a.category === b.category && a.source?.id === b.source?.id;

/**
 * Cut the rail at the first thought at or past the call budget, so a section
 * opens on a thought. A run of one kind is not cut mid-way unless it alone
 * exceeds twice the budget: sections stay readable as "what it did next".
 * A single unbroken act with no thoughts (200 reads in a row) cannot be cut.
 */
function sectionsOf(items: readonly Item[]): Section[] {
  const runTotal = new Map<ActItem, number>();
  let run: ActItem[] = [];
  const close = () => { const total = run.reduce((sum, act) => sum + act.calls.length, 0); for (const act of run) runTotal.set(act, total); run = []; };
  for (const item of items) {
    if (item.kind !== "act") continue;
    if (run.length && !sameRun(run[0]!, item)) close();
    run.push(item);
  }
  close();
  const out: Item[][] = [[]];
  let calls = 0;
  let last: ActItem | undefined;
  items.forEach((item, index) => {
    if (item.kind === "thought" && calls >= SECTION_CALLS) {
      const next = items.slice(index + 1).find((candidate): candidate is ActItem => candidate.kind === "act");
      if (next && !(last && sameRun(last, next) && runTotal.get(last)! <= 2 * SECTION_CALLS)) { out.push([]); calls = 0; }
    }
    out.at(-1)!.push(item);
    if (item.kind === "act") { calls += item.calls.length; last = item; }
  });
  return out.map((group) => {
    const acts = group.filter((item): item is ActItem => item.kind === "act");
    return { key: acts[0]!.key, items: group, calls: acts.flatMap((act) => act.calls) };
  });
}

/** Calls of one kind join into one group across the thoughts between them; those thoughts ride on the group. */
function mergeRuns(items: readonly Item[]): Item[] {
  const out: Item[] = [];
  let pending: ThoughtItem[] = [];
  for (const item of items) {
    if (item.kind === "thought") { pending.push(item); continue; }
    const last = out.at(-1);
    if (last?.kind === "act" && sameRun(last, item)) out[out.length - 1] = { ...last, calls: [...last.calls, ...item.calls], thoughts: [...(last.thoughts ?? []), ...pending] };
    else out.push(...pending, item);
    pending = [];
  }
  return out.concat(pending);
}

/** "Read 14 files · Ran 9 commands · Edited 3 files · 2 more": the rail's own verbs, most frequent first. */
function summaryOf(calls: readonly ActCall[]): string {
  const counts = new Map<Category, number>();
  for (const { part } of calls) { const category = categoryOf(part); counts.set(category, (counts.get(category) ?? 0) + 1); }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const parts = ranked.slice(0, 3).map(([category, n]) => countPhrase(category, n));
  if (ranked.length > 3) parts.push(`${ranked.length - 3} more`);
  return parts.join(" · ");
}

/** Wall time of some calls, from tool start/end stamps or the message's own; null when unknown. */
function spanOf(calls: readonly ActCall[], created: ReadonlyMap<string, number | undefined>): string | null {
  let start = Infinity;
  let end = -Infinity;
  for (const { part, messageId } of calls) {
    const from = part.startedAt ?? created.get(messageId);
    if (from === undefined) continue;
    start = Math.min(start, from);
    end = Math.max(end, part.endedAt ?? from);
  }
  return end > start ? spokenDuration(end - start) : null;
}

// A long turn recovers from many failed calls; turning each whole row red made a healthy run read as alarming. The row stays muted and only its failure count is red.
function FoldButton({ open, failures = 0, text, time, onClick, testId }: { open: boolean; failures?: number; text: string; time?: string | null; onClick: () => void; testId: string }) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      aria-expanded={open}
      data-testid={testId}
      data-open={open}
      onClick={onClick}
      className="pressable flex w-full min-w-0 items-center gap-3 text-left text-meta text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Chevron aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {failures ? <span className="shrink-0 text-danger">{`${failures} failed`}</span> : null}
      {time ? <span className="shrink-0 tabular-nums">{time}</span> : null}
    </button>
  );
}

type RowsContext = { live: boolean; liveMessageId?: string | null; sessionPath?: string | null; toolResultUnknown?: boolean; newestThought?: string };

function Rows({ items, ...context }: { items: readonly Item[] } & RowsContext) {
  return (
    <>
      {items.map((item) => item.kind === "thought"
        ? <ThoughtRow key={item.key} text={item.text} redacted={item.redacted} initiallyOpen={item.key === context.newestThought} />
        : <ActRow key={item.key} item={item} {...context} />)}
    </>
  );
}

export const WorkRail = memo(function WorkRail({ messages, toolsLive, liveMessageId, sessionPath, toolResultUnknown, sectioned, nest }: {
  messages: readonly UiMessage[];
  toolsLive: boolean;
  liveMessageId?: string | null;
  sessionPath?: string | null;
  toolResultUnknown?: boolean;
  /** The turn as a whole is long: sections even when this stretch alone is short, so the turn reads as one list of rows. */
  sectioned?: boolean;
  /** Drawn inline in the chat, not in a sheet: a settled run's sections fold behind one line too. A running turn
   * is split into several runs by markers (compaction, background jobs), and only the live one had that line, so
   * the older runs' rows lay flat under it. */
  nest?: boolean;
}) {
  const { thinking } = useAppearance();
  const all = useMemo(() => railItems(messages), [messages]);
  // Settings → Appearance → Thinking: "hidden" leaves settled thoughts out (the
  // live line still says Thinking); "latest" opens the newest thought in full.
  const items = useMemo(() => (thinking === "hidden" ? all.filter((item) => item.kind !== "thought") : all), [all, thinking]);
  // Live, the newest thought streams in full (the group's preview window shows its newest words, as DeepSeek's does).
  const newestThought = thinking === "latest" || toolsLive ? items.findLast((item) => item.kind === "thought")?.key : undefined;
  const sections = useMemo(
    () => {
      const calls = items.reduce((sum, item) => sum + (item.kind === "act" ? item.calls.length : 0), 0);
      return calls > SECTION_CALLS || (sectioned && calls > 0) ? sectionsOf(items) : null;
    },
    [items, sectioned],
  );
  const created = useMemo(() => new Map(messages.map((message) => [message.id, message.createdAt?.getTime()])), [messages]);
  // Tokens: a section's first call id, "more:" + that id (its hidden live steps), "earlier". Keyed by call id
  // rather than position so what the reader opened survives the rail growing under it.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (token: string) => setOpened((previous) => {
    const next = new Set(previous);
    if (!next.delete(token)) next.add(token);
    return next;
  });
  if (!items.length && !toolsLive) return null;
  const context: RowsContext = { live: toolsLive, liveMessageId, sessionPath, toolResultUnknown, newestThought };
  const failed = (calls: readonly ActCall[]) => calls.filter(({ part, messageId }) => callState(part, toolsLive && (!liveMessageId || messageId === liveMessageId), !!toolResultUnknown).state === "error");
  const newest = toolsLive ? sections?.at(-1) : undefined;
  const older = sections && newest ? sections.slice(0, -1) : sections ?? [];
  // The folding line heads older sections while live, and a settled inline run's sections (more than one: a
  // single row needs no line over it).
  const foldOlder = newest ? older.length > 0 : !!nest && older.length > 1;
  const sectionRows = older.map((section) => {
    const open = opened.has(section.key);
    return (
      <li key={section.key} className="pb-3" data-testid="rail-section" data-open={open} data-calls={section.calls.length}>
        <FoldButton open={open} failures={failed(section.calls).length} text={summaryOf(section.calls)} time={spanOf(section.calls, created)} onClick={() => toggle(section.key)} testId="rail-section-summary" />
        {open ? <ol className="m-0 mt-3 list-none p-0"><Rows items={mergeRuns(section.items)} {...context} /></ol> : null}
      </li>
    );
  });
  const earlierCalls = older.flatMap((section) => section.calls);
  const earlierOpen = opened.has("earlier");
  const steps = newest ? mergeRuns(newest.items) : [];
  // Same inversion as RunSummary: the model keeps appending to its thinking part while the calls that
  // part issued run and report, so the live thought would sit above work that came after it. Draw it
  // last while the run is live; a settled run keeps the true order.
  const liveThought = toolsLive ? steps.findLast((item) => item.kind === "thought") : undefined;
  const drawn = liveThought && steps.at(-1) !== liveThought ? [...steps.filter((item) => item !== liveThought), liveThought] : steps;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="work-rail" data-live={toolsLive ? "true" : undefined} data-entry-id={messages[0]?.sourceEntryId}>
      {/* The work group's title is the one live voice; a second shimmer here would be a second spinner. */}
      {items.length ? <ol className="m-0 list-none p-0">
        {!sections ? <Rows items={items} {...context} /> : null}
        {sections && !newest && !foldOlder ? sectionRows : null}
        {foldOlder ? (
          <li className="pb-3">
            <FoldButton
              open={earlierOpen}
              failures={failed(earlierCalls).length}
              text={["Earlier", `${earlierCalls.length} steps`, spanOf(earlierCalls, created)].filter(Boolean).join(" · ")}
              onClick={() => toggle("earlier")}
              testId="rail-earlier"
            />
            {earlierOpen ? <ol className="m-0 mt-3 list-none p-0">{sectionRows}</ol> : null}
          </li>
        ) : null}
        {newest ? (
          <li data-testid="rail-section" data-open={!opened.has(`closed:${newest.key}`)} data-calls={newest.calls.length}>
            {/* The newest steps fold too, open by default, so a whole turn can be one line. */}
            <div className="pb-3">
              <FoldButton open={!opened.has(`closed:${newest.key}`)} failures={failed(newest.calls).length} text={summaryOf(newest.calls)} time={spanOf(newest.calls, created)} onClick={() => toggle(`closed:${newest.key}`)} testId="rail-section-summary" />
            </div>
            {opened.has(`closed:${newest.key}`) ? null : <ol className="m-0 list-none p-0">
              <Rows items={drawn} {...context} />
            </ol>}
          </li>
        ) : null}
      </ol> : null}
    </div>
  );
});

type RunProps = Parameters<typeof RunSummary>[0];

/**
 * A run of thinking and calls as the reader chose to see it: the rail in
 * Summary mode, RunSummary's grouped rows otherwise. The rail keeps what
 * RunSummary adds around the rows (screenshots in the flow, a pending quick
 * question) by rendering RunSummary for those alone.
 */
export function WorkRun({ sectioned, group, ...props }: RunProps & {
  sectioned?: boolean;
  /** Not folded into a settled group yet (the live turn's runs): draw the rail as its own work group,
   * previewing while `"live"`. Screenshots and a pending question stay outside it, in the chat flow. */
  group?: "live" | "done";
}) {
  const { toolCalls } = useAppearance();
  if (toolCalls !== "summary" && !group) return <RunSummary {...props} />;
  // defaultExpanded marks a run drawn inside an open group; anything else is inline in the chat.
  // Grouped and Expanded change what a group holds (tool rows instead of the rail), never whether it folds.
  // Inside a group the group is the fold, so its rows start open rather than folding a second time.
  const rail = toolCalls !== "summary" ? <RunSummary {...props} defaultExpanded rowsOnly /> : <WorkRail messages={props.messages} toolsLive={props.toolsLive} liveMessageId={props.liveMessageId} sessionPath={props.sessionPath} toolResultUnknown={props.toolResultUnknown} sectioned={sectioned} nest={!props.defaultExpanded} />;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {group ? <RunGroup messages={props.messages} live={group === "live"} toolsLive={props.toolsLive} sessionPath={props.sessionPath}>{rail}</RunGroup> : rail}
      <RunSummary {...props} extrasOnly />
    </div>
  );
}
